// Suite for the studio enhance pass. The fixture is synthetic (an SVG-rendered "garment" on a
// warm-grey backdrop with a soft offset shadow), so the tests pin the mechanism: backdrop
// measurement, white balance to pure white, border-seeded masking, shadow retention, crop
// geometry, the REQUIRED acceptance rows, and sidecar-driven deterministic re-runs. Real-photo
// quality (fleece edges, halos) is reviewed by eye in the skill's gate, not asserted here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  SPEC,
  estimateBackdrop,
  backdropGains,
  backgroundMask,
  garmentBBox,
  cropBox,
  enhanceFile,
  acceptanceFailures,
  guardOutDir,
  validStoredParams,
  readSidecar,
} from './enhance-product-images.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enhance-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// 1600x1200 warm-grey backdrop, dark rounded "garment" centered-ish, soft shadow offset below.
const FIXTURE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200">
  <defs><filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
    <feGaussianBlur stdDeviation="18"/></filter></defs>
  <rect width="1600" height="1200" fill="rgb(233,229,222)"/>
  <rect x="530" y="330" width="560" height="580" rx="60" fill="rgb(150,146,140)" filter="url(#soft)"/>
  <rect x="520" y="310" width="560" height="580" rx="60" fill="rgb(24,24,26)"/>
  <rect x="640" y="420" width="140" height="60" fill="rgb(240,240,240)"/>
</svg>`;

async function writeFixture(name, svg = FIXTURE_SVG) {
  const p = path.join(tmp, name);
  await sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toFile(p);
  return p;
}

async function rawOf(filePath) {
  const { data, info } = await sharp(filePath).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

test('estimateBackdrop reads the border ring, not the garment', async () => {
  const raw = await rawOf(await writeFixture('bd.jpg'));
  const bd = estimateBackdrop(raw);
  for (const [i, expected] of [233, 229, 222].entries()) {
    assert.ok(Math.abs(bd[i] - expected) <= 4, `channel ${i}: ${bd[i]} vs ${expected}`);
  }
});

test('backdropGains lifts the backdrop to white and clamps hopeless exposures', () => {
  const gains = backdropGains([233, 229, 222]);
  for (const [i, v] of [233, 229, 222].entries()) {
    assert.ok(Math.abs(v * gains[i] - 255) < 2);
  }
  assert.equal(backdropGains([40, 40, 40])[0], 1.8);
});

test('border-seeded mask keeps an interior light patch as garment', async () => {
  const raw = await rawOf(await writeFixture('mask.jpg'));
  const mask = backgroundMask(raw, SPEC.maskTolerance);
  // A pixel inside the light-grey chest patch (interior, not border-connected).
  assert.equal(mask[450 * raw.width + 700], 0, 'light interior patch must stay garment');
  assert.equal(mask[10 * raw.width + 10], 1, 'corner is background');
  const bbox = garmentBBox(mask, raw.width, raw.height);
  assert.ok(bbox.minX > 400 && bbox.maxX < 1200 && bbox.minY > 200 && bbox.maxY < 1000);
});

test('cropBox centers the garment at the target margin', () => {
  const box = cropBox({ minX: 500, minY: 300, maxX: 1099, maxY: 899 }, SPEC, 1600, 1200);
  assert.equal(box.side, Math.round(600 / (1 - 2 * SPEC.marginTarget)));
  assert.equal(box.left + Math.round(box.side / 2), 800, 'centered on bbox');
});

test('enhanceFile end to end: spec canvas, pure-white corners, margins, no EXIF, shadow kept', async () => {
  const src = await writeFixture('e2e.jpg');
  const outDir = fs.mkdtempSync(path.join(tmp, 'out-'));
  const result = await enhanceFile(src, outDir, {});
  assert.equal(result.status, 'ok', JSON.stringify(result.failures ?? []));
  const meta = await sharp(result.outPath).metadata();
  assert.equal(meta.width, SPEC.canvas);
  assert.equal(meta.height, SPEC.canvas);
  assert.equal(meta.exif, undefined, 'no EXIF in output');
  assert.deepEqual(await acceptanceFailures(fs.readFileSync(result.outPath), SPEC), []);

  // Contact shadow survives: some near-garment background pixels are non-white but light.
  const { data, info } = await sharp(result.outPath).raw().toBuffer({ resolveWithObject: true });
  let shadowPx = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    const p = i * 3;
    const v = data[p];
    if (v > 140 && v < 245 && Math.abs(data[p + 1] - v) < 20 && Math.abs(data[p + 2] - v) < 20) shadowPx++;
  }
  assert.ok(shadowPx > 1000, `expected retained shadow pixels, found ${shadowPx}`);
});

test('re-run with the sidecar params reproduces identical bytes', async () => {
  const src = await writeFixture('det.jpg');
  const outDir = fs.mkdtempSync(path.join(tmp, 'det-'));
  const first = await enhanceFile(src, outDir, {});
  assert.equal(first.status, 'ok');
  const bytes1 = fs.readFileSync(first.outPath);
  const second = await enhanceFile(src, outDir, { storedParams: first.params });
  assert.equal(second.status, 'ok');
  assert.deepEqual(fs.readFileSync(second.outPath), bytes1);
});

test('a garment touching the frame edge is flagged, not cropped', async () => {
  const svg = FIXTURE_SVG.replace('x="520" y="310"', 'x="0" y="310"');
  const src = await writeFixture('edge.jpg', svg);
  const outDir = fs.mkdtempSync(path.join(tmp, 'edge-'));
  const result = await enhanceFile(src, outDir, {});
  assert.equal(result.status, 'flagged');
  assert.match(result.failures.join(' '), /touches the frame edge/);
  assert.equal(fs.readdirSync(outDir).length, 0, 'flagged inputs write no output');
});

test('an underexposed backdrop hits the gain clamp and is flagged', async () => {
  const svg = FIXTURE_SVG.replace('rgb(233,229,222)', 'rgb(70,68,66)');
  const src = await writeFixture('dark.jpg', svg);
  const outDir = fs.mkdtempSync(path.join(tmp, 'dark-'));
  const result = await enhanceFile(src, outDir, {});
  assert.equal(result.status, 'flagged');
  assert.match(result.failures.join(' '), /gain clamp/);
  assert.equal(fs.readdirSync(outDir).length, 0, 'flagged inputs write no output');
});

// A raw canvas at a given size with a dark square whose bbox insets are set per side, encoded to
// JPEG, for driving acceptanceFailures' individual branches directly.
async function acceptanceFixture({ size = SPEC.canvas, insetL = 0.11, insetT = 0.11, insetR = 0.11, insetB = 0.11, empty = false }) {
  const rects = empty ? '' :
    `<rect x="${Math.round(size * insetL)}" y="${Math.round(size * insetT)}"
      width="${Math.round(size * (1 - insetL - insetR))}" height="${Math.round(size * (1 - insetT - insetB))}"
      fill="rgb(20,20,20)"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <rect width="${size}" height="${size}" fill="rgb(255,255,255)"/>${rects}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer();
}

test('acceptanceFailures catches each REQUIRED-row violation', async () => {
  assert.deepEqual(await acceptanceFailures(await acceptanceFixture({}), SPEC), []);

  const wrongCanvas = await acceptanceFailures(await acceptanceFixture({ size: 2000 }), SPEC);
  assert.match(wrongCanvas.join(' '), /canvas 2000x2000/);

  const empty = await acceptanceFailures(await acceptanceFixture({ empty: true }), SPEC);
  assert.match(empty.join(' '), /no garment pixels/);

  // Garment shoved into the top-left corner: fails the corner patch, the margin floor, and centering.
  const cornered = await acceptanceFailures(
    await acceptanceFixture({ insetL: 0.0, insetT: 0.0, insetR: 0.5, insetB: 0.5 }), SPEC);
  assert.match(cornered.join(' '), /corner patch/);
  assert.match(cornered.join(' '), /tightest margin/);
  assert.match(cornered.join(' '), /centering/);

  // Near-full-frame garment: margins below spec without touching the corner patches.
  const crowded = await acceptanceFailures(
    await acceptanceFixture({ insetL: 0.04, insetT: 0.04, insetR: 0.04, insetB: 0.04 }), SPEC);
  assert.match(crowded.join(' '), /tightest margin/);
});

test('guardOutDir confines writes to product-images/', () => {
  guardOutDir('product-images');
  guardOutDir(path.join('product-images', 'enhanced', 'x'));
  for (const bad of ['product-images-evil', path.join('..', 'product-images'), os.tmpdir(), 'scripts']) {
    assert.throws(() => guardOutDir(bad), /refusing to write outside/, bad);
  }
});

test('validStoredParams gates sidecar entries; a corrupt entry re-derives instead of throwing', async () => {
  assert.equal(validStoredParams({ gains: [1, 1, 1], maskTolerance: 34, shadowFloor: 247, marginTarget: 0.11 }), true);
  for (const bad of [null, {}, { gains: [1, 1] }, { gains: [1, 1, 'x'], maskTolerance: 34, shadowFloor: 247, marginTarget: 0.11 }]) {
    assert.equal(validStoredParams(bad), false, JSON.stringify(bad));
  }
  const src = await writeFixture('corrupt-sidecar.jpg');
  const outDir = fs.mkdtempSync(path.join(tmp, 'cs-'));
  const result = await enhanceFile(src, outDir, { storedParams: {} });
  assert.equal(result.status, 'ok');
  assert.ok(validStoredParams(result.params), 're-derived params are complete');
});

test('readSidecar returns a fresh structure when absent and round-trips when present', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'sc-'));
  assert.deepEqual(readSidecar(dir).images, {});
  const sidecar = { version: 1, images: { 'a.jpg': { gains: [1, 1, 1] } } };
  fs.writeFileSync(path.join(dir, 'enhance-params.json'), JSON.stringify(sidecar));
  assert.deepEqual(readSidecar(dir), sidecar);
});
