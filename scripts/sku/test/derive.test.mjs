import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSku, skuProblem, MISS_UNKNOWN_PRODUCT, MISS_UNMAPPED_VALUE, MISS_MISSING_OPTION, MISS_INVALID_VALUE } from '../lib/derive.mjs';
import { loadTables } from '../lib/tables.mjs';
import { TABLES, variant } from './fixtures.mjs';

test('the four-segment shape', () => {
  const got = deriveSku(TABLES, variant('lead-ii-crewneck', { Design: 'RN (Registered Nurse)', Color: 'Black', Size: 'M' }));
  assert.deepEqual(got, { ok: true, sku: 'L2CN-RN-BLK-M', segments: ['L2CN', 'RN', 'BLK', 'M'] });
});

test('the design-less shape drops the segment rather than emitting an empty one', () => {
  const got = deriveSku(TABLES, variant('shift-fuel-crewneck', { Color: 'Grey Heather', Size: '2XL' }));
  assert.equal(got.sku, 'SFCN-GRH-2XL');
});

test('the gift card encodes its zero-padded denomination', () => {
  const got = deriveSku(TABLES, variant('sapphire-shadow-studio-gift-card', { Denominations: '$50.00' }));
  assert.equal(got.sku, 'GIFT-050');
  assert.equal(skuProblem(got.sku), null, 'a segment may start with 0; the SKU does not');
});

test('design codes are namespaced per product family', () => {
  // "Nurse" exists only in the huddle namespace; the lead-ii namespace must not see it.
  assert.equal(deriveSku(TABLES, variant('huddle-crewneck', { Design: 'Nurse', Color: 'Black', Size: 'S' })).sku, 'HDCN-NRS-BLK-S');
  const miss = deriveSku(TABLES, variant('lead-ii-crewneck', { Design: 'Nurse', Color: 'Black', Size: 'S' }));
  assert.equal(miss.ok, false);
  assert.equal(miss.kind, MISS_UNMAPPED_VALUE);
  assert.match(miss.message, /designs\.lead-ii: add "Nurse"/);
});

test('an unknown product is a typed miss naming the handle', () => {
  const got = deriveSku(TABLES, variant('brand-new-hoodie', { Color: 'Black', Size: 'M' }));
  assert.equal(got.ok, false);
  assert.equal(got.kind, MISS_UNKNOWN_PRODUCT);
  assert.equal(got.value, 'brand-new-hoodie');
  assert.match(got.message, /not in tables\.json/);
});

test('an unmapped colour is a typed miss quoting the value verbatim', () => {
  const got = deriveSku(TABLES, variant('shift-fuel-crewneck', { Color: 'Forest Green', Size: 'M' }));
  assert.equal(got.ok, false);
  assert.equal(got.kind, MISS_UNMAPPED_VALUE);
  assert.equal(got.option, 'Color');
  assert.equal(got.value, 'Forest Green');
  assert.match(got.message, /colors: add "Forest Green"/);
});

test('a missing or blank option is a miss, never a dropped segment', () => {
  const absent = deriveSku(TABLES, variant('lead-ii-crewneck', { Design: 'Medic', Color: 'Black' }));
  assert.equal(absent.kind, MISS_MISSING_OPTION);
  assert.equal(absent.option, 'Size');
  const blank = deriveSku(TABLES, variant('lead-ii-crewneck', { Design: 'Medic', Color: 'Black', Size: '  ' }));
  assert.equal(blank.kind, MISS_MISSING_OPTION);
});

test('sizes pass through uppercased, including one with no table entry', () => {
  assert.equal(deriveSku(TABLES, variant('shift-fuel-crewneck', { Color: 'Black', Size: '3xl' })).sku, 'SFCN-BLK-3XL');
});

test('a size that is not letters and digits is refused rather than mangled', () => {
  const got = deriveSku(TABLES, variant('shift-fuel-crewneck', { Color: 'Black', Size: 'One Size' }));
  assert.equal(got.ok, false);
  assert.equal(got.kind, MISS_INVALID_VALUE);
  assert.match(got.message, /cannot pass through/);
});

test('there is no fuzzy matching: a near miss is still a miss', () => {
  const got = deriveSku(TABLES, variant('lead-ii-crewneck', { Design: 'RN (Registered nurse)', Color: 'Black', Size: 'M' }));
  assert.equal(got.ok, false);
  assert.equal(got.kind, MISS_UNMAPPED_VALUE);
});

test('skuProblem enforces the scheme rules the tables cannot', () => {
  assert.equal(skuProblem('L2CN-RN-BLK-M'), null);
  assert.match(skuProblem('0FF-BLK-M'), /starts with 0/);
  assert.match(skuProblem('l2cn-rn'), /outside A-Z/);
  assert.match(skuProblem('L2CN--BLK'), /empty segment/);
  assert.match(skuProblem('L2CN-BLK-'), /empty segment/);
  assert.match(skuProblem(''), /empty SKU/);
});

test('every live option value in the committed tables derives a legal SKU', async () => {
  const tables = await loadTables();
  const seen = new Set();
  for (const [handle, entry] of Object.entries(tables.products)) {
    const axes = entry.segments.map((seg) => {
      if (seg.kind === 'color') return Object.keys(tables.colors).map((v) => [seg.option, v]);
      if (seg.kind === 'design') return Object.keys(tables.designs[entry.designNamespace]).map((v) => [seg.option, v]);
      if (seg.kind === 'denomination') return Object.keys(tables.denominations).map((v) => [seg.option, v]);
      return ['XS', 'S', 'M', 'L', 'XL', '2XL'].map((v) => [seg.option, v]);
    });
    for (const combo of cartesian(axes)) {
      const got = deriveSku(tables, { productHandle: handle, options: Object.fromEntries(combo) });
      assert.equal(got.ok, true, `${handle} ${JSON.stringify(combo)}`);
      assert.equal(skuProblem(got.sku), null, got.sku);
      assert.ok(got.sku.length <= 16, `${got.sku} is longer than the 16-character band`);
      assert.equal(seen.has(got.sku), false, `${got.sku} is derived twice`);
      seen.add(got.sku);
    }
  }
  // The full table cross-product, which is deliberately wider than the live catalogue: the vest is
  // Black-only today, and the tables carry no per-product colour availability because a colour
  // added to it later must not need a scheme change. 3 x (8 designs x 3 colours x 6 sizes) for the
  // Lead II family, 4 x 3 x 6 for Huddle, 3 x 6 for Shift Fuel, 5 denominations.
  assert.equal(seen.size, 432 + 72 + 18 + 5);
});

function cartesian(axes) {
  return axes.reduce((acc, axis) => acc.flatMap((prefix) => axis.map((v) => [...prefix, v])), [[]]);
}
