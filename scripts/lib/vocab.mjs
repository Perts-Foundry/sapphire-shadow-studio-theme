// The option-value vocabulary primitives: the key separator, and the one normalisation rule every
// axis shares.
//
// WHY THIS IS A LEAF. These two things started life inside scripts/blank-inventory/lib/groups.mjs,
// which imports planner.mjs, which imports input.mjs. Once the catalogue manifest became the repo's
// single source of truth, seven unrelated areas (sku, photo naming, size charts, applique grids, the
// a11y path list, the SEO review and the manifest lint itself) needed `normaliseAxis` and would have
// picked up a load-time dependency on the blank-inventory planner to get it, one module away from
// lib/mutations.mjs. This file imports nothing at all, and must stay that way.
//
// groups.mjs re-exports both names, permanently and deliberately, so its own callers are unaffected.

/**
 * The vocabulary key separator. A token containing it is refused rather than escaped: two axes
 * bleeding into one key resolves the wrong blank id, and a silent collision here moves real stock.
 */
export const SEP = '|';

/**
 * Normalise one axis value for keying.
 *
 * All three axes get the SAME rules, which is the point: body was added last and must not acquire
 * its own casing or whitespace behaviour. Normalisation can only MERGE keys, never split them, and a
 * merged key holding two different blank ids surfaces as a conflict (refused) rather than as a
 * silent pick. That is the safe direction.
 *
 * @param {string|null|undefined} value
 * @param {string} axis - for the error message
 * @returns {string}
 */
export function normaliseAxis(value, axis) {
  const raw = String(value ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
  if (raw.includes(SEP)) {
    throw new Error(
      `${axis} value ${JSON.stringify(raw)} contains the key separator "${SEP}". This tool refuses ` +
        `to escape it: a key collision between two axes would resolve a variant to the wrong blank ` +
        `and move stock on the wrong garment. Rename the option value in Admin.`
    );
  }
  return raw.toLowerCase();
}
