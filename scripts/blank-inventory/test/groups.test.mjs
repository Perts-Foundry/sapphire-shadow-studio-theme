import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  learnVocab,
  resolveBlank,
  conventionWarnings,
  buildGroups,
  classifyGroup,
  classifyGroups,
  blankPrefix,
  multiLevelVariants,
  AWAITING_SEED,
  CONVERGED,
  DRIFT,
} from '../lib/groups.mjs';
import { variant, groupSlice, blankIdFor, resetSeq } from './fixtures.mjs';

test('learnVocab maps Color+Size to the blank id used by tagged variants', () => {
  const vs = groupSlice();
  const { vocab, conflicts } = learnVocab(vs);
  assert.equal(conflicts.length, 0);
  assert.equal(vocab.get('Grey Heather|2XL'), blankIdFor('Grey Heather', '2XL'));
});

test('learnVocab records a conflict and refuses rather than picking a winner', () => {
  const vs = [
    variant({ color: 'Black', size: 'M', blankId: 'BLACK_ACME_FLEECE_0001_M' }),
    variant({ color: 'Black', size: 'M', blankId: 'BLACK_ACME_FLEECE_0002_M' }),
  ];
  const { vocab, conflicts } = learnVocab(vs);
  assert.equal(vocab.has('Black|M'), false, 'a conflicted key must not enter the vocab');
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].values, ['BLACK_ACME_FLEECE_0001_M', 'BLACK_ACME_FLEECE_0002_M']);
});

test('resolveBlank refuses a Color+Size with no precedent instead of inventing one', () => {
  const { vocab } = learnVocab(groupSlice());
  assert.throws(() => resolveBlank(vocab, 'Black', 'XS'), /No blank precedent/);
});

test('untagged variants contribute nothing to the vocab', () => {
  const { vocab } = learnVocab([variant({ blankId: null }), variant({ blankId: null })]);
  assert.equal(vocab.size, 0);
});

test('blankPrefix strips the size suffix and returns null on a mismatch', () => {
  assert.equal(blankPrefix('GREY_ACME_FLEECE_0001_2XL', '2XL'), 'GREY_ACME_FLEECE_0001');
  assert.equal(blankPrefix('GREY_ACME_FLEECE_0001_2XL', 'XL'), null);
});

test('conventionWarnings flags a blank id that does not end with its own size', () => {
  // The classic paste error: an M value landed on the L variant.
  const vs = [variant({ color: 'Black', size: 'L', blankId: 'BLACK_ACME_FLEECE_0001_M' })];
  const warnings = conventionWarnings(vs);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'size-suffix');
});

test('conventionWarnings flags a minority colour prefix as a likely typo', () => {
  const vs = [
    variant({ color: 'Black', size: 'M', blankId: 'BLACK_ACME_FLEECE_0001_M' }),
    variant({ color: 'Black', size: 'M', blankId: 'BLACK_ACME_FLEECE_0001_M' }),
    variant({ color: 'Black', size: 'M', blankId: 'BLCAK_ACME_FLEECE_0001_M' }),
  ];
  const warnings = conventionWarnings(vs);
  const typos = warnings.filter((w) => w.kind === 'color-prefix');
  assert.equal(typos.length, 1, 'only the minority variant should be flagged');
});

test('conventionWarnings is silent on a clean catalogue', () => {
  const vs = [];
  for (const size of ['XS', 'M', '2XL']) {
    for (const color of ['Black', 'Grey Heather']) {
      vs.push(variant({ color, size }));
    }
  }
  assert.deepEqual(conventionWarnings(vs), []);
});

test('buildGroups groups only tagged variants, sorted deterministically', () => {
  const vs = groupSlice();
  const groups = buildGroups(vs);
  assert.equal(groups.size, 1);
  const members = groups.get(blankIdFor('Grey Heather', '2XL'));
  assert.equal(members.length, 8, 'the 13 untagged variants are excluded');
  const ids = members.map((m) => m.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)));
});

test('classifyGroup reports converged when every member agrees', () => {
  const { state } = classifyGroup(groupSlice({ untagged: 0 }));
  assert.equal(state, CONVERGED);
});

test('classifyGroup calls a disagreement drift when no seed is pending', () => {
  const members = groupSlice({ taggedQty: [11, 11, 0], untagged: 0 });
  const { state, quantities } = classifyGroup(members);
  assert.equal(state, DRIFT);
  assert.deepEqual(quantities, [0, 11]);
});

test('classifyGroup calls the SAME state awaiting-seed when a seed is pending', () => {
  // This is the distinction that makes audit useful: identical live state, opposite meaning.
  resetSeq(100);
  const members = groupSlice({ taggedQty: [11, 11, 0], untagged: 0 });
  const blankId = members[0].blankId;
  const { state } = classifyGroup(members, new Set([blankId]));
  assert.equal(state, AWAITING_SEED);
});

test('classifyGroups sorts by blank id and preserves members', () => {
  const vs = [
    ...groupSlice({ color: 'Grey Heather', size: '2XL', taggedQty: [5, 5], untagged: 0 }),
    ...groupSlice({ color: 'Black', size: 'M', taggedQty: [7, 7], untagged: 0 }),
  ];
  const rows = classifyGroups(buildGroups(vs));
  assert.deepEqual(
    rows.map((r) => r.blankId),
    [blankIdFor('Black', 'M'), blankIdFor('Grey Heather', '2XL')]
  );
  assert.equal(rows[0].members.length, 2);
});

test('multiLevelVariants catches the assumption the Flow depends on', () => {
  const vs = [
    variant({ locationIds: ['gid://shopify/Location/1'] }),
    variant({ locationIds: ['gid://shopify/Location/1', 'gid://shopify/Location/2'] }),
  ];
  assert.equal(multiLevelVariants(vs).length, 1);
});
