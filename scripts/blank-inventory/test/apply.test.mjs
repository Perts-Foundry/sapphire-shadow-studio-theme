import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPlan,
  applyPlanInBatches,
  unsettledBlankIds,
  checkDrift,
  DEFAULT_BATCH_SIZE,
  GATE_FAILED,
  DRIFT_TARGET_MOVED,
  DRIFT_BASELINE_MOVED,
  ALREADY_CONVERGED,
} from '../lib/apply.mjs';
import { createArtifact, createReceipt, finalizeReceipt, isReceiptComplete, pendingBlankIds, ROW_APPLIED, ROW_FAILED, ROW_SKIPPED, ROW_NOT_ATTEMPTED } from '../lib/receipt.mjs';
import { CONVERGED, STALE } from '../lib/convergence.mjs';

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

// --- finishedAt -------------------------------------------------------------
// The module header has always promised that "a half-applied run never looks finished". Nothing
// enforced it: the tail assignment was unconditional and only a crash kept it from running.

test('finishedAt stays null while any row is not-attempted, and is set once every row is terminal', () => {
  const receipt = createReceipt(artifactOf(['B1', 'B2']));
  receipt.rows[0].status = ROW_APPLIED;
  finalizeReceipt(receipt);
  assert.equal(receipt.finishedAt, null, 'B2 has not been attempted');

  receipt.rows[1].status = ROW_FAILED;
  finalizeReceipt(receipt);
  assert.ok(receipt.finishedAt, 'a failed row is terminal; the run really did finish');
});

test('finalizeReceipt CLEARS a stale finishedAt rather than leaving it', () => {
  // A resumed run that halts again must not inherit a finishedAt written by an earlier attempt.
  const receipt = createReceipt(artifactOf(['B1', 'B2']));
  receipt.finishedAt = '2026-09-03T00:00:00.000Z';
  finalizeReceipt(receipt);
  assert.equal(receipt.finishedAt, null);
});

test('applyPlan({finalize: false}) leaves finishedAt untouched even when every row is terminal', async () => {
  const artifact = artifactOf(['B1']);
  const receipt = createReceipt(artifact);
  await applyPlan({
    artifact,
    receipt,
    readGroup: async () => asPlanned(),
    write: async () => ({ ok: true, noop: false }),
    persist: async () => {},
    finalize: false,
  });
  assert.equal(receipt.rows[0].status, ROW_APPLIED);
  assert.equal(receipt.finishedAt, null, 'the caller running this loop repeatedly decides when the run is over');
});

// --- batching ---------------------------------------------------------------
// The gate is injected (awaitBatch), so every case below is synchronous and deterministic: no
// clock, no network, no real waiting.

/** A gate that reports every id converged, recording what it was asked about. */
function convergingGate(calls) {
  return async (blankIds) => {
    calls.push([...blankIds]);
    return { verdicts: new Map(blankIds.map((b) => [b, CONVERGED])) };
  };
}

function batchHarness({ artifact, readGroup, write, awaitBatch, receipt: given }) {
  const receipt = given ?? createReceipt(artifact);
  const persisted = [];
  return {
    receipt,
    persisted,
    run: (over = {}) =>
      applyPlanInBatches({
        artifact,
        receipt,
        readGroup,
        write,
        awaitBatch,
        persist: async (r) => persisted.push(structuredClone(r)),
        ...over,
      }),
  };
}

test('the default batch size is 1: no two groups fan out at the same time', () => {
  assert.equal(DEFAULT_BATCH_SIZE, 1);
});

test('nine groups at batchSize 4 are written 4/4/1 and gated three times, the last chunk included', async () => {
  // Gating the final chunk is not free (one extra wait) and it is the difference between `apply`
  // exiting "finished" with the last group mid-storm and exiting when it really is done. finishedAt
  // tracks WRITE status and is orthogonal to convergence, so it cannot stand in for this.
  const ids = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9'];
  const calls = [];
  const h = batchHarness({
    artifact: artifactOf(ids),
    readGroup: async () => asPlanned(),
    write: async () => ({ ok: true, noop: false }),
    awaitBatch: convergingGate(calls),
  });
  const res = await h.run({ batchSize: 4 });
  assert.deepEqual(calls, [['B1', 'B2', 'B3', 'B4'], ['B5', 'B6', 'B7', 'B8'], ['B9']]);
  assert.equal(res.applied, 9);
  assert.equal(res.halted, false);
  assert.equal(isReceiptComplete(res.receipt), true);
  assert.ok(res.receipt.finishedAt);
});

test('the gate is asked ONLY about rows that reached applied, never a skipped or a failed one', async () => {
  // A skipped row was already at target and fired nothing; a failed row never fired. Waiting on
  // either hangs the run forever, because no trigger is ever coming.
  const calls = [];
  const artifact = artifactOf(['ok', 'skipped', 'failed']);
  const h = batchHarness({
    artifact,
    readGroup: async (blankId) => (blankId === 'skipped' ? [mem(1, 12), mem(2, 12)] : asPlanned()),
    write: async (g) =>
      g.blankId === 'failed'
        ? { ok: false, noop: false, code: 'CHANGE_FROM_QUANTITY_STALE', message: 'stale' }
        : { ok: true, noop: false },
    awaitBatch: convergingGate(calls),
  });
  const res = await h.run({ batchSize: 3 });
  assert.deepEqual(calls, [['ok']]);
  assert.deepEqual(res.receipt.rows.map((r) => r.status), [ROW_APPLIED, ROW_SKIPPED, ROW_FAILED]);
  assert.deepEqual(res.receipt.batches[0].appliedBlankIds, ['ok']);
  assert.deepEqual(res.receipt.batches[0].blankIds, ['ok', 'skipped', 'failed'], 'the batch still records what it attempted');
});

test('a write failure mid-chunk still attempts the rest of the chunk, and the gate sees only the applied subset', async () => {
  // Per-row continue-on-error is unchanged by batching: rows 3 and 4 are attempted after row 2
  // fails. What must NOT happen is the gate waiting on row 2, which fired nothing.
  const calls = [];
  const artifact = artifactOf(['B1', 'B2', 'B3', 'B4']);
  const writes = [];
  const h = batchHarness({
    artifact,
    readGroup: async () => asPlanned(),
    write: async (g) => {
      writes.push(g.blankId);
      return g.blankId === 'B2' ? { ok: false, noop: false, code: 'BOOM', message: 'no' } : { ok: true, noop: false };
    },
    awaitBatch: convergingGate(calls),
  });
  const res = await h.run({ batchSize: 4 });
  assert.deepEqual(writes, ['B1', 'B2', 'B3', 'B4'], 'rows 3-4 are attempted after row 2 fails');
  assert.deepEqual(calls, [['B1', 'B3', 'B4']]);
  assert.equal(res.failed, 1);
  assert.equal(res.applied, 3);
});

test('a stale verdict HALTS: later rows stay not-attempted and finishedAt stays null', async () => {
  // Not FAILED. Nothing was tried on them, so nothing failed, and --resume can pick them up
  // unchanged once the stranded group has been repaired.
  const calls = [];
  const artifact = artifactOf(['B1', 'B2', 'B3', 'B4']);
  const writes = [];
  const h = batchHarness({
    artifact,
    readGroup: async () => asPlanned(),
    write: async (g) => {
      writes.push(g.blankId);
      return { ok: true, noop: false };
    },
    awaitBatch: async (blankIds) => {
      calls.push([...blankIds]);
      return { verdicts: new Map(blankIds.map((b) => [b, b === 'B2' ? STALE : CONVERGED])) };
    },
  });
  const res = await h.run({ batchSize: 2 });
  assert.deepEqual(writes, ['B1', 'B2'], 'B3 and B4 are never written');
  assert.equal(res.halted, true);
  assert.deepEqual(res.receipt.rows.map((r) => r.status), [ROW_APPLIED, ROW_APPLIED, ROW_NOT_ATTEMPTED, ROW_NOT_ATTEMPTED]);
  assert.equal(res.receipt.finishedAt, null, 'a run that stopped halfway must not look finished');
  assert.equal(res.receipt.batches.at(-1).halted, true);
  assert.equal(res.receipt.batches.at(-1).verdicts.B2, STALE);
});

test('a missing verdict is treated as stale, not as converged', async () => {
  // Fail closed: a gate that answers about fewer groups than it was asked about has not cleared
  // the ones it left out.
  const h = batchHarness({
    artifact: artifactOf(['B1', 'B2']),
    readGroup: async () => asPlanned(),
    write: async () => ({ ok: true, noop: false }),
    awaitBatch: async () => ({ verdicts: new Map() }),
  });
  const res = await h.run({ batchSize: 2 });
  assert.equal(res.halted, true);
});

test('a resumed batched run rebatches only the remainder', async () => {
  const artifact = artifactOf(['B1', 'B2', 'B3', 'B4']);
  const receipt = createReceipt(artifact);
  receipt.rows[0].status = ROW_APPLIED;
  receipt.rows[1].status = ROW_APPLIED;
  const calls = [];
  const writes = [];
  const h = batchHarness({
    artifact,
    receipt,
    readGroup: async () => asPlanned(),
    write: async (g) => {
      writes.push(g.blankId);
      return { ok: true, noop: false };
    },
    awaitBatch: convergingGate(calls),
  });
  await h.run({ batchSize: 1, only: pendingBlankIds(receipt) });
  assert.deepEqual(writes, ['B3', 'B4']);
  assert.deepEqual(calls, [['B3'], ['B4']]);
});

test('a resume whose receipt records a halted, still-unconverged group REFUSES before any write', async () => {
  // The blocker the plan review found. Without this drain, a halt followed by --resume reproduces
  // the original incident one group at a time: the halted group's re-triggered runs are still
  // draining when the next write fires.
  const artifact = artifactOf(['B1', 'B2']);
  const receipt = createReceipt(artifact);
  receipt.rows[0].status = ROW_APPLIED;
  receipt.batches = [{ index: 0, blankIds: ['B1'], appliedBlankIds: ['B1'], verdicts: { B1: STALE }, halted: true }];
  const writes = [];
  await assert.rejects(
    applyPlanInBatches({
      artifact,
      receipt,
      readGroup: async () => asPlanned(),
      write: async (g) => {
        writes.push(g.blankId);
        return { ok: true, noop: false };
      },
      persist: async () => {},
      awaitBatch: async (ids) => ({ verdicts: new Map(ids.map((b) => [b, STALE])) }),
      only: pendingBlankIds(receipt),
    }),
    /still not converged[\s\S]*repair/
  );
  assert.deepEqual(writes, [], 'not one write may be issued while an earlier batch is still draining');
});

test('a resume whose halted group HAS since converged drains clean and proceeds', async () => {
  const artifact = artifactOf(['B1', 'B2']);
  const receipt = createReceipt(artifact);
  receipt.rows[0].status = ROW_APPLIED;
  receipt.batches = [{ index: 0, blankIds: ['B1'], appliedBlankIds: ['B1'], verdicts: { B1: STALE }, halted: true }];
  const calls = [];
  const h = batchHarness({
    artifact,
    receipt,
    readGroup: async () => asPlanned(),
    write: async () => ({ ok: true, noop: false }),
    awaitBatch: convergingGate(calls),
  });
  await h.run({ only: pendingBlankIds(receipt) });
  assert.deepEqual(calls, [['B1'], ['B2']], 'the drain runs first, then the batch gate');
});

test('unsettledBlankIds takes the LATEST verdict per blank, so a later clean batch supersedes an earlier halt', () => {
  const receipt = {
    batches: [
      { verdicts: { B1: STALE, B2: CONVERGED }, halted: true },
      { verdicts: { B1: CONVERGED }, halted: false },
    ],
  };
  assert.deepEqual(unsettledBlankIds(receipt), []);
  assert.deepEqual(unsettledBlankIds({ batches: [{ verdicts: { B1: STALE } }] }), ['B1']);
  assert.deepEqual(unsettledBlankIds({}), [], 'a fresh receipt records no batches at all');
});

test('gate:false writes everything in one pass and calls the gate zero times (--no-batch)', async () => {
  const calls = [];
  const h = batchHarness({
    artifact: artifactOf(['B1', 'B2', 'B3']),
    readGroup: async () => asPlanned(),
    write: async () => ({ ok: true, noop: false }),
    awaitBatch: convergingGate(calls),
  });
  const res = await h.run({ batchSize: Infinity, gate: false });
  assert.deepEqual(calls, []);
  assert.equal(res.applied, 3);
  assert.equal(res.receipt.batches.length, 1);
  assert.deepEqual(res.receipt.batches[0].verdicts, {}, 'an ungated batch claims no convergence');
});

test('the receipt hits disk at every batch boundary, not once at the end', async () => {
  const artifact = artifactOf(['B1', 'B2']);
  const h = batchHarness({
    artifact,
    readGroup: async () => asPlanned(),
    write: async () => ({ ok: true, noop: false }),
    awaitBatch: convergingGate([]),
  });
  await h.run({ batchSize: 1 });
  // A persist carrying exactly one batch entry proves the boundary reached disk before the second
  // group was written: this is the record the next incident is reconstructed from.
  const boundary = h.persisted.find((r) => r.batches?.length === 1);
  assert.ok(boundary, 'a persist carrying the first batch entry exists');
  assert.deepEqual(boundary.rows.map((r) => r.status), [ROW_APPLIED, ROW_NOT_ATTEMPTED]);
  assert.equal(h.persisted.at(-1).batches.length, 2, 'and the last write on disk carries both batches');
});

test('a gate that THROWS still records the batch, so a later resume has something to drain', async () => {
  // The hole this closes: the rows are already durably `applied` (applyPlan persists per row), so
  // the writes landed and their fan-out is in flight. If the throw escaped before the batch entry
  // was pushed, the receipt would record no entry at all, `unsettledBlankIds` would find nothing,
  // and the next --resume would sail past the drain into the following batch's writes: the original
  // incident, reproduced through the mechanism built to prevent it.
  const artifact = artifactOf(['B1', 'B2']);
  const receipt = createReceipt(artifact);
  const persisted = [];
  const writes = [];
  await assert.rejects(
    applyPlanInBatches({
      artifact,
      receipt,
      readGroup: async () => asPlanned(),
      write: async (g) => {
        writes.push(g.blankId);
        return { ok: true, noop: false };
      },
      persist: async (r) => persisted.push(structuredClone(r)),
      awaitBatch: async () => {
        throw new Error('Admin API read failed');
      },
      batchSize: 1,
    }),
    /convergence gate failed[\s\S]*--resume/
  );

  assert.deepEqual(writes, ['B1'], 'the run stops at the batch whose gate failed');
  assert.equal(receipt.rows[0].status, ROW_APPLIED, 'that write DID land and must stay recorded');
  assert.equal(receipt.batches.length, 1, 'the batch entry reached the receipt despite the throw');
  assert.equal(receipt.batches[0].verdicts.B1, GATE_FAILED);
  assert.equal(receipt.batches[0].halted, true);
  assert.match(receipt.batches[0].gateError, /Admin API read failed/);
  assert.ok(
    persisted.some((r) => r.batches?.length === 1),
    'and it reached DISK, not just the in-memory receipt'
  );
  assert.deepEqual(unsettledBlankIds(receipt), ['B1'], 'so the next resume drains it');
});

test('a gate-failed verdict is distinct from stale but treated the same way by the drain', () => {
  // Different meanings: STALE means the store was read and had not converged; GATE_FAILED means the
  // store could not be read, so convergence is unknown. Both are outstanding.
  assert.notEqual(GATE_FAILED, STALE);
  assert.deepEqual(unsettledBlankIds({ batches: [{ verdicts: { B1: GATE_FAILED } }] }), ['B1']);
});

test('the resume drain runs even with gate:false, because it is an absolute and not a pacing preference', async () => {
  // An operator could reasonably expect --no-batch to skip all waiting. It does not skip THIS wait:
  // refusing to write on top of a group an earlier batch left unconverged is not pacing.
  const artifact = artifactOf(['B1', 'B2']);
  const receipt = createReceipt(artifact);
  receipt.rows[0].status = ROW_APPLIED;
  receipt.batches = [{ index: 0, blankIds: ['B1'], appliedBlankIds: ['B1'], verdicts: { B1: STALE }, halted: true }];
  const writes = [];
  await assert.rejects(
    applyPlanInBatches({
      artifact,
      receipt,
      readGroup: async () => asPlanned(),
      write: async (g) => {
        writes.push(g.blankId);
        return { ok: true, noop: false };
      },
      persist: async () => {},
      awaitBatch: async (ids) => ({ verdicts: new Map(ids.map((b) => [b, STALE])) }),
      batchSize: Infinity,
      gate: false,
      only: pendingBlankIds(receipt),
    }),
    /still not converged/
  );
  assert.deepEqual(writes, []);
});

test('a resume against a fully applied receipt writes nothing and still finalizes cleanly', async () => {
  const artifact = artifactOf(['B1', 'B2']);
  const receipt = createReceipt(artifact);
  receipt.rows.forEach((r) => (r.status = ROW_APPLIED));
  const calls = [];
  const writes = [];
  const res = await applyPlanInBatches({
    artifact,
    receipt,
    readGroup: async () => asPlanned(),
    write: async (g) => {
      writes.push(g.blankId);
      return { ok: true, noop: false };
    },
    persist: async () => {},
    awaitBatch: convergingGate(calls),
    only: pendingBlankIds(receipt),
  });
  assert.deepEqual(writes, []);
  assert.deepEqual(calls, [], 'nothing fired, so nothing is waited on');
  assert.equal(res.applied, 2);
  assert.ok(res.receipt.finishedAt, 'every row is terminal, so the run really is finished');
});

test('an already-applied row is NOT re-announced by every later batch', async () => {
  // Quadratic output: each batch re-walks the whole artifact, so the `only` filter has to be checked
  // BEFORE the already-applied short-circuit. At batch size 1 a 27-group run printed roughly 350
  // spurious APPLIED lines, which is exactly what buries the HALTED line during an incident.
  const artifact = artifactOf(['B1', 'B2', 'B3', 'B4']);
  const events = [];
  const h = batchHarness({
    artifact,
    readGroup: async () => asPlanned(),
    write: async () => ({ ok: true, noop: false }),
    awaitBatch: convergingGate([]),
  });
  await h.run({ batchSize: 1, onRow: (e) => events.push(e) });
  assert.equal(events.length, 4, 'one event per group, not one per group per remaining batch');
  assert.deepEqual(events.map((e) => e.blankId), ['B1', 'B2', 'B3', 'B4']);
  assert.ok(!events.some((e) => e.resumed), 'and none of them is a resumed re-announcement');
});

test('a non-whole or non-positive batch size is refused rather than silently producing no chunks', async () => {
  const artifact = artifactOf(['B1']);
  for (const batchSize of [0, -1, 1.5, NaN]) {
    await assert.rejects(
      applyPlanInBatches({
        artifact,
        receipt: createReceipt(artifact),
        readGroup: async () => asPlanned(),
        write: async () => ({ ok: true, noop: false }),
        persist: async () => {},
        awaitBatch: convergingGate([]),
        batchSize,
      }),
      /positive whole number/
    );
  }
});

test('applyPlanInBatches refuses to run with no gate function at all', async () => {
  // There is no unpaced fallback: a caller that forgot the gate would silently be the old behaviour.
  const artifact = artifactOf(['B1']);
  await assert.rejects(
    applyPlanInBatches({
      artifact,
      receipt: createReceipt(artifact),
      readGroup: async () => asPlanned(),
      write: async () => ({ ok: true, noop: false }),
      persist: async () => {},
    }),
    /awaitBatch/
  );
});

test('a group excluded by `only` is not read, not written, and its receipt row is untouched', async () => {
  const artifact = artifactOf(['B1', 'B2']);
  const reads = [];
  const writes = [];
  const receipt = createReceipt(artifact);
  await applyPlan({
    artifact,
    receipt,
    readGroup: async (blankId) => {
      reads.push(blankId);
      return asPlanned();
    },
    write: async (g) => {
      writes.push(g.blankId);
      return { ok: true, noop: false };
    },
    persist: async () => {},
    only: ['B2'],
  });
  assert.deepEqual(reads, ['B2']);
  assert.deepEqual(writes, ['B2']);
  assert.equal(receipt.rows[0].status, ROW_NOT_ATTEMPTED, 'B1 must be left exactly as it was');
});
