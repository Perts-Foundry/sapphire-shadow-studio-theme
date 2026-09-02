// Tier A1 JSON endpoint classifiers. Synthetic product JSON only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFetchGuard } from './harness.mjs';
installFetchGuard();

import {
  classifyProductJson, classifyCollectionJson, classifySearchSuggest, classifyRecommendations,
  classifyNotFound, safeJson, pickAvailableVariant, expectedVariantCount,
} from '../lib/endpoints.mjs';

const variant = (id, over = {}) => ({ id, available: true, requires_shipping: true, grams: 500, price: 6500, ...over });
const product = (variants, over = {}) => JSON.stringify({ id: 1001, handle: 'lead-ii-crewneck', options: [{ name: 'Color', values: ['Black'] }, { name: 'Size', values: ['S', 'M'] }], variants, ...over });
const garment = { variantCount: 2, requiresShipping: true, isGiftCard: false };
const checks = (fs) => fs.map((f) => f.check);

test('a healthy product JSON yields no findings', () => {
  assert.deepEqual(classifyProductJson({ handle: 'lead-ii-crewneck', status: 200, body: product([variant(1), variant(2)]), expected: garment }), []);
});

test('non-JSON body (password page, challenge) is a GATE, never a crash', () => {
  const html = classifyProductJson({ handle: 'lead-ii-crewneck', status: 200, body: '<html><body>Just a moment...</body></html>', expected: garment });
  assert.deepEqual(checks(html), ['product-json-not-json']);
  assert.equal(html[0].severity, 'GATE');
  const pw = classifyProductJson({ handle: 'lead-ii-crewneck', status: 200, finalUrl: 'https://x.test/password', body: '<html>', expected: garment });
  assert.equal(pw[0].check, 'product-json-not-json');
  const junk = classifyProductJson({ handle: 'lead-ii-crewneck', status: 200, body: '{not json', expected: garment });
  assert.deepEqual(checks(junk), ['product-json-not-json']);
  assert.equal(safeJson('{bad'), null);
  assert.equal(safeJson(''), null);
});

test('status, variant count, requires_shipping, weight zero, sold out', () => {
  assert.deepEqual(checks(classifyProductJson({ handle: 'h', status: 404, body: '{}', expected: garment })), ['product-json-status']);
  const count = classifyProductJson({ handle: 'h', status: 200, body: product([variant(1)]), expected: garment });
  assert.deepEqual(checks(count), ['product-json-variant-count']);
  assert.equal(count[0].evidence, 'variants 1 expected 2');
  const ship = classifyProductJson({ handle: 'h', status: 200, body: product([variant(1, { requires_shipping: false }), variant(2)]), expected: garment });
  assert.deepEqual(checks(ship), ['product-json-requires-shipping']);
  const zero = classifyProductJson({ handle: 'h', status: 200, body: product([variant(1, { grams: 0 }), variant(2, { grams: 0 })]), expected: garment });
  assert.deepEqual(checks(zero), ['product-json-weight-zero']);
  assert.equal(zero.length, 1, 'one finding per product');
  assert.match(zero[0].message, /2 of 2 shippable variants/);
  assert.equal(zero[0].subject, 'h');
  const sold = classifyProductJson({ handle: 'h', status: 200, body: product([variant(1, { available: false }), variant(2, { available: false })]), expected: garment });
  assert.deepEqual(checks(sold), ['product-json-sold-out']);
  assert.equal(sold[0].severity, 'WARN');
});

test('gift card: no count check, requires_shipping false expected, grams 0 fine when not shippable', () => {
  const gc = { variantCount: null, requiresShipping: false, isGiftCard: true };
  const body = product([variant(9, { requires_shipping: false, grams: 0 })], { handle: 'gift-card', options: [{ name: 'Denominations', values: ['$25', '$50'] }] });
  assert.deepEqual(classifyProductJson({ handle: 'gift-card', status: 200, body, expected: gc }), []);
  const wrong = classifyProductJson({ handle: 'gift-card', status: 200, body: product([variant(9, { grams: 0 })]), expected: gc });
  assert.deepEqual(checks(wrong).sort(), ['product-json-requires-shipping', 'product-json-weight-zero']);
});

test('expectedVariantCount widens by extra option axes; pickAvailableVariant', () => {
  const p = JSON.parse(product([variant(1)]));
  assert.equal(expectedVariantCount({ colors: 3, sizes: 6 }, p, ['Color', 'Size']), 18);
  p.options.push({ name: 'Design', values: ['A', 'B'] });
  assert.equal(expectedVariantCount({ colors: 3, sizes: 6 }, p, ['Color', 'Size']), 36);
  assert.equal(expectedVariantCount({ colors: 1, sizes: 6 }, null, ['Color', 'Size']), 6);
  assert.equal(pickAvailableVariant(JSON.parse(product([variant(1, { available: false }), variant(2)]))).id, 2);
  assert.equal(pickAvailableVariant(JSON.parse(product([variant(1, { available: false })]))), null);
});

test('collection, suggest, recommendations', () => {
  const col = (n) => JSON.stringify({ products: Array.from({ length: n }, (_, i) => ({ id: i })) });
  assert.deepEqual(classifyCollectionJson({ status: 200, body: col(6), expectedCount: 6 }), []);
  assert.deepEqual(checks(classifyCollectionJson({ status: 200, body: col(5), expectedCount: 6 })), ['collection-json']);
  assert.deepEqual(checks(classifyCollectionJson({ status: 500, body: '', expectedCount: 6 })), ['collection-json']);
  assert.equal(classifyCollectionJson({ status: 200, body: '<html>Just a moment', expectedCount: 6 })[0].severity, 'GATE');
  const sug = (n) => JSON.stringify({ resources: { results: { products: Array.from({ length: n }, () => ({ handle: 'x' })) } } });
  assert.deepEqual(classifySearchSuggest({ status: 200, body: sug(2), term: 'crewneck' }), []);
  const none = classifySearchSuggest({ status: 200, body: sug(0), term: 'lead ii' });
  assert.deepEqual(checks(none), ['search-suggest']);
  assert.equal(none[0].subject, 'q=lead+ii');
  const rec = classifyRecommendations({ status: 200, body: JSON.stringify({ products: [{}, {}] }), handle: 'lead-ii-crewneck' });
  assert.equal(rec[0].check, 'recommendations');
  assert.equal(rec[0].severity, 'INFO');
  assert.match(rec[0].message, /2 recommended/);
  assert.equal(classifyRecommendations({ status: 404, body: '', handle: 'h' })[0].severity, 'INFO');
});

test('not-found expectation per lock mode', () => {
  const path = '/site-check-garbage';
  assert.deepEqual(classifyNotFound({ status: 404, finalUrl: `https://x.test${path}`, lockState: 'PUBLIC', path }), []);
  assert.deepEqual(checks(classifyNotFound({ status: 200, finalUrl: `https://x.test${path}`, lockState: 'PUBLIC', path })), ['not-found-status']);
  assert.deepEqual(classifyNotFound({ status: 200, finalUrl: 'https://x.test/password', lockState: 'LOCKED', path }), []);
  assert.deepEqual(classifyNotFound({ status: 302, finalUrl: 'https://x.test/password?x=1', lockState: 'LOCKED', path }), []);
  assert.deepEqual(checks(classifyNotFound({ status: 404, finalUrl: `https://x.test${path}`, lockState: 'LOCKED', path })), ['not-found-status']);
  assert.deepEqual(classifyNotFound({ status: 404, finalUrl: `https://x.test${path}`, lockState: 'LOCKED', path, authenticated: true }), []);
});
