import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditCatalogue } from '../lib/audit.mjs';
import { buildPlan, PlanRefused } from '../lib/planner.mjs';
import { MODE_NULLS, MODE_NULLS_AND_MISMATCHES } from '../lib/artifact.mjs';
import { TABLES, catalogue, variant } from './fixtures.mjs';

const planOf = (tables, rows, opts) => buildPlan(auditCatalogue(tables, rows), opts);

test('a null-only plan covers every actionable null and nothing else', () => {
  const rows = catalogue();
  const { rows: planned, mode } = planOf(TABLES, rows);
  assert.equal(mode, MODE_NULLS);
  assert.equal(planned.length, rows.length);
  assert.ok(planned.every((r) => r.baselineSku === null));
  assert.ok(planned.every((r) => r.expectedSku && r.productId && r.variantId));
});

test('drift is refused by default and included only on the explicit opt-in', () => {
  const rows = [
    variant('shift-fuel-crewneck', { Color: 'Black', Size: 'M' }, { id: 'v1', sku: 'OLD-1' }),
    variant('shift-fuel-crewneck', { Color: 'Black', Size: 'S' }, { id: 'v2' }),
  ];
  const nullsOnly = planOf(TABLES, rows);
  assert.deepEqual(nullsOnly.rows.map((r) => r.variantId), ['v2']);
  assert.equal(nullsOnly.refused.length, 1);
  assert.match(nullsOnly.refused[0].reason, /--include-mismatches/);

  const both = planOf(TABLES, rows, { includeMismatches: true });
  assert.equal(both.mode, MODE_NULLS_AND_MISMATCHES);
  assert.deepEqual(both.rows.map((r) => r.variantId).sort(), ['v1', 'v2']);
  assert.equal(both.rows.find((r) => r.variantId === 'v1').baselineSku, 'OLD-1');
});

test('an unmapped value refuses the whole plan, naming what to add', () => {
  assert.throws(
    () => planOf(TABLES, catalogue({ unmappedColor: true })),
    (err) => {
      assert.ok(err instanceof PlanRefused);
      assert.match(err.message, /unmapped value\(s\)/);
      assert.match(err.message, /colors: add "Forest Green"/);
      assert.match(err.message, /tables\.json first/);
      return true;
    }
  );
});

test('a duplicate expected SKU refuses the plan', () => {
  const rows = [
    variant('shift-fuel-crewneck', { Color: 'Black', Size: 'M' }, { id: 'v1' }),
    variant('shift-fuel-crewneck', { Color: 'Black', Size: 'm' }, { id: 'v2' }),
  ];
  assert.throws(() => planOf(TABLES, rows), /is derived by 2 variants/);
});

test('a collision with a live SKU on another variant refuses the plan', () => {
  const rows = [
    variant('shift-fuel-crewneck', { Color: 'Black', Size: 'M' }, { id: 'v1' }),
    variant('shift-fuel-crewneck', { Color: 'Black', Size: 'S' }, { id: 'v2', sku: 'SFCN-BLK-M' }),
  ];
  assert.throws(() => planOf(TABLES, rows), /already live on a different variant/);
});

test('an exempt product is refused into the not-in-plan list, not written', () => {
  const tables = JSON.parse(JSON.stringify(TABLES));
  tables.products['sapphire-shadow-studio-gift-card'].skuWritable = false;
  const rows = [
    variant('sapphire-shadow-studio-gift-card', { Denominations: '$10.00' }, { id: 'g1' }),
    variant('shift-fuel-crewneck', { Color: 'Black', Size: 'M' }, { id: 'v1' }),
  ];
  const plan = planOf(tables, rows);
  assert.deepEqual(plan.rows.map((r) => r.variantId), ['v1']);
  assert.equal(plan.refused[0].variantId, 'g1');
  assert.match(plan.refused[0].reason, /skuWritable: false/);
});

test('nothing to write is a refusal, not an empty plan that looks applicable', () => {
  const rows = [variant('shift-fuel-crewneck', { Color: 'Black', Size: 'M' }, { sku: 'SFCN-BLK-M' })];
  assert.throws(() => planOf(TABLES, rows), /nothing to write/);
});

test('the in-plan collision guard stands on its own, for a caller that assembles rows another way', () => {
  const report = {
    misses: [],
    duplicates: [],
    collisions: [],
    rows: [
      { status: 'null-actionable', variantId: 'v1', productId: 'p', productHandle: 'h', variantTitle: 't', sku: null, expected: 'SFCN-BLK-M' },
      { status: 'null-actionable', variantId: 'v2', productId: 'p', productHandle: 'h', variantTitle: 't', sku: null, expected: 'SFCN-BLK-M' },
    ],
  };
  assert.throws(() => buildPlan(report), /would write SFCN-BLK-M to both v1 and v2/);
});
