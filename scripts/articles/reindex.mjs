#!/usr/bin/env node
// Rebuild marketing/articles/manifest.json from the tree.
//
// The manifest is DERIVED. Nothing here is a judgement: every field is a hash or a length computed
// from the committed files, so hand-editing it can only ever make it wrong. That is also why
// `articles:check` refuses a manifest that disagrees with the tree rather than quietly fixing it:
// the two commands have different jobs, and a checker that repaired its own input would report
// success on a tree nobody had reviewed.
//
//   node scripts/articles/reindex.mjs              rewrite the manifest
//   node scripts/articles/reindex.mjs --check      report drift, write nothing
//   node scripts/articles/reindex.mjs --root <dir> operate on another checkout (tests)
//
// EXIT CODES: 0 clean, 1 could not run, 2 drift under --check. The 2 is load-bearing and tested:
// it is what lets a caller tell "the manifest is stale" from "the tree could not be read", which a
// single non-zero code would collapse into one ambiguous failure.

import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARTICLES_DIR,
  ARTICLE_FILES,
  NON_ARTICLE_FILES,
  bodyFromFileText,
  metaSha256,
  sha256,
  stripVersionQuery,
} from './lib/articles.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function manifestPath(root) {
  return join(root, ...ARTICLES_DIR.split('/'), 'manifest.json');
}

/**
 * The manifest the tree implies.
 *
 * Skips a directory missing any of its three files: that is `articles:check`'s refusal to report,
 * and reindex inventing an entry for a half-written article would hide it.
 */
export function buildManifest(root = REPO_ROOT) {
  const dir = join(root, ...ARTICLES_DIR.split('/'));
  const articles = {};
  if (!existsSync(dir)) return { articles };
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    if (NON_ARTICLE_FILES.includes(name)) continue;
    if (ARTICLE_FILES.some((f) => !existsSync(join(full, f)))) continue;

    const body = bodyFromFileText(readFileSync(join(full, 'body.html'), 'utf8'));
    const article = JSON.parse(readFileSync(join(full, 'article.json'), 'utf8'));
    const images = JSON.parse(readFileSync(join(full, 'images.json'), 'utf8'));

    articles[name] = {
      bodySha256: sha256(body),
      bodyLength: body.length,
      metaSha256: metaSha256(article),
      images: (Array.isArray(images.images) ? images.images : []).map((e) => stripVersionQuery(e?.url)).sort(),
    };
  }
  return { articles };
}

/** The bytes the manifest file holds: stable key order, two-space indent, trailing newline. */
export function formatManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function readManifestText(root) {
  const file = manifestPath(root);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

function main(argv) {
  const args = argv.slice(2);
  const rootFlag = args.indexOf('--root');
  const root = rootFlag !== -1 ? resolve(args[rootFlag + 1]) : REPO_ROOT;
  const checkOnly = args.includes('--check');

  let next;
  try {
    next = formatManifest(buildManifest(root));
  } catch (err) {
    console.error(`error: ${err.message}`);
    console.error(`articles:reindex failed: ${ARTICLES_DIR}/ could not be read`);
    return 1;
  }

  const current = readManifestText(root);
  if (checkOnly) {
    if (current === next) {
      console.log('articles:reindex --check: manifest.json is current');
      return 0;
    }
    console.error('articles:reindex --check: manifest.json is stale; run npm run articles:reindex');
    return 2;
  }

  writeFileSync(manifestPath(root), next, 'utf8');
  console.log(current === next ? 'manifest.json unchanged' : 'manifest.json rewritten');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
