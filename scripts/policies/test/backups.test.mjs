// scripts/policies/lib/backups.mjs: where the pre-mutation backup goes, and what mode it lands at.
//
// The backup is the ONLY record of what Admin held at the moment of a push (`HEAD~` is not one:
// it matches live only if nobody edited the policy in Admin since). It holds a full policy body,
// outside the checkout, on a machine that also holds the credentials that wrote it. So the modes
// are asserted as literals, not as "restrictive enough".

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';

import { writeBackup } from '../push.mjs';
import {
  BACKUP_DIR_BASENAME,
  DIR_MODE,
  FILE_MODE,
  backupFileName,
  defaultBackupDir,
  displayPath,
  resolveBackupDir,
} from '../lib/backups.mjs';

const POSIX = process.platform !== 'win32';
const NOW = '2026-01-02T03:04:05.678Z';

test('the modes are the literals the comment promises, not merely restrictive', () => {
  assert.equal(DIR_MODE, 0o700);
  assert.equal(FILE_MODE, 0o600);
});

// ---------------------------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------------------------

test('the default is an XDG state path under the basename, never inside a checkout', () => {
  const dir = defaultBackupDir({ XDG_STATE_HOME: '/var/state' });
  assert.equal(dir, join('/var/state', BACKUP_DIR_BASENAME));
});

test('a relative or blank XDG_STATE_HOME falls back to ~/.local/state', () => {
  // A relative XDG_STATE_HOME would make the backup location depend on cwd, which is the exact
  // bug workdir.mjs was rewritten to remove.
  for (const value of ['relative/state', '   ', '', undefined]) {
    const dir = defaultBackupDir({ XDG_STATE_HOME: value, HOME: '/home/tester' });
    assert.equal(dir.includes(`${sep}.local${sep}state${sep}${BACKUP_DIR_BASENAME}`), true, JSON.stringify(value));
  }
});

test('POLICIES_BACKUP_DIR wins and is resolved to an absolute path', () => {
  const dir = resolveBackupDir({ POLICIES_BACKUP_DIR: 'rel/backups', XDG_STATE_HOME: '/var/state' });
  assert.equal(dir, join(process.cwd(), 'rel', 'backups'));
  assert.equal(resolveBackupDir({ POLICIES_BACKUP_DIR: '/abs/backups' }), join(sep, 'abs', 'backups'));
});

test('a whitespace-only override does not silently become the cwd', () => {
  assert.equal(resolveBackupDir({ POLICIES_BACKUP_DIR: '   ', XDG_STATE_HOME: '/var/state' }), join('/var/state', BACKUP_DIR_BASENAME));
});

// ---------------------------------------------------------------------------------------------
// Naming and display
// ---------------------------------------------------------------------------------------------

test('the filename sorts by policy then chronologically, with no filesystem-hostile characters', () => {
  assert.equal(backupFileName('SHIPPING_POLICY', NOW), 'shipping_policy.2026-01-02T03-04-05-678Z.json');
  assert.equal(/[:]/.test(backupFileName('SHIPPING_POLICY', NOW)), false, 'a colon is illegal on Windows');
});

test('displayPath collapses $HOME, because a backup path carries the operator username', () => {
  // CLAUDE.md bars a dev-machine identifier from the tree, and this path is printed in a message
  // the operator is invited to paste into a PR or an issue.
  assert.equal(displayPath('/home/tester/.local/state/shop-policies/x.json', '/home/tester'), '~/.local/state/shop-policies/x.json');
  assert.equal(displayPath('/home/tester', '/home/tester'), '~');
  assert.equal(displayPath('/home/tester-other/x', '/home/tester'), '/home/tester-other/x', 'a prefix match is not a path match');
  assert.equal(displayPath('/var/state/x', '/home/tester'), '/var/state/x');
  assert.equal(displayPath('/var/state/x', ''), '/var/state/x', 'an unknown home must not collapse everything');
});

// ---------------------------------------------------------------------------------------------
// The modes on disk
// ---------------------------------------------------------------------------------------------

const live = { id: 'gid://shopify/ShopPolicy/4', title: 'Shipping', body: '<p>Live body.</p>' };

test('a fresh backup directory and file land at 0700 / 0600', { skip: !POSIX && 'POSIX modes' }, () => {
  const parent = mkdtempSync(join(tmpdir(), 'policies-modes-'));
  const dir = join(parent, 'nested', 'backups');
  const { file } = writeBackup({ dir, type: 'SHIPPING_POLICY', live, now: NOW, domain: 'example.myshopify.com' });
  assert.equal(statSync(dir).mode & 0o777, DIR_MODE);
  assert.equal(statSync(file).mode & 0o777, FILE_MODE);
});

test('a PRE-EXISTING permissive directory is tightened, which mkdirSync alone never does', { skip: !POSIX && 'POSIX modes' }, () => {
  // `mkdirSync`'s mode argument applies only to a directory it creates. Without the explicit
  // chmod, a state directory that already existed at 0755 would keep it, and every backup of a
  // full policy body would be world-readable with nothing to say so.
  const dir = mkdtempSync(join(tmpdir(), 'policies-modes-'));
  mkdirSync(join(dir, 'sub'), { recursive: true, mode: 0o755 });
  writeBackup({ dir, type: 'REFUND_POLICY', live, now: NOW, domain: 'example.myshopify.com' });
  assert.equal(statSync(dir).mode & 0o777, DIR_MODE);
});

test('a permissive umask cannot loosen the file mode', { skip: !POSIX && 'POSIX modes' }, () => {
  const previous = process.umask(0o000);
  try {
    const dir = mkdtempSync(join(tmpdir(), 'policies-modes-'));
    const { file } = writeBackup({ dir, type: 'TERMS_OF_SERVICE', live, now: NOW, domain: 'example.myshopify.com' });
    assert.equal(statSync(file).mode & 0o777, FILE_MODE);
    assert.equal(statSync(dir).mode & 0o777, DIR_MODE);
  } finally {
    process.umask(previous);
  }
});

test('an existing backup file is a refusal: the one thing a backup must never do is overwrite one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'policies-modes-'));
  writeBackup({ dir, type: 'SHIPPING_POLICY', live, now: NOW, domain: 'example.myshopify.com' });
  assert.throws(
    () => writeBackup({ dir, type: 'SHIPPING_POLICY', live, now: NOW, domain: 'example.myshopify.com' }),
    /already exists; refusing to overwrite it/,
  );
});
