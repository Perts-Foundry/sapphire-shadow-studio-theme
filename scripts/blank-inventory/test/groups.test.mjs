import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  learnVocab,
  resolveBlank,
  conventionWarnings,
  vocabKey,
  normaliseAxis,
  buildGroups,
  classifyGroup,
  classifyGroups,
  blankPrefix,
  multiLevelVariants,
  AWAITING_SEED,
  CONVERGED,
  DRIFT,
} from '../lib/groups.mjs';
import { variant, groupSlice, crossBodySlice, blankIdFor, resetSeq, BODIES } from './fixtures.mjs';

// --- the key itself ---------------------------------------------------------

test('a fixture cannot be built without an explicit body', () => {
  // Pins the fixture contract. A default body here would let every test below keep asserting the
  // single-garment world that produced the bug, all while staying green.
  assert.throws(() => variant({ color: 'Black', size: 'M' }), /requires an explicit `body`/);
});

test('vocabKey refuses a variant with no body rather than falling back to colour+size', () => {
  assert.throws(() => vocabKey({ body: null, color: 'Black', size: 'M' }), /Cannot key a variant with no garment body/);
});

test('vocabKey separates two bodies that share a colour and size', () => {
  const a = vocabKey({ body: 'crewneck', color: 'Black', size: 'M' });
  const b = vocabKey({ body: 'quarter-zip', color: 'Black', size: 'M' });
  assert.notEqual(a, b);
});

test('an axis value containing the separator is refused, not escaped', () => {
  // A collision here resolves a variant to another garment's blank and moves the wrong stock.
  assert.throws(() => vocabKey({ body: 'crew|neck', color: 'Black', size: 'M' }), /contains the key separator/);
  assert.throws(() => vocabKey({ body: 'crewneck', color: 'Bla|ck', size: 'M' }), /contains the key separator/);
});

test('all three axes share one normalisation rule', () => {
  assert.equal(normaliseAxis('  Grey   Heather ', 'Color'), 'grey heather');
  assert.equal(
    vocabKey({ body: 'Crewneck', color: 'BLACK', size: 'm' }),
    vocabKey({ body: 'crewneck', color: 'black', size: 'M' })
  );
});

// --- vocabulary -------------------------------------------------------------

test('learnVocab maps Body+Color+Size to the blank id used by tagged variants', () => {
  const { vocab, conflicts } = learnVocab(groupSlice());
  assert.equal(conflicts.length, 0);
  assert.equal(
    vocab.get(vocabKey({ body: 'crewneck', color: 'Grey Heather', size: '2XL' })),
    blankIdFor('crewneck', 'Grey Heather', '2XL')
  );
});

test('two DIFFERENT bodies sharing a colour and size are not a conflict', () => {
  // The defect this axis fixes. Under the old colour+size key these two poisoned one another's
  // entry, the key was dropped as conflicted, and neither garment could ever be resolved again.
  const vs = [
    variant({ body: 'crewneck', color: 'Black', size: 'M' }),
    variant({ body: 'quarter-zip', color: 'Black', size: 'M' }),
  ];
  const { vocab, conflicts } = learnVocab(vs);
  assert.deepEqual(conflicts, []);
  assert.equal(resolveBlank(vocab, { body: 'crewneck', color: 'Black', size: 'M' }), blankIdFor('crewneck', 'Black', 'M'));
  assert.equal(resolveBlank(vocab, { body: 'quarter-zip', color: 'Black', size: 'M' }), blankIdFor('quarter-zip', 'Black', 'M'));
});

test('two ids for ONE body+colour+size is still a conflict, and still refused', () => {
  const vs = [
    variant({ body: 'crewneck', color: 'Black', size: 'M', blankId: 'BLACK_ACME_BLANKA_0001_M' }),
    variant({ body: 'crewneck', color: 'Black', size: 'M', blankId: 'BLACK_ACME_BLANKA_0002_M' }),
  ];
  const { vocab, conflicts } = learnVocab(vs);
  assert.equal(conflicts.length, 1);
  assert.throws(() => resolveBlank(vocab, { body: 'crewneck', color: 'Black', size: 'M' }), /No blank precedent/);
  assert.deepEqual(conflicts[0].values, ['BLACK_ACME_BLANKA_0001_M', 'BLACK_ACME_BLANKA_0002_M']);
});

test('resolveBlank refuses a key with no precedent instead of inventing one', () => {
  const { vocab } = learnVocab(groupSlice());
  assert.throws(() => resolveBlank(vocab, { body: 'crewneck', color: 'Black', size: 'XS' }), /No blank precedent/);
});

test('resolveBlank refuses a body that exists for another colour but not this one', () => {
  const { vocab } = learnVocab([variant({ body: 'crewneck', color: 'Black', size: 'M' })]);
  assert.throws(() => resolveBlank(vocab, { body: 'vest-womens', color: 'Black', size: 'M' }), /No blank precedent/);
});

test('a tagged variant with no body is reported, not silently keyed', () => {
  const { vocab, unbodied } = learnVocab([variant({ body: null, color: 'Black', size: 'M', blankId: 'BLACK_ACME_BLANKA_0001_M' })]);
  assert.equal(vocab.size, 0);
  assert.equal(unbodied.length, 1);
});

test('untagged variants contribute nothing to the vocab', () => {
  const { vocab } = learnVocab([variant({ body: 'crewneck', blankId: null }), variant({ body: 'vest-womens', blankId: null })]);
  assert.equal(vocab.size, 0);
});

test('blankPrefix strips the size suffix and returns null on a mismatch', () => {
  assert.equal(blankPrefix('GREY_ACME_BLANKA_0001_2XL', '2XL'), 'GREY_ACME_BLANKA_0001');
  assert.equal(blankPrefix('GREY_ACME_BLANKA_0001_2XL', 'XL'), null);
});

// --- convention warnings ----------------------------------------------------

test('conventionWarnings flags a blank id that does not end with its own size', () => {
  // The classic paste error: an M value landed on the L variant.
  const vs = [variant({ body: 'crewneck', color: 'Black', size: 'L', blankId: 'BLACK_ACME_BLANKA_0001_M' })];
  const warnings = conventionWarnings(vs);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'size-suffix');
});

test('conventionWarnings flags a minority colour prefix within ONE body as a likely typo', () => {
  // GREY vs GRAY is a real-world confusion and keeps both tokens inside the synthetic vocabulary
  // that check-no-real-blank-ids.mjs allows, so this fixture cannot trip the leak guard.
  const vs = [
    variant({ body: 'crewneck', color: 'Grey Heather', size: 'M', blankId: 'GREY_ACME_BLANKA_0001_M' }),
    variant({ body: 'crewneck', color: 'Grey Heather', size: 'M', blankId: 'GREY_ACME_BLANKA_0001_M' }),
    variant({ body: 'crewneck', color: 'Grey Heather', size: 'M', blankId: 'GRAY_ACME_BLANKA_0001_M' }),
  ];
  const typos = conventionWarnings(vs).filter((w) => w.kind === 'color-prefix');
  assert.equal(typos.length, 1, 'only the minority variant should be flagged');
});

test('one colour across DIFFERENT bodies produces no typo warning', () => {
  // Keyed on colour alone, this fired on every correctly-modelled catalogue: a crewneck and a vest
  // in one colour draw on different blanks and so legitimately carry different prefixes. A warning
  // that is always on is one nobody reads.
  const vs = BODIES.map((body) => variant({ body, color: 'Black', size: 'M' }));
  assert.deepEqual(conventionWarnings(vs).filter((w) => w.kind === 'color-prefix'), []);
});

test('conventionWarnings flags one blank id held by two different bodies', () => {
  // Two physical garments drawing from one stock pool: selling one decrements the other. This is
  // the pre-migration state of the real store, and nothing surfaced it before.
  const spans = conventionWarnings(crossBodySlice()).filter((w) => w.kind === 'body-span');
  assert.equal(spans.length, 1);
  assert.match(spans[0].message, /3 different bodies/);
});

test('conventionWarnings is silent on a clean multi-body catalogue', () => {
  const vs = [];
  for (const body of BODIES) {
    for (const size of ['XS', 'M', '2XL']) {
      for (const color of ['Black', 'Grey Heather']) {
        vs.push(variant({ body, color, size }));
      }
    }
  }
  assert.deepEqual(conventionWarnings(vs), []);
});

test('buildGroups groups only tagged variants, sorted deterministically', () => {
  const vs = groupSlice();
  const groups = buildGroups(vs);
  assert.equal(groups.size, 1);
  const members = groups.get(blankIdFor('crewneck', 'Grey Heather', '2XL'));
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
    [blankIdFor('crewneck', 'Black', 'M'), blankIdFor('crewneck', 'Grey Heather', '2XL')].sort()
  );
  assert.equal(rows[0].members.length, 2);
});

test('buildGroups keeps two bodies in separate groups', () => {
  const vs = [
    ...groupSlice({ body: 'crewneck', color: 'Black', size: 'M', taggedQty: [7, 7], untagged: 0 }),
    ...groupSlice({ body: 'vest-womens', color: 'Black', size: 'M', taggedQty: [4], untagged: 0 }),
  ];
  assert.equal(buildGroups(vs).size, 2, 'two bodies must not share one stock pool');
});

test('multiLevelVariants catches the assumption the Flow depends on', () => {
  const vs = [
    variant({ body: 'crewneck', locationIds: ['gid://shopify/Location/1'] }),
    variant({ body: 'crewneck', locationIds: ['gid://shopify/Location/1', 'gid://shopify/Location/2'] }),
  ];
  assert.equal(multiLevelVariants(vs).length, 1);
});
