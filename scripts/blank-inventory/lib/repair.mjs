// Re-planning a group the Flow left stranded.
//
// THE SITUATION THIS EXISTS FOR. An `apply` writes one member of a blank group and the Flow fans
// the value out to the rest. When the Flow is overwhelmed (see the pacing note in apply.mjs), the
// write lands but the fan-out does not: the group is left with one member holding the new value and
// its siblings still on the old one. On 2026-09-03 that happened to 13 groups at once, and there
// was no legal way out of it. `plan` refuses a non-uniform group by design, `apply` accepts only a
// hashed artifact, and `backfill --stage seed` covers only newly tagged variants. The only remaining
// options were to do it by hand in Admin, or to step outside every gate this system exists to
// enforce.
//
// So: one more planner, emitting an ordinary hashed artifact that `show`, gate 5 and `apply` all
// consume unchanged. There is no second write path to audit.
//
// WHY THIS IS NOT "WRITING ON TOP OF AN UNCONVERGED GROUP", which is otherwise an absolute here.
// That rule covers a group whose correct value is unknown or contested: drift with no receipt, a
// partial nobody planned, a group mid-cascade. Writing there is guessing. A stranded fan-out is a
// different case: a receipt records a value the operator approved and the tool wrote, at least one
// member already holds it, and the fix is another trigger carrying that same number. Nothing is
// guessed. The distinction is the receipt, which is why the receipt is checked rather than assumed.
//
// THE ONE THING NEVER TO INFER IS THE TARGET. On a stranded group of eight with one member at 12
// and seven at 11, every live-state heuristic (majority, mode, histogram peak, "the value most
// members hold") returns 11, which silently rolls the approved change back on the one member that
// did converge. It is the obvious implementation and it is exactly backwards. The target comes from
// the receipt's `applied` rows and from nowhere else.
//
// Pure module: no network, no clock, no filesystem. `now` is injected because the age bound below
// gates a live write and must be testable at its boundaries.

import { selectWriteTarget, derivedIdempotencyKey } from './planner.mjs';
import { ROW_APPLIED, SEED_RECEIPT_MAX_AGE_MS } from './receipt.mjs';
import { MODE_ABSOLUTE } from './input.mjs';

/** A group that is already uniform at its approved target. Nothing to repair; enumerated anyway. */
export const REPAIR_SKIP_CONVERGED = 'already-converged';
/** The receipt row never reached `applied`, so no write fired. That is `--resume` territory. */
export const REPAIR_REFUSE_NOT_APPLIED = 'row-not-applied';
/** The group has no tagged members at all any more. */
export const REPAIR_REFUSE_NO_MEMBERS = 'no-tagged-members';
/** More than two distinct quantities. Not a stranded fan-out; a human has to look. */
export const REPAIR_REFUSE_SPREAD = 'multi-value-spread';
/** No live member holds the approved target, so something moved after the write. */
export const REPAIR_REFUSE_NO_TARGET_MEMBER = 'no-member-at-target';

/**
 * Past this, a receipt gets a warning: the fan-out it describes settles in 80 to 90 seconds, so an
 * hour is already far outside any legitimate settle and the live state may have moved for reasons
 * that have nothing to do with the stranding.
 */
export const REPAIR_RECEIPT_WARN_AGE_MS = 60 * 60 * 1000;

/**
 * Past this, a receipt is refused outright. Same order as `SEED_RECEIPT_MAX_AGE_MS`, and for the
 * same reason: a record of a live write stops explaining the store's current state long before it
 * stops sitting in the working directory, and a day tolerates a run left overnight while refusing a
 * receipt from last week.
 */
export const REPAIR_RECEIPT_MAX_AGE_MS = SEED_RECEIPT_MAX_AGE_MS;

export const AGE_FRESH = 'fresh';
export const AGE_WARN = 'warn';
export const AGE_REFUSE = 'refuse';

/**
 * When the writes a receipt describes actually happened.
 *
 * The LATEST row timestamp, not `startedAt`: a paced run can span the better part of an hour, and
 * the question here is how long ago the store was touched, not when the operator hit return. Falls
 * back to `finishedAt` and then `startedAt` for a receipt with no stamped rows.
 *
 * @param {object} receipt
 * @returns {number|null} epoch ms, or null when nothing parses
 */
export function receiptWrittenAt(receipt) {
  const stamps = (receipt?.rows ?? [])
    .map((r) => Date.parse(r?.at ?? ''))
    .concat([Date.parse(receipt?.finishedAt ?? ''), Date.parse(receipt?.startedAt ?? '')])
    .filter((t) => Number.isFinite(t));
  return stamps.length ? Math.max(...stamps) : null;
}

/**
 * How much a receipt's age should be trusted.
 *
 * An unparseable timestamp REFUSES rather than passing, the same fail-closed stance
 * `splitStaleSeedReceipts` takes: the failure mode being closed here is a receipt that never stops
 * being believed.
 *
 * @param {object} receipt
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {number} [opts.warnAfterMs]
 * @param {number} [opts.maxAgeMs]
 * @returns {{verdict: string, ageMs: number|null, writtenAt: number|null}}
 */
export function assessReceiptAge(
  receipt,
  { now = Date.now(), warnAfterMs = REPAIR_RECEIPT_WARN_AGE_MS, maxAgeMs = REPAIR_RECEIPT_MAX_AGE_MS } = {}
) {
  const writtenAt = receiptWrittenAt(receipt);
  if (writtenAt === null) return { verdict: AGE_REFUSE, ageMs: null, writtenAt: null };
  const ageMs = now - writtenAt;
  if (ageMs > maxAgeMs) return { verdict: AGE_REFUSE, ageMs, writtenAt };
  if (ageMs > warnAfterMs) return { verdict: AGE_WARN, ageMs, writtenAt };
  return { verdict: AGE_FRESH, ageMs, writtenAt };
}

/** How many members hold each quantity, distinct values ascending. */
function distinctQuantities(members) {
  return [...new Set(members.map((m) => m.quantity))].sort((a, b) => a - b);
}

/**
 * Re-plan every group a receipt says was written but that did not finish propagating.
 *
 * ONE WRITE PER GROUP, exactly as an ordinary plan. Seven stragglers do not mean seven writes: the
 * plan targets one member still holding the OLD value, and the Flow fans the change out to the
 * rest. Writing every straggler would be the amplification this whole change exists to avoid.
 *
 * @param {object} params
 * @param {object[]} params.rows - the receipt's rows, ALL of them. The `applied` filter lives here
 *   rather than in the caller so that the "row never reached applied" refusal is reachable and
 *   reported, instead of a caller silently pre-filtering those groups out of existence.
 * @param {Map<string, object[]>} params.groups - live groups, blank id to members
 * @param {string} params.planId - a FRESH id, never the original's (see cmdRepair)
 * @returns {{plans: object[], skipped: object[], refused: object[]}}
 */
export function repairPlans({ rows, groups, planId }) {
  const plans = [];
  const skipped = [];
  const refused = [];

  const refuse = (blankId, reason, detail, current, target) =>
    refused.push({ blankId, reason, detail, current, target });

  for (const row of rows ?? []) {
    const { blankId, target } = row;

    if (row.status !== ROW_APPLIED) {
      refuse(
        blankId,
        REPAIR_REFUSE_NOT_APPLIED,
        `the receipt records this row as "${row.status}", so no write fired and there is no ` +
          `stranded fan-out to finish. Re-run the ORIGINAL artifact with --resume.`,
        null,
        target
      );
      continue;
    }

    const members = groups.get(blankId) ?? [];
    if (!members.length) {
      refuse(blankId, REPAIR_REFUSE_NO_MEMBERS, 'the group has no tagged variants any more', null, target);
      continue;
    }

    const quantities = distinctQuantities(members);

    if (quantities.length === 1) {
      if (quantities[0] === target) {
        skipped.push({ blankId, reason: REPAIR_SKIP_CONVERGED, current: quantities[0], target });
      } else {
        // Uniform, but not at the approved value. The write did not survive, or something else
        // overwrote the whole group. Either way it is not a half-finished fan-out.
        refuse(
          blankId,
          REPAIR_REFUSE_NO_TARGET_MEMBER,
          `every member holds ${quantities[0]}, not the approved ${target}. Nothing here is a ` +
            `stranded fan-out; the store moved after the write. Re-plan from a fresh count.`,
          quantities[0],
          target
        );
      }
      continue;
    }

    if (quantities.length > 2) {
      refuse(
        blankId,
        REPAIR_REFUSE_SPREAD,
        `three or more distinct quantities (${quantities.join(', ')}). A stranded fan-out has ` +
          `exactly two: the approved target and the value it has not reached yet.`,
        quantities.join('/'),
        target
      );
      continue;
    }

    if (!quantities.includes(target)) {
      refuse(
        blankId,
        REPAIR_REFUSE_NO_TARGET_MEMBER,
        `no member holds the approved ${target} (the group holds ${quantities.join(' and ')}). ` +
          `Something moved after the write, so finishing the fan-out would propagate a value the ` +
          `operator never approved.`,
        quantities.join('/'),
        target
      );
      continue;
    }

    // Mechanic 1, unchanged: the write lands on a member whose quantity DIFFERS from the target.
    // Writing the target onto the member that already holds it returns no adjustment group, fires
    // no trigger, and strands the siblings exactly as they are now.
    const writeTarget = selectWriteTarget(members, target);
    const stragglerValue = quantities.find((q) => q !== target);

    plans.push({
      blankId,
      mode: MODE_ABSOLUTE,
      skipped: false,
      current: stragglerValue,
      target,
      // THE CAS BASELINE IS THE CHOSEN MEMBER'S LIVE QUANTITY, never the approved target. Setting
      // it to the target would make compare-and-swap compare the target against itself, which
      // passes on a member that already holds it and silently defeats the one guard standing
      // between this command and a sale landing between the read and the write.
      baseline: writeTarget.quantity,
      delta: null,
      writeTargetId: writeTarget.id,
      writeTargetTitle: `${writeTarget.productHandle} | ${writeTarget.title}`,
      inventoryItemId: writeTarget.inventoryItemId,
      memberIds: members.map((m) => m.id),
      siblingCount: members.length - 1,
      // A fresh planId yields fresh derived keys, so a repair can never be deduplicated against the
      // run it repairs. Same reasoning narrowArtifact documents; the planId itself is never reused.
      idempotencyKey: derivedIdempotencyKey({ planId, blankId, target, mode: MODE_ABSOLUTE }),
    });
  }

  return { plans, skipped, refused };
}
