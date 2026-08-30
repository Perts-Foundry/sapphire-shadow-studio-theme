import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSvg } from '../lib/render-svg.mjs';
import { drawGarment } from '../lib/garments.mjs';
import { altText } from '../render-size-chart.mjs';
import { resolvedProfile } from './profile-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = resolvedProfile('crewneck-fleece');

test('altText lists the crewneck measured columns and sizes', () => {
  assert.equal(
    altText(SEED),
    'Unisex Crewneck Fleece size guide: chest (laid flat), chest (circumference), body length, '
    + 'and sleeve length in inches and centimeters for sizes XS, S, M, L, XL, 2XL.',
  );
});

test('buildSvg throws (not clips) when content overflows canvas_height', () => {
  const tooShort = { ...SEED, canvas_height: 900 };
  assert.throws(() => buildSvg(tooShort), /overflows/);
});

test('drawGarment renders nothing for the null (no-diagram) garment', () => {
  assert.equal(drawGarment(null, 0, 0, 1, {}), '');
});

test('drawGarment throws on an unknown garment id', () => {
  assert.throws(() => drawGarment('trousers', 0, 0, 1, {}), /Unknown garment/);
});

test('altText joins one and two measured columns without an oxford comma', () => {
  const base = { display_name: 'X', sizes: ['XS'], columns: [{ role: 'size', heading: 'Size', kind: 'label' }] };
  const one = { ...base, columns: [...base.columns, { role: 'chest_laid_flat', heading: 'Chest', kind: 'measure', values: [19] }] };
  assert.match(altText(one), /guide: chest in inches/);
  const two = { ...base, columns: [...one.columns, { role: 'body_length_hps', heading: 'Body', kind: 'measure', values: [25] }] };
  assert.match(altText(two), /chest and body in inches/);
});
