// The product templates' "Shipping & Turnaround" accordion, and the rule that it defers to the
// shipping policy rather than restating a number.
//
// THIS TEST IS WHAT MAKES "removes six drift sites permanently" TRUE. Without it the claim is
// aspirational: six hand-maintained identical strings is the exact failure mode this repo has
// already documented for product cards (`_product-card` blocks, CLAUDE.md "Directory structure").
// Nothing else in CI compares copy across templates.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from '../check.mjs';
import { parseShopifyJson, walkBlocks } from '../../site-check/lib/repo-checks.mjs';

const TEMPLATES_DIR = join(REPO_ROOT, 'templates');
const POLICY_PATH = 'marketing/policies/shipping_policy.html';

/** The accordion row id every product template gives its "Shipping & Turnaround" section. */
const ROW_ID = 'accordion_row_st001';

/**
 * Product templates that are expected to carry no shipping accordion, each with its reason. A
 * product with no shipping section at all is conceivable (a digital product); making that an
 * explicit, reasoned entry is what keeps "cannot opt out" true.
 */
const NO_SHIPPING_ROW = new Map([
  // The gift card is delivered by email. Its accordion is headed "Delivery", not "Shipping &
  // Turnaround", and it carries a different block id; docs/theme-settings-contracts.md covers it.
  ['product.gift-card.json', 'delivered by email; it has its own Delivery accordion'],
]);

/**
 * Every product template, partitioned into those carrying the row and those exempted.
 *
 * ENUMERATE FIRST, then assert coverage. Discovering only the templates that happen to carry the
 * row is what let a new product opt out silently: a template without it was simply not discovered,
 * and a `rows.length >= 6` floor still passed.
 */
function partitionProductTemplates() {
  const withRow = [];
  const withoutRow = [];
  for (const name of readdirSync(TEMPLATES_DIR).sort()) {
    if (!/^product\.[^/]+\.json$/.test(name)) continue;
    const json = parseShopifyJson(readFileSync(join(TEMPLATES_DIR, name), 'utf8'));
    const block = [...walkBlocks(json)].find((b) => b.id === ROW_ID);
    if (block) withRow.push({ name, block, json });
    else withoutRow.push(name);
  }
  return { withRow, withoutRow };
}

/** The `text` of every child block under one accordion row, joined. */
function rowText(json, rowId) {
  const parts = [];
  for (const block of walkBlocks(json)) {
    if (!block.path.includes(`/${rowId}/`)) continue;
    if (typeof block.settings.text === 'string') parts.push(block.settings.text);
  }
  return parts.join('\n');
}

const { withRow: rows, withoutRow } = partitionProductTemplates();

test('EVERY product template carries the shipping accordion, or is exempted with a reason', () => {
  const unexplained = withoutRow.filter((name) => !NO_SHIPPING_ROW.has(name));
  assert.deepEqual(
    unexplained,
    [],
    `these product templates carry no "${ROW_ID}" block, so they state nothing about shipping and ` +
      'are invisible to every other test in this file. Add the accordion, or add the template to ' +
      `NO_SHIPPING_ROW with the reason.\n${unexplained.map((n) => `  ${n}`).join('\n')}`,
  );
  assert.ok(rows.length >= 6, `only ${rows.length} product templates carry ${ROW_ID}`);
});

test('the no-shipping-row exemption list still matches reality', () => {
  for (const [name, reason] of NO_SHIPPING_ROW) {
    assert.ok(
      withoutRow.includes(name) || !existsSync(join(TEMPLATES_DIR, name)),
      `${name} now carries ${ROW_ID}; drop it from NO_SHIPPING_ROW (${reason})`,
    );
  }
});

test('the accordion heading is unchanged across every template', () => {
  const headings = new Set(rows.map(({ block }) => block.settings.heading));
  assert.deepEqual([...headings], ['Shipping & Turnaround'], 'the accordion heading drifted between templates');
});

test('the accordion body is BYTE-IDENTICAL across every template', () => {
  const byText = new Map();
  for (const { name, json } of rows) {
    const text = rowText(json, ROW_ID);
    if (!byText.has(text)) byText.set(text, []);
    byText.get(text).push(name);
  }
  if (byText.size !== 1) {
    const groups = [...byText.entries()]
      .map(([text, names], i) => `  group ${i + 1} (${names.join(', ')}):\n    ${text.slice(0, 200)}`)
      .join('\n');
    assert.fail(
      `the "Shipping & Turnaround" copy differs between templates; it must be one string in all of them.\n${groups}\n` +
        `The source of truth for turnaround is ${POLICY_PATH}, and the accordion defers to it.`,
    );
  }
});

test('the accordion points at the shipping policy', () => {
  for (const { name, json } of rows) {
    assert.ok(rowText(json, ROW_ID).includes('/policies/shipping-policy'), `${name} no longer links to the shipping policy`);
  }
});

// ---------------------------------------------------------------------------------------------
// The rule that closes the drift site for good.
// ---------------------------------------------------------------------------------------------

/** `7-10 business days`, `3 to 5 business days`, `about 2 business days`, with any dash. */
const DURATION_RE = /\b\d{1,2}\s*(?:[-‐-―]|to)\s*\d{1,2}\s*(?:business\s+)?days?\b|\b\d{1,2}\s+business\s+days?\b/i;

/**
 * Every template file, exempting the ones that legitimately state a duration that is NOT a
 * production or transit turnaround. Each exemption is named with its reason, so adding one is a
 * decision a reviewer sees rather than a regex someone widened.
 */
const EXEMPT = new Map([
  // A response-time promise for the contact form and phone, not a turnaround. It states no
  // production or shipping figure.
  ['page.faq.json', 'response times for messages and calls, not a turnaround'],
  // The custom-orders track is separate and deliberately quotes its own quote-turnaround and its
  // own 2 to 3 week production window; the plan for the 3-5 day change left it untouched.
  ['page.custom-orders.json', 'the separate custom-orders track, with its own quoted timeline'],
]);

test('no product template states a business-day duration; the policy is the source of truth', () => {
  const offenders = [];
  for (const name of readdirSync(TEMPLATES_DIR).sort()) {
    if (!name.endsWith('.json')) continue;
    if (EXEMPT.has(name)) continue;
    const text = readFileSync(join(TEMPLATES_DIR, name), 'utf8');
    const match = DURATION_RE.exec(text);
    if (match) offenders.push(`${name}: ${JSON.stringify(match[0])}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `a template states a turnaround. The single source of truth is ${POLICY_PATH}; templates must ` +
      'link to /policies/shipping-policy instead of restating a number, because six copies of the ' +
      'same figure is what this change removed.\n' +
      offenders.map((o) => `  ${o}`).join('\n'),
  );
});

test('the exemption list still matches reality, so a stale exemption cannot hide a regression', () => {
  for (const [name, reason] of EXEMPT) {
    const path = join(TEMPLATES_DIR, name);
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      assert.fail(`${name} is exempted from the duration rule but no longer exists; drop the exemption (${reason})`);
    }
    assert.ok(
      DURATION_RE.test(text),
      `${name} is exempted from the duration rule but states no duration any more; drop the exemption (${reason})`,
    );
  }
});
