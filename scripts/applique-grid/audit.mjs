#!/usr/bin/env node
// Audit registry vs template vs rendered charts vs the live store, so drift is visible instead of
// silent. Read-only against the store; it never fixes anything. On red, the operator chooses the
// remediation (normally re-running the affected pipeline step); nothing here, and nothing in the
// skill, edits live state or the template to silence an audit.
//
// Two modes:
//   --local  offline: registry schema, template vs derived dropdown text, charts manifest vs
//            registry spec hashes. Mid-pipeline staleness (registry ahead of a not-yet-run render
//            or template sync) prints as STALE and exits 0; structural breakage is FAIL and exits
//            non-zero. The naming-gate step gates on this.
//   (full)   everything local PLUS the live store: product GID, live Color values vs the
//            committed snapshot, published GIDs/alts/count/contiguous-tail order vs live media,
//            convention suspects, and a WARN (not a failure; the fix is in Admin, not the repo)
//            when legacy Huddle photo alts still say Gray/Navy. In full mode, STALE is drift and the
//            exit is non-zero: green means everything converged.

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAdminClient } from '../blank-inventory/lib/admin.mjs';
import {
  load as loadRegistry, activePatterns, dropdownText, pinnedMedia, REGISTRY_PATH,
} from './lib/registry.mjs';
import { galleryTailProblem } from './lib/media-plan.mjs';
import { classifyChartFiles } from './lib/artifacts.mjs';
import { findAppliqueBlock } from './lib/options-writer.mjs';
import { splitHeader } from '../size-chart/lib/template-writer.mjs';
import { buildChartAlt, isChartAlt, isChartFilename } from './lib/naming.mjs';
import { balancedPages } from './lib/layout.mjs';
import { fetchProductState } from './lib/media.mjs';
import { paginate, pageArtifacts } from './render.mjs';

const SHOP_DOMAIN = 'sapphire-shadow-studio.myshopify.com';
const DEFAULT_OUT_DIR = 'product-images/applique';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

function parseArgs(argv) {
  const opts = { local: false, outDir: DEFAULT_OUT_DIR };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith('--')) continue;
    a = a.slice(2);
    let val;
    const eq = a.indexOf('=');
    if (eq !== -1) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    if (a === 'local') { opts.local = true; continue; }
    if (a === 'out-dir') { opts.outDir = val ?? argv[++i]; continue; }
    throw new Error(`Unknown option --${a}`);
  }
  return opts;
}

// Expected chart alts derived from the registry alone (names + numbering; no image artifacts),
// so the published-vs-registry comparison works on a fresh clone.
function expectedAlts(registry) {
  const actives = activePatterns(registry);
  const sizes = balancedPages(actives.length, registry.chart.columns * registry.chart.rows);
  const out = [];
  let cursor = 0;
  sizes.forEach((size, i) => {
    const slice = actives.slice(cursor, cursor + size);
    cursor += size;
    out.push(buildChartAlt({
      page: i + 1,
      pages: sizes.length,
      first: slice[0].number,
      last: slice[slice.length - 1].number,
      names: slice.map((p) => p.name),
    }));
  });
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(opts.outDir);
  const results = []; // { level: 'PASS'|'STALE'|'FAIL'|'WARN', name, detail }
  const report = (level, name, detail = '') => {
    results.push({ level, name });
    console.log(`${level.padEnd(5)} ${name}${detail ? `: ${detail}` : ''}`);
  };

  // 1. Registry schema.
  let registry = null;
  try {
    registry = await loadRegistry(REGISTRY_PATH);
    report('PASS', 'registry schema');
  } catch (e) {
    report('FAIL', 'registry schema', e.message);
  }

  if (registry) {
    // 2. Template vs derived dropdown text.
    const rel = path.join('templates', `product.${registry.product.handle}.json`);
    try {
      const raw = await readFile(path.join(REPO_ROOT, rel), 'utf8');
      const block = findAppliqueBlock(JSON.parse(splitHeader(raw).body));
      const current = block.settings?.pattern_options ?? '';
      const derived = dropdownText(registry);
      if (current === derived) report('PASS', 'template pattern_options matches registry');
      else report('STALE', 'template pattern_options', `does not match the registry-derived text; run apply-options.mjs (${rel})`);
    } catch (e) {
      report('FAIL', 'template pattern_options', e.message);
    }

    // 3. Charts manifest vs registry spec hashes (needs the ingest manifest for hero hashes).
    try {
      const ingest = JSON.parse(await readFile(path.join(outDir, 'ingest-manifest.json'), 'utf8'));
      const manifest = JSON.parse(await readFile(path.join(outDir, 'charts', 'manifest.json'), 'utf8'));
      const actives = activePatterns(registry);
      if (!actives.length) {
        report('STALE', 'charts manifest', 'registry has no active patterns');
      } else {
        const expected = paginate(actives, registry.chart.columns * registry.chart.rows)
          .map((pageDef) => pageArtifacts({ chart: registry.chart, registry, pageDef, ingest }));
        const charts = manifest.charts ?? [];
        const stale = expected.length !== charts.length
          || expected.some((e, i) => charts[i]?.specHash !== e.specHash || charts[i]?.filename !== e.filename);
        if (stale) report('STALE', 'charts manifest', 'spec hashes do not match the registry; re-run render.mjs');
        else report('PASS', 'charts manifest matches registry spec hashes');
      }
    } catch (e) {
      if (e.code === 'ENOENT') report('STALE', 'charts manifest', 'render/ingest output not present on this machine');
      else report('FAIL', 'charts manifest', e.message);
    }

    // 3b. Rendered chart files nothing references. Report only: this audit never deletes, and a
    // stale chart file is harmless clutter (every filename embeds its own spec hash).
    try {
      const chartsDir = path.join(outDir, 'charts');
      const names = (await readdir(chartsDir)).filter((n) => n.endsWith('.jpg'));
      const files = await Promise.all(names.map(async (name) => ({
        name, mtimeMs: (await stat(path.join(chartsDir, name))).mtimeMs,
      })));
      const manifest = JSON.parse(await readFile(path.join(chartsDir, 'manifest.json'), 'utf8'));
      const { stale, prunable, reason } = classifyChartFiles({
        files,
        manifestFilenames: (manifest.charts ?? []).map((c) => c.filename),
        publishedFilenames: registry.published.map((e) => e.filename),
        manifestMtimeMs: (await stat(path.join(chartsDir, 'manifest.json'))).mtimeMs,
      });
      if (!stale.length) report('PASS', 'no unreferenced chart files on disk');
      else {
        report('WARN', 'unreferenced chart file(s)', `${stale.length} (${stale.join(', ')}); ${prunable ? 'remove with render.mjs --prune-charts' : `pruning is NOT safe right now: ${reason}`}`);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') report('FAIL', 'chart files', e.message);
    }
  }

  // 4+. Live checks.
  if (!opts.local && registry) {
    const client = createAdminClient({ domain: SHOP_DOMAIN });
    const state = await fetchProductState(client, registry.product.handle);

    if (state.id === registry.product.gid) report('PASS', 'live product GID matches registry');
    else report('FAIL', 'live product GID', `live ${state.id} != recorded ${registry.product.gid}`);

    if (state.liveColorValues.join('\n') === registry.product.colorValues.join('\n')) {
      report('PASS', 'live Color values match the committed snapshot');
    } else {
      report('FAIL', 'live Color values', `live [${state.liveColorValues.join(', ')}] vs snapshot [${registry.product.colorValues.join(', ')}]; update the snapshot and re-run the colour guard over every active name`);
    }

    // Published record vs live media.
    const liveById = new Map(state.media.map((m) => [m.id, m]));
    const published = registry.published.slice().sort((a, b) => a.page - b.page);
    const alts = expectedAlts(registry);
    let publishedOk = true;
    if (published.length !== alts.length) {
      report('STALE', 'published chart count', `${published.length} recorded vs ${alts.length} expected page(s); run publish.mjs`);
      publishedOk = false;
    }
    for (const e of published) {
      const live = liveById.get(e.mediaGid);
      if (!live) { report('STALE', `published page ${e.page}`, `recorded media ${e.mediaGid} is not live`); publishedOk = false; continue; }
      if (live.alt !== e.alt) { report('STALE', `published page ${e.page}`, `live alt ${JSON.stringify(live.alt)} != recorded ${JSON.stringify(e.alt)}`); publishedOk = false; }
      if (live.filename !== e.filename) { report('STALE', `published page ${e.page}`, `live filename ${live.filename} != recorded ${e.filename}`); publishedOk = false; }
    }
    if (publishedOk && published.length) {
      const altsMatch = published.every((e, i) => e.alt === alts[i]);
      if (!altsMatch) { report('STALE', 'published alts', 'recorded charts do not reflect the current registry; re-render and publish'); publishedOk = false; }
    }
    if (publishedOk && published.length) {
      const pinned = pinnedMedia(registry);
      const problem = galleryTailProblem({
        liveIds: state.media.map((m) => m.id),
        publishedGids: published.map((e) => e.mediaGid),
        pinnedGids: pinned,
      });
      if (problem) report('STALE', 'gallery order', problem);
      else if (pinned.length) report('PASS', 'charts, then the pinned media, form the gallery tail in order');
      else report('PASS', 'published charts form the contiguous gallery tail in page order');
    }
    if (publishedOk && published.length) report('PASS', 'published GIDs, alts, and filenames match live media');

    // Convention suspects: chart-shaped media the record does not know.
    const recorded = new Set(published.map((e) => e.mediaGid));
    for (const m of state.media) {
      if (recorded.has(m.id)) continue;
      const fileSig = isChartFilename(m.filename, registry.product.handle);
      const altSig = isChartAlt(m.alt);
      if (fileSig || altSig) {
        report('WARN', 'suspect media', `${m.id} (${m.filename || 'no filename'}): ${fileSig && altSig ? 'matches both chart conventions but is unrecorded' : fileSig ? 'chart-convention filename, non-chart alt' : 'chart-convention alt, non-chart filename'}`);
      }
    }

    // Legacy staleness, surfaced not fixed: photo alts naming Gray/Navy (not live values) may have
    // un-shared old photos. The repo-side vocabulary is reconciled; this is live Admin data only,
    // and it is edited in Admin, not here.
    const legacyWords = ['Gray', 'Navy'].filter((w) => !state.liveColorValues.includes(w));
    const legacyHits = state.media.filter(
      (m) => legacyWords.some((w) => new RegExp(`(^|[-_,./():;'\\s])${w}([-_,./():;'\\s]|$)`, 'i').test(m.alt)),
    );
    if (legacyHits.length) {
      report('WARN', 'legacy alt drift (out of scope)', `${legacyHits.length} media alt(s) name ${legacyWords.join('/')}, which are not live Color values; fix those alts in Admin (the repo-side vocabulary is already reconciled).`);
    }
  }

  const fails = results.filter((r) => r.level === 'FAIL').length;
  const stales = results.filter((r) => r.level === 'STALE').length;
  console.log(`\n${fails} FAIL, ${stales} STALE, ${results.filter((r) => r.level === 'WARN').length} WARN, ${results.filter((r) => r.level === 'PASS').length} PASS`);
  if (fails || (!opts.local && stales)) {
    console.log(opts.local
      ? 'Audit FAILED. Fix the structural problem, then re-run.'
      : 'Audit found drift. Choose the remediation (normally re-running the affected step); never edit live state or the template just to silence this.');
    process.exitCode = 1;
  } else if (stales) {
    console.log('Offline audit passed with STALE items (expected mid-pipeline; the full audit treats them as drift).');
  } else {
    console.log('Audit green.');
    // A green FULL audit is the only moment the live gallery is known to match the record, so it
    // is the watermark snapshot retention refuses to prune past. A local audit proves nothing
    // about live state and deliberately does not move it.
    if (!opts.local) {
      await writeFile(
        path.join(outDir, 'last-converged-audit.json'),
        `${JSON.stringify({ version: 1, convergedAt: new Date().toISOString() }, null, 2)}\n`,
      ).catch((e) => console.warn(`WARN: could not record the convergence watermark (${e.message})`));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`Fatal: ${e.message}`); process.exitCode = 1; });
}
