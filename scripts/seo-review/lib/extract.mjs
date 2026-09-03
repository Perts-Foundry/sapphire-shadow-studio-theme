// extract.mjs -- pure HTML/XML extractors for the SEO review crawl.
//
// WHY hand-rolled: the repo's only runtime dep is sharp and node has no DOMParser.
// Every extractor here targets one specific, well-formed pattern this theme emits
// (Shopify-rendered HTML, not arbitrary web content), is tolerant of attribute
// order, and is covered by fixture tests. Nothing here does I/O.

/**
 * Parse the attributes of a single HTML tag string into a lowercase-keyed map.
 * Handles double-quoted, single-quoted, and bare values.
 * @param {string} tag e.g. `<meta name="description" content="...">`
 * @returns {Record<string, string>}
 */
export function parseAttrs(tag) {
  const attrs = {};
  const re = /([a-zA-Z][a-zA-Z0-9:-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag)) !== null) {
    attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  }
  return attrs;
}

/** All opening tags of a given name, as attribute maps. Void and non-void tags. */
export function findTags(html, tagName) {
  const out = [];
  const re = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  let m;
  while ((m = re.exec(html)) !== null) out.push(parseAttrs(m[0]));
  return out;
}

// Named entities that reach head metadata: the five XML basics Shopify escapes
// with, plus the typographic ones a merchant can type into a title or
// description in Admin. The non-ASCII values are written as \u escapes on
// purpose. This repo bans the literal em dash (U+2014) in every file, and
// spelling its neighbours the same way keeps the table consistent rather than
// half-escaped. Null-prototype so a lookup can never reach Object.prototype.
const NAMED_ENTITIES = Object.assign(Object.create(null), {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  // Folded to a plain space: a non-breaking space is one character either way
  // for the length checks, and folding it keeps two descriptions that differ
  // only in whitespace kind from escaping the duplicate check.
  nbsp: ' ',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
});

/**
 * Decode the HTML entities Shopify emits in head metadata.
 *
 * WHY this is worth more than tidiness: every `<title>` the theme renders joins
 * its parts with a literal `&ndash;` (snippets/meta-tags.liquid), so a table
 * that stops at `&amp;` measures every title on the store 6 characters too long and
 * reports a phantom `title-long` on anything past 54 real characters. It did,
 * on six URLs, until 2026-09-03.
 *
 * One pass, not a chain of `.replace()` calls: a chain that decodes `&amp;`
 * first turns `&amp;lt;` into `<` rather than the literal `&lt;` the page meant.
 * A single pass over the source cannot double-decode.
 *
 * An unknown or malformed entity is left exactly as written, so a decode can
 * only ever shorten a string it understands, never mangle one it does not.
 */
export function decodeEntities(s) {
  const re = /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{0,31});/g;
  return String(s).replace(re, (match, body) => {
    if (body[0] !== '#') {
      const named = NAMED_ENTITIES[body];
      return named === undefined ? match : named;
    }
    const cp = body[1] === 'x' || body[1] === 'X'
      ? parseInt(body.slice(2), 16)
      : parseInt(body.slice(1), 10);
    // Reject what String.fromCodePoint would throw on, plus lone surrogates,
    // which are unpaired garbage rather than a character anyone meant to write.
    if (!Number.isInteger(cp) || cp < 1 || cp > 0x10ffff) return match;
    if (cp >= 0xd800 && cp <= 0xdfff) return match;
    return String.fromCodePoint(cp);
  });
}

/** <title> text, whitespace-collapsed, or null when absent. */
export function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  return decodeEntities(m[1].replace(/\s+/g, ' ').trim());
}

/** content of <meta name="..."> (case-insensitive name match), or null. */
export function extractMetaByName(html, name) {
  for (const attrs of findTags(html, 'meta')) {
    if ((attrs.name || '').toLowerCase() === name.toLowerCase() && 'content' in attrs) {
      return decodeEntities(attrs.content);
    }
  }
  return null;
}

/** content of <meta property="..."> (og:/twitter: tags), or null. */
export function extractMetaByProperty(html, property) {
  for (const attrs of findTags(html, 'meta')) {
    if ((attrs.property || '').toLowerCase() === property.toLowerCase() && 'content' in attrs) {
      return decodeEntities(attrs.content);
    }
  }
  return null;
}

/** href of <link rel="canonical">, or null. */
export function extractCanonical(html) {
  for (const attrs of findTags(html, 'link')) {
    if ((attrs.rel || '').toLowerCase() === 'canonical' && attrs.href) {
      return decodeEntities(attrs.href);
    }
  }
  return null;
}

/** Number of <h1> opening tags in the document. */
export function countH1(html) {
  return (html.match(/<h1\b[^>]*>/gi) || []).length;
}

/**
 * Every <script type="application/ld+json"> block, with its parse result.
 * A block that fails JSON.parse is the highest-value finding this module
 * produces: Liquid trailing-comma bugs render markup that looks fine and is
 * silently ignored by every consumer, and no browser surfaces the error.
 * @returns {Array<{raw: string, parsed: object|null, types: string[], error: string|null}>}
 */
export function extractJsonLdBlocks(html) {
  const out = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    let parsed = null;
    let error = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      error = e.message;
    }
    out.push({ raw, parsed, types: jsonLdTypes(parsed), error });
  }
  return out;
}

/** Flatten the @type values of a parsed JSON-LD payload (object, array, or @graph). */
export function jsonLdTypes(parsed) {
  if (!parsed) return [];
  const nodes = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);
  const types = [];
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const t = node['@type'];
    if (Array.isArray(t)) types.push(...t.map(String));
    else if (t) types.push(String(t));
  }
  return types;
}

/** True when the theme's breadcrumb trail is present (snippets/breadcrumbs.liquid markup). */
export function hasBreadcrumbNav(html) {
  return /<nav\b[^>]*class\s*=\s*["'][^"']*\bbreadcrumbs\b/i.test(html);
}

/** Alt coverage over <img> tags: total count and how many lack an alt attribute entirely. */
export function imgAltStats(html) {
  const tags = html.match(/<img\b[^>]*>/gi) || [];
  let missing = 0;
  for (const tag of tags) {
    if (!('alt' in parseAttrs(tag))) missing += 1;
  }
  return { total: tags.length, missing };
}

/** pageType from a Shopify server-timing header value, or null. */
export function parsePageType(serverTiming) {
  if (!serverTiming) return null;
  const m = String(serverTiming).match(/pageType;desc="([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * All <loc> URLs from a sitemap (index or child). Tolerant of malformed
 * entries; skips them. Same approach as the deploy smoke test's parser.
 * @returns {string[]} absolute URLs as printed in the sitemap
 */
export function parseSitemapLocs(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/g;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/** Child sitemap URLs from a sitemap index (any type, not just products). */
export function parseSitemapChildren(xml) {
  return parseSitemapLocs(xml).filter((u) => /\/sitemap_[a-z]+_\d+\.xml/.test(u));
}
