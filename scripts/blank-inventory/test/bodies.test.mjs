// The garment body axis, after the authority reversal.
//
// WHAT THIS SUITE USED TO TEST, and no longer can: keyword inference, the proposal, the approval
// artifact and its content hash. All of it is deleted. catalogue.json declares each product's body,
// so there is nothing to infer and nothing to approve.
//
// The load-bearing property under test now is the one that survived the reversal unchanged: a
// product the manifest does not declare is NEVER guessed. `bodyOf` refuses, `attachBodies` yields
// `body: null` rather than a fallback, and `unmappedHandles` names it. That is what makes a newly
// added product loud instead of silently absorbed into whichever pool its colour and size match.
//
// Every manifest here is HAND-AUTHORED. Reading the committed one would make these assertions
// statements about today's catalogue rather than about the module's decisions, and they would
// rewrite themselves the next time a product ships.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyIndex, bodyOf, attachBodies, unmappedHandles } from '../lib/bodies.mjs';
import { parseCatalogue } from '../../lib/catalogue-manifest.mjs';

/**
 * A hand-authored manifest: two garment bodies, three garment products, one non-garment.
 * @param {object} [over] - replaces the `products` block wholesale when given
 */
function manifest(over = {}) {
  return parseCatalogue(
    JSON.stringify({
      version: 2,
      options: { color: 'Color', size: 'Size', design: 'Design', denomination: 'Denominations' },
      colors: { black: { display: 'Black', slug: 'black' } },
      sizes: { m: { display: 'M' } },
      bodies: {
        crewneck: { colors: ['black'], sizes: ['m'] },
        vest: { colors: ['black'], sizes: ['m'] },
      },
      products: {
        'a-crew': { line: 'a', body: 'crewneck', template: 'a-crew', title: 'A Crew', gid: 'gid://shopify/Product/1' },
        'b-crew': { line: 'b', body: 'crewneck', template: 'b-crew', title: 'B Crew', gid: 'gid://shopify/Product/2' },
        'b-vest': { line: 'b', body: 'vest', template: 'b-vest', title: 'B Vest', gid: 'gid://shopify/Product/3' },
        'gift-card': { line: null, body: null, template: 'gift-card', title: 'Gift Card', gid: 'gid://shopify/Product/4' },
      },
      ...over,
    })
  );
}

const variant = (productHandle, extra = {}) => ({ productHandle, tracked: true, ...extra });

// --- the index ---------------------------------------------------------------

test('bodyIndex maps every garment product to its declared body, in declaration order', () => {
  const index = bodyIndex(manifest());
  assert.deepEqual(
    [...index.entries()],
    [
      ['a-crew', 'crewneck'],
      ['b-crew', 'crewneck'],
      ['b-vest', 'vest'],
    ]
  );
});

test('a non-garment product is EXCLUDED from the index rather than given a body', () => {
  // The exclusion used to be inferred from "has no tracked variants". It is declared now: the gift
  // card carries "body": null, which is a decision an omitted key would not have been.
  const index = bodyIndex(manifest());
  assert.equal(index.has('gift-card'), false);
  assert.equal(index.size, 3);
});

// --- refusal, which is the whole point ---------------------------------------

test('bodyOf refuses an undeclared product rather than guessing from its handle', () => {
  // "shift-fuel-crewneck" contains the word "crewneck". The deleted inference layer would have
  // resolved it with high confidence; nothing here does, because the handle is not a declaration.
  const index = bodyIndex(manifest());
  assert.throws(
    () => bodyOf(index, { productHandle: 'shift-fuel-crewneck' }),
    /No declared body for product "shift-fuel-crewneck"/
  );
});

test("bodyOf's refusal points at catalogue.json and at a reviewed PR, not at a command", () => {
  const index = bodyIndex(manifest());
  assert.throws(() => bodyOf(index, { productHandle: 'nope' }), (err) => {
    assert.match(err.message, /catalogue\.json/);
    assert.match(err.message, /reviewed PR/);
    assert.doesNotMatch(err.message, /--stage/, 'the propose/approve workflow no longer exists');
    return true;
  });
});

test('bodyOf resolves a declared product', () => {
  assert.equal(bodyOf(bodyIndex(manifest()), { productHandle: 'b-vest' }), 'vest');
});

// --- attachBodies ------------------------------------------------------------

test('attachBodies gives an undeclared product body: null, never a fallback body', () => {
  const out = attachBodies(bodyIndex(manifest()), [variant('a-crew'), variant('unknown')]);
  assert.deepEqual(out.map((v) => v.body), ['crewneck', null]);
});

test('attachBodies returns copies and does not mutate its input', () => {
  const input = [variant('a-crew')];
  const out = attachBodies(bodyIndex(manifest()), input);
  assert.equal(input[0].body, undefined);
  assert.notEqual(out[0], input[0]);
});

test('attachBodies tolerates a null index, so a caller cannot crash before the refusal fires', () => {
  assert.deepEqual(attachBodies(null, [variant('a-crew')]).map((v) => v.body), [null]);
});

// --- unmappedHandles ---------------------------------------------------------

test('unmappedHandles names every undeclared product exactly once, sorted', () => {
  const out = unmappedHandles(bodyIndex(manifest()), [
    variant('zeta'),
    variant('alpha'),
    variant('zeta'),
    variant('a-crew'),
  ]);
  assert.deepEqual(out, ['alpha', 'zeta']);
});

test('unmappedHandles ignores untracked variants', () => {
  // Nothing untracked joins a blank group, so an untracked product with no declared body is not the
  // loud case this exists to surface.
  const out = unmappedHandles(bodyIndex(manifest()), [
    { productHandle: 'gift-card', tracked: false },
    variant('a-crew'),
  ]);
  assert.deepEqual(out, []);
});

// --- the reversal itself -----------------------------------------------------

test('bodies.mjs exports nothing from the deleted infer-then-approve workflow', async () => {
  // A stale export would let a caller keep inferring after the authority moved, which is the exact
  // two-authorities state the reversal exists to end.
  const mod = await import('../lib/bodies.mjs');
  assert.deepEqual(Object.keys(mod).sort(), ['attachBodies', 'bodyIndex', 'bodyOf', 'unmappedHandles']);
});
