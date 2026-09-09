// The one live write: adding an option value across a line's products, and the hero attach that
// follows it.
//
// Everything in this module is pure except the two functions that take a client, and those two do
// nothing but send a mutation and hand back its payload. The plan, the pre-flight, the expected
// variant counts and the hero decisions are all computed here from a read, so the dry run the
// operator approves and the live run that follows compute the same numbers from the same code.
//
// WHY THE SEQUENCE IS TWO MUTATIONS AND NOT ONE. productOptionUpdate with variantStrategy MANAGE
// mints the new variants at Admin defaults: no weight, tracked as the shop default, and whatever
// price Shopify picks. On a product that is already ACTIVE and published those variants are
// purchasable immediately, so the second mutation is not a tidy-up, it is the rest of the write.
// If the first lands and the second does not, the store is holding variants at defaults and
// `--repair` exists to finish the job. Rollback is not the answer there: deleting a variant loses
// its id and its history for good.
//
// Mutation shapes and the read queries were validated against the Admin schema with
// validate_graphql_codeblocks (productOptionUpdate with OptionUpdateInput plus OptionValueCreateInput
// and variantStrategy MANAGE; productVariantsBulkUpdate with price, inventoryPolicy and
// inventoryItem.measurement.weight; productVariantAppendMedia with ProductVariantAppendMediaInput).
// Re-validate rather than trusting this comment if you change a field.

import { COLOR_OPTION_NAME, NO_COLOUR_KEY, findOption, optionValue } from './admin-reads.mjs';
import { findLiveValue, hexOf, looseKey } from './checks.mjs';

export const M_OPTION_UPDATE = `
mutation AddProductOptionValue($productId: ID!, $option: OptionUpdateInput!, $optionValuesToAdd: [OptionValueCreateInput!]!) {
  productOptionUpdate(productId: $productId, option: $option, optionValuesToAdd: $optionValuesToAdd, variantStrategy: MANAGE) {
    product { id options { id name optionValues { id name } } }
    userErrors { field message code }
  }
}`;

export const M_VARIANTS_BULK_UPDATE = `
mutation AddProductVariantSetup($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id price inventoryPolicy inventoryItem { tracked measurement { weight { value unit } } } }
    userErrors { field message code }
  }
}`;

export const M_APPEND_HERO = `
mutation AddProductAppendHero($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
  productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) {
    productVariants { id }
    userErrors { field message }
  }
}`;

/** Pounds, spelled once. Shopify's enum; the store's shipping rates are configured in lb. */
export const WEIGHT_UNIT = 'POUNDS';

export class OptionValueError extends Error {
  constructor(subject, detail) {
    super(`${subject} ${detail}`);
    this.name = 'OptionValueError';
    this.subject = subject;
  }
}

/**
 * Parse `--weight-lb handle=1.6,other=2.1`.
 *
 * Every affected handle needs one. A missing weight is not defaulted: a 0-lb variant breaks live
 * shipping rates the moment it exists and was a launch-audit P0 here.
 *
 * @param {string|null} raw
 * @returns {Map<string, number>}
 */
export function parseWeights(raw) {
  const out = new Map();
  if (raw === null || raw === undefined || raw === '') return out;
  for (const part of String(raw).split(',')) {
    const piece = part.trim();
    if (piece === '') continue;
    const eq = piece.indexOf('=');
    if (eq === -1) throw new OptionValueError('--weight-lb', `entry "${piece}" is not handle=lb`);
    const handle = piece.slice(0, eq).trim();
    const lb = Number(piece.slice(eq + 1).trim());
    if (!Number.isFinite(lb) || lb <= 0) {
      throw new OptionValueError('--weight-lb', `weight for "${handle}" must be a positive number of pounds`);
    }
    out.set(handle, lb);
  }
  return out;
}

/**
 * How many variants adding one value to this option will mint.
 *
 * The product of every OTHER option's value count: a Design value on a Design x Color x Size
 * product creates one variant per colour-size pair. This is the number the operator approves, so it
 * is computed from the live option lists and never from a variant count divided by anything (a
 * product with a manually deleted variant would make that arithmetic lie).
 *
 * @param {object} product
 * @param {string} optionName
 * @returns {number}
 */
export function expectedNewVariants(product, optionName) {
  const others = (product.options ?? []).filter((o) => o.name.toLowerCase() !== String(optionName).toLowerCase());
  if (others.length === 0) return 1;
  return others.reduce((acc, o) => acc * Math.max(o.values.length, 1), 1);
}

/**
 * Pre-flight: the value must not already exist anywhere in the run.
 *
 * Loose matching on purpose. An existing value that differs only by a non-breaking space would slip
 * past an exact comparison and the run would add a SECOND, visually identical value; that is the
 * mess this whole directory exists to prevent, not something to discover afterwards.
 *
 * @param {object[]} products
 * @param {string} optionName
 * @param {string} value
 */
export function assertValueAbsent(products, optionName, value) {
  const hits = products
    .map((p) => ({ handle: p.handle, live: findLiveValue(p, optionName, value) }))
    .filter((h) => h.live !== null);
  if (hits.length) {
    throw new OptionValueError(
      `option value "${value}"`,
      `already exists on ${hits.map((h) => `${h.handle} (as ${JSON.stringify(h.live)}, hex ${hexOf(h.live)})`).join(', ')}. ` +
        'Nothing was written. If the value is genuinely missing elsewhere, run this for the handles that lack it, ' +
        'and use --repair if the existing variants need their price, weight, tracking or policy finished.',
    );
  }
}

/**
 * Build the phase 0 plan.
 * @param {object} o
 * @param {object[]} o.products - normalised products in resolved handle order
 * @param {string} o.option
 * @param {string} o.value
 * @param {string} o.price
 * @param {Map<string, number>} o.weights
 * @returns {{rows: object[], totalNew: number}}
 */
export function planAddition({ products, option, value, price, weights }) {
  const missingWeight = products.map((p) => p.handle).filter((h) => !weights.has(h));
  if (missingWeight.length) {
    throw new OptionValueError('--weight-lb', `has no weight for ${missingWeight.join(', ')}; every affected handle needs one`);
  }
  const rows = products.map((product) => {
    const opt = findOption(product, option);
    if (!opt) {
      throw new OptionValueError(product.handle, `has no "${option}" option; this run would create one, which is not what --value means`);
    }
    return {
      handle: product.handle,
      productId: product.id,
      status: product.status,
      optionId: opt.id,
      optionName: opt.name,
      existingValues: opt.values.length,
      expectedNew: expectedNewVariants(product, option),
      price,
      weightLb: weights.get(product.handle),
    };
  });
  return { rows, totalNew: rows.reduce((acc, r) => acc + r.expectedNew, 0) };
}

/**
 * The variant ids a run is responsible for on one product: those carrying the new value.
 *
 * Read back off the product rather than taken from the mutation payload, because the payload of
 * productOptionUpdate reports the product's options, not the variants Shopify minted for them.
 *
 * @param {object} product - re-read after the option update
 * @param {string} option
 * @param {string} value
 * @returns {object[]}
 */
export function variantsCarrying(product, option, value) {
  const key = looseKey(value);
  return product.variants.filter((v) => {
    const val = optionValue(v, option);
    return val !== null && looseKey(val) === key;
  });
}

/**
 * The productVariantsBulkUpdate input for the new variants.
 * @param {object[]} variants
 * @param {{price: string, weightLb: number}} o
 * @returns {object[]}
 */
export function variantSetupInput(variants, { price, weightLb }) {
  return variants.map((v) => ({
    id: v.id,
    price,
    inventoryPolicy: 'DENY',
    inventoryItem: { tracked: true, measurement: { weight: { value: weightLb, unit: WEIGHT_UNIT } } },
  }));
}

/**
 * Plan the hero attach for one product.
 *
 * The hero is read off the colour's EXISTING variants, which is what makes this safe to run for a
 * new design value or size: those land under colours that already have photography, so there is a
 * right answer already in the store. Two distinct ids on one colour means there is not, and that is
 * a STOP rather than a guess; picking one would silently change what half the variants show.
 *
 * Already-attached targets are skipped, so a re-run after a partial failure attaches only what is
 * left.
 *
 * @param {object} product
 * @param {{option: string, value: string}} o
 * @returns {{colors: object[], stops: string[], attachments: Array<{variantId: string, mediaIds: string[]}>, skipped: number}}
 */
export function planHeroAttach(product, { option, value }) {
  const targetIds = new Set(variantsCarrying(product, option, value).map((v) => v.id));
  const groups = new Map();
  for (const v of product.variants) {
    const key = optionValue(v, COLOR_OPTION_NAME) ?? NO_COLOUR_KEY;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }

  const colors = [];
  const stops = [];
  const attachments = [];
  let skipped = 0;
  for (const [color, variants] of groups) {
    const existing = variants.filter((v) => !targetIds.has(v.id));
    const heroIds = [...new Set(existing.flatMap((v) => v.mediaIds ?? []))];
    const targets = variants.filter((v) => targetIds.has(v.id));
    const attachable = targets.filter((v) => (v.mediaIds ?? []).length === 0);
    skipped += targets.length - attachable.length;
    const row = {
      color,
      heroIds,
      heroId: heroIds.length === 1 ? heroIds[0] : null,
      targets: targets.map((v) => v.id),
      attach: attachable.map((v) => v.id),
      alreadyAttached: targets.length - attachable.length,
    };
    if (heroIds.length > 1) {
      stops.push(
        `${product.handle} / ${color}: ${heroIds.length} distinct hero media ids on the existing variants ` +
          `(${heroIds.join(', ')}). Decide which is the hero before attaching anything.`,
      );
    } else if (heroIds.length === 0 && attachable.length > 0) {
      row.note = 'no media on any existing variant of this colour; nothing to copy';
    } else if (row.heroId) {
      for (const variantId of row.attach) attachments.push({ variantId, mediaIds: [row.heroId] });
    }
    colors.push(row);
  }
  return { colors, stops, attachments, skipped };
}

/** Add the option value. Returns the raw payload; userErrors are the caller's to read. */
export async function addOptionValue(client, { productId, optionId, value }) {
  const data = await client.gql(M_OPTION_UPDATE, {
    productId,
    option: { id: optionId },
    optionValuesToAdd: [{ name: value }],
  });
  return data.productOptionUpdate;
}

/** Set price, weight, tracking and policy on the given variants. */
export async function setUpVariants(client, { productId, variants }) {
  const data = await client.gql(M_VARIANTS_BULK_UPDATE, { productId, variants });
  return data.productVariantsBulkUpdate;
}

/** Append one media id to each named variant. */
export async function appendHeroes(client, { productId, variantMedia }) {
  const data = await client.gql(M_APPEND_HERO, { productId, variantMedia });
  return data.productVariantAppendMedia;
}
