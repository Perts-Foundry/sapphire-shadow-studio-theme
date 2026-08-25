import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseThresholds,
  loadThresholds,
  findDuplicateKeys,
  reconcileThresholds,
  assessThresholds,
  buildAxes,
  buildPivot,
  formatCell,
  flagReorders,
  selectReorders,
  pivotCounts,
  bodyTotals,
  buildPurchaseList,
  renderPurchaseList,
  aggregateDemand,
  netUnits,
  proposeAdjustments,
  largestRemainder,
  deriveThresholds,
  serializeThresholds,
  sinceDate,
  compareSizes,
  cartesianCells,
  NO_GROUP,
  THRESHOLDS_PATH,
} from '../lib/reorder.mjs';
import { vocabKey, normaliseAxis, DRIFT, AWAITING_SEED, CONVERGED } from '../lib/groups.mjs';
import { loadCatalogue } from '../lib/catalogue-manifest.mjs';
import { variant, thresholdsFor, budgetsFor, manifestFor, VEST_BLACK_ONLY, MID_SIZES_ONLY, resetSeq, BODIES, COLORS, SIZES } from './fixtures.mjs';

const AXES = buildAxes({ bodies: BODIES, colors: COLORS, sizes: SIZES });
const key = (body, color, size) => vocabKey({ body, color, size });
const K = key('crewneck', 'Black', 'M');

/** The thresholds document as text, so the raw-text checks are exercised the way the tool runs. */
function doc({ version = 1, cells = { [K]: { min: 6 } }, provenance } = {}) {
  return JSON.stringify({ version, provenance: provenance ?? { budgets: {}, adjustments: [] }, cells }, null, 2);
}

// --- parseThresholds --------------------------------------------------------

test('parseThresholds returns normalised cells and budgets, not the raw object', () => {
  const parsed = parseThresholds(
    doc({
      cells: { [K]: { min: 6, note: 'core size' }, [key('crewneck', 'Black', 'XS')]: { min: 0 } },
      provenance: { budgets: { crewneck: 60 }, adjustments: [] },
    })
  );
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.cells.get(K), { min: 6, note: 'core size' });
  assert.deepEqual(parsed.cells.get(key('crewneck', 'Black', 'XS')), { min: 0 });
  assert.equal(parsed.budgets.get('crewneck'), 60);
});

test('parseThresholds accepts an empty cells object', () => {
  const parsed = parseThresholds(doc({ cells: {} }));
  assert.equal(parsed.cells.size, 0);
});

test('parseThresholds refuses a minimum that is not a whole non-negative number', () => {
  for (const min of [-1, 2.5, '6', null]) {
    assert.throws(() => parseThresholds(doc({ cells: { [K]: { min } } })), /crewneck\|black\|m/);
  }
  assert.throws(() => parseThresholds(doc({ cells: { [K]: {} } })), /crewneck\|black\|m/);
  assert.throws(() => parseThresholds(doc({ cells: { [K]: 6 } })), /must be an object/);
  assert.throws(() => parseThresholds(doc({ cells: { [K]: { min: 6, note: 7 } } })), /non-string note/);
});

test('parseThresholds refuses a malformed or unnormalised cell key rather than normalising it', () => {
  assert.throws(() => parseThresholds(doc({ cells: { 'crewneck|black': { min: 1 } } })), /segment\(s\), not 2/);
  assert.throws(() => parseThresholds(doc({ cells: { 'crewneck|black|m|x': { min: 1 } } })), /segment\(s\), not 4/);
  assert.throws(() => parseThresholds(doc({ cells: { 'crewneck||m': { min: 1 } } })), /empty segment/);
  assert.throws(() => parseThresholds(doc({ cells: { 'Crewneck|Black|M': { min: 1 } } })), /not in normalised form/);
  assert.throws(() => parseThresholds(doc({ cells: { 'crewneck|black| m': { min: 1 } } })), /not in normalised form/);
});

test('parseThresholds refuses a missing cells object and an unknown version', () => {
  assert.throws(() => parseThresholds(JSON.stringify({ version: 1 })), /needs a "cells" object/);
  assert.throws(() => parseThresholds(doc({ version: 2 })), /understands 1 only/);
  assert.throws(() => parseThresholds(JSON.stringify({ cells: {} })), /understands 1 only/);
});

test('parseThresholds surfaces a JSON syntax error as a refusal, not a raw SyntaxError', () => {
  assert.throws(() => parseThresholds('{ "version": 1, }}'), new RegExp(`${THRESHOLDS_PATH.replace(/[/.]/g, '\\$&')} is not valid JSON`));
});

test('parseThresholds rejects a duplicate cell key, which JSON.parse would silently last-wins', () => {
  const text = `{
  "version": 1,
  "cells": {
    "${K}": { "min": 6 },
    "${K}": { "min": 60 }
  }
}`;
  // JSON.parse itself is happy and takes the WRONG minimum, which is the whole point.
  assert.equal(JSON.parse(text).cells[K].min, 60);
  assert.throws(() => parseThresholds(text), /duplicate key/);
});

test('parseThresholds rejects a duplicate budget key', () => {
  const text = `{
  "version": 1,
  "provenance": { "budgets": { "crewneck": 60, "crewneck": 40 } },
  "cells": {}
}`;
  assert.throws(() => parseThresholds(text), /duplicate key/);
});

test('findDuplicateKeys names the path and ignores repeats in sibling objects', () => {
  const clean = `{"a": {"min": 1}, "b": {"min": 1}}`;
  assert.deepEqual(findDuplicateKeys(clean), []);
  const dirty = `{"cells": {"x": 1, "x": 2}}`;
  assert.deepEqual(findDuplicateKeys(dirty), [{ path: 'cells.x', key: 'x' }]);
});

test('parseThresholds refuses a budget key that is not a normalised garment body', () => {
  // The budget axis is the body alone: the colour split is derived from a curve, so a per-colour
  // budget would be a second source of truth for the same number.
  assert.throws(
    () => parseThresholds(doc({ provenance: { budgets: { 'crewneck|black': 20 } } })),
    /segment\(s\), not 2/
  );
  assert.throws(() => parseThresholds(doc({ provenance: { budgets: { Crewneck: 20 } } })), /not in normalised form/);
  assert.throws(() => parseThresholds(doc({ provenance: { budgets: { crewneck: 20.5 } } })), /crewneck/);
  assert.throws(() => parseThresholds(doc({ provenance: { budgets: { crewneck: '20' } } })), /unit count, never a currency/);
});

test('parseThresholds validates the shape of every adjustments entry', () => {
  const entry = (over) => doc({ provenance: { budgets: {}, adjustments: [{ date: '2026-08-24', source: 'last 60 days', note: 'n', cells: { [K]: { from: 6, to: 7 } } }].map((e) => ({ ...e, ...over })) } });
  assert.doesNotThrow(() => parseThresholds(entry({})));
  assert.throws(() => parseThresholds(entry({ note: '' })), /non-empty string "note"/);
  assert.throws(() => parseThresholds(entry({ date: 20260824 })), /non-empty string "date"/);
  assert.throws(() => parseThresholds(entry({ cells: [] })), /"cells" object/);
  assert.throws(() => parseThresholds(entry({ cells: { [K]: { from: 6 } } })), /non-integer "to"/);
  assert.throws(() => parseThresholds(entry({ cells: { 'CREW|BLACK|M': { from: 1, to: 2 } } })), /not in normalised form/);
  assert.throws(() => parseThresholds(doc({ provenance: { adjustments: {} } })), /must be an array/);
});

test('loadThresholds turns a missing file into a refusal carrying fileMissing', async () => {
  const enoent = Object.assign(new Error('nope'), { code: 'ENOENT' });
  await assert.rejects(
    loadThresholds({ read: async () => { throw enoent; } }),
    (err) => err.fileMissing === true && /No thresholds file at/.test(err.message)
  );
});

test('loadThresholds passes the raw text through the duplicate-key check', async () => {
  const text = `{"version": 1, "cells": {"${K}": {"min": 1}, "${K}": {"min": 2}}}`;
  await assert.rejects(loadThresholds({ read: async () => text }), /duplicate key/);
});

// --- reconcileThresholds ----------------------------------------------------

test('reconcileThresholds reports nothing when the table exactly covers the axes', () => {
  const out = reconcileThresholds(thresholdsFor(), budgetsFor(), AXES);
  assert.deepEqual(out.unthresholded, []);
  assert.deepEqual(out.stale, []);
  assert.deepEqual(out.staleBudgets, []);
  assert.deepEqual(out.missingBudgets, []);
  assert.equal(out.resolved.size, BODIES.length * COLORS.length * SIZES.length);
  assert.equal(out.resolved.get(K).min, 5);
});

test('reconcileThresholds reports a missing cell as unthresholded', () => {
  const cells = thresholdsFor();
  cells.delete(K);
  const out = reconcileThresholds(cells, budgetsFor(), AXES);
  assert.deepEqual(out.unthresholded, [K]);
});

test('an empty table against a full vocabulary reports every cell, which is the day-one path', () => {
  const out = reconcileThresholds(new Map(), new Map(), AXES);
  assert.equal(out.unthresholded.length, BODIES.length * COLORS.length * SIZES.length);
  assert.equal(out.missingBudgets.length, BODIES.length);
  assert.deepEqual(out.stale, []);
});

test('a retired combination is stale, never deleted', () => {
  const cells = thresholdsFor({ [key('hoodie', 'Black', 'M')]: 4 });
  const out = reconcileThresholds(cells, budgetsFor(), AXES);
  assert.deepEqual(out.stale, [key('hoodie', 'Black', 'M')]);
  assert.deepEqual(out.unthresholded, []);
});

test('a budget for an unknown body is stale, and a body with no budget is missing', () => {
  const budgets = budgetsFor(90, { hoodie: 12 });
  budgets.delete('crewneck');
  const out = reconcileThresholds(thresholdsFor(), budgets, AXES);
  assert.deepEqual(out.staleBudgets, ['hoodie']);
  assert.deepEqual(out.missingBudgets, ['crewneck']);
});

test('an empty vocabulary makes every committed cell stale rather than crashing', () => {
  const out = reconcileThresholds(thresholdsFor(), budgetsFor(), buildAxes({ bodies: [], colors: [], sizes: [] }));
  assert.equal(out.stale.length, BODIES.length * COLORS.length * SIZES.length);
  assert.deepEqual(out.unthresholded, []);
  assert.equal(out.resolved.size, 0);
});

// --- assessThresholds -------------------------------------------------------

test('assessThresholds is clean when nothing diverges', () => {
  const out = assessThresholds({});
  assert.equal(out.exitCode, 0);
  assert.deepEqual(out.refusals, []);
  assert.deepEqual(out.warnings, []);
});

test('assessThresholds refuses on unthresholded cells and names every one of them', () => {
  const keys = [K, key('vest-womens', 'Classic Navy', '2XL')];
  const out = assessThresholds({ unthresholded: keys });
  assert.equal(out.exitCode, 1);
  assert.equal(out.refusals.length, 1);
  for (const k of keys) assert.match(out.refusals[0].message, new RegExp(k.replace(/\|/g, '\\|')));
  assert.deepEqual(out.refusals[0].keys, keys);
});

test('assessThresholds warns, and does not refuse, on stale entries', () => {
  const out = assessThresholds({ stale: ['hoodie|black|m'], staleBudgets: ['hoodie|black'] });
  assert.equal(out.exitCode, 0);
  assert.equal(out.warnings.length, 2);
  assert.match(out.warnings[0].message, /hoodie\|black\|m/);
});

test('both kinds at once still exit 1 and keep the warning alongside the refusal', () => {
  const out = assessThresholds({ unthresholded: [K], stale: ['hoodie|black|m'] });
  assert.equal(out.exitCode, 1);
  assert.equal(out.refusals.length, 1);
  assert.equal(out.warnings.length, 1);
});

test('a missing budget refuses for demand and only warns for reorder', () => {
  const asReorder = assessThresholds({ missingBudgets: ['crewneck'] });
  assert.equal(asReorder.exitCode, 0);
  assert.match(asReorder.warnings[0].message, /crewneck/);
  const asDemand = assessThresholds({ missingBudgets: ['crewneck'], mode: 'demand' });
  assert.equal(asDemand.exitCode, 1);
  assert.match(asDemand.refusals[0].message, /redistributes a stated budget/);
});

test('a missing file is a refusal that points at the derivation workflow', () => {
  const out = assessThresholds({ fileMissing: true });
  assert.equal(out.exitCode, 1);
  assert.match(out.refusals[0].message, /No thresholds file at/);
});

// --- buildPivot -------------------------------------------------------------

const smallAxes = buildAxes({ bodies: ['crewneck'], colors: ['Black'], sizes: SIZES });

test('buildPivot reports a converged group as a single on-hand reading', () => {
  resetSeq();
  const variants = [7, 7, 7].map(() => variant({ body: 'crewneck', color: 'Black', size: 'M', quantity: 7 }));
  const pivot = buildPivot({ variants, axes: smallAxes });
  const cell = pivot.cells.get(K);
  assert.equal(cell.state, CONVERGED);
  assert.equal(cell.onHand, 7);
  assert.equal(cell.members, 3);
});

test('buildPivot never averages a non-converged group: onHand is null and the range is kept', () => {
  resetSeq();
  const variants = [4, 11, 11].map((q) => variant({ body: 'crewneck', color: 'Black', size: 'M', quantity: q }));
  const drifted = buildPivot({ variants, axes: smallAxes }).cells.get(K);
  assert.equal(drifted.state, DRIFT);
  assert.equal(drifted.onHand, null);
  assert.equal(drifted.low, 4);
  assert.equal(drifted.high, 11);

  const seeding = buildPivot({
    variants,
    axes: smallAxes,
    pendingSeedBlankIds: new Set([variants[0].blankId]),
  }).cells.get(K);
  assert.equal(seeding.state, AWAITING_SEED);
  assert.equal(seeding.onHand, null);
});

test('buildPivot marks a body+colour+size nothing carries as no-group', () => {
  const cell = buildPivot({ variants: [], axes: smallAxes }).cells.get(K);
  assert.equal(cell.state, NO_GROUP);
  assert.equal(cell.onHand, null);
  assert.equal(cell.members, 0);
});

test('buildPivot emits sizes in garment order, not lexicographic order', () => {
  const pivot = buildPivot({ variants: [], axes: smallAxes });
  const sizes = pivot.bodies[0].colors[0].cells.map((c) => c.size);
  assert.deepEqual(sizes, ['xs', 's', 'm', 'l', 'xl', '2xl']);
  assert.ok(compareSizes('s', '2xl') < 0 && compareSizes('xs', 'xl') < 0);
});

// --- formatCell -------------------------------------------------------------

test('formatCell renders every glyph state', () => {
  const base = { key: K, body: 'crewneck', color: 'black', size: 'm', sizeLabel: 'M' };
  const cases = [
    [{ ...base, state: CONVERGED, onHand: 7, low: 7, high: 7 }, { min: 6 }, 'M:7/6'],
    [{ ...base, state: CONVERGED, onHand: 6, low: 6, high: 6 }, { min: 6 }, 'M:6/6'],
    [{ ...base, state: CONVERGED, onHand: 5, low: 5, high: 5 }, { min: 6 }, 'M:5/6*'],
    [{ ...base, state: CONVERGED, onHand: -2, low: -2, high: -2 }, { min: 6 }, 'M:-2/6*'],
    [{ ...base, state: DRIFT, onHand: null, low: 4, high: 11 }, { min: 6 }, 'M:4-11/6?'],
    [{ ...base, state: DRIFT, onHand: null, low: 2, high: 4 }, { min: 6 }, 'M:2-4/6*?'],
    [{ ...base, state: AWAITING_SEED, onHand: null, low: 0, high: 9 }, { min: 6 }, 'M:0-9/6?'],
    [{ ...base, state: NO_GROUP, onHand: null, low: null, high: null }, { min: 6 }, 'M:--/6!'],
    [{ ...base, state: NO_GROUP, onHand: null, low: null, high: null }, { min: 0 }, 'M:--/0'],
    [{ ...base, state: CONVERGED, onHand: 0, low: 0, high: 0 }, undefined, 'M:0/0'],
  ];
  for (const [cell, threshold, expected] of cases) {
    assert.equal(formatCell(cell, threshold), expected, JSON.stringify(cell));
  }
});

// --- flagReorders / selectReorders ------------------------------------------

function pivotOf(spec) {
  // spec: {size: quantity[] | 'none'}
  resetSeq();
  const variants = [];
  for (const [size, quantities] of Object.entries(spec)) {
    if (quantities === 'none') continue;
    for (const q of quantities) variants.push(variant({ body: 'crewneck', color: 'Black', size, quantity: q }));
  }
  return buildPivot({ variants, axes: smallAxes });
}

const resolvedOf = (mins) =>
  new Map(
    Object.entries(mins).map(([size, min]) => [
      key('crewneck', 'Black', size),
      { key: key('crewneck', 'Black', size), body: 'crewneck', color: 'black', size: size.toLowerCase(), min },
    ])
  );

test('a cell below its minimum is flagged with the shortfall; the boundary is not', () => {
  const pivot = pivotOf({ M: [5], L: [6], XL: [7] });
  const flags = flagReorders(pivot, resolvedOf({ M: 6, L: 6, XL: 6 }));
  assert.deepEqual(flags.map((f) => [f.size, f.shortfall]), [['m', 1]]);
});

test('an unconverged group is flagged only when even its highest member is below the minimum', () => {
  const notFlagged = flagReorders(pivotOf({ M: [4, 6] }), resolvedOf({ M: 6 }));
  assert.deepEqual(notFlagged, []);
  const flagged = flagReorders(pivotOf({ M: [2, 4] }), resolvedOf({ M: 6 }));
  assert.deepEqual(flagged.map((f) => [f.shortfall, f.onHand, f.high]), [[2, null, 4]]);
});

test('a minimum of 0 never flags, whatever the state', () => {
  assert.deepEqual(flagReorders(pivotOf({ M: [0] }), resolvedOf({ M: 0 })), []);
  assert.deepEqual(flagReorders(pivotOf({ M: 'none' }), resolvedOf({ M: 0 })), []);
});

test('a thresholded cell with no group at all is always flagged, at the full minimum', () => {
  const flags = flagReorders(pivotOf({ M: 'none' }), resolvedOf({ M: 6 }));
  assert.deepEqual(flags.map((f) => [f.reason, f.shortfall, f.onHand]), [[NO_GROUP, 6, null]]);
});

test('a negative on-hand yields an unclamped shortfall', () => {
  const flags = flagReorders(pivotOf({ M: [-3] }), resolvedOf({ M: 6 }));
  assert.equal(flags[0].shortfall, 9);
});

test('selectReorders sorts by shortfall descending and breaks ties deterministically', () => {
  const flags = [
    { body: 'crewneck', color: 'black', size: '2xl', shortfall: 2 },
    { body: 'crewneck', color: 'black', size: 'm', shortfall: 2 },
    { body: 'crewneck', color: 'black', size: 's', shortfall: 9 },
    { body: 'quarter-zip', color: 'black', size: 'm', shortfall: 2 },
    { body: 'crewneck', color: 'classic navy', size: 'm', shortfall: 2 },
  ];
  assert.deepEqual(
    selectReorders({ flags }).map((f) => `${f.body}|${f.color}|${f.size}|${f.shortfall}`),
    [
      'crewneck|black|s|9',
      'crewneck|black|m|2',
      'crewneck|black|2xl|2',
      'crewneck|classic navy|m|2',
      'quarter-zip|black|m|2',
    ]
  );
  assert.deepEqual(selectReorders({ flags, body: 'quarter-zip' }).map((f) => f.body), ['quarter-zip']);
  assert.deepEqual(selectReorders({ flags: [] }), []);
  // The terse view must select exactly what the full view selects.
  assert.deepEqual(selectReorders({ flags, belowOnly: true }), selectReorders({ flags }));
});

test('pivotCounts keeps unsettled and absent cells visible to the terse view', () => {
  const pivot = pivotOf({ M: [4, 9], L: [7], XL: 'none' });
  const counts = pivotCounts(pivot, resolvedOf({ M: 6, L: 6, XL: 6, XS: 0, S: 0, '2XL': 0 }));
  assert.deepEqual(counts, { unsettled: 1, noGroup: 1 });
});

// --- bodyTotals -------------------------------------------------------------
//
// The block that answers "is this body short overall, or holding the right number of units in the
// wrong sizes". Every assertion here is about what is EXCLUDED as much as what is summed: a cell
// mid-fan-out and a cell with no group must never be read as settled zeroes.

test('bodyTotals sums only settled cells and reports the rest as excluded', () => {
  const pivot = pivotOf({ S: [2], M: [4, 9], L: [7], XL: 'none' });
  const totals = bodyTotals(pivot, resolvedOf({ XS: 0, S: 4, M: 6, L: 6, XL: 6, '2XL': 0 }));

  assert.equal(totals.bodies.length, 1);
  const crew = totals.bodies[0];
  assert.equal(crew.body, 'crewneck');
  // S and L are settled (2 and 7 on hand, minimums 4 and 6). M is a range and XL has no group.
  assert.equal(crew.onHandSum, 9);
  assert.equal(crew.minSum, 10);
  assert.equal(crew.shortfallUnits, 2);
  assert.equal(crew.surplusUnits, 1);
  assert.equal(crew.converged, 2);
  assert.equal(crew.unsettled, 1);
  assert.equal(crew.noGroup, 1);
});

test('a cell with no group and no minimum is not counted as a gap', () => {
  // Mirrors pivotCounts: "we do not make this combination" is recorded as min 0, and a 0 never flags.
  const totals = bodyTotals(pivotOf({ M: [6] }), resolvedOf({ XS: 0, S: 0, M: 6, L: 0, XL: 0, '2XL': 0 }));
  assert.equal(totals.bodies[0].noGroup, 0);
  assert.equal(totals.bodies[0].converged, 1);
});

test('a negative on-hand is not clamped, in either direction', () => {
  // Shopify permits an oversell. flagReorders reports the full gap; so does this, or the body
  // furthest behind would be the one under-reported.
  const totals = bodyTotals(pivotOf({ M: [-3] }), resolvedOf({ XS: 0, S: 0, M: 6, L: 0, XL: 0, '2XL': 0 }));
  assert.equal(totals.bodies[0].onHandSum, -3);
  assert.equal(totals.bodies[0].shortfallUnits, 9);
  assert.equal(totals.bodies[0].surplusUnits, 0);
});

test('short and surplus are counted separately, never netted', () => {
  // The whole point of the block: 2 short in one size and 4 spare in another is not "2 in hand".
  const totals = bodyTotals(pivotOf({ S: [0], M: [10] }), resolvedOf({ XS: 0, S: 2, M: 6, L: 0, XL: 0, '2XL': 0 }));
  const crew = totals.bodies[0];
  assert.equal(crew.shortfallUnits, 2);
  assert.equal(crew.surplusUnits, 4);
  assert.equal(crew.onHandSum, 10);
  assert.equal(crew.minSum, 8);
});

test('a body with no settled cell sums to zero rather than to NaN', () => {
  const totals = bodyTotals(pivotOf({ M: [4, 9] }), resolvedOf({ XS: 0, S: 0, M: 6, L: 0, XL: 0, '2XL': 0 }));
  assert.deepEqual(totals.bodies[0], {
    body: 'crewneck',
    bodyLabel: 'crewneck',
    onHandSum: 0,
    minSum: 0,
    shortfallUnits: 0,
    surplusUnits: 0,
    converged: 0,
    unsettled: 1,
    noGroup: 0,
  });
});

test('an empty pivot yields no body rows and an all-zero total', () => {
  const totals = bodyTotals(buildPivot({ variants: [], axes: buildAxes({ bodies: [], colors: [], sizes: [] }) }), new Map());
  assert.deepEqual(totals.bodies, []);
  assert.deepEqual(totals.total, {
    onHandSum: 0,
    minSum: 0,
    shortfallUnits: 0,
    surplusUnits: 0,
    converged: 0,
    unsettled: 0,
    noGroup: 0,
  });
});

test('the grand total is the sum of the bodies, and is kept out of the bodies array', () => {
  // Returned separately so a consumer that iterates bodies cannot sum the total into itself.
  resetSeq();
  const variants = [
    variant({ body: 'crewneck', color: 'Black', size: 'M', quantity: 3 }),
    variant({ body: 'quarter-zip', color: 'Black', size: 'M', quantity: 8 }),
  ];
  const axes = buildAxes({ bodies: ['crewneck', 'quarter-zip'], colors: ['Black'], sizes: ['M'] });
  const resolved = new Map([
    [key('crewneck', 'Black', 'M'), { min: 6 }],
    [key('quarter-zip', 'Black', 'M'), { min: 6 }],
  ]);
  const totals = bodyTotals(buildPivot({ variants, axes }), resolved);

  assert.deepEqual(totals.bodies.map((b) => b.body), ['crewneck', 'quarter-zip'], 'body order follows the axes, so two runs print the same table');
  assert.equal(totals.bodies.some((b) => b.body === undefined), false);
  for (const field of ['onHandSum', 'minSum', 'shortfallUnits', 'surplusUnits', 'converged', 'unsettled', 'noGroup']) {
    assert.equal(
      totals.total[field],
      totals.bodies.reduce((n, b) => n + b[field], 0),
      `total.${field} must equal the sum of the bodies`
    );
  }
  assert.equal(totals.total.onHandSum, 11);
  assert.equal(totals.total.shortfallUnits, 3);
  assert.equal(totals.total.surplusUnits, 2);
});

// --- aggregateDemand --------------------------------------------------------

const VARIANT_INDEX = new Map([
  ['v1', { body: 'crewneck', color: 'Black', size: 'M' }],
  ['v2', { body: 'crewneck', color: 'Black', size: 'L' }],
  ['v3', { body: 'crewneck', color: 'Classic Navy', size: 'M' }],
]);

test('netUnits prefers the quantity that already excludes refunded and removed units', () => {
  assert.equal(netUnits({ quantity: 3, currentQuantity: 1, refundableQuantity: 2 }), 1);
  assert.equal(netUnits({ quantity: 3, refundableQuantity: 2 }), 2);
  assert.equal(netUnits({ quantity: 3 }), 3);
  assert.equal(netUnits({}), 0);
});

test('aggregateDemand sums per cell and rolls up to body+colour', () => {
  const out = aggregateDemand(
    [
      { id: 'l1', variantId: 'v1', quantity: 2, currentQuantity: 2 },
      { id: 'l2', variantId: 'v1', quantity: 3, currentQuantity: 3 },
      { id: 'l3', variantId: 'v2', quantity: 0, currentQuantity: 0 },
      { id: 'l4', variantId: 'v3', quantity: 4, currentQuantity: 4 },
    ],
    VARIANT_INDEX
  );
  assert.equal(out.byCell.get(K).units, 5);
  assert.equal(out.byCell.get(key('crewneck', 'Black', 'L')).units, 0);
  assert.equal(out.byBodyColor.get('crewneck|black'), 5);
  assert.equal(out.byBodyColor.get('crewneck|classic navy'), 4);
  // The rollup is the sum of its cells, by construction rather than by coincidence.
  const summed = [...out.byCell.values()]
    .filter((c) => `${c.body}|${c.color}` === 'crewneck|black')
    .reduce((a, c) => a + c.units, 0);
  assert.equal(summed, out.byBodyColor.get('crewneck|black'));
});

test('a fully refunded line contributes nothing and a partial refund contributes the net', () => {
  const out = aggregateDemand(
    [
      { id: 'l1', variantId: 'v1', quantity: 2, currentQuantity: 0 },
      { id: 'l2', variantId: 'v1', quantity: 5, currentQuantity: 3 },
    ],
    VARIANT_INDEX
  );
  assert.equal(out.byCell.get(K).units, 3);
});

test('a cancelled line is excluded outright', () => {
  const out = aggregateDemand([{ id: 'l1', variantId: 'v1', quantity: 9, currentQuantity: 9, cancelled: true }], VARIANT_INDEX);
  assert.equal(out.byCell.size, 0);
});

test('an unkeyable line is reported, never dropped', () => {
  const out = aggregateDemand(
    [
      { id: 'l1', variantId: null, quantity: 2, currentQuantity: 2, orderId: 'o1' },
      { id: 'l2', quantity: 1, currentQuantity: 1, orderId: 'o2' },
      { id: 'l3', variantId: 'gone', quantity: 4, currentQuantity: 4, orderId: 'o3' },
    ],
    VARIANT_INDEX
  );
  assert.equal(out.byCell.size, 0);
  assert.deepEqual(out.unattributed.map((u) => [u.lineItemId, u.variantId, u.units]), [
    ['l1', null, 2],
    ['l2', null, 1],
    ['l3', 'gone', 4],
  ]);
});

test('aggregateDemand handles an empty window', () => {
  const out = aggregateDemand([], VARIANT_INDEX);
  assert.equal(out.byCell.size, 0);
  assert.equal(out.byBodyColor.size, 0);
  assert.deepEqual(out.unattributed, []);
});

// --- largestRemainder / proposeAdjustments ----------------------------------

test('largestRemainder always sums to the total, with a deterministic tie vector', () => {
  const equal = largestRemainder(
    ['a', 'b', 'c', 'd'].map((k) => ({ key: k, weight: 1 })),
    10
  );
  assert.deepEqual([...equal.values()], [3, 3, 2, 2]);
  assert.equal([...equal.values()].reduce((a, b) => a + b, 0), 10);

  const three = largestRemainder(['a', 'b', 'c'].map((k) => ({ key: k, weight: 1 })), 10);
  assert.deepEqual([...three.values()], [4, 3, 3]);

  assert.deepEqual([...largestRemainder([{ key: 'a', weight: 0 }], 10).values()], [0]);
  assert.deepEqual([...largestRemainder([{ key: 'a', weight: 1 }], 0).values()], [0]);
  assert.deepEqual([...largestRemainder([], 10).values()], []);
});

/** A single body+colour, full size run, converged and comfortably above every minimum. */
function demandFixture({ mins, units, budget = 30, onHand }) {
  resetSeq();
  const variants = [];
  for (const size of SIZES) {
    const q = onHand?.[size];
    if (q === 'none') continue;
    variants.push(variant({ body: 'crewneck', color: 'Black', size, quantity: q ?? 99 }));
  }
  const pivot = buildPivot({ variants, axes: smallAxes });
  const resolved = new Map(
    SIZES.map((size) => {
      const k = key('crewneck', 'Black', size);
      return [k, { key: k, body: 'crewneck', color: 'black', size: size.toLowerCase(), min: mins[size] ?? 0 }];
    })
  );
  const byCell = new Map(
    Object.entries(units).map(([size, u]) => {
      const k = key('crewneck', 'Black', size);
      return [k, { key: k, body: 'crewneck', color: 'black', size: size.toLowerCase(), units: u }];
    })
  );
  return { pivot, resolved, byCell, budgets: new Map([['crewneck', budget]]) };
}

test('proposeAdjustments redistributes the current budget by observed share', () => {
  const f = demandFixture({ mins: { XS: 1, S: 4, M: 9, L: 8, XL: 5, '2XL': 3 }, units: { M: 10, L: 5, S: 5 } });
  const { rows, bodies } = proposeAdjustments(f);
  const total = rows.reduce((a, r) => a + r.proposedMin, 0);
  assert.equal(total, 30);
  assert.ok(rows.every((r) => Number.isInteger(r.proposedMin)));
  const m = rows.find((r) => r.size === 'm');
  assert.equal(m.units, 10);
  assert.equal(m.observedShare, 0.5);
  assert.equal(m.proposedMin, 15);
  assert.equal(m.delta, 6);
  assert.equal(m.status, 'proposed');
  assert.equal(bodies[0].budgetDrift, null);
  assert.equal(rows.find((r) => r.size === 'xs').proposedMin, 0);
});

test('a body+colour with no observed sales holds its minimums instead of ratcheting them to zero', () => {
  const f = demandFixture({ mins: { XS: 1, S: 4, M: 9, L: 8, XL: 5, '2XL': 3 }, units: {} });
  const { rows, bodies } = proposeAdjustments(f);
  assert.equal(bodies[0].status, 'insufficient-data');
  assert.ok(rows.every((r) => r.status === 'insufficient-data' && r.delta === 0));
});

test('a single stray unit does not absorb the whole budget', () => {
  const f = demandFixture({ mins: { XS: 1, S: 4, M: 9, L: 8, XL: 5, '2XL': 3 }, units: { XS: 1 } });
  const { rows } = proposeAdjustments(f);
  assert.equal(rows.find((r) => r.size === 'xs').proposedMin, 1);
  assert.ok(rows.every((r) => r.delta === 0));
});

test('the demand pass recalibrates colour as well as size, from one body budget', () => {
  // The colour split is derived, not stated, so demand has to be able to move it. A pass that only
  // reshuffled sizes would leave the colour mix on its original guess forever.
  resetSeq();
  const axes = buildAxes({ bodies: ['crewneck'], colors: COLORS, sizes: ['M'] });
  const variants = COLORS.map((color) => variant({ body: 'crewneck', color, size: 'M', quantity: 99 }));
  const pivot = buildPivot({ variants, axes });
  const resolved = new Map(
    COLORS.map((color) => {
      const k = key('crewneck', color, 'M');
      return [k, { key: k, body: 'crewneck', color: color.toLowerCase(), size: 'm', min: 10 }];
    })
  );
  const byCell = new Map(
    [['Black', 24], ['Grey Heather', 6], ['Classic Navy', 0]].map(([color, units]) => {
      const k = key('crewneck', color, 'M');
      return [k, { key: k, body: 'crewneck', color: color.toLowerCase(), size: 'm', units }];
    })
  );
  const { rows } = proposeAdjustments({ byCell, budgets: new Map([['crewneck', 30]]), resolved, pivot });
  assert.deepEqual(rows.map((r) => [r.color, r.proposedMin]), [
    ['black', 24],
    ['grey heather', 6],
    ['classic navy', 0],
  ]);
  assert.equal(rows.reduce((a, r) => a + r.proposedMin, 0), 30);
});

test('a cell that sat at or below its minimum is held out of the redistribution', () => {
  // M was stocked out all window, so its zero sales are not evidence of zero demand.
  const f = demandFixture({
    mins: { XS: 0, S: 0, M: 9, L: 8, XL: 0, '2XL': 0 },
    units: { L: 12 },
    onHand: { M: 9 },
    budget: 20,
  });
  const { rows, bodies } = proposeAdjustments(f);
  const m = rows.find((r) => r.size === 'm');
  assert.equal(m.status, 'held:stocked-out');
  assert.equal(m.proposedMin, 9);
  assert.equal(rows.find((r) => r.size === 'l').proposedMin, 11); // 20 budget minus the 9 held
  assert.deepEqual(bodies[0].heldCells, [key('crewneck', 'Black', 'M')]);
});

test('a cell with no settled reading is held rather than assumed idle', () => {
  resetSeq();
  const variants = [
    variant({ body: 'crewneck', color: 'Black', size: 'M', quantity: 2 }),
    variant({ body: 'crewneck', color: 'Black', size: 'M', quantity: 8 }),
    variant({ body: 'crewneck', color: 'Black', size: 'L', quantity: 99 }),
  ];
  const pivot = buildPivot({ variants, axes: smallAxes });
  const f = demandFixture({ mins: { XS: 0, S: 0, M: 5, L: 5, XL: 0, '2XL': 0 }, units: { L: 12 }, budget: 20 });
  const { rows } = proposeAdjustments({ ...f, pivot });
  assert.equal(rows.find((r) => r.size === 'm').status, 'held:unsettled');
  assert.equal(rows.find((r) => r.size === 'xs').status, 'held:no-group');
});

test('budget drift is reported and the proposal sums to the budget, not to the old total', () => {
  const f = demandFixture({ mins: { XS: 0, S: 2, M: 8, L: 6, XL: 3, '2XL': 1 }, units: { M: 10, L: 10 }, budget: 30 });
  const { rows, bodies } = proposeAdjustments(f);
  assert.deepEqual(bodies[0].budgetDrift, { currentSum: 20, budget: 30 });
  assert.equal(rows.reduce((a, r) => a + r.proposedMin, 0), 30);
});

test('proposeAdjustments follows the resolved table\'s canonical order, and ignores the demand map\'s', () => {
  // `resolved` comes from cartesianCells, so its insertion order IS the canonical colour-then-size
  // order and the rows follow it rather than a second sort rule. The observed-demand map has no
  // meaningful order at all, so reversing it must change nothing.
  const f = demandFixture({ mins: { XS: 1, S: 4, M: 9, L: 8, XL: 5, '2XL': 3 }, units: { M: 10, L: 5, S: 5 } });
  assert.deepEqual(
    proposeAdjustments(f).rows.map((r) => r.size),
    ['xs', 's', 'm', 'l', 'xl', '2xl']
  );
  const reversedDemand = { ...f, byCell: new Map([...f.byCell.entries()].reverse()) };
  assert.deepEqual(proposeAdjustments(reversedDemand).rows, proposeAdjustments(f).rows);
});

test('proposeAdjustments refuses an incomplete pivot and a missing budget', () => {
  const f = demandFixture({ mins: { XS: 1, S: 4, M: 9, L: 8, XL: 5, '2XL': 3 }, units: { M: 10 } });
  assert.throws(() => proposeAdjustments({ ...f, pivot: { cells: new Map() } }), /built from different reads/);
  assert.throws(() => proposeAdjustments({ ...f, budgets: new Map() }), /No budget for "crewneck"/);
});

test('proposeAdjustments over an empty demand window holds everything', () => {
  const f = demandFixture({ mins: { XS: 1, S: 1, M: 1, L: 1, XL: 1, '2XL': 1 }, units: {} });
  const { rows } = proposeAdjustments({ ...f, byCell: new Map() });
  assert.ok(rows.every((r) => r.delta === 0));
});

// --- deriveThresholds / serializeThresholds ---------------------------------

test('deriveThresholds splits a body budget by colour, then by size, and loses nothing to rounding', () => {
  const sizeCurve = { crewneck: { xs: 0.03, s: 0.15, m: 0.28, l: 0.27, xl: 0.17, '2xl': 0.1 } };
  const colorCurve = { crewneck: { black: 0.45, 'grey heather': 0.3, 'classic navy': 0.25 } };
  const axes = buildAxes({ bodies: ['crewneck'], colors: COLORS, sizes: SIZES });
  const built = deriveThresholds({ sizeCurve, colorCurve, budgets: { crewneck: 60 }, axes });

  const all = Object.values(built.cells).reduce((a, c) => a + c.min, 0);
  assert.equal(all, 60, 'both rounding stages are largest remainder, so nothing leaks between them');

  const perColor = (color) => SIZES.reduce((a, size) => a + built.cells[key('crewneck', color, size)].min, 0);
  assert.deepEqual(COLORS.map(perColor), [27, 18, 15]);
  assert.deepEqual(
    SIZES.map((size) => built.cells[key('crewneck', 'Black', size)].min),
    [1, 4, 7, 7, 5, 3]
  );
  assert.ok(Object.values(built.cells).every((c) => Number.isInteger(c.min)));
});

test('deriveThresholds gives a body with no budget explicit zeroes plus a note', () => {
  const built = deriveThresholds({
    sizeCurve: {},
    colorCurve: {},
    budgets: {},
    axes: smallAxes,
    notes: { crewneck: 'not made yet' },
  });
  assert.deepEqual(built.cells[K], { min: 0, note: 'not made yet' });
  assert.equal(Object.keys(built.cells).length, SIZES.length);
});

test('deriveThresholds records both curves and the budgets as provenance only', () => {
  const sizeCurve = { crewneck: { m: 1 } };
  const colorCurve = { crewneck: { black: 1 } };
  const built = deriveThresholds({ sizeCurve, colorCurve, budgets: { crewneck: 4 }, axes: smallAxes, provenance: { derivedAt: '2026-08-24' } });
  assert.deepEqual(built.provenance.sizeCurve, sizeCurve);
  assert.deepEqual(built.provenance.colorCurve, colorCurve);
  assert.deepEqual(built.provenance.budgets, { crewneck: 4 });
  assert.deepEqual(built.provenance.adjustments, []);
  // The whole budget lands on the only cell either curve gives weight to.
  assert.equal(built.cells[K].min, 4);
});

test('serializeThresholds is canonical: fixed order, two-space indent, trailing newline', () => {
  const sizeCurve = { crewneck: { xs: 0.03, s: 0.15, m: 0.28, l: 0.27, xl: 0.17, '2xl': 0.1 } };
  const colorCurve = { crewneck: { black: 1 } };
  const make = () =>
    deriveThresholds({ sizeCurve, colorCurve, budgets: { crewneck: 20 }, axes: smallAxes, provenance: { derivedAt: '2026-08-24' } });
  const text = serializeThresholds(make(), smallAxes);
  assert.ok(text.endsWith('}\n'));
  assert.match(text, /\n  "version": 1,/);
  assert.deepEqual(Object.keys(JSON.parse(text).cells), SIZES.map((s) => key('crewneck', 'Black', s)));
  // Regeneration is byte-identical, and a reordered input does not move a line.
  assert.equal(serializeThresholds(make(), smallAxes), text);
  const built = make();
  const shuffled = { ...built, cells: Object.fromEntries(Object.entries(built.cells).reverse()) };
  assert.equal(serializeThresholds(shuffled, smallAxes), text);
  // And it round-trips through the parser it will be read by.
  assert.equal(parseThresholds(text).cells.size, SIZES.length);
});

// --- sinceDate --------------------------------------------------------------

test('sinceDate walks back from an injected clock', () => {
  assert.equal(sinceDate(60, new Date('2026-08-24T12:00:00.000Z')), '2026-06-25T12:00:00.000Z');
  assert.equal(sinceDate(1, Date.parse('2026-01-01T00:00:00.000Z')), '2025-12-31T00:00:00.000Z');
});

test('sinceDate refuses a window that is not a whole positive number of days', () => {
  for (const days of [0, -7, 1.5, '60', true, undefined]) {
    assert.throws(() => sinceDate(days, new Date('2026-08-24T12:00:00.000Z')), /whole number of days/);
  }
});

// --- the committed file, and the read-only guard ----------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

test('the committed thresholds.json parses under the tool\'s own schema rules', async () => {
  // Schema and duplicate keys only. Coverage against the live vocabulary needs the store, so that
  // half stays a runtime refusal rather than a CI check that cannot see the catalogue.
  const parsed = await loadThresholds({ read: (p) => readFile(path.join(repoRoot, p), 'utf8') });
  assert.ok(parsed.cells.size > 0, 'the committed file must carry cells');
  for (const [k, cell] of parsed.cells) {
    assert.ok(Number.isInteger(cell.min) && cell.min >= 0, `${k} has a usable minimum`);
  }
});

test('neither new command is a write command, and the lib cannot reach a mutation', async () => {
  const cli = await readFile(path.join(repoRoot, 'scripts/blank-inventory/blank-inventory.mjs'), 'utf8');
  const writeSet = cli.match(/const writeCommands = new Set\(\[([^\]]*)\]\)/)?.[1] ?? '';
  assert.ok(writeSet, 'the writeCommands set must still be readable from the CLI');
  assert.doesNotMatch(writeSet, /reorder|demand/);
  assert.match(cli, /reorder: cmdReorder/);
  assert.match(cli, /demand: cmdDemand/);

  // Assert the import list itself, not a substring search: the module header names mutations.mjs
  // precisely to say it must never import it, and a naive grep cannot tell the prohibition from the
  // violation.
  const lib = await readFile(path.join(here, '../lib/reorder.mjs'), 'utf8');
  const imports = [...lib.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./groups.mjs']);
  assert.doesNotMatch(lib, /setQuantity\(|adjustQuantity\(|metafieldsSet/);
});

test('cartesianCells covers the whole axis space in canonical order', () => {
  const cells = cartesianCells(AXES);
  assert.equal(cells.length, BODIES.length * COLORS.length * SIZES.length);
  assert.equal(cells[0].key, key('crewneck', 'Black', 'XS'));
  assert.equal(cells.at(-1).key, key('vest-womens', 'Classic Navy', '2XL'));
});

// --- the declared coverage space --------------------------------------------
// The cell space used to be a global cross product, which invented cells for combinations a body is
// not made in. It is now per body, taken from the committed catalogue manifest.

const narrowManifest = manifestFor({ 'vest-womens': VEST_BLACK_ONLY });
const narrowAxes = buildAxes({ bodies: BODIES, colors: COLORS, sizes: SIZES, ranges: narrowManifest.bodies });

test('cartesianCells is a per-body sum, not a global cross product, once ranges are declared', () => {
  const cells = cartesianCells(narrowAxes);
  const expected = (COLORS.length * SIZES.length) * 2 + SIZES.length; // two full bodies plus a Black-only vest
  assert.equal(cells.length, expected);
  assert.equal(cells.length, BODIES.length * COLORS.length * SIZES.length - 12, 'twelve unfillable vest cells are gone');
  assert.equal(cells[0].key, key('crewneck', 'Black', 'XS'));
  assert.equal(cells.at(-1).key, key('vest-womens', 'Black', '2XL'));
  assert.ok(!cells.some((c) => c.key.startsWith('vest-womens|classic navy')));
});

test('buildAxes refuses a body with no declared range rather than falling back to the global axes', () => {
  // A silent fallback here is exactly the cross product this split removed, reintroduced for one body.
  assert.throws(
    () => buildAxes({ bodies: BODIES, colors: COLORS, sizes: SIZES, ranges: manifestFor({ 'vest-womens': null }).bodies }),
    /No declared colour and size range for garment body "vest-womens"/
  );
});

test('the vest matrix prints one colour row, and its undeclared cells do not exist at all', () => {
  const variants = [
    variant({ body: 'vest-womens', color: 'Black', size: 'M', quantity: 3 }),
    variant({ body: 'crewneck', color: 'Classic Navy', size: 'M', quantity: 3 }),
  ];
  const pivot = buildPivot({ variants, axes: narrowAxes });
  const vest = pivot.bodies.find((b) => b.body === 'vest-womens');
  assert.deepEqual(vest.colors.map((c) => c.color), ['black']);
  assert.equal(pivot.cells.has(key('vest-womens', 'Classic Navy', 'M')), false);
  // The other bodies are untouched by the narrowing.
  assert.equal(pivot.bodies.find((b) => b.body === 'crewneck').colors.length, COLORS.length);
});

test('a thresholds entry outside the declared shape is stale, and the declared cells still refuse when missing', () => {
  const cells = thresholdsFor(); // the full cross product, including the twelve undeclared vest cells
  const out = reconcileThresholds(cells, budgetsFor(), narrowAxes);
  assert.equal(out.unthresholded.length, 0, 'every declared cell has an entry');
  assert.equal(out.stale.length, 12);
  assert.ok(out.stale.every((k) => k.startsWith('vest-womens|classic navy') || k.startsWith('vest-womens|grey heather')));
  const assessed = assessThresholds({ ...out, mode: 'reorder' });
  assert.equal(assessed.exitCode, 0, 'a stale row is a warning, never a refusal');
  assert.deepEqual(assessed.warnings.map((w) => w.code), ['stale-cells']);
});

test('a body narrowed on the SIZE axis contributes only its declared columns', () => {
  // Colour narrowing and size narrowing run through different loops. A fixture set that only ever
  // narrows colours leaves half the per-body path unexercised in both the pivot and the derivation.
  const axes = buildAxes({ bodies: BODIES, ranges: manifestFor({ 'vest-womens': MID_SIZES_ONLY }).bodies });
  const pivot = buildPivot({ variants: [variant({ body: 'vest-womens', color: 'Black', size: 'M', quantity: 1 })], axes });
  const vest = pivot.bodies.find((b) => b.body === 'vest-womens');
  assert.deepEqual(vest.colors[0].cells.map((c) => c.size), ['m', 'l']);
  assert.equal(pivot.cells.has(key('vest-womens', 'Black', 'XS')), false);
  // The other bodies keep all six columns, so the narrowing is per body and not global.
  assert.equal(pivot.bodies.find((b) => b.body === 'crewneck').colors[0].cells.length, SIZES.length);
});

test('deriveThresholds spends a narrowed body\'s whole budget on the colours it is actually made in', () => {
  // largestRemainder normalises by the sum of the weights it is GIVEN, so dropping a colour from the
  // range redistributes rather than discards. Without this the vest's budget would leak into cells
  // that no longer exist, or vanish entirely when the curve weights only undeclared colours.
  const axes = buildAxes({ bodies: ['vest-womens'], ranges: manifestFor({ 'vest-womens': VEST_BLACK_ONLY }).bodies });
  const built = deriveThresholds({
    // The curve still names all three colours, exactly as the committed file did before the split.
    colorCurve: { 'vest-womens': { black: 0.4, 'grey heather': 0.3, 'classic navy': 0.3 } },
    sizeCurve: { 'vest-womens': { xs: 0.04, s: 0.18, m: 0.28, l: 0.26, xl: 0.16, '2xl': 0.08 } },
    budgets: { 'vest-womens': 12 },
    axes,
  });
  const keys = Object.keys(built.cells);
  assert.ok(!keys.some((k) => k.includes('grey heather') || k.includes('classic navy')));
  assert.equal(keys.length, SIZES.length);
  assert.equal(
    Object.values(built.cells).reduce((a, c) => a + c.min, 0),
    12,
    "the whole budget lands on the declared colour rather than leaking into cells that do not exist"
  );
});

test('deriveThresholds gives a body zero rather than a wrong number when the curve weights only undeclared colours', () => {
  // The degenerate case: every weight the curve supplies belongs to a colour outside the range, so
  // largestRemainder sees a zero sum. Zero cells is the honest answer, and the demand pass's
  // budgetDrift is what surfaces it; inventing a split across colours the curve never rated would be
  // a number nobody chose.
  const axes = buildAxes({ bodies: ['vest-womens'], ranges: manifestFor({ 'vest-womens': VEST_BLACK_ONLY }).bodies });
  const built = deriveThresholds({
    colorCurve: { 'vest-womens': { 'classic navy': 1 } },
    sizeCurve: { 'vest-womens': { m: 1 } },
    budgets: { 'vest-womens': 12 },
    axes,
  });
  assert.equal(Object.values(built.cells).reduce((a, c) => a + c.min, 0), 0);
});

test('buildAxes exposes the flat union of the declared ranges, deduped and in garment size order', () => {
  const axes = buildAxes({ bodies: BODIES, ranges: manifestFor({ 'vest-womens': MID_SIZES_ONLY }).bodies });
  // Colours in first-declaring-body order, each once even though two bodies declare all three.
  assert.deepEqual(axes.colors, ['black', 'grey heather', 'classic navy']);
  assert.deepEqual(axes.sizes, SIZES.map((s) => s.toLowerCase()));
});

test('buildAxes accepts the plain-object form of ranges as well as a Map', () => {
  // The documented alternative, and the shape a caller gets from JSON straight off disk.
  const asObject = Object.fromEntries([...manifestFor({ 'vest-womens': VEST_BLACK_ONLY }).bodies.entries()]);
  const fromObject = buildAxes({ bodies: BODIES, ranges: asObject });
  const fromMap = buildAxes({ bodies: BODIES, ranges: manifestFor({ 'vest-womens': VEST_BLACK_ONLY }).bodies });
  assert.deepEqual(cartesianCells(fromObject).map((c) => c.key), cartesianCells(fromMap).map((c) => c.key));
});

test('buildAxes reads only own properties of an object range, never an inherited one', () => {
  // `ranges?.[body]` would otherwise find Object.prototype.constructor for a body called
  // "constructor" and treat a function as a declared range.
  assert.throws(
    () => buildAxes({ bodies: ['constructor'], ranges: { crewneck: { colors: ['black'], sizes: ['m'] } } }),
    /No declared colour and size range for garment body "constructor"/
  );
});

test('serializeThresholds orders bodies by code point, colours in manifest order, sizes in garment order', () => {
  // Body order deliberately does NOT follow the manifest: reordering bodies there must never churn
  // the committed thresholds file. Colour order does, because it is the matrix row order.
  const shuffled = manifestFor({
    crewneck: { colors: ['classic navy', 'black'], sizes: ['2xl', 'm', 'xs'] },
    'quarter-zip': null,
    'vest-womens': VEST_BLACK_ONLY,
  });
  const axes = buildAxes({ bodies: ['vest-womens', 'crewneck'], ranges: shuffled.bodies });
  const doc = {
    version: 1,
    provenance: { budgets: { crewneck: 1, 'vest-womens': 1 } },
    // REVERSED before serializing. Built in canonical order the assertion would pass on an
    // implementation that only spread doc.cells through, since JS objects keep insertion order; it
    // would be re-asserting cartesianCells rather than serialize's own ordering loop.
    cells: Object.fromEntries(cartesianCells(axes).map((c) => [c.key, { min: 1 }]).reverse()),
  };
  assert.deepEqual(Object.keys(JSON.parse(serializeThresholds(doc, axes)).cells), [
    key('crewneck', 'Classic Navy', 'XS'),
    key('crewneck', 'Classic Navy', 'M'),
    key('crewneck', 'Classic Navy', '2XL'),
    key('crewneck', 'Black', 'XS'),
    key('crewneck', 'Black', 'M'),
    key('crewneck', 'Black', '2XL'),
    ...SIZES.map((s) => key('vest-womens', 'Black', s)),
  ]);
});

test('serializeThresholds keeps rows the manifest no longer declares instead of deleting them', () => {
  // Newly load-bearing under narrowing: regenerating after a colour is removed from a body's range
  // must not silently drop the rows that narrowing stranded. Only the operator removes a row.
  const axes = buildAxes({ bodies: ['vest-womens'], ranges: manifestFor({ 'vest-womens': VEST_BLACK_ONLY }).bodies });
  const stranded = key('vest-womens', 'Classic Navy', 'M');
  const doc = {
    version: 1,
    provenance: { budgets: { 'vest-womens': 1 } },
    cells: { [stranded]: { min: 2 }, ...Object.fromEntries(cartesianCells(axes).map((c) => [c.key, { min: 1 }])) },
  };
  const out = Object.keys(JSON.parse(serializeThresholds(doc, axes)).cells);
  assert.ok(out.includes(stranded), 'the stranded row survives regeneration');
  assert.equal(out.at(-1), stranded, 'and sorts after the declared cells rather than among them');
});

test('the committed thresholds.json reconciles cleanly against the committed catalogue.json', async () => {
  // The cross-artifact cohesion check the split newly makes possible: the policy file and the shape
  // file are two committed artifacts that must agree, and CI can check that without a store.
  const thresholds = await loadThresholds({ read: (p) => readFile(path.join(repoRoot, p), 'utf8') });
  const manifest = await loadCatalogue({ read: (p) => readFile(path.join(repoRoot, p), 'utf8') });
  const axes = buildAxes({ bodies: [...manifest.bodies.keys()], ranges: manifest.bodies });
  const out = reconcileThresholds(thresholds.cells, thresholds.budgets, axes);
  assert.deepEqual(out.unthresholded, [], 'every declared cell has a committed minimum');
  assert.deepEqual(out.stale, [], 'no committed minimum falls outside the declared shape');
  assert.deepEqual(out.missingBudgets, [], 'every declared body has a budget');
  assert.deepEqual(out.staleBudgets, []);
  // The demand pass reports budgetDrift unless a body's cells sum to its budget.
  for (const body of axes.bodies) {
    const sum = [...out.resolved.values()].filter((c) => c.body === body).reduce((a, c) => a + c.min, 0);
    assert.equal(sum, thresholds.budgets.get(body), `${body}: cells sum to its stated budget`);
  }
});

// --- buildPurchaseList / renderPurchaseList ----------------------------------
// The supplier-ordering view. Its whole reason to exist is the exclusion filter: a hand-built list
// off the matrix silently turns a range or a missing blank group into a buy quantity, and these
// tests are what keeps that filter from quietly loosening.

const plAxes = buildAxes({
  bodies: BODIES,
  colors: COLORS,
  sizes: SIZES,
  ranges: manifestFor({ 'vest-womens': VEST_BLACK_ONLY }).bodies,
  display: {
    body: new Map(BODIES.map((b) => [b, b])),
    color: new Map(COLORS.map((c) => [normaliseAxis(c, 'Color'), c])),
    size: new Map(SIZES.map((s) => [normaliseAxis(s, 'Size'), s])),
  },
});

/** Every declared cell at `defaultMin`, with the named cells overridden. */
function plResolved(overrides = {}, defaultMin = 0) {
  const cells = new Map();
  for (const c of cartesianCells(plAxes)) cells.set(c.key, { min: overrides[c.key] ?? defaultMin });
  return cells;
}

/**
 * One pivot carrying every case at once: short, exact, surplus, unsettled, no-group, min-0, and a
 * second and third body. Separate per-case fixtures would each be individually green while the
 * combination they are meant to model never runs.
 */
function plFixture() {
  resetSeq();
  const at = (body, color, size, quantities) =>
    quantities.map((q) => variant({ body, color, size, quantity: q }));
  const variants = [
    ...at('crewneck', 'Black', 'M', [1, 1]),
    ...at('crewneck', 'Black', 'XS', [1]),
    ...at('crewneck', 'Black', 'S', [4]),
    ...at('crewneck', 'Black', 'L', [9]),
    ...at('crewneck', 'Classic Navy', 'M', [2, 9]),
    ...at('quarter-zip', 'Black', 'XL', [0]),
    ...at('vest-womens', 'Black', 'M', [1]),
  ];
  const resolved = plResolved({
    [key('crewneck', 'Black', 'M')]: 4,
    [key('crewneck', 'Black', 'XS')]: 2,
    [key('crewneck', 'Black', 'S')]: 4,
    [key('crewneck', 'Black', 'L')]: 4,
    [key('crewneck', 'Classic Navy', 'M')]: 6,
    [key('crewneck', 'Grey Heather', 'M')]: 5,
    [key('crewneck', 'Grey Heather', 'S')]: 0,
    [key('quarter-zip', 'Black', 'XL')]: 3,
    [key('vest-womens', 'Black', 'M')]: 2,
  });
  return { pivot: buildPivot({ variants, axes: plAxes }), resolved };
}

test('a buy line is min minus on hand, and only for a settled cell that is actually short', () => {
  const { pivot, resolved } = plFixture();
  const list = buildPurchaseList(pivot, resolved);
  const crew = list.bodies.find((b) => b.body === 'crewneck');
  const black = crew.colors.find((c) => c.color === 'black');
  assert.deepEqual(
    black.rows.map((r) => [r.sizeLabel, r.buy, r.onHand, r.min]),
    [
      ['XS', 1, 1, 2],
      ['M', 3, 1, 4],
    ],
    'S sits exactly at its minimum and L is in surplus; neither is a buy line'
  );
});

test('a cell the catalogue does not make is never a buy line, whether by min 0 or by range', () => {
  const { pivot, resolved } = plFixture();
  const list = buildPurchaseList(pivot, resolved);
  const cells = list.bodies.flatMap((b) => b.colors.flatMap((c) => c.rows.map((r) => `${b.body}|${c.color}|${r.size}`)));
  assert.equal(cells.includes('crewneck|grey heather|s'), false, 'min 0 is how "we do not make this" is recorded');
  assert.equal(
    [...list.excluded.unsettled, ...list.excluded.noGroup].some((c) => c.size === 's' && c.color === 'grey heather'),
    false,
    'a min-0 cell is not something to resolve before ordering either'
  );
  assert.equal(cells.some((c) => c.startsWith('vest-womens|classic navy')), false);
  assert.equal(
    [...list.excluded.unsettled, ...list.excluded.noGroup].some((c) => c.body === 'vest-womens' && c.color !== 'black'),
    false,
    'the vest is made in Black only, so its other colours are not cells at all'
  );
});

test('an unsettled cell and a cell with no blank group are excluded, never bought from', () => {
  const { pivot, resolved } = plFixture();
  const list = buildPurchaseList(pivot, resolved);
  const bought = list.bodies.flatMap((b) => b.colors.flatMap((c) => c.rows.map((r) => `${b.body}|${c.color}|${r.size}`)));
  assert.equal(bought.includes('crewneck|classic navy|m'), false, 'a purchase quantity is never derived from a range');
  assert.equal(bought.includes('crewneck|grey heather|m'), false);

  assert.deepEqual(
    list.excluded.unsettled.map((c) => [c.key, c.low, c.high, c.min]),
    [[key('crewneck', 'Classic Navy', 'M'), 2, 9, 6]]
  );
  assert.deepEqual(
    list.excluded.noGroup.map((c) => [c.key, c.min]),
    [[key('crewneck', 'Grey Heather', 'M'), 5]]
  );
});

test('the excluded lists are ordered by the same comparators as the list itself', () => {
  // Deterministic rendering: two runs over the same store must print the same excluded block.
  resetSeq();
  const variants = [
    ...[2, 9].map((q) => variant({ body: 'quarter-zip', color: 'Grey Heather', size: 'XL', quantity: q })),
    ...[2, 9].map((q) => variant({ body: 'crewneck', color: 'Grey Heather', size: 'S', quantity: q })),
    ...[2, 9].map((q) => variant({ body: 'crewneck', color: 'Black', size: '2XL', quantity: q })),
    ...[2, 9].map((q) => variant({ body: 'crewneck', color: 'Black', size: 'S', quantity: q })),
  ];
  const resolved = plResolved(
    Object.fromEntries(
      [
        ['quarter-zip', 'Grey Heather', 'XL'],
        ['crewneck', 'Grey Heather', 'S'],
        ['crewneck', 'Black', '2XL'],
        ['crewneck', 'Black', 'S'],
      ].map((k) => [key(...k), 20])
    )
  );
  const list = buildPurchaseList(buildPivot({ variants, axes: plAxes }), resolved);
  assert.deepEqual(
    list.excluded.unsettled.map((c) => c.key),
    [
      key('crewneck', 'Black', 'S'),
      key('crewneck', 'Black', '2XL'),
      key('crewneck', 'Grey Heather', 'S'),
      key('quarter-zip', 'Grey Heather', 'XL'),
    ],
    'body, then colour label, then garment size order'
  );
});

test('bodies, colours and sizes come out in one deterministic order', () => {
  const { pivot, resolved } = plFixture();
  const list = buildPurchaseList(pivot, resolved);
  assert.deepEqual(list.bodies.map((b) => b.body), ['crewneck', 'quarter-zip', 'vest-womens']);

  resetSeq();
  const everyColor = COLORS.map((color) => variant({ body: 'crewneck', color, size: 'M', quantity: 1 }));
  const mins = plResolved(Object.fromEntries(COLORS.map((c) => [key('crewneck', c, 'M'), 4])));
  const colored = buildPurchaseList(buildPivot({ variants: everyColor, axes: plAxes }), mins);
  assert.deepEqual(
    colored.bodies[0].colors.map((c) => c.colorLabel),
    ['Black', 'Classic Navy', 'Grey Heather'],
    'sorted by display label, not by the manifest declaration order (Black, Grey Heather, Classic Navy)'
  );

  resetSeq();
  const everySize = SIZES.map((size) => variant({ body: 'crewneck', color: 'Black', size, quantity: 1 }));
  const sizeMins = plResolved(Object.fromEntries(SIZES.map((s) => [key('crewneck', 'Black', s), 4])));
  const sized = buildPurchaseList(buildPivot({ variants: everySize, axes: plAxes }), sizeMins);
  assert.deepEqual(sized.bodies[0].colors[0].rows.map((r) => r.sizeLabel), SIZES, 'garment order, not lexicographic');
});

test('per-colour, per-body and grand totals are the sums of the lines under them', () => {
  const { pivot, resolved } = plFixture();
  const list = buildPurchaseList(pivot, resolved);
  for (const body of list.bodies) {
    for (const color of body.colors) {
      assert.equal(color.units, color.rows.reduce((n, r) => n + r.buy, 0), `${body.body}/${color.color}`);
    }
    assert.equal(body.units, body.colors.reduce((n, c) => n + c.units, 0), body.body);
  }
  assert.equal(list.totalUnits, list.bodies.reduce((n, b) => n + b.units, 0));
  assert.equal(list.totalUnits, 4 + 3 + 1, 'crewneck 4, quarter-zip 3, vest 1');
});

test('an oversold cell buys back the oversell as well as the minimum', () => {
  // Unclamped, mirroring flagReorders: Shopify permits a negative quantity, and clamping would
  // under-order exactly the cell that is furthest behind.
  resetSeq();
  const pivot = buildPivot({ variants: [variant({ body: 'crewneck', color: 'Black', size: 'M', quantity: -2 })], axes: plAxes });
  const list = buildPurchaseList(pivot, plResolved({ [key('crewneck', 'Black', 'M')]: 4 }));
  assert.deepEqual(list.bodies[0].colors[0].rows, [{ size: 'm', sizeLabel: 'M', buy: 6, onHand: -2, min: 4 }]);
});

test('--body narrows the buy lines AND the excluded cells together', () => {
  // An operator who asked about one garment must not be handed warnings about the others.
  const { pivot, resolved } = plFixture();
  const list = buildPurchaseList(pivot, resolved, { body: 'quarter-zip' });
  assert.deepEqual(list.bodies.map((b) => b.body), ['quarter-zip']);
  assert.equal(list.totalUnits, 3);
  assert.deepEqual(list.excluded.unsettled, []);
  assert.deepEqual(list.excluded.noGroup, [], 'the crewneck cells with no group belong to a body the operator did not ask about');
});

test('nothing short yields an empty list rather than a zeroed one', () => {
  const list = buildPurchaseList(buildPivot({ variants: [], axes: plAxes }), plResolved());
  assert.deepEqual(list.bodies, []);
  assert.equal(list.totalUnits, 0);
  assert.deepEqual(list.excluded, { unsettled: [], noGroup: [] });
});

test('renderPurchaseList prints the header, the excluded block before the total, and the guardrail', () => {
  const { pivot, resolved } = plFixture();
  const text = renderPurchaseList(buildPurchaseList(pivot, resolved));
  const lines = text.split('\n');
  assert.equal(lines[0], 'PURCHASE LIST  (units to reach minimum)');
  assert.equal(lines[1], '='.repeat(lines[0].length));
  assert.match(text, /^ {6}size {4}buy {3}have {3}min$/m);
  assert.match(text, /^ {6}M {9}3 {6}1 {5}4$/m);
  assert.match(text, /^ {2}crewneck total: 4 units$/m);

  const excludedAt = lines.findIndex((l) => l.startsWith('Excluded: '));
  const totalAt = lines.findIndex((l) => l.startsWith('TOTAL: '));
  assert.ok(excludedAt !== -1 && totalAt !== -1 && excludedAt < totalAt, 'the excluded block sits above the number the eye stops on');
  assert.match(lines[excludedAt], /^Excluded: 2 cell\(s\) \(not settled \/ no group\); resolve before ordering those$/);
  assert.match(text, /crewneck \/ Classic Navy \/ M: not settled \(2-9 on hand, min 6\)/);
  assert.match(text, /crewneck \/ Grey Heather \/ M: no blank group \(min 5\); see "audit"/);
  assert.equal(lines[totalAt], 'TOTAL: 8 units');
  assert.match(text, /Each body is a different physical garment; totals never combine across bodies\./);
  assert.match(text, /Purchasing aid only\. Never enter these numbers into a count sheet or inventory write\./);
});

test('renderPurchaseList says so when nothing is short, and when nothing was excluded', () => {
  const text = renderPurchaseList(buildPurchaseList(buildPivot({ variants: [], axes: plAxes }), plResolved()));
  assert.match(text, /^No sizes below minimum\.$/m, 'a bare zero total would read as a failed run');
  assert.match(text, /^Excluded: none$/m, 'always printed: an absent section cannot be told from an unchecked one');
  assert.match(text, /^TOTAL: 0 units$/m);
});

test('a min-0 cell whose group has NOT settled is dropped by the min gate, not by its state', () => {
  // The one case the shared fixture structurally cannot distinguish: its min-0 cell has no variants,
  // so it is NO_GROUP regardless of the gate. Give the cell a real member range and the gate is the
  // only thing standing between it and excluded.unsettled, which is what the docblock claims.
  resetSeq();
  const variants = [2, 9].map((q) => variant({ body: 'crewneck', color: 'Black', size: 'M', quantity: q }));
  const list = buildPurchaseList(buildPivot({ variants, axes: plAxes }), plResolved({ [key('crewneck', 'Black', 'M')]: 0 }));
  assert.deepEqual(list.bodies, [], 'a combination the catalogue does not make is never bought');
  assert.deepEqual(list.excluded.unsettled, [], 'nor is it something to resolve before ordering');
  assert.deepEqual(list.excluded.noGroup, []);
});

test('the min gate makes this view narrower than pivotCounts, on purpose', () => {
  // pivotCounts counts every unsettled cell because its job is to stop a terse matrix from hiding
  // one. The purchase list counts only cells that could ever be bought. The two numbers differ, and
  // that difference is a design decision rather than a drift between two counters.
  resetSeq();
  const variants = [2, 9].map((q) => variant({ body: 'crewneck', color: 'Black', size: 'M', quantity: q }));
  const pivot = buildPivot({ variants, axes: plAxes });
  const resolved = plResolved({ [key('crewneck', 'Black', 'M')]: 0 });
  assert.equal(pivotCounts(pivot, resolved).unsettled, 1);
  assert.equal(buildPurchaseList(pivot, resolved).excluded.unsettled.length, 0);
});

test('the no-group excluded list is sorted by the same comparators as the unsettled one', () => {
  // Shared code, but a copy-paste that sorted one array on `color` and the other on `colorLabel`
  // would only show up with more than one entry in each.
  const cells = [
    ['quarter-zip', 'Grey Heather', 'XL'],
    ['crewneck', 'Grey Heather', 'S'],
    ['crewneck', 'Black', '2XL'],
    ['crewneck', 'Black', 'S'],
  ];
  const resolved = plResolved(Object.fromEntries(cells.map((c) => [key(...c), 4])));
  const list = buildPurchaseList(buildPivot({ variants: [], axes: plAxes }), resolved);
  assert.deepEqual(
    list.excluded.noGroup.map((c) => c.key),
    [
      key('crewneck', 'Black', 'S'),
      key('crewneck', 'Black', '2XL'),
      key('crewneck', 'Grey Heather', 'S'),
      key('quarter-zip', 'Grey Heather', 'XL'),
    ]
  );
  assert.deepEqual(list.excluded.unsettled, [], 'nothing carries these cells at all');
});

test('--body narrowed to a garment with nothing short yields an empty list, not a leak', () => {
  const { pivot, resolved } = plFixture();
  const list = buildPurchaseList(pivot, resolved, { body: 'vest-womens' });
  assert.deepEqual(list.bodies.map((b) => b.body), ['vest-womens']);
  assert.deepEqual(list.excluded, { unsettled: [], noGroup: [] }, 'the crewneck exclusions belong to another body');

  const none = buildPurchaseList(buildPivot({ variants: [], axes: plAxes }), plResolved(), { body: 'quarter-zip' });
  assert.deepEqual(none.bodies, []);
  assert.equal(none.totalUnits, 0);
});

test('renderPurchaseList renders every body and every colour, not just the first of each', () => {
  // A dropped separator, a mis-indented second colour block, or a missing per-body total after the
  // first body would all pass a render test that only ever looked at the top section.
  resetSeq();
  const variants = [
    variant({ body: 'crewneck', color: 'Black', size: 'M', quantity: 1 }),
    variant({ body: 'crewneck', color: 'Classic Navy', size: 'L', quantity: 0 }),
    variant({ body: 'quarter-zip', color: 'Black', size: 'S', quantity: 1 }),
  ];
  const resolved = plResolved({
    [key('crewneck', 'Black', 'M')]: 4,
    [key('crewneck', 'Classic Navy', 'L')]: 2,
    [key('quarter-zip', 'Black', 'S')]: 3,
  });
  const text = renderPurchaseList(buildPurchaseList(buildPivot({ variants, axes: plAxes }), resolved));

  assert.deepEqual(
    text.split('\n').filter((l) => l.endsWith(' units)') || / total: /.test(l)),
    [
      '  Black   (3 units)',
      '  Classic Navy   (2 units)',
      '  crewneck total: 5 units',
      '  Black   (2 units)',
      '  quarter-zip total: 2 units',
    ],
    'two colours under one body, and a total under each body'
  );
  assert.match(text, /^crewneck\n={8}$/m);
  assert.match(text, /^quarter-zip\n={11}$/m);
  assert.match(text, /  crewneck total: 5 units\n\nquarter-zip/, 'bodies stay separated by a blank line');
});

test('an unsettled cell is named only when the unknown reading could change the order', () => {
  // A range that straddles or falls under the minimum is genuinely ambiguous. A range whose LOWEST
  // member already meets the minimum buys nothing whichever reading is true, so sending the operator
  // to recount it is the same crying-wolf that flagReorders refuses.
  resetSeq();
  const at = (size, quantities) => quantities.map((q) => variant({ body: 'crewneck', color: 'Black', size, quantity: q }));
  const variants = [...at('M', [8, 9]), ...at('L', [3, 9]), ...at('XL', [1, 2])];
  const resolved = plResolved({
    [key('crewneck', 'Black', 'M')]: 4,
    [key('crewneck', 'Black', 'L')]: 4,
    [key('crewneck', 'Black', 'XL')]: 4,
  });
  const list = buildPurchaseList(buildPivot({ variants, axes: plAxes }), resolved);

  assert.deepEqual(
    list.excluded.unsettled.map((c) => [c.size, c.low, c.high]),
    [
      ['l', 3, 9],
      ['xl', 1, 2],
    ],
    'M is 8-9 against a minimum of 4: no reading in that range is short, so there is nothing to resolve'
  );
  assert.deepEqual(list.bodies, [], 'and none of the three becomes a buy line either');
});
