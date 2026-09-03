// The apply engine.
//
// Every dependency is injected (read, write, persist), so the whole loop, including the failure
// paths that matter most, is unit-testable against a mocked client with no network.
//
// Three properties this loop must hold, all of them about what happens when things go wrong:
//
//   - PER-ROW CONTINUE-ON-ERROR. One group's failure never aborts the rest. A count sheet can span
//     many groups and a single stale baseline is not a reason to abandon the others. A re-run is
//     made safe by compare-and-swap: an already-applied row's baseline no longer matches, so the
//     write is refused rather than applied twice.
//   - INCREMENTAL, ATOMIC RECEIPTS. The receipt is persisted after every row, so a crash leaves a
//     parseable record of exactly what was and was not done. A half-applied run must never look
//     finished.
//   - FAIL CLOSED ON DRIFT. If the store moved such that the approved write target is no longer the
//     right variant to write, refuse that row and demand a re-plan. Re-deriving silently would let
//     apply write somewhere the operator never approved.

import { selectWriteTarget } from './planner.mjs';
import { markRow, finalizeReceipt, ROW_APPLIED, ROW_FAILED, ROW_SKIPPED } from './receipt.mjs';
import { MODE_DELTA } from './input.mjs';
import { CONVERGED } from './convergence.mjs';

export const DRIFT_TARGET_MOVED = 'plan-target-moved';
export const DRIFT_BASELINE_MOVED = 'baseline-moved';
export const ALREADY_CONVERGED = 'already-converged';

/**
 * Decide whether a planned group is still safe to write.
 *
 * @param {object} group - a group from the plan artifact
 * @param {object[]} members - the group as it looks right now
 * @returns {{action: 'write'|'skip'|'refuse', reason: string|null, detail: string|null}}
 */
export function checkDrift(group, members) {
  if (!members?.length) {
    return { action: 'refuse', reason: DRIFT_TARGET_MOVED, detail: 'the group has no tagged variants any more' };
  }

  const chosen = selectWriteTarget(members, group.target);
  if (!chosen) {
    // Everything already holds the target. Nothing to do, and a write would be a no-op that fires
    // no trigger anyway.
    return { action: 'skip', reason: ALREADY_CONVERGED, detail: `every member is already at ${group.target}` };
  }

  if (chosen.id !== group.writeTargetId) {
    return {
      action: 'refuse',
      reason: DRIFT_TARGET_MOVED,
      detail:
        `the approved write target was ${group.writeTargetId}, but the correct target is now ` +
        `${chosen.id}. Re-plan rather than writing somewhere that was never approved.`,
    };
  }

  const current = members.find((m) => m.id === group.writeTargetId);
  if (current.quantity !== group.baseline) {
    return {
      action: 'refuse',
      reason: DRIFT_BASELINE_MOVED,
      detail: `baseline was ${group.baseline}, the variant now holds ${current.quantity}`,
    };
  }

  return { action: 'write', reason: null, detail: null };
}

/**
 * Run an approved plan.
 *
 * @param {object} params
 * @param {object} params.artifact - a verified plan artifact
 * @param {object} params.receipt
 * @param {(blankId: string) => Promise<object[]>} params.readGroup
 * @param {(group: object, mode: string) => Promise<{ok: boolean, noop: boolean, code: string|null, message: string|null}>} params.write
 * @param {(receipt: object) => Promise<void>} params.persist
 * @param {(event: object) => void} [params.onRow]
 * @param {string[]} [params.only] - restrict to these blanks (a resumed run)
 * @param {boolean} [params.finalize] - stamp the receipt's `finishedAt` at the tail. False when a
 *   caller is running this loop repeatedly over one receipt (see applyPlanInBatches), where the run
 *   is not over when the loop returns.
 * @returns {Promise<{receipt: object, applied: number, failed: number, skipped: number}>}
 */
export async function applyPlan({ artifact, receipt, readGroup, write, persist, onRow = () => {}, only = null, finalize = true }) {
  const allowed = only ? new Set(only) : null;
  let applied = 0;
  let failed = 0;
  let skipped = 0;

  for (const group of artifact.groups) {
    // `only` is checked FIRST, before the already-applied short-circuit. The other order is
    // quadratic under batching: every batch re-walks the whole artifact, so each batch re-emitted an
    // `applied` event for every row an earlier batch had finished. At the default batch size of 1 a
    // 27-group run printed roughly 350 spurious lines, which is exactly the output that buries the
    // HALTED line during the incident this pacing exists for.
    if (allowed && !allowed.has(group.blankId)) continue;

    const row = receipt.rows.find((r) => r.blankId === group.blankId);
    if (row?.status === ROW_APPLIED) {
      onRow({ blankId: group.blankId, status: ROW_APPLIED, resumed: true });
      applied++;
      continue;
    }

    let members;
    try {
      members = await readGroup(group.blankId);
    } catch (err) {
      failed++;
      markRow(receipt, group.blankId, ROW_FAILED, `read failed: ${err.message}`);
      await persist(receipt);
      onRow({ blankId: group.blankId, status: ROW_FAILED, detail: err.message });
      continue;
    }

    const drift = checkDrift(group, members);
    if (drift.action === 'skip') {
      skipped++;
      markRow(receipt, group.blankId, ROW_SKIPPED, drift.detail);
      await persist(receipt);
      onRow({ blankId: group.blankId, status: ROW_SKIPPED, detail: drift.detail });
      continue;
    }
    if (drift.action === 'refuse') {
      failed++;
      markRow(receipt, group.blankId, ROW_FAILED, `${drift.reason}: ${drift.detail}`);
      await persist(receipt);
      onRow({ blankId: group.blankId, status: ROW_FAILED, detail: drift.detail, reason: drift.reason });
      continue;
    }

    let outcome;
    try {
      outcome = await write(group, artifact.mode);
    } catch (err) {
      outcome = { ok: false, noop: false, code: 'EXCEPTION', message: err.message };
    }

    if (!outcome.ok) {
      failed++;
      markRow(receipt, group.blankId, ROW_FAILED, `${outcome.code ?? 'error'}: ${outcome.message}`);
      await persist(receipt);
      onRow({ blankId: group.blankId, status: ROW_FAILED, detail: outcome.message, reason: outcome.code });
      continue;
    }

    if (outcome.noop) {
      // Should be unreachable: the planner only ever targets a mismatched member. If it happens,
      // the write did nothing, the Flow never fired, and reporting success would be a lie.
      failed++;
      const detail = 'write was a no-op (no adjustment group returned); the Flow will not have fired';
      markRow(receipt, group.blankId, ROW_FAILED, detail);
      await persist(receipt);
      onRow({ blankId: group.blankId, status: ROW_FAILED, detail });
      continue;
    }

    applied++;
    markRow(receipt, group.blankId, ROW_APPLIED, artifact.mode === MODE_DELTA ? `delta ${group.delta}` : `set ${group.target}`);
    await persist(receipt);
    onRow({ blankId: group.blankId, status: ROW_APPLIED });
  }

  if (finalize) {
    finalizeReceipt(receipt);
    await persist(receipt);
  }
  return { receipt, applied, failed, skipped };
}

// ---------------------------------------------------------------------------
// Pacing.
//
// THE FAILURE THIS EXISTS FOR. The Flow's guard clause runs AFTER its catalogue scan, not before
// it. Every sibling write re-fires the `Inventory quantity changed` trigger, each re-triggered run
// performs the full "Get product data" scan, and only then evaluates the guard and exits. So one
// write into a group of 8 costs 7 further writes and 7 further full scans, and a run that writes
// many groups back to back overlaps all of those. Twice now that has exhausted Flow's step budget:
// 2026-07-27 (38 groups, 13 fanned out) and 2026-09-03 (27 groups, 14 fanned out, 13 stranded with
// one member holding the new value and its siblings still on the old one).
//
// The remedy is to pace `apply` to what the Flow can absorb: write a small batch, wait for those
// groups to converge, then write the next. Two rules keep that from being theatre:
//
//   - GATE ON WHAT ACTUALLY FIRED. Only a row that reached `applied` triggered anything. A skipped
//     row was already at target and fired nothing; a failed row never fired. Waiting on either
//     hangs the run forever.
//   - HALT, NEVER CONTINUE. A batch that does not converge means the Flow is already behind.
//     Writing the next batch on top of it is the incident. The remaining rows are left
//     not-attempted rather than failed: nothing was tried, so nothing failed.
//
// This wraps `applyPlan` rather than modifying it. `only` is already a per-call filter and the
// receipt is passed in, so repeated calls over one receipt were always legal.

/**
 * How many groups may be written before waiting for them to settle.
 *
 * ONE, and the number is evidence rather than caution. Two incidents, 2026-07-27 (38 groups) and
 * 2026-09-03 (27 groups), both overwhelmed the Flow; neither isolated a smaller batch that is safe.
 * Until one does, the only defensible default is the smallest one.
 *
 * What it does NOT address: a single large group's own internal storm. A 13-member group is 12
 * writes and 12 full scans on its own, and batching cannot divide that. If a single group's fan-out
 * alone can time out, the product-level roll-up metafield in docs/blank-inventory-sync-flow.md
 * becomes required work rather than a deferred option.
 */
export const DEFAULT_BATCH_SIZE = 1;

/**
 * The verdict recorded for a batch whose gate call THREW rather than returning a verdict.
 *
 * A distinct value rather than reusing STALE, because the two say different things: STALE means the
 * store was read and the group had not converged; this means the store could not be read at all, so
 * convergence is unknown. Both are treated identically by `unsettledBlankIds` (anything that is not
 * CONVERGED is outstanding), which is the fail-closed behaviour, but an operator reading a receipt
 * afterwards can tell a slow fan-out from a broken connection.
 */
export const GATE_FAILED = 'gate-failed';

/** Split a list into fixed-size chunks, in order. `Infinity` yields one chunk (the --no-batch path). */
function chunk(items, size) {
  if (!Number.isFinite(size)) return items.length ? [items] : [];
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Terminal-status tallies over the WHOLE receipt, matching what applyPlan reports for one pass. */
function tallyRows(receipt) {
  let applied = 0;
  let failed = 0;
  let skipped = 0;
  for (const row of receipt.rows) {
    if (row.status === ROW_APPLIED) applied++;
    else if (row.status === ROW_FAILED) failed++;
    else if (row.status === ROW_SKIPPED) skipped++;
  }
  return { applied, failed, skipped };
}

/**
 * Blanks a previous attempt on this receipt wrote and then recorded as NOT converged.
 *
 * This is the input to the resume drain (see applyPlanInBatches). It walks EVERY batch entry, not
 * only the halted ones, and keeps the last verdict recorded per blank. A clean batch recorded
 * `converged` for each of its blanks and so contributes nothing; a later clean batch over a blank an
 * earlier one halted on correctly supersedes it. Filtering to `halted` entries first would look
 * equivalent and would leave a superseded stale verdict standing forever.
 *
 * An ungated run (--no-batch) records no verdicts at all, which is the honest answer: it made no
 * claim about convergence, so there is nothing here for a later resume to drain.
 *
 * @param {object} receipt
 * @returns {string[]}
 */
export function unsettledBlankIds(receipt) {
  /** @type {Map<string, string>} */
  const latest = new Map();
  for (const batch of receipt.batches ?? []) {
    for (const [blankId, verdict] of Object.entries(batch.verdicts ?? {})) latest.set(blankId, verdict);
  }
  return [...latest.entries()].filter(([, verdict]) => verdict !== CONVERGED).map(([blankId]) => blankId);
}

/**
 * Run an approved plan in paced batches, waiting for each batch's fan-out before writing the next.
 *
 * @param {object} params
 * @param {object} params.artifact
 * @param {object} params.receipt
 * @param {(blankId: string) => Promise<object[]>} params.readGroup
 * @param {(group: object, mode: string) => Promise<object>} params.write
 * @param {(receipt: object) => Promise<void>} params.persist
 * @param {(event: object) => void} [params.onRow]
 * @param {string[]} [params.only]
 * @param {number} [params.batchSize]
 * @param {(blankIds: string[]) => Promise<{verdicts: Map<string, string>}>} params.awaitBatch -
 *   injected, so the clock and the network stay out of this module and every apply test stays
 *   synchronous.
 * @param {boolean} [params.gate] - false for --no-batch: write everything in one pass and never
 *   wait. The resume drain below still runs; it is an absolute, not a pacing preference.
 * @param {(event: object) => void} [params.onBatch]
 * @returns {Promise<{receipt: object, applied: number, failed: number, skipped: number, batches: object[], halted: boolean}>}
 */
export async function applyPlanInBatches({
  artifact,
  receipt,
  readGroup,
  write,
  persist,
  onRow = () => {},
  only = null,
  batchSize = DEFAULT_BATCH_SIZE,
  awaitBatch,
  gate = true,
  onBatch = () => {},
}) {
  if (typeof awaitBatch !== 'function') {
    throw new Error('applyPlanInBatches needs an awaitBatch function; there is no unpaced fallback.');
  }
  // Infinity is the --no-batch spelling: one chunk, no waiting. Everything else must be a whole
  // number of groups; a 0 or a 1.5 would silently produce zero chunks or a wrong-sized one.
  const validBatchSize = batchSize === Infinity || (Number.isInteger(batchSize) && batchSize > 0);
  if (!validBatchSize) {
    throw new Error(`Batch size must be a positive whole number, got ${JSON.stringify(batchSize)}.`);
  }

  // A RESUME DRAINS BEFORE IT WRITES. Without this, a halt followed by `--resume` reproduces the
  // original incident one group at a time: the halted group's re-triggered runs are still draining
  // when the next write fires. Unconditional, because a fresh receipt records no batches at all.
  const outstanding = unsettledBlankIds(receipt);
  if (outstanding.length) {
    const { verdicts } = await awaitBatch(outstanding);
    const stillUnsettled = outstanding.filter((blankId) => verdicts.get(blankId) !== CONVERGED);
    if (stillUnsettled.length) {
      throw new Error(
        `${stillUnsettled.length} group(s) from an earlier halted batch are still not converged ` +
          `(${stillUnsettled.join(', ')}). Resuming would write on top of a fan-out that is already ` +
          `behind, which is the failure the pacing exists to prevent. Repair them first:\n` +
          `  blank-inventory.mjs repair --receipt <this receipt>`
      );
    }
  }

  const allowed = only ? new Set(only) : null;
  const attempts = artifact.groups
    .filter((g) => receipt.rows.find((r) => r.blankId === g.blankId)?.status !== ROW_APPLIED)
    .filter((g) => !allowed || allowed.has(g.blankId))
    .map((g) => g.blankId);

  receipt.batches = receipt.batches ?? [];
  let halted = false;

  for (const [index, ids] of chunk(attempts, batchSize).entries()) {
    const startedAt = new Date().toISOString();
    await applyPlan({ artifact, receipt, readGroup, write, persist, onRow, only: ids, finalize: false });

    // Only rows that reached `applied` fired a trigger, so only they have a fan-out to wait for.
    const appliedBlankIds = ids.filter(
      (blankId) => receipt.rows.find((r) => r.blankId === blankId)?.status === ROW_APPLIED
    );

    /** @type {Map<string, string>} */
    let verdicts = new Map();
    let gated = false;
    let gateError = null;
    if (gate && appliedBlankIds.length) {
      try {
        verdicts = (await awaitBatch(appliedBlankIds)).verdicts;
      } catch (err) {
        // THE BATCH ENTRY MUST REACH DISK EVEN WHEN THE GATE ITSELF FAILS, and this try/catch is
        // the only thing that makes that true. The rows are already durably `applied` (applyPlan
        // persists per row), so the writes happened and their fan-out is in flight. If the throw
        // escaped before `receipt.batches.push` below, the receipt would record no entry for this
        // batch at all, `unsettledBlankIds` would find nothing outstanding, and the next `--resume`
        // would sail past the drain straight into the following batch's writes: the original
        // incident, reproduced through the mechanism built to prevent it.
        //
        // The gate throwing is not exotic. It reads the catalogue through the Admin API, so a
        // transient failure there is likeliest precisely when the Flow is already struggling, which
        // is when this batch most needs to be recorded as unsettled.
        gateError = err;
      }
      gated = true;
    }
    // Fails closed twice over: a verdict MISSING from the map is stale rather than converged, and a
    // gate that threw leaves every id of the batch marked unsettled rather than unrecorded.
    const stale = gated
      ? appliedBlankIds.filter((blankId) => (gateError ? true : verdicts.get(blankId) !== CONVERGED))
      : [];
    halted = stale.length > 0;

    const entry = {
      index,
      blankIds: ids,
      appliedBlankIds,
      startedAt,
      finishedAt: new Date().toISOString(),
      verdicts: gateError
        ? Object.fromEntries(appliedBlankIds.map((blankId) => [blankId, GATE_FAILED]))
        : Object.fromEntries(verdicts),
      halted,
      ...(gateError ? { gateError: gateError.message } : {}),
    };
    receipt.batches.push(entry);
    await persist(receipt);
    onBatch({ ...entry, stale });

    // Re-thrown only after the record is safely on disk. The caller still sees the real failure;
    // what changes is that a later `--resume` now has something to drain.
    if (gateError) {
      throw new Error(
        `The convergence gate failed after batch ${index + 1} was written ` +
          `(${appliedBlankIds.join(', ')}): ${gateError.message}. Those writes LANDED and their ` +
          `fan-out was never confirmed, so they are recorded as unsettled. Re-run with --resume, ` +
          `which drains them first, or repair them.`
      );
    }

    // Every later row stays ROW_NOT_ATTEMPTED. Nothing was tried, so nothing failed, and `--resume`
    // (after a `repair`) picks them up unchanged.
    if (halted) break;
  }

  finalizeReceipt(receipt);
  await persist(receipt);
  return { receipt, ...tallyRows(receipt), batches: receipt.batches, halted };
}
