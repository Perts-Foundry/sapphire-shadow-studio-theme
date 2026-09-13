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
import { parseHtml } from '../../notifications/html-walk.mjs';
import { hasEmDash } from '../../lib/prose.mjs';
import { TITLE_MAX, DESC_MIN, DESC_MAX } from '../../lib/seo-bounds.mjs';
import { STOREFRONT_HANDLES } from '../../policies/lib/policies.mjs';

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

/** Elements that may never appear in a body, as a tag OR as an attribute name. */
export const FORBIDDEN_ELEMENTS = Object.freeze(['script', 'iframe', 'object', 'embed', 'form', 'style', 'svg']);

/** Attributes carrying a URL, each of which is checked for a dangerous scheme. */
export const URL_ATTRIBUTES = Object.freeze(['href', 'src', 'srcset', 'xlink:href', 'formaction']);

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

  // Safety, because the body renders raw
  FORBIDDEN_ELEMENT: 'safety/forbidden-element',
  FORBIDDEN_ATTRIBUTE: 'safety/forbidden-attribute',
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
 * Forbidden elements and attributes, event handlers, dangerous URLs, inline SVG.
 *
 * Parsed rather than regexed. `parseHtml` lowercases every tag and attribute name, which is what
 * makes "no `on*` attribute in ANY case" a property of the parse rather than of a case-insensitive
 * regex that a novel spelling could slip past. The ambiguity in the plan is resolved deliberately:
 * a forbidden name is refused BOTH as an element and as an attribute, because `<div form="...">` is
 * not dangerous but is a strong signal that something generated markup nobody reviewed.
 */
export function safetyFindings(body, handle) {
  const out = [];
  const { elements } = parseHtml(String(body ?? ''));
  for (const el of elements) {
    if (FORBIDDEN_ELEMENTS.includes(el.tag)) {
      out.push(finding(RULES.FORBIDDEN_ELEMENT, handle, `<${el.tag}> is not allowed in an article body`));
    }
    for (const name of Object.keys(el.attrs)) {
      if (name.startsWith('on')) {
        out.push(finding(RULES.EVENT_HANDLER, handle, `<${el.tag}> carries the event-handler attribute "${name}"`));
        continue;
      }
      if (FORBIDDEN_ELEMENTS.includes(name)) {
        out.push(finding(RULES.FORBIDDEN_ATTRIBUTE, handle, `<${el.tag}> carries the attribute "${name}"`));
      }
    }
    for (const attr of URL_ATTRIBUTES) {
      const raw = el.attrs[attr];
      if (raw === undefined) continue;
      for (const value of attr === 'srcset' ? splitSrcset(raw) : [raw]) {
        const reason = dangerousUrlReason(value);
        if (reason !== null) {
          out.push(finding(RULES.DANGEROUS_URL, handle, `<${el.tag} ${attr}>: ${reason}`));
        }
      }
    }
  }
  return out;
}

/** A srcset is a comma-separated list of `url descriptor` pairs; only the URLs matter here. */
function splitSrcset(value) {
  return String(value)
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

/**
 * Why a URL is dangerous, or null.
 *
 * Leading whitespace and control characters are stripped first: browsers tolerate
 * `java\tscript:alert(1)` and a naive `startsWith` does not.
 */
export function dangerousUrlReason(value) {
  const raw = String(value ?? '');
  const collapsed = raw.replace(/[\s\u0000-\u001f]+/g, '').toLowerCase();
  if (collapsed.startsWith('javascript:')) return 'a javascript: URL';
  if (collapsed.startsWith('data:')) return 'a data: URL';
  if (collapsed.startsWith('vbscript:')) return 'a vbscript: URL';
  if (/^\/\/[^/]/.test(raw.trim())) return 'a protocol-relative //host URL; name the scheme';
  return null;
}

// ------------------------------------------------------------------------------------------
// Prose
// ------------------------------------------------------------------------------------------

/** Heading levels present in a body, in document order. */
export function headingLevels(body) {
  const { elements } = parseHtml(String(body ?? ''));
  return elements
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
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/;
const MACHINE_PATHS = Object.freeze(['/mnt/c/Users/', '/Users/', '~/repos/']);

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
  for (const p of MACHINE_PATHS) {
    if (s.includes(p)) {
      out.push(finding(RULES.MACHINE_PATH, handle, `${where} contains the machine path "${p}"`));
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

/** Every `href` in a body, in document order. */
export function hrefsOf(body) {
  const { elements } = parseHtml(String(body ?? ''));
  return elements.filter((el) => el.tag === 'a' && el.attrs.href !== undefined).map((el) => el.attrs.href);
}

/** Every `<img>` in a body, as `{ src, alt }`. */
export function imagesOf(body) {
  const { elements } = parseHtml(String(body ?? ''));
  return elements.filter((el) => el.tag === 'img').map((el) => ({ src: el.attrs.src ?? '', alt: el.attrs.alt ?? '' }));
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
