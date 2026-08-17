import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditCatalogue, OK, MISS, MISMATCH, NULL_ACTIONABLE, NULL_EXEMPT } from '../lib/audit.mjs';
import { TABLES, catalogue, variant } from './fixtures.mjs';

const withExemptGift = () => {
  const t = JSON.parse(JSON.stringify(TABLES));
  t.products['sapphire-shadow-studio-gift-card'].skuWritable = false;
  return t;
};

test('every variant lands in exactly one status and the counts add up', () => {
  const variants = catalogue();
  const report = auditCatalogue(TABLES, variants);
  assert.equal(report.total, variants.length);
  const sum = Object.values(report.counts).reduce((a, b) => a + b, 0);
  assert.equal(sum, variants.length, 'a variant in no class is a variant nobody counted');
  assert.equal(report.counts[NULL_ACTIONABLE], variants.length);
  assert.equal(report.ok, false);
});

test('a correct SKU is ok and a wrong one is drift', () => {
  const rows = [
    variant('shift-fuel-crewneck', { Color: 'Black', Size: 'M' }, { id: 'v1', sku: 'SFCN-BLK-M' }),
    variant('shift-fuel-crewneck', { Color: 'Black', Size: 'S' }, { id: 'v2', sku: 'OLD-SKU-1' }),
  ];
  const report = auditCatalogue(TABLES, rows);
  assert.equal(report.counts[OK], 1);
  assert.equal(report.counts[MISMATCH], 1);
  assert.equal(report.rows[1].expected, 'SFCN-BLK-S');
  assert.match(report.problems.join(' '), /1 variant\(s\) have a SKU that is not the derived one/);
});

test('an unmapped value is grouped once with a variant count, not repeated per variant', () => {
  const rows = [
    variant('shift-fuel-crewneck', { Color: 'Forest Green', Size: 'M' }),
    variant('shift-fuel-crewneck', { Color: 'Forest Green', Size: 'S' }),
    variant('shift-fuel-crewneck', { Color: 'Black', Size: 'S' }),
  ];
  const report = auditCatalogue(TABLES, rows);
  assert.equal(report.counts[MISS], 2);
  assert.equal(report.misses.length, 1);
  assert.equal(report.misses[0].variantCount, 2);
  assert.equal(report.misses[0].value, 'Forest Green');
  assert.match(report.misses[0].message, /colors: add "Forest Green"/);
});

test('an unknown product is reported once for the whole product', () => {
  const report = auditCatalogue(TABLES, [variant('brand-new-hoodie', { Color: 'Black', Size: 'M' })]);
  assert.equal(report.misses[0].kind, 'unknown-product');
  assert.equal(report.misses[0].productHandle, 'brand-new-hoodie');
});

test('exempt nulls are counted apart and do not fail the verdict on their own', () => {
  const tables = withExemptGift();
  const rows = [
    variant('sapphire-shadow-studio-gift-card', { Denominations: '$10.00' }),
    variant('shift-fuel-crewneck', { Color: 'Black', Size: 'M' }, { sku: 'SFCN-BLK-M' }),
  ];
  const report = auditCatalogue(tables, rows);
  assert.equal(report.counts[NULL_EXEMPT], 1);
  assert.equal(report.counts[NULL_ACTIONABLE], 0);
  assert.equal(report.ok, true, '0 actionable nulls is the steady state, not permanent failure');
});

test('an exempt product with a correct SKU is still ok, not exempt', () => {
  const report = auditCatalogue(withExemptGift(), [
    variant('sapphire-shadow-studio-gift-card', { Denominations: '$10.00' }, { sku: 'GIFT-010' }),
  ]);
  assert.equal(report.counts[OK], 1);
  assert.equal(report.counts[NULL_EXEMPT], 0);
});

test('two variants deriving one SKU is reported as a tables defect', () => {
  const rows = [
    variant('shift-fuel-crewneck', { Color: 'Black', Size: 'M' }, { id: 'v1' }),
    variant('shift-fuel-crewneck', { Color: 'Black', Size: 'm' }, { id: 'v2' }),
  ];
  const report = auditCatalogue(TABLES, rows);
  assert.equal(report.duplicates.length, 1);
  assert.equal(report.duplicates[0].sku, 'SFCN-BLK-M');
  assert.deepEqual(report.duplicates[0].variantIds, ['v1', 'v2']);
  assert.equal(report.ok, false);
});

test('an expected SKU already live on a different variant is a collision, not a duplicate', () => {
  const rows = [
    // v1 wants SFCN-BLK-M; v2 is a different variant already holding that string by hand.
    variant('shift-fuel-crewneck', { Color: 'Black', Size: 'M' }, { id: 'v1' }),
    variant('shift-fuel-crewneck', { Color: 'Black', Size: 'S' }, { id: 'v2', sku: 'SFCN-BLK-M' }),
  ];
  const report = auditCatalogue(TABLES, rows);
  assert.equal(report.duplicates.length, 0);
  assert.equal(report.collisions.length, 1);
  assert.deepEqual(
    { sku: report.collisions[0].sku, wantedBy: report.collisions[0].wantedBy, heldBy: report.collisions[0].heldBy },
    { sku: 'SFCN-BLK-M', wantedBy: 'v1', heldBy: 'v2' }
  );
});

test('a variant already holding its own expected SKU is not a collision with itself', () => {
  const report = auditCatalogue(TABLES, [variant('shift-fuel-crewneck', { Color: 'Black', Size: 'M' }, { id: 'v1', sku: 'SFCN-BLK-M' })]);
  assert.deepEqual(report.collisions, []);
  assert.equal(report.ok, true);
});

test('a clean catalogue is ok with no problems', () => {
  const rows = catalogue().map((v) => ({ ...v }));
  const first = auditCatalogue(TABLES, rows);
  for (const [i, r] of first.rows.entries()) rows[i].sku = r.expected;
  const report = auditCatalogue(TABLES, rows);
  assert.equal(report.ok, true);
  assert.deepEqual(report.problems, []);
  assert.equal(report.counts[OK], rows.length);
});
