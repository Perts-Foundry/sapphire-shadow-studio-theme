// Synthetic fixtures.
//
// These are pseudonymised, NOT hand-invented: the shape mirrors real live data (underscore-
// separated uppercase ids ending in the size token, real Admin option value spellings, real group
// sizes of 8 to 10 tagged members inside a 21-variant colour+size slice, a mix of tagged and
// untagged variants) with only the supplier and style tokens replaced. Keeping the real delimiters,
// casing, and distribution is deliberate: clean toy fixtures let tests pass while production breaks.
//
// No real blank id, supplier name, or style number may appear in this file. See CLAUDE.md.

import { vocabKey, normaliseAxis } from '../lib/groups.mjs';

export const SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL'];
export const COLORS = ['Black', 'Grey Heather', 'Classic Navy'];

/**
 * Three bodies, matching the real catalogue's shape. Two would be enough to make a test pass and
 * would still hide the bug this axis exists to fix: with two, "the other one" is unambiguous, so a
 * lookup that falls back to the wrong body still lands somewhere plausible.
 */
export const BODIES = ['crewneck', 'quarter-zip', 'vest-womens'];

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
  return { version: 1, bodies };
}

/**
 * A catalogue manifest as TEXT, so the raw-text checks (duplicate keys, JSON syntax) are exercised
 * the way the tool runs. The default mirrors the real catalogue's shape, vest narrowing included.
 *
 * @param {object} [over]
 * @returns {string}
 */
export function manifestDoc({ version = 1, comment, bodies } = {}) {
  const doc = { version };
  if (comment !== undefined) doc.comment = comment;
  doc.bodies = bodies ?? {
    crewneck: { colors: ['black', 'grey heather', 'classic navy'], sizes: ['xs', 's', 'm', 'l', 'xl', '2xl'] },
    'quarter-zip': { colors: ['black', 'grey heather', 'classic navy'], sizes: ['xs', 's', 'm', 'l', 'xl', '2xl'] },
    'vest-womens': { colors: ['black'], sizes: ['xs', 's', 'm', 'l', 'xl', '2xl'] },
  };
  return JSON.stringify(doc, null, 2);
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
