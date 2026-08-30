// The catalogue manifest: the option axis names, every colour and size value with its Admin
// spelling, which garment bodies exist and what each is made in, and the complete product census.
// Committed at the repo root as catalogue.json.
//
// WHY IT EXISTS. thresholds.json used to be two things fused into one file: inventory POLICY
// (minimums, budgets, provenance) and a de facto declaration of the catalogue's body x colour x size
// SHAPE. The shape was never stated anywhere; it was inferred as a full cross product of the approved
// bodies against the GLOBAL colour and size vocabulary learned from the store. On a catalogue where
// one body is made in fewer colours than another, that product invents cells no variant can ever
// fill, and once those cells carry a nonzero minimum they flag as `no-group` in every report,
// forever. This file states the shape instead of inferring it, and the policy file keeps the numbers.
//
// WHY IT GREW A PRODUCT CENSUS. The same vocabulary (colour list, size list, product handles, titles,
// GIDs, option axis names) was restated across seven other places that nothing reconciled: five
// spellings of three garment bodies, three casings of one colour, one product GID written four times.
// The manifest is now the authority for all of it, and `scripts/lib/catalogue-cohesion.mjs` refuses a
// PR whose other files disagree with it.
//
// WHY IT LIVES IN scripts/lib/. It began under scripts/blank-inventory/lib/, whose neighbours reach
// lib/mutations.mjs in two hops. Seven areas import this module now, so it and its two dependencies
// (../lib/vocab.mjs, ../lib/json-keys.mjs) are zero-import leaves or near-leaves by construction.
//
// READ-ONLY BY CONSTRUCTION. Nothing here writes to the store or to any file, and nothing here may
// ever import lib/mutations.mjs (a transitive-closure test asserts it). The manifest itself is
// hand-edited in a reviewed PR; no command and no agent creates or edits it.
//
// WHAT IS SAFE TO COMMIT. Storefront option values (the colour and size names any visitor sees on a
// product page), generic body ids, product handles, titles, template suffixes and product GIDs: all
// of it renders on the storefront. Never a blank id, a supplier name, a style number, a case pack, a
// cost, or any policy number: those belong to thresholds.json or nowhere.
//
// THE HEADER RULE FOR VALIDATION, which every rule below is an instance of: an IDENTITY is rejected
// unless it is already normalised; a DISPLAY string is rejected unless it normalises back to the
// identity it hangs off; an option name, a title and a GID are checked on shape and uniqueness only,
// and are never case-folded.

import { normaliseAxis } from './vocab.mjs';
import { findDuplicateKeys } from './json-keys.mjs';

/** The one schema version this tool understands. A future shape means a bump plus a transform. */
export const CATALOGUE_VERSION = 2;

/** Where the committed manifest lives, relative to the repo root. */
export const CATALOGUE_PATH = 'catalogue.json';

/** Everything a manifest document may carry at the top level. Anything else refuses. */
const TOP_LEVEL_KEYS = ['version', 'comment', 'options', 'colors', 'sizes', 'bodies', 'products'];

/** Everything one body entry may carry. Anything else refuses. */
const BODY_KEYS = ['colors', 'sizes'];

/** Everything one colour entry may carry. Exactly these, all required. */
const COLOR_KEYS = ['display', 'slug'];

/** Everything one size entry may carry. Exactly these, all required. */
const SIZE_KEYS = ['display'];

/** Everything one product entry may carry. Exactly these, all required (null counts as present). */
const PRODUCT_KEYS = ['line', 'body', 'template', 'title', 'gid'];

/** The option axes this catalogue has. Closed: a new axis is a schema change, not a data edit. */
const OPTION_KEYS = ['color', 'size', 'design', 'denomination'];

/**
 * Kebab-case identifier shape, for handles, template suffixes and colour slugs.
 *
 * THE ONE DEFINITION. It was copied here from scripts/applique-grid/lib/registry.mjs rather than
 * moved, so trunk stayed green in the window before that module was migrated; the original is gone
 * now and registry.mjs imports this one. A test asserts there is no second declaration.
 */
export const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Product GID shape. Same history, and the only definition left. */
export const PRODUCT_GID_RE = /^gid:\/\/shopify\/Product\/\d+$/;

const cmpString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Render a list of PR-authored strings for an error message, each JSON-quoted and the whole list
 * bounded.
 *
 * The quoting is not cosmetic. These messages carry names straight out of PR-authored files, and CI
 * captures them into `$GITHUB_OUTPUT` under a heredoc. A name containing a real newline could
 * otherwise close that heredoc early and forge a later `exit_code=0` line, turning a refused lint
 * into a green check. JSON.stringify escapes the newline, so the name cannot span lines at all.
 * The workflow uses a random delimiter as well; this is the half that closes the class.
 *
 * The bound is the second half. These lists are set differences over PR-controlled files, so their
 * length is PR-controlled too: an inflated set could trip the Actions output limit or produce a PR
 * comment nobody can read. The count is always stated, so a truncated list never looks complete.
 *
 * @param {string[]} names
 * @param {number} [limit]
 * @returns {string}
 */
export function nameList(names, limit = 12) {
  const list = [...names];
  const head = list.slice(0, limit).map((n) => JSON.stringify(n));
  if (list.length <= limit) return head.join(', ');
  return `${head.join(', ')} and ${list.length - limit} more`;
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
 * A human-facing string that is NOT normalisable: an option axis name, a product title.
 *
 * Case is preserved, because these are Admin spellings and Admin is case-sensitive about them. What
 * is checked is only what a display string can be wrong about structurally: emptiness, a stray
 * newline or control character, untrimmed or doubled whitespace, a non-NFC encoding that would
 * compare unequal to the identical-looking Admin value, and the vocabulary key separator.
 *
 * @param {unknown} value
 * @param {string} where
 * @returns {string}
 */
function assertDisplayString(value, where) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${where} must be a non-empty string, got ${JSON.stringify(value)}.`);
  }
  if (value.normalize('NFC') !== value) {
    throw new Error(
      `${where} ${JSON.stringify(value)} is not NFC-normalised. Admin stores NFC, so a decomposed ` +
        `spelling here compares unequal to an identical-looking live value and every match silently fails.`
    );
  }
  if (value !== value.trim()) {
    throw new Error(`${where} ${JSON.stringify(value)} has leading or trailing whitespace.`);
  }
  if (/\s{2,}/.test(value)) {
    throw new Error(
      `${where} ${JSON.stringify(value)} contains doubled whitespace. The storefront gallery filter ` +
        `never collapses doubles, so a doubled space stops a multi-word value binding at all.`
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${where} ${JSON.stringify(value)} contains a control character or newline.`);
  }
  if (value.includes('|')) {
    throw new Error(
      `${where} ${JSON.stringify(value)} contains the vocabulary key separator "|". This tool ` +
        `refuses to escape it; rename the value in Admin.`
    );
  }
  return value;
}

/**
 * Refuse a repeated value across a set of entries.
 *
 * @param {Array<[string, string]>} pairs - [owningKey, value]
 * @param {string} what
 */
function assertPairwiseUnique(pairs, what) {
  /** @type {Map<string, string[]>} */
  const byValue = new Map();
  for (const [key, value] of pairs) {
    if (!byValue.has(value)) byValue.set(value, []);
    byValue.get(value).push(key);
  }
  const clashes = [...byValue.entries()].filter(([, keys]) => keys.length > 1);
  if (clashes.length) {
    throw new Error(
      `${what} must be unique. Repeated: ` +
        `${nameList(clashes.map(([value, keys]) => `${value} (${keys.join(', ')})`))}.`
    );
  }
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
 * The option axis names, keyed by internal axis id.
 *
 * THE ROUND-TRIP RULE DELIBERATELY DOES NOT APPLY HERE, and this is the one place in the schema
 * where key and value are not two spellings of one thing. `options.denomination` is `"Denominations"`
 * on the live store: it normalises to `denominations`, not to its key. That plural mismatch is real
 * data, not a typo to fix. So an option KEY is an internal axis id (a closed set, checked for
 * membership) and its VALUE is the nearby Admin label (checked on shape and uniqueness only).
 *
 * @param {unknown} raw
 * @returns {Map<string, string>}
 */
function parseOptions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `${CATALOGUE_PATH} needs an "options" object mapping each axis id to its Admin option name. ` +
        `Those names are what config/settings_schema.json's variant-picker defaults must match.`
    );
  }
  const keys = Object.keys(raw);
  const missing = OPTION_KEYS.filter((k) => !keys.includes(k));
  const unknown = keys.filter((k) => !OPTION_KEYS.includes(k));
  if (missing.length || unknown.length) {
    throw new Error(
      `${CATALOGUE_PATH} "options" must have exactly the keys ${nameList(OPTION_KEYS)}.` +
        `${missing.length ? ` Missing: ${nameList(missing)}.` : ''}` +
        `${unknown.length ? ` Unknown: ${nameList(unknown)}.` : ''} The axis set is closed: a new ` +
        `axis is a schema change with consumers to update, not a data edit.`
    );
  }
  const options = new Map();
  for (const key of OPTION_KEYS) {
    options.set(key, assertDisplayString(raw[key], `${CATALOGUE_PATH} options.${key}`));
  }
  assertPairwiseUnique([...options].map(([k, v]) => [`options.${k}`, v]), 'Option axis names');
  return options;
}

/**
 * The colour vocabulary: normalised identity -> Admin display spelling + kebab slug.
 *
 * `display` round-trips: `normaliseAxis(display, 'Color')` must equal the key. `"Gray Heather"` under
 * the key `"grey heather"` refuses, naming both, because the two are not the same value and a silent
 * accept would put one spelling on the storefront and the other in every derived table.
 *
 * `slug` is a STORED, CHECKED projection: it must equal `key.replace(/ /g, '-')`. It is stored rather
 * than computed so a reviewer adding a colour sees all three spellings adjacent in one diff hunk.
 *
 * @param {unknown} raw
 * @returns {Map<string, {display: string, slug: string}>}
 */
function parseColors(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${CATALOGUE_PATH} needs a "colors" object keyed by normalised colour value.`);
  }
  const colors = new Map();
  for (const [key, entry] of Object.entries(raw)) {
    assertNormalised(key, 'Color', `${CATALOGUE_PATH} colour id`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Colour ${JSON.stringify(key)} must be an object with "display" and "slug".`);
    }
    const keys = Object.keys(entry);
    if (keys.length !== COLOR_KEYS.length || COLOR_KEYS.some((k) => !keys.includes(k))) {
      throw new Error(
        `Colour ${JSON.stringify(key)} must have exactly the keys ${nameList(COLOR_KEYS)}, got ` +
          `${nameList(keys)}.`
      );
    }
    const display = assertDisplayString(entry.display, `Colour ${JSON.stringify(key)} "display"`);
    const roundTrip = normaliseAxis(display, 'Color');
    if (roundTrip !== key) {
      throw new Error(
        `Colour ${JSON.stringify(key)} has display ${JSON.stringify(display)}, which normalises to ` +
          `${JSON.stringify(roundTrip)}. A display string and its key are two spellings of ONE value; ` +
          `these are two different values. Correct whichever one is wrong.`
      );
    }
    const expectedSlug = key.replace(/ /g, '-');
    if (entry.slug !== expectedSlug) {
      throw new Error(
        `Colour ${JSON.stringify(key)} has slug ${JSON.stringify(entry.slug)}; the only valid slug ` +
          `is ${JSON.stringify(expectedSlug)}. It is stored rather than computed so all three ` +
          `spellings of a colour appear adjacent in the diff that adds it.`
      );
    }
    if (!ID_RE.test(entry.slug)) {
      throw new Error(`Colour ${JSON.stringify(key)} slug ${JSON.stringify(entry.slug)} is not kebab-case.`);
    }
    colors.set(key, { display, slug: entry.slug });
  }
  assertPairwiseUnique([...colors].map(([k, v]) => [k, v.display]), 'Colour display spellings');
  assertPairwiseUnique([...colors].map(([k, v]) => [k, v.slug]), 'Colour slugs');
  return colors;
}

/**
 * The size vocabulary: normalised identity -> Admin display spelling. Same round-trip rule as colour,
 * no slug (nothing puts a size in a filename or a URL).
 *
 * @param {unknown} raw
 * @returns {Map<string, {display: string}>}
 */
function parseSizes(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${CATALOGUE_PATH} needs a "sizes" object keyed by normalised size value.`);
  }
  const sizes = new Map();
  for (const [key, entry] of Object.entries(raw)) {
    assertNormalised(key, 'Size', `${CATALOGUE_PATH} size id`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Size ${JSON.stringify(key)} must be an object with "display".`);
    }
    const keys = Object.keys(entry);
    if (keys.length !== SIZE_KEYS.length || SIZE_KEYS.some((k) => !keys.includes(k))) {
      throw new Error(
        `Size ${JSON.stringify(key)} must have exactly the keys ${nameList(SIZE_KEYS)}, got ${nameList(keys)}.`
      );
    }
    const display = assertDisplayString(entry.display, `Size ${JSON.stringify(key)} "display"`);
    const roundTrip = normaliseAxis(display, 'Size');
    if (roundTrip !== key) {
      throw new Error(
        `Size ${JSON.stringify(key)} has display ${JSON.stringify(display)}, which normalises to ` +
          `${JSON.stringify(roundTrip)}. A display string and its key are two spellings of ONE value.`
      );
    }
    sizes.set(key, { display });
  }
  assertPairwiseUnique([...sizes].map(([k, v]) => [k, v.display]), 'Size display spellings');
  return sizes;
}

/**
 * The product census: every product on the store, garment or not.
 *
 * `body` and `line` are `null` TOGETHER and EXPLICITLY on a non-garment, never omitted: an absent key
 * reads as an oversight, and `"body": null` reads as a decision. All five keys are required.
 *
 * `template` is the theme template suffix, and it earns its place by settling three spellings that
 * otherwise diverge: `templates/product.<template>.json` is the file, `<template>` is what the SEO
 * review's non-garment allowlist compares against, and `product (<template with hyphens as spaces>)`
 * is the a11y audit label. It is also what the size-chart profiles' `handles` derive from, which is
 * why scripts/size-chart/README.md's statement that those are template suffixes stays true.
 *
 * @param {unknown} raw
 * @param {Map<string, unknown>} bodies
 * @returns {Map<string, {handle: string, line: string|null, body: string|null, template: string, title: string, gid: string}>}
 */
function parseProducts(raw, bodies) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `${CATALOGUE_PATH} needs a "products" object keyed by Admin product handle. It is the complete ` +
        `census, gift cards included; a product missing from it is a product seven tools cannot see.`
    );
  }
  const products = new Map();
  for (const [handle, entry] of Object.entries(raw)) {
    assertNormalised(handle, 'Handle', `${CATALOGUE_PATH} product handle`);
    if (!ID_RE.test(handle)) {
      throw new Error(`Product handle ${JSON.stringify(handle)} is not kebab-case.`);
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Product ${JSON.stringify(handle)} must be an object.`);
    }
    const keys = Object.keys(entry);
    const missing = PRODUCT_KEYS.filter((k) => !keys.includes(k));
    const unknown = keys.filter((k) => !PRODUCT_KEYS.includes(k));
    if (missing.length || unknown.length) {
      throw new Error(
        `Product ${JSON.stringify(handle)} must have exactly the keys ${nameList(PRODUCT_KEYS)}.` +
          `${missing.length ? ` Missing: ${nameList(missing)}.` : ''}` +
          `${unknown.length ? ` Unknown: ${nameList(unknown)}.` : ''} "line" and "body" are null ` +
          `together and explicitly on a non-garment; an omitted key reads as an oversight, an ` +
          `explicit null reads as a decision.`
      );
    }

    const { line, body, template, title, gid } = entry;
    if (line !== null) assertNormalised(line, 'Line', `Product ${JSON.stringify(handle)} "line"`);
    if (body !== null) {
      assertNormalised(body, 'Body', `Product ${JSON.stringify(handle)} "body"`);
      if (!bodies.has(body)) {
        throw new Error(
          `Product ${JSON.stringify(handle)} declares body ${JSON.stringify(body)}, which is not a ` +
            `declared body (${nameList([...bodies.keys()])}). Matched exactly: a near-miss spelling ` +
            `would give the product a colour and size range nobody declared for it.`
        );
      }
    }
    if ((line === null) !== (body === null)) {
      throw new Error(
        `Product ${JSON.stringify(handle)} has line ${JSON.stringify(line)} and body ` +
          `${JSON.stringify(body)}. A product with no body is not a garment and has no product line; ` +
          `they are null together or neither is.`
      );
    }

    assertNormalised(template, 'Template', `Product ${JSON.stringify(handle)} "template"`);
    if (!ID_RE.test(template)) {
      throw new Error(`Product ${JSON.stringify(handle)} template ${JSON.stringify(template)} is not kebab-case.`);
    }
    assertDisplayString(title, `Product ${JSON.stringify(handle)} "title"`);
    if (typeof gid !== 'string' || !PRODUCT_GID_RE.test(gid)) {
      throw new Error(
        `Product ${JSON.stringify(handle)} gid ${JSON.stringify(gid)} must look like ` +
          `gid://shopify/Product/<id>.`
      );
    }

    products.set(handle, { handle, line: line ?? null, body: body ?? null, template, title, gid });
  }

  if (!products.size) {
    throw new Error(
      `${CATALOGUE_PATH} declares no products. It is the complete census; an empty one silently ` +
        `narrows every derived list to nothing, which is the fail-open shape this file exists to prevent.`
    );
  }

  const entries = [...products.values()];
  assertPairwiseUnique(entries.map((p) => [p.handle, p.template]), 'Product template suffixes');
  assertPairwiseUnique(entries.map((p) => [p.handle, p.title]), 'Product titles');
  // A shared GID is what would make upload-product-media.mjs write photos onto the wrong product,
  // so this one is not a tidiness check.
  assertPairwiseUnique(entries.map((p) => [p.handle, p.gid]), 'Product GIDs');

  return products;
}

/**
 * The colour and size key order must equal the first-seen union across `bodies`, both directions.
 *
 * ORDER IS LOAD-BEARING, which is why this is a refusal and not a sort. That union order is the row
 * order of the reorder matrix, so a reshuffle here silently reorders a printed count sheet.
 *
 * @param {Map<string, unknown>} vocab - the `colors` or `sizes` map, in declaration order
 * @param {Map<string, {colors: string[], sizes: string[]}>} bodies
 * @param {'colors'|'sizes'} axis
 */
function assertVocabMatchesBodies(vocab, bodies, axis) {
  const union = [];
  for (const range of bodies.values()) {
    for (const value of range[axis]) if (!union.includes(value)) union.push(value);
  }
  const declared = [...vocab.keys()];
  const missing = union.filter((v) => !declared.includes(v));
  const extra = declared.filter((v) => !union.includes(v));
  if (missing.length || extra.length) {
    throw new Error(
      `${CATALOGUE_PATH} "${axis}" must name exactly the values used across "bodies".` +
        `${missing.length ? ` Used but not declared: ${nameList(missing)}.` : ''}` +
        `${extra.length ? ` Declared but unused: ${nameList(extra)}.` : ''}`
    );
  }
  if (declared.length !== union.length || declared.some((v, i) => v !== union[i])) {
    throw new Error(
      `${CATALOGUE_PATH} "${axis}" key order is ${nameList(declared)} but the first-seen order across ` +
        `"bodies" is ${nameList(union)}. That order is the reorder matrix's row order, so a reshuffle ` +
        `here silently reorders a printed count sheet. Reorder one to match the other deliberately.`
    );
  }
}

/**
 * Parse and validate the manifest from its raw text.
 *
 * Raw text in, not an object, for the same reason `parseThresholds` takes text: the duplicate-key
 * check can only be done on the text, and doing it anywhere else means a caller can skip it.
 *
 * Declaration ORDER is preserved into every returned Map. It is load-bearing in two independent
 * places, which the manifest's own `comment` names side by side: product declaration order drives the
 * a11y audit block and photo-naming's line list, and colour/size key order is the reorder matrix's
 * row order.
 *
 * @param {string} text
 * @returns {{version: number, options: Map<string,string>, colors: Map<string,{display:string,slug:string}>, sizes: Map<string,{display:string}>, bodies: Map<string,{colors:string[],sizes:string[]}>, products: Map<string,object>, raw: object}}
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
        `the catalogue's shape and nothing else; policy numbers live in thresholds.json, SKU codes in ` +
        `scripts/sku/tables.json.`
    );
  }

  if (doc.version !== CATALOGUE_VERSION) {
    // The v1 skeleton printer shipped alongside the schema and was deleted once every consumer had
    // migrated: there is no v1 document left anywhere to convert, and a one-shot kept for a
    // conversion that can no longer happen is cruft that still has to be maintained. It is
    // recoverable from git history if a v1 file ever turns up.
    const migrator =
      doc.version === 1
        ? ` A version 1 document predates the manifest's Admin display spellings and its product ` +
          `census, which is exactly what nothing can derive, so it is hand-corrected in a reviewed ` +
          `PR. This file is never auto-migrated in place.`
        : '';
    throw new Error(
      `${CATALOGUE_PATH} declares version ${JSON.stringify(doc.version)}; this tool understands ` +
        `${CATALOGUE_VERSION} only.${migrator}`
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
    if (!ID_RE.test(bodyId)) {
      throw new Error(`${CATALOGUE_PATH} body id ${JSON.stringify(bodyId)} is not kebab-case.`);
    }
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
  if (!bodies.size) {
    throw new Error(`${CATALOGUE_PATH} declares no bodies. A catalogue with no garment body is not a catalogue.`);
  }

  const options = parseOptions(doc.options);
  const colors = parseColors(doc.colors);
  const sizes = parseSizes(doc.sizes);
  assertVocabMatchesBodies(colors, bodies, 'colors');
  assertVocabMatchesBodies(sizes, bodies, 'sizes');
  const products = parseProducts(doc.products, bodies);

  return { version: doc.version, options, colors, sizes, bodies, products, raw: doc };
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
 * @returns {Promise<ReturnType<typeof parseCatalogue>>}
 */
export async function loadCatalogue({ read, path = CATALOGUE_PATH }) {
  let text;
  try {
    text = await read(path);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const e = new Error(
        `No catalogue manifest at ${path}. It is committed at the repo root and hand-edited in a ` +
          `reviewed PR; no command and no agent creates or edits it. It declares the option axis ` +
          `names, the colour and size vocabulary, which colours and sizes each garment body is made ` +
          `in, and the complete product census. Seven areas derive from it, so a missing file is a ` +
          `broken checkout rather than a workflow state.`
      );
      e.fileMissing = true;
      throw e;
    }
    throw err;
  }
  return parseCatalogue(text);
}

// ---------------------------------------------------------------------------
// Derived accessors
//
// Every consumer reads the manifest through these rather than reaching into the Maps, so a schema
// change has one place to update and a null-body product cannot be treated as a garment by accident.
// ---------------------------------------------------------------------------

/** The error thrown when a garment-only accessor is handed a non-garment product. */
export class NotAGarmentError extends Error {
  /** @param {string} handle @param {string} accessor */
  constructor(handle, accessor) {
    super(
      `${accessor}("${handle}"): that product has "body": null, so it is not a garment and has no ` +
        `colour or size range. Returning an empty list here would let a caller silently build zero ` +
        `cells, zero photo targets or zero SKU segments and report success. Use garmentProducts() to ` +
        `select, or handle the non-garment case explicitly.`
    );
    this.name = 'NotAGarmentError';
    this.handle = handle;
  }
}

/** @param {object} m @param {string} id @returns {string} the Admin spelling of a colour */
export function colorDisplay(m, id) {
  const entry = m.colors.get(id);
  if (!entry) throw new Error(`Unknown colour ${JSON.stringify(id)}; declared: ${nameList([...m.colors.keys()])}.`);
  return entry.display;
}

/** @param {object} m @param {string} id @returns {string} the kebab slug of a colour */
export function colorSlug(m, id) {
  const entry = m.colors.get(id);
  if (!entry) throw new Error(`Unknown colour ${JSON.stringify(id)}; declared: ${nameList([...m.colors.keys()])}.`);
  return entry.slug;
}

/** @param {object} m @param {string} id @returns {string} the Admin spelling of a size */
export function sizeDisplay(m, id) {
  const entry = m.sizes.get(id);
  if (!entry) throw new Error(`Unknown size ${JSON.stringify(id)}; declared: ${nameList([...m.sizes.keys()])}.`);
  return entry.display;
}

/** @param {object} m @param {string} axis - one of color|size|design|denomination @returns {string} */
export function optionName(m, axis) {
  const name = m.options.get(axis);
  if (!name) throw new Error(`Unknown option axis ${JSON.stringify(axis)}; declared: ${nameList([...m.options.keys()])}.`);
  return name;
}

/** @param {object} m @param {string} handle @returns {object} the product entry, or throws */
export function productByHandle(m, handle) {
  const product = m.products.get(handle);
  if (!product) {
    throw new Error(
      `No product ${JSON.stringify(handle)} in ${CATALOGUE_PATH}. Declared: ` +
        `${nameList([...m.products.keys()])}. The manifest is the complete census; add the product ` +
        `there in a reviewed PR rather than special-casing it here.`
    );
  }
  return product;
}

/** @param {object} m @param {string} bodyId @returns {object[]} products on one body, declaration order */
export function productsOnBody(m, bodyId) {
  if (!m.bodies.has(bodyId)) {
    throw new Error(`Unknown body ${JSON.stringify(bodyId)}; declared: ${nameList([...m.bodies.keys()])}.`);
  }
  return [...m.products.values()].filter((p) => p.body === bodyId);
}

/** @param {object} m @returns {object[]} every product with a body, in declaration order */
export function garmentProducts(m) {
  return [...m.products.values()].filter((p) => p.body !== null);
}

/** @param {object} m @returns {object[]} every product with no body, in declaration order */
export function nonGarmentProducts(m) {
  return [...m.products.values()].filter((p) => p.body === null);
}

/**
 * The Admin Color option values a product sells, in its body's declaration order.
 * @param {object} m @param {string} handle @returns {string[]}
 * @throws {NotAGarmentError} on a null-body product
 */
export function colorValuesFor(m, handle) {
  const product = productByHandle(m, handle);
  if (product.body === null) throw new NotAGarmentError(handle, 'colorValuesFor');
  return m.bodies.get(product.body).colors.map((id) => colorDisplay(m, id));
}

/**
 * The Admin Size option values a product sells, in its body's declaration order.
 * @param {object} m @param {string} handle @returns {string[]}
 * @throws {NotAGarmentError} on a null-body product
 */
export function sizeValuesFor(m, handle) {
  const product = productByHandle(m, handle);
  if (product.body === null) throw new NotAGarmentError(handle, 'sizeValuesFor');
  return m.bodies.get(product.body).sizes.map((id) => sizeDisplay(m, id));
}

/** @param {object} m @returns {string[]} every product line, first-seen order, non-garments excluded */
export function linesOf(m) {
  const out = [];
  for (const p of m.products.values()) if (p.line && !out.includes(p.line)) out.push(p.line);
  return out;
}

/**
 * The repo-relative theme template path for a product.
 * @param {object} m @param {string} handle @returns {string}
 */
export function templateFileFor(m, handle) {
  return `templates/product.${productByHandle(m, handle).template}.json`;
}

// ---------------------------------------------------------------------------
// The networked gate
// ---------------------------------------------------------------------------

/**
 * Compare the declared shape against the live store.
 *
 * Pure: nothing here reads a file, touches the network, or edits the manifest.
 *
 * THE TWO-WAY BODY-SET CHECK AGAINST THE APPROVED BODY MAP IS GONE, deliberately. The manifest is now
 * the only authority on a product's body and the body map is derived from it, so that check would
 * compare the manifest against a derivative of itself and could never fail for a real reason. What
 * replaces it is a set of checks against the LIVE STORE, which is the only thing that can disagree
 * with the manifest about facts:
 *
 *   - A declared body with no product refuses at parse time (offline).
 *   - A live tracked product missing from the census refuses here: seven tools cannot see it.
 *   - A declared handle with no live product refuses here: it is a stale census entry.
 *   - A live title or GID differing from the declared one refuses here. The GID check is the one
 *     that matters most: a stale GID is what would make the media uploader write onto another product.
 *   - A declared colour or size the store has not shown yet is a WARNING. Declaring a colour before
 *     the first variant exists is the point of declaring it at all.
 *   - A live TAGGED variant whose body+colour+size falls outside the manifest is a REFUSAL. This is
 *     the check the cross product used to provide by accident. Untagged variants are out of scope for
 *     the same reason they are out of scope for `learnVocab`: nothing untagged is in a blank group.
 *
 * @param {object} params
 * @param {ReturnType<typeof parseCatalogue>} params.manifest
 * @param {Array<{handle: string, title?: string, gid?: string, id?: string}>} [params.liveProducts]
 * @param {{colors?: string[], sizes?: string[]}} [params.vocab] - the learned store vocabulary
 * @param {object[]} [params.variants] - post-attachBodies variants
 * @param {(v: object) => string} [params.keyOf] - vocabKey, injected so this module stays a near-leaf
 * @returns {{danglingBodies: string[], undeclaredProducts: string[], staleProducts: string[], titleMismatches: Array<{handle:string, live:string, declared:string}>, gidMismatches: Array<{handle:string, live:string, declared:string}>, unknownColors: string[], unknownSizes: string[], undeclaredVariants: Array<{key: string, count: number}>}}
 */
export function reconcileCatalogue({ manifest, liveProducts = [], vocab = {}, variants = [], keyOf = null }) {
  const declared = manifest?.bodies ?? new Map();
  const products = manifest?.products ?? new Map();

  // Offline: needs no live data at all, and the lint calls reconcileCatalogue with none so it fires
  // in CI. It is not a parse-time throw because it is a FACT about the catalogue rather than a
  // malformed document, and it deserves its own refusal code alongside the networked ones.
  const declaredProducts = [...products.values()];
  const danglingBodies = [...declared.keys()]
    .filter((b) => !declaredProducts.some((p) => p.body === b))
    .sort(cmpString);

  const live = (liveProducts ?? []).filter((p) => p && p.handle);
  const liveByHandle = new Map(live.map((p) => [p.handle, p]));

  const undeclaredProducts = live
    .filter((p) => p.tracked !== false && !products.has(p.handle))
    .map((p) => p.handle)
    .sort(cmpString);
  const staleProducts = live.length
    ? [...products.keys()].filter((h) => !liveByHandle.has(h)).sort(cmpString)
    : [];

  const titleMismatches = [];
  const gidMismatches = [];
  for (const [handle, declaredProduct] of products) {
    const liveProduct = liveByHandle.get(handle);
    if (!liveProduct) continue;
    if (liveProduct.title !== undefined && liveProduct.title !== declaredProduct.title) {
      titleMismatches.push({ handle, live: liveProduct.title, declared: declaredProduct.title });
    }
    const liveGid = liveProduct.gid ?? liveProduct.id;
    if (liveGid !== undefined && liveGid !== declaredProduct.gid) {
      gidMismatches.push({ handle, live: liveGid, declared: declaredProduct.gid });
    }
  }

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
    const key = keyOf
      ? keyOf(v)
      : [normaliseAxis(v.body, 'Body'), normaliseAxis(v.color, 'Color'), normaliseAxis(v.size, 'Size')].join('|');
    const [body, color, size] = key.split('|');
    const range = declared.get(body);
    if (range && range.colors.includes(color) && range.sizes.includes(size)) continue;
    undeclared.set(key, (undeclared.get(key) ?? 0) + 1);
  }
  const undeclaredVariants = [...undeclared.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => cmpString(a.key, b.key));

  return {
    danglingBodies,
    undeclaredProducts,
    staleProducts,
    titleMismatches,
    gidMismatches,
    unknownColors,
    unknownSizes,
    undeclaredVariants,
  };
}

/**
 * The loud-failure contract for the manifest, as data.
 *
 * Same shape as `assessThresholds` so the command layer prints both through one refusal path and a
 * `--json` consumer sees one object shape whichever gate stopped the run.
 *
 * @param {object} params
 * @param {string[]} [params.danglingBodies]
 * @param {string[]} [params.undeclaredProducts]
 * @param {string[]} [params.staleProducts]
 * @param {Array<{handle:string, live:string, declared:string}>} [params.titleMismatches]
 * @param {Array<{handle:string, live:string, declared:string}>} [params.gidMismatches]
 * @param {string[]} [params.unknownColors]
 * @param {string[]} [params.unknownSizes]
 * @param {Array<{key: string, count: number}>} [params.undeclaredVariants]
 * @param {boolean} [params.fileMissing]
 * @param {string} [params.invalid] - a parse or schema failure message from parseCatalogue
 * @returns {{exitCode: number, refusals: Array<{code: string, message: string, keys: string[]}>, warnings: Array<{code: string, message: string, keys: string[]}>}}
 */
export function assessCatalogue({
  danglingBodies = [],
  undeclaredProducts = [],
  staleProducts = [],
  titleMismatches = [],
  gidMismatches = [],
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
        `No catalogue manifest at ${CATALOGUE_PATH}. It declares the option axis names, the colour ` +
        `and size vocabulary, which colours and sizes each garment body is made in, and the complete ` +
        `product census. It is hand-edited in a reviewed PR; no command creates it, so a missing ` +
        `file is a broken checkout.`,
    });
  }

  if (danglingBodies.length) {
    refusals.push({
      code: 'catalogue-dangling-body',
      keys: danglingBodies,
      message:
        `${danglingBodies.length} declared body/bodies have no product: ${nameList(danglingBodies)}. ` +
        `A body exists because something is printed on it, so a body with no product is a stale ` +
        `declaration whose colour and size range nothing reads, and whose cells would appear in the ` +
        `reorder matrix as rows no variant can ever fill. Delete the body, or declare the product ` +
        `that uses it.`,
    });
  }

  if (undeclaredProducts.length) {
    refusals.push({
      code: 'catalogue-undeclared-products',
      keys: undeclaredProducts,
      message:
        `${undeclaredProducts.length} live product(s) with tracked variants are not declared in ` +
        `${CATALOGUE_PATH}: ${nameList(undeclaredProducts)}. The manifest is the complete census and ` +
        `the only authority on a product's garment body, so an undeclared product is invisible to ` +
        `the reorder review, the SKU tables, the photo pipeline and the accessibility audit at once. ` +
        `Declare it in a reviewed PR; never work around this by untagging its variants.`,
    });
  }

  if (staleProducts.length) {
    refusals.push({
      code: 'catalogue-stale-products',
      keys: staleProducts,
      message:
        `${staleProducts.length} product handle(s) declared in ${CATALOGUE_PATH} have no live ` +
        `product: ${nameList(staleProducts)}. Either the product was deleted or its handle was ` +
        `renamed in Admin. A renamed handle also breaks its storefront URL and every link to it, so ` +
        `check which happened before editing the manifest.`,
    });
  }

  if (titleMismatches.length) {
    refusals.push({
      code: 'catalogue-title-mismatch',
      keys: titleMismatches.map((t) => t.handle),
      message:
        `${titleMismatches.length} product title(s) differ from the live store: ` +
        `${nameList(titleMismatches.map((t) => `${t.handle} (live ${t.live}, declared ${t.declared})`))}. ` +
        `The declared title is what the SKU tables and the media uploader print; correct the manifest ` +
        `to match Admin, which is the authority on merchandising copy.`,
    });
  }

  if (gidMismatches.length) {
    refusals.push({
      code: 'catalogue-gid-mismatch',
      keys: gidMismatches.map((g) => g.handle),
      message:
        `${gidMismatches.length} product GID(s) differ from the live store: ` +
        `${nameList(gidMismatches.map((g) => `${g.handle} (live ${g.live}, declared ${g.declared})`))}. ` +
        `A GID is stable for the life of a product, so a mismatch means the handle now resolves to a ` +
        `DIFFERENT product. Stop: writing media or options against a stale GID edits the wrong product.`,
    });
  }

  if (undeclaredVariants.length) {
    refusals.push({
      code: 'catalogue-undeclared-variants',
      keys: undeclaredVariants.map((u) => u.key),
      message:
        `${undeclaredVariants.length} live combination(s) are tagged into a blank group but are not ` +
        `declared in ${CATALOGUE_PATH}: ` +
        `${nameList(undeclaredVariants.map((u) => `${u.key} (${u.count} variant(s))`))}. Stock ` +
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
        `${nameList(unknownColors)}. That is expected for a colour declared ahead of its first ` +
        `blank; their cells exist and will report as having no group until one does.`,
    });
  }

  if (unknownSizes.length) {
    warnings.push({
      code: 'catalogue-unseen-sizes',
      keys: unknownSizes,
      message:
        `${unknownSizes.length} declared size(s) have no tagged variant on the store yet: ` +
        `${nameList(unknownSizes)}.`,
    });
  }

  return { exitCode: refusals.length ? 1 : 0, refusals, warnings };
}
