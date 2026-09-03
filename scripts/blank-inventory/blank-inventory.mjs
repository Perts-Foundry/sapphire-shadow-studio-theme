#!/usr/bin/env node
// blank-inventory: keep shared-blank stock and its variant metafield correct, with the Shopify Flow
// doing the fan-out.
//
// This tool writes to the LIVE store. There is no staging store, so the gates are not ceremony.
// The `blank-inventory` skill (.claude/skills/blank-inventory/SKILL.md) drives it and holds the
// operator approval STOPs; this file is the deterministic half.
//
//   bodies    read-only: print the declared garment body of each product (from catalogue.json)
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

import { readFile, writeFile, unlink, readdir, mkdir, rename } from 'node:fs/promises';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { createAdminClient, assertScopes, assertSingleLocation } from './lib/admin.mjs';
import { readCatalogue, liveFetchers, createGroupReader } from './lib/catalogue.mjs';
import { learnVocab, buildGroups, classifyGroups, conventionWarnings, multiLevelVariants, resolveBlank, nearMatches, groupHistogram, coverageGaps, unconvergedGroups, vocabKey, normaliseAxis, CONVERGED, DRIFT, AWAITING_SEED } from './lib/groups.mjs';
import { parseInput, MODE_ABSOLUTE, MODE_DELTA, MODES, FORMATS } from './lib/input.mjs';
import { planAll, derivedIdempotencyKey } from './lib/planner.mjs';
import { createArtifact, verifyArtifact, assertRenderablePlan, createReceipt, writeJsonAtomic, readJson, pendingBlankIds, pendingSeedBlankIds, splitStaleSeedReceipts, receiptsToArchive, receiptArtifactMismatch, isReceiptComplete, markRow, ROW_APPLIED, ROW_FAILED } from './lib/receipt.mjs';
import { applyPlanInBatches, DEFAULT_BATCH_SIZE } from './lib/apply.mjs';
import { repairPlans, assessReceiptAge, AGE_REFUSE, AGE_WARN } from './lib/repair.mjs';
import { planBackfill, planBlankBootstrap, planSeed, untagVariants } from './lib/backfill.mjs';
import { setQuantity, adjustQuantity, setBlankMetafields, deleteBlankMetafields } from './lib/mutations.mjs';
import { watchToConvergence, groupSignature, quiesce, DEFAULT_TIMEOUT_MS } from './lib/convergence.mjs';
import { resolveWorkDir, findOrphanWorkDir, WORK_DIR_BASENAME } from './lib/workdir.mjs';
import { bodyIndex, attachBodies, unmappedHandles } from './lib/bodies.mjs';
import { loadThresholds, reconcileThresholds, assessThresholds, buildAxes, axisLabel, buildPivot, formatCell, flagReorders, selectReorders, pivotCounts, bodyTotals, buildPurchaseList, renderPurchaseList, aggregateDemand, proposeAdjustments, sinceDate, NO_GROUP, THRESHOLDS_PATH } from './lib/reorder.mjs';
import { loadCatalogue, reconcileCatalogue, assessCatalogue, garmentProducts, nonGarmentProducts } from '../lib/catalogue-manifest.mjs';

// Absolute, and by default outside any checkout. See lib/workdir.mjs for why.
const WORK_DIR = resolveWorkDir();
const LOCK_FILE = path.join(WORK_DIR, '.lock');
// The two artifacts the deleted propose/approve workflow used to write. Nothing reads them any
// more; they are named only so a leftover copy produces a one-time "this file is inert" notice
// rather than sitting in the work directory looking authoritative.
const INERT_BODY_FILES = [path.join(WORK_DIR, 'bodies.json'), path.join(WORK_DIR, 'bodies-proposal.json')];
// Where `audit` parks expired seeding receipts. A subdirectory rather than a delete: a receipt is
// the record of a real write against the live store, so it is moved out of the way, never removed.
const ARCHIVE_DIR_NAME = 'archive';
const ARCHIVE_DIR = path.join(WORK_DIR, ARCHIVE_DIR_NAME);

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
// The committed manifest is read once per process. Nested re-reads (the per-row group reader, the
// quiesce poller) must see the SAME body assignment as the plan they are checking; re-resolving it
// mid-run could silently regroup variants between a plan and its apply.
let manifestCache;
let bodiesIndexCache;
let inertNoticeShown = false;

/** Where the committed manifest lives, resolved from this file rather than from the CWD. */
const CATALOGUE_FILE = fileURLToPath(new URL('../../catalogue.json', import.meta.url));
/**
 * Read and cache the committed catalogue manifest, or refuse.
 *
 * EVERY command refuses on a missing or invalid manifest, read commands included. That is a change
 * from the body-map artifact this replaced, which read commands tolerated: a missing body map was a
 * WORKFLOW STATE (the operator had not run the propose/approve pair yet) and warning was the right
 * response. A missing catalogue.json is a BROKEN CHECKOUT. There is no command that creates it, so
 * there is nothing for a warning to tell the operator to go and run.
 *
 * @param {object} [params]
 * @param {(path: string) => Promise<string>} [params.read]
 * @param {string} [params.path]
 * @returns {Promise<object>}
 */
async function ensureManifest({ read = (p) => readFile(p, 'utf8'), path: manifestPath = CATALOGUE_FILE } = {}) {
  if (manifestCache === undefined) {
    try {
      manifestCache = await loadCatalogue({ read, path: manifestPath });
    } catch (err) {
      fail(err.message);
    }
  }
  return manifestCache;
}

/**
 * Notice a leftover body-map artifact exactly once per process.
 *
 * Silently ignoring it would leave a file in the work directory that looks like the authority and is
 * not; deleting it for the operator would destroy the record of what the old gate approved.
 */
function noticeInertBodyFiles() {
  if (inertNoticeShown) return;
  inertNoticeShown = true;
  const leftovers = INERT_BODY_FILES.filter((f) => existsSync(f));
  if (!leftovers.length) return;
  console.warn(
    `\nNOTICE: ${leftovers.join(', ')} is left over from the deleted "bodies --stage propose|approve"\n` +
      `workflow and is now INERT: nothing reads it. catalogue.json is the only authority on a\n` +
      `product's garment body. Delete it when you have finished comparing it against the manifest.\n`
  );
}

/**
 * The declared body index, derived from the manifest.
 * @returns {Promise<Map<string, string>>}
 */
async function ensureBodies() {
  noticeInertBodyFiles();
  if (bodiesIndexCache === undefined) bodiesIndexCache = bodyIndex(await ensureManifest());
  return bodiesIndexCache;
}

/**
 * The handles the manifest declares as non-garments, for unmappedHandles to skip.
 * @returns {Promise<Set<string>>}
 */
async function declaredNonGarmentHandles() {
  return new Set(nonGarmentProducts(await ensureManifest()).map((p) => p.handle));
}

async function loadStore({ requireWrite }) {
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
  const index = await ensureBodies();
  const variants = attachBodies(index, catalogue.variants);
  const unmapped = unmappedHandles(index, variants, await declaredNonGarmentHandles());
  if (unmapped.length && requireWrite) {
    fail(
      `${unmapped.length} product(s) have no declared body: ${unmapped.join(', ')}. A write cannot ` +
        `proceed without knowing which physical garment each variant draws from. Declare each one in ` +
        `catalogue.json, in a reviewed PR, and re-run.`
    );
  }

  const { vocab, conflicts, unbodied, display } = learnVocab(variants);
  const groups = buildGroups(variants);
  return { client, locationId, ...catalogue, variants, vocab, conflicts, unbodied, display, unmapped, groups };
}

/**
 * The live half of a convergence watch: one full catalogue read per tick, a real clock, a real
 * sleep. Separated from `waitForGroups` so a test can drive the same decision logic on a fake one.
 *
 * @returns {{readAll: () => Promise<Map<string, object[]>>, now: () => number, sleep: (ms: number) => Promise<void>}}
 */
function liveWatchDeps() {
  return {
    readAll: async () => (await loadStore({ requireWrite: false })).groups,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/**
 * Wait for a set of groups to converge on their targets.
 *
 * ONE helper, TWO callers: `verify` and the batch gate inside `apply`. Sharing it is not
 * deduplication, it is a correctness property. "The gate says converged" and "verify says
 * converged" have to be the same bar, or the gate lets a batch through that `verify` then fails,
 * and the operator is left holding two tools that disagree about the same store.
 *
 * The catalogue read per tick is unavoidable (variant metafields are not filterable in a products
 * search), so the win is one read per TICK rather than one per group per tick. `verify` used to
 * poll each group serially with its own full `loadStore` per poll, which made it quadratic in the
 * group count and piled reads onto the Admin API exactly when the Flow was already struggling.
 *
 * @param {object} params
 * @param {Map<string, number>} params.targets - blank id to the quantity it should reach
 * @param {number} [params.timeoutMs]
 * @param {number} [params.intervalMs]
 * @param {(tick: object) => void} [params.onTick]
 * @param {object} [params.deps] - injectable for tests; defaults to the live store and clock
 * @returns {Promise<{verdicts: Map<string, string>, converged: Set<string>, stale: Set<string>, missing: Set<string>, elapsedMs: number, reads: number}>}
 */
async function waitForGroups({ targets, timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs, onTick, deps = liveWatchDeps() }) {
  return watchToConvergence(deps, { targets, timeoutMs, intervalMs, onTick });
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

/**
 * Move expired seeding receipts out of the working directory root.
 *
 * Why this is not a store write, and why `audit` may do it: `audit` is read-only AGAINST THE STORE,
 * which is the property that matters. Moving a file inside the operator's own working directory is
 * not a Shopify write, and `backfill --stage propose` already writes
 * files there, so this does not change the command's trust class.
 *
 * Why it happens at all: an expired seeding receipt explains nothing (a seed settles in 80 to 90
 * seconds) but it is still read on every run, and 78 of them listed one per line drowned the report
 * that names them. Never archive a FRESH seeding receipt: those are the entire basis for reporting a
 * non-uniform group as awaiting-seed rather than as drift.
 *
 * Failure policy is skip-and-report, never abort. A rename can fail because the file is already gone
 * from a partial earlier run, because of permissions, or because a file of that name is already in
 * the archive. None of those is a reason to abandon the audit or the other moves. A destination
 * collision keeps the archived copy: receipts are immutable once written, so the same name is the
 * same content.
 *
 * @param {object[]} receipts - the FULL population, fresh and expired alike; the pure decision
 *   function picks the expired ones, so no caller can widen the selection.
 * @returns {Promise<{archived: object[], skipped: Array<{file: string, reason: string}>}>}
 */
async function archiveStaleSeedReceipts(receipts) {
  const names = new Set(receiptsToArchive(receipts));
  const targets = receipts.filter((r) => names.has(r.sourceFile));
  const archived = [];
  const skipped = [];
  if (!targets.length) return { archived, skipped };

  await mkdir(ARCHIVE_DIR, { recursive: true });
  for (const receipt of targets) {
    const from = path.join(WORK_DIR, receipt.sourceFile);
    const to = path.join(ARCHIVE_DIR, receipt.sourceFile);
    // Checked rather than left to rename, which overwrites the destination silently on POSIX.
    if (existsSync(to)) {
      skipped.push({ file: receipt.sourceFile, reason: 'already in the archive; kept the archived copy' });
      continue;
    }
    try {
      await rename(from, to);
      archived.push(receipt);
    } catch (err) {
      skipped.push({ file: receipt.sourceFile, reason: err.code ?? err.message });
    }
  }
  return { archived, skipped };
}

/** The oldest and newest `startedAt` in a set of receipts, as dates, for the one-line summary. */
function receiptDateRange(receipts) {
  const times = receipts.map((r) => Date.parse(r.startedAt ?? '')).filter((t) => Number.isFinite(t));
  if (!times.length) return null;
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  return { oldest: iso(Math.min(...times)), newest: iso(Math.max(...times)) };
}

/**
 * The one-line report of what the archive step did. Silent when it did nothing: a line saying zero
 * files moved, on every run forever, is the noise this change exists to remove.
 *
 * @param {{archived: object[], skipped: Array<{file: string, reason: string}>}} result
 */
function printArchiveSummary({ archived, skipped }) {
  if (!archived.length && !skipped.length) return;
  heading('Expired seeding receipts');
  if (archived.length) {
    const range = receiptDateRange(archived);
    const when = range ? `, started ${range.oldest} to ${range.newest}` : '';
    console.log(`  archived ${archived.length} file(s)${when} to ${ARCHIVE_DIR}`);
  }
  for (const s of skipped) console.log(`  NOT archived: ${s.file} (${s.reason})`);
  console.log(
    `  A seed settles in 80-90s, so these stopped explaining anything long ago. Any group they\n` +
      `  covered is now reported as drift rather than awaiting-seed. Archived receipts are inert:\n` +
      `  nothing reads them again.`
  );
}

// ---------------------------------------------------------------------------
// The body axis. See lib/bodies.mjs for why body is declared rather than inferred, and what the
// reversal cost.
// ---------------------------------------------------------------------------

/**
 * Print the declared body of every product.
 *
 * READ-ONLY. This used to be a three-stage `--stage propose|approve|show` workflow that inferred a
 * body per product, presented the guess at an operator gate, and sealed the approved result in a
 * hash-checked artifact. catalogue.json is the authority now, so there is nothing to propose and
 * nothing to approve: this command prints what the manifest declares and writes nothing.
 */
async function cmdBodies(opts = {}) {
  // Refused by name rather than ignored. The propose/approve pair wrote real artifacts, and an
  // operator or a script that still passes the flag must be told the workflow is gone, not handed a
  // read-only report that looks like it worked.
  if (opts.stage !== undefined) {
    fail(
      `"bodies --stage ${opts.stage}" no longer exists. The propose/approve/show workflow was ` +
        `deleted: catalogue.json declares each product's garment body, so there is nothing to ` +
        `propose and nothing to approve. Run "bodies" with no flags for the read-only report, and ` +
        `edit catalogue.json in a reviewed PR to change an assignment.`
    );
  }
  if (opts.proposal !== undefined) {
    fail(
      `"bodies --proposal" no longer exists. There is no body proposal file: catalogue.json is the ` +
        `only authority on a product's garment body.`
    );
  }

  const manifest = await ensureManifest();
  noticeInertBodyFiles();

  const garments = garmentProducts(manifest);
  const others = nonGarmentProducts(manifest);
  const w = Math.max(...[...manifest.products.keys()].map((h) => h.length), 12);

  heading(`Declared bodies: ${garments.length} garment product(s)`);
  for (const p of garments) {
    const range = manifest.bodies.get(p.body);
    console.log(
      `  ${p.handle.padEnd(w)}  ${p.body.padEnd(14)}  ${range.colors.length} colour(s) x ${range.sizes.length} size(s)`
    );
  }

  if (others.length) {
    heading('Not garments (declared "body": null, so no blank group)');
    for (const p of others) console.log(`  ${p.handle.padEnd(w)}  ${p.title}`);
  }

  console.log(`\n  declared in ${CATALOGUE_FILE}`);
  console.log(
    `\nThis is a DECLARATION, not a guess, and it decides which products share stock. Two products ` +
      `on one\nbody share a pool; two on different bodies must not. Change it in a reviewed PR; no ` +
      `command edits it.`
  );
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
  // Before any view branches, so every path leaves the working directory in the same state and a
  // --json or --group run cannot quietly skip the tidy-up the human view performs.
  const archiveResult = await archiveStaleSeedReceipts([...receipts, ...staleSeeds]);
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
          // The files themselves are no longer listed: they have been moved, so a consumer that
          // held the old array would be holding paths that no longer resolve.
          staleSeedReceipts: {
            archived: archiveResult.archived.length,
            skipped: archiveResult.skipped,
            dir: ARCHIVE_DIR_NAME,
          },
        },
        null,
        2
      )
    );
    return;
  }

  printArchiveSummary(archiveResult);

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
  check(store.unmapped.length === 0, 'every product has a declared body', `${store.unmapped.length} product(s) undeclared in catalogue.json: ${store.unmapped.join(', ')}`);
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
  // requireWrite is false (planning writes nothing to Shopify), but the declared body map is still a
  // hard precondition: a plan built on a colour+size key would target the wrong garment's pool, and
  // the plan is what apply executes without re-deriving.
  await ensureBodies();
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
  await ensureBodies();
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
// The catalogue manifest lives at the repo root, not beside the policy file: it declares the shape
// of the whole offering, and other tooling is expected to migrate onto it (see TODO.md).

/**
 * A flag that takes no value.
 *
 * parseArgs swallows the next bare token as a value, so `--below crewneck` silently becomes
 * `below: "crewneck"` and the intended argument vanishes. Refuse it rather than coercing.
 *
 * Coercing matters more since `--no-batch` joined the callers: a truthiness test on
 * `--no-batch counts.csv` would read the swallowed filename as "yes, disable the write pacing".
 *
 * @param {string} flag
 * @param {unknown} raw
 * @param {(msg: string) => never} [onInvalid] - how to reject; defaults to the process-exiting
 *   `fail`. Injectable so a unit test can assert the refusal without tearing down the runner.
 * @returns {boolean}
 */
function boolOpt(flag, raw, onInvalid = fail) {
  if (raw === undefined) return false;
  if (raw === true) return true;
  return onInvalid(`${flag} takes no value, got ${JSON.stringify(raw)}.`);
}

/**
 * The axis space the thresholds table must cover.
 *
 * Bodies and their colour and size ranges come from the committed catalogue manifest, which
 * `catalogueGate` has already reconciled against the live store. Reading the axis
 * off the tagged population instead would let the table shrink exactly when coverage does, and
 * reading it off a global cross product (what this did before) invents cells for combinations a body
 * is not made in. The learned vocabulary still supplies `display`, which is the only place the
 * store's own spellings exist.
 *
 * @param {{bodies: Map<string, {colors: string[], sizes: string[]}>}} manifest
 * @param {object} store
 * @returns {object}
 */
function axesFromStore(manifest, store) {
  return buildAxes({
    bodies: [...manifest.bodies.keys()],
    colors: [...store.display.color.keys()],
    sizes: [...store.display.size.keys()],
    ranges: manifest.bodies,
    display: store.display,
  });
}

/**
 * Read the committed catalogue manifest and reconcile it against the live store, or refuse.
 *
 * ONE helper, called by both `reorder` and `demand`, so the two cannot drift into different gates
 * for the same file. It runs BEFORE thresholds are loaded: an undeclared combination means the cell
 * space itself is wrong, and reporting unthresholded or stale cells computed from a wrong cell space
 * would bury the one refusal that matters under a list of consequences.
 *
 * WHAT IT NO LONGER COMPARES: the two-way body-set check against the approved body map. The manifest
 * is the only authority on a product's body now and the body index is derived FROM it, so that check
 * would compare the manifest against a derivative of itself and could never fail for a real reason.
 * The live store replaces it as the counterparty, which is the only thing that can disagree with the
 * manifest about facts: an undeclared live product, a declared handle with no live product, a title
 * mismatch and a GID mismatch all refuse here.
 *
 * `read` and `refuse` are injected so the whole path is testable without a filesystem and without
 * exiting the test runner.
 *
 * @param {object} params
 * @param {object} params.store
 * @param {boolean} params.json
 * @param {(path: string) => Promise<string>} [params.read]
 * @param {string} [params.path]
 * @param {(params: {assessment: object, json: boolean}) => void} [params.refuse]
 * @returns {Promise<{manifest: object, warnings: Array<object>}>}
 */
export async function catalogueGate({
  store,
  json,
  read = (p) => readFile(p, 'utf8'),
  path: manifestPath = CATALOGUE_FILE,
  refuse = refuseThresholds,
}) {
  let manifest;
  try {
    manifest = await loadCatalogue({ read, path: manifestPath });
  } catch (err) {
    // Both load failures go through the SAME refusal path as a reconcile failure. A parse or schema
    // error used to print its own narrower `{error, message, keys}` object instead, so a --json
    // consumer that read `refusals` crashed on exactly the malformed-manifest case the shape exists
    // to describe.
    refuse({
      assessment: err.fileMissing ? assessCatalogue({ fileMissing: true }) : assessCatalogue({ invalid: err.message }),
      json,
    });
    return;
  }

  // `tracked` is annotated here rather than inside the pure module: only the variant read knows
  // whether a product has any tracked variant at all, and an untracked product (a gift card) is not
  // a garment and never joins a blank group, so it must not read as an undeclared one.
  const trackedHandles = new Set(
    (store.variants ?? []).filter((v) => v.tracked !== false).map((v) => v.productHandle)
  );
  const liveProducts = (store.products ?? []).map((p) => ({
    handle: p.handle,
    title: p.title,
    gid: p.id,
    tracked: trackedHandles.has(p.handle),
  }));

  const assessment = assessCatalogue(
    reconcileCatalogue({
      manifest,
      liveProducts,
      vocab: { colors: [...store.display.color.keys()], sizes: [...store.display.size.keys()] },
      variants: store.variants,
      keyOf: vocabKey,
    })
  );
  // The bare return matters even though `refuse` exits in production: without it a non-exiting
  // `refuse` would fall through and hand both call sites a result built on a manifest the gate just
  // rejected, which is worse than the TypeError a caller would get from destructuring undefined.
  if (assessment.exitCode !== 0) {
    refuse({ assessment, json });
    return;
  }
  return { manifest, warnings: assessment.warnings };
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

/**
 * The `--json` body of a refusal.
 *
 * Exactly four fields, whichever gate produced the assessment: a consumer must not have to know
 * whether the manifest or the thresholds table stopped the run in order to parse the answer.
 *
 * @param {{refusals: Array<{code: string, keys: string[]}>, warnings: Array<object>}} assessment
 * @returns {{error: string, keys: string[], refusals: Array<object>, warnings: Array<object>}}
 */
export function refusalPayload(assessment) {
  return {
    error: assessment.refusals[0]?.code ?? 'thresholds-refused',
    keys: assessment.refusals.flatMap((r) => r.keys),
    refusals: assessment.refusals,
    warnings: assessment.warnings,
  };
}

/** Print a refusal in whichever shape the caller asked for, then exit 1. */
function refuseThresholds({ assessment, json }) {
  if (json) {
    console.log(JSON.stringify(refusalPayload(assessment), null, 2));
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
  const purchaseList = boolOpt('--purchase-list', opts.purchaseList);
  const bodyFlag = opts.body === undefined ? null : normaliseAxis(stringOpt('--body', opts.body), 'Body');
  // NO JSON FORM OF THE PURCHASE LIST, deliberately. --json exists to be consumed by a program, and a
  // program consuming buy quantities is precisely the write-adjacent path this output must not open:
  // the numbers here are a supplier-ordering aid, never a restock quantity and never a count-sheet
  // entry. Do not add JSON support to this flag without revisiting that guardrail (see the skill).
  if (purchaseList && asJson) {
    fail('--purchase-list has no --json form: it is a human-facing ordering aid, and its numbers are never a machine input. Use --json for the full report.');
  }

  const store = await loadStore({ requireWrite: false });
  // The manifest gate comes first, and before the thresholds file is even read: it decides what the
  // cell space IS, and every threshold divergence is measured against that space.
  const { manifest, warnings: catalogueWarnings } = await catalogueGate({ store, json: asJson });
  const axes = axesFromStore(manifest, store);
  if (bodyFlag && !axes.bodies.includes(bodyFlag)) {
    fail(`Unknown --body "${bodyFlag}". The catalogue manifest declares: ${axes.bodies.join(', ')}.`);
  }

  const thresholds = await readThresholdsOrRefuse({ json: asJson });
  const reconciled = reconcileThresholds(thresholds.cells, thresholds.budgets, axes);
  const assessment = assessThresholds({ ...reconciled, mode: 'reorder' });
  assessment.warnings = [...catalogueWarnings, ...assessment.warnings];
  if (assessment.exitCode !== 0) refuseThresholds({ assessment, json: asJson });

  const { receipts } = await loadReceipts();
  const pivot = buildPivot({ variants: store.variants, axes, pendingSeedBlankIds: pendingSeedBlankIds(receipts) });
  const flags = flagReorders(pivot, reconciled.resolved);
  // `axes.sizes` is the manifest's declared size sequence. Passed to BOTH views so the matrix, the
  // reorder table and the purchase list cannot disagree about size order; a partial migration would
  // print half the report in manifest order and half in SIZE_ORDER.
  const table = selectReorders({ flags, body: bodyFlag, belowOnly, sizeOrder: axes.sizes });
  const counts = pivotCounts(pivot, reconciled.resolved);
  const totals = bodyTotals(pivot, reconciled.resolved);

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
          // Every derived number an operator report needs, computed here so nothing downstream has
          // to re-add the matrix by hand. See bodyTotals for what the sums do and do not include.
          totals,
        },
        null,
        2
      )
    );
    return;
  }

  for (const w of assessment.warnings) console.warn(`\nWARNING: ${w.message}\n`);

  if (purchaseList) {
    // A different question from the matrix, so it replaces it rather than following it. `--below` is
    // implied by this view (it lists only short sizes), so passing it as well is an accepted no-op.
    console.log(renderPurchaseList(buildPurchaseList(pivot, reconciled.resolved, { body: bodyFlag, sizeOrder: axes.sizes })));
    return;
  }

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

  // The shortfall column leads, because it is the number the operator is reading the table for, and
  // the rows are already sorted by it. It is a gap against a recommended minimum and never an order
  // quantity: nothing here tells anyone what to buy, which is why the column keeps the name "short".
  const shortTotal = table.reduce((n, f) => n + f.shortfall, 0);
  heading(`Reorder list: ${table.length} cell(s) below their minimum, ${shortTotal} unit(s) short`);
  if (!table.length) {
    console.log('  nothing is below its recommended minimum.');
  } else {
    console.log('  biggest gaps first.\n');
    const w = Math.max(12, ...table.map((f) => f.body.length));
    console.log(`  ${'short'.padStart(6)}  ${'body'.padEnd(w)}  ${'color'.padEnd(16)}  ${'size'.padEnd(5)}  ${'on hand'.padStart(8)}  ${'min'.padStart(4)}  state`);
    for (const f of table) {
      const onHand = f.state === NO_GROUP ? '--' : f.onHand !== null ? String(f.onHand) : `${f.low}-${f.high}`;
      console.log(
        `  ${String(f.shortfall).padStart(6)}  ${f.body.padEnd(w)}  ${axisLabel(axes, 'color', f.color).padEnd(16)}  ` +
          `${String(f.sizeLabel ?? f.size).padEnd(5)}  ${onHand.padStart(8)}  ${String(f.min).padStart(4)}  ${f.state}`
      );
    }
  }

  // Per-body totals: the one thing the matrix cannot show at a glance, and the thing that was
  // previously re-added by hand off the terminal. Under --body only that body is shown, and the
  // all-bodies row is dropped with it rather than printed as a total of one narrowed view.
  const totalRows = bodyFlag ? totals.bodies.filter((b) => b.body === bodyFlag) : totals.bodies;
  heading('Per-body totals (settled cells only)');
  const bw = Math.max(12, ...totalRows.map((b) => (b.bodyLabel ?? b.body).length), 3);
  const totalLine = (label, t) =>
    `  ${label.padEnd(bw)}  ${String(t.onHandSum).padStart(8)}  ${String(t.minSum).padStart(4)}  ` +
    `${String(t.shortfallUnits).padStart(6)}  ${String(t.surplusUnits).padStart(7)}  ` +
    `${String(t.converged).padStart(7)}  ${t.unsettled} unsettled, ${t.noGroup} no group`;
  console.log(`  ${'body'.padEnd(bw)}  ${'on hand'.padStart(8)}  ${'min'.padStart(4)}  ${'short'.padStart(6)}  ${'surplus'.padStart(7)}  ${'cells'.padStart(7)}  excluded`);
  for (const b of totalRows) console.log(totalLine(b.bodyLabel ?? b.body, b));
  if (!bodyFlag) console.log(totalLine('ALL', totals.total));
  console.log(
    `\n  Sums cover only cells whose group has settled; the excluded column counts the rest, and an\n` +
      `  excluded cell is not a zero. Short and surplus are counted separately rather than netted:\n` +
      `  a body with both is holding roughly enough units in the wrong sizes or colours, which is a\n` +
      `  different problem from being short overall. These sums are not the reorder list's total\n` +
      `  above, which also counts cells with no group and cells still settling.`
  );

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

  const store = await loadStore({ requireWrite: false });
  // Same shared gate, same order, for the same reason as `reorder`.
  const { manifest, warnings: catalogueWarnings } = await catalogueGate({ store, json: asJson });
  const axes = axesFromStore(manifest, store);

  const thresholds = await readThresholdsOrRefuse({ json: asJson });
  const reconciled = reconcileThresholds(thresholds.cells, thresholds.budgets, axes);
  const assessment = assessThresholds({ ...reconciled, mode: 'demand' });
  assessment.warnings = [...catalogueWarnings, ...assessment.warnings];
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
  // Gate 5 is the only human backstop against a stale or wrong receipt, and it cannot be that
  // backstop without seeing where the numbers came from. A repair's targets are not read off the
  // store; they are the values an earlier run's operator approved, so the operator approving THIS
  // one needs to see which run, and how long ago.
  if (artifact.repairedFrom) {
    console.log(`  REPAIR of plan ${artifact.repairedFrom}`);
    console.log(`    source receipt   ${artifact.repairedFromReceipt ?? 'unknown'}`);
    console.log(`    written          ${artifact.repairedFromWrittenAt ?? 'unknown'}`);
    console.log(`    Every target below is that run's approved value, read from the receipt and not`);
    console.log(`      from the store. Check the receipt is the right one before approving.`);
  }
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

/**
 * Unconverged groups that this artifact does NOT cover.
 *
 * `plan` already refuses while any group is non-uniform, but nothing re-checked between plan and
 * apply, and a long apply is exactly the window in which a group goes non-uniform. That is the gap
 * the 2026-09-03 incident opened.
 *
 * THE SCOPING IS THE SUBTLE PART. Groups INSIDE the artifact are excluded, for two separate
 * reasons: `checkDrift` already handles them per row, with the artifact's own approved baseline; and
 * `repair` deliberately targets non-uniform groups, so a blanket check would make every repair
 * artifact unappliable, which is the one case that most needs applying.
 *
 * @param {object} artifact
 * @param {Array<{blankId: string, state: string, quantities: number[], members: object[]}>} classified
 * @returns {Array<object>}
 */
export function outOfArtifactUnconverged(artifact, classified) {
  const inArtifact = new Set(artifact.groups.map((g) => g.blankId));
  return unconvergedGroups(classified).filter((g) => !inArtifact.has(g.blankId));
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

  const noBatch = boolOpt('--no-batch', opts.noBatch);
  const batchSize = noBatch ? Infinity : numericOpt('--batch-size', opts.batchSize, DEFAULT_BATCH_SIZE);
  if (!noBatch && !(Number.isInteger(batchSize) && batchSize > 0)) {
    fail(`--batch-size needs a positive whole number of groups, got ${JSON.stringify(opts.batchSize)}.`);
  }

  const artifact = verifyArtifact(await readJson(opts.plan));
  const store = await loadStore({ requireWrite: true });
  const byBlank = (blankId) => store.groups.get(blankId) ?? [];
  // Fresh read per row, NOT the snapshot above. The drift check only works if it sees the store as
  // it is at the moment of each write; a cached snapshot silently disables it.
  const readGroupLive = createGroupReader(async () => (await loadStore({ requireWrite: false })).groups);

  const { receipts: onDiskReceipts } = await loadReceipts();
  const blockedOutside = outOfArtifactUnconverged(
    artifact,
    classifyGroups(store.groups, pendingSeedBlankIds(onDiskReceipts))
  );
  if (blockedOutside.length && !opts.dryRun) {
    const detail = blockedOutside
      .map((g) => `  ${g.state.toUpperCase().padEnd(14)} ${g.blankId}  ${JSON.stringify(groupHistogram(g.members))}`)
      .join('\n');
    fail(
      `${blockedOutside.length} group(s) OUTSIDE this artifact are not converged:\n${detail}\n\n` +
        `Every write here fans out through the same Flow, so writing while another group's cascade ` +
        `is unfinished is what turns one slow fan-out into a stranded one. Groups inside the ` +
        `artifact are not counted: they are checked per row against the approved baseline, and a ` +
        `repair artifact targets non-uniform groups on purpose.\n` +
        `Resolve these first (audit --group <blankId>), or repair them, and re-run.`
    );
  }

  const receiptPath = opts.receipt ?? path.join(WORK_DIR, `receipt-${artifact.planId}.json`);
  let receipt;
  if (opts.resume && existsSync(receiptPath)) {
    receipt = await readJson(receiptPath);
    // A receipt is a row list plus a set of approved targets. Resuming with one that belongs to a
    // different plan drives THIS artifact's writes from THAT plan's row statuses.
    const mismatch = receiptArtifactMismatch(receipt, artifact);
    if (mismatch) {
      fail(
        `${receiptPath} does not belong to this plan: ${mismatch}. Resuming would re-attempt one ` +
          `plan's rows against another plan's targets. Point --receipt at this plan's own receipt, ` +
          `or drop --resume to start a fresh one.`
      );
    }
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
    console.log(
      noBatch
        ? '\n  --no-batch: every group would be written in one pass, with no wait between them.'
        : `\n  Pacing: ${batchSize} group(s) per batch, waiting for each batch's fan-out before the next.`
    );
    if (blockedOutside.length) {
      console.log(`  ${blockedOutside.length} group(s) outside this artifact are not converged; a real run would refuse.`);
    }
    console.log('\nNothing written.');
    return;
  }

  const timeoutMs = numericOpt('--timeout-ms', opts.timeoutMs, DEFAULT_TIMEOUT_MS);
  console.log(
    noBatch
      ? `Pacing DISABLED (--no-batch): all groups in one pass, no wait between them.`
      : `Pacing: ${batchSize} group(s) per batch, then waiting for the fan-out (timeout ${Math.round(timeoutMs / 1000)}s).`
  );

  const result = await applyPlanInBatches({
    artifact,
    receipt,
    readGroup: readGroupLive,
    write: makeWriter(store.client, store.locationId),
    persist: (r) => writeJsonAtomic(receiptPath, r),
    only: opts.resume ? pendingBlankIds(receipt) : null,
    batchSize,
    gate: !noBatch,
    // The batch gate and `verify` go through the same helper on purpose: two different bars for
    // "converged" would let the gate pass a batch that verify then fails.
    awaitBatch: async (blankIds) => {
      const targets = new Map(
        blankIds.map((blankId) => {
          const group = artifact.groups.find((g) => g.blankId === blankId);
          // Unreachable while the receipt check above holds, and named rather than left to become a
          // "cannot read properties of undefined" if it ever stops holding.
          if (!group) fail(`Receipt names blank "${blankId}", which this artifact does not contain.`);
          return [blankId, group.target];
        })
      );
      return waitForGroups({ targets, timeoutMs });
    },
    onRow: (e) => console.log(`  ${e.status.toUpperCase().padEnd(13)} ${e.blankId}${e.detail ? `  ${e.detail}` : ''}`),
    onBatch: (b) => {
      const waited = Math.round((Date.parse(b.finishedAt) - Date.parse(b.startedAt)) / 1000);
      const verdicts = Object.entries(b.verdicts)
        .map(([blankId, verdict]) => `${blankId}=${verdict}`)
        .join(' ');
      console.log(
        `  BATCH ${b.index + 1}: wrote ${b.appliedBlankIds.length}/${b.blankIds.length} ` +
          `(${b.blankIds.join(', ')}), ${waited}s${verdicts ? `, ${verdicts}` : ''}` +
          `${b.halted ? '  HALTED' : ''}`
      );
    },
  });

  heading('Apply');
  console.log(`  applied ${result.applied}   skipped ${result.skipped}   failed ${result.failed}`);
  console.log(`  batches ${result.batches.length}${result.halted ? ' (HALTED)' : ''}`);
  console.log(`  receipt ${receiptPath}`);
  console.log(`  complete: ${isReceiptComplete(result.receipt)}`);
  if (result.halted) {
    console.log(
      `\nA batch's fan-out did not converge, so the remaining groups were NOT attempted. Do not\n` +
        `re-run with --resume until those groups are settled: resuming drains first and will refuse\n` +
        `while they are outstanding. Repair them:\n` +
        `  node scripts/blank-inventory/blank-inventory.mjs repair --receipt '${receiptPath}'`
    );
    process.exitCode = 1;
  } else {
    console.log(`\nThe Flow settles in about 80-90s. Confirm with:`);
    console.log(`  node scripts/blank-inventory/blank-inventory.mjs verify --receipt '${receiptPath}'`);
  }
  if (result.failed) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// repair: finish a fan-out the Flow left stranded.
//
// It is its own command rather than a `plan --recover` flag because what it emits is an ordinary
// hashed plan artifact: gate 5, `show` and `apply` all work on it unchanged, and there is no second
// write path to audit. Read-only against the store, like `plan`.
// ---------------------------------------------------------------------------

/**
 * Find the artifact a receipt was written from.
 *
 * Two places, in order: beside the receipt (which is where a preserved incident pair lives, since
 * the runbook copies the receipt and its artifact together), then the working directory. Not a
 * glob: the filename is derived from the receipt's own `planId`, so a directory holding several
 * plans cannot resolve to the wrong one, and the hash check afterwards catches the rest.
 *
 * @param {string} receiptPath
 * @param {string} planId
 * @returns {string|null}
 */
function findOriginArtifact(receiptPath, planId) {
  const candidates = [path.join(path.dirname(receiptPath), `plan-${planId}.json`), path.join(WORK_DIR, `plan-${planId}.json`)];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * @param {object} opts
 * @param {object} [deps] - injected so the test suite can prove this command issues no write
 *   without reaching the network. `load` stands in for loadStore; `refuse` for the exiting `fail`.
 */
async function cmdRepair(opts, { load = loadStore, refuse = fail } = {}) {
  if (!opts.receipt) return refuse('repair needs --receipt <receipt.json>.');
  const receiptPath = stringOpt('--receipt', opts.receipt);
  let receipt;
  try {
    receipt = await readJson(receiptPath);
  } catch (err) {
    return refuse(`Could not read ${receiptPath}: ${err.message}`);
  }

  // PROVENANCE IS CHECKED, NOT ASSUMED. Every target below comes from this receipt, so "the group's
  // own receipt" has to be a property this command verified. A wrong --receipt path names a
  // genuinely stranded group and steers it to the other of its two live values, which looks exactly
  // like a correct repair right up to the moment it propagates.
  const artifactPath = findOriginArtifact(receiptPath, receipt.planId);
  if (!artifactPath) {
    return refuse(
      `No plan artifact for ${receipt.planId} beside ${receiptPath} or in ${WORK_DIR}. A repair's ` +
        `targets are only trustworthy if the receipt can be tied back to the plan the operator ` +
        `approved, so a receipt with no artifact is refused rather than believed.`
    );
  }
  let origin;
  try {
    origin = verifyArtifact(await readJson(artifactPath));
  } catch (err) {
    return refuse(`${artifactPath}: ${err.message}`);
  }
  const mismatch = receiptArtifactMismatch(receipt, origin);
  if (mismatch) return refuse(`${receiptPath} does not belong to ${artifactPath}: ${mismatch}.`);

  const age = assessReceiptAge(receipt);
  const ageHours = age.ageMs === null ? null : (age.ageMs / 3_600_000).toFixed(1);
  if (age.verdict === AGE_REFUSE) {
    return refuse(
      age.ageMs === null
        ? `${receiptPath} has no usable timestamp. An undatable record of a live write is refused ` +
            `rather than trusted forever.`
        : `${receiptPath} is ${ageHours}h old, past the 24h bound. A fan-out settles in 80-90 ` +
            `seconds, so a receipt this old no longer describes why the group is non-uniform. ` +
            `Investigate with audit --group <blankId> and re-plan from a fresh count.`
    );
  }
  if (age.verdict === AGE_WARN) {
    console.warn(
      `\nWARNING: ${receiptPath} is ${ageHours}h old (warn past 1h, refused past 24h). A fan-out\n` +
        `settles in 80-90 seconds, so the store has had time to move for reasons unrelated to the\n` +
        `stranding. Check the per-group diff below with more than usual care.\n`
    );
  }

  // No separate ensureBodies() call: loadStore makes the declared body map a precondition of every
  // read, and a repair never resolves a body+colour+size of its own. It works from blank ids the
  // receipt already names.
  const store = await load({ requireWrite: false });

  const planId = randomUUID();
  const { plans, skipped, refused } = repairPlans({ rows: receipt.rows, groups: store.groups, planId });

  const artifact = createArtifact({ plans, skipped: [...skipped, ...refused], mode: MODE_ABSOLUTE, planId });
  // Outside canonicalPayload, exactly as narrowedFrom is, so the content hash is undisturbed and
  // two repairs that differ only in provenance still hash identically.
  artifact.repairedFrom = origin.planId;
  artifact.repairedFromReceipt = receiptPath;
  artifact.repairedFromWrittenAt = age.writtenAt === null ? null : new Date(age.writtenAt).toISOString();

  heading(`Repair ${planId} (from plan ${origin.planId})`);
  console.log(`  receipt ${receiptPath}, written ${artifact.repairedFromWrittenAt} (${ageHours}h ago)`);
  if (!plans.length) console.log('  nothing to repair; no group is stranded on an approved target.');
  for (const p of plans) {
    console.log(`  ${p.blankId}`);
    console.log(`    ${p.siblingCount + 1} member(s) hold ${p.current} or ${p.target}; the approved target is ${p.target}`);
    console.log(`    write quantity ${p.target} to ${p.writeTargetTitle}`);
    console.log(`    chosen because it holds ${p.baseline}, which differs from the target; a write to a`);
    console.log(`      member already at the target fires no trigger and the siblings stay stale.`);
    console.log(`    compare-and-swap baseline ${p.baseline} (its LIVE quantity, not the target).`);
  }

  // Enumerated, never merely absent: to an operator scanning gate 5, a silently omitted group and
  // an overlooked one look identical.
  if (skipped.length) {
    heading('Nothing to do');
    for (const s of skipped) console.log(`  ${s.blankId}: ${s.reason} (at ${s.current}, target ${s.target})`);
  }
  if (refused.length) {
    heading('REFUSED (not in the artifact; these need a human)');
    for (const r of refused) console.log(`  ${r.blankId}: ${r.reason}\n    ${r.detail}`);
  }

  const out = opts.out ? stringOpt('--out', opts.out) : path.join(WORK_DIR, `plan-${planId}.json`);
  await writeJsonAtomic(out, artifact);
  console.log(`\nArtifact: ${out}`);
  console.log(`  ${plans.length} group(s) would be written, ${skipped.length} already fine, ${refused.length} refused.`);
  console.log(`Nothing has been written to the store. Review the plan, then:`);
  console.log(`  node scripts/blank-inventory/blank-inventory.mjs show --plan '${out}'`);
  console.log(`  node scripts/blank-inventory/blank-inventory.mjs apply --plan '${out}'`);
  return artifact;
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
  // ONE read per tick, for every group at once. This used to poll each group serially, each poll
  // doing its own full loadStore, so verifying N groups cost N x ticks catalogue reads and got
  // slower exactly as the Flow got busier.
  const res = await waitForGroups({
    targets,
    timeoutMs: numericOpt('--timeout-ms', opts.timeoutMs, DEFAULT_TIMEOUT_MS),
  });

  for (const [blankId, verdict] of res.verdicts) {
    console.log(`  ${verdict.toUpperCase().padEnd(10)} ${blankId}  target ${targets.get(blankId)}`);
  }
  console.log(`\n  ${res.reads} catalogue read(s) over ${Math.round(res.elapsedMs / 1000)}s.`);

  if (res.missing.size) {
    console.log(
      `\n${res.missing.size} group(s) have no tagged variants at all, so there is nothing to ` +
        `converge: ${[...res.missing].join(', ')}. That is a tagging problem, not a Flow one.`
    );
  }
  if (res.stale.size) {
    console.log(
      `\n${res.stale.size} group(s) did not converge. Propagation is not atomic and settles in about ` +
        `80-90s, so past ~3 minutes this is a real fault. See the Troubleshooting section of ` +
        `docs/blank-inventory-sync-flow.md. If a group is stranded with one member at target and ` +
        `its siblings on the old value, that is what "repair" is for.`
    );
  }
  if (res.stale.size || res.missing.size) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
async function cmdBackfill(opts) {
  const stage = opts.stage ?? 'propose';
  // Required even at propose: with no declared body every variant is unresolvable, so the proposal
  // would be an empty report that looks like "nothing to do" rather than "cannot tell".
  await ensureBodies();
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

  bodies                                   read-only: the declared garment body of each product
  audit    [--json] [--group <blankId>] [--stale]     read-only health report
  reorder  [--json] [--body <slug>] [--below] [--purchase-list]   on-hand vs thresholds.json, flag shortfalls
           (--purchase-list is the human-facing ordering view; it has no --json form, and the two are refused together)
  demand   [--days <n>] [--json]                      net units sold, and proposed threshold changes
  vocab    [--check <csv> --mode <${MODES.join('|')}> [--format ${FORMATS.join('|')}]]   the resolvable key space, or check a transcription
  show     --plan <artifact.json>          render a plan artifact for the approval gate
  plan     --input <csv> --mode <${MODES.join('|')}> [--format ${FORMATS.join('|')}]
  repair   --receipt <receipt.json> [--out <artifact.json>]   re-plan groups the Flow left stranded
           (read-only; emits an ordinary plan artifact for the same show/apply path)
  apply    --plan <artifact.json> [--dry-run] [--resume] [--batch-size <n>] [--no-batch] [--timeout-ms <n>]
           (paced: ${DEFAULT_BATCH_SIZE} group(s) per batch by default, waiting for each batch's fan-out)
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
    // NOT in writeCommands: repair reads the store and emits an artifact. The write it enables
    // happens later, through `apply`, behind the same gate every other plan goes through.
    repair: cmdRepair,
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

// Exported for unit tests. The first three assemble a live write from parsed flags, so they are the
// paths where an untested branch would corrupt real stock: parseArgs (flag parsing), numericOpt
// (the "bare --quantity becomes 1" guard), and makeWriter (the plan-row -> mutation translator).
//
// The last two are the receipt archive step. It is exported because it is the one part of this file
// that touches the filesystem on a READ command, and the failure modes that matter (a rename that
// fails, a collision, a receipt that must stay unread once archived) cannot be reached through an
// injected reader: they need real files in a real directory. Its test drives them against a temp
// working directory, never the operator's.
// `boolOpt` joins them for the same reason numericOpt is here: it decides whether a switch that
// disables the write pacing was really passed. `waitForGroups` is exported so the "one bar for
// converged" property can be tested across both of its callers on one fake clock, and `cmdRepair`
// so its promise of zero store writes can be asserted against a spying client rather than argued.
export { parseArgs, numericOpt, boolOpt, makeWriter, loadReceipts, archiveStaleSeedReceipts, waitForGroups, cmdRepair };
