// Tier A3: repo-only cross-checks over the theme files, run by consistency.mjs. Pure over an
// injected `files` Map (repo-relative path -> text), the parsed catalogue manifest, the effective
// theme settings and the schema defaults: no fs, no fetch, no env here, so tests build synthetic
// trees in memory. Every check is exported on its own so a test can target it; runRepoChecks
// concatenates them all.
//
// Each check exists because the thing it compares fails silently (CLAUDE.md "Theme settings"
// lists them): announcement copy vs shipping settings, four dated vacation settings, the FAQ deep
// link, the price block's show_shipping_info per template, the catalogue census vs template files,
// the two hardcoded social lists, and the two mirrored locales.

import { makeFinding, skipFinding, sortFindings } from './finding.mjs';

// ---------------------------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------------------------

/**
 * Strip the comments Shopify writes into its JSON files (a leading `/* ... *\/` banner on
 * settings_data.json and the locale files, `//` line comments inside en.default.json) without
 * touching string contents, then JSON.parse. `//` inside a string ("https://...") is left alone.
 * @param {string} text
 */
export function parseShopifyJson(text) {
  let out = '';
  let i = 0;
  let inString = false;
  const s = String(text ?? '');
  while (i < s.length) {
    const ch = s[i];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += s[i + 1] ?? ''; i += 2; continue; }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; i += 1; continue; }
    if (ch === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    if (ch === '/' && s[i + 1] === '/') {
      const end = s.indexOf('\n', i);
      i = end === -1 ? s.length : end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return JSON.parse(out);
}

/** `{ id: default }` for every setting in settings_schema.json that declares a default. */
export function schemaDefaults(schemaJson) {
  const out = {};
  for (const group of Array.isArray(schemaJson) ? schemaJson : []) {
    for (const setting of Array.isArray(group.settings) ? group.settings : []) {
      if (setting && typeof setting.id === 'string' && setting.default !== undefined) out[setting.id] = setting.default;
    }
  }
  return out;
}

/**
 * settings_data.json `current` merged over the schema defaults. `current` may be a preset name
 * rather than an object; then the named preset supplies the values.
 */
export function effectiveSettings(schemaJson, dataJson) {
  const defaults = schemaDefaults(schemaJson);
  let current = dataJson && dataJson.current;
  if (typeof current === 'string') current = (dataJson.presets || {})[current] || {};
  return { ...defaults, ...(current && typeof current === 'object' ? current : {}) };
}

function parseJsonFile(files, path) {
  const text = files.get(path);
  if (text === undefined) return { missing: true };
  try { return { json: parseShopifyJson(text) }; } catch (err) { return { error: err.message }; }
}

/**
 * Walk every block of a template or section-group JSON document, depth first, yielding
 * { id, type, settings, path } where `path` is the section id followed by the block id chain
 * (joined with `/`), which is stable across editor re-saves because ids are.
 */
export function* walkBlocks(doc) {
  const sections = (doc && doc.sections) || {};
  function* walk(blocks, prefix) {
    for (const [id, block] of Object.entries(blocks || {})) {
      if (!block || typeof block !== 'object') continue;
      const path = `${prefix}/${id}`;
      yield { id, type: block.type, settings: block.settings || {}, path };
      yield* walk(block.blocks, path);
    }
  }
  for (const [sectionId, section] of Object.entries(sections)) {
    if (!section || typeof section !== 'object') continue;
    yield* walk(section.blocks, sectionId);
  }
}

/** Subject helper: `<path>#<fragment>`; neither part may carry whitespace. */
const subj = (path, fragment) => `${path}#${fragment}`;

const stripHtml = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/** Normalise "8", "8.0", "$8.00" and " 75.00 " to a two-decimal string, or null when not a number. */
export function normaliseAmount(value) {
  const n = Number(String(value ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n.toFixed(2) : null;
}

const AMOUNT_RE = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g;

/** Every `$<amount>` in a text, in order, normalised, with its character offset. */
export function extractAmounts(text) {
  const out = [];
  const plain = stripHtml(text);
  for (const m of plain.matchAll(AMOUNT_RE)) out.push({ amount: normaliseAmount(m[1]), index: m.index, text: plain });
  return out;
}

function shippingSettings(settings) {
  return {
    flat: normaliseAmount(settings.flat_rate_shipping ?? '8.00'),
    threshold: normaliseAmount(settings.free_shipping_threshold ?? '75.00'),
  };
}

// ---------------------------------------------------------------------------------------------
// 1. announcement-amounts
// ---------------------------------------------------------------------------------------------

export const HEADER_GROUP_PATH = 'sections/header-group.json';

/**
 * Each `_announcement` slide's amounts, as an ordered pair against (flat_rate_shipping,
 * free_shipping_threshold): a slide with two amounts must read [flat, threshold]; a slide with
 * one must read the flat rate when it says "flat rate" and the threshold when it says "free".
 */
export function checkAnnouncementAmounts({ files, settings }) {
  const check = 'announcement-amounts';
  const { missing, error, json } = parseJsonFile(files, HEADER_GROUP_PATH);
  if (missing) return [skipFinding(check, HEADER_GROUP_PATH, `${HEADER_GROUP_PATH} not found`)];
  if (error) return [makeFinding({ check, subject: HEADER_GROUP_PATH, message: `${HEADER_GROUP_PATH} does not parse`, evidence: error })];
  const { flat, threshold } = shippingSettings(settings);
  const out = [];
  for (const b of walkBlocks(json)) {
    if (b.type !== '_announcement') continue;
    const text = b.settings.text;
    const amounts = extractAmounts(text).map((a) => a.amount);
    if (!amounts.length) continue;
    const plain = stripHtml(text);
    let expected;
    if (amounts.length >= 2) expected = [flat, threshold];
    else if (/flat[\s-]*rate/i.test(plain)) expected = [flat];
    else if (/free/i.test(plain)) expected = [threshold];
    else expected = null;
    const ok = expected
      ? amounts.length === expected.length && amounts.every((a, i) => a === expected[i])
      : amounts.every((a) => a === flat || a === threshold);
    if (ok) continue;
    out.push(makeFinding({
      check,
      subject: subj(HEADER_GROUP_PATH, b.id),
      message: `announcement slide amounts [${amounts.join(', ')}] do not match settings flat_rate_shipping=${flat}, free_shipping_threshold=${threshold}`,
      evidence: plain,
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 2. template-shipping-amounts
// ---------------------------------------------------------------------------------------------

// A bare "flat" rather than "flat rate": copy writes "a flat $8.00 rate" with the amount inside
// the phrase. Sentence scoping (below) keeps the bare word from matching unrelated copy.
const SHIPPING_CONTEXT_RE = /ship|flat|free/i;
const SENTENCE_END_RE = /[.!?;]/;

/** True when the sentence holding the amount (between sentence-ending punctuation) mentions shipping. */
export function inShippingContext(text, index) {
  let start = index;
  while (start > 0 && !SENTENCE_END_RE.test(text[start - 1])) start -= 1;
  let end = index;
  while (end < text.length && !SENTENCE_END_RE.test(text[end])) end += 1;
  // A decimal point inside the amount itself ("$8.00") is not a sentence end.
  const after = text.slice(end).match(/^\.\d+/);
  if (after) {
    end += after[0].length;
    while (end < text.length && !SENTENCE_END_RE.test(text[end])) end += 1;
  }
  return SHIPPING_CONTEXT_RE.test(text.slice(start, end));
}

/**
 * Any `$<amount>` in product-template or FAQ block copy that sits in a shipping context and is
 * neither the flat rate nor the threshold. Non-shipping amounts (a price, a gift-card
 * denomination) are ignored.
 */
export function checkTemplateShippingAmounts({ files, settings }) {
  const check = 'template-shipping-amounts';
  const { flat, threshold } = shippingSettings(settings);
  const out = [];
  const paths = [...files.keys()].filter((p) => /^templates\/product\.[^/]+\.json$/.test(p) || p === 'templates/page.faq.json').sort();
  for (const path of paths) {
    const { error, json } = parseJsonFile(files, path);
    if (error) { out.push(makeFinding({ check, subject: path, message: `${path} does not parse`, evidence: error })); continue; }
    for (const b of walkBlocks(json)) {
      const bad = [];
      for (const value of Object.values(b.settings)) {
        if (typeof value !== 'string' || !value.includes('$')) continue;
        for (const a of extractAmounts(value)) {
          if (!inShippingContext(a.text, a.index)) continue;
          if (a.amount !== flat && a.amount !== threshold) bad.push({ amount: a.amount, text: a.text });
        }
      }
      if (!bad.length) continue;
      out.push(makeFinding({
        check,
        subject: subj(path, b.id),
        message: `shipping copy states ${bad.map((x) => `$${x.amount}`).join(', ')}; settings are flat_rate_shipping=${flat}, free_shipping_threshold=${threshold}`,
        evidence: bad[0].text,
      }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 3. vacation-date-sync / vacation-date-format
// ---------------------------------------------------------------------------------------------

/**
 * The pinned format for `vacation_processing_date`: "Month D, YYYY" (e.g. "March 3, 2027"), the
 * English long form the three prose settings embed verbatim. The setting is also the record of
 * what each customer agreed to (it lands on the order as a line-item property), so one spelling
 * everywhere is the point.
 */
export const VACATION_DATE_RE = /^(January|February|March|April|May|June|July|August|September|October|November|December) [1-9]\d?, \d{4}$/;
export const VACATION_DATE_PLACEHOLDER = '[SET DATE]';
export const VACATION_DATED_SETTINGS = ['vacation_popup_body', 'vacation_checkbox_terms', 'vacation_shipping_message'];

const isEnabled = (v) => v === true || v === 'true';

/**
 * With vacation mode on, `vacation_processing_date` must be a real date in the pinned format
 * and the three prose settings must each contain that exact string. Off: nothing is emitted.
 */
export function checkVacationDates({ settings }) {
  if (!isEnabled(settings.vacation_mode_enabled)) return [];
  const out = [];
  const date = String(settings.vacation_processing_date ?? '').trim();
  if (!date || date === VACATION_DATE_PLACEHOLDER) {
    out.push(makeFinding({
      check: 'vacation-date-sync',
      subject: 'vacation_processing_date',
      message: 'vacation mode is enabled but vacation_processing_date is still the placeholder',
      evidence: date,
    }));
  } else if (!VACATION_DATE_RE.test(date)) {
    out.push(makeFinding({
      check: 'vacation-date-format',
      subject: 'vacation_processing_date',
      message: 'vacation_processing_date does not match the pinned "Month D, YYYY" format',
      evidence: date,
    }));
  }
  for (const id of VACATION_DATED_SETTINGS) {
    const plain = stripHtml(settings[id]);
    if (plain.includes(VACATION_DATE_PLACEHOLDER)) {
      out.push(makeFinding({ check: 'vacation-date-sync', subject: id, message: `${id} still carries the [SET DATE] placeholder while vacation mode is enabled`, evidence: plain }));
      continue;
    }
    if (date && date !== VACATION_DATE_PLACEHOLDER && !plain.includes(date)) {
      out.push(makeFinding({ check: 'vacation-date-sync', subject: id, message: `${id} does not contain the vacation_processing_date "${date}"`, evidence: plain }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 4. vacation-faq-anchor
// ---------------------------------------------------------------------------------------------

export const FAQ_TEMPLATE_PATH = 'templates/page.faq.json';
export const VACATION_BLOCK_PATH = 'blocks/_vacation-announcement.liquid';
export const VACATION_FAQ_ANCHOR = 'away-from-studio';
export const VACATION_FAQ_LINK = `/pages/faq#${VACATION_FAQ_ANCHOR}`;
export const VACATION_FAQ_BLOCK_ID = 'faq_item_vacation';

const HREF_RE = /href\s*=\s*["']([^"']*)["']/gi;
const hrefsIn = (text) => [...String(text ?? '').matchAll(HREF_RE)].map((m) => m[1]);

/**
 * The FAQ entry keeps its anchor, and every vacation surface that links (the announcement slide
 * block, and the popup body / checkbox terms in both the schema default and the current value)
 * links to exactly that anchor.
 */
export function checkVacationFaqAnchor({ files, settings, schemaDefaults: defaults = {} }) {
  const check = 'vacation-faq-anchor';
  const out = [];
  const faq = parseJsonFile(files, FAQ_TEMPLATE_PATH);
  if (faq.missing) out.push(skipFinding(check, FAQ_TEMPLATE_PATH, `${FAQ_TEMPLATE_PATH} not found`));
  else if (faq.error) out.push(makeFinding({ check, subject: FAQ_TEMPLATE_PATH, message: `${FAQ_TEMPLATE_PATH} does not parse`, evidence: faq.error }));
  else {
    const block = [...walkBlocks(faq.json)].find((b) => b.id === VACATION_FAQ_BLOCK_ID);
    if (!block) {
      out.push(makeFinding({ check, subject: subj(FAQ_TEMPLATE_PATH, VACATION_FAQ_BLOCK_ID), message: `${FAQ_TEMPLATE_PATH} has no block ${VACATION_FAQ_BLOCK_ID}` }));
    } else if (block.settings.custom_anchor !== VACATION_FAQ_ANCHOR) {
      out.push(makeFinding({ check, subject: subj(FAQ_TEMPLATE_PATH, VACATION_FAQ_BLOCK_ID), message: `${VACATION_FAQ_BLOCK_ID} custom_anchor is not "${VACATION_FAQ_ANCHOR}"`, evidence: String(block.settings.custom_anchor ?? '') }));
    }
  }

  const liquid = files.get(VACATION_BLOCK_PATH);
  if (liquid === undefined) out.push(skipFinding(check, VACATION_BLOCK_PATH, `${VACATION_BLOCK_PATH} not found`));
  else {
    const hrefs = hrefsIn(liquid);
    if (!hrefs.includes(VACATION_FAQ_LINK)) {
      out.push(makeFinding({ check, subject: VACATION_BLOCK_PATH, message: `${VACATION_BLOCK_PATH} does not link to ${VACATION_FAQ_LINK}`, evidence: hrefs.join(' ') || '(no href)' }));
    }
  }

  for (const id of ['vacation_popup_body', 'vacation_checkbox_terms']) {
    for (const [source, value] of [['settings_schema', defaults[id]], ['settings_data', settings[id]]]) {
      const hrefs = hrefsIn(value);
      if (hrefs.length && !hrefs.includes(VACATION_FAQ_LINK)) {
        out.push(makeFinding({ check, subject: `${source}:${id}`, message: `${id} (${source}) links somewhere other than ${VACATION_FAQ_LINK}`, evidence: hrefs.join(' ') }));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 5. price-show-shipping-info
// ---------------------------------------------------------------------------------------------

const PRODUCT_TEMPLATE_RE = /^templates\/product(?:\.([^/]+))?\.json$/;

function productForTemplate(catalogue, suffix) {
  for (const p of catalogue.products.values()) if (p.template === suffix) return p;
  return null;
}

/**
 * Every `price` block: `show_shipping_info` true on a garment product template, false anywhere
 * else (there it sits inside a product card), exempt on a non-garment (gift card) template, and
 * an absent key is reported as absent rather than read as false.
 */
export function checkPriceShowShippingInfo({ files, catalogue }) {
  const check = 'price-show-shipping-info';
  const out = [];
  const paths = [...files.keys()].filter((p) => /^templates\/[^/]+\.json$/.test(p)).sort();
  for (const path of paths) {
    const m = PRODUCT_TEMPLATE_RE.exec(path);
    let expected;
    if (m) {
      const product = m[1] ? productForTemplate(catalogue, m[1]) : null;
      if (product && product.body === null) continue; // gift card: exempt
      expected = true;
    } else {
      expected = false;
    }
    const { error, json } = parseJsonFile(files, path);
    if (error) { out.push(makeFinding({ check, subject: path, message: `${path} does not parse`, evidence: error })); continue; }
    for (const b of walkBlocks(json)) {
      if (b.type !== 'price') continue;
      const actual = b.settings.show_shipping_info;
      if (actual === expected) continue;
      const message = actual === undefined
        ? `price block has no show_shipping_info key (absent); expected ${expected} for this template`
        : `price block show_shipping_info is ${JSON.stringify(actual)}; expected ${expected} for this template`;
      out.push(makeFinding({ check, subject: subj(path, b.path), message }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 6. catalogue-template-missing / 7. catalogue-template-blocks
// ---------------------------------------------------------------------------------------------

/**
 * Block types each product template must contain, as a rule table over the catalogue product
 * entry ({ handle, line, body, template }). Rules are applied in order; `require` adds block
 * types, `exempt` removes them. Add a row for a new line or a documented exception.
 */
export const TEMPLATE_BLOCK_RULES = [
  // Every garment page sells through the same widget set.
  { name: 'garment', when: (p) => p.body !== null, require: ['variant-picker', 'buy-buttons', 'add-to-cart', 'return-policy-acknowledgment', 'vacation-acknowledgment', 'price'] },
  // The gift card has no return policy to acknowledge and no processing delay to accept.
  { name: 'non-garment', when: (p) => p.body === null, require: ['variant-picker', 'buy-buttons', 'add-to-cart', 'price'] },
  // Documented: the Shift Fuel page carries no return-policy acknowledgment block.
  { name: 'shift-fuel-no-return-policy', when: (p) => p.handle === 'shift-fuel-crewneck', exempt: ['return-policy-acknowledgment'] },
  // The Huddle line sells its applique pattern through its own picker block.
  { name: 'huddle-applique', when: (p) => p.handle === 'huddle-crewneck', require: ['applique-pattern-select'] },
  // Lead II products take a custom text property.
  { name: 'lead-ii-custom-property', when: (p) => p.handle.startsWith('lead-ii-'), require: ['product-custom-property'] },
];

/** The required block-type set for one catalogue product, from TEMPLATE_BLOCK_RULES. */
export function requiredBlockTypes(product, rules = TEMPLATE_BLOCK_RULES) {
  const set = new Set();
  for (const rule of rules) {
    if (!rule.when(product)) continue;
    for (const t of rule.require || []) set.add(t);
    for (const t of rule.exempt || []) set.delete(t);
  }
  return set;
}

export function checkCatalogueTemplateMissing({ files, catalogue }) {
  const out = [];
  for (const p of catalogue.products.values()) {
    const path = `templates/product.${p.template}.json`;
    if (!files.has(path)) {
      out.push(makeFinding({ check: 'catalogue-template-missing', subject: p.handle, message: `catalogue product ${p.handle} has no ${path}` }));
    }
  }
  return out;
}

export function checkCatalogueTemplateBlocks({ files, catalogue, rules = TEMPLATE_BLOCK_RULES }) {
  const check = 'catalogue-template-blocks';
  const out = [];
  for (const p of catalogue.products.values()) {
    const path = `templates/product.${p.template}.json`;
    if (!files.has(path)) continue; // catalogue-template-missing reports it
    const { error, json } = parseJsonFile(files, path);
    if (error) { out.push(makeFinding({ check, subject: path, message: `${path} does not parse`, evidence: error })); continue; }
    const present = new Set([...walkBlocks(json)].map((b) => b.type));
    for (const type of [...requiredBlockTypes(p, rules)].sort()) {
      if (!present.has(type)) {
        out.push(makeFinding({ check, subject: subj(path, type), message: `${path} (${p.handle}) has no block of type ${type}` }));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 8. social-list-parity
// ---------------------------------------------------------------------------------------------

export const SOCIAL_LINKS_PATH = 'snippets/social-links.liquid';
export const STRUCTURED_DATA_ORG_PATH = 'snippets/structured-data-organization.liquid';

/** The quoted comma list assigned to `name` in a Liquid file, split; null when absent. */
export function parseLiquidList(liquid, name) {
  const re = new RegExp(`assign\\s+${name}\\s*=\\s*'([^']*)'\\s*\\|\\s*split:\\s*','`);
  const m = re.exec(String(liquid ?? ''));
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

export function checkSocialListParity({ files }) {
  const check = 'social-list-parity';
  const out = [];
  const links = files.get(SOCIAL_LINKS_PATH);
  const org = files.get(STRUCTURED_DATA_ORG_PATH);
  if (links === undefined) return [skipFinding(check, SOCIAL_LINKS_PATH, `${SOCIAL_LINKS_PATH} not found`)];
  if (org === undefined) return [skipFinding(check, STRUCTURED_DATA_ORG_PATH, `${STRUCTURED_DATA_ORG_PATH} not found`)];
  const platforms = parseLiquidList(links, 'social_platforms');
  const keys = parseLiquidList(org, 'social_keys');
  if (!platforms) out.push(makeFinding({ check, subject: SOCIAL_LINKS_PATH, message: `could not find the social_platforms assign in ${SOCIAL_LINKS_PATH}` }));
  if (!keys) out.push(makeFinding({ check, subject: STRUCTURED_DATA_ORG_PATH, message: `could not find the social_keys assign in ${STRUCTURED_DATA_ORG_PATH}` }));
  if (!platforms || !keys) return out;
  const fromKeys = new Set(keys.map((k) => k.replace(/^social_/, '').replace(/_link$/, '')));
  const fromPlatforms = new Set(platforms);
  for (const p of fromPlatforms) {
    if (!fromKeys.has(p)) out.push(makeFinding({ check, subject: p, message: `${p} is in social_platforms (${SOCIAL_LINKS_PATH}) but social_keys (${STRUCTURED_DATA_ORG_PATH}) has no social_${p}_link` }));
  }
  for (const p of fromKeys) {
    if (!fromPlatforms.has(p)) out.push(makeFinding({ check, subject: p, message: `social_${p}_link is in social_keys (${STRUCTURED_DATA_ORG_PATH}) but ${p} is not in social_platforms (${SOCIAL_LINKS_PATH})` }));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 9. locale-key-missing / locale-key-todo
// ---------------------------------------------------------------------------------------------

export const DEFAULT_LOCALE_PATH = 'locales/en.default.json';
export const MIRRORED_LOCALES = ['it', 'ro'];

/** Dotted leaf keys of a nested object: { a: { b: 'x' } } -> Map('a.b' -> 'x'). */
export function flattenLeaves(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenLeaves(v, key, out);
    else out.set(key, v);
  }
  return out;
}

export function checkLocaleKeys({ files, locales = MIRRORED_LOCALES }) {
  const out = [];
  const base = parseJsonFile(files, DEFAULT_LOCALE_PATH);
  if (base.missing) return [skipFinding('locale-key-missing', DEFAULT_LOCALE_PATH, `${DEFAULT_LOCALE_PATH} not found`)];
  if (base.error) return [makeFinding({ check: 'locale-key-missing', subject: DEFAULT_LOCALE_PATH, message: `${DEFAULT_LOCALE_PATH} does not parse`, evidence: base.error, severity: 'ERROR' })];
  const baseLeaves = flattenLeaves(base.json);
  for (const locale of locales) {
    const path = `locales/${locale}.json`;
    const parsed = parseJsonFile(files, path);
    if (parsed.missing) { out.push(makeFinding({ check: 'locale-key-missing', subject: locale, message: `${path} not found` })); continue; }
    if (parsed.error) { out.push(makeFinding({ check: 'locale-key-missing', subject: locale, message: `${path} does not parse`, evidence: parsed.error, severity: 'ERROR' })); continue; }
    const leaves = flattenLeaves(parsed.json);
    for (const key of baseLeaves.keys()) {
      if (!leaves.has(key)) {
        out.push(makeFinding({ check: 'locale-key-missing', subject: `${locale}:${key}`, message: `${path} has no key ${key}` }));
      } else if (typeof leaves.get(key) === 'string' && leaves.get(key).startsWith('TODO:')) {
        out.push(makeFinding({ check: 'locale-key-todo', subject: `${locale}:${key}`, message: `${path} ${key} is still a TODO placeholder`, evidence: leaves.get(key) }));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// All of Tier A3
// ---------------------------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {Map<string,string>} o.files          repo-relative path -> file text
 * @param {object} o.catalogue                  parsed manifest (parseCatalogue / readCommittedCatalogue)
 * @param {object} o.settings                   effectiveSettings(schema, data)
 * @param {object} [o.schemaDefaults]           schemaDefaults(schema)
 */
export function runRepoChecks({ files, catalogue, settings, schemaDefaults: defaults = {} }) {
  const ctx = { files, catalogue, settings, schemaDefaults: defaults };
  return sortFindings([
    ...checkAnnouncementAmounts(ctx),
    ...checkTemplateShippingAmounts(ctx),
    ...checkVacationDates(ctx),
    ...checkVacationFaqAnchor(ctx),
    ...checkPriceShowShippingInfo(ctx),
    ...checkCatalogueTemplateMissing(ctx),
    ...checkCatalogueTemplateBlocks(ctx),
    ...checkSocialListParity(ctx),
    ...checkLocaleKeys(ctx),
  ]);
}
