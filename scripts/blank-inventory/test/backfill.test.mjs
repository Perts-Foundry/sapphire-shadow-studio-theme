import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBackfill, planBlankBootstrap, planSeed, untagVariants, BLANK_BOOTSTRAP_CAP } from '../lib/backfill.mjs';
import { learnVocab, buildGroups } from '../lib/groups.mjs';
import { batch } from '../lib/mutations.mjs';
import { variant, groupSlice, blankIdFor, resetSeq } from './fixtures.mjs';

test('planBackfill proposes a tag for every untagged variant with a precedent', () => {
  resetSeq(0);
  const variants = groupSlice({ taggedQty: [11, 11], untagged: 3 });
  const { vocab } = learnVocab(variants);
  const { tags, unresolvable } = planBackfill({ variants, vocab });
  assert.equal(tags.length, 3);
  assert.equal(unresolvable.length, 0);
  assert.equal(tags[0].blankId, blankIdFor('crewneck', 'Grey Heather', '2XL'));
});

test('planBackfill reports a variant with no precedent instead of inventing one', () => {
  const variants = [
    ...groupSlice({ color: 'Grey Heather', size: '2XL', taggedQty: [11], untagged: 0 }),
    variant({ body: 'crewneck', color: 'Black', size: 'XS', blankId: null, quantity: 0 }),
  ];
  const { vocab } = learnVocab(variants);
  const { tags, unresolvable } = planBackfill({ variants, vocab });
  assert.equal(tags.length, 0);
  assert.equal(unresolvable.length, 1);
  assert.match(unresolvable[0].reason, /no blank precedent for "crewneck \/ Black \/ XS"/);
});

test('a precedent on one body does NOT resolve the same colour+size on another', () => {
  // The oversell path: a vest would have been tagged with the crewneck's blank and drawn from its
  // stock. Under the old key this variant resolved cleanly and was silently proposed for tagging.
  const variants = [
    ...groupSlice({ body: 'crewneck', color: 'Black', size: 'M', taggedQty: [11], untagged: 0 }),
    variant({ body: 'vest-womens', color: 'Black', size: 'M', blankId: null, quantity: 0 }),
  ];
  const { vocab } = learnVocab(variants);
  const { tags, unresolvable } = planBackfill({ variants, vocab });
  assert.equal(tags.length, 0);
  assert.equal(unresolvable.length, 1);
  assert.match(unresolvable[0].reason, /no blank precedent for "vest-womens \/ Black \/ M"/);
});

test('planBackfill leaves untracked variants alone', () => {
  const variants = [
    ...groupSlice({ taggedQty: [11], untagged: 0 }),
    variant({ body: 'crewneck', blankId: null, tracked: false, quantity: 0 }),
  ];
  const { vocab } = learnVocab(variants);
  assert.equal(planBackfill({ variants, vocab }).tags.length, 0);
});

test('a variant missing colour or size is REPORTED, never silently dropped', () => {
  // It used to be skipped with a bare `continue`, so the proposal's counts did not add up to the
  // tracked population and nothing said why. Silence is indistinguishable from "no such variant".
  const variants = [
    ...groupSlice({ taggedQty: [11], untagged: 0 }),
    variant({ body: 'crewneck', color: null, size: 'M', blankId: null, quantity: 0 }),
    variant({ body: 'crewneck', color: 'Black', size: null, blankId: null, quantity: 0 }),
    variant({ body: null, color: 'Black', size: 'M', blankId: null, quantity: 0 }),
  ];
  const { vocab } = learnVocab(variants);
  const { tags, unresolvable } = planBackfill({ variants, vocab });
  assert.equal(tags.length, 0);
  assert.equal(unresolvable.length, 3);
  assert.match(unresolvable[0].reason, /cannot be keyed: no color/);
  assert.match(unresolvable[1].reason, /cannot be keyed: no size/);
  assert.match(unresolvable[2].reason, /cannot be keyed: no body/);
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

test('planBackfill honours a body filter', () => {
  const variants = [
    ...groupSlice({ body: 'crewneck', color: 'Black', size: 'M', taggedQty: [11], untagged: 2 }),
    ...groupSlice({ body: 'vest-womens', color: 'Black', size: 'M', taggedQty: [11], untagged: 2 }),
  ];
  const { vocab } = learnVocab(variants);
  const { tags } = planBackfill({ variants, vocab, filter: { body: 'vest-womens' } });
  assert.equal(tags.length, 2);
  assert.ok(tags.every((t) => t.body === 'vest-womens'));
});

// --- the new-blank bootstrap ------------------------------------------------

const NEW_ID = 'BLACK_CREWNECK_0001_M';
const untaggedM = (over = {}) =>
  variant({ body: 'crewneck', color: 'Black', size: 'M', productHandle: 'lead-ii-crewneck', blankId: null, quantity: 0, ...over });

test('the bootstrap mints a new id onto a scoped, untagged variant', () => {
  const boot = planBlankBootstrap({
    variants: [untaggedM()],
    blankId: NEW_ID,
    filter: { productHandle: 'lead-ii-crewneck', color: 'Black' },
  });
  assert.equal(boot.isNew, true);
  assert.equal(boot.tags.length, 1);
  assert.equal(boot.tags[0].blankId, NEW_ID);
});

test('the bootstrap refuses without a --product scope', () => {
  assert.throws(
    () => planBlankBootstrap({ variants: [untaggedM()], blankId: NEW_ID, filter: { color: 'Black' } }),
    /--blank requires --product/
  );
});

test('the bootstrap refuses an id whose trailing segment is not a real size', () => {
  // "0001" is a style number, not a size. Because the size is taken from a matching variant rather
  // than string-sliced off the id, a style-numbered id matches no variant and is refused.
  assert.throws(
    () => planBlankBootstrap({ variants: [untaggedM()], blankId: 'BLACK_CREWNECK_0001', filter: { productHandle: 'lead-ii-crewneck' } }),
    /does not end with the size of any matching variant/
  );
});

test('the bootstrap only tags variants of the id\'s own size', () => {
  // A crewneck at L is present, but the id ends in _M, so the L variant is never touched: every
  // tagged variant still ends up with an id ending in its own size.
  const variants = [untaggedM(), untaggedM({ size: 'L', id: 'gid://shopify/ProductVariant/L1' })];
  const boot = planBlankBootstrap({ variants, blankId: NEW_ID, filter: { productHandle: 'lead-ii-crewneck' } });
  assert.equal(boot.tags.length, 1);
  assert.equal(boot.tags[0].size, 'M');
});

test('the bootstrap refuses when --size contradicts the id suffix', () => {
  // --size L narrows to the L variant, but the id ends in _M, so no candidate ends with its size.
  const variants = [untaggedM(), untaggedM({ size: 'L', id: 'gid://shopify/ProductVariant/L1' })];
  assert.throws(
    () => planBlankBootstrap({ variants, blankId: NEW_ID, filter: { productHandle: 'lead-ii-crewneck', size: 'L' } }),
    /does not end with the size of any matching variant \(sizes present: L\)/
  );
});

test('the bootstrap caps blast radius and demands an explicit override', () => {
  // More matching variants than the cap: without the override this is refused, since a mint is
  // normally one variant and a large match means too broad a filter.
  const many = Array.from({ length: BLANK_BOOTSTRAP_CAP + 1 }, (_, i) =>
    untaggedM({ id: `gid://shopify/ProductVariant/${i}`, color: 'Black' })
  );
  assert.throws(
    () => planBlankBootstrap({ variants: many, blankId: NEW_ID, filter: { productHandle: 'lead-ii-crewneck' } }),
    /over the bootstrap cap/
  );
  const boot = planBlankBootstrap({ variants: many, blankId: NEW_ID, filter: { productHandle: 'lead-ii-crewneck' }, allowOverCap: true });
  assert.equal(boot.tags.length, BLANK_BOOTSTRAP_CAP + 1);
});

test('the bootstrap refuses to join a variant whose quantity differs from an existing family', () => {
  // The id already names a family at 11; the joining variant holds 5. Tagging then seeding would
  // silently overwrite the 5. Refused.
  const family = groupSlice({ body: 'crewneck', color: 'Black', size: 'M', taggedQty: [11, 11], untagged: 0 }).map((v) => ({
    ...v,
    blankId: NEW_ID,
  }));
  const joiner = untaggedM({ quantity: 5, id: 'gid://shopify/ProductVariant/join' });
  assert.throws(
    () =>
      planBlankBootstrap({
        variants: [...family, joiner],
        blankId: NEW_ID,
        filter: { productHandle: 'lead-ii-crewneck' },
        existingGroups: buildGroups([...family, joiner]),
      }),
    /hold 5 but family .* holds 11/
  );
});

test('the bootstrap refuses when selected variants disagree on quantity', () => {
  const variants = [untaggedM({ quantity: 0, id: 'a' }), untaggedM({ quantity: 3, id: 'b' })];
  assert.throws(
    () => planBlankBootstrap({ variants, blankId: NEW_ID, filter: { productHandle: 'lead-ii-crewneck' } }),
    /disagree on current quantity/
  );
});

test('the bootstrap refuses when nothing matches the filter', () => {
  assert.throws(
    () => planBlankBootstrap({ variants: [untaggedM({ blankId: 'already-tagged' })], blankId: NEW_ID, filter: { productHandle: 'lead-ii-crewneck' } }),
    /No untagged, tracked variant/
  );
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
