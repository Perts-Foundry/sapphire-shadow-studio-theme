// Where plan artifacts and receipts live.
//
// Outside the repository by default, mirroring scripts/blank-inventory/lib/workdir.mjs. SKUs are
// public information, so this is not a data-sensitivity call: it is that a public repo should have
// exactly one convention for tool state. A second, "this kind is safe to commit" class is how an
// artifact eventually gets committed by a `git add -A` from the wrong directory, and then the next
// tool's artifacts follow it in.
//
// The path is resolved from the environment only, never from cwd, so the same command finds the
// same artifacts whichever directory it is run from. That cwd-relative bug is the one
// blank-inventory actually shipped and had to fix.

import os from 'node:os';
import path from 'node:path';

/**
 * The default working directory: an XDG state path outside any checkout.
 *
 * Honours XDG_STATE_HOME per the XDG Base Directory spec.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} absolute path
 */
export function defaultWorkDir(env = process.env) {
  const stateHome = env.XDG_STATE_HOME?.trim();
  const base = stateHome && path.isAbsolute(stateHome) ? stateHome : path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'sku-tool');
}

/**
 * Resolve the working directory for this run. SKU_WORK_DIR overrides and is made absolute.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} absolute path
 */
export function resolveWorkDir(env = process.env) {
  const override = env.SKU_WORK_DIR?.trim();
  if (override) return path.resolve(override);
  return defaultWorkDir(env);
}
