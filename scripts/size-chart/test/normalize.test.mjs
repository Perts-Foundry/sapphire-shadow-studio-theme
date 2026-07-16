import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cell, cmTenths, formatCm, deriveRows } from '../lib/normalize.mjs';

test('cell reproduces the seed dual-unit strings', () => {
  assert.equal(cell(38.5), '38.5" / 97.8 cm');
  assert.equal(cell(19.25), '19.25" / 48.9 cm');
  assert.equal(cell(22), '22" / 55.9 cm');
});

test('trailing .0 is stripped from whole-centimetre values', () => {
  // 24" x 2.54 = 60.96 -> 61.0 cm -> "61 cm", not "61.0 cm"
  assert.equal(cell(24), '24" / 61 cm');
});

test('centimetre ties round up (away from zero)', () => {
  // 27.5" x 2.54 = 69.85 -> 69.9 cm (half-even would give 69.8)
  assert.equal(cell(27.5), '27.5" / 69.9 cm');
});

test('laid-flat cm is derived independently, not halved from rounded circumference cm', () => {
  // circumference 43.5" -> 110.5 cm; laid-flat 21.75" -> 55.2 cm (half of 110.5 is 55.25)
  assert.equal(cell(43.5), '43.5" / 110.5 cm');
  assert.equal(cell(21.75), '21.75" / 55.2 cm');
});

test('cmTenths and formatCm building blocks', () => {
  assert.equal(cmTenths(24), 610);
  assert.equal(formatCm(610), '61');
  assert.equal(formatCm(978), '97.8');
});

test('deriveRows computes every column for one size', () => {
  const profile = {
    sizes: ['XS'],
    measurements: {
      chest_circumference: [38],
      body_length: [25],
      sleeve_length: [34],
    },
  };
  assert.deepEqual(deriveRows(profile)[0], {
    size: 'XS',
    chest_circumference: '38" / 96.5 cm',
    chest_laid_flat: '19" / 48.3 cm',
    body_length: '25" / 63.5 cm',
    sleeve_length: '34" / 86.4 cm',
  });
});
