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

import { buildManifest, formatManifest } from '../reindex.mjs';

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

/** Copy the repo's real catalogue into a fixture root, for the product-link cases. */
export function withRealCatalogue(root) {
  cpSync(join(REPO_ROOT, 'catalogue.json'), join(root, 'catalogue.json'));
  return root;
}

/**
 * Rewrite the manifest from what is on disk, with the real reindexer's own two functions.
 *
 * Most cases are about content being wrong, not about the manifest being stale. Rewriting the
 * manifest after the mutation keeps the hash rules quiet so the case under test is the only one that
 * fires; the hash rules have their own cases, where staleness IS the subject.
 *
 * NOT A SECOND IMPLEMENTATION. This used to recompute the hashes itself, once here and once again in
 * the check suite, and each copy could drift from `reindex.mjs` without any test noticing, because
 * the checker was then being measured against the helper rather than against the tool an operator
 * runs. Calling `buildManifest` also recomputes EVERY entry, so a case that adds a second article
 * cannot leave it carrying the first one's hashes.
 */
export function reindexInPlace(root) {
  writeFileSync(join(root, 'marketing', 'articles', 'manifest.json'), formatManifest(buildManifest(root)), 'utf8');
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
