import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createArtifact,
  hashArtifact,
  verifyArtifact,
  assertTablesUnchanged,
  assertRenderablePlan,
  createReceipt,
  markRow,
  receiptTally,
  planPath,
  receiptPath,
  writeJsonAtomic,
  readJson,
  ARTIFACT_VERSION,
  MODE_NULLS,
  ROW_APPLIED,
  ROW_FAILED,
  ROW_SKIPPED,
  ROW_NOT_ATTEMPTED,
} from '../lib/artifact.mjs';

const row = (over = {}) => ({
  variantId: over.variantId ?? 'gid://shopify/ProductVariant/1',
  productId: 'gid://shopify/Product/1',
  productHandle: 'shift-fuel-crewneck',
  variantTitle: 'Black / M',
  baselineSku: over.baselineSku ?? null,
  expectedSku: over.expectedSku ?? 'SFCN-BLK-M',
  ...over,
});

const artifactOf = (rows, over = {}) =>
  createArtifact({ rows, mode: MODE_NULLS, tablesHash: 'tables-hash-a', planId: 'plan-a', createdAt: '2026-08-16T00:00:00Z', ...over });

test('an artifact hashes its rows, mode and tables hash', () => {
  const a = artifactOf([row()]);
  assert.equal(a.version, ARTIFACT_VERSION);
  assert.equal(a.contentHash, hashArtifact(a));
  assert.equal(verifyArtifact(a), a);
});

test('row order does not change the hash, but a changed SKU does', () => {
  const a = artifactOf([row({ variantId: 'v1', expectedSku: 'SFCN-BLK-M' }), row({ variantId: 'v2', expectedSku: 'SFCN-BLK-S' })]);
  const b = artifactOf([row({ variantId: 'v2', expectedSku: 'SFCN-BLK-S' }), row({ variantId: 'v1', expectedSku: 'SFCN-BLK-M' })]);
  assert.equal(a.contentHash, b.contentHash);
  const c = artifactOf([row({ variantId: 'v1', expectedSku: 'SFCN-BLK-L' }), row({ variantId: 'v2', expectedSku: 'SFCN-BLK-S' })]);
  assert.notEqual(a.contentHash, c.contentHash);
});

test('a hand-edited artifact is refused', () => {
  const a = artifactOf([row()]);
  a.rows[0].expectedSku = 'SFCN-BLK-XL';
  assert.throws(() => verifyArtifact(a), /hash mismatch/);
});

test('a hand-edited baseline is refused too: it is what the write guard compares against', () => {
  const a = artifactOf([row({ baselineSku: null })]);
  a.rows[0].baselineSku = 'ANYTHING';
  assert.throws(() => verifyArtifact(a), /hash mismatch/);
});

test('an artifact from another version is refused', () => {
  const a = artifactOf([row()]);
  a.version = 99;
  assert.throws(() => verifyArtifact(a), /Unsupported plan artifact/);
  assert.throws(() => verifyArtifact({ version: ARTIFACT_VERSION }), /no "rows" array/);
});

test('an artifact planned against different tables is refused', () => {
  const a = artifactOf([row()]);
  assert.equal(assertTablesUnchanged(a, 'tables-hash-a'), a);
  assert.throws(() => assertTablesUnchanged(a, 'tables-hash-b'), /voids this plan and its approval/);
});

test('an artifact must record the tables hash and a known mode', () => {
  assert.throws(() => createArtifact({ rows: [row()], mode: MODE_NULLS, tablesHash: '' }), /must record the tables hash/);
  assert.throws(() => createArtifact({ rows: [row()], mode: 'everything', tablesHash: 'h' }), /Unknown plan mode/);
});

test('a row missing a gate field refuses to render, but a null baseline is legitimate', () => {
  assert.equal(assertRenderablePlan(artifactOf([row({ baselineSku: null })])).rows.length, 1);
  const broken = artifactOf([row()]);
  delete broken.rows[0].expectedSku;
  assert.throws(() => assertRenderablePlan(broken), /is missing expectedSku/);
  const noBaseline = artifactOf([row()]);
  delete noBaseline.rows[0].baselineSku;
  assert.throws(() => assertRenderablePlan(noBaseline), /is missing baselineSku/);
});

test('a receipt starts not-attempted and records the prior SKU per row', () => {
  const a = artifactOf([row({ variantId: 'v1', baselineSku: 'OLD-1' })]);
  const receipt = createReceipt(a, '2026-08-16T01:00:00Z');
  assert.equal(receipt.planId, 'plan-a');
  assert.equal(receipt.tablesHash, 'tables-hash-a');
  assert.deepEqual(
    receipt.rows.map((r) => [r.variantId, r.baselineSku, r.expectedSku, r.status]),
    [['v1', 'OLD-1', 'SFCN-BLK-M', ROW_NOT_ATTEMPTED]]
  );
});

test('markRow is terminal per row and refuses an unknown variant', () => {
  const receipt = createReceipt(artifactOf([row({ variantId: 'v1' }), row({ variantId: 'v2' })]));
  markRow(receipt, 'v1', ROW_APPLIED, null, '2026-08-16T02:00:00Z');
  markRow(receipt, 'v2', ROW_FAILED, 'TAKEN: sku in use');
  assert.deepEqual(receiptTally(receipt), { [ROW_APPLIED]: 1, [ROW_FAILED]: 1, [ROW_SKIPPED]: 0, [ROW_NOT_ATTEMPTED]: 0 });
  assert.equal(receipt.rows[0].at, '2026-08-16T02:00:00Z');
  assert.throws(() => markRow(receipt, 'v9', ROW_APPLIED), /no row for variant/);
});

test('artifact and receipt paths are derived from the plan id, so the receipt is the spend record', () => {
  assert.equal(planPath('/w', 'p1'), path.join('/w', 'plan-p1.json'));
  assert.equal(receiptPath('/w', 'p1'), path.join('/w', 'receipt-p1.json'));
});

test('writeJsonAtomic creates the directory and leaves no temp file behind', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sku-artifact-'));
  const file = path.join(dir, 'nested', 'plan.json');
  const a = artifactOf([row()]);
  await writeJsonAtomic(file, a);
  assert.deepEqual(await readJson(file), a);
  assert.match(await readFile(file, 'utf8'), /\n$/);
});
