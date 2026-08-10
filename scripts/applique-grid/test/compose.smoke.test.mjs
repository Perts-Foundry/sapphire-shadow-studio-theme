// Run the real rasterize + composite pipeline once, at small size, on a synthetic 2x3 grid.
// Asserts output format, exact pixel dimensions, and decodability; deliberately asserts nothing
// about glyph pixels (font rasterisation differs across fontconfig environments).

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChartSvg } from '../lib/chart-svg.mjs';
import { pageLayout, compositePlan } from '../lib/layout.mjs';
import { prepareCell, renderChart, resizeProof } from '../lib/compose.mjs';
import { coverCrop } from '../lib/crop.mjs';

const chart = {
  columns: 2, rows: 3, cell_aspect: 0.75, cell_fit: 'cover',
  title: 'Applique Patterns', width_units: 800, scale: 1, styleVersion: 1,
};
const patterns = Array.from({ length: 6 }, (_, i) => ({
  number: i + 1, name: `Pattern ${i + 1}`, thread: 'white',
}));

test('compose smoke: 2x3 synthetic grid renders a decodable JPEG at exact dimensions', async () => {
  const layout = pageLayout({ chart, count: 6 });
  const plan = compositePlan(layout, chart.scale);
  const svg = buildChartSvg({ chart, layout, page: 1, pages: 1, patterns });

  // Synthetic working cells: flat-colour JPEGs cropped through the real coverCrop path.
  const { default: sharp } = await import('sharp');
  const cells = [];
  for (let i = 0; i < plan.length; i++) {
    const srcWidth = 300;
    const srcHeight = 400;
    const source = await sharp({
      create: { width: srcWidth, height: srcHeight, channels: 3, background: { r: 40 * i, g: 90, b: 160 } },
    }).jpeg().toBuffer();
    const { extract, resize } = coverCrop({
      srcWidth, srcHeight,
      box: { left: 0.1, top: 0.1, width: 0.8, height: 0.8 },
      targetWidth: plan[i].width,
      targetHeight: plan[i].height,
    });
    cells.push({ data: await prepareCell({ source, extract, resize }), left: plan[i].left, top: plan[i].top });
  }

  const out = await renderChart({ svg, scale: chart.scale, cells });
  assert.equal(out.width, Math.round(layout.width * chart.scale));
  assert.equal(out.height, Math.round(layout.height * chart.scale));
  assert.equal(out.data[0], 0xff); // JPEG SOI
  assert.equal(out.data[1], 0xd8);

  const meta = await sharp(out.data).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, out.width);
  assert.equal(meta.height, out.height);

  const proof = await resizeProof(out.data, 200);
  const proofMeta = await sharp(proof).metadata();
  assert.equal(proofMeta.width, 200);
});
