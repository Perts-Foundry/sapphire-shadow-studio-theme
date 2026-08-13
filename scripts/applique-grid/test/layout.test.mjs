import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  balancedPages, pageLayout, compositePlan, cellWidth, nameCharCeiling,
  LABEL_EM_PER_CHAR, LABEL_FONT_SIZE, LABEL_PREFIX_RESERVE,
} from '../lib/layout.mjs';
import { REGISTRY_PATH } from '../lib/registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'registry.fixture.json'), 'utf8'));

test('balancedPages discriminating cases', () => {
  assert.deepEqual(balancedPages(18, 9), [9, 9]);
  assert.deepEqual(balancedPages(20, 9), [7, 7, 6]);
  assert.deepEqual(balancedPages(10, 9), [5, 5]); // NOT [9, 1]
  assert.deepEqual(balancedPages(9, 6), [5, 4]);  // the fixture's shape
  assert.deepEqual(balancedPages(9, 9), [9]);
  assert.deepEqual(balancedPages(0, 9), []);
  assert.deepEqual(balancedPages(1, 9), [1]);
});

test('balancedPages invariant sweep', () => {
  for (let cap = 1; cap <= 12; cap++) {
    for (let n = 0; n <= 40; n++) {
      const pages = balancedPages(n, cap);
      const sum = pages.reduce((a, b) => a + b, 0);
      assert.equal(sum, n, `sum for n=${n} cap=${cap}`);
      assert.equal(pages.length, n === 0 ? 0 : Math.ceil(n / cap), `count for n=${n} cap=${cap}`);
      if (pages.length) {
        assert.ok(Math.max(...pages) <= cap, `max page <= cap for n=${n} cap=${cap}`);
        assert.ok(Math.max(...pages) - Math.min(...pages) <= 1, `spread <= 1 for n=${n} cap=${cap}`);
        for (let i = 1; i < pages.length; i++) assert.ok(pages[i - 1] >= pages[i], `larger first for n=${n} cap=${cap}`);
      }
    }
  }
});

test('balancedPages rejects bad caps and counts', () => {
  assert.throws(() => balancedPages(5, 0), /positive integer/);
  assert.throws(() => balancedPages(5, -3), /positive integer/);
  assert.throws(() => balancedPages(5, 2.5), /positive integer/);
  assert.throws(() => balancedPages(-1, 9), /non-negative integer/);
});

test('pageLayout cells sit inside the canvas and do not overlap', () => {
  const layout = pageLayout({ chart: fixture.chart, count: 5 });
  assert.equal(layout.cells.length, 5);
  for (const c of layout.cells) {
    assert.ok(c.x >= 0 && c.x + c.width <= layout.width, `cell ${c.index} inside horizontally`);
    assert.ok(c.y >= 0 && c.threadLabelY <= layout.height, `cell ${c.index} + both label lines inside vertically`);
    assert.ok(c.labelY > c.y + c.height && c.threadLabelY > c.labelY, `cell ${c.index} label lines ordered below the photo`);
  }
  for (const a of layout.cells) {
    for (const b of layout.cells) {
      if (a.index >= b.index) continue;
      const overlap = a.x < b.x + b.width && b.x < a.x + a.width
        && a.y < b.y + b.height && b.y < a.y + a.height;
      assert.ok(!overlap, `cells ${a.index} and ${b.index} overlap`);
    }
  }
});

test('pageLayout: a row advance clears both label lines before the next row', () => {
  const layout = pageLayout({ chart: fixture.chart, count: 5 }); // 3x2 grid
  const firstRow = layout.cells.filter((c) => c.y === layout.cells[0].y);
  const nextRowTop = Math.min(...layout.cells.filter((c) => c.y > layout.cells[0].y).map((c) => c.y));
  for (const c of firstRow) {
    assert.ok(c.threadLabelY < nextRowTop, `cell ${c.index} thread line clears the next row`);
  }
});

test('pageLayout: a partial last row leaves trailing slots empty (left-aligned)', () => {
  const layout = pageLayout({ chart: fixture.chart, count: 5 }); // 3x2 grid, 5 cells
  const rows = new Set(layout.cells.map((c) => c.y));
  assert.equal(rows.size, 2);
  const lastRowCells = layout.cells.filter((c) => c.y === Math.max(...rows));
  assert.equal(lastRowCells.length, 2);
  assert.equal(lastRowCells[0].x, layout.cells[0].x); // left-aligned, not centred
});

test('pageLayout: fewer rows used means a shorter canvas', () => {
  const tall = pageLayout({ chart: fixture.chart, count: 4 });
  const short = pageLayout({ chart: fixture.chart, count: 3 }); // fits one row of 3
  assert.ok(short.height < tall.height);
});

test('pageLayout rejects impossible counts', () => {
  assert.throws(() => pageLayout({ chart: fixture.chart, count: 0 }), /positive integer/);
  assert.throws(() => pageLayout({ chart: fixture.chart, count: 7 }), /grid holds 6/);
});

test('compositePlan offsets against the fixture registry', () => {
  const { chart } = fixture;
  const layout = pageLayout({ chart, count: 5 });
  const plan = compositePlan(layout, chart.scale);
  assert.equal(plan.length, 5);
  plan.forEach((p, i) => {
    const c = layout.cells[i];
    assert.deepEqual(p, {
      left: Math.round(c.x * chart.scale),
      top: Math.round(c.y * chart.scale),
      width: Math.round(c.width * chart.scale),
      height: Math.round(c.height * chart.scale),
    });
    assert.ok(Number.isInteger(p.left) && Number.isInteger(p.top) && Number.isInteger(p.width) && Number.isInteger(p.height));
  });
  // Same-size cells stay the same size after scaling (no per-cell rounding drift).
  assert.equal(new Set(plan.map((p) => `${p.width}x${p.height}`)).size, 1);
});

test('compositePlan rejects a sub-1 scale', () => {
  const layout = pageLayout({ chart: fixture.chart, count: 2 });
  assert.throws(() => compositePlan(layout, 0.5), /scale/);
});

// ---------------------------------------------------------------------------
// The label ceiling: derived from geometry, not picked.
// ---------------------------------------------------------------------------

test('cellWidth is the same arithmetic pageLayout places cells with', () => {
  for (const columns of [2, 3, 4, 5]) {
    const chart = { ...fixture.chart, columns, rows: 3 };
    assert.equal(pageLayout({ chart, count: 1 }).cells[0].width, cellWidth(chart));
  }
});

test('the name ceiling tightens as the grid densifies, and never goes below 1', () => {
  const at = (columns) => nameCharCeiling({ columns, width_units: 1600 }, 255);
  assert.equal(at(3), 21);
  assert.ok(at(2) > at(3) && at(3) > at(4) && at(4) > at(5), 'denser grids must carry shorter names');
  assert.ok(nameCharCeiling({ columns: 40, width_units: 800 }, 255) >= 1);
});

test('the shipped registry clears its own ceiling, with headroom', () => {
  // The plan's rule: measure the real names first, or audit.mjs --local goes red and draft.mjs
  // --write refuses on already-committed data.
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  const ceiling = nameCharCeiling(registry.chart, 255);
  const longest = registry.patterns.map((p) => p.name).sort((a, b) => b.length - a.length)[0];
  assert.equal(longest, 'Terracotta Blossom');
  assert.equal(longest.length, 18);
  assert.ok(ceiling > longest.length, `ceiling ${ceiling} must exceed the longest committed name`);
  assert.ok(ceiling - longest.length >= 3, 'and with headroom, not by one character');
});

test('the ceiling also respects the dropdown line bound, so a wide chart cannot escape it', () => {
  // A 2-column chart at a huge canvas is bounded by the cart line-item property length, not pixels.
  const wide = nameCharCeiling({ columns: 1, width_units: 100000 }, 255);
  assert.equal(wide, 255 - LABEL_PREFIX_RESERVE - ' (Light Purple thread)'.length);
  assert.ok(wide < Math.floor(cellWidth({ columns: 1, width_units: 100000 }) / (LABEL_FONT_SIZE * LABEL_EM_PER_CHAR)));
});
