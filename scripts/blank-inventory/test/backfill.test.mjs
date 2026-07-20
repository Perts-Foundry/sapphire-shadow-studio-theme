import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBackfill, planSeed, untagVariants } from '../lib/backfill.mjs';
import { learnVocab } from '../lib/groups.mjs';
import { batch } from '../lib/mutations.mjs';
import { variant, groupSlice, blankIdFor, resetSeq } from './fixtures.mjs';

test('planBackfill proposes a tag for every untagged variant with a precedent', () => {
  resetSeq(0);
  const variants = groupSlice({ taggedQty: [11, 11], untagged: 3 });
  const { vocab } = learnVocab(variants);
  const { tags, unresolvable } = planBackfill({ variants, vocab });
  assert.equal(tags.length, 3);
  assert.equal(unresolvable.length, 0);
  assert.equal(tags[0].blankId, blankIdFor('Grey Heather', '2XL'));
});

test('planBackfill reports a variant with no precedent instead of inventing one', () => {
  const variants = [
    ...groupSlice({ color: 'Grey Heather', size: '2XL', taggedQty: [11], untagged: 0 }),
    variant({ color: 'Black', size: 'XS', blankId: null, quantity: 0 }),
  ];
  const { vocab } = learnVocab(variants);
  const { tags, unresolvable } = planBackfill({ variants, vocab });
  assert.equal(tags.length, 0);
  assert.equal(unresolvable.length, 1);
  assert.match(unresolvable[0].reason, /no blank precedent for "Black \/ XS"/);
});

test('planBackfill leaves untracked variants alone', () => {
  const variants = [
    ...groupSlice({ taggedQty: [11], untagged: 0 }),
    variant({ blankId: null, tracked: false, quantity: 0 }),
  ];
  const { vocab } = learnVocab(variants);
  assert.equal(planBackfill({ variants, vocab }).tags.length, 0);
});

test('planBackfill honours a colour and size filter', () => {
  const variants = [
    ...groupSlice({ color: 'Grey Heather', size: '2XL', taggedQty: [11], untagged: 2 }),
    ...groupSlice({ color: 'Black', size: 'M', taggedQty: [11], untagged: 2 }),
  ];
  const { vocab } = learnVocab(variants);
  const { tags } = planBackfill({ variants, vocab, filter: { color: 'Black' } });
  assert.equal(tags.length, 2);
  assert.ok(tags.every((t) => t.color === 'Black'));
});

// --- the seed write ---------------------------------------------------------

const m = (n, quantity) => ({
  id: `gid://shopify/ProductVariant/${n}`,
  quantity,
  blankId: 'B',
  productHandle: 'p',
  title: `v${n}`,
  inventoryItemId: `ii-${n}`,
});

test('planSeed targets the established quantity and writes to a NEWLY TAGGED variant', () => {
  // The established members already hold 11, so they are all "already correct". Writing to one of
  // them would be a no-op that fires no trigger and the new tags would stay at 0 forever.
  const members = [m(1, 11), m(2, 11), m(9, 0)];
  const seed = planSeed({ blankId: 'B', members, newlyTaggedIds: new Set([m(9, 0).id]), planId: 'p1' });
  assert.equal(seed.target, 11);
  assert.equal(seed.writeTargetId, 'gid://shopify/ProductVariant/9');
  assert.equal(seed.baseline, 0);
});

test('planSeed returns null when there is nothing left to seed', () => {
  const members = [m(1, 11), m(2, 11)];
  assert.equal(planSeed({ blankId: 'B', members, newlyTaggedIds: new Set(), planId: 'p1' }), null);
});

test('planSeed refuses a group whose established members disagree', () => {
  const members = [m(1, 11), m(2, 7), m(9, 0)];
  assert.throws(
    () => planSeed({ blankId: 'B', members, newlyTaggedIds: new Set([m(9, 0).id]), planId: 'p1' }),
    /not converged among its established members/
  );
});

test('planSeed refuses to invent a stock level for an all-new group', () => {
  const members = [m(9, 0), m(10, 0)];
  assert.throws(
    () => planSeed({ blankId: 'B', members, newlyTaggedIds: new Set([m(9, 0).id, m(10, 0).id]), planId: 'p1' }),
    /no established members/
  );
});

// --- the untag interlock ----------------------------------------------------

function untagHarness({ deletedErrors = [], afterRead, quantityResult = { ok: true, message: null } }) {
  const calls = [];
  return {
    calls,
    run: (variantIds, targetQuantity = 0) =>
      untagVariants({
        variantIds,
        targetQuantity,
        deleteTags: async (ids) => {
          calls.push({ op: 'delete', ids });
          return { deleted: ids.length, errors: deletedErrors };
        },
        readVariants: async (ids) => {
          calls.push({ op: 'read', ids });
          return afterRead(ids);
        },
        setQuantity: async (v, q) => {
          calls.push({ op: 'setQuantity', id: v.id, q });
          return quantityResult;
        },
      }),
  };
}

test('untag deletes the metafield BEFORE any quantity write', async () => {
  const h = untagHarness({ afterRead: (ids) => ids.map((id) => ({ id, blankId: null, quantity: 11 })) });
  await h.run(['gid://shopify/ProductVariant/1']);
  assert.deepEqual(h.calls.map((c) => c.op), ['delete', 'read', 'setQuantity']);
});

test('untag REFUSES every quantity write when a tag survived the delete', async () => {
  // Zeroing a still-tagged variant propagates 0 across the whole blank group and wipes real stock.
  const h = untagHarness({
    afterRead: (ids) => ids.map((id) => ({ id, blankId: 'B', quantity: 11 })),
  });
  await assert.rejects(() => h.run(['gid://shopify/ProductVariant/1']), /still carry the blank metafield/);
  assert.equal(h.calls.some((c) => c.op === 'setQuantity'), false, 'no quantity write may be attempted');
});

test('untag refuses to proceed when the delete itself reported errors', async () => {
  const h = untagHarness({
    deletedErrors: [{ message: 'nope' }],
    afterRead: (ids) => ids.map((id) => ({ id, blankId: null, quantity: 11 })),
  });
  await assert.rejects(() => h.run(['gid://shopify/ProductVariant/1']), /no quantity write will be attempted/);
  assert.equal(h.calls.some((c) => c.op === 'setQuantity'), false);
});

test('untag skips a variant already at the target quantity', async () => {
  const h = untagHarness({ afterRead: (ids) => ids.map((id) => ({ id, blankId: null, quantity: 0 })) });
  const res = await h.run(['gid://shopify/ProductVariant/1'], 0);
  assert.equal(res.zeroed, 0);
  assert.equal(h.calls.some((c) => c.op === 'setQuantity'), false);
});

test('untag reports per-variant quantity failures without throwing', async () => {
  const h = untagHarness({
    afterRead: (ids) => ids.map((id) => ({ id, blankId: null, quantity: 5 })),
    quantityResult: { ok: false, message: 'stale' },
  });
  const res = await h.run(['gid://shopify/ProductVariant/1']);
  assert.equal(res.failures.length, 1);
});

test('untag is a no-op on an empty list', async () => {
  const h = untagHarness({ afterRead: () => [] });
  const res = await h.run([]);
  assert.deepEqual(res, { untagged: 0, zeroed: 0, failures: [] });
  assert.equal(h.calls.length, 0);
});

// --- batching ---------------------------------------------------------------

test('metafield batching respects the 25 per call ceiling at every boundary', () => {
  const sizes = [0, 1, 25, 26, 51];
  const expected = [0, 1, 1, 2, 3];
  sizes.forEach((n, i) => {
    const chunks = batch(Array.from({ length: n }, (_, k) => k));
    assert.equal(chunks.length, expected[i], `${n} items should make ${expected[i]} batch(es)`);
    assert.ok(chunks.every((c) => c.length <= 25));
    assert.equal(chunks.flat().length, n, 'no item may be dropped');
  });
});

test('batch refuses a nonsensical size', () => {
  assert.throws(() => batch([1], 0), /at least 1/);
});
