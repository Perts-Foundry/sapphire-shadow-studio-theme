// Canonical naming convention for Sapphire Shadow Studio product photos, plus the
// product / colour mappings the upload pipeline needs. Pure and dependency-free so both
// process-product-images.mjs (naming + output) and upload-product-media.mjs (resolution)
// read one source of truth. No side effects, no I/O.
//
// Convention:
//   <line>_<garment>_<colorway>[_<design>]_<shot>-<index>.jpg
//   group shot:  <line>_<garment>_group_<shot>-<index>.jpg   (no colorway, no design)
//
// Fields are underscore-separated. A multi-word field value hyphenates internally
// (crew-sweater, classic-navy). The shot carries a -<index> suffix (flat-1). ONE scheme runs end
// to end: the canonical name (processed output, uploaded Shopify filename, and --rename-originals
// target) is the parsed fields re-joined by '_', e.g. LEAD2 quarter-zip black emt flat-1 stays
// lead2_quarter-zip_black_emt_flat-1.jpg. Underscores keep the field boundaries explicit and the
// name trivially re-parseable; the internal hyphens of a multi-word field are preserved.
//
// line / garment / colorway / shot are closed sets (an unknown token warns). design is an
// open kebab token (any profession/design; never warns on content). Keep new products on the
// established vocab unless there is a reason not to, and extend the tables here when one ships.

export const LINES = ['huddle', 'lead2', 'shift-fuel'];
export const GARMENTS = ['crew-sweater', 'quarter-zip', 'vest'];
// 'group' is not a colour; it is the group-shot marker that occupies the colorway slot.
export const COLORWAYS = ['black', 'classic-navy', 'grey-heather', 'group'];
export const SHOTS = ['angled', 'closeup', 'flat', 'styled'];

// Multi-word vocab tokens, longest first, used only by the hyphen-fallback parser to repair
// all-hyphen source names (where the field separators were typed as '-' instead of '_').
const MULTIWORD_TOKENS = ['shift-fuel', 'crew-sweater', 'quarter-zip', 'classic-navy', 'grey-heather'];

// Known field-value typos we silently repair (kebab, per field). Extend as real ones surface.
const FIELD_TYPOS = new Map([
  ['quarterzip', 'quarter-zip'], // garment written without the internal hyphen
]);

// Colorway token (as it appears in the filename) -> the Admin Color option value that the
// storefront gallery filter matches alt text against. 'group' and any shared shot map to null
// (no value -> shared across every colour). This is the general map; per-product recognized
// values live in PRODUCTS below (the women's vest ships in Black only).
const COLORWAY_TO_ADMIN = new Map([
  ['black', 'Black'],
  ['classic-navy', 'Classic Navy'],
  ['grey-heather', 'Grey Heather'],
  ['group', null],
]);

// Resolved product targets, keyed '<line>/<garment>'. handle is the resolution key for the
// Admin API; gid is the recorded product GID (verified against the handle lookup at upload
// time, never trusted blind, never resolved by display title). colorValues is the set of
// Admin Color option values reserved on that product; it is what the alt-colour guard checks
// a non-group alt string against. These value sets are provisional: the uploader re-reads the
// live option values and fails loudly on any drift before writing. Public data (product IDs
// and handles render on the storefront).
export const PRODUCTS = {
  'lead2/crew-sweater': {
    line: 'lead2', garment: 'crew-sweater',
    title: 'Lead II Crewneck', handle: 'lead-ii-crewneck',
    gid: 'gid://shopify/Product/10209039483180',
    colorValues: ['Black', 'Grey Heather', 'Classic Navy'],
  },
  'lead2/quarter-zip': {
    line: 'lead2', garment: 'quarter-zip',
    title: 'Lead II Quarter-Zip', handle: 'lead-ii-quarter-zip',
    gid: 'gid://shopify/Product/10401392263468',
    colorValues: ['Black', 'Grey Heather', 'Classic Navy'],
  },
  'lead2/vest': {
    line: 'lead2', garment: 'vest',
    title: "Lead II Vest - Women's", handle: 'lead-ii-vest-womens',
    gid: 'gid://shopify/Product/10401393377580',
    colorValues: ['Black'], // deliberate divergence: sold in Black only
  },
  'shift-fuel/crew-sweater': {
    line: 'shift-fuel', garment: 'crew-sweater',
    title: 'Shift Fuel Crewneck', handle: 'shift-fuel-crewneck',
    gid: 'gid://shopify/Product/10231499882796',
    colorValues: ['Black', 'Grey Heather', 'Classic Navy'],
  },
  'huddle/crew-sweater': {
    line: 'huddle', garment: 'crew-sweater',
    title: 'Huddle Crewneck', handle: 'huddle-crewneck',
    gid: 'gid://shopify/Product/10231493787948',
    colorValues: ['Black', 'Grey Heather', 'Classic Navy'],
  },
};

// --- lookups -----------------------------------------------------------------------------

// The Admin Color value for a colorway token, or null for group/shared. Pass a productKey to
// honour a per-product divergence (a value not reserved on that product resolves to null, so
// the photo is treated as shared there rather than bound to a colour the product does not sell).
export function colorwayToAdminValue(colorway, productKey) {
  const value = COLORWAY_TO_ADMIN.has(colorway) ? COLORWAY_TO_ADMIN.get(colorway) : null;
  if (value === null) return null;
  if (productKey && PRODUCTS[productKey] && !PRODUCTS[productKey].colorValues.includes(value)) {
    return null;
  }
  return value;
}

// The product record for a line+garment pair, or null if the pair is not a known product.
export function productForLineGarment(line, garment) {
  return PRODUCTS[`${line}/${garment}`] || null;
}

// Reverse lookup: the product entry for an Admin handle, as { key, record }, or null when no
// recorded product uses that handle. The uploader resolves manifest rows by handle, and the
// shared-asset alt guard needs the product key back from a row that carries only the handle.
export function productForHandle(handle) {
  const found = Object.entries(PRODUCTS).find(([, p]) => p.handle === handle);
  return found ? { key: found[0], record: found[1] } : null;
}

// The recognized Admin Color values for a product key (used by the alt-colour guard).
export function recognizedColorValues(productKey) {
  return PRODUCTS[productKey] ? [...PRODUCTS[productKey].colorValues] : [];
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
export function altColorProblem(alt, expected, productKey) {
  if (!alt || !alt.trim()) return null;
  const matched = matchedColorValues(alt, recognizedColorValues(productKey));
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
function fieldsFromHyphenated(base) {
  let rest = base.toLowerCase();
  const fields = [];
  while (rest.length) {
    let matched = null;
    for (const token of MULTIWORD_TOKENS) {
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
 *   { line, garment, colorway, design, shot, index, fields, warnings, ok, uncertain }
 * `fields` is the corrected, ordered field list used to build the canonical names. `ok` is
 * false when the name could not be parsed into a plausible structure at all. `uncertain` is
 * true when a warning reflects genuine ambiguity (unknown token, missing index, unparseable);
 * it is NOT set by confident repairs (separator misuse, a known typo), which are safe to apply
 * to a source file. `--rename-originals` renames only when `ok && !uncertain`.
 */
export function parseName(filename) {
  const warnings = [];
  let uncertain = false;
  const dot = filename.lastIndexOf('.');
  const base = dot === -1 ? filename : filename.slice(0, dot);

  // Prefer underscore fields; fall back to hyphen recovery when there is no usable underscore
  // structure (the all-hyphen separator-misuse case). A hyphen repair is confident, not uncertain.
  let rawFields = base.split('_').filter((f) => f.length);
  if (rawFields.length < 4) {
    const recovered = fieldsFromHyphenated(base);
    if (recovered && recovered.length >= 4) {
      warnings.push('field separators were hyphens; expected underscores between fields');
      rawFields = recovered;
    }
  }
  rawFields = rawFields.map(repairToken);

  if (rawFields.length < 4 || rawFields.length > 5) {
    warnings.push(`expected 4 or 5 fields, found ${rawFields.length}: could not parse convention`);
    return { line: null, garment: null, colorway: null, design: null, shot: null, index: null, fields: rawFields, warnings, ok: false, uncertain: true };
  }

  const [line, garment, colorway] = rawFields;
  const shotField = rawFields[rawFields.length - 1];
  const design = rawFields.length === 5 ? rawFields[3] : null;

  const m = INDEX_RE.exec(shotField);
  let shot = shotField;
  let index = null;
  if (m) { shot = m[1]; index = Number(m[2]); }
  else { warnings.push(`shot field "${shotField}" has no -<index> suffix`); uncertain = true; }

  if (!LINES.includes(line)) { warnings.push(`unknown line "${line}"`); uncertain = true; }
  if (!GARMENTS.includes(garment)) { warnings.push(`unknown garment "${garment}"`); uncertain = true; }
  if (!COLORWAYS.includes(colorway)) { warnings.push(`unknown colorway "${colorway}"`); uncertain = true; }
  if (shot && !SHOTS.includes(shot)) { warnings.push(`unknown shot "${shot}"`); uncertain = true; }
  if (colorway === 'group' && design !== null) {
    warnings.push('group shot should not carry a design field'); uncertain = true;
  }

  return { line, garment, colorway, design, shot, index, fields: rawFields, warnings, ok: true, uncertain };
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
export function normalizeName(filename) {
  const parsed = parseName(filename);
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
