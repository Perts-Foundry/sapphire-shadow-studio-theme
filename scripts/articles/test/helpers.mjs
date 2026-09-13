// TEST SUPPORT: a disposable copy of the committed clean fixture, and the mutations each rule case
// applies to it.
//
// WHY MUTATION RATHER THAN FORTY COMMITTED FIXTURES. Every rule needs a tree that trips it and
// nothing else. Committing one directory per rule would mean forty near-identical articles, and the
// day a shared field changes, thirty-nine of them drift out of sync with the fortieth and nobody
// notices because each still trips its own rule. One reviewable golden article plus one explicit
// mutation per rule keeps the difference between "clean" and "broken" visible in a single line.
//
// EVERY PATH IS UNDER A TEMP ROOT, asserted by the suites that use this.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { metaSha256, sha256, stripVersionQuery } from '../lib/articles.mjs';

export const TEST_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(TEST_DIR, '..', '..', '..');
export const CLEAN_FIXTURE = join(TEST_DIR, 'fixtures', 'clean');
export const HANDLE = 'welcome-to-shift-notes';

const MADE = [];

/** A fresh copy of the clean fixture in a temp directory. Returns the root. */
export function cleanRoot() {
  const root = mkdtempSync(join(tmpdir(), 'articles-fixture-'));
  MADE.push(root);
  cpSync(CLEAN_FIXTURE, root, { recursive: true });
  return root;
}

/** Every temp root this module has created, for the suite-level guard. */
export function madeRoots() {
  return [...MADE];
}

export function cleanup() {
  for (const root of MADE) rmSync(root, { recursive: true, force: true });
  MADE.length = 0;
}

function articleDir(root, handle = HANDLE) {
  return join(root, 'marketing', 'articles', handle);
}

export function readBody(root, handle = HANDLE) {
  return readFileSync(join(articleDir(root, handle), 'body.html'), 'utf8');
}

export function writeBody(root, text, handle = HANDLE) {
  writeFileSync(join(articleDir(root, handle), 'body.html'), text, 'utf8');
}

export function readArticle(root, handle = HANDLE) {
  return JSON.parse(readFileSync(join(articleDir(root, handle), 'article.json'), 'utf8'));
}

export function writeArticle(root, article, handle = HANDLE) {
  writeFileSync(join(articleDir(root, handle), 'article.json'), `${JSON.stringify(article, null, 2)}\n`, 'utf8');
}

export function readImages(root, handle = HANDLE) {
  return JSON.parse(readFileSync(join(articleDir(root, handle), 'images.json'), 'utf8'));
}

export function writeImages(root, images, handle = HANDLE) {
  writeFileSync(join(articleDir(root, handle), 'images.json'), `${JSON.stringify(images, null, 2)}\n`, 'utf8');
}

export function readManifestFile(root) {
  return JSON.parse(readFileSync(join(root, 'marketing', 'articles', 'manifest.json'), 'utf8'));
}

export function writeManifestFile(root, manifest) {
  writeFileSync(join(root, 'marketing', 'articles', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * Edit an article's metadata and keep the manifest in step.
 *
 * Most rule cases are about the CONTENT being wrong, not about the manifest being stale. Without
 * this the hash rules would fire alongside the rule under test and every case would trip two ids,
 * which is exactly what the "trips exactly one" assertion is there to catch.
 */
export function mutateArticle(root, mutate) {
  const article = readArticle(root);
  mutate(article);
  writeArticle(root, article);
  return article;
}

/** Copy the repo's real catalogue into a fixture root, for the product-link cases. */
export function withRealCatalogue(root) {
  cpSync(join(REPO_ROOT, 'catalogue.json'), join(root, 'catalogue.json'));
  return root;
}

/**
 * Recompute ONE manifest entry from what is on disk.
 *
 * Several cases add a second article, and copying the first one's entry was the obvious shortcut
 * and is wrong: the copy's `metaSha256` describes a different handle, so the case trips the hash
 * rule as well as the rule under test and the "exactly one rule" assertion fails for a reason that
 * has nothing to do with what is being tested.
 */
export function reindexHandle(root, handle = HANDLE) {
  const manifest = readManifestFile(root);
  const body = readFileSync(join(articleDir(root, handle), 'body.html'), 'utf8').replace(/\n$/, '');
  const article = readArticle(root, handle);
  const images = readImages(root, handle);
  manifest.articles[handle] = {
    bodySha256: sha256(body),
    bodyLength: body.length,
    metaSha256: metaSha256(article),
    images: (Array.isArray(images.images) ? images.images : []).map((e) => stripVersionQuery(e?.url)).sort(),
  };
  writeManifestFile(root, manifest);
}

/** Add a second article directory, for the redirect-collision case. */
export function addSecondArticle(root, handle) {
  const dir = articleDir(root, handle);
  mkdirSync(dir, { recursive: true });
  cpSync(join(articleDir(root), 'body.html'), join(dir, 'body.html'));
  cpSync(join(articleDir(root), 'images.json'), join(dir, 'images.json'));
  const article = readArticle(root);
  article.handle = handle;
  writeFileSync(join(dir, 'article.json'), `${JSON.stringify(article, null, 2)}\n`, 'utf8');
  return dir;
}
