import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildConfig, CHROME_PATH, PATHS_FILE } from '../build-pa11yci.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const paths = JSON.parse(readFileSync(PATHS_FILE, 'utf8'));
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
