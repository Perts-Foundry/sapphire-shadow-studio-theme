// Re-planning a stranded fan-out.
//
// Every fixture here is synthetic, from test/fixtures.mjs's vocabulary. Writing up an incident is
// the easiest place in this repo to paste a real blank id, and this is the suite that models one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  repairPlans,
  assessReceiptAge,
  receiptWrittenAt,
  REPAIR_SKIP_CONVERGED,
  REPAIR_REFUSE_NOT_APPLIED,
  REPAIR_REFUSE_NO_MEMBERS,
  REPAIR_REFUSE_SPREAD,
  REPAIR_REFUSE_NO_TARGET_MEMBER,
  REPAIR_RECEIPT_WARN_AGE_MS,
  REPAIR_RECEIPT_MAX_AGE_MS,
  AGE_FRESH,
  AGE_WARN,
  AGE_REFUSE,
} from '../lib/repair.mjs';
import {
  createArtifact,
  verifyArtifact,
  assertRenderablePlan,
  receiptArtifactMismatch,
  ROW_APPLIED,
  ROW_FAILED,
  ROW_NOT_ATTEMPTED,
  ROW_SKIPPED,
} from '../lib/receipt.mjs';
import { derivedIdempotencyKey } from '../lib/planner.mjs';
import { MODE_ABSOLUTE } from '../lib/input.mjs';
import { strandedGroup, blankIdFor, resetSeq } from './fixtures.mjs';

const STRANDED = blankIdFor('crewneck', 'Grey Heather', '2XL');
const OTHER = blankIdFor('crewneck', 'Black', 'M');
/** A blank the live store has no tagged variants for. */
const UNTAGGED = blankIdFor('quarter-zip', 'Black', 'M');

const row = (blankId, target, status = ROW_APPLIED) => ({ blankId, target, status, detail: null, at: '2026-09-03T12:00:00.000Z' });

/** One group, stranded: a single member at the approved target and seven still on the old value. */
function strandedStore({ target = 12, stale = 11, atTargetIndex = 0 } = {}) {
  resetSeq(100);
  return new Map([[STRANDED, strandedGroup({ target, stale, atTargetIndex })]]);
}

// --- the target comes from the receipt --------------------------------------

test('the repair target is the RECEIPT value, not the value most live members hold', () => {
  // The load-bearing case. On a stranded group of 8 with one member at 12 and seven at 11, every
  // live-state heuristic (majority, mode, histogram peak) returns 11, which silently rolls the
  // approved change back on the one member that did converge. It is the obvious implementation and
  // it is exactly backwards.
  const { plans, skipped, refused } = repairPlans({
    rows: [row(STRANDED, 12)],
    groups: strandedStore({ target: 12, stale: 11 }),
    planId: 'repair-1',
  });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].target, 12);
  assert.notEqual(plans[0].target, 11, 'the seven-member majority value must never become the target');
  assert.deepEqual(skipped, []);
  assert.deepEqual(refused, []);
});

test('a stranded group yields exactly ONE plan row, not one per straggler', () => {
  // Seven stragglers do not mean seven writes. The plan targets one member holding the old value
  // and the Flow fans the change out to the rest; writing each straggler would be the amplification
  // this whole change exists to avoid.
  const { plans } = repairPlans({
    rows: [row(STRANDED, 12)],
    groups: strandedStore({ target: 12, stale: 11, atTargetIndex: 3 }),
    planId: 'repair-1',
  });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].siblingCount, 7, 'the Flow updates the other seven');
});

test('the write target is a member holding the OLD value, never the one already at target', () => {
  // Mechanic 1, unchanged: a write to a member already at the target returns no adjustment group,
  // fires no trigger, and leaves the group exactly as stranded as it was.
  const groups = strandedStore({ target: 12, stale: 11, atTargetIndex: 0 });
  const members = groups.get(STRANDED);
  const converged = members.find((m) => m.quantity === 12);
  const { plans } = repairPlans({ rows: [row(STRANDED, 12)], groups, planId: 'repair-1' });
  assert.notEqual(plans[0].writeTargetId, converged.id);
  assert.equal(members.find((m) => m.id === plans[0].writeTargetId).quantity, 11);
});

test('baseline is the chosen member LIVE quantity, and is distinct from the target', () => {
  // Wiring the baseline to the approved target would make compare-and-swap compare the target
  // against itself, which passes on a member already holding it and silently defeats the one guard
  // between this command and a sale landing between the read and the write.
  const { plans } = repairPlans({ rows: [row(STRANDED, 12)], groups: strandedStore(), planId: 'repair-1' });
  assert.equal(plans[0].baseline, 11);
  assert.notEqual(plans[0].baseline, plans[0].target);
});

test('the repair is absolute mode, whatever the original plan was', () => {
  // The original delta was consumed by the write that landed; re-applying it would double it.
  const { plans } = repairPlans({ rows: [row(STRANDED, 12)], groups: strandedStore(), planId: 'repair-1' });
  assert.equal(plans[0].mode, MODE_ABSOLUTE);
  assert.equal(plans[0].delta, null);
});

test('idempotency keys differ from the original run, so a repair cannot be deduped against it', () => {
  const original = derivedIdempotencyKey({ planId: 'plan-a', blankId: STRANDED, target: 12, mode: MODE_ABSOLUTE });
  const { plans } = repairPlans({ rows: [row(STRANDED, 12)], groups: strandedStore(), planId: 'repair-1' });
  assert.notEqual(plans[0].idempotencyKey, original);
});

// --- refusals ---------------------------------------------------------------

test('a three-way spread is refused: that is not a stranded fan-out', () => {
  resetSeq(200);
  const members = strandedGroup({ target: 12, stale: 11 });
  members[2].quantity = 9;
  const { plans, refused } = repairPlans({ rows: [row(STRANDED, 12)], groups: new Map([[STRANDED, members]]), planId: 'r' });
  assert.deepEqual(plans, []);
  assert.equal(refused[0].reason, REPAIR_REFUSE_SPREAD);
  assert.match(refused[0].detail, /exactly two/);
});

test('a group where NO member holds the approved target is refused', () => {
  // Something moved after the write, so finishing the fan-out would propagate a value the operator
  // never approved.
  resetSeq(300);
  const members = strandedGroup({ target: 13, stale: 11 });
  const { plans, refused } = repairPlans({ rows: [row(STRANDED, 12)], groups: new Map([[STRANDED, members]]), planId: 'r' });
  assert.deepEqual(plans, []);
  assert.equal(refused[0].reason, REPAIR_REFUSE_NO_TARGET_MEMBER);
});

test('a uniform group sitting at the wrong value is refused, not silently re-written', () => {
  resetSeq(310);
  const members = strandedGroup({ target: 9, stale: 9 });
  const { plans, refused } = repairPlans({ rows: [row(STRANDED, 12)], groups: new Map([[STRANDED, members]]), planId: 'r' });
  assert.deepEqual(plans, []);
  assert.equal(refused[0].reason, REPAIR_REFUSE_NO_TARGET_MEMBER);
  assert.match(refused[0].detail, /moved after the write/);
});

test('a receipt row that never reached applied is refused and pointed at --resume', () => {
  // No write fired, so there is no half-finished fan-out to finish. Re-running the ORIGINAL
  // artifact is the right answer, and a repair would write a target nothing has attempted.
  for (const status of [ROW_FAILED, ROW_NOT_ATTEMPTED, ROW_SKIPPED]) {
    const { plans, refused } = repairPlans({
      rows: [row(STRANDED, 12, status)],
      groups: strandedStore(),
      planId: 'r',
    });
    assert.deepEqual(plans, [], `${status} must not be planned`);
    assert.equal(refused[0].reason, REPAIR_REFUSE_NOT_APPLIED);
    assert.match(refused[0].detail, /--resume/);
  }
});

test('a group that lost every tag is refused rather than planned against nothing', () => {
  const { plans, refused } = repairPlans({ rows: [row(STRANDED, 12)], groups: new Map(), planId: 'r' });
  assert.deepEqual(plans, []);
  assert.equal(refused[0].reason, REPAIR_REFUSE_NO_MEMBERS);
});

test('a converged group is enumerated as skipped, never silently absent', () => {
  // To an operator scanning gate 5, a silently omitted group and an overlooked one look identical.
  resetSeq(400);
  const members = strandedGroup({ target: 12, stale: 12 });
  const { plans, skipped } = repairPlans({ rows: [row(STRANDED, 12)], groups: new Map([[STRANDED, members]]), planId: 'r' });
  assert.deepEqual(plans, []);
  assert.deepEqual(skipped, [{ blankId: STRANDED, reason: REPAIR_SKIP_CONVERGED, current: 12, target: 12 }]);
});

test('every receipt row appears in exactly one of plans, skipped or refused', () => {
  resetSeq(500);
  const groups = new Map([
    [STRANDED, strandedGroup({ target: 12, stale: 11 })],
    [OTHER, strandedGroup({ target: 5, stale: 5, color: 'Black', size: 'M' })],
  ]);
  const rows = [row(STRANDED, 12), row(OTHER, 5), row(UNTAGGED, 3), row(STRANDED, 12, ROW_FAILED)];
  const { plans, skipped, refused } = repairPlans({ rows, groups, planId: 'r' });
  assert.equal(plans.length + skipped.length + refused.length, rows.length);
});

test('an empty receipt yields an empty artifact rather than an error', () => {
  const { plans, skipped, refused } = repairPlans({ rows: [], groups: new Map(), planId: 'r' });
  assert.deepEqual([plans, skipped, refused], [[], [], []]);
});

// --- the artifact it produces -----------------------------------------------

test('a repair artifact verifies and renders like any other plan', () => {
  const { plans, skipped, refused } = repairPlans({ rows: [row(STRANDED, 12)], groups: strandedStore(), planId: 'repair-1' });
  const artifact = createArtifact({ plans, skipped: [...skipped, ...refused], mode: MODE_ABSOLUTE, planId: 'repair-1' });
  assert.doesNotThrow(() => assertRenderablePlan(verifyArtifact(artifact)));
});

test('repairedFrom sits OUTSIDE the hash: two artifacts differing only in provenance hash identically', () => {
  // Same reason narrowedFrom does. Provenance is for the human at gate 5; the hash is the promise
  // that the writes were not edited after approval, and those are different questions.
  const build = () =>
    createArtifact({
      plans: repairPlans({ rows: [row(STRANDED, 12)], groups: strandedStore(), planId: 'repair-1' }).plans,
      mode: MODE_ABSOLUTE,
      planId: 'repair-1',
      createdAt: '2026-09-03T13:00:00.000Z',
    });
  const a = build();
  const b = build();
  a.repairedFrom = 'plan-a';
  b.repairedFrom = 'plan-b';
  assert.equal(a.contentHash, b.contentHash);
  assert.doesNotThrow(() => verifyArtifact(a));
  assert.doesNotThrow(() => verifyArtifact(b));
});

// --- provenance -------------------------------------------------------------
//
// "The group's own receipt" has to be a CHECKED property. A wrong --receipt path names a genuinely
// stranded group and steers it to the other of its two live values, which looks exactly like a
// correct repair right up to the moment it propagates.

test('a receipt is tied to its artifact by BOTH planId and contentHash', () => {
  const artifact = createArtifact({ plans: [], mode: MODE_ABSOLUTE, planId: 'plan-a' });
  const good = { planId: 'plan-a', contentHash: artifact.contentHash };
  assert.equal(receiptArtifactMismatch(good, artifact), null);

  assert.match(receiptArtifactMismatch({ ...good, planId: 'plan-b' }, artifact), /not plan-a/);
  assert.match(receiptArtifactMismatch({ ...good, contentHash: 'deadbeef' }, artifact), /different bytes/);
  assert.match(receiptArtifactMismatch({}, artifact), /planId|plan-a/);
});

// --- the age bound ----------------------------------------------------------
//
// A fan-out settles in 80 to 90 seconds. Past an hour the store has had time to move for reasons
// unrelated to the stranding; past a day the receipt no longer describes anything. `now` is injected
// so both boundaries are testable rather than argued about.

const receiptAt = (iso) => ({ startedAt: iso, finishedAt: iso, rows: [{ blankId: STRANDED, at: iso }] });
const T0 = Date.parse('2026-09-03T12:00:00.000Z');

test('the age bound is 1 hour to warn and 24 hours to refuse', () => {
  assert.equal(REPAIR_RECEIPT_WARN_AGE_MS, 60 * 60 * 1000);
  assert.equal(REPAIR_RECEIPT_MAX_AGE_MS, 24 * 60 * 60 * 1000);
});

test('a receipt under an hour old is clean, 1h-24h warns, and over 24h refuses', () => {
  const at = new Date(T0).toISOString();
  const verdictAfter = (ms) => assessReceiptAge(receiptAt(at), { now: T0 + ms }).verdict;
  assert.equal(verdictAfter(0), AGE_FRESH);
  assert.equal(verdictAfter(REPAIR_RECEIPT_WARN_AGE_MS), AGE_FRESH, 'exactly at the bound is not yet past it');
  assert.equal(verdictAfter(REPAIR_RECEIPT_WARN_AGE_MS + 1), AGE_WARN);
  assert.equal(verdictAfter(REPAIR_RECEIPT_MAX_AGE_MS), AGE_WARN);
  assert.equal(verdictAfter(REPAIR_RECEIPT_MAX_AGE_MS + 1), AGE_REFUSE);
});

test('an unparseable timestamp REFUSES rather than being believed forever', () => {
  // The same fail-closed stance splitStaleSeedReceipts takes, for the same reason: the failure mode
  // being closed here is a record of a live write that never stops being trusted.
  assert.equal(assessReceiptAge({ rows: [{ at: 'not a date' }] }, { now: T0 }).verdict, AGE_REFUSE);
  assert.equal(assessReceiptAge({}, { now: T0 }).verdict, AGE_REFUSE);
});

test('age is measured from the LATEST row, not from startedAt', () => {
  // A paced run can span the better part of an hour. The question is how long ago the store was
  // touched, not when the operator hit return.
  const receipt = {
    startedAt: new Date(T0 - 40 * 60_000).toISOString(),
    finishedAt: null,
    rows: [{ at: new Date(T0 - 40 * 60_000).toISOString() }, { at: new Date(T0 - 60_000).toISOString() }],
  };
  assert.equal(receiptWrittenAt(receipt), T0 - 60_000);
  assert.equal(assessReceiptAge(receipt, { now: T0 }).verdict, AGE_FRESH);
});
