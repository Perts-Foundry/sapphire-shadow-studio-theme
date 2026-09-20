// The reviewed-tree gate against REAL git, with nothing injected.
//
// EXEMPT IMPORTER. This is one of the two paths test/no-invocation.test.mjs allows to import the push
// module. It imports the gate function only, and no client exists anywhere in this file.
//
// WHY A SECOND LAYER. The strict fake proves the gate reacts correctly to what git says. It cannot
// prove the argv the gate emits is one real git accepts, or that its pathspec matches the files it
// means to: a staged rename, an untracked file, an ignored file, a linked worktree. Each case below is
// a real repository with a real bare origin, built under the temp directory.
//
// It must pass when the suite runs as root in CI and from a linked worktree, so nothing here relies
// on file permissions, and git identity and signing are set per invocation with `-c` rather than from
// the environment or the machine's global config.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { assertReviewedTree } from '../push.mjs';
import { CLEAN_FIXTURE, HANDLE, addSecondArticle, reindexInPlace } from './helpers.mjs';
import { cleanupDirs, madeDirs, tempDir } from './network-helpers.mjs';

const OTHER = 'second-article';
const RENAMED = 'welcome-renamed';

/**
 * Identity, no signing, no hooks, no gc or maintenance: per invocation, so a developer's global
 * config cannot interfere and no harness command leaves a git child running to race the teardown.
 * The gate's own fetch and the bare origin's receive-pack never see these flags; `disableMaintenance`
 * covers them.
 */
const SETUP_CONFIG = [
  '-c', 'user.name=Test',
  '-c', 'user.email=test@example.com',
  '-c', 'gc.auto=0',
  '-c', 'gc.autoDetach=false',
  '-c', 'maintenance.auto=false',
  '-c', 'commit.gpgsign=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'init.defaultBranch=main',
];

function git(cwd, ...args) {
  return execFileSync('git', [...SETUP_CONFIG, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

after(() => {
  for (const dir of madeDirs()) assert.ok(dir.startsWith(tmpdir()), `${dir} is not under the temp root`);
  cleanupDirs();
});

/**
 * Written into each repo's own config, so it also reaches the production gate's `fetch` (which runs
 * without `SETUP_CONFIG`) and the push's receive-pack in the bare origin (which git strips `-c` from).
 */
function disableMaintenance(repo) {
  git(repo, 'config', 'gc.auto', '0');
  git(repo, 'config', 'gc.autoDetach', 'false');
  git(repo, 'config', 'maintenance.auto', 'false');
}

/** A working repository holding two committed articles, pushed to a bare origin. */
function makeRepos() {
  const base = tempDir('articles-git-');
  const origin = join(base, 'origin.git');
  const work = join(base, 'work');
  git(base, 'init', '--quiet', '--bare', origin);
  disableMaintenance(origin);
  cpSync(CLEAN_FIXTURE, work, { recursive: true });
  addSecondArticle(work, OTHER);
  reindexInPlace(work);
  writeFileSync(join(work, '.gitignore'), '/article-images/\n/.claude/worktrees/\n', 'utf8');
  git(work, 'init', '--quiet');
  disableMaintenance(work);
  git(work, 'add', '--all');
  git(work, 'commit', '--quiet', '-m', 'articles');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '--quiet', 'origin', 'main');
  return { base, origin, work };
}

const articleFile = (root, handle, name) => join(root, 'marketing', 'articles', handle, name);

test('a clean tree whose HEAD is on origin/main passes', () => {
  const { work } = makeRepos();
  assert.doesNotThrow(() => assertReviewedTree(work, [HANDLE]));
});

test('a dirty file in THIS article refuses', () => {
  const { work } = makeRepos();
  appendFileSync(articleFile(work, HANDLE, 'body.html'), '<p>edit</p>\n', 'utf8');
  assert.throws(() => assertReviewedTree(work, [HANDLE]), /has uncommitted changes/);
});

test('a dirty file in ANOTHER article does not refuse: the pathspec is scoped', () => {
  const { work } = makeRepos();
  appendFileSync(articleFile(work, OTHER, 'body.html'), '<p>edit</p>\n', 'utf8');
  assert.doesNotThrow(() => assertReviewedTree(work, [HANDLE]));
  assert.throws(() => assertReviewedTree(work, [OTHER]), /has uncommitted changes/);
});

test('a dirty top-level manifest refuses', () => {
  const { work } = makeRepos();
  appendFileSync(join(work, 'marketing', 'articles', 'manifest.json'), '\n', 'utf8');
  assert.throws(() => assertReviewedTree(work, [HANDLE]), /has uncommitted changes/);
});

test('an untracked new file in the article directory refuses', () => {
  const { work } = makeRepos();
  writeFileSync(articleFile(work, HANDLE, 'notes.txt'), 'draft\n', 'utf8');
  assert.throws(() => assertReviewedTree(work, [HANDLE]), /has uncommitted changes/);
});

test('a staged but uncommitted change refuses', () => {
  const { work } = makeRepos();
  appendFileSync(articleFile(work, HANDLE, 'body.html'), '<p>staged</p>\n', 'utf8');
  git(work, 'add', '--all');
  assert.throws(() => assertReviewedTree(work, [HANDLE]), /has uncommitted changes/);
});

test('a staged delete refuses', () => {
  const { work } = makeRepos();
  git(work, 'rm', '--quiet', articleFile(work, HANDLE, 'images.json'));
  assert.throws(() => assertReviewedTree(work, [HANDLE]), /has uncommitted changes/);
});

test('a staged rename of the directory refuses, looked up by the new handle, the old, or both', () => {
  const { work } = makeRepos();
  git(work, 'mv', join('marketing', 'articles', HANDLE), join('marketing', 'articles', RENAMED));
  assert.throws(() => assertReviewedTree(work, [RENAMED]), /has uncommitted changes/);
  assert.throws(() => assertReviewedTree(work, [HANDLE]), /has uncommitted changes/);
  assert.throws(() => assertReviewedTree(work, [RENAMED, HANDLE]), /has uncommitted changes/);
});

test('an ignored file under article-images/ does not refuse', () => {
  const { work } = makeRepos();
  mkdirSync(join(work, 'article-images', HANDLE), { recursive: true });
  writeFileSync(join(work, 'article-images', HANDLE, 'bench-overview.jpg'), 'not really a jpeg', 'utf8');
  assert.equal(git(work, 'status', '--porcelain'), '', 'the fixture is wrong: the image should be ignored');
  assert.doesNotThrow(() => assertReviewedTree(work, [HANDLE]));
});

test('a missing origin refuses, naming the fetch', () => {
  const { work } = makeRepos();
  git(work, 'remote', 'remove', 'origin');
  assert.throws(() => assertReviewedTree(work, [HANDLE]), /git fetch origin main/);
});

test('a STALE local origin/main is fetched before the ancestor check, so a merged HEAD passes', () => {
  const { work } = makeRepos();
  const before = git(work, 'rev-parse', 'HEAD');
  writeFileSync(join(work, 'NOTES.md'), 'merged elsewhere\n', 'utf8');
  git(work, 'add', '--all');
  git(work, 'commit', '--quiet', '-m', 'later');
  git(work, 'push', '--quiet', 'origin', 'main');
  git(work, 'update-ref', 'refs/remotes/origin/main', before);
  assert.throws(() => git(work, 'merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/main'), 'the fixture is wrong: the local ref should be stale');
  assert.doesNotThrow(() => assertReviewedTree(work, [HANDLE]));
  assert.equal(git(work, 'rev-parse', 'refs/remotes/origin/main'), git(work, 'rev-parse', 'HEAD'));
});

test('HEAD ahead of origin/main refuses', () => {
  const { work } = makeRepos();
  writeFileSync(join(work, 'NOTES.md'), 'unmerged\n', 'utf8');
  git(work, 'add', '--all');
  git(work, 'commit', '--quiet', '-m', 'unmerged');
  assert.throws(() => assertReviewedTree(work, [HANDLE]), /not an ancestor of origin\/main/);
});

test('a detached HEAD at a merged commit passes, and at an unmerged one refuses', () => {
  const { work } = makeRepos();
  git(work, 'checkout', '--quiet', '--detach', 'HEAD');
  assert.doesNotThrow(() => assertReviewedTree(work, [HANDLE]));
  writeFileSync(join(work, 'NOTES.md'), 'detached work\n', 'utf8');
  git(work, 'add', '--all');
  git(work, 'commit', '--quiet', '-m', 'detached');
  assert.throws(() => assertReviewedTree(work, [HANDLE]), /not an ancestor of origin\/main/);
});

test('a local BRANCH and a local TAG named origin/main at an unmerged commit cannot stand in for the base', () => {
  // Bare `origin/main` resolves through git's refname search order, where refs/tags/ and refs/heads/
  // come before refs/remotes/. So with a tag at HEAD, the old spelling compared HEAD with itself.
  const { work } = makeRepos();
  writeFileSync(join(work, 'NOTES.md'), 'unmerged\n', 'utf8');
  git(work, 'add', '--all');
  git(work, 'commit', '--quiet', '-m', 'unmerged');
  git(work, 'branch', 'origin/main');
  git(work, 'tag', 'origin/main');
  assert.equal(
    git(work, 'rev-parse', 'origin/main'),
    git(work, 'rev-parse', 'HEAD'),
    'the fixture is wrong: the ambiguous short name should resolve to the planted local ref',
  );
  assert.throws(() => assertReviewedTree(work, [HANDLE]), /not an ancestor of origin\/main/);
});

test('after a COMMITTED rename, an untracked file back in the previous handle\'s directory refuses', () => {
  const { work } = makeRepos();
  git(work, 'mv', join('marketing', 'articles', HANDLE), join('marketing', 'articles', RENAMED));
  git(work, 'commit', '--quiet', '-m', 'rename');
  git(work, 'push', '--quiet', 'origin', 'main');
  assert.doesNotThrow(() => assertReviewedTree(work, [RENAMED, HANDLE]));
  mkdirSync(join(work, 'marketing', 'articles', HANDLE), { recursive: true });
  writeFileSync(articleFile(work, HANDLE, 'notes.txt'), 'left behind\n', 'utf8');
  assert.throws(() => assertReviewedTree(work, [RENAMED, HANDLE]), /has uncommitted changes/);
});

test('a handle that is a PREFIX of another does not match it: a dirty foo-bar does not refuse foo', () => {
  const { work } = makeRepos();
  const LONGER = `${HANDLE}-part-two`;
  addSecondArticle(work, LONGER);
  reindexInPlace(work);
  git(work, 'add', '--all');
  git(work, 'commit', '--quiet', '-m', 'longer handle');
  git(work, 'push', '--quiet', 'origin', 'main');
  appendFileSync(articleFile(work, LONGER, 'body.html'), '<p>edit</p>\n', 'utf8');
  writeFileSync(articleFile(work, LONGER, 'notes.txt'), 'draft\n', 'utf8');
  assert.doesNotThrow(() => assertReviewedTree(work, [HANDLE]));
  assert.throws(() => assertReviewedTree(work, [LONGER]), /has uncommitted changes/);
});

test(
  'as root, the gate still sees an unreadable untracked file and still passes a clean tree',
  { skip: process.getuid?.() === 0 ? false : 'runs only as root (uid 0), which is how CI runs this suite; permissions do not bind root, so this is the one place that proves the gate does not depend on them' },
  () => {
    const { work } = makeRepos();
    assert.doesNotThrow(() => assertReviewedTree(work, [HANDLE]));
    const file = articleFile(work, HANDLE, 'notes.txt');
    writeFileSync(file, 'draft\n', 'utf8');
    chmodSync(file, 0o000);
    assert.throws(() => assertReviewedTree(work, [HANDLE]), /has uncommitted changes/);
  },
);

test('a linked worktree under .claude/worktrees/ passes when clean and refuses when dirty', () => {
  const { work } = makeRepos();
  const tree = join(work, '.claude', 'worktrees', 'feature');
  git(work, 'worktree', 'add', '--quiet', '-b', 'feature', tree, 'main');
  assert.doesNotThrow(() => assertReviewedTree(tree, [HANDLE]));
  appendFileSync(articleFile(tree, HANDLE, 'body.html'), '<p>worktree edit</p>\n', 'utf8');
  assert.throws(() => assertReviewedTree(tree, [HANDLE]), /has uncommitted changes/);
  // The primary checkout is unaffected by a dirty linked worktree.
  assert.doesNotThrow(() => assertReviewedTree(work, [HANDLE]));
});
