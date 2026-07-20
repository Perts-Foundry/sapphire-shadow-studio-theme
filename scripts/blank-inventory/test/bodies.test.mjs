// The garment body axis: inference, the approval artifact, and refusal behaviour.
//
// The load-bearing property under test is that inference is confined to PROPOSAL time. Nothing here
// may resolve a body at write time from a signal the operator has not approved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inferBody,
  proposeBodies,
  createBodiesArtifact,
  verifyBodiesArtifact,
  hashBodies,
  bodyIndex,
  bodyOf,
  unmappedHandles,
  HIGH,
  LOW,
  NONE,
} from '../lib/bodies.mjs';

const product = (handle, title = '') => ({ handle, title });
const tracked = (productHandle) => ({ productHandle, tracked: true });

// --- inference ------------------------------------------------------------

test('a garment keyword in the handle infers a body at high confidence', () => {
  const r = inferBody(product('lead-ii-crewneck'));
  assert.equal(r.bodyId, 'crewneck');
  assert.equal(r.confidence, HIGH);
  assert.match(r.signal, /handle contains "crewneck"/);
});

test('the longest keyword wins, so quarter-zip is not shadowed by a shorter match', () => {
  assert.equal(inferBody(product('lead-ii-quarter-zip')).bodyId, 'quarter-zip');
});

test('a fit qualifier distinguishes a womens cut as its own body', () => {
  // A women's vest is a different physical blank from a unisex vest; sharing a pool would oversell.
  const r = inferBody(product('lead-ii-vest-womens'));
  assert.equal(r.bodyId, 'vest-womens');
  assert.equal(r.confidence, HIGH);
});

test('all three crewneck products infer the SAME body, so they keep sharing one pool', () => {
  const bodies = ['lead-ii-crewneck', 'huddle-crewneck', 'shift-fuel-crewneck'].map(
    (h) => inferBody(product(h)).bodyId
  );
  assert.deepEqual(bodies, ['crewneck', 'crewneck', 'crewneck']);
});

test('a title-only match is inferred at LOW confidence, not high', () => {
  const r = inferBody(product('lead-ii-classic', 'The Lead II Hoodie'));
  assert.equal(r.bodyId, 'hoodie');
  assert.equal(r.confidence, LOW);
  assert.match(r.signal, /^title contains/);
});

test('a handle naming two different garments is ambiguous, never resolved to the first', () => {
  const r = inferBody(product('crewneck-and-hoodie-bundle'));
  assert.equal(r.bodyId, null);
  assert.equal(r.confidence, NONE);
  assert.match(r.signal, /matches 2 garments/);
});

test('an unrecognised product yields no body rather than a default', () => {
  const r = inferBody(product('mystery-garment', 'Mystery Garment'));
  assert.equal(r.bodyId, null);
  assert.equal(r.confidence, NONE);
});

test('inference is deterministic over the same input', () => {
  // Re-guessing per run would be worse than a hardcoded map, because it would be worse AND silent.
  const a = inferBody(product('lead-ii-quarter-zip'));
  const b = inferBody(product('lead-ii-quarter-zip'));
  assert.deepEqual(a, b);
});

test('existing blank ids are not an inference signal', () => {
  // They currently all name one family, which is the state being corrected.
  const withBlank = { handle: 'lead-ii-vest-womens', title: '', blankId: 'BLACK_ACME_FLEECE_M' };
  assert.equal(inferBody(withBlank).bodyId, 'vest-womens');
});

// --- proposal -------------------------------------------------------------

test('proposeBodies excludes products with no tracked variants', () => {
  const { rows, excluded } = proposeBodies({
    products: [product('lead-ii-crewneck'), product('a-gift-card')],
    variants: [tracked('lead-ii-crewneck'), { productHandle: 'a-gift-card', tracked: false }],
  });
  assert.deepEqual(rows.map((r) => r.productHandle), ['lead-ii-crewneck']);
  assert.deepEqual(excluded, [{ productHandle: 'a-gift-card', reason: 'no tracked variants' }]);
});

test('proposeBodies surfaces an un-inferrable product as a row with a null body, not a silent drop', () => {
  const { rows } = proposeBodies({
    products: [product('mystery-garment')],
    variants: [tracked('mystery-garment')],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bodyId, null);
});

// --- artifact -------------------------------------------------------------

test('an artifact cannot be approved while any product is unnamed', () => {
  assert.throws(
    () => createBodiesArtifact({ rows: [{ productHandle: 'mystery', bodyId: null }] }),
    /Cannot approve a body proposal with 1 unnamed product/
  );
});

test('a created artifact verifies, and a hand-edit is refused', () => {
  const artifact = createBodiesArtifact({
    rows: [{ productHandle: 'lead-ii-crewneck', bodyId: 'crewneck' }],
  });
  assert.equal(verifyBodiesArtifact(artifact), artifact);

  artifact.bodies[0].bodyId = 'quarter-zip';
  assert.throws(() => verifyBodiesArtifact(artifact), /hash mismatch/);
});

test('an artifact from an unsupported version is refused rather than interpreted', () => {
  assert.throws(() => verifyBodiesArtifact({ version: 999 }), /Unsupported body artifact/);
});

test('the hash ignores row order, so a reordered but identical approval still verifies', () => {
  const rows = [
    { productHandle: 'b-crewneck', bodyId: 'crewneck' },
    { productHandle: 'a-vest', bodyId: 'vest' },
  ];
  const forward = createBodiesArtifact({ rows, proposalId: 'fixed', createdAt: 'fixed' });
  const reversed = createBodiesArtifact({ rows: [...rows].reverse(), proposalId: 'fixed', createdAt: 'fixed' });
  assert.equal(hashBodies(forward), hashBodies(reversed));
});

test('the hash covers the body assignment, so changing one product changes it', () => {
  const base = createBodiesArtifact({ rows: [{ productHandle: 'a', bodyId: 'vest' }], proposalId: 'x', createdAt: 'y' });
  const other = createBodiesArtifact({ rows: [{ productHandle: 'a', bodyId: 'tee' }], proposalId: 'x', createdAt: 'y' });
  assert.notEqual(hashBodies(base), hashBodies(other));
});

// --- resolution -----------------------------------------------------------

test('bodyOf resolves an approved product', () => {
  const index = bodyIndex(createBodiesArtifact({ rows: [{ productHandle: 'lead-ii-crewneck', bodyId: 'crewneck' }] }));
  assert.equal(bodyOf(index, { productHandle: 'lead-ii-crewneck' }), 'crewneck');
});

test('bodyOf REFUSES an unapproved product rather than inferring at write time', () => {
  // The whole safety property. Inference belongs at proposal time, behind a gate.
  const index = bodyIndex(createBodiesArtifact({ rows: [{ productHandle: 'known', bodyId: 'crewneck' }] }));
  assert.throws(
    () => bodyOf(index, { productHandle: 'brand-new-crewneck' }),
    /No approved body for product "brand-new-crewneck"/
  );
});

test('bodyOf refuses even when the handle would infer cleanly', () => {
  // A handle that inferBody would resolve at high confidence must still be refused at write time.
  assert.equal(inferBody(product('brand-new-crewneck')).confidence, HIGH);
  const index = bodyIndex(createBodiesArtifact({ rows: [{ productHandle: 'known', bodyId: 'crewneck' }] }));
  assert.throws(() => bodyOf(index, { productHandle: 'brand-new-crewneck' }), /never infers a body at write time/);
});

test('unmappedHandles lists tracked products the artifact does not cover, ignoring untracked ones', () => {
  const index = bodyIndex(createBodiesArtifact({ rows: [{ productHandle: 'known', bodyId: 'crewneck' }] }));
  const variants = [
    tracked('known'),
    tracked('newcomer'),
    tracked('newcomer'),
    { productHandle: 'a-gift-card', tracked: false },
  ];
  assert.deepEqual(unmappedHandles(index, variants), ['newcomer']);
});
