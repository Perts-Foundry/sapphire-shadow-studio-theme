// What an article IS, for comparison: the same shape built from the repo and from a live read.
// Pure: no fs, no fetch, no process.env.
//
// ONE PROJECTION, EVERY FIELD THE PUSH WRITES. The policies push compared bodies, and a no-op check
// that compares only the body reports "nothing to do" while the title, the tags or the SEO
// description are stale. So the no-op path, the freshness hash, the dry run, the re-read
// verification and status all read this one list, and a field the push starts sending must be added
// here or every one of those goes blind to it.
//
// THE BODY IS COMPARED STRUCTURALLY, NOT BY BYTES. The live spike showed Shopify stores a body
// verbatim with one exception: it inserts newlines between table rows and cells. A byte comparison
// would therefore report every article with a table as permanently changed. `bodiesEquivalent` is
// byte-identical outside table subtrees and whitespace-insensitive inside them, and it FAILS CLOSED
// on anything it was not designed for: an unclosed or nested table is compared as bytes. The checker
// refuses `<pre>` and nested tables in bodies until a second spike proves them, so this comparator
// never meets that input from a clean tree.

import { canonicalise, sha256, stripVersionQuery } from './articles.mjs';

/** Every field the push writes, in hash order. */
export const WRITTEN_FIELDS = Object.freeze([
  'handle', 'title', 'author', 'summary', 'tags', 'templateSuffix',
  'seoTitle', 'seoDescription', 'imageUrl', 'imageAlt', 'body', 'isPublished',
]);

const nonEmpty = (v) => (typeof v === 'string' && v !== '' ? v : null);

/**
 * The repo's article, projected.
 *
 * `isPublished` is always false: the tooling only ever writes hidden articles, so the value the repo
 * means is the value the mutation sends. Empty strings project as null, because Shopify returns null
 * for an unset summary or metafield and "" versus null is not a difference anyone meant.
 *
 * @param {{article: object, body: string, images: object}} files  parsed article.json, body.html text, parsed images.json
 */
export function repoProjection({ article, body, images }) {
  const imageUrl = nonEmpty(stripVersionQuery(article?.image ?? ''));
  const entry = imageUrl === null
    ? null
    : ((images?.images ?? []).find((e) => stripVersionQuery(e?.url) === imageUrl) ?? null);
  return {
    handle: article?.handle ?? null,
    title: nonEmpty(article?.title),
    author: nonEmpty(article?.author),
    summary: nonEmpty(article?.summary),
    tags: Array.isArray(article?.tags) ? [...article.tags] : [],
    templateSuffix: nonEmpty(article?.templateSuffix),
    seoTitle: nonEmpty(article?.seo?.title),
    seoDescription: nonEmpty(article?.seo?.description),
    imageUrl,
    imageAlt: imageUrl === null ? null : nonEmpty(entry?.alt),
    body: canonicalise(body),
    isPublished: false,
  };
}

/** A live article node (the selection in queries.mjs), projected. */
export function liveProjection(node) {
  const imageUrl = node?.image?.url ? nonEmpty(stripVersionQuery(node.image.url)) : null;
  return {
    handle: node?.handle ?? null,
    title: nonEmpty(node?.title),
    author: nonEmpty(node?.author?.name),
    summary: nonEmpty(node?.summary),
    tags: Array.isArray(node?.tags) ? [...node.tags] : [],
    templateSuffix: nonEmpty(node?.templateSuffix),
    seoTitle: nonEmpty(node?.titleTag?.value),
    seoDescription: nonEmpty(node?.descriptionTag?.value),
    imageUrl,
    imageAlt: imageUrl === null ? null : nonEmpty(node?.image?.altText),
    body: canonicalise(node?.body ?? ''),
    isPublished: node?.isPublished === true,
  };
}

/**
 * The hash of a projection, over every written field in WRITTEN_FIELDS order.
 *
 * TAGS ARE SORTED for the hash and for comparison: whether Shopify preserves tag order is unproven,
 * and a store that sorted them would otherwise make every article with two tags permanently stale.
 * The body is hashed as bytes; use `bodiesEquivalent` where a repo body meets a live one.
 */
export function projectionSha(projection) {
  const ordered = {};
  for (const field of WRITTEN_FIELDS) {
    ordered[field] = field === 'tags' ? [...(projection?.tags ?? [])].sort() : (projection?.[field] ?? null);
  }
  return sha256(JSON.stringify(ordered));
}

const TABLE_OPEN = /<table\b/i;
const TABLE_CLOSE = /<\/table\s*>/i;

/**
 * A body split into table and non-table segments, or null when the tables are not flat and closed.
 * @param {string} body
 * @returns {Array<{table: boolean, text: string}>|null}
 */
export function tableSegments(body) {
  const text = String(body ?? '');
  const out = [];
  let pos = 0;
  for (;;) {
    const rest = text.slice(pos);
    const open = rest.search(TABLE_OPEN);
    const strayClose = rest.search(TABLE_CLOSE);
    if (open === -1) {
      if (strayClose !== -1) return null;
      out.push({ table: false, text: rest });
      return out;
    }
    if (strayClose !== -1 && strayClose < open) return null;
    out.push({ table: false, text: rest.slice(0, open) });
    const afterOpen = rest.slice(open + 1);
    const close = afterOpen.search(TABLE_CLOSE);
    if (close === -1) return null;
    const nested = afterOpen.slice(0, close).search(TABLE_OPEN);
    if (nested !== -1) return null;
    const closeMatch = afterOpen.slice(close).match(TABLE_CLOSE);
    const end = open + 1 + close + closeMatch[0].length;
    out.push({ table: true, text: rest.slice(open, end) });
    pos += end;
  }
}

/** A table subtree with whitespace made insignificant: removed beside a tag, collapsed elsewhere. */
function normaliseTable(text) {
  return text.replace(/\s+(?=<)|(?<=>)\s+/g, '').replace(/\s+/g, ' ');
}

/**
 * True when two bodies differ, and the differences are whitespace inside table subtrees only.
 *
 * Structural: both bodies must split into the same sequence of table and non-table segments, every
 * non-table segment must be byte-identical, and every table segment must be equal once whitespace is
 * made insignificant. Anything the splitter refuses (a nested or unclosed table) is not
 * "table whitespace only", so this returns false for it.
 */
export function differsOnlyByTableWhitespace(a, b) {
  if (a === b) return false;
  const sa = tableSegments(a);
  const sb = tableSegments(b);
  if (sa === null || sb === null || sa.length !== sb.length) return false;
  return sa.every((seg, i) => {
    const other = sb[i];
    if (seg.table !== other.table) return false;
    return seg.table ? normaliseTable(seg.text) === normaliseTable(other.text) : seg.text === other.text;
  });
}

/** Byte-equal, or different only by table whitespace. */
export function bodiesEquivalent(a, b) {
  return a === b || differsOnlyByTableWhitespace(a, b);
}

/**
 * Whether the featured image differs, given what is known about where Admin's copy came from.
 *
 * SHOPIFY RE-HOSTS A FEATURED IMAGE SET BY URL (verified on the 2026-09-12 spike): it copies the file
 * to its own `articles/` CDN path, so the live `image.url` never equals the URL the repo sent. An
 * equality comparison would make the no-op gate never fire, the re-read after every push with an
 * image fail, and `verify --live` always report a difference. So the comparison is:
 *
 *   one side has an image and the other does not        differs
 *   neither has one                                      same
 *   both, and Admin holds the very URL the repo names    same
 *   both, and `imageSource` (the repo URL Admin's copy   same when it equals the repo URL now,
 *   was last made from) is known                         differs otherwise: the repo's image changed
 *   both, and nothing records where the copy came from   differs, so the push sends the image again
 *
 * FAIL CLOSED: an omitted `imageSource` is "unknown", never "same". A caller that knows the source
 * (the re-read right after sending it) says so explicitly.
 *
 * @param {object} repo
 * @param {object} live
 * @param {string|null|undefined} imageSource
 */
export function imageDiffers(repo, live, imageSource) {
  if ((repo.imageUrl === null) !== (live.imageUrl === null)) return true;
  if (repo.imageUrl === null) return false;
  if (repo.imageUrl === live.imageUrl) return false;
  return typeof imageSource !== 'string' || imageSource !== repo.imageUrl;
}

/**
 * The written fields on which two projections differ, in WRITTEN_FIELDS order.
 *
 * @param {object} repo
 * @param {object} live
 * @param {{ignore?: string[], imageSource?: string|null}} [options]
 *   `ignore`: fields to leave out, e.g. `isPublished` for a report. `imageSource`: the repo image URL
 *   Admin's re-hosted copy was last made from, or null/absent when unknown (see `imageDiffers`).
 */
export function fieldDifferences(repo, live, { ignore = [], imageSource = null } = {}) {
  const out = [];
  for (const field of WRITTEN_FIELDS) {
    if (ignore.includes(field)) continue;
    if (field === 'body') {
      if (!bodiesEquivalent(repo.body, live.body)) out.push(field);
    } else if (field === 'imageUrl') {
      if (imageDiffers(repo, live, imageSource)) out.push(field);
    } else if (field === 'tags') {
      if (JSON.stringify([...repo.tags].sort()) !== JSON.stringify([...live.tags].sort())) out.push(field);
    } else if (repo[field] !== live[field]) {
      out.push(field);
    }
  }
  return out;
}
