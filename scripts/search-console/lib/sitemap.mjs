// sitemap.mjs -- the node-side cross-checks: the live sitemap and a secondary domain's redirect.
//
// WHY NODE AND NOT THE BROWSER. The browser pass is for Search Console only; its navigation
// allowlist closes every other host unvisited. The storefront numbers Search Console is compared
// against come from here, anonymously, with the same fetch helpers as seo-review.
//
// Never curl: Shopify's bot management blocks curl's fingerprint and returns a hard 429, which
// would read as an unreachable sitemap. Node's fetch is not flagged (scripts/seo-review/lib/http.mjs).

import { fetchPage, BROWSER_HEADERS } from '../../seo-review/lib/http.mjs';
import { parseSitemapLocs, parseSitemapChildren } from '../../seo-review/lib/extract.mjs';

const isSitemapXml = (body) => /<(?:urlset|sitemapindex)[\s>]/.test(body ?? '');

function sameHost(url, base) {
  try {
    return new URL(url).host === new URL(base).host;
  } catch {
    return false;
  }
}

const decodeAmp = (u) => u.replace(/&amp;/g, '&');

/**
 * Every distinct <loc> in the live sitemap: the index, then each child.
 *
 * @param {string} baseUrl storefront origin
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 * @param {number[]} [opts.backoff] 429 backoff schedule; fetchPage's default when omitted
 * @returns {Promise<{ urls: string[], partial: boolean } | null>} null when the index failed;
 *   `partial` when a child failed, redirected off the host, or was not sitemap XML
 */
export async function liveSitemapUrls(baseUrl, { fetchImpl = globalThis.fetch, timeoutMs = 20000, backoff } = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const get = (url) => fetchPage(url, { fetchImpl, timeoutMs, anonymous: true, ...(backoff ? { backoff } : {}) });
  const usable = (res) => res.status === 200 && sameHost(res.url, base) && isSitemapXml(res.body);

  const index = await get(`${base}/sitemap.xml`);
  if (!usable(index)) return null;

  const urls = new Set();
  const children = parseSitemapChildren(index.body).map(decodeAmp);
  if (children.length === 0) {
    if (!/<urlset[\s>]/.test(index.body)) return null;
    for (const loc of parseSitemapLocs(index.body)) urls.add(decodeAmp(loc));
    return { urls: [...urls], partial: false };
  }

  let partial = false;
  for (const child of children) {
    if (!sameHost(child, base)) {
      partial = true;
      continue;
    }
    const res = await get(child);
    if (!usable(res)) {
      partial = true;
      continue;
    }
    for (const loc of parseSitemapLocs(res.body)) urls.add(decodeAmp(loc));
  }
  return { urls: [...urls], partial };
}

/**
 * One unfollowed request to a host's root, to see where it points.
 * @returns {Promise<{ status: number, location: string | null } | null>} null on a network failure
 */
export async function probeRedirect(host, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://${host}/`, { headers: BROWSER_HEADERS, redirect: 'manual', signal: ctl.signal });
    return { status: res.status, location: res.headers?.get?.('location') ?? null };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
