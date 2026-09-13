// articles:status: the output is pinned for absent, clean, drifted and never-pushed, offline sends
// nothing, and `--live` adds what only a live read can say.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { format, run } from '../status.mjs';
import { toExitCode } from '../lib/context.mjs';
import { describeState } from '../lib/state.mjs';
import { readRepoArticle } from '../repo.mjs';
import { HANDLE, cleanRoot, cleanup, madeRoots, readArticle, reindexInPlace, writeArticle } from './helpers.mjs';
import { VISIBLE, cleanupDirs, madeDirs, makeClient, makeCtx, nodeFromRepo, seedObservation } from './network-helpers.mjs';

after(() => {
  for (const dir of [...madeRoots(), ...madeDirs()]) assert.ok(dir.startsWith(tmpdir()), `${dir} is not under the temp root`);
  cleanupDirs();
  cleanup();
});

const OFFLINE = 'live:   NOT READ. This compares against the last observation; pass --live to report an Admin edit.';
const PUSH_NEXT = `  next: the article push for ${HANDLE}, dry run first (scripts/articles/README.md)`;

/** An offline run over a tripwire client: any call to it fails the test. */
async function offline(root, seed = () => {}) {
  const tripwire = makeClient();
  const made = makeCtx({ root, client: tripwire });
  seed(made.stateDir);
  const result = await run([], made.ctx);
  assert.equal(tripwire.calls.length, 0, 'offline status reached the store');
  return { ...made, result, head: `state:  ${describeState(made.stateDir).display}` };
}

test('absent: no state file is reported, not refused', async () => {
  const root = cleanRoot();
  const { logs, result, head } = await offline(root);
  assert.equal(result.code, 2);
  assert.deepEqual(logs, [
    `${head} (ABSENT)`,
    OFFLINE,
    '',
    HANDLE,
    '  unknown: no observation state on this machine',
    '  next: npm run articles:pull -- --check, then npm run articles:pull -- --seed',
  ]);
});

test('clean: the last observation matched this exact repo version', async () => {
  const root = cleanRoot();
  const node = nodeFromRepo(root);
  const { logs, result, head } = await offline(root, (dir) => seedObservation(dir, node, { matchedRepoSha256: readRepoArticle(root, HANDLE).sha }));
  assert.equal(result.code, 0);
  assert.deepEqual(logs, [head, OFFLINE, '', HANDLE, '  in sync', '  next: nothing to do']);
});

test('drifted: the repo moved on since the observation', async () => {
  const root = cleanRoot();
  const node = nodeFromRepo(root);
  const sha = readRepoArticle(root, HANDLE).sha;
  const article = readArticle(root);
  article.tags = ['studio'];
  writeArticle(root, article);
  reindexInPlace(root);
  const { logs, result, head } = await offline(root, (dir) => seedObservation(dir, node, { matchedRepoSha256: sha }));
  assert.equal(result.code, 2);
  assert.deepEqual(logs, [head, OFFLINE, '', HANDLE, '  repo ahead: a push is outstanding', PUSH_NEXT]);
});

test('never-pushed: a state file with nothing for this handle', async () => {
  const root = cleanRoot();
  const other = nodeFromRepo(root, HANDLE, { id: 'gid://shopify/Article/5', handle: 'another-post' });
  const { logs, result, head } = await offline(root, (dir) => seedObservation(dir, other));
  assert.equal(result.code, 2);
  assert.deepEqual(logs, [head, OFFLINE, '', HANDLE, '  never pushed: a create is outstanding', PUSH_NEXT]);
});

test('a corrupt state file is reported in a note and exits 2, never 0', async () => {
  const root = cleanRoot();
  const { logs, result } = await offline(root, (dir) => writeFileSync(join(dir, 'observed.json'), '{ nope', 'utf8'));
  assert.equal(result.code, 2);
  assert.ok(logs.some((l) => l.startsWith('note: the observation state could not be read')), logs.join('\n'));
});

test('--live: Admin moved, a live-only article, and visibility are each reported', async () => {
  const root = cleanRoot();
  const node = nodeFromRepo(root);
  const orphan = nodeFromRepo(root, HANDLE, { id: 'gid://shopify/Article/2', handle: 'orphan-post', isPublished: VISIBLE });
  const client = makeClient({ articles: [{ ...node, summary: 'Edited in Admin.' }, orphan] });
  const { ctx, stateDir, logs } = makeCtx({ root, client });
  seedObservation(stateDir, node);
  seedObservation(stateDir, orphan);
  const result = await run(['--live'], ctx);
  assert.equal(result.code, 2);
  assert.equal(logs[1], 'live:   read from Admin');
  assert.deepEqual(logs.slice(3), [
    HANDLE,
    '  Admin moved since this machine last observed it',
    '  next: npm run articles:pull -- --check   (read both sides; the push refuses until the baseline is current)',
    'orphan-post',
    '  live, with no repo directory (VISIBLE on the storefront)',
    '  next: nothing automatic: it exists only in Admin; decide there, or add a repo directory for it',
  ]);
  assert.equal(client.calls.filter((c) => c.kind !== 'query').length, 0);
});

test('--live: in sync exits 0', async () => {
  const root = cleanRoot();
  const node = nodeFromRepo(root);
  const { ctx, stateDir } = makeCtx({ root, client: makeClient({ articles: [node] }) });
  seedObservation(stateDir, node);
  assert.equal(await toExitCode(run, ['--live'], ctx, 'status'), 0);
});

test('exit 1 when the tree cannot be read or a flag is unknown', async () => {
  const root = cleanRoot();
  writeFileSync(join(root, 'marketing', 'articles', 'manifest.json'), '{ nope', 'utf8');
  assert.equal(await toExitCode(run, [], makeCtx({ root }).ctx, 'status'), 1);
  assert.equal(await toExitCode(run, ['--seed'], makeCtx({ root: cleanRoot() }).ctx, 'status'), 1);
});

test('an empty tree says so', () => {
  const lines = format({ rows: [], notes: [], state: { display: '/x/observed.json', exists: true }, live: false });
  assert.deepEqual(lines, ['state:  /x/observed.json', OFFLINE, '', 'no articles in marketing/articles/']);
});
