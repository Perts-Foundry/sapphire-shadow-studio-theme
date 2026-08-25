// The catalogue manifest: which garment bodies exist, and which colours and sizes each one is made
// in. Committed at the repo root as catalogue.json.
//
// WHY IT EXISTS. thresholds.json used to be two things fused into one file: inventory POLICY
// (minimums, budgets, provenance) and a de facto declaration of the catalogue's body x colour x size
// SHAPE. The shape was never stated anywhere; it was inferred as a full cross product of the approved
// bodies against the GLOBAL colour and size vocabulary learned from the store. On a catalogue where
// one body is made in fewer colours than another, that product invents cells no variant can ever
// fill, and once those cells carry a nonzero minimum they flag as `no-group` in every report,
// forever. This file states the shape instead of inferring it, and the policy file keeps the numbers.
//
// READ-ONLY BY CONSTRUCTION. Nothing here writes to the store or to any file, and nothing here may
// ever import lib/mutations.mjs (a unit test asserts the import list). The manifest itself is
// hand-edited in a reviewed PR; no command creates or edits it.
//
// WHAT IS SAFE TO COMMIT. Storefront option values (the colour and size names any visitor sees on a
// product page) and generic body ids. Never a blank id, a supplier name, a style number, a case pack,
// a cost, or any policy number: those belong to thresholds.json or nowhere.
//
// BODY-MAP FRESHNESS IS A NON-ISSUE BY CONSTRUCTION. The approved body-map artifact is loaded fresh
// on every command invocation, so a manifest/body-map disagreement seen at reconcile time is always
// real drift and never a stale read. That is why both directions of that disagreement refuse rather
// than warn.

import { normaliseAxis, vocabKey } from './groups.mjs';
import { findDuplicateKeys } from './reorder.mjs';

/** The one schema version this tool understands. A future shape means a bump plus a transform. */
export const CATALOGUE_VERSION = 1;

/** Where the committed manifest lives, relative to the repo root. */
export const CATALOGUE_PATH = 'catalogue.json';

/** Everything a manifest document may carry at the top level. Anything else refuses. */
const TOP_LEVEL_KEYS = ['version', 'comment', 'bodies'];

/** Everything one body entry may carry. Anything else refuses. */
const BODY_KEYS = ['colors', 'sizes'];

const cmpString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Render a list of PR-authored key names for an error message, each JSON-quoted.
 *
 * The quoting is not cosmetic. These messages carry key names straight out of the manifest, and CI
 * captures them into `$GITHUB_OUTPUT` under a heredoc. A key containing a real newline could
 * otherwise close that heredoc early and forge a later `exit_code=0` line, turning a refused lint
 * into a green check. JSON.stringify escapes the newline, so the name cannot span lines at all.
 * The workflow uses a random delimiter as well; this is the half that closes the class.
 *
 * @param {string[]} names
 * @returns {string}
 */
function nameList(names) {
  return names.map((n) => JSON.stringify(n)).join(', ');
}

/**
 * A value is valid only if it is ALREADY in normalised vocab form. Rejected, never normalised: two
 * spellings of one colour would silently become two cells for one physical blank, which is the same
 * failure `parseThresholds` refuses on its keys.
 *
 * @param {unknown} value
 * @param {string} axis - 'Body' | 'Color' | 'Size'
 * @param {string} where - for the message
 * @returns {string}
 */
function assertNormalised(value, axis, where) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${where} must be a non-empty string, got ${JSON.stringify(value)}.`);
  }
  const renormalised = normaliseAxis(value, axis);
  if (renormalised !== value) {
    throw new Error(
      `${where} ${JSON.stringify(value)} is not in normalised form. Expected ` +
        `${JSON.stringify(renormalised)}. Values are rejected rather than normalised here: two ` +
        `spellings of one value would silently become two cells for one physical blank.`
    );
  }
  return value;
}

/**
 * One body's colour or size list.
 *
 * Uniqueness is checked HERE and not by findDuplicateKeys, which walks object keys and knows nothing
 * about array values: `["black", "black"]` is valid JSON with no duplicate key in it, and it would
 * otherwise produce the same cell twice.
 *
 * @param {unknown} values
 * @param {string} axis - 'Color' | 'Size'
 * @param {string} where
 * @returns {string[]}
 */
function parseAxisList(values, axis, where) {
  if (!Array.isArray(values)) {
    throw new Error(`${where} must be an array of normalised ${axis.toLowerCase()} values.`);
  }
  if (!values.length) {
    throw new Error(
      `${where} is empty. A body with no ${axis.toLowerCase()}s is a body that no longer exists; ` +
        `remove it from the manifest rather than emptying its list.`
    );
  }
  const out = [];
  for (const value of values) {
    assertNormalised(value, axis, `${where} entry`);
    if (out.includes(value)) {
      throw new Error(
        `${where} lists ${JSON.stringify(value)} twice. JSON has no duplicate-key check for array ` +
          `values, so this would silently produce one cell twice.`
      );
    }
    out.push(value);
  }
  return out;
}

/**
 * Parse and validate the manifest from its raw text.
 *
 * Raw text in, not an object, for the same reason `parseThresholds` takes text: the duplicate-key
 * check can only be done on the text, and doing it anywhere else means a caller can skip it.
 *
 * Declaration ORDER of `colors` and `sizes` is preserved into the returned Map. It is load-bearing:
 * it becomes the colour row order of the reorder matrix.
 *
 * @param {string} text
 * @returns {{version: number, bodies: Map<string, {colors: string[], sizes: string[]}>, raw: object}}
 */
export function parseCatalogue(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${CATALOGUE_PATH} is not valid JSON: ${err.message}. Fix the file by hand (it is committed at ` +
        `the repo root and reviewed in a PR); no command creates or edits it.`
    );
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${CATALOGUE_PATH} must contain a JSON object.`);
  }

  const dups = findDuplicateKeys(text);
  if (dups.length) {
    throw new Error(
      `${CATALOGUE_PATH} has duplicate key(s): ${nameList(dups.map((d) => d.path))}. JSON.parse ` +
        `takes the last one silently, so a bad merge would declare a range nobody reviewed.`
    );
  }

  const unknownTop = Object.keys(doc).filter((k) => !TOP_LEVEL_KEYS.includes(k));
  if (unknownTop.length) {
    throw new Error(
      `${CATALOGUE_PATH} has unknown top-level key(s): ${nameList(unknownTop)}. This file declares ` +
        `the catalogue's shape and nothing else; policy numbers live in thresholds.json.`
    );
  }

  if (doc.version !== CATALOGUE_VERSION) {
    throw new Error(
      `${CATALOGUE_PATH} declares version ${JSON.stringify(doc.version)}; this tool understands ` +
        `${CATALOGUE_VERSION} only. A new shape needs a version bump plus a transform committed together.`
    );
  }

  if (doc.comment !== undefined && typeof doc.comment !== 'string') {
    throw new Error(`${CATALOGUE_PATH} "comment" must be a string.`);
  }

  const rawBodies = doc.bodies;
  if (!rawBodies || typeof rawBodies !== 'object' || Array.isArray(rawBodies)) {
    throw new Error(
      `${CATALOGUE_PATH} needs a "bodies" object keyed by garment body id. Without it there is no ` +
        `declared shape at all, and the reorder review would have nothing to build its cells from.`
    );
  }

  const bodies = new Map();
  for (const [bodyId, entry] of Object.entries(rawBodies)) {
    assertNormalised(bodyId, 'Body', `${CATALOGUE_PATH} body id`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Body ${JSON.stringify(bodyId)} must be an object with "colors" and "sizes".`);
    }
    const unknown = Object.keys(entry).filter((k) => !BODY_KEYS.includes(k));
    if (unknown.length) {
      throw new Error(
        `Body ${JSON.stringify(bodyId)} has unknown key(s): ${nameList(unknown)}. A body declares ` +
          `its colours and its sizes and nothing else; an unrecognised key is refused rather than ` +
          `ignored, so a typo cannot look like a setting that took effect.`
      );
    }
    bodies.set(bodyId, {
      colors: parseAxisList(entry.colors, 'Color', `Body ${JSON.stringify(bodyId)} "colors"`),
      sizes: parseAxisList(entry.sizes, 'Size', `Body ${JSON.stringify(bodyId)} "sizes"`),
    });
  }

  return { version: doc.version, bodies, raw: doc };
}

/**
 * Read and parse the committed manifest.
 *
 * The reader is injected so the whole path is testable without a filesystem, and so the refusal
 * messages are asserted rather than assumed. A missing file is a refusal carrying `fileMissing`, not
 * an empty default: an empty manifest would silently narrow the reorder review to nothing, which is
 * the fail-open shape this whole loud-refusal contract exists to prevent.
 *
 * @param {object} params
 * @param {(path: string) => Promise<string>} params.read
 * @param {string} [params.path]
 * @returns {Promise<{version: number, bodies: Map<string, {colors: string[], sizes: string[]}>, raw: object}>}
 */
export async function loadCatalogue({ read, path = CATALOGUE_PATH }) {
  let text;
  try {
    text = await read(path);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const e = new Error(
        `No catalogue manifest at ${path}. It is committed at the repo root and hand-edited in a ` +
          `reviewed PR; no command creates or edits it. It declares which colours and sizes each ` +
          `garment body is made in, and the reorder review cannot build its cells without it.`
      );
      e.fileMissing = true;
      throw e;
    }
    throw err;
  }
  return parseCatalogue(text);
}

/**
 * Compare the declared shape against the approved body map and against the live store.
 *
 * Pure: nothing here reads a file, touches the network, or edits the manifest.
 *
 * Three kinds of divergence, and the WARN/REFUSE split is the whole design:
 *
 *   - The manifest and the approved body map must agree EXACTLY on the set of bodies, both
 *     directions. The body map stays the authority on product-to-body identity; the manifest is the
 *     authority on each body's range. Neither can be right about a body the other has never heard of.
 *   - A declared colour or size the store has not shown yet is a WARNING. Declaring a colour before
 *     the first variant exists is the point of declaring it at all.
 *   - A live TAGGED variant whose body+colour+size falls outside the manifest is a REFUSAL. This is
 *     the check the cross product used to provide by accident: with the shape declared, an
 *     undeclared combination is loud by declaration instead. Untagged variants are out of scope for
 *     the same reason they are out of scope for `learnVocab`: nothing untagged is in a blank group,
 *     so nothing untagged is part of the stock picture this review reports on.
 *
 * @param {object} params
 * @param {{bodies: Map<string, {colors: string[], sizes: string[]}>}} params.manifest
 * @param {string[]} params.bodyMapBodies - body ids from the approved body-map artifact
 * @param {{colors?: string[], sizes?: string[]}} [params.vocab] - the learned store vocabulary
 * @param {object[]} [params.variants] - post-attachBodies variants
 * @returns {{unknownBodies: string[], unmappedBodies: string[], unknownColors: string[], unknownSizes: string[], undeclaredVariants: Array<{key: string, count: number}>}}
 */
export function reconcileCatalogue({ manifest, bodyMapBodies = [], vocab = {}, variants = [] }) {
  const declared = manifest?.bodies ?? new Map();
  const mapped = new Set((bodyMapBodies ?? []).filter(Boolean).map((b) => normaliseAxis(b, 'Body')));

  const unknownBodies = [...declared.keys()].filter((b) => !mapped.has(b)).sort(cmpString);
  const unmappedBodies = [...mapped].filter((b) => !declared.has(b)).sort(cmpString);

  const declaredColors = new Set();
  const declaredSizes = new Set();
  for (const range of declared.values()) {
    for (const c of range.colors) declaredColors.add(c);
    for (const s of range.sizes) declaredSizes.add(s);
  }
  const seenColors = new Set((vocab.colors ?? []).map((c) => normaliseAxis(c, 'Color')));
  const seenSizes = new Set((vocab.sizes ?? []).map((s) => normaliseAxis(s, 'Size')));
  const unknownColors = [...declaredColors].filter((c) => !seenColors.has(c)).sort(cmpString);
  const unknownSizes = [...declaredSizes].filter((s) => !seenSizes.has(s)).sort(cmpString);

  /** @type {Map<string, number>} */
  const undeclared = new Map();
  for (const v of variants ?? []) {
    if (!v?.blankId || !v.body || !v.color || !v.size) continue;
    const key = vocabKey(v);
    const [body, color, size] = key.split('|');
    const range = declared.get(body);
    if (range && range.colors.includes(color) && range.sizes.includes(size)) continue;
    undeclared.set(key, (undeclared.get(key) ?? 0) + 1);
  }
  const undeclaredVariants = [...undeclared.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => cmpString(a.key, b.key));

  return { unknownBodies, unmappedBodies, unknownColors, unknownSizes, undeclaredVariants };
}

/**
 * The loud-failure contract for the manifest, as data.
 *
 * Same shape as `assessThresholds` so the command layer prints both through one refusal path and a
 * `--json` consumer sees one object shape whichever gate stopped the run.
 *
 * @param {object} params
 * @param {string[]} [params.unknownBodies]
 * @param {string[]} [params.unmappedBodies]
 * @param {string[]} [params.unknownColors]
 * @param {string[]} [params.unknownSizes]
 * @param {Array<{key: string, count: number}>} [params.undeclaredVariants]
 * @param {boolean} [params.fileMissing]
 * @param {string} [params.invalid] - a parse or schema failure message from parseCatalogue
 * @returns {{exitCode: number, refusals: Array<{code: string, message: string, keys: string[]}>, warnings: Array<{code: string, message: string, keys: string[]}>}}
 */
export function assessCatalogue({
  unknownBodies = [],
  unmappedBodies = [],
  unknownColors = [],
  unknownSizes = [],
  undeclaredVariants = [],
  fileMissing = false,
  invalid = null,
} = {}) {
  const refusals = [];
  const warnings = [];

  if (invalid) {
    // Carried here rather than printed by the command layer so a malformed manifest produces the
    // same refusal object shape as every other gate failure.
    refusals.push({ code: 'catalogue-invalid', keys: [], message: invalid });
  }

  if (fileMissing) {
    refusals.push({
      code: 'catalogue-missing',
      keys: [],
      message:
        `No catalogue manifest at ${CATALOGUE_PATH}. It declares which colours and sizes each ` +
        `garment body is made in, and without it there is no cell space to compare on-hand stock ` +
        `against. It is hand-edited in a reviewed PR; no command creates it.`,
    });
  }

  if (unknownBodies.length) {
    refusals.push({
      code: 'catalogue-unknown-bodies',
      keys: unknownBodies,
      message:
        `${unknownBodies.length} body/bodies in ${CATALOGUE_PATH} are not in the approved body map: ` +
        `${unknownBodies.join(', ')}. The body map is the authority on which physical garments ` +
        `exist, so a body declared here and unknown there is a manifest that describes a catalogue ` +
        `nobody approved. Re-run "bodies --stage propose", or correct the manifest in a reviewed PR.`,
    });
  }

  if (unmappedBodies.length) {
    refusals.push({
      code: 'catalogue-unmapped-bodies',
      keys: unmappedBodies,
      message:
        `${unmappedBodies.length} approved body/bodies are missing from ${CATALOGUE_PATH}: ` +
        `${unmappedBodies.join(', ')}. Every approved body needs a declared colour and size range, ` +
        `or its cells would silently vanish from the reorder review. Declare it in a reviewed PR; ` +
        `do not delete it from the body map to quieten this.`,
    });
  }

  if (undeclaredVariants.length) {
    refusals.push({
      code: 'catalogue-undeclared-variants',
      keys: undeclaredVariants.map((u) => u.key),
      message:
        `${undeclaredVariants.length} live combination(s) are tagged into a blank group but are not ` +
        `declared in ${CATALOGUE_PATH}: ` +
        `${undeclaredVariants.map((u) => `${u.key} (${u.count} variant(s))`).join(', ')}. Stock ` +
        `exists that the declared shape has no cell for, so the report would omit it silently. ` +
        `Report these keys to the operator and stop. Only the operator declares the missing colour ` +
        `or size, in a reviewed PR: never edit ${CATALOGUE_PATH} yourself to clear this, never ` +
        `relax or bypass the check, and never untag a variant to make it pass.`,
    });
  }

  if (unknownColors.length) {
    warnings.push({
      code: 'catalogue-unseen-colors',
      keys: unknownColors,
      message:
        `${unknownColors.length} declared colour(s) have no tagged variant on the store yet: ` +
        `${unknownColors.join(', ')}. That is expected for a colour declared ahead of its first ` +
        `blank; their cells exist and will report as having no group until one does.`,
    });
  }

  if (unknownSizes.length) {
    warnings.push({
      code: 'catalogue-unseen-sizes',
      keys: unknownSizes,
      message:
        `${unknownSizes.length} declared size(s) have no tagged variant on the store yet: ` +
        `${unknownSizes.join(', ')}.`,
    });
  }

  return { exitCode: refusals.length ? 1 : 0, refusals, warnings };
}
