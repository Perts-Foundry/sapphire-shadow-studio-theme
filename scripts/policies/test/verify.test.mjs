// scripts/policies/verify.mjs: what the LIVE bodies say, after a push.
//
// `policies:pull --check` is a tautology here: a successful push already reconciled the repo with
// Admin, so it comes back clean whether the intended wording landed or not.
//
// The property under test that matters most is FAIL-CLOSED ON A STALE ASSERTION SET. A set whose
// sentences were written against wording that has since changed reports confident PASS lines about
// text nobody has read, which is worse output than no assertions at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { assertSetIsCurrent, readAssertions, run } from '../verify.mjs';
import { coreOf, coreSha256, fileNameForType, fileTextFor } from '../lib/policies.mjs';
import {
  BODIES,
  cleanup,
  liveFrom,
  makeClient,
  makeRoot,
  writeRaw,
  writtenBodyFor,
} from './helpers.mjs';

const SHIPPING_CORE = coreSha256(BODIES.SHIPPING_POLICY);

function currentSet(extra = {}) {
  return { shipping_policy: { coreSha256: SHIPPING_CORE, must: ['Shipping Options'], mustNot: ['NOT PRESENT'], ...extra } };
}

function collect() {
  const lines = [];
  return { lines, log: (s) => lines.push(s) };
}

// ---------------------------------------------------------------------------------------------
// Stale assertion sets
// ---------------------------------------------------------------------------------------------

test('a set whose coreSha256 MATCHES runs, and can actually fail', async () => {
  // The other half of the fail-closed test. A guard that refuses everything would pass a test that
  // only ever asserted refusals.
  const root = makeRoot();
  try {
    const { lines, log } = collect();
    const assertions = { shipping_policy: { coreSha256: SHIPPING_CORE, must: ['a sentence that is not there'], mustNot: [] } };
    const { failed } = await run({ client: makeClient({ live: liveFrom() }), root, assertions, log });
    assert.ok(failed > 0, 'a matching set must be able to report a failure');
    assert.ok(lines.join('\n').includes('FAIL  live contains'));
  } finally {
    cleanup(root);
  }
});

test('a set whose coreSha256 DIFFERS refuses BEFORE any live read', async () => {
  const root = makeRoot();
  try {
    const client = makeClient({ live: liveFrom() });
    const assertions = { shipping_policy: { coreSha256: 'a'.repeat(64), must: ['Shipping Options'] } };
    await assert.rejects(
      () => run({ client, root, assertions, log: () => {} }),
      /was written against core .* but the repo body is now .*Refusing BEFORE reading the live store/s,
    );
    assert.deepEqual(client.calls, [], 'a stale set cost a live read');
  } finally {
    cleanup(root);
  }
});

test('a set with NO coreSha256 refuses fail-closed; it never falls back to default mode', async () => {
  const root = makeRoot();
  try {
    const client = makeClient({ live: liveFrom() });
    for (const bad of [undefined, null, '', 'nope', 'A'.repeat(64), 123]) {
      const assertions = { shipping_policy: { ...(bad === undefined ? {} : { coreSha256: bad }), must: ['x'] } };
      await assert.rejects(
        () => run({ client, root, assertions, log: () => {} }),
        /has no coreSha256/,
        JSON.stringify(bad),
      );
    }
    assert.deepEqual(client.calls, []);
  } finally {
    cleanup(root);
  }
});

test('assertSetIsCurrent names the value to paste in, so the fix is not a hunt', () => {
  assert.throws(() => assertSetIsCurrent('shipping_policy', {}, SHIPPING_CORE), new RegExp(SHIPPING_CORE));
});

test('a set naming no tracked policy is a refusal', async () => {
  const root = makeRoot();
  try {
    await assert.rejects(
      () => run({ client: makeClient({ live: liveFrom() }), root, assertions: { legal_notice: { coreSha256: SHIPPING_CORE } }, log: () => {} }),
      /names no tracked policy/,
    );
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------------------------
// The version assertion of record
// ---------------------------------------------------------------------------------------------

test('THE ASSERTION OF RECORD: live carrying the repo version is what PASSES', async () => {
  const root = makeRoot();
  try {
    const { lines, log } = collect();
    // Live carries our stamped body: the state after a stamped push.
    const live = liveFrom({ ...BODIES, SHIPPING_POLICY: writtenBodyFor('SHIPPING_POLICY') });
    const { failed } = await run({ client: makeClient({ live }), root, assertions: currentSet(), log });
    assert.equal(failed, 0);
    assert.ok(lines.join('\n').includes('live carries the version stamp this repo names (v1)'));
  } finally {
    cleanup(root);
  }
});

test('a byte-match with the WRONG version is a FAIL, because a byte-match is not a verification', async () => {
  const root = makeRoot();
  try {
    const { lines, log } = collect();
    const live = liveFrom({ ...BODIES, SHIPPING_POLICY: `<!-- sss-policy shipping_policy v9 -->\n${BODIES.SHIPPING_POLICY}` });
    const { failed } = await run({ client: makeClient({ live }), root, assertions: currentSet(), log });
    assert.ok(failed > 0);
    assert.ok(lines.join('\n').includes('live carries v9'));
    assert.ok(lines.join('\n').includes('the live CORE is identical'), 'the core comparison must still pass');
  } finally {
    cleanup(root);
  }
});

test('NO stamped write yet + live unstamped is a SKIP, not a failure: that is the normal state', async () => {
  const root = makeRoot();
  try {
    const { lines, log } = collect();
    const state = { schemaVersion: 1, policies: { shipping_policy: { lastPushStamped: false } } };
    const { failed } = await run({ client: makeClient({ live: liveFrom() }), root, assertions: currentSet(), state, log });
    assert.equal(failed, 0);
    assert.ok(lines.join('\n').includes('no stamped write has happened from this machine yet'));
  } finally {
    cleanup(root);
  }
});

test('a stamped write DID happen + live unstamped is a FAIL that names the cause', async () => {
  // We wrote v1 and live carries no stamp: Shopify strips HTML comments. Not a wording failure,
  // but it retires the version assertion permanently, and those need different actions.
  const root = makeRoot();
  try {
    const { lines, log } = collect();
    const state = { schemaVersion: 1, policies: { shipping_policy: { lastPushStamped: true } } };
    const { failed } = await run({ client: makeClient({ live: liveFrom() }), root, assertions: currentSet(), state, log });
    assert.ok(failed > 0);
    const text = lines.join('\n');
    assert.ok(text.includes('Shopify strips HTML comments'));
    assert.ok(text.includes('"stamped": false'), 'the failure must name the fix');
  } finally {
    cleanup(root);
  }
});

test('an unstamped policy skips the version assertion entirely', async () => {
  const root = makeRoot();
  try {
    const { lines, log } = collect();
    await run({ client: makeClient({ live: liveFrom() }), root, assertions: {}, log });
    const privacy = lines.join('\n').split('=== privacy_policy ===')[1];
    assert.ok(privacy.includes('not stamped, so there is no version to assert'));
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------------------------
// Default mode
// ---------------------------------------------------------------------------------------------

test('with no assertions at all, every policy is compared on the CORE', async () => {
  const root = makeRoot();
  try {
    const { lines, log } = collect();
    const { failed, results } = await run({ client: makeClient({ live: liveFrom() }), root, assertions: {}, log });
    assert.equal(failed, 0);
    assert.equal(results.length, 5);
    assert.equal((lines.join('\n').match(/live CORE is identical/g) ?? []).length, 5);
  } finally {
    cleanup(root);
  }
});

test('a differing live body FAILS and the printed diff contains the differing text', async () => {
  const root = makeRoot();
  try {
    const { lines, log } = collect();
    const live = liveFrom({ ...BODIES, REFUND_POLICY: `${BODIES.REFUND_POLICY}\n<p>UNIQUE ADMIN SENTENCE</p>` });
    const { failed } = await run({ client: makeClient({ live }), root, assertions: {}, log });
    assert.ok(failed > 0);
    assert.ok(lines.join('\n').includes('UNIQUE ADMIN SENTENCE'), 'the diff does not show what differs');
  } finally {
    cleanup(root);
  }
});

test('a policy Admin does not return is a FAIL, not a silent skip', async () => {
  const root = makeRoot();
  try {
    const { lines, log } = collect();
    const live = liveFrom();
    delete live.TERMS_OF_SERVICE;
    const { failed } = await run({ client: makeClient({ live }), root, assertions: {}, log });
    assert.ok(failed > 0);
    assert.ok(lines.join('\n').includes('Admin returned no such policy'));
  } finally {
    cleanup(root);
  }
});

test('a live body stamped while the repo copy is not says to pull', async () => {
  const root = makeRoot();
  try {
    writeRaw(root, fileNameForType('PRIVACY_POLICY'), fileTextFor(BODIES.PRIVACY_POLICY));
    const { lines, log } = collect();
    const live = liveFrom({ ...BODIES, PRIVACY_POLICY: `<!-- sss-policy privacy_policy v3 -->\n${BODIES.PRIVACY_POLICY}` });
    await run({ client: makeClient({ live }), root, assertions: {}, log });
    assert.ok(lines.join('\n').includes('live carries a stamp and the repo copy does not'));
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------------------------
// --root, and the committed assertion set
// ---------------------------------------------------------------------------------------------

test('--root is NOT inert: two roots with different bodies give different answers', async () => {
  const a = makeRoot();
  const b = makeRoot();
  try {
    writeRaw(b, fileNameForType('REFUND_POLICY'), fileTextFor(`<!-- sss-policy refund_policy v1 -->\n${BODIES.REFUND_POLICY}\n<p>only in b</p>`));
    const client = makeClient({ live: liveFrom() });
    const first = await run({ client, root: a, assertions: {}, log: () => {} });
    const second = await run({ client: makeClient({ live: liveFrom() }), root: b, assertions: {}, log: () => {} });
    assert.equal(first.failed, 0);
    assert.ok(second.failed > 0, '--root was ignored: both roots gave the same answer');
  } finally {
    cleanup(a);
    cleanup(b);
  }
});

test('run refuses without an injected client or root', async () => {
  await assert.rejects(() => run({ root: '/tmp', assertions: {} }), /needs an Admin client/);
  await assert.rejects(() => run({ client: { gql: async () => ({}) }, assertions: {} }), /needs a root/);
});

test('the COMMITTED assertions.json is current against the committed bodies', async () => {
  // The set in the repo has to pass its own staleness gate, or the first real run refuses. This
  // is the check that catches a wording edit that forgot to rewrite the sentences.
  const { REPO_ROOT, paths } = await import('../check.mjs');
  const assertions = readAssertions();
  assert.ok(Object.keys(assertions).length > 0, 'assertions.json is empty');
  for (const [key, set] of Object.entries(assertions)) {
    const body = readFileSync(paths(REPO_ROOT).file(key.toUpperCase()), 'utf8');
    assert.doesNotThrow(() => assertSetIsCurrent(key, set, coreSha256(body)), key);
    for (const sentence of set.must ?? []) {
      assert.ok(coreOf(body).includes(sentence), `${key}: must-string absent from the committed body: ${sentence}`);
    }
    for (const sentence of set.mustNot ?? []) {
      assert.equal(coreOf(body).includes(sentence), false, `${key}: mustNot-string present in the committed body: ${sentence}`);
    }
  }
});
