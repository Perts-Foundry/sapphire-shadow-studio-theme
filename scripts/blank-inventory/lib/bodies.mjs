// The garment body axis.
//
// WHY THIS EXISTS. A blank is a physical garment. Two products printed on the same body share stock;
// two products on different bodies do not. The original model keyed a blank on Color+Size alone,
// which silently assumed one body per colour+size. On a catalogue with a crewneck, a quarter-zip and
// a vest, that assumption put every product into one pool: a count sheet with three tables had
// exactly one group to write to, and stock had already been mirrored across garments that share no
// blank. Body is the missing dimension.
//
// WHY IT IS NOW DECLARED, NOT INFERRED. This module used to INFER a body per product from keyword
// matches on the handle and title, present the proposal at an operator gate, and seal the approved
// result in a hash-checked artifact under ~/.local/state/. Its own header argued that a committed map
// "needs a PR per new product" and that inference avoided that cost.
//
// THAT PREMISE WAS EMPIRICALLY FALSE, and the repo was the evidence. A new product already required a
// PR in six places (the SKU tables, the photo-naming product table, a size-chart profile's handle
// list, the applique registry, the a11y path list, a product template). Inference bought no
// PR-avoidance at all; what it bought was an authority living in an uncommitted local file, invisible
// to CI and to review, which is precisely why all six of those places grew a private copy of the same
// vocabulary. catalogue.json is now the ONE authority on a product's body, for existing and future
// products alike, and it must be updated for CI to pass.
//
// WHAT WAS LOST, EXACTLY: the operator gate. Body assignment was machine-proposed, re-presented for
// approval, and sealed against hand edits. There is now no re-presentation and no seal. What replaces
// it: the manifest changes only in a reviewed PR; the offline lint refuses inconsistency; seven
// consumers derive from it, so a wrong body appears in the same diff as a wrong size-chart binding
// and a wrong photo token; and the networked gate gained live title and GID checks. Genuinely weaker:
// the hash seal. A manifest edit is now a signed, reviewed, auditable event instead of a silent local
// file write. Full argument in release-notes.md.
//
// WHAT NOTHING CATCHES: a manifest that declares the WRONG body for a product that really exists.
// Nothing offline can know, and the live store carries no body field, which is the very observation
// that motivated inference in the first place. Mitigation is a diff, not a check.

import { garmentProducts } from '../../lib/catalogue-manifest.mjs';

/**
 * Index the manifest for body lookup.
 *
 * Non-garment products (`"body": null`, today the gift card) are excluded rather than assigned a
 * body: they are not garments and never join a blank group. That exclusion used to be inferred from
 * "has no tracked variants"; it is declared now.
 *
 * @param {{products: Map<string, {handle: string, body: string|null}>}} manifest
 * @returns {Map<string, string>} productHandle -> bodyId
 */
export function bodyIndex(manifest) {
  return new Map(garmentProducts(manifest).map((p) => [p.handle, p.body]));
}

/**
 * Resolve a variant's body, or refuse.
 *
 * A product absent from the manifest is NEVER guessed here. Read commands surface it as a warning and
 * continue; write paths call this and stop. That is what makes a newly added product loud instead of
 * silently absorbed into whichever pool its colour and size happen to match.
 *
 * @param {Map<string, string>} index
 * @param {{productHandle: string}} variant
 * @returns {string}
 */
export function bodyOf(index, variant) {
  const body = index.get(variant?.productHandle);
  if (!body) {
    throw new Error(
      `No declared body for product "${variant?.productHandle}". Declare it in catalogue.json, in a ` +
        `reviewed PR, and re-run. This tool never infers a body: the manifest is the only authority ` +
        `on which physical garment a product is printed on.`
    );
  }
  return body;
}

/**
 * Attach the declared body to each variant.
 *
 * A variant whose product is not in the manifest gets `body: null` rather than a guess. Read paths
 * report those; write paths refuse on them. Returns copies; the input is not mutated.
 *
 * @param {Map<string, string>|null} index
 * @param {object[]} variants
 * @returns {object[]}
 */
export function attachBodies(index, variants) {
  return variants.map((v) => ({ ...v, body: index?.get(v.productHandle) ?? null }));
}

/**
 * Products on the live store that the manifest does not cover.
 *
 * A declared non-garment (`"body": null`) is covered, not missing, so it must be passed in and
 * skipped. Excluding it via `bodyIndex` alone is not possible: that index holds garments only. The
 * exclusion used to fall out of "has no tracked variants", which held while the gift card was the
 * only non-garment; the tote is a declared non-garment that DOES track stock, so it fell through and
 * every write path refused on a manifest that was already correct. An UNDECLARED product still
 * lands here, which is the loudness this check exists for.
 *
 * @param {Map<string, string>} index
 * @param {object[]} variants
 * @param {Set<string>|null} declaredNonGarment product handles the manifest declares with no body
 * @returns {string[]} product handles
 */
export function unmappedHandles(index, variants, declaredNonGarment = null) {
  const seen = new Set();
  for (const v of variants) {
    if (v.tracked === false) continue;
    if (declaredNonGarment?.has(v.productHandle)) continue;
    if (!index.has(v.productHandle)) seen.add(v.productHandle);
  }
  return [...seen].sort();
}
