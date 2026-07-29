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

/** Decode the handful of HTML entities Shopify emits in head metadata. */
export function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'");
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
