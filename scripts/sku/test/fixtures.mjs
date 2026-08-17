// Synthetic catalogue fixtures.
//
// The shape mirrors the real store rather than being convenient: real Admin option-value spellings
// (`RN (Registered Nurse)`, not `RN`), a design-less product so the P-C-S shape is exercised, a gift
// card whose option is a formatted currency string, and one unmapped colour so the extension path
// has a test. Toy fixtures let a derivation pass here and produce wrong SKUs in production, which is
// the one failure mode this data cannot detect after the fact.
//
// Everything here is public catalogue information. Nothing supplier-keyed belongs in a SKU fixture.

export const SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL'];

export const TABLES = {
  version: 1,
  ambiguityExemptions: ['GIFT'],
  colors: { Black: 'BLK', 'Grey Heather': 'GRH', 'Classic Navy': 'NVY' },
  designs: {
    'lead-ii': { 'RN (Registered Nurse)': 'RN', Medic: 'MDC' },
    huddle: { Nurse: 'NRS', 'Vet Tech': 'VTT' },
  },
  denominations: { '$10.00': '010', '$50.00': '050' },
  products: {
    'lead-ii-crewneck': {
      code: 'L2CN',
      title: 'Lead II Crewneck',
      designNamespace: 'lead-ii',
      segments: [
        { kind: 'design', option: 'Design' },
        { kind: 'color', option: 'Color' },
        { kind: 'size', option: 'Size' },
      ],
    },
    'huddle-crewneck': {
      code: 'HDCN',
      title: 'Huddle Crewneck',
      designNamespace: 'huddle',
      segments: [
        { kind: 'design', option: 'Design' },
        { kind: 'color', option: 'Color' },
        { kind: 'size', option: 'Size' },
      ],
    },
    'shift-fuel-crewneck': {
      code: 'SFCN',
      title: 'Shift Fuel Crewneck',
      segments: [
        { kind: 'color', option: 'Color' },
        { kind: 'size', option: 'Size' },
      ],
    },
    'sapphire-shadow-studio-gift-card': {
      code: 'GIFT',
      title: 'Gift Card',
      segments: [{ kind: 'denomination', option: 'Denominations' }],
    },
  },
};

let seq = 0;
const nextId = () => `gid://shopify/ProductVariant/${++seq}`;

export function resetIds() {
  seq = 0;
}

export const PRODUCT_IDS = {
  'lead-ii-crewneck': 'gid://shopify/Product/1',
  'huddle-crewneck': 'gid://shopify/Product/2',
  'shift-fuel-crewneck': 'gid://shopify/Product/3',
  'sapphire-shadow-studio-gift-card': 'gid://shopify/Product/4',
};

/**
 * One normalised variant.
 * @param {string} handle
 * @param {object} options
 * @param {object} [over]
 * @returns {object}
 */
export function variant(handle, options, over = {}) {
  return {
    id: over.id ?? nextId(),
    title: Object.values(options).join(' / '),
    sku: over.sku ?? null,
    productId: PRODUCT_IDS[handle] ?? `gid://shopify/Product/${handle}`,
    productHandle: handle,
    productTitle: TABLES.products[handle]?.title ?? handle,
    isGiftCard: handle === 'sapphire-shadow-studio-gift-card',
    options,
    ...over,
  };
}

/**
 * A small but structurally complete catalogue: two design-bearing products, one without a design
 * axis, and the gift card.
 * @param {object} [opts]
 * @param {boolean} [opts.unmappedColor] - add a colour with no code, the extension-flow case
 * @returns {object[]}
 */
export function catalogue({ unmappedColor = false } = {}) {
  resetIds();
  const out = [];
  for (const design of ['RN (Registered Nurse)', 'Medic']) {
    for (const color of ['Black', 'Grey Heather']) {
      for (const size of ['S', '2XL']) {
        out.push(variant('lead-ii-crewneck', { Design: design, Color: color, Size: size }));
      }
    }
  }
  for (const size of ['S', 'M']) {
    out.push(variant('huddle-crewneck', { Design: 'Nurse', Color: 'Classic Navy', Size: size }));
    out.push(variant('shift-fuel-crewneck', { Color: 'Black', Size: size }));
  }
  for (const denom of ['$10.00', '$50.00']) {
    out.push(variant('sapphire-shadow-studio-gift-card', { Denominations: denom }));
  }
  if (unmappedColor) {
    out.push(variant('shift-fuel-crewneck', { Color: 'Forest Green', Size: 'M' }));
  }
  return out;
}

/**
 * A paginated connection fetcher over canned pages, for the catalogue read tests.
 * @param {object[][]} pages
 * @returns {(cursor: string|null) => Promise<object>}
 */
export function pagedFetcher(pages) {
  return async (cursor) => {
    const i = cursor === null || cursor === undefined ? 0 : Number(cursor);
    return {
      nodes: pages[i] ?? [],
      pageInfo: { hasNextPage: i < pages.length - 1, endCursor: String(i + 1) },
    };
  };
}

/**
 * A raw (un-normalised) variant node as the Admin API returns it.
 * @param {object} over
 * @returns {object}
 */
export function rawVariant(over = {}) {
  return {
    id: over.id ?? nextId(),
    title: over.title ?? 'RN (Registered Nurse) / Black / M',
    sku: over.sku ?? null,
    product: over.product ?? {
      id: PRODUCT_IDS['lead-ii-crewneck'],
      handle: 'lead-ii-crewneck',
      title: 'Lead II Crewneck',
      isGiftCard: false,
    },
    selectedOptions: over.selectedOptions ?? [
      { name: 'Design', value: 'RN (Registered Nurse)' },
      { name: 'Color', value: 'Black' },
      { name: 'Size', value: 'M' },
    ],
  };
}
