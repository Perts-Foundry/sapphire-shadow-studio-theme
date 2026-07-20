// Read the catalogue: every product and every variant, with the blank metafield and the inventory
// state the planner needs.
//
// The pagination and merge logic is pure and takes an injected page-fetch function, so it is
// unit-testable against canned multi-page fixtures with no network. Only `fetchVariantsPage` and
// `fetchProductsPage` touch the Admin client.
//
// Variants are read through the top-level productVariants connection rather than nested under
// products: nesting blows the 1000-point single-query cost ceiling on this catalogue.

export const BLANK_NAMESPACE = 'custom';
export const BLANK_KEY = 'inventory_blank_sku';

export const PRODUCTS_QUERY = `
query BlankInventoryProducts($cursor: String) {
  products(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id handle title status
      variantsCount { count }
    }
  }
}`;

export const VARIANTS_QUERY = `
query BlankInventoryVariants($cursor: String) {
  productVariants(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title inventoryQuantity inventoryPolicy
      product { id handle }
      selectedOptions { name value }
      inventoryItem {
        id tracked
        inventoryLevels(first: 5) { nodes { location { id name } } }
      }
      metafield(namespace: "${BLANK_NAMESPACE}", key: "${BLANK_KEY}") { id value }
    }
  }
}`;

export const LOCATIONS_QUERY = `
query BlankInventoryLocations {
  locations(first: 20) { nodes { id name isActive } }
}`;

/**
 * Fields this tool depends on. If the Admin API renames or drops one, fail loudly here rather than
 * silently mapping undefined into a planner decision that moves real stock.
 */
const REQUIRED_VARIANT_FIELDS = ['id', 'title', 'inventoryQuantity', 'product', 'selectedOptions', 'inventoryItem'];

/**
 * Assert a variant node has the shape the rest of the tool assumes.
 * @param {object} node
 * @param {number} index
 */
export function assertVariantShape(node, index = 0) {
  if (!node || typeof node !== 'object') {
    throw new Error(`Variant #${index} is not an object. The Admin API response shape changed.`);
  }
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
  // metafield is legitimately null for an untagged variant, so it is not in the required list.
}

/**
 * Walk a Relay connection to completion.
 * @param {(cursor: string|null) => Promise<{nodes: object[], pageInfo: {hasNextPage: boolean, endCursor: string|null}}>} fetchPage
 * @param {object} [opts]
 * @param {number} [opts.maxPages]
 * @returns {Promise<{nodes: object[], pages: number}>}
 */
export async function paginate(fetchPage, opts = {}) {
  const { maxPages = 200 } = opts;
  const nodes = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    const page = await fetchPage(cursor);
    if (!page || !Array.isArray(page.nodes) || !page.pageInfo) {
      throw new Error('Malformed connection page: expected { nodes, pageInfo }.');
    }
    nodes.push(...page.nodes);
    pages++;
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
    if (pages >= maxPages) {
      throw new Error(`Pagination exceeded ${maxPages} pages; refusing to continue.`);
    }
  }
  return { nodes, pages };
}

/**
 * Normalise a raw variant node into the shape the rest of the tool uses.
 * @param {object} node
 * @returns {object}
 */
export function normaliseVariant(node) {
  const opt = (name) => node.selectedOptions.find((o) => o.name === name)?.value ?? null;
  const levels = node.inventoryItem?.inventoryLevels?.nodes ?? [];
  return {
    id: node.id,
    title: node.title,
    productHandle: node.product?.handle ?? null,
    color: opt('Color'),
    size: opt('Size'),
    quantity: node.inventoryQuantity,
    policy: node.inventoryPolicy ?? null,
    tracked: node.inventoryItem?.tracked ?? null,
    inventoryItemId: node.inventoryItem?.id ?? null,
    locationIds: levels.map((l) => l.location.id),
    blankId: (node.metafield?.value ?? '').trim() || null,
    metafieldId: node.metafield?.id ?? null,
  };
}

/**
 * Read the whole catalogue. Pure apart from the injected fetchers.
 * @param {object} deps
 * @param {(cursor: string|null) => Promise<object>} deps.fetchProductsPage
 * @param {(cursor: string|null) => Promise<object>} deps.fetchVariantsPage
 * @param {() => Promise<object[]>} deps.fetchLocations
 * @returns {Promise<{products: object[], variants: object[], locations: object[], locationId: string}>}
 */
export async function readCatalogue({ fetchProductsPage, fetchVariantsPage, fetchLocations }) {
  const [{ nodes: products }, { nodes: rawVariants }, locations] = await Promise.all([
    paginate(fetchProductsPage),
    paginate(fetchVariantsPage),
    fetchLocations(),
  ]);

  rawVariants.forEach(assertVariantShape);

  const expected = products.reduce((n, p) => n + (p.variantsCount?.count ?? 0), 0);
  if (expected !== rawVariants.length) {
    throw new Error(
      `Variant read is incomplete: fetched ${rawVariants.length}, products report ${expected}. ` +
        `A truncated read must never be mistaken for a clean catalogue.`
    );
  }

  return {
    products,
    variants: rawVariants.map(normaliseVariant),
    locations,
  };
}

/**
 * Bind the queries above to a live Admin client.
 * @param {import('./admin.mjs').AdminClient} client
 * @returns {{fetchProductsPage: Function, fetchVariantsPage: Function, fetchLocations: Function}}
 */
export function liveFetchers(client) {
  return {
    fetchProductsPage: async (cursor) => (await client.gql(PRODUCTS_QUERY, { cursor })).products,
    fetchVariantsPage: async (cursor) => (await client.gql(VARIANTS_QUERY, { cursor })).productVariants,
    fetchLocations: async () => (await client.gql(LOCATIONS_QUERY)).locations.nodes,
  };
}
