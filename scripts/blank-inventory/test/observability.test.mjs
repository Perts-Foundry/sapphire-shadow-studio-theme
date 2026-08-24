// Stage 1: the read-only reporting surface.
//
// These are the renderers the operator approval gates read from. A gate fed a wrong or empty table
// is worse than no gate, so the assertions here are about what the reader is TOLD, not just about
// return shapes: that a histogram distinguishes the two opposite readings of `[0, 2]`, that a near
// match is offered and never applied, and that a non-uniform group is refused whatever the tool
// calls its state.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  learnVocab,
  resolveBlank,
  nearMatches,
  editDistance,
  groupHistogram,
  coverageGaps,
  unconvergedGroups,
  classifyGroups,
  buildGroups,
  AWAITING_SEED,
  DRIFT,
} from '../lib/groups.mjs';
import {
  splitStaleSeedReceipts,
  receiptsToArchive,
  assertRenderablePlan,
  createArtifact,
  SEED_RECEIPT_MAX_AGE_MS,
  PLAN_ROW_KEYS,
} from '../lib/receipt.mjs';
import { variant, groupSlice, blankIdFor } from './fixtures.mjs';

/** A two-group artifact carrying every key the approval gate reads. */
const showArtifact = () =>
  createArtifact({
    mode: 'absolute',
    planId: 'plan-show',
    createdAt: '2026-07-27T00:00:00.000Z',
    plans: [1, 2].map((n) => ({
      blankId: `BLACK_ACME_BLANKA_000${n}_M`,
      target: 10 + n,
      current: 9,
      baseline: 9,
      delta: null,
      writeTargetId: `gid://shopify/ProductVariant/${n}`,
      writeTargetTitle: `product-crewneck | Design ${n} / Black / M`,
      inventoryItemId: `gid://shopify/InventoryItem/${n}`,
      memberIds: [`gid://shopify/ProductVariant/${n}`],
      siblingCount: 7,
      idempotencyKey: `key-${n}`,
    })),
  });

// --- histograms -------------------------------------------------------------

test('the histogram separates the two readings of a deduped quantity list', () => {
  // `[0, 2]` is the ambiguity this exists to remove: a cascade one member short and a cascade that
  // never ran are the same deduped list and opposite situations.
  const nearlyDone = [variant({ body: 'crewneck', quantity: 0 })].concat(
    Array.from({ length: 7 }, () => variant({ body: 'crewneck', quantity: 2 }))
  );
  const neverRan = [variant({ body: 'crewneck', quantity: 2 })].concat(
    Array.from({ length: 7 }, () => variant({ body: 'crewneck', quantity: 0 }))
  );

  assert.deepEqual(groupHistogram(nearlyDone), { 0: 1, 2: 7 });
  assert.deepEqual(groupHistogram(neverRan), { 0: 7, 2: 1 });
});

test('the histogram of a converged group is a single bucket holding every member', () => {
  const members = Array.from({ length: 8 }, () => variant({ body: 'crewneck', quantity: 11 }));
  assert.deepEqual(groupHistogram(members), { 11: 8 });
});

test('an empty group histograms to an empty object rather than throwing', () => {
  assert.deepEqual(groupHistogram([]), {});
});

// --- the precheck that the incident got past --------------------------------

test('unconvergedGroups catches a stranded group that is classified AWAITING_SEED', () => {
  // The regression. `backfill --stage tag` records a seeding receipt whose rows stay
  // not-attempted, so a group stranded mid-fan-out is AWAITING_SEED, not DRIFT. Keying the plan
  // precheck on DRIFT let exactly this through, and it then died inside groupQuantity as a
  // per-line parse error for a store-state problem.
  const blankId = blankIdFor('crewneck', 'Black', 'M');
  const members = [variant({ body: 'crewneck', color: 'Black', size: 'M', quantity: 9 })].concat(
    Array.from({ length: 7 }, () => variant({ body: 'crewneck', color: 'Black', size: 'M', quantity: 0 }))
  );
  const rows = classifyGroups(buildGroups(members), new Set([blankId]));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, AWAITING_SEED, 'fixture must reproduce the masking state, not drift');

  const blocked = unconvergedGroups(rows);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].blankId, blankId);
  assert.deepEqual(groupHistogram(blocked[0].members), { 0: 7, 9: 1 });
});

test('unconvergedGroups also catches an ordinary drifting group', () => {
  const members = [
    variant({ body: 'crewneck', color: 'Black', size: 'L', quantity: 4 }),
    variant({ body: 'crewneck', color: 'Black', size: 'L', quantity: 5 }),
  ];
  const rows = classifyGroups(buildGroups(members));
  assert.equal(rows[0].state, DRIFT);
  assert.equal(unconvergedGroups(rows).length, 1);
});

test('unconvergedGroups passes a converged group, whatever its state', () => {
  const rows = classifyGroups(buildGroups(groupSlice({ untagged: 0 })));
  assert.equal(unconvergedGroups(rows).length, 0);
});

// --- seeding receipts stop explaining things --------------------------------

test('a seeding receipt past the age bound stops suppressing a drift report', () => {
  const now = Date.parse('2026-07-27T12:00:00.000Z');
  const fresh = { seeding: true, startedAt: new Date(now - 60_000).toISOString(), sourceFile: 'receipt-seed-a.json' };
  const old = { seeding: true, startedAt: new Date(now - SEED_RECEIPT_MAX_AGE_MS - 1).toISOString(), sourceFile: 'receipt-seed-b.json' };

  const { fresh: kept, stale } = splitStaleSeedReceipts([fresh, old], { now });
  assert.deepEqual(kept.map((r) => r.sourceFile), ['receipt-seed-a.json']);
  assert.deepEqual(stale.map((r) => r.sourceFile), ['receipt-seed-b.json']);
});

test('a non-seeding receipt is never expired, however old', () => {
  const now = Date.parse('2026-07-27T12:00:00.000Z');
  const ancient = { seeding: false, startedAt: '2020-01-01T00:00:00.000Z' };
  const { fresh, stale } = splitStaleSeedReceipts([ancient], { now });
  assert.equal(fresh.length, 1);
  assert.equal(stale.length, 0);
});

test('a seeding receipt with an unparseable timestamp expires rather than being believed forever', () => {
  // Fail closed: the failure being designed out is a receipt that never stops being trusted.
  const { fresh, stale } = splitStaleSeedReceipts([{ seeding: true, startedAt: 'not a date' }]);
  assert.equal(fresh.length, 0);
  assert.equal(stale.length, 1);
});

// --- which receipts may be moved out of the way -----------------------------
//
// receiptsToArchive is the whole decision behind a filesystem move, which is why it is a pure
// function and tested here rather than through the command that performs the move. What must never
// happen is a FRESH seeding receipt being archived: it is the only thing distinguishing
// awaiting-seed from drift, and it would be gone.

test('receiptsToArchive names only the expired seeding receipts in a mixed population', () => {
  const now = Date.parse('2026-07-27T12:00:00.000Z');
  const population = [
    { seeding: true, startedAt: new Date(now - 60_000).toISOString(), sourceFile: 'receipt-seed-fresh.json' },
    { seeding: true, startedAt: new Date(now - SEED_RECEIPT_MAX_AGE_MS - 1).toISOString(), sourceFile: 'receipt-seed-old.json' },
    { seeding: false, startedAt: '2020-01-01T00:00:00.000Z', sourceFile: 'receipt-apply-ancient.json' },
    { seeding: true, startedAt: 'not a date', sourceFile: 'receipt-seed-broken.json' },
  ];
  assert.deepEqual(receiptsToArchive(population, { now }), ['receipt-seed-old.json', 'receipt-seed-broken.json']);
});

test('receiptsToArchive holds a seeding receipt exactly at the age bound', () => {
  // The comparison is `>`, so the bound itself is still fresh. Pinned because a later refactor to
  // `>=` would expire a receipt one millisecond early, and nothing else would notice.
  const now = Date.parse('2026-07-27T12:00:00.000Z');
  const atBound = { seeding: true, startedAt: new Date(now - SEED_RECEIPT_MAX_AGE_MS).toISOString(), sourceFile: 'receipt-seed-edge.json' };
  const pastBound = { seeding: true, startedAt: new Date(now - SEED_RECEIPT_MAX_AGE_MS - 1).toISOString(), sourceFile: 'receipt-seed-past.json' };
  assert.deepEqual(receiptsToArchive([atBound], { now }), []);
  assert.deepEqual(receiptsToArchive([pastBound], { now }), ['receipt-seed-past.json']);
});

test('receiptsToArchive skips a receipt that came from no file, and an empty population', () => {
  // Nothing to move is not an error, and a receipt with no sourceFile was never read off disk.
  const now = Date.parse('2026-07-27T12:00:00.000Z');
  const noFile = { seeding: true, startedAt: new Date(now - SEED_RECEIPT_MAX_AGE_MS - 1).toISOString() };
  assert.deepEqual(receiptsToArchive([noFile], { now }), []);
  assert.deepEqual(receiptsToArchive([], { now }), []);
});

// --- near matches are offered, never applied --------------------------------

const vocabFixture = () =>
  learnVocab([
    variant({ body: 'crewneck', color: 'Classic Navy', size: 'M' }),
    variant({ body: 'crewneck', color: 'Grey Heather', size: 'M' }),
    variant({ body: 'crewneck', color: 'Black', size: 'M' }),
    variant({ body: 'quarter-zip', color: 'Classic Navy', size: 'M' }),
  ]);

test('the vocabulary records the store\'s own spelling for each axis value', () => {
  // Normalisation lowercases, so without this every suggestion names a spelling that appears
  // nowhere in Admin and the operator cannot find it.
  const { display } = vocabFixture();
  assert.equal(display.color.get('classic navy'), 'Classic Navy');
  assert.equal(display.color.get('grey heather'), 'Grey Heather');
  assert.equal(display.body.get('crewneck'), 'crewneck');
});

test('"Navy" suggests "Classic Navy" and does NOT resolve to it', () => {
  // The exact mismatch that would have failed 24 of 42 rows after the operator had already
  // confirmed the table.
  const { vocab, display } = vocabFixture();
  const near = nearMatches(vocab, { body: 'crewneck', color: 'Navy', size: 'M' }, { display });
  assert.ok(
    near.some((n) => n.axis === 'color' && n.value === 'Classic Navy'),
    'expected the store spelling to be suggested'
  );

  assert.throws(
    () => resolveBlank(vocab, { body: 'crewneck', color: 'Navy', size: 'M' }, { display }),
    /No blank precedent for "crewneck \/ Navy \/ M"/,
    'a near match must never satisfy the lookup'
  );
});

test('the refusal names the suggestion and says only the operator may act on it', () => {
  const { vocab, display } = vocabFixture();
  assert.throws(
    () => resolveBlank(vocab, { body: 'crewneck', color: 'Grey', size: 'M' }, { display }),
    (err) => {
      assert.match(err.message, /Grey Heather/);
      assert.match(err.message, /never substitutes/);
      assert.match(err.message, /OPERATOR/);
      return true;
    }
  );
});

test('a suggestion always differs on exactly one axis, so it is a real key', () => {
  const { vocab, display } = vocabFixture();
  // Wrong colour AND wrong size: nothing one keystroke away is a genuine key, so suggest nothing
  // rather than something that differs on two axes and reads as a plausible answer.
  const near = nearMatches(vocab, { body: 'crewneck', color: 'Navy', size: '4XL' }, { display });
  assert.deepEqual(near, []);
});

test('an exact key resolves and produces no suggestion path at all', () => {
  const { vocab, display } = vocabFixture();
  assert.equal(
    resolveBlank(vocab, { body: 'crewneck', color: 'Classic Navy', size: 'M' }, { display }),
    blankIdFor('crewneck', 'Classic Navy', 'M')
  );
});

test('resolveBlank still refuses with no display map supplied', () => {
  // The suggestion machinery is optional; its absence must not weaken the refusal.
  const { vocab } = vocabFixture();
  assert.throws(() => resolveBlank(vocab, { body: 'crewneck', color: 'Navy', size: 'M' }), /No blank precedent/);
});

test('editDistance is symmetric and zero only on equality', () => {
  assert.equal(editDistance('navy', 'navy'), 0);
  assert.equal(editDistance('navy', 'classic navy'), editDistance('classic navy', 'navy'));
  assert.ok(editDistance('navy', 'classic navy') > 0);
});

// --- coverage ---------------------------------------------------------------

test('coverage counts tagged against the KEYABLE population, per body', () => {
  const variants = [
    ...groupSlice({ body: 'crewneck', color: 'Black', size: 'M', taggedQty: [5, 5], untagged: 3 }),
    ...groupSlice({ body: 'vest-womens', color: 'Black', size: 'M', taggedQty: [7], untagged: 1 }),
  ];
  const { byBody, totals } = coverageGaps(variants);

  const crew = byBody.find((r) => r.body === 'crewneck');
  assert.deepEqual(crew, { body: 'crewneck', keyable: 5, tagged: 2, untagged: 3 });
  assert.equal(totals.keyable, 7);
  assert.equal(totals.tagged, 3);
  assert.equal(totals.untagged, 4);
});

test('an untagged variant that can never be keyed is excluded from the denominator', () => {
  // Counting it would report a permanent shortfall no backfill can close, which trains the
  // operator to ignore the number.
  const variants = [
    variant({ body: 'crewneck', color: 'Black', size: 'M', blankId: null }),
    variant({ body: 'crewneck', color: null, size: 'M', blankId: null }),
    variant({ body: 'crewneck', color: 'Black', size: 'M', blankId: null, tracked: false }),
  ];
  const { totals, unkeyable } = coverageGaps(variants);
  assert.equal(totals.keyable, 1);
  assert.equal(unkeyable, 2);
});

test('a fully tagged body reports no gap', () => {
  const { byBody } = coverageGaps(groupSlice({ body: 'crewneck', taggedQty: [4, 4], untagged: 0 }));
  assert.equal(byBody[0].untagged, 0);
  assert.equal(byBody[0].tagged, byBody[0].keyable);
});

// --- the plan gate renderer -------------------------------------------------

test('a complete artifact renders', () => {
  assert.doesNotThrow(() => assertRenderablePlan(showArtifact()));
});

test('an artifact with a RENAMED key errors rather than rendering a blank cell', () => {
  // The regression this command exists for: the gate once printed `write: undefined` on every row
  // and the operator approved a table that showed none of the actual writes.
  const artifact = showArtifact();
  artifact.groups[0].writeTarget = artifact.groups[0].writeTargetTitle;
  delete artifact.groups[0].writeTargetTitle;

  assert.throws(() => assertRenderablePlan(artifact), (err) => {
    assert.match(err.message, /missing writeTargetTitle/);
    assert.match(err.message, /Refusing to render/);
    return true;
  });
});

test('every gate-critical key is individually required', () => {
  for (const key of PLAN_ROW_KEYS) {
    const artifact = showArtifact();
    delete artifact.groups[0][key];
    assert.throws(
      () => assertRenderablePlan(artifact),
      new RegExp(`missing ${key}`),
      `${key} must be required to render`
    );
  }
});

test('a null value is as unrenderable as an absent one', () => {
  // `write: undefined` was a present key holding nothing, not a missing key.
  const artifact = showArtifact();
  artifact.groups[0].writeTargetTitle = null;
  assert.throws(() => assertRenderablePlan(artifact), /missing writeTargetTitle/);
});

test('an empty plan renders (nothing to write is a legitimate answer)', () => {
  assert.doesNotThrow(() => assertRenderablePlan({ groups: [] }));
});

test('something that is not a plan artifact is refused outright', () => {
  assert.throws(() => assertRenderablePlan({ rows: [] }), /not a plan artifact/);
  assert.throws(() => assertRenderablePlan(null), /not a plan artifact/);
});
