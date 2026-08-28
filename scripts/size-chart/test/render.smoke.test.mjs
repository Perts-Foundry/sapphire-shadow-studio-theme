import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSvg, CANVAS } from '../lib/render-svg.mjs';
import { setupFontconfig } from '../lib/fontconfig.mjs';
import { resolvedProfile } from './profile-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = resolvedProfile('crewneck-fleece');

// Structural smoke test, not a golden snapshot: pixel output is Pillow/librsvg/FreeType-version
// bound, so we assert shape + brand background rather than byte-equality (see the plan's test notes).
test('renders a navy PNG of the expected dimensions', async (t) => {
  // Fontconfig must be set before sharp is imported.
  process.env.FONTCONFIG_FILE = setupFontconfig();
  let sharp;
  try {
    ({ default: sharp } = await import('sharp'));
  } catch (err) {
    // Locally, an exotic platform with no sharp binary should not block the whole suite. In CI it
    // must: a silent skip there would leave the run green while rasterisation coverage quietly
    // vanished, which is the exact failure mode gating this suite is meant to close. sharp ships its
    // binaries as optionalDependencies, so `npm ci --ignore-scripts` still resolves them; if that
    // ever stops being true, this should be loud.
    if (process.env.CI) throw new Error(`sharp failed to load in CI: ${err.message}`);
    t.skip('sharp unavailable in this environment');
    return;
  }

  const svg = buildSvg(SEED);
  // Height is derived from content (the crewneck pins no canvas_height), so read the authoritative
  // value back off the SVG rather than hardcoding it; the raster must match that exactly.
  const svgH = Number(svg.match(/height="(\d+)"/)[1]);

  const density = 36; // half the 72dpi default -> half-size raster, keeps the test fast
  const scale = density / 72;
  const { data, info } = await sharp(Buffer.from(svg), { density }).png().toBuffer({ resolveWithObject: true });

  assert.equal(info.width, Math.round(CANVAS.W * scale));
  assert.equal(info.height, Math.round(svgH * scale));
  assert.ok(data.length > 2000, 'PNG should be non-trivially sized');

  // Top-left should be the brand navy #071e3f. The background is a vertical gradient normalized to
  // the canvas height, so the top row's sub-pixel sample drifts by ~1 LSB as the derived height
  // changes; assert proximity to the target rather than an exact byte (which would pin the height).
  const px = await sharp(data).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
  const target = [7, 30, 63];
  target.forEach((c, i) => assert.ok(Math.abs(px[i] - c) <= 2, `top-left channel ${i} (${px[i]}) should be ~${c} (brand navy #071e3f)`));
});
