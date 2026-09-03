// scripts/policies/status.mjs: "you are here, do this next".
//
// The entry point the subsystem was missing. `check` proves the repo agrees with ITSELF and is
// green in the merged-but-not-pushed state, which is how a wording change gets declared done while
// customers still read the old text. `pull --check` needs credentials and answers a different
// question. This one classifies, and names exactly one command per state.
//
// Two properties are non-negotiable and both are asserted here: it is OFFLINE unless asked, and it
// DEGRADES rather than refusing. A status command that dies because it could not resolve a ref has
// told you nothing about your policies.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { STATES, classify, describeBranch, format, nextCommand, run } from '../status.mjs';
import { POLICY_TYPES, coreSha256, fileNameForType, fileTextFor, keyForType } from '../lib/policies.mjs';
import {
  BODIES,
  cleanup,
  liveFrom,
  makeClient,
  makeGitFake,
  makeRoot,
  makeStateDir,
  seedState,
  writeRaw,
} from './helpers.mjs';

const HASH_A = coreSha256('a');
const HASH_B = coreSha256('b');
const HASH_C = coreSha256('c');

const MADE = [];
function stateDir(options) {
  const dir = makeStateDir();
  MADE.push(dir);
  if (options !== 'empty') seedState(dir, options);
  return dir;
}
after(() => {
  for (const d of MADE) rmSync(d, { recursive: true, force: true });
});

/** git answering the way it does in a merged worktree. */
function mergedGit() {
  return makeGitFake([
    { args: ['branch', '--show-current'], result: 'main' },
    { args: ['rev-parse', 'HEAD'], result: 'aaa' },
    { args: ['rev-parse', 'origin/main'], result: 'aaa' },
    { args: ['merge-base', '--is-ancestor', 'aaa', 'aaa'], result: '' },
  ]);
}

// ---------------------------------------------------------------------------------------------
// classify: the whole table, as a pure function of the input triple
// ---------------------------------------------------------------------------------------------

test('classify, row by row, with the exact label strings', () => {
  const rows = [
    // repoCore, manifestCore, observedCore, liveCore, expected
    [HASH_A, HASH_A, HASH_A, HASH_A, STATES.IN_SYNC],
    [HASH_A, HASH_A, HASH_A, null, STATES.IN_SYNC],
    [HASH_A, HASH_A, HASH_B, null, STATES.REPO_AHEAD],
    [HASH_A, HASH_A, HASH_B, HASH_B, STATES.REPO_AHEAD],
    [HASH_A, HASH_B, HASH_A, null, STATES.REPO_DIRTY],
    [HASH_A, HASH_A, HASH_A, HASH_B, STATES.ADMIN_MOVED],
    [HASH_A, HASH_B, HASH_A, HASH_C, STATES.CONFLICT],
    [HASH_A, HASH_A, null, null, STATES.NO_STATE],
    [HASH_A, HASH_A, null, HASH_B, STATES.NO_STATE],
  ];
  for (const [repoCore, manifestCore, observedCore, liveCore, expected] of rows) {
    assert.equal(
      classify({ repoCore, manifestCore, observedCore, liveCore }),
      expected,
      JSON.stringify([repoCore.slice(0, 4), manifestCore.slice(0, 4), observedCore?.slice(0, 4) ?? null, liveCore?.slice(0, 4) ?? null]),
    );
  }
});

test('the label strings themselves are pinned: they are what the operator reads', () => {
  assert.deepEqual(Object.values(STATES), [
    'in sync',
    'repo ahead: a push is outstanding',
    'repo edited: restamp, then commit',
    'Admin moved: pull and review',
    'CONFLICT: edited locally AND Admin moved',
    'unknown: no observation state on this machine',
    'in the observation state but not the manifest',
    'status could not classify this policy',
  ]);
});

test('REPO_DIRTY outranks REPO_AHEAD, because a repo that fails check cannot be pushed at all', () => {
  // Telling the operator to push here would be a dead end: `policies:check` refuses a manifest
  // that does not describe its own body, so the push never gets past step 2.
  assert.equal(classify({ repoCore: HASH_A, manifestCore: HASH_B, observedCore: HASH_C }), STATES.REPO_DIRTY);
});

test('with no --live column, "Admin moved" is unknowable and is never guessed at', () => {
  assert.equal(classify({ repoCore: HASH_A, manifestCore: HASH_A, observedCore: HASH_A, liveCore: null }), STATES.IN_SYNC);
});

test('a malformed input is TOOL_ERROR, not a confident wrong answer', () => {
  assert.equal(classify({ repoCore: undefined, manifestCore: HASH_A, observedCore: HASH_A }), STATES.TOOL_ERROR);
  assert.equal(classify({ repoCore: HASH_A, manifestCore: null, observedCore: HASH_A }), STATES.TOOL_ERROR);
});

test('every state names exactly ONE next command, and never "it depends"', () => {
  for (const state of Object.values(STATES)) {
    const command = nextCommand(state, 'shipping_policy');
    assert.equal(typeof command, 'string');
    assert.ok(command.length > 0, state);
    assert.equal(command.includes(' or '), false, `${state}: offers a choice`);
  }
  assert.ok(nextCommand(STATES.REPO_AHEAD, 'shipping_policy').includes('--type shipping_policy'));
  assert.ok(nextCommand(STATES.NO_STATE, 'x').includes('policies:pull'));
  assert.ok(nextCommand(STATES.REPO_DIRTY, 'x').includes('policies:restamp'));
  assert.ok(nextCommand(STATES.TOOL_ERROR, 'x').includes('stop and look'));
});

// ---------------------------------------------------------------------------------------------
// run: offline by default
// ---------------------------------------------------------------------------------------------

test('without a client, status constructs nothing and reads nothing from the network', async () => {
  const root = makeRoot();
  try {
    const result = await run({ root, stateDir: stateDir(), gitRun: mergedGit() });
    assert.equal(result.live, false);
    assert.equal(result.rows.length, POLICY_TYPES.length);
    for (const row of result.rows) assert.equal(row.status, STATES.IN_SYNC, row.key);
    assert.ok(format(result).includes('pass --live for the Admin column'));
  } finally {
    cleanup(root);
  }
});

test('with --live, the Admin read decides the fourth column', async () => {
  const root = makeRoot();
  try {
    const drifted = liveFrom({ ...BODIES, REFUND_POLICY: `${BODIES.REFUND_POLICY}\n<p>edited in Admin</p>` });
    const result = await run({ root, stateDir: stateDir(), client: makeClient({ live: drifted }), gitRun: mergedGit() });
    assert.equal(result.live, true);
    const refund = result.rows.find((r) => r.key === 'refund_policy');
    assert.equal(refund.status, STATES.ADMIN_MOVED);
    assert.ok(refund.next.includes('policies:pull'));
    assert.equal(result.rows.find((r) => r.key === 'shipping_policy').status, STATES.IN_SYNC);
  } finally {
    cleanup(root);
  }
});

test('a merged wording change reports REPO_AHEAD, which is the state check is silent about', async () => {
  const root = makeRoot();
  try {
    const editedCore = `${BODIES.SHIPPING_POLICY}\n<p>a merged wording change</p>`;
    // Restamped and committed, as a merged PR leaves it.
    writeRaw(root, fileNameForType('SHIPPING_POLICY'), fileTextFor(`<!-- sss-policy shipping_policy v2 -->\n${editedCore}`));
    const manifestFile = join(root, 'marketing', 'policies', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    manifest.policies.shipping_policy.version = 2;
    manifest.policies.shipping_policy.coreSha256 = coreSha256(editedCore);
    manifest.policies.shipping_policy.sha256 = coreSha256(`<!-- sss-policy shipping_policy v2 -->\n${editedCore}`);
    manifest.policies.shipping_policy.length = `<!-- sss-policy shipping_policy v2 -->\n${editedCore}`.length;
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const result = await run({ root, stateDir: stateDir(), gitRun: mergedGit() });
    const row = result.rows.find((r) => r.key === 'shipping_policy');
    assert.equal(row.status, STATES.REPO_AHEAD);
    assert.equal(row.version, 2);
    assert.ok(row.next.includes('npm run policies:push -- --type shipping_policy'));
    assert.ok(row.next.includes('operator'), 'the next command must not read as "just run this"');
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------------------------
// Degrading rather than refusing
// ---------------------------------------------------------------------------------------------

test('with NO state file it reports NO_STATE for every policy and still runs', async () => {
  const root = makeRoot();
  try {
    const result = await run({ root, stateDir: stateDir('empty'), gitRun: mergedGit() });
    for (const row of result.rows) assert.equal(row.status, STATES.NO_STATE, row.key);
    assert.ok(format(result).includes('(ABSENT)'));
  } finally {
    cleanup(root);
  }
});

test('a CORRUPT state file is reported as a note; it does not take the command down', async () => {
  const root = makeRoot();
  const dir = stateDir('empty');
  try {
    writeFileSync(join(dir, 'observed.json'), 'nonsense', 'utf8');
    const result = await run({ root, stateDir: dir, gitRun: mergedGit() });
    assert.ok(result.notes.some((n) => n.includes('could not be read')));
    for (const row of result.rows) assert.equal(row.status, STATES.NO_STATE, row.key);
  } finally {
    cleanup(root);
  }
});

test('no origin/main (a fresh clone) reports rather than crashing', async () => {
  const root = makeRoot();
  try {
    const gitRun = makeGitFake([
      { args: ['branch', '--show-current'], result: 'main' },
      { args: ['rev-parse', 'HEAD'], result: 'aaa' },
      { args: ['rev-parse', 'origin/main'], throws: new Error('unknown revision') },
    ]);
    const result = await run({ root, stateDir: stateDir(), gitRun });
    assert.equal(result.branch.branch, 'main');
    assert.equal(result.branch.merged, false);
    assert.equal(result.rows.length, POLICY_TYPES.length);
    gitRun.assertExhausted(assert, 'fresh clone');
  } finally {
    cleanup(root);
  }
});

test('not a git worktree at all reports rather than crashing', async () => {
  const root = makeRoot();
  try {
    const gitRun = makeGitFake([{ args: ['branch', '--show-current'], throws: new Error('not a git repository') }]);
    const result = await run({ root, stateDir: stateDir(), gitRun });
    assert.equal(result.branch.branch, null);
    assert.ok(result.branch.note.includes('not a git worktree'));
    assert.ok(format(result).includes('not a git worktree'));
    gitRun.assertExhausted(assert, 'no worktree');
  } finally {
    cleanup(root);
  }
});

test('a policy in the state file but NOT in the manifest is reported, not ignored', async () => {
  const root = makeRoot();
  const dir = stateDir();
  try {
    const state = JSON.parse(readFileSync(join(dir, 'observed.json'), 'utf8'));
    state.policies.legal_notice = { coreSha256: HASH_A, observedAt: '2026-01-01T00:00:00.000Z' };
    writeFileSync(join(dir, 'observed.json'), JSON.stringify(state), 'utf8');
    const result = await run({ root, stateDir: dir, gitRun: mergedGit() });
    const row = result.rows.find((r) => r.key === 'legal_notice');
    assert.equal(row.status, STATES.NOT_TRACKED);
    assert.ok(row.next.includes('leftover'));
  } finally {
    cleanup(root);
  }
});

test('describeBranch survives a detached HEAD', () => {
  const gitRun = makeGitFake([
    { args: ['branch', '--show-current'], result: '' },
    { args: ['rev-parse', 'HEAD'], result: 'aaa' },
    { args: ['rev-parse', 'origin/main'], result: 'aaa' },
    { args: ['merge-base', '--is-ancestor', 'aaa', 'aaa'], result: '' },
  ]);
  assert.equal(describeBranch('/x', { run: gitRun }).branch, '(detached)');
  gitRun.assertExhausted(assert, 'detached HEAD');
});

test('the rendered report names every policy and its next command', async () => {
  const root = makeRoot();
  try {
    const text = format(await run({ root, stateDir: stateDir(), gitRun: mergedGit() }));
    for (const type of POLICY_TYPES) assert.ok(text.includes(keyForType(type)), keyForType(type));
    assert.equal((text.match(/next:/g) ?? []).length, POLICY_TYPES.length);
  } finally {
    cleanup(root);
  }
});

test('status.mjs constructs no Admin client at module load, and imports one lazily', () => {
  // Offline by default has to be structural. A top-level import of the Admin client would read
  // MYSHOPIFY_DOMAIN eagerly and make the offline command fail on a machine with no credentials.
  const source = readFileSync(new URL('../status.mjs', import.meta.url), 'utf8');
  const topLevel = source.slice(0, source.indexOf('export const STATES'));
  assert.equal(/^import .*blank-inventory/m.test(topLevel), false, 'status.mjs imports the Admin client at the top level');
  assert.ok(source.includes("await Promise.all(["), 'the live client is not lazily imported');
});
