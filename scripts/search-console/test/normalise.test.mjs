import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseCapture } from '../lib/normalise.mjs';
import { validateCapture, reasonSlugFor } from '../lib/schema.mjs';
import { baseCapture, readFixture, ORIGIN } from './harness.mjs';

const norm = (mutate) => {
  const c = baseCapture();
  mutate(c.reports, c);
  return normaliseCapture(c);
};

test('percent forms become rates rounded to 4 dp', () => {
  const { capture, errors } = norm((r) => {
    r.performance.pages.rows[0].ctr = '3.2%';
    r.performance.pages.rows[1].ctr = '2.34567%';
    r['crawl-stats'].share_4xx = '1%';
  });
  assert.deepEqual(errors, []);
  assert.equal(capture.reports.performance.pages.rows[0].ctr, 0.032);
  assert.equal(capture.reports.performance.pages.rows[1].ctr, 0.0235);
  assert.equal(capture.reports['crawl-stats'].share_4xx, 0.01);
});

test('"<0.1%" becomes 0.0005', () => {
  const { capture } = norm((r) => { r.performance.queries.rows[1].ctr = '<0.1%'; });
  assert.equal(capture.reports.performance.queries.rows[1].ctr, 0.0005);
});

test('comma thousands and numeric strings become numbers', () => {
  const { capture, errors } = norm((r) => {
    r.performance.totals.impressions = '2,000';
    r.performance.totals.position = '12.4';
    r['crawl-stats'].requests = '500';
  });
  assert.deepEqual(errors, []);
  assert.equal(capture.reports.performance.totals.impressions, 2000);
  assert.equal(capture.reports.performance.totals.position, 12.4);
  assert.equal(capture.reports['crawl-stats'].requests, 500);
});

test('K, M and B abbreviations are refused with a clear error', () => {
  for (const value of ['1.2K', '1.5M', '3 k', '1.2B']) {
    const { errors } = norm((r) => { r.performance.totals.impressions = value; });
    assert.equal(errors.length, 1, value);
    assert.equal(errors[0].path, '/reports/performance/totals/impressions');
    assert.match(errors[0].message, /abbreviated number/);
    assert.ok(!errors[0].message.includes(value));
  }
});

test('an empty string and a bare dash become null', () => {
  const { capture } = norm((r) => {
    r['crawl-stats'].share_5xx = '-';
    r['crawl-stats'].share_4xx = '';
    r.inspections.items[0].crawled_as = ' – ';
  });
  assert.equal(capture.reports['crawl-stats'].share_5xx, null);
  assert.equal(capture.reports['crawl-stats'].share_4xx, null);
  assert.equal(capture.reports.inspections.items[0].crawled_as, null);
});

test('strings are trimmed; query text and discovery labels are never turned into numbers', () => {
  const { capture } = norm((r) => {
    r.performance.search_type = '  Web  ';
    r.performance.queries.rows[1].query = '1,234';
    r.discovery.performance_controls.push('100');
  });
  assert.equal(capture.reports.performance.search_type, 'Web');
  assert.equal(capture.reports.performance.queries.rows[1].query, '1,234');
  assert.ok(capture.reports.discovery.performance_controls.includes('100'));
});

test('already-numeric input passes through; rates are rounded', () => {
  const { capture } = norm((r) => { r.performance.pages.rows[0].ctr = 0.123456; });
  assert.equal(capture.reports.performance.pages.rows[0].ctr, 0.1235);
  assert.equal(capture.reports.performance.pages.rows[1].clicks, 2);
});

test('booleans and verdicts from page text', () => {
  const { capture } = norm((r) => {
    r.inspections.items[0].crawl_allowed = 'Yes';
    r.inspections.items[0].indexing_allowed = 'No';
    r.inspections.items[0].verdict = 'URL is on Google';
    r.inspections.items[3].verdict = 'URL is not on Google';
    r.sitemaps.rows[0].status = 'Couldn’t fetch';
  });
  const items = capture.reports.inspections.items;
  assert.equal(items[0].crawl_allowed, true);
  assert.equal(items[0].indexing_allowed, false);
  assert.equal(items[0].verdict, 'on-google');
  assert.equal(items[3].verdict, 'not-on-google');
  assert.equal(capture.reports.sitemaps.rows[0].status, "Couldn't fetch");
});

test('host derivation: sc-domain and URL-prefix properties absolutise relative URLs', () => {
  const domain = norm((r) => { r.performance.pages.rows[0].url = '/pages/about'; });
  assert.equal(domain.capture.reports.performance.pages.rows[0].url, `${ORIGIN}/pages/about`);

  const c = baseCapture();
  c.property = 'https://www.example.test/';
  c.reports.links.top_linked_pages[0].url = '/pages/faq';
  const prefix = normaliseCapture(c);
  assert.equal(prefix.capture.reports.links.top_linked_pages[0].url, 'https://www.example.test/pages/faq');
});

test('an absolute URL on a foreign host is rejected; a subdomain of a Domain property is not', () => {
  const foreign = norm((r) => { r.performance.pages.rows[0].url = 'https://other-shop.example/x'; });
  assert.equal(foreign.errors.length, 1);
  assert.equal(foreign.errors[0].path, '/reports/performance/pages/rows/0/url');
  assert.match(foreign.errors[0].message, /outside the property/);

  const sub = norm((r) => { r.performance.pages.rows[0].url = 'https://www.sapphireshadowstudio.com/x'; });
  assert.deepEqual(sub.errors, []);

  const canonical = norm((r) => { r.inspections.items[0].google_canonical = 'https://other-shop.example/'; });
  assert.deepEqual(canonical.errors, [], 'a canonical on another host is data, not a transcription error');
});

test('query strings and fragments are stripped from URL fields', () => {
  const { capture } = norm((r) => {
    r.performance.pages.rows[0].url = `${ORIGIN}/products/lead-ii-crewneck?variant=123#reviews`;
    r['indexing-pages'].reasons[0].examples = ['/blogs/shift-notes?page=2'];
    r.inspections.items[1].user_canonical = `${ORIGIN}/products/lead-ii-vest-womens?utm_source=x`;
  });
  assert.equal(capture.reports.performance.pages.rows[0].url, `${ORIGIN}/products/lead-ii-crewneck`);
  assert.equal(capture.reports['indexing-pages'].reasons[0].examples[0], `${ORIGIN}/blogs/shift-notes`);
  assert.equal(capture.reports.inspections.items[1].user_canonical, `${ORIGIN}/products/lead-ii-vest-womens`);
});

test('every reason label, with its punctuation, maps to its slug', () => {
  const cases = {
    'Crawled - currently not indexed': 'crawled-not-indexed',
    'Discovered - currently not indexed': 'discovered-not-indexed',
    'Alternate page with proper canonical tag': 'alternate-canonical',
    'Duplicate without user-selected canonical': 'duplicate-no-canonical',
    'Duplicate, Google chose different canonical than user': 'duplicate-google-chose-different',
    "Excluded by 'noindex' tag": 'noindex',
    'Not found (404)': 'not-found',
    'Page with redirect': 'redirect',
    'Soft 404': 'soft-404',
    'Blocked by robots.txt': 'blocked-robots',
    'Server error (5xx)': 'server-error',
    'Blocked due to access forbidden (403)': 'forbidden',
    'Blocked due to other 4xx issue': 'other-4xx',
    // curly quotes and an en dash, as a rendered page may show them
    'Excluded by ‘noindex’ tag': 'noindex',
    'Crawled – currently not indexed': 'crawled-not-indexed',
  };
  for (const [label, slug] of Object.entries(cases)) {
    assert.equal(reasonSlugFor(label), slug, label);
    const { capture } = norm((r) => {
      r['indexing-pages'].reasons[0].reason = label;
    });
    assert.equal(capture.reports['indexing-pages'].reasons[0].reason, slug, label);
  }
});

test('an unknown reason label is kept under unknown with the label preserved', () => {
  const { capture } = norm((r) => { r['indexing-pages'].reasons[0].reason = 'Blocked by page removal tool'; });
  const reason = capture.reports['indexing-pages'].reasons[0];
  assert.equal(reason.reason, 'unknown');
  assert.equal(reason.label, 'Blocked by page removal tool');
  assert.deepEqual(validateCapture(capture).errors, []);
});

test('report ids are filled from their key when the transcription omits them', () => {
  const raw = readFixture('capture-insights.json');
  const { capture } = normaliseCapture(raw);
  for (const [id, rep] of Object.entries(capture.reports)) assert.equal(rep.report, id);
});

test('normalisation is idempotent', () => {
  for (const name of ['capture-healthy.json', 'capture-insights.json', 'capture-preindex.json', 'capture-problems.json']) {
    const once = normaliseCapture(readFixture(name)).capture;
    const twice = normaliseCapture(structuredClone(once));
    assert.deepEqual(twice.capture, once, name);
    assert.deepEqual(twice.errors, []);
  }
  assert.deepEqual(normaliseCapture(baseCapture()).capture, baseCapture(), 'a normalised capture comes back unchanged');
});

test('normalise runs before validate: the raw form fails, the normalised form passes', () => {
  const c = baseCapture();
  c.reports.performance.totals.ctr = '2%';
  c.reports.performance.totals.impressions = '2,000';
  assert.ok(validateCapture(c).errors.length >= 2);
  assert.deepEqual(validateCapture(normaliseCapture(c).capture).errors, []);
});

test('non-object input passes through untouched', () => {
  assert.deepEqual(normaliseCapture(null), { capture: null, errors: [] });
  assert.deepEqual(normaliseCapture([1]), { capture: [1], errors: [] });
});
