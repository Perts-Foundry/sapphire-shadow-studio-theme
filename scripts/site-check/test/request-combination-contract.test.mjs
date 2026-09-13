// The request-combination availability status spans three files that cannot see each other:
//
//   1. blocks/request-combination.liquid                     emits data-option-value-id per <option>,
//                                                             data-product-url and data-status-checking
//   2. sections/section-rendering-request-combination.liquid  renders the verdict marker and tokens
//   3. assets/request-combination.js                         fetches that section by id and reads them
//
// Drift in any name fails silently: #parseVerdict returns null and the dialog quietly posts
// "Not verified" with an empty status line, with nothing in the console. theme-check cannot see
// across the files, so this suite is the shared source of truth and hardcodes every literal
// rather than importing it (the ruling in scripts/size-chart/test/anchor-contract.test.mjs).
//
// It also guards the reason the section exists: Liquid's product.variants returns at most 250
// entries, so the block must never rebuild an availability map by looping it.
//
// Assertions read markup, never prose: Liquid {% comment %} and {% doc %} blocks are stripped
// first, because both Liquid files describe their own markup in comments.
//
// Scope note: a theme-layer contract under scripts/site-check/, because site-check owns
// b-product-request-combination and its suite is the nearest test runner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const stripLiquidProse = (src) =>
  src
    .replace(/{%-?\s*comment\s*-?%}[\s\S]*?{%-?\s*endcomment\s*-?%}/g, '')
    .replace(/{%-?\s*doc\s*-?%}[\s\S]*?{%-?\s*enddoc\s*-?%}/g, '');

const SECTION_ID = 'section-rendering-request-combination';
const TOKENS = ['available', 'sold-out', 'not-offered'];

const block = stripLiquidProse(read('blocks/request-combination.liquid'));
const section = stripLiquidProse(read(`sections/${SECTION_ID}.liquid`));
const js = read('assets/request-combination.js');

test('the block never loops product.variants or embeds a variant map', () => {
  assert.doesNotMatch(block, /\bfor\s+\w+\s+in\s+product\.variants\b/);
  assert.doesNotMatch(block, /ref="variantData"/);
});

test('the block emits the attributes the script reads', () => {
  const optionsLoop = block.match(/for\s+product_option\s+in\s+product\.options_with_values[\s\S]*?endfor/);
  assert.ok(optionsLoop, 'option selects loop over product.options_with_values');
  assert.match(optionsLoop[0], /data-option-value-id="{{\s*product_option_value\.id\s*}}"/);
  assert.match(block, /data-product-url="{{\s*product\.url\s*}}"/);
  assert.match(block, /data-status-checking="{{\s*'blocks\.request_combination\.status_checking'\s*\|\s*t\s*}}"/);
});

test('the stub section renders the marker, the resolved ids and exactly the three tokens', () => {
  assert.match(section, /<div\s[^>]*data-request-combination-section[\s>]/);
  assert.match(section, /data-request-combination-availability="{{\s*token\s*}}"/);
  assert.match(section, /data-resolved-option-value-ids="{{\s*resolved_ids\s*}}"/);
  const assigned = [...section.matchAll(/assign\s+token\s*=\s*'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(assigned, [...TOKENS].sort());
});

test('the script targets the stub section and reads its attributes', () => {
  assert.match(js, new RegExp(`const STATUS_SECTION_ID = '${SECTION_ID}';`));
  assert.match(js, /querySelector\('\[data-request-combination-section\]'\)/);
  for (const key of ['requestCombinationAvailability', 'resolvedOptionValueIds', 'optionValueId', 'productUrl', 'statusChecking']) {
    assert.ok(js.includes(key), `script reads dataset.${key}`);
  }
  const set = js.match(/const VERDICT_TOKENS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(set, 'VERDICT_TOKENS is declared');
  const scriptTokens = [...set[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(scriptTokens, [...TOKENS].sort());
});

test('the checking string exists in every maintained storefront locale', () => {
  for (const locale of ['en.default', 'it', 'ro']) {
    assert.match(read(`locales/${locale}.json`), /"status_checking":\s*"[^"]+"/, `locales/${locale}.json`);
  }
});
