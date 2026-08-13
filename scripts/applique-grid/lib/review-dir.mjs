// APPLIQUE_REVIEW_DIR: an opt-in drop folder OUTSIDE the repo where the gate's review images are
// copied so the operator can open them from their own file browser. It is the only write in this
// module that lands outside a `product-images/` path, so it carries its own guard rather than
// none.
//
// The resolved path is a dev-machine path, which is sensitive content in this public repo. It is
// therefore never printed, never written into gate-table.md, the ledger, a commit message, a PR
// body, or an issue comment; only the COUNT of files copied is reported. The README example stays
// symbolic (`export APPLIQUE_REVIEW_DIR=<your-review-dir>`) for the same reason.

import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const REVIEW_DIR_ENV = 'APPLIQUE_REVIEW_DIR';

/**
 * Why a review-dir value is unusable, or null when it is fine. Path-shape rules only; existence is
 * checked by resolveReviewDir, which owns the fs calls.
 * @param {string} value - the raw environment value
 * @param {string} repoRoot - absolute path of the repo working tree
 * @returns {string | null}
 */
export function reviewDirShapeProblem(value, repoRoot) {
  const raw = String(value ?? '');
  if (!raw.trim()) return `${REVIEW_DIR_ENV} is set but empty`;
  if (raw.split(/[\\/]/).includes('..')) return `${REVIEW_DIR_ENV} must not contain a ".." segment`;
  if (!path.isAbsolute(raw)) return `${REVIEW_DIR_ENV} must be an absolute path`;
  const resolved = path.resolve(raw);
  const root = path.resolve(repoRoot);
  const rel = path.relative(root, resolved);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    return `${REVIEW_DIR_ENV} must resolve OUTSIDE the repo working tree (it is a dev-machine path, and this repo is public)`;
  }
  return null;
}

/**
 * Resolve the review dir from the environment. Unset is a silent no-op (dir null, problem null);
 * set-but-unusable is a hard problem the caller refuses on.
 * @param {object} input
 * @param {string} input.repoRoot
 * @param {Record<string, string | undefined>} [input.env]
 * @returns {Promise<{dir: string | null, problem: string | null}>}
 */
export async function resolveReviewDir({ repoRoot, env = process.env }) {
  const raw = env[REVIEW_DIR_ENV];
  if (raw === undefined) return { dir: null, problem: null };
  const shape = reviewDirShapeProblem(raw, repoRoot);
  if (shape) return { dir: null, problem: shape };
  const resolved = path.resolve(raw);
  let info;
  try {
    info = await stat(resolved);
  } catch {
    return { dir: null, problem: `${REVIEW_DIR_ENV} does not exist; create the directory first` };
  }
  if (!info.isDirectory()) return { dir: null, problem: `${REVIEW_DIR_ENV} is not a directory` };
  return { dir: resolved, problem: null };
}

/**
 * Copy files into the review dir, into a named subfolder. The TOOL performs the copy; the
 * assistant is never asked to.
 * @param {string[]} files - absolute source paths
 * @param {string} dir - a dir already vetted by resolveReviewDir
 * @param {string} [subdir]
 * @returns {Promise<number>} how many files were copied
 */
export async function copyToReviewDir(files, dir, subdir = '') {
  if (!dir) return 0;
  const target = subdir ? path.join(dir, subdir) : dir;
  await mkdir(target, { recursive: true });
  let n = 0;
  for (const f of files) {
    await copyFile(f, path.join(target, path.basename(f)));
    n++;
  }
  return n;
}
