// Regenerate the pinned golden fixtures after an INTENTIONAL design or format change.
// Run: npm run applique-grid:golden:update   then review the fixture diffs carefully.
//
// Two goldens live here, both derived from fixtures/registry.fixture.json (10 synthetic
// patterns, one discontinued interleaved, on a 3x2 grid so page 1 carries a trailing empty
// cell):
//
//   fixtures/page-1.svg            chart page 1's SVG, text-reviewable brand output
//   fixtures/pattern-options.txt   the derived dropdown text
//   fixtures/gate-table.golden.md  the naming gate's verification surface, over a synthetic
//                                  2-pattern draft (deliberately not the real 18, so the format is
//                                  pinned without coupling to production goldens)
//
// Not a test file (no `.test.mjs`), so `node --test` does not pick it up.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activePatterns } from '../lib/registry.mjs';
import { dropdownText } from '../lib/registry.mjs';
import { balancedPages, pageLayout } from '../lib/layout.mjs';
import { buildChartSvg } from '../lib/chart-svg.mjs';
import { detailTable, emptyDraft, keyFor, tableRows } from '../lib/draft.mjs';

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

// Kept byte-identical to draft.test.mjs's `twoPattern()`; the test asserts against this file.
const draft = {
  ...emptyDraft(),
  threads: [...fixture.threads],
  patterns: fixture.patterns.slice(0, 2).map((p) => ({
    id: p.id,
    name: p.name,
    thread: p.thread,
    status: p.status,
    sources: [...p.sources],
    hero: p.hero,
    crop: { ...p.crop },
    position: p.position,
  })),
};
draft.patterns[0].candidates = { descriptive: 'Scattered Paws', evocative: 'Midnight Steps', modern: 'Paws' };
draft.patterns[1].candidates = { descriptive: 'Busy Bees', playful: 'Bee Kind', trade: 'Apis Mellifera' };
writeFileSync(path.join(FIXTURES, 'gate-table.golden.md'), detailTable({
  rows: tableRows(draft),
  draft,
  colorValues: ['Black', 'Grey Heather', 'Classic Navy'],
  clearance: { [keyFor(draft.patterns[0].hero)]: { minSd: 5.2, tile: 91, edge: 'bottom-left', suspect: true } },
}));
console.log(`Regenerated ${path.join(FIXTURES, 'gate-table.golden.md')}`);
