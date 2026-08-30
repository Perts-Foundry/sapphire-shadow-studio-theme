import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadProfile, materialiseProfile } from '../lib/profile-io.mjs';
import { parseCatalogue } from '../../lib/catalogue-manifest.mjs';
import { resolvedProfile } from './profile-fixture.mjs';

// The LOGIC tests below run against a hand-authored manifest. They state what materialisation does,
// which is a different claim from "today's catalogue happens to say this", and they keep meaning the
// same thing after a product ships. The two MATCHES PRODUCTION tests at the end are labelled.

const MANIFEST = parseCatalogue(
  JSON.stringify({
    version: 2,
    options: { color: 'Color', size: 'Size', design: 'Design', denomination: 'Denominations' },
    colors: { black: { display: 'Black', slug: 'black' } },
    sizes: { s: { display: 'S' }, m: { display: 'M' }, l: { display: 'L' } },
    bodies: {
      crewneck: { colors: ['black'], sizes: ['s', 'm', 'l'] },
      scarf: { colors: ['black'], sizes: ['s'] },
    },
    products: {
      'huddle-crewneck': { line: 'huddle', body: 'crewneck', template: 'huddle-crewneck', title: 'Huddle Crewneck', gid: 'gid://shopify/Product/1' },
      // Its template suffix and its handle are deliberately DIFFERENT strings: `handles` derives
      // from the template, and this is the case that tells the two apart.
      'lead-ii-crewneck': { line: 'lead2', body: 'crewneck', template: 'lead-two-crew', title: 'Lead II Crewneck', gid: 'gid://shopify/Product/2' },
      'lead-ii-scarf': { line: 'lead2', body: 'scarf', template: 'lead-ii-scarf', title: 'Lead II Scarf', gid: 'gid://shopify/Product/3' },
    },
  })
);

const RAW = { blank_id: 'crewneck-fleece', body: 'crewneck', garment: 'crewneck' };

test('materialiseProfile fills sizes from the body and handles from each product TEMPLATE', () => {
  const out = materialiseProfile(RAW, MANIFEST);
  assert.deepEqual(out.sizes, ['S', 'M', 'L']);
  assert.deepEqual(out.handles, ['huddle-crewneck', 'lead-two-crew'], 'template suffixes, not handles');
  // Nothing else about the profile is touched.
  assert.equal(out.blank_id, 'crewneck-fleece');
  assert.equal(out.garment, 'crewneck');
});

test('a profile still carrying its own sizes or handles is REFUSED, not quietly overwritten', () => {
  // Silently overwriting would leave a stale literal in the file that nobody reads and nobody
  // corrects, which is exactly the failure this migration removes.
  assert.throws(() => materialiseProfile({ ...RAW, sizes: ['XS'] }, MANIFEST), /carries "sizes", which is derived/);
  assert.throws(() => materialiseProfile({ ...RAW, handles: ['x'] }, MANIFEST), /carries "handles", which is derived/);
});

test('an undeclared or missing body is refused, naming the bodies that exist', () => {
  assert.throws(() => materialiseProfile({ ...RAW, body: 'hoodie' }, MANIFEST), /which catalogue\.json does not/);
  assert.throws(() => materialiseProfile({ ...RAW, body: 'hoodie' }, MANIFEST), /crewneck, scarf/);
  const { body, ...noBody } = RAW;
  assert.throws(() => materialiseProfile(noBody, MANIFEST), /declares body null/);
});

test('a body every product has left is refused rather than materialising an empty chart', () => {
  const orphaned = parseCatalogue(
    JSON.stringify({
      version: 2,
      options: { color: 'Color', size: 'Size', design: 'Design', denomination: 'Denominations' },
      colors: { black: { display: 'Black', slug: 'black' } },
      sizes: { s: { display: 'S' } },
      bodies: { crewneck: { colors: ['black'], sizes: ['s'] } },
      products: {
        'huddle-crewneck': { line: 'huddle', body: 'crewneck', template: 'huddle-crewneck', title: 'Huddle Crewneck', gid: 'gid://shopify/Product/1' },
      },
    })
  );
  // `crewneck` is the only body this manifest declares, so ask for one it does not.
  assert.throws(() => materialiseProfile({ ...RAW, body: 'scarf' }, orphaned), /does not/);
});

test('MATCHES PRODUCTION: loadProfile resolves a blank_id and returns the materialised profile', async () => {
  assert.deepEqual(await loadProfile('crewneck-fleece'), resolvedProfile('crewneck-fleece'));
});

test('MATCHES PRODUCTION: every committed profile materialises against the committed manifest', async () => {
  for (const id of ['crewneck-fleece', 'quarter-zip-midweight', 'vest-microfleece-womens']) {
    const profile = await loadProfile(id);
    assert.ok(profile.sizes.length, `${id} has a size range`);
    assert.ok(profile.handles.length, `${id} applies to at least one template`);
  }
});

test('loadProfile wraps a missing/unreadable profile in a clear error', async () => {
  await assert.rejects(loadProfile('./does-not-exist.json'), /Cannot read profile/);
});
