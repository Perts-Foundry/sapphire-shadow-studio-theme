// articles:pull: `--check` reports, `--seed` records, and nothing reachable from argv writes a repo file.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FLAG_SPEC, run } from '../pull.mjs';
import { toExitCode } from '../lib/context.mjs';
import { liveProjection, projectionSha } from '../lib/projection.mjs';
import { readState } from '../lib/state.mjs';
import { readRepoArticle } from '../repo.mjs';
import { HANDLE, TEST_DIR, cleanRoot, cleanup, madeRoots, readArticle, reindexInPlace, writeArticle } from './helpers.mjs';
import {
  ARTICLE_GID,
  cleanupDirs,
  madeDirs,
  makeClient,
  makeCtx,
  nodeFromRepo,
  seedIntent,
  seedObservation,
  snapshotTree,
} from './network-helpers.mjs';

after(() => {
  for (const dir of [...madeRoots(), ...madeDirs()]) assert.ok(dir.startsWith(tmpdir()), `${dir} is not under the temp root`);
  cleanupDirs();
  cleanup();
});

const ORPHAN_GID = 'gid://shopify/Article/2';
const orphanOf = (root) => nodeFromRepo(root, HANDLE, { id: ORPHAN_GID, handle: 'orphan-post', title: 'Only in Admin' });
const articlesDir = (root) => join(root, 'marketing', 'articles');
const stateFileText = (dir) => {
  try {
    return readFileSync(join(dir, 'observed.json'), 'utf8');
  } catch {
    return null;
  }
};

function editTitle(root) {
  const article = readArticle(root);
  article.title = 'Edited in the repo';
  writeArticle(root, article);
  reindexInPlace(root);
}

test('--seed records the observed sha of every live article, and touches nothing under marketing/articles/', async () => {
  const root = cleanRoot();
  const node = nodeFromRepo(root);
  const orphan = orphanOf(root);
  const client = makeClient({ articles: [node, orphan] });
  const { ctx, stateDir, logs } = makeCtx({ root, client });
  seedIntent(stateDir);
  seedObservation(stateDir, { ...node, id: 'gid://shopify/Article/999', handle: 'deleted-in-admin' });
  const tree = snapshotTree(articlesDir(root));

  const result = await run(['--seed'], ctx);
  assert.equal(result.code, 0);
  assert.deepEqual(snapshotTree(articlesDir(root)), tree);

  const state = readState({ dir: stateDir });
  assert.deepEqual(Object.keys(state.articles).sort(), [ARTICLE_GID, ORPHAN_GID]);
  assert.equal(state.articles[ARTICLE_GID].liveSha256, projectionSha(liveProjection(node)));
  assert.equal(state.articles[ARTICLE_GID].matchedRepoSha256, readRepoArticle(root, HANDLE).sha);
  assert.equal(state.articles[ORPHAN_GID].liveSha256, projectionSha(liveProjection(orphan)));
  assert.equal(state.articles[ORPHAN_GID].matchedRepoSha256, null);
  assert.deepEqual(state.intents, {});
  assert.ok(logs.includes(`cleared the interrupted-push record for ${HANDLE}`), logs.join('\n'));
  assert.ok(logs.includes('dropped the observation for gid://shopify/Article/999, which is no longer live'), logs.join('\n'));
  assert.ok(logs.includes('NOTHING under marketing/articles/ was touched.'));
  assert.equal(client.calls.filter((c) => c.kind !== 'query').length, 0);
});

test('--seed records a null match when the repo differs from what is live', async () => {
  const root = cleanRoot();
  const node = nodeFromRepo(root);
  editTitle(root);
  const { ctx, stateDir } = makeCtx({ root, client: makeClient({ articles: [node] }) });
  await run(['--seed'], ctx);
  assert.equal(readState({ dir: stateDir }).articles[ARTICLE_GID].matchedRepoSha256, null);
});

test('no body-overwriting path is reachable from argv', async () => {
  // The flag set is closed and has no writing mode in it.
  assert.deepEqual(Object.keys(FLAG_SPEC).sort(), ['--check', '--seed']);
  for (const argv of [[], ['--check', '--seed'], ['--discard-local'], ['--write'], ['--force'], ['--seed=yes'], ['welcome-to-shift-notes'], ['--root', '/tmp']]) {
    const root = cleanRoot();
    const client = makeClient({ articles: [nodeFromRepo(root)] });
    const { ctx, stateDir } = makeCtx({ root, client });
    const tree = snapshotTree(articlesDir(root));
    assert.equal(await toExitCode(run, argv, ctx, 'pull'), 1, JSON.stringify(argv));
    assert.equal(client.calls.length, 0, `${JSON.stringify(argv)} reached the store`);
    assert.deepEqual(snapshotTree(articlesDir(root)), tree);
    assert.equal(stateFileText(stateDir), null);
  }
  // And the module cannot write a file at all: it imports no filesystem module.
  const source = readFileSync(join(TEST_DIR, '..', 'pull.mjs'), 'utf8');
  assert.equal(/from ['"]node:fs(?:\/promises)?['"]/.test(source), false, 'pull.mjs imports a filesystem module');
  assert.equal(/\b(?:writeFileSync|renameSync|cpSync|copyFileSync|rmSync|unlinkSync|mkdirSync)\b/.test(source), false);
});

test('--check exit codes: 0 in sync, 2 for each kind of drift, and it writes nothing', async () => {
  const cases = [
    {
      label: 'in sync',
      code: 0,
      build: (root) => {
        const node = nodeFromRepo(root);
        return { articles: [node], seed: [node] };
      },
    },
    {
      label: 'repo ahead',
      code: 2,
      build: (root) => {
        const node = nodeFromRepo(root);
        editTitle(root);
        return { articles: [node], seed: [node] };
      },
    },
    {
      label: 'Admin moved',
      code: 2,
      build: (root) => {
        const node = nodeFromRepo(root);
        return { articles: [{ ...node, summary: 'Edited in Admin.' }], seed: [node] };
      },
    },
    {
      label: 'live only',
      code: 2,
      build: (root) => {
        const node = nodeFromRepo(root);
        const orphan = orphanOf(root);
        return { articles: [node, orphan], seed: [node, orphan] };
      },
    },
    { label: 'never pushed', code: 2, build: () => ({ articles: [], seed: [] }) },
    { label: 'no state file', code: 2, build: (root) => ({ articles: [nodeFromRepo(root)], seed: null }) },
  ];
  for (const { label, code, build } of cases) {
    const root = cleanRoot();
    const { articles, seed } = build(root);
    const client = makeClient({ articles });
    const { ctx, stateDir, logs } = makeCtx({ root, client });
    for (const node of seed ?? []) seedObservation(stateDir, node);
    const before = stateFileText(stateDir);
    const tree = snapshotTree(articlesDir(root));
    assert.equal(await toExitCode(run, ['--check'], ctx, 'pull'), code, `${label}:\n${logs.join('\n')}`);
    assert.equal(stateFileText(stateDir), before, `${label}: --check wrote the state file`);
    assert.deepEqual(snapshotTree(articlesDir(root)), tree);
    assert.equal(client.calls.filter((c) => c.kind !== 'query').length, 0);
  }
});

test('--check names the state and the one next step', async () => {
  const root = cleanRoot();
  const node = nodeFromRepo(root);
  editTitle(root);
  const { ctx, stateDir, logs } = makeCtx({ root, client: makeClient({ articles: [node] }) });
  seedObservation(stateDir, node);
  await run(['--check'], ctx);
  assert.deepEqual(logs, [
    `${HANDLE}: repo ahead: a push is outstanding`,
    `  next: the article push for ${HANDLE}, dry run first (scripts/articles/README.md)`,
    'articles:pull --check found drift in 1 article(s). Nothing was written.',
  ]);
});
