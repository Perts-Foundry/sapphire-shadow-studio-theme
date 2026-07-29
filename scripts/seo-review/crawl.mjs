#!/usr/bin/env node
//
// crawl.mjs -- full-site SEO crawl (mode: crawl).
//
// WHY: re-runs the July 2026 SEO audit's page sweep as regression testing.
// Nothing in CI covers titles, descriptions, canonicals, H1 structure,
// JSON-LD parseability, or breadcrumb coverage, and every failure mode is
// silent on the storefront. URLs are enumerated from the sitemap (like the
// deploy smoke test) so new products/pages/collections are swept automatically.
//
// SECURITY (public repo): the storefront password comes from STORE_PW and is
// never printed. Only URLs, statuses, page types, and finding text are logged;
// bodies and cookie values never are. Run artifacts go to the state dir
// outside the repo (~/.local/state/seo-review/), never into the checkout.
//
// USAGE:
//   STORE_PW='...' node scripts/seo-review/crawl.mjs [--full] [--no-save] [--max <n>]
//   BASE_URL overrides the storefront origin (e.g. a public post-launch run
//   needs no STORE_PW at all).

import {
  extractTitle, extractMetaByName, extractMetaByProperty, extractCanonical,
  countH1, extractJsonLdBlocks, hasBreadcrumbNav, imgAltStats, parsePageType,
  parseSitemapLocs, parseSitemapChildren,
} from './lib/extract.mjs';
import { evaluatePage, crossPageChecks, ERROR } from './lib/checks.mjs';
import { fetchPage, authenticate, isLocked, newJar, sleep } from './lib/http.mjs';
import { finishRun } from './lib/report.mjs';

const BASE_URL = (process.env.BASE_URL || 'https://sapphireshadowstudio.com').replace(/\/+$/, '');
const EXPECTED_HOST = new URL(BASE_URL).host;

// Paths the sitemap never lists but the audit swept. Policy pages Shopify has
// not published simply 404 and are skipped without a finding.
const FIXED_PATHS = ['/', '/cart', '/search?q=test', '/collections', '/blogs/news'];
const POLICY_PATHS = [
  '/policies/refund-policy', '/policies/privacy-policy', '/policies/terms-of-service',
  '/policies/shipping-policy', '/policies/contact-information', '/policies/subscription-policy',
];
const NOT_FOUND_PROBE = '/definitely-not-a-page-404-probe';

function arg(flag) { return process.argv.includes(flag); }
function argValue(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

async function enumerateUrls(jar) {
  const seen = new Set();
  const urls = [];
  const push = (u) => {
    let parsed;
    try { parsed = new URL(u, BASE_URL); } catch { return; }
    const key = parsed.pathname + parsed.search;
    if (seen.has(key)) return;
    seen.add(key);
    urls.push(`${BASE_URL}${key}`);
  };

  for (const p of FIXED_PATHS) push(p);

  const idx = await fetchPage(`${BASE_URL}/sitemap.xml`, { jar });
  if (idx.status === 200) {
    let children = parseSitemapChildren(idx.body);
    if (children.length === 0) children = [`${BASE_URL}/sitemap_products_1.xml`];
    for (const child of children) {
      const c = await fetchPage(child, { jar });
      if (c.status !== 200) continue;
      for (const loc of parseSitemapLocs(c.body)) push(loc);
    }
  }
  return { urls, sitemapOk: idx.status === 200 };
}

async function main() {
  const maxUrls = Number(argValue('--max', '80')) || 80;
  const paceMs = Number(argValue('--pace', '1500')) || 1500;
  const jar = newJar();
  const log = (l) => process.stdout.write(l + '\n');

  log(`seo-review crawl: ${BASE_URL}`);

  const locked = await isLocked(BASE_URL);
  if (locked) {
    const pw = process.env.STORE_PW || process.env.STOREFRONT_PASSWORD || '';
    if (!pw) {
      log('store is password-locked and no STORE_PW is set; the crawl cannot see content pages.');
      log('set STORE_PW (never echo it) and re-run.');
      process.exit(2);
    }
    const auth = await authenticate(BASE_URL, pw, { jar });
    if (auth !== 'success') {
      log(`storefront password auth ${auth}; cannot crawl content. Check the password (never printed).`);
      process.exit(2);
    }
    log('store is locked; authenticated session established.');
  } else {
    log('store is public; crawling anonymously.');
  }

  const { urls, sitemapOk } = await enumerateUrls(jar);
  if (!sitemapOk) log('WARNING: sitemap unreachable; crawling fixed paths only.');
  const targets = urls.slice(0, maxUrls);
  log(`enumerated ${urls.length} URL(s); probing ${targets.length} (cap ${maxUrls}), plus policies and a 404 probe.`);

  const pages = [];
  const findings = [];

  const probeOne = async (url, { optional = false, expect404 = false } = {}) => {
    await sleep(paceMs);
    const res = await fetchPage(url, { jar });
    if (expect404) {
      if (res.status !== 404) {
        findings.push({
          check: '404-status', severity: ERROR, url,
          detail: `missing-page probe returned ${res.status} (expected a real 404)`,
        });
      }
      return;
    }
    if (optional && (res.status === 404 || res.status === 410)) return; // unpublished policy
    const pageType = parsePageType(res.serverTiming);
    const x = {
      title: extractTitle(res.body),
      description: extractMetaByName(res.body, 'description'),
      robots: extractMetaByName(res.body, 'robots'),
      canonical: extractCanonical(res.body),
      ogImage: extractMetaByProperty(res.body, 'og:image'),
      h1Count: countH1(res.body),
      jsonLd: extractJsonLdBlocks(res.body),
      breadcrumb: hasBreadcrumbNav(res.body),
      imgAlt: imgAltStats(res.body),
    };
    const page = { url, pageType, status: res.status, x };
    pages.push(page);
    findings.push(...evaluatePage(page, EXPECTED_HOST));
    log(`  ${res.status} ${pageType || '-'} ${new URL(url).pathname}${new URL(url).search}`);
  };

  for (const url of targets) await probeOne(url);
  for (const p of POLICY_PATHS) await probeOne(`${BASE_URL}${p}`, { optional: true });
  await probeOne(`${BASE_URL}${NOT_FOUND_PROBE}`, { expect404: true });

  findings.push(...crossPageChecks(pages));

  const exitCode = finishRun('crawl', findings, {
    full: arg('--full'),
    noSave: arg('--no-save'),
    meta: { baseUrl: BASE_URL, probed: pages.length, locked },
    log,
  });
  process.exit(exitCode);
}

main().catch((e) => {
  // Never print the raw error object (a request URL could carry credentials).
  process.stderr.write(`seo-review crawl: fatal (${e && e.name ? e.name : 'error'}: ${e && e.message ? e.message : ''})\n`);
  process.exit(1);
});
