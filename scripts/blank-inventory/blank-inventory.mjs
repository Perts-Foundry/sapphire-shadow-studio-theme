#!/usr/bin/env node
// blank-inventory: keep shared-blank stock and its variant metafield correct, with the Shopify Flow
// doing the fan-out.
//
// This tool writes to the LIVE store. There is no staging store, so the gates are not ceremony.
// The `blank-inventory` skill (.claude/skills/blank-inventory/SKILL.md) drives it and holds the
// operator approval STOPs; this file is the deterministic half.
//
//   bodies    propose and approve the garment body map; a precondition of every other command
//   audit     read-only health report: coverage, groups, drift vs awaiting-seed
//   plan      emit an immutable, hashed plan artifact from an adjustments CSV
//   apply     execute an approved artifact (and ONLY an artifact)
//   verify    poll the affected groups to convergence
//   backfill  tag untagged variants, then seed them so the Flow propagates
//   untag     remove variants from a group, metafield first (see the interlock)
//
// Read scripts/blank-inventory/README.md before using any write path.

import { readFile, writeFile, unlink, readdir } from 'node:fs/promises';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createAdminClient, assertScopes, assertSingleLocation } from './lib/admin.mjs';
import { readCatalogue, liveFetchers, createGroupReader } from './lib/catalogue.mjs';
import { learnVocab, buildGroups, classifyGroups, conventionWarnings, multiLevelVariants, resolveBlank, CONVERGED, DRIFT, AWAITING_SEED } from './lib/groups.mjs';
import { parseInput, MODE_ABSOLUTE, MODE_DELTA, MODES, FORMATS } from './lib/input.mjs';
import { planAll, derivedIdempotencyKey } from './lib/planner.mjs';
import { createArtifact, verifyArtifact, createReceipt, writeJsonAtomic, readJson, pendingBlankIds, pendingSeedBlankIds, isReceiptComplete, markRow, ROW_APPLIED, ROW_FAILED } from './lib/receipt.mjs';
import { applyPlan } from './lib/apply.mjs';
import { planBackfill, planBlankBootstrap, planSeed, untagVariants } from './lib/backfill.mjs';
import { setQuantity, adjustQuantity, setBlankMetafields, deleteBlankMetafields } from './lib/mutations.mjs';
import { pollToConvergence, allAtTarget, groupSignature, quiesce } from './lib/convergence.mjs';
import { resolveWorkDir, findOrphanWorkDir, WORK_DIR_BASENAME } from './lib/workdir.mjs';
import { proposeBodies, createBodiesArtifact, verifyBodiesArtifact, bodyIndex, attachBodies, unmappedHandles, HIGH } from './lib/bodies.mjs';

// Absolute, and by default outside any checkout. See lib/workdir.mjs for why.
const WORK_DIR = resolveWorkDir();
const LOCK_FILE = path.join(WORK_DIR, '.lock');
const BODIES_FILE = path.join(WORK_DIR, 'bodies.json');
const BODIES_PROPOSAL_FILE = path.join(WORK_DIR, 'bodies-proposal.json');

// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) {
      opts._.push(a);
      continue;
    }
    let key = a.slice(2);
    let val;
    const eq = key.indexOf('=');
    if (eq !== -1) {
      val = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (val === undefined) {
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        val = next;
        i++;
      } else val = true;
    }
    if (camel === 'variant') {
      opts.variant = opts.variant ?? [];
      opts.variant.push(val);
    } else opts[camel] = val;
  }
  return opts;
}

const fail = (msg) => {
  console.error(`\nERROR: ${msg}\n`);
  process.exit(1);
};

const heading = (s) => console.log(`\n${s}\n${'-'.repeat(s.length)}`);

/**
 * Read a numeric flag, or refuse.
 *
 * parseArgs gives a bare `--flag` the value `true`, and Number(true) is 1. For `--quantity` that
 * turns a fat-fingered flag into a silent "set every untagged variant to 1" instead of an error, and
 * a typo'd value into NaN. Neither may reach a write.
 *
 * @param {string} flag
 * @param {unknown} raw
 * @param {number} fallback
 * @returns {number}
 */
function numericOpt(flag, raw, fallback) {
  if (raw === undefined) return fallback;
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) {
    fail(`${flag} needs a number, got ${JSON.stringify(raw)}. It is never defaulted: the value ends up in a live write.`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// A pidfile lock. Two concurrent applies against the same groups would interleave writes and race
// the Flow's cascade against each other.
// ---------------------------------------------------------------------------
function pidAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 tests for existence without touching the process
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // alive but owned by someone else
  }
}

async function withLock(fn) {
  if (existsSync(LOCK_FILE)) {
    const held = (await readFile(LOCK_FILE, 'utf8').catch(() => '')).trim();
    const pid = Number(held.match(/pid (\d+)/)?.[1]);
    if (pid && pidAlive(pid)) {
      fail(`Another blank-inventory run holds the lock (${held}).`);
    }
    // The holder is gone, so this is a leftover from a crashed run, not a live conflict.
    console.warn(`Reclaiming a stale lock from a process that is no longer running (${held}).`);
    await unlink(LOCK_FILE).catch(() => {});
  }
  await writeJsonAtomic(path.join(WORK_DIR, '.keep'), { note: 'blank-inventory working directory' });
  await writeFile(LOCK_FILE, `pid ${process.pid} started ${new Date().toISOString()}\n`, 'utf8');

  // fail() exits the process, which skips `finally`. Without this hook a failed run would leak its
  // lock and block every subsequent run.
  const release = () => {
    try {
      unlinkSync(LOCK_FILE);
    } catch {
      /* already gone */
    }
  };
  process.once('exit', release);
  try {
    return await fn();
  } finally {
    release();
    process.removeListener('exit', release);
  }
}

// ---------------------------------------------------------------------------
// The approved body map is read once per process. Nested re-reads (the per-row group reader, the
// quiesce poller) must see the SAME body assignment as the plan they are checking; re-resolving it
// mid-run could silently regroup variants between a plan and its apply.
let bodiesIndexCache;

/**
 * @param {boolean} requireApproved
 * @returns {Promise<Map<string, string>|null>}
 */
async function ensureBodies(requireApproved) {
  if (bodiesIndexCache === undefined) {
    bodiesIndexCache = (await loadBodies({ requireApproved }))?.index ?? null;
  } else if (requireApproved && !bodiesIndexCache) {
    await loadBodies({ requireApproved: true }); // fails with the full message
  }
  return bodiesIndexCache;
}

async function loadStore({ requireWrite, skipBodies = false }) {
  const client = createAdminClient();
  if (requireWrite) await assertScopes(client);
  const catalogue = await readCatalogue(liveFetchers(client));
  const locationId = assertSingleLocation(catalogue.locations);

  const multi = multiLevelVariants(catalogue.variants);
  if (multi.length) {
    fail(
      `${multi.length} variant(s) have more than one inventory level. The sync Flow assumes a ` +
        `single location and both its locationId handling and its quantity comparison break ` +
        `otherwise. Revisit the Flow before running this tool.`
    );
  }

  // Body first: every key downstream depends on it, so attaching it after grouping would leave the
  // vocabulary keyed on a colour+size that means nothing on a multi-garment catalogue.
  const index = skipBodies ? null : await ensureBodies(requireWrite);
  const variants = attachBodies(index, catalogue.variants);
  const unmapped = index ? unmappedHandles(index, variants) : [];
  if (unmapped.length && requireWrite) {
    fail(
      `${unmapped.length} product(s) have no approved body: ${unmapped.join(', ')}. A write cannot ` +
        `proceed without knowing which physical garment each variant draws from. Re-run ` +
        `"bodies --stage propose" and approve the new proposal.`
    );
  }

  const { vocab, conflicts, unbodied } = learnVocab(variants);
  const groups = buildGroups(variants);
  return { client, locationId, ...catalogue, variants, vocab, conflicts, unbodied, unmapped, groups };
}

/** Receipts on disk, newest first, so audit can tell awaiting-seed from drift. */
async function loadReceipts() {
  if (!existsSync(WORK_DIR)) return [];
  const files = (await readdir(WORK_DIR)).filter((f) => f.startsWith('receipt-') && f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      out.push(await readJson(path.join(WORK_DIR, f)));
    } catch {
      /* a torn receipt is not fatal to a report */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The body axis. See lib/bodies.mjs for why body is proposed rather than declared.
// ---------------------------------------------------------------------------

/**
 * Load the approved body artifact.
 *
 * Read commands tolerate its absence and say so; write commands refuse. A write that resolved a
 * blank without knowing the garment is the original bug, so there is no "assume a default" path.
 *
 * @param {object} params
 * @param {boolean} params.requireApproved
 * @returns {Promise<{artifact: object, index: Map<string, string>}|null>}
 */
async function loadBodies({ requireApproved }) {
  if (!existsSync(BODIES_FILE)) {
    const msg =
      `No approved body map at ${BODIES_FILE}. A blank is a physical garment, so the tool cannot ` +
      `tell a crewneck from a vest without one. Run:\n` +
      `  node scripts/blank-inventory/blank-inventory.mjs bodies --stage propose`;
    if (requireApproved) fail(msg);
    console.warn(`\nWARNING: ${msg}\n`);
    return null;
  }
  const artifact = verifyBodiesArtifact(await readJson(BODIES_FILE));
  return { artifact, index: bodyIndex(artifact) };
}

/** Render a proposal or approved body table. */
function printBodyRows(rows) {
  const w = Math.max(...rows.map((r) => r.productHandle.length), 12);
  for (const r of rows) {
    const conf = r.confidence === HIGH ? '' : `  <-- ${String(r.confidence).toUpperCase()} CONFIDENCE, check this`;
    console.log(`  ${r.productHandle.padEnd(w)}  ${String(r.bodyId ?? '(UNNAMED)').padEnd(14)}  ${r.signal ?? ''}${conf}`);
  }
}

async function cmdBodies(opts) {
  const stage = opts.stage ?? 'propose';

  if (stage === 'show') {
    const loaded = await loadBodies({ requireApproved: true });
    heading(`Approved bodies (proposal ${loaded.artifact.proposalId})`);
    printBodyRows(loaded.artifact.bodies);
    console.log(`\n  approved artifact ${BODIES_FILE}`);
    return;
  }

  if (stage === 'propose') {
    // skipBodies: this command exists to CREATE the body map, so warning about its absence here
    // would be telling the operator to run the command they are already running.
    const store = await loadStore({ requireWrite: false, skipBodies: true });
    const { rows, excluded } = proposeBodies({ products: store.products, variants: store.variants });

    heading(`Body proposal: ${rows.length} product(s)`);
    printBodyRows(rows);
    if (excluded.length) {
      heading('Excluded (no tracked variants, so no body needed)');
      for (const e of excluded) console.log(`  ${e.productHandle}  ${e.reason}`);
    }

    const unnamed = rows.filter((r) => !r.bodyId);
    await writeJsonAtomic(BODIES_PROPOSAL_FILE, {
      version: 1,
      proposedAt: new Date().toISOString(),
      rows,
      excluded,
    });

    console.log(`\nProposal: ${BODIES_PROPOSAL_FILE}`);
    console.log(
      `\nThis is a GUESS from each product's handle and title, and it decides which products share ` +
        `stock. Two products on one body share a pool; two on different bodies must not. Read every\n` +
        `row before approving.`
    );
    if (unnamed.length) {
      console.log(
        `\n${unnamed.length} product(s) could not be named. Edit the "bodyId" field for each in the ` +
          `proposal file; approval refuses while any is null.`
      );
    }
    console.log(`\nTo correct a row, edit its "bodyId" in the file above, then:`);
    console.log(`  node scripts/blank-inventory/blank-inventory.mjs bodies --stage approve`);
    return;
  }

  if (stage === 'approve') {
    const src = opts.proposal ?? BODIES_PROPOSAL_FILE;
    if (!existsSync(src)) fail(`No proposal at ${src}. Run "bodies --stage propose" first.`);
    const proposal = await readJson(src);

    // Re-present in full rather than trusting the operator to remember the propose output. An
    // adjustment between the two commands is invisible otherwise, and this is the gate.
    heading(`Approving ${proposal.rows.length} body assignment(s)`);
    printBodyRows(proposal.rows);

    const artifact = createBodiesArtifact({ rows: proposal.rows, excluded: proposal.excluded ?? [] });
    await writeJsonAtomic(BODIES_FILE, artifact);

    const bodies = [...new Set(artifact.bodies.map((b) => b.bodyId))].sort();
    console.log(`\n  ${bodies.length} distinct body/bodies: ${bodies.join(', ')}`);
    console.log(`  approved artifact ${BODIES_FILE}`);
    console.log(
      `\nThis artifact is hashed and is now authoritative. It is never re-inferred, so body ` +
        `assignment cannot drift between runs. A product added later is refused on write paths ` +
        `until you re-propose.`
    );
    return;
  }

  fail(`Unknown --stage "${stage}". Use propose | approve | show.`);
}

// ---------------------------------------------------------------------------
async function cmdAudit(opts) {
  const store = await loadStore({ requireWrite: false });
  const pendingSeeds = pendingSeedBlankIds(await loadReceipts());
  const rows = classifyGroups(store.groups, pendingSeeds);
  const warnings = conventionWarnings(store.variants);

  const tagged = store.variants.filter((v) => v.blankId).length;
  const untracked = store.variants.filter((v) => v.tracked === false).length;

  if (opts.json) {
    console.log(JSON.stringify({ groups: rows.map((r) => ({ blankId: r.blankId, state: r.state, quantities: r.quantities, members: r.members.length })), warnings }, null, 2));
    return;
  }

  heading('Catalogue');
  console.log(`  products            ${store.products.length}`);
  console.log(`  variants            ${store.variants.length}`);
  console.log(`  tagged / untagged   ${tagged} / ${store.variants.length - tagged} (${untracked} untracked)`);
  console.log(`  blank groups        ${rows.length}`);
  console.log(`  active locations    1`);

  heading('Invariants');
  // Asserted as invariants, not as frozen counts: backfill legitimately moves variants between the
  // tagged and untagged pools, so a count comparison would false-alarm on the first correct run.
  const taggedAtZero = store.variants.filter((v) => v.blankId && v.quantity <= 0);
  const untaggedNonZero = store.variants.filter((v) => !v.blankId && v.tracked !== false && v.quantity > 0);
  const awaitingSeed = new Set(rows.filter((r) => r.state === AWAITING_SEED).flatMap((r) => r.members.map((m) => m.id)));
  const unexplainedZero = taggedAtZero.filter((v) => !awaitingSeed.has(v.id));

  const check = (ok, label, detail) => console.log(`  ${ok ? 'PASS' : 'WARN'}  ${label}${ok ? '' : `: ${detail}`}`);
  check(unexplainedZero.length === 0, 'every tagged variant holds stock or is awaiting seed', `${unexplainedZero.length} tagged variant(s) at 0 with no pending seed`);
  check(untaggedNonZero.length === 0, 'every untagged tracked variant is at 0', `${untaggedNonZero.length} untagged variant(s) hold stock`);
  // Body+Color+Size, not Color+Size. Under the old wording a correctly-modelled multi-garment
  // catalogue was a permanent FAIL: a crewneck and a vest in the same colour and size draw on two
  // different blanks, which is right, not a contradiction.
  check(store.conflicts.length === 0, 'no Body+Color+Size resolves to two different blanks', `${store.conflicts.length} conflict(s)`);
  check(warnings.length === 0, 'every blank id matches the structural convention', `${warnings.length} warning(s)`);
  check(store.unmapped.length === 0, 'every product has an approved body', `${store.unmapped.length} product(s) unmapped: ${store.unmapped.join(', ')}`);
  check(store.unbodied.length === 0, 'every tagged variant has a body', `${store.unbodied.length} tagged variant(s) excluded from the vocabulary`);

  heading('Groups');
  const byState = { [CONVERGED]: 0, [DRIFT]: 0, [AWAITING_SEED]: 0 };
  for (const r of rows) byState[r.state]++;
  console.log(`  converged ${byState[CONVERGED]}   awaiting-seed ${byState[AWAITING_SEED]}   DRIFT ${byState[DRIFT]}`);
  for (const r of rows.filter((x) => x.state !== CONVERGED)) {
    console.log(`  ${r.state.toUpperCase().padEnd(14)} ${r.blankId}  quantities=[${r.quantities.join(', ')}]  members=${r.members.length}`);
  }

  if (warnings.length) {
    heading('Convention warnings');
    for (const w of warnings) console.log(`  [${w.kind}] ${w.message}`);
  }
  if (store.conflicts.length) {
    heading('Vocabulary conflicts (these Body+Color+Size keys cannot be resolved)');
    for (const c of store.conflicts) console.log(`  ${c.key}: ${c.values.join(' vs ')}`);
  }
  if (byState[DRIFT]) {
    console.log(
      `\nDRIFT means the Flow is not converging those groups. Do not write on top of it; see the ` +
        `Troubleshooting section of docs/blank-inventory-sync-flow.md.`
    );
  }
}

// ---------------------------------------------------------------------------
async function cmdPlan(opts) {
  if (!opts.input) fail('plan needs --input <csv>.');
  if (!MODES.includes(opts.mode)) {
    fail(`plan needs --mode ${MODES.join('|')}. There is no default: reading "12" as a count when it meant "+12" silently destroys stock.`);
  }

  const text = await readFile(opts.input, 'utf8');
  const { rows } = parseInput(text, { mode: opts.mode, format: opts.format });
  // requireWrite is false (planning writes nothing to Shopify), but an approved body map is still a
  // hard precondition: a plan built on a colour+size key would target the wrong garment's pool, and
  // the plan is what apply executes without re-deriving.
  await loadBodies({ requireApproved: true });
  const store = await loadStore({ requireWrite: false });

  const pendingSeeds = pendingSeedBlankIds(await loadReceipts());
  const drifting = classifyGroups(store.groups, pendingSeeds).filter((r) => r.state === DRIFT);
  if (drifting.length) {
    fail(
      `${drifting.length} group(s) are in drift (${drifting.map((d) => d.blankId).join(', ')}). ` +
        `Planning on top of an unconverged group would mask a Flow fault. Resolve it first.`
    );
  }

  const planId = randomUUID();
  const { plans, skipped } = planAll({ rows, groups: store.groups, vocab: store.vocab, mode: opts.mode, planId, resolveBlank });
  const artifact = createArtifact({ plans, skipped, mode: opts.mode, planId });

  heading(`Plan ${planId} (mode: ${opts.mode})`);
  if (!plans.length) console.log('  nothing to write; every group already holds its target.');
  for (const p of plans) {
    console.log(`  ${p.blankId}`);
    console.log(`    now ${p.current} -> target ${p.target}${p.delta != null ? ` (delta ${p.delta >= 0 ? '+' : ''}${p.delta})` : ''}`);
    console.log(`    write to  ${p.writeTargetTitle}`);
    console.log(`    chosen because it holds ${p.baseline}, which differs from the target; a write to a`);
    console.log(`      member already at the target fires no trigger and the siblings stay stale.`);
    console.log(`    compare-and-swap baseline ${p.baseline}; the Flow then updates ${p.siblingCount} sibling(s).`);
  }
  for (const s of skipped) console.log(`  SKIP ${s.blankId}: ${s.reason} (at ${s.current}, target ${s.target})`);

  const out = opts.out ?? path.join(WORK_DIR, `plan-${planId}.json`);
  await writeJsonAtomic(out, artifact);
  console.log(`\nArtifact: ${out}`);
  console.log(`Nothing has been written to the store. Review the plan, then:`);
  console.log(`  node scripts/blank-inventory/blank-inventory.mjs apply --plan '${out}'`);
}

// ---------------------------------------------------------------------------
function makeWriter(client, locationId) {
  return async (group, mode) => {
    if (mode === MODE_DELTA) {
      return adjustQuantity(client, {
        inventoryItemId: group.inventoryItemId,
        locationId,
        delta: group.target - group.baseline,
        changeFromQuantity: group.baseline,
        idempotencyKey: group.idempotencyKey,
      });
    }
    return setQuantity(client, {
      inventoryItemId: group.inventoryItemId,
      locationId,
      quantity: group.target,
      changeFromQuantity: group.baseline,
      idempotencyKey: group.idempotencyKey,
    });
  };
}

async function cmdApply(opts) {
  if (opts.input || opts.mode) {
    fail(
      `apply takes --plan <artifact>, never --input/--mode. The artifact is what the operator ` +
        `approved; re-deriving a plan at apply time could pick a different write target than the ` +
        `one that was reviewed.`
    );
  }
  if (!opts.plan) fail('apply needs --plan <artifact.json> (produced by the plan command).');

  const artifact = verifyArtifact(await readJson(opts.plan));
  const store = await loadStore({ requireWrite: true });
  const byBlank = (blankId) => store.groups.get(blankId) ?? [];
  // Fresh read per row, NOT the snapshot above. The drift check only works if it sees the store as
  // it is at the moment of each write; a cached snapshot silently disables it.
  const readGroupLive = createGroupReader(async () => (await loadStore({ requireWrite: false })).groups);

  const receiptPath = opts.receipt ?? path.join(WORK_DIR, `receipt-${artifact.planId}.json`);
  let receipt;
  if (opts.resume && existsSync(receiptPath)) {
    receipt = await readJson(receiptPath);
    console.log(`Resuming ${receiptPath}: ${pendingBlankIds(receipt).length} group(s) outstanding.`);
  } else {
    receipt = createReceipt(artifact);
    // Cheap insurance beyond the per-row CAS baselines: what every affected group held before we
    // touched anything.
    receipt.preRunSnapshot = artifact.groups.map((g) => ({
      blankId: g.blankId,
      members: byBlank(g.blankId).map((m) => ({ id: m.id, quantity: m.quantity })),
    }));
  }

  if (opts.dryRun) {
    heading(`DRY RUN, plan ${artifact.planId}`);
    for (const g of artifact.groups) {
      console.log(`  ${g.blankId}: would write ${artifact.mode === MODE_DELTA ? `delta ${g.target - g.baseline}` : `quantity ${g.target}`} to ${g.writeTargetTitle} (CAS ${g.baseline})`);
    }
    console.log('\nNothing written.');
    return;
  }

  const result = await applyPlan({
    artifact,
    receipt,
    readGroup: readGroupLive,
    write: makeWriter(store.client, store.locationId),
    persist: (r) => writeJsonAtomic(receiptPath, r),
    only: opts.resume ? pendingBlankIds(receipt) : null,
    onRow: (e) => console.log(`  ${e.status.toUpperCase().padEnd(13)} ${e.blankId}${e.detail ? `  ${e.detail}` : ''}`),
  });

  heading('Apply');
  console.log(`  applied ${result.applied}   skipped ${result.skipped}   failed ${result.failed}`);
  console.log(`  receipt ${receiptPath}`);
  console.log(`  complete: ${isReceiptComplete(result.receipt)}`);
  console.log(`\nThe Flow settles in about 80-90s. Confirm with:`);
  console.log(`  node scripts/blank-inventory/blank-inventory.mjs verify --receipt '${receiptPath}'`);
  if (result.failed) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
async function cmdVerify(opts) {
  if (!opts.receipt) fail('verify needs --receipt <receipt.json>.');
  const receipt = await readJson(opts.receipt);
  const targets = new Map(receipt.rows.filter((r) => r.status === ROW_APPLIED).map((r) => [r.blankId, r.target]));
  if (!targets.size) {
    console.log('No applied rows in this receipt; nothing to verify.');
    return;
  }

  heading(`Verify ${targets.size} group(s)`);
  const results = [];
  for (const [blankId, target] of targets) {
    const res = await pollToConvergence(
      {
        read: async () => {
          const store = await loadStore({ requireWrite: false });
          const members = store.groups.get(blankId) ?? [];
          return allAtTarget(members, target);
        },
        now: () => Date.now(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      },
      { timeoutMs: numericOpt('--timeout-ms', opts.timeoutMs, 300_000) }
    );
    results.push({ blankId, ...res });
    console.log(`  ${res.verdict.toUpperCase().padEnd(10)} ${blankId}  target ${target}  after ${Math.round(res.elapsedMs / 1000)}s`);
  }

  const stale = results.filter((r) => r.verdict !== 'converged');
  if (stale.length) {
    console.log(
      `\n${stale.length} group(s) did not converge. Propagation is not atomic and settles in about ` +
        `80-90s, so past ~3 minutes this is a real fault. See the Troubleshooting section of ` +
        `docs/blank-inventory-sync-flow.md.`
    );
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
async function cmdBackfill(opts) {
  const stage = opts.stage ?? 'propose';
  // Required even at propose: without a body map every variant is unresolvable, so the proposal
  // would be an empty report that looks like "nothing to do" rather than "cannot tell".
  await loadBodies({ requireApproved: true });
  const store = await loadStore({ requireWrite: stage !== 'propose' });
  const filter = { body: opts.body, color: opts.color, size: opts.size, productHandle: opts.product };

  if (stage === 'propose' && opts.blank) {
    // Bootstrap: mint a brand-new id rather than reuse a precedent. The machine-side gate lives in
    // planBlankBootstrap; the operator STOP is in SKILL.md.
    const boot = planBlankBootstrap({
      variants: store.variants,
      blankId: opts.blank,
      filter,
      existingGroups: store.groups,
      allowOverCap: opts.allowOverCap === true,
    });
    heading(`New-blank bootstrap: ${boot.tags.length} variant(s) to tag with ${boot.blankId}`);
    for (const t of boot.tags) console.log(`  ${t.label}  (${t.body} / ${t.color} / ${t.size}, qty ${t.quantity})`);
    console.log(`\n  ${boot.isNew ? 'This id is NEW to the store' : 'Joining an existing family'}; current quantity ${boot.quantity}.`);

    const planId = randomUUID();
    const out = opts.out ?? path.join(WORK_DIR, `backfill-${planId}.json`);
    await writeJsonAtomic(out, { version: 1, planId, createdAt: new Date().toISOString(), bootstrap: true, tags: boot.tags });
    console.log(`\nProposal: ${out}`);
    console.log(`Nothing written. Minting an id does not move stock; tag, then set the level:`);
    console.log(`  1. backfill --stage tag  --plan '${out}'`);
    if (boot.isNew) {
      console.log(`  2. plan --input <csv> --mode absolute       (set the new family's quantity; it has no seed source yet)`);
    } else {
      console.log(`  2. backfill --stage seed --plan '${out}'   (a separate approval; this one moves stock)`);
    }
    return;
  }

  if (stage === 'propose') {
    const { tags, unresolvable } = planBackfill({ variants: store.variants, vocab: store.vocab, filter });
    heading(`Backfill proposal: ${tags.length} variant(s) to tag`);
    const byBlank = new Map();
    for (const t of tags) {
      if (!byBlank.has(t.blankId)) byBlank.set(t.blankId, []);
      byBlank.get(t.blankId).push(t);
    }
    for (const [blankId, items] of [...byBlank].sort()) {
      console.log(`  ${blankId}  (${items.length} variant(s))`);
      for (const it of items.slice(0, 5)) console.log(`      ${it.label}`);
      if (items.length > 5) console.log(`      ... and ${items.length - 5} more`);
    }
    for (const u of unresolvable) console.log(`  UNRESOLVABLE ${u.variant.productHandle} | ${u.variant.title}: ${u.reason}`);

    const planId = randomUUID();
    const out = opts.out ?? path.join(WORK_DIR, `backfill-${planId}.json`);
    await writeJsonAtomic(out, { version: 1, planId, createdAt: new Date().toISOString(), tags });
    console.log(`\nProposal: ${out}`);
    console.log(`Nothing written. Tagging alone moves NO stock, so it is followed by a seed write:`);
    console.log(`  1. backfill --stage tag  --plan '${out}'`);
    console.log(`  2. backfill --stage seed --plan '${out}'   (a separate approval; this one moves stock)`);
    return;
  }

  if (!opts.plan) fail(`backfill --stage ${stage} needs --plan <backfill.json>.`);
  const proposal = await readJson(opts.plan);

  if (stage === 'tag') {
    // Quiesce first: tagging never triggers the Flow, but a cascade already in flight will sweep in
    // whatever is tagged at that moment, giving nondeterministic partial convergence.
    const affected = [...new Set(proposal.tags.map((t) => t.blankId))];
    console.log(`Waiting for ${affected.length} group(s) to go quiet before tagging...`);
    const q = await quiesce({
      readSignatures: async () => {
        const s = await loadStore({ requireWrite: false });
        return new Map(affected.map((b) => [b, groupSignature(s.groups.get(b) ?? [])]));
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    if (q.timedOut) fail(`Groups still moving after ${q.reads} reads: ${[...q.moving].join(', ')}. Try again later.`);
    console.log(`Quiet after ${q.reads} reads.`);

    const { written, errors } = await setBlankMetafields(
      store.client,
      proposal.tags.map((t) => ({ ownerId: t.variantId, value: t.blankId }))
    );
    heading('Tagging');
    console.log(`  tagged ${written} variant(s)`);
    if (errors.length) console.log(`  errors: ${JSON.stringify(errors)}`);

    // Record the outstanding seeds so audit reports these groups as awaiting-seed, not drift.
    const affectedBlanks = [...new Set(proposal.tags.map((t) => t.blankId))];
    const receipt = {
      planId: proposal.planId,
      seeding: true,
      startedAt: new Date().toISOString(),
      rows: affectedBlanks.map((blankId) => ({ blankId, status: 'not-attempted', detail: null, at: null, target: null })),
    };
    await writeJsonAtomic(path.join(WORK_DIR, `receipt-seed-${proposal.planId}.json`), receipt);
    console.log(
      `\nThese variants are tagged but still at 0, and they will STAY at 0: a metafield write fires ` +
        `no inventory event, so the Flow has not run. Seed them:\n  backfill --stage seed --plan '${opts.plan}'`
    );
    return;
  }

  if (stage === 'seed') {
    const newlyTagged = new Set(proposal.tags.map((t) => t.variantId));
    const affected = [...new Set(proposal.tags.map((t) => t.blankId))];
    const planId = randomUUID();
    const seeds = [];
    for (const blankId of affected) {
      const members = store.groups.get(blankId) ?? [];
      const seed = planSeed({ blankId, members, newlyTaggedIds: newlyTagged, planId });
      if (seed) seeds.push(seed);
    }

    heading(`Seed writes: ${seeds.length} group(s)`);
    for (const s of seeds) {
      console.log(`  ${s.blankId}: set ${s.target} on ${s.writeTargetTitle} (currently ${s.baseline})`);
      console.log(`      the Flow then propagates ${s.target} to ${s.siblingCount} sibling(s).`);
    }
    if (!seeds.length) {
      console.log('  nothing to seed; every group already agrees.');
      return;
    }
    if (opts.dryRun) {
      console.log('\nDRY RUN: nothing written.');
      return;
    }

    const artifact = createArtifact({ plans: seeds, mode: MODE_ABSOLUTE, planId });
    const receiptPath = path.join(WORK_DIR, `receipt-seed-${proposal.planId}.json`);
    const receipt = createReceipt(artifact);
    receipt.seeding = true;

    const result = await applyPlan({
      artifact,
      receipt,
      readGroup: createGroupReader(async () => (await loadStore({ requireWrite: false })).groups),
      write: makeWriter(store.client, store.locationId),
      persist: (r) => writeJsonAtomic(receiptPath, r),
      onRow: (e) => console.log(`  ${e.status.toUpperCase().padEnd(13)} ${e.blankId}${e.detail ? `  ${e.detail}` : ''}`),
    });

    console.log(`\n  applied ${result.applied}   skipped ${result.skipped}   failed ${result.failed}`);
    console.log(`  receipt ${receiptPath}`);
    console.log(`\nVerify once the Flow settles:\n  blank-inventory.mjs verify --receipt '${receiptPath}'`);
    if (result.failed) process.exitCode = 1;
    return;
  }

  fail(`Unknown --stage "${stage}". Use propose | tag | seed.`);
}

// ---------------------------------------------------------------------------
async function cmdUntag(opts) {
  const ids = opts.variant ?? [];
  if (!ids.length) fail('untag needs at least one --variant <gid://shopify/ProductVariant/...>.');
  // Validate the flags before the catalogue read, so a bad --quantity costs nothing and cannot be
  // discovered after the lock is held.
  const quantity = numericOpt('--quantity', opts.quantity, 0);
  if (!Number.isInteger(quantity) || quantity < 0) {
    fail(`--quantity must be a whole number of units, zero or more; got ${quantity}.`);
  }
  const store = await loadStore({ requireWrite: true });

  const targets = store.variants.filter((v) => ids.includes(v.id));
  if (targets.length !== ids.length) {
    fail(`Only ${targets.length} of ${ids.length} variant id(s) matched the catalogue.`);
  }

  heading(`Untag ${targets.length} variant(s), then set quantity ${quantity}`);
  for (const v of targets) {
    console.log(`  ${v.productHandle} | ${v.title}  (blank ${v.blankId ?? 'none'}, qty ${v.quantity})`);
    // Removing a tag changes group membership for everyone else in that group, so show them.
    const siblings = (store.groups.get(v.blankId) ?? []).filter((m) => m.id !== v.id);
    if (siblings.length) {
      console.log(`      leaves a group of ${siblings.length} other member(s):`);
      for (const s of siblings.slice(0, 5)) console.log(`        ${s.productHandle} | ${s.title} (qty ${s.quantity})`);
      if (siblings.length > 5) console.log(`        ... and ${siblings.length - 5} more`);
    }
  }
  console.log(
    `\nOrder matters: the metafield is deleted FIRST and the deletion is confirmed by a re-read ` +
      `before any quantity write. Zeroing a still-tagged variant would propagate 0 across its whole ` +
      `blank group and wipe real stock.`
  );

  if (opts.dryRun) {
    console.log('\nDRY RUN: nothing written.');
    return;
  }

  const res = await untagVariants({
    variantIds: ids,
    targetQuantity: quantity,
    deleteTags: (variantIds) => deleteBlankMetafields(store.client, variantIds),
    readVariants: async (variantIds) => {
      const fresh = await loadStore({ requireWrite: false });
      return fresh.variants.filter((v) => variantIds.includes(v.id));
    },
    setQuantity: async (v, q) => {
      const out = await setQuantity(store.client, {
        inventoryItemId: v.inventoryItemId,
        locationId: store.locationId,
        quantity: q,
        changeFromQuantity: v.quantity,
        idempotencyKey: derivedIdempotencyKey({ planId: `untag-${v.id}`, blankId: 'untag', target: q, mode: MODE_ABSOLUTE }),
      });
      return { ok: out.ok, message: out.message };
    },
    onStep: (e) => console.log(`  ${e.step} (${e.count})`),
  });

  console.log(`\n  untagged ${res.untagged}   quantity set on ${res.zeroed}`);
  if (res.failures.length) {
    console.log(`  failures: ${JSON.stringify(res.failures)}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
const USAGE = `
blank-inventory: shared-blank stock and metafield tooling.

  bodies   --stage propose|approve|show    the garment body map (run this before anything else)
  audit                                   read-only health report
  plan     --input <csv> --mode <${MODES.join('|')}> [--format ${FORMATS.join('|')}]
  apply    --plan <artifact.json> [--dry-run] [--resume]
  verify   --receipt <receipt.json> [--timeout-ms <n>]
  backfill --stage propose|tag|seed [--plan <f>] [--body B] [--color C] [--size S] [--product H] [--dry-run]
           propose --blank <id> --product H [--color C] [--allow-over-cap]   (mint a NEW id)
  untag    --variant <gid> [--variant <gid>] [--quantity 0] [--dry-run]

Input CSV is "body,color,size,value[,raw]" with a header row, or pass --format.
--product takes a product HANDLE, not a title or an id.

Env: MYSHOPIFY_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET.
     BLANK_INVENTORY_DIR overrides the working directory.
Working directory: ${WORK_DIR}
     (outside the repo by default: artifacts hold real blank ids, and this repo is public)
`;

/**
 * Refuse to write while a stray cwd-relative working directory is still present.
 *
 * A leftover `.blank-inventory/` from the old cwd-relative behaviour is both invisible to this run
 * and, if it sits inside the checkout, live supplier data in a public repo. Warn on every command
 * and block the write paths until the operator clears it.
 *
 * @param {string} command
 * @param {boolean} isWrite
 */
function assertNoOrphanWorkDir(command, isWrite) {
  const orphan = findOrphanWorkDir(process.cwd(), WORK_DIR);
  if (!orphan || !existsSync(orphan)) return;
  console.error(
    `\nWARNING: a stray ${WORK_DIR_BASENAME}/ exists at\n  ${orphan}\n` +
      `but this run uses\n  ${WORK_DIR}\n` +
      `It was probably written by an older version that resolved the working directory from the ` +
      `current directory. Its artifacts are invisible here, and if it is inside the repository it ` +
      `holds real blank ids in a public checkout. Move it somewhere private (do not delete it: it ` +
      `may be the only record of a previous tagging state), then re-run.\n`
  );
  if (isWrite) {
    fail(`Refusing to run "${command}" while a stray working directory is present. See the warning above.`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const writeCommands = new Set(['apply', 'backfill', 'untag']);
  const run = {
    bodies: cmdBodies,
    audit: cmdAudit,
    plan: cmdPlan,
    apply: cmdApply,
    verify: cmdVerify,
    backfill: cmdBackfill,
    untag: cmdUntag,
  }[opts.command];

  if (!run) {
    console.log(USAGE);
    process.exit(opts.command ? 1 : 0);
  }
  const isWrite = writeCommands.has(opts.command) && !opts.dryRun;
  assertNoOrphanWorkDir(opts.command, isWrite);
  if (isWrite) await withLock(() => run(opts));
  else await run(opts);
}

main().catch((err) => fail(err.message));
