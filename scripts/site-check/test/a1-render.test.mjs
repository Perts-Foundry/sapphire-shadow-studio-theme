// Tier A1 render classifier: gates, theme id bookkeeping, body checks, h1 rules, coverage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFetchGuard } from './harness.mjs';
installFetchGuard();

import { classifyRender, createThemeTracker, coverageFindings, gateReason } from '../lib/render.mjs';
import { markerRuleFor } from '../lib/markers.mjs';

const HOST = 'example.test';
const page = (h1s = 1, extra = '') => `<html><head><title>t</title></head><body>${'<h1>x</h1>'.repeat(h1s)}${extra}</body></html>`;
const timing = (theme, pageType) => `db;dur=1, theme;desc="${theme}", pageType;desc="${pageType}"`;
const ok = (over = {}) => ({
  path: '/', status: 200, finalUrl: `https://${HOST}/`, expectedHost: HOST,
  serverTiming: timing('111', 'index'), body: page(1, '<h1 class="hero-lockup">'), ...over,
});
const checks = (fs) => fs.map((f) => f.check);

test('password page is a GATE, never PASS, and stops classification', () => {
  const f = classifyRender(ok({ finalUrl: `https://${HOST}/password`, body: page(0) }));
  assert.deepEqual(checks(f), ['render-gate']);
  assert.equal(f[0].severity, 'GATE');
  assert.equal(f[0].subject, '/');
  const form = classifyRender(ok({ body: '<form><input type="hidden" name="form_type" value="storefront_password"><input name="password"></form>' }));
  assert.deepEqual(checks(form), ['render-gate']);
});

test('challenge markers and edge statuses are gates', () => {
  for (const body of ['<title>Just a moment...</title>', '<script src="/cdn-cgi/challenge-platform/x"></script>', 'cf-chl-bypass']) {
    assert.deepEqual(checks(classifyRender(ok({ body }))), ['render-gate'], body);
  }
  for (const status of [403, 429, 430]) {
    assert.deepEqual(checks(classifyRender(ok({ status, body: '' }))), ['render-gate'], String(status));
  }
  assert.equal(gateReason({ status: 200, body: page(1), finalUrl: `https://${HOST}/` }), null);
});

test('status, host, and connection failure', () => {
  assert.deepEqual(checks(classifyRender(ok({ status: 500 }))), ['render-status']);
  assert.deepEqual(checks(classifyRender(ok({ status: null }))), ['render-status']);
  const host = classifyRender(ok({ finalUrl: 'https://other.test/' }));
  assert.ok(checks(host).includes('render-host'));
  assert.equal(host[0].evidence, 'host other.test');
  // The deliberate 404 entry expects 404.
  const rule = markerRuleFor({ path: '/404-intentionally-missing', template: 'templates/404.json' });
  assert.deepEqual(checks(classifyRender(ok({ path: '/404-intentionally-missing', status: 404, markerRule: rule, serverTiming: timing('111', '404'), body: page(1, 'Page not found') }))), []);
  assert.deepEqual(checks(classifyRender(ok({ path: '/404-intentionally-missing', status: 200, markerRule: rule, serverTiming: timing('111', '404') }))), ['render-status']);
});

test('Liquid error and translation missing are found with counts, never body text', () => {
  const f = classifyRender(ok({ body: page(1, '<p>Liquid error (line 3): x</p><p>Liquid error: y</p><span>translation missing: en.foo</span>') }));
  assert.deepEqual(checks(f).sort(), ['render-liquid-error', 'render-translation-missing']);
  const liquid = f.find((x) => x.check === 'render-liquid-error');
  assert.equal(liquid.evidence, 'count 2');
  assert.ok(!liquid.message.includes('line 3'));
});

test('h1 rule: exactly one on index/product/collection/page/article, at most one elsewhere', () => {
  for (const type of ['index', 'product', 'collection', 'page', 'article']) {
    assert.deepEqual(checks(classifyRender(ok({ serverTiming: timing('1', type), body: page(0) }))), ['render-h1-count'], `${type} zero`);
    assert.deepEqual(checks(classifyRender(ok({ serverTiming: timing('1', type), body: page(2) }))), ['render-h1-count'], `${type} two`);
    assert.deepEqual(checks(classifyRender(ok({ serverTiming: timing('1', type), body: page(1) }))), [], `${type} one`);
  }
  for (const type of ['cart', 'search', 'list-collections', 'blog', '404', 'policy']) {
    assert.deepEqual(checks(classifyRender(ok({ serverTiming: timing('1', type), body: page(0) }))), [], `${type} zero`);
    assert.deepEqual(checks(classifyRender(ok({ serverTiming: timing('1', type), body: page(1) }))), [], `${type} one`);
    assert.deepEqual(checks(classifyRender(ok({ serverTiming: timing('1', type), body: page(2) }))), ['render-h1-count'], `${type} two`);
  }
  // An explicit pageType wins over the header.
  assert.deepEqual(checks(classifyRender(ok({ pageType: 'product', serverTiming: null, body: page(0) }))), ['render-h1-count']);
});

test('marker rules: a missing marker names the marker, never the body', () => {
  const rule = markerRuleFor({ path: '/products/lead-ii-crewneck', template: 'templates/product.lead-ii-crewneck.json' });
  const good = page(1, '<div id="SizeChart"></div><input type="checkbox" name="properties[Customer confirm size guide & return policy]" value="Yes">');
  assert.deepEqual(checks(classifyRender(ok({ path: '/products/lead-ii-crewneck', serverTiming: timing('1', 'product'), body: good, markerRule: rule }))), []);
  const bad = classifyRender(ok({ path: '/products/lead-ii-crewneck', serverTiming: timing('1', 'product'), body: page(1, '<p>secret body text</p>'), markerRule: rule }));
  assert.deepEqual(checks(bad), ['render-marker-missing', 'render-marker-missing']);
  assert.equal(bad[0].evidence, 'marker id="SizeChart"');
  for (const f of bad) assert.ok(!f.message.includes('secret') && !f.evidence.includes('secret'));
  const policy = markerRuleFor({ path: '/policies/refund-policy', template: null });
  assert.deepEqual(checks(classifyRender(ok({ path: '/policies/refund-policy', serverTiming: timing('1', 'policy'), body: page(1, '<policy-nav-component>'), markerRule: policy }))), []);
  assert.deepEqual(checks(classifyRender(ok({ path: '/policies/refund-policy', serverTiming: timing('1', 'policy'), body: page(1), markerRule: policy }))), ['render-marker-missing']);
});

test('theme tracker: wrong id is one WARN per run and tags later evidence', () => {
  const t = createThemeTracker({ expectedThemeId: '111' });
  assert.deepEqual(t.observe(timing('111', 'index'), '/'), []);
  const first = t.observe(timing('222', 'product'), '/products/a');
  assert.deepEqual(checks(first), ['render-theme-id']);
  assert.equal(first[0].severity, 'WARN');
  assert.equal(first[0].evidence, 'theme=222');
  assert.deepEqual(t.observe(timing('222', 'product'), '/products/b'), []);
  const tagged = t.tag(classifyRender(ok({ path: '/products/b', status: 500 })));
  assert.equal(tagged[0].evidence, 'theme=222 status 500');
  assert.equal(t.served, '222');
});

test('theme tracker: missing server-timing is render-theme-id-missing (WARN), not PASS', () => {
  const t = createThemeTracker({ expectedThemeId: '111' });
  const f = t.observe(null, '/cart');
  assert.deepEqual(checks(f), ['render-theme-id-missing']);
  assert.equal(f[0].severity, 'WARN');
  assert.equal(f[0].subject, '/cart');
  assert.deepEqual(checks(t.observe('db;dur=1', '/x')), ['render-theme-id-missing']);
});

test('theme tracker: no expected id takes the first served id and notes it once at INFO', () => {
  const t = createThemeTracker({});
  const f = t.observe(timing('333', 'index'), '/');
  assert.deepEqual(checks(f), ['render-theme-id-missing']);
  assert.equal(f[0].severity, 'INFO');
  assert.equal(f[0].subject, 'run');
  assert.equal(t.expected, '333');
  assert.deepEqual(t.observe(timing('333', 'product'), '/products/a'), []);
  assert.deepEqual(checks(t.observe(timing('444', 'product'), '/products/b')), ['render-theme-id']);
});

test('coverage: zero products is an ERROR, otherwise INFO with counts; empty catalogue exempt', () => {
  const zero = coverageFindings({ products: 0, structural: 5, json: 3, cartSteps: 0 });
  assert.equal(zero[0].check, 'render-coverage');
  assert.equal(zero[0].severity, 'ERROR');
  const some = coverageFindings({ products: 6, structural: 15, json: 9, cartSteps: 24 });
  assert.equal(some[0].severity, 'INFO');
  assert.equal(some[0].evidence, 'products 6, structural 15, json 9, cart steps 24');
  assert.equal(coverageFindings({ products: 0, structural: 1, catalogueEmpty: true })[0].severity, 'INFO');
});
