// checks.mjs -- pure rule evaluation for the SEO review. No I/O.
//
// A finding is { check, severity, url, detail }. `check` is a stable id: the
// baseline differ and accepted-risks matching key on it (plus the URL path),
// so renaming a check id orphans its accepted-risk entries and its baseline
// history. Add new ids freely; rename existing ones only with a matching edit
// to accepted-risks.json.

export const ERROR = 'ERROR';
export const WARN = 'WARN';
export const INFO = 'INFO';

// Page types (Shopify server-timing pageType) that carry the breadcrumb trail.
// Mirrors the allow-list in snippets/breadcrumbs.liquid; if that snippet's
// case list changes, this constant must change with it.
export const BREADCRUMB_PAGE_TYPES = new Set([
  'product', 'collection', 'page', 'article', 'blog', 'list-collections',
]);

// Page types where a missing meta description is acceptable (never indexed
// or deliberately utilitarian). Everything else should have one.
const DESCRIPTION_EXEMPT = new Set(['cart', 'search', '404', 'password']);

// Page types where a robots noindex is expected rather than a defect.
const NOINDEX_OK = new Set(['cart', 'search', '404', 'password', 'policy']);

// Shared by the crawl checks below and admin.mjs's stored-field checks.
export const TITLE_MAX = 60;
export const DESC_MIN = 50;
export const DESC_MAX = 160;

/**
 * Stable per-page key: the path (query stripped) for http(s) URLs, the string
 * itself for admin-mode identifiers like `admin:product/handle`.
 */
export function pathOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.pathname;
  } catch { /* fall through */ }
  return String(url);
}

/**
 * Evaluate one crawled page.
 * @param {object} page
 * @param {string} page.url         final URL probed
 * @param {string|null} page.pageType server-timing pageType (null when absent)
 * @param {number} page.status      final HTTP status
 * @param {object} page.x           extract results: title, description, robots,
 *   canonical, ogImage, h1Count, jsonLd, breadcrumb, imgAlt
 * @param {string} expectedHost     canonical host every URL should live on
 * @returns {Array<{check:string, severity:string, url:string, detail:string}>}
 */
export function evaluatePage(page, expectedHost) {
  const { url, pageType, status, x } = page;
  const f = [];
  const add = (check, severity, detail) => f.push({ check, severity, url, detail });

  if (status !== 200) {
    add('page-status', ERROR, `status ${status}`);
    return f; // nothing below is meaningful on a non-200 body
  }

  // Title
  if (!x.title) add('title-missing', ERROR, 'no <title>');
  else if (x.title.length > TITLE_MAX) {
    add('title-long', WARN, `${x.title.length} chars (target <= ${TITLE_MAX}): "${x.title}"`);
  }

  // Meta description
  if (!x.description) {
    if (!DESCRIPTION_EXEMPT.has(pageType)) add('description-missing', WARN, 'no meta description');
  } else if (x.description.length < DESC_MIN || x.description.length > DESC_MAX) {
    add('description-length', WARN,
      `${x.description.length} chars (target ${DESC_MIN}-${DESC_MAX})`);
  }

  // Robots
  if (x.robots && /noindex/i.test(x.robots) && !NOINDEX_OK.has(pageType)) {
    add('robots-noindex', ERROR, `robots meta is "${x.robots}" on an indexable page type (${pageType})`);
  }

  // Canonical
  if (!x.canonical) {
    add('canonical-missing', ERROR, 'no rel=canonical');
  } else {
    let c;
    try { c = new URL(x.canonical); } catch { c = null; }
    if (!c) add('canonical-invalid', ERROR, `unparseable canonical "${x.canonical}"`);
    else {
      if (c.protocol !== 'https:') add('canonical-scheme', ERROR, `canonical is ${c.protocol}`);
      if (expectedHost && c.host !== expectedHost) {
        add('canonical-host', ERROR, `canonical host ${c.host}, expected ${expectedHost}`);
      }
    }
  }

  // og:image scheme (the PR #77 regression class)
  if (x.ogImage && !/^https:/i.test(x.ogImage)) {
    add('og-image-scheme', ERROR, `og:image is not https: "${x.ogImage.slice(0, 60)}"`);
  }

  // Exactly one H1 per page type (no CI check exists for this; the crawl is it)
  if (x.h1Count !== 1) add('h1-count', ERROR, `${x.h1Count} <h1> elements (expected exactly 1)`);

  // JSON-LD: every block must parse; entity nodes are homepage-only
  const types = [];
  for (const block of x.jsonLd) {
    if (block.error) {
      add('jsonld-parse', ERROR, `unparseable ld+json block: ${block.error}`);
    } else {
      types.push(...block.types);
    }
  }
  for (const entity of ['Organization', 'WebSite']) {
    const n = types.filter((t) => t === entity).length;
    if (pageType === 'index' && n !== 1) {
      add('jsonld-entity-home', ERROR, `${entity} node count on homepage is ${n} (expected 1)`);
    }
    if (pageType !== 'index' && n > 0) {
      add('jsonld-entity-leak', ERROR, `${entity} node emitted on non-homepage page type (${pageType})`);
    }
  }
  if (pageType === 'product' && !types.some((t) => t === 'Product' || t === 'ProductGroup')) {
    add('jsonld-product-missing', WARN, 'no Product/ProductGroup markup (Shopify structured_data filter)');
  }
  if (BREADCRUMB_PAGE_TYPES.has(pageType) && !types.includes('BreadcrumbList')) {
    add('jsonld-breadcrumb-missing', ERROR, `no BreadcrumbList on page type ${pageType}`);
  }

  // Visible breadcrumb presence must match the allow-list
  if (BREADCRUMB_PAGE_TYPES.has(pageType) && !x.breadcrumb) {
    add('breadcrumb-missing', ERROR, `no breadcrumb nav on page type ${pageType}`);
  }
  if (!BREADCRUMB_PAGE_TYPES.has(pageType) && pageType && x.breadcrumb) {
    add('breadcrumb-unexpected', WARN, `breadcrumb nav on page type ${pageType} (outside the allow-list)`);
  }

  // Image alt coverage
  if (x.imgAlt.missing > 0) {
    add('img-alt-missing', WARN, `${x.imgAlt.missing} of ${x.imgAlt.total} <img> lack an alt attribute`);
  }

  return f;
}

/**
 * Cross-page checks over all crawled pages: duplicated titles and meta
 * descriptions (the exact defect class of the original audit's B1 finding).
 * @param {Array<{url:string, x:object}>} pages
 */
export function crossPageChecks(pages) {
  const f = [];
  const byValue = (field) => {
    const map = new Map();
    for (const p of pages) {
      const v = p.x[field];
      if (!v) continue;
      if (!map.has(v)) map.set(v, []);
      map.get(v).push(p.url);
    }
    return map;
  };
  for (const [value, urls] of byValue('description')) {
    if (urls.length > 1) {
      f.push({
        check: 'description-duplicate', severity: ERROR, url: urls[0],
        detail: `identical meta description on ${urls.length} pages: ${urls.map(pathOf).join(', ')}`,
      });
    }
  }
  for (const [value, urls] of byValue('title')) {
    if (urls.length > 1) {
      f.push({
        check: 'title-duplicate', severity: WARN, url: urls[0],
        detail: `identical <title> on ${urls.length} pages ("${value.slice(0, 50)}"): ${urls.map(pathOf).join(', ')}`,
      });
    }
  }
  return f;
}

/**
 * Split findings into { fresh, accepted } against accepted-risks entries.
 * An entry matches on check id, and on URL path when the entry names one.
 * @param {Array} findings
 * @param {Array<{check:string, path?:string, note:string, accepted_on:string}>} accepted
 */
export function partitionAccepted(findings, accepted) {
  const fresh = [];
  const acceptedOut = [];
  for (const finding of findings) {
    const hit = (accepted || []).find((a) =>
      a.check === finding.check && (!a.path || a.path === pathOf(finding.url)));
    if (hit) acceptedOut.push({ ...finding, note: hit.note, accepted_on: hit.accepted_on });
    else fresh.push(finding);
  }
  return { fresh, accepted: acceptedOut };
}

/** Stable identity key for baseline diffing. */
export function findingKey(f) {
  return `${f.check}|${pathOf(f.url)}`;
}

/**
 * Diff two finding lists by identity key.
 * @returns {{added: Array, resolved: Array, unchanged: Array}}
 */
export function diffFindings(previous, current) {
  const prevKeys = new Set((previous || []).map(findingKey));
  const curKeys = new Set(current.map(findingKey));
  return {
    added: current.filter((f) => !prevKeys.has(findingKey(f))),
    resolved: (previous || []).filter((f) => !curKeys.has(findingKey(f))),
    unchanged: current.filter((f) => prevKeys.has(findingKey(f))),
  };
}

/** Exit code policy: block only on fresh ERROR findings. */
export function exitCodeFor(freshFindings) {
  return freshFindings.some((f) => f.severity === ERROR) ? 1 : 0;
}
