// Synthetic catalogue fixtures.
//
// The shape mirrors the real store rather than being convenient: real Admin option-value spellings
// (`RN (Registered Nurse)`, not `RN`), a design-less product so the P-C-S shape is exercised, a gift
// card whose option is a formatted currency string, and one unmapped colour so the extension path
// has a test. Toy fixtures let a derivation pass here and produce wrong SKUs in production, which is
// the one failure mode this data cannot detect after the fact.
//
// Everything here is public catalogue information. Nothing supplier-keyed belongs in a SKU fixture.
//
// THE MANIFEST HERE IS HAND-AUTHORED, and the committed catalogue.json is never read. Half the
// derivation inputs come from the manifest now (the option axis names, the colour ids, each
// product's declared size range), and feeding these tests the live file would make every assertion a
// statement about today's catalogue rather than about the derivation, and would rewrite itself the
// next time a product shipped. `TABLES` is the RAW committed shape and `EFFECTIVE` is what every
// module actually receives.

import { parseCatalogue } from '../../lib/catalogue-manifest.mjs';
import { effectiveTables } from '../lib/tables.mjs';

export const SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL'];

/** A hand-authored manifest covering exactly the five fixture products. */
export const MANIFEST = parseCatalogue(
  JSON.stringify({
    version: 2,
    options: { color: 'Color', size: 'Size', design: 'Design', denomination: 'Denominations' },
    colors: {
      black: { display: 'Black', slug: 'black' },
      'grey heather': { display: 'Grey Heather', slug: 'grey-heather' },
      'classic navy': { display: 'Classic Navy', slug: 'classic-navy' },
    },
    sizes: {
      xs: { display: 'XS' },
      s: { display: 'S' },
      m: { display: 'M' },
      l: { display: 'L' },
      xl: { display: 'XL' },
      '2xl': { display: '2XL' },
    },
    bodies: {
      crewneck: {
        colors: ['black', 'grey heather', 'classic navy'],
        sizes: ['xs', 's', 'm', 'l', 'xl', '2xl'],
      },
    },
    products: {
      'lead-ii-crewneck': {
        line: 'lead2',
        body: 'crewneck',
        template: 'lead-ii-crewneck',
        title: 'Lead II Crewneck',
        gid: 'gid://shopify/Product/1',
      },
      'huddle-crewneck': {
        line: 'huddle',
        body: 'crewneck',
        template: 'huddle-crewneck',
        title: 'Huddle Crewneck',
        gid: 'gid://shopify/Product/2',
      },
      'shift-fuel-crewneck': {
        line: 'shift-fuel',
        body: 'crewneck',
        template: 'shift-fuel-crewneck',
        title: 'Shift Fuel Crewneck',
        gid: 'gid://shopify/Product/3',
      },
      'sapphire-shadow-studio-gift-card': {
        line: null,
        body: null,
        template: 'gift-card',
        title: 'Gift Card',
        gid: 'gid://shopify/Product/4',
      },
      // An option-less non-garment: one variant, so its SKU is the bare product code.
      'shift-fuel-tote': {
        line: null,
        body: null,
        template: 'shift-fuel-tote',
        title: 'Shift Fuel Tote',
        gid: 'gid://shopify/Product/5',
      },
    },
  })
);

/**
 * The RAW committed shape: codes only. No titles, no option names, colour keys are manifest ids.
 * Use this for anything that validates or lints the committed file.
 */
export const TABLES = {
  version: 2,
  ambiguityExemptions: ['GIFT'],
  colors: { black: 'BLK', 'grey heather': 'GRH', 'classic navy': 'NVY' },
  designs: {
    'lead-ii': { 'RN (Registered Nurse)': 'RN', Medic: 'MDC' },
    huddle: { Nurse: 'NRS', 'Vet Tech': 'VTT' },
  },
  denominations: { '$10.00': '010', '$50.00': '050' },
  products: {
    'lead-ii-crewneck': {
      code: 'L2CN',
      designNamespace: 'lead-ii',
      segments: [{ kind: 'design' }, { kind: 'color' }, { kind: 'size' }],
    },
    'huddle-crewneck': {
      code: 'HDCN',
      designNamespace: 'huddle',
      segments: [{ kind: 'design' }, { kind: 'color' }, { kind: 'size' }],
    },
    'shift-fuel-crewneck': {
      code: 'SFCN',
      segments: [{ kind: 'color' }, { kind: 'size' }],
    },
    'sapphire-shadow-studio-gift-card': {
      code: 'GIFT',
      segments: [{ kind: 'denomination' }],
    },
    'shift-fuel-tote': {
      code: 'SFTB',
      segments: [],
    },
  },
};

/**
 * What every module downstream of `loadTables` actually receives: the codes above merged with the
 * manifest's titles, option names and per-product size ranges.
 */
export const EFFECTIVE = effectiveTables(TABLES, MANIFEST);

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
  'shift-fuel-tote': 'gid://shopify/Product/5',
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
    productTitle: EFFECTIVE.products[handle]?.title ?? handle,
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
