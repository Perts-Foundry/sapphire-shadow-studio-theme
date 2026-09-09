// The read side: the queries every command here shares, and the normalisation that turns an Admin
// response into the flat shape the pure verdict modules take.
//
// The queries live in ONE module because check-variants, media-survey and add-option-value must
// agree about what "the variants of this product" means. When they each had their own throwaway
// query they disagreed: one paginated and one did not, and a product past 250 variants reported a
// clean matrix that was simply the first page.
//
// Nothing read here is an instruction. Titles, option values and media alt text are merchant data
// from a store the operator edits by hand; they are quoted in output and never acted on.

/** Admin spells it "Color". Matched case-insensitively; never rewritten. */
export const COLOR_OPTION_NAME = 'Color';

/** The colour bucket for a product that has no colour option at all (the tote is the model). */
export const NO_COLOUR_KEY = '(no colour option)';

const VARIANT_FIELDS = `
  id
  title
  sku
  price
  inventoryPolicy
  inventoryQuantity
  selectedOptions { name value }
  inventoryItem { id tracked measurement { weight { value unit } } }
  media(first: 25) { nodes { id } }
`;

export const Q_PRODUCT = `
query AddProductProduct($identifier: ProductIdentifierInput!) {
  productByIdentifier(identifier: $identifier) {
    id
    handle
    title
    status
    templateSuffix
    options { id name position optionValues { id name } }
    variants(first: 250) {
      pageInfo { hasNextPage endCursor }
      nodes {${VARIANT_FIELDS}}
    }
  }
}`;

export const Q_VARIANTS_PAGE = `
query AddProductVariantsPage($id: ID!, $after: String) {
  product(id: $id) {
    variants(first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {${VARIANT_FIELDS}}
    }
  }
}`;

export const Q_PUBLICATIONS = `
query AddProductPublications($identifier: ProductIdentifierInput!) {
  productByIdentifier(identifier: $identifier) {
    id
    handle
    title
    status
    resourcePublicationsV2(first: 50) {
      nodes { isPublished publication { id name } }
    }
  }
}`;

/**
 * Walk a variants connection to completion.
 *
 * The first page comes from the caller because Q_PRODUCT already fetched it; re-fetching it would
 * double the cost of the common case (every product in this store fits one page) to save a branch.
 *
 * @param {{gql: Function}} client
 * @param {string} productId
 * @param {{nodes: object[], pageInfo: {hasNextPage: boolean, endCursor: string|null}}} firstPage
 * @param {{maxPages?: number}} [opts]
 * @returns {Promise<object[]>}
 */
export async function fetchAllVariants(client, productId, firstPage, opts = {}) {
  const { maxPages = 20 } = opts;
  const nodes = [...(firstPage?.nodes ?? [])];
  let info = firstPage?.pageInfo ?? { hasNextPage: false, endCursor: null };
  let pages = 1;
  while (info.hasNextPage) {
    if (pages >= maxPages) throw new Error(`variants pagination exceeded ${maxPages} pages for ${productId}; refusing to continue`);
    const data = await client.gql(Q_VARIANTS_PAGE, { id: productId, after: info.endCursor });
    const conn = data?.product?.variants;
    if (!conn) throw new Error(`a variants page for ${productId} returned no connection`);
    nodes.push(...(conn.nodes ?? []));
    info = conn.pageInfo ?? { hasNextPage: false, endCursor: null };
    pages++;
  }
  return nodes;
}

/**
 * Flatten one raw variant node.
 *
 * `tracked` and the weight are read off `inventoryItem`, which is where they live; a missing
 * inventoryItem yields null rather than a default, because "we did not read it" and "it is false"
 * are different facts and the zero-weight check turns on the difference.
 *
 * @param {object} node
 * @returns {object}
 */
export function normaliseVariant(node) {
  const weight = node?.inventoryItem?.measurement?.weight ?? null;
  return {
    id: node.id,
    title: node.title ?? null,
    sku: node.sku ?? null,
    price: node.price ?? null,
    inventoryPolicy: node.inventoryPolicy ?? null,
    inventoryQuantity: node.inventoryQuantity ?? null,
    tracked: node.inventoryItem?.tracked ?? null,
    inventoryItemId: node.inventoryItem?.id ?? null,
    weight: weight ? weight.value : null,
    weightUnit: weight ? weight.unit : null,
    selectedOptions: (node.selectedOptions ?? []).map((o) => ({ name: o.name, value: o.value })),
    mediaIds: (node.media?.nodes ?? []).map((m) => m.id),
  };
}

/**
 * Read one product whole.
 * @param {{gql: Function}} client
 * @param {string} handle
 * @returns {Promise<object>}
 */
export async function fetchProduct(client, handle) {
  const data = await client.gql(Q_PRODUCT, { identifier: { handle } });
  const raw = data?.productByIdentifier;
  if (!raw) throw new Error(`no product resolves for handle "${handle}"`);
  const variantNodes = await fetchAllVariants(client, raw.id, raw.variants);
  return {
    id: raw.id,
    handle: raw.handle ?? handle,
    title: raw.title ?? null,
    status: raw.status ?? null,
    templateSuffix: raw.templateSuffix ?? null,
    options: (raw.options ?? []).map((o) => ({
      id: o.id,
      name: o.name,
      position: o.position ?? null,
      values: (o.optionValues ?? []).map((v) => v.name),
    })),
    variants: variantNodes.map(normaliseVariant),
  };
}

/**
 * Read publication state for one product.
 *
 * A separate query rather than a field on Q_PRODUCT: `resourcePublicationsV2` needs read_publications,
 * and folding it into the query every command runs would make the whole directory fail on a store
 * whose app does not grant it.
 *
 * @param {{gql: Function}} client
 * @param {string} handle
 * @returns {Promise<{handle: string, id: string, title: string|null, status: string|null, published: string[], unpublished: string[]}>}
 */
export async function fetchPublications(client, handle) {
  const data = await client.gql(Q_PUBLICATIONS, { identifier: { handle } });
  const raw = data?.productByIdentifier;
  if (!raw) throw new Error(`no product resolves for handle "${handle}"`);
  const nodes = raw.resourcePublicationsV2?.nodes ?? [];
  return {
    handle: raw.handle ?? handle,
    id: raw.id,
    title: raw.title ?? null,
    status: raw.status ?? null,
    published: nodes.filter((n) => n.isPublished).map((n) => n.publication?.name ?? '(unnamed)').sort(),
    unpublished: nodes.filter((n) => !n.isPublished).map((n) => n.publication?.name ?? '(unnamed)').sort(),
  };
}

/** The value a variant carries for one option, matched case-insensitively by option name. */
export function optionValue(variant, optionName) {
  const hit = (variant.selectedOptions ?? []).find((o) => o.name.toLowerCase() === String(optionName).toLowerCase());
  return hit ? hit.value : null;
}

/** The product's option record for a name, or null. */
export function findOption(product, optionName) {
  return (product.options ?? []).find((o) => o.name.toLowerCase() === String(optionName).toLowerCase()) ?? null;
}

/**
 * Variants grouped by their colour value.
 * @param {object} product
 * @returns {Map<string, object[]>}
 */
export function variantsByColor(product) {
  const groups = new Map();
  for (const v of product.variants) {
    const key = optionValue(v, COLOR_OPTION_NAME) ?? NO_COLOUR_KEY;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  return groups;
}
