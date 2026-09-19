import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  validateCapture, propertyHost, onPropertyHost, isSensitivePath, REPORTS, REQUIRED_REPORTS_BY_MODE,
  EXPECTED_REPORTS_BY_MODE, KNOWN_REASONS, REASON_LABELS,
} from '../lib/schema.mjs';
import { normaliseCapture } from '../lib/normalise.mjs';
import { baseCapture, readFixture, ORIGIN, notReady, FIXTURES } from './harness.mjs';

const errorsOf = (capture) => validateCapture(capture).errors;

/** Mutate the healthy capture and assert an error at a pointer matching `pathRe`. */
function expectError(mutate, pathRe, messageRe) {
  const c = baseCapture();
  mutate(c, c.reports);
  const errors = errorsOf(c);
  assert.ok(
    errors.some((e) => pathRe.test(e.path) && (!messageRe || messageRe.test(e.message))),
    `expected an error at ${pathRe}; got ${JSON.stringify(errors)}`,
  );
  return errors;
}

test('the healthy, pre-index and problems fixtures validate', () => {
  assert.deepEqual(errorsOf(baseCapture()), []);
  assert.deepEqual(errorsOf(readFixture('capture-preindex.json')), []);
  assert.deepEqual(errorsOf(readFixture('capture-problems.json')), []);
});

test('the insights fixture validates only after normalisation', () => {
  const raw = readFixture('capture-insights.json');
  assert.ok(errorsOf(raw).length > 0, 'the raw transcription should not validate');
  const { capture, errors } = normaliseCapture(raw);
  assert.deepEqual(errors, []);
  assert.deepEqual(errorsOf(capture), []);
});

test('an unknown key is rejected at any depth', () => {
  expectError((c) => { c.extra = 1; }, /^\/extra$/, /unknown key/);
  expectError((c, r) => { r.settings.extra = 1; }, /^\/reports\/settings\/extra$/, /unknown key/);
  expectError((c, r) => { r.performance.pages.rows[0].extra = 1; }, /^\/reports\/performance\/pages\/rows\/0\/extra$/, /unknown key/);
  expectError((c, r) => { r.discovery.unknown.push({ kind: 'nav', label: 'x', path: null, note: 'n', extra: 1 }); }, /\/unknown\/0\/extra$/, /unknown key/);
});

test('a negative integer is rejected', () => {
  expectError((c, r) => { r.settings.owners = -1; }, /^\/reports\/settings\/owners$/, /non-negative integer/);
  expectError((c, r) => { r.cwv.mobile.good = 1.5; }, /^\/reports\/cwv\/mobile\/good$/, /non-negative integer/);
});

test('a rate above 1 is rejected', () => {
  expectError((c, r) => { r['crawl-stats'].share_4xx = 1.01; }, /share_4xx$/, /rate between 0 and 1/);
});

test('position 0 is allowed only with zero impressions', () => {
  expectError((c, r) => { r.performance.pages.rows[0].position = 0; }, /pages\/rows\/0\/position$/, /between 1 and 100/);
  const c = baseCapture();
  c.reports.performance.devices.tablet = { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  assert.deepEqual(errorsOf(c), []);
  expectError((c2, r) => { r.performance.pages.rows[0].position = 101; }, /position$/, /between 1 and 100/);
});

test('a bad status is rejected, at report and sitemap level', () => {
  expectError((c, r) => { r.cwv.status = 'processing'; }, /^\/reports\/cwv\/status$/);
  expectError((c, r) => { r.sitemaps.rows[0].status = 'OK'; }, /sitemaps\/rows\/0\/status$/);
});

test('a not-ready or not-present report carries no data fields', () => {
  expectError((c, r) => { r.cwv = { ...notReady('cwv'), mobile: 'no-data' }; }, /^\/reports\/cwv\/mobile$/, /carries no data fields/);
  expectError((c, r) => { r.https = { ...notReady('https', 'not-present'), https_urls: 0 }; }, /^\/reports\/https\/https_urls$/, /carries no data fields/);
});

test('the nonce is required and shaped', () => {
  expectError((c) => { delete c.nonce; }, /^\/nonce$/);
  expectError((c) => { c.nonce = 'short'; }, /^\/nonce$/);
  expectError((c) => { c.nonce = 'UPPERCASE123'; }, /^\/nonce$/);
});

test('a timestamp without an offset is rejected', () => {
  expectError((c) => { c.captured_at = '2026-12-01T09:00:00'; }, /^\/captured_at$/, /offset/);
  expectError((c, r) => { r.links.captured_at = '2026-12-01'; }, /^\/reports\/links\/captured_at$/, /offset/);
});

test('an unknown report id is rejected, and report must equal its key', () => {
  expectError((c, r) => { r.shopping = notReady('shopping'); }, /^\/reports\/shopping$/, /unknown report id/);
  expectError((c, r) => { r.links.report = 'cwv'; }, /^\/reports\/links\/report$/);
});

test('an email-shaped string is rejected anywhere', () => {
  const address = ['someone', 'example.test'].join('@');
  expectError((c, r) => { r.messages.subjects.push(`Access granted to ${address}`); }, /^\/reports\/messages\/subjects\/1$/, /email-shaped/);
  expectError((c, r) => { r.performance.queries.rows[1].query = address; }, /queries\/rows\/1\/query$/, /email-shaped/);
});

test('a token-shaped or customer URL is rejected; a long hyphenated handle is not', () => {
  const token = ['Z2NwLXVzLWVh', 'c3QxOjAxSkY'].join('');
  expectError((c, r) => { r['indexing-pages'].reasons[0].examples = [`${ORIGIN}/cart/c/${token}`]; }, /examples\/0$/, /token-bearing/);
  expectError((c, r) => { r['indexing-pages'].reasons[0].examples = [`${ORIGIN}/pages/${token}`]; }, /examples\/0$/, /token-bearing/);
  expectError((c, r) => { r.links.top_linked_pages[0].url = `${ORIGIN}/account/login`; }, /top_linked_pages\/0\/url$/, /token-bearing/);
  assert.equal(isSensitivePath('/products/sapphire-shadow-studio-gift-card'), false);
  assert.equal(isSensitivePath('/checkouts/cn/abc'), true);
  assert.equal(isSensitivePath('/orders/12'), true);
});

test('a URL with a query string or fragment, or off the property host, is rejected', () => {
  expectError((c, r) => { r.performance.pages.rows[0].url = `${ORIGIN}/?variant=1`; }, /pages\/rows\/0\/url$/, /query string/);
  expectError((c, r) => { r.performance.pages.rows[0].url = `${ORIGIN}/#top`; }, /pages\/rows\/0\/url$/, /fragment/);
  expectError((c, r) => { r.performance.pages.rows[0].url = 'https://other-shop.example/'; }, /pages\/rows\/0\/url$/, /property host/);
  const c = baseCapture();
  c.reports.inspections.items[1].google_canonical = 'https://other-shop.example/products/x';
  assert.deepEqual(errorsOf(c), [], 'a canonical may name another host; that is a finding, not a typo');
});

test('reason counts must sum to not_indexed', () => {
  expectError((c, r) => { r['indexing-pages'].not_indexed = 4; }, /^\/reports\/indexing-pages\/reasons$/, /sum/);
});

test('cross-field invariants: clicks, ctr, devices, countries, owners', () => {
  expectError((c, r) => { r.performance.pages.rows[0].clicks = 500; }, /pages\/rows\/0$/, /clicks exceed/);
  expectError((c, r) => { r.performance.totals.ctr = 0.5; }, /totals\/ctr$/, /disagrees/);
  expectError((c, r) => { r.performance.devices.mobile.impressions = 5000; r.performance.devices.mobile.clicks = 100; r.performance.devices.mobile.ctr = 0.02; }, /^\/reports\/performance\/devices$/, /exceed the total/);
  expectError((c, r) => { r.performance.countries.rows[0].impressions = 2500; r.performance.countries.rows[0].clicks = 50; }, /^\/reports\/performance\/countries$/, /exceed the total/);
  expectError((c, r) => { r.settings.owners = 3; }, /^\/reports\/settings\/owners$/, /owners exceed users/);
});

test('a mode with its required report missing is rejected', () => {
  expectError((c, r) => { delete r.settings; }, /^\/reports\/settings$/, /required for mode audit/);
  expectError((c, r) => { c.mode = 'insights'; delete r.performance; }, /^\/reports\/performance$/, /required for mode insights/);
  assert.ok(REQUIRED_REPORTS_BY_MODE.audit.every((id) => REPORTS.includes(id)));
  assert.ok(EXPECTED_REPORTS_BY_MODE.insights.every((id) => REPORTS.includes(id)));
});

test('errors are aggregated, each with a pointer path', () => {
  const errors = errorsOf(readFixture('capture-invalid.json'));
  assert.ok(errors.length >= 6, JSON.stringify(errors));
  for (const e of errors) {
    assert.equal(typeof e.path, 'string');
    assert.equal(typeof e.message, 'string');
  }
  const paths = errors.map((e) => e.path);
  for (const p of ['/schema', '/captured_at', '/nonce', '/extra', '/reports/settings/owners', '/reports/cwv/mobile', '/reports/bogus']) {
    assert.ok(paths.includes(p), `missing ${p} in ${JSON.stringify(paths)}`);
  }
});

test('offending values are never echoed', () => {
  const c = baseCapture();
  c.nonce = 'sentinelvalueNONCE';
  c.reports.settings.owners = 'sentinel-owners';
  c.reports.settings.method = 'x'.repeat(130) + 'sentinel';
  c.reports.performance.pages.rows[0].url = `${ORIGIN}/?q=sentinel-query`;
  c.reports.messages.subjects.push(`sentinel ${['a', 'b.test'].join('@')}`);
  const text = JSON.stringify(errorsOf(c));
  assert.ok(errorsOf(c).length >= 5);
  assert.ok(!/sentinel/i.test(text), text);
});

test('property host helpers', () => {
  assert.equal(propertyHost('sc-domain:sapphireshadowstudio.com'), 'sapphireshadowstudio.com');
  assert.equal(propertyHost('https://www.example.test/'), 'www.example.test');
  assert.equal(propertyHost('sc-domain:not a host'), null);
  assert.equal(propertyHost(42), null);
  assert.equal(onPropertyHost('www.sapphireshadowstudio.com', 'sc-domain:sapphireshadowstudio.com'), true);
  assert.equal(onPropertyHost('www.example.test', 'https://example.test/'), false);
  assert.equal(onPropertyHost('evil-sapphireshadowstudio.com', 'sc-domain:sapphireshadowstudio.com'), false);
});

test('every reason label maps to a known slug', () => {
  const slugs = new Set(Object.values(REASON_LABELS));
  assert.deepEqual([...slugs].sort(), KNOWN_REASONS.filter((r) => r !== 'unknown').sort());
});

test('isSensitivePath: public storefront paths pass; token-shaped and customer routes do not', () => {
  const pass = [
    '/sitemap_products_1.xml', '/sitemap_collections_1.xml', '/sitemap_pages_1.xml', '/sitemap_blogs_1.xml',
    '/blogs/shift-notes/internationalization', '/pages/abcdefghij123456789', '/accounts-receivable-tote',
    '/products/sapphire-shadow-studio-gift-card', '/',
  ];
  const refuse = [
    '/pages/abcdefghij1234567890', '/cart/c/hWN4-ab', '/12345678/checkouts/cn/hWN4abcd-EFgh-ijkl', '/Checkouts/abc',
    '/account', '/account/login', '/12345678/orders/abc', '/pages/123e4567-e89b-12d3-a456-426614174000',
  ];
  for (const p of pass) assert.equal(isSensitivePath(p), false, p);
  for (const p of refuse) assert.equal(isSensitivePath(p), true, p);
});

test('a discovery view path with a token-shaped segment is rejected', () => {
  const token = 'abcdef0123456789abcdef01';
  expectError((c, r) => { r.discovery.unknown.push({ kind: 'nav', label: 'X', path: `resource/${token}`, note: 'n' }); }, /\/unknown\/0\/path$/, /token-shaped/);
  expectError((c, r) => { r.discovery.nav.push({ label: 'X', path: `r/${token}` }); }, /\/nav\/\d+\/path$/, /token-shaped/);
  const c = baseCapture();
  c.reports.discovery.unknown.push({ kind: 'nav', label: 'Shopping', path: 'shopping-tab', note: 'a new report' });
  assert.deepEqual(errorsOf(c), []);
});

test('unread above total, more examples than the count, and an email-shaped key are rejected', () => {
  expectError((c, r) => { r.messages.unread = r.messages.total + 1; }, /^\/reports\/messages\/unread$/, /exceeds total/);
  expectError((c, r) => {
    r['indexing-pages'].reasons.push({ reason: 'soft-404', source: null, count: 1, examples: [`${ORIGIN}/pages/faq`, `${ORIGIN}/pages/about`] });
    r['indexing-pages'].not_indexed += 1;
  }, /reasons\/\d+\/examples$/, /more examples than the reason count/);
  const address = ['someone', 'example.test'].join('@');
  expectError((c, r) => { r.messages[address] = 1; }, /^\/reports\/messages\//, /email-shaped key/);
});

test('a capture that is not an object, a bad property and a non-object reports are rejected', () => {
  assert.deepEqual(validateCapture([]).errors.map((e) => e.path), ['']);
  assert.deepEqual(validateCapture(null).errors.map((e) => e.path), ['']);
  expectError((c) => { c.property = 'not a property'; }, /^\/property$/);
  expectError((c) => { c.reports = []; }, /^\/reports$/, /expected an object/);
});

// ---------------------------------------------------------------------------------------------
// Fields added after the run of 2026-09-18.

const ENH = /^\/reports\/enhancements\/items\/0/;
const issue = (over = {}) => ({ label: "Missing field 'name'", items: 1, level: 'warning', ...over });

test('enhancement issues: level enum, the 20-row cap, and items against valid plus invalid', () => {
  expectError((c, r) => { r.enhancements.items[0].issues = [issue({ level: 'critical' })]; }, /issues\/0\/level$/, /expected one of/);
  const withIssues = (n) => {
    const c = baseCapture();
    c.reports.enhancements.items[0].issues = Array.from({ length: n }, (_, i) => issue({ label: `Issue ${i}` }));
    return errorsOf(c);
  };
  assert.deepEqual(withIssues(20), []);
  assert.ok(withIssues(21).some((e) => /\/issues$/.test(e.path) && /longer than 20/.test(e.message)));
  const atCap = baseCapture();
  const item = atCap.reports.enhancements.items[0];
  item.invalid = 1;
  item.issues = [issue({ items: item.valid + item.invalid })];
  assert.deepEqual(errorsOf(atCap), []);
  expectError((c, r) => {
    const it = r.enhancements.items[0];
    it.issues = [issue({ items: it.valid + it.invalid + 1 })];
  }, /issues\/0\/items$/, /exceed valid plus invalid/);
});

test('enhancement warning: null is accepted, above valid is rejected', () => {
  const c = baseCapture();
  c.reports.enhancements.items[0].warning = null;
  assert.deepEqual(errorsOf(c), []);
  expectError((c2, r) => { r.enhancements.items[0].warning = r.enhancements.items[0].valid + 1; }, new RegExp(`${ENH.source}/warning$`), /exceeds valid/);
});

const alert = (over = {}) => ({ subject: 'New reasons prevent pages from being indexed', examples: [], ...over });

test('message alerts: empty examples accepted; count, report status and URL shape enforced', () => {
  const c = baseCapture();
  c.reports.messages.alerts = [alert()];
  assert.deepEqual(errorsOf(c), []);
  expectError((c2, r) => { r.messages.alerts = [alert(), alert()]; }, /^\/reports\/messages\/alerts$/, /more alerts than messages/);
  expectError((c2, r) => { r.messages = { ...notReady('messages', 'not-present'), alerts: [alert()] }; }, /^\/reports\/messages\/alerts$/, /carries no data fields/);
  expectError((c2, r) => { r.messages.alerts = [alert({ examples: [`${ORIGIN}/pages/faq?x=1`] })]; }, /alerts\/0\/examples\/0$/, /query string/);
  expectError((c2, r) => { r.messages.alerts = [alert({ examples: ['https://other-shop.example/pages/faq'] })]; }, /alerts\/0\/examples\/0$/, /not on the property host/);
});

test('anchor misses: caps on entries and anchors; a null view is the bell', () => {
  const miss = (anchors = ['Last update:'], view = 'index') => ({ view, anchors });
  const c = baseCapture();
  c.reports.discovery.anchor_misses = [miss(['Messages'], null)];
  assert.deepEqual(errorsOf(c), []);
  expectError((c2, r) => { r.discovery.anchor_misses = Array.from({ length: 31 }, () => miss()); }, /\/anchor_misses$/, /longer than 30/);
  expectError((c2, r) => { r.discovery.anchor_misses = [miss(Array.from({ length: 11 }, (_, i) => `a${i}`))]; }, /\/anchor_misses\/0\/anchors$/, /longer than 10/);
});

test('videos: counts are non-negative; not-ready carries none; insights may carry one', () => {
  expectError((c, r) => { r.videos.not_indexed = -1; }, /^\/reports\/videos\/not_indexed$/, /non-negative integer/);
  const c = baseCapture();
  c.reports.videos = notReady('videos');
  assert.deepEqual(errorsOf(c), []);
  assert.ok(EXPECTED_REPORTS_BY_MODE.audit.includes('videos'));
  assert.ok(!EXPECTED_REPORTS_BY_MODE.insights.includes('videos'));
  const { capture: insights } = normaliseCapture(readFixture('capture-insights.json'));
  insights.reports.videos = { ...notReady('videos', 'ok'), indexed: 0, not_indexed: 0 };
  assert.deepEqual(errorsOf(insights), []);
});

test('a template placeholder or a ?-suffixed key is refused at its pointer', () => {
  expectError((c, r) => { r.links['top_linking_sites?'] = 1; }, /^\/reports\/links\/top_linking_sites\?$/, /`\?` suffix/);
  expectError((c, r) => { r.settings.method = '<int>'; }, /^\/reports\/settings\/method$/, /placeholder left unfilled/);
  const angled = baseCapture();
  angled.reports.settings.method = 'Domain name provider <DNS>';
  assert.deepEqual(errorsOf(angled), [], 'only a whole-value placeholder is refused');
});

test('fields wrapped by describe still validate: one rejection per wrapped field', () => {
  expectError((c, r) => { r.messages.alerts = [alert({ subject: 'x'.repeat(121) })]; }, /alerts\/0\/subject$/, /longer than 120/);
  expectError((c, r) => { r.messages.alerts = [alert({ reason_label: 'x'.repeat(201) })]; }, /alerts\/0\/reason_label$/, /longer than 200/);
  expectError((c, r) => { r.enhancements.items[0].type = 'x'.repeat(81); }, /items\/0\/type$/, /longer than 80/);
  expectError((c, r) => { r.enhancements.items[0].issues = [issue({ label: 'x'.repeat(121) })]; }, /issues\/0\/label$/, /longer than 120/);
  expectError((c, r) => { r.discovery.anchor_misses = [{ view: 'bad path!', anchors: ['a'] }]; }, /anchor_misses\/0\/view$/, /view path/);
  expectError((c, r) => { r.discovery.anchor_misses = [{ view: 'r/abcdef0123456789abcdef01', anchors: ['a'] }]; }, /anchor_misses\/0\/view$/, /token-shaped/);
});

test('the placeholder guard reaches inside arrays, and refuses any whole-value <...> string by design', () => {
  expectError((c, r) => { r.messages.subjects[0] = '<string of at most 120 characters>'; }, /^\/reports\/messages\/subjects\/0$/, /placeholder left unfilled/);
  expectError((c, r) => { r.messages.alerts = [alert({ examples: ['<page URL on the property host, no query or fragment>'] })]; },
    /alerts\/0\/examples\/0$/, /placeholder left unfilled/);
  // A real value written entirely in angle brackets is refused too: the guard cannot tell it from a
  // skeleton slot, and such a value is rare enough that transcribing it without the brackets is the rule.
  expectError((c, r) => { r.messages.subjects[0] = '<Search Console>'; }, /subjects\/0$/, /placeholder left unfilled/);
});

test('every committed fixture except capture-invalid still validates', () => {
  const names = fs.readdirSync(FIXTURES).filter((f) => /^capture-.*\.json$/.test(f) && f !== 'capture-invalid.json');
  assert.ok(names.includes('capture-run2.json'));
  for (const name of names) {
    const { capture, errors } = normaliseCapture(readFixture(name));
    assert.deepEqual([...errors, ...errorsOf(capture)], [], name);
  }
});
