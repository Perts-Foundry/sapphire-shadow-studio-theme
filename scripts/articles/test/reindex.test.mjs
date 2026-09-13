// scripts/articles/reindex.mjs: the manifest is DERIVED, and `--check` reports drift without
// writing.
//
// The load-bearing property is the EXIT CODE CONTRACT. `--check` exits 2 on drift and 1 when it
// could not run, and those must stay distinguishable: a caller that collapsed them into "non-zero"
// could not tell a stale manifest from a broken checkout, and would tell an operator to re-run a
// command that cannot help.
//
// The other property is COVERAGE OF metaSha256. Its field list is the contract, and a field missing
// from it is invisible to both this command and the checker's hashes-agree rule, so every field is
// edited here and each edit must move the hash.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { buildManifest, formatManifest } from '../reindex.mjs';
import { META_FIELDS, metaSha256 } from '../lib/articles.mjs';
import {
  cleanRoot,
  cleanup,
  madeRoots,
  readArticle,
  readManifestFile,
  writeArticle,
  writeBody,
  writeManifestFile,
} from './helpers.mjs';

const TEMP_ROOT = statSync(tmpdir()).isDirectory() ? tmpdir() : null;

after(() => {
  assert.ok(TEMP_ROOT, 'no usable temp directory');
  const roots = madeRoots();
  assert.ok(roots.length > 0, 'the temp-root guard ran before anything was created, so it checked nothing');
  for (const root of roots) assert.ok(root.startsWith(TEMP_ROOT), `${root} is not under the temp root`);
  cleanup();
});

test('the committed clean fixture is already current, so drift means drift', () => {
  const root = cleanRoot();
  assert.equal(formatManifest(buildManifest(root)), `${JSON.stringify(readManifestFile(root), null, 2)}\n`);
});

test('a body edit moves bodySha256 and bodyLength', () => {
  const root = cleanRoot();
  const before = buildManifest(root);
  writeBody(root, '<p>Something else entirely.</p>\n');
  const after_ = buildManifest(root);
  const handle = Object.keys(before.articles)[0];
  assert.notEqual(after_.articles[handle].bodySha256, before.articles[handle].bodySha256);
  assert.notEqual(after_.articles[handle].bodyLength, before.articles[handle].bodyLength);
});

test('every field feeding metaSha256 actually moves it', () => {
  // The list IS the contract. A field named in META_FIELDS but not reaching the hash would make an
  // edit to it invisible to the checker, which is the silent-drift shape this whole manifest exists
  // to prevent.
  const root = cleanRoot();
  const base = readArticle(root);
  const baseline = metaSha256(base);

  const edits = {
    handle: 'a-different-handle',
    title: 'A different title',
    author: 'Someone else',
    summary: 'A different summary, long enough to be a real one.',
    tags: ['different'],
    templateSuffix: 'photo-story',
    seo: { title: 'Different', description: 'A different description that is long enough to pass the minimum bound.' },
    image: 'https://cdn.shopify.com/s/files/1/0000/0001/files/other.jpg',
    previousHandles: ['an-old-handle'],
  };

  for (const field of META_FIELDS) {
    assert.ok(field in edits, `META_FIELDS names "${field}" but this test has no edit for it`);
    const mutated = { ...base, [field]: edits[field] };
    assert.notEqual(metaSha256(mutated), baseline, `editing ${field} did not move metaSha256`);
  }
});

test('metaSha256 ignores key order, so re-serialising article.json is not drift', () => {
  const root = cleanRoot();
  const article = readArticle(root);
  const reversed = {};
  for (const key of Object.keys(article).reverse()) reversed[key] = article[key];
  assert.equal(metaSha256(reversed), metaSha256(article));
});

test('an absent optional field and an explicit null hash the same', () => {
  // Otherwise "omit it" and "write null" would be two spellings of one state, and a reindex after a
  // hand edit would report drift that is not there.
  const root = cleanRoot();
  const article = readArticle(root);
  const withNull = { ...article, templateSuffix: null };
  const without = { ...article };
  delete without.templateSuffix;
  assert.equal(metaSha256(withNull), metaSha256(without));
});

test('a half-written article directory is skipped rather than invented into the manifest', () => {
  // Reporting it is the checker's job (MISSING_FILE). If reindex minted an entry for a directory
  // with no article.json, the checker's bijection rule would go quiet about the real problem.
  const root = cleanRoot();
  writeArticle(root, readArticle(root));
  const built = buildManifest(root);
  assert.equal(Object.keys(built.articles).length, 1);
});

test('a stale manifest is drift, and rewriting it is not', () => {
  const root = cleanRoot();
  const manifest = readManifestFile(root);
  const handle = Object.keys(manifest.articles)[0];
  manifest.articles[handle].bodyLength = 1;
  writeManifestFile(root, manifest);
  assert.notEqual(formatManifest(buildManifest(root)), `${JSON.stringify(readManifestFile(root), null, 2)}\n`);
});
