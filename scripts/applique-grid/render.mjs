#!/usr/bin/env node
// Render the numbered applique pattern chart pages from the registry + ingested working cells.
// Balanced pagination over the ACTIVE pattern count (18 at a 3x3 cap -> 9+9; pages differ by at
// most one, larger first). Every chart filename embeds hash8 of its spec, so any change to what
// a chart shows (names, numbers, crops, hero content, grid params, styleVersion) yields a new
// filename and publish.mjs sees a replace.
//
// Output is guarded to a product-images/ path (gitignored; binaries never enter this public
// repo). The 20-megapixel Shopify upload cap is enforced here as a hard fail with a suggested
// reduced --scale, before any pixels are pushed.

import { readdir, readFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifyChartFiles } from './lib/artifacts.mjs';
import { load as loadRegistry, activePatterns, REGISTRY_PATH } from './lib/registry.mjs';
import { balancedPages, pageLayout, compositePlan } from './lib/layout.mjs';
import { buildChartSvg } from './lib/chart-svg.mjs';
import { prepareCellForBox, renderChart, resizeProof } from './lib/compose.mjs';
import {
  buildChartAlt, chartFilename, chartSpec, colorConflicts, hash8, specHash,
} from './lib/naming.mjs';

const DEFAULT_OUT_DIR = 'product-images/applique';
const OUT_DIR_RE = /(^|[\\/])product-images([\\/]|$)/;
const MP_CAP = 20e6; // Shopify's 20-megapixel media upload cap
const SAMPLE_GRIDS = ['3x3', '4x5']; // default density candidates at the sample gate

export const HELP = `Usage: node scripts/applique-grid/render.mjs [options]

Composites the numbered chart pages from the registry plus the ingested working cells. Runs the
backdrop screen as a non-fatal pre-flight and hard-fails above Shopify's 20-megapixel cap.

Options:
  --sample          Render page 1 at candidate densities plus a mobile proof, for the density gate.
  --grid CxR        Extra density candidate for --sample (default ${SAMPLE_GRIDS.join(' and ')}); repeatable.
  --page N          Render only page N. NOTE: this deliberately skips the charts manifest write, so
                    publish.mjs will refuse until a full render has run.
  --scale N         Override chart.scale (>= 1).
  --prune-charts    Delete chart files nothing references. Refused after a partial --page render,
                    and never applied to a file the registry records in published.
  --out-dir <dir>   Working directory (default ${DEFAULT_OUT_DIR}; must be under product-images/).
  --help            This text.
`;

export function parseArgs(argv) {
  const opts = {
    sample: false, page: null, scale: null, outDir: DEFAULT_OUT_DIR, grids: [], pruneCharts: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith('--')) continue;
    a = a.slice(2);
    let val;
    const eq = a.indexOf('=');
    if (eq !== -1) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    if (a === 'help') { opts.help = true; continue; }
    if (a === 'sample') { opts.sample = true; continue; }
    if (a === 'prune-charts') { opts.pruneCharts = true; continue; }
    if (a === 'page') { opts.page = Number(val ?? argv[++i]); continue; }
    if (a === 'scale') { opts.scale = Number(val ?? argv[++i]); continue; }
    if (a === 'out-dir') { opts.outDir = val ?? argv[++i]; continue; }
    if (a === 'grid') { opts.grids.push(val ?? argv[++i]); continue; }
    throw new Error(`Unknown option --${a}`);
  }
  if (opts.help) return opts;
  if (opts.page !== null && (!Number.isInteger(opts.page) || opts.page < 1)) throw new Error('--page must be a positive integer');
  if (opts.scale !== null && !(Number.isFinite(opts.scale) && opts.scale >= 1)) throw new Error('--scale must be a number >= 1');
  if (opts.grids.length && !opts.sample) throw new Error('--grid only applies with --sample');
  for (const g of opts.grids) {
    if (!/^\d+x\d+$/.test(g)) throw new Error(`--grid must look like 3x3, got ${g}`);
  }
  return opts;
}

// Split the numbered actives into pages: larger pages first, display order preserved.
// Exported (with pageArtifacts) so publish.mjs and audit.mjs recompute the desired charts from
// the same code path that rendered them; a second copy of either would drift.
export function paginate(actives, cap) {
  const sizes = balancedPages(actives.length, cap);
  const out = [];
  let cursor = 0;
  sizes.forEach((size, i) => {
    out.push({ page: i + 1, pages: sizes.length, patterns: actives.slice(cursor, cursor + size) });
    cursor += size;
  });
  return out;
}

// Everything needed to render one page; pure assembly over the libs.
export function pageArtifacts({ chart, registry, pageDef, ingest }) {
  const { page, pages, patterns } = pageDef;
  const withHashes = patterns.map((p) => {
    const entry = ingest.entries[p.hero];
    if (!entry) throw new Error(`active pattern "${p.id}" hero ${p.hero} is not in the ingest manifest; run ingest.mjs first`);
    return { ...p, heroSha256: entry.sha256, cell: entry };
  });
  const spec = chartSpec({ chart, page, pages, patterns: withHashes });
  const hash = specHash(spec);
  const alt = buildChartAlt({
    page,
    pages,
    first: patterns[0].number,
    last: patterns[patterns.length - 1].number,
    names: patterns.map((p) => p.name),
  });
  const conflicts = colorConflicts(alt, registry.product.colorValues);
  if (conflicts.length) {
    throw new Error(`chart ${page} alt would bind to Color value(s) [${conflicts.join(', ')}]; rename the offending pattern (guard should have caught this at the naming gate)`);
  }
  const filename = chartFilename({ handle: registry.product.handle, page, pages, hash8: hash8(hash) });
  return { page, pages, patterns: withHashes, spec, specHash: hash, alt, filename };
}

/**
 * Backdrop-contamination pre-flight over the page's confirmed crops. Deliberately NON-FATAL and
 * deliberately the same exported function the gate table calls: rendering worked before this
 * screen existed and must keep working if the screen throws, and two implementations of the same
 * screen would tell the operator two different things about one crop.
 * @param {object} input
 * @param {Array<object>} input.patterns - the page's patterns (hero + crop)
 * @param {string} input.cellsDir
 * @param {(msg: string) => void} [input.warn]
 * @returns {Promise<Array<{id: string, minSd: number, tile: number, edge: string}>>} the suspects
 */
export async function preflightScan({ patterns, cellsDir, warn = console.warn }) {
  const suspects = [];
  try {
    const { scanCrop } = await import('./crops.mjs');
    for (const p of patterns) {
      try {
        const r = await scanCrop({ source: path.join(cellsDir, `${p.hero}.jpg`), box: p.crop });
        if (r.suspect) suspects.push({ id: p.id, minSd: r.minSd, tile: r.tile, edge: r.edge });
      } catch (e) {
        warn(`WARN: crop screen skipped for ${p.id}: ${e.message}`);
      }
    }
  } catch (e) {
    warn(`WARN: crop screen unavailable (${e.message}); rendering anyway`);
    return suspects;
  }
  for (const s of suspects) {
    warn(`WARN: ${s.id} has a near-flat tile (min tile sd ${s.minSd.toFixed(1)}, tile ${s.tile}, ${s.edge}); inspect the crop. This is a screen, not a verdict.`);
  }
  return suspects;
}

async function renderPage({ chart, layout, art, scale, outPath, cellsDir }) {
  const svg = buildChartSvg({ chart, layout, page: art.page, pages: art.pages, patterns: art.patterns });
  const plan = compositePlan(layout, scale);
  const cells = [];
  for (let i = 0; i < art.patterns.length; i++) {
    const p = art.patterns[i];
    const data = await prepareCellForBox({
      source: path.join(cellsDir, `${p.hero}.jpg`),
      srcWidth: p.cell.cellWidth,
      srcHeight: p.cell.cellHeight,
      box: p.crop,
      targetWidth: plan[i].width,
      targetHeight: plan[i].height,
    });
    cells.push({ data, left: plan[i].left, top: plan[i].top });
  }
  const out = await renderChart({ svg, scale, cells });
  await writeFile(outPath, out.data);
  return out;
}

const mp = (w, h) => (w * h) / 1e6;

function assertUnderMpCap(layout, scale) {
  const pixels = layout.width * scale * (layout.height * scale);
  if (pixels > MP_CAP) {
    const suggested = Math.floor(Math.sqrt(MP_CAP / (layout.width * layout.height)) * 100) / 100;
    throw new Error(
      `chart would be ${Math.round(layout.width * scale)}x${Math.round(layout.height * scale)} `
      + `(${mp(layout.width * scale, layout.height * scale).toFixed(1)}MP), over Shopify's 20MP cap; re-run with --scale ${suggested}`,
    );
  }
}

// Report (and, only on --prune-charts, delete) chart files nothing references. `published` is
// consulted as well as the manifest: a file recorded as live is never a prune candidate, whatever
// the manifest says.
async function reportChartFiles({ chartsDir, registry, manifestCharts, prune }) {
  const names = (await readdir(chartsDir)).filter((n) => n.endsWith('.jpg'));
  if (!names.length) return;
  const files = await Promise.all(names.map(async (name) => ({
    name, mtimeMs: (await stat(path.join(chartsDir, name))).mtimeMs,
  })));
  const { stale, prunable, reason } = classifyChartFiles({
    files,
    manifestFilenames: manifestCharts.map((c) => c.filename),
    publishedFilenames: registry.published.map((e) => e.filename),
    // The manifest is written after this runs, so "now" is what the fresh charts are dated against.
    manifestMtimeMs: Date.now(),
  });
  if (!stale.length) return;
  console.log(`\n${stale.length} unreferenced chart file(s) on disk:`);
  stale.forEach((n) => console.log(`  ${n}`));
  if (!prune) {
    console.log('Reported only. Delete them with --prune-charts once the current charts are confirmed.');
    return;
  }
  if (!prunable) {
    console.log(`--prune-charts refused: ${reason}`);
    return;
  }
  for (const n of stale) await rm(path.join(chartsDir, n));
  console.log(`Pruned ${stale.length} unreferenced chart file(s).`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }
  const outDir = path.resolve(opts.outDir);
  if (!OUT_DIR_RE.test(outDir)) {
    throw new Error(`--out-dir must be under a 'product-images/' directory (got ${outDir}); refusing to write elsewhere.`);
  }

  const registry = await loadRegistry(REGISTRY_PATH);
  const actives = activePatterns(registry);
  if (!actives.length) throw new Error('registry has no active patterns; run the grouping/naming gate first');

  const ingestPath = path.join(outDir, 'ingest-manifest.json');
  let ingest;
  try {
    ingest = JSON.parse(await readFile(ingestPath, 'utf8'));
  } catch (e) {
    throw new Error(`ingest manifest unreadable (${e.message}); run ingest.mjs first`);
  }

  const cellsDir = path.join(outDir, 'cells');

  if (opts.sample) {
    const grids = (opts.grids.length ? opts.grids : SAMPLE_GRIDS).map((g) => {
      const [columns, rows] = g.split('x').map(Number);
      return { g, columns, rows };
    });
    const samplesDir = path.join(outDir, 'samples');
    await mkdir(samplesDir, { recursive: true });
    console.log(`Sample renders for ${actives.length} active pattern(s):\n`);
    for (const { g, columns, rows } of grids) {
      const chart = { ...registry.chart, columns, rows };
      const scale = opts.scale ?? chart.scale;
      const pageDefs = paginate(actives, columns * rows);
      const art = pageArtifacts({ chart, registry, pageDef: pageDefs[0], ingest });
      const layout = pageLayout({ chart, count: art.patterns.length });
      assertUnderMpCap(layout, scale);
      const outPath = path.join(samplesDir, `sample-${g}-page-1.jpg`);
      const out = await renderPage({ chart, layout, art, scale, outPath, cellsDir });
      const proofPath = path.join(samplesDir, `sample-${g}-page-1-mobile.jpg`);
      await writeFile(proofPath, await resizeProof(out.data));
      console.log(`  ${g}: ${pageDefs.length} page(s) (${pageDefs.map((p) => p.patterns.length).join('+')})`);
      console.log(`    ${outPath}  (${out.width}x${out.height}, ${mp(out.width, out.height).toFixed(1)}MP)`);
      console.log(`    ${proofPath}  (mobile proof)`);
    }
    console.log('\nNext: pick a density with the operator, record it in the registry chart params, then re-run render.mjs without --sample.');
    return;
  }

  const chart = registry.chart;
  const scale = opts.scale ?? chart.scale;
  const pageDefs = paginate(actives, chart.columns * chart.rows);
  const selected = opts.page === null ? pageDefs : pageDefs.filter((p) => p.page === opts.page);
  if (!selected.length) throw new Error(`--page ${opts.page} is out of range (1..${pageDefs.length})`);

  const chartsDir = path.join(outDir, 'charts');
  await mkdir(chartsDir, { recursive: true });

  const manifestCharts = [];
  for (const pageDef of selected) {
    const art = pageArtifacts({ chart, registry, pageDef, ingest });
    await preflightScan({ patterns: art.patterns, cellsDir });
    const layout = pageLayout({ chart, count: art.patterns.length });
    assertUnderMpCap(layout, scale);
    const outPath = path.join(chartsDir, art.filename);
    const out = await renderPage({ chart, layout, art, scale, outPath, cellsDir });
    manifestCharts.push({
      page: art.page,
      pages: art.pages,
      filename: art.filename,
      alt: art.alt,
      specHash: art.specHash,
      width: out.width,
      height: out.height,
      patterns: art.patterns.map((p) => ({ number: p.number, id: p.id, name: p.name })),
    });
    console.log(`Wrote ${outPath}  (${out.width}x${out.height}, ${mp(out.width, out.height).toFixed(1)}MP)`);
    console.log(`  alt: ${art.alt}`);
  }

  // Unreferenced chart files: reported on every full render, deleted only when asked. A prune
  // keyed on the manifest right after `--page N` (which deliberately skips the manifest write)
  // would delete every other page's chart, so the mtime rule refuses exactly that case.
  if (opts.page === null) await reportChartFiles({ chartsDir, registry, manifestCharts, prune: opts.pruneCharts });
  else if (opts.pruneCharts) console.log('\n--prune-charts ignored: a partial --page render does not establish which charts are current.');

  // A partial --page render still records a full-run manifest only if every page was rendered.
  if (opts.page === null) {
    const manifestPath = path.join(chartsDir, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify({ version: 1, handle: registry.product.handle, charts: manifestCharts }, null, 2)}\n`);
    console.log(`\nCharts manifest: ${manifestPath}`);
    console.log('Next: review the charts, then run publish.mjs --dry-run.');
  } else {
    console.log('\nPartial render (--page): charts manifest NOT updated; run a full render before publishing.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`Fatal: ${e.message}`); process.exitCode = 1; });
}
