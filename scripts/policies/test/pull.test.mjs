// scripts/policies/pull.mjs against a recording fake client and the strict git fake.
//
// Two properties are new and matter most. Pull writes the STAMPED body, so a freshly pulled tree
// is `policies:check`-clean; and pull refuses to overwrite a dirty or repo-ahead body, which is
// what makes bare `policies:pull` safe to run at all. It used to overwrite all five committed
// bodies with no check of any kind.
//
// PULL IS ALSO THE SEEDER, so its own gates must be inert without the state file. A pull that
// required state and a push that required state would deadlock: nothing could ever create the
// file that everything demands.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { check } from '../check.mjs';
import { assertBodiesClean, indexPolicies, run } from '../pull.mjs';
import { POLICY_TYPES, PolicyError, bodyFromFileText, fileNameForType, fileTextFor, coreSha256 } from '../lib/policies.mjs';
import {
  BODIES,
  GIT_ARGV,
  NOW,
  assertTreeUnchanged,
  cleanup,
  liveFrom,
  makeClient,
  makeGitFake,
  makeRoot,
  makeStateDir,
  policiesDir,
  readManifestRaw,
  readPolicy,
  readStateRaw,
  seedState,
  shopPoliciesFrom,
  snapshotTree,
  writeRaw,
  writtenBodyFor,
} from './helpers.mjs';

const ALL_FILES = POLICY_TYPES.map(fileNameForType);

/**
 * A git fake answering "clean" for exactly the files this pull will rewrite.
 *
 * `names` is the argv the gate must emit, matched by deep equality, so the pathspec cannot
 * silently widen to the whole directory (which would refuse on an unrelated edit) or narrow to
 * nothing (which would refuse nothing at all).
 */
function cleanGit(...names) {
  return makeGitFake([{ args: GIT_ARGV.statusFiles(...names), result: '' }]);
}

/** A fake that must never be called: the gate is not expected to reach git on this path. */
function noGit() {
  return makeGitFake([{ args: ['status', '--porcelain', '--', 'never'], result: '' }]);
}

/** An empty checkout: marketing/policies/ exists but holds nothing. */
function emptyRoot() {
  const root = mkdtempSync(join(tmpdir(), 'policies-pull-'));
  mkdirSync(join(root, 'marketing', 'policies'), { recursive: true });
  return root;
}

async function withDirs(fn, { rootOptions } = {}) {
  const root = rootOptions === 'empty' ? emptyRoot() : makeRoot();
  const stateDir = makeStateDir();
  try {
    return await fn(root, stateDir);
  } finally {
    cleanup(root);
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test('run refuses without an injected client, root, timestamp or state directory', async () => {
  await assert.rejects(() => run({ root: '/tmp', now: NOW, stateDir: '/tmp/s' }), /needs an Admin client/);
  await assert.rejects(() => run({ client: { gql: async () => ({}) }, now: NOW, stateDir: '/tmp/s' }), /needs a root/);
  await assert.rejects(() => run({ client: { gql: async () => ({}) }, root: '/tmp', stateDir: '/tmp/s' }), /needs an ISO timestamp/);
  await assert.rejects(() => run({ client: { gql: async () => ({}) }, root: '/tmp', now: NOW }), /needs a state directory/);
});

// ---------------------------------------------------------------------------------------------
// What a pull writes
// ---------------------------------------------------------------------------------------------

test('pull writes all five policies STAMPED, and the result is check-clean', async () => {
  await withDirs(async (root, stateDir) => {
    const client = makeClient({ live: liveFrom() });
    const gitRun = cleanGit(...ALL_FILES);
    const { changed, written, manifestChanged } = await run({ client, root, now: NOW, stateDir, gitRun });
    assert.equal(written.length, 5);
    assert.equal(manifestChanged, true);
    assert.deepEqual(changed.sort(), POLICY_TYPES.map((t) => t.toLowerCase()).sort());
    for (const type of POLICY_TYPES) {
      assert.equal(bodyFromFileText(readPolicy(root, type)), writtenBodyFor(type));
    }
    assert.equal(readPolicy(root, 'SHIPPING_POLICY').startsWith('<!-- sss-policy shipping_policy v1 -->\n'), true);
    assert.equal(readPolicy(root, 'PRIVACY_POLICY').startsWith('<!--'), false, 'the auto-managed policy is never stamped');

    const manifest = JSON.parse(readManifestRaw(root));
    assert.equal(manifest.policies.privacy_policy.writable, false);
    assert.ok(manifest.policies.privacy_policy.reason);
    const { problems, mismatches } = check(root);
    assert.deepEqual(problems, [], 'a freshly pulled tree must be check-clean, stamps and all');
    assert.deepEqual(mismatches, []);
    gitRun.assertExhausted(assert, 'the dirty gate never ran');
  }, { rootOptions: 'empty' });
});

test('pull seeds the observation state, which is what push refuses without', async () => {
  await withDirs(async (root, stateDir) => {
    const client = makeClient({ live: liveFrom() });
    const { stateFile } = await run({ client, root, now: NOW, stateDir, gitRun: cleanGit(...ALL_FILES) });
    assert.ok(stateFile.endsWith('observed.json'));
    const state = readStateRaw(stateDir);
    assert.equal(state.schemaVersion, 1);
    for (const type of POLICY_TYPES) {
      const entry = state.policies[type.toLowerCase()];
      assert.equal(entry.coreSha256, coreSha256(BODIES[type]));
      assert.equal(entry.observedAt, NOW);
    }
  }, { rootOptions: 'empty' });
});

test('pull only reads: it never sends a mutation', async () => {
  await withDirs(async (root, stateDir) => {
    const client = makeClient({ live: liveFrom() });
    await run({ client, root, now: NOW, stateDir, gitRun: cleanGit(...ALL_FILES) });
    assert.deepEqual(client.calls.map((c) => c.kind), ['read']);
  }, { rootOptions: 'empty' });
});

test('a pull of our OWN stamped body is a no-op: the version does not walk up on every pull', async () => {
  await withDirs(async (root, stateDir) => {
    // The state after the first stamped push: live carries the stamp we wrote.
    const live = liveFrom({ ...BODIES, SHIPPING_POLICY: writtenBodyFor('SHIPPING_POLICY') });
    const client = makeClient({ live });
    const first = readManifestRaw(root);
    const result = await run({ client, root, now: '2027-11-11T11:11:11.000Z', stateDir, gitRun: noGit() });
    assert.deepEqual(result.changed, []);
    assert.equal(result.manifestChanged, false);
    assert.equal(readManifestRaw(root), first);
    assert.equal(JSON.parse(first).policies.shipping_policy.version, 1);
  });
});

test('a live body that is stamped AHEAD of the manifest is taken as a wording change', async () => {
  // Someone pushed from another machine, or Admin was edited. The core is what decides, so a
  // higher stamp with the SAME wording changes nothing; a higher stamp with different wording is
  // an ordinary Admin edit and bumps from the manifest's own version.
  await withDirs(async (root, stateDir) => {
    seedState(stateDir);
    const live = liveFrom({
      ...BODIES,
      REFUND_POLICY: `<!-- sss-policy refund_policy v7 -->\n${BODIES.REFUND_POLICY}\n<p>edited elsewhere</p>`,
    });
    await run({ client: makeClient({ live }), root, now: NOW, stateDir, gitRun: cleanGit(fileNameForType('REFUND_POLICY')) });
    const manifest = JSON.parse(readManifestRaw(root));
    assert.equal(manifest.policies.refund_policy.version, 2, 'the version is derived here, never taken from the live stamp');
    assert.equal(readPolicy(root, 'REFUND_POLICY').startsWith('<!-- sss-policy refund_policy v2 -->\n'), true);
    assert.deepEqual(check(root).mismatches, []);
  });
});

test('a live body that is UNSTAMPED against a stamped repo reads as in sync', async () => {
  // The normal state until the first stamped push lands. Comparing whole bodies here would report
  // a permanent repo-ahead for every policy, forever.
  await withDirs(async (root, stateDir) => {
    const result = await run({ client: makeClient({ live: liveFrom() }), root, now: NOW, stateDir, gitRun: noGit(), checkOnly: true });
    assert.deepEqual(result.changed, []);
    assert.equal(result.manifestChanged, false);
  });
});

// ---------------------------------------------------------------------------------------------
// --check
// ---------------------------------------------------------------------------------------------

test('--check reports drift without writing, and is silent on a matching tree', async () => {
  await withDirs(async (root, stateDir) => {
    const clean = await run({ client: makeClient({ live: liveFrom() }), root, now: '2027-01-01T00:00:00.000Z', stateDir, gitRun: noGit(), checkOnly: true });
    assert.deepEqual(clean.changed, []);
    assert.equal(clean.manifestChanged, false);

    const before = snapshotTree(policiesDir(root));
    const drifted = liveFrom({ ...BODIES, REFUND_POLICY: `${BODIES.REFUND_POLICY}\n<p>edited in Admin</p>` });
    const result = await run({ client: makeClient({ live: drifted }), root, now: '2027-01-01T00:00:00.000Z', stateDir, gitRun: noGit(), checkOnly: true });
    assert.deepEqual(result.changed, ['refund_policy']);
    assert.equal(result.written.length, 0);
    assertTreeUnchanged(assert, before, snapshotTree(policiesDir(root)), '--check wrote something');
  });
});

test('--check names the DIRECTION of drift: repo-ahead vs admin-moved', async () => {
  // The bug this pins: the old message told the operator to run `policies:pull` for every drift.
  // In the repo-ahead case that is the destructive action.
  await withDirs(async (root, stateDir) => {
    seedState(stateDir);
    const edited = `<!-- sss-policy shipping_policy v1 -->\n${BODIES.SHIPPING_POLICY}\n<p>a committed wording change</p>`;
    writeRaw(root, fileNameForType('SHIPPING_POLICY'), fileTextFor(edited));
    const ahead = await run({ client: makeClient({ live: liveFrom() }), root, now: NOW, stateDir, gitRun: noGit(), checkOnly: true });
    assert.deepEqual(ahead.changed, ['shipping_policy']);
    assert.equal(ahead.directions.get('shipping_policy'), 'repo-ahead');
  });

  await withDirs(async (root, stateDir) => {
    seedState(stateDir);
    const drifted = liveFrom({ ...BODIES, REFUND_POLICY: `${BODIES.REFUND_POLICY}\n<p>edited in Admin</p>` });
    const moved = await run({ client: makeClient({ live: drifted }), root, now: NOW, stateDir, gitRun: noGit(), checkOnly: true });
    assert.deepEqual(moved.changed, ['refund_policy']);
    assert.equal(moved.directions.get('refund_policy'), 'admin-moved');
  });
});

test('both directions at once are reported separately', async () => {
  await withDirs(async (root, stateDir) => {
    seedState(stateDir);
    writeRaw(root, fileNameForType('SHIPPING_POLICY'), fileTextFor(`<!-- sss-policy shipping_policy v1 -->\n${BODIES.SHIPPING_POLICY}\n<p>local edit</p>`));
    const live = liveFrom({ ...BODIES, REFUND_POLICY: `${BODIES.REFUND_POLICY}\n<p>admin edit</p>` });
    const result = await run({ client: makeClient({ live }), root, now: NOW, stateDir, gitRun: noGit(), checkOnly: true });
    assert.deepEqual([...result.changed].sort(), ['refund_policy', 'shipping_policy']);
    assert.equal(result.directions.get('shipping_policy'), 'repo-ahead');
    assert.equal(result.directions.get('refund_policy'), 'admin-moved');
  });
});

// ---------------------------------------------------------------------------------------------
// The destructive-write gates
// ---------------------------------------------------------------------------------------------

test('a dirty body this pull would overwrite is a refusal, and nothing is written', async () => {
  await withDirs(async (root, stateDir) => {
    seedState(stateDir);
    const before = snapshotTree(policiesDir(root));
    const live = liveFrom({ ...BODIES, REFUND_POLICY: `${BODIES.REFUND_POLICY}\n<p>admin edit</p>` });
    const gitRun = makeGitFake([
      { args: GIT_ARGV.statusFiles(fileNameForType('REFUND_POLICY')), result: ' M marketing/policies/refund_policy.html' },
    ]);
    await assert.rejects(
      () => run({ client: makeClient({ live }), root, now: NOW, stateDir, gitRun }),
      /would OVERWRITE.*Commit or stash/s,
    );
    assertTreeUnchanged(assert, before, snapshotTree(policiesDir(root)), 'a refused pull wrote something');
    gitRun.assertExhausted(assert, 'dirty-body gate');
  });
});

test('a clean tree PROCEEDS, so the gate is not simply always-refuse', async () => {
  await withDirs(async (root, stateDir) => {
    seedState(stateDir);
    const live = liveFrom({ ...BODIES, REFUND_POLICY: `${BODIES.REFUND_POLICY}\n<p>admin edit</p>` });
    const gitRun = cleanGit(fileNameForType('REFUND_POLICY'));
    const { written } = await run({ client: makeClient({ live }), root, now: NOW, stateDir, gitRun });
    assert.equal(written.length, 1);
    gitRun.assertExhausted(assert, 'dirty-body gate');
  });
});

test('the gate asks about ONLY the bodies that would be overwritten', async () => {
  // A dirty file that this pull is not going to touch must not refuse. Deep argv equality is what
  // proves it: an expectation naming all five would fail against a gate that names one.
  await withDirs(async (root, stateDir) => {
    seedState(stateDir);
    const live = liveFrom({ ...BODIES, REFUND_POLICY: `${BODIES.REFUND_POLICY}\n<p>admin edit</p>` });
    const gitRun = cleanGit(fileNameForType('REFUND_POLICY'));
    await run({ client: makeClient({ live }), root, now: NOW, stateDir, gitRun });
    assert.deepEqual(
      gitRun.calls.map((c) => c.args),
      [['status', '--porcelain', '--', 'marketing/policies/refund_policy.html']],
    );
  });
});

test('assertBodiesClean asks git nothing when there is nothing to overwrite', () => {
  // git-fake-not-exhausted: the assertion IS that the expectation goes unused.
  const gitRun = makeGitFake([{ args: ['status', '--porcelain', '--', 'never'], result: '' }]);
  assertBodiesClean('/x', [], { run: gitRun });
  assert.deepEqual(gitRun.calls, []);
});

test('a repo-ahead policy is a refusal when state exists: pulling would destroy the committed edit', async () => {
  await withDirs(async (root, stateDir) => {
    seedState(stateDir);
    const before = snapshotTree(policiesDir(root));
    writeRaw(root, fileNameForType('SHIPPING_POLICY'), fileTextFor(`<!-- sss-policy shipping_policy v1 -->\n${BODIES.SHIPPING_POLICY}\n<p>committed change</p>`));
    await assert.rejects(
      () => run({ client: makeClient({ live: liveFrom() }), root, now: NOW, stateDir, gitRun: noGit() }),
      /the REPO is ahead.*push is outstanding/s,
    );
    // The tree is unchanged apart from the edit the test made itself.
    assert.equal(before.size, snapshotTree(policiesDir(root)).size);
  });
});

test('with no baseline, a WORDING difference refuses rather than guessing which side moved', async () => {
  // The gap the migration test found. Guessing "Admin" here silently reverts a committed wording
  // change, which is the same class of loss the dirty-tree gate exists to prevent, one commit
  // later. `--seed` is the non-destructive way out, and it is what the refusal names.
  await withDirs(async (root, stateDir) => {
    const edited = `<!-- sss-policy shipping_policy v1 -->\n${BODIES.SHIPPING_POLICY}\n<p>committed change</p>`;
    writeRaw(root, fileNameForType('SHIPPING_POLICY'), fileTextFor(edited));
    const before = snapshotTree(policiesDir(root));
    await assert.rejects(
      () => run({ client: makeClient({ live: liveFrom() }), root, now: NOW, stateDir, gitRun: noGit() }),
      /no observation state on this machine.*--seed/s,
    );
    assertTreeUnchanged(assert, before, snapshotTree(policiesDir(root)), 'the no-baseline refusal wrote something');
  });
});

test('a STAMP-ONLY difference is written with no baseline: that is the migration, and it deadlocks otherwise', async () => {
  // Every policy in the migration window differs from live only by its version stamp. If the
  // no-baseline refusal looked at bytes rather than at the core, the seeding pull would refuse
  // and nothing could ever create the file that push demands.
  await withDirs(async (root, stateDir) => {
    // Live is unstamped; the repo is stamped. Same wording, different bytes.
    const gitRun = noGit();
    const result = await run({ client: makeClient({ live: liveFrom() }), root, now: NOW, stateDir, gitRun, checkOnly: true });
    assert.deepEqual(result.changed, [], 'a stamped repo against an unstamped live read as drift');
  });

  await withDirs(async (root, stateDir) => {
    // A body whose STAMP is missing on disk, which is what the migration itself looks like per
    // policy: same wording, different bytes, no baseline. It must be written, not refused.
    writeRaw(root, fileNameForType('REFUND_POLICY'), fileTextFor(BODIES.REFUND_POLICY));
    const gitRun = cleanGit(fileNameForType('REFUND_POLICY'));
    const result = await run({ client: makeClient({ live: liveFrom() }), root, now: NOW, stateDir, gitRun });
    assert.deepEqual(result.changed, ['refund_policy']);
    assert.equal(result.directions.get('refund_policy'), 'stamp-only');
    assert.equal(bodyFromFileText(readPolicy(root, 'REFUND_POLICY')), writtenBodyFor('REFUND_POLICY'));
    gitRun.assertExhausted(assert, 'stamp-only pull');
  });
});

test('--seed writes ONLY the state file, and never one byte of the repo', async () => {
  await withDirs(async (root, stateDir) => {
    const edited = `<!-- sss-policy shipping_policy v1 -->\n${BODIES.SHIPPING_POLICY}\n<p>committed change</p>`;
    writeRaw(root, fileNameForType('SHIPPING_POLICY'), fileTextFor(edited));
    const before = snapshotTree(policiesDir(root));
    const result = await run({ client: makeClient({ live: liveFrom() }), root, now: NOW, stateDir, seedOnly: true, gitRun: noGit() });
    assert.equal(result.seeded, true);
    assert.deepEqual(result.written, []);
    assert.equal(result.manifestChanged, false);
    assertTreeUnchanged(assert, before, snapshotTree(policiesDir(root)), '--seed wrote into the repo');
    assert.equal(readStateRaw(stateDir).policies.shipping_policy.coreSha256, coreSha256(BODIES.SHIPPING_POLICY));
  });
});

test('after --seed, the same policy classifies as repo-ahead rather than undetermined', async () => {
  await withDirs(async (root, stateDir) => {
    const edited = `<!-- sss-policy shipping_policy v1 -->\n${BODIES.SHIPPING_POLICY}\n<p>committed change</p>`;
    writeRaw(root, fileNameForType('SHIPPING_POLICY'), fileTextFor(edited));
    await run({ client: makeClient({ live: liveFrom() }), root, now: NOW, stateDir, seedOnly: true, gitRun: noGit() });
    const result = await run({ client: makeClient({ live: liveFrom() }), root, now: NOW, stateDir, gitRun: noGit(), checkOnly: true });
    assert.equal(result.directions.get('shipping_policy'), 'repo-ahead');
  });
});

test('--discard-local overrides both gates on purpose', async () => {
  await withDirs(async (root, stateDir) => {
    seedState(stateDir);
    writeRaw(root, fileNameForType('SHIPPING_POLICY'), fileTextFor(`<!-- sss-policy shipping_policy v1 -->\n${BODIES.SHIPPING_POLICY}\n<p>committed change</p>`));
    const gitRun = noGit();
    const { written } = await run({ client: makeClient({ live: liveFrom() }), root, now: NOW, stateDir, gitRun, discardLocal: true });
    assert.equal(written.length, 1);
    assert.deepEqual(gitRun.calls, [], '--discard-local must not consult git at all');
    assert.equal(bodyFromFileText(readPolicy(root, 'SHIPPING_POLICY')), writtenBodyFor('SHIPPING_POLICY'));
  });
});

test('--check never consults git: it writes nothing, so there is nothing to guard', async () => {
  await withDirs(async (root, stateDir) => {
    const gitRun = noGit();
    const live = liveFrom({ ...BODIES, REFUND_POLICY: `${BODIES.REFUND_POLICY}\n<p>admin edit</p>` });
    await run({ client: makeClient({ live }), root, now: NOW, stateDir, gitRun, checkOnly: true });
    assert.deepEqual(gitRun.calls, []);
  });
});

// ---------------------------------------------------------------------------------------------
// Input refusals
// ---------------------------------------------------------------------------------------------

test('a type the API omits is a refusal, not a skipped file', async () => {
  await withDirs(async (root, stateDir) => {
    const live = liveFrom();
    delete live.SHIPPING_POLICY;
    await assert.rejects(() => run({ client: makeClient({ live }), root, now: NOW, stateDir, gitRun: noGit() }), (err) => {
      assert.ok(err instanceof PolicyError);
      assert.match(err.message, /SHIPPING_POLICY.*did not return this policy/s);
      return true;
    });
    assert.deepEqual(snapshotTree(policiesDir(root)).size, 0);
  }, { rootOptions: 'empty' });
});

test('a null or empty body is a refusal, not a zero-byte write', async () => {
  for (const body of [null, '', '   \n  ']) {
    await withDirs(async (root, stateDir) => {
      const client = makeClient({ live: { ...liveFrom(), REFUND_POLICY: { title: 'Refund policy', body } } });
      await assert.rejects(() => run({ client, root, now: NOW, stateDir, gitRun: noGit() }), /empty body|did not return/);
      assert.equal(snapshotTree(policiesDir(root)).size, 0, `body ${JSON.stringify(body)} wrote a file`);
    }, { rootOptions: 'empty' });
  }
});

test('a refusal writes nothing at all, including no .tmp residue and no state file', async () => {
  await withDirs(async (root, stateDir) => {
    const before = snapshotTree(policiesDir(root));
    const live = liveFrom();
    delete live.CONTACT_INFORMATION;
    await assert.rejects(() => run({ client: makeClient({ live }), root, now: NOW, stateDir, gitRun: noGit() }));
    assertTreeUnchanged(assert, before, snapshotTree(policiesDir(root)), 'a refused pull wrote something');
    assert.equal(readStateRaw(stateDir), null, 'a refused pull seeded state');
  });
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

test('a body arriving with CRLF and a BOM is written canonical, then stamped', async () => {
  await withDirs(async (root, stateDir) => {
    const live = liveFrom({ ...BODIES, REFUND_POLICY: '﻿<h2>Returns</h2>\r\n<p>a</p>\r\n' });
    await run({ client: makeClient({ live }), root, now: NOW, stateDir, gitRun: cleanGit(...ALL_FILES) });
    const text = readFileSync(join(policiesDir(root), fileNameForType('REFUND_POLICY')), 'utf8');
    assert.equal(text, '<!-- sss-policy refund_policy v1 -->\n<h2>Returns</h2>\n<p>a</p>\n');
    assert.deepEqual(check(root).problems, []);
  }, { rootOptions: 'empty' });
});

test('pull rewrites only the files whose bodies moved', async () => {
  await withDirs(async (root, stateDir) => {
    const live = liveFrom({ ...BODIES, REFUND_POLICY: `${BODIES.REFUND_POLICY}\n<p>new</p>` });
    seedState(stateDir);
    const { written, changed } = await run({
      client: makeClient({ live }),
      root,
      now: '2027-02-02T02:02:02.000Z',
      stateDir,
      gitRun: cleanGit(fileNameForType('REFUND_POLICY')),
    });
    assert.deepEqual(changed, ['refund_policy']);
    assert.equal(written.length, 1);
    const manifest = JSON.parse(readManifestRaw(root));
    assert.equal(manifest.policies.shipping_policy.version, 1, 'an untouched policy must not move');
    assert.equal(manifest.policies.refund_policy.version, 2);
  });
});

test('a bare directory with no manifest is a valid starting point', async () => {
  await withDirs(async (root, stateDir) => {
    await run({ client: makeClient({ live: liveFrom() }), root, now: NOW, stateDir, gitRun: cleanGit(...ALL_FILES) });
    assert.deepEqual(check(root).problems, []);
  }, { rootOptions: 'empty' });
});
