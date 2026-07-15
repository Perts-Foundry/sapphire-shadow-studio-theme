import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSvg, CANVAS } from '../lib/render-svg.mjs';
import { readCopy } from '../lib/copy.mjs';
import { setupFontconfig } from '../lib/fontconfig.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(path.join(HERE, '..', 'profiles', 'crewneck-fleece.json'), 'utf8'));

// Structural smoke test, not a golden snapshot: pixel output is Pillow/librsvg/FreeType-version
// bound, so we assert shape + brand background rather than byte-equality (see the plan's test notes).
test('renders a navy PNG of the expected dimensions', async (t) => {
  // Fontconfig must be set before sharp is imported.
  process.env.FONTCONFIG_FILE = setupFontconfig();
  let sharp;
  try {
    ({ default: sharp } = await import('sharp'));
  } catch {
    t.skip('sharp unavailable in this environment');
    return;
  }

  const { pngLegend } = readCopy();
  const svg = buildSvg(SEED, pngLegend);

  const density = 36; // half the 72dpi default -> half-size raster, keeps the test fast
  const scale = density / 72;
  const { data, info } = await sharp(Buffer.from(svg), { density }).png().toBuffer({ resolveWithObject: true });

  assert.equal(info.width, Math.round(CANVAS.W * scale));
  assert.equal(info.height, Math.round(CANVAS.H * scale));
  assert.ok(data.length > 2000, 'PNG should be non-trivially sized');

  const px = await sharp(data).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
  assert.deepEqual([px[0], px[1], px[2]], [7, 30, 63], 'top-left pixel should be the brand navy #071e3f');
});
