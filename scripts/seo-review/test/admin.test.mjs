import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isEffectivelyEmpty, breadcrumbCollectionFindings, breadcrumbBlankOkHandles,
  breadcrumbPreferredHandleFindings,
} from '../admin.mjs';
import { parseCatalogue } from '../../lib/catalogue-manifest.mjs';
import { WARN, ERROR, BREADCRUMB_PREFERRED_HANDLES } from '../lib/checks.mjs';

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

// The regression this pair exists for: `healthcare` sat in the preferred list while the store's
// collection was `healthcare-collection`. The snippet skips an unresolvable handle without error,
// so Healthcare Collection could never win step 3 and nothing reported it.
test('a preferred handle naming no collection is an ERROR', () => {
  const f = breadcrumbPreferredHandleFindings([
    { handle: 'the-vitals-collection' }, { handle: 'featured' },
  ]);
  assert.equal(f.length, 1);
  assert.equal(f[0].check, 'breadcrumb-preferred-handle-missing');
  assert.equal(f[0].severity, ERROR);
  assert.match(f[0].detail, /healthcare-collection/);
});

test('preferred handles that all resolve produce no finding', () => {
  const collections = BREADCRUMB_PREFERRED_HANDLES.map((handle) => ({ handle }));
  assert.deepEqual(breadcrumbPreferredHandleFindings([...collections, { handle: 'extra' }]), []);
});

// checks.mjs only quotes the list in a finding detail; snippets/breadcrumbs.liquid is what actually
// scans it. Their comments say "change them together", which nothing enforced. This does.
test('the preferred-handle list matches the one the snippet scans', async () => {
  const { readFile } = await import('node:fs/promises');
  const url = new URL('../../../snippets/breadcrumbs.liquid', import.meta.url);
  const liquid = await readFile(url, 'utf8');
  const m = liquid.match(/assign preferred_handles = '([^']+)' \| split: ','/);
  assert.ok(m, 'could not find preferred_handles in snippets/breadcrumbs.liquid');
  assert.deepEqual(m[1].split(','), BREADCRUMB_PREFERRED_HANDLES);
});

// A hand-authored manifest with TWO non-garment products, one whose handle and template suffix are
// different strings. The set is compared against Admin HANDLES only, so the template suffix must
// stay out of it; the handle/template distinction is the whole reason the old literal never matched
// anything.
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

test('the intentionally-blank set is every non-garment HANDLE, and never a template suffix', () => {
  assert.deepEqual([...breadcrumbBlankOkHandles(MANIFEST)].sort(), [
    'sapphire-shadow-studio-gift-card',
    'studio-consultation',
  ]);
  // The set is only ever tested against Admin handles, so the template suffix would be a dead
  // entry that could only ever mask a future product whose HANDLE happened to equal it.
  assert.equal(breadcrumbBlankOkHandles(MANIFEST).has('gift-card'), false);
  // A garment is never in it: every garment has a parent collection to name.
  assert.equal(breadcrumbBlankOkHandles(MANIFEST).has('lead-ii-crewneck'), false);
});

test('a documented intentionally-blank product produces no missing finding', () => {
  // docs/breadcrumb-collection-metafield.md says the gift card stays blank, so the missing WARN
  // must not fire for it; a catch-all value on it still would.
  for (const handle of ['sapphire-shadow-studio-gift-card', 'studio-consultation']) {
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
