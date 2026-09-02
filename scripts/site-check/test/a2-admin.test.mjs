// Tier A2 tests: the read-only guard, scope skips, partial responses, pagination and the pure
// classifiers. Pure and network-free: the fetch guard is installed first, the "client" is a
// fake gql function, and every fixture is synthetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFetchGuard } from './harness.mjs';
installFetchGuard();

import { parseCatalogue } from '../../lib/catalogue-manifest.mjs';
import { makeFinding } from '../lib/finding.mjs';
import { diffFindings } from '../lib/state.mjs';
import { checkById } from '../lib/registry.mjs';
import { createReadOnlyClient, operationType, readOrSkip, runRead } from '../lib/admin-readonly.mjs';
import { READS, REQUIRED_SCOPES, paginate, continueProductVariants, throttleDelayMs, readByName, PRODUCT_VARIANTS_QUERY } from '../lib/admin-queries.mjs';
import {
  isPartial, partialFinding, flattenProducts, flattenDeliveryProfiles, marketCountries, dollarAmounts,
  classifyDeliveryProfiles, classifyVariants, classifyProducts, classifyPolicies, classifyShop,
} from '../lib/admin-checks.mjs';

// ---------------------------------------------------------------------------
// Fixtures (synthetic: handles and public prices only)
// ---------------------------------------------------------------------------

const CATALOGUE = parseCatalogue(JSON.stringify({
  version: 2,
  comment: 'synthetic test manifest',
  options: { color: 'Color', size: 'Size', design: 'Design', denomination: 'Denominations' },
  colors: { black: { display: 'Black', slug: 'black' } },
  sizes: { s: { display: 'S' }, m: { display: 'M' } },
  bodies: { crewneck: { colors: ['black'], sizes: ['s', 'm'] } },
  products: {
    'test-crewneck': { line: 'test', body: 'crewneck', template: 'test-crewneck', title: 'Test Crewneck', gid: 'gid://shopify/Product/1000000000001' },
    'test-gift-card': { line: null, body: null, template: 'gift-card', title: 'Test Gift Card', gid: 'gid://shopify/Product/1000000000002' },
  },
}));

const SETTINGS = { flat_rate_shipping: '8.00', free_shipping_threshold: '75.00' };

function variant(id, over = {}) {
  return {
    node: {
      id: `gid://shopify/ProductVariant/${id}`, sku: `SKU-${id}`, availableForSale: true, inventoryQuantity: 3,
      inventoryItem: { requiresShipping: true, measurement: { weight: { unit: 'POUNDS', value: 1.2 } } },
      ...over,
    },
  };
}

function product(handle, { status = 'ACTIVE', templateSuffix = handle, mediaCount = 4, breadcrumb = 'crewnecks', variants = [], hasNextPage = false } = {}) {
  return {
    node: {
      id: `gid://shopify/Product/${handle.length}000`, handle, title: handle, status, templateSuffix,
      mediaCount: { count: mediaCount },
      breadcrumbCollection: breadcrumb === null ? null : { value: 'gid://shopify/Collection/1', reference: { handle: breadcrumb } },
      variants: { pageInfo: { hasNextPage, endCursor: hasNextPage ? 'c1' : null }, edges: variants },
    },
  };
}

function profile(rates, name = 'General Profile') {
  return {
    deliveryProfiles: {
      pageInfo: { hasNextPage: false, endCursor: null },
      edges: [{ node: {
        id: 'gid://shopify/DeliveryProfile/1', name, default: true,
        profileLocationGroups: [{ locationGroup: { id: 'g1' }, locationGroupZones: { pageInfo: { hasNextPage: false }, edges: [{ node: {
          zone: { name: 'Domestic', countries: [{ code: { countryCode: 'US', restOfWorld: false }, name: 'United States', provinces: [] }] },
          methodDefinitions: { pageInfo: { hasNextPage: false }, edges: rates.map((r) => ({ node: r })) },
        } }] } }],
      } }],
    },
  };
}

const rate = (name, amount, conditions = [], active = true) => ({
  name, active, rateProvider: { price: { amount, currencyCode: 'USD' } }, methodConditions: conditions,
});
const priceCond = (operator, amount) => ({ field: 'TOTAL_PRICE', operator, conditionCriteria: { amount, currencyCode: 'USD' } });
const weightCond = (operator, value, unit = 'POUNDS') => ({ field: 'TOTAL_WEIGHT', operator, conditionCriteria: { unit, value } });

const byCheck = (findings, check) => findings.filter((f) => f.check === check);

// ---------------------------------------------------------------------------
// Read-only guard
// ---------------------------------------------------------------------------

test('read-only client refuses a mutation before any network call', async () => {
  const calls = [];
  const client = createReadOnlyClient({ gql: async (q, v) => { calls.push([q, v]); return { ok: true }; }, scopes: async () => ['read_products'] });
  await assert.rejects(client.gql('mutation productUpdate($input: ProductInput!) { productUpdate(input: $input) { product { id } } }', {}), /read-only client refused a mutation/);
  await assert.rejects(client.gql('  \n mutation { x }'), /mutation/);
  await assert.rejects(client.gql('subscription { x }'), /subscription/);
  await assert.rejects(client.gql('# harmless comment\n# query { shop { name } }\nmutation { productDelete(input: {id: "x"}) { deletedProductId } }'), /mutation/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await client.gql('query { shop { name } }'), { ok: true });
  assert.deepEqual(await client.gql('{ shop { name } }'), { ok: true });
  assert.deepEqual(await client.gql('# leading comment mentioning mutation\nquery Named { shop { name } }'), { ok: true });
  assert.equal(calls.length, 3);
  assert.equal(operationType('fragment F on Shop { name } query { shop { ...F } }'), 'query');
  assert.equal(operationType('fragment F on Product { id } mutation { productDelete(input: {id: "x"}) { deletedProductId } }'), 'mutation');
  assert.throws(() => operationType(''), /empty/);
  assert.equal(client.readOnly, true);
  assert.deepEqual(await client.scopes(), ['read_products']);
});

test('every READS document passes the guard and the scope union is exported', async () => {
  for (const read of READS) assert.equal(operationType(read.document), 'query', read.name);
  for (const read of READS) for (const c of read.checks) assert.ok(checkById(c), `${read.name} feeds unregistered ${c}`);
  assert.deepEqual([...REQUIRED_SCOPES].sort(), [
    'read_inventory', 'read_legal_policies', 'read_locales', 'read_markets', 'read_online_store_navigation', 'read_products', 'read_shipping',
  ]);
  assert.equal(readByName('shop').scopes.length, 1);
});

// ---------------------------------------------------------------------------
// Scope skip
// ---------------------------------------------------------------------------

test('scope skip yields SKIPPED findings for every check the read feeds, and the differ reports them SKIPPED not RESOLVED', async () => {
  const read = readByName('products');
  const client = { gql: async () => { throw new Error('must not be called'); } };
  const result = await readOrSkip({ client, read, granted: ['read_products'] });
  assert.equal(result.skipped, true);
  assert.deepEqual(result.missing, ['read_inventory']);
  const checks = result.findings.map((f) => f.check);
  for (const c of read.checks) assert.ok(checks.includes(c), c);
  assert.ok(checks.includes('admin-scope-missing'));
  for (const f of result.findings) assert.equal(f.severity, 'SKIPPED');
  assert.equal(result.findings.find((f) => f.check === 'variant-weight').subject, 'read_inventory');

  const previous = [
    makeFinding({ check: 'variant-weight', subject: 'test-crewneck', message: '0 lb' }),
    makeFinding({ check: 'product-media-count', subject: 'test-crewneck', message: 'none' }),
    makeFinding({ check: 'policy-empty', subject: 'REFUND_POLICY', message: 'empty' }),
  ];
  const d = diffFindings(previous, result.findings);
  assert.deepEqual(d.skipped.map((f) => f.id).sort(), ['product-media-count:test-crewneck', 'variant-weight:test-crewneck']);
  assert.deepEqual(d.resolved.map((f) => f.id), ['policy-empty:REFUND_POLICY']);
  assert.equal(d.added.length, 0);
});

test('a read that throws yields one admin-partial-response ERROR with a redacted message, never a crash', async () => {
  const read = readByName('shopLocales');
  const client = {
    gql: async () => { throw new Error('GraphQL errors: [{"message":"boom"}] token shpat_0123456789abcdef secretvalue'); },
    redact: (s) => String(s).split('secretvalue').join('[redacted]'),
  };
  const result = await readOrSkip({ client, read, granted: ['read_locales'], redact: (s) => s.replace(/shpat_\w+/g, '[tok]') });
  assert.equal(result.skipped, false);
  assert.equal(result.findings.length, 1);
  const f = result.findings[0];
  assert.equal(f.check, 'admin-partial-response');
  assert.equal(f.severity, 'ERROR');
  assert.equal(f.subject, 'shopLocales');
  assert.ok(f.message.includes('boom'));
  assert.ok(!f.message.includes('secretvalue') && !f.message.includes('shpat_0123'), f.message);
});

// ---------------------------------------------------------------------------
// Partial responses and pagination
// ---------------------------------------------------------------------------

test('isPartial: errors alongside data, or a hasNextPage left true, is never complete', () => {
  assert.equal(isPartial({ shop: { name: 'x' } }).partial, false);
  const withErrors = isPartial({ data: { shop: { name: 'x' } }, errors: [{ message: 'Access denied for field' }] });
  assert.equal(withErrors.partial, true);
  assert.match(withErrors.reasons[0], /Access denied/);
  const unfollowed = isPartial({ products: { pageInfo: { hasNextPage: true, endCursor: 'x' }, edges: [product('test-crewneck', { hasNextPage: true })] } });
  assert.equal(unfollowed.partial, true);
  assert.deepEqual(unfollowed.reasons, ['unfollowed page at products', 'unfollowed page at products.edges[0].node.variants']);
  const f = partialFinding('products', { products: { pageInfo: { hasNextPage: true }, edges: [] } });
  assert.equal(f.check, 'admin-partial-response');
  assert.equal(f.subject, 'products');
  assert.equal(partialFinding('shop', { shop: {} }), null);
});

test('paginate follows endCursor until hasNextPage is false and merges edges', async () => {
  const pages = {
    null: { products: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, edges: [{ node: { handle: 'a' } }] } },
    c1: { products: { pageInfo: { hasNextPage: true, endCursor: 'c2' }, edges: [{ node: { handle: 'b' } }] } },
    c2: { products: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [{ node: { handle: 'c' } }] } },
  };
  const seen = [];
  const out = await paginate({ path: ['products'], fetchPage: async (after) => { seen.push(after); return pages[String(after)]; } });
  assert.deepEqual(seen, [null, 'c1', 'c2']);
  assert.deepEqual(out.products.edges.map((e) => e.node.handle), ['a', 'b', 'c']);
  assert.equal(out.products.pageInfo.hasNextPage, false);
  assert.equal(isPartial(out).partial, false);

  // A page cap leaves hasNextPage true so the read is reported partial, never silently complete.
  const capped = await paginate({ path: ['products'], maxPages: 2, fetchPage: async (after) => pages[String(after)] });
  assert.equal(capped.products.edges.length, 2);
  assert.equal(capped.products.pageInfo.hasNextPage, true);
  assert.equal(isPartial(capped).partial, true);
});

test('runRead follows product variant pages through the continue hook (two-page fake gql)', async () => {
  const read = readByName('products');
  const firstPage = { products: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [
    product('test-crewneck', { variants: [variant(1)], hasNextPage: true }),
    product('test-gift-card', { variants: [variant(9, { inventoryItem: { requiresShipping: false, measurement: { weight: null } } })] }),
  ] } };
  const calls = [];
  const gql = async (doc, vars) => {
    calls.push(vars);
    if (doc === read.document) return firstPage;
    if (doc === PRODUCT_VARIANTS_QUERY) {
      assert.equal(vars.id, firstPage.products.edges[0].node.id);
      if (vars.after === 'c1') return { product: { variants: { pageInfo: { hasNextPage: true, endCursor: 'c2' }, edges: [variant(2)] } } };
      return { product: { variants: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [variant(3)] } } };
    }
    throw new Error('unexpected document');
  };
  const data = await runRead({ gql }, read);
  const flat = flattenProducts(data);
  assert.deepEqual(flat[0].variants.map((v) => v.id.split('/').pop()), ['1', '2', '3']);
  assert.equal(flat[0].variantsComplete, true);
  assert.equal(isPartial(data).partial, false);
  assert.equal(calls.length, 3);
  // The hook is a no-op on a response without products.
  assert.deepEqual(await continueProductVariants({ shop: {} }, gql), { shop: {} });
});

test('throttleDelayMs is zero with headroom and restore-rate based without', () => {
  assert.equal(throttleDelayMs(undefined), 0);
  assert.equal(throttleDelayMs({ requestedQueryCost: 50, throttleStatus: { currentlyAvailable: 900, restoreRate: 100 } }), 0);
  assert.equal(throttleDelayMs({ requestedQueryCost: 500, throttleStatus: { currentlyAvailable: 100, restoreRate: 100 } }), 4000);
  assert.equal(throttleDelayMs({ requestedQueryCost: 500, throttleStatus: { currentlyAvailable: 100, restoreRate: 0 } }), 0);
});

// ---------------------------------------------------------------------------
// Shipping
// ---------------------------------------------------------------------------

test('shipping: matching sets are silent, mismatches print both sets order-insensitively, conditions are INFO', () => {
  const rates = [
    rate('Flat Rate', '8.0', [priceCond('LESS_THAN', '75.0')]),
    rate('Free Shipping', '0.0', [priceCond('GREATER_THAN_OR_EQUAL_TO', '75.0')]),
    rate('Retired', '99.0', [], false),
  ];
  const profiles = flattenDeliveryProfiles(profile(rates));
  assert.deepEqual(profiles[0].countries, ['US']);
  const ok = classifyDeliveryProfiles({ profiles, settings: SETTINGS, copyAmounts: ['75.00', '8.00'], copyTokens: ['free', 'flat', 'on', 'orders'] });
  assert.equal(byCheck(ok, 'shipping-rates-mismatch').length, 0);
  const info = byCheck(ok, 'shipping-rate-conditions');
  assert.equal(info.length, 1);
  assert.equal(info[0].severity, 'INFO');
  assert.equal(info[0].subject, 'general-profile');
  assert.match(info[0].evidence, /Flat Rate: price LESS_THAN 8?75\.00/);

  const bad = classifyDeliveryProfiles({ profiles, settings: { flat_rate_shipping: '9.00', free_shipping_threshold: '75' }, copyAmounts: [] });
  const mm = byCheck(bad, 'shipping-rates-mismatch');
  assert.equal(mm.length, 1);
  assert.equal(mm[0].severity, 'WARN');
  assert.ok(mm[0].message.includes('{75.00, 8.00}') && mm[0].message.includes('{75.00, 9.00}'), mm[0].message);

  const tokenOnly = classifyDeliveryProfiles({ profiles, settings: SETTINGS, copyAmounts: [], copyTokens: ['expedited'] });
  assert.match(byCheck(tokenOnly, 'shipping-rates-mismatch')[0].message, /tokens Admin \{flat, free\} vs copy \{expedited\}/);

  const weighted = classifyDeliveryProfiles({ profiles: flattenDeliveryProfiles(profile([rate('Heavy', '8.0', [weightCond('GREATER_THAN', 5)])])), settings: SETTINGS });
  assert.match(byCheck(weighted, 'shipping-rate-conditions')[0].evidence, /weight GREATER_THAN 5 pounds/);
});

test('shipping: no profiles or no active rate is shipping-profiles-read ERROR', () => {
  const none = classifyDeliveryProfiles({ profiles: [], settings: SETTINGS });
  assert.equal(none.length, 1);
  assert.equal(none[0].check, 'shipping-profiles-read');
  assert.equal(none[0].severity, 'ERROR');
  const inactive = classifyDeliveryProfiles({ profiles: flattenDeliveryProfiles(profile([rate('Off', '8.0', [], false)])), settings: SETTINGS });
  assert.equal(inactive[0].check, 'shipping-profiles-read');
  assert.equal(inactive[0].subject, 'general-profile');
});

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

test('variants: weight 0 and nil are one ERROR per product with the count and unit', () => {
  const products = flattenProducts({ products: { pageInfo: { hasNextPage: false }, edges: [
    product('test-crewneck', { variants: [
      variant(1),
      variant(2, { inventoryItem: { requiresShipping: true, measurement: { weight: { unit: 'KILOGRAMS', value: 0 } } } }),
      variant(3, { inventoryItem: { requiresShipping: true, measurement: { weight: null } } }),
      variant(4, { inventoryItem: { requiresShipping: true, measurement: null } }),
    ] }),
    product('test-gift-card', { variants: [variant(9, { inventoryItem: { requiresShipping: false, measurement: { weight: { unit: 'POUNDS', value: 0 } } } })] }),
  ] } });
  const out = classifyVariants({ products, catalogue: CATALOGUE });
  const w = byCheck(out, 'variant-weight');
  assert.equal(w.length, 1, 'one finding per product, not per variant');
  assert.equal(w[0].subject, 'test-crewneck');
  assert.equal(w[0].severity, 'ERROR');
  assert.match(w[0].message, /3 of 4 variant/);
  assert.match(w[0].message, /kilograms/);
  assert.match(w[0].message, /nil/);
  assert.equal(byCheck(out, 'variant-requires-shipping').length, 0);
  assert.equal(byCheck(out, 'variant-sku-missing').length, 0);
  const inv = byCheck(out, 'variant-inventory');
  assert.equal(inv.length, 2);
  assert.match(inv.find((f) => f.subject === 'test-crewneck').message, /^12 unit/);
});

test('variants: requiresShipping mismatch both directions, missing SKU and unavailable counts', () => {
  const products = flattenProducts({ products: { pageInfo: { hasNextPage: false }, edges: [
    product('test-crewneck', { variants: [
      variant(1, { inventoryItem: { requiresShipping: false, measurement: { weight: { unit: 'POUNDS', value: 1 } } }, sku: '', availableForSale: false }),
      variant(2, { sku: null }),
    ] }),
    product('test-gift-card', { variants: [variant(9, { inventoryItem: { requiresShipping: true, measurement: { weight: null } } })] }),
    product('undeclared-thing', { variants: [variant(5, { inventoryItem: { requiresShipping: false, measurement: null } })] }),
  ] } });
  const out = classifyVariants({ products, catalogue: CATALOGUE });
  const rs = byCheck(out, 'variant-requires-shipping');
  assert.deepEqual(rs.map((f) => f.subject).sort(), ['test-crewneck', 'test-gift-card']);
  assert.match(rs.find((f) => f.subject === 'test-crewneck').message, /garment .*requiresShipping false/);
  assert.match(rs.find((f) => f.subject === 'test-gift-card').message, /gift-card .*requiresShipping true/);
  assert.equal(byCheck(out, 'variant-weight').length, 0, 'gift cards are not weighed');
  const sku = byCheck(out, 'variant-sku-missing');
  assert.equal(sku.length, 1);
  assert.match(sku[0].message, /2 of 2/);
  const un = byCheck(out, 'variant-unavailable');
  assert.equal(un.length, 1);
  assert.match(un[0].message, /1 of 2/);
  assert.ok(!out.some((f) => f.subject === 'undeclared-thing'), 'undeclared products are classifyProducts business');
});

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

test('products: template suffix, status, media, breadcrumb, undeclared and absent', () => {
  const products = flattenProducts({ products: { pageInfo: { hasNextPage: false }, edges: [
    product('test-crewneck', { templateSuffix: null, mediaCount: 0, breadcrumb: 'all' }),
    product('mystery-hoodie', { status: 'DRAFT' }),
  ] } });
  const out = classifyProducts({ products, catalogue: CATALOGUE });
  assert.match(byCheck(out, 'product-template-suffix')[0].message, /null; catalogue declares test-crewneck/);
  assert.equal(byCheck(out, 'product-media-count')[0].subject, 'test-crewneck');
  assert.match(byCheck(out, 'product-breadcrumb-metafield')[0].message, /catch-all "all"/);
  const status = byCheck(out, 'product-status');
  assert.deepEqual(status.map((f) => f.subject).sort(), ['mystery-hoodie', 'test-gift-card']);
  assert.match(status.find((f) => f.subject === 'mystery-hoodie').message, /undeclared/);
  assert.match(status.find((f) => f.subject === 'test-gift-card').message, /absent from Admin/);
  for (const f of status) assert.equal(f.severity, 'WARN');

  const archived = classifyProducts({ products: flattenProducts({ products: { edges: [
    product('test-crewneck', { status: 'ARCHIVED', templateSuffix: 'wrong', breadcrumb: null }),
    product('test-gift-card', { templateSuffix: 'gift-card', breadcrumb: null }),
  ] } }), catalogue: CATALOGUE });
  assert.match(byCheck(archived, 'product-status')[0].message, /ARCHIVED/);
  assert.equal(byCheck(archived, 'product-template-suffix').length, 0, 'suffix only judged on ACTIVE products');
  assert.deepEqual(byCheck(archived, 'product-breadcrumb-metafield').map((f) => f.subject), ['test-crewneck'], 'gift card needs no breadcrumb');
});

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

test('policies: missing, empty and shipping amount set', () => {
  const policies = [
    { type: 'REFUND_POLICY', body: '<p>&nbsp;</p>', url: 'https://example.test/policies/refund-policy' },
    { type: 'PRIVACY_POLICY', body: '<p>We keep it.</p>' },
    { type: 'SHIPPING_POLICY', body: '<p>$8 flat rate. Free over $75.00. Expedited $25.00.</p>' },
    { type: 'CONTACT_INFORMATION', body: '<p>Write to the studio.</p>' },
  ];
  const out = classifyPolicies({ policies, settings: SETTINGS });
  assert.deepEqual(byCheck(out, 'policy-missing').map((f) => f.subject), ['TERMS_OF_SERVICE']);
  assert.deepEqual(byCheck(out, 'policy-empty').map((f) => f.subject), ['REFUND_POLICY']);
  const amounts = byCheck(out, 'policy-shipping-amounts');
  assert.equal(amounts.length, 1);
  assert.equal(amounts[0].severity, 'WARN');
  assert.ok(amounts[0].message.includes('{25.00, 75.00, 8.00}') && amounts[0].message.includes('{75.00, 8.00}'), amounts[0].message);

  const fine = classifyPolicies({ policies: [{ type: 'SHIPPING_POLICY', body: 'Free over $75; otherwise $8.00' }], linkedTypes: ['SHIPPING_POLICY'], settings: SETTINGS });
  assert.equal(fine.length, 0);
  assert.deepEqual(dollarAmounts('$8 and $ 75.5 and $1,000'), ['8.00', '75.50', '1.00']);
});

// ---------------------------------------------------------------------------
// Shop, locales, markets, menus
// ---------------------------------------------------------------------------

test('locales: exactly one published is silent; zero or two is ERROR', () => {
  const one = classifyShop({ locales: [{ locale: 'en', primary: true, published: true }, { locale: 'it', primary: false, published: false }] });
  assert.equal(byCheck(one, 'locales-published').length, 0);
  const two = classifyShop({ locales: [{ locale: 'en', primary: true, published: true }, { locale: 'it', primary: false, published: true }] });
  assert.match(byCheck(two, 'locales-published')[0].message, /2 locale\(s\) published \(en, it\)/);
  assert.equal(byCheck(classifyShop({ locales: [] }), 'locales-published')[0].severity, 'ERROR');
});

test('markets vs show_country, and the shop INFO trio plus gift cards', () => {
  const data = { markets: { pageInfo: { hasNextPage: false }, edges: [
    { node: { name: 'US', status: 'ACTIVE', conditions: { regionsCondition: { regions: { pageInfo: { hasNextPage: false }, edges: [{ node: { code: 'US' } }] } } } } },
    { node: { name: 'EU', status: 'DRAFT', conditions: { regionsCondition: { regions: { edges: [{ node: { code: 'DE' } }, { node: { code: 'FR' } }] } } } } },
    { node: { name: 'CA', status: 'ACTIVE', conditions: { regionsCondition: { regions: { edges: [{ node: { code: 'CA' } }] } } } } },
  ] } };
  assert.deepEqual(marketCountries(data), ['CA', 'US']);
  assert.equal(byCheck(classifyShop({ markets: ['CA', 'US'], showCountry: true }), 'markets-shipping-countries').length, 0);
  assert.match(byCheck(classifyShop({ markets: ['CA', 'US'], showCountry: false }), 'markets-shipping-countries')[0].message, /2 shipping countries .*show_country false/);
  assert.match(byCheck(classifyShop({ markets: ['US'], showCountry: true }), 'markets-shipping-countries')[0].message, /1 shipping country .*show_country true/);
  assert.equal(byCheck(classifyShop({ markets: ['US'], showCountry: false }), 'markets-shipping-countries').length, 0);

  const shop = { currencyCode: 'USD', features: { giftCards: false }, customerAccountsV2: { customerAccountsVersion: 'NEW_CUSTOMER_ACCOUNTS' }, paymentSettings: { supportedDigitalWallets: ['APPLE_PAY', 'SHOPIFY_PAY'] } };
  const out = classifyShop({ shop, sellsGiftCard: true });
  assert.match(byCheck(out, 'shop-currency')[0].message, /USD/);
  assert.equal(byCheck(out, 'shop-gift-cards').length, 1);
  assert.match(byCheck(out, 'customer-accounts-version')[0].message, /NEW_CUSTOMER_ACCOUNTS/);
  assert.match(byCheck(out, 'digital-wallets')[0].message, /APPLE_PAY, SHOPIFY_PAY/);
  assert.equal(byCheck(classifyShop({ shop, sellsGiftCard: false }), 'shop-gift-cards').length, 0);
});

test('menus: a catalog link with children is menu-catalog-children ERROR; childless is silent', () => {
  const menus = [
    { handle: 'footer', title: 'Footer', items: [{ title: 'Shop', type: 'CATALOG', url: '/collections', items: [{ title: 'x' }] }] },
    { handle: 'main-menu', title: 'Main', items: [
      { title: 'Shop', type: 'CATALOG', url: '/collections', items: [{ title: 'Crewnecks', type: 'COLLECTION', url: '/collections/crewnecks' }] },
      { title: 'About', type: 'PAGE', url: '/pages/about', items: [] },
    ] },
  ];
  const out = byCheck(classifyShop({ menus }), 'menu-catalog-children');
  assert.equal(out.length, 1, 'only the main menu counts');
  assert.equal(out[0].subject, 'main-menu:shop');
  assert.equal(out[0].severity, 'ERROR');
  assert.equal(out[0].evidence, 'Crewnecks');
  menus[1].items[0].items = [];
  assert.equal(byCheck(classifyShop({ menus }), 'menu-catalog-children').length, 0);
});
