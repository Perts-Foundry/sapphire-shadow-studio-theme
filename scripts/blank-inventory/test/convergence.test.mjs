import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  isTransientReadError,
  withReadRetry,
  DEFAULT_READ_RETRY_ATTEMPTS,
  READ_RETRY_BACKOFF,
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

// --- transport retry on the read path ---------------------------------------
//
// The incident: a paced seed of 42 groups died at batch 15 on one `fetch failed` inside the
// read-only convergence poll, with the writes applied and the Flow mid-cascade. Re-reading is safe;
// re-driving a write is not, which is why these tests pin BOTH the retry and its blast radius.

const transportError = (message) => Object.assign(new Error(message), { code: 'ECONNRESET' });

test('isTransientReadError recognises transport failures and nothing else', () => {
  assert.equal(isTransientReadError(new Error('fetch failed')), true);
  assert.equal(isTransientReadError(new Error('socket hang up')), true);
  assert.equal(isTransientReadError(new Error('read ECONNRESET')), true);
  assert.equal(isTransientReadError(new Error('HTTP 502: {}')), true);
  assert.equal(isTransientReadError(Object.assign(new Error('boom'), { cause: { code: 'ETIMEDOUT' } })), true);

  assert.equal(isTransientReadError(new Error('connect ECONNREFUSED 127.0.0.1:443')), true);
  assert.equal(isTransientReadError(new Error('getaddrinfo EAI_AGAIN example.myshopify.com')), true);
  assert.equal(isTransientReadError(Object.assign(new Error('boom'), { cause: { message: 'fetch failed' } })), true);
  assert.equal(isTransientReadError(Object.assign(new Error('boom'), { code: 503 })), true, 'a numeric code is read too');
  assert.equal(isTransientReadError(Object.assign(new Error('boom'), { status: 502 })), true);
  assert.equal(isTransientReadError(Object.assign(new Error('boom'), { status: 429 })), false, 'a numeric 429 is throttling too');

  // Throttling has its own backoff inside the Admin client. Retrying it out here would stack two
  // backoffs on one wait, so a 429 must NOT be transient to this layer.
  assert.equal(isTransientReadError(new Error('HTTP 429: {}')), false);
  assert.equal(isTransientReadError(new Error('GraphQL errors: [{"message":"Field does not exist"}]')), false);
  assert.equal(isTransientReadError(new Error('HTTP 403: {}')), false);
  assert.equal(isTransientReadError(undefined), false);

  // Ordering, not coincidence: the 429 refusal precedes the pattern scan, so an error carrying both
  // is throttling with a transport-shaped tail, and re-driving it here would double the backoff.
  assert.equal(isTransientReadError(new Error('HTTP 429: {} (fetch failed on retry)')), false);
});

test('withReadRetry re-reads a transient failure and yields ONE result', async () => {
  let calls = 0;
  const slept = [];
  const read = withReadRetry(
    async () => {
      calls++;
      if (calls === 1) throw transportError('fetch failed');
      return 'catalogue';
    },
    { sleep: async (ms) => slept.push(ms) }
  );

  assert.equal(await read(), 'catalogue');
  assert.equal(calls, 2, 'the read was re-driven once');
  assert.equal(slept.length, 1, 'one backoff between the two reads');
  assert.ok(slept[0] > 0 && slept[0] <= READ_RETRY_BACKOFF.maxMs, 'the added wall-clock is bounded');
});

test('withReadRetry rethrows anything it does not recognise, on the first failure', async () => {
  let calls = 0;
  const read = withReadRetry(
    async () => {
      calls++;
      throw new Error('GraphQL errors: [{"message":"Access denied"}]');
    },
    { sleep: async () => {} }
  );
  await assert.rejects(read, /Access denied/);
  assert.equal(calls, 1, 'a real error is reported at once, not after three waits');
});

test('withReadRetry gives up after its attempt budget and reports the last failure', async () => {
  let calls = 0;
  const read = withReadRetry(
    async () => {
      calls++;
      throw transportError('fetch failed');
    },
    { sleep: async () => {} }
  );
  await assert.rejects(read, /fetch failed/);
  assert.equal(calls, DEFAULT_READ_RETRY_ATTEMPTS, 'the original read plus its retries, and no more');
});

test('a retried read is ONE observation: it cannot advance the converged counter', async () => {
  // Two consecutive converged reads are required, so the bug this guards against is a retry whose
  // value is treated as an extra observation: one converged tick plus a flaky socket would then look
  // like convergence and greenlight a still-moving cascade.
  //
  // The retry MUST return something different from the read before it, or the test passes against
  // that exact bug. So: converged, blip, then the retry sees the group MOVING again, and only the
  // last two reads are consecutive-converged.
  const frames = [
    { A: [12, 12] }, // converged once
    'throw', //        the socket drops here
    { A: [12, 11] }, // the retry's value: the cascade was still moving after all
    { A: [12, 12] },
    { A: [12, 12] },
  ];
  let i = 0;
  const state = { t: 0 };
  const ticks = [];
  const deps = {
    readAll: async () => {
      const frame = frames[Math.min(i, frames.length - 1)];
      i++;
      if (frame === 'throw') throw transportError('fetch failed');
      return new Map(Object.entries(frame).map(([b, qs]) => [b, qs.map((q) => ({ quantity: q }))]));
    },
    now: () => state.t,
    sleep: async (ms) => {
      state.t += ms;
    },
  };

  const retries = [];
  const res = await watchToConvergence(deps, {
    targets: new Map([['A', 12]]),
    onReadRetry: (info) => retries.push(info),
    onTick: (t) => ticks.push([...t.converged]),
  });

  assert.equal(res.verdicts.get('A'), CONVERGED);
  assert.equal(retries.length, 1, 'the watch reported the blip rather than swallowing it');
  assert.equal(res.reads, 4, 'four observations: converged, moving, converged, converged');
  assert.deepEqual(ticks, [[], [], [], ['A']], 'the group is not called converged until the last read');
});

test('a watch dies on an exhausted retry rather than polling past a dead socket', async () => {
  // What the operator is left with when the network is genuinely gone: the error propagates and the
  // watch stops. If this ever becomes "keep polling", that has to be a deliberate edit, because a
  // watch that cannot read is not evidence about the store either way.
  let calls = 0;
  const deps = {
    readAll: async () => {
      calls++;
      throw transportError('fetch failed');
    },
    now: () => 0,
    sleep: async () => {},
  };
  await assert.rejects(() => watchToConvergence(deps, { targets: new Map([['A', 12]]) }), /fetch failed/);
  assert.equal(calls, DEFAULT_READ_RETRY_ATTEMPTS, 'one budget for the tick, not one per loop pass');

  let quiesceCalls = 0;
  await assert.rejects(
    () =>
      quiesce({
        readSignatures: async () => {
          quiesceCalls++;
          throw transportError('ECONNRESET');
        },
        sleep: async () => {},
      }),
    /ECONNRESET/
  );
  assert.equal(quiesceCalls, DEFAULT_READ_RETRY_ATTEMPTS);
});

test('retry backoff is spent from the watch budget, not added to it', async () => {
  // The retry sleeps on the same injected clock the deadline is measured against, so a store that
  // blips on every tick reports STALE at the timeout instead of running long.
  const state = { t: 0 };
  let calls = 0;
  const deps = {
    readAll: async () => {
      calls++;
      if (calls % 2 === 0) throw transportError('fetch failed');
      return new Map([['A', [{ quantity: 11 }]]]);
    },
    now: () => state.t,
    sleep: async (ms) => {
      state.t += ms;
    },
  };
  const res = await watchToConvergence(deps, { targets: new Map([['A', 12]]), timeoutMs: 30_000 });
  assert.equal(res.verdicts.get('A'), STALE);
  assert.ok(res.elapsedMs >= 30_000, 'the deadline still bounds the watch');
  assert.ok(res.elapsedMs < 60_000, 'retry waits did not buy the watch a second budget');
});

test('a handler passed inside readRetry is honoured, and the top-level one still wins', async () => {
  const inner = [];
  const outer = [];
  const flaky = () => {
    let n = 0;
    return async () => {
      n++;
      if (n === 1) throw transportError('fetch failed');
      return true;
    };
  };

  await pollToConvergence(
    { read: flaky(), now: () => 0, sleep: async () => {} },
    { requiredConvergedReads: 1, readRetry: { onReadRetry: (i) => inner.push(i) } }
  );
  assert.equal(inner.length, 1, 'an onReadRetry inside readRetry is not clobbered by an absent top-level one');

  await pollToConvergence(
    { read: flaky(), now: () => 0, sleep: async () => {} },
    {
      requiredConvergedReads: 1,
      readRetry: { onReadRetry: (i) => inner.push(i) },
      onReadRetry: (i) => outer.push(i),
    }
  );
  assert.equal(outer.length, 1, 'the top-level handler takes precedence when it is present');
  assert.equal(inner.length, 1, 'and the inner one does not also fire');
});

test('readRetry.attempts is honoured, so a caller can turn the retry off', async () => {
  let calls = 0;
  const deps = {
    readAll: async () => {
      calls++;
      throw transportError('fetch failed');
    },
    now: () => 0,
    sleep: async () => {},
  };
  await assert.rejects(
    () => watchToConvergence(deps, { targets: new Map([['A', 12]]), readRetry: { attempts: 1 } }),
    /fetch failed/
  );
  assert.equal(calls, 1, 'attempts: 1 means the original read and no retry');
});

test('pollToConvergence and quiesce survive a transient read the same way', async () => {
  let pollCalls = 0;
  const poll = await pollToConvergence(
    {
      read: async () => {
        pollCalls++;
        if (pollCalls === 1) throw transportError('fetch failed');
        return true;
      },
      now: () => 0,
      sleep: async () => {},
    },
    { requiredConvergedReads: 2 }
  );
  assert.equal(poll.verdict, CONVERGED);
  assert.equal(poll.reads, 2, 'the retry did not count as one of the two converged reads');

  let quiesceCalls = 0;
  const q = await quiesce({
    readSignatures: async () => {
      quiesceCalls++;
      if (quiesceCalls === 1) throw transportError('fetch failed');
      return new Map([['B', 'steady']]);
    },
    sleep: async () => {},
  });
  assert.equal(q.timedOut, false);
  assert.equal(q.stable.has('B'), true);
});

test('no write path can reach the retry wrapper', async () => {
  // Stated as a property of the TREE, not of one caller: the reason a read may be re-driven (a read
  // has no effect) is exactly the reason a write may not, and an inventory set that timed out may
  // well have landed. Scoped to all of scripts/ rather than this tool's lib/, because a cross-module
  // import is a real shape here (scripts/policies/ already imports blank-inventory's admin client).
  // If this fails, the fix is to delete the import, never to relax the test.
  const scriptsDir = fileURLToPath(new URL('../../', import.meta.url));
  const home = fileURLToPath(new URL('../lib/convergence.mjs', import.meta.url));

  const scanned = [];
  const offenders = [];
  const walk = async (dir) => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'test') continue;
        await walk(full);
        continue;
      }
      if (!entry.name.endsWith('.mjs') && !entry.name.endsWith('.js')) continue;
      scanned.push(full);
      if (full === home) continue;
      if ((await readFile(full, 'utf8')).includes('withReadRetry')) offenders.push(path.relative(scriptsDir, full));
    }
  };
  await walk(scriptsDir);

  // Positive control: a green result must mean "scanned and found nothing", never "scanned nothing".
  // Without these two lines an inverted predicate or a filter that matches no file passes silently.
  assert.ok(scanned.length > 20, `the walk read the tree (${scanned.length} files)`);
  assert.ok(scanned.includes(home), 'the read module itself was in the scanned set');
  assert.ok(
    (await readFile(home, 'utf8')).includes('withReadRetry'),
    'the predicate detects the token in the one file that legitimately has it'
  );

  assert.deepEqual(offenders, [], 'the retry wrapper is used by the read module and nothing else');
});
