// Containment of the working directory, and the blank-id guard's coverage of it.
//
// These are regression tests for a real leak: a cwd-relative working directory created
// `scripts/blank-inventory/.blank-inventory/` (outside a root-anchored ignore pattern) holding an
// artifact with real blank ids, in a public repo, while the guard's SKIP pattern exempted that
// directory at any depth. Each assertion below pins one link of that chain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { defaultWorkDir, resolveWorkDir, findOrphanWorkDir, WORK_DIR_BASENAME } from '../lib/workdir.mjs';
import { findSuspectTokens } from '../check-no-real-blank-ids.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

test('the default working directory is outside the repository', () => {
  const dir = defaultWorkDir({ HOME: os.homedir() });
  assert.ok(path.isAbsolute(dir), 'must be absolute');
  assert.ok(
    !path.resolve(dir).startsWith(REPO_ROOT + path.sep),
    `default work dir ${dir} must not sit inside the checkout at ${REPO_ROOT}: artifacts hold real blank ids and this repo is public`
  );
});

test('defaultWorkDir honours XDG_STATE_HOME when it is absolute', () => {
  const dir = defaultWorkDir({ XDG_STATE_HOME: '/var/tmp/state' });
  assert.equal(dir, path.join('/var/tmp/state', 'blank-inventory'));
});

test('defaultWorkDir ignores a relative XDG_STATE_HOME rather than resolving it against cwd', () => {
  // A relative value here would reintroduce cwd dependence, which is the whole bug.
  const dir = defaultWorkDir({ XDG_STATE_HOME: 'relative/state' });
  assert.ok(path.isAbsolute(dir));
  assert.ok(!dir.includes('relative/state'));
});

test('BLANK_INVENTORY_DIR overrides and is resolved to an absolute path', () => {
  const dir = resolveWorkDir({ BLANK_INVENTORY_DIR: '/tmp/bi-override' });
  assert.equal(dir, '/tmp/bi-override');
});

test('a relative BLANK_INVENTORY_DIR is made absolute, never left cwd-relative', () => {
  const dir = resolveWorkDir({ BLANK_INVENTORY_DIR: './some/where' });
  assert.ok(path.isAbsolute(dir), 'an override must not stay relative');
  assert.equal(dir, path.resolve('./some/where'));
});

test('an empty BLANK_INVENTORY_DIR falls back to the default rather than resolving to cwd', () => {
  assert.equal(resolveWorkDir({ BLANK_INVENTORY_DIR: '   ' }), defaultWorkDir({}));
});

test('findOrphanWorkDir flags a stray directory under a different cwd', () => {
  const resolved = '/home/someone/.local/state/blank-inventory';
  const orphan = findOrphanWorkDir('/repo/scripts/blank-inventory', resolved);
  assert.equal(orphan, path.join('/repo/scripts/blank-inventory', WORK_DIR_BASENAME));
});

test('findOrphanWorkDir returns null when cwd already holds the resolved work dir', () => {
  const resolved = path.join('/repo', WORK_DIR_BASENAME);
  assert.equal(findOrphanWorkDir('/repo', resolved), null);
});

// --- guard coverage -------------------------------------------------------

test('the guard module imports cleanly with no entry script', () => {
  // Regression: the main-detection dereferenced process.argv[1], which is undefined under import(),
  // so the module threw on import and none of its logic could be unit-tested.
  assert.equal(typeof findSuspectTokens, 'function');
});

test('the guard flags a supplier-encoding blank id', () => {
  const hits = findSuspectTokens('BLACK_SUPPLIERNAME_1234_M');
  assert.deepEqual(hits, ['BLACK_SUPPLIERNAME_1234_M']);
});

test('a numeric style segment alone does NOT make an id suspect', () => {
  // Pins the guard's real discriminator: numeric segments are exempt, so detection rests entirely
  // on supplier NAME tokens. Any future widening of ALLOWED_SEGMENTS must preserve this.
  assert.deepEqual(findSuspectTokens('BLACK_BLANK_1234_M'), []);
});

test('the synthetic fixture vocabulary is not flagged', () => {
  assert.deepEqual(findSuspectTokens('BLACK_ACME_FLEECE_M and GREY_ACME_FLEECE_2XL'), []);
});

test('the guard no longer exempts a .blank-inventory path at any depth', async () => {
  // The load-bearing fix. Previously SKIP matched `.blank-inventory/` anywhere, so the one
  // directory guaranteed to hold real blank ids was never scanned.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../check-no-real-blank-ids.mjs', import.meta.url), 'utf8');
  const skipLine = src.match(/^const SKIP = .*$/m)?.[0] ?? '';
  assert.ok(skipLine.length > 0, 'SKIP pattern should still exist');
  assert.ok(
    !skipLine.includes('blank-inventory'),
    'SKIP must not exempt the working directory; a leak detector that fails open on its highest-risk input is worse than none'
  );
});
