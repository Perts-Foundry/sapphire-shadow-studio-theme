// Convergence and quiesce decisions.
//
// The Flow is asynchronous and propagates NON-ATOMICALLY: a mid-cascade read legitimately shows
// some siblings updated and some not (observed live: 12,12,11,11,11,11,11,11 at t+78s of a 90s
// settle). Two consequences drive everything here:
//
//   - verify must POLL TO CONVERGENCE, never sample once. A single sample can catch a
//     half-propagated group and wrongly report drift.
//   - a single converged-looking read is not proof either, because a group can pass through a
//     momentarily-consistent state. Convergence requires N consecutive converged reads.
//
// Quiesce exists for a different reason: tagging a variant never triggers the Flow, but any
// inventory event in that group sweeps in whatever is tagged at that moment, including the Flow's
// own self-retriggering cascade. Backfilling into an in-flight cascade gives nondeterministic
// partial convergence. So backfill waits for stillness first.
//
// Pure module: no clock, no network, no sleeping. Callers feed observations and elapsed time, which
// is what makes all of this testable with a fake clock.

export const CONTINUE = 'continue';
export const CONVERGED = 'converged';
export const STALE = 'stale';
/** A watched group that has no tagged members at all. Terminal, and never convergence. */
export const MISSING = 'missing';

/**
 * Measured cascade is 80-90s on an idle Flow. Report stale at 3 minutes, keep polling to 5.
 *
 * STALE here is "this watch gave up", NOT "this group is broken". Trigger latency sits outside the
 * cascade figure (3 minutes observed on a healthy store, ~6 minutes end to end) and cascades
 * degrade under load (313s observed within one paced run). So a STALE verdict is a prompt to
 * re-check and read the Flow run list, never a fault verdict on its own. Callers must not phrase it
 * as one.
 */
export const DEFAULT_STALE_AFTER_MS = 180_000;
export const DEFAULT_TIMEOUT_MS = 300_000;
export const DEFAULT_REQUIRED_CONVERGED_READS = 2;

/** Quiesce: 3 consecutive unchanged reads, 30s apart, informed by the observed 150s hot window. */
export const DEFAULT_QUIESCE_READS = 3;
export const DEFAULT_QUIESCE_INTERVAL_MS = 30_000;

/**
 * Is every member at the target?
 * @param {Array<{quantity: number}>} members
 * @param {number} target
 * @returns {boolean}
 */
export function allAtTarget(members, target) {
  return members.length > 0 && members.every((m) => m.quantity === target);
}

/**
 * A stable signature of a group's observable state. Any change to a quantity or a tag changes it.
 * @param {Array<{id: string, quantity: number, blankId: string|null}>} members
 * @returns {string}
 */
export function groupSignature(members) {
  return [...members]
    .map((m) => `${m.id}:${m.quantity}:${m.blankId ? 1 : 0}`)
    .sort()
    .join('|');
}

/** @returns {{consecutive: number, verdict: string, flaggedStale: boolean, reads: number}} */
export function createPollState() {
  return { consecutive: 0, verdict: CONTINUE, flaggedStale: false, reads: 0 };
}

/**
 * Advance the polling state by one observation.
 *
 * @param {ReturnType<typeof createPollState>} state
 * @param {{converged: boolean, elapsedMs: number}} observation
 * @param {object} [opts]
 * @returns {ReturnType<typeof createPollState>} a new state
 */
export function pollStep(state, { converged, elapsedMs }, opts = {}) {
  const {
    requiredConvergedReads = DEFAULT_REQUIRED_CONVERGED_READS,
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;

  if (state.verdict !== CONTINUE) return state;

  // A flap resets the run. A group that reaches the target, leaves it, and returns has not settled,
  // and reporting the first touch as convergence would greenlight a still-moving cascade.
  const consecutive = converged ? state.consecutive + 1 : 0;
  const reads = state.reads + 1;
  const flaggedStale = state.flaggedStale || (!converged && elapsedMs >= staleAfterMs);

  if (consecutive >= requiredConvergedReads) {
    return { consecutive, reads, flaggedStale, verdict: CONVERGED };
  }
  if (elapsedMs >= timeoutMs) {
    return { consecutive, reads, flaggedStale: true, verdict: STALE };
  }
  return { consecutive, reads, flaggedStale, verdict: CONTINUE };
}

/**
 * Run a poll loop to a verdict. The clock and the reader are injected, so tests drive it
 * deterministically with no real waiting.
 *
 * @param {object} deps
 * @param {() => Promise<boolean>} deps.read - resolves true when the watched set is at target
 * @param {() => number} deps.now
 * @param {(ms: number) => Promise<void>} deps.sleep
 * @param {object} [opts]
 * @returns {Promise<{verdict: string, elapsedMs: number, reads: number, flaggedStale: boolean}>}
 */
export async function pollToConvergence({ read, now, sleep }, opts = {}) {
  const { intervalMs = 10_000, ...rest } = opts;
  const startedAt = now();
  let state = createPollState();
  for (;;) {
    const converged = await read();
    state = pollStep(state, { converged, elapsedMs: now() - startedAt }, rest);
    if (state.verdict !== CONTINUE) {
      return { verdict: state.verdict, elapsedMs: now() - startedAt, reads: state.reads, flaggedStale: state.flaggedStale };
    }
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// Watching MANY groups on ONE read per tick.
//
// `pollToConvergence` watches a single predicate, so watching N groups with it costs N full
// catalogue reads per tick. `verify` did exactly that, serially, which made it quadratic in the
// number of groups and piled reads onto the Admin API at precisely the moment the Flow was already
// struggling. The batch gate would have repeated the mistake.
//
// The full catalogue read per tick is unavoidable: variant metafields are not filterable in a
// products search (docs/blank-inventory-sync-flow.md, "A scan is unavoidable in pure Flow"), so
// there is no query for "just this group". ONE read per tick instead of one read per group per tick
// is the entire win, and it is a large one.
//
// `pollStep` is pure and per-predicate, so this is a fold over it. Three properties are not folds,
// and each has its own reason:
//
//   - ELAPSED IS GLOBAL. A batch is written within seconds of itself, so the deadline is computed
//     once from the start of the watch and never reset per group. A per-group deadline would give
//     the last group in a batch a fresh five minutes.
//   - A GROUP WITH NO MEMBERS IS `missing`, AND TERMINAL. `allAtTarget` returns false for an empty
//     array, so a naive fold sits out the whole timeout on a group whose tags were removed and then
//     reports it as stale, which points at the Flow instead of at the missing tags.
//   - EXIT AS SOON AS EVERY GROUP IS TERMINAL, so a healthy batch does not burn the timeout.
//
// DEFAULT_REQUIRED_CONVERGED_READS stays at 2 here. Dropping it to 1 looks like a free saving and is
// not: the second read is what absorbs the tail of re-triggered runs that are queued but destined to
// exit at the Flow's guard.

/**
 * One poll state per watched group.
 * @param {Iterable<string>} blankIds
 * @returns {Map<string, ReturnType<typeof createPollState>>}
 */
export function createWatchState(blankIds) {
  return new Map([...blankIds].map((blankId) => [blankId, createPollState()]));
}

/**
 * Advance every watched group by one observation.
 *
 * `converged` is keyed by blank id. A watched id ABSENT from it is a group with no tagged members
 * (the reader could not find one), which is terminal `missing` rather than "not converged yet".
 *
 * @param {Map<string, ReturnType<typeof createPollState>>} state
 * @param {{converged: Map<string, boolean>, elapsedMs: number}} observation
 * @param {object} [opts]
 * @returns {{state: Map<string, object>, converged: Set<string>, stale: Set<string>, pending: Set<string>, missing: Set<string>}}
 */
export function watchStep(state, { converged, elapsedMs }, opts = {}) {
  const next = new Map();
  const out = { converged: new Set(), stale: new Set(), pending: new Set(), missing: new Set() };

  for (const [blankId, poll] of state) {
    if (poll.verdict === MISSING || !converged.has(blankId)) {
      // Sticky in both directions: a group seen once with no members stays missing, and a group
      // that loses its last member mid-watch becomes missing rather than waiting out the timeout.
      next.set(blankId, { ...poll, verdict: MISSING, reads: poll.reads + (poll.verdict === MISSING ? 0 : 1) });
      out.missing.add(blankId);
      continue;
    }
    const stepped = pollStep(poll, { converged: converged.get(blankId), elapsedMs }, opts);
    next.set(blankId, stepped);
    if (stepped.verdict === CONVERGED) out.converged.add(blankId);
    else if (stepped.verdict === STALE) out.stale.add(blankId);
    else out.pending.add(blankId);
  }

  return { state: next, ...out };
}

/**
 * Watch a set of groups to a verdict each, one read per tick.
 *
 * @param {object} deps
 * @param {() => Promise<Map<string, object[]>>} deps.readAll - called ONCE per tick; blank id to
 *   that group's members. A group absent from the map (or present with no members) is `missing`.
 * @param {() => number} deps.now
 * @param {(ms: number) => Promise<void>} deps.sleep
 * @param {object} opts
 * @param {Map<string, number>} opts.targets - blank id to the quantity that group should reach
 * @param {number} [opts.intervalMs]
 * @param {(tick: object) => void} [opts.onTick]
 * @returns {Promise<{verdicts: Map<string, string>, converged: Set<string>, stale: Set<string>, missing: Set<string>, elapsedMs: number, reads: number}>}
 */
export async function watchToConvergence({ readAll, now, sleep }, opts = {}) {
  const { targets, intervalMs = 10_000, onTick = () => {}, ...rest } = opts;
  if (!(targets instanceof Map)) throw new Error('watchToConvergence needs a Map of blankId to target.');

  const startedAt = now();
  let state = createWatchState(targets.keys());
  let last = { converged: new Set(), stale: new Set(), pending: new Set(targets.keys()), missing: new Set() };
  let reads = 0;

  while (state.size) {
    const members = await readAll();
    reads++;
    /** @type {Map<string, boolean>} */
    const converged = new Map();
    for (const [blankId, target] of targets) {
      const group = members.get(blankId);
      if (!group?.length) continue; // absent from the map: `missing`, handled in watchStep
      converged.set(blankId, allAtTarget(group, target));
    }

    // ONE elapsed for the whole tick. See the note above: the deadline is never reset per group.
    const elapsedMs = now() - startedAt;
    const stepped = watchStep(state, { converged, elapsedMs }, rest);
    state = stepped.state;
    last = stepped;
    onTick({ reads, elapsedMs, converged: stepped.converged, stale: stepped.stale, pending: stepped.pending, missing: stepped.missing });
    if (stepped.pending.size === 0) break;
    await sleep(intervalMs);
  }

  return {
    verdicts: new Map([...state].map(([blankId, poll]) => [blankId, poll.verdict])),
    converged: last.converged,
    stale: last.stale,
    missing: last.missing,
    elapsedMs: now() - startedAt,
    reads,
  };
}

/** @returns {{signatures: Map<string, string>, stableCounts: Map<string, number>, reads: number}} */
export function createQuiesceState() {
  return { signatures: new Map(), stableCounts: new Map(), reads: 0 };
}

/**
 * Advance quiesce by one observation.
 *
 * Per group, not global: one still-moving group must not hold up the rest, and a group that has
 * gone quiet must not be reset by a neighbour's churn.
 *
 * @param {ReturnType<typeof createQuiesceState>} state
 * @param {Map<string, string>} signatures - blankId to current signature
 * @param {object} [opts]
 * @returns {{state: object, stable: Set<string>, moving: Set<string>}}
 */
export function quiesceStep(state, signatures, opts = {}) {
  const { requiredStableReads = DEFAULT_QUIESCE_READS } = opts;
  const nextSignatures = new Map(signatures);
  const nextCounts = new Map();
  const stable = new Set();
  const moving = new Set();

  for (const [blankId, sig] of signatures) {
    const unchanged = state.signatures.get(blankId) === sig;
    const count = unchanged ? (state.stableCounts.get(blankId) ?? 0) + 1 : 0;
    nextCounts.set(blankId, count);
    if (count >= requiredStableReads - 1) stable.add(blankId);
    else moving.add(blankId);
  }

  return {
    state: { signatures: nextSignatures, stableCounts: nextCounts, reads: state.reads + 1 },
    stable,
    moving,
  };
}

/**
 * Wait until every watched group is quiet, or give up.
 *
 * @param {object} deps
 * @param {() => Promise<Map<string, string>>} deps.readSignatures
 * @param {(ms: number) => Promise<void>} deps.sleep
 * @param {object} [opts]
 * @returns {Promise<{stable: Set<string>, moving: Set<string>, reads: number, timedOut: boolean}>}
 */
export async function quiesce({ readSignatures, sleep }, opts = {}) {
  const {
    requiredStableReads = DEFAULT_QUIESCE_READS,
    intervalMs = DEFAULT_QUIESCE_INTERVAL_MS,
    maxReads = 20,
  } = opts;
  let state = createQuiesceState();
  let last = { stable: new Set(), moving: new Set() };
  for (let i = 0; i < maxReads; i++) {
    const signatures = await readSignatures();
    const stepped = quiesceStep(state, signatures, { requiredStableReads });
    state = stepped.state;
    last = { stable: stepped.stable, moving: stepped.moving };
    if (last.moving.size === 0 && state.reads >= requiredStableReads) {
      return { ...last, reads: state.reads, timedOut: false };
    }
    await sleep(intervalMs);
  }
  return { ...last, reads: state.reads, timedOut: true };
}
