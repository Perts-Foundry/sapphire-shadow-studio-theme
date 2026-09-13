// articles:verify: offline against the observation, and `--live` against the store: the template
// suffix, collection links, CDN HEADs, redirects for previous handles, and live articles with no repo
// directory.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';

import { COLLECTION_SCOPE, OK_LINE, REDIRECT_SCOPE, run } from '../verify.mjs';
import { toExitCode } from '../lib/context.mjs';
import { readRepoArticle } from '../repo.mjs';
import { HANDLE, cleanRoot, cleanup, madeRoots, readBody, reindexInPlace, writeBody } from './helpers.mjs';
import {
  ARTICLE_GID,
  VISIBLE,
  cleanupDirs,
  madeDirs,
  makeClient,
  makeCtx,
  nodeFromRepo,
  rehostedUrl,
  renameArticleDir,
  seedObservation,
  tempDir,
} from './network-helpers.mjs';

after(() => {
  for (const dir of [...madeRoots(), ...madeDirs()]) assert.ok(dir.startsWith(tmpdir()), `${dir} is not under the temp root`);
  cleanupDirs();
  cleanup();
});

const IMG = 'https://cdn.shopify.com/s/files/1/0000/0001/files/bench-overview.jpg';
const ALL_SCOPES = ['read_content', COLLECTION_SCOPE, REDIRECT_SCOPE];

function fakeFetch(statusByUrl = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, method: init?.method });
    const status = statusByUrl[url] ?? 200;
    if (status instanceof Error) throw status;
    return { status };
  };
  f.calls = calls;
  return f;
}

function withCollectionLink(root) {
  writeBody(root, `${readBody(root).trimEnd()}\n\n<p>See the <a href="/collections/scrubs">scrubs</a>.</p>\n`);
  reindexInPlace(root);
  return root;
}

function live({ root = withCollectionLink(cleanRoot()), nodeOverrides = {}, extra = [], scopes = ALL_SCOPES, collections = { scrubs: { id: 'gid://shopify/Collection/1', handle: 'scrubs' } }, redirects = [], statuses = {}, handle = HANDLE } = {}) {
  const node = nodeFromRepo(root, handle, nodeOverrides);
  const client = makeClient({ articles: [node, ...extra], scopes, collections, redirects });
  const fetch = fakeFetch(statuses);
  return { root, node, client, fetch, ...makeCtx({ root, client, fetch }) };
}

// ---------------------------------------------------------------------------------------------
// Offline
// ---------------------------------------------------------------------------------------------

test('offline: no observation is a SKIP, a matched one a PASS, a mismatched one a FAIL with exit 2', async () => {
  const root = cleanRoot();
  const node = nodeFromRepo(root);

  const none = makeCtx({ root });
  assert.equal((await run([], none.ctx)).code, 0);
  assert.ok(none.logs.some((l) => l.startsWith('  SKIP  no observation of this article')), none.logs.join('\n'));
  assert.ok(none.logs.includes(`\n${OK_LINE}`));

  const matched = makeCtx({ root });
  seedObservation(matched.stateDir, node, { matchedRepoSha256: readRepoArticle(root, HANDLE).sha });
  assert.equal((await run([], matched.ctx)).code, 0);
  assert.ok(matched.logs.some((l) => l.startsWith(`  PASS  the last observation of ${ARTICLE_GID} matched`)));

  const stale = makeCtx({ root });
  seedObservation(stale.stateDir, node, { matchedRepoSha256: 'f'.repeat(64) });
  assert.equal(await toExitCode(run, [], stale.ctx, 'verify'), 2);
  assert.ok(stale.logs.some((l) => l.startsWith('  FAIL  the last observation')));
});

test('offline: a tree articles:check refuses exits 1, and --root chooses the tree', async () => {
  const root = cleanRoot();
  writeBody(root, `${readBody(root).trimEnd()}\n<script>x</script>\n`);
  reindexInPlace(root);
  assert.equal(await toExitCode(run, [], makeCtx({ root }).ctx, 'verify'), 1);

  const empty = tempDir('articles-not-a-repo-');
  const good = cleanRoot();
  assert.equal(await toExitCode(run, [], makeCtx({ root: empty }).ctx, 'verify'), 1);
  assert.equal(await toExitCode(run, ['--root', good], makeCtx({ root: empty }).ctx, 'verify'), 0);
});

// ---------------------------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------------------------

test('--live: every check passes against a store that matches, with HEAD requests and no write', async () => {
  const { ctx, logs, client, fetch } = live();
  const result = await run(['--live'], ctx);
  assert.equal(result.code, 0, logs.join('\n'));
  for (const line of [
    `  PASS  every written field matches Admin (${ARTICLE_GID})`,
    '  PASS  templateSuffix is null in both',
    '  PASS  link /collections/scrubs resolves to a collection',
    `  PASS  HEAD ${IMG} returned 200`,
  ]) {
    assert.ok(logs.includes(line), `missing ${line}\n${logs.join('\n')}`);
  }
  assert.deepEqual(fetch.calls, [{ url: IMG, method: 'HEAD' }]);
  assert.equal(client.calls.filter((c) => c.kind !== 'query').length, 0);
});

test('--live: a templateSuffix Admin holds differently is its own FAIL, not folded into the field comparison', async () => {
  const { ctx, logs } = live({ nodeOverrides: { templateSuffix: 'photo-story' } });
  assert.equal(await toExitCode(run, ['--live'], ctx, 'verify'), 2);
  assert.ok(logs.includes('  FAIL  templateSuffix is "photo-story" in Admin and null in the repo'), logs.join('\n'));
  assert.ok(logs.includes(`  PASS  every written field matches Admin (${ARTICLE_GID})`));
});

test('--live: a CDN URL that does not answer 2xx, or does not answer, fails', async () => {
  for (const status of [404, 500, new Error('getaddrinfo ENOTFOUND')]) {
    const { ctx, logs } = live({ statuses: { [IMG]: status } });
    assert.equal(await toExitCode(run, ['--live'], ctx, 'verify'), 2);
    assert.ok(logs.some((l) => l.startsWith(`  FAIL  HEAD ${IMG}`)), logs.join('\n'));
  }
});

test('--live: a collection link Admin cannot resolve fails; a missing scope is a SKIP naming it', async () => {
  const missing = live({ collections: {} });
  assert.equal(await toExitCode(run, ['--live'], missing.ctx, 'verify'), 2);
  assert.ok(missing.logs.includes('  FAIL  link /collections/scrubs names no collection in Admin'));

  const unscoped = live({ scopes: ['read_content'] });
  assert.equal(await toExitCode(run, ['--live'], unscoped.ctx, 'verify'), 0);
  assert.ok(unscoped.logs.includes(`  SKIP  link /collections/scrubs: the app does not grant ${COLLECTION_SCOPE}, so the collection was not resolved`));
  assert.equal(unscoped.client.calls.filter((c) => c.name === 'ArticlesCollection').length, 0);
});

test('--live: live articles with no repo directory are listed', async () => {
  const root = withCollectionLink(cleanRoot());
  const orphan = nodeFromRepo(root, HANDLE, { id: 'gid://shopify/Article/2', handle: 'orphan-post', isPublished: VISIBLE });
  const { ctx, logs } = live({ root, extra: [orphan] });
  const result = await run(['--live'], ctx);
  assert.equal(result.code, 0);
  assert.deepEqual(result.orphans, ['orphan-post']);
  assert.ok(logs.includes('  note  orphan-post (gid://shopify/Article/2), VISIBLE'), logs.join('\n'));
});

test('--live: a redirect is reported for each previous handle, present or missing', async () => {
  const path = `/blogs/shift-notes/${HANDLE}`;
  const makeRoot = () => {
    const root = withCollectionLink(cleanRoot());
    renameArticleDir(root, HANDLE, 'welcome-renamed');
    return root;
  };
  const present = live({ root: makeRoot(), handle: 'welcome-renamed', redirects: [{ id: 'gid://shopify/UrlRedirect/1', path, target: '/blogs/shift-notes/welcome-renamed' }] });
  assert.equal(await toExitCode(run, ['--live'], present.ctx, 'verify'), 0);
  assert.ok(present.logs.includes(`  PASS  a redirect from ${path} exists (to /blogs/shift-notes/welcome-renamed)`), present.logs.join('\n'));

  const absent = live({ root: makeRoot(), handle: 'welcome-renamed' });
  assert.equal(await toExitCode(run, ['--live'], absent.ctx, 'verify'), 2);
  assert.ok(absent.logs.includes(`  FAIL  no redirect from ${path}, which previousHandles says this article used to live at`));
});

test('--live: an article Admin still holds at its previous handle is ONE failure, not a second one for the handle field', async () => {
  const path = `/blogs/shift-notes/${HANDLE}`;
  const root = withCollectionLink(cleanRoot());
  renameArticleDir(root, HANDLE, 'welcome-renamed');
  const { ctx, logs } = live({
    root,
    handle: 'welcome-renamed',
    nodeOverrides: { handle: HANDLE },
    redirects: [{ id: 'gid://shopify/UrlRedirect/1', path, target: '/blogs/shift-notes/welcome-renamed' }],
  });
  const result = await run(['--live'], ctx);
  assert.equal(result.code, 2);
  assert.equal(result.failed, 1, logs.join('\n'));
  assert.deepEqual(logs.filter((l) => l.startsWith('  FAIL  ')), [`  FAIL  Admin still holds this article at its previous handle "${HANDLE}"`]);
  assert.ok(logs.includes(`  PASS  every written field matches Admin (${ARTICLE_GID})`), logs.join('\n'));
});

test('--live: a re-hosted featured image passes when the observation records its source, and fails when nothing does', async () => {
  const rehosted = { image: { url: rehostedUrl(IMG), altText: 'A cutting bench with a folded crewneck and a tape measure' } };
  const known = live({ nodeOverrides: rehosted });
  seedObservation(known.stateDir, known.node, { imageSourceUrl: IMG });
  assert.equal((await run(['--live'], known.ctx)).code, 0, known.logs.join('\n'));
  assert.ok(known.logs.includes(`  PASS  every written field matches Admin (${ARTICLE_GID})`));

  const unknown = live({ nodeOverrides: rehosted });
  assert.equal(await toExitCode(run, ['--live'], unknown.ctx, 'verify'), 2);
  assert.ok(unknown.logs.includes('  FAIL  Admin differs from the repo in: imageUrl'), unknown.logs.join('\n'));
});

test('--live: nothing live for a repo article fails, and --live without fetch cannot run', async () => {
  const root = withCollectionLink(cleanRoot());
  const client = makeClient({ articles: [], scopes: ALL_SCOPES, collections: { scrubs: { id: 'x', handle: 'scrubs' } } });
  const made = makeCtx({ root, client, fetch: fakeFetch() });
  assert.equal(await toExitCode(run, ['--live'], made.ctx, 'verify'), 2);
  assert.ok(made.logs.includes('  FAIL  Admin holds no article at this handle or any previous handle'));

  const noFetch = makeCtx({ root, client });
  assert.equal(await toExitCode(run, ['--live'], noFetch.ctx, 'verify'), 1);
});
