// Decide the ONE write per blank group.
//
// Two rules here are load-bearing and were established by live testing against the store; both are
// documented in docs/blank-inventory-sync-flow.md. Do not "simplify" either away:
//
//   1. The write must land on a member whose quantity DIFFERS from the target. Writing the target
//      to a member that already holds it returns `inventoryAdjustmentGroup: null`, fires no
//      inventory-changed event, and the Flow never runs, so stale siblings stay stale forever.
//      Taking members[0] is the obvious implementation and it is wrong.
//   2. Exactly one member is written. The Flow fans the change out to the rest. Writing every
//      member is redundant for absolute mode and actively destructive for delta mode, where a
//      "+12" applied to 10 siblings becomes "+120".
//
// Pure module: no network, no clock, no filesystem.

import { createHash } from 'node:crypto';
import { MODE_ABSOLUTE, MODE_DELTA } from './input.mjs';

export const SKIP_ALREADY_CORRECT = 'already-correct';
export const SKIP_NO_CHANGE = 'zero-delta';

/**
 * Derive a stable idempotency key.
 *
 * The Admin API REQUIRES `@idempotent(key: ...)` on the inventory mutations, so some key must be
 * sent. Deriving it from the plan rather than randomising per attempt keeps a plan reproducible:
 * the same logical write always carries the same identity, in the artifact and in the request.
 *
 * DO NOT treat key collapse as a safety property. Tested live: re-issuing a byte-identical mutation
 * with the same key about two minutes later was NOT deduplicated. It was processed as a new call
 * and stopped by compare-and-swap (`CHANGE_FROM_QUANTITY_STALE`). Whatever dedup window Shopify
 * applies did not cover that gap, so **compare-and-swap is what actually prevents a double-apply**;
 * the key is for reproducibility, not protection.
 *
 * Distinctness still matters in the other direction: two different groups, or the same group across
 * two different plans, must never collide, in case a dedup window does apply and silently swallows
 * a legitimate write.
 *
 * Formatted as a UUID because the directive's contract expects that shape.
 *
 * @param {object} parts
 * @param {string} parts.planId
 * @param {string} parts.blankId
 * @param {number} parts.target
 * @param {string} parts.mode
 * @returns {string}
 */
export function derivedIdempotencyKey({ planId, blankId, target, mode }) {
  // JSON.stringify rather than a delimiter string: it is unambiguous (no component can forge a
  // separator), and it is printable, so this file stays a reviewable text diff. An earlier version
  // used NUL separators, which made git treat the whole module as binary.
  const hex = createHash('sha256').update(JSON.stringify([planId, blankId, mode, target])).digest('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}

/**
 * Choose the member to write to: the lowest variant id among those whose quantity differs from the
 * target. Deterministic so the same plan always names the same variant and is reproducible.
 *
 * @param {object[]} members
 * @param {number} target
 * @returns {object|null} null when every member already matches
 */
export function selectWriteTarget(members, target) {
  const mismatched = members.filter((m) => m.quantity !== target);
  if (!mismatched.length) return null;
  return mismatched.reduce((lowest, m) => (m.id.localeCompare(lowest.id) < 0 ? m : lowest));
}

/**
 * The quantity a converged group currently holds.
 * @param {object[]} members
 * @returns {number}
 */
export function groupQuantity(members) {
  const distinct = [...new Set(members.map((m) => m.quantity))];
  if (distinct.length !== 1) {
    throw new Error(
      `Group is not converged (quantities ${distinct.sort((a, b) => a - b).join(', ')}). ` +
        `Planning on top of an unconverged group would mask a Flow fault; resolve it first.`
    );
  }
  return distinct[0];
}

/**
 * Plan one group.
 *
 * @param {object} params
 * @param {string} params.blankId
 * @param {object[]} params.members
 * @param {number} params.value - the operator's number (a count in absolute mode, a change in delta)
 * @param {string} params.mode
 * @param {string} params.planId
 * @returns {object} a plan row, possibly a skip
 */
export function planGroup({ blankId, members, value, mode, planId }) {
  if (!members?.length) throw new Error(`Blank "${blankId}" resolved to no variants.`);

  const current = groupQuantity(members);
  const target = mode === MODE_ABSOLUTE ? value : current + value;

  if (target < 0) {
    throw new Error(
      `Blank "${blankId}": a delta of ${value >= 0 ? `+${value}` : value} against ${current} would ` +
        `drive the quantity to ${target}. Negative stock is refused.`
    );
  }

  if (mode === MODE_DELTA && value === 0) {
    return { blankId, mode, skipped: true, reason: SKIP_NO_CHANGE, current, target, members };
  }

  const writeTarget = selectWriteTarget(members, target);
  if (!writeTarget) {
    return { blankId, mode, skipped: true, reason: SKIP_ALREADY_CORRECT, current, target, members };
  }

  return {
    blankId,
    mode,
    skipped: false,
    current,
    target,
    // The compare-and-swap baseline: the quantity observed on THIS variant at plan time. If an
    // order lands before apply, the write fails with CHANGE_FROM_QUANTITY_STALE rather than
    // silently reverting the sale.
    baseline: writeTarget.quantity,
    delta: mode === MODE_DELTA ? target - writeTarget.quantity : null,
    writeTargetId: writeTarget.id,
    writeTargetTitle: `${writeTarget.productHandle} | ${writeTarget.title}`,
    inventoryItemId: writeTarget.inventoryItemId,
    memberIds: members.map((m) => m.id),
    siblingCount: members.length - 1,
    idempotencyKey: derivedIdempotencyKey({ planId, blankId, target, mode }),
  };
}

/**
 * Plan every input row.
 *
 * @param {object} params
 * @param {Array<{blankId?: string, color?: string, size?: string, value: number, line: number}>} params.rows
 * @param {Map<string, object[]>} params.groups
 * @param {Map<string, string>} params.vocab
 * @param {string} params.mode
 * @param {string} params.planId
 * @param {(vocab: Map<string,string>, color: string, size: string) => string} params.resolveBlank
 * @returns {{plans: object[], skipped: object[]}}
 */
export function planAll({ rows, groups, vocab, mode, planId, resolveBlank }) {
  const plans = [];
  const skipped = [];
  // Dedupe on the RESOLVED blank id, not on the input strings. input.mjs already refuses a literal
  // duplicate, but two different (Color, Size) spellings can resolve to the same blank, and that
  // would produce two plan rows for one group: both computed against the same pre-run quantity, and
  // only the first recorded in the receipt (markRow finds by blankId). Refuse loudly instead.
  const seenBlanks = new Map();
  for (const row of rows) {
    const blankId = row.blankId ?? resolveBlank(vocab, row.color, row.size);
    if (seenBlanks.has(blankId)) {
      throw new Error(
        `Line ${row.line}: resolves to blank "${blankId}", which line ${seenBlanks.get(blankId)} ` +
          `already targets. Two rows cannot address the same physical blank in one run: they would ` +
          `both be computed against the same starting quantity and only one would be recorded.`
      );
    }
    seenBlanks.set(blankId, row.line);
    const members = groups.get(blankId);
    if (!members?.length) {
      throw new Error(
        `Line ${row.line}: blank "${blankId}" has no tagged variants on the store. Nothing would ` +
          `receive this write.`
      );
    }
    let planned;
    try {
      planned = planGroup({ blankId, members, value: row.value, mode, planId });
    } catch (err) {
      throw new Error(`Line ${row.line}: ${err.message}`);
    }
    (planned.skipped ? skipped : plans).push({ ...planned, line: row.line });
  }
  return { plans, skipped };
}
