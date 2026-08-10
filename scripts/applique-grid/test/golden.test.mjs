// Pinned goldens over the synthetic fixture registry, plus the joint alt-partition property.
// Regen after an intentional change: npm run applique-grid:golden:update

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, activePatterns, dropdownText } from '../lib/registry.mjs';
import { balancedPages, pageLayout } from '../lib/layout.mjs';
import { buildChartSvg } from '../lib/chart-svg.mjs';
import { buildChartAlt } from '../lib/naming.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const fixture = JSON.parse(readFileSync(path.join(FIXTURES, 'registry.fixture.json'), 'utf8'));

test('fixture registry validates and has a discontinued pattern interleaved', () => {
  assert.deepEqual(validate(fixture), []);
  const statuses = fixture.patterns.map((p) => p.status);
  const i = statuses.indexOf('discontinued');
  assert.ok(i > 0 && i < statuses.length - 1, 'discontinued pattern must sit between active ones');
});

test('page-1 SVG golden (exercises the trailing empty cell)', () => {
  const actives = activePatterns(fixture);
  const sizes = balancedPages(actives.length, fixture.chart.columns * fixture.chart.rows);
  assert.deepEqual(sizes, [5, 4]); // 9 actives on a 3x2 grid; page 1's last row has an empty slot
  const page1 = actives.slice(0, sizes[0]);
  const layout = pageLayout({ chart: fixture.chart, count: page1.length });
  const svg = buildChartSvg({ chart: fixture.chart, layout, page: 1, pages: sizes.length, patterns: page1 });
  const golden = readFileSync(path.join(FIXTURES, 'page-1.svg'), 'utf8');
  assert.equal(`${svg}\n`, golden, 'intentional design change? npm run applique-grid:golden:update and review the diff');
});

test('pattern-options golden', () => {
  const golden = readFileSync(path.join(FIXTURES, 'pattern-options.txt'), 'utf8');
  assert.equal(`${dropdownText(fixture)}\n`, golden);
});

test('joint property: page alt ranges partition 1..N with no gaps or overlap, names match', () => {
  const actives = activePatterns(fixture);
  const sizes = balancedPages(actives.length, fixture.chart.columns * fixture.chart.rows);
  let cursor = 0;
  let expectedNext = 1;
  sizes.forEach((size, i) => {
    const slice = actives.slice(cursor, cursor + size);
    cursor += size;
    const first = slice[0].number;
    const last = slice[slice.length - 1].number;
    assert.equal(first, expectedNext, `page ${i + 1} starts where the previous ended`);
    assert.equal(last - first + 1, slice.length, `page ${i + 1} range is contiguous`);
    expectedNext = last + 1;

    const alt = buildChartAlt({ page: i + 1, pages: sizes.length, first, last, names: slice.map((p) => p.name) });
    assert.match(alt, new RegExp(`^Applique pattern chart ${i + 1} of ${sizes.length}: patterns ${first}-${last}, `));
    for (const p of slice) assert.ok(alt.includes(p.name), `page ${i + 1} alt names ${p.name}`);
    for (const p of actives.filter((a) => !slice.includes(a))) {
      assert.ok(!alt.includes(p.name), `page ${i + 1} alt must not name off-page pattern ${p.name}`);
    }
  });
  assert.equal(expectedNext - 1, actives.length, 'the last page ends at N');
});
