import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSku, skuProblem, MISS_UNKNOWN_PRODUCT, MISS_UNMAPPED_VALUE, MISS_MISSING_OPTION, MISS_INVALID_VALUE } from '../lib/derive.mjs';
import { loadTables, effectiveTables } from '../lib/tables.mjs';
import { parseCatalogue } from '../../lib/catalogue-manifest.mjs';
import { EFFECTIVE as TABLES, variant } from './fixtures.mjs';

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

test('an option-less product is its bare code, and Shopify\'s "Default Title" option is ignored', () => {
  // A single-variant product carries the synthetic `Title: Default Title` option, which maps to
  // no segment; the SKU is the product code alone and has no hyphen.
  const got = deriveSku(TABLES, variant('shift-fuel-tote', { Title: 'Default Title' }));
  assert.deepEqual(got, { ok: true, sku: 'SFTB', segments: ['SFTB'] });
  assert.equal(skuProblem(got.sku), null);
  assert.equal(deriveSku(TABLES, variant('shift-fuel-tote', {})).sku, 'SFTB');
});

test('a stray option on an option-less product is ignored, not derived into a segment', () => {
  // Pinned as a decision: the tables entry, not the variant, says which axes a product reads. A
  // Color option that appears on the tote later is a tables change (and `sku audit` reports the
  // resulting duplicate SKUs across variants), never a segment invented from the variant.
  const got = deriveSku(TABLES, variant('shift-fuel-tote', { Color: 'Black', Size: 'M' }));
  assert.deepEqual(got, { ok: true, sku: 'SFTB', segments: ['SFTB'] });
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
  assert.match(got.message, /normalises to "forest green", which catalogue\.json does not declare/);
});

test('a missing or blank option is a miss, never a dropped segment', () => {
  const absent = deriveSku(TABLES, variant('lead-ii-crewneck', { Design: 'Medic', Color: 'Black' }));
  assert.equal(absent.kind, MISS_MISSING_OPTION);
  assert.equal(absent.option, 'Size');
  const blank = deriveSku(TABLES, variant('lead-ii-crewneck', { Design: 'Medic', Color: 'Black', Size: '  ' }));
  assert.equal(blank.kind, MISS_MISSING_OPTION);
});

test('a declared size passes through into the SKU', () => {
  assert.equal(deriveSku(TABLES, variant('shift-fuel-crewneck', { Color: 'Black', Size: '2XL' })).sku, 'SFCN-BLK-2XL');
});

test('a size the product does not sell is a miss, not a passed-through segment', () => {
  // The hole this closes: sizes used to pass through on nothing but a /^[A-Z0-9]+$/ shape test, so
  // any uppercase token Admin happened to carry produced a plausible-looking SKU. The declared size
  // range from catalogue.json is now checked first.
  for (const size of ['3XL', 'm']) {
    const got = deriveSku(TABLES, variant('shift-fuel-crewneck', { Color: 'Black', Size: size }));
    assert.equal(got.ok, false, `"${size}" should not derive a SKU`);
    assert.equal(got.kind, MISS_UNMAPPED_VALUE);
    assert.equal(got.option, 'Size');
    assert.equal(got.value, size);
    assert.match(got.message, /declares the sizes \[XS, S, M, L, XL, 2XL\]/);
  }
});

test('a size segment on a product with no declared body is a tables error, not a value error', () => {
  const noBody = JSON.parse(JSON.stringify(TABLES));
  noBody.products['sapphire-shadow-studio-gift-card'].segments = [{ kind: 'size', option: 'Size' }];
  const got = deriveSku(noBody, variant('sapphire-shadow-studio-gift-card', { Size: 'M' }));
  assert.equal(got.ok, false);
  assert.equal(got.kind, MISS_INVALID_VALUE);
  assert.match(got.message, /declares no body for it/);
});

test('a declared size that cannot be spelled inside a SKU is refused rather than mangled', () => {
  // Reachable only through a manifest declaring such a size, which is why it needs its own fixture:
  // the declared-range check above now stands in front of the shape check.
  const oneSize = parseCatalogue(
    JSON.stringify({
      version: 2,
      options: { color: 'Color', size: 'Size', design: 'Design', denomination: 'Denominations' },
      colors: { black: { display: 'Black', slug: 'black' } },
      sizes: { 'one size': { display: 'One Size' } },
      bodies: { scarf: { colors: ['black'], sizes: ['one size'] } },
      products: {
        'lead-ii-scarf': {
          line: 'lead2',
          body: 'scarf',
          template: 'lead-ii-scarf',
          title: 'Lead II Scarf',
          gid: 'gid://shopify/Product/9',
        },
      },
    })
  );
  const tables = effectiveTables(
    {
      version: 2,
      colors: { black: 'BLK' },
      products: {
        'lead-ii-scarf': { code: 'L2SC', segments: [{ kind: 'color' }, { kind: 'size' }] },
      },
    },
    oneSize
  );
  const got = deriveSku(tables, { productHandle: 'lead-ii-scarf', options: { Color: 'Black', Size: 'One Size' } });
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
  // Lead II family, 4 x 3 x 6 for Huddle, 3 x 6 for Shift Fuel, 5 denominations, and the one bare
  // code of the option-less Shift Fuel Tote (an empty segments list is one combination, not none).
  assert.equal(seen.size, 432 + 72 + 18 + 5 + 1);
  assert.equal(seen.has('SFTB'), true, 'the option-less product derives its bare product code');
});

function cartesian(axes) {
  return axes.reduce((acc, axis) => acc.flatMap((prefix) => axis.map((v) => [...prefix, v])), [[]]);
}
