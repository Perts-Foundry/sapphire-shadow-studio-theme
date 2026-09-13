import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  stateDir, repoRoots, assertOutsideRepo, realpathNearest, saveRun, loadLatest, loadLatestComparable,
} from '../lib/baseline.mjs';
import { REPO_ROOT } from './harness.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'search-console-baseline-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const fresh = (name) => {
  const dir = path.join(tmp, `${name}-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/** A primary checkout with a linked worktree inside it, the layout .claude/worktrees/ produces. */
function fakeCheckout() {
  const primary = fresh('primary');
  fs.mkdirSync(path.join(primary, '.git', 'worktrees', 'wt'), { recursive: true });
  fs.writeFileSync(path.join(primary, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
  const worktree = path.join(primary, '.claude', 'worktrees', 'wt');
  fs.mkdirSync(path.join(worktree, 'scripts', 'search-console'), { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(primary, '.git', 'worktrees', 'wt')}\n`);
  return { primary, worktree };
}

const refuses = (dir, roots) => assert.throws(() => assertOutsideRepo(dir, roots), /inside the repository/);

test('stateDir: override, then XDG_STATE_HOME, then HOME', () => {
  assert.equal(stateDir({ SEARCH_CONSOLE_STATE_DIR: '/x/state', HOME: '/h' }), path.resolve('/x/state'));
  assert.equal(stateDir({ XDG_STATE_HOME: '/xdg', HOME: '/h' }), path.join('/xdg', 'search-console'));
  assert.equal(stateDir({ XDG_STATE_HOME: 'relative', HOME: '/h' }), path.join('/h', '.local', 'state', 'search-console'));
  assert.equal(stateDir({ HOME: '/h' }), path.join('/h', '.local', 'state', 'search-console'));
  assert.equal(stateDir({ SEARCH_CONSOLE_STATE_DIR: '  ', HOME: '/h' }), path.join('/h', '.local', 'state', 'search-console'));
});

test('repoRoots: a plain checkout, a linked worktree, and outside any checkout', () => {
  const plain = fresh('plain');
  fs.mkdirSync(path.join(plain, '.git'));
  fs.mkdirSync(path.join(plain, 'a', 'b'), { recursive: true });
  assert.deepEqual(repoRoots(path.join(plain, 'a', 'b')), [plain]);

  const { primary, worktree } = fakeCheckout();
  assert.deepEqual(repoRoots(path.join(worktree, 'scripts', 'search-console')), [worktree, primary]);

  assert.deepEqual(repoRoots(fresh('nowhere')).length <= 1, true);
});

test('repoRoots from this suite includes the checkout it runs in', () => {
  const roots = repoRoots(path.join(REPO_ROOT, 'scripts', 'search-console', 'lib')).map((r) => realpathNearest(r));
  assert.ok(roots.includes(realpathNearest(REPO_ROOT)), JSON.stringify(roots));
});

test('assertOutsideRepo: lexically inside is refused, outside is accepted', () => {
  const { primary, worktree } = fakeCheckout();
  const roots = [worktree, primary];
  refuses(path.join(worktree, 'state'), roots);
  refuses(worktree, roots);
  assert.doesNotThrow(() => assertOutsideRepo(fresh('outside'), roots));
  assert.doesNotThrow(() => assertOutsideRepo(`${primary}-sibling`, roots), 'a sibling sharing a name prefix is outside');
});

test('assertOutsideRepo: the primary checkout is refused when running from a worktree', () => {
  const { primary, worktree } = fakeCheckout();
  refuses(path.join(primary, 'state'), repoRoots(path.join(worktree, 'scripts', 'search-console')));
});

test('assertOutsideRepo: a directory that does not exist yet is judged by its ancestor', () => {
  const { primary, worktree } = fakeCheckout();
  refuses(path.join(worktree, 'not', 'yet', 'here'), [worktree, primary]);
  assert.doesNotThrow(() => assertOutsideRepo(path.join(fresh('elsewhere'), 'not', 'yet'), [worktree, primary]));
});

test('assertOutsideRepo: symlinks in both directions', () => {
  const { primary, worktree } = fakeCheckout();
  const roots = [worktree, primary];

  // An outside-looking path that is a link into the checkout.
  const inward = path.join(fresh('links'), 'state');
  fs.symlinkSync(path.join(worktree, 'scripts'), inward);
  refuses(inward, roots);
  refuses(path.join(inward, 'deeper', 'new'), roots);

  // The roots named through a link, the state dir named by its real path.
  const linkToRoot = path.join(fresh('links'), 'checkout');
  fs.symlinkSync(primary, linkToRoot);
  refuses(path.join(primary, 'state'), [linkToRoot]);
  refuses(path.join(linkToRoot, 'state'), [primary]);
});

test('saveRun: a stamp collision gets the next counter, and lexical order is write order', () => {
  const dir = fresh('runs');
  const now = new Date('2026-12-01T15:00:00Z');
  const a = saveRun(dir, { mode: 'audit', now, findings: [{ check: 'a' }] });
  const b = saveRun(dir, { mode: 'audit', now, findings: [{ check: 'b' }] });
  assert.notEqual(a, b);
  assert.match(path.basename(a), /-00\.json$/);
  assert.match(path.basename(b), /-01\.json$/);
  assert.equal(loadLatest(dir, 'audit').findings[0].check, 'b');
  assert.throws(() => saveRun(dir, { mode: '../escape', now }), /unknown mode/);
});

test('loadLatestComparable skips runs where the report was not ready, and other modes', () => {
  const dir = fresh('comparable');
  const t = (m) => new Date(Date.UTC(2026, 11, 1, 0, m));
  saveRun(dir, { mode: 'audit', now: t(1), reportStatus: { performance: 'ok' }, findings: [{ check: 'first' }] });
  saveRun(dir, { mode: 'audit', now: t(2), reportStatus: { performance: 'not-ready' }, findings: [{ check: 'second' }] });
  saveRun(dir, { mode: 'insights', now: t(3), reportStatus: { performance: 'ok' }, findings: [{ check: 'insights' }] });
  assert.equal(loadLatestComparable(dir, 'audit', 'performance').findings[0].check, 'first');
  assert.equal(loadLatestComparable(dir, 'audit', 'envelope').findings[0].check, 'second');
  assert.equal(loadLatestComparable(dir, 'insights', 'performance').findings[0].check, 'insights');
  assert.equal(loadLatestComparable(dir, 'audit', 'cwv'), null);
  assert.equal(loadLatest(fresh('empty'), 'audit'), null);
  assert.equal(loadLatest(path.join(tmp, 'missing-dir'), 'audit'), null);
});

test('an unreadable run file is skipped, and a stray file is ignored', () => {
  const dir = fresh('corrupt');
  saveRun(dir, { mode: 'audit', now: new Date('2026-12-01T00:00:00Z'), findings: [{ check: 'good' }] });
  fs.writeFileSync(path.join(dir, 'audit-2026-12-02T00-00-00-000Z-00.json'), '{ truncated');
  fs.writeFileSync(path.join(dir, 'audit-notes.json'), '{"findings":[{"check":"stray"}]}');
  assert.equal(loadLatest(dir, 'audit').findings[0].check, 'good');
});
