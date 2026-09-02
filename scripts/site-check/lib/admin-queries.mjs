// The Admin GraphQL documents Tier A2 reads, and the read list that binds each document to the
// scopes it needs and the checks it feeds. Pure data plus two pure helpers (pagination and the
// throttle pause); nothing here touches the network, the filesystem or the environment.
//
// Every document below was validated on 2026-09-01 with the shopify-dev `validate_graphql_codeblocks`
// tool against the latest Admin API schema. One change the validator forced: `Market.enabled` and
// `Market.regions` are deprecated, so the markets read uses `status` and
// `conditions.regionsCondition.regions` instead. The scope lists are the ones the validator reported
// for each document (the markets document reports `read_markets`; the validator also lists
// `write_markets`, which a read-only app does not hold and this tool never asks for).
//
// A read entry is:
//   { name, scopes, checks, document, variables?, page?: { path, first }, continue? }
// `page` names the top-level connection whose `endCursor` the runner follows until `hasNextPage`
// is false. `continue(data, gql)` runs after the top-level pages are collected and follows any
// nested connection (product variants); it must leave `pageInfo.hasNextPage` false on every
// connection it completed, because `isPartial` treats a leftover `hasNextPage: true` as an
// incomplete read.

const VARIANT_FIELDS = `
        id sku availableForSale inventoryQuantity
        inventoryItem { requiresShipping measurement { weight { unit value } } }`;

export const DELIVERY_PROFILES_QUERY = `query SiteCheckDeliveryProfiles($first: Int!, $after: String) {
  deliveryProfiles(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      id name default
      profileLocationGroups {
        locationGroup { id }
        locationGroupZones(first: 20) {
          pageInfo { hasNextPage endCursor }
          edges { node {
            zone { name countries { code { countryCode restOfWorld } name provinces { code } } }
            methodDefinitions(first: 20) {
              pageInfo { hasNextPage endCursor }
              edges { node {
                name active
                rateProvider { ... on DeliveryRateDefinition { price { amount currencyCode } } }
                methodConditions { field operator conditionCriteria { ... on MoneyV2 { amount currencyCode } ... on Weight { unit value } } }
              } }
            }
          } }
        }
      }
    } }
  }
}`;

export const PRODUCTS_QUERY = `query SiteCheckProducts($first: Int!, $after: String) {
  products(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      id handle title status templateSuffix
      mediaCount { count }
      breadcrumbCollection: metafield(namespace: "custom", key: "breadcrumb_collection") {
        value
        reference { ... on Collection { handle } }
      }
      variants(first: 100) {
        pageInfo { hasNextPage endCursor }
        edges { node {${VARIANT_FIELDS}
        } }
      }
    } }
  }
}`;

export const PRODUCT_VARIANTS_QUERY = `query SiteCheckProductVariants($id: ID!, $first: Int!, $after: String) {
  product(id: $id) {
    handle
    variants(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges { node {${VARIANT_FIELDS}
      } }
    }
  }
}`;

export const SHOP_POLICIES_QUERY = `query SiteCheckShopPolicies {
  shop { shopPolicies { type body url } }
}`;

export const SHOP_LOCALES_QUERY = `query SiteCheckShopLocales {
  shopLocales { locale primary published }
}`;

export const MARKETS_QUERY = `query SiteCheckMarkets($first: Int!, $after: String) {
  markets(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      id name status
      conditions {
        regionsCondition {
          regions(first: 250) {
            pageInfo { hasNextPage endCursor }
            edges { node { ... on MarketRegionCountry { code name } } }
          }
        }
      }
    } }
  }
}`;

export const MENUS_QUERY = `query SiteCheckMenus($first: Int!, $after: String) {
  menus(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      handle title
      items { title type url items { title type url } }
    } }
  }
}`;

export const SHOP_QUERY = `query SiteCheckShop {
  shop {
    currencyCode
    features { giftCards }
    customerAccountsV2 { customerAccountsVersion }
    paymentSettings { supportedDigitalWallets }
  }
}`;

/**
 * Walk `path` into `data` and return the connection object there (or undefined). Path segments
 * are plain keys; the runner only pages top-level connections.
 */
export function connectionAt(data, path) {
  let cur = data;
  for (const key of path) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * Follow a connection's `endCursor` until `hasNextPage` is false, concatenating `edges`.
 * `fetchPage(after)` returns one page's `data`; the result is the first page's data with the
 * connection at `path` replaced by the merged edges and the LAST page's pageInfo, so a caller
 * that stops early (maxPages) leaves `hasNextPage: true` visible for isPartial.
 *
 * NEVER treats `hasNextPage: true` as complete: that is the exact fail-open shape this exists
 * to prevent.
 *
 * @param {object} o
 * @param {(after: string|null) => Promise<object>} o.fetchPage
 * @param {string[]} o.path
 * @param {number} [o.maxPages]  safety cap; a hit leaves hasNextPage true (reported as partial)
 * @returns {Promise<object>}
 */
export async function paginate({ fetchPage, path, maxPages = 50 }) {
  const first = await fetchPage(null);
  const conn = connectionAt(first, path);
  if (!conn || !conn.pageInfo) return first;
  const edges = [...(conn.edges || [])];
  let pageInfo = conn.pageInfo;
  let pages = 1;
  while (pageInfo.hasNextPage && pages < maxPages) {
    const next = await fetchPage(pageInfo.endCursor);
    const nextConn = connectionAt(next, path);
    if (!nextConn || !nextConn.pageInfo) break;
    edges.push(...(nextConn.edges || []));
    pageInfo = nextConn.pageInfo;
    pages += 1;
  }
  const merged = { ...conn, edges, pageInfo };
  const out = { ...first };
  let target = out;
  for (let i = 0; i < path.length - 1; i++) {
    target[path[i]] = { ...target[path[i]] };
    target = target[path[i]];
  }
  target[path[path.length - 1]] = merged;
  return out;
}

/**
 * Follow each product's variant connection past its first page. Runs as the products read's
 * `continue` hook. Mutates a copy: the returned data has every product's `variants.edges`
 * complete and `pageInfo.hasNextPage` false unless the cap was hit.
 */
export async function continueProductVariants(data, gql, { first = 100, maxPages = 50 } = {}) {
  const products = data && data.products;
  if (!products || !Array.isArray(products.edges)) return data;
  const edges = [];
  for (const edge of products.edges) {
    const node = edge.node;
    if (!node || !node.variants || !node.variants.pageInfo || !node.variants.pageInfo.hasNextPage) {
      edges.push(edge);
      continue;
    }
    const variants = await paginate({
      path: ['product', 'variants'],
      maxPages,
      fetchPage: async (after) => {
        if (after === null) return { product: { variants: node.variants } };
        return gql(PRODUCT_VARIANTS_QUERY, { id: node.id, first, after });
      },
    });
    edges.push({ ...edge, node: { ...node, variants: variants.product.variants } });
  }
  return { ...data, products: { ...products, edges } };
}

/**
 * Milliseconds to pause before the next read, given `extensions.cost.throttleStatus`. Zero when
 * the bucket can absorb another request of the size just made; otherwise the time the restore
 * rate needs to refill the shortfall. Pure and injectable; the client already retries THROTTLED,
 * so this only smooths the pace between reads.
 * @param {{throttleStatus?: {currentlyAvailable?: number, restoreRate?: number}, requestedQueryCost?: number, actualQueryCost?: number}} [cost]
 * @returns {number}
 */
export function throttleDelayMs(cost) {
  const status = cost && cost.throttleStatus;
  if (!status) return 0;
  const available = Number(status.currentlyAvailable);
  const restore = Number(status.restoreRate);
  const needed = Number(cost.actualQueryCost ?? cost.requestedQueryCost ?? 0);
  if (!Number.isFinite(available) || !Number.isFinite(restore) || restore <= 0) return 0;
  if (available >= needed) return 0;
  return Math.ceil(((needed - available) / restore) * 1000);
}

const FIRST = 100;

/** The read list. Order is report order; `checks` lists every check id a skip of this read must mark SKIPPED. */
export const READS = Object.freeze([
  {
    name: 'deliveryProfiles',
    scopes: ['read_shipping'],
    checks: ['shipping-profiles-read', 'shipping-rates-mismatch', 'shipping-rate-conditions'],
    document: DELIVERY_PROFILES_QUERY,
    variables: { first: 20 },
    page: { path: ['deliveryProfiles'], first: 20 },
  },
  {
    name: 'products',
    scopes: ['read_products', 'read_inventory'],
    checks: [
      'variant-weight', 'variant-requires-shipping', 'variant-sku-missing', 'variant-unavailable', 'variant-inventory',
      'product-template-suffix', 'product-status', 'product-media-count', 'product-breadcrumb-metafield',
    ],
    document: PRODUCTS_QUERY,
    variables: { first: FIRST },
    page: { path: ['products'], first: FIRST },
    continue: continueProductVariants,
  },
  {
    name: 'shopPolicies',
    scopes: ['read_legal_policies'],
    checks: ['policy-missing', 'policy-empty', 'policy-shipping-amounts'],
    document: SHOP_POLICIES_QUERY,
  },
  {
    name: 'shopLocales',
    scopes: ['read_locales'],
    checks: ['locales-published'],
    document: SHOP_LOCALES_QUERY,
  },
  {
    name: 'markets',
    scopes: ['read_markets'],
    checks: ['markets-shipping-countries'],
    document: MARKETS_QUERY,
    variables: { first: 50 },
    page: { path: ['markets'], first: 50 },
  },
  {
    name: 'menus',
    scopes: ['read_online_store_navigation'],
    checks: ['menu-catalog-children'],
    document: MENUS_QUERY,
    variables: { first: 10 },
    page: { path: ['menus'], first: 10 },
  },
  {
    name: 'shop',
    scopes: ['read_products'],
    checks: ['shop-currency', 'shop-gift-cards', 'customer-accounts-version', 'digital-wallets'],
    document: SHOP_QUERY,
  },
]);

/** The union of every read's scopes; the README and the skill preflight print it. */
export const REQUIRED_SCOPES = Object.freeze([...new Set(READS.flatMap((r) => r.scopes))]);

/** @param {string} name */
export function readByName(name) { return READS.find((r) => r.name === name); }
