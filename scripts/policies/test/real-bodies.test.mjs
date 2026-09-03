// The committed bodies under marketing/policies/, read IN PLACE.
//
// These assert PROPERTIES, never pinned content, and never a literal digest: the file's sha must
// equal the manifest's sha, which is a consistency claim that survives every wording edit. A copy
// of a 23 KB body under test/fixtures/ would rot silently and turn every wording edit red, so
// there is none.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, check, paths, readManifest } from '../check.mjs';
import { effectiveSettings, parseShopifyJson } from '../../site-check/lib/repo-checks.mjs';
import {
  POLICY_TYPES,
  WRITABLE,
  bodyFromFileText,
  duplicateHeadingIds,
  extractHeadings,
  hygieneProblems,
  keyForType,
  sha256,
} from '../lib/policies.mjs';

const manifest = readManifest(REPO_ROOT);
const p = paths(REPO_ROOT);
const bodies = new Map(POLICY_TYPES.map((type) => [type, bodyFromFileText(readFileSync(p.file(type), 'utf8'))]));

test('the committed tree passes its own check', () => {
  const { problems, mismatches } = check(REPO_ROOT);
  assert.deepEqual(problems, []);
  assert.deepEqual(mismatches, []);
});

test('each file agrees with its manifest entry, by consistency and not by a pinned digest', () => {
  for (const type of POLICY_TYPES) {
    const entry = manifest.policies[keyForType(type)];
    const body = bodies.get(type);
    assert.equal(sha256(body), entry.sha256, `${type} sha`);
    assert.equal(body.length, entry.length, `${type} length`);
  }
});

test('every writable body passes hygiene', () => {
  for (const type of POLICY_TYPES.filter((t) => WRITABLE[t])) {
    assert.deepEqual(hygieneProblems(bodies.get(type)), [], type);
  }
});

test('no policy has two h2 headings that slugify alike', () => {
  for (const type of POLICY_TYPES) {
    assert.deepEqual(duplicateHeadingIds(extractHeadings(bodies.get(type))), [], type);
  }
});

test('the shipping policy keeps enough h2 headings for the jump nav to render', () => {
  // assets/policy-nav.js hides the nav below MIN_HEADINGS = 3, and the post-deploy smoke asserts
  // the `policy-nav-component` custom element is present on the page.
  const h2s = extractHeadings(bodies.get('SHIPPING_POLICY')).filter((h) => h.level === 2);
  assert.ok(h2s.length >= 3, `only ${h2s.length} h2 headings`);
});

test('the anchors the storefront deep-links to still exist', () => {
  // These are the ids other copy in this repo points at. A reworded heading changes its runtime id
  // and nothing else would notice.
  const ids = new Set(extractHeadings(bodies.get('SHIPPING_POLICY')).map((h) => h.id));
  for (const id of ['production-delivery-times', 'custom-personalized-orders', 'rush-orders', 'multiple-item-orders']) {
    assert.ok(ids.has(id), `#${id} is gone from the shipping policy`);
  }
});

// ---------------------------------------------------------------------------------------------
// The shipping policy's totals table, the one place where a wording edit can produce arithmetic
// that contradicts itself.
// ---------------------------------------------------------------------------------------------

const RANGE = /(\d+)\s*[-–]\s*(\d+)\s*business days/;
const SINGLE = /(\d+)\s*business days/;

/** `3–5 business days` or `2 business days` as `[low, high]`. */
export function parseWindow(text) {
  const range = RANGE.exec(text);
  if (range) return [Number(range[1]), Number(range[2])];
  const single = SINGLE.exec(text);
  if (single) return [Number(single[1]), Number(single[1])];
  return null;
}

/** The rows of the first table in the body, as arrays of cell text. */
export function tableRows(html) {
  const table = /<table[\s\S]*?<\/table>/i.exec(html);
  if (!table) return [];
  const body = /<tbody[\s\S]*?<\/tbody>/i.exec(table[0]);
  const rows = [];
  const re = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = re.exec((body ?? table)[0])) !== null) {
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1].replace(/<[^>]*>/g, '').trim());
    if (cells.length) rows.push(cells);
  }
  return rows;
}

test('the totals table adds up: production + transit = total, on every row', () => {
  const rows = tableRows(bodies.get('SHIPPING_POLICY'));
  assert.ok(rows.length >= 2, 'expected at least two shipping-method rows');
  for (const [method, production, transit, total] of rows) {
    const [pLow, pHigh] = parseWindow(production) ?? [];
    const [tLow, tHigh] = parseWindow(transit) ?? [];
    const [totalLow, totalHigh] = parseWindow(total) ?? [];
    assert.ok(pLow !== undefined && tLow !== undefined && totalLow !== undefined, `${method}: unparseable row`);
    assert.equal(totalLow, pLow + tLow, `${method}: total low should be ${pLow + tLow}`);
    assert.equal(totalHigh, pHigh + tHigh, `${method}: total high should be ${pHigh + tHigh}`);
  }
});

test("the table's production window matches the prose figure in the same section", () => {
  const body = bodies.get('SHIPPING_POLICY');
  const prose = /<strong>Production Time:<\/strong>([\s\S]*?)<\/p>/i.exec(body);
  assert.ok(prose, 'the Production Time paragraph is gone');
  const proseWindow = parseWindow(prose[1]);
  assert.ok(proseWindow, 'the Production Time paragraph states no business-day figure');
  for (const [method, production] of tableRows(body)) {
    assert.deepEqual(parseWindow(production), proseWindow, `${method}: the table disagrees with the prose`);
  }
});

test('the shipping policy states no dollar amount other than the flat rate and the threshold', () => {
  // Mirrors site-check's template-shipping-amounts rule, which does not reach the policy body.
  // Reuses site-check's own readers rather than a second parser: settings_data.json carries a
  // Shopify comment banner that JSON.parse chokes on, and `current` may name a preset instead of
  // holding the values.
  const settings = effectiveSettings(
    parseShopifyJson(readFileSync(join(REPO_ROOT, 'config', 'settings_schema.json'), 'utf8')),
    parseShopifyJson(readFileSync(join(REPO_ROOT, 'config', 'settings_data.json'), 'utf8')),
  );
  const allowed = new Set(
    ['flat_rate_shipping', 'free_shipping_threshold'].map((id) => Number(settings[id])),
  );
  assert.equal(allowed.size, 2, 'could not read flat_rate_shipping and free_shipping_threshold');
  assert.ok([...allowed].every(Number.isFinite), 'the shipping settings are not numbers');
  const amounts = [...bodies.get('SHIPPING_POLICY').matchAll(/\$\s?([0-9]+(?:\.[0-9]{2})?)/g)].map((m) => Number(m[1]));
  for (const amount of amounts) {
    assert.ok(allowed.has(amount), `the shipping policy states $${amount}, which is neither the flat rate nor the threshold`);
  }
});
