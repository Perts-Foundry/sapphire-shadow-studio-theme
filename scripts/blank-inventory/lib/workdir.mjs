// Where plan artifacts, receipts and proposals live.
//
// THIS DIRECTORY HOLDS LIVE SUPPLIER DATA. Artifacts enumerate real variant ids and real blank ids
// (which embed a supplier name and style number), so the default location is deliberately OUTSIDE
// the repository. This repo is public; a working directory inside the tree is protected only by a
// .gitignore entry, and a single `git add -f`, a pattern edit, or a stray `git add -A` from the
// wrong cwd defeats that. Keeping the data out of the tree removes the class of failure rather than
// guarding it.
//
// The original implementation resolved `.blank-inventory` relative to process.cwd(), so running the
// same command from `scripts/blank-inventory/` instead of the repo root silently created a SECOND
// working directory one level down, outside the root-anchored ignore pattern. That is exactly what
// happened, and the resulting artifact was left untracked-but-stageable in a public repo. Both the
// CLI and the blank-id guard now import from here so the two can never disagree about the path.

import os from 'node:os';
import path from 'node:path';

/** The conventional basename, wherever the directory ends up. */
export const WORK_DIR_BASENAME = '.blank-inventory';

/**
 * The default working directory: an XDG state path outside any checkout.
 *
 * Honours XDG_STATE_HOME when set, per the XDG Base Directory spec, so the location is predictable
 * on machines that relocate state.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} absolute path
 */
export function defaultWorkDir(env = process.env) {
  const stateHome = env.XDG_STATE_HOME?.trim();
  const base = stateHome && path.isAbsolute(stateHome) ? stateHome : path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'blank-inventory');
}

/**
 * Resolve the working directory for this run.
 *
 * BLANK_INVENTORY_DIR overrides, and is resolved to an absolute path so the result never depends on
 * cwd. Everything else falls back to `defaultWorkDir`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} absolute path
 */
export function resolveWorkDir(env = process.env) {
  const override = env.BLANK_INVENTORY_DIR?.trim();
  if (override) return path.resolve(override);
  return defaultWorkDir(env);
}

/**
 * Detect a stray working directory left by an older cwd-relative run.
 *
 * Silence is the failure mode here: an artifact written yesterday from a different cwd is simply
 * invisible to today's command, and the operator sees "no plan found" rather than a reason. Worse,
 * the stray copy may hold live blank ids inside the repo. Callers surface this loudly and refuse
 * write commands until it is cleared.
 *
 * @param {string} cwd
 * @param {string} resolved - the work dir this run will actually use
 * @returns {string|null} absolute path of the stray directory, or null
 */
export function findOrphanWorkDir(cwd, resolved) {
  const candidate = path.resolve(cwd, WORK_DIR_BASENAME);
  return candidate === path.resolve(resolved) ? null : candidate;
}
