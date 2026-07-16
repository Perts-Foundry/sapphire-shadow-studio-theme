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

test('deriveRows returns cells in column order, with a halved derived column', () => {
  const profile = {
    sizes: ['XS'],
    columns: [
      { role: 'size', heading: 'Size', kind: 'label' },
      { role: 'chest_laid_flat', heading: 'Chest (laid flat)', kind: 'measure', derive: { from: 'chest_circumference', factor: 0.5 } },
      { role: 'chest_circumference', heading: 'Chest (circumference)', kind: 'measure', values: [38] },
      { role: 'body_length_hps', heading: 'Body Length', kind: 'measure', values: [25] },
      { role: 'sleeve_cb', heading: 'Sleeve Length', kind: 'measure', values: [34] },
    ],
  };
  assert.deepEqual(deriveRows(profile)[0], [
    'XS', '19" / 48.3 cm', '38" / 96.5 cm', '25" / 63.5 cm', '34" / 86.4 cm',
  ]);
});

test('deriveRows formats string, doubled-derive, and range columns', () => {
  const profile = {
    sizes: ['XS', 'S'],
    columns: [
      { role: 'size', heading: 'Size', kind: 'label' },
      { role: 'size_numeric', heading: 'US', kind: 'string', values: ['2', '4/6'] },
      { role: 'chest_laid_flat', heading: 'Chest', kind: 'measure', values: [19.5, 20] },
      { role: 'chest_circumference', heading: 'Chest (circ)', kind: 'measure', derive: { from: 'chest_laid_flat', factor: 2 } },
      { role: 'body_chest_range', heading: 'To Fit', kind: 'range', values: [[32, 34], [35, 37]] },
    ],
  };
  const rows = deriveRows(profile);
  assert.deepEqual(rows[0], ['XS', '2', '19.5" / 49.5 cm', '39" / 99.1 cm', '32-34"']);
  assert.deepEqual(rows[1], ['S', '4/6', '20" / 50.8 cm', '40" / 101.6 cm', '35-37"']);
});
