// The migration, as one sequence rather than as five separate properties.
//
// PR A deletes `remote` and `pulledAt` from the manifest. After it merges, the operator runs
// `npm run policies:pull` once to seed the machine-local state, and until they do, push does not
// work. That window is deliberate and is stated in the PR description; this file is what proves
// the window behaves as described rather than as a puzzle.
//
// Two starting points, because they are different states with different first refusals:
//
//   THE MIGRATION WINDOW is `main` right after PR A merges: the manifest is migrated, the bodies
//   are stamped, the live store is unstamped, and no machine has an observation yet. Push refuses
//   at the state gate, naming `npm run policies:pull` verbatim.
//
//   A STALE BRANCH is one opened before PR A: the old manifest shape, unstamped bodies. `check`
//   is what refuses there, not the state gate, and one pull repairs the whole checkout.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { check } from '../check.mjs';
import { run as pullRun } from '../pull.mjs';
import { run as pushRun } from '../push.mjs';
import { SEED_COMMAND, readState } from '../lib/state.mjs';
import { POLICY_TYPES, coreSha256, fileNameForType, keyForType, parseVersionStamp, sha256 } from '../lib/policies.mjs';
import {
  BODIES,
  GIT_ARGV,
  assertTreeUnchanged,
  NOW,
  cleanup,
  liveFrom,
  makeClient,
  makeGitFake,
  makeRoot,
  makeStateDir,
  policiesDir,
  readManifestRaw,
  snapshotTree,
  writeRaw,
} from './helpers.mjs';

/** A git fake that must never be called: this path is not expected to reach the dirty gate. */
function noGit() {
  // git-fake-not-exhausted: the point is that the gate never runs.
  return makeGitFake([{ args: ['status', '--porcelain', '--', 'never'], result: '' }]);
}

const ALL_FILES = POLICY_TYPES.map(fileNameForType);
/** The four the migration restamps. The privacy policy is unstamped, so its bytes do not move. */
const STAMPED_FILES = POLICY_TYPES.filter((t) => t !== 'PRIVACY_POLICY').map(fileNameForType);

/**
 * A checkout in the PRE-MIGRATION shape, as a branch opened before PR A still holds it: `remote`
 * and `pulledAt` present, none of `version`, `coreSha256` or `stamped`, and UNSTAMPED bodies.
 */
function preMigrationRoot() {
  const root = makeRoot();
  const file = join(policiesDir(root), 'manifest.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  for (const type of POLICY_TYPES) {
    const key = keyForType(type);
    const entry = manifest.policies[key];
    delete entry.version;
    delete entry.coreSha256;
    delete entry.stamped;
    // Pre-migration bodies carry no stamp, so the hashes are over the bare body.
    const body = BODIES[type];
    entry.sha256 = coreSha256(body);
    entry.length = body.length;
    entry.remote = { sha256: coreSha256(body), length: body.length, observedAt: NOW };
    entry.pulledAt = NOW;
    writeRaw(root, fileNameForType(type), `${body}\n`);
  }
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return root;
}

/** The push options a bare `--type <policy>` dry run produces. */
function dryRunOptions(type = 'SHIPPING_POLICY') {
  return {
    type,
    confirm: null,
    expectLiveSha: null,
    restore: null,
    restoreRecord: null,
    root: null,
    acceptNormalisation: false,
    forceOverwriteLive: false,
    allowUnreviewed: false,
    operatorApproved: false,
  };
}

function pushArgs({ root, stateDir, backupDir, client, log = () => {}, options = dryRunOptions() }) {
  return { client, root, now: NOW, stateDir, backupDir, domain: 'example.myshopify.com', log, sleep: async () => {}, options };
}

test('THE MIGRATION WINDOW: a migrated repo with no state file, seeded by one pull', async () => {
  // This is `main` the moment PR A merges: the manifest is migrated and the bodies are stamped,
  // but no machine has an observation yet. Push does not work until the operator runs one pull.
  // That window is deliberate, and stating it in the PR description is what makes it deliberate
  // rather than discovered.
  const root = makeRoot();
  const stateDir = makeStateDir();
  const backupDir = makeStateDir();
  try {
    // ---- Preconditions, asserted rather than assumed -------------------------------------
    assert.deepEqual(check(root).mismatches, [], 'the fixture is not a migrated, check-clean tree');
    assert.equal(readState({ dir: stateDir }), null, 'the fixture already has state');
    assert.ok(parseVersionStamp(readFileSync(join(policiesDir(root), 'shipping_policy.html'), 'utf8')), 'the repo bodies are not stamped');
    const live = liveFrom();
    assert.equal(parseVersionStamp(live.SHIPPING_POLICY.body), null, 'live must be unstamped: no stamped push has landed');

    // ---- 1. push refuses, naming the seeding command VERBATIM ----------------------------
    // A pending wording change, restamped and committed, so the push has something to send and
    // step 3's "already in sync" short-circuit does not fire before the state gate.
    const newCore = `${BODIES.SHIPPING_POLICY}\n<p>a wording change</p>`;
    const newBody = `<!-- sss-policy shipping_policy v2 -->\n${newCore}`;
    const restamped = JSON.parse(readManifestRaw(root));
    restamped.policies.shipping_policy.version = 2;
    restamped.policies.shipping_policy.coreSha256 = coreSha256(newCore);
    restamped.policies.shipping_policy.sha256 = sha256(newBody);
    restamped.policies.shipping_policy.length = newBody.length;
    writeRaw(root, 'manifest.json', `${JSON.stringify(restamped, null, 2)}\n`);
    writeRaw(root, fileNameForType('SHIPPING_POLICY'), `${newBody}\n`);
    assert.deepEqual(check(root).mismatches, [], 'the restamped tree is not check-clean');

    const pushClient = makeClient({ live });
    await assert.rejects(
      () => pushRun(pushArgs({ root, stateDir, backupDir, client: pushClient })),
      (err) => {
        assert.match(err.message, /no observation state/);
        assert.ok(err.message.includes(SEED_COMMAND), `the refusal must name "${SEED_COMMAND}" verbatim`);
        return true;
      },
    );
    assert.equal(pushClient.calls.filter((c) => c.kind === 'mutate').length, 0);

    // ---- 2. a BARE pull refuses too, rather than silently reverting the wording change -----
    // Without a baseline there is no way to tell whether the repo moved or Admin did, and
    // guessing "Admin" is exactly how a merged wording change disappears.
    // git-fake-not-exhausted: the refusal lands before the dirty gate, which is the assertion.
    const bareGit = makeGitFake([{ args: GIT_ARGV.statusFiles(fileNameForType('SHIPPING_POLICY')), result: '' }]);
    await assert.rejects(
      () => pullRun({ client: makeClient({ live }), root, now: NOW, stateDir, gitRun: bareGit }),
      /no observation state on this machine.*--seed/s,
    );
    assert.deepEqual(bareGit.calls, [], 'the no-baseline refusal must land before the dirty gate');
    assert.equal(readFileSync(join(policiesDir(root), fileNameForType('SHIPPING_POLICY')), 'utf8'), `${newBody}\n`);

    // ---- 3. --seed writes the baseline and NOT ONE BYTE of the repo -------------------------
    const treeBefore = snapshotTree(policiesDir(root));
    const seed = await pullRun({ client: makeClient({ live }), root, now: NOW, stateDir, seedOnly: true, gitRun: noGit() });
    assert.equal(seed.seeded, true);
    assert.deepEqual(seed.written, []);
    assertTreeUnchanged(assert, treeBefore, snapshotTree(policiesDir(root)), '--seed wrote into the repo');
    assert.equal(readState({ dir: stateDir }).policies.shipping_policy.coreSha256, coreSha256(BODIES.SHIPPING_POLICY));

    // ---- 4. check is clean, and the dry run now proceeds ------------------------------------
    const { problems, mismatches } = check(root);
    assert.deepEqual(problems, []);
    assert.deepEqual(mismatches, []);

    const dryLines = [];
    const dry = await pushRun(pushArgs({ root, stateDir, backupDir, client: makeClient({ live }), log: (s) => dryLines.push(s) }));
    assert.equal(dry.reason, 'dry-run', 'the dry run did not proceed after the baseline was seeded');
    assert.ok(dryLines.join('\n').includes(`--expect-live-sha=${dry.liveCore}`));
    assert.ok(dryLines.join('\n').includes('v2'));
  } finally {
    cleanup(root);
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
  }
});

test('THE ORDINARY MIGRATION: repo and Admin agree, so one plain pull seeds and changes nothing', async () => {
  // The case the PR description describes: `main` right after PR A merges, with no wording change
  // outstanding. Nothing differs, so the no-baseline refusal cannot fire and cannot deadlock.
  const root = makeRoot();
  const stateDir = makeStateDir();
  try {
    const treeBefore = snapshotTree(policiesDir(root));
    // git-fake-not-exhausted: nothing differs, so the gate has nothing to ask about.
    const gitRun = makeGitFake([{ args: GIT_ARGV.statusFiles(...ALL_FILES), result: '' }]);
    const pull = await pullRun({ client: makeClient({ live: liveFrom() }), root, now: NOW, stateDir, gitRun });
    assert.deepEqual(pull.changed, []);
    assert.deepEqual(gitRun.calls, [], 'the gate ran with nothing to overwrite');
    assert.equal(pull.manifestChanged, false);
    assertTreeUnchanged(assert, treeBefore, snapshotTree(policiesDir(root)), 'the seeding pull rewrote the repo');
    assert.ok(readState({ dir: stateDir }));
    assert.deepEqual(check(root).mismatches, []);
  } finally {
    cleanup(root);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('A STALE BRANCH: a pre-migration manifest refuses at check FIRST, and one pull repairs it', async () => {
  // Every branch opened before PR A carries the old shape. `check` is what fires, not the state
  // gate, and its summary must name the command that actually fixes it.
  const root = preMigrationRoot();
  const stateDir = makeStateDir();
  const backupDir = makeStateDir();
  try {
    const { mismatches } = check(root);
    assert.ok(mismatches.some((m) => m.includes('version is undefined')));
    assert.ok(mismatches.some((m) => m.includes('coreSha256')));

    const client = makeClient({ live: liveFrom() });
    await assert.rejects(
      () => pushRun(pushArgs({ root, stateDir, backupDir, client })),
      /policies:check: is not clean/,
    );
    assert.deepEqual(client.calls, [], 'the client was touched before the repo gate passed');

    // Only the four STAMPED bodies change: the unstamped privacy policy is already byte-identical
    // to what a pull would write, so the gate must not ask about it. Deep argv equality is what
    // proves that, and the strict fake is what makes the proof possible.
    const gitRun = makeGitFake([{ args: GIT_ARGV.statusFiles(...STAMPED_FILES), result: '' }]);
    await pullRun({ client: makeClient({ live: liveFrom() }), root, now: NOW, stateDir, gitRun });
    gitRun.assertExhausted(assert, 'the pre-migration pull');
    assert.deepEqual(check(root).mismatches, [], 'one pull did not repair a pre-migration checkout');

    const after = JSON.parse(readManifestRaw(root));
    for (const type of POLICY_TYPES) {
      const entry = after.policies[keyForType(type)];
      assert.equal('remote' in entry, false, `${type}: remote survived the migration`);
      assert.equal('pulledAt' in entry, false, `${type}: pulledAt survived the migration`);
      assert.equal(entry.version, 1, `${type}: version`);
      assert.equal(entry.coreSha256, coreSha256(BODIES[type]), `${type}: coreSha256`);
      assert.equal(typeof entry.stamped, 'boolean', `${type}: stamped`);
    }
    assert.equal(after.policies.privacy_policy.stamped, false);
  } finally {
    cleanup(root);
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
  }
});

test('a HALF-MIGRATED manifest (a leftover remote field) is IGNORED, not refused', async () => {
  // Every open branch carries the old shape the moment PR A merges, and a rebase can leave one
  // field behind. Pinned in both directions on purpose: `check` must not refuse it, because a
  // refusal would turn CI red on branches nobody has touched; and the next `pull` deletes it, so
  // the leftover cannot survive.
  const root = makeRoot();
  const stateDir = makeStateDir();
  try {
    const file = join(policiesDir(root), 'manifest.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.policies.refund_policy.remote = { sha256: 'a'.repeat(64), length: 1, observedAt: NOW };
    manifest.policies.refund_policy.pulledAt = NOW;
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const { problems, mismatches } = check(root);
    assert.deepEqual(problems, [], 'a leftover observation field turned check red');
    assert.deepEqual(mismatches, []);

    // git-fake-not-exhausted: only the manifest shape moves here, no body.
    const gitRun = makeGitFake([{ args: GIT_ARGV.statusFiles(...ALL_FILES), result: '' }]);
    await pullRun({ client: makeClient({ live: liveFrom() }), root, now: NOW, stateDir, gitRun });
    const after = JSON.parse(readManifestRaw(root)).policies.refund_policy;
    assert.equal('remote' in after, false, 'the next pull must delete the leftover');
    assert.equal('pulledAt' in after, false);
  } finally {
    cleanup(root);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('reverting the migration is survivable: an orphan state file is harmless', async () => {
  // The rollback path, recorded in release-notes.md: revert the PR, delete observed.json. A
  // stamped live body is harmless afterwards because every comparison runs on the core.
  const stateDir = makeStateDir();
  const root = makeRoot();
  try {
    // git-fake-not-exhausted: repo and Admin agree, so no body is overwritten.
    const gitRun = makeGitFake([{ args: GIT_ARGV.statusFiles(...ALL_FILES), result: '' }]);
    await pullRun({ client: makeClient({ live: liveFrom() }), root, now: NOW, stateDir, gitRun });
    assert.ok(readState({ dir: stateDir }));
    rmSync(join(stateDir, 'observed.json'));
    assert.equal(readState({ dir: stateDir }), null, 'deleting observed.json must leave a clean absent state');
    // And a live body carrying a stamp still reads as in sync against an unstamped repo core.
    const stampedLive = liveFrom({ ...BODIES, SHIPPING_POLICY: `<!-- sss-policy shipping_policy v9 -->\n${BODIES.SHIPPING_POLICY}` });
    const result = await pullRun({ client: makeClient({ live: stampedLive }), root, now: NOW, stateDir, gitRun: noGit(), checkOnly: true });
    assert.deepEqual(result.changed, [], 'a stamped live body read as drift against a stamped repo core');
  } finally {
    cleanup(root);
    rmSync(stateDir, { recursive: true, force: true });
  }
});
