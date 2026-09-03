// Synthetic fixtures.
//
// These are pseudonymised, NOT hand-invented: the shape mirrors real live data (underscore-
// separated uppercase ids ending in the size token, real Admin option value spellings, real group
// sizes of 8 to 10 tagged members inside a 21-variant colour+size slice, a mix of tagged and
// untagged variants) with only the supplier and style tokens replaced. Keeping the real delimiters,
// casing, and distribution is deliberate: clean toy fixtures let tests pass while production breaks.
//
// No real blank id, supplier name, or style number may appear in this file. See CLAUDE.md.
//
// THE AXES ARE DERIVED FROM catalogue.json, NOT HAND-MAINTAINED. `BODIES`, `COLORS` and `SIZES`
// used to be a second copy of the catalogue's vocabulary, kept in step with the manifest by hand
// and by nothing else. They are now read from the committed manifest at module load. Only the
// vocabulary is shared; every blank id, variant and quantity below is still synthetic.
//
// WHICH TESTS MAY USE THESE DEFAULTS, AND WHICH MAY NOT. This is the load-bearing rule, and it is
// broader than "keep manifestFor() override-capable":
//
//   - A test that validates LOGIC (sorting, derivation, reconciliation, anything order-sensitive)
//     must use an explicit hand-authored `manifestFor()` override, independent of the live file.
//     Otherwise its expected output is computed from the same data as its actual output, which
//     checks self-consistency rather than correctness.
//   - A test whose intent is genuinely "matches production" may use the derived defaults.
//
// The consequence to be aware of: editing catalogue.json now changes what the derived-default tests
// exercise, with no review moment of their own. The cross-artifact cohesion test in reorder.test.mjs
// reconciles thresholds.json against the manifest, so ADDING a colour or a size fails CI until a
// matching minimum exists. It says nothing about REORDERING existing entries, which is exactly what
// the size-ruler tests are sensitive to; those use an override for that reason.
//
// WHAT THIS FILE DERIVES, AND WHAT IT DELIBERATELY DOES NOT. The manifest grew from three bodies to
// the whole catalogue vocabulary: option axis names, per-colour display and slug spellings, and the
// complete product census with titles and GIDs. Only `BODIES`, `COLORS` and `SIZES` are derived here.
// Nothing else should be: these fixtures model a STOCK PICTURE, and a product title or a GID has no
// part in one. A fixture that grew a product census would be a fourth copy of the census, kept in
// step by nothing, which is the state the manifest exists to end.
//
// THERE IS NO MANIFEST-DOCUMENT BUILDER HERE ANY MORE. `manifestDoc` used to serialise a v1 document
// so the schema's raw-text checks could run against it. Those checks moved to
// scripts/catalogue/test/catalogue-manifest.test.mjs, where every document is hand-authored: a
// schema test fed a document derived from the committed manifest asserts that the file agrees with
// itself. Do not reintroduce one. `manifestFor` stays, because it builds the `{bodies}` shape the
// reorder axis code consumes, and every caller overrides it into a deliberately narrow catalogue.

import { readFileSync } from 'node:fs';
import { vocabKey, normaliseAxis } from '../lib/groups.mjs';
import { parseCatalogue, CATALOGUE_PATH, CATALOGUE_VERSION } from '../../lib/catalogue-manifest.mjs';

const MANIFEST = parseCatalogue(
  readFileSync(new URL(`../../../${CATALOGUE_PATH}`, import.meta.url), 'utf8')
);

/** First-seen union of one axis across every declared body, in declaration order. */
function unionOf(axis) {
  const out = [];
  for (const range of MANIFEST.bodies.values()) {
    for (const value of range[axis]) if (!out.includes(value)) out.push(value);
  }
  return out;
}

const titleCase = (value) => value.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * The catalogue's sizes, in declaration order, in DISPLAY case.
 *
 * Display case rather than the normalised form because these stand in for Admin option values,
 * which is what the code under test receives. Declaration order rather than sorted, because that
 * order is now the size ruler (see buildAxes) and a fixture that re-sorted it would model a
 * catalogue this one is not.
 */
export const SIZES = unionOf('sizes').map((s) => s.toUpperCase());

/** The catalogue's colours, in first-seen declaration order, in display case. */
export const COLORS = unionOf('colors').map(titleCase);

/**
 * Every body the catalogue declares. Three today, and three is the floor that matters: two would be
 * enough to make a test pass and would still hide the bug this axis exists to fix, because with two
 * "the other one" is unambiguous, so a lookup that falls back to the wrong body still lands
 * somewhere plausible.
 */
export const BODIES = [...MANIFEST.bodies.keys()];

if (BODIES.length < 3) {
  throw new Error(
    `${CATALOGUE_PATH} declares ${BODIES.length} body/bodies. These fixtures need at least three: ` +
      `with two, a lookup that falls back to the wrong body still lands somewhere plausible and the ` +
      `multi-body bug they exist to catch goes green.`
  );
}

/** Pseudonymised stand-ins for the live colour+style prefixes, per body. */
const COLOR_TOKEN = {
  Black: 'BLACK',
  'Grey Heather': 'GREY',
  'Classic Navy': 'NAVY',
};
const BODY_TOKEN = {
  crewneck: 'BLANKA',
  'quarter-zip': 'BLANKB',
  'vest-womens': 'SAMPLE',
};

/**
 * @param {string} body
 * @param {string} color
 * @param {string} size
 * @returns {string}
 */
export function blankIdFor(body, color, size) {
  const bodyToken = BODY_TOKEN[body];
  const colorToken = COLOR_TOKEN[color];
  if (!bodyToken || !colorToken) {
    throw new Error(`No fixture blank id for body "${body}" / colour "${color}".`);
  }
  return `${colorToken}_ACME_${bodyToken}_0001_${size}`;
}

let seq = 0;
/**
 * Build one normalised variant, matching catalogue.mjs's normaliseVariant output plus the body
 * attached by bodies.mjs.
 *
 * BODY IS REQUIRED AND HAS NO DEFAULT, deliberately. Defaulting it here would let every test in
 * this suite go on asserting the single-body world that produced the original bug, and they would
 * all stay green while the catalogue they model cannot be represented. Pass `body: null` explicitly
 * when the absence of a body is the thing under test.
 *
 * @param {object} over
 * @returns {object}
 */
export function variant(over = {}) {
  if (!('body' in over)) {
    throw new Error(
      'variant() requires an explicit `body`. There is no default: a fixture that silently assumes ' +
        'one garment is exactly what let colour+size keying look correct. Pass body: null if a ' +
        'missing body is what you are testing.'
    );
  }
  seq += 1;
  const body = over.body;
  // `in`, not `??`: an explicit null means "this axis is genuinely absent", which is a case under
  // test. `??` would quietly substitute the default and the test would assert the wrong thing.
  const color = 'color' in over ? over.color : 'Grey Heather';
  const size = 'size' in over ? over.size : '2XL';
  const tagged = over.blankId !== undefined ? over.blankId : blankIdFor(body, color, size);
  return {
    id: over.id ?? `gid://shopify/ProductVariant/${5000000 + seq}`,
    title: over.title ?? `Design ${seq} / ${color} / ${size}`,
    productHandle: over.productHandle ?? `product-${body}`,
    body,
    color,
    size,
    quantity: over.quantity ?? 11,
    policy: over.policy ?? 'DENY',
    tracked: over.tracked ?? true,
    inventoryItemId: over.inventoryItemId ?? `gid://shopify/InventoryItem/${9000000 + seq}`,
    locationIds: over.locationIds ?? ['gid://shopify/Location/1'],
    blankId: tagged,
    metafieldId: tagged ? over.metafieldId ?? `gid://shopify/Metafield/${7000000 + seq}` : null,
  };
}

/**
 * A realistic body+colour+size slice: `taggedQty.length` tagged members plus `untagged` members at 0.
 * @param {object} opts
 * @returns {object[]}
 */
export function groupSlice({ body = 'crewneck', color = 'Grey Heather', size = '2XL', taggedQty = [11, 11, 11, 11, 11, 11, 11, 11], untagged = 13 } = {}) {
  const members = taggedQty.map((q) => variant({ body, color, size, quantity: q }));
  for (let i = 0; i < untagged; i++) {
    members.push(variant({ body, color, size, quantity: 0, blankId: null }));
  }
  return members;
}

/**
 * A group the Flow left half-propagated: one member on the new value, the rest on the old one.
 *
 * This is the exact shape of the 2026-09-03 stranding, and the shape every `repair` decision turns
 * on. It is built here rather than in the repair suite so no test hand-rolls a "stranded" group that
 * quietly differs from the real one: the discriminating detail is that the CONVERGED member is a
 * single one and the stragglers are the majority, which is what makes every live-state heuristic
 * (majority, mode, histogram peak) return the OLD value and roll the approved change back.
 *
 * `atTargetIndex` exists because which member converged decides which member `selectWriteTarget`
 * then picks, and a fixture that always converged members[0] would never exercise that.
 *
 * @param {object} opts
 * @param {number} opts.target - the approved value; exactly one member holds it
 * @param {number} opts.stale - the value the fan-out never reached
 * @param {number} [opts.members] - total member count
 * @param {number} [opts.atTargetIndex] - which member converged
 * @returns {object[]}
 */
export function strandedGroup({ target, stale, members = 8, atTargetIndex = 0, body = 'crewneck', color = 'Grey Heather', size = '2XL' } = {}) {
  return Array.from({ length: members }, (_, i) =>
    variant({ body, color, size, quantity: i === atTargetIndex ? target : stale })
  );
}

/**
 * The catalogue shape that broke the tool: three bodies sharing one colour and size, all carrying
 * ONE blank id. Correct modelling needs three separate pools; the old colour+size key had exactly
 * one slot for them.
 *
 * @param {object} opts
 * @returns {object[]}
 */
export function crossBodySlice({ color = 'Black', size = 'M', sharedBlankId = 'BLACK_ACME_BLANKA_0001_M' } = {}) {
  return BODIES.map((body) => variant({ body, color, size, blankId: sharedBlankId }));
}

/** Reset the id counter so tests that assert on ordering are deterministic. */
export function resetSeq(to = 0) {
  seq = to;
}

/**
 * A complete thresholds cell map over the fixture axes.
 *
 * Cross-product by construction, because the loud-failure contract keys on "every combination has an
 * entry": a hand-listed subset would make a test pass for the wrong reason, by looking exactly like
 * the gap the refusal exists to report. Keys go through `vocabKey` for the same reason the tool does,
 * so the separator and the normalisation rules live in one place.
 *
 * @param {Record<string, number|{min: number, note?: string}>} [overrides] - keyed by `body|color|size`
 * @param {number} [defaultMin]
 * @returns {Map<string, {min: number, note?: string}>}
 */
export function thresholdsFor(overrides = {}, defaultMin = 5) {
  const cells = new Map();
  for (const body of BODIES) {
    for (const color of COLORS) {
      for (const size of SIZES) {
        cells.set(vocabKey({ body, color, size }), { min: defaultMin });
      }
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    cells.set(key, typeof value === 'number' ? { min: value } : value);
  }
  return cells;
}

/**
 * A parsed catalogue manifest over the fixture axes.
 *
 * Cross-product by default, matching what `thresholdsFor` builds, so the two fixtures describe one
 * consistent world and a test that pairs them is not asserting against a shape mismatch it created
 * itself. Pass an override to narrow one body (the women's vest is Black only on the real
 * catalogue), or `null` to remove a body entirely.
 *
 * @param {Record<string, {colors: string[], sizes: string[]}|null>} [overrides] - keyed by body id
 * @returns {{version: number, bodies: Map<string, {colors: string[], sizes: string[]}>}}
 */
/**
 * The real catalogue's narrowing: the women's vest is made in one colour only.
 *
 * Read from the manifest rather than restated, and shared rather than redeclared per suite, because
 * it is the one divergence the whole per-body split exists to represent and two copies would let one
 * drift into describing a catalogue that is not this one.
 *
 * THE SINGLE-COLOUR ASSERTION IS THE POINT, not a formality. Every consumer of this constant is
 * modelling "one body is narrower than the others". If the vest ever gained a second colour, a
 * derived-but-unchecked constant would silently convert all of them into multi-colour scenarios with
 * nothing failing to flag the shift, which is precisely the class of silent drift deriving from the
 * manifest is supposed to end. So it fails loudly at load instead.
 */
const VEST_BODY = 'vest-womens';
const vestRange = MANIFEST.bodies.get(VEST_BODY);
if (!vestRange) {
  throw new Error(
    `${CATALOGUE_PATH} no longer declares "${VEST_BODY}". These fixtures model a catalogue where one ` +
      `body is narrower than the others; pick the new narrow body and update VEST_BLACK_ONLY.`
  );
}
if (vestRange.colors.length !== 1) {
  throw new Error(
    `${CATALOGUE_PATH} declares ${vestRange.colors.length} colours for "${VEST_BODY}". Every test ` +
      `using VEST_BLACK_ONLY models a single-colour body; a second colour turns them all into ` +
      `multi-colour scenarios with nothing else failing. Update those tests deliberately.`
  );
}
export const VEST_BLACK_ONLY = {
  colors: [...vestRange.colors],
  sizes: [...vestRange.sizes],
};

/**
 * A body narrowed on the SIZE axis, which no real body is today.
 *
 * Colour narrowing and size narrowing run through different loops in buildPivot and
 * deriveThresholds, so a fixture set that only ever narrows colours leaves half the per-body path
 * unexercised.
 *
 * HAND-WRITTEN ON PURPOSE, unlike the axes above. This is a deliberately narrow scenario, not a
 * statement about the catalogue, so deriving it from the manifest would be deriving a fiction.
 */
export const MID_SIZES_ONLY = { colors: ['black'], sizes: ['m', 'l'] };

export function manifestFor(overrides = {}) {
  const bodies = new Map();
  for (const body of BODIES) {
    bodies.set(body, {
      colors: COLORS.map((c) => normaliseAxis(c, 'Color')),
      sizes: SIZES.map((s) => normaliseAxis(s, 'Size')),
    });
  }
  for (const [body, range] of Object.entries(overrides)) {
    if (range === null) bodies.delete(body);
    else bodies.set(body, { colors: [...range.colors], sizes: [...range.sizes] });
  }
  return { version: CATALOGUE_VERSION, bodies };
}

/**
 * A complete budget map over the fixture bodies.
 *
 * Keyed by BODY, not by body+colour: the colour split is derived from a popularity curve exactly as
 * the size split is, so a per-colour budget would be a second source of truth for the same number.
 *
 * @param {number} [defaultBudget]
 * @param {Record<string, number>} [overrides] - keyed by body
 * @returns {Map<string, number>}
 */
export function budgetsFor(defaultBudget = 90, overrides = {}) {
  const budgets = new Map(BODIES.map((body) => [normaliseAxis(body, 'Body'), defaultBudget]));
  for (const [key, value] of Object.entries(overrides)) budgets.set(key, value);
  return budgets;
}
