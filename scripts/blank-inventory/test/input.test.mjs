import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInput,
  resolveLayout,
  crossCheckMode,
  parseValue,
  isSigned,
  parseCsvLine,
  MODE_ABSOLUTE,
  MODE_DELTA,
  UNREADABLE,
  FORMAT_BLANK,
  FORMAT_BCS,
} from '../lib/input.mjs';

/** The canonical layout, with its header row. */
const H = 'body,color,size,value';
const bcs = (...rows) => [H, ...rows].join('\n');

test('mode is required and has no default', () => {
  assert.throws(() => parseInput(bcs('crewneck,Black,M,4'), { mode: undefined }), /--mode must be one of/);
  assert.throws(() => parseInput(bcs('crewneck,Black,M,4'), { mode: 'guess' }), /--mode must be one of/);
});

// --- layout, which is declared and never inferred ---------------------------

test('a shape is NEVER inferred from the column count', () => {
  // The original bug: three cells silently meant "color,size,value", so there was nowhere to put
  // the body and a mis-shaped row read as a different valid shape instead of being refused.
  assert.throws(() => parseInput('Black,M,14', { mode: MODE_ABSOLUTE }), /no recognisable header row/);
});

test('an explicit --format parses a headerless file', () => {
  const { rows, format } = parseInput('crewneck,Black,M,14', { mode: MODE_ABSOLUTE, format: FORMAT_BCS });
  assert.equal(format, FORMAT_BCS);
  assert.equal(rows[0].body, 'crewneck');
});

test('a header row and a contradicting --format stop the run rather than one winning', () => {
  assert.throws(
    () => parseInput(bcs('crewneck,Black,M,14'), { mode: MODE_ABSOLUTE, format: FORMAT_BLANK }),
    /declared but the header row describes/
  );
});

test('a header missing a required column is refused', () => {
  assert.throws(() => parseInput('color,size,value\nBlack,M,14', { mode: MODE_ABSOLUTE }), /missing required column\(s\): body/);
});

test('resolveLayout accepts colour and blank_id spellings', () => {
  assert.equal(resolveLayout(parseCsvLine('body,colour,size,qty'), undefined).format, FORMAT_BCS);
  assert.equal(resolveLayout(parseCsvLine('blank_id,count'), undefined).format, FORMAT_BLANK);
});

test('the optional raw column carries the token as written', () => {
  // This is what lets the confirmation table be generated FROM the file rather than re-rendered.
  const { rows } = parseInput('body,color,size,value,raw\ncrewneck,Black,M,14,"14 (smudged)"', { mode: MODE_ABSOLUTE });
  assert.equal(rows[0].asWritten, '14 (smudged)');
  assert.equal(rows[0].value, 14);
});

test('raw is optional, and absent means null rather than undefined', () => {
  const { rows } = parseInput(bcs('crewneck,Black,M,14'), { mode: MODE_ABSOLUTE });
  assert.equal(rows[0].asWritten, null);
});

test('an empty axis cell is refused rather than defaulted', () => {
  assert.throws(() => parseInput(bcs(',Black,M,14'), { mode: MODE_ABSOLUTE }), /body is empty/);
});

test('an empty VALUE cell is refused, never coerced to zero', () => {
  // "blank cell means zero" is a transcription-layer convention applied upstream, NOT a parser
  // behaviour. If the parser silently read an empty value as 0, a stray empty cell in a CSV would
  // zero a live group and the suite would stay green. Pin that the parser refuses it instead.
  assert.throws(() => parseInput(bcs('crewneck,Black,M,'), { mode: MODE_ABSOLUTE }), /[Ee]mpty value cell/);
});

// --- values and modes -------------------------------------------------------

test('absolute mode parses body,color,size,value rows', () => {
  const { rows } = parseInput(bcs('crewneck,Black,M,14', 'vest-womens,Grey Heather,2XL,3'), { mode: MODE_ABSOLUTE });
  assert.equal(rows.length, 2);
  assert.deepEqual(
    { body: rows[0].body, color: rows[0].color, size: rows[0].size, value: rows[0].value },
    { body: 'crewneck', color: 'Black', size: 'M', value: 14 }
  );
});

test('absolute mode parses blank,value rows', () => {
  const { rows } = parseInput('blank,value\nBLACK_ACME_BLANKA_0001_M,14', { mode: MODE_ABSOLUTE });
  assert.equal(rows[0].blankId, 'BLACK_ACME_BLANKA_0001_M');
  assert.equal(rows[0].value, 14);
});

test('one body+colour+size differing only by body is NOT a duplicate', () => {
  // Under the old colour+size key these two rows collided, which is the whole defect.
  const { rows } = parseInput(bcs('crewneck,Black,M,14', 'quarter-zip,Black,M,9'), { mode: MODE_ABSOLUTE });
  assert.deepEqual(rows.map((r) => r.value), [14, 9]);
});

test('delta mode requires an explicit sign', () => {
  const { rows } = parseInput(bcs('crewneck,Black,M,+12', 'crewneck,Black,L,-3'), { mode: MODE_DELTA });
  assert.deepEqual(rows.map((r) => r.value), [12, -3]);
});

test('an UNSIGNED value under --mode delta is refused, never assumed positive', () => {
  // "12" meaning "+12" and "12" meaning "set to 12" are the same characters, opposite outcomes.
  assert.throws(() => parseInput(bcs('crewneck,Black,M,12'), { mode: MODE_DELTA }), /unsigned under --mode delta/);
});

test('a SIGNED value under --mode absolute is refused', () => {
  assert.throws(() => parseInput(bcs('crewneck,Black,M,+12'), { mode: MODE_ABSOLUTE }), /signed under --mode absolute/);
});

test('a negative absolute quantity is refused', () => {
  assert.throws(() => parseInput(bcs('crewneck,Black,M,-4'), { mode: MODE_ABSOLUTE }), /signed under --mode absolute|cannot be negative/);
});

test('a duplicate key is refused rather than summed or last-wins', () => {
  assert.throws(() => parseInput(bcs('crewneck,Black,M,14', 'crewneck,Black,M,9'), { mode: MODE_ABSOLUTE }), /duplicate entry/i);
});

test('a duplicate is detected on the blank,value shape too', () => {
  assert.throws(
    () => parseInput('blank,value\nBLACK_ACME_BLANKA_0001_M,14\nBLACK_ACME_BLANKA_0001_M,9', { mode: MODE_ABSOLUTE }),
    /duplicate entry/i
  );
});

test('an UNREADABLE cell blocks its row and is never guessed', () => {
  assert.throws(() => parseInput(bcs(`crewneck,Black,M,${UNREADABLE}`), { mode: MODE_ABSOLUTE }), /illegible cell blocks its row/);
});

test('a non-numeric value is refused', () => {
  assert.throws(() => parseInput(bcs('crewneck,Black,M,about ten'), { mode: MODE_ABSOLUTE }), /not a whole number/);
});

test('header rows are detected and skipped, and line numbers stay accurate', () => {
  const { rows, headers } = parseInput('body,color,size,count\ncrewneck,Black,M,14', { mode: MODE_ABSOLUTE });
  assert.deepEqual(headers, ['body', 'color', 'size', 'count']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].line, 2);
});

test('comments and blank lines are ignored', () => {
  const { rows } = parseInput('# counted 2026-07-19\n\nbody,color,size,value\ncrewneck,Black,M,14\n', { mode: MODE_ABSOLUTE });
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
  assert.throws(
    () => parseInput(bcs('crewneck,Black,M,14', 'crewneck,Black,L,+3'), { mode: MODE_ABSOLUTE }),
    /signed under --mode absolute/
  );
});

test('parseValue and isSigned handle whitespace inside a signed token', () => {
  assert.equal(isSigned('+ 12'), true);
  assert.deepEqual(parseValue('+ 12'), { value: 12, signed: true });
});
