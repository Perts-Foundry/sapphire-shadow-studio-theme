// The version stamp and the derivation rule.
//
// These are the two pieces of the design with no natural safety net. A stamp that strips too
// eagerly silently rewrites a legal policy; a derivation that bumps when it should not mints a
// version the live store has never seen. Both fail quietly, so both are pinned against literal
// bytes rather than against a rearrangement of the same expressions the production code uses.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POLICY_TYPES,
  PolicyError,
  assertVersionFloor,
  coreOf,
  coreSha256,
  defaultStamped,
  deriveVersion,
  isStamped,
  isStampedBody,
  keyForType,
  parseVersionStamp,
  sha256,
  stampVersion,
  stripVersionStamp,
} from '../lib/policies.mjs';

const CORE = '<h2>One</h2>\n<p>a</p>';
const HASH_A = sha256('a');
const HASH_B = sha256('b');

// ---------------------------------------------------------------------------------------------
// stampVersion, against literal bytes
// ---------------------------------------------------------------------------------------------

test('stampVersion emits exactly these bytes', () => {
  assert.equal(stampVersion(CORE, 'shipping_policy', 3), `<!-- sss-policy shipping_policy v3 -->\n${CORE}`);
  assert.equal(stampVersion(CORE, 'contact_information', 1), `<!-- sss-policy contact_information v1 -->\n${CORE}`);
});

test('stampVersion refuses a body that already carries a stamp, so a double stamp is impossible', () => {
  const once = stampVersion(CORE, 'refund_policy', 2);
  assert.throws(() => stampVersion(once, 'refund_policy', 3), /already carries a version stamp/);
});

test('stampVersion refuses an unknown key and a version that is not an integer >= 1', () => {
  assert.throws(() => stampVersion(CORE, 'legal_notice', 1), /not a tracked policy key/);
  for (const bad of [0, -1, 1.5, '3', null, undefined, NaN, Infinity, true]) {
    assert.throws(() => stampVersion(CORE, 'refund_policy', bad), /version must be an integer >= 1/, String(bad));
  }
});

// ---------------------------------------------------------------------------------------------
// parseVersionStamp, against hand-written literals
// ---------------------------------------------------------------------------------------------

test('parseVersionStamp reads a well-formed stamp', () => {
  assert.deepEqual(parseVersionStamp('<!-- sss-policy shipping_policy v3 -->\n<p>x</p>'), { key: 'shipping_policy', version: 3 });
  assert.deepEqual(parseVersionStamp('<!-- sss-policy terms_of_service v12 -->'), { key: 'terms_of_service', version: 12 });
});

test('parseVersionStamp rejects every near-miss spelling', () => {
  const negatives = [
    '<!-- sss-policy shipping_policy v 3 -->\n<p>x</p>',
    '<!-- sss-policy shipping_policy v03 -->\n<p>x</p>',
    '<!-- sss-policy shipping_policy v0 -->\n<p>x</p>',
    '<!-- sss-policy shipping_policy v-1 -->\n<p>x</p>',
    '<!-- sss-policy shipping_policy vX -->\n<p>x</p>',
    '<!-- sss-policy shipping_policy -->\n<p>x</p>',
    '<!-- policy shipping_policy v3 -->\n<p>x</p>',
    '<!-- sss-policy SHIPPING_POLICY v3 -->\n<p>x</p>',
    '<!-- sss-policy shipping_policy v3 --\n<p>x</p>',
    '<!--sss-policy shipping_policy v3-->\n<p>x</p>',
    ' <!-- sss-policy shipping_policy v3 -->\n<p>x</p>',
    '\n<!-- sss-policy shipping_policy v3 -->\n<p>x</p>',
    '<p>x</p>\n<!-- sss-policy shipping_policy v3 -->',
    '',
    null,
  ];
  for (const body of negatives) assert.equal(parseVersionStamp(body), null, JSON.stringify(body));
});

test('v03 and v3 cannot both name version 3: a leading zero is not a stamp at all', () => {
  assert.equal(parseVersionStamp('<!-- sss-policy refund_policy v03 -->\n<p>x</p>'), null);
  assert.deepEqual(parseVersionStamp('<!-- sss-policy refund_policy v3 -->\n<p>x</p>'), { key: 'refund_policy', version: 3 });
});

// ---------------------------------------------------------------------------------------------
// stripVersionStamp: anchoring and idempotence
// ---------------------------------------------------------------------------------------------

test('stripVersionStamp is anchored: a stamp-shaped comment mid-body is CONTENT and survives', () => {
  const body = `<p>x</p>\n<!-- sss-policy shipping_policy v3 -->\n<p>y</p>`;
  assert.equal(stripVersionStamp(body), body);
});

test('stripVersionStamp removes exactly one stamp, so a double stamp is visible rather than tidied', () => {
  const doubled = `<!-- sss-policy refund_policy v2 -->\n<!-- sss-policy refund_policy v1 -->\n${CORE}`;
  assert.equal(stripVersionStamp(doubled), `<!-- sss-policy refund_policy v1 -->\n${CORE}`);
});

test('a body with no stamp is returned unchanged', () => {
  assert.equal(stripVersionStamp(CORE), CORE);
  assert.equal(stripVersionStamp(''), '');
});

test('a leading blank line, space or BOM means the stamp is not on the first line, so it stays', () => {
  for (const prefix of [' ', '\n', '\t', '﻿']) {
    const body = `${prefix}<!-- sss-policy refund_policy v1 -->\n${CORE}`;
    assert.equal(stripVersionStamp(body), body, JSON.stringify(prefix));
  }
});

test('but coreOf canonicalises first, so a BOM before the stamp is handled end to end', () => {
  // canonicalise drops the BOM and normalises CRLF, and only then is the stamp on line one. That
  // ordering is the contract; the raw-string case above is what proves the anchor is real.
  assert.equal(coreOf(`﻿<!-- sss-policy refund_policy v1 -->\n${CORE}`), CORE);
  assert.equal(coreOf(`<!-- sss-policy refund_policy v1 -->\r\n${CORE}`), CORE);
});

test('strip is idempotent, and round-trips every key', () => {
  for (const type of POLICY_TYPES) {
    const key = keyForType(type);
    const stamped = stampVersion(CORE, key, 7);
    assert.equal(stripVersionStamp(stamped), CORE, key);
    assert.equal(stripVersionStamp(stripVersionStamp(stamped)), stripVersionStamp(stamped), key);
    assert.equal(isStampedBody(stamped), true, key);
    assert.equal(isStampedBody(CORE), false, key);
  }
});

test('coreSha256 is stamp-blind: every version of the same wording hashes the same', () => {
  const hashes = new Set([1, 2, 99].map((v) => coreSha256(stampVersion(CORE, 'shipping_policy', v))));
  hashes.add(coreSha256(CORE));
  assert.equal(hashes.size, 1, 'the stamp leaked into the core hash, which would self-trip every gate');
});

// ---------------------------------------------------------------------------------------------
// deriveVersion: the whole table
// ---------------------------------------------------------------------------------------------

test('deriveVersion, row by row', () => {
  assert.equal(deriveVersion(undefined, HASH_A), 1, 'no entry');
  assert.equal(deriveVersion({}, HASH_A), 1, 'no version');
  assert.equal(deriveVersion({ version: null }, HASH_A), 1, 'null version');
  assert.equal(deriveVersion({ version: 4 }, HASH_A), 4, 'version but no coreSha256: seed, do not bump');
  assert.equal(deriveVersion({ version: 4, coreSha256: HASH_A }, HASH_A), 4, 'unchanged core');
  assert.equal(deriveVersion({ version: 3, coreSha256: HASH_A }, HASH_B), 4, 'changed core bumps by exactly one');
  assert.equal(deriveVersion({ version: 1, coreSha256: HASH_A }, HASH_B), 2, 'the 1/0 boundary');
});

test('deriveVersion refuses every type-hostile previous version, and nothing is written', () => {
  for (const bad of ['3', 0, -1, 1.5, true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, [], {}]) {
    assert.throws(
      () => deriveVersion({ version: bad, coreSha256: HASH_A }, HASH_B),
      (err) => err instanceof PolicyError && /not an integer >= 1/.test(err.message),
      JSON.stringify(bad),
    );
  }
});

test('deriveVersion refuses a core hash that is not a digest', () => {
  for (const bad of ['', 'nope', 'A'.repeat(64), 123, null]) {
    assert.throws(() => deriveVersion(undefined, bad), /needs a sha256 digest/, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------------------------
// The monotonic floor
// ---------------------------------------------------------------------------------------------

test('the floor refuses a version at or below one already pushed against DIFFERENT wording', () => {
  const floor = { highestPushed: 3, coreSha256: HASH_A };
  // The revert case: the tree walked back to v2 while live still carries v3.
  assert.throws(() => deriveVersion({ version: 2, coreSha256: HASH_B }, HASH_B, floor), /already been pushed/);
  assert.throws(() => assertVersionFloor(3, HASH_B, floor), /already been pushed/);
  assert.throws(() => assertVersionFloor(1, HASH_B, floor), /already been pushed/);
});

test('the floor allows the SAME wording at or below the floor: that is not a collision', () => {
  const floor = { highestPushed: 3, coreSha256: HASH_A };
  assert.equal(deriveVersion({ version: 3, coreSha256: HASH_A }, HASH_A, floor), 3);
  assert.doesNotThrow(() => assertVersionFloor(3, HASH_A, floor));
});

test('the floor allows anything above it, and is inert when the machine has pushed nothing', () => {
  assert.equal(deriveVersion({ version: 3, coreSha256: HASH_A }, HASH_B, { highestPushed: 3, coreSha256: HASH_A }), 4);
  assert.doesNotThrow(() => assertVersionFloor(1, HASH_B, null));
  assert.doesNotThrow(() => assertVersionFloor(1, HASH_B, { highestPushed: undefined }));
});

test('the floor message names the revert, because that is the only way to reach it', () => {
  assert.throws(
    () => assertVersionFloor(2, HASH_B, { highestPushed: 3, coreSha256: HASH_A }),
    /git revert/,
  );
});

// ---------------------------------------------------------------------------------------------
// Which policies are stamped
// ---------------------------------------------------------------------------------------------

test('the auto-managed privacy policy defaults to unstamped, every writable one to stamped', () => {
  assert.equal(defaultStamped('PRIVACY_POLICY'), false);
  for (const type of POLICY_TYPES.filter((t) => t !== 'PRIVACY_POLICY')) {
    assert.equal(defaultStamped(type), true, type);
  }
});

test('isStamped reads the manifest field and nothing else', () => {
  assert.equal(isStamped({ stamped: true }), true);
  assert.equal(isStamped({ stamped: false }), false);
  assert.equal(isStamped({ stamped: 'true' }), false, 'a string is not a boolean');
  assert.equal(isStamped({}), false);
  assert.equal(isStamped(undefined), false);
});
