// Where the per-product state files, their archive, and the live-write receipts live.
//
// Outside any checkout on purpose, and for a reason stronger than tidiness: these files hold live
// store facts (GIDs, variant ids, quantities) and the repo is public. A state directory inside the
// tree is one `git add -A` away from being a commit nobody meant to make.
//
// Resolved from the environment only, never from cwd, so the same command finds the same run
// whichever directory it is invoked from. That cwd-relative bug shipped once already in
// blank-inventory and is not worth rediscovering here.

import os from 'node:os';
import path from 'node:path';

export const STATE_DIR_BASENAME = 'add-product';

/** 0700 on the directory, 0600 on the files. They record live-store facts. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/**
 * The default state directory: an XDG state path outside any checkout.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} absolute path
 */
export function defaultStateDir(env = process.env) {
  const stateHome = env.XDG_STATE_HOME?.trim();
  const base = stateHome && path.isAbsolute(stateHome) ? stateHome : path.join(os.homedir(), '.local', 'state');
  return path.join(base, STATE_DIR_BASENAME);
}

/**
 * The state directory for this run. ADD_PRODUCT_DIR overrides, resolved to an absolute path.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} absolute path
 */
export function resolveStateDir(env = process.env) {
  const override = env.ADD_PRODUCT_DIR?.trim();
  return override ? path.resolve(override) : defaultStateDir(env);
}

/** The state file for one handle. Always derived from the handle, never read out of a file. */
export function stateFilePath(dir, handle) {
  return path.join(dir, `${handle}.json`);
}

export function archiveDir(dir) {
  return path.join(dir, 'archive');
}

export function receiptsDir(dir) {
  return path.join(dir, 'receipts');
}
