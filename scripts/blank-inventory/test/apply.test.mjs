import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPlan, checkDrift, DRIFT_TARGET_MOVED, DRIFT_BASELINE_MOVED, ALREADY_CONVERGED } from '../lib/apply.mjs';
import { createArtifact, createReceipt, isReceiptComplete, pendingBlankIds, ROW_APPLIED, ROW_FAILED, ROW_SKIPPED, ROW_NOT_ATTEMPTED } from '../lib/receipt.mjs';

const V = (n) => `gid://shopify/ProductVariant/${n}`;
const mem = (n, quantity) => ({ id: V(n), quantity, blankId: 'B', productHandle: 'p', title: 't', inventoryItemId: `ii-${n}` });

const planRow = (blankId, over = {}) => ({
  blankId,
  target: over.target ?? 12,
  current: 11,
  baseline: over.baseline ?? 11,
  delta: over.delta ?? null,
  writeTargetId: over.writeTargetId ?? V(1),
  writeTargetTitle: 'p | t',
  inventoryItemId: 'ii-1',
  memberIds: [V(1), V(2)],
  siblingCount: 1,
  idempotencyKey: `key-${blankId}`,
});

const artifactOf = (blankIds, over = {}) =>
  createArtifact({ plans: blankIds.map((b) => planRow(b, over)), mode: 'absolute', planId: 'plan-a' });

/** A group that still looks exactly as planned. */
const asPlanned = () => [mem(1, 11), mem(2, 11)];

function harness({ artifact, readGroup, write }) {
  const receipt = createReceipt(artifact);
  const persisted = [];
  return {
    receipt,
    persisted,
    run: (only) =>
      applyPlan({
        artifact,
        receipt,
        readGroup,
        write,
        persist: async (r) => persisted.push(structuredClone(r)),
        only,
      }),
  };
}

// --- drift checking ---------------------------------------------------------

test('checkDrift allows a write when the group is unchanged', () => {
  assert.equal(checkDrift(planRow('B'), asPlanned()).action, 'write');
});

test('checkDrift skips a group that already reached the target', () => {
  const d = checkDrift(planRow('B'), [mem(1, 12), mem(2, 12)]);
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, ALREADY_CONVERGED);
});

test('checkDrift REFUSES when the correct write target moved to a different variant', () => {
  // The approved variant converged on its own, so the right target is now variant 2. Writing
  // anyway would hit a variant the operator never approved, and CAS would not catch it because CAS
  // guards the value on a variant, not the choice of variant.
  const d = checkDrift(planRow('B'), [mem(1, 12), mem(2, 11)]);
  assert.equal(d.action, 'refuse');
  assert.equal(d.reason, DRIFT_TARGET_MOVED);
  assert.match(d.detail, /Re-plan/);
});

test('checkDrift REFUSES when the baseline moved under the approved target', () => {
  const d = checkDrift(planRow('B'), [mem(1, 9), mem(2, 11)]);
  assert.equal(d.action, 'refuse');
  assert.equal(d.reason, DRIFT_BASELINE_MOVED);
});

test('checkDrift refuses a group that lost all its tags', () => {
  assert.equal(checkDrift(planRow('B'), []).action, 'refuse');
});

// --- the loop ---------------------------------------------------------------

test('a clean run applies every group and is receipted-complete', async () => {
  const h = harness({
    artifact: artifactOf(['B1', 'B2', 'B3']),
    readGroup: async () => asPlanned(),
    write: async () => ({ ok: true, noop: false }),
  });
  const res = await h.run();
  assert.equal(res.applied, 3);
  assert.equal(res.failed, 0);
  assert.equal(isReceiptComplete(res.receipt), true);
});

test('a failure on group 3 of 5 leaves 1-2 applied, 3 failed, 4-5 attempted after it', async () => {
  // Per-row continue-on-error: one stale baseline must not abandon the remaining groups.
  const artifact = artifactOf(['B1', 'B2', 'B3', 'B4', 'B5']);
  const h = harness({
    artifact,
    readGroup: async () => asPlanned(),
    write: async (g) =>
      g.blankId === 'B3'
        ? { ok: false, noop: false, code: 'CHANGE_FROM_QUANTITY_STALE', message: 'stale' }
        : { ok: true, noop: false },
  });
  const res = await h.run();
  assert.deepEqual(res.receipt.rows.map((r) => r.status), [ROW_APPLIED, ROW_APPLIED, ROW_FAILED, ROW_APPLIED, ROW_APPLIED]);
  assert.equal(res.applied, 4);
  assert.equal(res.failed, 1);
  assert.match(res.receipt.rows[2].detail, /CHANGE_FROM_QUANTITY_STALE/);
});

test('a crash mid-run leaves a parseable receipt that is NOT complete', async () => {
  const artifact = artifactOf(['B1', 'B2', 'B3', 'B4', 'B5']);
  const h = harness({
    artifact,
    readGroup: async () => asPlanned(),
    write: async (g) => {
      if (g.blankId === 'B3') throw Object.assign(new Error('process died'), { fatal: true });
      return { ok: true, noop: false };
    },
  });
  const res = await h.run();
  // The thrown error is captured as a row failure rather than killing the run.
  assert.equal(res.receipt.rows[2].status, ROW_FAILED);
  assert.match(res.receipt.rows[2].detail, /process died/);

  // Simulate the harder case: persistence stopped after row 2.
  const partial = h.persisted[1];
  assert.deepEqual(partial.rows.map((r) => r.status), [ROW_APPLIED, ROW_APPLIED, ROW_NOT_ATTEMPTED, ROW_NOT_ATTEMPTED, ROW_NOT_ATTEMPTED]);
  assert.equal(isReceiptComplete(partial), false, 'a half-applied run must never look finished');
  assert.deepEqual(pendingBlankIds(partial), ['B3', 'B4', 'B5']);
});

test('the receipt is persisted after every row, not once at the end', async () => {
  const h = harness({
    artifact: artifactOf(['B1', 'B2', 'B3']),
    readGroup: async () => asPlanned(),
    write: async () => ({ ok: true, noop: false }),
  });
  await h.run();
  assert.equal(h.persisted.length, 4, 'three rows plus the final finishedAt write');
});

test('a resumed run skips rows already applied and does not rewrite them', async () => {
  const artifact = artifactOf(['B1', 'B2']);
  const writes = [];
  const receipt = createReceipt(artifact);
  receipt.rows[0].status = ROW_APPLIED;

  const res = await applyPlan({
    artifact,
    receipt,
    readGroup: async () => asPlanned(),
    write: async (g) => {
      writes.push(g.blankId);
      return { ok: true, noop: false };
    },
    persist: async () => {},
  });
  assert.deepEqual(writes, ['B2'], 'B1 must not be written twice');
  assert.equal(res.applied, 2, 'the already-applied row still counts as applied');
});

test('a failed row is retried on a resumed run', async () => {
  const artifact = artifactOf(['B1', 'B2']);
  const receipt = createReceipt(artifact);
  receipt.rows[0].status = ROW_FAILED;
  const writes = [];
  await applyPlan({
    artifact,
    receipt,
    readGroup: async () => asPlanned(),
    write: async (g) => {
      writes.push(g.blankId);
      return { ok: true, noop: false };
    },
    persist: async () => {},
    only: pendingBlankIds(receipt),
  });
  assert.ok(writes.includes('B1'), 'CAS plus the derived key make a retry safe');
});

test('a no-op write is recorded as a FAILURE, not a success', async () => {
  // inventoryAdjustmentGroup: null means nothing moved and the Flow never fired. Calling that
  // success would report a converged group that is actually still stale.
  const h = harness({
    artifact: artifactOf(['B1']),
    readGroup: async () => asPlanned(),
    write: async () => ({ ok: true, noop: true }),
  });
  const res = await h.run();
  assert.equal(res.failed, 1);
  assert.match(res.receipt.rows[0].detail, /no-op/);
});

test('a read failure is contained to its own row', async () => {
  const h = harness({
    artifact: artifactOf(['B1', 'B2']),
    readGroup: async (blankId) => {
      if (blankId === 'B1') throw new Error('network hiccup');
      return asPlanned();
    },
    write: async () => ({ ok: true, noop: false }),
  });
  const res = await h.run();
  assert.equal(res.receipt.rows[0].status, ROW_FAILED);
  assert.equal(res.receipt.rows[1].status, ROW_APPLIED);
});

test('drift refusal is recorded per row and does not stop the run', async () => {
  const h = harness({
    artifact: artifactOf(['B1', 'B2']),
    readGroup: async (blankId) => (blankId === 'B1' ? [mem(1, 9), mem(2, 11)] : asPlanned()),
    write: async () => ({ ok: true, noop: false }),
  });
  const res = await h.run();
  assert.equal(res.receipt.rows[0].status, ROW_FAILED);
  assert.match(res.receipt.rows[0].detail, new RegExp(DRIFT_BASELINE_MOVED));
  assert.equal(res.receipt.rows[1].status, ROW_APPLIED);
});

test('an already-converged group is a reported SKIP, not a wasted write', async () => {
  const writes = [];
  const h = harness({
    artifact: artifactOf(['B1']),
    readGroup: async () => [mem(1, 12), mem(2, 12)],
    write: async (g) => {
      writes.push(g.blankId);
      return { ok: true, noop: false };
    },
  });
  const res = await h.run();
  assert.equal(res.skipped, 1);
  assert.equal(writes.length, 0);
  assert.equal(res.receipt.rows[0].status, ROW_SKIPPED);
});
