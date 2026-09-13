// lib/state.mjs and lib/backups.mjs: where the machine-local files live, what they are called, and
// that neither can land inside the checkout.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { BACKUP_DIR_BASENAME, BACKUP_ENV_VAR, backupFileName, backupRecord, defaultBackupDir, resolveBackupDir } from '../lib/backups.mjs';
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
  observationByHandle,
  readState,
  resolveStateDir,
  withIntent,
  withObservation,
  withoutIntent,
  writeState,
} from '../lib/state.mjs';
import { HANDLE, REPO_ROOT, cleanRoot, cleanup } from './helpers.mjs';
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
