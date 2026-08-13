// The containment rule for every `--out-dir` in this module. It was duplicated in four entry
// points as a module-private const consumed inside main(), which made it unreachable from a test:
// deleting the check outright left the whole suite green. One exported pure function instead, so
// the rule has exactly one definition and one set of cases.
//
// The boundary is a whole path SEGMENT. `/x/product-images-backup` must be refused; only
// `product-images` itself, or a directory under it, may be written to.

import path from 'node:path';

export const OUT_DIR_RE = /(^|[\\/])product-images([\\/]|$)/;

/**
 * Why a resolved --out-dir may not be written to, or null when it may.
 * @param {string} resolved - an ALREADY absolute path (path.resolve applied by the caller)
 * @returns {string | null}
 */
export function outDirProblem(resolved) {
  const value = String(resolved ?? '');
  if (!value) return "--out-dir is empty; it must be under a 'product-images/' directory";
  if (!path.isAbsolute(value)) return `--out-dir must be resolved to an absolute path first (got ${value})`;
  if (!OUT_DIR_RE.test(value)) {
    return `--out-dir must be under a 'product-images/' directory (got ${value}); refusing to write elsewhere.`;
  }
  return null;
}
