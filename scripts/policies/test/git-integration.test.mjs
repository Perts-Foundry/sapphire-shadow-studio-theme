// The git-backed gates against REAL git, with nothing injected.
//
// WHY A SECOND LAYER. `makeGitFake` proves the gate reacts correctly to what git says. It cannot
// prove that the argv production code emits is one real git accepts, or that the pathspec it uses
// actually matches the files it means to match. That gap is exactly the #154 defect: a pathspec
// could have been wrong in either direction and every injected test stayed green.
//
// So: `git init` a temp repo, commit a real marketing/policies/, dirty a real file, and call the
// gate with no `run` override at all.
//
// These tests are slower than the injected ones and deliberately few: one per gate, covering the
// refusal and the pass. Everything else stays injected.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assertReviewedTree } from '../push.mjs';
import { fileTextFor } from '../lib/policies.mjs';
import { BODIES, cleanup, makeRoot, policiesDir } from './helpers.mjs';

/**
 * A real git repository at `root`, with everything committed and `origin/main` pointing at HEAD.
 *
 * `origin/main` is faked with `update-ref` rather than a real remote: the gate resolves it with
 * `rev-parse origin/main`, which does not care how the ref got there, and a real remote would add
 * a network-shaped dependency to a unit test for no extra coverage.
 */
function initRepo(root) {
  // real-git-not-a-fake: this shells out to the actual binary, so it can answer nothing by default.
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    }).trim();
  git('init', '--quiet', '--initial-branch=main');
  git('add', '--all');
  git('commit', '--quiet', '-m', 'policies');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return git;
}

test('a real dirty policy body is refused, proving the pathspec matches what it means to match', () => {
  const root = makeRoot();
  try {
    initRepo(root);
    // No `run` override: this is the production `execFileSync` path end to end.
    assert.deepEqual(assertReviewedTree(root), { unreviewed: false }, 'a clean committed tree must pass');

    writeFileSync(join(policiesDir(root), 'shipping_policy.html'), fileTextFor(`${BODIES.SHIPPING_POLICY}\n<p>edit</p>`), 'utf8');
    assert.throws(() => assertReviewedTree(root), /uncommitted policy bodies/);
  } finally {
    cleanup(root);
  }
});

test('an untracked policy body is refused too: `??` is a dirty tree, not an empty status', () => {
  const root = makeRoot();
  try {
    initRepo(root);
    writeFileSync(join(policiesDir(root), 'terms_of_service.html.new'), 'x\n', 'utf8');
    // Not a policy file: outside the pathspec, so it must NOT refuse.
    assert.deepEqual(assertReviewedTree(root), { unreviewed: false });

    writeFileSync(join(policiesDir(root), 'legal_notice.html'), 'x\n', 'utf8');
    assert.throws(() => assertReviewedTree(root), /uncommitted policy bodies/);
  } finally {
    cleanup(root);
  }
});

test('a dirty file elsewhere in the repo does not refuse: the pathspec is scoped', () => {
  const root = makeRoot();
  try {
    initRepo(root);
    writeFileSync(join(root, 'README.md'), '# not a policy\n', 'utf8');
    assert.deepEqual(assertReviewedTree(root), { unreviewed: false });
  } finally {
    cleanup(root);
  }
});

test('HEAD ahead of origin/main is refused by real git, and --allow-unreviewed passes', () => {
  const root = makeRoot();
  try {
    const git = initRepo(root);
    writeFileSync(join(root, 'README.md'), '# a later commit\n', 'utf8');
    git('add', '--all');
    git('commit', '--quiet', '-m', 'later');
    assert.throws(() => assertReviewedTree(root), /not an ancestor of origin\/main/);
    assert.deepEqual(assertReviewedTree(root, { allowUnreviewed: true }), { unreviewed: true });
  } finally {
    cleanup(root);
  }
});

test('a manifest dirty only in the observation fields passes against real git', () => {
  const root = makeRoot();
  try {
    initRepo(root);
    const file = join(policiesDir(root), 'manifest.json');
    const manifest = JSON.parse(execFileSync('git', ['show', 'HEAD:marketing/policies/manifest.json'], { cwd: root, encoding: 'utf8' }));
    manifest.policies.shipping_policy.remote = { sha256: 'a'.repeat(64), length: 1, observedAt: '2027-01-01T00:00:00.000Z' };
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    assert.deepEqual(assertReviewedTree(root), { unreviewed: false });

    manifest.policies.shipping_policy.sha256 = 'b'.repeat(64);
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    assert.throws(() => assertReviewedTree(root), /beyond the `remote` and `pulledAt` observation fields/);
  } finally {
    cleanup(root);
  }
});
