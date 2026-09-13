// Where the article push writes its pre-mutation backups, and what one holds.
//
// OUTSIDE THE CHECKOUT, deliberately, for the same two reasons as scripts/policies/lib/backups.mjs:
// a gitignore line is one `git add -f` away from committing a file in a public repo, and the repo is
// not a backup (after a change merges, HEAD holds the new text and says nothing about what Admin held
// at the moment of the write).
//
//   $XDG_STATE_HOME/sapphire-articles/<handle>-<timestamp>.json   (default)
//   $ARTICLES_BACKUP_DIR/<handle>-<timestamp>.json                (override)
//
// NAMED BY HANDLE FIRST, so `ls` groups one article's backups together and sorts them in time. The
// push resolves the directory absolutely and refuses one inside the checkout; that check and the
// write live in the push, because this file touches no filesystem.

import os from 'node:os';
import path from 'node:path';

import { displayPath } from '../../lib/display-path.mjs';
import { fileTextFor } from './articles.mjs';

// Re-exported as a binding, never with `export ... from`, which the import-closure guard refuses.
export { displayPath };

export const BACKUP_DIR_BASENAME = 'sapphire-articles';
export const BACKUP_ENV_VAR = 'ARTICLES_BACKUP_DIR';

/** 0700 on the directory, 0600 on each file. A backup holds a full article. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

export function defaultBackupDir(env) {
  const stateHome = env?.XDG_STATE_HOME?.trim();
  const base = stateHome && path.isAbsolute(stateHome) ? stateHome : path.join(os.homedir(), '.local', 'state');
  return path.join(base, BACKUP_DIR_BASENAME);
}

/** The override wins and is resolved absolutely, so the location never depends on cwd. */
export function resolveBackupDir(env) {
  const override = env?.[BACKUP_ENV_VAR]?.trim();
  return override ? path.resolve(override) : defaultBackupDir(env);
}

/** `<handle>-<timestamp>.json`, with the timestamp made filesystem-safe. */
export function backupFileName(handle, now) {
  return `${handle}-${String(now).replace(/[:.]/g, '-')}.json`;
}

/**
 * The backup record for one live article.
 *
 * `live` is the article exactly as Admin returned it. `restore` is the same article in the repo's
 * own shapes, so the copy-then-push recovery is a copy: `body.html` holds the bytes to write, and
 * `article.json` holds the fields that file carries. The featured image's alt text lives in
 * `images.json` in the repo, so it is recorded separately rather than guessed into a file shape.
 */
export function backupRecord({ node, blogHandle, liveSha256, fetchedAt }) {
  const article = {
    handle: node.handle,
    title: node.title,
    author: node.author?.name ?? '',
    summary: node.summary ?? '',
    tags: Array.isArray(node.tags) ? [...node.tags] : [],
    templateSuffix: node.templateSuffix || null,
    seo: {
      title: node.titleTag?.value ?? '',
      description: node.descriptionTag?.value ?? '',
    },
    image: node.image?.url ?? null,
  };
  return {
    gid: node.id,
    blogId: node.blog?.id ?? null,
    blogHandle,
    fetchedAt,
    liveSha256,
    live: node,
    restore: {
      'body.html': fileTextFor(node.body ?? ''),
      'article.json': article,
      imageAlt: node.image?.altText ?? null,
    },
  };
}
