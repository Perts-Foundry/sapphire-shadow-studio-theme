// Read every product and variant this tool reasons about.
//
// Pagination and normalisation take injected fetchers, so the whole read path is unit-testable
// against canned multi-page fixtures with no network. The completeness assertion is the important
// part: a truncated read that looks clean would report "0 nulls remaining" for variants it never
// saw, which is exactly the half-populated state this tooling exists to prevent.
//
// Variants come from the top-level productVariants connection rather than nested under products,
// matching scripts/blank-inventory/lib/catalogue.mjs: nesting blows the single-query cost ceiling
// on this catalogue.

import { paginate } from '../../blank-inventory/lib/catalogue.mjs';

export { paginate };

export const PRODUCTS_QUERY = `
query SkuProducts($cursor: String) {
  products(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id handle title status isGiftCard
      variantsCount { count }
    }
  }
}`;

export const VARIANTS_QUERY = `
query SkuVariants($cursor: String) {
  productVariants(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title sku
      product { id handle title isGiftCard }
      selectedOptions { name value }
    }
  }
}`;

/** A per-product re-read, for apply's baseline guard. */
export const PRODUCT_VARIANTS_QUERY = `
query SkuProductVariants($id: ID!, $cursor: String) {
  product(id: $id) {
    id handle
    variants(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title sku
        selectedOptions { name value }
      }
    }
  }
}`;

const REQUIRED_VARIANT_FIELDS = ['id', 'product', 'selectedOptions'];

/**
 * Assert a variant node has the shape the rest of the tool assumes.
 *
 * `sku` is legitimately null (that is the state being fixed), so it is not required to be present
 * as a value, but the field must be selected: an absent key and a null value are indistinguishable
 * downstream, and treating an unselected field as "no SKU" would plan a write over a real one.
 *
 * @param {object} node
 * @param {number} index
 */
export function assertVariantShape(node, index = 0) {
  assertSkuShape(node, index);
  const missing = REQUIRED_VARIANT_FIELDS.filter((f) => node[f] === undefined || node[f] === null);
  if (missing.length) {
    throw new Error(
      `Variant #${index} (${node.id ?? 'unknown id'}) is missing field(s): ${missing.join(', ')}. ` +
        `The Admin API response shape changed; do not trust any plan built from this read.`
    );
  }
  if (!Array.isArray(node.selectedOptions)) {
    throw new Error(`Variant ${node.id} selectedOptions is not an array. Response shape changed.`);
  }
}

/**
 * The narrower shape the baseline re-read needs: an id and a selected `sku`.
 *
 * The re-read reads variants NESTED UNDER a product, so its nodes carry no `product` field and no
 * options; demanding the full catalogue shape there rejected every row of a 431-row plan. Splitting
 * the assertion keeps each read strict about what it actually consumes rather than about what some
 * other read consumes.
 *
 * @param {object} node
 * @param {number} index
 */
export function assertSkuShape(node, index = 0) {
  if (!node || typeof node !== 'object') {
    throw new Error(`Variant #${index} is not an object. The Admin API response shape changed.`);
  }
  if (!node.id) {
    throw new Error(`Variant #${index} has no id. The Admin API response shape changed.`);
  }
  if (!('sku' in node)) {
    throw new Error(
      `Variant ${node.id} has no "sku" key. The query stopped selecting it; a missing selection ` +
        `would read as an empty SKU and plan a write over a real one.`
    );
  }
}

/**
 * Normalise a raw variant node.
 * @param {object} node
 * @param {object} [product] - the product node, when the variant was read nested under one
 * @returns {object}
 */
export function normaliseVariant(node, product = null) {
  const options = {};
  for (const o of node.selectedOptions) options[o.name] = o.value;
  const prod = node.product ?? product ?? {};
  return {
    id: node.id,
    title: node.title ?? null,
    sku: (node.sku ?? '').trim() || null,
    productId: prod.id ?? null,
    productHandle: prod.handle ?? null,
    productTitle: prod.title ?? null,
    isGiftCard: prod.isGiftCard ?? false,
    options,
  };
}

/**
 * Read the whole catalogue.
 * @param {object} deps
 * @param {(cursor: string|null) => Promise<object>} deps.fetchProductsPage
 * @param {(cursor: string|null) => Promise<object>} deps.fetchVariantsPage
 * @returns {Promise<{products: object[], variants: object[]}>}
 */
export async function readCatalogue({ fetchProductsPage, fetchVariantsPage }) {
  const [{ nodes: products }, { nodes: rawVariants }] = await Promise.all([
    paginate(fetchProductsPage),
    paginate(fetchVariantsPage),
  ]);

  rawVariants.forEach(assertVariantShape);

  const expected = products.reduce((n, p) => n + (p.variantsCount?.count ?? 0), 0);
  if (expected !== rawVariants.length) {
    throw new Error(
      `Variant read is incomplete: fetched ${rawVariants.length}, products report ${expected}. ` +
        `A truncated read must never be mistaken for a clean catalogue.`
    );
  }

  const byId = new Map(products.map((p) => [p.id, p]));
  return {
    products,
    variants: rawVariants.map((v) => {
      const normalised = normaliseVariant(v);
      // isGiftCard is authoritative on the product node; the nested copy is a convenience.
      const product = byId.get(normalised.productId);
      if (product) normalised.isGiftCard = product.isGiftCard ?? normalised.isGiftCard;
      return normalised;
    }),
  };
}

/**
 * Re-read one product's variants, for apply's baseline guard.
 *
 * This MUST hit the API on every call rather than serving a snapshot: the guard exists to catch the
 * store moving *during* a multi-batch run, and one snapshot taken before batch 1 would not see it.
 *
 * @param {(cursor: string|null) => Promise<object>} fetchPage
 * @returns {Promise<Map<string, string|null>>} variant id to live SKU
 */
export async function readProductSkus(fetchPage) {
  const { nodes } = await paginate(fetchPage);
  nodes.forEach(assertSkuShape);
  return new Map(nodes.map((n) => [n.id, (n.sku ?? '').trim() || null]));
}

/**
 * Bind the queries above to a live Admin client.
 * @param {import('../../blank-inventory/lib/admin.mjs').AdminClient} client
 * @returns {object}
 */
export function liveFetchers(client) {
  return {
    fetchProductsPage: async (cursor) => (await client.gql(PRODUCTS_QUERY, { cursor })).products,
    fetchVariantsPage: async (cursor) => (await client.gql(VARIANTS_QUERY, { cursor })).productVariants,
    fetchProductVariantsPage: (productId) => async (cursor) => {
      const data = await client.gql(PRODUCT_VARIANTS_QUERY, { id: productId, cursor });
      if (!data.product) throw new Error(`Product ${productId} was not found on re-read.`);
      return data.product.variants;
    },
  };
}
