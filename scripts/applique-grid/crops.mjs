#!/usr/bin/env node
// The crop workbench for the grouping/naming gate: propose a fabric-region box per photo, preview
// one exactly as the chart will render it, overlay a coordinate grid to nudge a box by hand, and
// screen confirmed crops for backdrop contamination.
//
// This exists because the same scratch pipeline was hand-built from nothing on two consecutive
// runs and thrown away both times. The algorithm lives in lib/autocrop.mjs (pure, tested); this
// file owns argv, pixels, and files. Image output is guarded to a `product-images/` path, with one
// deliberate exception: --emit-fixture writes the committed test fixtures, to a path this file
// resolves itself and never takes from argv.
//
// Nothing here writes to the registry, the live store, or the source photo folder.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AUTOCROP_DEFAULTS, SCAN_TILES, SUSPECT_SD, classifyTiles, proposeBox, tileStats,
} from './lib/autocrop.mjs';
import { loadSharp, prepareCellForBox } from './lib/compose.mjs';
import { outDirProblem } from './lib/out-dir.mjs';
import { pageLayout, compositePlan } from './lib/layout.mjs';
import { load as loadRegistry, activePatterns, REGISTRY_PATH } from './lib/registry.mjs';
import { REVIEW_DIR_ENV, copyToReviewDir, resolveReviewDir } from './lib/review-dir.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const FIXTURES_DIR = path.join(HERE, 'test', 'fixtures');
const DEFAULT_OUT_DIR = 'product-images/applique';

// Which real photo stands in for which algorithm archetype in the committed fixtures. Fixed here
// so --emit-fixture is reproducible and a fixture's provenance is reviewable in the diff.
const ARCHETYPES = [
  { archetype: 'achromatic-paw', patternId: 'scattered-paws' },
  { archetype: 'sparse-bee', patternId: 'busy-bees' },
  { archetype: 'cream-print', patternId: 'teacup-floral' },
  { archetype: 'youll-live', patternId: 'youll-live' },
];

export const HELP = `Usage: node scripts/applique-grid/crops.mjs <mode> [options]

Modes (exactly one):
  --propose                     Propose a fabric-region crop box per photo, from the ingest
                                manifest. Writes crop-proposals.json under --out-dir.
  --preview <hero> <l> <t> <s>  Render ONE crop exactly as render.mjs would (same code path).
  --grid <hero>                 Write a labelled 0.05 normalized-coordinate overlay.
  --scan                        Screen confirmed crops for backdrop contamination (10x10 tiles of
                                luminance stddev; min sd < ${SUSPECT_SD} is a SUSPECT to inspect, never a verdict).
  --sheet                       Contact sheet of the proposed crops (needs --propose output).
  --emit-fixture                Regenerate the committed autocrop test fixtures from the local
                                photo tree. Writes only to scripts/applique-grid/test/fixtures/.

Options:
  --hero <basename>             Restrict --propose / --scan to this photo (repeatable).
  --box <l,t,s>                 With --scan --hero: screen an arbitrary normalized square.
  --out-dir <dir>               Working directory (default ${DEFAULT_OUT_DIR}; must be under product-images/).
  --help                        This text.

${REVIEW_DIR_ENV}, when set to an absolute existing directory OUTSIDE this repo, receives a copy of
every image this tool writes. The resolved path is never printed or recorded anywhere.
`;

export function parseArgs(argv) {
  const opts = {
    propose: false,
    preview: null,
    grid: null,
    scan: false,
    sheet: false,
    emitFixture: false,
    help: false,
    heroes: [],
    box: null,
    outDir: DEFAULT_OUT_DIR,
  };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith('--')) continue;
    a = a.slice(2);
    let val;
    const eq = a.indexOf('=');
    if (eq !== -1) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    if (a === 'help') { opts.help = true; continue; }
    if (a === 'propose') { opts.propose = true; continue; }
    if (a === 'scan') { opts.scan = true; continue; }
    if (a === 'sheet') { opts.sheet = true; continue; }
    if (a === 'emit-fixture') { opts.emitFixture = true; continue; }
    if (a === 'grid') { opts.grid = val ?? argv[++i]; continue; }
    if (a === 'hero') { opts.heroes.push(val ?? argv[++i]); continue; }
    if (a === 'box') { opts.box = parseBox(val ?? argv[++i]); continue; }
    if (a === 'out-dir') { opts.outDir = val ?? argv[++i]; continue; }
    if (a === 'preview') {
      const hero = val ?? argv[++i];
      const nums = [argv[++i], argv[++i], argv[++i]].map(Number);
      if (!hero || nums.some((n) => !Number.isFinite(n))) {
        throw new Error('--preview needs <hero> <left> <top> <size>, all normalized 0..1');
      }
      opts.preview = { hero, left: nums[0], top: nums[1], size: nums[2] };
      continue;
    }
    throw new Error(`Unknown option --${a}`);
  }
  if (opts.help) return opts;
  const modes = [opts.propose, !!opts.preview, !!opts.grid, opts.scan, opts.sheet, opts.emitFixture].filter(Boolean);
  if (modes.length !== 1) throw new Error('pick exactly one mode: --propose, --preview, --grid, --scan, --sheet, or --emit-fixture');
  if (opts.box && !(opts.scan && opts.heroes.length)) throw new Error('--box only applies to --scan --hero');
  return opts;
}

function parseBox(raw) {
  const parts = String(raw ?? '').split(',').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) throw new Error('--box must look like left,top,size');
  return normalizedSquare(parts[0], parts[1], parts[2]);
}

function normalizedSquare(left, top, size) {
  if (!(size > 0) || left < 0 || top < 0 || left + size > 1 || top + size > 1) {
    throw new Error(`box out of bounds: left ${left}, top ${top}, size ${size} (need 0 <= left, left + size <= 1)`);
  }
  return { left, top, width: size, height: size };
}

// ---------------------------------------------------------------------------

async function rawPixels(filePath) {
  const sharp = await loadSharp();
  const { data, info } = await sharp(filePath).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/**
 * Box-average an image down to a grid x grid RGB raster. This is the exact reduction
 * lib/autocrop.mjs's toWorkGrid performs internally, so a fixture written this way reproduces the
 * full-resolution proposal instead of approximating it (a resampling kernel would not).
 * @param {{data: ArrayLike<number>, width: number, height: number, channels: number}} image
 * @param {number} grid
 * @returns {Buffer} grid * grid * 3 bytes
 */
export function boxDownsample({ data, width, height, channels }, grid) {
  const out = Buffer.alloc(grid * grid * 3);
  for (let gy = 0; gy < grid; gy++) {
    const y0 = Math.floor((gy * height) / grid);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / grid));
    for (let gx = 0; gx < grid; gx++) {
      const x0 = Math.floor((gx * width) / grid);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / grid));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < height; y++) {
        let idx = (y * width + x0) * channels;
        for (let x = x0; x < x1 && x < width; x++, idx += channels) {
          r += data[idx]; g += data[idx + 1]; b += data[idx + 2]; n++;
        }
      }
      const o = (gy * grid + gx) * 3;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  }
  return out;
}

// The chart cell dimensions one crop is composited into, so --preview shows the operator exactly
// the pixels the chart will carry.
function cellTarget(registry) {
  const layout = pageLayout({ chart: registry.chart, count: 1 });
  const plan = compositePlan(layout, registry.chart.scale);
  return { targetWidth: plan[0].width, targetHeight: plan[0].height };
}

async function readIngest(outDir) {
  const p = path.join(outDir, 'ingest-manifest.json');
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch (e) {
    throw new Error(`ingest manifest unreadable (${e.message}); run ingest.mjs first`);
  }
}

function cellPath(outDir, hero) {
  return path.join(outDir, 'cells', `${hero}.jpg`);
}

const fmt = (v) => (Number.isFinite(v) ? v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : String(v));

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function modePropose({ outDir, heroes }) {
  const ingest = await readIngest(outDir);
  const names = heroes.length ? heroes : Object.keys(ingest.entries).sort();
  const missing = names.filter((n) => !ingest.entries[n]);
  if (missing.length) throw new Error(`not in the ingest manifest: ${missing.join(', ')}`);

  const proposals = [];
  for (const hero of names) {
    const image = await rawPixels(cellPath(outDir, hero));
    const box = proposeBox(image);
    proposals.push({ hero, box });
    if (!box) {
      console.log(`${hero.padEnd(20)} manual crop required (no resolvable fabric region)`);
      continue;
    }
    console.log(
      `${hero.padEnd(20)} left ${fmt(box.left).padEnd(7)} top ${fmt(box.top).padEnd(7)} size ${fmt(box.size).padEnd(7)}`
      + `  (grid side ${box.diagnostics.side}, coverage ${fmt(box.diagnostics.coverage)})`,
    );
  }
  const outPath = path.join(outDir, 'crop-proposals.json');
  await writeFile(outPath, `${JSON.stringify({ version: 1, defaults: AUTOCROP_DEFAULTS, proposals }, null, 2)}\n`);
  const resolved = proposals.filter((p) => p.box).length;
  console.log(`\n${resolved}/${proposals.length} resolved. Proposals: ${outPath}`);
  console.log('Next: --preview each box the operator will see, and --grid any box that needs nudging.');
  return proposals;
}

/**
 * The exact chart-cell pixels for one normalized box, through the SAME code path render.mjs uses
 * (lib/compose.mjs's prepareCellForBox). This is the operator's decision surface, so a second
 * implementation here would let them approve pixels that never ship; crops.test.mjs asserts the
 * bytes match the render path.
 * @param {object} input
 * @param {string} input.outDir
 * @param {string} input.hero - photo basename (the manifest key)
 * @param {{left: number, top: number, width: number, height: number}} input.box
 * @param {object} input.registry
 * @returns {Promise<{png: Buffer, targetWidth: number, targetHeight: number}>}
 */
export async function previewCellPng({ outDir, hero, box, registry }) {
  const ingest = await readIngest(outDir);
  const entry = ingest.entries[hero];
  if (!entry) throw new Error(`${hero} is not in the ingest manifest`);
  const { targetWidth, targetHeight } = cellTarget(registry);
  const png = await prepareCellForBox({
    source: cellPath(outDir, hero),
    srcWidth: entry.cellWidth,
    srcHeight: entry.cellHeight,
    box,
    targetWidth,
    targetHeight,
  });
  return { png, targetWidth, targetHeight };
}

async function modePreview({ outDir, preview, registry, reviewDir }) {
  const box = normalizedSquare(preview.left, preview.top, preview.size);
  const { png, targetWidth, targetHeight } = await previewCellPng({ outDir, hero: preview.hero, box, registry });
  const sharp = await loadSharp();
  const dir = path.join(outDir, 'crop-previews');
  await mkdir(dir, { recursive: true });
  const outPath = path.join(dir, `${preview.hero}.jpg`);
  await sharp(png).jpeg({ quality: 88, mozjpeg: true, chromaSubsampling: '4:4:4' }).toFile(outPath);
  console.log(`Wrote ${outPath}  (${targetWidth}x${targetHeight}, the exact chart cell pixels)`);
  await reportCopied(await copyToReviewDir([outPath], reviewDir, 'crop-previews'));
  return outPath;
}

async function modeGrid({ outDir, hero, reviewDir }) {
  const sharp = await loadSharp();
  const src = cellPath(outDir, hero);
  const meta = await sharp(src).metadata();
  const W = 900;
  const H = Math.round((meta.height / meta.width) * W);
  const step = 0.05;
  const lines = [];
  for (let i = 0; i <= 20; i++) {
    const v = i * step;
    const x = Math.round(v * W);
    const y = Math.round(v * H);
    const major = i % 2 === 0;
    const stroke = major ? '#ff2d95' : '#ffffff';
    const opacity = major ? 0.9 : 0.45;
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="${stroke}" stroke-opacity="${opacity}" stroke-width="1"/>`);
    lines.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${stroke}" stroke-opacity="${opacity}" stroke-width="1"/>`);
    if (major) {
      lines.push(`<text x="${Math.min(x + 4, W - 30)}" y="14" font-family="DejaVu Sans, Arial, sans-serif" font-size="13" fill="#ff2d95">${v.toFixed(2)}</text>`);
      lines.push(`<text x="2" y="${Math.max(y - 3, 12)}" font-family="DejaVu Sans, Arial, sans-serif" font-size="13" fill="#ff2d95">${v.toFixed(2)}</text>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${lines.join('')}</svg>`;
  const dir = path.join(outDir, 'crop-grids');
  await mkdir(dir, { recursive: true });
  const outPath = path.join(dir, `${hero}-grid.jpg`);
  await sharp(src)
    .resize(W, H, { fit: 'fill' })
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }])
    .jpeg({ quality: 85 })
    .toFile(outPath);
  console.log(`Wrote ${outPath}  (0.05 normalized coordinate overlay; x labels along the top, y down the left)`);
  await reportCopied(await copyToReviewDir([outPath], reviewDir, 'crop-grids'));
  return outPath;
}

/**
 * Screen one crop for backdrop contamination. Exported so render.mjs's pre-flight and the gate
 * table call the same function; two copies of this would drift and the operator would be told two
 * different things about the same crop.
 * @param {object} input
 * @param {string} input.source - working-cell path
 * @param {{left: number, top: number, width: number, height: number}} input.box
 * @returns {Promise<{minSd: number, tile: number, row: number, col: number, edge: string,
 *   suspect: boolean, matrix: number[]}>}
 */
export async function scanCrop({ source, box }) {
  const image = await rawPixels(source);
  const matrix = tileStats(image, box, SCAN_TILES);
  return { ...classifyTiles(matrix), matrix };
}

async function modeScan({ outDir, heroes, box, registry }) {
  const targets = heroes.length
    ? heroes.map((hero) => ({ label: hero, hero, crop: box ?? null }))
    : activePatterns(registry).map((p) => ({ label: p.id, hero: p.hero, crop: p.crop }));
  const rows = [];
  for (const t of targets) {
    if (!t.crop) throw new Error(`--scan --hero ${t.hero} needs --box left,top,size (that photo has no confirmed crop)`);
    const r = await scanCrop({ source: cellPath(outDir, t.hero), box: t.crop });
    rows.push({ ...t, ...r });
    console.log(
      `${t.label.padEnd(20)} min tile sd ${r.minSd.toFixed(1).padStart(6)}  tile ${String(r.tile).padStart(3)} (${r.edge})`
      + `  ${r.suspect ? 'SUSPECT: inspect this crop' : 'ok'}`,
    );
  }
  const suspects = rows.filter((r) => r.suspect).length;
  console.log(`\n${suspects} suspect / ${rows.length} scanned (threshold: min tile sd < ${SUSPECT_SD}).`);
  console.log('This is a screen, never an oracle: a genuinely flat area of fabric reads the same as a');
  console.log('flat tabletop. SUSPECT means look at that tile, not that the crop is wrong.');
  return rows;
}

async function modeSheet({ outDir, registry, reviewDir }) {
  const proposalsPath = path.join(outDir, 'crop-proposals.json');
  let doc;
  try {
    doc = JSON.parse(await readFile(proposalsPath, 'utf8'));
  } catch {
    throw new Error(`no proposals at ${proposalsPath}; run crops.mjs --propose first`);
  }
  const ingest = await readIngest(outDir);
  const previewDir = path.join(outDir, 'crop-previews');
  await mkdir(previewDir, { recursive: true });
  const sharp = await loadSharp();
  const { targetWidth, targetHeight } = cellTarget(registry);
  const written = [];
  for (const p of doc.proposals ?? []) {
    if (!p.box) continue;
    const entry = ingest.entries[p.hero];
    if (!entry) continue;
    const png = await prepareCellForBox({
      source: cellPath(outDir, p.hero),
      srcWidth: entry.cellWidth,
      srcHeight: entry.cellHeight,
      box: { left: p.box.left, top: p.box.top, width: p.box.width, height: p.box.height },
      targetWidth,
      targetHeight,
    });
    const outPath = path.join(previewDir, `${p.hero}.jpg`);
    await sharp(png).jpeg({ quality: 85, mozjpeg: true }).toFile(outPath);
    written.push(outPath);
  }
  if (!written.length) throw new Error('no resolvable proposals to sheet');

  const { renderSheet, planSheet } = await import('../contact-sheet.mjs');
  const sheetsDir = path.join(outDir, 'crop-sheets');
  await mkdir(sheetsDir, { recursive: true });
  const sheets = planSheet(written.map((f) => path.basename(f)), 4);
  const sheetPaths = [];
  for (const s of sheets) {
    const outPath = path.join(sheetsDir, `crop-sheet-${s.index + 1}.jpg`);
    const info = await renderSheet(s.files.map((f) => path.join(previewDir, f)), outPath, { columns: 4, cell: 480 });
    sheetPaths.push(outPath);
    console.log(`wrote ${outPath}  (${info.count} crops, ${info.width}x${info.height})`);
  }
  await reportCopied(await copyToReviewDir([...sheetPaths, ...written], reviewDir, 'crop-sheets'));
  return sheetPaths;
}

async function modeEmitFixture({ outDir }) {
  const registry = await loadRegistry(REGISTRY_PATH);
  const ingest = await readIngest(outDir);
  const sharp = await loadSharp();
  const byId = new Map(registry.patterns.map((p) => [p.id, p]));
  const grid = AUTOCROP_DEFAULTS.grid;

  await mkdir(path.join(FIXTURES_DIR, 'autocrop'), { recursive: true });
  const archetypes = [];
  for (const { archetype, patternId } of ARCHETYPES) {
    const p = byId.get(patternId);
    if (!p) throw new Error(`archetype "${archetype}" wants pattern "${patternId}", which is not in the registry`);
    const image = await rawPixels(cellPath(outDir, p.hero));
    const raw = boxDownsample(image, grid);
    const file = `${archetype}.png`;
    await sharp(raw, { raw: { width: grid, height: grid, channels: 3 } })
      .png({ compressionLevel: 9 })
      .toFile(path.join(FIXTURES_DIR, 'autocrop', file));
    archetypes.push({
      archetype,
      file,
      grid,
      // Provenance only: the photo BASENAME and its source content hash. Never a machine path.
      sourceBasename: p.hero,
      sourceSha256: ingest.entries[p.hero]?.sha256 ?? null,
      fullResolutionProposal: proposeBox(image),
      confirmedCrop: p.crop,
    });
    console.log(`wrote fixtures/autocrop/${file}  (from ${p.hero})`);
  }
  await writeFile(
    path.join(FIXTURES_DIR, 'autocrop', 'archetypes.json'),
    `${JSON.stringify({ version: 1, defaults: AUTOCROP_DEFAULTS, archetypes }, null, 2)}\n`,
  );

  const matrices = [];
  for (const p of activePatterns(registry)) {
    const r = await scanCrop({ source: cellPath(outDir, p.hero), box: p.crop });
    matrices.push({
      patternId: p.id,
      sourceBasename: p.hero,
      sourceSha256: ingest.entries[p.hero]?.sha256 ?? null,
      crop: p.crop,
      tiles: SCAN_TILES,
      matrix: r.matrix.map((v) => Math.round(v * 1e4) / 1e4),
    });
  }
  // Known-bad matrices, so the screen's margin is measurable and not just its verdict. The frame
  // corner is backdrop in every one of these shots, so a crop parked there is contamination by
  // construction rather than by judgement.
  const knownBad = [];
  const badBox = { left: 0.02, top: 0.02, width: 0.15, height: 0.15 };
  for (const { archetype, patternId } of ARCHETYPES) {
    const p = byId.get(patternId);
    const r = await scanCrop({ source: cellPath(outDir, p.hero), box: badBox });
    knownBad.push({
      archetype,
      sourceBasename: p.hero,
      crop: badBox,
      why: 'crop parked on the frame corner, which is backdrop in every launch photo',
      matrix: r.matrix.map((v) => Math.round(v * 1e4) / 1e4),
    });
  }

  await writeFile(
    path.join(FIXTURES_DIR, 'scan-tiles.json'),
    `${JSON.stringify({ version: 1, tiles: SCAN_TILES, threshold: SUSPECT_SD, entries: matrices, knownBad }, null, 2)}\n`,
  );
  console.log(`wrote fixtures/scan-tiles.json  (${matrices.length} confirmed crops, ${knownBad.length} known-bad)`);
  console.log('\nFixtures regenerated. Review the diff: a moved number here is an algorithm change.');
}

async function reportCopied(n) {
  // The COUNT only. The resolved review dir is a dev-machine path and never appears in output.
  if (n) console.log(`Copied ${n} image(s) to ${REVIEW_DIR_ENV}.`);
}

// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }

  const outDir = path.resolve(opts.outDir);
  const outProblem = outDirProblem(outDir);
  if (outProblem) throw new Error(outProblem);

  const { dir: reviewDir, problem } = await resolveReviewDir({ repoRoot: REPO_ROOT });
  if (problem) throw new Error(problem);

  if (opts.emitFixture) return modeEmitFixture({ outDir });
  if (opts.propose) return modePropose({ outDir, heroes: opts.heroes });

  const registry = await loadRegistry(REGISTRY_PATH);
  if (opts.preview) return modePreview({ outDir, preview: opts.preview, registry, reviewDir });
  if (opts.grid) return modeGrid({ outDir, hero: opts.grid, reviewDir });
  if (opts.scan) return modeScan({ outDir, heroes: opts.heroes, box: opts.box, registry });
  return modeSheet({ outDir, registry, reviewDir });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`Fatal: ${e.message}`); process.exitCode = 1; });
}
