import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEffectivelyEmpty, breadcrumbCollectionFindings, breadcrumbBlankOkHandles } from '../admin.mjs';
import { parseCatalogue } from '../../lib/catalogue-manifest.mjs';
import { WARN } from '../lib/checks.mjs';

test('isEffectivelyEmpty treats editor artifacts as empty', () => {
  assert.equal(isEffectivelyEmpty(''), true);
  assert.equal(isEffectivelyEmpty(null), true);
  assert.equal(isEffectivelyEmpty('   '), true);
  assert.equal(isEffectivelyEmpty('<p></p>'), true);
  assert.equal(isEffectivelyEmpty('<p>&nbsp;</p>'), true);
  assert.equal(isEffectivelyEmpty('<p><br></p>\n'), true);
});

test('isEffectivelyEmpty keeps real copy', () => {
  assert.equal(isEffectivelyEmpty('<p>Real body copy.</p>'), false);
  assert.equal(isEffectivelyEmpty('plain text'), false);
});

const mf = (handle) => ({ value: `gid://shopify/Collection/${handle}`, reference: { handle } });

test('a resolved, non-catch-all breadcrumb metafield produces no finding', () => {
  assert.deepEqual(
    breadcrumbCollectionFindings([{ handle: 'lead-ii-crewneck', breadcrumbCollection: mf('healthcare') }]),
    [],
  );
});

test('every nil cause of an unset breadcrumb metafield reads the same', () => {
  // Unset, definition absent or not storefront-readable, and a deleted
  // reference all reach the theme as blank, so they reach this check as one
  // finding rather than three.
  const products = [
    { handle: 'a', breadcrumbCollection: null },
    { handle: 'b', breadcrumbCollection: { value: null, reference: null } },
    { handle: 'c', breadcrumbCollection: { value: 'gid://shopify/Collection/999', reference: null } },
  ];
  const f = breadcrumbCollectionFindings(products);
  assert.deepEqual(f.map((x) => x.check), Array(3).fill('product-breadcrumb-collection-missing'));
  assert.deepEqual(f.map((x) => x.url), ['admin:product/a', 'admin:product/b', 'admin:product/c']);
  assert.ok(f.every((x) => x.severity === WARN));
});

// A hand-authored manifest with TWO non-garment products, one whose handle and template suffix are
// different strings. The live census has exactly one non-garment shape, so without this the flatMap
// and the dedup are untested for any other, and the handle/template distinction is the whole reason
// the old literal never matched anything.
const MANIFEST = parseCatalogue(
  JSON.stringify({
    version: 2,
    options: { color: 'Color', size: 'Size', design: 'Design', denomination: 'Denominations' },
    colors: { black: { display: 'Black', slug: 'black' } },
    sizes: { s: { display: 'S' } },
    bodies: { crewneck: { colors: ['black'], sizes: ['s'] } },
    products: {
      'lead-ii-crewneck': { line: 'lead2', body: 'crewneck', template: 'lead-ii-crewneck', title: 'Lead II Crewneck', gid: 'gid://shopify/Product/1' },
      'sapphire-shadow-studio-gift-card': { line: null, body: null, template: 'gift-card', title: 'Gift Card', gid: 'gid://shopify/Product/2' },
      'studio-consultation': { line: null, body: null, template: 'studio-consultation', title: 'Studio Consultation', gid: 'gid://shopify/Product/3' },
    },
  })
);

test('the intentionally-blank set is every non-garment, under both its spellings', () => {
  assert.deepEqual([...breadcrumbBlankOkHandles(MANIFEST)].sort(), [
    'gift-card',
    'sapphire-shadow-studio-gift-card',
    'studio-consultation',
  ], 'both spellings for the product whose two differ, deduped for the one whose two agree');
  // A garment is never in it: every garment has a parent collection to name.
  assert.equal(breadcrumbBlankOkHandles(MANIFEST).has('lead-ii-crewneck'), false);
});

test('a documented intentionally-blank product produces no missing finding', () => {
  // docs/breadcrumb-collection-metafield.md says the gift card stays blank, so the missing WARN
  // must not fire for it; a catch-all value on it still would.
  for (const handle of ['gift-card', 'sapphire-shadow-studio-gift-card', 'studio-consultation']) {
    assert.deepEqual(
      breadcrumbCollectionFindings([{ handle, breadcrumbCollection: null }], { manifest: MANIFEST }),
      [],
      handle,
    );
  }
  assert.equal(
    breadcrumbCollectionFindings([{ handle: 'gift-card', breadcrumbCollection: mf('all') }], { manifest: MANIFEST })[0].check,
    'product-breadcrumb-collection-catchall',
  );
});

test('REGRESSION: the live gift-card HANDLE is skipped, which the old literal never managed', () => {
  // The set was ['gift-card'] and the Admin API returns the handle
  // sapphire-shadow-studio-gift-card, so this exact call used to produce a WARN on every run.
  assert.deepEqual(
    breadcrumbCollectionFindings([
      { handle: 'sapphire-shadow-studio-gift-card', breadcrumbCollection: null },
    ]),
    [],
    'against the COMMITTED manifest, not the fixture',
  );
});

test('a catch-all breadcrumb metafield is flagged separately, keyed per product', () => {
  const f = breadcrumbCollectionFindings([
    { handle: 'x', breadcrumbCollection: mf('all-products') },
    { handle: 'y', breadcrumbCollection: mf('frontpage') },
    { handle: 'z', breadcrumbCollection: mf('all') },
  ]);
  assert.deepEqual(f.map((x) => x.check), Array(3).fill('product-breadcrumb-collection-catchall'));
  assert.deepEqual(f.map((x) => x.url), ['admin:product/x', 'admin:product/y', 'admin:product/z']);
  assert.ok(f.every((x) => x.severity === WARN));
});
