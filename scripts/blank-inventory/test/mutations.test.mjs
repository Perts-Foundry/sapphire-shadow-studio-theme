import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readOutcome,
  setQuantity,
  adjustQuantity,
  setBlankMetafields,
  deleteBlankMetafields,
  batch,
  REFERENCE_URI,
  REASON,
} from '../lib/mutations.mjs';

/** A client stub that records the query and variables it was handed. */
function stubClient(response) {
  const calls = [];
  return {
    calls,
    gql: async (query, variables) => {
      calls.push({ query, variables });
      return response;
    },
  };
}

// --- readOutcome ------------------------------------------------------------
// This is the function that decides whether a write actually did anything. Every apply/backfill
// test stubs `write`, so without these cases a regression here would fail nothing.

test('readOutcome reports a real adjustment as a successful, non-noop write', () => {
  const out = readOutcome({ userErrors: [], inventoryAdjustmentGroup: { reason: 'correction', changes: [{ name: 'available', delta: 1 }] } });
  assert.deepEqual(out, { ok: true, noop: false, code: null, message: null });
});

test('readOutcome flags a null adjustment group as a NO-OP', () => {
  // A write of the value a variant already holds succeeds but moves nothing and fires no trigger,
  // so the Flow never runs. Treating this as plain success would report a converged group that is
  // actually still stale.
  const out = readOutcome({ userErrors: [], inventoryAdjustmentGroup: null });
  assert.equal(out.ok, true);
  assert.equal(out.noop, true);
});

test('readOutcome surfaces the first userErrors code and joins every message', () => {
  const out = readOutcome({
    userErrors: [
      { code: 'CHANGE_FROM_QUANTITY_STALE', message: 'no longer matches' },
      { code: 'OTHER', message: 'second problem' },
    ],
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'CHANGE_FROM_QUANTITY_STALE');
  assert.equal(out.message, 'no longer matches; second problem');
});

test('readOutcome treats a missing or malformed payload as a reportable no-op, not a silent success', () => {
  // If a mutation field is renamed, the payload arrives undefined. That must not read as "written".
  for (const payload of [undefined, null, {}]) {
    const out = readOutcome(payload);
    assert.equal(out.noop, true, `payload ${JSON.stringify(payload)} must not look like a real write`);
  }
});

test('readOutcome tolerates a userErrors entry with no code', () => {
  const out = readOutcome({ userErrors: [{ message: 'unspecified' }] });
  assert.equal(out.ok, false);
  assert.equal(out.code, null);
});

// --- mutation payload shape -------------------------------------------------
// The only place a plan's baseline/target/idempotencyKey become a live API call.

test('setQuantity sends the absolute quantity, the CAS baseline, and the idempotency key', async () => {
  const client = stubClient({ inventorySetQuantities: { userErrors: [], inventoryAdjustmentGroup: { changes: [] } } });
  await setQuantity(client, {
    inventoryItemId: 'gid://shopify/InventoryItem/1',
    locationId: 'gid://shopify/Location/1',
    quantity: 12,
    changeFromQuantity: 11,
    idempotencyKey: 'key-abc',
  });

  const { query, variables } = client.calls[0];
  assert.match(query, /@idempotent\(key: \$idempotencyKey\)/, 'the directive is required by the API');
  assert.equal(variables.idempotencyKey, 'key-abc');
  assert.equal(variables.input.name, 'available');
  assert.equal(variables.input.reason, REASON);
  assert.equal(variables.input.referenceDocumentUri, REFERENCE_URI);
  assert.deepEqual(variables.input.quantities, [
    {
      inventoryItemId: 'gid://shopify/InventoryItem/1',
      locationId: 'gid://shopify/Location/1',
      quantity: 12,
      changeFromQuantity: 11,
    },
  ]);
});

test('adjustQuantity sends a delta rather than an absolute quantity', async () => {
  const client = stubClient({ inventoryAdjustQuantities: { userErrors: [], inventoryAdjustmentGroup: { changes: [] } } });
  await adjustQuantity(client, {
    inventoryItemId: 'gid://shopify/InventoryItem/1',
    locationId: 'gid://shopify/Location/1',
    delta: -3,
    changeFromQuantity: 11,
    idempotencyKey: 'key-xyz',
  });

  const { query, variables } = client.calls[0];
  assert.match(query, /@idempotent\(key: \$idempotencyKey\)/);
  assert.equal(variables.input.changes[0].delta, -3);
  assert.equal(variables.input.changes[0].changeFromQuantity, 11);
  assert.equal(variables.input.changes[0].quantity, undefined, 'an adjust must not send an absolute quantity');
});

test('a stale compare-and-swap surfaces as a failed outcome, not an exception', async () => {
  const client = stubClient({
    inventorySetQuantities: { userErrors: [{ code: 'CHANGE_FROM_QUANTITY_STALE', message: 'stale' }], inventoryAdjustmentGroup: null },
  });
  const out = await setQuantity(client, { inventoryItemId: 'i', locationId: 'l', quantity: 1, changeFromQuantity: 0, idempotencyKey: 'k' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'CHANGE_FROM_QUANTITY_STALE');
});

// --- metafield batching -----------------------------------------------------

test('setBlankMetafields chunks into calls of at most 25 and counts what was written', async () => {
  const entries = Array.from({ length: 26 }, (_, i) => ({ ownerId: `gid://shopify/ProductVariant/${i}`, value: 'GREY_ACME_FLEECE_0001_M' }));
  const calls = [];
  const client = {
    gql: async (query, variables) => {
      calls.push(variables.metafields);
      return { metafieldsSet: { metafields: variables.metafields.map((m) => ({ id: 'x', ...m })), userErrors: [] } };
    },
  };
  const res = await setBlankMetafields(client, entries);
  assert.equal(calls.length, 2, '26 entries must split into 2 calls');
  assert.equal(calls[0].length, 25);
  assert.equal(calls[1].length, 1);
  assert.equal(res.written, 26);
  assert.equal(calls[0][0].type, 'single_line_text_field');
  assert.equal(calls[0][0].namespace, 'custom');
  assert.equal(calls[0][0].key, 'inventory_blank_sku');
});

test('setBlankMetafields collects userErrors across batches rather than throwing', async () => {
  const client = { gql: async () => ({ metafieldsSet: { metafields: [], userErrors: [{ message: 'nope' }] } }) };
  const res = await setBlankMetafields(client, [{ ownerId: 'a', value: 'v' }]);
  assert.equal(res.errors.length, 1);
  assert.equal(res.written, 0);
});

test('deleteBlankMetafields targets the right namespace and key', async () => {
  let seen;
  const client = {
    gql: async (query, variables) => {
      seen = variables.metafields;
      return { metafieldsDelete: { deletedMetafields: variables.metafields, userErrors: [] } };
    },
  };
  const res = await deleteBlankMetafields(client, ['gid://shopify/ProductVariant/1']);
  assert.deepEqual(seen, [{ ownerId: 'gid://shopify/ProductVariant/1', namespace: 'custom', key: 'inventory_blank_sku' }]);
  assert.equal(res.deleted, 1);
});

test('batch never exceeds the API ceiling and drops nothing', () => {
  for (const n of [0, 1, 24, 25, 26, 51]) {
    const chunks = batch(Array.from({ length: n }, (_, i) => i));
    assert.ok(chunks.every((c) => c.length <= 25));
    assert.equal(chunks.flat().length, n);
  }
});
