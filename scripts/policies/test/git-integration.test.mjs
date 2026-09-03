// The git-backed gates against REAL git, with nothing injected.
//
// THIS FILE BUILDS NO FAKE AT ALL; it is the layer below them.
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
//
// Two gates live here now: push's "all of marketing/policies/ is clean", and pull's "the bodies I
// am about to overwrite are clean". The second is what makes bare `policies:pull` safe to run.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assertReviewedTree } from '../push.mjs';
import { assertBodiesClean, run as pullRun } from '../pull.mjs';
import { fileTextFor } from '../lib/policies.mjs';
import { BODIES, cleanup, liveFrom, makeClient, makeRoot, makeStateDir, policiesDir, seedState } from './helpers.mjs';

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
    assert.throws(() => assertReviewedTree(root), /has uncommitted changes/);
  } finally {
    cleanup(root);
  }
});

test('a dirty MANIFEST is refused too: a push writes nothing into the tree any more', () => {
  // The per-field exemption for `remote` and `pulledAt` is gone, along with the HEAD read and the
  // JSON reshape it needed. This is what proves the simpler gate against real git.
  const root = makeRoot();
  try {
    initRepo(root);
    const file = join(policiesDir(root), 'manifest.json');
    writeFileSync(file, `${readFileSync(file, 'utf8').replace('"version": 1', '"version":  1')}`, 'utf8');
    assert.throws(() => assertReviewedTree(root), /has uncommitted changes/);
  } finally {
    cleanup(root);
  }
});

test('an untracked file under marketing/policies/ is refused: `??` is a dirty tree', () => {
  const root = makeRoot();
  try {
    initRepo(root);
    writeFileSync(join(policiesDir(root), 'legal_notice.html'), 'x\n', 'utf8');
    assert.throws(() => assertReviewedTree(root), /has uncommitted changes/);
  } finally {
    cleanup(root);
  }
});

test('pull\'s dirty gate refuses against real git, and its pathspec is scoped to the named bodies', async () => {
  // No fake can prove the pathspec production code emits is one real git accepts, and this gate
  // is the only thing standing between bare `policies:pull` and a destroyed wording edit.
  const root = makeRoot();
  const stateDir = makeStateDir();
  try {
    initRepo(root);
    assert.doesNotThrow(() => assertBodiesClean(root, ['SHIPPING_POLICY', 'REFUND_POLICY']));

    writeFileSync(join(policiesDir(root), 'refund_policy.html'), fileTextFor(`${BODIES.REFUND_POLICY}\n<p>edit</p>`), 'utf8');
    assert.throws(() => assertBodiesClean(root, ['REFUND_POLICY']), /would OVERWRITE/);
    // Scoped: a pull that is not going to touch the refund policy must not refuse because of it.
    assert.doesNotThrow(() => assertBodiesClean(root, ['SHIPPING_POLICY']));

    // And end to end through `run`, with nothing injected: the real gate, the real pathspec.
    // The baseline has to be seeded first, or the no-observation refusal fires before the dirty
    // one and this would prove the wrong gate.
    const live = liveFrom({ ...BODIES, REFUND_POLICY: `${BODIES.REFUND_POLICY}\n<p>admin edit</p>` });
    seedState(stateDir);
    await assert.rejects(
      () => pullRun({ client: makeClient({ live }), root, now: '2026-01-02T03:04:05.000Z', stateDir }),
      /would OVERWRITE/,
    );
  } finally {
    cleanup(root);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a dirty file elsewhere in the repo does not refuse either gate: both pathspecs are scoped', () => {
  const root = makeRoot();
  try {
    initRepo(root);
    writeFileSync(join(root, 'README.md'), '# not a policy\n', 'utf8');
    assert.deepEqual(assertReviewedTree(root), { unreviewed: false });
    assert.doesNotThrow(() => assertBodiesClean(root, ['SHIPPING_POLICY']));
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

test('the ancestor refusal names the recovery, and says why main is not a place to commit', () => {
  const root = makeRoot();
  try {
    const git = initRepo(root);
    writeFileSync(join(root, 'README.md'), '# later\n', 'utf8');
    git('add', '--all');
    git('commit', '--quiet', '-m', 'later');
    assert.throws(() => assertReviewedTree(root), (err) => {
      assert.match(err.message, /Merge the PR/);
      assert.match(err.message, /git switch main && git pull/);
      assert.match(err.message, /never a licence to commit to main/);
      return true;
    });
  } finally {
    cleanup(root);
  }
});
