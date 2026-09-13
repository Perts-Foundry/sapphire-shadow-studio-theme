// The article push: one recording-fake test per gate, and the properties around them.
//
// EXEMPT IMPORTER. This file is one of the two paths test/no-invocation.test.mjs allows to import the
// push module, and it is held to that file's rules: it imports gate functions and `run` only, never
// `main`, and builds every context over fakes. Nothing here can reach a store.
//
// Every gate has a test whose name starts `[gate:<id>]`, and the last test in this file fails if an
// exported gate id has none. Refusals are proved to have sent no mutation by reading the fake's call
// log, and to have written nothing by comparing state and backup directories before and after.

import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { GATES, PUSH_SCOPES, SUCCESS_MARKER, VERIFY_ATTEMPTS, assertReviewedTree, run, writeBackup } from '../push.mjs';
import { assertAllGitFakesExhausted, makeGitFake } from '../../lib/git-fake.mjs';
import { fileTextFor } from '../lib/articles.mjs';
import { DIR_MODE, FILE_MODE, backupRecord } from '../lib/backups.mjs';
import { toExitCode } from '../lib/context.mjs';
import { buildArticleInput } from '../lib/mutations.mjs';
import { WRITTEN_FIELDS, liveProjection, projectionSha } from '../lib/projection.mjs';
import { CHECK_COMMAND, SEED_COMMAND, readState } from '../lib/state.mjs';
import { readRepoArticle } from '../repo.mjs';
import {
  HANDLE,
  addSecondArticle,
  cleanRoot,
  cleanup,
  madeRoots,
  readArticle,
  readBody,
  readImages,
  reindexInPlace,
  writeArticle,
  writeBody,
  writeImages,
} from './helpers.mjs';
import {
  ARTICLE_GID,
  BLOG_GID,
  FakeClientRefusal,
  NOW,
  VISIBLE,
  cleanupDirs,
  madeDirs,
  makeClient,
  makeCtx,
  nodeFromRepo,
  rehostedUrl,
  renameArticleDir,
  seedIntent,
  seedObservation,
  snapshotTree,
  tempDir,
} from './network-helpers.mjs';

const POSIX = process.platform !== 'win32';
const RENAMED = 'welcome-renamed';
const TITLE_EDIT = 'Welcome to Shift Notes, revised';
const IMG = 'https://cdn.shopify.com/s/files/1/0000/0001/files/bench-overview.jpg';

after(() => {
  assertAllGitFakesExhausted(assert);
  for (const dir of [...madeRoots(), ...madeDirs()]) assert.ok(dir.startsWith(tmpdir()), `${dir} is not under the temp root`);
  cleanupDirs();
  cleanup();
});

/** The five invocations gate 3 makes on a clean, merged tree. */
function cleanGit(handles = [HANDLE], options = {}) {
  return makeGitFake([
    { args: ['fetch', '--quiet', 'origin', 'main'], result: '' },
    { args: ['status', '--porcelain', '--untracked-files=all', '--no-renames', '--', ...handles.map((h) => `marketing/articles/${h}`), 'marketing/articles/manifest.json'], result: '' },
    { args: ['rev-parse', '--verify', 'HEAD^{commit}'], result: 'aaa111' },
    { args: ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'], result: 'bbb222' },
    { args: ['merge-base', '--is-ancestor', 'aaa111', 'bbb222'], result: '' },
  ], options);
}

/** A git fake for a run refused before gate 3; any invocation at all fails the test. */
function unreachedGit(why) {
  return makeGitFake([], { exhaustive: false, why });
}

const liveShaOf = (node) => projectionSha(liveProjection(node));
const mutationsOf = (client) => client.calls.filter((c) => c.kind === 'mutation');
const dryRun = (handle = HANDLE) => ['--handle', handle];
const confirmUpdate = (node, handle = HANDLE) => ['--handle', handle, `--confirm=${handle}`, `--expect-live-sha=${liveShaOf(node)}`];
const confirmCreate = (handle = HANDLE) => ['--handle', handle, `--confirm=${handle}`, '--expect-absent'];

/**
 * A repo whose article's title was edited and merged, a live article holding the ORIGINAL, and (by
 * default) this machine's observation of that live article: the ordinary precondition for an update.
 */
function updateSetup({ git, seed = true, nodeOverrides = {}, clientOptions = {}, env = {}, backupDir } = {}) {
  const root = cleanRoot();
  const node = nodeFromRepo(root, HANDLE, nodeOverrides);
  const article = readArticle(root);
  article.title = TITLE_EDIT;
  writeArticle(root, article);
  reindexInPlace(root);
  const client = makeClient({ articles: [node], ...clientOptions });
  const made = makeCtx({ root, client, git, env, backupDir });
  if (seed) seedObservation(made.stateDir, node);
  return { root, node, client, ...made };
}

/** A repo article with nothing live: the precondition for a create. */
function createSetup({ git, clientOptions = {} } = {}) {
  const root = cleanRoot();
  const client = makeClient({ articles: [], ...clientOptions });
  return { root, client, ...makeCtx({ root, client, git }) };
}

function stateText(stateDir) {
  const file = join(stateDir, 'observed.json');
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

// ---------------------------------------------------------------------------------------------
// Gate 0 and gate 1: before anything else
// ---------------------------------------------------------------------------------------------

test('[gate:ci-refusal] CI present refuses every invocation, dry run included, whatever its value', async () => {
  for (const value of ['true', '1', '', 'false']) {
    const { ctx, client, stateDir, backupDir } = createSetup({ git: unreachedGit('CI refuses before gate 3') });
    const env = { CI: value };
    const ciCtx = { ...ctx, env };
    for (const argv of [dryRun(), confirmCreate()]) {
      await assert.rejects(() => run(argv, ciCtx), /refuses to run with CI set/, `CI=${JSON.stringify(value)}`);
    }
    assert.equal(client.calls.length, 0, 'the CI refusal must come before any read');
    assert.equal(stateText(stateDir), null);
    assert.deepEqual(readdirSync(backupDir), []);
  }
});

test('[gate:confirm-matches-handle] --confirm must equal --handle exactly, before any read', async () => {
  for (const confirm of ['welcome', 'Welcome-to-shift-notes', `${HANDLE} `, 'yes']) {
    const { ctx, client } = createSetup({ git: unreachedGit('refused at gate 1') });
    await assert.rejects(() => run(['--handle', HANDLE, `--confirm=${confirm}`, '--expect-absent'], ctx), /--confirm: must be exactly/);
    assert.equal(client.calls.length, 0);
  }
});

// ---------------------------------------------------------------------------------------------
// Gates 2 to 5: the repo, the tree, the scopes, the blog
// ---------------------------------------------------------------------------------------------

test('[gate:check-clean] a tree articles:check refuses is never sent anywhere', async () => {
  const { root, ctx, client } = createSetup({ git: unreachedGit('refused at gate 2') });
  writeBody(root, `${readBody(root).trimEnd()}\n<script>alert(1)</script>\n`);
  reindexInPlace(root);
  await assert.rejects(() => run(dryRun(), ctx), /articles:check: is not clean; refusing to push[\s\S]*safety\/forbidden-element/);
  assert.equal(client.calls.length, 0);
});

test('[gate:reviewed-tree] a dirty article refuses before the scopes are read, and the argv is exact', async () => {
  const dirty = makeGitFake([
    { args: ['fetch', '--quiet', 'origin', 'main'], result: '' },
    { args: ['status', '--porcelain', '--untracked-files=all', '--no-renames', '--', `marketing/articles/${HANDLE}`, 'marketing/articles/manifest.json'], result: `M marketing/articles/${HANDLE}/body.html` },
  ]);
  const { ctx, client } = createSetup({ git: dirty });
  await assert.rejects(() => run(dryRun(), ctx), /has uncommitted changes/);
  assert.equal(client.calls.length, 0);
});

test('[gate:reviewed-tree] an unfetchable origin/main refuses naming the fetch, and an unmerged HEAD refuses', async () => {
  const noFetch = makeGitFake([{ args: ['fetch', '--quiet', 'origin', 'main'], throws: new Error("fatal: 'origin' does not appear to be a git repository") }]);
  assert.throws(() => assertReviewedTree('/repo', [HANDLE], { git: noFetch }), /git fetch origin main/);

  const unmerged = makeGitFake([
    { args: ['fetch', '--quiet', 'origin', 'main'], result: '' },
    { args: ['status', '--porcelain', '--untracked-files=all', '--no-renames', '--', `marketing/articles/${HANDLE}`, 'marketing/articles/manifest.json'], result: '' },
    { args: ['rev-parse', '--verify', 'HEAD^{commit}'], result: 'feature' },
    { args: ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'], result: 'main' },
    { args: ['merge-base', '--is-ancestor', 'feature', 'main'], throws: new Error('exit 1') },
  ]);
  assert.throws(() => assertReviewedTree('/repo', [HANDLE], { git: unmerged }), /HEAD: is not an ancestor of origin\/main/);
});

test('[gate:reviewed-tree] the pathspec covers every previous handle of the article too', async () => {
  const root = cleanRoot();
  renameArticleDir(root, HANDLE, RENAMED);
  const client = makeClient({ articles: [] });
  const { ctx } = makeCtx({ root, client, git: cleanGit([RENAMED, HANDLE]) });
  const result = await run(dryRun(RENAMED), ctx);
  assert.equal(result.reason, 'dry-run');
});

test('[gate:scopes] both scopes are asserted by name, before any GraphQL read', async () => {
  assert.deepEqual([...PUSH_SCOPES], ['write_online_store_pages', 'read_content']);
  for (const granted of [['read_content'], ['write_online_store_pages'], []]) {
    const { ctx, client } = createSetup({ git: cleanGit(), clientOptions: { scopes: granted } });
    await assert.rejects(() => run(dryRun(), ctx), /scopes: Missing required scope/);
    assert.equal(client.calls.length, 0, `granted ${granted.join(',')}`);
  }
});

test('[gate:blog-resolution] zero blogs, two blogs with the handle, or a truncated list all refuse', async () => {
  const cases = [
    { blogs: [], why: /found 0/ },
    { blogs: [{ id: BLOG_GID, handle: 'shift-notes' }, { id: 'gid://shopify/Blog/2', handle: 'shift-notes' }], why: /found 2/ },
    { blogs: [{ id: 'gid://shopify/Blog/9', handle: 'news' }], why: /found 0/ },
    { blogs: [{ id: BLOG_GID, handle: 'shift-notes' }], blogsHasNextPage: true, why: /cannot be proved unique/ },
  ];
  for (const { why, ...clientOptions } of cases) {
    const { ctx, client } = createSetup({ git: cleanGit(), clientOptions });
    await assert.rejects(() => run(dryRun(), ctx), why);
    assert.deepEqual(client.calls.map((c) => c.name), ['ArticlesBlogs']);
  }
});

// ---------------------------------------------------------------------------------------------
// Gates 6 and 7: freshness, keyed by GID
// ---------------------------------------------------------------------------------------------

test('[gate:live-read-freshness] ABSENT STATE PLUS A LIVE ARTICLE IS A HARD REFUSAL naming check then seed', async () => {
  const { ctx, client, stateDir, node } = updateSetup({ git: cleanGit(), seed: false });
  for (const argv of [dryRun(), confirmUpdate(node)]) {
    await assert.rejects(() => run(argv, ctx), (err) => {
      assert.match(err.message, /no observation state at/);
      assert.ok(err.message.indexOf(CHECK_COMMAND) !== -1 && err.message.indexOf(CHECK_COMMAND) < err.message.indexOf(SEED_COMMAND), err.message);
      return true;
    });
  }
  assert.equal(mutationsOf(client).length, 0);
  assert.equal(stateText(stateDir), null, 'a refusal must not seed the state it found missing');
});

test('[gate:live-read-freshness] a state file with no observation for this article refuses too', async () => {
  const { ctx, client, stateDir, node } = updateSetup({ git: cleanGit(), seed: false });
  seedObservation(stateDir, { ...node, id: 'gid://shopify/Article/777', handle: 'some-other-post' });
  await assert.rejects(() => run(dryRun(), ctx), /records nothing for it/);
  assert.equal(mutationsOf(client).length, 0);
});

test('[gate:live-read-freshness] the comparison is against a FRESH read, so an Admin edit since the observation refuses', async () => {
  const { ctx, client, node } = updateSetup({ git: cleanGit() });
  // The observation matches what was live; Admin has moved since, and only a fresh read can see it.
  client.store.set(node.id, { ...client.store.get(node.id), summary: 'Edited in Admin by hand.' });
  await assert.rejects(() => run(confirmUpdate(node), ctx), /Admin holds a version this machine has not seen/);
  assert.equal(mutationsOf(client).length, 0);
  assert.ok(client.calls.some((c) => c.name === 'ArticlesList'), 'the refusal must follow a live read');
});

test('[gate:live-read-freshness] a create with no state file at all passes the gate', async () => {
  const { ctx, stateDir } = createSetup({ git: cleanGit() });
  const result = await run(dryRun(), ctx);
  assert.equal(result.op, 'create');
  assert.equal(stateText(stateDir), null);
});

test('[gate:gid-keyed-observation] renaming the directory keeps the baseline: the target resolves through previousHandles and its observation by GID', async () => {
  const root = cleanRoot();
  const node = nodeFromRepo(root);
  renameArticleDir(root, HANDLE, RENAMED);
  const client = makeClient({ articles: [node] });
  const { ctx, stateDir, logs } = makeCtx({ root, client, git: cleanGit([RENAMED, HANDLE]) });
  seedObservation(stateDir, node);

  const dry = await run(dryRun(RENAMED), ctx);
  assert.equal(dry.op, 'update');
  assert.ok(logs.some((l) => l.includes(`renaming it from "${HANDLE}"`)), logs.join('\n'));

  const { ctx: ctx2 } = makeCtx({ root, client, git: cleanGit([RENAMED, HANDLE]), stateDir });
  const pushed = await run(confirmUpdate(node, RENAMED), ctx2);
  assert.equal(pushed.gid, ARTICLE_GID);
  const sent = mutationsOf(client);
  assert.deepEqual(sent.map((c) => c.name), ['ArticleUpdate']);
  // Whole-object equality, as for the plain update: a rename changes the handle and the redirect
  // flag and nothing else.
  assert.deepEqual(sent[0].variables, {
    id: ARTICLE_GID,
    article: {
      handle: RENAMED,
      title: 'Welcome to Shift Notes',
      author: { name: 'Sapphire Shadow Studio' },
      summary: 'Why this blog exists, what will be in it, and how often to expect anything.',
      body: readRepoArticle(root, RENAMED).body,
      tags: ['studio', 'process'],
      templateSuffix: null,
      image: { url: IMG, altText: 'A cutting bench with a folded crewneck and a tape measure' },
      isPublished: false,
      metafields: [
        { namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: 'Welcome to Shift Notes' },
        {
          namespace: 'global',
          key: 'description_tag',
          type: 'single_line_text_field',
          value: 'Short pieces about how the work gets made: fabric, fit, and the reasoning behind each decision.',
        },
      ],
      redirectNewHandle: true,
    },
  });
  // The observation migrated with the rename: same GID, new handle.
  assert.equal(readState({ dir: stateDir }).articles[ARTICLE_GID].handle, RENAMED);
});

test('[gate:gid-keyed-observation] an observation recorded under the same HANDLE but another GID is not this article\'s', async () => {
  const { ctx, client, stateDir, node } = updateSetup({ git: cleanGit(), seed: false });
  seedObservation(stateDir, node, { gid: 'gid://shopify/Article/555' });
  await assert.rejects(() => run(dryRun(), ctx), /records nothing for it/);
  assert.equal(mutationsOf(client).length, 0);
});

test('rename resolution: the old handle live updates, both live refuses, neither live creates', async () => {
  const root = cleanRoot();
  const oldNode = nodeFromRepo(root);
  renameArticleDir(root, HANDLE, RENAMED);

  const onlyOld = makeClient({ articles: [oldNode] });
  const a = makeCtx({ root, client: onlyOld, git: cleanGit([RENAMED, HANDLE]) });
  seedObservation(a.stateDir, oldNode);
  assert.equal((await run(dryRun(RENAMED), a.ctx)).op, 'update');

  const both = makeClient({ articles: [oldNode, { ...oldNode, id: 'gid://shopify/Article/2', handle: RENAMED }] });
  const b = makeCtx({ root, client: both, git: cleanGit([RENAMED, HANDLE]) });
  await assert.rejects(() => run(dryRun(RENAMED), b.ctx), /refusing to pick one/);
  assert.equal(mutationsOf(both).length, 0);

  const neither = makeClient({ articles: [] });
  const c = makeCtx({ root, client: neither, git: cleanGit([RENAMED, HANDLE]) });
  assert.equal((await run(dryRun(RENAMED), c.ctx)).op, 'create');
});

test('a create that is really an unrecorded rename refuses: an observed live article no directory claims', async () => {
  const root = cleanRoot();
  const oldNode = nodeFromRepo(root);
  renameArticleDir(root, HANDLE, RENAMED, { recordPrevious: false });
  const client = makeClient({ articles: [oldNode] });
  const { ctx, stateDir } = makeCtx({ root, client, git: cleanGit([RENAMED]) });
  seedObservation(stateDir, oldNode);
  await assert.rejects(() => run(confirmCreate(RENAMED), ctx), /add it to previousHandles/);
  assert.equal(mutationsOf(client).length, 0);
});

// ---------------------------------------------------------------------------------------------
// Gates 8 and 9: no-op and the dry run
// ---------------------------------------------------------------------------------------------

test('[gate:no-op] every written field matching is a no-op that records the observation and sends nothing', async () => {
  const root = cleanRoot();
  const node = nodeFromRepo(root);
  const client = makeClient({ articles: [node] });
  const { ctx, stateDir } = makeCtx({ root, client, git: cleanGit() });
  seedObservation(stateDir, node);
  const result = await toExitCode(run, confirmUpdate(node), ctx, 'push');
  assert.equal(result, 0);
  assert.equal(mutationsOf(client).length, 0);
  const observed = readState({ dir: stateDir }).articles[ARTICLE_GID];
  assert.equal(observed.matchedRepoSha256, readRepoArticle(root, HANDLE).sha);
  assert.equal(observed.liveSha256, liveShaOf(node));
});

test('[gate:no-op] a difference in ANY written field, not only the body, is not a no-op', async () => {
  const other = {
    title: { title: 'Another title' },
    author: { author: { name: 'Someone Else' } },
    summary: { summary: 'Another summary.' },
    tags: { tags: ['studio'] },
    templateSuffix: { templateSuffix: 'photo-story' },
    seoTitle: { titleTag: { value: 'Another SEO title' } },
    seoDescription: { descriptionTag: { value: 'Another description that is long enough to be a real description.' } },
    imageUrl: { image: { url: 'https://cdn.shopify.com/s/files/1/0000/0001/files/other.jpg', altText: 'A cutting bench with a folded crewneck and a tape measure' } },
    imageAlt: { image: { url: 'https://cdn.shopify.com/s/files/1/0000/0001/files/bench-overview.jpg', altText: 'Different alt' } },
    body: { body: '<p>Different.</p>' },
  };
  for (const field of WRITTEN_FIELDS.filter((f) => f !== 'handle' && f !== 'isPublished')) {
    assert.ok(field in other, `no case for the written field ${field}`);
    const root = cleanRoot();
    const node = nodeFromRepo(root, HANDLE, other[field]);
    const client = makeClient({ articles: [node] });
    const { ctx, stateDir } = makeCtx({ root, client, git: cleanGit() });
    seedObservation(stateDir, node);
    const result = await run(dryRun(), ctx);
    assert.equal(result.reason, 'dry-run', field);
    assert.deepEqual(result.diffs, [field]);
  }
});

test('[gate:dry-run-coupling] the dry run prints the sha the gate checks, and writes nothing anywhere', async () => {
  const { ctx, client, logs, stateDir, backupDir, node } = updateSetup({ git: cleanGit() });
  const before = stateText(stateDir);
  const result = await run(dryRun(), ctx);
  assert.equal(result.code, 0);
  assert.equal(result.liveSha, liveShaOf(node));
  assert.ok(logs.includes(`  --confirm=${HANDLE} --expect-live-sha=${liveShaOf(node)}`), logs.join('\n'));
  assert.equal(mutationsOf(client).length, 0);
  assert.equal(stateText(stateDir), before);
  assert.deepEqual(readdirSync(backupDir), []);
});

test('[gate:dry-run-coupling] --confirm needs the matching flag for its operation, re-checked now', async () => {
  const refusals = [
    { setup: () => updateSetup({ git: cleanGit() }), argv: () => ['--handle', HANDLE, `--confirm=${HANDLE}`], why: /--expect-live-sha: required/ },
    { setup: () => updateSetup({ git: cleanGit() }), argv: () => ['--handle', HANDLE, `--confirm=${HANDLE}`, `--expect-live-sha=${'f'.repeat(64)}`], why: /changed since that dry run/ },
    { setup: () => updateSetup({ git: cleanGit() }), argv: () => confirmCreate(), why: /--expect-absent: Admin holds this article now/ },
    { setup: () => createSetup({ git: cleanGit() }), argv: () => ['--handle', HANDLE, `--confirm=${HANDLE}`], why: /--expect-absent: required/ },
    { setup: () => createSetup({ git: cleanGit() }), argv: () => ['--handle', HANDLE, `--confirm=${HANDLE}`, `--expect-live-sha=${'a'.repeat(64)}`], why: /this would be a create/ },
  ];
  for (const { setup, argv, why } of refusals) {
    const s = setup();
    await assert.rejects(() => run(argv(), s.ctx), why);
    assert.equal(mutationsOf(s.client).length, 0);
    assert.deepEqual(readdirSync(s.backupDir), []);
  }
});

test('[gate:dry-run-coupling] an article that appeared after a create dry run is refused, never overwritten', async () => {
  const { root, ctx, client } = createSetup({ git: cleanGit() });
  assert.equal((await run(dryRun(), ctx)).op, 'create');
  // Someone creates it in Admin between the dry run and the push.
  const appeared = nodeFromRepo(root, HANDLE, { body: '<p>Written in Admin.</p>' });
  client.store.set(appeared.id, appeared);
  const { ctx: again } = makeCtx({ root, client, git: cleanGit() });
  await assert.rejects(() => run(confirmCreate(), again), /Admin already holds this article/);
  assert.equal(mutationsOf(client).length, 0);
});

// ---------------------------------------------------------------------------------------------
// Gates 10 to 15: backup, intent, the write, the re-read, the record
// ---------------------------------------------------------------------------------------------

test('[gate:backup] an update writes a verified backup outside the checkout, asserted by CONTENT, at 0600 in 0700', async () => {
  const { root, ctx, client, backupDir, node } = updateSetup({ git: cleanGit() });
  const original = structuredClone(client.store.get(node.id));
  await run(confirmUpdate(node), ctx);
  const files = readdirSync(backupDir);
  assert.deepEqual(files, [`${HANDLE}-${NOW.replace(/[:.]/g, '-')}.json`]);
  const record = JSON.parse(readFileSync(join(backupDir, files[0]), 'utf8'));
  assert.equal(record.gid, ARTICLE_GID);
  assert.equal(record.blogHandle, 'shift-notes');
  assert.deepEqual(record.live, original, 'the backup must hold what Admin held BEFORE the write');
  assert.equal(record.liveSha256, liveShaOf(original));
  assert.equal(record.restore['body.html'], fileTextFor(original.body));
  assert.equal(record.restore['article.json'].title, 'Welcome to Shift Notes', 'restore holds the pre-edit title');
  assert.ok(!join(backupDir, files[0]).startsWith(root));
  if (POSIX) {
    assert.equal(statSync(join(backupDir, files[0])).mode & 0o777, FILE_MODE);
    assert.equal(statSync(backupDir).mode & 0o777, DIR_MODE);
  }
});

test('[gate:backup] a backup that cannot be written means NO mutation and no intent record', async () => {
  const blocker = join(tempDir('articles-blocker-'), 'a-file');
  writeFileSync(blocker, 'not a directory', 'utf8');
  for (const backupDir of [blocker, null]) {
    const { ctx, client, stateDir, node } = updateSetup({ git: cleanGit(), backupDir });
    const before = stateText(stateDir);
    await assert.rejects(() => run(confirmUpdate(node), ctx), /backup directory/);
    assert.equal(mutationsOf(client).length, 0);
    assert.equal(stateText(stateDir), before, 'no intent may be written when the backup failed');
  }
  const inside = updateSetup({ git: unreachedGit('this context is replaced by one whose backup dir is inside the checkout') });
  const { ctx } = makeCtx({ root: inside.root, client: inside.client, git: cleanGit(), stateDir: inside.stateDir, backupDir: join(inside.root, 'backups') });
  await assert.rejects(() => run(confirmUpdate(inside.node), ctx), /inside the checkout/);
  assert.equal(mutationsOf(inside.client).length, 0);
});

test('[gate:backup] the read-back is verified: a backup that reads back different is a refusal', () => {
  const root = cleanRoot();
  const node = nodeFromRepo(root);
  const record = backupRecord({ node, blogHandle: 'shift-notes', liveSha256: liveShaOf(node), fetchedAt: NOW });
  const tampered = (file) => readFileSync(file, 'utf8').replace('Welcome to Shift Notes', 'Tampered');
  assert.throws(() => writeBackup({ dir: tempDir('articles-backup-'), root, handle: HANDLE, now: NOW, record, readBack: tampered }), /read back with different content/);
  assert.throws(() => writeBackup({ dir: tempDir('articles-backup-'), root, handle: HANDLE, now: NOW, record, readBack: () => '{ nope' }), /could not be read back/);
  const dir = tempDir('articles-backup-');
  const file = writeBackup({ dir, root, handle: HANDLE, now: NOW, record });
  assert.ok(existsSync(file));
  assert.throws(() => writeBackup({ dir, root, handle: HANDLE, now: NOW, record }), /refusing to overwrite it/);
});

test('[gate:intent-record] the intent is on disk BEFORE the mutation is sent, and cleared once the outcome is known', async () => {
  const { root, ctx, client, stateDir, node } = updateSetup({ git: cleanGit() });
  let seen = null;
  client.hooks.ArticleUpdate = { before: () => { seen = readState({ dir: stateDir }).intents[HANDLE]; } };
  await run(confirmUpdate(node), ctx);
  assert.deepEqual(seen, {
    op: 'update',
    gid: ARTICLE_GID,
    sentSha256: readRepoArticle(root, HANDLE).sha,
    at: NOW,
    backup: seen.backup,
  });
  assert.ok(typeof seen.backup === 'string' && seen.backup.endsWith('.json'));
  assert.deepEqual(readState({ dir: stateDir }).intents, {});
});

test('[gate:intent-record] an unreconciled intent refuses every later run, dry run included, before any mutation', async () => {
  const { ctx, client, stateDir, node } = updateSetup({ git: cleanGit() });
  seedIntent(stateDir);
  for (const argv of [dryRun(), confirmUpdate(node)]) {
    await assert.rejects(() => run(argv, ctx), (err) => {
      assert.match(err.message, /never learned whether it landed/);
      assert.ok(err.message.includes(CHECK_COMMAND) && err.message.includes(SEED_COMMAND));
      return true;
    });
  }
  assert.equal(mutationsOf(client).length, 0);
});

test('indeterminate network outcomes each leave an intent record the next run refuses until reconciled', async () => {
  const outcomes = [
    ['a throw before any response', { before: () => { throw new Error('socket hang up'); } }],
    ['a throw after the write landed', { after: () => { throw new Error('connection reset after the write'); } }],
    ['a timeout', { before: () => new Promise((_, reject) => setTimeout(() => reject(new Error('The operation was aborted due to timeout')), 1)) }],
    ['a 5xx', { before: () => { throw new Error('HTTP 503: {"errors":"Service Unavailable"}'); } }],
  ];
  for (const [label, hook] of outcomes) {
    const { root, ctx, client, stateDir, node } = updateSetup({ git: cleanGit() });
    client.hooks.ArticleUpdate = hook;
    await assert.rejects(() => run(confirmUpdate(node), ctx), /outcome is UNKNOWN/, label);
    const intent = readState({ dir: stateDir }).intents[HANDLE];
    assert.equal(intent?.op, 'update', `${label}: no intent record was left`);

    client.hooks = {};
    const { ctx: next } = makeCtx({ root, client, git: cleanGit(), stateDir });
    await assert.rejects(() => run(confirmUpdate(node), next), /never learned whether it landed/, label);
    assert.equal(mutationsOf(client).length, 1, `${label}: the next run sent another mutation`);
  }
});

test('[gate:hidden-explicit] the update input is exactly this object, hidden sent explicitly', async () => {
  const { root, ctx, client, node } = updateSetup({ git: cleanGit() });
  await run(confirmUpdate(node), ctx);
  const sent = mutationsOf(client);
  assert.deepEqual(sent.map((c) => c.name), ['ArticleUpdate']);
  assert.deepEqual(sent[0].variables, {
    id: ARTICLE_GID,
    article: {
      handle: HANDLE,
      title: TITLE_EDIT,
      author: { name: 'Sapphire Shadow Studio' },
      summary: 'Why this blog exists, what will be in it, and how often to expect anything.',
      body: readRepoArticle(root, HANDLE).body,
      tags: ['studio', 'process'],
      templateSuffix: null,
      image: {
        url: 'https://cdn.shopify.com/s/files/1/0000/0001/files/bench-overview.jpg',
        altText: 'A cutting bench with a folded crewneck and a tape measure',
      },
      isPublished: false,
      metafields: [
        { namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: 'Welcome to Shift Notes' },
        {
          namespace: 'global',
          key: 'description_tag',
          type: 'single_line_text_field',
          value: 'Short pieces about how the work gets made: fabric, fit, and the reasoning behind each decision.',
        },
      ],
      redirectNewHandle: false,
    },
  });
});

test('the create input is exactly this object: blogId, no redirect, hidden sent explicitly', async () => {
  const { root, ctx, client, stateDir, backupDir } = createSetup({ git: cleanGit() });
  const result = await run(confirmCreate(), ctx);
  const sent = mutationsOf(client);
  assert.deepEqual(sent.map((c) => c.name), ['ArticleCreate']);
  const repo = readRepoArticle(root, HANDLE);
  assert.deepEqual(sent[0].variables, {
    article: {
      blogId: BLOG_GID,
      handle: HANDLE,
      title: 'Welcome to Shift Notes',
      author: { name: 'Sapphire Shadow Studio' },
      summary: 'Why this blog exists, what will be in it, and how often to expect anything.',
      body: repo.body,
      tags: ['studio', 'process'],
      templateSuffix: null,
      image: {
        url: 'https://cdn.shopify.com/s/files/1/0000/0001/files/bench-overview.jpg',
        altText: 'A cutting bench with a folded crewneck and a tape measure',
      },
      isPublished: false,
      metafields: [
        { namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: 'Welcome to Shift Notes' },
        {
          namespace: 'global',
          key: 'description_tag',
          type: 'single_line_text_field',
          value: 'Short pieces about how the work gets made: fabric, fit, and the reasoning behind each decision.',
        },
      ],
    },
  });
  assert.equal(readState({ dir: stateDir }).articles[result.gid].matchedRepoSha256, repo.sha);
  assert.deepEqual(readdirSync(backupDir), [], 'a create has nothing to back up and must write no backup');
});

test('[gate:hidden-explicit] a VISIBLE live article is refused: an update would take a live post down', async () => {
  const { ctx, client, node } = updateSetup({ git: cleanGit(), nodeOverrides: { isPublished: VISIBLE } });
  await assert.rejects(() => run(confirmUpdate(node), ctx), /is VISIBLE on the storefront/);
  assert.equal(mutationsOf(client).length, 0);
});

test('the fake allows only the reviewed operation names, so a new write fails loudly here', async () => {
  const client = makeClient();
  const deleteDoc = ['mutation', 'ArticleDelete($id: ID!) { articleDelete(id: $id) { deletedArticleId } }'].join(' ');
  await assert.rejects(() => client.gql(deleteDoc, { id: ARTICLE_GID }), FakeClientRefusal);
  const visibleDoc = ['mutation', ['Publishable', 'Publish'].join(''), '{ x }'].join(' ');
  await assert.rejects(() => client.gql(visibleDoc), FakeClientRefusal);
  await assert.rejects(() => client.gql('query ShopName { shop { name } }'), FakeClientRefusal);
  await assert.rejects(() => client.gql('{ shop { name } }'), FakeClientRefusal);
  // A reviewed name with the wrong root field is refused too.
  await assert.rejects(() => client.gql('mutation ArticleUpdate($id: ID!) { articleDelete(id: $id) { deletedArticleId } }'), FakeClientRefusal);
  assert.equal(client.calls.length, 0);
});

test('[gate:fail-closed] userErrors is a failure that writes nothing and clears the intent (a known outcome)', async () => {
  const { ctx, client, stateDir, node } = updateSetup({ git: cleanGit() });
  const before = structuredClone(client.store.get(node.id));
  client.hooks.ArticleUpdate = {
    after: ({ store }) => {
      store.set(node.id, before);
      return { articleUpdate: { article: null, userErrors: [{ code: 'INVALID', field: ['article', 'body'], message: 'Body is invalid' }] } };
    },
  };
  await assert.rejects(() => run(confirmUpdate(node), ctx), /returned userErrors; nothing was written[\s\S]*article\.body: Body is invalid \[INVALID\]/);
  assert.deepEqual(readState({ dir: stateDir }).intents, {});
  assert.equal(client.calls.filter((c) => c.name === 'ArticleRead').length, 0, 'no re-read after a refused write');
});

test('[gate:fail-closed] a null article with no userErrors is an UNKNOWN outcome, and the intent is kept', async () => {
  const { ctx, client, stateDir, node } = updateSetup({ git: cleanGit() });
  client.hooks.ArticleUpdate = { after: () => ({ articleUpdate: { article: null, userErrors: [] } }) };
  await assert.rejects(() => run(confirmUpdate(node), ctx), /returned no article and no userErrors/);
  assert.equal(readState({ dir: stateDir }).intents[HANDLE].op, 'update');
});

test('[gate:reread-verify] Admin storing something else in any written field fails loud, naming the field', async () => {
  const { ctx, client, stateDir, node } = updateSetup({ git: cleanGit() });
  client.hooks.ArticleUpdate = { after: ({ store }) => { store.set(node.id, { ...store.get(node.id), summary: 'Rewritten by the store.' }); } };
  await assert.rejects(() => run(confirmUpdate(node), ctx), /Admin stored something different from what was sent, in: summary/);
  const observed = readState({ dir: stateDir }).articles[ARTICLE_GID];
  assert.equal(observed.liveSha256, liveShaOf(client.store.get(node.id)), 'the observation records what Admin holds');
  assert.equal(observed.matchedRepoSha256, null);
  assert.equal(client.calls.filter((c) => c.name === 'ArticleRead').length, VERIFY_ATTEMPTS);
});

test('[gate:reread-verify] the live published state is re-read: VISIBLE after a hidden write fails loud', async () => {
  const { ctx, client, stateDir, node } = updateSetup({ git: cleanGit() });
  client.hooks.ArticleUpdate = { after: ({ store }) => { store.set(node.id, { ...store.get(node.id), isPublished: VISIBLE }); } };
  await assert.rejects(() => run(confirmUpdate(node), ctx), /ADMIN REPORTS THIS ARTICLE AS VISIBLE/);
  // The observation records what Admin reported, visible, so status and the next push see it.
  assert.equal(readState({ dir: stateDir }).articles[ARTICLE_GID].isPublished, true);
});

test('[gate:reread-verify] table whitespace Shopify inserts is not a difference, and a thrown read is retried', async () => {
  const { root, ctx, client, logs } = createSetup({ git: cleanGit() });
  writeBody(root, `${readBody(root).trimEnd()}\n\n<table><tr><td>Weight</td><td>Heavy</td></tr><tr><td>Fit</td><td>Relaxed</td></tr></table>\n`);
  reindexInPlace(root);
  client.hooks.ArticleCreate = {
    after: ({ store, response }) => {
      const id = response.articleCreate.article.id;
      const stored = store.get(id);
      store.set(id, { ...stored, body: stored.body.replace(/<tr>/g, '\n<tr>\n').replace(/<td>/g, '\n<td>') });
    },
  };
  let reads = 0;
  client.hooks.ArticleRead = { before: () => { reads++; if (reads === 1) throw new Error('read timed out'); } };
  const result = await run(confirmCreate(), ctx);
  assert.equal(result.reason, 'create');
  assert.equal(reads, 2);
  assert.ok(logs.some((l) => l.startsWith(`${SUCCESS_MARKER} ${HANDLE}`)), logs.join('\n'));
});

test('[gate:record-observation] a failed re-read still records an unverified observation, and keeps the intent', async () => {
  const { ctx, client, stateDir, node } = updateSetup({ git: cleanGit() });
  client.hooks.ArticleRead = { before: () => { throw new Error('HTTP 502'); } };
  await assert.rejects(() => run(confirmUpdate(node), ctx), new RegExp(`could not be read back after ${VERIFY_ATTEMPTS} attempts`));
  const state = readState({ dir: stateDir });
  assert.equal(state.articles[ARTICLE_GID].unverified, true);
  assert.equal(state.intents[HANDLE].op, 'update');
});

test('[gate:record-observation] success records what the re-read saw, drops a stale same-handle entry, and prints the recovery', async () => {
  const { root, ctx, client, stateDir, logs, node } = updateSetup({ git: cleanGit() });
  seedObservation(stateDir, { ...node, id: 'gid://shopify/Article/999' });
  const result = await run(confirmUpdate(node), ctx);
  assert.equal(result.code, 0);
  const state = readState({ dir: stateDir });
  assert.deepEqual(Object.keys(state.articles), [ARTICLE_GID]);
  assert.deepEqual(state.articles[ARTICLE_GID], {
    handle: HANDLE,
    blogId: BLOG_GID,
    liveSha256: liveShaOf(client.store.get(ARTICLE_GID)),
    bodySha256: state.articles[ARTICLE_GID].bodySha256,
    isPublished: false,
    matchedRepoSha256: readRepoArticle(root, HANDLE).sha,
    liveImageUrl: 'https://cdn.shopify.com/s/files/1/0000/0001/files/bench-overview.jpg',
    imageSourceUrl: 'https://cdn.shopify.com/s/files/1/0000/0001/files/bench-overview.jpg',
    observedAt: NOW,
  });
  assert.ok(logs.some((l) => l.includes('copy restore["body.html"] from the backup')), logs.join('\n'));
});

test('exit codes: dry run 0, no-op 0, a verified write 0, any refusal 1', async () => {
  const dry = updateSetup({ git: cleanGit() });
  assert.equal(await toExitCode(run, dryRun(), dry.ctx, 'push'), 0);

  const write = updateSetup({ git: cleanGit() });
  assert.equal(await toExitCode(run, confirmUpdate(write.node), write.ctx, 'push'), 0);

  const again = makeCtx({ root: write.root, client: write.client, git: cleanGit(), stateDir: write.stateDir });
  assert.equal(await toExitCode(run, confirmUpdate(write.client.store.get(ARTICLE_GID)), again.ctx, 'push'), 0);
  assert.equal(mutationsOf(write.client).length, 1, 'the second run should have been a no-op');

  const refused = createSetup({ git: unreachedGit('refused at gate 0') });
  const code = await toExitCode(run, dryRun(), { ...refused.ctx, env: { CI: 'true' } }, 'push');
  assert.equal(code, 1);
});

// ---------------------------------------------------------------------------------------------
// Review fixes: gate order at runtime, refusal side effects, failed creates, images, renames
// ---------------------------------------------------------------------------------------------

/**
 * Trace fs access to the state, backup and repo directories into `note`, for the length of `fn`.
 * The push imports named fs bindings, so the builtin's ESM exports are re-synced after mocking and
 * again after restoring, or later tests would still run through the wrappers.
 */
async function withFsTrace({ root, stateDir, backupDir, note }, fn) {
  const originals = { readFileSync: fs.readFileSync, existsSync: fs.existsSync, openSync: fs.openSync, renameSync: fs.renameSync };
  const label = (p) => {
    const s = String(p);
    if (s.startsWith(backupDir + sep)) return 'backup';
    if (s.startsWith(stateDir + sep)) return 'state read';
    if (s.startsWith(root + sep)) return 'repo read';
    return null;
  };
  for (const name of ['readFileSync', 'existsSync', 'openSync']) {
    mock.method(fs, name, function traced(p, ...rest) {
      const l = label(p);
      if (l) note(l);
      return originals[name].call(this, p, ...rest);
    });
  }
  mock.method(fs, 'renameSync', function traced(from, to, ...rest) {
    if (String(to).startsWith(stateDir + sep)) {
      const written = JSON.parse(originals.readFileSync(from, 'utf8'));
      note(Object.keys(written.intents ?? {}).length > 0 ? 'intent write' : 'state write');
    }
    return originals.renameSync.call(this, from, to, ...rest);
  });
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
}

test('the gates run in GATES order at RUNTIME: one ordered log across env, argv, fs, git and the client', async () => {
  // Each event is paired with the gate it belongs to, and the gate indices must never go backwards.
  const UPDATE = [
    ['ci', 'ci-refusal'],
    ['argv', 'confirm-matches-handle'],
    ['repo read', 'check-clean'],
    ['git fetch', 'reviewed-tree'],
    ['git status', 'reviewed-tree'],
    ['git rev-parse HEAD^{commit}', 'reviewed-tree'],
    ['git rev-parse refs/remotes/origin/main^{commit}', 'reviewed-tree'],
    ['git merge-base', 'reviewed-tree'],
    ['scopes', 'scopes'],
    ['blog', 'blog-resolution'],
    ['list', 'live-read-freshness'],
    ['state read', 'live-read-freshness'],
    ['backup', 'backup'],
    ['intent write', 'intent-record'],
    ['mutation', 'hidden-explicit'],
    ['re-read', 'reread-verify'],
    ['state read', 'record-observation'],
    ['state write', 'record-observation'],
  ];
  const CREATE = [
    ...UPDATE.slice(0, 12),
    ['repo read', 'gid-keyed-observation'],
    ...UPDATE.slice(13),
  ];
  const OP_EVENTS = { ArticlesBlogs: 'blog', ArticlesList: 'list', ArticleRead: 're-read', ArticleUpdate: 'mutation', ArticleCreate: 'mutation' };

  for (const [op, expected] of [['update', UPDATE], ['create', CREATE]]) {
    const events = [];
    const note = (e) => {
      if (events.at(-1) !== e) events.push(e);
    };
    const git = cleanGit([HANDLE], { onCall: (args) => note(`git ${args[0]}${args[0] === 'rev-parse' ? ` ${args[2]}` : ''}`) });
    const s = op === 'update' ? updateSetup({ git }) : createSetup({ git });
    const env = new Proxy({}, {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'CI') note('ci');
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const list = op === 'update' ? confirmUpdate(s.node) : confirmCreate();
    const argv = new Proxy(list, {
      get(target, key, receiver) {
        if (key === '0') note('argv');
        return Reflect.get(target, key, receiver);
      },
    });
    const client = {
      ...s.client,
      scopes: async () => {
        note('scopes');
        return s.client.scopes();
      },
      gql: async (document, variables) => {
        const response = await s.client.gql(document, variables);
        note(OP_EVENTS[s.client.calls.at(-1).name]);
        return response;
      },
    };
    const ctx = { ...s.ctx, env, client };
    const result = await withFsTrace({ root: s.root, stateDir: s.stateDir, backupDir: s.backupDir, note }, () => run(argv, ctx));
    assert.equal(result.reason, op);
    assert.deepEqual(events, expected.map(([e]) => e), `${op}: the runtime order changed\n${events.join('\n')}`);
    const indices = expected.map(([, gate]) => GATES.indexOf(gate));
    assert.ok(indices.every((i) => i !== -1), `${op}: an event names a gate that does not exist`);
    assert.ok(indices.every((i, n) => n === 0 || i >= indices[n - 1]), `${op}: the gates ran out of order: ${indices.join(',')}`);
  }
});

test('[gate:gid-keyed-observation] two live previous handles refuse, dry run and confirmed update alike, writing nothing', async () => {
  const OLDER = 'older-welcome';
  const root = cleanRoot();
  const oldNode = nodeFromRepo(root);
  renameArticleDir(root, HANDLE, RENAMED);
  const article = readArticle(root, RENAMED);
  article.previousHandles = [HANDLE, OLDER];
  writeArticle(root, article, RENAMED);
  reindexInPlace(root);
  const olderNode = { ...oldNode, id: 'gid://shopify/Article/2', handle: OLDER };
  const client = makeClient({ articles: [oldNode, olderNode] });
  const stateDir = tempDir('articles-state-');
  seedObservation(stateDir, oldNode);
  seedObservation(stateDir, olderNode);
  const before = stateText(stateDir);
  for (const argv of [dryRun(RENAMED), confirmUpdate(oldNode, RENAMED)]) {
    const { ctx, backupDir } = makeCtx({ root, client, git: cleanGit([RENAMED, HANDLE, OLDER]), stateDir });
    await assert.rejects(() => run(argv, ctx), /more than one previous handle is live/);
    assert.deepEqual(readdirSync(backupDir), []);
  }
  assert.equal(mutationsOf(client).length, 0);
  assert.equal(stateText(stateDir), before, 'the state must be byte-identical after the refusal');
});

test('[gate:hidden-explicit] a VISIBLE live article refuses on the DRY RUN too, before any backup or intent, state byte-identical', async () => {
  for (const argvOf of [() => dryRun(), (node) => confirmUpdate(node)]) {
    const { ctx, client, stateDir, backupDir, node, logs } = updateSetup({ git: cleanGit(), nodeOverrides: { isPublished: VISIBLE } });
    const before = stateText(stateDir);
    await assert.rejects(() => run(argvOf(node), ctx), /is VISIBLE on the storefront/);
    assert.equal(mutationsOf(client).length, 0);
    assert.deepEqual(readdirSync(backupDir), [], 'a backup was written before the visible refusal');
    assert.equal(stateText(stateDir), before, 'an intent or observation was written before the visible refusal');
    assert.equal(logs.some((l) => l.includes('keeping it hidden')), false, 'the dry run described an update it must refuse');
  }
});

test('[gate:intent-record] a failed CREATE keeps {op: create, gid: null}, and the next run refuses, whether or not it landed', async () => {
  const shapes = [
    ['a throw before any response', false, { before: () => { throw new Error('socket hang up'); } }, /outcome is UNKNOWN/],
    ['a throw after the create landed', true, { after: () => { throw new Error('connection reset after the write'); } }, /outcome is UNKNOWN/],
    ['a 5xx', false, { before: () => { throw new Error('HTTP 503: {"errors":"Service Unavailable"}'); } }, /outcome is UNKNOWN/],
    ['a null article that landed', true, { after: () => ({ articleCreate: { article: null, userErrors: [] } }) }, /returned no article and no userErrors/],
  ];
  for (const [label, landed, hook, why] of shapes) {
    const { root, ctx, client, stateDir, backupDir } = createSetup({ git: cleanGit() });
    client.hooks.ArticleCreate = hook;
    await assert.rejects(() => run(confirmCreate(), ctx), (err) => {
      assert.match(err.message, why, label);
      assert.match(err.message, /If the create landed, a hidden article now exists/, `${label}: no recovery text`);
      return true;
    });
    assert.deepEqual(readState({ dir: stateDir }).intents[HANDLE], {
      op: 'create',
      gid: null,
      sentSha256: readRepoArticle(root, HANDLE).sha,
      at: NOW,
      backup: null,
    }, label);
    assert.deepEqual(readdirSync(backupDir), [], label);
    assert.equal(client.store.size, landed ? 1 : 0, `${label}: the fixture is wrong about whether the create landed`);

    client.hooks = {};
    for (const argv of [dryRun(), confirmCreate()]) {
      const { ctx: next } = makeCtx({ root, client, git: cleanGit(), stateDir });
      await assert.rejects(() => run(argv, next), /never learned whether it landed/, label);
    }
    assert.equal(mutationsOf(client).length, 1, `${label}: a later run sent another create`);
  }
});

test('an unknown UPDATE outcome prints the backup path and the copy-then-push recovery', async () => {
  const { ctx, client, node, backupDir } = updateSetup({ git: cleanGit() });
  client.hooks.ArticleUpdate = { before: () => { throw new Error('socket hang up'); } };
  await assert.rejects(() => run(confirmUpdate(node), ctx), (err) => {
    assert.match(err.message, /outcome is UNKNOWN/);
    assert.ok(err.message.includes(`backup: `) && err.message.includes(readdirSync(backupDir)[0]), err.message);
    assert.ok(err.message.includes('copy restore["body.html"] from the backup'), err.message);
    return true;
  });
});

test('[gate:intent-record] an intent is found by a previous handle and by the live GID, not only by the current handle', async () => {
  // A create that died, then the directory was renamed: the intent sits under what is now a previous handle.
  const renamed = cleanRoot();
  renameArticleDir(renamed, HANDLE, RENAMED);
  const a = makeCtx({ root: renamed, client: makeClient({ articles: [] }), git: cleanGit([RENAMED, HANDLE]) });
  seedIntent(a.stateDir, HANDLE, { op: 'create', gid: null });
  await assert.rejects(() => run(dryRun(RENAMED), a.ctx), new RegExp(`under "${HANDLE}"[\\s\\S]*never learned whether it landed`));

  // An update's intent recorded under some other handle, for the same live article.
  const b = updateSetup({ git: cleanGit() });
  seedIntent(b.stateDir, 'a-handle-long-gone', { gid: ARTICLE_GID });
  await assert.rejects(() => run(confirmUpdate(b.node), b.ctx), /never learned whether it landed/);
  assert.equal(mutationsOf(b.client).length, 0);
});

test('[gate:dry-run-coupling] both expect flags at once refuse, before any read', async () => {
  const { ctx, client } = createSetup({ git: unreachedGit('refused before gate 2') });
  await assert.rejects(
    () => run(['--handle', HANDLE, `--confirm=${HANDLE}`, `--expect-live-sha=${'a'.repeat(64)}`, '--expect-absent'], ctx),
    /--expect-live-sha is for an update and --expect-absent for a create; not both/,
  );
  assert.equal(client.calls.length, 0);
});

test('an update whose repo clears an SEO field Admin still holds refuses, since the update cannot delete a metafield', async () => {
  const { root, ctx, client, stateDir, backupDir, node } = updateSetup({ git: cleanGit() });
  const article = readArticle(root);
  article.seo.description = '';
  writeArticle(root, article);
  reindexInPlace(root);
  const before = stateText(stateDir);
  await assert.rejects(() => run(dryRun(), ctx), /the repo clears seoDescription but Admin holds/);
  await assert.rejects(() => run(confirmUpdate(node), makeCtx({ root, client, git: cleanGit(), stateDir, backupDir }).ctx), /clears seoDescription/);
  assert.equal(mutationsOf(client).length, 0);
  assert.equal(stateText(stateDir), before);
  assert.deepEqual(readdirSync(backupDir), []);
});

test('[gate:backup] a backup directory that is a SYMLINK into the checkout refuses, compared on real paths', { skip: POSIX ? false : 'symlinks need POSIX' }, async () => {
  const s = updateSetup({ git: unreachedGit('this context is replaced by one whose backup dir links into the checkout') });
  const inside = join(s.root, 'backups-inside');
  mkdirSync(inside);
  const link = join(tempDir('articles-link-'), 'backups');
  symlinkSync(inside, link);
  const { ctx } = makeCtx({ root: s.root, client: s.client, git: cleanGit(), stateDir: s.stateDir, backupDir: link });
  await assert.rejects(() => run(confirmUpdate(s.node), ctx), /inside the checkout/);
  assert.equal(mutationsOf(s.client).length, 0);
  assert.deepEqual(readdirSync(inside), []);
});

test('[gate:hidden-explicit] the input builder sends isPublished false even from a projection that claims visible', () => {
  const root = cleanRoot();
  const visible = { ...readRepoArticle(root, HANDLE).projection, isPublished: VISIBLE };
  assert.equal(buildArticleInput({ op: 'update', repo: visible }).isPublished, false);
  assert.equal(buildArticleInput({ op: 'create', repo: visible, blogId: BLOG_GID }).isPublished, false);
});

// C3: the create-side rename refusal fires on evidence that it is THIS article, and nothing else.

test('a create is not blocked by an unrelated observed live article no directory claims', async () => {
  const root = cleanRoot();
  const unrelated = nodeFromRepo(root, HANDLE, {
    id: 'gid://shopify/Article/42',
    handle: 'removed-from-the-repo',
    title: 'A post removed from the repo on purpose',
    body: '<p>Nothing like the article being created.</p>',
    image: null,
  });
  const client = makeClient({ articles: [unrelated] });
  const { ctx, stateDir } = makeCtx({ root, client, git: cleanGit() });
  seedObservation(stateDir, unrelated);
  const result = await run(confirmCreate(), ctx);
  assert.equal(result.reason, 'create');
  assert.deepEqual(mutationsOf(client).map((c) => c.name), ['ArticleCreate']);
});

test('a create is not blocked by a live article another directory claims through ITS previousHandles', async () => {
  const OTHER = 'second-article';
  const root = cleanRoot();
  addSecondArticle(root, OTHER);
  const other = readArticle(root, OTHER);
  other.title = 'The second article';
  other.seo.title = 'The second article';
  other.previousHandles = ['second-article-old'];
  writeArticle(root, other, OTHER);
  reindexInPlace(root);
  // The other article's rename is not pushed yet, so Admin still holds it at its old handle. Its body is
  // the same as this article's, so only the claimed-handle rule keeps it from reading as a rename of this one.
  const pendingRename = nodeFromRepo(root, OTHER, { id: 'gid://shopify/Article/43', handle: 'second-article-old' });
  const client = makeClient({ articles: [pendingRename] });
  const { ctx, stateDir } = makeCtx({ root, client, git: cleanGit() });
  seedObservation(stateDir, pendingRename);
  const result = await run(confirmCreate(), ctx);
  assert.equal(result.reason, 'create');
});

test('an unrecorded rename is still refused when only the body matches (the title was edited too)', async () => {
  const root = cleanRoot();
  const oldNode = nodeFromRepo(root);
  renameArticleDir(root, HANDLE, RENAMED, { recordPrevious: false });
  const article = readArticle(root, RENAMED);
  article.title = TITLE_EDIT;
  writeArticle(root, article, RENAMED);
  reindexInPlace(root);
  const client = makeClient({ articles: [oldNode] });
  const { ctx } = makeCtx({ root, client, git: cleanGit([RENAMED]) });
  await assert.rejects(() => run(dryRun(RENAMED), ctx), /which no repo directory claims and which has this article's body[\s\S]*add it to previousHandles/);
  assert.equal(mutationsOf(client).length, 0);
});

// Featured images: Shopify re-hosts an image set by URL, so the live URL never equals the repo's.

test('[gate:reread-verify] a RE-HOSTED featured image passes the re-read, and the next run is a no-op', async () => {
  const { root, ctx, client, stateDir } = createSetup({ git: cleanGit(), clientOptions: { rehostImages: true } });
  const created = await run(confirmCreate(), ctx);
  assert.equal(created.reason, 'create');
  const stored = client.store.get(created.gid);
  assert.equal(stored.image.url, rehostedUrl(IMG));
  assert.notEqual(stored.image.url, IMG, 'the fixture is wrong: the fake should have re-hosted the image');
  const observed = readState({ dir: stateDir }).articles[created.gid];
  assert.equal(observed.liveImageUrl, rehostedUrl(IMG));
  assert.equal(observed.imageSourceUrl, IMG);
  assert.equal(observed.matchedRepoSha256, readRepoArticle(root, HANDLE).sha);

  const { ctx: again } = makeCtx({ root, client, git: cleanGit(), stateDir });
  const second = await run(confirmUpdate(stored), again);
  assert.equal(second.reason, 'no-op');
  assert.equal(mutationsOf(client).length, 1);
});

test('[gate:no-op] a changed repo image SOURCE is a difference, though Admin only ever holds a re-hosted copy', async () => {
  const { root, ctx, client, stateDir } = createSetup({ git: cleanGit(), clientOptions: { rehostImages: true } });
  const created = await run(confirmCreate(), ctx);
  const NEW_IMG = 'https://cdn.shopify.com/s/files/1/0000/0001/files/bench-detail.jpg';
  const images = readImages(root);
  images.images.push({ ...images.images[0], url: NEW_IMG });
  writeImages(root, images);
  const article = readArticle(root);
  article.image = NEW_IMG;
  writeArticle(root, article);
  reindexInPlace(root);
  const { ctx: next } = makeCtx({ root, client, git: cleanGit(), stateDir });
  const dry = await run(dryRun(), next);
  assert.equal(dry.reason, 'dry-run');
  assert.deepEqual(dry.diffs, ['imageUrl']);
  assert.equal(client.store.get(created.gid).image.url, rehostedUrl(IMG));
});

test('[gate:no-op] a re-hosted image with no recorded source is a difference: unknown never reads as the same', async () => {
  const root = cleanRoot();
  const node = nodeFromRepo(root, HANDLE, { image: { url: rehostedUrl(IMG), altText: 'A cutting bench with a folded crewneck and a tape measure' } });
  const client = makeClient({ articles: [node] });
  const { ctx, stateDir } = makeCtx({ root, client, git: cleanGit() });
  seedObservation(stateDir, node);
  const dry = await run(dryRun(), ctx);
  assert.deepEqual(dry.diffs, ['imageUrl']);
});

test('every exported gate id has a [gate:<id>] test in this file, in the documented order', () => {
  assert.deepEqual([...GATES], [
    'ci-refusal', 'confirm-matches-handle', 'check-clean', 'reviewed-tree', 'scopes', 'blog-resolution',
    'live-read-freshness', 'gid-keyed-observation', 'no-op', 'dry-run-coupling', 'backup', 'intent-record',
    'hidden-explicit', 'fail-closed', 'reread-verify', 'record-observation',
  ]);
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const named = new Set([...source.matchAll(/^test\('\[gate:([a-z-]+)\]/gm)].map((m) => m[1]));
  for (const id of GATES) assert.ok(named.has(id), `the gate ${id} has no [gate:${id}] test`);
  for (const id of named) assert.ok(GATES.includes(id), `a test names ${id}, which is not an exported gate`);
});
