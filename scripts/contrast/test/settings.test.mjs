import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSettingsData, extractSchemes, schemaRoleIds, loadSchemes } from '../lib/settings.mjs';
import { PATHS } from '../check-contrast.mjs';

const BANNER = ['/*', ' * IMPORTANT: auto-generated.', ' */'].join('\n');

test('parseSettingsData strips the leading Shopify banner comment', () => {
  assert.deepEqual(parseSettingsData(`${BANNER}\n{"current":{}}`), { current: {} });
  assert.deepEqual(parseSettingsData('{"current":{}}'), { current: {} }, 'no banner is fine too');
  assert.deepEqual(parseSettingsData(`﻿${BANNER}\n{"a":1}`), { a: 1 }, 'BOM tolerated');
});

test('parseSettingsData only strips a LEADING comment, never one inside a value', () => {
  // A `/*` inside a string value must survive: treating the file as general
  // JSONC would corrupt any colour or label containing those two characters.
  const data = parseSettingsData(`${BANNER}\n{"note":"a /* b */ c"}`);
  assert.equal(data.note, 'a /* b */ c');
});

test('parseSettingsData throws on genuinely broken JSON', () => {
  assert.throws(() => parseSettingsData(`${BANNER}\n{"current":`), SyntaxError);
});

test('extractSchemes pulls from current AND from every preset', () => {
  const schemes = extractSchemes({
    current: { color_schemes: { 'scheme-1': { settings: { background: '#fff' } } } },
    presets: {
      Default: { color_schemes: { 'scheme-1': { settings: { background: '#000' } } } },
      Alt: { color_schemes: { 'scheme-9': { settings: { background: '#eee' } } } },
    },
  });
  assert.deepEqual(schemes.map((s) => `${s.source}/${s.scheme}`), [
    'current/scheme-1',
    'presets.Alt/scheme-9',
    'presets.Default/scheme-1',
  ]);
  // Presets drift from `current` silently; both must be checked independently.
  assert.equal(schemes[0].settings.background, '#fff');
  assert.equal(schemes[2].settings.background, '#000');
});

test('extractSchemes survives missing sections without inventing schemes', () => {
  assert.deepEqual(extractSchemes({}), []);
  assert.deepEqual(extractSchemes({ current: {} }), []);
  assert.deepEqual(extractSchemes(null), []);
});

test('extractSchemes emits a settings-less scheme rather than dropping it', () => {
  // Dropping it would let a scheme that lost its colours pass unexamined.
  const schemes = extractSchemes({ current: { color_schemes: { 'scheme-1': {} } } });
  assert.equal(schemes.length, 1);
  assert.deepEqual(schemes[0].settings, {});
});

test('the real settings_data.json parses and yields both sources', () => {
  const schemes = loadSchemes(PATHS.settingsData);
  assert.ok(schemes.length > 0, 'fail-closed floor: the lint is worthless on zero schemes');
  assert.ok(schemes.some((s) => s.source === 'current'));
  assert.ok(schemes.some((s) => s.source.startsWith('presets.')));
  for (const s of schemes) assert.ok(s.settings.background !== undefined, `${s.scheme} has no background`);
});

test('schemaRoleIds reads the color_scheme_group definition', () => {
  const ids = schemaRoleIds(PATHS.settingsSchema);
  assert.ok(ids.includes('background'));
  assert.ok(ids.includes('foreground'));
  assert.ok(ids.includes('shadow'));
  assert.ok(ids.length >= 35, `expected the full role set, got ${ids.length}`);
  assert.deepEqual(ids, [...ids].sort(), 'ids must be sorted for stable comparison');
  // Headers inside the definition are not colours and must not leak in.
  assert.ok(!ids.includes(undefined));
});
