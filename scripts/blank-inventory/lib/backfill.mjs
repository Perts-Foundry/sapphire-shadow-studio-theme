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
import { vocabKey, blankPrefix } from './groups.mjs';
import { MODE_ABSOLUTE } from './input.mjs';

/**
 * How many variants one `--blank` bootstrap may tag before demanding an explicit override.
 *
 * The bootstrap mints a NEW id, so unlike a vocab-resolved backfill it has no precedent to check the
 * operator against. A fat-fingered filter that matched the whole catalogue would fold every garment
 * into one new pool. The cap is deliberately small: a normal mint is one colour+size slice of one
 * product, which is one variant.
 */
export const BLANK_BOOTSTRAP_CAP = 6;

/**
 * Work out which untagged variants can be tagged, and which cannot.
 *
 * A variant that cannot be keyed is REPORTED, never skipped. It used to be dropped silently when it
 * lacked a colour or a size, so the proposal's counts did not add up to the tracked population and
 * nothing said why. Silence about a variant the tool cannot handle is indistinguishable from the
 * variant not existing.
 *
 * @param {object} params
 * @param {object[]} params.variants - the whole catalogue, normalised, with `body` attached
 * @param {Map<string, string>} params.vocab
 * @param {object} [params.filter] - optional {body, color, size, productHandle} narrowing
 * @returns {{tags: object[], unresolvable: object[]}}
 */
export function planBackfill({ variants, vocab, filter = {} }) {
  const tags = [];
  const unresolvable = [];

  for (const v of variants) {
    if (v.blankId) continue;
    if (v.tracked === false) continue; // gift cards and other untracked items are not blanks
    if (filter.body && v.body !== filter.body) continue;
    if (filter.color && v.color !== filter.color) continue;
    if (filter.size && v.size !== filter.size) continue;
    if (filter.productHandle && v.productHandle !== filter.productHandle) continue;

    const missing = ['body', 'color', 'size'].filter((axis) => !v[axis]);
    if (missing.length) {
      unresolvable.push({
        variant: v,
        reason:
          `cannot be keyed: no ${missing.join(', ')}. ` +
          (missing.includes('body')
            ? 'Run "bodies --stage propose" so this product has an approved body.'
            : 'A variant with no colour or size has no blank to draw from; check its options in Admin.'),
      });
      continue;
    }

    const blankId = vocab.get(vocabKey(v));
    if (!blankId) {
      unresolvable.push({
        variant: v,
        reason: `no blank precedent for "${v.body} / ${v.color} / ${v.size}"`,
      });
      continue;
    }
    tags.push({
      variantId: v.id,
      blankId,
      label: `${v.productHandle} | ${v.title}`,
      body: v.body,
      color: v.color,
      size: v.size,
      quantity: v.quantity,
    });
  }

  return { tags, unresolvable };
}

/**
 * Mint a NEW blank id and plan tagging a scoped set of untagged variants with it.
 *
 * This is the bootstrap escape hatch. resolveBlank refuses any id with no precedent, by design, so
 * without this there is no way to introduce the first variant of a new blank family through the
 * tool: the operator had to open Admin and tag one by hand (finding 13), and the only hint that the
 * hatch was needed lived in an error string (finding 14).
 *
 * It is deliberately narrow and loud, because minting has no precedent to validate against:
 *   - it refuses without a `--product` scope; a blank id belongs to one product's variants;
 *   - it only tags a variant whose own size the id ends with, so every tagged variant ends up with
 *     an id ending in its own size (the size-suffix convention holds). The size is taken from the
 *     matching variant, not string-sliced off the id, because a trailing "_0001" is a style number,
 *     not a size, and only the live variant can say which token is which;
 *   - it caps how many variants one call may tag and demands an explicit override past the cap;
 *   - the selected variants must all hold ONE quantity, and if the id already names a family on the
 *     store, that quantity must equal the family's. Joining a variant that holds different stock
 *     would let the next seed silently overwrite it.
 *
 * It does NOT seed. A freshly minted family has no established quantity to propagate; the operator
 * sets its level afterwards with `plan --input`, which can now resolve the id because it has members.
 *
 * @param {object} params
 * @param {object[]} params.variants - the whole catalogue, normalised, with `body` attached
 * @param {string} params.blankId - the full new id, ending in a size token
 * @param {object} params.filter - {productHandle (required), color?, size?, body?}
 * @param {Map<string, object[]>} [params.existingGroups] - live groups, to detect an existing family
 * @param {number} [params.cap]
 * @param {boolean} [params.allowOverCap]
 * @returns {{blankId: string, isNew: boolean, size: string, quantity: number, tags: object[]}}
 */
export function planBlankBootstrap({
  variants,
  blankId,
  filter = {},
  existingGroups = new Map(),
  cap = BLANK_BOOTSTRAP_CAP,
  allowOverCap = false,
}) {
  const id = String(blankId ?? '').trim();
  if (!id) throw new Error('--blank needs a blank id, e.g. --blank BLACK_CREWNECK_0001_M.');
  if (!filter.productHandle) {
    throw new Error(
      '--blank requires --product. Minting a new blank id is scoped to one product deliberately: an ' +
        'unscoped mint could fold unrelated garments into a single new stock pool.'
    );
  }

  // Which size does this id serve? Not string-derived from the id (the trailing segment could be a
  // style number as easily as a size), but taken from whichever variant's own size the id actually
  // ends with. That reuses the size-suffix convention as the discriminator and needs no size list.
  const candidates = variants.filter(
    (v) =>
      !v.blankId &&
      v.tracked !== false &&
      v.productHandle === filter.productHandle &&
      (!filter.color || v.color === filter.color) &&
      (!filter.size || v.size === filter.size) &&
      (!filter.body || v.body === filter.body)
  );
  if (!candidates.length) {
    throw new Error(
      `No untagged, tracked variant of "${filter.productHandle}"` +
        `${filter.color ? ` in ${filter.color}` : ''}${filter.size ? ` at ${filter.size}` : ''} matches. ` +
        `Nothing to tag; check the filter, or the variant may already carry a blank id.`
    );
  }

  const selected = candidates.filter((v) => blankPrefix(id, v.size) !== null);
  if (!selected.length) {
    const sizes = [...new Set(candidates.map((v) => v.size))].sort().join(', ');
    throw new Error(
      `--blank id "${id}" does not end with the size of any matching variant (sizes present: ${sizes}). ` +
        `A blank id must end with its variant's size token, e.g. _M or _2XL; without a matching size ` +
        `the id is malformed for these variants.`
    );
  }
  const size = selected[0].size;

  if (selected.length > cap && !allowOverCap) {
    throw new Error(
      `This would tag ${selected.length} variant(s), over the bootstrap cap of ${cap}. A mint is ` +
        `normally one variant; ${selected.length} suggests too broad a filter. If it is intended, ` +
        `re-run with --allow-over-cap.`
    );
  }

  const quantities = [...new Set(selected.map((v) => v.quantity))];
  if (quantities.length !== 1) {
    throw new Error(
      `Selected variants disagree on current quantity (${quantities.sort((a, b) => a - b).join(', ')}). ` +
        `They are about to share one pool, so a single starting value must be unambiguous. Level them ` +
        `first, or narrow the filter.`
    );
  }
  const quantity = quantities[0];

  const existing = existingGroups.get(id) ?? [];
  const isNew = existing.length === 0;
  if (existing.length) {
    const fam = [...new Set(existing.map((m) => m.quantity))];
    if (fam.length !== 1) {
      throw new Error(
        `Blank "${id}" already exists but is not converged (${fam.sort((a, b) => a - b).join(', ')}). ` +
          `Resolve that before joining variants to it.`
      );
    }
    if (fam[0] !== quantity) {
      throw new Error(
        `Refusing to join: the selected variant(s) hold ${quantity} but family "${id}" holds ${fam[0]}. ` +
          `Tagging would let the next seed overwrite real stock. Use "backfill --stage propose" for a ` +
          `normal at-zero backfill, or level the variant first.`
      );
    }
  }

  return {
    blankId: id,
    isNew,
    size,
    quantity,
    tags: selected.map((v) => ({
      variantId: v.id,
      blankId: id,
      label: `${v.productHandle} | ${v.title}`,
      body: v.body,
      color: v.color,
      size: v.size,
      quantity: v.quantity,
    })),
  };
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
