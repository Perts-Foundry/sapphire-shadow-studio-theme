// Shared test support: the healthy capture, the live-sitemap URLs that match it, and FIXTURE_FOR,
// which maps every check id to the smallest mutation of the healthy capture that makes it fire.
//
// The healthy capture evaluates to zero findings under healthyOpts(). That is what makes FIXTURE_FOR
// meaningful: checks.test.mjs asserts each id is absent from the healthy run and present after its
// mutation, so a check that fires on everything, or on nothing, fails its own row.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCapture } from '../lib/schema.mjs';
import { invalidFindings, DISCOVERY_REVIEW_DAYS } from '../lib/checks.mjs';
import { KNOWN_SURFACES_REVIEWED_ON } from '../lib/known-surfaces.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(HERE, 'fixtures');
export const SC_ROOT = path.resolve(HERE, '..');
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

export const NOW = new Date('2026-12-01T15:00:00Z');
export const PREINDEX_NOW = new Date('2026-09-13T21:00:00Z');
export const ORIGIN = 'https://sapphireshadowstudio.com';
const DAY_MS = 86_400_000;

export const readFixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
export const readText = (name) => readFileSync(path.join(FIXTURES, name), 'utf8');
export const clone = (v) => structuredClone(v);

const HEALTHY = readFixture('capture-healthy.json');

/** A fresh copy of the healthy capture. */
export function baseCapture() {
  return clone(HEALTHY);
}

export const SITEMAP_URLS = Object.freeze([
  '/', '/products/lead-ii-vest-womens', '/products/lead-ii-crewneck', '/products/lead-ii-quarter-zip',
  '/products/huddle-crewneck', '/products/shift-fuel-tote', '/products/sapphire-shadow-studio-gift-card',
  '/collections/healthcare-collection', '/collections/the-vitals-collection', '/collections/featured',
  '/collections/all-apparel', '/pages/about', '/pages/faq', '/pages/contact', '/pages/size-guide',
  '/blogs/shift-notes', '/blogs/shift-notes/first-post',
].map((p) => `${ORIGIN}${p}`));

export function healthyOpts() {
  return { sitemapUrls: [...SITEMAP_URLS], sitemapState: 'ok', redirectProbes: {}, previousPeriod: null, now: NOW };
}

export const notReady = (id, status = 'not-ready') => ({ captured_at: '2026-12-01T09:00:00-05:00', report: id, status });

const mut = (fn) => () => {
  const capture = baseCapture();
  const opts = healthyOpts();
  fn(capture.reports, opts, capture);
  return { capture, opts };
};

const reason = (slug) => mut((r) => {
  r['indexing-pages'].reasons.push({ reason: slug, source: 'Website', count: 1, examples: [`${ORIGIN}/pages/faq`] });
  r['indexing-pages'].not_indexed += 1;
});

/** check id -> () => ({ capture, opts }) or ({ findings }) */
export const FIXTURE_FOR = Object.freeze({
  'capture-invalid': () => {
    const c = baseCapture();
    c.nonce = 'X';
    return { findings: invalidFindings(validateCapture(c).errors) };
  },
  'capture-missing-report': mut((r) => { delete r.links; }),
  'capture-stale': mut((r, o) => { o.now = new Date('2026-12-20T00:00:00Z'); }),
  'gsc-not-ready': mut((r) => { r.cwv = notReady('cwv'); }),
  'gsc-property-mismatch': mut((r, o, c) => { c.property = 'sc-domain:other-shop.example'; }),

  'property-url-prefix': mut((r) => { r.settings.property_type = 'url-prefix'; }),
  'verification-lost': mut((r) => { r.settings.verified = false; }),
  'verification-method-fragile': mut((r) => { r.settings.method = 'HTML tag'; }),
  'owner-single': mut((r) => { r.settings.owners = 1; }),
  'users-unexpected': mut((r) => { r.settings.users = 5; }),
  'ownership-tokens-unused': mut((r) => { r.settings.unused_tokens = 2; }),
  'change-of-address-set': mut((r) => { r.settings.change_of_address_set = true; }),
  'bulk-export-configured': mut((r) => { r.settings.bulk_export_configured = true; }),
  'ai-control-exclude': mut((r) => { r.settings.ai_control = 'exclude'; }),
  'email-notifications-off': mut((r) => { r.settings.email_notifications = false; }),
  'secondary-domain-redirect': mut((r, o) => {
    r.settings.secondary_domains = ['brand-alias.example'];
    o.redirectProbes = { 'brand-alias.example': { status: 200, location: null } };
  }),

  'robots-not-seen': mut((r) => { r['crawl-stats'].robots_state = 'not-seen'; }),
  'robots-fetch-error': mut((r) => { r['crawl-stats'].robots_state = 'error'; }),
  'crawl-host-issues': mut((r) => { r['crawl-stats'].host_status = 'issues'; }),
  'crawl-5xx-share': mut((r) => { r['crawl-stats'].share_5xx = 0.02; }),
  'crawl-4xx-share': mut((r) => { r['crawl-stats'].share_4xx = 0.06; }),

  'association-missing': mut((r) => { r.associations.services = ['analytics']; }),
  'association-pending': mut((r) => { r.associations.pending = 1; }),

  'removal-active': mut((r) => { r.removals.temporary_active = 1; r.removals.temporary_urls = [`${ORIGIN}/pages/about`]; }),
  'removal-other-active': mut((r) => { r.removals.outdated_active = 1; }),

  'messages-unread': mut((r) => { r.messages.unread = 1; }),

  'sitemap-missing': mut((r) => { r.sitemaps.rows = []; }),
  'sitemap-error': mut((r) => { r.sitemaps.rows[0].status = "Couldn't fetch"; }),
  'sitemap-pending': mut((r) => { r.sitemaps.rows[0].status = 'Pending'; }),
  'sitemap-child-submitted': mut((r) => {
    r.sitemaps.rows.push({ ...r.sitemaps.rows[0], path: `${ORIGIN}/sitemap_products_1.xml`, type: 'Sitemap', discovered_pages: 7 });
  }),
  'sitemap-discovered-mismatch': mut((r) => { r.sitemaps.rows[0].discovered_pages = 30; }),
  'sitemap-stale-read': mut((r) => { r.sitemaps.rows[0].last_read = '2026-10-01'; }),
  'sitemap-live-unreachable': mut((r, o) => { delete o.sitemapUrls; o.sitemapState = 'unreachable'; }),

  'index-count-below-sitemap': mut((r) => { r['indexing-pages'].indexed = 10; }),
  'index-reason-unknown': mut((r) => {
    r['indexing-pages'].reasons.push({ reason: 'unknown', label: 'Blocked by page removal tool', source: 'Website', count: 1, examples: [] });
    r['indexing-pages'].not_indexed += 1;
  }),
  'index-reason-crawled-not-indexed': reason('crawled-not-indexed'),
  'index-reason-discovered-not-indexed': reason('discovered-not-indexed'),
  'index-reason-alternate-canonical': reason('alternate-canonical'),
  'index-reason-duplicate-no-canonical': reason('duplicate-no-canonical'),
  'index-reason-duplicate-google-chose-different': reason('duplicate-google-chose-different'),
  'index-reason-noindex': reason('noindex'),
  'index-reason-not-found': reason('not-found'),
  'index-reason-redirect': reason('redirect'),
  'index-reason-soft-404': reason('soft-404'),
  'index-reason-blocked-robots': reason('blocked-robots'),
  'index-reason-server-error': reason('server-error'),
  'index-reason-forbidden': reason('forbidden'),
  'index-reason-other-4xx': reason('other-4xx'),

  'inspect-not-indexed': mut((r) => { r.inspections.items[1].verdict = 'not-on-google'; r.inspections.items[1].indexed = false; }),
  'inspect-canonical-mismatch': mut((r) => { r.inspections.items[1].google_canonical = `${ORIGIN}/products/lead-ii-crewneck`; }),
  'inspect-stale-crawl': mut((r) => { r.inspections.items[0].last_crawl = '2026-09-20T00:00:00Z'; }),
  'inspect-crawl-blocked': mut((r) => { r.inspections.items[2].indexing_allowed = false; }),
  'inspect-fetch-failed': mut((r) => { r.inspections.items[0].page_fetch = 'Failed: Server error (5xx)'; }),
  'inspect-rich-result-missing': mut((r) => { r.inspections.items[1].rich_results = ['Product snippets']; }),
  'inspect-section-unknown': mut((r) => { r.inspections.items[0].sections.push('Structured data'); }),

  'cwv-poor': mut((r) => { r.cwv.mobile.poor = 2; }),
  'cwv-needs-improvement': mut((r) => { r.cwv.mobile.needs_improvement = 3; }),
  'cwv-no-data': mut((r) => { r.cwv.desktop = 'no-data'; }),
  'https-non-https': mut((r) => { r.https.non_https_urls = 1; }),
  'https-no-data': mut((r) => { r.https = notReady('https', 'not-present'); }),

  'enhancement-invalid': mut((r) => { r.enhancements.items[0].invalid = 1; }),
  'enhancement-warning': mut((r) => { r.enhancements.items[0].warning = 1; }),
  'enhancement-absent': mut((r) => { r.enhancements.items = r.enhancements.items.filter((i) => i.type !== 'Breadcrumbs'); }),
  'enhancement-product-duplicate-evidence': mut((r) => {
    r.enhancements.items.push({ type: 'Merchant listings', valid: 6, invalid: 0, warning: 0 });
  }),
  'enhancement-type-unknown': mut((r) => { r.enhancements.items.push({ type: 'Shopping', valid: 1, invalid: 0, warning: 0 }); }),

  'manual-action': mut((r) => { r['security-manual'].manual_actions = 'present'; }),
  'security-issue': mut((r) => { r['security-manual'].security_issues = 'present'; }),

  'perf-zero-impressions': mut((r) => { r.performance.totals = { clicks: 0, impressions: 0, ctr: 0, position: 0 }; }),
  'perf-brand-only': mut((r) => { r.performance.queries.rows = r.performance.queries.rows.slice(0, 1); }),
  'perf-page-no-impressions': mut((r) => { r.performance.pages.rows = r.performance.pages.rows.slice(1); }),
  'perf-low-ctr': mut((r) => {
    r.performance.pages.rows[1] = { url: `${ORIGIN}/products/lead-ii-vest-womens`, clicks: 1, impressions: 150, ctr: 0.0067, position: 5 };
  }),
  'perf-position-opportunity': mut((r) => { r.performance.pages.rows[2].position = 8; }),
  'perf-country-outside-us': mut((r) => { r.performance.countries.rows[1].impressions = 400; }),
  'search-type-new': mut((r) => { r.performance.search_type = 'Search type: Discover'; }),
  'period-mismatch': mut((r, o) => { o.previousPeriod = '3mo'; }),

  'links-none': mut((r) => { r.links.top_linking_sites = 0; }),

  'surface-new': mut((r) => { r.discovery.nav.push({ label: 'Shopping', path: 'shopping' }); }),
  'surface-gone': mut((r) => { r.discovery.nav = r.discovery.nav.filter((n) => n.label !== 'Links'); }),
  'discovery-review-due': mut((r, o) => {
    o.now = new Date(Date.parse(`${KNOWN_SURFACES_REVIEWED_ON}T00:00:00Z`) + (DISCOVERY_REVIEW_DAYS + 1) * DAY_MS);
  }),
});

/** A writable stream stand-in that collects text. */
export function sink() {
  let text = '';
  return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
}

/** A fetch that fails the test if anything calls it. */
export const throwingFetch = () => {
  throw new Error('network access in a test');
};
