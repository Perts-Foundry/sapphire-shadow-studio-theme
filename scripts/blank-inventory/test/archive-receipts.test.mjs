// The receipt archive step, against a real directory.
//
// WHY THIS SUITE EXISTS SEPARATELY. Everything else in this tree is tested through injected seams,
// and the decision half of this feature (receiptsToArchive) is a pure function tested in
// observability.test.mjs. What is left is exactly the part no seam can reach: mkdir, rename, a
// source file that vanished between the read and the move, a name already present in the archive,
// and the promise that an archived receipt is never read again. Those are filesystem behaviours, so
// they are exercised on the filesystem.
//
// BLANK_INVENTORY_DIR is set to a temp directory BEFORE the CLI module is imported, because the
// module resolves its working directory once at import time. The import is therefore dynamic: a
// static import hoists above the assignment and would point this suite at the operator's own
// working directory, which holds live artifacts.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SEED_RECEIPT_MAX_AGE_MS } from '../lib/receipt.mjs';

const workDir = await mkdtemp(path.join(os.tmpdir(), 'blank-inventory-archive-'));
process.env.BLANK_INVENTORY_DIR = workDir;

/** @type {{loadReceipts: Function, archiveStaleSeedReceipts: Function}} */
let cli;
const archiveDir = path.join(workDir, 'archive');

before(async () => {
  cli = await import('../blank-inventory.mjs');
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
});

/** A seeding receipt of a given age, written where loadReceipts will find it. */
async function writeReceipt(file, { ageMs, seeding = true, blankId = 'BLACK_ACME_BLANKA_0001_M', status = 'not-attempted' }, dir = workDir) {
  const receipt = {
    planId: file,
    mode: 'absolute',
    seeding,
    startedAt: new Date(Date.now() - ageMs).toISOString(),
    finishedAt: null,
    rows: [{ blankId, writeTargetId: 'gid://shopify/ProductVariant/1', target: 4, status, detail: null, at: null }],
  };
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return receipt;
}

const DAY = SEED_RECEIPT_MAX_AGE_MS;
const load = () => cli.loadReceipts();
const archive = async () => {
  const { receipts, staleSeeds } = await load();
  return cli.archiveStaleSeedReceipts([...receipts, ...staleSeeds]);
};

test('an expired seeding receipt is moved into archive/, which is created on demand', async () => {
  await writeReceipt('receipt-seed-old.json', { ageMs: DAY + 60_000 });
  assert.equal(existsSync(archiveDir), false, 'the archive is created only when there is something to put in it');

  const result = await archive();

  assert.deepEqual(result.archived.map((r) => r.sourceFile), ['receipt-seed-old.json']);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(await readdir(archiveDir), ['receipt-seed-old.json']);
  assert.equal(existsSync(path.join(workDir, 'receipt-seed-old.json')), false);
});

test('a fresh seeding receipt is left in place and still explains its group', async () => {
  // The failure this guards: archiving a fresh seeding receipt would make a group mid-fan-out read
  // as DRIFT, which is the one report the operator is told to stop and troubleshoot on.
  await writeReceipt('receipt-seed-fresh.json', { ageMs: 60_000 });
  await writeReceipt('receipt-seed-old.json', { ageMs: DAY + 60_000 });

  const result = await archive();

  assert.deepEqual(result.archived.map((r) => r.sourceFile), ['receipt-seed-old.json']);
  assert.equal(existsSync(path.join(workDir, 'receipt-seed-fresh.json')), true);

  const { receipts, staleSeeds } = await load();
  assert.deepEqual(receipts.map((r) => r.sourceFile), ['receipt-seed-fresh.json']);
  assert.deepEqual(staleSeeds, [], 'the expired one is gone from the root, so it is no longer read at all');
});

test('a non-seeding receipt is never archived, however old', async () => {
  await writeReceipt('receipt-apply-ancient.json', { ageMs: DAY * 400, seeding: false, status: 'applied' });

  const result = await archive();

  assert.deepEqual(result.archived, []);
  assert.equal(existsSync(path.join(workDir, 'receipt-apply-ancient.json')), true);
  assert.equal(existsSync(archiveDir), false);
});

test('a second run archives nothing and reports nothing', async () => {
  await writeReceipt('receipt-seed-old.json', { ageMs: DAY + 60_000 });
  await archive();

  const second = await archive();
  assert.deepEqual(second, { archived: [], skipped: [] }, 'an empty result is what keeps the report silent');
});

test('a source file that has already gone is skipped, and the other moves still happen', async () => {
  // The partial-earlier-run case. Reported rather than thrown: one unmovable file must not abandon
  // the audit or the rest of the moves.
  await writeReceipt('receipt-seed-old.json', { ageMs: DAY + 60_000 });
  const { receipts, staleSeeds } = await load();
  const vanished = { ...staleSeeds[0], planId: 'gone', sourceFile: 'receipt-seed-vanished.json' };

  const result = await cli.archiveStaleSeedReceipts([...receipts, ...staleSeeds, vanished]);

  assert.deepEqual(result.archived.map((r) => r.sourceFile), ['receipt-seed-old.json']);
  assert.deepEqual(result.skipped.map((s) => s.file), ['receipt-seed-vanished.json']);
  assert.equal(result.skipped[0].reason, 'ENOENT');
});

test('a name already in the archive keeps the archived copy rather than overwriting it', async () => {
  // rename() overwrites its destination silently on POSIX. A receipt is immutable once written, so
  // the same name is the same content and the archived copy is the one to keep.
  await writeReceipt('receipt-seed-old.json', { ageMs: DAY + 60_000 }, archiveDir);
  await writeReceipt('receipt-seed-old.json', { ageMs: DAY + 60_000 });

  const result = await archive();

  assert.deepEqual(result.archived, []);
  assert.deepEqual(result.skipped.map((s) => s.file), ['receipt-seed-old.json']);
  assert.match(result.skipped[0].reason, /already in the archive/);
  assert.equal(existsSync(path.join(workDir, 'receipt-seed-old.json')), true, 'the source is left alone, never deleted');
});

test('a receipt inside archive/ is not loaded, so an archived one can never explain a group again', async () => {
  // Locks in that the reader globs the working directory root and does not recurse. If it ever did,
  // archiving would stop meaning anything: every moved receipt would go on being read.
  await writeReceipt('receipt-seed-fresh.json', { ageMs: 60_000 }, archiveDir);

  const { receipts, staleSeeds } = await load();
  assert.deepEqual(receipts, []);
  assert.deepEqual(staleSeeds, []);
});

test('an absent working directory is not an error', async () => {
  await rm(workDir, { recursive: true, force: true });
  assert.deepEqual(await load(), { receipts: [], staleSeeds: [] });
  assert.deepEqual(await archive(), { archived: [], skipped: [] });
});
