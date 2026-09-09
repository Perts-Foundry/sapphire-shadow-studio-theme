import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePage, crossPageChecks, partitionAccepted, diffFindings,
  findingKey, exitCodeFor, pathOf, ERROR, WARN,
} from '../lib/checks.mjs';
import { jsonLdTypes } from '../lib/extract.mjs';

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

test('collection page without an ItemList warns, and other page types do not', () => {
  const bc = { raw: '', parsed: {}, types: ['BreadcrumbList'], error: null };
  const missing = evaluatePage(page('collection', goodExtract({ jsonLd: [bc] })), HOST);
  assert.deepEqual(checksOf(missing), ['jsonld-itemlist-missing']);
  assert.equal(missing[0].severity, WARN);

  const present = evaluatePage(page('collection', goodExtract({
    jsonLd: [bc, { raw: '', parsed: {}, types: ['ItemList'], error: null }],
  })), HOST);
  assert.deepEqual(present, []);

  // A page with no ItemList and no reason to have one stays clean.
  assert.deepEqual(evaluatePage(page('page', goodExtract()), HOST), []);
});

test('product without Product/ProductGroup markup warns', () => {
  const f = evaluatePage(page('product', goodExtract({ jsonLd: [{ raw: '', parsed: {}, types: ['BreadcrumbList'], error: null }] })), HOST);
  assert.ok(f.some((x) => x.check === 'jsonld-product-missing' && x.severity === WARN));
});

test('more than one top-level Product node on a product page errors', () => {
  const bc = { raw: '', parsed: {}, types: ['BreadcrumbList'], error: null };
  const themeProduct = { raw: '', parsed: {}, types: ['Product'], error: null };
  const appProduct = { raw: '', parsed: {}, types: ['Product'], error: null };

  // Theme filter plus an app's own block: the anticipated overlap, flagged as ERROR.
  const dup = evaluatePage(page('product', goodExtract({ jsonLd: [bc, themeProduct, appProduct] })), HOST);
  assert.ok(dup.some((x) => x.check === 'jsonld-product-duplicate' && x.severity === ERROR));

  // One block: clean.
  assert.deepEqual(evaluatePage(page('product', goodExtract({ jsonLd: [bc, themeProduct] })), HOST), []);

  // One ProductGroup whose variants are nested Products counts once: the
  // extractor flattens only top-level nodes.
  const group = {
    '@type': 'ProductGroup',
    hasVariant: [{ '@type': 'Product' }, { '@type': 'Product' }],
  };
  const groupBlock = { raw: '', parsed: group, types: jsonLdTypes(group), error: null };
  assert.deepEqual(groupBlock.types, ['ProductGroup']);
  assert.deepEqual(evaluatePage(page('product', goodExtract({ jsonLd: [bc, groupBlock] })), HOST), []);

  // The likeliest real trip: the theme's ProductGroup (multi-variant product)
  // beside an app's Product. The count is the only diagnostic the operator gets,
  // so pin it too.
  const mixed = evaluatePage(page('product', goodExtract({ jsonLd: [bc, groupBlock, appProduct] })), HOST);
  const mixedFinding = mixed.find((x) => x.check === 'jsonld-product-duplicate');
  assert.equal(mixedFinding?.severity, ERROR);
  assert.match(mixedFinding.detail, /^2 Product\/ProductGroup nodes/);

  // One block carrying two Products in a @graph counts as two top-level nodes.
  const graph = { '@graph': [{ '@type': 'Product' }, { '@type': 'Product' }] };
  const graphBlock = { raw: '', parsed: graph, types: jsonLdTypes(graph), error: null };
  assert.ok(evaluatePage(page('product', goodExtract({ jsonLd: [bc, graphBlock] })), HOST).some((x) => x.check === 'jsonld-product-duplicate'));

  // A block that fails to parse contributes no types: the theme's node plus a
  // broken app block is a parse error, not a duplicate.
  const broken = { raw: '{', parsed: null, types: [], error: 'Unexpected end of JSON input' };
  assert.deepEqual(checksOf(evaluatePage(page('product', goodExtract({ jsonLd: [bc, themeProduct, broken] })), HOST)), ['jsonld-parse']);

  // The check is gated on the product page type: a collection page with
  // product-card markup never trips it.
  const itemList = { raw: '', parsed: {}, types: ['ItemList'], error: null };
  const coll = evaluatePage(page('collection', goodExtract({ jsonLd: [bc, themeProduct, appProduct, itemList] })), HOST);
  assert.ok(!coll.some((x) => x.check === 'jsonld-product-duplicate'));
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
