// Pure rules behind marketing/articles/. No fs, no fetch, no process.env, no process.argv.
//
// Lib rules, matching scripts/policies/lib/ and scripts/site-check/lib/: everything here is a
// function of its arguments, so the offline checker cannot become an online one by mistake. check.mjs
// owns the filesystem; this file owns what is true about an article.
//
// WHY THE RULES ARE THIS STRICT. An article body is rendered RAW by Shopify: whatever bytes are
// stored are emitted into the page. A `<script>` tag in a body is a script tag on the storefront,
// verified on a live spike. So the safety rules here are not lint, they are the only thing between
// a repo edit and executable content on a customer-facing page, and every one of them fails closed.
//
// AND THIS IS A PUBLIC REPO. Blog prose is the likeliest leak class in the whole tree: it is long,
// it is written in a hurry, and it is the one place an operator naturally types an address or a
// phone number. The sensitive-content rules exist for that and are deliberately blunt.
//
// EVERY REFUSAL CARRIES A RULE ID from `RULES`. A finding with no id, or an id not in that frozen
// map, is itself a bug: the meta-test walks the map and asserts each id has a fixture that trips it
// and nothing else, which is only possible if the ids are a closed set.

import { createHash } from 'node:crypto';

import { ID_RE } from '../../lib/catalogue-manifest.mjs';
import { hasEmDash } from '../../lib/prose.mjs';
import { TITLE_MAX, DESC_MIN, DESC_MAX } from '../../lib/seo-bounds.mjs';
import { STOREFRONT_HANDLES } from '../../policies/lib/policies.mjs';
import {
  ALLOWED_ELEMENTS,
  NESTED_TABLE_REFUSED,
  URL_ATTRIBUTE_BY_ELEMENT,
  allowedAttributesFor,
  decodeUrl,
  readMarkup,
  urlRefusal,
} from './body-markup.mjs';

/**
 * The blog every article in this repo belongs to.
 *
 * ONE CONSTANT, pinned by a unit test. The previous blog (`news`) was deleted in Admin on
 * 2026-09-13 and this one created in its place, which changed the blog's GID. Nothing in this repo
 * memorises a GID for exactly that reason: the push resolves the blog by handle at write time and
 * refuses if the handle resolves to zero blogs or to more than one.
 */
export const BLOG_HANDLE = 'shift-notes';

/** Where articles live, relative to the repo root. */
export const ARTICLES_DIR = 'marketing/articles';

/** Files directly under ARTICLES_DIR that are not an article directory. */
export const NON_ARTICLE_FILES = Object.freeze(['README.md', 'manifest.json']);

/** The three files every article directory holds. */
export const ARTICLE_FILES = Object.freeze(['body.html', 'article.json', 'images.json']);

/** Exactly the keys `article.json` may carry. Unknown keys are a refusal, never ignored. */
export const ARTICLE_KEYS = Object.freeze([
  'handle', 'title', 'author', 'summary', 'tags', 'templateSuffix',
  'seo', 'image', 'previousHandles',
]);

/**
 * The fields `metaSha256` covers, named explicitly.
 *
 * THE LIST IS THE CONTRACT. A field absent from it is invisible to both `reindex --check` and the
 * checker's hashes-agree rule, so it could be edited in the repo and neither would notice. Adding a
 * field to `article.json` means adding it here in the same change; a test asserts this list and
 * ARTICLE_KEYS stay in step.
 */
export const META_FIELDS = Object.freeze([
  'handle', 'title', 'author', 'summary', 'tags', 'templateSuffix',
  'seo', 'image', 'previousHandles',
]);

/** The only host an article image may be served from. */
export const IMAGE_HOST = 'cdn.shopify.com';

/**
 * Every rule this subsystem can refuse on.
 *
 * Ids are stable strings: a fixture names one, the meta-test walks this map, and a report groups by
 * it. Renaming one is a breaking change to the fixtures, which is the point.
 */
export const RULES = Object.freeze({
  // Structure
  DIR_NAME_MISMATCH: 'structure/dir-name-mismatch',
  HANDLE_SHAPE: 'structure/handle-shape',
  MISSING_FILE: 'structure/missing-file',
  UNEXPECTED_FILE: 'structure/unexpected-file',
  MANIFEST_ORPHAN: 'structure/manifest-orphan',
  DIRECTORY_UNLISTED: 'structure/directory-unlisted',
  NOT_CANONICAL: 'structure/not-canonical',
  BODY_SHA_MISMATCH: 'structure/body-sha-mismatch',
  BODY_LENGTH_MISMATCH: 'structure/body-length-mismatch',
  META_SHA_MISMATCH: 'structure/meta-sha-mismatch',
  UNKNOWN_KEY: 'structure/unknown-key',
  PREVIOUS_HANDLE_SHAPE: 'structure/previous-handle-shape',
  PREVIOUS_HANDLE_SELF: 'structure/previous-handle-self',
  PREVIOUS_HANDLE_COLLISION: 'structure/previous-handle-collision',
  IMAGES_MISMATCH: 'structure/images-mismatch',
  JSON_INVALID: 'structure/json-invalid',
  FIELD_TYPE: 'structure/field-type',

  // Safety, because the body renders raw
  MALFORMED_MARKUP: 'safety/malformed-markup',
  FORBIDDEN_ELEMENT: 'safety/forbidden-element',
  FORBIDDEN_ATTRIBUTE: 'safety/forbidden-attribute',
  DUPLICATE_ATTRIBUTE: 'safety/duplicate-attribute',
  EVENT_HANDLER: 'safety/event-handler',
  DANGEROUS_URL: 'safety/dangerous-url',

  // Prose
  EM_DASH: 'prose/em-dash',
  BODY_H1: 'prose/body-h1',
  HEADING_SKIP: 'prose/heading-skip',

  // Sensitive content, because this repo is public
  EMAIL_SHAPED: 'sensitive/email-shaped',
  PHONE_SHAPED: 'sensitive/phone-shaped',
  MACHINE_PATH: 'sensitive/machine-path',

  // Media
  IMG_MISSING_ALT: 'media/img-missing-alt',
  IMG_SRC_UNKNOWN: 'media/img-src-unknown',
  IMAGE_ORPHAN: 'media/image-orphan',
  FEATURED_IMAGE_UNRESOLVED: 'media/featured-image-unresolved',
  IMAGE_HOST: 'media/image-host',

  // Metadata
  TITLE_EMPTY: 'meta/title-empty',
  SUMMARY_EMPTY: 'meta/summary-empty',
  AUTHOR_EMPTY: 'meta/author-empty',
  TAG_DUPLICATE: 'meta/tag-duplicate',
  SEO_TITLE_LONG: 'meta/seo-title-long',
  SEO_DESC_SHORT: 'meta/seo-desc-short',
  SEO_DESC_LONG: 'meta/seo-desc-long',
  TEMPLATE_SUFFIX_UNKNOWN: 'meta/template-suffix-unknown',

  // Links
  PRODUCT_LINK_UNKNOWN: 'link/product-unknown',
  POLICY_LINK_UNKNOWN: 'link/policy-unknown',
  RELATIVE_ROOT_UNKNOWN: 'link/relative-root-unknown',
  EXTERNAL_NOT_HTTPS: 'link/external-not-https',
});

/** Every rule id, for the meta-test and for report grouping. */
export const ALL_RULE_IDS = Object.freeze(Object.values(RULES));

/** A finding. `handle` is null for a tree-level refusal that belongs to no one article. */
export function finding(rule, handle, detail) {
  return { rule, handle, detail };
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The one canonical form of a body, matching marketing/policies/: drop a leading BOM, CRLF and lone
 * CR to LF, strip trailing whitespace at the END of the document only.
 *
 * Per-line trailing whitespace is NOT stripped: a space before a newline is significant between
 * inline elements, and tidying it would change what the storefront renders.
 */
export function canonicalise(body) {
  let text = String(body ?? '');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
}

/** The bytes `body.html` holds for a body: canonical plus one trailing newline. */
export function fileTextFor(body) {
  return `${canonicalise(body)}\n`;
}

/** The body a `body.html` file holds. Inverse of `fileTextFor` for any canonical body. */
export function bodyFromFileText(text) {
  return canonicalise(text);
}

/**
 * The canonical projection of an article's metadata, as the exact JSON `metaSha256` is taken over.
 *
 * Key order is META_FIELDS order, not object order, so re-serialising `article.json` with keys in a
 * different order does not change the hash. Absent optional fields serialise as null rather than
 * being omitted, so "absent" and "null" hash the same and cannot drift apart.
 */
export function metaProjection(article) {
  const out = {};
  for (const key of META_FIELDS) out[key] = article?.[key] ?? null;
  return out;
}

export function metaSha256(article) {
  return sha256(JSON.stringify(metaProjection(article)));
}

/** Strip Shopify's cache-busting query so a recorded URL and a body's `src` compare equal. */
export function stripVersionQuery(url) {
  const s = String(url ?? '');
  const q = s.indexOf('?');
  return q === -1 ? s : s.slice(0, q);
}

// ------------------------------------------------------------------------------------------
// Safety. The body renders raw, so these are the load-bearing rules.
// ------------------------------------------------------------------------------------------

/**
 * The body's elements under the strict reading, or null when the body leaves the grammar.
 *
 * EVERY element-based rule reads the body through this, and nothing reads it any other way. The
 * version this replaced ran every rule over a lenient parser that recovers from broken markup in its
 * own way, which is not the way a browser recovers. The fix for "the checker and a browser read the
 * markup differently" is not a second opinion but a single reading that refuses to exist when it is
 * ambiguous. Null means the malformed-markup refusal has already been reported by `safetyFindings`,
 * and every other element rule then reports nothing for that body: it is refused either way, and a
 * heading or link finding computed past the point the reading stopped would be a guess presented as
 * a fact.
 */
export function bodyElements(body) {
  const { elements, error } = readMarkup(body);
  return error === null ? elements : null;
}

/**
 * The strict grammar, then the element and attribute allowlists, then the URL rules.
 *
 * ORDER OF THE ATTRIBUTE CHECKS. A name starting `on` is an event handler whatever the element, and
 * is reported as one: it is the case a reviewer most needs named. Otherwise a name not on the
 * element's allowlist is a forbidden attribute. Attributes of an element that is itself refused are
 * not examined: refusing the element refuses everything on it, and listing its attributes as well
 * would bury the one finding that matters under several that follow from it.
 *
 * EVERY VALUE OF A DUPLICATED NAME IS STILL CHECKED. Browsers keep the first of two same-named
 * attributes and a lenient walker may keep the last, so `<a href="javascript:..." href="https://...">`
 * is exactly the disagreement this subsystem exists to refuse. The duplicate is its own finding, and
 * the URL rule runs over both values rather than trusting either reader's pick.
 */
export function safetyFindings(body, handle) {
  const { elements, error } = readMarkup(body);
  if (error !== null) {
    return [finding(RULES.MALFORMED_MARKUP, handle, error.detail)];
  }
  const out = [];
  for (const el of elements) {
    if (!ALLOWED_ELEMENTS.includes(el.tag)) {
      out.push(finding(RULES.FORBIDDEN_ELEMENT, handle, `<${el.tag}> is not in the allowlist of elements an article body may contain`));
      continue;
    }
    if (el.nestedTable) {
      out.push(finding(RULES.FORBIDDEN_ELEMENT, handle, NESTED_TABLE_REFUSED));
      continue;
    }
    const allowed = allowedAttributesFor(el.tag);
    const seen = new Set();
    for (const [name, value] of el.attrs) {
      if (seen.has(name)) {
        out.push(finding(RULES.DUPLICATE_ATTRIBUTE, handle, `<${el.tag}> carries the attribute "${name}" more than once`));
      }
      seen.add(name);
      if (name.startsWith('on')) {
        out.push(finding(RULES.EVENT_HANDLER, handle, `<${el.tag}> carries the event-handler attribute "${name}"`));
        continue;
      }
      if (!allowed.includes(name)) {
        out.push(finding(RULES.FORBIDDEN_ATTRIBUTE, handle, `<${el.tag}> carries the attribute "${name}", which is not in its allowlist`));
        continue;
      }
      if (URL_ATTRIBUTE_BY_ELEMENT[el.tag] !== name) continue;
      const refusal = urlRefusal(el.tag, value ?? '');
      if (refusal === null) continue;
      const rule = refusal.kind === 'not-https' ? RULES.EXTERNAL_NOT_HTTPS : RULES.DANGEROUS_URL;
      out.push(finding(rule, handle, `<${el.tag} ${name}=${JSON.stringify(value ?? '')}> ${refusal.reason}`));
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Prose
// ------------------------------------------------------------------------------------------

/** Heading levels present in a body, in document order. Empty for a body the reading refused. */
export function headingLevels(body) {
  return (bodyElements(body) ?? [])
    .filter((el) => /^h[1-6]$/.test(el.tag))
    .map((el) => Number(el.tag.slice(1)));
}

/**
 * No `<h1>` in the body, and levels start at h2 and never skip.
 *
 * The `<h1>` is the article title, emitted by the template. A second one in the body gives the page
 * two, which is the exact defect `scripts/seo-review` reports as `h1-count`.
 */
export function headingFindings(body, handle) {
  const out = [];
  const levels = headingLevels(body);
  let previous = 1;
  for (const level of levels) {
    if (level === 1) {
      out.push(finding(RULES.BODY_H1, handle, 'the body carries an <h1>; the template emits the title heading'));
      continue;
    }
    if (level > previous + 1) {
      out.push(finding(RULES.HEADING_SKIP, handle, `heading level jumps from h${previous} to h${level}`));
    }
    previous = level;
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Sensitive content
// ------------------------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * A North American phone number in one of the separator styles people actually type.
 *
 * SEPARATORS ARE REQUIRED, and that is the whole design. The first version matched any run of eight
 * or more digits with optional punctuation, which reads a date (`2026-09-13`), a year range, a
 * cache-busting `?v=1726012345` and a CDN path (`/0123/4567/8901/`) as phone numbers. A rule that
 * fires on every image URL is a rule an author learns to reword around, and the rewording teaches
 * nothing. The digit lookarounds stop a longer number being read as a phone by its middle ten
 * digits.
 */
const PHONE_RE = /(?<!\d)(?:\+1[ .-]?)?(?:\(\d{3}\) ?\d{3}-\d{4}|\d{3}-\d{3}-\d{4}|\d{3}\.\d{3}\.\d{4}|\d{3} \d{3} \d{4})(?!\d)/;

/**
 * Machine paths that carry a username, as `[label, pattern]`.
 *
 * `/home/` needs a name segment after it and must not be the tail of a longer path, so a storefront
 * link such as `/pages/home/` is not a machine path. The drive letter in `C:\Users\` is matched in
 * either case because Windows tooling prints both.
 */
const MACHINE_PATHS = Object.freeze([
  ['/mnt/c/Users/', /\/mnt\/c\/Users\//],
  ['/c/Users/', /\/c\/Users\//],
  ['/Users/', /\/Users\//],
  ['C:\\Users\\', /[A-Za-z]:\\Users\\/],
  ['/home/<name>', /(?:^|[^A-Za-z0-9._/-])\/home\/[A-Za-z0-9._-]+/],
  ['~/repos/', /~\/repos\//],
]);

/**
 * Email-shaped, phone-shaped and machine-path strings.
 *
 * Blunt on purpose. This is a public repo and blog prose is where an address or a phone number gets
 * typed without thinking; a false positive costs one rewording, a false negative is published.
 */
export function sensitiveFindings(text, handle, where) {
  const out = [];
  const s = String(text ?? '');
  if (EMAIL_RE.test(s)) {
    out.push(finding(RULES.EMAIL_SHAPED, handle, `${where} contains an email-shaped string`));
  }
  if (PHONE_RE.test(s)) {
    out.push(finding(RULES.PHONE_SHAPED, handle, `${where} contains a phone-shaped string`));
  }
  for (const [label, re] of MACHINE_PATHS) {
    if (re.test(s)) {
      out.push(finding(RULES.MACHINE_PATH, handle, `${where} contains the machine path "${label}"`));
    }
  }
  return out;
}

/** Every authored string on an article, as `[label, value]`, for the prose and sensitive sweeps. */
export function authoredStrings(article) {
  const out = [
    ['title', article?.title],
    ['summary', article?.summary],
    ['author', article?.author],
    ['seo.title', article?.seo?.title],
    ['seo.description', article?.seo?.description],
  ];
  for (const [i, tag] of (article?.tags ?? []).entries()) out.push([`tags[${i}]`, tag]);
  return out;
}

/** The em-dash rule, over every authored string plus the body. */
export function emDashFindings(article, body, handle) {
  const out = [];
  for (const [label, value] of authoredStrings(article)) {
    if (hasEmDash(value)) out.push(finding(RULES.EM_DASH, handle, `${label} contains an em dash`));
  }
  if (hasEmDash(body)) out.push(finding(RULES.EM_DASH, handle, 'the body contains an em dash'));
  return out;
}

// ------------------------------------------------------------------------------------------
// Links
// ------------------------------------------------------------------------------------------

/** The policy handles a `/policies/<handle>` link may name. */
export const POLICY_HANDLES = Object.freeze(Object.values(STOREFRONT_HANDLES));

/** Relative roots an article body may link to. `/collections/` is shape-only, see below. */
export const KNOWN_RELATIVE_ROOTS = Object.freeze(['/products/', '/policies/', '/collections/', '/pages/', '/blogs/']);

/**
 * Classify one href.
 *
 * COLLECTIONS ARE SHAPE-ONLY, deliberately. catalogue.json is the census of products, not of
 * collections, so nothing offline can prove `/collections/x` resolves. `articles:verify --live` is
 * what answers that. Saying so here stops a later reader adding a rule that cannot be right.
 */
export function classifyLink(href) {
  const s = String(href ?? '').trim();
  if (s === '' || s.startsWith('#')) return { kind: 'fragment' };
  if (/^https?:\/\//i.test(s)) return { kind: 'external', https: /^https:\/\//i.test(s) };
  if (/^mailto:/i.test(s)) return { kind: 'mailto' };
  if (!s.startsWith('/')) return { kind: 'other' };
  const path = s.split(/[?#]/)[0];
  for (const root of KNOWN_RELATIVE_ROOTS) {
    if (path.startsWith(root)) {
      return { kind: 'relative', root, handle: path.slice(root.length).replace(/\/+$/, '') };
    }
  }
  return { kind: 'relative-unknown', path };
}

/** The first value of a named attribute on an element from `readMarkup`, or undefined. */
function attr(el, name) {
  const pair = el.attrs.find(([n]) => n === name);
  return pair === undefined ? undefined : (pair[1] ?? '');
}

/**
 * Every `href` in a body that passed the URL rules, `&amp;` decoded, in document order.
 *
 * An href the URL rules refused is left out rather than classified: it is already a refusal, and
 * classifying `javascript:x` as an unknown relative root would report one mistake twice.
 */
export function hrefsOf(body) {
  return (bodyElements(body) ?? [])
    .filter((el) => el.tag === 'a' && attr(el, 'href') !== undefined)
    .map((el) => attr(el, 'href'))
    .filter((href) => urlRefusal('a', href) === null)
    .map(decodeUrl);
}

/**
 * Every `<img>` in a body, as `{ src, alt }`, with `src` decoded, or null when the URL rules refused
 * it (for the same reason as `hrefsOf`). The alt is still returned, so the alt rules run either way.
 */
export function imagesOf(body) {
  return (bodyElements(body) ?? [])
    .filter((el) => el.tag === 'img')
    .map((el) => {
      const src = attr(el, 'src') ?? '';
      return { src: urlRefusal('img', src) === null ? decodeUrl(src) : null, alt: attr(el, 'alt') ?? '' };
    });
}

// ------------------------------------------------------------------------------------------
// Metadata
// ------------------------------------------------------------------------------------------

/** SEO length bounds, re-exported so a caller reads one module. */
export { TITLE_MAX, DESC_MIN, DESC_MAX };

/** Is this a usable handle? */
export function isHandle(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

/** The template file a suffix names, relative to the repo root, or null for no suffix. */
export function templateFileFor(templateSuffix) {
  if (templateSuffix === null || templateSuffix === undefined) return null;
  return `templates/article.${templateSuffix}.json`;
}

// ------------------------------------------------------------------------------------------
// Field types
// ------------------------------------------------------------------------------------------

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * The type refusals for a parsed `article.json`, as detail strings. Empty means every present field
 * has the type the format defines.
 *
 * WHY THIS RUNS BEFORE ANY OTHER METADATA RULE. Every rule after it reads a field as the type the
 * format promises: `.trim()` on a title, `.length` on an seo description, iteration over tags. The
 * first version trusted that promise, so a tag list written as a string was iterated a character
 * at a time and a numeric seo title was quietly skipped by the length rules. A type error is its
 * own refusal, and the checker reads nothing else from a file that failed one.
 *
 * ABSENT IS NOT A TYPE ERROR. A missing title, summary or author is the matching `meta/*-empty`
 * rule's to report, and every other field is optional; `undefined` is therefore accepted here and
 * only a present value of the wrong type is refused.
 */
export function articleFieldTypeErrors(article) {
  if (!isPlainObject(article)) return ['article.json must hold a JSON object'];
  const out = [];
  for (const key of ['title', 'author', 'summary']) {
    if (article[key] !== undefined && typeof article[key] !== 'string') out.push(`${key} must be a string`);
  }
  if (article.tags !== undefined && !isStringArray(article.tags)) out.push('tags must be an array of strings');
  if (article.previousHandles !== undefined && !isStringArray(article.previousHandles)) {
    out.push('previousHandles must be an array of strings');
  }
  for (const key of ['templateSuffix', 'image']) {
    if (article[key] !== undefined && article[key] !== null && typeof article[key] !== 'string') {
      out.push(`${key} must be a string or null`);
    }
  }
  if (article.seo !== undefined && article.seo !== null) {
    if (!isPlainObject(article.seo)) {
      out.push('seo must be an object or null');
    } else {
      for (const key of ['title', 'description']) {
        if (article.seo[key] !== undefined && typeof article.seo[key] !== 'string') out.push(`seo.${key} must be a string`);
      }
    }
  }
  return out;
}

/** The type refusals for a parsed `images.json`, as detail strings. Same contract as above. */
export function imagesFieldTypeErrors(images) {
  if (!isPlainObject(images) || !Array.isArray(images.images)) {
    return ['images.json must hold an object with an "images" array'];
  }
  const out = [];
  for (const [i, entry] of images.images.entries()) {
    if (!isPlainObject(entry)) {
      out.push(`images[${i}] must be an object`);
      continue;
    }
    if (typeof entry.url !== 'string') out.push(`images[${i}].url must be a string`);
    if (entry.alt !== undefined && typeof entry.alt !== 'string') out.push(`images[${i}].alt must be a string`);
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Media and the manifest
// ------------------------------------------------------------------------------------------

/**
 * Why a recorded image URL is not on the CDN, or null.
 *
 * PARSED, NOT SEARCHED. The first version asked whether the URL string contained the host name,
 * which `https://cdn.shopify.com.evil.example/`, `https://evil.example/cdn.shopify.com/` and
 * `https://cdn.shopify.com@evil.example/` all do. What matters is the host a browser will connect
 * to, and only a URL parser answers that.
 */
export function imageHostRefusal(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ''));
  } catch {
    return 'is not a parseable absolute URL';
  }
  if (parsed.protocol !== 'https:') return `uses ${parsed.protocol} rather than https:`;
  if (parsed.username !== '' || parsed.password !== '') return 'carries credentials before the host';
  if (parsed.hostname !== IMAGE_HOST) return `is served from ${parsed.hostname}, not ${IMAGE_HOST}`;
  return null;
}

/**
 * The recorded image URLs a manifest entry holds, version query stripped and sorted.
 *
 * Tolerant of a malformed `images.json` on purpose: this also runs inside reindex, which must write
 * a manifest for a tree the checker then refuses with a precise finding, rather than crash first.
 */
export function manifestImagesFor(images) {
  const list = Array.isArray(images?.images) ? images.images : [];
  return list.map((e) => stripVersionQuery(e?.url)).sort();
}

/**
 * The manifest entry one article's files imply.
 *
 * ONE DERIVATION, TWO CALLERS. `reindex` writes this and `articles:check` compares against it. Each
 * used to compute the entry for itself, and the checker's copy simply never looked at `images`, so
 * the recorded image list could drift from `images.json` with nothing refusing it. A single function
 * is what makes "the checker and the reindexer agree" true by construction rather than by review.
 */
export function manifestEntryFor(body, article, images) {
  return {
    bodySha256: sha256(body),
    bodyLength: body.length,
    metaSha256: metaSha256(article),
    images: manifestImagesFor(images),
  };
}
