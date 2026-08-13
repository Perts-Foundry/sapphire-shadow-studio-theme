#!/usr/bin/env node
// Publish the rendered chart pages to the live Huddle Crewneck gallery: create the new charts
// (alt set at create), delete the stale ones, and reorder the charts to a contiguous gallery
// tail. This is the ONE entry point in this module that writes to the LIVE store; there is no
// staging store, so every rail here is load-bearing.
//
//   - --dry-run computes and prints the full plan (verbatim alts and filenames, deletes with
//     reasons, suspects, final order) and stores it with a hash of the live media state. The live
//     run REQUIRES that stored plan, refuses if live state moved since, and consumes it either
//     way: a second attempt always starts from a fresh dry-run and a fresh operator gate.
//   - Phase order: creates -> readiness barrier -> deletes -> reorder. Deletes and the reorder
//     run only if every create reached READY with its alt verified; otherwise they are skipped,
//     the surviving plan is printed, and the exit is non-zero.
//   - Credentials come from the environment (run via `node --env-file=<gitignored file>`); argv
//     never carries a secret (unknown options are refused, secret-shaped ones by name). The shop
//     domain is a constant asserted at startup. The token never appears in output (admin.mjs
//     redaction), and the live media list is snapshotted to the gitignored output dir before
//     anything executes.

import { createHash } from 'node:crypto';
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAdminClient, missingScopes } from '../blank-inventory/lib/admin.mjs';
import {
  load as loadRegistry, save as saveRegistry, activePatterns, pinnedMedia, REGISTRY_PATH,
} from './lib/registry.mjs';
import { buildMediaPlan, evaluateReorder } from './lib/media-plan.mjs';
import { selectSnapshotsToPrune } from './lib/artifacts.mjs';
import {
  REQUIRED_SCOPES, fetchProductState, createChart, pollMediaReady, deleteMedia, reorderMedia,
} from './lib/media.mjs';
import { colorConflicts, isChartFilename } from './lib/naming.mjs';
import { paginate, pageArtifacts } from './render.mjs';

const SHOP_DOMAIN = 'sapphire-shadow-studio.myshopify.com';
const DEFAULT_OUT_DIR = 'product-images/applique';

export const HELP = `Usage: node --env-file=.env scripts/applique-grid/publish.mjs [options]

The ONE entry point in this module that writes to the LIVE store. A live run requires a stored,
stamped, operator-approved dry-run plan, and consumes it either way.

Options:
  --dry-run          Compute and print the full plan, store it stamped, write nothing.
  --manifest <path>  Charts manifest (default <out-dir>/charts/manifest.json).
  --out-dir <dir>    Working directory (default ${DEFAULT_OUT_DIR}).
  --help             This text.

Credentials come from the environment, never argv; secret-shaped options are refused by name.
`;

export function parseArgs(argv) {
  const opts = { dryRun: false, manifest: null, outDir: DEFAULT_OUT_DIR, help: false };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith('--')) continue;
    a = a.slice(2);
    let val;
    const eq = a.indexOf('=');
    if (eq !== -1) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    if (/^(token|secret|client-secret|password|api-key)$/i.test(a)) {
      throw new Error(`--${a} refused: secrets come from the env file (node --env-file=...), never argv`);
    }
    if (a === 'help') { opts.help = true; continue; }
    if (a === 'dry-run') { opts.dryRun = true; continue; }
    if (a === 'manifest') { opts.manifest = val ?? argv[++i]; continue; }
    if (a === 'out-dir') { opts.outDir = val ?? argv[++i]; continue; }
    throw new Error(`Unknown option --${a}`);
  }
  return opts;
}

// The stored dry-run plan binds to the exact live media state it was computed against.
export function liveStateHash(media) {
  const canon = media.map((m) => `${m.id}\t${m.alt}\t${m.filename}`).join('\n');
  return createHash('sha256').update(canon).digest('hex');
}

// A stored plan older than this is refused even against byte-identical live state: an approval is
// a decision about a moment, and "the gallery has not changed in a week" is not the same thing as
// "the operator said yes to this a moment ago".
export const PLAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Why a stored dry-run plan may not be executed, or null when it may. Pure, so the refusals are
 * unit-testable without a store.
 * @param {object} input
 * @param {object} input.stored - the parsed publish-plan.json
 * @param {string} input.shop
 * @param {string} input.handle
 * @param {string} input.liveHash - hash of live media as it reads NOW
 * @param {object} input.plan - the plan as recomputed NOW
 * @param {number} input.nowMs
 * @returns {string | null}
 */
export function planStampProblem({ stored, shop, handle, liveHash, plan, nowMs }) {
  if (!stored || typeof stored !== 'object') return 'stored plan is not an object';
  if (stored.version !== 1) return `stored plan version ${JSON.stringify(stored.version)} is not 1`;
  if (stored.shop !== shop) return `stored plan was computed against ${stored.shop}, not ${shop}`;
  if (stored.handle !== handle) return `stored plan was computed for product "${stored.handle}", not "${handle}"`;
  const stampedAt = Date.parse(stored.stampedAt ?? '');
  if (!Number.isFinite(stampedAt)) return 'stored plan has no usable stampedAt';
  const ageMs = nowMs - stampedAt;
  if (ageMs < 0) return 'stored plan is stamped in the future; the clock or the file is wrong';
  if (ageMs > PLAN_MAX_AGE_MS) {
    return `stored plan is ${(ageMs / 3600000).toFixed(1)}h old (limit ${PLAN_MAX_AGE_MS / 3600000}h); re-run --dry-run and re-gate`;
  }
  if (stored.liveStateHash !== liveHash) return 'live media state changed since the approved dry-run; re-run --dry-run and re-gate';
  if (stored.reorderVerdict !== plan.reorderVerdict) {
    return `stored plan approved reorder verdict "${stored.reorderVerdict}", but this run computes "${plan.reorderVerdict}"; re-run --dry-run and re-gate`;
  }
  if (JSON.stringify(stored.plan) !== JSON.stringify(plan)) {
    return 'the computed plan changed since the approved dry-run; re-run --dry-run and re-gate';
  }
  return null;
}

/**
 * Does the live gallery, re-read after the creates landed, hold exactly what this run put there
 * and nothing else? Scoped deliberately: our OWN creates and deletes are expected, so they do not
 * trip it, while a concurrent Admin edit to any untouched media does. Pure.
 * @param {object} input
 * @param {Array<{id: string, alt: string, filename: string}>} input.before - media at plan time
 * @param {Array<{id: string, alt: string, filename: string}>} input.after - media re-read now
 * @param {string[]} input.createdIds
 * @param {Set<string>} input.deletedIds
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function reconcileLiveState({ before, after, createdIds, deletedIds }) {
  const expected = new Set([
    ...before.filter((m) => !deletedIds.has(m.id)).map((m) => m.id),
    ...createdIds,
  ]);
  const actual = new Set(after.map((m) => m.id));
  const missing = [...expected].filter((id) => !actual.has(id));
  const extra = [...actual].filter((id) => !expected.has(id));
  if (missing.length) return { ok: false, reason: `media missing from the gallery since this run started: ${missing.join(', ')}` };
  if (extra.length) return { ok: false, reason: `unexpected media appeared in the gallery since this run started: ${extra.join(', ')}` };

  const afterById = new Map(after.map((m) => [m.id, m]));
  const created = new Set(createdIds);
  for (const m of before) {
    if (deletedIds.has(m.id) || created.has(m.id)) continue;
    const now = afterById.get(m.id);
    if (now.alt !== m.alt || now.filename !== m.filename) {
      return { ok: false, reason: `media ${m.id} was edited elsewhere while this run was in flight (alt or filename changed)` };
    }
  }
  return { ok: true };
}

/**
 * Phase 3, re-evaluated against ACTUAL state. The naive fix for the mid-gallery-create bug was to
 * re-read and just reorder, which buys correctness by executing a live gallery mutation the
 * operator never approved. So this re-reads, reconciles against what this run itself did, checks
 * the approved target is still achievable, snapshots the pre-reorder order, and only then moves
 * anything. Any failure returns without calling reorder at all.
 *
 * The client is injected rather than constructed, so a fake can drive every branch.
 * @param {object} input
 * @param {() => Promise<Array<{id: string, alt: string, filename: string}>>} input.readLiveOrder
 * @param {(targetIds: string[]) => Promise<void>} input.reorder
 * @param {(media: Array<object>, label: string) => Promise<string>} input.writeSnapshot
 * @param {Array<{id: string, alt: string, filename: string}>} input.before
 * @param {string[]} input.createdIds
 * @param {Set<string>} input.deletedIds
 * @param {string[]} input.targetIds - the approved final order, resolved to live GIDs
 * @param {(msg: string) => void} [input.log]
 * @returns {Promise<{status: 'converged' | 'reordered' | 'aborted', reason?: string,
 *   snapshotPath?: string, moves?: number}>}
 */
export async function reorderPhase({
  readLiveOrder, reorder, writeSnapshot, before, createdIds, deletedIds, targetIds, log = console.log,
}) {
  let after;
  try {
    after = await readLiveOrder();
  } catch (e) {
    return { status: 'aborted', reason: `could not re-read the gallery after the create barrier (${e.message}); no reorder was attempted` };
  }

  const rec = reconcileLiveState({ before, after, createdIds, deletedIds });
  if (!rec.ok) return { status: 'aborted', reason: `${rec.reason}; no reorder was attempted` };

  const actualIds = after.map((m) => m.id);
  const same = targetIds.length === actualIds.length && targetIds.every((id) => actualIds.includes(id));
  if (!same) {
    return {
      status: 'aborted',
      reason: 'reorder needed but the resulting order differs from the approved plan; re-run --dry-run',
    };
  }

  const { required, moves } = evaluateReorder(actualIds, targetIds);
  if (!required) {
    log('reorder: not needed after the creates landed (the gallery is already in the approved order)');
    return { status: 'converged', moves: 0 };
  }

  const snapshotPath = await writeSnapshot(after, 'pre-reorder');
  log(`reorder: ${moves.length} item(s) move; pre-reorder order snapshotted to ${snapshotPath}`);
  await reorder(targetIds);
  return { status: 'reordered', moves: moves.length, snapshotPath };
}

// Recompute the desired charts from the registry + ingest manifest and require the rendered
// charts manifest to agree; a stale manifest means render.mjs must run again first.
async function loadDesired({ registry, outDir, manifestPath }) {
  const ingest = JSON.parse(await readFile(path.join(outDir, 'ingest-manifest.json'), 'utf8'));
  const actives = activePatterns(registry);
  if (!actives.length) throw new Error('registry has no active patterns; nothing to publish');
  const expected = paginate(actives, registry.chart.columns * registry.chart.rows)
    .map((pageDef) => pageArtifacts({ chart: registry.chart, registry, pageDef, ingest }));

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const charts = manifest.charts ?? [];
  const stale = expected.length !== charts.length
    || expected.some((e, i) => charts[i].specHash !== e.specHash
      || charts[i].filename !== e.filename || charts[i].alt !== e.alt || charts[i].page !== e.page);
  if (stale) throw new Error('charts manifest does not match the current registry; re-run render.mjs before publishing');

  const chartsDir = path.dirname(manifestPath);
  for (const c of charts) {
    await access(path.join(chartsDir, c.filename)).catch(() => {
      throw new Error(`chart file missing: ${path.join(chartsDir, c.filename)}; re-run render.mjs`);
    });
  }
  return { charts, chartsDir };
}

// What the gate reads. The reorder line is deliberately three-valued: with creates pending, the
// post-create gallery order is not predictable, and the old code's confident "reorder not
// required" was wrong on the very first publish.
function reorderLine(plan) {
  if (plan.reorderVerdict === 'undetermined') {
    return `reorder: undetermined until post-create (up to ${plan.finalOrder.length} items may move; `
      + 'relative order of untouched media preserved)';
  }
  return `reorder ${plan.reorderVerdict === 'required' ? 'required' : 'not required'}`;
}

function printPlan(plan, liveColorValues) {
  console.log(`Live Color values: [${liveColorValues.join(', ')}]`);
  console.log(`\nPlan: ${plan.creates.length} create(s), ${plan.deletes.length} delete(s), ${plan.keeps.length} keep(s), ${reorderLine(plan)}${plan.converged ? ' (converged: nothing to do)' : ''}`);
  for (const c of plan.creates) {
    console.log(`  create  page ${c.page}: ${c.filename}`);
    console.log(`          alt: ${c.alt}`);
  }
  for (const k of plan.keeps) console.log(`  keep    page ${k.page}: ${k.id} (${k.filename})`);
  for (const d of plan.deletes) console.log(`  delete  ${d.id} (${d.filename || 'no filename'}): ${d.reason}`);
  for (const s of plan.suspects) {
    console.log(`  suspect ${s.id} (${s.filename || 'no filename'}), untouched:`);
    s.reasons.forEach((r) => console.log(`          - ${r}`));
  }
  if (plan.stalePublished.length) {
    console.log(`  stale published record(s) to prune: ${plan.stalePublished.map((e) => e.mediaGid).join(', ')}`);
  }
  if (plan.pinned.length) {
    console.log(`  pinned after the charts (registry gallery.pin_after_charts): ${plan.pinned.join(', ')}`);
  }
  // Always printed once the order could move. An "undetermined" verdict is only approvable if the
  // operator can see the DESTINATION, not just the possibility.
  if (plan.reorderVerdict !== 'not-required') {
    console.log('  target final order:');
    plan.finalOrder.forEach((e, i) => console.log(`    ${i + 1}. ${e.kind === 'live' ? e.id : `(new) ${e.filename}`}`));
  }
}

// Retention over the snapshot dir. These are the only rollback record for a live media write, so
// the rule can only ever keep more: the newest 10 stay whatever their age, the newest always
// stays, and nothing after the last converged audit is touched. With no converged audit on record,
// nothing is pruned at all.
async function pruneSnapshots(outDir) {
  const dir = path.join(outDir, 'publish-snapshots');
  let lastConvergedAtMs = null;
  try {
    const marker = JSON.parse(await readFile(path.join(outDir, 'last-converged-audit.json'), 'utf8'));
    const at = Date.parse(marker.convergedAt ?? '');
    if (Number.isFinite(at)) lastConvergedAtMs = at;
  } catch { /* no watermark: nothing is prunable, which is the safe direction */ }

  const names = await readdir(dir).catch(() => []);
  const { prune } = selectSnapshotsToPrune({ names, keep: 10, lastConvergedAtMs });
  for (const n of prune) await rm(path.join(dir, n), { force: true });
  if (prune.length) console.log(`Pruned ${prune.length} snapshot(s) older than the last converged audit.`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }
  const outDir = path.resolve(opts.outDir);
  const manifestPath = opts.manifest ? path.resolve(opts.manifest) : path.join(outDir, 'charts', 'manifest.json');
  const planPath = path.join(outDir, 'publish-plan.json');

  if (process.env.MYSHOPIFY_DOMAIN && process.env.MYSHOPIFY_DOMAIN !== SHOP_DOMAIN) {
    throw new Error(`MYSHOPIFY_DOMAIN is ${process.env.MYSHOPIFY_DOMAIN}, but this tool only publishes to ${SHOP_DOMAIN}`);
  }

  // A dry run starts from nothing: a plan left behind by a crashed or abandoned earlier dry run
  // must never be the thing a later live run reads.
  if (opts.dryRun) await rm(planPath, { force: true });

  const registry = await loadRegistry(REGISTRY_PATH);
  const { charts: desired, chartsDir } = await loadDesired({ registry, outDir, manifestPath });

  const client = createAdminClient({ domain: SHOP_DOMAIN });
  const granted = await client.scopes();
  const missing = missingScopes(granted, REQUIRED_SCOPES);
  if (missing.length) {
    throw new Error(`Missing required scope(s): ${missing.join(', ')}. The app must grant ${REQUIRED_SCOPES.join(' + ')}.`);
  }

  const state = await fetchProductState(client, registry.product.handle);
  if (state.id !== registry.product.gid) {
    throw new Error(`product GID drift for "${registry.product.handle}": live ${state.id} != recorded ${registry.product.gid}`);
  }

  // Snapshot the live media list before anything executes (dry runs snapshot too; cheap). These
  // are the ONLY rollback record for a live media write, so the phase 3 re-read snapshots too.
  await mkdir(path.join(outDir, 'publish-snapshots'), { recursive: true });
  const writeSnapshot = async (media, label) => {
    const p = path.join(
      outDir, 'publish-snapshots',
      `live-media-${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.json`,
    );
    await writeFile(p, `${JSON.stringify({ takenAt: new Date().toISOString(), label, media }, null, 2)}\n`);
    return p;
  };
  const snapshotPath = await writeSnapshot(state.media, opts.dryRun ? 'dry-run' : 'live');
  await pruneSnapshots(outDir);

  // Colour guards against the LIVE values: the committed snapshot must agree, and no planned alt
  // may bind to any value.
  const snap = registry.product.colorValues;
  if (snap.join('\n') !== state.liveColorValues.join('\n')) {
    throw new Error(`live Color values [${state.liveColorValues.join(', ')}] do not match the registry snapshot [${snap.join(', ')}]; update the snapshot, re-run the colour guard over every name (this can re-open the naming gate), and re-render`);
  }
  for (const c of desired) {
    const hits = colorConflicts(c.alt, state.liveColorValues);
    if (hits.length) throw new Error(`chart ${c.page} alt binds to live Color value(s) [${hits.join(', ')}]; rename the offending pattern`);
  }

  const plan = buildMediaPlan({
    desired,
    live: state.media,
    published: registry.published,
    variantAttachedIds: state.variantAttachedIds,
    handle: registry.product.handle,
    pinned: pinnedMedia(registry),
  });

  console.log(`${opts.dryRun ? 'DRY RUN: ' : ''}${state.title} (${registry.product.handle}), scope OK (${REQUIRED_SCOPES.join(', ')}); snapshot: ${snapshotPath}\n`);
  printPlan(plan, state.liveColorValues);

  if (opts.dryRun) {
    // The stamp is what a live run checks: shop, product, freshness, live state, the approved
    // reorder verdict, and the plan itself.
    await writeFile(planPath, `${JSON.stringify({
      version: 1,
      stampedAt: new Date().toISOString(),
      shop: SHOP_DOMAIN,
      handle: registry.product.handle,
      liveStateHash: liveStateHash(state.media),
      reorderVerdict: plan.reorderVerdict,
      plan,
    }, null, 2)}\n`);
    console.log(`\nNo writes performed. Plan stored: ${planPath}`);
    console.log('Next: on explicit operator approval of THIS plan, re-run without --dry-run.');
    return;
  }

  // Live run: require the stored dry-run plan and a byte-identical live state + plan.
  let stored;
  try {
    stored = JSON.parse(await readFile(planPath, 'utf8'));
  } catch {
    throw new Error(`no stored dry-run plan at ${planPath}; run publish.mjs --dry-run and gate on it first`);
  }
  await rm(planPath); // consumed either way: any retry starts from a fresh dry-run + fresh gate
  const stampProblem = planStampProblem({
    stored,
    shop: SHOP_DOMAIN,
    handle: registry.product.handle,
    liveHash: liveStateHash(state.media),
    plan,
    nowMs: Date.now(),
  });
  if (stampProblem) throw new Error(stampProblem);

  if (plan.converged && !plan.stalePublished.length) {
    console.log('\nAlready converged; nothing to write.');
    return;
  }

  // Phase 1: creates, in page order.
  const createdByFilename = new Map(); // desired filename -> { id, page, alt, specHash, liveFilename }
  const failures = [];
  for (const c of plan.creates) {
    try {
      const id = await createChart(client, {
        productId: state.id,
        filePath: path.join(chartsDir, c.filename),
        filename: c.filename,
        alt: c.alt,
      });
      createdByFilename.set(c.filename, { id, page: c.page, alt: c.alt, specHash: c.specHash });
      console.log(`created  page ${c.page}: ${id}`);
    } catch (e) {
      failures.push(`create page ${c.page} (${c.filename}): ${e.message}`);
    }
  }

  // Readiness barrier: every create must reach READY with its alt verified before anything is
  // deleted or moved.
  for (const [filename, rec] of createdByFilename) {
    try {
      const ready = await pollMediaReady(client, { productId: state.id, mediaId: rec.id });
      if (ready.alt !== rec.alt) {
        failures.push(`create page ${rec.page} (${filename}): READY but alt reads ${JSON.stringify(ready.alt)}, expected ${JSON.stringify(rec.alt)}`);
        continue;
      }
      rec.liveFilename = ready.filename;
      rec.ready = true;
      if (!isChartFilename(ready.filename, registry.product.handle)) {
        console.warn(`WARN: live filename "${ready.filename}" does not match the chart convention; convention-fallback identification will not see it (recorded GID still will)`);
      }
    } catch (e) {
      failures.push(`create page ${rec.page} (${filename}): ${e.message}`);
    }
  }

  // Write back what IS live now, success or not: recorded GIDs are the primary identification
  // for every later run. On failure the old entries stay (their media were not deleted).
  const readyCreates = [...createdByFilename.values()].filter((r) => r.ready);
  const staleGids = new Set(plan.stalePublished.map((e) => e.mediaGid));
  const writePublished = async (deletedIds = new Set()) => {
    const keptOld = registry.published.filter((e) => !staleGids.has(e.mediaGid) && !deletedIds.has(e.mediaGid));
    const fresh = readyCreates
      .map((r) => ({ page: r.page, filename: r.liveFilename, mediaGid: r.id, alt: r.alt, specHash: r.specHash }));
    const keepEntries = plan.keeps.map((k) => {
      const liveNode = state.media.find((m) => m.id === k.id);
      return { page: k.page, filename: liveNode?.filename || k.filename, mediaGid: k.id, alt: k.alt, specHash: k.specHash };
    });
    const byGid = new Map();
    for (const e of [...keptOld, ...keepEntries, ...fresh]) byGid.set(e.mediaGid, e);
    registry.published = [...byGid.values()].sort((a, b) => a.page - b.page);
    await saveRegistry(REGISTRY_PATH, registry);
  };

  if (failures.length) {
    await writePublished();
    console.error('\nCreate phase failed; deletes and reorder were SKIPPED. Surviving plan:');
    for (const d of plan.deletes) console.error(`  delete  ${d.id} (${d.filename || 'no filename'}): ${d.reason}`);
    if (plan.reorderVerdict !== 'not-required') console.error('  reorder to the planned final order');
    console.error('\nFailures:');
    failures.forEach((f) => console.error(`  ${f}`));
    console.error('\nRe-run publish.mjs --dry-run and re-gate before a second attempt.');
    process.exitCode = 1;
    return;
  }

  // Phase 2: deletes.
  const deleteIds = plan.deletes.map((d) => d.id);
  try {
    await deleteMedia(client, { productId: state.id, mediaIds: deleteIds });
    if (deleteIds.length) console.log(`deleted  ${deleteIds.length} stale chart(s)`);
  } catch (e) {
    await writePublished();
    console.error(`\nDelete phase failed: ${e.message}`);
    console.error('Reorder was SKIPPED. Re-run publish.mjs --dry-run and re-gate before a second attempt.');
    process.exitCode = 1;
    return;
  }

  // Phase 3: reorder, re-evaluated against the gallery as it actually reads now. The dry run could
  // not know where Shopify would place the creates, so the approved artifact was the TARGET order;
  // this is where that target meets reality.
  const targetIds = plan.finalOrder.map((e) => (e.kind === 'live' ? e.id : createdByFilename.get(e.filename).id));
  let outcome;
  try {
    outcome = await reorderPhase({
      readLiveOrder: async () => (await fetchProductState(client, registry.product.handle)).media,
      reorder: (ids) => reorderMedia(client, { productId: state.id, targetIds: ids }),
      writeSnapshot,
      before: state.media,
      createdIds: readyCreates.map((r) => r.id),
      deletedIds: new Set(deleteIds),
      targetIds,
    });
  } catch (e) {
    await writePublished(new Set(deleteIds));
    console.error(`\nReorder failed: ${e.message}`);
    console.error('The pre-reorder gallery order is in publish-snapshots/ if a partial move needs undoing.');
    process.exitCode = 1;
    return;
  }
  if (outcome.status === 'aborted') {
    await writePublished(new Set(deleteIds));
    console.error(`\nReorder ABORTED: ${outcome.reason}`);
    console.error('Creates and deletes are done and recorded; only the ordering is outstanding.');
    console.error('Re-run publish.mjs --dry-run and re-gate.');
    process.exitCode = 1;
    return;
  }

  await writePublished(new Set(deleteIds));
  console.log(`\nPublished: ${readyCreates.length} created, ${deleteIds.length} deleted, order converged.`);
  console.log(`Registry published record updated: ${REGISTRY_PATH}`);
  console.log('Next: run audit.mjs to confirm convergence, and spot-check the gallery via the admin Preview link (charts shared across all colourways, ordered last).');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`Fatal: ${e.message}`); process.exitCode = 1; });
}
