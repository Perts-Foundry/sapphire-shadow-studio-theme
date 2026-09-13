// lib/state.mjs and lib/backups.mjs: where the machine-local files live, what they are called, and
// that neither can land inside the checkout.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { BACKUP_DIR_BASENAME, BACKUP_ENV_VAR, backupFileName, backupRecord, defaultBackupDir, resolveBackupDir } from '../lib/backups.mjs';
import { plan } from '../check.mjs';
import { RULES } from '../lib/articles.mjs';
import { ArticleError } from '../lib/context.mjs';
import {
  CHECK_COMMAND,
  SEED_COMMAND,
  STATE_DIR_BASENAME,
  STATE_ENV_VAR,
  assertStateDirOutsideRepo,
  defaultStateDir,
  emptyState,
  intentFor,
  makeObservation,
  observationByHandle,
  pendingIntent,
  readState,
  recordedImageSource,
  resolveStateDir,
  withIntent,
  withObservation,
  withoutIntent,
  writeState,
} from '../lib/state.mjs';
import { HANDLE, REPO_ROOT, cleanRoot, cleanup, readArticle, reindexInPlace, writeArticle } from './helpers.mjs';
import { NOW, cleanupDirs, nodeFromRepo, tempDir } from './network-helpers.mjs';

after(() => {
  cleanupDirs();
  cleanup();
});

test('the names follow the policies shape, and every refusal names the same seed command', () => {
  assert.equal(STATE_DIR_BASENAME, 'sapphire-articles-state');
  assert.equal(BACKUP_DIR_BASENAME, 'sapphire-articles');
  assert.equal(STATE_ENV_VAR, 'ARTICLES_STATE_DIR');
  assert.equal(BACKUP_ENV_VAR, 'ARTICLES_BACKUP_DIR');
  assert.equal(SEED_COMMAND, 'npm run articles:pull -- --seed');
  assert.equal(CHECK_COMMAND, 'npm run articles:pull -- --check');
});

test('the state and backup directories are SIBLINGS, never one inside the other', () => {
  const env = { XDG_STATE_HOME: '/var/state' };
  const state = defaultStateDir(env);
  const backups = defaultBackupDir(env);
  assert.equal(state, path.join('/var/state', 'sapphire-articles-state'));
  assert.equal(backups, path.join('/var/state', 'sapphire-articles'));
  assert.equal(state.startsWith(backups + path.sep), false);
  assert.equal(backups.startsWith(state + path.sep), false);
});

test('the default backup and state locations are outside the checkout, pinned', () => {
  for (const dir of [defaultBackupDir({}), defaultStateDir({}), resolveBackupDir({}), resolveStateDir({})]) {
    assert.equal(dir === REPO_ROOT || dir.startsWith(REPO_ROOT + path.sep), false, `${dir} is inside the checkout`);
    assert.ok(path.isAbsolute(dir));
  }
});

test('the overrides win and resolve absolutely; a blank override does not become the cwd', () => {
  assert.equal(resolveBackupDir({ ARTICLES_BACKUP_DIR: '/abs/b' }), path.resolve('/abs/b'));
  assert.equal(resolveBackupDir({ ARTICLES_BACKUP_DIR: 'rel/b' }), path.join(process.cwd(), 'rel', 'b'));
  assert.equal(resolveBackupDir({ ARTICLES_BACKUP_DIR: '   ', XDG_STATE_HOME: '/var/state' }), path.join('/var/state', 'sapphire-articles'));
  assert.equal(resolveStateDir({ ARTICLES_STATE_DIR: '/abs/s' }), path.resolve('/abs/s'));
});

test('a state directory inside the checkout is refused, as an ArticleError', () => {
  const root = cleanRoot();
  assert.throws(() => assertStateDirOutsideRepo(path.join(root, 'state'), root), ArticleError);
  assert.throws(() => writeState({ dir: path.join(root, 'state'), root, state: emptyState() }), /inside the checkout/);
});

test('an intents value that is not an object is a refusal; a file without one reads as none', () => {
  const dir = tempDir('articles-state-');
  writeFileSync(path.join(dir, 'observed.json'), JSON.stringify({ schemaVersion: 1, articles: {}, intents: [] }), 'utf8');
  assert.throws(() => readState({ dir }), /"intents" value that is not an object/);
  writeFileSync(path.join(dir, 'observed.json'), JSON.stringify({ schemaVersion: 1, articles: {} }), 'utf8');
  assert.deepEqual(readState({ dir }).intents, {});
  writeFileSync(path.join(dir, 'observed.json'), '{ nope', 'utf8');
  assert.throws(() => readState({ dir }), (err) => err instanceof ArticleError && err.message.includes(SEED_COMMAND));
});

test('the state helpers are pure: the input state is never modified', () => {
  const base = emptyState();
  const frozen = JSON.stringify(base);
  const a = withObservation(base, 'gid://shopify/Article/1', { handle: HANDLE });
  const b = withIntent(a, HANDLE, { op: 'create' });
  const c = withoutIntent(b, HANDLE);
  assert.equal(JSON.stringify(base), frozen);
  assert.equal(intentFor(b, HANDLE).op, 'create');
  assert.equal(intentFor(c, HANDLE), undefined);
  assert.equal(intentFor(a, HANDLE), undefined);
  assert.deepEqual(observationByHandle(c, HANDLE), ['gid://shopify/Article/1', { handle: HANDLE }]);
  assert.equal(observationByHandle(c, 'nope'), null);
});

test('pendingIntent finds a record by the current handle, then by a previous handle, then by GID', () => {
  const gid = 'gid://shopify/Article/1';
  const state = withIntent(withIntent(emptyState(), 'old-handle', { op: 'create', gid: null }), 'elsewhere', { op: 'update', gid });
  assert.deepEqual(pendingIntent(state, { handles: ['new-handle', 'old-handle'] }), ['old-handle', { op: 'create', gid: null }]);
  assert.deepEqual(pendingIntent(state, { handles: ['new-handle'], gid }), ['elsewhere', { op: 'update', gid }]);
  assert.equal(pendingIntent(state, { handles: ['new-handle'], gid: 'gid://shopify/Article/2' }), undefined);
  assert.equal(pendingIntent(state, { handles: ['new-handle'], gid: null }), undefined, 'a null GID must not match a create intent\'s null gid');
  assert.equal(pendingIntent(null, { handles: ['x'] }), undefined);
});

test('a backup file is named <handle>-<timestamp>.json with a filesystem-safe timestamp', () => {
  assert.equal(backupFileName(HANDLE, '2026-01-02T03:04:05.678Z'), `${HANDLE}-2026-01-02T03-04-05-678Z.json`);
});

test('a backup record holds the live article and the repo shapes to copy back', () => {
  const root = cleanRoot();
  const node = nodeFromRepo(root, HANDLE, { templateSuffix: '' });
  const record = backupRecord({ node, blogHandle: 'shift-notes', liveSha256: 'a'.repeat(64), fetchedAt: NOW });
  assert.equal(record.gid, node.id);
  assert.deepEqual(record.live, node);
  assert.equal(record.restore['body.html'], `${node.body}\n`);
  assert.deepEqual(record.restore['article.json'], {
    handle: HANDLE,
    title: node.title,
    author: node.author.name,
    summary: node.summary,
    tags: node.tags,
    templateSuffix: null,
    seo: { title: node.titleTag.value, description: node.descriptionTag.value },
    image: node.image.url,
  });
  assert.equal(record.restore.imageAlt, node.image.altText);
  mkdirSync(path.join(tmpdir()), { recursive: true });
});

test('an empty-string templateSuffix: kept verbatim under live, restored as null because articles:check refuses ""', () => {
  // Reviewed as a possible `||`-for-`??` defect. It is deliberate: `restore` is copied into
  // article.json, and a "" suffix there names templates/article..json, which the checker refuses.
  const root = cleanRoot();
  const node = nodeFromRepo(root, HANDLE, { templateSuffix: '' });
  const record = backupRecord({ node, blogHandle: 'shift-notes', liveSha256: 'a'.repeat(64), fetchedAt: NOW });
  assert.equal(record.live.templateSuffix, '', 'the live half must hold exactly what Admin returned');
  assert.equal(record.restore['article.json'].templateSuffix, null);

  const article = readArticle(root);
  article.templateSuffix = '';
  writeArticle(root, article);
  reindexInPlace(root);
  assert.ok(plan(root).findings.some((f) => f.rule === RULES.TEMPLATE_SUFFIX_UNKNOWN), 'the checker no longer refuses "", so restore could keep it');
  article.templateSuffix = record.restore['article.json'].templateSuffix;
  writeArticle(root, article);
  reindexInPlace(root);
  assert.deepEqual(plan(root).findings, [], 'the restored value must pass the checker');
});

test('an observation records the live image URL and the source it was copied from, and trusts the source only for that copy', () => {
  const root = cleanRoot();
  const node = nodeFromRepo(root);
  const observation = makeObservation({ node, liveSha256: 'a'.repeat(64), bodySha256: 'b'.repeat(64), matchedRepoSha256: null, now: NOW, imageSourceUrl: 'https://cdn.shopify.com/src.jpg' });
  assert.equal(observation.liveImageUrl, node.image.url);
  assert.equal(recordedImageSource(observation, node.image.url), 'https://cdn.shopify.com/src.jpg');
  assert.equal(recordedImageSource(observation, 'https://cdn.shopify.com/replaced-in-admin.jpg'), null);
  assert.equal(recordedImageSource(observation, null), null);
  assert.equal(recordedImageSource(undefined, node.image.url), null);
  assert.equal(recordedImageSource({ ...observation, imageSourceUrl: undefined }, node.image.url), null, 'an observation from before these fields is unknown');
  assert.equal(makeObservation({ node: { ...node, image: null }, liveSha256: 'a', bodySha256: 'b', now: NOW, imageSourceUrl: 'x' }).imageSourceUrl, null);
});
