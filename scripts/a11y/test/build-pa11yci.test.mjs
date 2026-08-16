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
