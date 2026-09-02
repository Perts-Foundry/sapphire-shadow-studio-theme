// scripts/policies/pull.mjs against a recording fake client.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { check } from '../check.mjs';
import { indexPolicies, run } from '../pull.mjs';
import { POLICY_TYPES, PolicyError, bodyFromFileText, fileNameForType } from '../lib/policies.mjs';
import {
  BODIES,
  NOW,
  cleanup,
  liveFrom,
  makeClient,
  makeRoot,
  policiesDir,
  readManifestRaw,
  readPolicy,
  shopPoliciesFrom,
  snapshotTree,
  assertTreeUnchanged,
} from './helpers.mjs';

/** An empty checkout: marketing/policies/ exists but holds nothing. */
function emptyRoot() {
  const root = mkdtempSync(join(tmpdir(), 'policies-pull-'));
  mkdirSync(join(root, 'marketing', 'policies'), { recursive: true });
  return root;
}

test('run refuses without an injected client or root, so no test can reach the live store', async () => {
  await assert.rejects(() => run({ root: '/tmp', now: NOW }), /needs an Admin client/);
  await assert.rejects(() => run({ client: { gql: async () => ({}) }, now: NOW }), /needs a root/);
  await assert.rejects(() => run({ client: { gql: async () => ({}) }, root: '/tmp' }), /needs an ISO timestamp/);
});

test('pull writes all five policies, including the non-writable privacy policy', async () => {
  const root = emptyRoot();
  try {
    const client = makeClient({ live: liveFrom() });
    const { changed, written, manifestChanged } = await run({ client, root, now: NOW });
    assert.equal(written.length, 5);
    assert.equal(manifestChanged, true);
    assert.deepEqual(changed.sort(), POLICY_TYPES.map((t) => t.toLowerCase()).sort());
    for (const type of POLICY_TYPES) {
      assert.equal(bodyFromFileText(readPolicy(root, type)), BODIES[type]);
    }
    const manifest = JSON.parse(readManifestRaw(root));
    assert.equal(manifest.policies.privacy_policy.writable, false);
    assert.ok(manifest.policies.privacy_policy.reason);
    const { problems, mismatches } = check(root);
    assert.deepEqual(problems, []);
    assert.deepEqual(mismatches, []);
  } finally {
    cleanup(root);
  }
});

test('pull only reads: it never sends a mutation', async () => {
  const root = emptyRoot();
  try {
    const client = makeClient({ live: liveFrom() });
    await run({ client, root, now: NOW });
    assert.deepEqual(client.calls.map((c) => c.kind), ['read']);
  } finally {
    cleanup(root);
  }
});

test('two pulls with identical bodies produce byte-identical manifests', async () => {
  const root = emptyRoot();
  try {
    const client = makeClient({ live: liveFrom() });
    await run({ client, root, now: NOW });
    const first = readManifestRaw(root);
    // A LATER clock, which is the case that used to churn every entry.
    const second = await run({ client, root, now: '2027-11-11T11:11:11.000Z' });
    assert.equal(readManifestRaw(root), first);
    assert.equal(second.changed.length, 0);
    assert.equal(second.manifestChanged, false);
  } finally {
    cleanup(root);
  }
});

test('--check reports drift without writing, and is silent on a matching tree', async () => {
  const root = makeRoot();
  try {
    const client = makeClient({ live: liveFrom() });
    const clean = await run({ client, root, now: '2027-01-01T00:00:00.000Z', checkOnly: true });
    assert.deepEqual(clean.changed, []);
    assert.equal(clean.manifestChanged, false);

    const before = snapshotTree(policiesDir(root));
    const drifted = liveFrom({ ...BODIES, REFUND_POLICY: `${BODIES.REFUND_POLICY}\n<p>edited in Admin</p>` });
    const client2 = makeClient({ live: drifted });
    const result = await run({ client: client2, root, now: '2027-01-01T00:00:00.000Z', checkOnly: true });
    assert.deepEqual(result.changed, ['refund_policy']);
    assert.equal(result.written.length, 0);
    assertTreeUnchanged(assert, before, snapshotTree(policiesDir(root)), '--check wrote something');
  } finally {
    cleanup(root);
  }
});

test('a type the API omits is a refusal, not a skipped file', async () => {
  const root = emptyRoot();
  try {
    const live = liveFrom();
    delete live.SHIPPING_POLICY;
    const client = makeClient({ live });
    await assert.rejects(() => run({ client, root, now: NOW }), (err) => {
      assert.ok(err instanceof PolicyError);
      assert.match(err.message, /SHIPPING_POLICY.*did not return this policy/s);
      return true;
    });
    assert.deepEqual(snapshotTree(policiesDir(root)).size, 0);
  } finally {
    cleanup(root);
  }
});

test('a null or empty body is a refusal, not a zero-byte write', async () => {
  for (const body of [null, '', '   \n  ']) {
    const root = emptyRoot();
    try {
      const client = makeClient({ live: { ...liveFrom(), REFUND_POLICY: { title: 'Refund policy', body } } });
      await assert.rejects(() => run({ client, root, now: NOW }), /empty body|did not return/);
      assert.equal(snapshotTree(policiesDir(root)).size, 0, `body ${JSON.stringify(body)} wrote a file`);
    } finally {
      cleanup(root);
    }
  }
});

test('a refusal writes nothing at all, including no .tmp residue', async () => {
  const root = makeRoot();
  try {
    const before = snapshotTree(policiesDir(root));
    const live = liveFrom();
    delete live.CONTACT_INFORMATION;
    await assert.rejects(() => run({ client: makeClient({ live }), root, now: NOW }));
    assertTreeUnchanged(assert, before, snapshotTree(policiesDir(root)), 'a refused pull wrote something');
  } finally {
    cleanup(root);
  }
});

test('indexPolicies refuses a duplicate type and a missing title', () => {
  const rows = shopPoliciesFrom(new Map(Object.entries(liveFrom())));
  assert.doesNotThrow(() => indexPolicies(rows));
  assert.throws(() => indexPolicies([...rows, rows[0]]), /two policies of the same type/);
  assert.throws(() => indexPolicies(rows.map((r) => ({ ...r, title: '' }))), /no title/);
});

test('indexPolicies ignores an untracked ShopPolicyType the shop happens to have', () => {
  const rows = shopPoliciesFrom(new Map(Object.entries(liveFrom())));
  const withExtra = [...rows, { id: 'gid://x', type: 'TERMS_OF_SALE', title: 'Sale', body: '<p>x</p>', url: 'u' }];
  const indexed = indexPolicies(withExtra);
  assert.equal(indexed.has('TERMS_OF_SALE'), false);
  assert.equal(indexed.size, POLICY_TYPES.length);
});

test('a body arriving with CRLF and a BOM is written canonical', async () => {
  const root = emptyRoot();
  try {
    const live = liveFrom({ ...BODIES, REFUND_POLICY: `\ufeff<h2>Returns</h2>\r\n<p>a</p>\r\n` });
    await run({ client: makeClient({ live }), root, now: NOW });
    const text = readFileSync(join(policiesDir(root), fileNameForType('REFUND_POLICY')), 'utf8');
    assert.equal(text, '<h2>Returns</h2>\n<p>a</p>\n');
    assert.deepEqual(check(root).problems, []);
  } finally {
    cleanup(root);
  }
});

test('pull rewrites only the files whose bodies moved', async () => {
  const root = makeRoot();
  try {
    const live = liveFrom({ ...BODIES, REFUND_POLICY: `${BODIES.REFUND_POLICY}\n<p>new</p>` });
    const { written, changed } = await run({ client: makeClient({ live }), root, now: '2027-02-02T02:02:02.000Z' });
    assert.deepEqual(changed, ['refund_policy']);
    assert.equal(written.length, 1);
    const manifest = JSON.parse(readManifestRaw(root));
    // The untouched entries keep their original timestamps; only the changed one moves.
    assert.equal(manifest.policies.shipping_policy.pulledAt, NOW);
    assert.equal(manifest.policies.refund_policy.pulledAt, '2027-02-02T02:02:02.000Z');
  } finally {
    cleanup(root);
  }
});

test('a bare directory with no manifest is a valid starting point', async () => {
  const root = emptyRoot();
  try {
    await run({ client: makeClient({ live: liveFrom() }), root, now: NOW });
    assert.deepEqual(check(root).problems, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
