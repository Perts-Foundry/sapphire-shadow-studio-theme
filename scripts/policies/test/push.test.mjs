// scripts/policies/push.mjs: the only tool here that can change what a customer reads.
//
// The gates are the product, so each one gets a named case. Refusals are proved to have written
// nothing by comparing a byte snapshot of the tree before and after.
//
// WHAT A FAKE CLIENT CANNOT PROVE, and what these tests therefore do NOT claim: the mutation's
// actual input shape against a live schema, token minting and scopes, Shopify's real refusal for
// the auto-managed policy, Shopify's actual normalisation, and idempotency. See
// marketing/policies/README.md, "What the tests do not prove".

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import {
  COMMIT_HINT,
  PUSH_MUTATION,
  PUSH_SCOPES,
  SUCCESS_MARKER,
  assertInteractive,
  assertReviewedTree,
  loadRestore,
  main,
  parseArgs,
  resolveType,
  run,
  writeBackup,
} from '../push.mjs';
import { check } from '../check.mjs';
import { FILE_MODE } from '../lib/backups.mjs';
import { SEED_COMMAND } from '../lib/state.mjs';
import { PolicyError, bodyFromFileText, canonicalise, coreOf, coreSha256, fileTextFor, formatManifest, stampVersion } from '../lib/policies.mjs';
import {
  BODIES,
  GIT_ARGV,
  NOW,
  UnexpectedGitInvocation,
  assertAllGitFakesExhausted,
  assertTreeUnchanged,
  cleanup,
  liveFrom,
  makeClient,
  makeGitFake,
  makeRoot,
  makeStateDir,
  readStateRaw,
  seedState,
  policiesDir,
  readManifestRaw,
  readPolicy,
  snapshotTree,
  writeRaw,
  writtenBodyFor,
} from './helpers.mjs';

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The repo body after a wording edit: the CORE of what a push exists to send. */
const EDITED = `${BODIES.SHIPPING_POLICY}\n<p>Most orders ship within 3-5 business days.</p>`;

/** What `editedRoot` actually puts on disk and therefore sends: the edit, stamped at v2. */
const EDITED_STAMPED = `<!-- sss-policy shipping_policy v2 -->\n${EDITED}`;

function backupDir() {
  return mkdtempSync(join(tmpdir(), 'policies-backup-'));
}

const STATE_DIRS = [];
after(() => {
  for (const d of STATE_DIRS) cleanup(d);
});

/**
 * A machine-local state directory recording exactly what `live` holds. The ordinary precondition
 * for a push: this machine has pulled, so the freshness gate has a baseline to compare against.
 */
function stateDir(live = liveFrom(), extra) {
  const dir = makeStateDir();
  STATE_DIRS.push(dir);
  seedState(dir, { live, extra });
  return dir;
}

/** A state directory with no file in it at all: a fresh clone, or the migration window. */
function emptyStateDir() {
  const dir = makeStateDir();
  STATE_DIRS.push(dir);
  return dir;
}

/**
 * A root whose shipping policy has been edited, restamped and committed, exactly as a merged
 * wording-change PR would leave it: the body carries v2, and the manifest agrees.
 */
function editedRoot(core = EDITED) {
  const root = makeRoot();
  const body = `<!-- sss-policy shipping_policy v2 -->\n${core}`;
  writeRaw(root, 'shipping_policy.html', fileTextFor(body));
  const file = join(policiesDir(root), 'manifest.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const entry = manifest.policies.shipping_policy;
  entry.version = 2;
  entry.coreSha256 = sha(core);
  entry.sha256 = sha(body);
  entry.length = body.length;
  entry.headings = headingsOf(core);
  writeFileSync(file, formatManifest(manifest), 'utf8');
  return root;
}

function headingsOf(body) {
  // Deliberately not the library's extractHeadings: a fixture builder that shares the code under
  // test cannot catch the code under test being wrong.
  const out = [];
  const re = /<(h[23])[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    const level = Number(m[1][1]);
    const text = m[2].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').trim();
    if (text === '') continue;
    out.push({
      level,
      text,
      id: level === 2 ? (text.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50).replace(/^-+|-+$/g, '') || 'section') : null,
    });
  }
  return out;
}

/**
 * The invariant for a refusal that happens AFTER the mutation landed: the repo BODY is untouched,
 * but the machine-local state records what Admin now holds. A blanket assertTreeUnchanged is
 * wrong here, and asserting it was what hid the unreachable `--accept-normalisation` recovery:
 * leaving the observation stale sends the re-run into the freshness gate and on to
 * --force-overwrite-live.
 */
function assertBodyUntouchedObservationRecorded(root, sdir, expectedBody, storedBody) {
  assert.equal(bodyFromFileText(readPolicy(root, 'SHIPPING_POLICY')), expectedBody, 'the repo body moved');
  const entry = JSON.parse(readManifestRaw(root)).policies.shipping_policy;
  assert.equal(entry.sha256, sha(expectedBody), 'the manifest body hash moved');
  const observed = readStateRaw(sdir).policies.shipping_policy;
  assert.equal(observed.coreSha256, coreSha256(storedBody), 'the observation does not record what Admin holds');
}

const BASE = { now: NOW, domain: 'example.myshopify.com', log: () => {}, sleep: async () => {} };

function options(overrides = {}) {
  return { ...parseArgs([]), type: 'SHIPPING_POLICY', ...overrides };
}

// ---------------------------------------------------------------------------------------------
// Step 1: argument parsing and the interactive gate
// ---------------------------------------------------------------------------------------------

test('parseArgs accepts both --flag value and --flag=value', () => {
  const a = parseArgs(['--type', 'shipping_policy', '--confirm=shipping_policy', '--expect-live-sha', 'abc']);
  assert.equal(a.type, 'shipping_policy');
  assert.equal(a.confirm, 'shipping_policy');
  assert.equal(a.expectLiveSha, 'abc');
});

test('parseArgs refuses an unknown flag and a flag with no value', () => {
  assert.throws(() => parseArgs(['--nope']), PolicyError);
  assert.throws(() => parseArgs(['--type']), /expects a value/);
});

test('resolveType refuses a missing type, an unknown type, and the auto-managed privacy policy', () => {
  assert.throws(() => resolveType(null), /--type: required/);
  assert.throws(() => resolveType('terms_of_sale'), /not a tracked policy/);
  assert.throws(() => resolveType('privacy_policy'), /not writable/);
  assert.equal(resolveType('shipping_policy'), 'SHIPPING_POLICY');
  assert.equal(resolveType('SHIPPING_POLICY'), 'SHIPPING_POLICY');
});

test('the operator gate: CI is an ABSOLUTE refusal, which no flag overrides', () => {
  // The blast-radius boundary. If this ever becomes overridable, CI can rewrite a legal policy.
  assert.throws(() => assertInteractive({ env: { CI: 'true' }, isTTY: true }), /with CI set/);
  assert.throws(() => assertInteractive({ env: { CI: 'true' }, isTTY: false }), /with CI set/);
  assert.throws(
    () => assertInteractive({ env: { CI: 'true' }, isTTY: true, operatorApproved: true }),
    /no flag overrides this/,
  );
  assert.throws(
    () => assertInteractive({ env: { CI: '1' }, isTTY: false, operatorApproved: true }),
    /with CI set/,
  );
});

test('A DRY RUN NEEDS NO TERMINAL: gating it made the documented sequence unreachable', () => {
  // The rule an agent must satisfy is "the operator asked, after seeing the dry run". Gating the
  // dry run on a TTY meant the dry run needed the attestation that the rule says can only come
  // after it, so every real run passed --operator-approved at a moment when nothing had been
  // attested. That teaches exactly the wrong thing about the flag.
  assert.deepEqual(assertInteractive({ env: {}, isTTY: false, mutating: false }), { via: 'dry-run' });
  assert.deepEqual(assertInteractive({ env: {}, isTTY: false, operatorApproved: false, mutating: false }), { via: 'dry-run' });
});

test('but CI is still absolute for a dry run: the boundary is the credential, not the write', () => {
  assert.throws(() => assertInteractive({ env: { CI: '1' }, isTTY: false, mutating: false }), /refuses to run with CI set/);
  assert.throws(
    () => assertInteractive({ env: { CI: '1' }, isTTY: true, operatorApproved: true, mutating: false }),
    /refuses to run with CI set/,
  );
});

test('a TTY satisfies the gate, and so does --operator-approved without one', () => {
  assert.deepEqual(assertInteractive({ env: {}, isTTY: true }), { via: 'tty' });
  assert.deepEqual(assertInteractive({ env: {}, isTTY: false, operatorApproved: true }), { via: 'operator-approval' });
  assert.deepEqual(assertInteractive({ env: {}, isTTY: true, operatorApproved: true }), { via: 'tty' });
});

test('no TTY and no attestation still refuses, and the message names the flag, not a pty', () => {
  // The failure mode this replaced: an agent hits the refusal and reaches for `script -qc`. The
  // message has to offer the supported route in the same breath as it refuses.
  assert.throws(
    () => assertInteractive({ env: {}, isTTY: false }),
    (err) => {
      assert.match(err.message, /without a TTY/);
      assert.match(err.message, /--operator-approved/);
      assert.match(err.message, /Do NOT wrap the command in a pty/);
      return true;
    },
  );
});

test('--operator-approved is parsed as a boolean and defaults to false', () => {
  assert.equal(parseArgs([]).operatorApproved, false);
  assert.equal(parseArgs(['--operator-approved']).operatorApproved, true);
  // It attests that a human asked; it does NOT name a policy, so it cannot authorize a write on
  // its own. --confirm=<type> and --expect-live-sha still decide what gets written.
  assert.equal(parseArgs(['--operator-approved']).confirm, null);
  assert.equal(parseArgs(['--operator-approved']).expectLiveSha, null);
});

test('main: a DRY RUN runs with no TTY and no attestation, and says nothing about an operator', async () => {
  // The end-to-end half of the same property, and the assertion that the attestation line is NOT
  // printed: a dry run over which nobody was asked must leave no sentence in the transcript that a
  // later agent, or the same agent after a compaction, could read as evidence that they were.
  const { code, out, err } = await runMain(['--type', 'shipping_policy']);
  assert.equal(out.includes('an operator asked for this write'), false, 'a dry run claimed an operator asked');
  assert.equal(err.includes('refuses to run without a TTY'), false, 'the dry run was refused for want of a terminal');
  // It gets as far as constructing the client, which fails here for want of credentials.
  assert.equal(code, 1);
  assert.match(err, /MYSHOPIFY_DOMAIN/);
});

test('main: a run carrying --confirm still refuses without a TTY or the attestation', async () => {
  const { code, err } = await runMain(['--type', 'shipping_policy', '--confirm=shipping_policy', '--expect-live-sha=x']);
  assert.equal(code, 1);
  assert.match(err, /refuses to run without a TTY/);
  assert.match(err, /--operator-approved/);
});

test('the dry run prints a re-run command that carries EVERY flag it was given', async () => {
  // Carrying only the attestation would propagate the one flag asserting a human decision while
  // dropping the ones recording WHICH decision, so the printed command would be refused by the
  // gate the operator had already been past, at the moment an agent is most inclined to re-add a
  // flag on its own judgment.
  const root = editedRoot();
  const dir = backupDir();
  const sdir = stateDir();
  const lines = [];
  try {
    const result = await run({
      ...BASE,
      log: (s) => lines.push(s),
      client: makeClient({ live: liveFrom() }),
      root,
      backupDir: dir, stateDir: sdir,
      options: options({ operatorApproved: true, allowUnreviewed: true, acceptNormalisation: true }),
    });
    assert.equal(result.reason, 'dry-run');
    const printed = lines.find((l) => l.includes('npm run policies:push --'));
    assert.ok(printed, 'no re-run command was printed');
    for (const flag of ['--operator-approved', '--allow-unreviewed', '--accept-normalisation']) {
      assert.ok(printed.includes(flag), `the printed re-run dropped ${flag}:\n${printed}`);
    }
    assert.equal(printed.includes('--force-overwrite-live'), false, 'a flag that was NOT passed was invented');
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('a dry run given no flags prints a command with none, so nothing is invented', async () => {
  const root = editedRoot();
  const dir = backupDir();
  const sdir = stateDir();
  const lines = [];
  try {
    await run({ ...BASE, log: (s) => lines.push(s), client: makeClient({ live: liveFrom() }), root, backupDir: dir, stateDir: sdir, options: options() });
    const printed = lines.find((l) => l.includes('npm run policies:push --'));
    for (const flag of ['--operator-approved', '--force-overwrite-live', '--allow-unreviewed', '--accept-normalisation']) {
      assert.equal(printed.includes(flag), false, `the printed re-run invented ${flag}`);
    }
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('--operator-approved does not weaken any gate that decides WHAT is written', async () => {
  const root = editedRoot();
  const dir = backupDir();
  const sdir = stateDir();
  try {
    const client = makeClient({ live: liveFrom() });
    const base = { ...BASE, client, root, backupDir: dir, stateDir: sdir, stateDir: sdir };
    const approved = (o) => options({ operatorApproved: true, ...o });
    // Still a dry run without --confirm.
    const dry = await run({ ...base, options: approved() });
    assert.equal(dry.mutated, false);
    assert.equal(dry.reason, 'dry-run');
    // Still refuses a mismatched --confirm and a missing/stale --expect-live-sha.
    await assert.rejects(() => run({ ...base, options: approved({ confirm: 'true' }) }), /must be exactly/);
    await assert.rejects(() => run({ ...base, options: approved({ confirm: 'shipping_policy' }) }), /--expect-live-sha: required/);
    await assert.rejects(
      () => run({ ...base, options: approved({ confirm: 'shipping_policy', expectLiveSha: 'stale' }) }),
      /changed since the dry run/,
    );
    assert.equal(client.calls.filter((c) => c.kind === 'mutate').length, 0);
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('no workflow wires policies:push', () => {
  // A legal-policy write is an operator action. If a workflow ever calls it, the CI gate would be
  // holding write_legal_policies credentials, which is the blast radius this subsystem avoids.
  const dir = new URL('../../../.github/workflows/', import.meta.url);
  for (const name of readdirSync(dir)) {
    // Whole-line `#` comments are stripped first: validate.yml carries a comment saying not to add
    // `policies:pull --check` there, and a bare substring match would read that warning as the
    // violation it warns against.
    const text = readFileSync(new URL(name, dir), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    assert.equal(text.includes('policies:push'), false, `${name} invokes policies:push`);
    assert.equal(text.includes('policies:pull'), false, `${name} invokes policies:pull, which needs secrets`);
  }
});

// ---------------------------------------------------------------------------------------------
// Step 2: repo gates
// ---------------------------------------------------------------------------------------------

test('ANY dirty file under marketing/policies/ is a refusal, manifest included', () => {
  // The gate went back to one question with one answer. It used to carry a per-field exemption
  // for `remote` and `pulledAt`, because a successful push wrote those into the manifest and so
  // blocked the next push on its own side effect: a PR per push, forever. Those fields live in
  // the machine-local state file now, so the exemption, and the HEAD read and JSON reshape it
  // needed, are gone. Do not reintroduce them.
  for (const dirty of [
    ' M marketing/policies/shipping_policy.html',
    ' M marketing/policies/manifest.json',
    '?? marketing/policies/legal_notice.html',
  ]) {
    const fakeGit = makeGitFake([{ args: GIT_ARGV.statusDir, result: dirty }]);
    assert.throws(() => assertReviewedTree('/x', { run: fakeGit }), /has uncommitted changes/, dirty);
    fakeGit.assertExhausted(assert, `dirty gate for ${dirty}`);
  }
});

test('the dirty gate reads git ONCE, and never reads HEAD to compare a manifest', () => {
  const fakeGit = makeGitFake([
    { args: GIT_ARGV.statusDir, result: '' },
    { args: GIT_ARGV.revParseHead, result: 'aaa' },
    { args: GIT_ARGV.revParseBase, result: 'bbb' },
    { args: GIT_ARGV.isAncestor('aaa', 'bbb'), result: '' },
  ]);
  assert.deepEqual(assertReviewedTree('/x', { run: fakeGit }), { unreviewed: false });
  fakeGit.assertExhausted(assert, 'clean path');
  assert.equal(
    fakeGit.calls.some((c) => c.args[0] === 'show'),
    false,
    'the gate read HEAD to reshape a manifest; that machinery was deleted on purpose',
  );
});

test('HEAD not an ancestor of origin/main is a refusal', () => {
  const fakeGit = makeGitFake([
    { args: GIT_ARGV.statusDir, result: '' },
    { args: GIT_ARGV.revParseHead, result: 'aaa' },
    { args: GIT_ARGV.revParseBase, result: 'bbb' },
    { args: GIT_ARGV.isAncestor('aaa', 'bbb'), throws: new Error('not an ancestor') },
  ]);
  assert.throws(() => assertReviewedTree('/x', { run: fakeGit }), /not an ancestor of origin\/main/);
  fakeGit.assertExhausted(assert, 'ancestor refusal');
});

test('--allow-unreviewed is the escape hatch, and it never reaches the ancestor check at all', () => {
  // Registering the rev-parse argvs and asserting they went UNUSED is the point: an
  // `--allow-unreviewed` that still resolved refs would be a different tool from the one
  // documented, and a permissive fake could not tell the difference.
  const fakeGit = makeGitFake([{ args: GIT_ARGV.statusDir, result: '' }]);
  assert.deepEqual(assertReviewedTree('/x', { run: fakeGit, allowUnreviewed: true }), { unreviewed: true });
  fakeGit.assertExhausted(assert, 'allow-unreviewed path');
  assert.deepEqual(
    fakeGit.calls.map((c) => c.args),
    [GIT_ARGV.statusDir],
    '--allow-unreviewed resolved a ref it should never have touched',
  );
});

test('--allow-unreviewed waives the ancestor check, never the dirty-body check', () => {
  const fakeGit = makeGitFake([
    { args: GIT_ARGV.statusDir, result: '?? marketing/policies/x.html' },
  ]);
  assert.throws(
    () => assertReviewedTree('/x', { run: fakeGit, allowUnreviewed: true }),
    /has uncommitted changes/,
  );
  fakeGit.assertExhausted(assert, 'allow-unreviewed dirty body');
});

test('the git fake refuses an argv nobody registered, rather than defaulting to ""', () => {
  // The meta-guard on the guard. If this ever returns a value instead of throwing, every gate
  // test in this file silently becomes a test of the fake.
  const fakeGit = makeGitFake([{ args: ['status', '--porcelain'], result: '' }], {
    exhaustive: false,
    why: 'this fake is the subject of the test; its expectation is never meant to be invoked',
  });
  assert.throws(
    () => fakeGit('/x', GIT_ARGV.statusDir),
    (err) => err.name === 'UnexpectedGitInvocation' && err instanceof UnexpectedGitInvocation,
  );
});

test('assertExhausted fails when a registered expectation was never invoked', () => {
  const fakeGit = makeGitFake(
    [
      { args: GIT_ARGV.statusDir, result: '' },
      { args: GIT_ARGV.revParseHead, result: 'aaa' },
    ],
    { exhaustive: false, why: 'this test IS the unused-expectation case; leaving one unused is the point' },
  );
  fakeGit('/x', GIT_ARGV.statusDir);
  assert.throws(() => fakeGit.assertExhausted(assert, 'partial'), /never invoked/);
});

test('an unclean policies:check refuses the push before anything is sent', async () => {
  const root = makeRoot();
  const dir = backupDir();
  const sdir = stateDir();
  try {
    writeRaw(root, 'shipping_policy.html', fileTextFor(EDITED)); // manifest deliberately NOT updated
    const client = makeClient({ live: liveFrom() });
    await assert.rejects(
      () => run({ ...BASE, client, root, options: options(), backupDir: dir, stateDir: sdir, stateDir: sdir }),
      /policies:check: is not clean/,
    );
    assert.deepEqual(client.calls, [], 'the client was touched before the repo gate passed');
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------------------------
// Step 3: already in sync
// ---------------------------------------------------------------------------------------------

test('a live body identical to the repo body exits without mutating', async () => {
  const root = makeRoot();
  const dir = backupDir();
  const sdir = stateDir();
  try {
    const client = makeClient({ live: liveFrom() });
    const result = await run({ ...BASE, client, root, options: options(), backupDir: dir, stateDir: sdir, stateDir: sdir });
    assert.equal(result.mutated, false);
    assert.equal(result.reason, 'in-sync');
    assert.deepEqual(client.calls.map((c) => c.kind), ['read']);
    assert.equal(readdirSync(dir).length, 0, 'wrote a backup for a no-op');
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------------------------
// Step 4: freshness
// ---------------------------------------------------------------------------------------------

test('a live body the manifest has not seen is a refusal naming policies:pull', async () => {
  const root = editedRoot();
  const dir = backupDir();
  const sdir = stateDir();
  try {
    const live = liveFrom({ ...BODIES, SHIPPING_POLICY: `${BODIES.SHIPPING_POLICY}\n<p>edited in Admin</p>` });
    const client = makeClient({ live });
    const before = snapshotTree(policiesDir(root));
    await assert.rejects(
      () => run({ ...BASE, client, root, options: options({ confirm: 'shipping_policy' }), backupDir: dir, stateDir: sdir, stateDir: sdir }),
      /has not seen.*policies:pull/s,
    );
    assert.equal(client.calls.filter((c) => c.kind === 'mutate').length, 0);
    assertTreeUnchanged(assert, before, snapshotTree(policiesDir(root)), 'freshness refusal wrote something');
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('--force-overwrite-live discards the Admin edit on purpose', async () => {
  const root = editedRoot();
  const dir = backupDir();
  const sdir = stateDir();
  try {
    const drifted = `${BODIES.SHIPPING_POLICY}\n<p>edited in Admin</p>`;
    const client = makeClient({ live: liveFrom({ ...BODIES, SHIPPING_POLICY: drifted }) });
    const result = await run({
      ...BASE,
      client,
      root,
      backupDir: dir, stateDir: sdir,
      options: options({ confirm: 'shipping_policy', expectLiveSha: sha(drifted), forceOverwriteLive: true }),
    });
    assert.equal(result.mutated, true);
    assert.equal(client.state.get('SHIPPING_POLICY').body, EDITED_STAMPED);
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('the in-sync fast path RECORDS the observation: it just did a confirmed live read', async () => {
  // Returning without recording leaves a stale or absent baseline in place, and the next real push
  // then trips the freshness gate on an Admin edit that never happened.
  const root = makeRoot();
  const dir = backupDir();
  const stale = emptyStateDir();
  try {
    writeFileSync(
      join(stale, 'observed.json'),
      JSON.stringify({ schemaVersion: 1, policies: { shipping_policy: { coreSha256: 'f'.repeat(64), observedAt: NOW } } }),
      'utf8',
    );
    const result = await run({
      ...BASE,
      client: makeClient({ live: liveFrom() }),
      root,
      backupDir: dir,
      stateDir: stale,
      options: options(),
    });
    assert.equal(result.reason, 'in-sync');
    assert.equal(
      readStateRaw(stale).policies.shipping_policy.coreSha256,
      coreSha256(BODIES.SHIPPING_POLICY),
      'the stale baseline survived a confirmed live read',
    );
    assert.equal(readdirSync(dir).length, 0, 'the in-sync path wrote a backup');
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('an in-sync push against a CORRUPT state file refuses rather than reporting in-sync', () => {
  // Pinned because the in-sync path now reads state (to record the observation) BEFORE the
  // freshness gate, so a corrupt file surfaces earlier than it used to. Refusing is the intended
  // behaviour and matches the rest of the design: absent is a fact, unusable is a refusal. The
  // operator has to fix the file either way, and "already in sync" read off an unusable baseline
  // is the kind of reassurance this subsystem exists to stop giving.
  const root = makeRoot();
  const dir = backupDir();
  const broken = emptyStateDir();
  writeFileSync(join(broken, 'observed.json'), 'nonsense', 'utf8');
  return assert.rejects(
    () => run({ ...BASE, client: makeClient({ live: liveFrom() }), root, backupDir: dir, stateDir: broken, options: options() }),
    /is not valid JSON/,
  ).finally(() => {
    cleanup(root);
    cleanup(dir);
  });
});

// ---------------------------------------------------------------------------------------------
// Step 4: the freshness gate needs the machine-local state, and refuses without it
// ---------------------------------------------------------------------------------------------

test('NO STATE FILE is a refusal naming policies:pull verbatim, and nothing is sent', async () => {
  // The migration window, and every fresh clone. Seeding here would mean minting the baseline
  // from the very read the gate is supposed to check against, which is not a check at all.
  const root = editedRoot();
  const dir = backupDir();
  const empty = emptyStateDir();
  try {
    const client = makeClient({ live: liveFrom() });
    const before = snapshotTree(policiesDir(root));
    await assert.rejects(
      () => run({
        ...BASE,
        client,
        root,
        backupDir: dir,
        stateDir: empty,
        options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
      }),
      (err) => {
        assert.match(err.message, /no observation state/);
        assert.ok(err.message.includes(SEED_COMMAND), `the refusal must name ${SEED_COMMAND} verbatim`);
        return true;
      },
    );
    assert.equal(client.calls.filter((c) => c.kind === 'mutate').length, 0);
    assertTreeUnchanged(assert, before, snapshotTree(policiesDir(root)), 'the state refusal wrote something');
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('the no-state refusal names the file with $HOME collapsed, not the operator username', async () => {
  // CLAUDE.md bars an absolute path carrying a username from the repo, from PRs and from issues,
  // and a freshness refusal is exactly the output an operator pastes into one. Every backup path
  // already went through displayPath; the state paths did not.
  const root = editedRoot();
  const dir = backupDir();
  const empty = join(homedir(), '.local', 'state', 'shop-policies-state-pushtest');
  mkdirSync(empty, { recursive: true });
  try {
    await assert.rejects(
      () => run({
        ...BASE,
        client: makeClient({ live: liveFrom() }),
        root,
        backupDir: dir,
        stateDir: empty,
        options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
      }),
      (err) => {
        assert.equal(err.message.includes(homedir()), false, `the refusal leaked $HOME:\n${err.message}`);
        assert.ok(err.message.includes('~/.local/state/'), `not a display path:\n${err.message}`);
        return true;
      },
    );
  } finally {
    cleanup(root);
    cleanup(dir);
    rmSync(empty, { recursive: true, force: true });
  }
});

test('a VALID state file lets the same push through, so the gate is not simply always-refuse', async () => {
  const root = editedRoot();
  const dir = backupDir();
  const sdir = stateDir();
  try {
    const result = await run({
      ...BASE,
      client: makeClient({ live: liveFrom() }),
      root,
      backupDir: dir, stateDir: sdir,
      options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
    });
    assert.equal(result.mutated, true);
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('a corrupt, empty, wrong-shape or wrong-schema state file is a refusal, not a reseed', async () => {
  // Each row asserts its OWN message and asserts it is NOT the absent-file one. Asserting only
  // that SEED_COMMAND appears would survive `readState` returning null on corrupt input: push
  // would fall through to "there is no observation state", which also names the command, and the
  // design's central distinction ("absent is a fact, unusable is a refusal") would be gone with
  // every row still green.
  for (const [label, contents, expected] of [
    ['not json', 'nonsense', /is not valid JSON/],
    ['empty', '', /is empty/],
    ['whitespace', '   \n', /is empty/],
    ['an array', '[]', /is not a state object/],
    ['no policies object', '{"schemaVersion":1}', /has no "policies" object/],
    ['a future schema', '{"schemaVersion":99,"policies":{}}', /has schemaVersion 99/],
  ]) {
    const root = editedRoot();
    const dir = backupDir();
    const broken = emptyStateDir();
    try {
      writeFileSync(join(broken, 'observed.json'), contents, 'utf8');
      await assert.rejects(
        () => run({
          ...BASE,
          client: makeClient({ live: liveFrom() }),
          root,
          backupDir: dir,
          stateDir: broken,
          options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
        }),
        (err) => {
          assert.match(err.message, expected, `${label}: wrong refusal`);
          assert.equal(
            /no observation state/.test(err.message),
            false,
            `${label}: refused as ABSENT, not as unusable; the two are different facts`,
          );
          assert.ok(err.message.includes(SEED_COMMAND), `${label}: the refusal must name ${SEED_COMMAND}`);
          return true;
        },
        label,
      );
    } finally {
      cleanup(root);
      cleanup(dir);
    }
  }
});

test('a state file that knows nothing about THIS policy is a refusal too', async () => {
  const root = editedRoot();
  const dir = backupDir();
  const partial = emptyStateDir();
  try {
    writeFileSync(join(partial, 'observed.json'), JSON.stringify({ schemaVersion: 1, policies: { refund_policy: {} } }), 'utf8');
    await assert.rejects(
      () => run({
        ...BASE,
        client: makeClient({ live: liveFrom() }),
        root,
        backupDir: dir,
        stateDir: partial,
        options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
      }),
      /records nothing for this policy/,
    );
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------------------------
// The monotonic version floor
// ---------------------------------------------------------------------------------------------

test('a REVERTED policy is refused: its version is already live against different wording', async () => {
  // `deriveVersion` reads `prev` from a git-tracked file, so `git revert` restores body and
  // manifest atomically and walks `version` backwards while the live store keeps the higher
  // number. The next edit then re-derives a version that is already live against different bytes.
  const root = editedRoot();
  const dir = backupDir();
  // This machine has pushed v3 with some other wording; the tree has been reverted to v2.
  const sdir = stateDir(liveFrom(), {
    shipping_policy: { highestPushed: 3, highestPushedCoreSha256: sha('something else entirely') },
  });
  try {
    const client = makeClient({ live: liveFrom() });
    const before = snapshotTree(policiesDir(root));
    await assert.rejects(
      () => run({
        ...BASE,
        client,
        root,
        backupDir: dir, stateDir: sdir,
        options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
      }),
      /already been pushed.*git revert/s,
    );
    assert.equal(client.calls.filter((c) => c.kind === 'mutate').length, 0, 'the floor refused after mutating');
    assert.equal(readdirSync(dir).length, 0, 'the floor refused after writing a backup');
    assertTreeUnchanged(assert, before, snapshotTree(policiesDir(root)), 'the floor refusal wrote something');
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('the floor does NOT refuse the same wording at the same version', async () => {
  const root = editedRoot();
  const dir = backupDir();
  const sdir = stateDir(liveFrom(), {
    shipping_policy: { highestPushed: 2, highestPushedCoreSha256: sha(EDITED) },
  });
  try {
    const result = await run({
      ...BASE,
      client: makeClient({ live: liveFrom() }),
      root,
      backupDir: dir, stateDir: sdir,
      options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
    });
    assert.equal(result.mutated, true);
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------------------------

test('PUSH_SCOPES is exactly this literal list', () => {
  // A mutation-pass survivor: an emptied or reordered list still let every test pass, and the
  // scope assertion is the only thing standing between this tool and a token that cannot write.
  assert.deepEqual(PUSH_SCOPES, ['read_legal_policies', 'write_legal_policies']);
});

// ---------------------------------------------------------------------------------------------
// Step 5: the dry run
// ---------------------------------------------------------------------------------------------

test('without --confirm the run reads only, mutates nothing, and prints the exact next command', async () => {
  const root = editedRoot();
  const dir = backupDir();
  const sdir = stateDir();
  const lines = [];
  try {
    const client = makeClient({ live: liveFrom() });
    const before = snapshotTree(policiesDir(root));
    const result = await run({ ...BASE, log: (s) => lines.push(s), client, root, options: options(), backupDir: dir, stateDir: sdir, stateDir: sdir });
    assert.equal(result.mutated, false);
    assert.equal(result.reason, 'dry-run');
    assert.deepEqual(client.calls.map((c) => c.kind), ['read']);
    assert.equal(readdirSync(dir).length, 0, 'a dry run wrote a backup');
    assertTreeUnchanged(assert, before, snapshotTree(policiesDir(root)), 'a dry run wrote something');

    const text = lines.join('\n');
    assert.ok(text.includes('NO CHANGES WERE MADE'));
    // The dry run must print the SAME hash the gate will check. A tool printing a re-run command
    // its own gate then refuses is the pattern this whole subsystem was rewritten to stop.
    assert.ok(text.includes(`--expect-live-sha=${result.liveCore}`));
    assert.equal(result.liveCore, coreSha256(BODIES.SHIPPING_POLICY));
    assert.ok(text.includes('v2 (stamped into the first line of the body)'));
    assert.ok(text.includes('--confirm=shipping_policy'));
    assert.equal(text.includes(SUCCESS_MARKER), false, 'the success marker leaked into a dry run');
    assert.ok(result.diff.includes('3-5 business days'));
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('the dry run calls out a heading change as an anchor break', async () => {
  const body = BODIES.SHIPPING_POLICY.replace('<h2>Questions?</h2>', '<h2>Questions and Answers</h2>');
  const root = editedRoot(body);
  const dir = backupDir();
  const sdir = stateDir();
  const lines = [];
  try {
    const client = makeClient({ live: liveFrom() });
    const result = await run({ ...BASE, log: (s) => lines.push(s), client, root, options: options(), backupDir: dir, stateDir: sdir, stateDir: sdir });
    assert.ok(result.headingDiff.length > 0);
    assert.ok(lines.join('\n').includes('HEADINGS CHANGE'));
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('--confirm must equal the type, and --expect-live-sha is required and checked', async () => {
  const root = editedRoot();
  const dir = backupDir();
  const sdir = stateDir();
  try {
    const client = makeClient({ live: liveFrom() });
    const base = { ...BASE, client, root, backupDir: dir, stateDir: sdir, stateDir: sdir };
    await assert.rejects(() => run({ ...base, options: options({ confirm: 'true' }) }), /must be exactly "shipping_policy"/);
    await assert.rejects(() => run({ ...base, options: options({ confirm: 'shipping_policy' }) }), /--expect-live-sha: required/);
    await assert.rejects(
      () => run({ ...base, options: options({ confirm: 'shipping_policy', expectLiveSha: 'stale' }) }),
      /changed since the dry run/,
    );
    assert.equal(client.calls.filter((c) => c.kind === 'mutate').length, 0);
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------------------------
// Step 6: the backup
// ---------------------------------------------------------------------------------------------

test('the backup holds the pre-push ADMIN body, not the repo body', async () => {
  const root = editedRoot();
  const dir = backupDir();
  const sdir = stateDir();
  try {
    const client = makeClient({ live: liveFrom() });
    const result = await run({
      ...BASE,
      client,
      root,
      backupDir: dir, stateDir: sdir,
      options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
    });
    const record = JSON.parse(readFileSync(result.backupFile, 'utf8'));
    assert.equal(record.body, BODIES.SHIPPING_POLICY, 'the backup captured the repo body instead of Admin');
    assert.notEqual(record.body, EDITED);
    assert.equal(record.type, 'SHIPPING_POLICY');
    assert.equal(record.storeDomain, 'example.myshopify.com');
    assert.equal(record.sha256, sha(BODIES.SHIPPING_POLICY));
    assert.ok(record.id);
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('the backup file is 0600 and the directory 0700', async () => {
  const dir = backupDir();
  const sdir = stateDir();
  try {
    const { file } = writeBackup({
      dir: join(dir, 'nested'),
      type: 'SHIPPING_POLICY',
      live: { id: 'gid://x', title: 'Shipping', body: '<p>a</p>' },
      now: NOW,
      domain: 'example.myshopify.com',
    });
    assert.equal(statSync(file).mode & 0o777, FILE_MODE);
    assert.equal(statSync(join(dir, 'nested')).mode & 0o777, 0o700);
  } finally {
    cleanup(dir);
  }
});

test('writeBackup refuses to overwrite an existing backup', () => {
  const dir = backupDir();
  const sdir = stateDir();
  try {
    const args = {
      dir,
      type: 'SHIPPING_POLICY',
      live: { id: 'gid://x', title: 'Shipping', body: '<p>a</p>' },
      now: NOW,
      domain: 'd',
    };
    writeBackup(args);
    assert.throws(() => writeBackup(args), /already exists/);
  } finally {
    cleanup(dir);
  }
});

test('a failed backup aborts before any mutation', async () => {
  const root = editedRoot();
  const sdir = stateDir();
  try {
    const client = makeClient({ live: liveFrom() });
    // A file where the backup directory must go: mkdirSync fails, so the backup cannot be written.
    const blocked = mkdtempSync(join(tmpdir(), 'policies-blocked-'));
    const dir = join(blocked, 'file');
    writeFileSync(dir, 'not a directory', 'utf8');
    // Matched, not bare: `assert.rejects` with no matcher is satisfied by ANY rejection, so this
    // passed whether the backup failed or the freshness gate did.
    await assert.rejects(
      () =>
        run({
          ...BASE,
          client,
          root,
          backupDir: dir, stateDir: sdir,
          options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
        }),
      /EEXIST|ENOTDIR|not a directory/,
    );
    assert.equal(client.calls.filter((c) => c.kind === 'mutate').length, 0, 'mutated without a backup');
    assert.equal(readStateRaw(sdir).policies.shipping_policy.coreSha256, coreSha256(BODIES.SHIPPING_POLICY), 'state moved on a pre-mutation refusal');
    cleanup(blocked);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------------------------
// Step 7: the mutation, and the userErrors-on-200 trap
// ---------------------------------------------------------------------------------------------

test('exactly one mutation, of the right type, with the canonicalised repo bytes', async () => {
  const root = editedRoot();
  const dir = backupDir();
  const sdir = stateDir();
  try {
    const client = makeClient({ live: liveFrom() });
    await run({
      ...BASE,
      client,
      root,
      backupDir: dir, stateDir: sdir,
      options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
    });
    const mutations = client.calls.filter((c) => c.kind === 'mutate');
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].document, PUSH_MUTATION);
    assert.deepEqual(mutations[0].variables, { shopPolicy: { type: 'SHIPPING_POLICY', body: EDITED_STAMPED } });
    assert.equal(
      mutations[0].variables.shopPolicy.body.startsWith('<!-- sss-policy shipping_policy v2 -->\n'),
      true,
      'the stamp travels WITH the body: it is what lets the live page identify its own version',
    );
    assert.equal(mutations[0].variables.shopPolicy.body, canonicalise(mutations[0].variables.shopPolicy.body));
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('the recorded call order is read, then backup, then mutate', async () => {
  const root = editedRoot();
  const dir = backupDir();
  const sdir = stateDir();
  const order = [];
  try {
    const client = makeClient({
      live: liveFrom(),
      onMutate: () => {
        order.push(`backup-exists:${readdirSync(dir).length > 0}`);
        return undefined;
      },
    });
    const patched = {
      ...client,
      async gql(doc, vars) {
        order.push(/\bmutation\b/.test(doc) ? 'mutate' : 'read');
        return client.gql(doc, vars);
      },
    };
    await run({
      ...BASE,
      client: patched,
      root,
      backupDir: dir, stateDir: sdir,
      options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
    });
    assert.deepEqual(order, ['read', 'mutate', 'backup-exists:true', 'read']);
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('userErrors on a 200 fails closed, printing field and message, writing nothing locally', async () => {
  const root = editedRoot();
  const dir = backupDir();
  const sdir = stateDir();
  try {
    const client = makeClient({
      live: liveFrom(),
      onMutate: () => ({
        shopPolicyUpdate: {
          shopPolicy: null,
          userErrors: [{ code: 'TOO_BIG', field: ['shopPolicy', 'body'], message: 'Body is too long' }],
        },
      }),
    });
    const before = snapshotTree(policiesDir(root));
    const lines = [];
    await assert.rejects(
      () =>
        run({
          ...BASE,
          log: (s) => lines.push(s),
          client,
          root,
          backupDir: dir, stateDir: sdir,
          options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
        }),
      (err) => {
        assert.match(err.message, /shopPolicy\.body: Body is too long \[TOO_BIG\]/);
        assert.match(err.message, /NOTHING WAS WRITTEN LOCALLY/);
        return true;
      },
    );
    assertTreeUnchanged(assert, before, snapshotTree(policiesDir(root)), 'a userErrors failure wrote something');
    assert.equal(lines.join('\n').includes(SUCCESS_MARKER), false, 'the success marker leaked into a failure');
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('a null shopPolicy with no userErrors is still a failed write', async () => {
  const root = editedRoot();
  const dir = backupDir();
  const sdir = stateDir();
  try {
    const client = makeClient({ live: liveFrom(), onMutate: () => ({ shopPolicyUpdate: { shopPolicy: null, userErrors: [] } }) });
    await assert.rejects(
      () =>
        run({
          ...BASE,
          client,
          root,
          backupDir: dir, stateDir: sdir,
          options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
        }),
      /no shopPolicy and no userErrors/,
    );
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('the failure taxonomy: a missing mutation field, and a client that throws', async () => {
  const cases = [
    { name: 'missing mutation field', onMutate: () => ({}) },
    { name: 'top-level errors with null data', onMutate: () => ({ shopPolicyUpdate: null }) },
  ];
  for (const { name, onMutate } of cases) {
    const root = editedRoot();
    const dir = backupDir();
  const sdir = stateDir();
    try {
      const client = makeClient({ live: liveFrom(), onMutate });
      await assert.rejects(
        () =>
          run({
            ...BASE,
            client,
            root,
            backupDir: dir, stateDir: sdir,
            options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
          }),
        /returned no shopPolicy and no userErrors/,
        name,
      );
    } finally {
      cleanup(root);
      cleanup(dir);
    }
  }

  // A thrown network error, and a throttling / 5xx error, both surface rather than being swallowed.
  for (const message of ['fetch failed', 'GraphQL errors: [{"extensions":{"code":"THROTTLED"}}]', 'HTTP 503: {}']) {
    const root = editedRoot();
    const dir = backupDir();
  const sdir = stateDir();
    try {
      const client = makeClient({ live: liveFrom() });
      const throwing = {
        ...client,
        async gql(doc, vars) {
          if (/\bmutation\b/.test(doc)) throw new Error(message);
          return client.gql(doc, vars);
        },
      };
      await assert.rejects(
        () =>
          run({
            ...BASE,
            client: throwing,
            root,
            backupDir: dir, stateDir: sdir,
            options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
          }),
        new RegExp(message.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
    } finally {
      cleanup(root);
      cleanup(dir);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Step 8: verification and write-back
// ---------------------------------------------------------------------------------------------

test('the happy path leaves the WORKING TREE CLEAN and records the observation outside it', async () => {
  // The property the whole state split exists for. A push used to write `remote` into the
  // manifest, which meant the dirty-tree gate blocked the next push until that side effect had
  // been committed and merged: a PR per push, forever.
  const root = editedRoot();
  const dir = backupDir();
  const sdir = stateDir();
  const lines = [];
  try {
    const client = makeClient({ live: liveFrom() });
    const before = snapshotTree(policiesDir(root));
    const result = await run({
      ...BASE,
      log: (s) => lines.push(s),
      client,
      root,
      backupDir: dir, stateDir: sdir,
      options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
    });
    assert.equal(result.mutated, true);
    assert.equal(result.normalised, false);
    assertTreeUnchanged(assert, before, snapshotTree(policiesDir(root)), 'a successful push wrote into the repo');

    const observed = readStateRaw(sdir).policies.shipping_policy;
    assert.equal(observed.coreSha256, sha(EDITED), 'the observation does not record what Admin now holds');
    assert.equal(observed.highestPushed, 2, 'the monotonic floor did not move');
    assert.equal(observed.highestPushedCoreSha256, sha(EDITED));
    assert.equal(observed.lastPushStamped, true);

    const text = lines.join('\n');
    assert.ok(text.includes(SUCCESS_MARKER));
    assert.ok(text.includes('v2'), 'the success line does not name the version that is now live');
    assert.ok(text.includes('--restore'));
    assert.deepEqual(checkClean(root), []);
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('the printed commit command carries NO AI attribution of any kind', async () => {
  // A template printed by a tool becomes the shape of every future policy commit, so a trailer
  // here would be permanent and would land in a public repo's history.
  const joined = COMMIT_HINT.join('\n');
  assert.equal(joined.includes('Claude-Session'), false);
  assert.equal(joined.includes('claude.ai/code'), false);
  assert.equal(/co-authored-by/i.test(joined), false);

  const root = editedRoot();
  const dir = backupDir();
  const sdir = stateDir();
  const lines = [];
  try {
    await run({
      ...BASE,
      log: (s) => lines.push(s),
      client: makeClient({ live: liveFrom() }),
      root,
      backupDir: dir, stateDir: sdir,
      options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
    });
    const text = lines.join('\n');
    assert.ok(text.includes('git switch -c policies/'), 'the commit hint was not printed at all');
    assert.equal(text.includes('Claude-Session'), false);
    assert.equal(text.includes('claude.ai/code'), false);
    assert.equal(/co-authored-by/i.test(text), false);
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('a stamped push whose live body comes back UNSTAMPED says so: Shopify strips comments', async () => {
  // The one experiment the first stamped push performs, and the answer changes what
  // policies:verify can assert. It must be stated, not left to be inferred from a green run.
  const root = editedRoot();
  const dir = backupDir();
  const sdir = stateDir();
  const lines = [];
  try {
    const client = makeClient({
      live: liveFrom(),
      onMutate: (type, body, state) => {
        // A fake Shopify that strips HTML comments. Every gate must still pass, on the core.
        const stored = coreOf(body);
        state.set(type, { ...state.get(type), body: stored });
        return { shopPolicyUpdate: { shopPolicy: { id: 'gid://1', type, title: 'Shipping', body: stored }, userErrors: [] } };
      },
    });
    const result = await run({
      ...BASE,
      log: (s) => lines.push(s),
      client,
      root,
      backupDir: dir, stateDir: sdir,
      options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
    });
    assert.equal(result.mutated, true, 'the push must complete: comparisons run on the core');
    assert.equal(result.normalised, false, 'a stripped stamp is not a renormalisation of the wording');
    assert.ok(lines.join('\n').includes('strips HTML comments'));
    assert.equal(readStateRaw(sdir).policies.shipping_policy.lastPushStamped, true, 'what WE sent was stamped');
    assert.deepEqual(checkClean(root), []);
    assertTreeUnchanged(
      assert,
      snapshotTree(policiesDir(editedRoot())),
      snapshotTree(policiesDir(root)),
      'the repo moved because Shopify dropped a comment',
    );
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

function checkClean(root) {
  const { problems, mismatches } = check(root);
  return [...problems, ...mismatches];
}

test('the verify read retries before believing a mismatch', async () => {
  const root = editedRoot();
  const dir = backupDir();
  const sdir = stateDir();
  try {
    let readsAfterMutate = 0;
    const client = makeClient({ live: liveFrom() });
    const flaky = {
      ...client,
      async gql(doc, vars) {
        if (!/\bmutation\b/.test(doc) && client.calls.some((c) => c.kind === 'mutate')) {
          readsAfterMutate += 1;
          // The first read after the write returns the OLD body, as a stale replica would.
          if (readsAfterMutate === 1) {
            return { shop: { shopPolicies: [{ id: 'gid://1', type: 'SHIPPING_POLICY', title: 'Shipping', body: BODIES.SHIPPING_POLICY, url: 'u' }, ...stubOthers()] } };
          }
        }
        return client.gql(doc, vars);
      },
    };
    const result = await run({
      ...BASE,
      client: flaky,
      root,
      backupDir: dir, stateDir: sdir,
      options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
    });
    assert.equal(result.mutated, true);
    assert.equal(result.normalised, false);
    assert.equal(readsAfterMutate, 2, 'expected exactly one retry');
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

function stubOthers() {
  return ['CONTACT_INFORMATION', 'PRIVACY_POLICY', 'REFUND_POLICY', 'TERMS_OF_SERVICE'].map((type, i) => ({
    id: `gid://${i + 2}`,
    type,
    title: type,
    body: BODIES[type],
    url: 'u',
  }));
}

test('a re-read that differs by entities and whitespace refuses without --accept-normalisation', async () => {
  const root = editedRoot();
  const dir = backupDir();
  const sdir = stateDir();
  try {
    const normalised = EDITED.replace('Production &amp; Delivery Times', 'Production &#38; Delivery Times');
    const client = makeClient({ live: liveFrom(), onMutate: (type, body, state) => {
      state.set(type, { ...state.get(type), body: normalised });
      return { shopPolicyUpdate: { shopPolicy: { id: 'gid://1', type, title: 'Shipping', body: normalised }, userErrors: [] } };
    } });
    await assert.rejects(
      () =>
        run({
          ...BASE,
          client,
          root,
          backupDir: dir, stateDir: sdir,
          options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
        }),
      /renormalised.*--accept-normalisation/s,
    );
    assertBodyUntouchedObservationRecorded(root, sdir, EDITED_STAMPED, normalised);
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('--accept-normalisation takes the stored version into the repo and the manifest', async () => {
  const root = editedRoot();
  const dir = backupDir();
  const sdir = stateDir();
  try {
    const normalised = EDITED.replace('Production &amp; Delivery Times', 'Production &#38; Delivery Times');
    const client = makeClient({ live: liveFrom(), onMutate: (type, body, state) => {
      state.set(type, { ...state.get(type), body: normalised });
      return { shopPolicyUpdate: { shopPolicy: { id: 'gid://1', type, title: 'Shipping', body: normalised }, userErrors: [] } };
    } });
    const result = await run({
      ...BASE,
      client,
      root,
      backupDir: dir, stateDir: sdir,
      options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY), acceptNormalisation: true }),
    });
    assert.equal(result.normalised, true);
    // The write-back keeps the SAME version: this is v2 as Shopify chose to spell it, not a new
    // version. Re-deriving here would mint a v3 that was never pushed anywhere.
    const expected = stampVersion(normalised, 'shipping_policy', 2);
    assert.equal(bodyFromFileText(readPolicy(root, 'SHIPPING_POLICY')), expected);
    const entry = JSON.parse(readManifestRaw(root)).policies.shipping_policy;
    assert.equal(entry.version, 2);
    assert.equal(entry.sha256, sha(expected));
    assert.equal(entry.coreSha256, sha(normalised));
    assert.equal(readStateRaw(sdir).policies.shipping_policy.coreSha256, sha(normalised));
    assert.deepEqual(checkClean(root), []);
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('the documented --accept-normalisation re-run is REACHABLE: it does not trip the freshness gate', async () => {
  // The bug this pins: on the normalisation refusal the manifest's `remote` used to keep its
  // pre-push value while Admin already held the normalised body, so the instructed re-run hit the
  // freshness gate at step 4 and was told to use --force-overwrite-live. Two documented steps in
  // sequence landed the operator on the most dangerous flag in the set, to fix whitespace.
  const root = editedRoot();
  const dir = backupDir();
  const sdir = stateDir();
  try {
    const normalised = EDITED.replace('Production &amp; Delivery Times', 'Production &#38; Delivery Times');
    const makeNormalising = () => makeClient({ live: liveFrom(), onMutate: (type, body, state) => {
      state.set(type, { ...state.get(type), body: normalised });
      return { shopPolicyUpdate: { shopPolicy: { id: 'gid://1', type, title: 'Shipping', body: normalised }, userErrors: [] } };
    } });

    // First run: refuses, and its message must carry a re-run command that can actually work,
    // which means the NEW live sha, not the one the operator passed in.
    await assert.rejects(
      () => run({
        ...BASE,
        client: makeNormalising(),
        root,
        backupDir: dir, stateDir: sdir,
        options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
      }),
      (err) => {
        assert.match(err.message, /renormalised/);
        assert.ok(
          err.message.includes(`--expect-live-sha=${sha(normalised)}`),
          `the refusal must name the new live sha so the re-run is runnable; got:\n${err.message}`,
        );
        assert.ok(err.message.includes('--accept-normalisation'));
        return true;
      },
    );

    // Second run: Admin already holds the normalised body, so live === remote and the freshness
    // gate passes. This is the assertion that matters.
    const second = makeClient({ live: liveFrom({ ...BODIES, SHIPPING_POLICY: normalised }), onMutate: (type, body, state) => {
      state.set(type, { ...state.get(type), body: normalised });
      return { shopPolicyUpdate: { shopPolicy: { id: 'gid://1', type, title: 'Shipping', body: normalised }, userErrors: [] } };
    } });
    const result = await run({
      ...BASE,
      now: '2026-01-02T03:04:06.000Z', // a later clock: the backup name must not collide
      client: second,
      root,
      backupDir: dir, stateDir: sdir,
      options: options({
        confirm: 'shipping_policy',
        expectLiveSha: sha(normalised),
        acceptNormalisation: true,
      }),
    });
    assert.equal(result.mutated, true, 'the re-run was refused; the documented recovery is unreachable');
    assert.equal(result.normalised, true);
    assert.equal(bodyFromFileText(readPolicy(root, 'SHIPPING_POLICY')), stampVersion(normalised, 'shipping_policy', 2));
    assert.deepEqual(checkClean(root), []);
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('a stored body differing by more than entities and whitespace is never accepted', async () => {
  const root = editedRoot();
  const dir = backupDir();
  const sdir = stateDir();
  try {
    const mangled = `${EDITED}\n<p>Shopify added a sentence.</p>`;
    const client = makeClient({ live: liveFrom(), onMutate: (type, body, state) => {
      state.set(type, { ...state.get(type), body: mangled });
      return { shopPolicyUpdate: { shopPolicy: { id: 'gid://1', type, title: 'Shipping', body: mangled }, userErrors: [] } };
    } });
    await assert.rejects(
      () =>
        run({
          ...BASE,
          client,
          root,
          backupDir: dir, stateDir: sdir,
          options: options({
            confirm: 'shipping_policy',
            expectLiveSha: sha(BODIES.SHIPPING_POLICY),
            acceptNormalisation: true,
          }),
        }),
      /more than entity and whitespace spelling/,
    );
    assertBodyUntouchedObservationRecorded(root, sdir, EDITED_STAMPED, mangled);
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('a re-read whose HEADINGS differ is an anchor break: non-zero, file untouched, no flag helps', async () => {
  const root = editedRoot();
  const dir = backupDir();
  const sdir = stateDir();
  try {
    const reheaded = EDITED.replace('<h2>Questions?</h2>', '<h2>Questions and Answers</h2>');
    const client = makeClient({ live: liveFrom(), onMutate: (type, body, state) => {
      state.set(type, { ...state.get(type), body: reheaded });
      return { shopPolicyUpdate: { shopPolicy: { id: 'gid://1', type, title: 'Shipping', body: reheaded }, userErrors: [] } };
    } });
    await assert.rejects(
      () =>
        run({
          ...BASE,
          client,
          root,
          backupDir: dir, stateDir: sdir,
          options: options({
            confirm: 'shipping_policy',
            expectLiveSha: sha(BODIES.SHIPPING_POLICY),
            acceptNormalisation: true,
          }),
        }),
      /HEADINGS differ.*anchor break/s,
    );
    // The BODY is what must not move on an anchor break: no flag takes Shopify's headings.
    assertBodyUntouchedObservationRecorded(root, sdir, EDITED_STAMPED, reheaded);
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------------------------

test('loadRestore refuses a missing file, a bodiless record, and a tampered body', () => {
  const dir = backupDir();
  const sdir = stateDir();
  try {
    assert.throws(() => loadRestore(join(dir, 'nope.json')), /no such backup file/);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ type: 'SHIPPING_POLICY', body: '' }), 'utf8');
    assert.throws(() => loadRestore(bad), /holds no body/);
    const tampered = join(dir, 'tampered.json');
    writeFileSync(tampered, JSON.stringify({ type: 'SHIPPING_POLICY', body: '<p>a</p>', sha256: 'f'.repeat(64) }), 'utf8');
    assert.throws(() => loadRestore(tampered), /does not match its recorded sha256/);
  } finally {
    cleanup(dir);
  }
});

test('a restore pushes the backup body and skips the freshness gate', async () => {
  const root = editedRoot();
  const dir = backupDir();
  const sdir = stateDir();
  try {
    // Live has drifted away from both the repo and the backup, which is exactly when a restore runs.
    const drifted = `${BODIES.SHIPPING_POLICY}\n<p>a bad edit</p>`;
    const client = makeClient({ live: liveFrom({ ...BODIES, SHIPPING_POLICY: drifted }) });
    const record = { type: 'SHIPPING_POLICY', body: BODIES.SHIPPING_POLICY, sha256: sha(BODIES.SHIPPING_POLICY) };
    const result = await run({
      ...BASE,
      client,
      root,
      backupDir: dir, stateDir: sdir,
      options: options({ confirm: 'shipping_policy', expectLiveSha: sha(drifted), restore: 'f.json', restoreRecord: record }),
    });
    assert.equal(result.mutated, true);
    assert.equal(client.state.get('SHIPPING_POLICY').body, BODIES.SHIPPING_POLICY);
    // The repo copy still holds its own wording, so a push is outstanding after a restore.
    assert.equal(bodyFromFileText(readPolicy(root, 'SHIPPING_POLICY')), EDITED_STAMPED);
    const entry = JSON.parse(readManifestRaw(root)).policies.shipping_policy;
    // A RESTORE REWRITES THE OBSERVATION. Without this the next freshness check would compare
    // against a body that is no longer live, and refuse the push that puts the fix back.
    const observed = readStateRaw(sdir).policies.shipping_policy;
    assert.equal(observed.coreSha256, sha(BODIES.SHIPPING_POLICY));
    assert.notEqual(observed.coreSha256, entry.coreSha256);
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------------------------
// The step-8 re-read, when the read itself fails
// ---------------------------------------------------------------------------------------------

test('a THROWING re-read retries, and succeeds if a later attempt answers', async () => {
  // This is a read, after a write that has already landed. Retrying is safe; giving up leaves the
  // operator with no idea what is live.
  const root = editedRoot();
  const dir = backupDir();
  const sdir = stateDir();
  try {
    const client = makeClient({ live: liveFrom() });
    let readsAfterMutate = 0;
    const flaky = {
      ...client,
      async gql(doc, vars) {
        if (!/\bmutation\b/.test(doc) && client.calls.some((c) => c.kind === 'mutate')) {
          readsAfterMutate += 1;
          if (readsAfterMutate === 1) throw new Error('ECONNRESET');
        }
        return client.gql(doc, vars);
      },
    };
    const result = await run({
      ...BASE,
      client: flaky,
      root,
      backupDir: dir, stateDir: sdir,
      options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
    });
    assert.equal(result.mutated, true);
    assert.equal(readsAfterMutate, 2, 'expected exactly one retry after the throw');
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('a re-read that throws EVERY time says the store changed and prints --restore', async () => {
  // An unknown outcome is not a retry. The message has to say so, and hand over the one command
  // that puts the previous body back.
  const root = editedRoot();
  const dir = backupDir();
  const sdir = stateDir();
  try {
    const client = makeClient({ live: liveFrom() });
    const broken = {
      ...client,
      async gql(doc, vars) {
        if (!/\bmutation\b/.test(doc) && client.calls.some((c) => c.kind === 'mutate')) throw new Error('ETIMEDOUT');
        return client.gql(doc, vars);
      },
    };
    await assert.rejects(
      () => run({
        ...BASE,
        client: broken,
        root,
        backupDir: dir, stateDir: sdir,
        options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
      }),
      (err) => {
        assert.match(err.message, /could NOT be read back/);
        assert.match(err.message, /Do NOT re-run the push/);
        assert.ok(err.message.includes('--restore'), `the refusal must print --restore; got:\n${err.message}`);
        assert.match(err.message, /ETIMEDOUT/);
        return true;
      },
    );
    // The write landed, so the observation records what we sent. Leaving it at the pre-push value
    // would be a false record, and would make the recovery push trip the freshness gate.
    assert.equal(readStateRaw(sdir).policies.shipping_policy.coreSha256, sha(EDITED));
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------------------------
// main(), end to end
// ---------------------------------------------------------------------------------------------

/**
 * Run `main` with a controlled argv and environment, capturing everything it prints.
 *
 * These assert the ORDER of the gates, which is `main`'s own contract and is not visible from
 * `run`: every refusal below has to happen before an Admin client exists, so a machine with no
 * credentials refuses for the RIGHT reason rather than for a missing MYSHOPIFY_DOMAIN.
 */
async function runMain(args, env = {}) {
  const savedEnv = { ...process.env };
  const savedTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (s) => out.push(String(s));
  console.error = (s) => err.push(String(s));
  try {
    for (const key of ['CI', 'MYSHOPIFY_DOMAIN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET']) delete process.env[key];
    Object.assign(process.env, env);
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const code = await main(['node', 'push.mjs', ...args]);
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
    if (savedTTY) Object.defineProperty(process.stdin, 'isTTY', savedTTY);
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
}

test('main: CI set is refused first, and no flag reaches past it', async () => {
  const { code, err } = await runMain(
    ['--type', 'shipping_policy', '--operator-approved', '--confirm=shipping_policy', '--expect-live-sha=x'],
    { CI: 'true' },
  );
  assert.equal(code, 1);
  assert.match(err, /refuses to run with CI set/);
  assert.match(err, /no flag overrides this/);
  assert.match(err, /nothing was written/);
});

test('main: no TTY and no attestation refuses a WRITE, and names the flag rather than a pty', async () => {
  const { code, err } = await runMain(['--type', 'shipping_policy', '--confirm=shipping_policy', '--expect-live-sha=x']);
  assert.equal(code, 1);
  assert.match(err, /refuses to run without a TTY/);
  assert.match(err, /--operator-approved/);
  assert.match(err, /Do NOT.*wrap the command in a pty/s);
});

test('main: the auto-managed privacy policy is refused at flag-parse time, before any client', async () => {
  const { code, err } = await runMain(['--type', 'privacy_policy', '--operator-approved']);
  assert.equal(code, 1);
  assert.match(err, /is not writable/);
});

test('main: an unknown flag and a missing type are refused', async () => {
  assert.equal((await runMain(['--nope'])).code, 1);
  assert.match((await runMain(['--nope'])).err, /unknown flag/);
  assert.equal((await runMain(['--operator-approved'])).code, 1);
  assert.match((await runMain(['--operator-approved'])).err, /--type: required/);
});

test('main: the --operator-approved path SAYS SO on stdout, so a transcript records the attestation', async () => {
  // The attestation must be visible in the log of the run that used it, and ONLY there: it is
  // printed for a run carrying --confirm, never for a dry run nobody was asked about. Without
  // credentials the run then fails at client construction, which the next assertion pins.
  const args = ['--type', 'shipping_policy', '--operator-approved', '--confirm=shipping_policy', '--expect-live-sha=x'];
  const { out, code, err } = await runMain(args);
  assert.match(out, /running without a TTY under --operator-approved \(an operator asked for this write\)/);
  assert.equal(code, 1);
  assert.match(err, /MYSHOPIFY_DOMAIN/);
});

test('main RETURNS an exit code even when the environment is missing; it never throws out', async () => {
  // A main that throws instead of returning is a main whose refusals cannot be tested, and in
  // production it surfaced as an unhandled rejection with a stack trace rather than `error:`.
  await assert.doesNotReject(() => runMain(['--type', 'shipping_policy', '--operator-approved']));
});


after(() => {
  // Exhaustion, checked at runtime rather than by counting text: every expectation registered by
  // every fake this file built must have been invoked, or the gate that would have invoked it did
  // not run. A fake deliberately never reached opts out at its own call site.
  assertAllGitFakesExhausted(assert);
});
