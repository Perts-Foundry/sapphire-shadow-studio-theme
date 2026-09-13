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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { buildManifest, formatManifest } from '../reindex.mjs';
import { ARTICLE_FILES, META_FIELDS, metaSha256 } from '../lib/articles.mjs';
import {
  HANDLE,
  TEST_DIR,
  cleanRoot,
  cleanup,
  madeRoots,
  readArticle,
  readBody,
  readManifestFile,
  writeBody,
  writeManifestFile,
} from './helpers.mjs';

const TEMP_ROOT = statSync(tmpdir()).isDirectory() ? tmpdir() : null;

/**
 * Roots this file builds itself, outside the helper's registry.
 *
 * The CLI cases need a tree the helper cannot produce, namely a deliberately unreadable one, so they
 * are created here. They are registered here too and go through the SAME temp-root guard below: a
 * root that skipped it would be the one path in this suite able to write outside the temp directory.
 */
const brokenRoots = [];

after(() => {
  assert.ok(TEMP_ROOT, 'no usable temp directory');
  const roots = [...madeRoots(), ...brokenRoots];
  assert.ok(roots.length > 0, 'the temp-root guard ran before anything was created, so it checked nothing');
  for (const root of roots) assert.ok(root.startsWith(TEMP_ROOT), `${root} is not under the temp root`);
  for (const root of brokenRoots) rmSync(root, { recursive: true, force: true });
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

for (const file of ARTICLE_FILES) {
  test(`a directory missing ${file} is skipped rather than invented into the manifest`, () => {
    // Reporting it is the checker's job (MISSING_FILE). If reindex minted an entry for a directory
    // with no article.json, the checker's bijection rule would go quiet about the real problem.
    // The earlier version of this test removed nothing, so it asserted the clean case twice.
    const root = cleanRoot();
    const target = join(root, 'marketing', 'articles', HANDLE, file);
    rmSync(target);
    assert.equal(existsSync(target), false);
    assert.deepEqual(buildManifest(root).articles, {}, `an entry was built for a directory with no ${file}`);
  });
}

test('a CRLF body hashes identically to the same body with LF endings', () => {
  // Git on a Windows checkout can hand a body back with CRLF endings. The hash is taken over the
  // canonical form, so the manifest must not read that as an edit.
  const root = cleanRoot();
  const lf = buildManifest(root).articles[HANDLE];
  writeBody(root, readBody(root).replace(/\n/g, '\r\n'));
  assert.ok(readBody(root).includes('\r\n'), 'the mutation did not produce CRLF');
  const crlf = buildManifest(root).articles[HANDLE];
  assert.equal(crlf.bodySha256, lf.bodySha256);
  assert.equal(crlf.bodyLength, lf.bodyLength);
});

// ---------------------------------------------------------------------------------------------
// The exit-code contract, exercised through the CLI
// ---------------------------------------------------------------------------------------------

/** Run the real command against a root, and return what a caller would see. */
function runReindex(root, extra = []) {
  const script = join(TEST_DIR, '..', 'reindex.mjs');
  const run = spawnSync(process.execPath, [script, '--root', root, ...extra], { encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

test('--check exits EXACTLY 2 on drift, and exactly 1 when it cannot run', () => {
  // The header of reindex.mjs calls this contract load-bearing, and until now nothing exercised it:
  // every other test in this file calls buildManifest and formatManifest directly, so the whole of
  // main() and its three exit codes were unreached. Asserting "non-zero" would rebuild the same gap
  // in a new shape, because collapsing 2 into 1 is the exact confusion the contract exists to stop:
  // a caller that cannot tell a stale manifest from an unreadable checkout tells the operator to run
  // a command that cannot help them.
  const clean = cleanRoot();
  const current = runReindex(clean, ['--check']);
  assert.equal(current.status, 0, `a current manifest must exit 0:\n${current.stderr}`);
  assert.match(current.stdout, /manifest\.json is current/);

  const drifted = cleanRoot();
  const manifest = readManifestFile(drifted);
  manifest.articles[Object.keys(manifest.articles)[0]].bodyLength = 1;
  writeManifestFile(drifted, manifest);
  const stale = runReindex(drifted, ['--check']);
  assert.equal(stale.status, 2, `drift must exit 2, not merely non-zero:\n${stale.stderr}`);
  assert.match(stale.stderr, /manifest\.json is stale/);

  // An unreadable tree is a different fact and gets a different code. `marketing/articles` is made
  // a FILE rather than a directory, deliberately: a MISSING directory is not an error at all, since
  // the builder returns an empty manifest for it, which then reads as drift and exits 2. The only
  // way to reach the failure branch on purpose is a path that exists and cannot be read as a
  // directory. Permissions are the other route and are worse, because they do not behave the same
  // way when the suite runs as root, which it does in CI.
  const broken = mkdtempSync(join(tmpdir(), 'articles-broken-'));
  brokenRoots.push(broken);
  mkdirSync(join(broken, 'marketing'), { recursive: true });
  writeFileSync(join(broken, 'marketing', 'articles'), 'not a directory', 'utf8');
  const unreadable = runReindex(broken, ['--check']);
  assert.equal(unreadable.status, 1, `an unreadable tree must exit 1, not 2:\n${unreadable.stderr}`);
});

test('a write run creates manifest.json when there is none', () => {
  const root = cleanRoot();
  const file = join(root, 'marketing', 'articles', 'manifest.json');
  const expected = readFileSync(file, 'utf8');
  rmSync(file);
  const written = runReindex(root);
  assert.equal(written.status, 0, written.stderr);
  assert.equal(readFileSync(file, 'utf8'), expected, 'the created manifest is not the committed one');
});

test('a write run rewrites a drifted manifest and then reports itself current', () => {
  // The other half of the same surface: --check must never write, and the write path must leave the
  // tree in the state --check calls current. Nothing reached either through the CLI before.
  const root = cleanRoot();
  const manifest = readManifestFile(root);
  manifest.articles[Object.keys(manifest.articles)[0]].bodyLength = 1;
  writeManifestFile(root, manifest);

  const checked = runReindex(root, ['--check']);
  assert.equal(checked.status, 2);
  assert.equal(readManifestFile(root).articles[HANDLE].bodyLength, 1, '--check wrote to the manifest');

  const written = runReindex(root);
  assert.equal(written.status, 0, written.stderr);
  assert.match(written.stdout, /manifest\.json rewritten/);
  assert.equal(runReindex(root, ['--check']).status, 0, 'a rewritten manifest is not current');
});
