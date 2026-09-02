// Canonical naming convention for Sapphire Shadow Studio product photos, plus the
// product / colour mappings the upload pipeline needs. Pure: no side effects and no I/O below
// `defaultNaming`, so both process-product-images.mjs (naming + output) and
// upload-product-media.mjs (resolution) read one source of truth.
//
// Convention:
//   <line>_<garment>_<colorway>[_<design>]_<shot>-<index>.jpg
//   group shot:  <line>_<garment>_group_<shot>-<index>.jpg   (no colorway, no design)
//   non-garment: <handle>_<shot>-<index>.jpg                  (a body-null product; no colour)
//
// A non-garment product (catalogue.json `body: null`, the tote and the gift card) has no line,
// garment or colour axis, so its filename carries the product handle itself and nothing else. Its
// census key is the handle (a key with no '/' can never collide with a '<line>/<garment>' key), its
// colour vocabulary is empty, and every alt on it is colour-free by construction: the guard runs
// with expected=null against an empty value list, so it only ever rejects nothing.
//
// Fields are underscore-separated. A multi-word field value hyphenates internally
// (crew-sweater, classic-navy). The shot carries a -<index> suffix (flat-1). ONE scheme runs end
// to end: the canonical name (processed output, uploaded Shopify filename, and --rename-originals
// target) is the parsed fields re-joined by '_', e.g. LEAD2 quarter-zip black emt flat-1 stays
// lead2_quarter-zip_black_emt_flat-1.jpg. Underscores keep the field boundaries explicit and the
// name trivially re-parseable; the internal hyphens of a multi-word field are preserved.
//
// line / garment / colorway / shot are closed sets (an unknown token warns). design is an
// open kebab token (any profession/design; never warns on content).
//
// THE VOCABULARY COMES FROM catalogue.json. Lines, the product census with every title, GID and
// colour list, and the colour tokens themselves were all restated here as literals; they are the
// manifest's to state, and the copies drifted (this module spelled the three garment bodies
// `crew-sweater`/`quarter-zip`/`vest` while the manifest spelled them
// `crewneck`/`quarter-zip`/`vest-womens`, with nothing reconciling the two). `createNaming(manifest)`
// builds the whole vocabulary from a manifest and is what the tests drive; every export below is a
// thin delegate over `defaultNaming()`, which reads the committed file once.
//
// The one thing that is NOT derived is BODY_PHOTO_TOKEN, the body id -> filename token map. A photo
// filename is a public-ish artifact typed by hand and already printed on hundreds of files, so its
// tokens cannot follow a manifest rename; they are their own vocabulary. A cohesion test asserts the
// map covers every declared body and names no body that is not declared, in both directions, which
// is what stops it going stale silently.

import {
  parseCatalogue,
  readCommittedCatalogue,
  garmentProducts,
  nonGarmentProducts,
  colorValuesFor,
  colorDisplay,
  colorSlug,
  linesOf,
} from './catalogue-manifest.mjs';

export const SHOTS = ['angled', 'closeup', 'flat', 'styled'];

/** The group-shot marker. Not a colour: it occupies the colorway slot and binds to nothing. */
export const GROUP_MARKER = 'group';

/**
 * Garment body id (catalogue.json) -> the token that appears in a photo filename.
 *
 * Hand-authored on purpose, and checked in both directions by photo-naming.test.mjs against the
 * committed manifest. Renaming a body in the manifest must NOT silently rename the filename token:
 * every already-shot file on disk and every already-uploaded Shopify filename carries the old one.
 */
const BODY_PHOTO_TOKEN = new Map([
  ['crewneck', 'crew-sweater'],
  ['quarter-zip', 'quarter-zip'],
  ['vest-womens', 'vest'],
]);

// Known field-value typos we silently repair (kebab, per field). Extend as real ones surface.
const FIELD_TYPOS = new Map([
  ['quarterzip', 'quarter-zip'], // garment written without the internal hyphen
]);

/** @param {string} bodyId @returns {string} the filename token for a declared body */
export function bodyPhotoToken(bodyId) {
  const token = BODY_PHOTO_TOKEN.get(bodyId);
  if (!token) {
    throw new Error(
      `No photo filename token for body ${JSON.stringify(bodyId)}. Add it to BODY_PHOTO_TOKEN in ` +
        `scripts/lib/photo-naming.mjs: filename tokens are their own vocabulary and cannot be ` +
        `derived from a body id, because renaming one would orphan every file already shot.`
    );
  }
  return token;
}

/** The body ids BODY_PHOTO_TOKEN covers, for the both-directions cohesion test. */
export function photoTokenBodies() {
  return [...BODY_PHOTO_TOKEN.keys()];
}

/**
 * Build the whole naming vocabulary from a manifest.
 *
 * Pure: it reads nothing and caches nothing. Every test drives this with a hand-authored manifest,
 * so no assertion here is a statement about today's catalogue.
 *
 * @param {ReturnType<typeof parseCatalogue>} manifest
 * @returns {object} the vocabulary and the lookups over it
 */
export function createNaming(manifest) {
  const lines = linesOf(manifest);

  const products = {};
  for (const product of garmentProducts(manifest)) {
    const garment = bodyPhotoToken(product.body);
    const key = `${product.line}/${garment}`;
    if (products[key]) {
      throw new Error(
        `Products ${JSON.stringify(products[key].handle)} and ${JSON.stringify(product.handle)} both ` +
          `resolve to photo census key "${key}". A photo filename carries only line and garment, so ` +
          `two products sharing both cannot be told apart; the second would silently overwrite the ` +
          `first and every one of its photos would upload to the wrong product.`
      );
    }
    products[key] = {
      line: product.line,
      garment,
      title: product.title,
      handle: product.handle,
      gid: product.gid,
      colorValues: colorValuesFor(manifest, product.handle),
    };
  }

  // Non-garment products: keyed by handle, no line/garment/colour. A handle never contains '/', so
  // this key space cannot collide with the '<line>/<garment>' keys above.
  const nonGarments = [];
  for (const product of nonGarmentProducts(manifest)) {
    products[product.handle] = {
      line: null,
      garment: null,
      title: product.title,
      handle: product.handle,
      gid: product.gid,
      colorValues: [],
    };
    nonGarments.push(product.handle);
  }

  const garments = [];
  for (const p of Object.values(products)) {
    if (p.garment !== null && !garments.includes(p.garment)) garments.push(p.garment);
  }

  // Colorway token -> the Admin Color option value the storefront gallery filter matches alt text
  // against. The token is the manifest's own colour slug, so the third casing of every colour is
  // gone. `group` maps to null: no value means shared across every colour.
  const colorwayToAdmin = new Map();
  for (const id of manifest.colors.keys()) colorwayToAdmin.set(colorSlug(manifest, id), colorDisplay(manifest, id));
  colorwayToAdmin.set(GROUP_MARKER, null);

  const colorways = [...colorwayToAdmin.keys()];

  // Bound once: recognizedColorValues and the alt guard must consult the same list.
  const valuesFor = (productKey) => (products[productKey] ? [...products[productKey].colorValues] : []);

  // Multi-word vocab tokens, longest first, used only by the hyphen-fallback parser to repair
  // all-hyphen source names (where the field separators were typed as '-' instead of '_').
  const multiword = [...new Set([...lines, ...garments, ...colorways, ...nonGarments].filter((t) => t.includes('-')))].sort(
    (a, b) => b.length - a.length || a.localeCompare(b)
  );

  const vocab = { lines, garments, colorways, nonGarments, multiword };

  return {
    LINES: lines,
    GARMENTS: garments,
    COLORWAYS: colorways,
    NON_GARMENTS: nonGarments,
    SHOTS,
    PRODUCTS: products,
    MULTIWORD_TOKENS: multiword,
    colorwayToAdminValue: (colorway, productKey) => resolveColorway(products, colorwayToAdmin, colorway, productKey),
    productForLineGarment: (line, garment) => products[`${line}/${garment}`] || null,
    productForHandle: (handle) => findByHandle(products, handle),
    recognizedColorValues: valuesFor,
    altColorProblem: (alt, expected, productKey) => checkAltColor(alt, expected, productKey, valuesFor),
    parseName: (filename) => parseWithVocab(filename, vocab),
    normalizeName: (filename) => normalizeWithVocab(filename, vocab),
  };
}

/**
 * The vocabulary built from the committed catalogue.json, read once.
 *
 * This is the ONLY I/O in the module, and it is synchronous on purpose: every export below it is a
 * plain function that callers already use synchronously. A missing manifest is a broken checkout,
 * not a workflow state, so it throws rather than falling back to an empty census, which would read
 * as "this product is not recorded" on every guard that consults it.
 */
let cached = null;
export function defaultNaming() {
  if (!cached) cached = createNaming(readCommittedCatalogue());
  return cached;
}

// --- lookups -----------------------------------------------------------------------------
//
// Each takes its census explicitly so `createNaming` can bind a hand-authored one; the exported
// delegates at the bottom of the file bind the committed manifest's.

// The Admin Color value for a colorway token, or null for group/shared. Pass a productKey to
// honour a per-product divergence (a value not reserved on that product resolves to null, so
// the photo is treated as shared there rather than bound to a colour the product does not sell).
function resolveColorway(products, colorwayToAdmin, colorway, productKey) {
  const value = colorwayToAdmin.has(colorway) ? colorwayToAdmin.get(colorway) : null;
  if (value === null) return null;
  if (productKey && products[productKey] && !products[productKey].colorValues.includes(value)) {
    return null;
  }
  return value;
}

// Reverse lookup: the product entry for an Admin handle, as { key, record }, or null when no
// recorded product uses that handle. The uploader resolves manifest rows by handle, and the
// shared-asset alt guard needs the product key back from a row that carries only the handle.
function findByHandle(products, handle) {
  const found = Object.entries(products).find(([, p]) => p.handle === handle);
  return found ? { key: found[0], record: found[1] } : null;
}

// Separator characters the storefront gallery filter normalizes to a space on BOTH sides of the
// comparison (snippets/product-media-gallery-content.liquid), per docs/product-media-alt-text.md:
// - _ , . / ( ) : ; and the apostrophe. Any OTHER punctuation touching the value breaks the
// binding, so this list is deliberately exhaustive. Deliberately NOT extended to other whitespace:
// the theme replaces these nine characters and nothing else, so a non-breaking space or a tab
// between two words does NOT bind on the storefront. Treating them as separators here would pass
// an alt the storefront reads as naming no colour at all, which silently shares that photo across
// every colour. Leaving them alone keeps the guard in parity and fails in the safe direction.
const SEP_CHARS = new Set([...`-_,./():;'`]);

/**
 * Normalize one side of the colour comparison exactly the way the theme does: lowercase, then
 * each separator character becomes exactly ONE space (Liquid `replace`, which never collapses
 * doubles), then trim, then pad with single spaces. The padding turns whole-word / whole-phrase
 * matching into a plain substring test: ' grey heather ' is found inside ' a grey heather crew '
 * but not inside ' grey  heather ' (a doubled separator breaks a multi-word phrase, on the
 * storefront and here alike).
 */
function normalizeForColorMatch(s) {
  let out = '';
  for (const ch of String(s).toLowerCase()) {
    out += SEP_CHARS.has(ch) ? ' ' : ch;
  }
  return ` ${out.trim()} `;
}

/**
 * The Admin Color values (from `values`) that an alt string binds to, under the exact match the
 * theme's gallery filter applies: whole-word / whole-phrase, case-insensitive, separator-aware,
 * including the shadow rule (a matched value whose padded form is contained in another matched
 * value's padded form is suppressed, the way a photo tagged "light blue" does not show under a
 * selected "Blue" when "Light Blue" is also a value). Values are returned in `values` order.
 * A doubled separator breaks a multi-word match: 'Classic, Navy' normalizes to a doubled space
 * and no longer contains ' classic navy '. There is no executable Liquid oracle for this parity,
 * so the contract table below is copied verbatim from the table-driven test in
 * photo-naming.test.mjs; keep the two in lockstep.
 *
 *   alt input                | values                              | result
 *   'Black crewneck, flat'   | [Black, Grey Heather, Classic Navy] | [Black]
 *   'Grey-Heather crewneck'  | [Black, Grey Heather, Classic Navy] | [Grey Heather]
 *   'Grey/Heather crewneck'  | [Black, Grey Heather, Classic Navy] | [Grey Heather]
 *   'grey_heather flat'      | [Black, Grey Heather, Classic Navy] | [Grey Heather]
 *   'Grey  Heather crewneck' | [Black, Grey Heather, Classic Navy] | []
 *   'Classic, Navy crewneck' | [Black, Grey Heather, Classic Navy] | []
 *   'Navy crewneck'          | [Black, Grey Heather, Classic Navy] | []
 *   'Grey\u00a0Heather crew' | [Black, Grey Heather, Classic Navy] | []   (NBSP is not a separator)
 *   'Grey\tHeather crewneck' | [Black, Grey Heather, Classic Navy] | []   (nor is a tab)
 *   'light blue flat'        | [Blue, Light Blue]                  | [Light Blue]
 *   'Blackout hoodie'        | [Black]                             | []
 */
export function matchedColorValues(alt, values) {
  if (!alt) return [];
  const paddedAlt = normalizeForColorMatch(alt);
  const padded = new Map();
  for (const value of values) {
    const p = normalizeForColorMatch(value);
    // A blank value can never match: its padded form is pure whitespace and would spuriously
    // "match" any alt containing a doubled separator.
    if (p.trim()) padded.set(value, p);
  }
  const hits = values.filter((v) => padded.has(v) && paddedAlt.includes(padded.get(v)));
  // Shadow rule: a matched value contained (padded) in a DIFFERENT matched value is suppressed.
  // Inequality is on the padded forms, matching the theme's token comparison, so two spellings
  // that normalize identically never suppress each other.
  return hits.filter((v) => !hits.some((w) => padded.get(w) !== padded.get(v) && padded.get(w).includes(padded.get(v))));
}

/**
 * Guard one alt string for a product against the reserved-vocabulary rule. `expected` is the
 * Admin Color value the photo should bind to (from colorwayToAdminValue), or null for a
 * group/shared photo. Returns null when the alt is acceptable, or an error string describing the
 * violation. Empty alt is skipped (not yet authored) and returns null.
 */
function checkAltColor(alt, expected, productKey, valuesFor) {
  if (!alt || !alt.trim()) return null;
  const matched = matchedColorValues(alt, valuesFor(productKey));
  if (expected === null) {
    return matched.length === 0
      ? null
      : `shared/group photo names colour value(s) [${matched.join(', ')}]; it would bind instead of staying shared`;
  }
  if (matched.length === 1 && matched[0] === expected) return null;
  if (matched.length === 0) return `names no recognized colour value; expected "${expected}" (photo would go shared)`;
  return `names colour value(s) [${matched.join(', ')}]; expected exactly "${expected}"`;
}

// --- parsing / normalization -------------------------------------------------------------

const INDEX_RE = /^(.*)-(\d+)$/; // split a trailing -<digits> index off the shot field

// Apply the caffine->caffeine fix and any per-field typo repair; lowercase.
function repairToken(token) {
  const lower = token.toLowerCase().replace(/caffine/g, 'caffeine');
  return FIELD_TYPOS.get(lower) || lower;
}

// Try to recover fields from an all-hyphen (or mixed) base name by greedily consuming known
// multi-word vocab tokens, then single tokens. Returns an array of field tokens or null.
function fieldsFromHyphenated(base, multiword) {
  let rest = base.toLowerCase();
  const fields = [];
  while (rest.length) {
    let matched = null;
    for (const token of multiword) {
      if (rest === token || rest.startsWith(`${token}-`)) { matched = token; break; }
    }
    if (matched) {
      fields.push(matched);
      rest = rest.slice(matched.length).replace(/^-/, '');
      continue;
    }
    const dash = rest.indexOf('-');
    if (dash === -1) { fields.push(rest); rest = ''; }
    else { fields.push(rest.slice(0, dash)); rest = rest.slice(dash + 1); }
  }
  // The shot's -<index> also reads as a field separator here; reattach a trailing pure-number
  // token to the preceding (shot) field so <shot>-<index> is preserved.
  if (fields.length >= 2 && /^\d+$/.test(fields[fields.length - 1])) {
    const index = fields.pop();
    fields[fields.length - 1] = `${fields[fields.length - 1]}-${index}`;
  }
  return fields.length ? fields : null;
}

/**
 * Parse a source filename into convention fields. Never throws. Returns:
 *   { line, garment, colorway, design, product, shot, index, fields, warnings, ok, uncertain }
 * `product` is the handle for the non-garment form (`<handle>_<shot>-<index>`) and null for the
 * garment forms, whose product is resolved from (line, garment) by the caller.
 * `fields` is the corrected, ordered field list used to build the canonical names. `ok` is
 * false when the name could not be parsed into a plausible structure at all. `uncertain` is
 * true when a warning reflects genuine ambiguity (unknown token, missing index, unparseable);
 * it is NOT set by confident repairs (separator misuse, a known typo), which are safe to apply
 * to a source file. `--rename-originals` renames only when `ok && !uncertain`.
 */
function parseWithVocab(filename, vocab) {
  const { lines, garments, colorways, nonGarments = [], multiword } = vocab;
  const warnings = [];
  let uncertain = false;
  const dot = filename.lastIndexOf('.');
  const base = dot === -1 ? filename : filename.slice(0, dot);

  // The non-garment form is exactly two fields whose first is a declared non-garment handle.
  const isNonGarmentShape = (fields) => fields.length === 2 && nonGarments.includes(fields[0]);

  // Prefer underscore fields; fall back to hyphen recovery when there is no usable underscore
  // structure (the all-hyphen separator-misuse case). A hyphen repair is confident, not uncertain.
  let rawFields = base.split('_').filter((f) => f.length);
  if (rawFields.length < 4 && !isNonGarmentShape(rawFields.map(repairToken))) {
    const recovered = fieldsFromHyphenated(base, multiword);
    if (recovered && (recovered.length >= 4 || isNonGarmentShape(recovered))) {
      warnings.push('field separators were hyphens; expected underscores between fields');
      rawFields = recovered;
    }
  }
  rawFields = rawFields.map(repairToken);

  const parseShot = (shotField) => {
    const m = INDEX_RE.exec(shotField);
    if (m) return { shot: m[1], index: Number(m[2]) };
    warnings.push(`shot field "${shotField}" has no -<index> suffix`);
    uncertain = true;
    return { shot: shotField, index: null };
  };

  if (isNonGarmentShape(rawFields)) {
    const [product, shotField] = rawFields;
    const { shot, index } = parseShot(shotField);
    if (shot && !SHOTS.includes(shot)) { warnings.push(`unknown shot "${shot}"`); uncertain = true; }
    return { line: null, garment: null, colorway: null, design: null, product, shot, index, fields: rawFields, warnings, ok: true, uncertain };
  }

  if (rawFields.length < 4 || rawFields.length > 5) {
    warnings.push(`expected 4 or 5 fields, found ${rawFields.length}: could not parse convention`);
    return { line: null, garment: null, colorway: null, design: null, product: null, shot: null, index: null, fields: rawFields, warnings, ok: false, uncertain: true };
  }

  const [line, garment, colorway] = rawFields;
  const shotField = rawFields[rawFields.length - 1];
  const design = rawFields.length === 5 ? rawFields[3] : null;
  const { shot, index } = parseShot(shotField);

  if (!lines.includes(line)) { warnings.push(`unknown line "${line}"`); uncertain = true; }
  if (!garments.includes(garment)) { warnings.push(`unknown garment "${garment}"`); uncertain = true; }
  if (!colorways.includes(colorway)) { warnings.push(`unknown colorway "${colorway}"`); uncertain = true; }
  if (shot && !SHOTS.includes(shot)) { warnings.push(`unknown shot "${shot}"`); uncertain = true; }
  if (colorway === GROUP_MARKER && design !== null) {
    warnings.push('group shot should not carry a design field'); uncertain = true;
  }

  return { line, garment, colorway, design, product: null, shot, index, fields: rawFields, warnings, ok: true, uncertain };
}

/**
 * The canonical filename for a source filename, plus warnings.
 * Returns { canonical, warnings, uncertain, parsed }:
 *   - canonical: the underscore-separated name (parsed fields re-joined by '_', internal hyphens
 *                kept). This is the ONE name used end to end: the processed output, the uploaded
 *                Shopify filename, and the `--rename-originals` target. Explicit field boundaries,
 *                trivially re-parseable.
 * When the name cannot be parsed, `canonical` falls back to a plain hyphen-collapse of the base
 * name (there are no fields to separate) so processing still produces a stable output; such a file
 * is `uncertain` and is never auto-renamed.
 */
function normalizeWithVocab(filename, vocab) {
  const parsed = parseWithVocab(filename, vocab);
  if (!parsed.ok) {
    const dot = filename.lastIndexOf('.');
    const base = dot === -1 ? filename : filename.slice(0, dot);
    const fallback = base.toLowerCase().replace(/caffine/g, 'caffeine')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'image';
    return { canonical: `${fallback}.jpg`, warnings: parsed.warnings, uncertain: true, parsed };
  }
  return {
    canonical: `${parsed.fields.join('_')}.jpg`,
    warnings: parsed.warnings,
    uncertain: parsed.uncertain,
    parsed,
  };
}

// --- committed-manifest delegates ---------------------------------------------------------
//
// The public surface, unchanged in shape and signature: each one binds `defaultNaming()`. A caller
// that needs a different census (a test, or a tool that has already loaded the manifest) calls
// `createNaming(manifest)` and uses the object it returns instead.

/** Every recorded product: garments keyed '<line>/<garment>', non-garments keyed by handle. */
export function allProducts() {
  return defaultNaming().PRODUCTS;
}

/** @param {string} colorway @param {string} [productKey] @returns {string|null} */
export function colorwayToAdminValue(colorway, productKey) {
  return defaultNaming().colorwayToAdminValue(colorway, productKey);
}

/** @param {string} line @param {string} garment @returns {object|null} */
export function productForLineGarment(line, garment) {
  return defaultNaming().productForLineGarment(line, garment);
}

/** @param {string} handle @returns {{key: string, record: object}|null} */
export function productForHandle(handle) {
  return defaultNaming().productForHandle(handle);
}

/** @param {string} productKey @returns {string[]} */
export function recognizedColorValues(productKey) {
  return defaultNaming().recognizedColorValues(productKey);
}

/** @param {string} alt @param {string|null} expected @param {string} productKey @returns {string|null} */
export function altColorProblem(alt, expected, productKey) {
  return defaultNaming().altColorProblem(alt, expected, productKey);
}

/** @param {string} filename @returns {object} */
export function parseName(filename) {
  return defaultNaming().parseName(filename);
}

/** @param {string} filename @returns {object} */
export function normalizeName(filename) {
  return defaultNaming().normalizeName(filename);
}
