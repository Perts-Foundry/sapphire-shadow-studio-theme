// Tier A2 classifiers: parsed Admin data in, findings out. Every function here is pure; the
// orchestrator (config.mjs) does the reading and passes the theme settings it derived.
//
// Subject rule (lib/finding.mjs): a handle, a profile-name slug, a policy type, a menu handle;
// never a count. Per-product aggregation is deliberate: a 431-variant catalogue with zero
// weights is ONE finding per product carrying the count, not 431 findings.

import { makeFinding } from './finding.mjs';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** kebab-case a display string for use as a subject. */
export function slug(text) {
  const s = String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'unnamed';
}

/** "8.0" / 8 / "8.00" all become "8.00"; a non-number returns null. */
export function normaliseAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : null;
}

/** Sorted, deduplicated, printable. */
export function setText(values) {
  return `{${[...new Set(values)].sort().join(', ')}}`;
}

/** Order-insensitive set equality. */
export function sameSet(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const v of sa) if (!sb.has(v)) return false;
  return true;
}

/** Edges-to-nodes, tolerant of a missing connection. */
export function nodes(connection) {
  return connection && Array.isArray(connection.edges) ? connection.edges.map((e) => e.node).filter(Boolean) : [];
}

/** True when rich text is empty once tags and &nbsp; are gone. */
export function isEffectivelyEmpty(text) {
  return String(text ?? '').replace(/<[^>]*>|&nbsp;|&#160;/gi, ' ').replace(/\s+/g, ' ').trim().length === 0;
}

/** Every `$<amount>` in a text, normalised to two decimals. */
export function dollarAmounts(text) {
  const out = [];
  const re = /\$\s?(\d{1,6}(?:\.\d{1,2})?)/g;
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) out.push(normaliseAmount(m[1]));
  return out.filter(Boolean);
}

/**
 * The catalogue as { handle -> { handle, body, template } }. Accepts the parsed manifest
 * (products is a Map), a plain object keyed by handle, or an array of entries.
 */
export function catalogueIndex(catalogue) {
  const index = new Map();
  if (!catalogue) return index;
  const products = catalogue.products ?? catalogue;
  const entries = products instanceof Map ? [...products.values()]
    : Array.isArray(products) ? products
      : Object.entries(products).map(([handle, p]) => ({ handle, ...p }));
  for (const p of entries) if (p && p.handle) index.set(p.handle, p);
  return index;
}

const isGarment = (entry) => Boolean(entry && entry.body !== null && entry.body !== undefined);
const isGiftCard = (entry) => Boolean(entry && entry.template === 'gift-card');

/**
 * Flatten the products read into plain records the classifiers consume.
 * @returns {Array<{id, handle, title, status, templateSuffix, mediaCount, breadcrumb, variants: Array, variantsComplete: boolean}>}
 */
export function flattenProducts(data) {
  return nodes(data && data.products).map((p) => ({
    id: p.id,
    handle: p.handle,
    title: p.title,
    status: p.status,
    templateSuffix: p.templateSuffix ?? null,
    mediaCount: p.mediaCount && typeof p.mediaCount.count === 'number' ? p.mediaCount.count : null,
    breadcrumb: p.breadcrumbCollection
      ? { value: p.breadcrumbCollection.value ?? null, handle: p.breadcrumbCollection.reference ? p.breadcrumbCollection.reference.handle : null }
      : null,
    variants: nodes(p.variants).map((v) => ({
      id: v.id,
      sku: v.sku ?? null,
      availableForSale: v.availableForSale,
      inventoryQuantity: typeof v.inventoryQuantity === 'number' ? v.inventoryQuantity : null,
      requiresShipping: v.inventoryItem ? v.inventoryItem.requiresShipping : null,
      weight: v.inventoryItem && v.inventoryItem.measurement ? v.inventoryItem.measurement.weight : null,
    })),
    variantsComplete: !(p.variants && p.variants.pageInfo && p.variants.pageInfo.hasNextPage),
  }));
}

// ---------------------------------------------------------------------------
// isPartial
// ---------------------------------------------------------------------------

/** Every `pageInfo.hasNextPage: true` left anywhere in a value, as dotted paths. */
export function unfollowedPages(value, path = '', out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => unfollowedPages(v, `${path}[${i}]`, out));
    return out;
  }
  if (value.pageInfo && value.pageInfo.hasNextPage === true) out.push(path || '(root)');
  for (const [k, v] of Object.entries(value)) {
    if (k === 'pageInfo') continue;
    unfollowedPages(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

/**
 * A response is partial when it carries `errors` alongside data or any connection still reports
 * another page. Accepts either the raw body ({ data, errors }) or bare data.
 * @returns {{partial: boolean, reasons: string[]}}
 */
export function isPartial(response) {
  const reasons = [];
  if (!response || typeof response !== 'object') return { partial: true, reasons: ['no data'] };
  const hasEnvelope = 'data' in response || 'errors' in response;
  const errors = hasEnvelope ? response.errors : undefined;
  const data = hasEnvelope ? response.data : response;
  if (Array.isArray(errors) && errors.length) {
    reasons.push(`${errors.length} GraphQL error(s) alongside data: ${errors.map((e) => e && e.message).filter(Boolean).join('; ')}`);
  }
  for (const p of unfollowedPages(data)) reasons.push(`unfollowed page at ${p}`);
  return { partial: reasons.length > 0, reasons };
}

/** The `admin-partial-response` finding for a read, or null when the response is complete. */
export function partialFinding(readName, response) {
  const { partial, reasons } = isPartial(response);
  if (!partial) return null;
  return makeFinding({
    check: 'admin-partial-response',
    subject: readName,
    message: `read ${readName} is incomplete and was not treated as complete: ${reasons.join('; ')}`,
  });
}

// ---------------------------------------------------------------------------
// Shipping
// ---------------------------------------------------------------------------

const RATE_NAME_TOKENS = new Set(['flat', 'free', 'expedited', 'standard', 'economy', 'express', 'priority', 'ground', 'overnight']);

/** Flatten deliveryProfiles into [{ name, slug, rates: [{ name, active, amount, conditions }], countries }]. */
export function flattenDeliveryProfiles(data) {
  return nodes(data && data.deliveryProfiles).map((p) => {
    const rates = [];
    const countries = new Set();
    for (const group of p.profileLocationGroups || []) {
      for (const zoneNode of nodes(group.locationGroupZones)) {
        const zoneName = zoneNode.zone ? zoneNode.zone.name : null;
        for (const c of (zoneNode.zone && zoneNode.zone.countries) || []) {
          if (c.code && c.code.restOfWorld) countries.add('*');
          else if (c.code && c.code.countryCode) countries.add(c.code.countryCode);
        }
        for (const m of nodes(zoneNode.methodDefinitions)) {
          const price = m.rateProvider && m.rateProvider.price ? m.rateProvider.price : null;
          rates.push({
            zone: zoneName,
            name: m.name,
            active: m.active !== false,
            amount: price ? normaliseAmount(price.amount) : null,
            currency: price ? price.currencyCode : null,
            conditions: (m.methodConditions || []).map((c) => ({
              field: c.field,
              operator: c.operator,
              amount: c.conditionCriteria && 'amount' in c.conditionCriteria ? normaliseAmount(c.conditionCriteria.amount) : null,
              weight: c.conditionCriteria && 'value' in c.conditionCriteria ? { unit: c.conditionCriteria.unit, value: c.conditionCriteria.value } : null,
            })),
          });
        }
      }
    }
    return { name: p.name, slug: slug(p.name), isDefault: Boolean(p.default), rates, countries: [...countries] };
  });
}

/** Theme-side shipping amounts: settings plus whatever copy the orchestrator scanned. */
export function themeShippingAmounts(settings, copyAmounts = []) {
  const s = settings || {};
  return [...new Set([normaliseAmount(s.flat_rate_shipping), normaliseAmount(s.free_shipping_threshold), ...copyAmounts.map(normaliseAmount)].filter(Boolean))];
}

/**
 * @param {object} o
 * @param {Array} o.profiles  from flattenDeliveryProfiles
 * @param {object} o.settings  effective theme settings
 * @param {string[]} [o.copyAmounts]  amounts the orchestrator found in the announcement bar / templates
 * @param {string[]} [o.copyTokens]  lowercased words from that copy
 */
export function classifyDeliveryProfiles({ profiles, settings, copyAmounts = [], copyTokens = [] }) {
  const findings = [];
  const activeRates = (profiles || []).flatMap((p) => p.rates.filter((r) => r.active));
  if (!profiles || !profiles.length || !activeRates.length) {
    findings.push(makeFinding({
      check: 'shipping-profiles-read',
      subject: profiles && profiles.length ? profiles[0].slug : 'none',
      message: profiles && profiles.length
        ? 'deliveryProfiles returned no active rate; the store cannot ship anything'
        : 'deliveryProfiles returned no profile',
    }));
    return findings;
  }
  const themeAmounts = themeShippingAmounts(settings, copyAmounts);
  const themeTokens = new Set(copyTokens.map((t) => String(t).toLowerCase()).filter((t) => RATE_NAME_TOKENS.has(t)));
  for (const profile of profiles) {
    const rates = profile.rates.filter((r) => r.active);
    if (!rates.length) continue;
    const adminAmounts = new Set();
    const adminTokens = new Set();
    const tiers = [];
    for (const r of rates) {
      if (r.amount && r.amount !== '0.00') adminAmounts.add(r.amount);
      for (const w of String(r.name).toLowerCase().split(/[^a-z]+/)) if (RATE_NAME_TOKENS.has(w)) adminTokens.add(w);
      for (const c of r.conditions) {
        if (c.amount) {
          adminAmounts.add(c.amount);
          tiers.push(`${r.name}: price ${c.operator} ${c.amount}`);
        } else if (c.weight) {
          tiers.push(`${r.name}: weight ${c.operator} ${c.weight.value} ${String(c.weight.unit).toLowerCase()}`);
        }
      }
    }
    const amountsMatch = sameSet(adminAmounts, themeAmounts);
    const tokensMatch = themeTokens.size === 0 || sameSet(adminTokens, themeTokens);
    if (!amountsMatch || !tokensMatch) {
      const parts = [];
      if (!amountsMatch) parts.push(`amounts Admin ${setText(adminAmounts)} vs theme ${setText(themeAmounts)}`);
      if (!tokensMatch) parts.push(`rate-name tokens Admin ${setText(adminTokens)} vs copy ${setText(themeTokens)}`);
      findings.push(makeFinding({
        check: 'shipping-rates-mismatch',
        subject: profile.slug,
        message: `profile ${profile.name}: ${parts.join('; ')}`,
        evidence: rates.map((r) => `${r.name}=${r.amount ?? 'n/a'}`).join(', '),
      }));
    }
    findings.push(makeFinding({
      check: 'shipping-rate-conditions',
      subject: profile.slug,
      message: tiers.length
        ? `profile ${profile.name}: ${tiers.length} rate condition(s)`
        : `profile ${profile.name}: no rate conditions (every active rate applies to every order)`,
      evidence: tiers.join('; '),
    }));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {Array} o.products  from flattenProducts
 * @param {object} o.catalogue  parsed manifest (or index-able equivalent)
 */
export function classifyVariants({ products, catalogue }) {
  const index = catalogueIndex(catalogue);
  const findings = [];
  for (const p of products || []) {
    const entry = index.get(p.handle);
    if (!entry) continue; // undeclared products are classifyProducts' concern
    const garment = isGarment(entry);
    const giftCard = isGiftCard(entry);
    const total = p.variants.length;
    if (!total) continue;

    if (garment) {
      const zero = p.variants.filter((v) => !v.weight || !(Number(v.weight.value) > 0));
      if (zero.length) {
        const units = [...new Set(zero.map((v) => (v.weight ? String(v.weight.unit).toLowerCase() : 'nil')))];
        findings.push(makeFinding({
          check: 'variant-weight',
          subject: p.handle,
          message: `${zero.length} of ${total} variant(s) weigh 0 or nil (unit: ${units.join(', ')}); weight-based rates and carrier labels cannot price them`,
          evidence: zero.slice(0, 5).map((v) => v.id).join(', '),
        }));
      }
    }

    const wrongShipping = p.variants.filter((v) => (garment && v.requiresShipping === false) || (giftCard && v.requiresShipping === true));
    if (wrongShipping.length) {
      findings.push(makeFinding({
        check: 'variant-requires-shipping',
        subject: p.handle,
        message: garment
          ? `${wrongShipping.length} of ${total} garment variant(s) have requiresShipping false; they would skip shipping at checkout`
          : `${wrongShipping.length} of ${total} gift-card variant(s) have requiresShipping true; a gift card would be charged shipping`,
        evidence: wrongShipping.slice(0, 5).map((v) => v.id).join(', '),
      }));
    }

    const noSku = p.variants.filter((v) => !v.sku || !String(v.sku).trim());
    if (noSku.length) {
      findings.push(makeFinding({
        check: 'variant-sku-missing',
        subject: p.handle,
        message: `${noSku.length} of ${total} variant(s) have no SKU`,
        evidence: noSku.slice(0, 5).map((v) => v.id).join(', '),
      }));
    }

    const unavailable = p.variants.filter((v) => v.availableForSale === false);
    if (unavailable.length) {
      findings.push(makeFinding({
        check: 'variant-unavailable',
        subject: p.handle,
        message: `${unavailable.length} of ${total} variant(s) are not availableForSale`,
        evidence: unavailable.slice(0, 5).map((v) => v.id).join(', '),
      }));
    }

    const known = p.variants.filter((v) => v.inventoryQuantity !== null);
    const sum = known.reduce((acc, v) => acc + v.inventoryQuantity, 0);
    findings.push(makeFinding({
      check: 'variant-inventory',
      subject: p.handle,
      message: `${sum} unit(s) across ${known.length} tracked variant(s) of ${total}`,
    }));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export const CATCH_ALL_COLLECTIONS = new Set(['all', 'frontpage', 'all-products']);

export function classifyProducts({ products, catalogue }) {
  const index = catalogueIndex(catalogue);
  const findings = [];
  const seen = new Set();
  for (const p of products || []) {
    seen.add(p.handle);
    const entry = index.get(p.handle);
    if (!entry) {
      findings.push(makeFinding({
        check: 'product-status',
        subject: p.handle,
        message: `product is in Admin (${p.status}) but undeclared in catalogue.json; every tool derives from the catalogue, so this product is invisible to them`,
      }));
      continue;
    }
    if (p.status !== 'ACTIVE') {
      findings.push(makeFinding({
        check: 'product-status',
        subject: p.handle,
        message: `catalogue product is ${p.status ?? 'unknown'}, not ACTIVE`,
      }));
    }
    if (p.status === 'ACTIVE' && p.templateSuffix !== entry.template) {
      findings.push(makeFinding({
        check: 'product-template-suffix',
        subject: p.handle,
        message: p.templateSuffix
          ? `templateSuffix is ${p.templateSuffix}; catalogue declares ${entry.template}`
          : `templateSuffix is null; catalogue declares ${entry.template} (the product renders with the generic product template)`,
      }));
    }
    if (p.mediaCount === 0) {
      findings.push(makeFinding({ check: 'product-media-count', subject: p.handle, message: 'product has no media' }));
    }
    if (isGarment(entry)) {
      const handle = p.breadcrumb ? p.breadcrumb.handle : null;
      if (!handle) {
        findings.push(makeFinding({
          check: 'product-breadcrumb-metafield',
          subject: p.handle,
          message: 'custom.breadcrumb_collection is unset or references a deleted collection; the breadcrumb parent falls back to the theme cascade',
        }));
      } else if (CATCH_ALL_COLLECTIONS.has(handle)) {
        findings.push(makeFinding({
          check: 'product-breadcrumb-metafield',
          subject: p.handle,
          message: `custom.breadcrumb_collection points at the catch-all "${handle}", which the theme ignores`,
        }));
      }
    }
  }
  for (const [handle, entry] of index) {
    if (seen.has(handle)) continue;
    findings.push(makeFinding({
      check: 'product-status',
      subject: handle,
      message: `catalogue product (${entry.template}) is absent from Admin`,
    }));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export const DEFAULT_LINKED_POLICY_TYPES = ['REFUND_POLICY', 'PRIVACY_POLICY', 'TERMS_OF_SERVICE', 'SHIPPING_POLICY', 'CONTACT_INFORMATION'];

/**
 * @param {object} o
 * @param {Array<{type:string, body:string, url?:string}>} o.policies  shop.shopPolicies
 * @param {string[]} [o.linkedTypes]
 * @param {object} o.settings
 */
export function classifyPolicies({ policies, linkedTypes = DEFAULT_LINKED_POLICY_TYPES, settings }) {
  const findings = [];
  const byType = new Map((policies || []).map((p) => [p.type, p]));
  for (const type of linkedTypes) {
    const policy = byType.get(type);
    if (!policy) {
      findings.push(makeFinding({ check: 'policy-missing', subject: type, message: `the theme links ${type} but the shop has no such policy` }));
      continue;
    }
    if (isEffectivelyEmpty(policy.body)) {
      findings.push(makeFinding({ check: 'policy-empty', subject: type, message: `${type} exists but its body is empty` }));
    }
  }
  const shipping = byType.get('SHIPPING_POLICY');
  if (shipping && !isEffectivelyEmpty(shipping.body)) {
    const policyAmounts = [...new Set(dollarAmounts(shipping.body))];
    const themeAmounts = themeShippingAmounts(settings);
    if (!sameSet(policyAmounts, themeAmounts)) {
      findings.push(makeFinding({
        check: 'policy-shipping-amounts',
        subject: 'SHIPPING_POLICY',
        message: `shipping policy $ amounts ${setText(policyAmounts)} differ from theme settings ${setText(themeAmounts)}`,
      }));
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Shop, locales, markets, menus
// ---------------------------------------------------------------------------

/** Country codes every ACTIVE market serves, from the markets read. */
export function marketCountries(data) {
  const out = new Set();
  for (const m of nodes(data && data.markets)) {
    const active = m.status ? m.status === 'ACTIVE' : m.enabled !== false;
    if (!active) continue;
    const regions = m.conditions && m.conditions.regionsCondition ? m.conditions.regionsCondition.regions : m.regions;
    for (const r of nodes(regions)) if (r && r.code) out.add(r.code);
  }
  return [...out].sort();
}

/** True when a menu item is the catalog link the header builds its collections dropdown from. */
export function isCatalogItem(item) {
  if (!item) return false;
  const url = String(item.url ?? '').replace(/\/+$/, '');
  if (/(^|\/)collections$/.test(url)) return true;
  const type = String(item.type ?? '').toUpperCase();
  return type === 'CATALOG' || type === 'COLLECTIONS';
}

/**
 * @param {object} o
 * @param {object} [o.shop]      shop { currencyCode, features, customerAccountsV2, paymentSettings }
 * @param {Array} [o.locales]    shopLocales
 * @param {string[]} [o.markets] country codes (see marketCountries)
 * @param {Array} [o.menus]      menu nodes { handle, title, items }
 * @param {object} [o.settings]
 * @param {boolean} [o.sellsGiftCard]
 * @param {boolean} [o.showCountry]  header section show_country
 * @param {string} [o.mainMenuHandle]
 */
export function classifyShop({ shop, locales, markets, menus, settings, sellsGiftCard = false, showCountry = false, mainMenuHandle = 'main-menu' }) {
  const findings = [];
  void settings;

  if (Array.isArray(locales)) {
    const published = locales.filter((l) => l.published);
    if (published.length !== 1) {
      findings.push(makeFinding({
        check: 'locales-published',
        subject: 'shopLocales',
        message: `${published.length} locale(s) published (${published.map((l) => l.locale).join(', ') || 'none'}); the theme mirrors strings for exactly one`,
      }));
    }
  }

  if (Array.isArray(markets)) {
    const n = markets.length;
    if (n > 1 && !showCountry) {
      findings.push(makeFinding({
        check: 'markets-shipping-countries',
        subject: 'markets',
        message: `${n} shipping countries across active markets but the header hides the country selector (show_country false)`,
        evidence: markets.join(', '),
      }));
    } else if (n <= 1 && showCountry) {
      findings.push(makeFinding({
        check: 'markets-shipping-countries',
        subject: 'markets',
        message: `${n} shipping country across active markets but the header shows a country selector (show_country true)`,
        evidence: markets.join(', '),
      }));
    }
  }

  if (shop) {
    findings.push(makeFinding({ check: 'shop-currency', subject: 'shop', message: `shop currency is ${shop.currencyCode ?? 'unknown'}` }));
    if (sellsGiftCard && shop.features && shop.features.giftCards === false) {
      findings.push(makeFinding({ check: 'shop-gift-cards', subject: 'shop', message: 'shop.features.giftCards is off while the catalogue sells a gift card' }));
    }
    const version = shop.customerAccountsV2 ? shop.customerAccountsV2.customerAccountsVersion : null;
    findings.push(makeFinding({ check: 'customer-accounts-version', subject: 'shop', message: `customer accounts version: ${version ?? 'unknown'}` }));
    const wallets = shop.paymentSettings && Array.isArray(shop.paymentSettings.supportedDigitalWallets) ? shop.paymentSettings.supportedDigitalWallets : [];
    findings.push(makeFinding({ check: 'digital-wallets', subject: 'shop', message: `supported digital wallets: ${wallets.length ? wallets.join(', ') : 'none'}` }));
  }

  if (Array.isArray(menus)) {
    const main = menus.find((m) => m.handle === mainMenuHandle);
    if (main) {
      for (const item of main.items || []) {
        if (!isCatalogItem(item)) continue;
        const children = (item.items || []).length;
        if (children > 0) {
          findings.push(makeFinding({
            check: 'menu-catalog-children',
            subject: `${main.handle}:${slug(item.title)}`,
            message: `main menu item "${item.title}" (${item.url}) has ${children} child item(s); the header only generates its collections dropdown for a childless catalog link`,
            evidence: (item.items || []).map((c) => c.title).join(', '),
          }));
        }
      }
    }
  }
  return findings;
}
