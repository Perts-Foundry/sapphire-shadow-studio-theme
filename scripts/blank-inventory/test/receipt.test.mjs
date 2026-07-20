import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createArtifact,
  hashArtifact,
  verifyArtifact,
  narrowArtifact,
  createReceipt,
  markRow,
  isReceiptComplete,
  pendingBlankIds,
  pendingSeedBlankIds,
  writeJsonAtomic,
  readJson,
  ROW_APPLIED,
  ROW_FAILED,
  ROW_NOT_ATTEMPTED,
} from '../lib/receipt.mjs';
import { derivedIdempotencyKey } from '../lib/planner.mjs';

const plan = (over = {}) => ({
  blankId: over.blankId ?? 'B1',
  target: over.target ?? 12,
  current: 11,
  baseline: 11,
  delta: null,
  writeTargetId: over.writeTargetId ?? 'gid://shopify/ProductVariant/1',
  writeTargetTitle: 'product-a | RN / Grey Heather / 2XL',
  inventoryItemId: 'gid://shopify/InventoryItem/1',
  memberIds: ['gid://shopify/ProductVariant/1', 'gid://shopify/ProductVariant/2'],
  siblingCount: 1,
  idempotencyKey: 'key-1',
});

const artifactOf = (plans, opts = {}) =>
  createArtifact({ plans, mode: 'absolute', planId: 'plan-a', createdAt: '2026-07-19T00:00:00Z', ...opts });

test('an artifact round-trips through JSON unchanged', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'blank-inv-'));
  const file = path.join(dir, 'plan.json');
  const artifact = artifactOf([plan()]);
  await writeJsonAtomic(file, artifact);
  const back = await readJson(file);
  assert.deepEqual(back, artifact);
  assert.doesNotThrow(() => verifyArtifact(back));
});

test('verifyArtifact rejects a hand-edited artifact', () => {
  // The whole point of the hash: an approved plan cannot be quietly widened after approval.
  const artifact = artifactOf([plan()]);
  artifact.groups[0].target = 9999;
  assert.throws(() => verifyArtifact(artifact), /hash mismatch/);
});

test('verifyArtifact rejects an unknown version', () => {
  const artifact = artifactOf([plan()]);
  artifact.version = 99;
  assert.throws(() => verifyArtifact(artifact), /Unsupported plan artifact/);
});

test('verifyArtifact rejects a version-1 artifact specifically', () => {
  // Not covered by the "unknown version" case above: 1 is the version that actually exists on disk
  // from before the vocabulary gained the body axis. Such a plan was grouped on colour+size, which
  // could not tell two garments apart, so executing it would write one garment's count to another's
  // pool. It must be refused outright rather than migrated.
  const artifact = artifactOf([plan()]);
  artifact.version = 1;
  assert.throws(() => verifyArtifact(artifact), /Unsupported plan artifact/);
});

test('the hash ignores member id ordering but not membership', () => {
  const a = artifactOf([plan({ blankId: 'B' })]);
  const b = artifactOf([plan({ blankId: 'B' })]);
  b.groups[0].memberIds = [...b.groups[0].memberIds].reverse();
  assert.equal(hashArtifact(a), hashArtifact(b));
  b.groups[0].memberIds = ['gid://shopify/ProductVariant/999'];
  assert.notEqual(hashArtifact(a), hashArtifact(b));
});

test('narrowArtifact keeps a subset and re-derives keys under a NEW plan id', () => {
  // Reusing the old plan id would reuse its idempotency keys, so a later full re-run could be
  // silently deduped against this narrowed one.
  const artifact = artifactOf([plan({ blankId: 'B1' }), plan({ blankId: 'B2' })]);
  const narrowed = narrowArtifact(artifact, ['B2'], derivedIdempotencyKey, { planId: 'plan-b', createdAt: '2026-07-19T01:00:00Z' });
  assert.equal(narrowed.groups.length, 1);
  assert.equal(narrowed.groups[0].blankId, 'B2');
  assert.equal(narrowed.planId, 'plan-b');
  assert.equal(narrowed.narrowedFrom, 'plan-a');
  assert.notEqual(narrowed.groups[0].idempotencyKey, artifact.groups[1].idempotencyKey);
  assert.doesNotThrow(() => verifyArtifact(narrowed));
});

test('narrowArtifact refuses to produce an empty plan', () => {
  const artifact = artifactOf([plan({ blankId: 'B1' })]);
  assert.throws(() => narrowArtifact(artifact, [], derivedIdempotencyKey), /nothing left to apply/);
});

test('a fresh receipt marks every row not-attempted', () => {
  const receipt = createReceipt(artifactOf([plan({ blankId: 'B1' }), plan({ blankId: 'B2' })]));
  assert.deepEqual(receipt.rows.map((r) => r.status), [ROW_NOT_ATTEMPTED, ROW_NOT_ATTEMPTED]);
  assert.equal(isReceiptComplete(receipt), false);
});

test('a partially applied run is not receipted-complete and reports what is left', () => {
  // The crash-mid-batch case: 3rd of 5 fails, 4 and 5 never attempted.
  const artifact = artifactOf(['B1', 'B2', 'B3', 'B4', 'B5'].map((blankId) => plan({ blankId })));
  const receipt = createReceipt(artifact);
  markRow(receipt, 'B1', ROW_APPLIED);
  markRow(receipt, 'B2', ROW_APPLIED);
  markRow(receipt, 'B3', ROW_FAILED, 'CHANGE_FROM_QUANTITY_STALE');

  assert.deepEqual(receipt.rows.map((r) => r.status), [
    ROW_APPLIED,
    ROW_APPLIED,
    ROW_FAILED,
    ROW_NOT_ATTEMPTED,
    ROW_NOT_ATTEMPTED,
  ]);
  assert.equal(isReceiptComplete(receipt), false, 'a half-applied run must never look finished');
  assert.deepEqual(pendingBlankIds(receipt), ['B3', 'B4', 'B5'], 'the failed row is retried too');
});

test('a fully terminal run is receipted-complete', () => {
  const receipt = createReceipt(artifactOf([plan({ blankId: 'B1' })]));
  markRow(receipt, 'B1', ROW_APPLIED);
  assert.equal(isReceiptComplete(receipt), true);
  assert.deepEqual(pendingBlankIds(receipt), []);
});

test('markRow refuses a blank the receipt does not know', () => {
  const receipt = createReceipt(artifactOf([plan({ blankId: 'B1' })]));
  assert.throws(() => markRow(receipt, 'NOPE', ROW_APPLIED), /no row for blank/);
});

test('pendingSeedBlankIds reports outstanding seeds from seeding receipts only', () => {
  const seeding = createReceipt(artifactOf([plan({ blankId: 'B1' }), plan({ blankId: 'B2' })]));
  seeding.seeding = true;
  markRow(seeding, 'B1', ROW_APPLIED);
  const ordinary = createReceipt(artifactOf([plan({ blankId: 'B9' })]));

  const pending = pendingSeedBlankIds([seeding, ordinary]);
  assert.equal(pending.has('B2'), true, 'B2 still awaits its seed write');
  assert.equal(pending.has('B1'), false, 'B1 was seeded');
  assert.equal(pending.has('B9'), false, 'a non-seeding receipt contributes nothing');
});

test('writeJsonAtomic leaves no temp file behind and creates missing directories', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'blank-inv-'));
  const file = path.join(dir, 'nested', 'receipt.json');
  await writeJsonAtomic(file, { a: 1 });
  const text = await readFile(file, 'utf8');
  assert.equal(JSON.parse(text).a, 1);
  assert.match(text, /\n$/, 'trailing newline');
});

test('writeJsonAtomic overwrites in place across repeated incremental writes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'blank-inv-'));
  const file = path.join(dir, 'receipt.json');
  for (let i = 0; i < 3; i++) await writeJsonAtomic(file, { i });
  assert.equal((await readJson(file)).i, 2);
});
