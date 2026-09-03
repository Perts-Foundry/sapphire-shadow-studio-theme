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
  createWatchState,
  watchStep,
  watchToConvergence,
  CONTINUE,
  CONVERGED,
  STALE,
  MISSING,
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

// --- watching many groups on one read ---------------------------------------
//
// The property the whole rewrite exists for is the READ COUNT: one catalogue read per tick, not one
// per group per tick. Everything else here is about the ways a fold over pollStep gets it wrong.

/**
 * A fake store: `ticks` is a list of `Map<blankId, members[]>`, one per read, and the last entry
 * repeats forever. Members are `{quantity}` only, which is all allAtTarget looks at.
 */
function fakeWatch(ticks) {
  const state = { reads: 0, t: 0 };
  return {
    state,
    deps: {
      readAll: async () => {
        const frame = ticks[Math.min(state.reads, ticks.length - 1)];
        state.reads++;
        return new Map(Object.entries(frame).map(([b, quantities]) => [b, quantities.map((q) => ({ quantity: q }))]));
      },
      now: () => state.t,
      sleep: async (ms) => {
        state.t += ms;
      },
    },
  };
}

test('watchToConvergence reads the catalogue ONCE per tick, not once per group per tick', async () => {
  // The quadratic verify this replaces did a full loadStore per group per poll, which is what made
  // it pile reads onto the Admin API exactly when the Flow was already struggling.
  const w = fakeWatch([{ A: [12, 12], B: [12, 12], C: [12, 12] }]);
  const res = await watchToConvergence(w.deps, { targets: new Map([['A', 12], ['B', 12], ['C', 12]]) });
  assert.equal(res.reads, 2, 'two consecutive converged reads, for three groups');
  assert.equal(w.state.reads, 2, 'and exactly two catalogue reads were issued');
  assert.deepEqual([...res.converged].sort(), ['A', 'B', 'C']);
});

test('one converged read is still pending; two consecutive are converged', async () => {
  // The tail of re-triggered runs is what the second read absorbs. Dropping the requirement to one
  // read looks like a free saving and is not.
  let state = createWatchState(['A']);
  let out = watchStep(state, { converged: new Map([['A', true]]), elapsedMs: 1000 });
  assert.equal(out.pending.has('A'), true);
  out = watchStep(out.state, { converged: new Map([['A', true]]), elapsedMs: 2000 });
  assert.equal(out.converged.has('A'), true);
});

test('groups are independent under flapping: one group racing does not disturb its neighbour', async () => {
  const w = fakeWatch([
    { calm: [12, 12], busy: [11, 12] },
    { calm: [12, 12], busy: [12, 12] },
    { calm: [12, 12], busy: [11, 12] },
    { calm: [12, 12], busy: [12, 12] },
    { calm: [12, 12], busy: [12, 12] },
  ]);
  const res = await watchToConvergence(w.deps, { targets: new Map([['calm', 12], ['busy', 12]]) });
  assert.equal(res.verdicts.get('calm'), CONVERGED);
  assert.equal(res.verdicts.get('busy'), CONVERGED);
  assert.equal(res.reads, 5, 'the flap reset only the flapping group, and the watch ran until both settled');
});

test('a never-converging group reports stale while its neighbours converge', async () => {
  const w = fakeWatch([{ ok: [12, 12], stuck: [11, 12] }]);
  const res = await watchToConvergence(w.deps, { targets: new Map([['ok', 12], ['stuck', 12]]) });
  assert.equal(res.verdicts.get('ok'), CONVERGED);
  assert.equal(res.verdicts.get('stuck'), STALE);
  assert.deepEqual([...res.stale], ['stuck']);
});

test('a group with no members is MISSING and terminal, not five minutes of waiting', async () => {
  // allAtTarget returns false for an empty array, so a naive fold sits out the whole timeout and
  // then reports stale, pointing the operator at the Flow when the tags are what is gone.
  const w = fakeWatch([{ ok: [12, 12], gone: [] }]);
  const res = await watchToConvergence(w.deps, { targets: new Map([['ok', 12], ['gone', 12]]) });
  assert.equal(res.verdicts.get('gone'), MISSING);
  assert.deepEqual([...res.missing], ['gone']);
  assert.equal(res.reads, 2, 'the missing group never held the watch open');
});

test('a group that loses its last member MID-WATCH becomes MISSING, not pending until timeout', async () => {
  // The other half of the sticky-in-both-directions claim in the module comment, and the one a
  // "missing from the first tick" fixture never reaches: present with quantities at tick 1, gone at
  // tick 2. A regression that left it pending would sit out the full five minutes and then blame
  // the Flow for what is actually a tag that was removed.
  const w = fakeWatch([{ A: [11, 12] }, {}]);
  const res = await watchToConvergence(w.deps, { targets: new Map([['A', 12]]) });
  assert.equal(res.verdicts.get('A'), MISSING);
  assert.equal(res.reads, 2, 'it went terminal on the tick it vanished, not at the timeout');
  assert.ok(res.elapsedMs < 300_000);
});

test('a group absent from the read entirely is MISSING too, not silently pending forever', async () => {
  const w = fakeWatch([{ ok: [12, 12] }]);
  const res = await watchToConvergence(w.deps, { targets: new Map([['ok', 12], ['never-tagged', 12]]) });
  assert.equal(res.verdicts.get('never-tagged'), MISSING);
});

test('the watch exits as soon as every group is terminal, without sleeping out the budget', async () => {
  const w = fakeWatch([{ A: [12, 12] }]);
  const res = await watchToConvergence(w.deps, { targets: new Map([['A', 12]]), intervalMs: 10_000 });
  assert.equal(res.verdicts.get('A'), CONVERGED);
  assert.equal(w.state.t, 10_000, 'exactly one sleep between the two reads, and none after the verdict');
  assert.ok(res.elapsedMs < 300_000);
});

test('the timeout deadline is GLOBAL, computed once, never reset per group', async () => {
  // A batch is written within seconds of itself, so one deadline is the honest reading. A per-group
  // deadline would give the last group in a batch a fresh five minutes and turn a 5-minute bound
  // into a 5-minutes-times-N one.
  const w = fakeWatch([{ A: [11, 12], B: [11, 12] }]);
  const res = await watchToConvergence(w.deps, { targets: new Map([['A', 12], ['B', 12]]), intervalMs: 60_000 });
  assert.equal(res.verdicts.get('A'), STALE);
  assert.equal(res.verdicts.get('B'), STALE);
  assert.equal(res.reads, 6, 'both groups timed out on the SAME clock: 0s..300s at one read a minute');
});

test('an empty target set does no reads at all', async () => {
  const w = fakeWatch([{}]);
  const res = await watchToConvergence(w.deps, { targets: new Map() });
  assert.equal(w.state.reads, 0);
  assert.equal(res.verdicts.size, 0);
});

test('watchToConvergence refuses anything but a Map of targets', async () => {
  const w = fakeWatch([{}]);
  await assert.rejects(() => watchToConvergence(w.deps, { targets: { A: 12 } }), /Map/);
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
