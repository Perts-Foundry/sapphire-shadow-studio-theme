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
//   reorder   read-only: on-hand stock against the committed per-cell minimums (thresholds.json)
//   demand    read-only: net units sold per body/colour/size, and proposed threshold adjustments
//   vocab     read-only: the resolvable key space, or check a transcription before planning it
//   show      render an approved plan artifact for the approval gate (read-only)
//   plan      emit an immutable, hashed plan artifact from an adjustments CSV (refuses on any
//             non-uniform group, whatever its state)
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
import { pathToFileURL, fileURLToPath } from 'node:url';

import { createAdminClient, assertScopes, assertSingleLocation } from './lib/admin.mjs';
import { readCatalogue, liveFetchers, createGroupReader } from './lib/catalogue.mjs';
import { learnVocab, buildGroups, classifyGroups, conventionWarnings, multiLevelVariants, resolveBlank, nearMatches, groupHistogram, coverageGaps, unconvergedGroups, vocabKey, normaliseAxis, CONVERGED, DRIFT, AWAITING_SEED } from './lib/groups.mjs';
import { parseInput, MODE_ABSOLUTE, MODE_DELTA, MODES, FORMATS } from './lib/input.mjs';
import { planAll, derivedIdempotencyKey } from './lib/planner.mjs';
import { createArtifact, verifyArtifact, assertRenderablePlan, createReceipt, writeJsonAtomic, readJson, pendingBlankIds, pendingSeedBlankIds, splitStaleSeedReceipts, isReceiptComplete, markRow, ROW_APPLIED, ROW_FAILED } from './lib/receipt.mjs';
import { applyPlan } from './lib/apply.mjs';
import { planBackfill, planBlankBootstrap, planSeed, untagVariants } from './lib/backfill.mjs';
import { setQuantity, adjustQuantity, setBlankMetafields, deleteBlankMetafields } from './lib/mutations.mjs';
import { pollToConvergence, allAtTarget, groupSignature, quiesce } from './lib/convergence.mjs';
import { resolveWorkDir, findOrphanWorkDir, WORK_DIR_BASENAME } from './lib/workdir.mjs';
import { proposeBodies, createBodiesArtifact, verifyBodiesArtifact, bodyIndex, attachBodies, unmappedHandles, HIGH } from './lib/bodies.mjs';
import { loadThresholds, reconcileThresholds, assessThresholds, buildAxes, axisLabel, buildPivot, formatCell, flagReorders, selectReorders, pivotCounts, aggregateDemand, proposeAdjustments, sinceDate, NO_GROUP, THRESHOLDS_PATH } from './lib/reorder.mjs';

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
 * Read a flag that must carry a path or an identifier.
 *
 * parseArgs gives a bare `--flag` the value `true`, the same trap numericOpt closes for numbers: a
 * fat-fingered `--plan --dry-run` would otherwise reach readFile as a boolean and surface as an
 * unrelated type error rather than as the missing argument it is.
 *
 * @param {string} flag
 * @param {unknown} raw
 * @returns {string}
 */
function stringOpt(flag, raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    fail(`${flag} needs a value, got ${JSON.stringify(raw)}.`);
  }
  return raw;
}

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
 * @param {(msg: string) => never} [onInvalid] - how to reject; defaults to the process-exiting `fail`.
 *   Injectable so a unit test can assert the refusal without tearing down the process.
 * @returns {number}
 */
function numericOpt(flag, raw, fallback, onInvalid = fail) {
  if (raw === undefined) return fallback;
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) {
    onInvalid(`${flag} needs a number, got ${JSON.stringify(raw)}. It is never defaulted: the value ends up in a live write.`);
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

  const { vocab, conflicts, unbodied, display } = learnVocab(variants);
  const groups = buildGroups(variants);
  return { client, locationId, ...catalogue, variants, vocab, conflicts, unbodied, display, unmapped, groups };
}

/**
 * Receipts on disk, so audit can tell awaiting-seed from drift.
 *
 * Seeding receipts are age-bounded (see splitStaleSeedReceipts): an abandoned tag stage otherwise
 * goes on explaining a non-uniform group forever, and `awaiting-seed` outranks `drift`, so one
 * stale file silently suppresses every real Flow fault on those groups. Expired ones are returned
 * separately rather than dropped, so a report can name the file doing the masking instead of just
 * changing its verdict.
 *
 * @returns {Promise<{receipts: object[], staleSeeds: object[]}>}
 */
async function loadReceipts() {
  if (!existsSync(WORK_DIR)) return { receipts: [], staleSeeds: [] };
  const files = (await readdir(WORK_DIR)).filter((f) => f.startsWith('receipt-') && f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      out.push({ ...(await readJson(path.join(WORK_DIR, f))), sourceFile: f });
    } catch {
      /* a torn receipt is not fatal to a report */
    }
  }
  const { fresh, stale } = splitStaleSeedReceipts(out);
  return { receipts: fresh, staleSeeds: stale };
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
/** One group's JSON shape. The pre-existing keys keep their names and types; the rest is additive. */
function groupJson(row) {
  return {
    blankId: row.blankId,
    state: row.state,
    quantities: row.quantities,
    members: row.members.length,
    // Additive. `quantities` is a deduped set, so [0, 2] cannot distinguish one member at 0 from
    // seven of them; the histogram is what makes a stranded group legible.
    histogram: groupHistogram(row.members),
    memberLabels: row.members.map((m) => ({
      id: m.id,
      label: `${m.productHandle} | ${m.title}`,
      quantity: m.quantity,
    })),
  };
}

async function cmdAudit(opts) {
  // Validate the flags before the catalogue read, as untag does: a bad flag should cost nothing,
  // and a full catalogue load is slow enough that discovering it afterwards reads as a hang.
  if (opts.group && typeof opts.group !== 'string') {
    fail('--group needs a blank id, e.g. --group BLACK_CREWNECK_0001_M.');
  }
  if (opts.group && opts.stale) {
    // Refused rather than given a precedence rule. Silently dropping --stale would print the
    // single-group view even when that group is converged, which reads as "nothing is stale".
    fail('--group and --stale select different views; pass one. --group <id> reports that group whatever its state, --stale reports every non-converged group.');
  }

  const store = await loadStore({ requireWrite: false });
  const { receipts, staleSeeds } = await loadReceipts();
  const pendingSeeds = pendingSeedBlankIds(receipts);
  const allRows = classifyGroups(store.groups, pendingSeeds);
  const warnings = conventionWarnings(store.variants);
  const coverage = coverageGaps(store.variants);

  const tagged = store.variants.filter((v) => v.blankId).length;
  const untracked = store.variants.filter((v) => v.tracked === false).length;

  // --group narrows to one blank; --stale narrows to everything not converged. Both are views of
  // the same classification, never a different computation.
  let rows = allRows;
  if (opts.group) {
    rows = allRows.filter((r) => r.blankId === opts.group);
    if (!rows.length) fail(`No group "${opts.group}" on the store. Nothing carries that blank id.`);
  } else if (opts.stale) {
    rows = unconvergedGroups(allRows);
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          catalogue: {
            products: store.products.length,
            variants: store.variants.length,
            tagged,
            untagged: store.variants.length - tagged,
            untracked,
            groups: allRows.length,
          },
          coverage,
          groups: rows.map(groupJson),
          warnings,
          staleSeedReceipts: staleSeeds.map((r) => r.sourceFile),
        },
        null,
        2
      )
    );
    return;
  }

  if (opts.group) {
    const row = rows[0];
    heading(`Group ${row.blankId}`);
    console.log(`  state       ${row.state}`);
    console.log(`  quantities  [${row.quantities.join(', ')}]`);
    console.log(`  histogram   ${JSON.stringify(groupHistogram(row.members))}`);
    heading('Members');
    for (const m of row.members) console.log(`  ${String(m.quantity).padStart(5)}  ${m.productHandle} | ${m.title}`);
    return;
  }

  heading('Catalogue');
  console.log(`  products            ${store.products.length}`);
  console.log(`  variants            ${store.variants.length}`);
  console.log(`  tagged / untagged   ${tagged} / ${store.variants.length - tagged} (${untracked} untracked)`);
  console.log(`  blank groups        ${allRows.length}`);
  console.log(`  active locations    1`);

  // Coverage, at preflight rather than at the first write. The denominator is the KEYABLE
  // population (tracked, with a body, colour and size), so the gap shown is work that a backfill
  // can actually close. Legacy tagging covered a fraction of it and nothing surfaced that until a
  // write path ran.
  heading('Coverage (keyable variants in a blank group)');
  const bodyWidth = Math.max(12, ...coverage.byBody.map((r) => r.body.length));
  for (const r of coverage.byBody) {
    const pct = r.keyable ? Math.round((r.tagged / r.keyable) * 100) : 0;
    console.log(`  ${r.body.padEnd(bodyWidth)}  ${String(r.tagged).padStart(4)} / ${String(r.keyable).padEnd(4)} tagged  (${pct}%, ${r.untagged} untagged)`);
  }
  const totalPct = coverage.totals.keyable ? Math.round((coverage.totals.tagged / coverage.totals.keyable) * 100) : 0;
  console.log(`  ${'ALL'.padEnd(bodyWidth)}  ${String(coverage.totals.tagged).padStart(4)} / ${String(coverage.totals.keyable).padEnd(4)} tagged  (${totalPct}%, ${coverage.totals.untagged} untagged)`);
  if (coverage.unkeyable) {
    console.log(`  ${coverage.unkeyable} variant(s) are not keyable (untracked, or missing a body, colour or size) and can never join a group.`);
  }

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
  for (const r of allRows) byState[r.state]++;
  console.log(`  converged ${byState[CONVERGED]}   awaiting-seed ${byState[AWAITING_SEED]}   DRIFT ${byState[DRIFT]}`);
  for (const r of rows.filter((x) => x.state !== CONVERGED)) {
    console.log(
      `  ${r.state.toUpperCase().padEnd(14)} ${r.blankId}  ${JSON.stringify(groupHistogram(r.members))}  members=${r.members.length}`
    );
  }

  if (staleSeeds.length) {
    heading('Expired seeding receipts (no longer suppressing a drift report)');
    for (const r of staleSeeds) console.log(`  ${r.sourceFile}`);
    console.log(
      `  A seed settles in 80-90s, so these stopped explaining anything long ago. Any group they\n` +
        `  covered is now reported as drift rather than awaiting-seed.`
    );
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

  const { receipts, staleSeeds } = await loadReceipts();
  const pendingSeeds = pendingSeedBlankIds(receipts);

  // Every non-uniform group, whatever its state. Keying this on DRIFT alone was the hole: a group
  // stranded mid-fan-out is normally AWAITING_SEED, so it passed here and then threw a per-line
  // parse error out of groupQuantity for a store-state problem. Report all of them, with the state
  // and the histogram, because the histogram is what says whether a cascade nearly finished or
  // never started.
  const blocked = unconvergedGroups(classifyGroups(store.groups, pendingSeeds));
  if (blocked.length) {
    const detail = blocked
      .map((g) => `  ${g.state.toUpperCase().padEnd(14)} ${g.blankId}  ${JSON.stringify(groupHistogram(g.members))}`)
      .join('\n');
    fail(
      `${blocked.length} group(s) are not converged:\n${detail}\n\n` +
        `Planning on top of an unconverged group would mask a Flow fault. "awaiting-seed" explains ` +
        `why a group is non-uniform; it never makes it plannable. Check whether the fan-out is ` +
        `still running (audit --group <blankId>), and see the Troubleshooting section of ` +
        `docs/blank-inventory-sync-flow.md.`
    );
  }
  if (staleSeeds.length) {
    console.warn(
      `\nWARNING: ignoring ${staleSeeds.length} expired seeding receipt(s) ` +
        `(${staleSeeds.map((r) => r.sourceFile).join(', ')}). They were old enough that they can no ` +
        `longer explain a non-uniform group; any group they covered is now reported as drift.\n`
    );
  }

  const strayPlans = (await readdir(WORK_DIR).catch(() => [])).filter(
    (f) => f.startsWith('plan-') && f.endsWith('.json')
  );
  if (strayPlans.length) {
    console.warn(
      `\nWARNING: ${strayPlans.length} other plan artifact(s) already in the working directory ` +
        `(${strayPlans.join(', ')}). Apply the one this run prints by its exact path; do not glob.\n`
    );
  }

  const planId = randomUUID();
  const { plans, skipped } = planAll({
    rows,
    groups: store.groups,
    vocab: store.vocab,
    mode: opts.mode,
    planId,
    // Bound so a refusal can name the spellings the store actually has. Suggestion only: planAll
    // still resolves through the exact key, and nothing substitutes a near match.
    resolveBlank: (vocab, axes) => resolveBlank(vocab, axes, { display: store.display }),
  });
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
// The resolvable key space, and the renderer for the transcription gate.
//
// This exists because the vocabulary mismatch was found AFTER the operator had already confirmed a
// transcription table: the sheet says "Navy" and "Grey", the store's option values are "Classic
// Navy" and "Grey Heather", and better than half the rows could not have resolved. The gate was
// assembled by hand from tokens nothing had checked. `vocab --check` renders it from the file the
// planner will actually read, so the confirmation and the plan see the same bytes.
// ---------------------------------------------------------------------------
async function cmdVocab(opts) {
  await loadBodies({ requireApproved: true });
  const store = await loadStore({ requireWrite: false });

  if (opts.check) {
    if (!MODES.includes(opts.mode)) {
      fail(`vocab --check needs --mode ${MODES.join('|')}, the same mode the plan will use: the parser enforces the mode contract, and checking under a different one checks a different file.`);
    }
    const checkPath = stringOpt('--check', opts.check);
    const text = await readFile(checkPath, 'utf8');
    const { rows } = parseInput(text, { mode: opts.mode, format: opts.format });

    heading(`Vocabulary check: ${rows.length} row(s) from ${checkPath}`);
    let unresolved = 0;
    for (const row of rows) {
      const label = row.blankId ?? `${row.body} / ${row.color} / ${row.size}`;
      const asWritten = row.asWritten ? `  (as written: ${JSON.stringify(row.asWritten)})` : '';
      let blankId = null;
      let problem = null;
      try {
        blankId = row.blankId ?? resolveBlank(store.vocab, row, { display: store.display });
        if (row.blankId && !store.groups.has(row.blankId)) {
          problem = 'no variant on the store carries this blank id';
          blankId = null;
        }
      } catch (err) {
        problem = err.message;
      }
      if (blankId) {
        const members = store.groups.get(blankId) ?? [];
        console.log(`  line ${String(row.line).padStart(3)}  OK          ${label}${asWritten}`);
        console.log(`              -> ${blankId}  (${members.length} member(s), currently ${JSON.stringify(groupHistogram(members))}), value ${row.rawValue}`);
      } else {
        unresolved++;
        console.log(`  line ${String(row.line).padStart(3)}  UNRESOLVED  ${label}${asWritten}`);
        console.log(`              ${problem}`);
      }
    }

    console.log(`\n  ${rows.length - unresolved} of ${rows.length} row(s) resolve.`);
    if (unresolved) {
      console.log(
        `\n${unresolved} row(s) do not resolve. Do NOT edit a token to make it resolve, and do not\n` +
          `drop the row to make the table clean: either is a silent change to what the sheet said.\n` +
          `Show the operator the token and the suggestion side by side and let them decide.`
      );
      process.exitCode = 1;
    }
    return;
  }

  // The whole key space: what a transcription is allowed to say, and where the holes are.
  const axis = (name) => [...store.display[name].entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const bodies = axis('body');
  const colors = axis('color');
  const sizes = axis('size');

  heading(`Resolvable keys: ${bodies.length} body/bodies x ${colors.length} colour(s) x ${sizes.length} size(s)`);
  console.log('  These are the store\'s own spellings. A transcription must use them exactly.\n');
  let missing = 0;
  for (const [, bodyLabel] of bodies) {
    console.log(`  ${bodyLabel}`);
    for (const [, colorLabel] of colors) {
      const cells = sizes.map(([, sizeLabel]) => {
        // Key through vocabKey, not a hand-joined string: the separator and the normalisation rules
        // live in one place, and a lookup that reimplements them drifts from what the planner does.
        const blankId = store.vocab.get(vocabKey({ body: bodyLabel, color: colorLabel, size: sizeLabel }));
        if (!blankId) missing++;
        return `${sizeLabel}:${blankId ? 'yes' : '--'}`;
      });
      console.log(`    ${colorLabel.padEnd(16)} ${cells.join('  ')}`);
    }
  }
  console.log(`\n  ${store.vocab.size} key(s) resolve; ${missing} combination(s) have no blank id yet.`);
  console.log(`  A "--" is not an error: not every body is made in every colour and size. It means a`);
  console.log(`  transcription row for that combination cannot be planned until one variant is tagged.`);
  if (store.conflicts.length) {
    heading('Keys that resolve to two different blanks (refused on every path)');
    for (const c of store.conflicts) console.log(`  ${c.key}: ${c.values.join(' vs ')}`);
  }
}

// ---------------------------------------------------------------------------
// The reorder review, and the demand pass behind it.
//
// BOTH ARE READ-ONLY. Neither is in `writeCommands`, neither touches a mutation, and neither edits
// thresholds.json: that file is generated once, reviewed in a PR, and afterwards hand-edited behind
// an operator STOP. A command that quietly "fixed" a threshold to make its own report pass would
// destroy the only review surface this feature has.
//
// Everything decided here is decided in lib/reorder.mjs. These two functions read flags, print, and
// exit; they do not compute.
// ---------------------------------------------------------------------------

const THRESHOLDS_FILE = fileURLToPath(new URL('./thresholds.json', import.meta.url));

/**
 * A flag that takes no value.
 *
 * parseArgs swallows the next bare token as a value, so `--below crewneck` silently becomes
 * `below: "crewneck"` and the intended argument vanishes. Refuse it rather than coercing.
 *
 * @param {string} flag
 * @param {unknown} raw
 * @returns {boolean}
 */
function boolOpt(flag, raw) {
  if (raw === undefined) return false;
  if (raw === true) return true;
  fail(`${flag} takes no value, got ${JSON.stringify(raw)}.`);
}

/**
 * The axis space the thresholds table must cover.
 *
 * Bodies come from the APPROVED map rather than from what is tagged: a body whose variants are not
 * yet in a group still needs a minimum, and reading the axis off the tagged population would let the
 * table shrink exactly when coverage does. Colours and sizes come from the learned vocabulary, which
 * is the only place the store's own spellings exist.
 *
 * @param {object} artifact - the approved bodies artifact
 * @param {object} store
 * @returns {object}
 */
function axesFromStore(artifact, store) {
  return buildAxes({
    bodies: artifact.bodies.map((b) => b.bodyId).filter(Boolean),
    colors: [...store.display.color.keys()],
    sizes: [...store.display.size.keys()],
    display: store.display,
  });
}

/**
 * Read the committed thresholds table, or refuse.
 *
 * Every refusal is global and is computed BEFORE anything is rendered, so `--body` and `--below`
 * cannot narrow a report past the gap that made it untrustworthy.
 *
 * @param {object} params
 * @param {boolean} params.json
 * @returns {Promise<object>}
 */
async function readThresholdsOrRefuse({ json }) {
  try {
    return await loadThresholds({ read: (p) => readFile(p, 'utf8'), path: THRESHOLDS_FILE });
  } catch (err) {
    if (err.fileMissing) {
      refuseThresholds({ assessment: assessThresholds({ fileMissing: true }), json });
    }
    if (json) {
      console.log(JSON.stringify({ error: 'thresholds-invalid', message: err.message, keys: [] }, null, 2));
      process.exit(1);
    }
    fail(err.message);
  }
}

/** Print a refusal in whichever shape the caller asked for, then exit 1. */
function refuseThresholds({ assessment, json }) {
  if (json) {
    console.log(
      JSON.stringify(
        {
          error: assessment.refusals[0]?.code ?? 'thresholds-refused',
          keys: assessment.refusals.flatMap((r) => r.keys),
          refusals: assessment.refusals,
          warnings: assessment.warnings,
        },
        null,
        2
      )
    );
    process.exit(1);
  }
  console.error(`\nERROR: ${assessment.refusals.map((r) => r.message).join('\n\n')}\n`);
  for (const w of assessment.warnings) console.error(`WARNING: ${w.message}\n`);
  process.exit(1);
}

async function cmdReorder(opts) {
  // Flags before the catalogue read, as audit and untag do: a bad flag should cost nothing, and a
  // full catalogue load is slow enough that discovering it afterwards reads as a hang.
  const belowOnly = boolOpt('--below', opts.below);
  const asJson = boolOpt('--json', opts.json);
  const bodyFlag = opts.body === undefined ? null : normaliseAxis(stringOpt('--body', opts.body), 'Body');

  const loaded = await loadBodies({ requireApproved: true });
  const store = await loadStore({ requireWrite: false });
  const axes = axesFromStore(loaded.artifact, store);
  if (bodyFlag && !axes.bodies.includes(bodyFlag)) {
    fail(`Unknown --body "${bodyFlag}". The approved body map has: ${axes.bodies.join(', ')}.`);
  }

  const thresholds = await readThresholdsOrRefuse({ json: asJson });
  const reconciled = reconcileThresholds(thresholds.cells, thresholds.budgets, axes);
  const assessment = assessThresholds({ ...reconciled, mode: 'reorder' });
  if (assessment.exitCode !== 0) refuseThresholds({ assessment, json: asJson });

  const { receipts } = await loadReceipts();
  const pivot = buildPivot({ variants: store.variants, axes, pendingSeedBlankIds: pendingSeedBlankIds(receipts) });
  const flags = flagReorders(pivot, reconciled.resolved);
  const table = selectReorders({ flags, body: bodyFlag, belowOnly });
  const counts = pivotCounts(pivot, reconciled.resolved);

  if (asJson) {
    // One blob, the full report. --below is a terser HUMAN view, never a smaller JSON shape: a
    // consumer that got fewer fields depending on a display flag would be reading a different report
    // than the one the operator saw.
    console.log(
      JSON.stringify(
        {
          thresholds: { version: thresholds.version, derivedAt: thresholds.provenance?.derivedAt ?? null },
          warnings: assessment.warnings,
          cells: [...pivot.cells.values()].map((c) => ({ ...c, min: reconciled.resolved.get(c.key)?.min ?? null })),
          reorder: table,
          counts: { ...counts, flagged: table.length },
        },
        null,
        2
      )
    );
    return;
  }

  for (const w of assessment.warnings) console.warn(`\nWARNING: ${w.message}\n`);

  if (!belowOnly) {
    heading('On hand vs recommended minimum');
    console.log('  on-hand/minimum per size.  * below minimum   ? group not settled (range shown)   ! no group at all\n');
    for (const bodyRow of pivot.bodies) {
      if (bodyFlag && bodyRow.body !== bodyFlag) continue;
      console.log(`  ${bodyRow.bodyLabel}`);
      for (const colorRow of bodyRow.colors) {
        const cells = colorRow.cells.map((c) => formatCell(c, reconciled.resolved.get(c.key)));
        console.log(`    ${colorRow.colorLabel.padEnd(16)} ${cells.join('  ')}`);
      }
    }
  }

  heading(`Reorder list: ${table.length} cell(s) below their minimum`);
  if (!table.length) {
    console.log('  nothing is below its recommended minimum.');
  } else {
    const w = Math.max(12, ...table.map((f) => f.body.length));
    console.log(`  ${'body'.padEnd(w)}  ${'color'.padEnd(16)}  ${'size'.padEnd(5)}  ${'on hand'.padStart(8)}  ${'min'.padStart(4)}  ${'short'.padStart(6)}  state`);
    for (const f of table) {
      const onHand = f.state === NO_GROUP ? '--' : f.onHand !== null ? String(f.onHand) : `${f.low}-${f.high}`;
      console.log(
        `  ${f.body.padEnd(w)}  ${axisLabel(axes, 'color', f.color).padEnd(16)}  ${String(f.sizeLabel ?? f.size).padEnd(5)}  ` +
          `${onHand.padStart(8)}  ${String(f.min).padStart(4)}  ${String(f.shortfall).padStart(6)}  ${f.state}`
      );
    }
  }

  // Always printed, in both views. These two are exactly the cells a terse list would otherwise hide,
  // and "not listed" would read as "fine".
  console.log(
    `\n  ${counts.unsettled} cell(s) not settled (the Flow takes 80 to 90 seconds; re-run to resolve a "?").`
  );
  console.log(`  ${counts.noGroup} cell(s) have a minimum but no blank group at all (see "audit").`);
  console.log(
    `\n  Advisory, and a snapshot. Verify against a physical count before ordering anything; this\n` +
      `  report is never an input to a write command or a count sheet.`
  );
}

// ---------------------------------------------------------------------------
// Orders, for the demand pass.
//
// Both connections are paginated. `lineItems` is its own connection, so an order with more than one
// page of lines would otherwise be silently truncated, and a truncated read looks exactly like an
// order that sold less.
// ---------------------------------------------------------------------------
const ORDERS_QUERY = `
query BlankInventoryOrders($cursor: String, $query: String) {
  orders(first: 25, after: $cursor, query: $query, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id createdAt cancelledAt test
      lineItems(first: 50) {
        pageInfo { hasNextPage endCursor }
        nodes { id quantity currentQuantity refundableQuantity variant { id } }
      }
    }
  }
}`;

const ORDER_LINE_ITEMS_QUERY = `
query BlankInventoryOrderLineItems($id: ID!, $cursor: String) {
  order(id: $id) {
    id
    lineItems(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id quantity currentQuantity refundableQuantity variant { id } }
    }
  }
}`;

/**
 * Every line item in the window, with test and cancelled orders excluded.
 *
 * @param {object} client
 * @param {string} since - ISO instant
 * @returns {Promise<{lineItems: object[], orders: number, excluded: number, earliest: string|null}>}
 */
async function fetchDemandLineItems(client, since) {
  const lineItems = [];
  let orders = 0;
  let excluded = 0;
  let earliest = null;
  let cursor = null;
  let pages = 0;

  for (;;) {
    const conn = (await client.gql(ORDERS_QUERY, { cursor, query: `created_at:>=${since}` })).orders;
    for (const order of conn.nodes) {
      if (order.test || order.cancelledAt) {
        excluded++;
        continue;
      }
      orders++;
      if (!earliest || order.createdAt < earliest) earliest = order.createdAt;

      const collect = (nodes) => {
        for (const li of nodes) {
          lineItems.push({
            id: li.id,
            orderId: order.id,
            variantId: li.variant?.id ?? null,
            quantity: li.quantity,
            currentQuantity: li.currentQuantity,
            refundableQuantity: li.refundableQuantity,
          });
        }
      };
      collect(order.lineItems.nodes);

      let { hasNextPage, endCursor } = order.lineItems.pageInfo;
      let linePages = 0;
      while (hasNextPage) {
        const page = (await client.gql(ORDER_LINE_ITEMS_QUERY, { id: order.id, cursor: endCursor })).order?.lineItems;
        if (!page) throw new Error(`Order ${order.id} returned no line items mid-pagination; refusing a partial read.`);
        collect(page.nodes);
        ({ hasNextPage, endCursor } = page.pageInfo);
        if (++linePages >= 40) throw new Error(`Order ${order.id} exceeded 40 line-item pages; refusing to continue.`);
      }
    }
    pages++;
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
    if (pages >= 200) throw new Error('Order pagination exceeded 200 pages; refusing to continue.');
  }

  return { lineItems, orders, excluded, earliest };
}

async function cmdDemand(opts) {
  const asJson = boolOpt('--json', opts.json);
  const days = numericOpt('--days', opts.days, 60);
  let since;
  try {
    since = sinceDate(days, new Date());
  } catch (err) {
    fail(err.message);
  }

  const loaded = await loadBodies({ requireApproved: true });
  const store = await loadStore({ requireWrite: false });
  const axes = axesFromStore(loaded.artifact, store);

  const thresholds = await readThresholdsOrRefuse({ json: asJson });
  const reconciled = reconcileThresholds(thresholds.cells, thresholds.budgets, axes);
  const assessment = assessThresholds({ ...reconciled, mode: 'demand' });
  if (assessment.exitCode !== 0) refuseThresholds({ assessment, json: asJson });

  // Capability, verified rather than assumed. read_orders reaches about 60 days; anything older
  // needs read_all_orders, which this app deliberately does not request. A window the granted
  // scopes cannot serve is REFUSED, never quietly shortened: a proposal built on a window the
  // operator did not get is worse than no proposal.
  let granted;
  try {
    granted = await assertScopes(store.client, ['read_orders']);
  } catch (err) {
    fail(
      `${err.message}\n\nAdd read_orders to the app's configured scopes and reauthorise, then re-run. ` +
        `Do not work around this: there is no substitute read path here, and a shorter window, a ` +
        `partial read, a CSV export or the admin UI is not one.`
    );
  }
  if (days > 60 && !granted.includes('read_all_orders')) {
    fail(
      `--days ${days} needs read_all_orders; only read_orders is granted, which reaches about 60 days. ` +
        `Widening that grant is an operator decision, not a workaround this command may take.`
    );
  }

  const { lineItems, orders, excluded, earliest } = await fetchDemandLineItems(store.client, since);
  const variantIndex = new Map(store.variants.map((v) => [v.id, { body: v.body, color: v.color, size: v.size }]));
  const demand = aggregateDemand(lineItems, variantIndex);
  const { receipts } = await loadReceipts();
  const pivot = buildPivot({ variants: store.variants, axes, pendingSeedBlankIds: pendingSeedBlankIds(receipts) });
  const { rows, bodies: bodyTotals } = proposeAdjustments({
    byCell: demand.byCell,
    budgets: thresholds.budgets,
    resolved: reconciled.resolved,
    pivot,
  });

  const model =
    'Model: the garment body budget is redistributed across its colour x size cells by recent net ' +
    'units sold, colour and size alike. No lead time, no safety stock, no seasonality. Sales are ' +
    'attributed through the CURRENT variant-to-blank mapping, so a re-tagged variant rewrites its ' +
    'own history.';

  if (asJson) {
    console.log(
      JSON.stringify(
        { window: { days, since, earliestOrder: earliest, orders, excluded }, model, warnings: assessment.warnings, bodies: bodyTotals, rows, unattributed: demand.unattributed },
        null,
        2
      )
    );
    return;
  }

  for (const w of assessment.warnings) console.warn(`\nWARNING: ${w.message}\n`);

  heading(`Demand: ${orders} order(s) since ${since}`);
  console.log(`  earliest order actually returned: ${earliest ?? '(none)'}`);
  console.log(`  ${excluded} test or cancelled order(s) excluded; ${lineItems.length} line item(s) read.`);
  console.log(`  ${model}`);

  for (const bodyRow of pivot.bodies) {
    const bodyRows = rows.filter((r) => r.body === bodyRow.body);
    if (!bodyRows.length) continue;
    heading(bodyRow.bodyLabel);
    console.log(`  ${'color'.padEnd(16)} ${'size'.padEnd(5)} ${'units'.padStart(6)} ${'obs%'.padStart(6)} ${'thr%'.padStart(6)} ${'now'.padStart(5)} ${'->'} ${'prop'.padStart(5)} ${'delta'.padStart(6)}  status`);
    for (const r of bodyRows) {
      const pct = (n) => `${Math.round(n * 100)}%`;
      console.log(
        `  ${axisLabel(axes, 'color', r.color).padEnd(16)} ${String(r.size).toUpperCase().padEnd(5)} ${String(r.units).padStart(6)} ` +
          `${pct(r.observedShare).padStart(6)} ${pct(r.thresholdShare).padStart(6)} ${String(r.currentMin).padStart(5)} -> ` +
          `${String(r.proposedMin).padStart(5)} ${`${r.delta >= 0 ? '+' : ''}${r.delta}`.padStart(6)}  ${r.status}`
      );
    }
    for (const t of bodyTotals.filter((x) => x.body === bodyRow.body && x.budgetDrift)) {
      console.log(
        `  NOTE ${t.body}: the current minimums sum to ${t.budgetDrift.currentSum}, the stated budget ` +
          `is ${t.budgetDrift.budget}. The proposal sums to the budget.`
      );
    }
  }

  if (demand.unattributed.length) {
    heading(`Unattributed line items: ${demand.unattributed.length}`);
    console.log('  These sold but could not be keyed to a body+colour+size (deleted or untagged variant).');
    for (const u of demand.unattributed) console.log(`  ${u.units} x ${u.variantId ?? '(no variant)'}  order ${u.orderId ?? '?'}`);
  }

  console.log(
    `\n  Nothing has been written, and this command never edits ${THRESHOLDS_PATH}. Take the ` +
      `from -> to list to the operator; only they may approve an edit, and it lands in a PR.`
  );
}

// ---------------------------------------------------------------------------
/**
 * Render an approved plan artifact. The refusal rule lives in receipt.mjs (assertRenderablePlan),
 * where it is pure and unit-tested; this is only the presentation.
 */
async function cmdShow(opts) {
  if (!opts.plan) fail('show needs --plan <artifact.json>.');
  const planPath = stringOpt('--plan', opts.plan);
  let artifact;
  try {
    artifact = assertRenderablePlan(verifyArtifact(await readJson(planPath)));
  } catch (err) {
    fail(err.message);
  }

  heading(`Plan ${artifact.planId} (mode: ${artifact.mode}, created ${artifact.createdAt})`);
  if (!artifact.groups.length) {
    console.log('  nothing to write; every group already holds its target.');
  } else {
    const w = Math.max(...artifact.groups.map((g) => g.blankId.length));
    console.log(`  ${'blank'.padEnd(w)}  ${'now'.padStart(5)} ${'->'} ${'target'.padStart(6)}  ${'CAS'.padStart(5)}  siblings  write target`);
    for (const g of artifact.groups) {
      const now = g.current ?? g.baseline;
      console.log(
        `  ${g.blankId.padEnd(w)}  ${String(now).padStart(5)} -> ${String(g.target).padStart(6)}  ` +
          `${String(g.baseline).padStart(5)}  ${String(g.siblingCount).padStart(8)}  ${g.writeTargetTitle}`
      );
    }

    heading('Per group');
    for (const g of artifact.groups) {
      console.log(`  ${g.blankId}`);
      console.log(`    write ${artifact.mode === MODE_DELTA ? `delta ${g.target - g.baseline}` : `quantity ${g.target}`} to ${g.writeTargetTitle}`);
      console.log(`    chosen because it holds ${g.baseline}, which differs from the target; a write to a`);
      console.log(`      member already at the target fires no trigger and the siblings stay stale.`);
      console.log(`    compare-and-swap baseline ${g.baseline}; the Flow then updates ${g.siblingCount} sibling(s).`);
    }
  }

  if (artifact.skipped?.length) {
    heading('Skipped');
    for (const s of artifact.skipped) console.log(`  ${s.blankId}: ${s.reason} (at ${s.current}, target ${s.target})`);
  }
  console.log(`\n  ${artifact.groups.length} group(s) would be written. Artifact: ${planPath}`);
  console.log(`  Nothing has been written to the store by this command.`);
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
  audit    [--json] [--group <blankId>] [--stale]     read-only health report
  reorder  [--json] [--body <slug>] [--below]         on-hand vs thresholds.json, flag shortfalls
  demand   [--days <n>] [--json]                      net units sold, and proposed threshold changes
  vocab    [--check <csv> --mode <${MODES.join('|')}> [--format ${FORMATS.join('|')}]]   the resolvable key space, or check a transcription
  show     --plan <artifact.json>          render a plan artifact for the approval gate
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
    reorder: cmdReorder,
    demand: cmdDemand,
    vocab: cmdVocab,
    show: cmdShow,
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

// Run as a script, but stay importable by the unit tests. import.meta.url is percent-encoded, so
// compare it against pathToFileURL(argv[1]) rather than a hand-built file:// string (the same
// entry-point subtlety documented in check-no-real-blank-ids.mjs). Guarding the dereference keeps
// the module importable under `import()`, where argv[1] is undefined.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => fail(err.message));
}

// Exported for unit tests. These three assemble a live write from parsed flags, so they are the
// paths where an untested branch would corrupt real stock: parseArgs (flag parsing), numericOpt
// (the "bare --quantity becomes 1" guard), and makeWriter (the plan-row -> mutation translator).
export { parseArgs, numericOpt, makeWriter };
