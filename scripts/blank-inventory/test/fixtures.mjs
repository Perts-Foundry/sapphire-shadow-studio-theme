// Synthetic fixtures.
//
// These are pseudonymised, NOT hand-invented: the shape mirrors real live data (underscore-
// separated uppercase ids ending in the size token, real Admin option value spellings, real group
// sizes of 8 to 10 tagged members inside a 21-variant colour+size slice, a mix of tagged and
// untagged variants) with only the supplier and style tokens replaced. Keeping the real delimiters,
// casing, and distribution is deliberate: clean toy fixtures let tests pass while production breaks.
//
// No real blank id, supplier name, or style number may appear in this file. See CLAUDE.md.

export const SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL'];
export const COLORS = ['Black', 'Grey Heather', 'Classic Navy'];

/** Pseudonymised stand-ins for the live colour+style prefixes. */
const PREFIX = {
  Black: 'BLACK_ACME_FLEECE_0001',
  'Grey Heather': 'GREY_ACME_FLEECE_0001',
  'Classic Navy': 'NAVY_ACME_FLEECE_0001',
};

/**
 * @param {string} color
 * @param {string} size
 * @returns {string}
 */
export function blankIdFor(color, size) {
  return `${PREFIX[color]}_${size}`;
}

let seq = 0;
/**
 * Build one normalised variant, matching catalogue.mjs's normaliseVariant output.
 * @param {object} over
 * @returns {object}
 */
export function variant(over = {}) {
  seq += 1;
  const color = over.color ?? 'Grey Heather';
  const size = over.size ?? '2XL';
  const tagged = over.blankId !== undefined ? over.blankId : blankIdFor(color, size);
  return {
    id: over.id ?? `gid://shopify/ProductVariant/${5000000 + seq}`,
    title: over.title ?? `Design ${seq} / ${color} / ${size}`,
    productHandle: over.productHandle ?? 'product-a',
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
 * A realistic colour+size slice: `taggedQty.length` tagged members plus `untagged` members at 0.
 * @param {object} opts
 * @returns {object[]}
 */
export function groupSlice({ color = 'Grey Heather', size = '2XL', taggedQty = [11, 11, 11, 11, 11, 11, 11, 11], untagged = 13 } = {}) {
  const members = taggedQty.map((q) => variant({ color, size, quantity: q }));
  for (let i = 0; i < untagged; i++) {
    members.push(variant({ color, size, quantity: 0, blankId: null }));
  }
  return members;
}

/** Reset the id counter so tests that assert on ordering are deterministic. */
export function resetSeq(to = 0) {
  seq = to;
}
