import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInput, crossCheckMode, parseValue, isSigned, MODE_ABSOLUTE, MODE_DELTA, UNREADABLE } from '../lib/input.mjs';

test('mode is required and has no default', () => {
  assert.throws(() => parseInput('Black,M,4', { mode: undefined }), /--mode must be one of/);
  assert.throws(() => parseInput('Black,M,4', { mode: 'guess' }), /--mode must be one of/);
});

test('absolute mode parses color,size,value rows', () => {
  const { rows } = parseInput('Black,M,14\nGrey Heather,2XL,3', { mode: MODE_ABSOLUTE });
  assert.equal(rows.length, 2);
  assert.deepEqual({ color: rows[0].color, size: rows[0].size, value: rows[0].value }, { color: 'Black', size: 'M', value: 14 });
});

test('absolute mode parses blank,value rows', () => {
  const { rows } = parseInput('BLACK_ACME_FLEECE_0001_M,14', { mode: MODE_ABSOLUTE });
  assert.equal(rows[0].blankId, 'BLACK_ACME_FLEECE_0001_M');
  assert.equal(rows[0].value, 14);
});

test('delta mode requires an explicit sign', () => {
  const { rows } = parseInput('Black,M,+12\nBlack,L,-3', { mode: MODE_DELTA });
  assert.deepEqual(rows.map((r) => r.value), [12, -3]);
});

test('an UNSIGNED value under --mode delta is refused, never assumed positive', () => {
  // "12" meaning "+12" and "12" meaning "set to 12" are the same characters, opposite outcomes.
  assert.throws(() => parseInput('Black,M,12', { mode: MODE_DELTA }), /unsigned under --mode delta/);
});

test('a SIGNED value under --mode absolute is refused', () => {
  assert.throws(() => parseInput('Black,M,+12', { mode: MODE_ABSOLUTE }), /signed under --mode absolute/);
});

test('a negative absolute quantity is refused', () => {
  assert.throws(() => parseInput('Black,M,-4', { mode: MODE_ABSOLUTE }), /signed under --mode absolute|cannot be negative/);
});

test('a duplicate blank is refused rather than summed or last-wins', () => {
  assert.throws(() => parseInput('Black,M,14\nBlack,M,9', { mode: MODE_ABSOLUTE }), /duplicate entry/i);
});

test('a duplicate is detected on the blank,value shape too', () => {
  assert.throws(
    () => parseInput('BLACK_ACME_FLEECE_0001_M,14\nBLACK_ACME_FLEECE_0001_M,9', { mode: MODE_ABSOLUTE }),
    /duplicate entry/i
  );
});

test('an UNREADABLE cell blocks its row and is never guessed', () => {
  assert.throws(() => parseInput(`Black,M,${UNREADABLE}`, { mode: MODE_ABSOLUTE }), /illegible cell blocks its row/);
});

test('a non-numeric value is refused', () => {
  assert.throws(() => parseInput('Black,M,about ten', { mode: MODE_ABSOLUTE }), /not a whole number/);
});

test('header rows are detected and skipped, and line numbers stay accurate', () => {
  const { rows, headers } = parseInput('color,size,count\nBlack,M,14', { mode: MODE_ABSOLUTE });
  assert.deepEqual(headers, ['color', 'size', 'count']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].line, 2);
});

test('comments and blank lines are ignored', () => {
  const { rows } = parseInput('# counted 2026-07-19\n\nBlack,M,14\n', { mode: MODE_ABSOLUTE });
  assert.equal(rows.length, 1);
});

// --- mode cross-check, table driven -----------------------------------------
// The positives must stop the run. The negatives must NOT false-stop, which matters just as much:
// a check that fires on clean input trains the operator to bypass it.

const CONTRADICTIONS = [
  ['signed values under absolute', { rawValues: ['+12', '-3'] }, MODE_ABSOLUTE],
  ['a "received" heading under absolute', { headers: ['color', 'size', 'received'] }, MODE_ABSOLUTE],
  ['an "added" heading under absolute', { headers: ['color', 'size', 'added'] }, MODE_ABSOLUTE],
  ['an "adjustment" heading under absolute', { headers: ['color', 'size', 'adjustment'] }, MODE_ABSOLUTE],
  ['an arrow glyph under absolute', { text: 'Black M → 12' }, MODE_ABSOLUTE],
  ['an ASCII arrow under absolute', { text: 'Black M -> 12' }, MODE_ABSOLUTE],
  ['a "count" heading under delta', { headers: ['color', 'size', 'count'] }, MODE_DELTA],
  ['an "on hand" heading under delta', { headers: ['color', 'size', 'on hand'] }, MODE_DELTA],
  ['an "in stock" heading under delta', { headers: ['color', 'size', 'in stock'] }, MODE_DELTA],
];

for (const [label, source, mode] of CONTRADICTIONS) {
  test(`cross-check STOPS on ${label}`, () => {
    const { ok, problems } = crossCheckMode(source, mode);
    assert.equal(ok, false, `expected a stop for ${label}`);
    assert.ok(problems.length > 0);
  });
}

const CLEAN = [
  ['plain counts under absolute', { headers: ['color', 'size', 'count'], rawValues: ['14', '3'] }, MODE_ABSOLUTE],
  ['bare rows under absolute', { rawValues: ['14', '3'] }, MODE_ABSOLUTE],
  ['signed values under delta', { headers: ['color', 'size', 'received'], rawValues: ['+12', '-3'] }, MODE_DELTA],
  ['bare signed rows under delta', { rawValues: ['+12'] }, MODE_DELTA],
];

for (const [label, source, mode] of CLEAN) {
  test(`cross-check does NOT false-stop on ${label}`, () => {
    const { ok, problems } = crossCheckMode(source, mode);
    assert.equal(ok, true, `unexpected stop: ${problems.join('; ')}`);
  });
}

test('cross-check stops on an AMBIGUOUS source carrying both signal families', () => {
  // Bias to stop: a sheet that looks like both is never resolved by guessing.
  const { ok, problems } = crossCheckMode(
    { headers: ['color', 'size', 'on hand', 'received'], rawValues: ['+12'] },
    MODE_DELTA
  );
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /BOTH/.test(p)));
});

test('a contradiction stops the whole run, not just the offending row', () => {
  // One clean row plus one signed row under absolute: the entire parse throws.
  assert.throws(() => parseInput('Black,M,14\nBlack,L,+3', { mode: MODE_ABSOLUTE }), /signed under --mode absolute/);
});

test('parseValue and isSigned handle whitespace inside a signed token', () => {
  assert.equal(isSigned('+ 12'), true);
  assert.deepEqual(parseValue('+ 12'), { value: 12, signed: true });
});
