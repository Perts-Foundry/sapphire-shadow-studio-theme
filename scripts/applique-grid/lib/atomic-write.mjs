// Write via a temp file in the SAME directory, then rename. A failure anywhere before the rename
// leaves the target untouched; a truncated patterns.json would break every other tool here. The fs
// calls are injectable so the mid-write failure is testable rather than assumed.
//
// Shared rather than per-tool: draft.mjs had this and lib/registry.mjs's save() did not, so the
// reversible local write was crash-safe while the one called immediately after a live Shopify
// media write was a plain writeFile. That is the wrong way round.

import { rename, writeFile } from 'node:fs/promises';

/**
 * @param {string} target - absolute path to write
 * @param {string} contents
 * @param {{writeFile?: Function, rename?: Function, suffix?: string | number}} [io]
 * @returns {Promise<void>}
 */
export async function atomicWrite(target, contents, io = {}) {
  const w = io.writeFile ?? writeFile;
  const r = io.rename ?? rename;
  const tmp = `${target}.tmp-${io.suffix ?? process.pid}`;
  await w(tmp, contents);
  await r(tmp, target);
}
