// Regenerate the pinned golden fixtures after an INTENTIONAL design or format change.
// Run: npm run applique-grid:golden:update   then review the fixture diffs carefully.
//
// Two goldens live here, both derived from fixtures/registry.fixture.json (10 synthetic
// patterns, one discontinued interleaved, on a 3x2 grid so page 1 carries a trailing empty
// cell):
//
//   fixtures/page-1.svg           chart page 1's SVG, text-reviewable brand output
//   fixtures/pattern-options.txt  the derived dropdown text
//
// Not a test file (no `.test.mjs`), so `node --test` does not pick it up.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activePatterns } from '../lib/registry.mjs';
import { dropdownText } from '../lib/registry.mjs';
import { balancedPages, pageLayout } from '../lib/layout.mjs';
import { buildChartSvg } from '../lib/chart-svg.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

const fixture = JSON.parse(readFileSync(path.join(FIXTURES, 'registry.fixture.json'), 'utf8'));
const actives = activePatterns(fixture);
const sizes = balancedPages(actives.length, fixture.chart.columns * fixture.chart.rows);
const page1 = actives.slice(0, sizes[0]);
const layout = pageLayout({ chart: fixture.chart, count: page1.length });
const svg = buildChartSvg({ chart: fixture.chart, layout, page: 1, pages: sizes.length, patterns: page1 });

writeFileSync(path.join(FIXTURES, 'page-1.svg'), `${svg}\n`);
console.log(`Regenerated ${path.join(FIXTURES, 'page-1.svg')}`);

writeFileSync(path.join(FIXTURES, 'pattern-options.txt'), `${dropdownText(fixture)}\n`);
console.log(`Regenerated ${path.join(FIXTURES, 'pattern-options.txt')}`);
