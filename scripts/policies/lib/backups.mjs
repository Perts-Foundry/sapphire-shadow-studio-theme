// Where `policies:push` writes its pre-mutation backups.
//
// OUTSIDE THE CHECKOUT, deliberately, following the shape proven in
// scripts/blank-inventory/lib/workdir.mjs. Two reasons, and the second is the one that matters:
//
//  1. A directory inside the tree is protected only by a .gitignore line, which a single
//     `git add -f` or a pattern edit defeats. This repo is public.
//  2. THE REPO IS NOT AN ADEQUATE BACKUP. After a wording change lands, `HEAD` holds the new
//     text and `HEAD~` matches live only if Admin has not been edited since. The backup is the
//     only record of what Admin actually held at the moment of the write.
//
// The path is resolved absolutely, so it never depends on cwd (the exact bug workdir.mjs was
// rewritten to remove). POLICIES_BACKUP_DIR overrides, for tests and for a machine that relocates
// state. The directory is created 0700 and the files 0600.
//
// No fs here beyond path building: the caller owns the writes, so this module stays pure enough
// to test without a temp directory.

import os from 'node:os';
import path from 'node:path';

import { displayPath } from '../../lib/display-path.mjs';

// Re-exported as a BINDING, not with `export ... from`: the import-closure guard refuses the latter
// because its walker cannot follow it. Every existing caller keeps importing `displayPath` from
// here; the implementation moved to scripts/lib/ when the observation state started needing it too,
// and one implementation is the point.
export { displayPath };

/** The conventional basename, wherever the directory ends up. */
export const BACKUP_DIR_BASENAME = 'shop-policies';

/** 0700 on the directory, 0600 on each file. A backup holds the full live policy body. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/**
 * The default backup directory: an XDG state path outside any checkout.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} absolute path
 */
export function defaultBackupDir(env = process.env) {
  const stateHome = env.XDG_STATE_HOME?.trim();
  const base = stateHome && path.isAbsolute(stateHome) ? stateHome : path.join(os.homedir(), '.local', 'state');
  return path.join(base, BACKUP_DIR_BASENAME);
}

/**
 * The backup directory for this run. POLICIES_BACKUP_DIR overrides and is resolved to an absolute
 * path so the result never depends on cwd.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} absolute path
 */
export function resolveBackupDir(env = process.env) {
  const override = env.POLICIES_BACKUP_DIR?.trim();
  return override ? path.resolve(override) : defaultBackupDir(env);
}

/**
 * The filename for one backup: type, then a filesystem-safe timestamp, so `ls` sorts by policy
 * and then chronologically.
 * @param {string} type  a ShopPolicyType
 * @param {string} now   ISO-8601 timestamp
 */
export function backupFileName(type, now) {
  return `${type.toLowerCase()}.${String(now).replace(/[:.]/g, '-')}.json`;
}

