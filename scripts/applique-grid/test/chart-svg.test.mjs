import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChartSvg } from '../lib/chart-svg.mjs';
import { pageLayout } from '../lib/layout.mjs';
import { BG, ACCENT, ACCENT_LT, FONT } from '../../size-chart/lib/svg-shared.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'registry.fixture.json'), 'utf8'));

// The escape exercisers deliberately bypass registry validation (which forbids & and <) so the
// SVG builder's escaping is proven independently of the charset gate in front of it.
const hostilePatterns = [
  { number: 1, name: 'Salt & Pepper', thread: 'white' },
  { number: 2, name: 'A <b> Weave', thread: 'grey & blue' },
  { number: 3, name: "Willow's Path", thread: 'black' },
];

function build(patterns, { page = 1, pages = 2 } = {}) {
  const layout = pageLayout({ chart: fixture.chart, count: patterns.length });
  return { layout, svg: buildChartSvg({ chart: fixture.chart, layout, page, pages, patterns }) };
}

test('eyebrow, title, and page indicator are present', () => {
  const { svg } = build(hostilePatterns);
  assert.match(svg, /SAPPHIRE SHADOW STUDIO/);
  assert.match(svg, /Applique Patterns/);
  assert.match(svg, /Chart 1 of 2/);
});

test('every label is rendered with number, name, and thread', () => {
  const { svg } = build(hostilePatterns);
  assert.match(svg, /1\. Salt &amp; Pepper \(white\)/);
  assert.match(svg, /2\. A &lt;b&gt; Weave \(grey &amp; blue\)/);
  assert.match(svg, /3\. Willow's Path \(black\)/);
});

test('XML special characters never appear raw', () => {
  const { svg } = build(hostilePatterns);
  // Every & must be an entity; no name-injected raw < outside real tags.
  assert.equal((svg.match(/&(?!(amp|lt|gt|quot|apos|#\d+);)/g) ?? []).length, 0);
  assert.ok(!svg.includes('<b>'));
});

test('brand tokens are used (background gradient, accent divider, Inter)', () => {
  const { svg } = build(hostilePatterns);
  assert.ok(svg.includes(`stop-color="${BG}"`));
  assert.ok(svg.includes(`stroke="${ACCENT}"`));
  assert.ok(svg.includes(`fill="${ACCENT_LT}"`));
  assert.ok(svg.includes(`font-family="${FONT}"`));
});

test('one frame per cell, dimensions match the layout', () => {
  const { svg, layout } = build(hostilePatterns);
  assert.match(svg, new RegExp(`<svg [^>]*width="${layout.width}" height="${layout.height}"`));
  const frames = svg.match(/<rect [^>]*stroke-opacity="0\.65"/g) ?? [];
  assert.equal(frames.length, hostilePatterns.length);
});

test('pattern/cell count mismatch throws', () => {
  const layout = pageLayout({ chart: fixture.chart, count: 2 });
  assert.throws(
    () => buildChartSvg({ chart: fixture.chart, layout, page: 1, pages: 1, patterns: hostilePatterns }),
    /2 cells but 3 patterns/,
  );
});
