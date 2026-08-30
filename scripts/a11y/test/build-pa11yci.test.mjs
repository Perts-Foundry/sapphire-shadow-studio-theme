import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildConfig, CHROME_PATH, PATHS_FILE, resolvePaths, resolvedPaths, PRODUCTS_MARKER } from '../build-pa11yci.mjs';
import { parseCatalogue } from '../../lib/catalogue-manifest.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const paths = resolvedPaths();
const base = { baseUrl: 'https://shop.example', themeId: '12345' };

test('every URL carries the preview theme pin', () => {
  // Without this the audit silently runs against the LIVE theme and greens
  // every PR regardless of what it changed.
  const config = buildConfig(base);
  assert.ok(config.urls.length > 0);
  for (const entry of config.urls) {
    assert.equal(new URL(entry.url).searchParams.get('preview_theme_id'), '12345');
  }
});

test('paths are resolved against the base URL without losing their query', () => {
  const config = buildConfig({ ...base, paths: { paths: [{ path: '/search?q=crewneck' }] } });
  const url = new URL(config.urls[0].url);
  assert.equal(url.origin, 'https://shop.example');
  assert.equal(url.pathname, '/search');
  assert.equal(url.searchParams.get('q'), 'crewneck');
  assert.equal(url.searchParams.get('preview_theme_id'), '12345');
});

test('the cookie is carried as a default header, and omitted when empty', () => {
  assert.equal(buildConfig({ ...base, cookie: 'a=b; c=d' }).defaults.headers.Cookie, 'a=b; c=d');
  // PUBLIC mode after the storefront password is removed: no cookie, still valid.
  assert.deepEqual(buildConfig({ ...base, cookie: '' }).defaults.headers, {});
});

test('defaults match the WCAG2AA gate the sibling repo already runs', () => {
  const { defaults } = buildConfig(base);
  assert.equal(defaults.standard, 'WCAG2AA');
  assert.deepEqual(defaults.runners, ['axe']);
  assert.deepEqual(defaults.rules, ['target-size'], 'the 44x44 project rule must stay checked');
  assert.equal(defaults.chromeLaunchConfig.executablePath, CHROME_PATH);
  assert.ok(defaults.chromeLaunchConfig.args.includes('--no-sandbox'));
});

test('needs-review findings are capped at warning and kept in the JSON', () => {
  // axe `incomplete` (background unmeasurable) is promoted to a gating error
  // by pa11y unless capped; the cap is what let color-contrast leave
  // baseline.json while measured violations still gate. includeWarnings keeps
  // the capped findings in the report so the summariser can disclose them.
  const { defaults } = buildConfig(base);
  assert.equal(defaults.levelCapWhenNeedsReview, 'warning');
  assert.equal(defaults.includeWarnings, true);
});

test('the run is serial, so a burst does not trip bot management', () => {
  assert.equal(buildConfig(base).concurrency, 1);
});

test('FAIL CLOSED: an empty path list throws rather than producing a green no-op config', () => {
  assert.throws(() => buildConfig({ ...base, paths: { paths: [] } }), /no paths/);
  assert.throws(() => buildConfig({ ...base, paths: {} }), /no paths/);
  assert.throws(() => buildConfig({ ...base, paths: { paths: 'nope' } }), /no paths/);
});

test('a missing or non-numeric theme id throws', () => {
  // A blank theme id would build URLs pinned to nothing at all.
  assert.throws(() => buildConfig({ baseUrl: base.baseUrl, themeId: '' }), /themeId/);
  assert.throws(() => buildConfig({ baseUrl: base.baseUrl, themeId: 'abc' }), /themeId/);
  assert.throws(() => buildConfig({ baseUrl: base.baseUrl, themeId: '1; rm -rf /' }), /themeId/);
  assert.throws(() => buildConfig({ baseUrl: '', themeId: '1' }), /baseUrl/);
});

test('per-entry pa11y escape hatches pass through, and nothing else does', () => {
  const config = buildConfig({
    ...base,
    paths: { paths: [{ path: '/', ignore: ['color-contrast'], hideElements: '#chat', label: 'x', bogus: 1 }] },
  });
  assert.deepEqual(config.urls[0].ignore, ['color-contrast']);
  assert.equal(config.urls[0].hideElements, '#chat');
  assert.ok(!('label' in config.urls[0]));
  assert.ok(!('bogus' in config.urls[0]));
});

test('the committed config is JSON-serialisable and has no undefined leaks', () => {
  const json = JSON.stringify(buildConfig({ ...base, cookie: 'x=y' }));
  assert.ok(!json.includes('undefined'));
  assert.deepEqual(JSON.parse(json).urls.length, paths.paths.length);
});

test('the known-debt baseline never reaches pa11y', () => {
  // pa11y's `ignore` drops findings inside the browser, so a baselined rule
  // would be unreportable and the CI comment would claim a pass over rules it
  // had not gated. The baseline is summarize-pa11y.mjs's job now; a regression
  // that re-adds it here would silently un-disclose the whole suppression set.
  const { defaults } = buildConfig(base);
  assert.ok(!('ignore' in defaults), 'defaults.ignore would re-hide the baseline from the report');
});

test('top-level defaults from paths.json reach pa11y, minus the note keys', () => {
  const config = buildConfig({
    ...base,
    paths: { defaults: { hideElements: '#PBarNextFrame', _comment: ['why'] }, paths: [{ path: '/' }] },
  });
  assert.equal(config.defaults.hideElements, '#PBarNextFrame');
  assert.ok(!('_comment' in config.defaults), 'rationale notes are not pa11y options');
});

test('file defaults cannot weaken the committed gate', () => {
  // Spread order is the whole protection here: a paths.json edit may ADD an
  // option, never downgrade the standard, drop the runner, or unpin Chrome.
  const config = buildConfig({
    ...base,
    paths: {
      defaults: { standard: 'WCAG2A', runners: ['htmlcs'], rules: [], chromeLaunchConfig: { args: [] } },
      paths: [{ path: '/' }],
    },
  });
  assert.equal(config.defaults.standard, 'WCAG2AA');
  assert.deepEqual(config.defaults.runners, ['axe']);
  assert.deepEqual(config.defaults.rules, ['target-size']);
  assert.equal(config.defaults.chromeLaunchConfig.executablePath, CHROME_PATH);
});

test('file defaults cannot promote needs-review findings past the warning cap', () => {
  // Raising the cap to error would re-flood the gate with unmeasurable
  // findings; dropping includeWarnings would hide them from the summariser.
  const config = buildConfig({
    ...base,
    paths: {
      defaults: { levelCapWhenNeedsReview: 'error', includeWarnings: false },
      paths: [{ path: '/' }],
    },
  });
  assert.equal(config.defaults.levelCapWhenNeedsReview, 'warning');
  assert.equal(config.defaults.includeWarnings, true);
});

test('an audit-wide ignore in paths.json defaults is rejected outright', () => {
  // Not merely ignored: it is the one option that would re-hide findings from
  // the summariser, which is what baseline.json exists to keep visible.
  assert.throws(
    () => buildConfig({ ...base, paths: { defaults: { ignore: ['color-contrast'] }, paths: [{ path: '/' }] } }),
    /ignore/
  );
});

test('a per-entry hideElements adds to the audit-wide one instead of replacing it', () => {
  // pa11y overrides rather than merges, so a page-scoped hide would otherwise
  // un-hide the preview bar on exactly the page that needed an extra selector.
  const config = buildConfig({
    ...base,
    paths: { defaults: { hideElements: '#PBarNextFrame' }, paths: [{ path: '/', hideElements: '#chat' }] },
  });
  assert.equal(config.urls[0].hideElements, '#PBarNextFrame, #chat');
});

test('the committed paths.json hides the DOM this theme cannot reach', () => {
  // frame-title / frame-tested were baselined audit-wide for the preview-bar
  // iframe, and two more rules for Judge.me's app blocks; dropping either
  // selector resurrects findings no change to this repo could fix. Asserted as
  // substrings so adding a third does not fail the test for the wrong reason.
  const { hideElements } = buildConfig(base).defaults;
  assert.match(hideElements, /#PBarNextFrame/);
  assert.match(hideElements, /jdgm-/);
});

test('per-path ignore is a different thing and still reaches pa11y', () => {
  // The third-party-embed escape hatch is deliberately invisible to the
  // summariser; it is scoped to one URL, not to the whole audit.
  const config = buildConfig({ ...base, paths: { paths: [{ path: '/', ignore: ['frame-title'] }] } });
  assert.deepEqual(config.urls[0].ignore, ['frame-title']);
});

// ── The derived product block ─────────────────────────────────────────────────
//
// Two DISTINCT tests, deliberately kept apart. The first drives the derivation against a
// HAND-AUTHORED manifest and states what the rule is. The second is a MATCHES-PRODUCTION check that
// today's committed files agree; on its own it would be the derived list compared against the
// manifest it came from, which is self-consistency dressed as correctness.

const TEST_MANIFEST = parseCatalogue(
  JSON.stringify({
    version: 2,
    options: { color: 'Color', size: 'Size', design: 'Design', denomination: 'Denominations' },
    colors: { black: { display: 'Black', slug: 'black' } },
    sizes: { s: { display: 'S' } },
    bodies: { crewneck: { colors: ['black'], sizes: ['s'] } },
    products: {
      'zeta-crewneck': { line: 'zeta', body: 'crewneck', template: 'zeta-crewneck', title: 'Zeta Crewneck', gid: 'gid://shopify/Product/1' },
      'alpha-crewneck': { line: 'alpha', body: 'crewneck', template: 'alpha-crewneck', title: 'Alpha Crewneck', gid: 'gid://shopify/Product/2' },
      'the-gift-card': { line: null, body: null, template: 'gift-card', title: 'Gift Card', gid: 'gid://shopify/Product/3' },
    },
  })
);

const RAW = () => ({
  productOverrides: {},
  paths: [
    { path: '/', label: 'index', template: 'templates/index.json' },
    { marker: PRODUCTS_MARKER },
    { path: '/cart', label: 'cart', template: 'templates/cart.json' },
  ],
});

test('LOGIC: the marker expands to one entry per product, in manifest order, in place', () => {
  const out = resolvePaths(RAW(), TEST_MANIFEST);
  assert.deepEqual(out.map((e) => e.path), [
    '/',
    '/products/zeta-crewneck',
    '/products/alpha-crewneck',
    '/products/the-gift-card',
    '/cart',
  ], 'declaration order, not alphabetical, and spliced where the marker sat');
});

test('LOGIC: the label derives from the TEMPLATE, never from the handle', () => {
  const out = resolvePaths(RAW(), TEST_MANIFEST);
  const gift = out.find((e) => e.path === '/products/the-gift-card');
  assert.equal(gift.label, 'product (gift card)');
  assert.notEqual(gift.label, 'product (the gift card)', 'deriving from the handle would say this');
  assert.equal(gift.template, 'templates/product.gift-card.json');
});

test('LOGIC: productOverrides merge onto the derived entry, keyed by handle', () => {
  const raw = RAW();
  raw.productOverrides = { 'zeta-crewneck': { ignore: ['video-caption'], hideElements: '#embed' } };
  const zeta = resolvePaths(raw, TEST_MANIFEST).find((e) => e.path === '/products/zeta-crewneck');
  assert.deepEqual(zeta.ignore, ['video-caption']);
  assert.equal(zeta.hideElements, '#embed');
  // And an override for a product that does not exist is a typo, not a silent no-op.
  raw.productOverrides = { ghost: { ignore: ['x'] } };
  assert.throws(() => resolvePaths(raw, TEST_MANIFEST), /does not declare/);
});

test('FAIL CLOSED: a paths.json with no products marker throws rather than auditing no product', () => {
  const raw = RAW();
  raw.paths = raw.paths.filter((e) => e.marker !== PRODUCTS_MARKER);
  assert.throws(() => resolvePaths(raw, TEST_MANIFEST), /no product page would be audited/);
});

test('FAIL CLOSED: an unrecognised marker throws rather than passing through as a "/undefined" URL', () => {
  const raw = RAW();
  raw.paths = [...raw.paths, { marker: 'catalogue:prodcuts' }];
  assert.throws(() => resolvePaths(raw, TEST_MANIFEST), /unrecognised marker "catalogue:prodcuts"/);
});

test('FAIL CLOSED: a plain entry with no path throws rather than auditing "/undefined"', () => {
  const raw = RAW();
  raw.paths = [...raw.paths, { label: 'lost', template: 'templates/lost.json' }];
  assert.throws(() => resolvePaths(raw, TEST_MANIFEST), /neither a "path" nor a recognised "marker"/);
});

test('MATCHES PRODUCTION: the resolved product entries equal the six the file used to spell out', () => {
  // Byte-compared against the frozen pre-migration capture, so "derived" had to mean "identical".
  const baseline = JSON.parse(
    readFileSync(join(REPO_ROOT, 'scripts/catalogue/test/fixtures/pre-migration-baseline.json'), 'utf8')
  ).a11yProductEntries;
  const derived = resolvedPaths().paths.filter((e) => e.path.startsWith('/products/'));
  assert.equal(JSON.stringify(derived), JSON.stringify(baseline));
});
