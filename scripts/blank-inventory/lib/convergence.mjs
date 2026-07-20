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

/** Measured settle is 80-90s. Report stale at 3 minutes, keep polling to 5 for the record. */
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
