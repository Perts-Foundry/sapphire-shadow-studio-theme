import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyArtifact } from '../lib/apply.mjs';
import { createArtifact, createReceipt, receiptTally, MODE_NULLS, ROW_APPLIED, ROW_FAILED, ROW_SKIPPED } from '../lib/artifact.mjs';

const P1 = 'gid://shopify/Product/1';
const P2 = 'gid://shopify/Product/2';

const row = (variantId, expectedSku, baselineSku = null, productId = P1) => ({
  variantId,
  productId,
  productHandle: 'shift-fuel-crewneck',
  variantTitle: variantId,
  baselineSku,
  expectedSku,
});

const setup = (rows) => {
  const artifact = createArtifact({ rows, mode: MODE_NULLS, tablesHash: 'h', planId: 'p', createdAt: '2026-08-16T00:00:00Z' });
  return { artifact, receipt: createReceipt(artifact) };
};

/** A fake store: variant id to live SKU, plus a record of every write. */
const fakeStore = (live, behaviour = {}) => {
  const writes = [];
  return {
    writes,
    readSkus: async (productId) => new Map(Object.entries(live[productId] ?? {})),
    write: async (productId, rows) => {
      writes.push({ productId, rows: rows.map((r) => r.variantId) });
      if (behaviour.throwOn?.(productId, rows)) throw new Error('network exploded');
      const byVariant = new Map();
      for (const r of rows) {
        const forced = behaviour.perRow?.(r);
        byVariant.set(r.variantId, forced ?? { ok: true, sku: r.expectedSku, code: null, message: null });
      }
      return { byVariant };
    },
  };
};

test('a clean run applies every row and records the prior SKU', async () => {
  const { artifact, receipt } = setup([row('v1', 'SFCN-BLK-M'), row('v2', 'SFCN-BLK-S')]);
  const store = fakeStore({ [P1]: { v1: null, v2: null } });
  await applyArtifact({ artifact, receipt, ...store });
  assert.deepEqual(receiptTally(receipt), { [ROW_APPLIED]: 2, [ROW_FAILED]: 0, [ROW_SKIPPED]: 0, 'not-attempted': 0 });
  assert.ok(receipt.finishedAt);
  assert.equal(receipt.dryRun, false);
});

test('a row whose live SKU moved off the baseline is skipped, never overwritten', async () => {
  const { artifact, receipt } = setup([row('v1', 'SFCN-BLK-M'), row('v2', 'SFCN-BLK-S')]);
  const store = fakeStore({ [P1]: { v1: 'SET-BY-HAND', v2: null } });
  await applyArtifact({ artifact, receipt, ...store });
  const v1 = receipt.rows.find((r) => r.variantId === 'v1');
  assert.equal(v1.status, ROW_SKIPPED);
  assert.match(v1.detail, /baseline moved: planned from \(none\), now "SET-BY-HAND"/);
  assert.deepEqual(store.writes, [{ productId: P1, rows: ['v2'] }]);
});

test('a row already holding the expected SKU is a no-op skip', async () => {
  const { artifact, receipt } = setup([row('v1', 'SFCN-BLK-M')]);
  const store = fakeStore({ [P1]: { v1: 'SFCN-BLK-M' } });
  await applyArtifact({ artifact, receipt, ...store });
  assert.equal(receipt.rows[0].status, ROW_SKIPPED);
  assert.match(receipt.rows[0].detail, /already holds/);
  assert.deepEqual(store.writes, []);
});

test('a variant that no longer exists is skipped, not failed against a phantom', async () => {
  const { artifact, receipt } = setup([row('v1', 'SFCN-BLK-M')]);
  await applyArtifact({ artifact, receipt, ...fakeStore({ [P1]: {} }) });
  assert.match(receipt.rows[0].detail, /no longer exists/);
});

test('a drift-repair row writes only when the live value still matches its recorded baseline', async () => {
  const { artifact, receipt } = setup([row('v1', 'SFCN-BLK-M', 'OLD-1'), row('v2', 'SFCN-BLK-S', 'OLD-2')]);
  const store = fakeStore({ [P1]: { v1: 'OLD-1', v2: 'CHANGED-SINCE' } });
  await applyArtifact({ artifact, receipt, ...store });
  assert.equal(receipt.rows.find((r) => r.variantId === 'v1').status, ROW_APPLIED);
  assert.equal(receipt.rows.find((r) => r.variantId === 'v2').status, ROW_SKIPPED);
});

test('one rejected row does not abandon the others', async () => {
  const { artifact, receipt } = setup([row('v1', 'SFCN-BLK-M'), row('v2', 'SFCN-BLK-S'), row('v3', 'SFCN-BLK-L')]);
  const store = fakeStore(
    { [P1]: { v1: null, v2: null, v3: null } },
    { perRow: (r) => (r.variantId === 'v2' ? { ok: false, sku: null, code: 'TAKEN', message: 'SKU has already been taken' } : null) }
  );
  await applyArtifact({ artifact, receipt, ...store });
  assert.deepEqual(receiptTally(receipt), { [ROW_APPLIED]: 2, [ROW_FAILED]: 1, [ROW_SKIPPED]: 0, 'not-attempted': 0 });
  assert.match(receipt.rows.find((r) => r.variantId === 'v2').detail, /TAKEN: SKU has already been taken/);
});

test('an accepted row whose returned SKU is not the requested one is a failure, not a success', async () => {
  const { artifact, receipt } = setup([row('v1', 'SFCN-BLK-M')]);
  const store = fakeStore({ [P1]: { v1: null } }, { perRow: () => ({ ok: true, sku: 'SOMETHING-ELSE', code: null, message: null }) });
  await applyArtifact({ artifact, receipt, ...store });
  assert.equal(receipt.rows[0].status, ROW_FAILED);
  assert.match(receipt.rows[0].detail, /wrote "SOMETHING-ELSE", expected "SFCN-BLK-M"/);
});

test('a thrown mutation fails only its own batch and the run continues', async () => {
  const { artifact, receipt } = setup([row('v1', 'A1'), row('v2', 'A2', null, P2)]);
  const store = fakeStore({ [P1]: { v1: null }, [P2]: { v2: null } }, { throwOn: (productId) => productId === P1 });
  const events = [];
  await applyArtifact({ artifact, receipt, ...store }, { onProgress: (e) => events.push(e.type) });
  assert.equal(receipt.rows.find((r) => r.variantId === 'v1').status, ROW_FAILED);
  assert.equal(receipt.rows.find((r) => r.variantId === 'v2').status, ROW_APPLIED);
  assert.ok(events.includes('batch-error'));
});

test('a failed baseline re-read fails that product and spares the next one', async () => {
  const { artifact, receipt } = setup([row('v1', 'A1'), row('v2', 'A2', null, P2)]);
  const store = fakeStore({ [P2]: { v2: null } });
  const failingRead = async (productId) => {
    if (productId === P1) throw new Error('read timed out');
    return new Map([['v2', null]]);
  };
  await applyArtifact({ artifact, receipt, ...store, readSkus: failingRead });
  assert.match(receipt.rows.find((r) => r.variantId === 'v1').detail, /baseline re-read failed: read timed out/);
  assert.equal(receipt.rows.find((r) => r.variantId === 'v2').status, ROW_APPLIED);
});

test('the baseline is re-read per product, inside the loop, so a mid-run change is seen', async () => {
  const { artifact, receipt } = setup([row('v1', 'A1'), row('v2', 'A2', null, P2)]);
  const reads = [];
  const store = fakeStore({ [P1]: { v1: null }, [P2]: { v2: null } });
  await applyArtifact({
    artifact,
    receipt,
    write: store.write,
    readSkus: async (productId) => {
      reads.push(productId);
      return store.readSkus(productId);
    },
  });
  assert.deepEqual(reads, [P1, P2]);
});

test('a dry run classifies and writes nothing', async () => {
  const { artifact, receipt } = setup([row('v1', 'SFCN-BLK-M')]);
  const store = fakeStore({ [P1]: { v1: null } });
  await applyArtifact({ artifact, receipt, ...store }, { dryRun: true });
  assert.deepEqual(store.writes, []);
  assert.equal(receipt.rows[0].status, ROW_SKIPPED);
  assert.match(receipt.rows[0].detail, /dry run: would write/);
  assert.equal(receipt.dryRun, true);
});

test('the receipt is persisted after every batch, so a crash leaves a readable record', async () => {
  const { artifact, receipt } = setup([row('v1', 'A1'), row('v2', 'A2', null, P2)]);
  const snapshots = [];
  const store = fakeStore({ [P1]: { v1: null }, [P2]: { v2: null } });
  await applyArtifact({ artifact, receipt, ...store }, { persist: async (r) => snapshots.push(receiptTally(r)) });
  assert.ok(snapshots.length >= 3, 'one per batch plus the final write');
  assert.deepEqual(snapshots.at(-1)[ROW_APPLIED], 2);
});

test('rows are batched per product, never mixed across products', async () => {
  const { artifact, receipt } = setup([row('v1', 'A1'), row('v2', 'A2', null, P2), row('v3', 'A3')]);
  const store = fakeStore({ [P1]: { v1: null, v3: null }, [P2]: { v2: null } });
  await applyArtifact({ artifact, receipt, ...store }, { batchSize: 1 });
  assert.deepEqual(store.writes, [
    { productId: P1, rows: ['v1'] },
    { productId: P1, rows: ['v3'] },
    { productId: P2, rows: ['v2'] },
  ]);
});
