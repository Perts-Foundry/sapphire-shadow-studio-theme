// The apply engine.
//
// Every dependency is injected (read, write, persist), so the whole loop, including the failure
// paths that matter most, is unit-testable against a mocked client with no network.
//
// Three properties this loop must hold, all of them about what happens when things go wrong:
//
//   - PER-ROW CONTINUE-ON-ERROR. One group's failure never aborts the rest. A count sheet can span
//     many groups and a single stale baseline is not a reason to abandon the others.
//   - INCREMENTAL, ATOMIC RECEIPTS. The receipt is persisted after every row, so a crash leaves a
//     parseable record of exactly what was and was not done. A half-applied run must never look
//     finished.
//   - FAIL CLOSED ON DRIFT. If the store moved such that the approved write target is no longer the
//     right variant to write, refuse that row and demand a re-plan. Re-deriving silently would let
//     apply write somewhere the operator never approved.

import { selectWriteTarget } from './planner.mjs';
import { markRow, ROW_APPLIED, ROW_FAILED, ROW_SKIPPED } from './receipt.mjs';
import { MODE_DELTA } from './input.mjs';

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
 * @returns {Promise<{receipt: object, applied: number, failed: number, skipped: number}>}
 */
export async function applyPlan({ artifact, receipt, readGroup, write, persist, onRow = () => {}, only = null }) {
  const allowed = only ? new Set(only) : null;
  let applied = 0;
  let failed = 0;
  let skipped = 0;

  for (const group of artifact.groups) {
    const row = receipt.rows.find((r) => r.blankId === group.blankId);
    if (row?.status === ROW_APPLIED) {
      onRow({ blankId: group.blankId, status: ROW_APPLIED, resumed: true });
      applied++;
      continue;
    }
    if (allowed && !allowed.has(group.blankId)) continue;

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

  receipt.finishedAt = new Date().toISOString();
  await persist(receipt);
  return { receipt, applied, failed, skipped };
}
