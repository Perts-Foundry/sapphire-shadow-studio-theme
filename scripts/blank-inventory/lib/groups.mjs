// Blank groups and the Color+Size vocabulary.
//
// THE VOCABULARY IS LEARNED FROM THE LIVE STORE, NEVER FROM THIS REPO. The blank ids embed the
// supplier name and style number, which CLAUDE.md classifies as sensitive for this public repo.
// Nothing here hardcodes a blank id, a supplier, or a style number, and nothing may be added that
// does. Every check below is structural, so it validates real values without naming any of them.
//
// Pure module: no network, no client. Feed it normalised variants from catalogue.mjs.

import { compareIds } from './planner.mjs';

/** A group state that looks like drift but is expected and harmless. */
export const AWAITING_SEED = 'awaiting-seed';
export const CONVERGED = 'converged';
export const DRIFT = 'drift';

/**
 * The vocabulary key separator. A token containing it is refused rather than escaped: two axes
 * bleeding into one key resolves the wrong blank id, and a silent collision here moves real stock.
 */
const SEP = '|';

/**
 * Normalise one axis value for keying.
 *
 * All three axes get the SAME rules, which is the point: body was added last and must not acquire
 * its own casing or whitespace behaviour. Normalisation can only MERGE keys, never split them, and a
 * merged key holding two different blank ids surfaces as a conflict (refused) rather than as a
 * silent pick. That is the safe direction.
 *
 * @param {string|null|undefined} value
 * @param {string} axis - for the error message
 * @returns {string}
 */
export function normaliseAxis(value, axis) {
  const raw = String(value ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
  if (raw.includes(SEP)) {
    throw new Error(
      `${axis} value ${JSON.stringify(raw)} contains the key separator "${SEP}". This tool refuses ` +
        `to escape it: a key collision between two axes would resolve a variant to the wrong blank ` +
        `and move stock on the wrong garment. Rename the option value in Admin.`
    );
  }
  return raw.toLowerCase();
}

/**
 * Key a variant by the physical blank it should draw from: garment body, colour and size.
 *
 * BODY IS MANDATORY AND HAS NO DEFAULT. The original key was colour+size alone, which assumed one
 * physical garment per colour+size. On a catalogue with a crewneck, a quarter-zip and a vest that
 * assumption collapsed three stock pools into one. A missing body throws rather than falling back,
 * because the fallback IS the bug.
 *
 * @param {{body: string|null, color: string|null, size: string|null}} v
 * @returns {string}
 */
export function vocabKey(v) {
  const body = normaliseAxis(v.body, 'Body');
  if (!body) {
    throw new Error(
      `Cannot key a variant with no garment body. Body is never defaulted: two products on ` +
        `different bodies do not share stock, and treating them as one pool is what this axis ` +
        `exists to prevent. Run "bodies --stage propose".`
    );
  }
  return [body, normaliseAxis(v.color, 'Color'), normaliseAxis(v.size, 'Size')].join(SEP);
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
 * Learn Body+Color+Size -> blankId from the variants that already carry a value.
 *
 * A key with no precedent is absent from the vocab, and resolveBlank refuses it.
 * A key with conflicting precedents is recorded as a conflict and also refused: guessing which of
 * two live values is correct is exactly the decision a tool must not make.
 *
 * Because the key now carries the body, two products on DIFFERENT bodies sharing a colour and size
 * are no longer a conflict. They are the normal case, and under the old key they poisoned the entry
 * for both. Only two ids for one body+colour+size is a genuine contradiction.
 *
 * A tagged variant with no body is excluded from the vocabulary and reported, rather than throwing:
 * read commands must still be able to produce a report when the body map is missing or stale.
 *
 * @param {object[]} variants
 * @returns {{vocab: Map<string, string>, conflicts: Array<{key: string, values: string[]}>, unbodied: object[]}}
 */
export function learnVocab(variants) {
  /** @type {Map<string, Set<string>>} */
  const seen = new Map();
  const unbodied = [];
  for (const v of variants) {
    if (!v.blankId) continue;
    if (!v.body) {
      unbodied.push(v);
      continue;
    }
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
  return { vocab, conflicts, unbodied };
}

/**
 * Resolve the blank id for a body+colour+size, or refuse.
 *
 * Takes an object, not positional arguments. Three same-typed strings in a row invite a silent
 * transposition, and a transposed lookup here resolves to the wrong garment's stock.
 *
 * @param {Map<string, string>} vocab
 * @param {{body: string, color: string, size: string}} axes
 * @returns {string}
 */
export function resolveBlank(vocab, { body, color, size }) {
  const found = vocab.get(vocabKey({ body, color, size }));
  if (!found) {
    throw new Error(
      `No blank precedent for "${body} / ${color} / ${size}". This tool only reuses blank ids that ` +
        `already exist on the store; it never invents one. Tag one variant of this body, colour and ` +
        `size in Admin first (or use "backfill --blank"), then re-run.`
    );
  }
  return found;
}

/**
 * Structural validation of the blank ids currently live.
 *
 * Deliberately encodes no supplier token. Three checks, all derivable from the data:
 *   1. every blank id ends with its own variant's Size, so a value pasted onto the wrong size shows up;
 *   2. every variant of one Color AND Body shares one prefix, so a typo'd colour token shows up;
 *   3. no blank id is held by variants of two different bodies.
 *
 * Check 2 is keyed on colour AND body. Keyed on colour alone it fires on every correctly-modelled
 * multi-garment catalogue, since a crewneck and a vest in the same colour draw on different blanks
 * and so legitimately carry different prefixes. A warning that is always on is one nobody reads.
 *
 * Check 3 is the cross-check between the approved body map and what is actually tagged live. Two
 * bodies sharing one blank id means two different physical garments drawing from one stock pool:
 * selling one silently decrements the other. This is the pre-migration state of the store, so it is
 * expected to fire until the re-tagging migration completes.
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
  const prefixesByColorBody = new Map();
  /** @type {Map<string, Set<string>>} */
  const bodiesByBlank = new Map();

  for (const v of variants) {
    if (!v.blankId) continue;

    if (v.body) {
      if (!bodiesByBlank.has(v.blankId)) bodiesByBlank.set(v.blankId, new Set());
      bodiesByBlank.get(v.blankId).add(v.body);
    }

    const prefix = blankPrefix(v.blankId, v.size);
    if (prefix === null) {
      warnings.push({
        kind: 'size-suffix',
        variantId: v.id,
        message: `${v.productHandle} | ${v.title}: blank id does not end with its own size "${v.size}".`,
      });
      continue;
    }
    // Body participates in the key. Without it, every multi-garment catalogue looks like a typo.
    const label = `${v.color ?? '(none)'} / ${v.body ?? '(no body)'}`;
    if (!prefixesByColorBody.has(label)) prefixesByColorBody.set(label, new Map());
    const byPrefix = prefixesByColorBody.get(label);
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(v.id);
  }

  for (const [label, byPrefix] of prefixesByColorBody) {
    if (byPrefix.size <= 1) continue;
    const sorted = [...byPrefix.entries()].sort((a, b) => b[1].length - a[1].length);
    const [, majorityIds] = sorted[0];
    for (const [, ids] of sorted.slice(1)) {
      for (const id of ids) {
        warnings.push({
          kind: 'color-prefix',
          variantId: id,
          message:
            `"${label}" uses ${byPrefix.size} different blank prefixes; this variant is in the ` +
            `minority group (${ids.length} vs ${majorityIds.length}). Likely a typo.`,
        });
      }
    }
  }

  for (const [blankId, bodies] of bodiesByBlank) {
    if (bodies.size <= 1) continue;
    warnings.push({
      kind: 'body-span',
      variantId: null,
      blankId,
      message:
        `One blank id is held by ${bodies.size} different bodies (${[...bodies].sort().join(', ')}). ` +
        `Those garments share no physical stock, so selling one silently decrements the others. ` +
        `Re-tag them onto separate blanks.`,
    });
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
    // Same code-point ordering the planner uses to pick a write target, for the same reason.
    members.sort((a, b) => compareIds(a.id, b.id));
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
