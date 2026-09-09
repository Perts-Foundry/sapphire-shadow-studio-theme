// The filesystem half of the state model: read, write, archive.
//
// Deliberately thin. Every decision lives in lib/state.mjs, which has no filesystem and no clock;
// this module only moves bytes, so a test can exercise the rules without a temp directory and a
// temp-directory test still exercises the real read-write round trip.
//
// Writes are write-then-rename, because a crash mid-write on a run record is worse than a crash
// before it: a truncated JSON file reads as "state lost", and the documented recovery for that is
// re-running every completion check from phase 0.

import fs from 'node:fs';
import path from 'node:path';

import { DIR_MODE, FILE_MODE, archiveDir, stateFilePath } from './workdir.mjs';
import { StateError, normaliseState } from './state.mjs';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
}

export function stateExists(dir, handle) {
  return fs.existsSync(stateFilePath(dir, handle));
}

/**
 * Read one handle's state.
 * @param {string} dir
 * @param {string} handle
 * @returns {{state: object, dropped: string[]}}
 */
export function readState(dir, handle) {
  const file = stateFilePath(dir, handle);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new StateError(handle, 'has no state file yet; run `state.mjs init` for it first');
    }
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StateError(`${handle}.json`, `is not parseable JSON (${err.message}); rebuild the run rather than hand-repairing it`);
  }
  return normaliseState(parsed, handle);
}

/**
 * Write one handle's state.
 * @param {string} dir
 * @param {object} state
 */
export function writeState(dir, state) {
  ensureDir(dir);
  const file = stateFilePath(dir, state.handle);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: FILE_MODE });
  fs.renameSync(tmp, file);
  return file;
}

/** Handles with a state file in this directory, sorted for a stable `show` with no --handle. */
export function listHandles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

/**
 * Move a closed run out of the working set.
 *
 * Archived rather than deleted: the run's evidence is the only record of which completion checks
 * actually passed, and a closed run is exactly the one someone re-opens a question about.
 *
 * @param {string} dir
 * @param {string} handle
 * @param {string} timestamp - ISO; ':' is not portable in a filename, so it is stripped
 * @returns {string} the archived path
 */
export function archiveState(dir, handle, timestamp) {
  const target = archiveDir(dir);
  ensureDir(target);
  const stamp = timestamp.replace(/[:.]/g, '-');
  const dest = path.join(target, `${handle}-${stamp}.json`);
  fs.renameSync(stateFilePath(dir, handle), dest);
  return dest;
}
