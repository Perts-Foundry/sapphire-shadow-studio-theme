// Blank groups and the Color+Size vocabulary.
//
// THE VOCABULARY IS LEARNED FROM THE LIVE STORE, NEVER FROM THIS REPO. The blank ids embed the
// supplier name and style number, which CLAUDE.md classifies as sensitive for this public repo.
// Nothing here hardcodes a blank id, a supplier, or a style number, and nothing may be added that
// does. Every check below is structural, so it validates real values without naming any of them.
//
// Pure module: no network, no client. Feed it normalised variants from catalogue.mjs.

import { compareIds } from './planner.mjs';
import { normaliseAxis, SEP } from '../../lib/vocab.mjs';

// PERMANENT COMPATIBILITY RE-EXPORT, not a shim awaiting removal. `normaliseAxis` moved to
// scripts/lib/vocab.mjs so seven areas outside blank-inventory could reach it without importing the
// planner; every caller inside blank-inventory still imports it from here, and that is fine. (The
// "no shim" rule recorded in release-notes.md applies to the DELETED blank-inventory copy of
// catalogue-manifest.mjs, not to this line.)
export { normaliseAxis };

/** A group state that looks like drift but is expected and harmless. */
export const AWAITING_SEED = 'awaiting-seed';
export const CONVERGED = 'converged';
export const DRIFT = 'drift';

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
        `exists to prevent. Declare the product's body in catalogue.json.`
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
 * read commands must still be able to produce a report when a product has no declared body.
 *
 * `display` carries the store's own spelling for each normalised axis value ("classic navy" ->
 * "Classic Navy"). Normalisation lowercases, so without it every suggestion and every printed key
 * would show a spelling that appears nowhere in Admin, and an operator told to look for "classic
 * navy" cannot find it. It is presentation only: nothing resolves through it.
 *
 * @param {object[]} variants
 * @returns {{vocab: Map<string, string>, conflicts: Array<{key: string, values: string[]}>, unbodied: object[], display: {body: Map<string, string>, color: Map<string, string>, size: Map<string, string>}}}
 */
export function learnVocab(variants) {
  /** @type {Map<string, Set<string>>} */
  const seen = new Map();
  const unbodied = [];
  const display = { body: new Map(), color: new Map(), size: new Map() };
  const remember = (axis, raw) => {
    const norm = normaliseAxis(raw, axis);
    // First spelling wins, so the table is stable across runs rather than reflecting variant order.
    if (norm && !display[axis].has(norm)) display[axis].set(norm, String(raw).trim());
  };

  for (const v of variants) {
    if (!v.blankId) continue;
    if (!v.body) {
      unbodied.push(v);
      continue;
    }
    const key = vocabKey(v);
    remember('body', v.body);
    remember('color', v.color);
    remember('size', v.size);
    if (!seen.has(key)) seen.set(key, new Set());
    seen.get(key).add(v.blankId);
  }
  const vocab = new Map();
  const conflicts = [];
  for (const [key, values] of seen) {
    if (values.size === 1) vocab.set(key, [...values][0]);
    else conflicts.push({ key, values: [...values].sort() });
  }
  return { vocab, conflicts, unbodied, display };
}

/**
 * Levenshtein distance, bounded by an early exit on the row minimum.
 *
 * Used ONLY to rank suggestions in an error message. Nothing resolves through it.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * Suggest keys the store actually has, for an axis triple that resolved to nothing.
 *
 * SUGGESTION ONLY. This never feeds a lookup and nothing here may ever be substituted for the
 * operator's token: "Navy" and "Classic Navy" are one keystroke apart and address different stock.
 * The caller prints these; only the operator may act on one, and a substituted token is a new
 * transcription that re-enters the transcription gate.
 *
 * A candidate must match the other two axes exactly, so a suggestion is always a real key that
 * differs on exactly the axis that failed.
 *
 * @param {Map<string, string>} vocab
 * @param {{body: string, color: string, size: string}} axes
 * Scoring, in two tiers. A raw edit distance alone is the wrong measure here and ranks the real
 * answer below a wrong one: "grey" is 8 edits from "grey heather" but only 5 from "black", so an
 * unrelated colour wins. The abbreviation case is the one that actually occurs (a sheet writes
 * "Navy" for "Classic Navy"), so containment scores 0 and beats everything, and anything else must
 * be within half the longer token's length to be offered at all.
 *
 * @param {object} [opts]
 * @param {{body: Map<string, string>, color: Map<string, string>, size: Map<string, string>}} [opts.display]
 * @param {number} [opts.limit]
 * @returns {Array<{axis: string, value: string, blankId: string, distance: number}>}
 */
export function nearMatches(vocab, { body, color, size }, opts = {}) {
  const { display, limit = 3 } = opts;
  const want = {
    body: normaliseAxis(body, 'Body'),
    color: normaliseAxis(color, 'Color'),
    size: normaliseAxis(size, 'Size'),
  };
  const axes = ['body', 'color', 'size'];
  const out = [];

  for (const [key, blankId] of vocab) {
    const parts = key.split(SEP);
    if (parts.length !== axes.length) continue;
    const have = { body: parts[0], color: parts[1], size: parts[2] };
    const differing = axes.filter((a) => have[a] !== want[a]);
    if (differing.length !== 1) continue;
    const axis = differing[0];
    const [a, b] = [want[axis], have[axis]];
    const contained = a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a));
    const distance = contained ? 0 : editDistance(a, b);
    // Half the longer token: "grey" -> "black" is 5 edits on a 5-character token and is not a near
    // match by any reading, but it beats the genuine answer on raw distance.
    if (!contained && distance > Math.floor(Math.max(a.length, b.length) / 2)) continue;
    out.push({ axis, value: display?.[axis]?.get(have[axis]) ?? have[axis], blankId, distance });
  }

  return out
    .sort((a, b) => a.distance - b.distance || a.value.localeCompare(b.value))
    .slice(0, limit);
}

/**
 * Resolve the blank id for a body+colour+size, or refuse.
 *
 * Takes an object, not positional arguments. Three same-typed strings in a row invite a silent
 * transposition, and a transposed lookup here resolves to the wrong garment's stock.
 *
 * The refusal may carry near-match suggestions when a `display` map is supplied. They are printed,
 * never applied: this function still resolves through the exact key and nothing else. A suggestion
 * is a prompt for the operator, not a fallback.
 *
 * @param {Map<string, string>} vocab
 * @param {{body: string, color: string, size: string}} axes
 * @param {object} [opts]
 * @param {{body: Map<string, string>, color: Map<string, string>, size: Map<string, string>}} [opts.display]
 * @returns {string}
 */
export function resolveBlank(vocab, { body, color, size }, opts = {}) {
  const found = vocab.get(vocabKey({ body, color, size }));
  if (!found) {
    const near = nearMatches(vocab, { body, color, size }, opts);
    const hint = near.length
      ? ` The store has ${near.map((n) => `${n.axis} "${n.value}"`).join(', ')}. If one of those is ` +
        `what the source meant, the OPERATOR must say so: this tool never substitutes a value, ` +
        `because a near match is a different physical blank.`
      : '';
    throw new Error(
      `No blank precedent for "${body} / ${color} / ${size}". This tool only reuses blank ids that ` +
        `already exist on the store; it never invents one. Tag one variant of this body, colour and ` +
        `size in Admin first (or use "backfill --blank"), then re-run.${hint}`
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
 * Check 3 is the cross-check between the declared body map and what is actually tagged live. Two
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
 * How many members hold each quantity.
 *
 * `[0, 2]` cannot tell "one member at 0 and seven at 2" from "seven at 0 and one at 2", and those
 * are opposite situations: the first is a cascade nearly done, the second is a cascade that never
 * ran. The distinction is the whole stranding signal, so the histogram is what the JSON report
 * carries.
 *
 * Keys are stringified numbers because this is serialised straight to JSON.
 *
 * @param {Array<{quantity: number}>} members
 * @returns {Record<string, number>}
 */
export function groupHistogram(members) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const m of members) {
    const k = String(m.quantity);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/**
 * Tagging coverage per body: how much of the keyable population is actually in a blank group.
 *
 * "Keyable" is the honest denominator. A variant that is untracked, or missing a colour, size or
 * body, can never join a group, so counting it as a gap would report a permanent shortfall that no
 * backfill can close and train the operator to ignore the number. The gap reported here is work
 * that can actually be done.
 *
 * This is the reading that was missing at preflight: legacy tagging covered a fraction of the
 * keyable catalogue and nothing surfaced it until the first write path ran.
 *
 * @param {object[]} variants
 * @returns {{byBody: Array<{body: string, keyable: number, tagged: number, untagged: number}>, totals: {keyable: number, tagged: number, untagged: number}, unkeyable: number}}
 */
export function coverageGaps(variants) {
  /** @type {Map<string, {body: string, keyable: number, tagged: number, untagged: number}>} */
  const byBody = new Map();
  let unkeyable = 0;

  for (const v of variants) {
    const keyable = v.tracked !== false && Boolean(v.body) && Boolean(v.color) && Boolean(v.size);
    if (!keyable) {
      // A tagged variant still counts as covered even if it is no longer keyable, but it is not
      // part of the denominator; count it only as a shape problem.
      unkeyable++;
      continue;
    }
    const key = v.body;
    if (!byBody.has(key)) byBody.set(key, { body: key, keyable: 0, tagged: 0, untagged: 0 });
    const row = byBody.get(key);
    row.keyable++;
    if (v.blankId) row.tagged++;
    else row.untagged++;
  }

  const rows = [...byBody.values()].sort((a, b) => a.body.localeCompare(b.body));
  const totals = rows.reduce(
    (acc, r) => ({ keyable: acc.keyable + r.keyable, tagged: acc.tagged + r.tagged, untagged: acc.untagged + r.untagged }),
    { keyable: 0, tagged: 0, untagged: 0 }
  );
  return { byBody: rows, totals, unkeyable };
}

/**
 * Every group that is not converged, whatever the tool calls its state.
 *
 * KEY ON THE QUANTITIES, NOT ON THE STATE. `plan` used to refuse only `DRIFT`, and a group stranded
 * mid-fan-out is normally `AWAITING_SEED` instead: `backfill --stage tag` records a seeding receipt
 * whose rows stay `not-attempted`, which is exactly what `AWAITING_SEED` means. Those groups sailed
 * past the state check and died deeper in, inside `groupQuantity`, as a per-line parse error for
 * what is really a store-state problem. `awaiting-seed` says a non-uniform group is EXPLAINED; it
 * never says it is plannable.
 *
 * @param {Array<{blankId: string, state: string, quantities: number[], members: object[]}>} rows
 * @returns {Array<{blankId: string, state: string, quantities: number[], members: object[]}>}
 */
export function unconvergedGroups(rows) {
  return rows.filter((r) => r.quantities.length > 1);
}

/**
 * Variants that break the single-inventory-level assumption the Flow depends on.
 * @param {object[]} variants
 * @returns {object[]}
 */
export function multiLevelVariants(variants) {
  return variants.filter((v) => (v.locationIds?.length ?? 0) > 1);
}
