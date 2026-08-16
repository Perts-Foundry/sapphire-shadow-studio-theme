// settings.mjs -- read colour schemes out of config/settings_data.json.
//
// Two things make this less trivial than JSON.parse:
//
// 1. The file opens with a `/* ... */` banner that Shopify writes and rewrites.
//    It is not valid JSON, so it has to come off before parsing. Only a LEADING
//    block comment is stripped; nothing else in the file is treated as a
//    comment, so a `/*` inside a string value cannot corrupt the parse.
//
// 2. Schemes live in TWO places: `current.color_schemes` (what the live theme
//    renders) and `presets.<name>.color_schemes` (what a fresh install of the
//    theme starts from). The theme editor only ever writes `current`, so the
//    presets drift silently and a merchant resetting to the preset would land
//    on colours nothing has ever checked. Both are scanned, tagged by source.

import { readFileSync } from 'node:fs';

/**
 * @typedef {{source: string, scheme: string, settings: Record<string, string>}} Scheme
 */

/**
 * Strip a leading JSONC block comment and parse the rest as JSON. A leading
 * byte-order mark is tolerated ahead of it.
 * @param {string} text raw file contents
 * @returns {object} the parsed settings object
 * @example
 *   parseSettingsData(bannerComment + '\n{"current":{}}') // { current: {} }
 */
export function parseSettingsData(text) {
  const stripped = String(text).replace(/^﻿?\s*\/\*[\s\S]*?\*\//, '');
  return JSON.parse(stripped);
}

/**
 * Every colour scheme in the parsed settings object, from `current` and from
 * every preset, in a stable order.
 * @param {object} data parsed settings_data.json
 * @returns {Scheme[]}
 * @example
 *   extractSchemes({ current: { color_schemes: { 'scheme-1': { settings: {} } } } })
 *   // [{ source: 'current', scheme: 'scheme-1', settings: {} }]
 */
export function extractSchemes(data) {
  const out = [];
  const push = (source, group) => {
    for (const name of Object.keys(group || {}).sort()) {
      const settings = group[name]?.settings;
      // A scheme entry with no settings object is malformed, not empty: emit it
      // with `{}` so the pairing completeness check reports a scheme that has
      // lost its colours rather than skipping it silently.
      out.push({ source, scheme: name, settings: settings || {} });
    }
  };

  push('current', data?.current?.color_schemes);
  for (const preset of Object.keys(data?.presets || {}).sort()) {
    push(`presets.${preset}`, data.presets[preset]?.color_schemes);
  }
  return out;
}

/**
 * Read and extract in one call.
 * @param {string} path path to config/settings_data.json
 * @returns {Scheme[]}
 * @example
 *   loadSchemes('config/settings_data.json')
 */
export function loadSchemes(path) {
  return extractSchemes(parseSettingsData(readFileSync(path, 'utf8')));
}

/**
 * The colour role ids declared by the `color_scheme_group` setting in
 * config/settings_schema.json. This is the authoritative list of roles the
 * theme editor can write, and pairs.mjs asserts its map covers exactly these,
 * so a Horizon upstream merge that adds a role fails the lint instead of
 * quietly leaving the new colour unchecked.
 * @param {string} path path to config/settings_schema.json
 * @returns {string[]} sorted role ids
 * @example
 *   schemaRoleIds('config/settings_schema.json') // ['background', 'border', ...]
 */
export function schemaRoleIds(path) {
  const schema = JSON.parse(readFileSync(path, 'utf8'));
  const ids = new Set();
  for (const group of Array.isArray(schema) ? schema : []) {
    for (const setting of group?.settings || []) {
      if (setting?.type !== 'color_scheme_group') continue;
      for (const def of setting.definition || []) {
        if (def?.type === 'color' && def.id) ids.add(def.id);
      }
    }
  }
  return [...ids].sort();
}
