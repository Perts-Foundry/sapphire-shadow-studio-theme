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
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAdminClient, missingScopes } from '../blank-inventory/lib/admin.mjs';
import {
  load as loadRegistry, save as saveRegistry, activePatterns, pinnedMedia, REGISTRY_PATH,
} from './lib/registry.mjs';
import { buildMediaPlan } from './lib/media-plan.mjs';
import {
  REQUIRED_SCOPES, fetchProductState, createChart, pollMediaReady, deleteMedia, reorderMedia,
} from './lib/media.mjs';
import { colorConflicts, isChartFilename } from './lib/naming.mjs';
import { paginate, pageArtifacts } from './render.mjs';

const SHOP_DOMAIN = 'sapphire-shadow-studio.myshopify.com';
const DEFAULT_OUT_DIR = 'product-images/applique';

function parseArgs(argv) {
  const opts = { dryRun: false, manifest: null, outDir: DEFAULT_OUT_DIR };
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
    if (a === 'dry-run') { opts.dryRun = true; continue; }
    if (a === 'manifest') { opts.manifest = val ?? argv[++i]; continue; }
    if (a === 'out-dir') { opts.outDir = val ?? argv[++i]; continue; }
    throw new Error(`Unknown option --${a}`);
  }
  return opts;
}

// The stored dry-run plan binds to the exact live media state it was computed against.
function liveStateHash(media) {
  const canon = media.map((m) => `${m.id}\t${m.alt}\t${m.filename}`).join('\n');
  return createHash('sha256').update(canon).digest('hex');
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(opts.outDir);
  const manifestPath = opts.manifest ? path.resolve(opts.manifest) : path.join(outDir, 'charts', 'manifest.json');
  const planPath = path.join(outDir, 'publish-plan.json');

  if (process.env.MYSHOPIFY_DOMAIN && process.env.MYSHOPIFY_DOMAIN !== SHOP_DOMAIN) {
    throw new Error(`MYSHOPIFY_DOMAIN is ${process.env.MYSHOPIFY_DOMAIN}, but this tool only publishes to ${SHOP_DOMAIN}`);
  }

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

  // Snapshot the live media list before anything executes (dry runs snapshot too; cheap).
  await mkdir(path.join(outDir, 'publish-snapshots'), { recursive: true });
  const snapshotPath = path.join(
    outDir, 'publish-snapshots',
    `live-media-${new Date().toISOString().replace(/[:.]/g, '-')}-${opts.dryRun ? 'dry-run' : 'live'}.json`,
  );
  await writeFile(snapshotPath, `${JSON.stringify({ takenAt: new Date().toISOString(), media: state.media }, null, 2)}\n`);

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
    await writeFile(planPath, `${JSON.stringify({ liveStateHash: liveStateHash(state.media), plan }, null, 2)}\n`);
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
  if (stored.liveStateHash !== liveStateHash(state.media)
    || JSON.stringify(stored.plan) !== JSON.stringify(plan)) {
    throw new Error('live media state (or the computed plan) changed since the approved dry-run; re-run --dry-run and re-gate');
  }

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

  // Phase 3: reorder to the contiguous gallery tail.
  const targetIds = plan.finalOrder.map((e) => (e.kind === 'live' ? e.id : createdByFilename.get(e.filename).id));
  try {
    await reorderMedia(client, { productId: state.id, targetIds });
  } catch (e) {
    await writePublished(new Set(deleteIds));
    console.error(`\nReorder failed: ${e.message}`);
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
