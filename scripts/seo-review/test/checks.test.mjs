import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePage, crossPageChecks, partitionAccepted, diffFindings,
  findingKey, exitCodeFor, pathOf, ERROR, WARN,
} from '../lib/checks.mjs';

const HOST = 'example.com';

function goodExtract(overrides = {}) {
  return {
    title: 'A fine page title',
    description: 'A meta description that is comfortably inside the fifty to one hundred sixty char window.',
    robots: null,
    canonical: `https://${HOST}/pages/x`,
    ogImage: 'https://cdn.example/img.jpg',
    h1Count: 1,
    jsonLd: [{ raw: '', parsed: {}, types: ['BreadcrumbList'], error: null }],
    breadcrumb: true,
    imgAlt: { total: 3, missing: 0 },
    ...overrides,
  };
}

function page(pageType, x, status = 200) {
  return { url: `https://${HOST}/pages/x`, pageType, status, x };
}

const checksOf = (findings) => findings.map((f) => f.check).sort();

test('clean content page produces no findings', () => {
  assert.deepEqual(evaluatePage(page('page', goodExtract()), HOST), []);
});

test('non-200 short-circuits to page-status', () => {
  const f = evaluatePage(page('page', goodExtract(), 500), HOST);
  assert.deepEqual(checksOf(f), ['page-status']);
  assert.equal(f[0].severity, ERROR);
});

test('missing title, description, and canonical are flagged', () => {
  const f = evaluatePage(page('page', goodExtract({ title: null, description: null, canonical: null })), HOST);
  assert.deepEqual(checksOf(f), ['canonical-missing', 'description-missing', 'title-missing']);
});

test('description exempt page types skip description-missing', () => {
  const f = evaluatePage(page('cart', goodExtract({ description: null, breadcrumb: false })), HOST);
  assert.deepEqual(f, []);
});

test('title and description length bounds warn', () => {
  const f = evaluatePage(page('page', goodExtract({
    title: 'T'.repeat(61),
    description: 'short',
  })), HOST);
  assert.deepEqual(checksOf(f), ['description-length', 'title-long']);
  assert.ok(f.every((x) => x.severity === WARN));
});

test('noindex on an indexable page type is an error; on search it is not', () => {
  const bad = evaluatePage(page('product', goodExtract({ robots: 'noindex, nofollow' })), HOST);
  assert.ok(bad.some((f) => f.check === 'robots-noindex' && f.severity === ERROR));
  const ok = evaluatePage(page('search', goodExtract({ robots: 'noindex', breadcrumb: false, description: null })), HOST);
  assert.ok(!ok.some((f) => f.check === 'robots-noindex'));
});

test('canonical host and scheme are enforced', () => {
  const f = evaluatePage(page('page', goodExtract({ canonical: 'http://shop.myshopify.com/pages/x' })), HOST);
  assert.deepEqual(checksOf(f), ['canonical-host', 'canonical-scheme']);
});

test('http og:image is the PR77 regression and errors', () => {
  const f = evaluatePage(page('page', goodExtract({ ogImage: 'http://cdn.example/i.jpg' })), HOST);
  assert.deepEqual(checksOf(f), ['og-image-scheme']);
});

test('h1 count must be exactly one', () => {
  assert.ok(evaluatePage(page('page', goodExtract({ h1Count: 0 })), HOST).some((f) => f.check === 'h1-count'));
  assert.ok(evaluatePage(page('page', goodExtract({ h1Count: 2 })), HOST).some((f) => f.check === 'h1-count'));
});

test('unparseable JSON-LD block errors', () => {
  const f = evaluatePage(page('page', goodExtract({
    jsonLd: [{ raw: '{,}', parsed: null, types: [], error: 'Unexpected token' }],
  })), HOST);
  assert.ok(f.some((x) => x.check === 'jsonld-parse' && x.severity === ERROR));
});

test('entity nodes are homepage-only, exactly once', () => {
  const orgBlock = { raw: '', parsed: {}, types: ['Organization'], error: null };
  const websiteBlock = { raw: '', parsed: {}, types: ['WebSite'], error: null };

  // Homepage with both, once each: clean (index has no breadcrumb).
  const home = { url: `https://${HOST}/`, pageType: 'index', status: 200, x: goodExtract({ jsonLd: [orgBlock, websiteBlock], breadcrumb: false }) };
  assert.deepEqual(evaluatePage(home, HOST), []);

  // Homepage missing WebSite: flagged.
  const homeMissing = { ...home, x: goodExtract({ jsonLd: [orgBlock], breadcrumb: false }) };
  assert.ok(evaluatePage(homeMissing, HOST).some((f) => f.check === 'jsonld-entity-home'));

  // Organization leaking onto a product page: flagged (the pre-PR77 defect).
  const leak = page('product', goodExtract({ jsonLd: [orgBlock, { raw: '', parsed: {}, types: ['ProductGroup', 'BreadcrumbList'], error: null }] }));
  assert.ok(evaluatePage(leak, HOST).some((f) => f.check === 'jsonld-entity-leak'));
});

test('breadcrumb allow-list is enforced in both directions', () => {
  const bc = { raw: '', parsed: {}, types: ['BreadcrumbList'], error: null };
  // Product without breadcrumb: two findings (visible nav + JSON-LD).
  const missing = evaluatePage(page('product', goodExtract({ breadcrumb: false, jsonLd: [{ raw: '', parsed: {}, types: ['ProductGroup'], error: null }] })), HOST);
  assert.ok(missing.some((f) => f.check === 'breadcrumb-missing'));
  assert.ok(missing.some((f) => f.check === 'jsonld-breadcrumb-missing'));
  // Policy page with a breadcrumb: outside the allow-list.
  const unexpected = evaluatePage(page('policy', goodExtract({ jsonLd: [bc] })), HOST);
  assert.ok(unexpected.some((f) => f.check === 'breadcrumb-unexpected'));
});

test('product without Product/ProductGroup markup warns', () => {
  const f = evaluatePage(page('product', goodExtract({ jsonLd: [{ raw: '', parsed: {}, types: ['BreadcrumbList'], error: null }] })), HOST);
  assert.ok(f.some((x) => x.check === 'jsonld-product-missing' && x.severity === WARN));
});

test('crossPageChecks flags duplicated descriptions as errors (the B1 class)', () => {
  const a = { url: `https://${HOST}/products/a`, x: goodExtract({ description: 'Same text '.repeat(6) }) };
  const b = { url: `https://${HOST}/products/b`, x: goodExtract({ description: 'Same text '.repeat(6) }) };
  const f = crossPageChecks([a, b]);
  assert.ok(f.some((x) => x.check === 'description-duplicate' && x.severity === ERROR));
  // Titles differ here, so no title-duplicate beyond the shared goodExtract title.
});

test('partitionAccepted matches on check id and optional path', () => {
  const findings = [
    { check: 'blog-empty', severity: WARN, url: 'admin:blog/news', detail: 'x' },
    { check: 'h1-count', severity: ERROR, url: `https://${HOST}/pages/faq`, detail: 'y' },
  ];
  const accepted = [{ check: 'blog-empty', path: null, note: 'deliberate', accepted_on: '2026-07-28' }];
  const { fresh, accepted: known } = partitionAccepted(findings, accepted);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].check, 'h1-count');
  assert.equal(known[0].note, 'deliberate');
});

test('diffFindings keys on check + path', () => {
  const prev = [{ check: 'h1-count', severity: ERROR, url: `https://${HOST}/pages/faq?x=1`, detail: 'old' }];
  const cur = [
    { check: 'h1-count', severity: ERROR, url: `https://${HOST}/pages/faq`, detail: 'new detail, same finding' },
    { check: 'title-missing', severity: ERROR, url: `https://${HOST}/`, detail: 'brand new' },
  ];
  const { added, resolved, unchanged } = diffFindings(prev, cur);
  assert.deepEqual(added.map((f) => f.check), ['title-missing']);
  assert.deepEqual(resolved, []);
  assert.deepEqual(unchanged.map((f) => f.check), ['h1-count']);
});

test('exitCodeFor blocks only on ERROR severity', () => {
  assert.equal(exitCodeFor([{ severity: WARN }]), 0);
  assert.equal(exitCodeFor([{ severity: ERROR }]), 1);
  assert.equal(exitCodeFor([]), 0);
});

test('findingKey and pathOf tolerate non-URL admin identifiers', () => {
  assert.equal(pathOf('admin:product/huddle-crewneck'), 'admin:product/huddle-crewneck');
  assert.equal(findingKey({ check: 'x', url: 'admin:variants' }), 'x|admin:variants');
});
