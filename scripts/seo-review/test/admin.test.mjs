import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEffectivelyEmpty, breadcrumbCollectionFindings } from '../admin.mjs';
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

test('a documented intentionally-blank product produces no missing finding', () => {
  // docs/breadcrumb-collection-metafield.md says gift-card stays blank, so the
  // missing WARN must not fire for it; a catch-all value on it still would.
  assert.deepEqual(
    breadcrumbCollectionFindings([{ handle: 'gift-card', breadcrumbCollection: null }]),
    [],
  );
  assert.equal(
    breadcrumbCollectionFindings([{ handle: 'gift-card', breadcrumbCollection: mf('all') }])[0].check,
    'product-breadcrumb-collection-catchall',
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
