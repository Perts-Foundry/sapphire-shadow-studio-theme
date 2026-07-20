// Backfill (tagging variants) and untag (removing them), plus the seed write that makes a backfill
// actually do something.
//
// TWO HAZARDS LIVE HERE, both established by live testing. Read docs/blank-inventory-sync-flow.md
// before changing any of it.
//
//   1. TAGGING IS INERT. metafieldsSet fires no inventory event, so on a quiet group a freshly
//      tagged variant sits at 0 indefinitely (observed: 150s, no movement). A backfill without a
//      seed write looks like it succeeded and changes nothing on the storefront. The seed write is
//      mandatory, not a precaution.
//
//   2. UNTAGGING ORDER IS DESTRUCTIVE IF REVERSED. Zeroing a variant that is STILL TAGGED fires the
//      trigger and propagates 0 across the entire blank group, wiping real stock everywhere. The
//      metafield must be deleted first, and the deletion must be confirmed by a re-read before any
//      quantity write. The interlock below is the only thing standing between a routine cleanup and
//      a catalogue-wide stock wipe.

import { selectWriteTarget, derivedIdempotencyKey } from './planner.mjs';
import { vocabKey } from './groups.mjs';
import { MODE_ABSOLUTE } from './input.mjs';

/**
 * Work out which untagged variants can be tagged, and which cannot.
 *
 * @param {object} params
 * @param {object[]} params.variants - the whole catalogue, normalised
 * @param {Map<string, string>} params.vocab
 * @param {object} [params.filter] - optional {color, size, productHandle} narrowing
 * @returns {{tags: object[], unresolvable: object[]}}
 */
export function planBackfill({ variants, vocab, filter = {} }) {
  const tags = [];
  const unresolvable = [];

  for (const v of variants) {
    if (v.blankId) continue;
    if (v.tracked === false) continue; // gift cards and other untracked items are not blanks
    if (filter.color && v.color !== filter.color) continue;
    if (filter.size && v.size !== filter.size) continue;
    if (filter.productHandle && v.productHandle !== filter.productHandle) continue;
    if (!v.color || !v.size) continue;

    const blankId = vocab.get(vocabKey(v));
    if (!blankId) {
      unresolvable.push({ variant: v, reason: `no blank precedent for "${v.color} / ${v.size}"` });
      continue;
    }
    tags.push({
      variantId: v.id,
      blankId,
      label: `${v.productHandle} | ${v.title}`,
      color: v.color,
      size: v.size,
      quantity: v.quantity,
    });
  }

  return { tags, unresolvable };
}

/**
 * Plan the seed write for one group after tagging.
 *
 * The target is the quantity the ALREADY-TAGGED members hold; the write lands on a mismatched
 * member, which after a backfill is one of the newly-tagged variants sitting at 0. Writing to an
 * already-correct member instead would be a no-op that fires no trigger, and the newly tagged
 * variants would stay at 0 forever.
 *
 * @param {object} params
 * @param {string} params.blankId
 * @param {object[]} params.members - the group AFTER tagging (established plus newly tagged)
 * @param {Set<string>} params.newlyTaggedIds
 * @param {string} params.planId
 * @returns {object|null} a plan row, or null when there is nothing to seed
 */
export function planSeed({ blankId, members, newlyTaggedIds, planId }) {
  const established = members.filter((m) => !newlyTaggedIds.has(m.id));
  if (!established.length) {
    throw new Error(
      `Blank "${blankId}" has no established members to take a quantity from. Seeding a group made ` +
        `entirely of new tags would invent a stock level; set one variant by hand first.`
    );
  }
  const targets = [...new Set(established.map((m) => m.quantity))];
  if (targets.length !== 1) {
    throw new Error(
      `Blank "${blankId}" is not converged among its established members (${targets.sort((a, b) => a - b).join(', ')}). ` +
        `Resolve that before seeding, or the seed will propagate whichever value it happens to pick.`
    );
  }
  const target = targets[0];

  const writeTarget = selectWriteTarget(members, target);
  if (!writeTarget) return null; // everything already agrees; nothing to seed

  return {
    blankId,
    mode: MODE_ABSOLUTE,
    skipped: false,
    current: target,
    target,
    baseline: writeTarget.quantity,
    delta: null,
    writeTargetId: writeTarget.id,
    writeTargetTitle: `${writeTarget.productHandle} | ${writeTarget.title}`,
    inventoryItemId: writeTarget.inventoryItemId,
    memberIds: members.map((m) => m.id),
    siblingCount: members.length - 1,
    idempotencyKey: derivedIdempotencyKey({ planId, blankId, target, mode: MODE_ABSOLUTE }),
  };
}

/**
 * Remove variants from their blank group, safely.
 *
 * The order below is the whole point. Deleting the metafield first means the subsequent quantity
 * write is invisible to the Flow (its gate exits on an empty blank id), so it cannot propagate.
 * The re-read between the two steps is not belt-and-braces: a silently failed delete followed by a
 * zeroing write is exactly the catalogue-wide stock wipe this guards against.
 *
 * @param {object} params
 * @param {string[]} params.variantIds
 * @param {number} params.targetQuantity
 * @param {(ids: string[]) => Promise<{deleted: number, errors: object[]}>} params.deleteTags
 * @param {(ids: string[]) => Promise<object[]>} params.readVariants
 * @param {(variant: object, quantity: number) => Promise<{ok: boolean, message: string|null}>} params.setQuantity
 * @param {(event: object) => void} [params.onStep]
 * @returns {Promise<{untagged: number, zeroed: number, failures: object[]}>}
 */
export async function untagVariants({
  variantIds,
  targetQuantity = 0,
  deleteTags,
  readVariants,
  setQuantity,
  onStep = () => {},
}) {
  if (!variantIds.length) return { untagged: 0, zeroed: 0, failures: [] };

  onStep({ step: 'delete-tags', count: variantIds.length });
  const del = await deleteTags(variantIds);
  if (del.errors.length) {
    throw new Error(
      `Metafield deletion reported errors, so no quantity write will be attempted: ` +
        `${JSON.stringify(del.errors)}`
    );
  }

  // INTERLOCK. Confirm every tag is actually gone before touching any quantity.
  onStep({ step: 'verify-untagged', count: variantIds.length });
  const after = await readVariants(variantIds);
  const stillTagged = after.filter((v) => v.blankId);
  if (stillTagged.length) {
    throw new Error(
      `Refusing to write quantities: ${stillTagged.length} variant(s) still carry the blank ` +
        `metafield (${stillTagged.map((v) => v.id).join(', ')}). Zeroing a tagged variant would ` +
        `propagate 0 across its whole blank group and wipe real stock.`
    );
  }

  onStep({ step: 'set-quantity', count: after.length, quantity: targetQuantity });
  const failures = [];
  let zeroed = 0;
  for (const v of after) {
    if (v.quantity === targetQuantity) continue;
    const res = await setQuantity(v, targetQuantity);
    if (res.ok) zeroed++;
    else failures.push({ variantId: v.id, message: res.message });
  }

  return { untagged: del.deleted, zeroed, failures };
}
