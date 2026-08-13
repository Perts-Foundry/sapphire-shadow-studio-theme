// The crop workbench's CLI surface, the preview-fidelity lock, the render pre-flight's
// non-fatality, and the APPLIQUE_REVIEW_DIR guard. No network, no HEIC decode: every image here
// comes from the committed autocrop fixtures.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, previewCellPng, scanCrop, HELP } from '../crops.mjs';
import { preflightScan } from '../render.mjs';
import { loadSharp, prepareCell, prepareCellForBox } from '../lib/compose.mjs';
import { coverCrop } from '../lib/crop.mjs';
import { pageLayout, compositePlan } from '../lib/layout.mjs';
import { reviewDirShapeProblem, resolveReviewDir, copyToReviewDir, REVIEW_DIR_ENV } from '../lib/review-dir.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const registry = JSON.parse(readFileSync(path.join(FIXTURES, 'registry.fixture.json'), 'utf8'));

const HERO = 'FIXTURE_0001.heic';
const BOX = { left: 0.2, top: 0.3, width: 0.45, height: 0.45 };

// A working directory shaped exactly like a real run's: cells/<hero>.jpg plus an ingest manifest.
// The path carries a product-images/ segment so it also satisfies the containment guard.
async function workDir() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'applique-crops-'));
  const outDir = path.join(root, 'product-images', 'applique');
  await mkdir(path.join(outDir, 'cells'), { recursive: true });
  const sharp = await loadSharp();
  const info = await sharp(path.join(FIXTURES, 'autocrop', 'cream-print.png'))
    .jpeg({ quality: 92 })
    .toFile(path.join(outDir, 'cells', `${HERO}.jpg`));
  await writeFile(path.join(outDir, 'ingest-manifest.json'), `${JSON.stringify({
    version: 1,
    entries: { [HERO]: { sha256: 'f'.repeat(64), cellWidth: info.width, cellHeight: info.height } },
  }, null, 2)}\n`);
  return { root, outDir, cellWidth: info.width, cellHeight: info.height };
}

// ---------------------------------------------------------------------------

test('parseArgs requires exactly one mode', () => {
  assert.throws(() => parseArgs([]), /exactly one mode/);
  assert.throws(() => parseArgs(['--propose', '--scan']), /exactly one mode/);
  assert.throws(() => parseArgs(['--nope']), /Unknown option --nope/);
  assert.equal(parseArgs(['--propose']).propose, true);
  assert.equal(parseArgs(['--help']).help, true, '--help short-circuits the mode requirement');
});

test('parseArgs reads --preview as hero plus three normalized numbers', () => {
  const o = parseArgs(['--preview', 'IMG_1.heic', '0.1', '0.2', '0.3']);
  assert.deepEqual(o.preview, { hero: 'IMG_1.heic', left: 0.1, top: 0.2, size: 0.3 });
  assert.throws(() => parseArgs(['--preview', 'IMG_1.heic', '0.1', '0.2']), /--preview needs/);
});

test('parseArgs refuses an out-of-bounds --box instead of clamping it', () => {
  assert.throws(() => parseArgs(['--scan', '--hero', 'a.heic', '--box', '0.8,0.1,0.5']), /box out of bounds/);
  assert.throws(() => parseArgs(['--scan', '--hero', 'a.heic', '--box', '0.1,0.1']), /left,top,size/);
  assert.throws(() => parseArgs(['--scan', '--box', '0.1,0.1,0.2']), /--box only applies/);
});

test('the help text names every mode the parser accepts', () => {
  for (const flag of ['--propose', '--preview', '--grid', '--scan', '--sheet', '--emit-fixture', '--hero', '--box', '--out-dir', '--help']) {
    assert.ok(HELP.includes(flag), `help text is missing ${flag}`);
  }
});

// ---------------------------------------------------------------------------
// 4.3: the only thing standing between the gate and a false approval.
// ---------------------------------------------------------------------------

test('--preview is byte-identical to what render.mjs composites for the same box', async () => {
  const { root, outDir, cellWidth, cellHeight } = await workDir();
  try {
    const { png, targetWidth, targetHeight } = await previewCellPng({ outDir, hero: HERO, box: BOX, registry });

    // The literal steps the render path takes, recomputed here rather than shared, so a future
    // change to either side shows up as a byte difference instead of passing vacuously.
    const layout = pageLayout({ chart: registry.chart, count: 1 });
    const plan = compositePlan(layout, registry.chart.scale);
    assert.equal(targetWidth, plan[0].width);
    assert.equal(targetHeight, plan[0].height);
    const { extract, resize } = coverCrop({
      srcWidth: cellWidth, srcHeight: cellHeight, box: BOX, targetWidth, targetHeight,
    });
    const rendered = await prepareCell({
      source: path.join(outDir, 'cells', `${HERO}.jpg`), extract, resize,
    });
    assert.ok(png.equals(rendered), 'preview pixels must be the pixels that ship');

    const shared = await prepareCellForBox({
      source: path.join(outDir, 'cells', `${HERO}.jpg`),
      srcWidth: cellWidth,
      srcHeight: cellHeight,
      box: BOX,
      targetWidth,
      targetHeight,
    });
    assert.ok(png.equals(shared));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('previewCellPng refuses a hero the ingest manifest does not know', async () => {
  const { root, outDir } = await workDir();
  try {
    await assert.rejects(
      () => previewCellPng({ outDir, hero: 'NOT_INGESTED.heic', box: BOX, registry }),
      /not in the ingest manifest/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4.4: the pre-flight must never be able to break rendering, which worked before it existed.
// ---------------------------------------------------------------------------

test('the render pre-flight and the gate screen call the same function on the same pixels', async () => {
  const { root, outDir } = await workDir();
  try {
    const source = path.join(outDir, 'cells', `${HERO}.jpg`);
    const direct = await scanCrop({ source, box: BOX });
    const warnings = [];
    const suspects = await preflightScan({
      patterns: [{ id: 'p1', hero: HERO, crop: BOX }],
      cellsDir: path.join(outDir, 'cells'),
      warn: (m) => warnings.push(m),
    });
    if (direct.suspect) {
      assert.equal(suspects.length, 1);
      assert.equal(suspects[0].minSd, direct.minSd);
      assert.equal(suspects[0].tile, direct.tile);
      assert.equal(suspects[0].edge, direct.edge);
    } else {
      assert.deepEqual(suspects, []);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a throwing scan warns and returns; it never breaks the render', async () => {
  const warnings = [];
  const suspects = await preflightScan({
    patterns: [{ id: 'missing', hero: 'NOPE.heic', crop: BOX }],
    cellsDir: path.join(os.tmpdir(), 'applique-does-not-exist'),
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(suspects, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^WARN: crop screen skipped for missing/);
});

test('a SUSPECT result warns but does not block the write', async () => {
  const { root, outDir } = await workDir();
  try {
    // The frame corner is backdrop in these photos, so this crop is contamination by construction.
    const corner = { left: 0.02, top: 0.02, width: 0.15, height: 0.15 };
    const direct = await scanCrop({ source: path.join(outDir, 'cells', `${HERO}.jpg`), box: corner });
    assert.equal(direct.suspect, true, 'fixture sanity: a corner crop must screen as suspect');
    const warnings = [];
    const suspects = await preflightScan({
      patterns: [{ id: 'corner', hero: HERO, crop: corner }],
      cellsDir: path.join(outDir, 'cells'),
      warn: (m) => warnings.push(m),
    });
    assert.equal(suspects.length, 1);
    assert.ok(warnings.some((w) => /screen, not a verdict/.test(w)), 'the warning must not read as a verdict');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4.9: the review dir is the one write outside product-images/, so it carries its own guard.
// ---------------------------------------------------------------------------

test('APPLIQUE_REVIEW_DIR: unset is a silent no-op', async () => {
  const r = await resolveReviewDir({ repoRoot: '/repo', env: {} });
  assert.deepEqual(r, { dir: null, problem: null });
  assert.equal(await copyToReviewDir(['/nope'], null), 0);
});

test('APPLIQUE_REVIEW_DIR: every rejected shape is named', () => {
  const root = '/repo/checkout';
  assert.match(reviewDirShapeProblem('', root), /set but empty/);
  assert.match(reviewDirShapeProblem('   ', root), /set but empty/);
  assert.match(reviewDirShapeProblem('review', root), /absolute path/);
  assert.match(reviewDirShapeProblem('./review', root), /absolute path/);
  assert.match(reviewDirShapeProblem('/tmp/../tmp/review', root), /".." segment/);
  assert.match(reviewDirShapeProblem(`${root}/product-images/review`, root), /OUTSIDE the repo/);
  assert.match(reviewDirShapeProblem(root, root), /OUTSIDE the repo/);
  assert.equal(reviewDirShapeProblem('/tmp/applique-review', root), null);
});

test('APPLIQUE_REVIEW_DIR: nonexistent and not-a-directory are rejected by name', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'applique-review-'));
  try {
    const repoRoot = path.join(root, 'checkout');
    await mkdir(repoRoot, { recursive: true });

    const missing = path.join(root, 'not-there');
    assert.match((await resolveReviewDir({ repoRoot, env: { [REVIEW_DIR_ENV]: missing } })).problem, /does not exist/);

    const file = path.join(root, 'a-file');
    await writeFile(file, 'x');
    assert.match((await resolveReviewDir({ repoRoot, env: { [REVIEW_DIR_ENV]: file } })).problem, /not a directory/);

    const good = path.join(root, 'drop');
    await mkdir(good);
    const ok = await resolveReviewDir({ repoRoot, env: { [REVIEW_DIR_ENV]: good } });
    assert.equal(ok.problem, null);
    assert.equal(ok.dir, good);

    const src = path.join(root, 'img.txt');
    await writeFile(src, 'pixels');
    assert.equal(await copyToReviewDir([src], good, 'crop-previews'), 1);
    assert.equal(await readFile(path.join(good, 'crop-previews', 'img.txt'), 'utf8'), 'pixels');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
