// Storefront JSON endpoint classifiers (Tier A1). Pure: a status and a body string in, findings
// out. Every body is parsed through safeJson so a challenge page or the password page (HTML
// with a 200) is a GATE finding, never a JSON.parse crash that takes the run down.
//
// Subjects are handles and paths. A variant id is a stable Admin identifier and appears in a
// message; prices, counts and grams appear in messages and evidence only.

import { makeFinding } from './finding.mjs';
import { gateReason } from './render.mjs';

/** JSON.parse that returns null instead of throwing; null is "not JSON" to every caller. */
export function safeJson(body) {
  if (typeof body !== 'string' || !body.trim()) return null;
  try { return JSON.parse(body); } catch { return null; }
}

/** A gate finding for a JSON endpoint, or null when the response is not a gate. */
function jsonGate(check, subject, { status, body, finalUrl }) {
  const reason = gateReason({ status, body, finalUrl });
  if (reason) return makeFinding({ check, subject, message: `inconclusive: ${reason}`, evidence: `status ${status ?? 'none'}` });
  return null;
}

/**
 * /products/<handle>.js
 * @param {object} o
 * @param {string} o.handle
 * @param {number|null} o.status
 * @param {string} o.body
 * @param {string|null} [o.finalUrl]
 * @param {object} o.expected  { variantCount: number|null, requiresShipping: boolean, isGiftCard: boolean }
 * @returns {Array} findings
 */
export function classifyProductJson({ handle, status, body, finalUrl = null, expected }) {
  const findings = [];
  const gate = jsonGate('product-json-not-json', handle, { status, body, finalUrl });
  if (gate) return [gate];
  if (status !== 200) {
    return [makeFinding({ check: 'product-json-status', subject: handle, message: `/products/${handle}.js returned ${status ?? 'no response'}`, evidence: `status ${status ?? 'none'}` })];
  }
  const product = safeJson(body);
  if (!product || typeof product !== 'object' || !Array.isArray(product.variants)) {
    return [makeFinding({ check: 'product-json-not-json', subject: handle, message: 'body is not a product JSON document', evidence: `status ${status}` })];
  }
  const variants = product.variants;
  const { variantCount = null, requiresShipping, isGiftCard = false } = expected || {};
  if (!isGiftCard && Number.isInteger(variantCount) && variants.length !== variantCount) {
    findings.push(makeFinding({
      check: 'product-json-variant-count', subject: handle,
      message: `${variants.length} variants, catalogue expects ${variantCount}`,
      evidence: `variants ${variants.length} expected ${variantCount}`,
    }));
  }
  if (typeof requiresShipping === 'boolean') {
    const wrong = variants.filter((v) => Boolean(v.requires_shipping) !== requiresShipping);
    if (wrong.length) {
      findings.push(makeFinding({
        check: 'product-json-requires-shipping', subject: handle,
        message: `${wrong.length} of ${variants.length} variants report requires_shipping ${!requiresShipping}, expected ${requiresShipping}`,
        evidence: `variants ${wrong.slice(0, 5).map((v) => v.id).join(',')}`,
      }));
    }
  }
  const zero = variants.filter((v) => v.requires_shipping && Number(v.grams) === 0);
  if (zero.length) {
    findings.push(makeFinding({
      check: 'product-json-weight-zero', subject: handle,
      message: `${zero.length} of ${variants.length} shippable variants report grams 0`,
      evidence: `variants ${zero.slice(0, 5).map((v) => v.id).join(',')}${zero.length > 5 ? ',...' : ''}`,
    }));
  }
  if (variants.length && !variants.some((v) => v.available)) {
    findings.push(makeFinding({ check: 'product-json-sold-out', subject: handle, message: 'no variant is available', evidence: `variants ${variants.length}` }));
  }
  return findings;
}

/** First available variant of a parsed product JSON, or null. */
export function pickAvailableVariant(product) {
  if (!product || !Array.isArray(product.variants)) return null;
  return product.variants.find((v) => v.available) || null;
}

/**
 * Expected variant count from the catalogue matrix, widened by any option the product JSON
 * declares beyond the colour and size axes (the Huddle line adds a Design axis). Full-matrix
 * store: every combination exists as a variant.
 * @param {{colors:number, sizes:number}} matrix
 * @param {object|null} product  parsed product JSON (for extra option axes)
 * @param {string[]} knownOptionNames  the catalogue's colour and size option names
 */
export function expectedVariantCount(matrix, product, knownOptionNames = []) {
  let n = matrix.colors * matrix.sizes;
  const options = product && Array.isArray(product.options) ? product.options : [];
  for (const opt of options) {
    const name = typeof opt === 'string' ? opt : opt?.name;
    if (!name || knownOptionNames.includes(name)) continue;
    const values = Array.isArray(opt?.values) ? opt.values.length : 0;
    if (values > 0) n *= values;
  }
  return n;
}

/**
 * /collections/all/products.json
 * @param {{status:number|null, body:string, finalUrl?:string|null, expectedCount:number|null}} o
 */
export function classifyCollectionJson({ status, body, finalUrl = null, expectedCount = null }) {
  const subject = '/collections/all/products.json';
  const gate = jsonGate('product-json-not-json', subject, { status, body, finalUrl });
  if (gate) return [gate];
  if (status !== 200) return [makeFinding({ check: 'collection-json', subject, message: `returned ${status ?? 'no response'}`, evidence: `status ${status ?? 'none'}` })];
  const data = safeJson(body);
  if (!data || !Array.isArray(data.products)) return [makeFinding({ check: 'product-json-not-json', subject, message: 'body is not a products JSON document', evidence: `status ${status}` })];
  if (Number.isInteger(expectedCount) && data.products.length !== expectedCount) {
    return [makeFinding({ check: 'collection-json', subject, message: `lists ${data.products.length} products, catalogue census is ${expectedCount}`, evidence: `products ${data.products.length} expected ${expectedCount}` })];
  }
  return [];
}

/**
 * /search/suggest.json?q=<term>&resources[type]=product
 * @param {{status:number|null, body:string, finalUrl?:string|null, term:string}} o
 */
export function classifySearchSuggest({ status, body, finalUrl = null, term }) {
  const subject = `q=${String(term).replace(/\s+/g, '+')}`;
  const gate = jsonGate('product-json-not-json', subject, { status, body, finalUrl });
  if (gate) return [gate];
  if (status !== 200) return [makeFinding({ check: 'search-suggest', subject, message: `returned ${status ?? 'no response'}`, evidence: `status ${status ?? 'none'}` })];
  const data = safeJson(body);
  const products = data?.resources?.results?.products;
  if (!Array.isArray(products)) return [makeFinding({ check: 'product-json-not-json', subject, message: 'body is not a suggest JSON document', evidence: `status ${status}` })];
  if (products.length === 0) return [makeFinding({ check: 'search-suggest', subject, message: `no product suggested for a catalogue-derived term`, evidence: 'products 0' })];
  return [];
}

/**
 * /recommendations/products.json?product_id=<id>&section_id=<id>. Informational only: the
 * recommendation engine needs order history the store may not have yet.
 * @param {{status:number|null, body:string, finalUrl?:string|null, handle:string}} o
 */
export function classifyRecommendations({ status, body, finalUrl = null, handle }) {
  const gate = jsonGate('product-json-not-json', handle, { status, body, finalUrl });
  if (gate) return [gate];
  const data = status === 200 ? safeJson(body) : null;
  const count = data && Array.isArray(data.products) ? data.products.length : null;
  const message = status !== 200
    ? `recommendations endpoint returned ${status ?? 'no response'}`
    : count === null ? 'recommendations body was not a products JSON document' : `${count} recommended products`;
  return [makeFinding({ check: 'recommendations', subject: handle, message, evidence: `status ${status ?? 'none'} products ${count ?? 'none'}` })];
}

/**
 * A garbage path. PUBLIC: a 404 is expected. LOCKED: an anonymous request is bounced to
 * /password, so the expectation is the password redirect (final path /password), not a 404.
 * @param {{status:number|null, finalUrl?:string|null, lockState:'LOCKED'|'PUBLIC', path:string, authenticated?:boolean}} o
 */
export function classifyNotFound({ status, finalUrl = null, lockState, path, authenticated = false }) {
  let finalPath = null;
  try { finalPath = finalUrl ? new URL(finalUrl).pathname : null; } catch { finalPath = null; }
  const onPassword = typeof finalPath === 'string' && /^\/password/.test(finalPath);
  const expect404 = lockState === 'PUBLIC' || authenticated;
  if (expect404) {
    if (status === 404) return [];
    return [makeFinding({ check: 'not-found-status', subject: path, message: `garbage path returned ${status ?? 'no response'}, expected 404 (${lockState}${authenticated ? ', authenticated' : ''})`, evidence: `status ${status ?? 'none'}` })];
  }
  if (onPassword) return [];
  return [makeFinding({ check: 'not-found-status', subject: path, message: `garbage path did not bounce to /password while LOCKED (status ${status ?? 'none'})`, evidence: `status ${status ?? 'none'}` })];
}
