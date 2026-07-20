import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectWriteTarget,
  compareIds,
  groupQuantity,
  planGroup,
  planAll,
  derivedIdempotencyKey,
  SKIP_ALREADY_CORRECT,
  SKIP_NO_CHANGE,
} from '../lib/planner.mjs';
import { MODE_ABSOLUTE, MODE_DELTA } from '../lib/input.mjs';
import { resolveBlank, learnVocab, buildGroups } from '../lib/groups.mjs';
import { variant, groupSlice, blankIdFor, resetSeq } from './fixtures.mjs';

const member = (id, quantity) =>
  variant({ body: 'crewneck', id: `gid://shopify/ProductVariant/${id}`, quantity, blankId: 'GREY_ACME_BLANKA_0001_2XL' });

test('selectWriteTarget never picks a member that already holds the target', () => {
  // The bug this exists to prevent: writing the target to a member already at it returns
  // inventoryAdjustmentGroup: null, fires no trigger, and strands the stale siblings forever.
  const members = [member(1, 12), member(2, 0), member(3, 12)];
  const chosen = selectWriteTarget(members, 12);
  assert.equal(chosen.id, 'gid://shopify/ProductVariant/2', 'must choose the mismatched member');
});

test('selectWriteTarget returns null when every member already matches', () => {
  assert.equal(selectWriteTarget([member(1, 12), member(2, 12)], 12), null);
});

test('selectWriteTarget breaks ties on the lowest variant id, deterministically', () => {
  const members = [member(9, 0), member(3, 0), member(7, 0), member(5, 12)];
  for (let i = 0; i < 5; i++) {
    assert.equal(selectWriteTarget(members, 12).id, 'gid://shopify/ProductVariant/3');
  }
});

test('selectWriteTarget tie-break stays deterministic when id digit-lengths differ', () => {
  // The contract is determinism, not numeric minimality: the comparison is lexicographic on the
  // full gid string, so '...41' sorts before '...410'. Pinned so a future refactor cannot quietly
  // change which variant a reproducible plan names.
  const members = [member(410, 0), member(41, 0), member(5, 12)];
  const chosen = selectWriteTarget(members, 12);
  assert.equal(chosen.id, 'gid://shopify/ProductVariant/41');
  for (let i = 0; i < 3; i++) assert.equal(selectWriteTarget(members, 12).id, chosen.id);
});

test('compareIds orders by code point, independently of locale', () => {
  // Plan and apply both derive the write target from this ordering, and apply REFUSES the row when
  // its answer differs from the artifact's. A locale-sensitive comparison could therefore turn a
  // healthy run into a "target moved" refusal purely because LANG differs between the two commands.
  // These pairs are ones a collation table is free to order differently from raw code points.
  assert.equal(compareIds('a', 'B'), 1); // code point: uppercase first. Most locales say otherwise.
  assert.equal(compareIds('a-b', 'a/b'), -1); // punctuation, commonly ignorable in collation
  assert.equal(compareIds('x', 'x'), 0);
  // Antisymmetric, so Array#sort cannot produce an unstable result.
  for (const [a, b] of [['a', 'B'], ['a-b', 'a/b'], ['41', '410']]) {
    assert.equal(compareIds(a, b), -compareIds(b, a));
  }
});

test('groupQuantity refuses an unconverged group rather than guessing which value is real', () => {
  assert.throws(() => groupQuantity([member(1, 11), member(2, 0)]), /not converged/);
});

test('absolute mode targets the stated count', () => {
  const p = planGroup({ blankId: 'B', members: [member(1, 11), member(2, 11)], value: 14, mode: MODE_ABSOLUTE, planId: 'p1' });
  assert.equal(p.target, 14);
  assert.equal(p.baseline, 11, 'CAS baseline is the chosen variant quantity at plan time');
  assert.equal(p.skipped, false);
});

test('delta mode targets current plus the change', () => {
  const p = planGroup({ blankId: 'B', members: [member(1, 11), member(2, 11)], value: 3, mode: MODE_DELTA, planId: 'p1' });
  assert.equal(p.target, 14);
  assert.equal(p.delta, 3);
});

test('a negative delta is fine while it stays above zero', () => {
  const p = planGroup({ blankId: 'B', members: [member(1, 11)], value: -11, mode: MODE_DELTA, planId: 'p1' });
  assert.equal(p.target, 0);
});

test('a delta that would drive stock negative is refused', () => {
  assert.throws(
    () => planGroup({ blankId: 'B', members: [member(1, 3)], value: -5, mode: MODE_DELTA, planId: 'p1' }),
    /Negative stock is refused/
  );
});

test('an absolute target of 0 is allowed (a group can legitimately sell out)', () => {
  const p = planGroup({ blankId: 'B', members: [member(1, 11)], value: 0, mode: MODE_ABSOLUTE, planId: 'p1' });
  assert.equal(p.skipped, false);
  assert.equal(p.target, 0);
});

test('a group already at the requested count is skipped, not written', () => {
  const p = planGroup({ blankId: 'B', members: [member(1, 12), member(2, 12)], value: 12, mode: MODE_ABSOLUTE, planId: 'p1' });
  assert.equal(p.skipped, true);
  assert.equal(p.reason, SKIP_ALREADY_CORRECT);
});

test('a zero delta is skipped', () => {
  const p = planGroup({ blankId: 'B', members: [member(1, 12)], value: 0, mode: MODE_DELTA, planId: 'p1' });
  assert.equal(p.skipped, true);
  assert.equal(p.reason, SKIP_NO_CHANGE);
});

test('a singleton group plans normally (one write, nothing to fan out to)', () => {
  const p = planGroup({ blankId: 'B', members: [member(1, 5)], value: 8, mode: MODE_ABSOLUTE, planId: 'p1' });
  assert.equal(p.siblingCount, 0);
  assert.equal(p.writeTargetId, 'gid://shopify/ProductVariant/1');
});

test('planGroup refuses an empty group', () => {
  assert.throws(() => planGroup({ blankId: 'B', members: [], value: 1, mode: MODE_ABSOLUTE, planId: 'p1' }), /no variants/);
});

// --- idempotency keys -------------------------------------------------------

test('the key is STABLE across retries of the same logical write', () => {
  // Not a safety property (live testing showed a same-key repeat is NOT deduplicated; CAS is what
  // catches a retry). This pins reproducibility: the same logical write always carries the same
  // identity in the artifact and in the request, so a plan can be re-derived and compared.
  const parts = { planId: 'plan-a', blankId: 'B', target: 12, mode: MODE_ABSOLUTE };
  assert.equal(derivedIdempotencyKey(parts), derivedIdempotencyKey({ ...parts }));
});

test('the key is DISTINCT across groups within one plan', () => {
  const a = derivedIdempotencyKey({ planId: 'plan-a', blankId: 'B1', target: 12, mode: MODE_ABSOLUTE });
  const b = derivedIdempotencyKey({ planId: 'plan-a', blankId: 'B2', target: 12, mode: MODE_ABSOLUTE });
  assert.notEqual(a, b, 'a collision could silently swallow a legitimate write if a dedup window did apply');
});

test('the key is DISTINCT for the same group across two plans', () => {
  const a = derivedIdempotencyKey({ planId: 'plan-a', blankId: 'B', target: 12, mode: MODE_ABSOLUTE });
  const b = derivedIdempotencyKey({ planId: 'plan-b', blankId: 'B', target: 12, mode: MODE_ABSOLUTE });
  assert.notEqual(a, b, 'a legitimate later re-run must not be deduped against an earlier one');
});

test('the key changes with the target and the mode', () => {
  const base = { planId: 'p', blankId: 'B', target: 12, mode: MODE_ABSOLUTE };
  assert.notEqual(derivedIdempotencyKey(base), derivedIdempotencyKey({ ...base, target: 13 }));
  assert.notEqual(derivedIdempotencyKey(base), derivedIdempotencyKey({ ...base, mode: MODE_DELTA }));
});

test('the key is UUID shaped, as the @idempotent directive expects', () => {
  const key = derivedIdempotencyKey({ planId: 'p', blankId: 'B', target: 1, mode: MODE_ABSOLUTE });
  assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

// --- planAll ----------------------------------------------------------------

test('planAll resolves body+color+size through the learned vocab and splits skips out', () => {
  resetSeq(0);
  const variants = [
    ...groupSlice({ body: 'crewneck', color: 'Grey Heather', size: '2XL', taggedQty: [11, 11], untagged: 0 }),
    ...groupSlice({ body: 'crewneck', color: 'Black', size: 'M', taggedQty: [5, 5], untagged: 0 }),
  ];
  const { vocab } = learnVocab(variants);
  const groups = buildGroups(variants);
  const rows = [
    { body: 'crewneck', color: 'Grey Heather', size: '2XL', value: 14, line: 1 },
    { body: 'crewneck', color: 'Black', size: 'M', value: 5, line: 2 },
  ];
  const { plans, skipped } = planAll({ rows, groups, vocab, mode: MODE_ABSOLUTE, planId: 'p1', resolveBlank });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].blankId, blankIdFor('crewneck', 'Grey Heather', '2XL'));
  assert.equal(skipped.length, 1, 'the Black group already holds 5');
  assert.equal(skipped[0].reason, SKIP_ALREADY_CORRECT);
});

test('two rows differing only by body plan as two separate writes', () => {
  // The count sheet's three tables. Under the old key these were one row with one destination, so
  // a three-garment sheet had exactly one pool to write to.
  const variants = [
    ...groupSlice({ body: 'crewneck', color: 'Black', size: 'M', taggedQty: [1, 1], untagged: 0 }),
    ...groupSlice({ body: 'vest-womens', color: 'Black', size: 'M', taggedQty: [1, 1], untagged: 0 }),
  ];
  const { vocab } = learnVocab(variants);
  const rows = [
    { body: 'crewneck', color: 'Black', size: 'M', value: 14, line: 1 },
    { body: 'vest-womens', color: 'Black', size: 'M', value: 9, line: 2 },
  ];
  const { plans } = planAll({ rows, groups: buildGroups(variants), vocab, mode: MODE_ABSOLUTE, planId: 'p1', resolveBlank });
  assert.equal(plans.length, 2);
  assert.deepEqual(
    plans.map((p) => p.blankId).sort(),
    [blankIdFor('crewneck', 'Black', 'M'), blankIdFor('vest-womens', 'Black', 'M')].sort()
  );
  assert.deepEqual(plans.map((p) => p.target).sort((a, b) => a - b), [9, 14]);
});

test('planAll refuses a blank with no tagged variants on the store', () => {
  const variants = groupSlice({ taggedQty: [11], untagged: 0 });
  const { vocab } = learnVocab(variants);
  const groups = buildGroups(variants);
  const rows = [{ blankId: 'SAMPLE_ACME_BLANKA_9999_M', value: 1, line: 7 }];
  assert.throws(
    () => planAll({ rows, groups, vocab, mode: MODE_ABSOLUTE, planId: 'p1', resolveBlank }),
    /Line 7: blank "SAMPLE_ACME_BLANKA_9999_M" has no tagged variants/
  );
});

test('planAll attributes a failure to its input line', () => {
  const variants = groupSlice({ taggedQty: [3], untagged: 0 });
  const { vocab } = learnVocab(variants);
  const groups = buildGroups(variants);
  const rows = [{ body: 'crewneck', color: 'Grey Heather', size: '2XL', value: -9, line: 4 }];
  assert.throws(
    () => planAll({ rows, groups, vocab, mode: MODE_DELTA, planId: 'p1', resolveBlank }),
    /Line 4: .*Negative stock is refused/s
  );
});

test('planAll refuses two rows that RESOLVE to the same blank', () => {
  // input.mjs already refuses a literal duplicate, but a body+colour+size row and a bare blank row
  // can resolve to one blank. Both would be computed against the same starting quantity and only
  // the first would be recorded in the receipt, so the second write would vanish from the record.
  const variants = groupSlice({ body: 'crewneck', color: 'Grey Heather', size: '2XL', taggedQty: [11, 11], untagged: 0 });
  const { vocab } = learnVocab(variants);
  const groups = buildGroups(variants);
  const blankId = blankIdFor('crewneck', 'Grey Heather', '2XL');
  const rows = [
    { body: 'crewneck', color: 'Grey Heather', size: '2XL', value: 14, line: 1 },
    { blankId, value: 9, line: 2 },
  ];
  assert.throws(
    () => planAll({ rows, groups, vocab, mode: MODE_ABSOLUTE, planId: 'p1', resolveBlank }),
    /Line 2: resolves to blank .* which line 1 already targets/
  );
});
