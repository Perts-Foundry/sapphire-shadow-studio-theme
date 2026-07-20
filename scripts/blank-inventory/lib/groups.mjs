// Blank groups and the Color+Size vocabulary.
//
// THE VOCABULARY IS LEARNED FROM THE LIVE STORE, NEVER FROM THIS REPO. The blank ids embed the
// supplier name and style number, which CLAUDE.md classifies as sensitive for this public repo.
// Nothing here hardcodes a blank id, a supplier, or a style number, and nothing may be added that
// does. Every check below is structural, so it validates real values without naming any of them.
//
// Pure module: no network, no client. Feed it normalised variants from catalogue.mjs.

/** A group state that looks like drift but is expected and harmless. */
export const AWAITING_SEED = 'awaiting-seed';
export const CONVERGED = 'converged';
export const DRIFT = 'drift';

/**
 * Key a variant by the physical blank it should draw from.
 * @param {{color: string|null, size: string|null}} v
 * @returns {string}
 */
export function vocabKey(v) {
  return `${v.color ?? ''}|${v.size ?? ''}`;
}

/**
 * Strip the trailing size token off a blank id, returning the colour-and-style prefix.
 * Returns null when the id does not end with the variant's own size, which is itself the signal
 * that the value is malformed.
 * @param {string} blankId
 * @param {string} size
 * @returns {string|null}
 */
export function blankPrefix(blankId, size) {
  if (!blankId || !size) return null;
  const suffix = `_${size}`;
  return blankId.endsWith(suffix) ? blankId.slice(0, -suffix.length) : null;
}

/**
 * Learn Color+Size -> blankId from the variants that already carry a value.
 *
 * A (Color, Size) with no precedent is absent from the vocab, and resolveBlank refuses it.
 * A (Color, Size) with conflicting precedents is recorded as a conflict and also refused: guessing
 * which of two live values is correct is exactly the decision a tool must not make.
 *
 * @param {object[]} variants
 * @returns {{vocab: Map<string, string>, conflicts: Array<{key: string, values: string[]}>}}
 */
export function learnVocab(variants) {
  /** @type {Map<string, Set<string>>} */
  const seen = new Map();
  for (const v of variants) {
    if (!v.blankId) continue;
    const key = vocabKey(v);
    if (!seen.has(key)) seen.set(key, new Set());
    seen.get(key).add(v.blankId);
  }
  const vocab = new Map();
  const conflicts = [];
  for (const [key, values] of seen) {
    if (values.size === 1) vocab.set(key, [...values][0]);
    else conflicts.push({ key, values: [...values].sort() });
  }
  return { vocab, conflicts };
}

/**
 * Resolve the blank id for a (Color, Size), or refuse.
 * @param {Map<string, string>} vocab
 * @param {string} color
 * @param {string} size
 * @returns {string}
 */
export function resolveBlank(vocab, color, size) {
  const key = vocabKey({ color, size });
  const found = vocab.get(key);
  if (!found) {
    throw new Error(
      `No blank precedent for "${color} / ${size}". This tool only reuses blank ids that already ` +
        `exist on the store; it never invents one. Tag one variant of this colour and size in ` +
        `Admin first, then re-run.`
    );
  }
  return found;
}

/**
 * Structural validation of the blank ids currently live.
 *
 * Deliberately encodes no supplier token. Two checks, both derivable from the data:
 *   1. every blank id ends with its own variant's Size, so a value pasted onto the wrong size shows up;
 *   2. every variant of one Color shares one prefix, so a typo'd colour token shows up.
 *
 * Returns warnings, not errors. The metafield definition has no validation, so a bad value can
 * already be live; the operator needs to see it rather than have the tool refuse to start.
 *
 * @param {object[]} variants
 * @returns {Array<{kind: string, message: string, variantId: string}>}
 */
export function conventionWarnings(variants) {
  const warnings = [];
  /** @type {Map<string, Map<string, string[]>>} */
  const prefixesByColor = new Map();

  for (const v of variants) {
    if (!v.blankId) continue;
    const prefix = blankPrefix(v.blankId, v.size);
    if (prefix === null) {
      warnings.push({
        kind: 'size-suffix',
        variantId: v.id,
        message: `${v.productHandle} | ${v.title}: blank id does not end with its own size "${v.size}".`,
      });
      continue;
    }
    const color = v.color ?? '(none)';
    if (!prefixesByColor.has(color)) prefixesByColor.set(color, new Map());
    const byPrefix = prefixesByColor.get(color);
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(v.id);
  }

  for (const [color, byPrefix] of prefixesByColor) {
    if (byPrefix.size <= 1) continue;
    const sorted = [...byPrefix.entries()].sort((a, b) => b[1].length - a[1].length);
    const [, majorityIds] = sorted[0];
    for (const [, ids] of sorted.slice(1)) {
      for (const id of ids) {
        warnings.push({
          kind: 'color-prefix',
          variantId: id,
          message:
            `Colour "${color}" uses ${byPrefix.size} different blank prefixes; this variant is in ` +
            `the minority group (${ids.length} vs ${majorityIds.length}). Likely a typo.`,
        });
      }
    }
  }

  return warnings;
}

/**
 * Group tagged variants by blank id. Untagged variants are excluded: an empty metafield opts a
 * variant out of the sync entirely.
 * @param {object[]} variants
 * @returns {Map<string, object[]>}
 */
export function buildGroups(variants) {
  /** @type {Map<string, object[]>} */
  const groups = new Map();
  for (const v of variants) {
    if (!v.blankId) continue;
    if (!groups.has(v.blankId)) groups.set(v.blankId, []);
    groups.get(v.blankId).push(v);
  }
  for (const members of groups.values()) {
    members.sort((a, b) => a.id.localeCompare(b.id));
  }
  return groups;
}

/**
 * Classify one group's health.
 *
 * The distinction that matters: a tagged variant sitting at 0 while its siblings hold stock looks
 * identical whether the Flow is broken (drift, urgent) or a backfill simply has not been seeded yet
 * (awaiting seed, expected). Conflating them makes the tool's most important signal useless, so a
 * pending-seed record is what separates the two.
 *
 * @param {object[]} members
 * @param {Set<string>} [pendingSeedBlankIds]
 * @returns {{state: string, quantities: number[], blankId: string|null}}
 */
export function classifyGroup(members, pendingSeedBlankIds = new Set()) {
  const blankId = members[0]?.blankId ?? null;
  const quantities = [...new Set(members.map((m) => m.quantity))].sort((a, b) => a - b);
  if (quantities.length <= 1) return { state: CONVERGED, quantities, blankId };
  const state = pendingSeedBlankIds.has(blankId) ? AWAITING_SEED : DRIFT;
  return { state, quantities, blankId };
}

/**
 * Classify every group.
 * @param {Map<string, object[]>} groups
 * @param {Set<string>} [pendingSeedBlankIds]
 * @returns {Array<{blankId: string, state: string, quantities: number[], members: object[]}>}
 */
export function classifyGroups(groups, pendingSeedBlankIds = new Set()) {
  return [...groups.entries()]
    .map(([blankId, members]) => ({
      blankId,
      members,
      ...classifyGroup(members, pendingSeedBlankIds),
    }))
    .sort((a, b) => a.blankId.localeCompare(b.blankId));
}

/**
 * Variants that break the single-inventory-level assumption the Flow depends on.
 * @param {object[]} variants
 * @returns {object[]}
 */
export function multiLevelVariants(variants) {
  return variants.filter((v) => (v.locationIds?.length ?? 0) > 1);
}
