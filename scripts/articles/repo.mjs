// Reading one article from the working tree, for the network commands.
//
// NOT IN lib/, on purpose: it reads files, and scripts/articles/lib/ holds no filesystem access (the
// leaf test asserts it). The four network commands all need the same read, so it lives beside them
// rather than being written four times. It never writes.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { paths, readManifest } from './check.mjs';
import { ARTICLE_FILES, ARTICLES_DIR, bodyFromFileText, isHandle } from './lib/articles.mjs';
import { ArticleError } from './lib/context.mjs';
import { projectionSha, repoProjection } from './lib/projection.mjs';

/** Every handle the manifest lists, sorted. */
export function repoHandles(root) {
  return Object.keys(readManifest(root).articles).sort();
}

/**
 * Every handle a repo directory claims: each current handle and each of its previousHandles. A live
 * article at any of these belongs to a repo directory, pushed or not.
 */
export function claimedHandles(root) {
  const out = new Set();
  for (const handle of repoHandles(root)) {
    out.add(handle);
    for (const old of readRepoArticle(root, handle).article.previousHandles ?? []) out.add(old);
  }
  return out;
}

/**
 * One article's files, parsed, with its projection and projection hash.
 *
 * Refuses rather than guessing: a handle that is not a handle, one the manifest does not list, a
 * missing file, or a JSON file that does not parse. `articles:check` reports all of those precisely;
 * the commands that call this have already run it or report it themselves.
 */
export function readRepoArticle(root, handle) {
  if (!isHandle(handle)) throw new ArticleError(String(handle), 'is not a kebab-case article handle');
  const manifest = readManifest(root);
  if (!manifest.articles[handle]) {
    throw new ArticleError(handle, `has no entry in ${ARTICLES_DIR}/manifest.json`);
  }
  const dir = paths(root).article(handle);
  for (const file of ARTICLE_FILES) {
    if (!existsSync(join(dir, file))) throw new ArticleError(handle, `is missing ${file}`);
  }
  const parse = (file) => {
    try {
      return JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (err) {
      throw new ArticleError(`${handle}/${file}`, `is not valid JSON (${err.message})`);
    }
  };
  const body = bodyFromFileText(readFileSync(join(dir, 'body.html'), 'utf8'));
  const article = parse('article.json');
  const images = parse('images.json');
  const projection = repoProjection({ article, body, images });
  return { handle, dir, article, body, images, projection, sha: projectionSha(projection) };
}
