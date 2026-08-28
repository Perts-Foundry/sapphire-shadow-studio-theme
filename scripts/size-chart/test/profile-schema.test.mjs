import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProfile } from '../lib/profile-schema.mjs';
import { resolvedProfile } from './profile-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = resolvedProfile('crewneck-fleece');
const clone = (o) => JSON.parse(JSON.stringify(o));

// Index of the seed's columns for targeted mutation.
const COL = { size: 0, laidFlat: 1, circ: 2, body: 3, sleeve: 4 };

test('accepts the seed profile', () => {
  assert.equal(validateProfile(SEED), true);
});

test('rejects a non-object profile', () => {
  assert.throws(() => validateProfile(null), /must be an object/);
  assert.throws(() => validateProfile([]), /must be an object/);
});

test('rejects an unknown top-level key', () => {
  const p = clone(SEED); p.foo = 1;
  assert.throws(() => validateProfile(p), /unknown key 'foo'/);
});

test('rejects a non-kebab blank_id', () => {
  const p = clone(SEED); p.blank_id = 'Crew Neck';
  assert.throws(() => validateProfile(p), /kebab/);
});

test('rejects unit other than inches', () => {
  const p = clone(SEED); p.unit = 'cm';
  assert.throws(() => validateProfile(p), /unit must be/);
});

test('rejects an unknown garment', () => {
  const p = clone(SEED); p.garment = 'trousers';
  assert.throws(() => validateProfile(p), /is not one of/);
});

test('rejects a canvas_height out of range', () => {
  const p = clone(SEED); p.canvas_height = 200;
  assert.throws(() => validateProfile(p), /canvas_height/);
});

test('rejects more than six sizes', () => {
  const p = clone(SEED); p.sizes = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];
  assert.throws(() => validateProfile(p), /exceeds the 6/);
});

test('rejects a handle that could traverse out of templates/', () => {
  const p = clone(SEED); p.handles = ['../../evil'];
  assert.throws(() => validateProfile(p), /kebab-case/);
});

test('rejects a measure column whose length does not match sizes', () => {
  const p = clone(SEED); p.columns[COL.circ].values.pop();
  assert.throws(() => validateProfile(p), /!= sizes length/);
});

test('rejects a non-monotonic measure column (transcription swap)', () => {
  const p = clone(SEED); p.columns[COL.circ].values[2] = 30;
  assert.throws(() => validateProfile(p), /decreases/);
});

test('rejects an out-of-range measure value (units error)', () => {
  const p = clone(SEED); p.columns[COL.circ].values = [5, 6, 7, 8, 9, 10];
  assert.throws(() => validateProfile(p), /outside sane range/);
});

test('rejects a non-numeric measure cell', () => {
  const p = clone(SEED); p.columns[COL.sleeve].values[0] = '22';
  assert.throws(() => validateProfile(p), /positive number/);
});

test('rejects an unknown column role', () => {
  const p = clone(SEED); p.columns[COL.body].role = 'inseam_x';
  assert.throws(() => validateProfile(p), /not a known role/);
});

test('rejects a duplicated role', () => {
  const p = clone(SEED); p.columns[COL.body].role = 'chest_circumference';
  assert.throws(() => validateProfile(p), /duplicated/);
});

test('rejects a duplicated badge', () => {
  const p = clone(SEED); p.columns[COL.body].badge = 'A';
  assert.throws(() => validateProfile(p), /badge 'A' is duplicated/);
});

test('rejects a badge with no how text', () => {
  const p = clone(SEED); p.columns[COL.circ].badge = 'D';
  assert.throws(() => validateProfile(p), /no 'how' text/);
});

test('rejects a derive.from that matches no column role', () => {
  const p = clone(SEED); p.columns[COL.laidFlat].derive.from = 'bust';
  assert.throws(() => validateProfile(p), /does not match any column role/);
});

// A synthetic vest-style profile exercising string + range column kinds and a doubled derive.
const RANGED = {
  blank_id: 'test-vest',
  display_name: 'Test Vest',
  unit: 'in',
  garment: 'vest',
  body: 'vest-womens',
  garment_noun: 'vest',
  sizes: ['XS', 'S'],
  columns: [
    { role: 'size', heading: 'Size', kind: 'label' },
    { role: 'size_numeric', heading: 'US Size', kind: 'string', values: ['2', '4/6'] },
    { role: 'chest_laid_flat', heading: 'Chest', kind: 'measure', values: [18.5, 20], badge: 'A', how: 'x', explain: 'is measured across the front.', decides_size: true },
    { role: 'body_chest_range', heading: 'To Fit', kind: 'range', values: [[32, 34], [35, 37]] },
  ],
};

test('accepts a profile with string + range columns', () => {
  assert.equal(validateProfile(RANGED), true);
});

test('rejects a range cell with lo greater than hi', () => {
  const p = clone(RANGED); p.columns[3].values[0] = [36, 34];
  assert.throws(() => validateProfile(p), /lo > hi/);
});

test('rejects a profile with no size column', () => {
  const p = clone(SEED); p.columns = p.columns.filter((c) => c.role !== 'size');
  assert.throws(() => validateProfile(p), /first column must have role 'size'/);
});

test('rejects a size column not at index 0', () => {
  const p = clone(SEED); const s = p.columns.shift(); p.columns.splice(1, 0, s);
  assert.throws(() => validateProfile(p), /first column must have role 'size'/);
});

test('rejects a badge on an anchor the garment does not expose', () => {
  // front_zipper -> zipper anchor, which the crewneck garment does not draw.
  const p = clone(SEED);
  p.columns.push({ role: 'front_zipper', heading: 'Zip', kind: 'measure', values: [8, 8, 8, 8, 8, 8.5], badge: 'D', how: 'x' });
  assert.throws(() => validateProfile(p), /does not have/);
});

test('rejects two badges colliding on the same anchor', () => {
  // chest_circumference -> chest, same anchor as chest_laid_flat (badge A).
  const p = clone(SEED); p.columns[COL.circ].badge = 'E'; p.columns[COL.circ].how = 'x';
  assert.throws(() => validateProfile(p), /both badge the 'chest' anchor/);
});

test('rejects a badge on a role with no diagram anchor', () => {
  const p = clone(RANGED); p.columns[3].badge = 'C'; p.columns[3].how = 'x'; // body_chest_range has no anchor
  assert.throws(() => validateProfile(p), /no diagram anchor/);
});

test('rejects a range column whose hi bound decreases', () => {
  const p = clone(RANGED); p.columns[3].values = [[32, 40], [35, 38]];
  assert.throws(() => validateProfile(p), /'hi' decreases/);
});

test('rejects a derived column whose factor pushes it out of range', () => {
  const p = clone(SEED); p.columns[COL.laidFlat].derive.factor = 0.05;
  assert.throws(() => validateProfile(p), /derived value .* outside sane range/);
});

// ── garment_noun ──────────────────────────────────────────────────────────────
// Substituted mid-sentence into copy.md's shared prose and rendered on a public storefront page.

test('rejects a missing garment_noun', () => {
  const p = clone(SEED); delete p.garment_noun;
  assert.throws(() => validateProfile(p), /garment_noun must be a non-empty string/);
});

test('rejects a garment_noun containing a digit (a supplier SKU shape)', () => {
  // The charset is the mechanical backstop for the provenance gate in SKILL.md: a spec-sourced
  // "qz-4050" or "st254" must never reach shopper-facing copy.
  for (const bad of ['qz-4050', 'st254', 'f280 fleece']) {
    const p = clone(SEED); p.garment_noun = bad;
    assert.throws(() => validateProfile(p), /lowercase noun phrase/, `expected ${bad} to be rejected`);
  }
});

test('rejects a capitalised garment_noun (tokens are sentence-medial)', () => {
  const p = clone(SEED); p.garment_noun = 'Sweatshirt';
  assert.throws(() => validateProfile(p), /lowercase noun phrase/);
});

test('accepts a hyphenated garment_noun', () => {
  const p = clone(SEED); p.garment_noun = 'quarter-zip';
  assert.equal(validateProfile(p), true);
});

// ── explain ───────────────────────────────────────────────────────────────────
// Operator-authored prose that lands inside the accordion's rich-text HTML.

test('rejects explain containing HTML or token syntax', () => {
  // `{`/`}` are rejected so a profile cannot smuggle a token into the shared copy pipeline.
  for (const bad of ['is <b>bold</b>', 'is a & b', 'is {{garment_noun}}']) {
    const p = clone(SEED); p.columns[COL.body].explain = bad;
    assert.throws(() => validateProfile(p), /plain prose/, `expected ${bad} to be rejected`);
  }
});

test('rejects explain containing an em dash', () => {
  const p = clone(SEED); p.columns[COL.body].explain = `is measured ${String.fromCharCode(0x2014)} like so`;
  assert.throws(() => validateProfile(p), /em dash/);
});

test('rejects an over-length explain', () => {
  const p = clone(SEED); p.columns[COL.body].explain = `is ${'x'.repeat(400)}`;
  assert.throws(() => validateProfile(p), /max 400/);
});

// ── decides_size ──────────────────────────────────────────────────────────────
// A merchandising claim, not a measurement fact: it renders into "choose your size by X" copy.

test('rejects zero columns deciding the size', () => {
  const p = clone(SEED); delete p.columns[COL.laidFlat].decides_size;
  assert.throws(() => validateProfile(p), /exactly one column must set decides_size: true \(found 0\)/);
});

test('rejects two columns deciding the size', () => {
  const p = clone(SEED);
  p.columns[COL.body].decides_size = true;
  assert.throws(() => validateProfile(p), /exactly one column must set decides_size: true \(found 2\)/);
});

test('rejects a non-boolean decides_size', () => {
  const p = clone(SEED); p.columns[COL.body].decides_size = 'yes';
  assert.throws(() => validateProfile(p), /decides_size must be a boolean/);
});

test('rejects a deciding column with no explain', () => {
  // It is what {{deciding_label}} names, so it always owes the shopper a definition.
  const p = clone(SEED); delete p.columns[COL.laidFlat].explain;
  assert.throws(() => validateProfile(p), /decides the size but has no 'explain'/);
});

test('rejects an unknown column key (the allowlist still bites after widening)', () => {
  const p = clone(SEED); p.columns[COL.body].explaination = 'typo';
  assert.throws(() => validateProfile(p), /unknown key 'explaination'/);
});
