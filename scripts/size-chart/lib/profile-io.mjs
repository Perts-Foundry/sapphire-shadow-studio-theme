// Shared profile loader for both CLIs (render-size-chart.mjs, apply-size-chart.mjs). Resolves a
// `--profile` argument (a blank_id under profiles/, or a path to a .json), parses it, MATERIALISES
// the fields catalogue.json owns, and validates the result before returning. Kept in one place so
// the two entrypoints cannot drift.
//
// WHAT MATERIALISATION MEANS HERE. A committed profile used to restate two things the manifest
// already declares: the blank's size range, and the list of theme templates its chart is applied to.
// Both were literal arrays that nothing reconciled, and both are now derived from the profile's
// `body`. Everything downstream of `loadProfile` still receives `sizes` and `handles` exactly as
// before, so the renderer, the applier and the schema are untouched by this.
//
// `handles` derives from each product's TEMPLATE, not from its handle. That is deliberate and is
// what keeps README's description of the field accurate: these are alternate-template suffixes
// interpolated into templates/product.<suffix>.json, and the gift card is the standing proof that a
// template suffix and a product handle are not the same string.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProfile } from './profile-schema.mjs';
import {
  loadCommittedCatalogue,
  productsOnBody,
  sizeValuesFor,
  CATALOGUE_PATH,
} from '../../lib/catalogue-manifest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROFILES_DIR = path.join(HERE, '..', 'profiles');

/**
 * Fill in the fields catalogue.json owns, from the profile's declared `body`.
 *
 * Pure: it takes the manifest rather than reading one, so every test drives it with a hand-authored
 * catalogue. A profile that still carries `sizes` or `handles` is REFUSED rather than having its
 * copy silently overwritten: a stale literal that quietly stops being read is the failure this
 * migration removes, and a loud refusal is the only way the author finds out the file is wrong.
 *
 * @param {object} raw - the parsed profile as committed
 * @param {object} manifest
 * @returns {object} the resolved profile
 */
export function materialiseProfile(raw, manifest) {
  for (const field of ['sizes', 'handles']) {
    if (raw[field] !== undefined) {
      throw new Error(
        `Profile '${raw.blank_id}' carries "${field}", which is derived from ${CATALOGUE_PATH} now. ` +
          `Delete it from the profile and let the manifest state it: a second copy here is what let ` +
          `a size range and a template list drift apart from the catalogue with nothing noticing.`
      );
    }
  }
  if (!raw.body || !manifest.bodies.has(raw.body)) {
    throw new Error(
      `Profile '${raw.blank_id}' declares body ${JSON.stringify(raw.body ?? null)}, which ` +
        `${CATALOGUE_PATH} does not. Declared bodies: ${[...manifest.bodies.keys()].join(', ')}. The ` +
        `body is what the size range and the template list are read from, so an unknown one has no ` +
        `safe default.`
    );
  }
  const products = productsOnBody(manifest, raw.body);
  if (!products.length) {
    throw new Error(
      `Profile '${raw.blank_id}' declares body "${raw.body}", which ${CATALOGUE_PATH} declares but no ` +
        `product is cut from. There is nothing to size and nothing to apply the chart to.`
    );
  }
  return {
    ...raw,
    // Every product on a body sells that body's sizes, so any one of them answers for the body.
    sizes: sizeValuesFor(manifest, products[0].handle),
    handles: products.map((p) => p.template),
  };
}

/**
 * Resolve, parse, materialise and validate a profile.
 *
 * @param {string} ref - a blank_id under profiles/, or a path to a .json
 * @param {object} [params]
 * @param {object} [params.manifest] - injected in tests; the committed manifest otherwise
 * @returns {Promise<object>}
 */
export async function loadProfile(ref, { manifest = null } = {}) {
  const p = ref.endsWith('.json') ? path.resolve(ref) : path.join(PROFILES_DIR, `${ref}.json`);
  let json;
  try {
    json = JSON.parse(await readFile(p, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read profile '${ref}' (${p}): ${e.message}`);
  }
  const resolved = manifest ?? (await loadCommittedCatalogue());
  const profile = materialiseProfile(json, resolved);
  validateProfile(profile);
  return profile;
}
