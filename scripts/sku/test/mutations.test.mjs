import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batch, readOutcome, indexFromField, setSkus, M_VARIANTS_BULK_UPDATE, VARIANT_BATCH_SIZE } from '../lib/mutations.mjs';

test('the SKU goes in inventoryItem, not at the top level', async () => {
  let captured;
  const client = {
    gql: async (query, vars) => {
      captured = { query, vars };
      return { productVariantsBulkUpdate: { productVariants: [{ id: 'v1', sku: 'SFCN-BLK-M' }], userErrors: [] } };
    },
  };
  const out = await setSkus(client, 'gid://shopify/Product/1', [{ variantId: 'v1', expectedSku: 'SFCN-BLK-M' }]);
  assert.deepEqual(captured.vars.variants, [{ id: 'v1', inventoryItem: { sku: 'SFCN-BLK-M' } }]);
  assert.equal(captured.query, M_VARIANTS_BULK_UPDATE);
  assert.deepEqual(out.byVariant.get('v1'), { ok: true, sku: 'SFCN-BLK-M', code: null, message: null });
});

test('the response selection stays off inventoryItem, which would widen the scope requirement', () => {
  assert.match(M_VARIANTS_BULK_UPDATE, /productVariants \{ id sku \}/);
  assert.doesNotMatch(M_VARIANTS_BULK_UPDATE, /productVariants \{[^}]*inventoryItem/);
});

test('a per-row error fails that row and leaves the rest applied', () => {
  const payload = {
    productVariants: [{ id: 'v1', sku: 'A' }, { id: 'v3', sku: 'C' }],
    userErrors: [{ field: ['variants', '1', 'inventoryItem', 'sku'], message: 'SKU has already been taken', code: 'TAKEN' }],
  };
  const { byVariant } = readOutcome(payload, ['v1', 'v2', 'v3']);
  assert.equal(byVariant.get('v1').ok, true);
  assert.deepEqual(
    { ok: byVariant.get('v2').ok, code: byVariant.get('v2').code },
    { ok: false, code: 'TAKEN' }
  );
  assert.equal(byVariant.get('v3').ok, true);
});

test('a row the API never mentions is not success', () => {
  const { byVariant } = readOutcome({ productVariants: [{ id: 'v1', sku: 'A' }], userErrors: [] }, ['v1', 'v2']);
  assert.equal(byVariant.get('v2').ok, false);
  assert.equal(byVariant.get('v2').code, 'NOT_RETURNED');
  assert.match(byVariant.get('v2').message, /treat as unwritten/);
});

test('a batch-level error fails every row and is reported separately', () => {
  const payload = { productVariants: [], userErrors: [{ field: ['productId'], message: 'Product does not exist', code: 'PRODUCT_DOES_NOT_EXIST' }] };
  const { byVariant, batchErrors } = readOutcome(payload, ['v1', 'v2']);
  assert.equal(batchErrors.length, 1);
  assert.ok([...byVariant.values()].every((o) => !o.ok));
  assert.match(byVariant.get('v1').message, /Product does not exist/);
});

test('a null payload fails every row rather than throwing', () => {
  const { byVariant } = readOutcome(null, ['v1']);
  assert.equal(byVariant.get('v1').ok, false);
});

test('indexFromField finds the input index and ignores paths without one', () => {
  assert.equal(indexFromField(['variants', '3', 'inventoryItem', 'sku']), 3);
  assert.equal(indexFromField(['variants', '0']), 0);
  assert.equal(indexFromField(['productId']), null);
  assert.equal(indexFromField(null), null);
  assert.equal(indexFromField(['variants', '3abc']), null);
});

test('batching respects the API ceiling and refuses a nonsense size', () => {
  assert.equal(VARIANT_BATCH_SIZE, 100);
  assert.deepEqual(batch([1, 2, 3], 2), [[1, 2], [3]]);
  assert.equal(batch(new Array(431).fill(0)).length, 5);
  assert.deepEqual(batch([]), []);
  assert.throws(() => batch([1], 0), /at least 1/);
});
