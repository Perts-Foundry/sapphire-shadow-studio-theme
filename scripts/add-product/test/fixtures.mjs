// Fixtures: normalised products in the shape lib/admin-reads.mjs produces, plus a fake Admin client
// that records the mutations sent to it.
//
// Hand-built rather than captured from a live response on purpose. Every test here turns on one
// deliberate defect (a non-breaking space, an untracked variant, two hero ids on one colour), and a
// captured response would carry a hundred fields that hide which one is the point.

/** A synthetic media id. Never a real one: receipts and fixtures do not share a namespace. */
export const media = (n) => `gid://shopify/MediaImage/${n}`;

export function makeVariant({
  id,
  options,
  price = '48.00',
  weight = 1.6,
  inventoryPolicy = 'DENY',
  tracked = true,
  mediaIds = [],
  sku = null,
  inventoryQuantity = 0,
}) {
  return {
    id,
    title: options.map((o) => o.value).join(' / '),
    sku,
    price,
    inventoryPolicy,
    inventoryQuantity,
    tracked,
    inventoryItemId: `${id}-item`,
    weight,
    weightUnit: 'POUNDS',
    selectedOptions: options,
    mediaIds,
  };
}

/**
 * A full-matrix product. Every option combination exists as a variant, which is how this store is
 * actually laid out (memory: full-matrix-variants).
 *
 * `heroByColor` attaches one media id to every variant of that colour, which is the healthy state.
 * `overrides(variantSpec)` lets one test bend exactly one variant.
 */
export function makeProduct({
  handle,
  id = `gid://shopify/Product/${handle}`,
  status = 'ACTIVE',
  designs = [],
  colors = [],
  sizes = [],
  designOptionName = 'Design',
  heroByColor = {},
  overrides = () => ({}),
}) {
  const options = [];
  if (designs.length) options.push({ id: `${id}/opt-design`, name: designOptionName, position: 1, values: designs });
  if (colors.length) options.push({ id: `${id}/opt-color`, name: 'Color', position: options.length + 1, values: colors });
  if (sizes.length) options.push({ id: `${id}/opt-size`, name: 'Size', position: options.length + 1, values: sizes });

  const variants = [];
  let n = 0;
  const designAxis = designs.length ? designs : [null];
  const colorAxis = colors.length ? colors : [null];
  const sizeAxis = sizes.length ? sizes : [null];
  for (const design of designAxis) {
    for (const color of colorAxis) {
      for (const size of sizeAxis) {
        n += 1;
        const selected = [];
        if (design !== null) selected.push({ name: designOptionName, value: design });
        if (color !== null) selected.push({ name: 'Color', value: color });
        if (size !== null) selected.push({ name: 'Size', value: size });
        const base = {
          id: `gid://shopify/ProductVariant/${handle}-${n}`,
          options: selected,
          mediaIds: color !== null && heroByColor[color] ? [heroByColor[color]] : [],
        };
        variants.push(makeVariant({ ...base, ...overrides({ design, color, size, base }) }));
      }
    }
  }
  return { id, handle, title: handle, status, templateSuffix: null, options, variants };
}

/** A publications record in the shape fetchPublications returns. */
export function makePublication({ handle, status = 'ACTIVE', published = [], unpublished = [] }) {
  return { handle, id: `gid://shopify/Product/${handle}`, title: handle, status, published: [...published].sort(), unpublished: [...unpublished].sort() };
}

/**
 * A fake Admin client. Records every call and answers from a queue of payloads keyed by mutation
 * name, so a test can assert on WHAT was sent as well as on what the command did with the answer.
 */
export function makeFakeClient(responders = {}) {
  const calls = [];
  return {
    calls,
    async gql(query, variables) {
      const name = /mutation (\w+)|query (\w+)/.exec(query);
      const opName = name ? name[1] ?? name[2] : 'unknown';
      calls.push({ opName, query, variables });
      const responder = responders[opName];
      const payload = typeof responder === 'function' ? responder(variables, calls.length) : responder;
      return payload ?? defaultPayload(opName, variables);
    },
  };
}

function defaultPayload(opName, variables) {
  switch (opName) {
    case 'AddProductOptionValue':
      return { productOptionUpdate: { product: { id: 'gid://shopify/Product/1', options: [] }, userErrors: [] } };
    case 'AddProductVariantSetup':
      // Echo every variant it was sent with the SKU it was sent, the way Shopify reports a bulk
      // update that landed. An empty list here would let a test of the SKU clear pass on a payload
      // that describes nothing.
      return {
        productVariantsBulkUpdate: {
          productVariants: (variables?.variants ?? []).map((v) => ({ id: v.id, inventoryItem: { sku: v.inventoryItem?.sku ?? null } })),
          userErrors: [],
        },
      };
    case 'AddProductAppendHero':
      return { productVariantAppendMedia: { productVariants: [], userErrors: [] } };
    default:
      return {};
  }
}

/** Collect log lines from a command run. */
export function makeLogger() {
  const lines = [];
  return { lines, write: (s) => lines.push(String(s)), text: () => lines.join('\n') };
}
