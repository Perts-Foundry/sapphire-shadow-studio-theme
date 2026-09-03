// scripts/policies/lib/state.mjs: the machine-local record of what Admin was last seen holding.
//
// This file exists because the same facts used to live in the manifest, where a push wrote them
// into the working tree and the dirty-tree gate then blocked the next push on that side effect.
// So the properties under test are: it is outside the repo (structurally, not by convention), it
// refuses rather than guesses when it cannot be trusted, and its modes are what a file holding a
// legal policy's hash should be.
//
// EVERY PATH IN THIS FILE IS UNDER A TEMP ROOT. A suite-level guard asserts that, because a bug
// that resolved a real XDG path would quietly write to the operator's own state.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

import { PolicyError, coreSha256, sha256 } from '../lib/policies.mjs';
import { defaultBackupDir } from '../lib/backups.mjs';
import {
  DIR_MODE,
  FILE_MODE,
  SEED_COMMAND,
  STATE_FILE_BASENAME,
  STATE_SCHEMA_VERSION,
  assertStateDirOutsideRepo,
  defaultStateDir,
  describeState,
  emptyState,
  floorFor,
  readState,
  recordObservation,
  resolveStateDir,
  stateEntry,
  stateFilePath,
  writeState,
} from '../lib/state.mjs';

const POSIX = process.platform !== 'win32';
const NOW = '2026-01-02T03:04:05.000Z';
const TEMP_ROOT = statSync(tmpdir()).isDirectory() ? tmpdir() : null;
const MADE = [];

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'policies-state-'));
  MADE.push(dir);
  return dir;
}

after(() => {
  // THE GUARD RUNS HERE, not as a test. As a top-level test it executed in declaration order,
  // before any test body had called `scratch()`, so `MADE` was empty and the loop never ran: it
  // would have passed against a suite writing straight into the operator's home directory. The
  // non-empty assertion is what stops it going quiet again.
  assert.ok(TEMP_ROOT, 'no usable temp directory');
  assert.ok(MADE.length > 0, 'the temp-root guard ran before anything was created, so it checked nothing');
  for (const dir of MADE) {
    assert.ok(dir.startsWith(TEMP_ROOT), `${dir} is not under the temp root`);
  }
  for (const dir of MADE) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// Where it lives
// ---------------------------------------------------------------------------------------------

test('the default is a SIBLING of the backup directory, never a child of it', () => {
  // Sharing the backup directory would mean a "reclaim some space, delete old backups" action
  // silently deletes the freshness baseline. `shop-policies/state/` was the first spelling and it
  // defeats that rationale entirely: `rm -rf ~/.local/state/shop-policies` still takes the
  // baseline. Separate overrides are not enough when the defaults nest.
  const env = { XDG_STATE_HOME: '/var/state' };
  const state = defaultStateDir(env);
  const backups = defaultBackupDir(env);
  assert.equal(state, join('/var/state', 'shop-policies-state'));
  assert.equal(backups, join('/var/state', 'shop-policies'));
  assert.equal(state.startsWith(`${backups}${sep}`), false, 'the state directory is inside the backup directory');
  assert.equal(backups.startsWith(`${state}${sep}`), false, 'the backup directory is inside the state directory');
});

test('POLICIES_STATE_DIR overrides, is resolved absolutely, and is separate from POLICIES_BACKUP_DIR', () => {
  assert.equal(resolveStateDir({ POLICIES_STATE_DIR: '/abs/state' }), join(sep, 'abs', 'state'));
  assert.equal(resolveStateDir({ POLICIES_STATE_DIR: 'rel' }), join(process.cwd(), 'rel'));
  // The backup override must not move the state file.
  assert.equal(
    resolveStateDir({ POLICIES_BACKUP_DIR: '/elsewhere', XDG_STATE_HOME: '/var/state' }),
    join('/var/state', 'shop-policies-state'),
  );
});

test('a relative or blank XDG_STATE_HOME falls back to ~/.local/state', () => {
  for (const value of ['relative/state', '  ', '', undefined]) {
    const dir = defaultStateDir({ XDG_STATE_HOME: value });
    assert.ok(dir.endsWith(`${sep}.local${sep}state${sep}shop-policies-state`), JSON.stringify(value));
  }
});

test('the path precedence ignores HOME once XDG_STATE_HOME is absolute', () => {
  const home = scratch();
  assert.equal(defaultStateDir({ HOME: home, XDG_STATE_HOME: '/var/state' }), join('/var/state', 'shop-policies-state'));
});

test('a state directory INSIDE the checkout is a refusal', () => {
  // The whole point of the move. An override pointing back into the repo would reintroduce the
  // committed observation one `git add -A` later, in a public repo.
  const root = scratch();
  assert.throws(() => assertStateDirOutsideRepo(join(root, 'marketing', 'policies'), root), /inside the checkout/);
  assert.throws(() => assertStateDirOutsideRepo(root, root), /inside the checkout/);
  assert.doesNotThrow(() => assertStateDirOutsideRepo(scratch(), root));
  // A sibling directory whose name merely starts with the root's is NOT inside it.
  assert.doesNotThrow(() => assertStateDirOutsideRepo(`${root}-other`, root));
});

test('a SYMLINK into the checkout is refused: the check resolves real paths, not lexical ones', () => {
  // `path.resolve` normalises `.` and `..` but knows nothing about symlinks, so a lexical check
  // passes a link that then writes straight through into the working tree.
  const root = scratch();
  const parent = scratch();
  mkdirSync(join(root, 'scripts'), { recursive: true });
  const link = join(parent, 'link');
  symlinkSync(join(root, 'scripts'), link, 'dir');
  assert.throws(() => assertStateDirOutsideRepo(link, root), /inside the checkout/);
  // And through a link whose own target does not exist yet: the deepest existing ancestor is
  // what gets resolved, and the rest re-attached.
  assert.throws(() => assertStateDirOutsideRepo(join(link, 'nested', 'deeper'), root), /inside the checkout/);
});

test('a symlink pointing somewhere legitimate still passes', () => {
  // The other half. A guard that refuses every symlink would pass the test above and be useless.
  const root = scratch();
  const parent = scratch();
  const target = scratch();
  const link = join(parent, 'link');
  symlinkSync(target, link, 'dir');
  assert.doesNotThrow(() => assertStateDirOutsideRepo(link, root));
});

test('a differently-cased spelling is refused where the filesystem is case-insensitive', { skip: process.platform === 'linux' && 'case-sensitive filesystem' }, () => {
  const root = scratch();
  assert.throws(() => assertStateDirOutsideRepo(join(root.toUpperCase(), 'state'), root), /inside the checkout/);
});

test('the refusal names the paths with $HOME collapsed, not the operator username', () => {
  // CLAUDE.md bars a dev-machine identifier from the repo, from PRs and from issues, and this
  // message is exactly the kind an operator pastes into one.
  const home = homedir();
  const root = join(home, 'a-checkout');
  try {
    assertStateDirOutsideRepo(join(root, 'state'), root);
    assert.fail('expected a refusal');
  } catch (err) {
    assert.equal(err.message.includes(home), false, `the refusal leaked $HOME:\n${err.message}`);
    assert.ok(err.message.includes('~/a-checkout'));
  }
});

test('no state message leaks an absolute $HOME path', () => {
  // Every refusal in this module, plus the report line status prints. `displayPath` exists for
  // exactly this and was already applied to every backup path.
  const home = homedir();
  const dir = join(home, '.local', 'state', 'shop-policies-state-test');
  mkdirSync(dir, { recursive: true });
  try {
    for (const contents of ['nonsense', '', '[]', '{"schemaVersion":99,"policies":{}}', '{"schemaVersion":1}']) {
      writeFileSync(stateFilePath(dir), contents, 'utf8');
      try {
        readState({ dir });
        assert.fail(`expected a refusal for ${JSON.stringify(contents)}`);
      } catch (err) {
        assert.equal(err.message.includes(home), false, `leaked $HOME for ${JSON.stringify(contents)}:\n${err.message}`);
        assert.ok(err.message.startsWith('~/'), `not a display path: ${err.message}`);
      }
    }
    assert.equal(describeState(dir).display.includes(home), false);
    assert.ok(describeState(dir).display.startsWith('~/'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readState and writeState enforce the outside-the-repo rule too', () => {
  const root = scratch();
  const inside = join(root, 'state');
  mkdirSync(inside, { recursive: true });
  assert.throws(() => readState({ dir: inside, root }), /inside the checkout/);
  assert.throws(() => writeState({ dir: inside, root, state: emptyState() }), /inside the checkout/);
});

// ---------------------------------------------------------------------------------------------
// Reading: absent is a fact, unusable is a refusal
// ---------------------------------------------------------------------------------------------

test('an absent state file is null, not a throw: the caller decides what that means', () => {
  assert.equal(readState({ dir: scratch() }), null);
});

test('every unusable state file is a refusal that names the seeding command verbatim', () => {
  for (const [label, contents] of [
    ['not JSON', 'nonsense'],
    ['empty', ''],
    ['whitespace only', '  \n '],
    ['an array', '[]'],
    ['a scalar', '42'],
    ['no policies object', JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION })],
    ['policies is an array', JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION, policies: [] })],
    ['a future schema', JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION + 1, policies: {} })],
    ['no schema at all', JSON.stringify({ policies: {} })],
  ]) {
    const dir = scratch();
    writeFileSync(stateFilePath(dir), contents, 'utf8');
    assert.throws(
      () => readState({ dir }),
      (err) => {
        assert.ok(err instanceof PolicyError, label);
        assert.ok(err.message.includes(SEED_COMMAND), `${label}: does not name ${SEED_COMMAND}`);
        return true;
      },
      label,
    );
  }
});

test('a valid file reads back exactly what was written', () => {
  const dir = scratch();
  const state = emptyState();
  state.policies.shipping_policy = recordObservation(undefined, { body: '<p>x</p>', now: NOW });
  writeState({ dir, state });
  const read = readState({ dir });
  assert.deepEqual(read, state);
  assert.equal(stateEntry(read, 'shipping_policy').coreSha256, coreSha256('<p>x</p>'));
  assert.equal(stateEntry(read, 'nope'), undefined);
});

test('the file is named observed.json under the state directory', () => {
  const dir = scratch();
  assert.equal(stateFilePath(dir), join(dir, STATE_FILE_BASENAME));
  writeState({ dir, state: emptyState() });
  assert.equal(describeState(dir).exists, true);
  assert.equal(describeState(scratch()).exists, false);
});

// ---------------------------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------------------------

test('the modes are the literals, not merely restrictive', () => {
  assert.equal(DIR_MODE, 0o700);
  assert.equal(FILE_MODE, 0o600);
});

test('a fresh state file lands at 0600 in a 0700 directory', { skip: !POSIX && 'POSIX modes' }, () => {
  const parent = scratch();
  const dir = join(parent, 'nested');
  writeState({ dir, state: emptyState() });
  assert.equal(statSync(dir).mode & 0o777, DIR_MODE);
  assert.equal(statSync(stateFilePath(dir)).mode & 0o777, FILE_MODE);
});

test('an EXISTING permissive file is tightened, which writeFileSync mode alone never does', { skip: !POSIX && 'POSIX modes' }, () => {
  // `writeFileSync`'s mode argument does nothing to a file that already exists, and this file is
  // rewritten on every pull and every push. Without the explicit chmod the first write would be
  // 0600 and every subsequent one would keep whatever mode the file had acquired.
  const dir = scratch();
  writeState({ dir, state: emptyState() });
  chmodSync(stateFilePath(dir), 0o644);
  chmodSync(dir, 0o755);
  writeState({ dir, state: emptyState() });
  assert.equal(statSync(stateFilePath(dir)).mode & 0o777, FILE_MODE);
  assert.equal(statSync(dir).mode & 0o777, DIR_MODE);
});

test('a permissive umask cannot loosen either mode', { skip: !POSIX && 'POSIX modes' }, () => {
  const previous = process.umask(0o000);
  try {
    const dir = join(scratch(), 'under-umask');
    writeState({ dir, state: emptyState() });
    assert.equal(statSync(stateFilePath(dir)).mode & 0o777, FILE_MODE);
    assert.equal(statSync(dir).mode & 0o777, DIR_MODE);
  } finally {
    process.umask(previous);
  }
});

test('the write is atomic: no .tmp sibling survives a successful write', () => {
  const dir = scratch();
  writeState({ dir, state: emptyState() });
  assert.throws(() => statSync(`${stateFilePath(dir)}.tmp`));
});

// ---------------------------------------------------------------------------------------------
// recordObservation and the monotonic floor
// ---------------------------------------------------------------------------------------------

test('an observation records the CORE hash, plus the raw bytes for a human to read', () => {
  const stamped = '<!-- sss-policy shipping_policy v3 -->\n<p>x</p>';
  const entry = recordObservation(undefined, { body: stamped, now: NOW });
  assert.equal(entry.coreSha256, sha256('<p>x</p>'));
  assert.equal(entry.sha256, sha256(stamped));
  assert.notEqual(entry.coreSha256, entry.sha256);
  assert.equal(entry.length, stamped.length);
  assert.equal(entry.observedAt, NOW);
  assert.equal('highestPushed' in entry, false, 'a plain observation is not a push');
});

test('a push records the floor and whether what it sent was stamped', () => {
  const entry = recordObservation(undefined, { body: '<p>x</p>', now: NOW, pushedVersion: 4, pushedStamped: true });
  assert.equal(entry.highestPushed, 4);
  assert.equal(entry.highestPushedCoreSha256, coreSha256('<p>x</p>'));
  assert.equal(entry.lastPushStamped, true);
  assert.equal(entry.lastPushedAt, NOW);
});

test('the floor only ever moves UP, so a restore of an older body cannot lower it', () => {
  // A restore pushes an older body. It must not tell the next wording change that v2 is free.
  const first = recordObservation(undefined, { body: '<p>new</p>', now: NOW, pushedVersion: 5, pushedStamped: true });
  const restored = recordObservation(first, { body: '<p>old</p>', now: NOW, pushedVersion: 2, pushedStamped: true });
  assert.equal(restored.highestPushed, 5);
  assert.equal(restored.highestPushedCoreSha256, coreSha256('<p>new</p>'));
  assert.equal(restored.coreSha256, coreSha256('<p>old</p>'), 'the observation itself still follows live');
});

test('a plain observation leaves the floor untouched', () => {
  const pushed = recordObservation(undefined, { body: '<p>a</p>', now: NOW, pushedVersion: 3, pushedStamped: true });
  const pulled = recordObservation(pushed, { body: '<p>b</p>', now: '2027-01-01T00:00:00.000Z' });
  assert.equal(pulled.highestPushed, 3);
  assert.equal(pulled.lastPushStamped, true);
  assert.equal(pulled.coreSha256, coreSha256('<p>b</p>'));
});

test('floorFor is null until this machine has actually pushed something', () => {
  const state = emptyState();
  assert.equal(floorFor(state, 'shipping_policy'), null);
  state.policies.shipping_policy = recordObservation(undefined, { body: '<p>x</p>', now: NOW });
  assert.equal(floorFor(state, 'shipping_policy'), null);
  state.policies.shipping_policy = recordObservation(undefined, { body: '<p>x</p>', now: NOW, pushedVersion: 2, pushedStamped: true });
  assert.deepEqual(floorFor(state, 'shipping_policy'), { highestPushed: 2, coreSha256: coreSha256('<p>x</p>') });
});

test('the state file is JSON a person can read, with a trailing newline', () => {
  const dir = scratch();
  writeState({ dir, state: emptyState() });
  const text = readFileSync(stateFilePath(dir), 'utf8');
  assert.equal(text.endsWith('\n'), true);
  assert.equal(text.includes('\n  "policies"'), true, 'the file is not indented');
});

test('pull and push both pass `root` to the state helpers, so the in-checkout guard is live', () => {
  // The guard itself is tested directly above, but nothing proved the CALLERS engage it. Dropping
  // `root` from a call site silently disables it: `readState`/`writeState` only check containment
  // when they are given a root, so the whole "never inside the checkout" property would be gone
  // with every test in this file still green.
  const dir = dirname(fileURLToPath(import.meta.url));
  for (const file of ['../pull.mjs', '../push.mjs']) {
    const source = readFileSync(join(dir, file), 'utf8');
    const calls = [...source.matchAll(/\b(readState|writeState)\(\{([^}]*)\}/g)];
    assert.ok(calls.length > 0, `${file} calls neither readState nor writeState`);
    for (const [whole, name, args] of calls) {
      assert.match(args, /\broot\b/, `${file}: ${name} called without a root, which disables the in-checkout guard: ${whole}`);
    }
  }
});

test('readState and writeState skip the guard when given no root, which is why the caller test exists', () => {
  // Pinning the escape hatch as well as the guard: the helpers are usable without a root (the tests
  // in this file do exactly that), so "the caller passes one" is a separate property and needs its
  // own assertion rather than being assumed.
  const root = scratch();
  const inside = join(root, 'state');
  mkdirSync(inside, { recursive: true });
  assert.doesNotThrow(() => writeState({ dir: inside, state: emptyState() }));
  assert.doesNotThrow(() => readState({ dir: inside }));
  assert.throws(() => readState({ dir: inside, root }), /inside the checkout/);
});
