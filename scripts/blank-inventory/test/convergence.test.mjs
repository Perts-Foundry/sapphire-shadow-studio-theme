import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allAtTarget,
  groupSignature,
  createPollState,
  pollStep,
  pollToConvergence,
  createQuiesceState,
  quiesceStep,
  quiesce,
  CONTINUE,
  CONVERGED,
  STALE,
} from '../lib/convergence.mjs';

const m = (id, quantity, blankId = 'B') => ({ id, quantity, blankId });

test('allAtTarget is true only when every member matches', () => {
  assert.equal(allAtTarget([m('a', 12), m('b', 12)], 12), true);
  assert.equal(allAtTarget([m('a', 12), m('b', 11)], 12), false);
  assert.equal(allAtTarget([], 12), false, 'an empty set is not convergence');
});

test('groupSignature is order independent and changes on a quantity or tag change', () => {
  const base = groupSignature([m('a', 1), m('b', 2)]);
  assert.equal(base, groupSignature([m('b', 2), m('a', 1)]));
  assert.notEqual(base, groupSignature([m('a', 1), m('b', 3)]));
  assert.notEqual(base, groupSignature([m('a', 1), { id: 'b', quantity: 2, blankId: null }]));
});

// --- polling ----------------------------------------------------------------

test('a single converged read is not enough; convergence needs consecutive reads', () => {
  let s = createPollState();
  s = pollStep(s, { converged: true, elapsedMs: 1000 });
  assert.equal(s.verdict, CONTINUE, 'one read could be a momentarily-consistent cascade');
  s = pollStep(s, { converged: true, elapsedMs: 2000 });
  assert.equal(s.verdict, CONVERGED);
});

test('a racing cascade 0 -> target -> 0 -> target does not report converged early', () => {
  // The exact non-atomic-propagation hazard: a group can touch the target and leave it again.
  const seq = [false, true, false, true];
  let s = createPollState();
  seq.forEach((converged, i) => {
    s = pollStep(s, { converged, elapsedMs: (i + 1) * 1000 });
  });
  assert.equal(s.verdict, CONTINUE, 'the flap must reset the consecutive run');
  s = pollStep(s, { converged: true, elapsedMs: 6000 });
  assert.equal(s.verdict, CONVERGED, 'two clean reads in a row settle it');
});

test('never reaching the target reports stale rather than hanging', () => {
  let s = createPollState();
  s = pollStep(s, { converged: false, elapsedMs: 299_000 });
  assert.equal(s.verdict, CONTINUE);
  s = pollStep(s, { converged: false, elapsedMs: 300_000 });
  assert.equal(s.verdict, STALE);
});

test('stale is flagged at 3 minutes while polling continues to 5', () => {
  let s = createPollState();
  s = pollStep(s, { converged: false, elapsedMs: 180_000 });
  assert.equal(s.verdict, CONTINUE, 'polling continues for the record');
  assert.equal(s.flaggedStale, true, 'but the run is already reportable as slow');
});

test('a terminal verdict is sticky', () => {
  let s = createPollState();
  s = pollStep(s, { converged: false, elapsedMs: 300_000 });
  assert.equal(s.verdict, STALE);
  s = pollStep(s, { converged: true, elapsedMs: 310_000 });
  assert.equal(s.verdict, STALE);
});

test('pollToConvergence drives to a verdict on an injected clock with no real waiting', async () => {
  let t = 0;
  const reads = [false, false, true, true];
  let i = 0;
  const res = await pollToConvergence({
    read: async () => reads[i++] ?? true,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  });
  assert.equal(res.verdict, CONVERGED);
  assert.equal(res.reads, 4);
});

test('pollToConvergence reports stale when the group never settles', async () => {
  let t = 0;
  const res = await pollToConvergence({
    read: async () => false,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  });
  assert.equal(res.verdict, STALE);
  assert.ok(res.elapsedMs >= 300_000);
});

// --- quiesce ----------------------------------------------------------------

test('quiesceStep needs consecutive unchanged reads before calling a group stable', () => {
  let state = createQuiesceState();
  const sig = new Map([['B', 'x']]);
  let out = quiesceStep(state, sig);
  state = out.state;
  assert.equal(out.moving.has('B'), true, 'first read has nothing to compare against');
  out = quiesceStep(state, sig);
  state = out.state;
  assert.equal(out.moving.has('B'), true);
  out = quiesceStep(state, sig);
  assert.equal(out.stable.has('B'), true);
});

test('a change resets a group back to moving', () => {
  let state = createQuiesceState();
  for (const sig of ['x', 'x', 'x']) {
    const out = quiesceStep(state, new Map([['B', sig]]));
    state = out.state;
  }
  const out = quiesceStep(state, new Map([['B', 'CHANGED']]));
  assert.equal(out.moving.has('B'), true);
});

test('quiesce is per group: one still-moving group does not hold the others back', () => {
  let state = createQuiesceState();
  let out;
  const seq = [
    new Map([['calm', 'a'], ['busy', 'b1']]),
    new Map([['calm', 'a'], ['busy', 'b2']]),
    new Map([['calm', 'a'], ['busy', 'b3']]),
  ];
  for (const sigs of seq) {
    out = quiesceStep(state, sigs);
    state = out.state;
  }
  assert.equal(out.stable.has('calm'), true, 'the quiet group is released');
  assert.equal(out.moving.has('busy'), true, 'the churning group is withheld');
});

test('quiesce returns once everything is quiet', async () => {
  const sigs = new Map([['B', 'steady']]);
  const res = await quiesce({ readSignatures: async () => sigs, sleep: async () => {} });
  assert.equal(res.timedOut, false);
  assert.equal(res.stable.has('B'), true);
});

test('quiesce gives up rather than waiting forever on a group that never settles', async () => {
  let n = 0;
  const res = await quiesce({
    readSignatures: async () => new Map([['B', `changing-${n++}`]]),
    sleep: async () => {},
    // maxReads kept small so the test is fast; the production default is 20.
  }, { maxReads: 4 });
  assert.equal(res.timedOut, true);
  assert.equal(res.moving.has('B'), true);
});
