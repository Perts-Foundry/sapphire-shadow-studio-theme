// checks.mjs -- pure rule evaluation over a validated Search Console capture. No I/O.
//
// A finding is { check, severity, url, detail }, the seo-review shape, so the accepted-risks
// matcher and the differ are reused as they are. `url` is the SUBJECT, and SUBJECT_KIND says which
// kind each check uses: a storefront URL for per-page findings, a report id, a device, an
// enhancement type, a Search Console label, or the literal check id for a singleton. Performance
// findings are keyed by page URL and never by query: a query is visitor-typed text, it goes in
// `detail` only, and the report layer never writes it to a repo file.
//
// Every threshold is a named export so the skill docs can quote it by name and the contract test
// can hold any number quoted beside that name to the value here.
//
// `check` ids are stable: the run files and accepted-risks.json key on them, so renaming one
// orphans its history. Add ids freely; rename only with a matching accepted-risks edit.

import { ERROR, WARN, INFO, pathOf, findingKey } from '../../seo-review/lib/checks.mjs';
import {
  EXPECTED_REPORTS_BY_MODE, REPORTS, propertyHost, reasonSlugFor, INSPECTION_SECTIONS, ENHANCEMENT_TYPES,
} from './schema.mjs';
import { KNOWN_SURFACES, KNOWN_SURFACES_REVIEWED_ON, labelKey } from './known-surfaces.mjs';

export { ERROR, WARN, INFO };

export const PROPERTY = 'sc-domain:sapphireshadowstudio.com';
export const PROPERTY_HOST = 'sapphireshadowstudio.com';

// Brand queries, compared with spaces removed so "sapphireshadow studio" still counts.
export const BRAND_TERMS = Object.freeze(['sapphire shadow studio', 'sapphire shadow']);
export const BRAND_ONLY_MIN_AGE_DAYS = 60;
export const PAGE_NO_IMPRESSIONS_MIN_AGE_DAYS = 28;

export const CTR_MIN = 0.02;
export const CTR_MIN_IMPRESSIONS = 100;
export const CTR_MAX_POSITION = 10;
export const OPPORTUNITY_POSITIONS = Object.freeze([4, 15]);
export const OPPORTUNITY_MIN_IMPRESSIONS = 20;
export const NOISE_FLOOR_IMPRESSIONS = 50;
export const COUNTRY_OUTSIDE_US_SHARE = 0.1;
export const CRAWL_5XX_SHARE = 0.01;
export const CRAWL_4XX_SHARE = 0.05;
export const ROBOTS_GRACE_DAYS = 7;
export const STALE_CAPTURE_DAYS = 7;
export const STALE_CRAWL_DAYS = 30;
export const SITEMAP_STALE_READ_DAYS = 14;
export const SITEMAP_TOLERANCE = 1;
export const DISCOVERY_REVIEW_DAYS = 90;

// Paths where a noindex is deliberate. Exact paths, and prefixes (which end in `/` or name a whole
// route family). Mirrors the intent of NOINDEX_OK in scripts/seo-review/lib/checks.mjs, by path
// rather than by page type, because Search Console reports URLs.
export const NOINDEX_OK = Object.freeze({
  exact: Object.freeze(['/blogs/shift-notes', '/cart', '/search']),
  prefix: Object.freeze(['/policies/', '/account', '/checkouts/']),
});

export function isNoindexOk(path) {
  return NOINDEX_OK.exact.includes(path) || NOINDEX_OK.prefix.some((p) => path === p.replace(/\/$/, '') || path.startsWith(p));
}

// Per-reason severity for `index-reason-<slug>`. `not-found` is WARN only for a URL still in the
// live sitemap (INFO otherwise); `noindex` is ERROR unless every example is in NOINDEX_OK.
export const REASON_SEVERITY = Object.freeze({
  'crawled-not-indexed': WARN,
  'discovered-not-indexed': INFO,
  'alternate-canonical': INFO,
  'duplicate-no-canonical': WARN,
  'duplicate-google-chose-different': WARN,
  noindex: ERROR,
  'not-found': WARN,
  redirect: INFO,
  'soft-404': WARN,
  'blocked-robots': WARN,
  'server-error': ERROR,
  forbidden: WARN,
  'other-4xx': WARN,
});

// Rich results a URL inspection should list, by path. Each inner array is an any-of group; every
// group must be satisfied. The homepage and the blog expect none.
export const EXPECTED_RICH_RESULTS = Object.freeze([
  Object.freeze({ match: '^/products/[^/]+$', require: [['Product snippets', 'Merchant listings'], ['Breadcrumbs']] }),
  Object.freeze({ match: '^/collections/[^/]+$', require: [['Breadcrumbs']] }),
]);

// check id -> [default severity, subject kind, report the finding belongs to]. `envelope` findings
// are about the run itself and are diffed against the latest run of the same mode.
const DEFS = {
  'capture-invalid': [ERROR, 'pointer', 'envelope'],
  'capture-missing-report': [INFO, 'report', 'envelope'],
  'capture-stale': [INFO, 'singleton', 'envelope'],
  'gsc-not-ready': [INFO, 'report', 'envelope'],
  'gsc-property-mismatch': [ERROR, 'singleton', 'envelope'],

  'property-url-prefix': [WARN, 'singleton', 'settings'],
  'verification-lost': [ERROR, 'singleton', 'settings'],
  'verification-method-fragile': [INFO, 'singleton', 'settings'],
  'owner-single': [INFO, 'singleton', 'settings'],
  'users-unexpected': [WARN, 'singleton', 'settings'],
  'ownership-tokens-unused': [INFO, 'singleton', 'settings'],
  'change-of-address-set': [ERROR, 'singleton', 'settings'],
  'bulk-export-configured': [INFO, 'singleton', 'settings'],
  'ai-control-exclude': [WARN, 'singleton', 'settings'],
  'email-notifications-off': [WARN, 'singleton', 'settings'],
  'secondary-domain-redirect': [WARN, 'host', 'settings'],

  'robots-not-seen': [WARN, 'singleton', 'crawl-stats'],
  'robots-fetch-error': [WARN, 'singleton', 'crawl-stats'],
  'crawl-host-issues': [WARN, 'singleton', 'crawl-stats'],
  'crawl-5xx-share': [WARN, 'singleton', 'crawl-stats'],
  'crawl-4xx-share': [WARN, 'singleton', 'crawl-stats'],

  'association-missing': [INFO, 'service', 'associations'],
  'association-pending': [INFO, 'singleton', 'associations'],

  'removal-active': [ERROR, 'page-or-singleton', 'removals'],
  'removal-other-active': [INFO, 'singleton', 'removals'],

  'messages-unread': [INFO, 'singleton', 'messages'],

  'sitemap-missing': [ERROR, 'singleton', 'sitemaps'],
  'sitemap-error': [ERROR, 'page', 'sitemaps'],
  'sitemap-pending': [INFO, 'page', 'sitemaps'],
  'sitemap-child-submitted': [WARN, 'page', 'sitemaps'],
  'sitemap-discovered-mismatch': [WARN, 'page', 'sitemaps'],
  'sitemap-stale-read': [INFO, 'page', 'sitemaps'],
  'sitemap-live-unreachable': [INFO, 'singleton', 'sitemaps'],

  'index-count-below-sitemap': [WARN, 'singleton', 'indexing-pages'],
  'index-reason-unknown': [INFO, 'label', 'indexing-pages'],

  'inspect-not-indexed': [WARN, 'page', 'inspections'],
  'inspect-canonical-mismatch': [WARN, 'page', 'inspections'],
  'inspect-stale-crawl': [INFO, 'page', 'inspections'],
  'inspect-crawl-blocked': [ERROR, 'page', 'inspections'],
  'inspect-fetch-failed': [WARN, 'page', 'inspections'],
  'inspect-rich-result-missing': [INFO, 'page', 'inspections'],
  'inspect-section-unknown': [INFO, 'label', 'inspections'],

  'cwv-poor': [WARN, 'device', 'cwv'],
  'cwv-needs-improvement': [INFO, 'device', 'cwv'],
  'cwv-no-data': [INFO, 'device', 'cwv'],
  'https-non-https': [ERROR, 'singleton', 'https'],
  'https-no-data': [INFO, 'singleton', 'https'],

  'enhancement-invalid': [ERROR, 'enhancement-type', 'enhancements'],
  'enhancement-warning': [WARN, 'enhancement-type', 'enhancements'],
  'enhancement-absent': [INFO, 'enhancement-type', 'enhancements'],
  'enhancement-product-duplicate-evidence': [INFO, 'singleton', 'enhancements'],
  'enhancement-type-unknown': [INFO, 'enhancement-type', 'enhancements'],

  'manual-action': [ERROR, 'singleton', 'security-manual'],
  'security-issue': [ERROR, 'singleton', 'security-manual'],

  'perf-zero-impressions': [INFO, 'singleton', 'performance'],
  'perf-brand-only': [WARN, 'singleton', 'performance'],
  'perf-page-no-impressions': [WARN, 'page', 'performance'],
  'perf-low-ctr': [WARN, 'page', 'performance'],
  'perf-position-opportunity': [INFO, 'page', 'performance'],
  'perf-country-outside-us': [INFO, 'singleton', 'performance'],
  'search-type-new': [INFO, 'label', 'performance'],
  'period-mismatch': [INFO, 'singleton', 'performance'],

  'links-none': [INFO, 'singleton', 'links'],

  'surface-new': [INFO, 'label', 'discovery'],
  'surface-gone': [INFO, 'label', 'discovery'],
  'discovery-review-due': [INFO, 'singleton', 'discovery'],
};

for (const slug of Object.keys(REASON_SEVERITY)) {
  DEFS[`index-reason-${slug}`] = [REASON_SEVERITY[slug], 'page-or-reason', 'indexing-pages'];
}

/** Default (or ceiling, for age-gated checks) severity per check id. */
export const SEVERITY = Object.freeze(Object.fromEntries(Object.entries(DEFS).map(([id, d]) => [id, d[0]])));
export const SUBJECT_KIND = Object.freeze(Object.fromEntries(Object.entries(DEFS).map(([id, d]) => [id, d[1]])));
export const REPORT_OF = Object.freeze(Object.fromEntries(Object.entries(DEFS).map(([id, d]) => [id, d[2]])));
export const CHECK_IDS = Object.freeze(Object.keys(DEFS).sort());

const DAY_MS = 86_400_000;
const toMs = (now) => (now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now));

/** Whole days from a YYYY-MM-DD date or an ISO timestamp to `now`; null when unparseable. */
export function daysSince(value, now) {
  if (typeof value !== 'string') return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  const n = toMs(now);
  if (Number.isNaN(t) || Number.isNaN(n)) return null;
  return Math.floor((n - t) / DAY_MS);
}

const DETAIL_MAX = 240;
function clip(detail) {
  // eslint-disable-next-line no-control-regex
  const s = String(detail ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX - 3)}...` : s;
}

const SEV_RANK = { [ERROR]: 0, [WARN]: 1, [INFO]: 2 };

/** One capture-invalid finding per validation error; the pointer is the subject. */
export function invalidFindings(errors) {
  return errors.map((e) => ({ check: 'capture-invalid', severity: ERROR, url: e.path || '/', detail: clip(e.message) }));
}

export function isBrandQuery(query) {
  const compact = String(query).toLowerCase().replace(/\s+/g, '');
  return BRAND_TERMS.some((t) => compact.includes(t.replace(/\s+/g, '')));
}

function liveSitemap(opts) {
  if (opts.sitemapState === 'partial' || opts.sitemapState === 'unreachable') {
    return { state: opts.sitemapState, paths: null, urls: null, count: null };
  }
  if (Array.isArray(opts.sitemapUrls)) {
    const paths = new Set(opts.sitemapUrls.map(pathOf));
    return { state: 'ok', paths, urls: opts.sitemapUrls, count: paths.size };
  }
  if (Number.isInteger(opts.sitemapCount)) return { state: 'ok', paths: null, urls: null, count: opts.sitemapCount };
  return { state: 'skipped', paths: null, urls: null, count: null };
}

function canonicalForm(url) {
  try {
    const u = new URL(url);
    const p = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
    return `${u.host.toLowerCase()}${p}`;
  } catch {
    return String(url);
  }
}

function hostOf(location, base) {
  try {
    return new URL(location, base).host.toLowerCase();
  } catch {
    return null;
  }
}

const has = (list, label) => list.some((x) => labelKey(x) === labelKey(label));

// ---------------------------------------------------------------------------------------------

function envelopeChecks({ capture, reports, add, now }) {
  const mode = capture.mode;
  for (const id of EXPECTED_REPORTS_BY_MODE[mode] ?? []) {
    if (!(id in reports)) add('capture-missing-report', id, `mode ${mode} expects the ${id} report and the capture has none`);
  }
  const stale = daysSince(capture.captured_at, now);
  if (stale !== null && stale > STALE_CAPTURE_DAYS) {
    add('capture-stale', 'capture-stale', `captured ${stale} day(s) ago (STALE_CAPTURE_DAYS ${STALE_CAPTURE_DAYS})`);
  }
  for (const id of REPORTS) {
    if (reports[id]?.status === 'not-ready') add('gsc-not-ready', id, `Search Console shows no data for ${id} yet; nothing to judge or compare`);
  }
  if (propertyHost(capture.property) !== PROPERTY_HOST) {
    add('gsc-property-mismatch', 'gsc-property-mismatch', `the capture is not for ${PROPERTY}; stop and re-check the property picker`);
  }
}

function settingsChecks({ capture, okRep, add, opts }) {
  const s = okRep('settings');
  if ((typeof capture.property === 'string' && !capture.property.startsWith('sc-domain:')) || s?.property_type === 'url-prefix') {
    add('property-url-prefix', 'property-url-prefix', 'a URL-prefix property is selected; it splits data with the Domain property');
  }
  if (!s) return;
  if (s.verified === false) add('verification-lost', 'verification-lost', 'the Ownership verification page no longer says you are a verified owner');
  else if (/html|file|meta|tag|analytics/i.test(s.method)) {
    add('verification-method-fragile', 'verification-method-fragile', `verified by a method a theme deploy can remove (${s.method}); DNS is sturdier`);
  }
  if (s.owners === 1) add('owner-single', 'owner-single', 'one verified owner; losing that account loses the property');
  if (s.users > s.owners + 1) add('users-unexpected', 'users-unexpected', `${s.users} users for ${s.owners} owner(s); review who has access`);
  if (s.unused_tokens > 0) add('ownership-tokens-unused', 'ownership-tokens-unused', `${s.unused_tokens} unused ownership token(s) remain`);
  if (s.change_of_address_set) add('change-of-address-set', 'change-of-address-set', 'a change of address is set; Google is being told the site moved');
  if (s.bulk_export_configured) add('bulk-export-configured', 'bulk-export-configured', 'bulk data export is configured, which needs a Cloud project the operator declined');
  if (s.ai_control === 'exclude') add('ai-control-exclude', 'ai-control-exclude', 'Search generative AI is set to Exclude; the store is removed from AI Overviews and AI Mode');
  if (s.email_notifications === false) add('email-notifications-off', 'email-notifications-off', 'Search Console email notifications are off; critical issues would go unseen');

  for (const host of s.secondary_domains ?? []) {
    if (!opts.redirectProbes || !(host in opts.redirectProbes)) continue; // offline: skipped
    const probe = opts.redirectProbes[host];
    if (probe === null) {
      add('secondary-domain-redirect', host, 'the redirect probe failed; could not confirm the host redirects', INFO);
      continue;
    }
    const target = probe.location ? hostOf(probe.location, `https://${host}/`) : null;
    const good = [301, 308].includes(probe.status) && (target === PROPERTY_HOST || target === `www.${PROPERTY_HOST}`);
    add('secondary-domain-redirect', host,
      good ? `answers ${probe.status} to the canonical host; no separate property needed`
        : `answers ${probe.status}${target ? ` to ${target}` : ''}, not a permanent redirect to the canonical host`,
      good ? INFO : WARN);
  }
}

function crawlChecks({ okRep, add, age }) {
  const c = okRep('crawl-stats');
  if (!c) return;
  if (c.robots_state === 'not-seen') {
    const early = age !== null && age <= ROBOTS_GRACE_DAYS;
    add('robots-not-seen', 'robots-not-seen', `Search Console has not fetched robots.txt (property age ${age ?? 'unknown'} day(s), ROBOTS_GRACE_DAYS ${ROBOTS_GRACE_DAYS})`, early ? INFO : WARN);
  }
  if (c.robots_state === 'error') add('robots-fetch-error', 'robots-fetch-error', 'the robots.txt report shows a fetch error');
  if (c.host_status === 'issues') add('crawl-host-issues', 'crawl-host-issues', 'Crawl stats reports host status issues');
  if (Number.isInteger(c.requests) && c.requests > 0) {
    if (c.share_5xx !== null && c.share_5xx > CRAWL_5XX_SHARE) {
      add('crawl-5xx-share', 'crawl-5xx-share', `5xx share ${c.share_5xx} of ${c.requests} requests (CRAWL_5XX_SHARE ${CRAWL_5XX_SHARE})`);
    }
    if (c.share_4xx !== null && c.share_4xx > CRAWL_4XX_SHARE) {
      add('crawl-4xx-share', 'crawl-4xx-share', `other-4xx share ${c.share_4xx} of ${c.requests} requests, where 429s land (CRAWL_4XX_SHARE ${CRAWL_4XX_SHARE})`);
    }
  }
}

function associationChecks({ okRep, add }) {
  const a = okRep('associations');
  if (!a) return;
  for (const svc of ['analytics', 'merchant-center']) {
    if (!a.services.includes(svc)) add('association-missing', svc, `no ${svc} association; see the TODO.md channel items`);
  }
  if (a.pending > 0) add('association-pending', 'association-pending', `${a.pending} pending association request(s)`);
}

function removalChecks({ okRep, add, live }) {
  const r = okRep('removals');
  if (!r) return;
  if (r.temporary_active > 0) {
    const urls = r.temporary_urls ?? [];
    if (urls.length === 0) {
      add('removal-active', 'removal-active', `${r.temporary_active} temporary removal(s) active; URLs not captured`, WARN);
    }
    for (const u of urls) {
      const inSitemap = live.paths?.has(pathOf(u)) ?? false;
      add('removal-active', u, inSitemap ? 'temporarily removed from Google while still in the live sitemap' : 'temporarily removed from Google', inSitemap ? ERROR : WARN);
    }
  }
  if (r.outdated_active + r.safesearch_active > 0) {
    add('removal-other-active', 'removal-other-active', `${r.outdated_active} outdated-content and ${r.safesearch_active} SafeSearch request(s)`);
  }
}

function messageChecks({ okRep, add }) {
  const m = okRep('messages');
  if (m && m.unread > 0) add('messages-unread', 'messages-unread', `${m.unread} unread message(s) of ${m.total}`);
}

function sitemapChecks({ okRep, add, live, now }) {
  const sm = okRep('sitemaps');
  if (sm) {
    const index = sm.rows.find((r) => pathOf(r.path) === '/sitemap.xml');
    if (!index) add('sitemap-missing', 'sitemap-missing', '/sitemap.xml is not among the submitted sitemaps');
    for (const row of sm.rows) {
      if (row.status === "Couldn't fetch" || row.status === 'Has errors') add('sitemap-error', row.path, `status ${row.status}`);
      if (row.status === 'Pending') add('sitemap-pending', row.path, 'submitted, not yet read');
      if (/^\/sitemap_[a-z]+_\d+\.xml$/.test(pathOf(row.path))) add('sitemap-child-submitted', row.path, 'a child sitemap submitted on its own; the index already lists it');
      const d = daysSince(row.last_read, now);
      if (d !== null && d > SITEMAP_STALE_READ_DAYS) add('sitemap-stale-read', row.path, `last read ${d} day(s) ago (SITEMAP_STALE_READ_DAYS ${SITEMAP_STALE_READ_DAYS})`);
    }
    if (index && index.status === 'Success' && live.count !== null && Math.abs(index.discovered_pages - live.count) > SITEMAP_TOLERANCE) {
      add('sitemap-discovered-mismatch', index.path, `Search Console discovered ${index.discovered_pages} page(s); the live sitemap lists ${live.count} (SITEMAP_TOLERANCE ${SITEMAP_TOLERANCE})`);
    }
  }
  if (live.state === 'unreachable' || live.state === 'partial') {
    add('sitemap-live-unreachable', 'sitemap-live-unreachable', live.state === 'partial' ? 'a child sitemap failed; live counts skipped' : 'the live sitemap index could not be fetched; live counts skipped');
  }
}

function indexingChecks({ okRep, add, live }) {
  const ix = okRep('indexing-pages');
  if (!ix) return;
  if (live.count !== null) {
    const exempt = live.paths ? [...live.paths].filter(isNoindexOk).length : 0;
    const expected = live.count - exempt;
    if (ix.indexed < expected) {
      const perf = okRep('performance');
      const early = !perf || perf.totals.impressions === 0;
      add('index-count-below-sitemap', 'index-count-below-sitemap', `${ix.indexed} indexed vs ${expected} indexable sitemap URL(s)`, early ? INFO : WARN);
    }
  }
  for (const r of ix.reasons) {
    if (r.count === 0) continue;
    if (r.reason === 'unknown') {
      add('index-reason-unknown', r.label, `a reason label this skill has not seen (${r.count} page(s)); route it per the self-discovery loop`);
      continue;
    }
    const id = `index-reason-${r.reason}`;
    const source = r.source ? `, source ${r.source}` : '';
    if (r.reason === 'noindex') {
      const flagged = r.examples.filter((u) => !isNoindexOk(pathOf(u)));
      for (const u of flagged) add(id, u, `noindex on a page outside NOINDEX_OK (${r.count} page(s)${source})`, ERROR);
      if (flagged.length === 0 && r.count > r.examples.length) {
        add(id, r.reason, `${r.count} noindex page(s), ${r.examples.length} example(s) all in NOINDEX_OK; unverified remainder`, WARN);
      }
      continue;
    }
    if (r.examples.length === 0) {
      add(id, r.reason, `${r.count} page(s)${source}; no examples captured`, r.reason === 'not-found' ? INFO : REASON_SEVERITY[r.reason]);
      continue;
    }
    for (const u of r.examples) {
      const sev = r.reason === 'not-found' ? (live.paths?.has(pathOf(u)) ? WARN : INFO) : REASON_SEVERITY[r.reason];
      add(id, u, `${r.count} page(s)${source}`, sev);
    }
  }
}

function inspectionChecks({ okRep, add, live, now }) {
  const ins = okRep('inspections');
  if (!ins) return;
  for (const item of ins.items) {
    const p = pathOf(item.url);
    const exempt = isNoindexOk(p);
    if (!exempt && (item.verdict === 'not-on-google' || !item.indexed)) add('inspect-not-indexed', item.url, 'URL is not on Google');
    if (item.user_canonical && item.google_canonical && canonicalForm(item.user_canonical) !== canonicalForm(item.google_canonical)) {
      add('inspect-canonical-mismatch', item.url, 'the user-declared and Google-selected canonicals differ');
    }
    const d = daysSince(item.last_crawl, now);
    if (d !== null && d > STALE_CRAWL_DAYS) add('inspect-stale-crawl', item.url, `last crawled ${d} day(s) ago (STALE_CRAWL_DAYS ${STALE_CRAWL_DAYS})`);
    const inSitemap = live.paths ? live.paths.has(p) : true;
    if (!exempt && inSitemap && (item.crawl_allowed === false || item.indexing_allowed === false)) {
      add('inspect-crawl-blocked', item.url, item.crawl_allowed === false ? 'crawl not allowed on a sitemap URL' : 'indexing not allowed on a sitemap URL');
    }
    if (item.page_fetch && !/success/i.test(item.page_fetch)) add('inspect-fetch-failed', item.url, `page fetch: ${item.page_fetch}`);
    if (item.verdict === 'on-google') {
      const rule = EXPECTED_RICH_RESULTS.find((r) => new RegExp(r.match).test(p));
      const missing = rule ? rule.require.filter((group) => !group.some((t) => has(item.rich_results, t))) : [];
      if (missing.length) add('inspect-rich-result-missing', item.url, `expected ${missing.map((g) => g.join(' or ')).join('; ')}`);
    }
    for (const sec of item.sections) {
      if (!has(INSPECTION_SECTIONS, sec)) add('inspect-section-unknown', sec, 'an inspection section this skill has not seen');
    }
  }
}

function experienceChecks({ okRep, reports, add }) {
  const cwv = okRep('cwv');
  if (cwv) {
    for (const device of ['mobile', 'desktop']) {
      const v = cwv[device];
      if (v === 'no-data') {
        add('cwv-no-data', device, 'not enough usage data; expected for months on a small site');
        continue;
      }
      if (v.poor > 0) add('cwv-poor', device, `${v.poor} poor URL(s), ${v.needs_improvement} need improvement, ${v.good} good`);
      if (v.needs_improvement > 0) add('cwv-needs-improvement', device, `${v.needs_improvement} URL(s) need improvement`);
    }
  }
  const hs = reports.https;
  if (hs?.status === 'not-present' || (hs?.status === 'ok' && hs.https_urls + hs.non_https_urls === 0)) {
    add('https-no-data', 'https-no-data', 'the HTTPS report has no data yet');
  }
  if (hs?.status === 'ok' && hs.non_https_urls > 0) add('https-non-https', 'https-non-https', `${hs.non_https_urls} URL(s) not served over HTTPS`);
}

function enhancementChecks({ reports, okRep, add }) {
  // Only a report that exists is judged. On the first live run a product inspection already listed
  // Product snippets, Merchant listings and Review snippets while the Enhancements section was still
  // absent from the navigation, so an absent section is not absent markup.
  const en = reports.enhancements;
  if (en?.status !== 'ok') return;
  const items = en.items;
  for (const item of items) {
    if (!has(ENHANCEMENT_TYPES, item.type)) add('enhancement-type-unknown', item.type, 'an enhancement type this skill has not seen');
    if (item.invalid > 0) add('enhancement-invalid', item.type, `${item.invalid} invalid item(s)`);
    if (item.warning > 0) add('enhancement-warning', item.type, `${item.warning} item(s) with warnings`);
  }
  const types = items.map((i) => i.type);
  if (has(types, 'Product snippets') && has(types, 'Merchant listings')) {
    add('enhancement-product-duplicate-evidence', 'enhancement-product-duplicate-evidence',
      'Product snippets and Merchant listings both report items; evidence for the Judge.me Product JSON-LD owner decision in TODO.md');
  }
  const ins = okRep('inspections');
  const productIndexed = ins?.items.some((i) => /^\/products\//.test(pathOf(i.url)) && i.verdict === 'on-google' && i.indexed);
  if (productIndexed) {
    for (const t of ['Product snippets', 'Breadcrumbs']) {
      if (!has(types, t)) add('enhancement-absent', t, 'absent while a product URL inspects as indexed');
    }
  }
}

function safetyChecks({ okRep, add }) {
  const sm = okRep('security-manual');
  if (!sm) return;
  if (sm.manual_actions === 'present') add('manual-action', 'manual-action', 'a manual action is listed');
  if (sm.security_issues === 'present') add('security-issue', 'security-issue', 'a security issue is listed');
}

function linkChecks({ okRep, add }) {
  const l = okRep('links');
  if (l && l.top_linking_sites === 0) add('links-none', 'links-none', 'no external linking sites reported');
}

function performanceChecks({ okRep, add, age, live, opts }) {
  const perf = okRep('performance');
  if (!perf) return;
  if (opts.previousPeriod && opts.previousPeriod !== perf.period) {
    add('period-mismatch', 'period-mismatch', `the previous comparable run used ${opts.previousPeriod} and this one ${perf.period}; the pair is not compared`);
  }
  const searchType = perf.search_type.replace(/^search type:\s*/i, '');
  if (!has(KNOWN_SURFACES.search_types, searchType)) add('search-type-new', searchType, 'a search type this skill has not seen');

  const total = perf.totals.impressions;
  if (total === 0) {
    add('perf-zero-impressions', 'perf-zero-impressions', `no impressions in ${perf.period}`);
    return;
  }
  const asCaptured = (t) => (perf[t].truncated ? ' (top rows as captured)' : '');

  const queries = perf.queries.rows;
  if (queries.length > 0 && total >= NOISE_FLOOR_IMPRESSIONS && queries.every((q) => isBrandQuery(q.query))) {
    const late = age !== null && age > BRAND_ONLY_MIN_AGE_DAYS;
    add('perf-brand-only', 'perf-brand-only', `all ${queries.length} captured queries are brand queries${asCaptured('queries')}`, late ? WARN : INFO);
  }

  const [lo, hi] = OPPORTUNITY_POSITIONS;
  for (const row of perf.pages.rows) {
    if (row.impressions >= CTR_MIN_IMPRESSIONS && row.ctr < CTR_MIN && row.position >= 1 && row.position <= CTR_MAX_POSITION) {
      add('perf-low-ctr', row.url, `${row.impressions} impressions, ctr ${row.ctr}, position ${row.position}${asCaptured('pages')}`);
    }
    if (row.impressions >= OPPORTUNITY_MIN_IMPRESSIONS && row.position >= lo && row.position <= hi) {
      const band = queries.filter((q) => q.position >= lo && q.position <= hi && q.impressions >= OPPORTUNITY_MIN_IMPRESSIONS).length;
      add('perf-position-opportunity', row.url, `position ${row.position} on ${row.impressions} impressions; ${band} captured query row(s) in the same band`);
    }
  }

  if (total >= NOISE_FLOOR_IMPRESSIONS) {
    const outside = perf.countries.rows
      .filter((r) => !/^(united states|usa|us)$/i.test(r.country))
      .reduce((s, r) => s + r.impressions, 0);
    const share = outside / total;
    if (share > COUNTRY_OUTSIDE_US_SHARE) {
      add('perf-country-outside-us', 'perf-country-outside-us', `${Math.round(share * 1000) / 10}% of impressions outside the US (COUNTRY_OUTSIDE_US_SHARE ${COUNTRY_OUTSIDE_US_SHARE})${asCaptured('countries')}`);
    }
  }

  if (live.urls && !perf.pages.truncated) {
    const seen = new Set(perf.pages.rows.map((r) => pathOf(r.url)));
    const late = age !== null && age >= PAGE_NO_IMPRESSIONS_MIN_AGE_DAYS;
    for (const u of live.urls) {
      const p = pathOf(u);
      if (!seen.has(p) && !isNoindexOk(p)) add('perf-page-no-impressions', u, `in the live sitemap, absent from the PAGES tab for ${perf.period}`, late ? WARN : INFO);
    }
  }
}

function discoveryChecks({ okRep, add, now }) {
  const reviewed = daysSince(KNOWN_SURFACES_REVIEWED_ON, now);
  if (reviewed !== null && reviewed > DISCOVERY_REVIEW_DAYS) {
    add('discovery-review-due', 'discovery-review-due', `KNOWN_SURFACES last reviewed ${reviewed} day(s) ago (DISCOVERY_REVIEW_DAYS ${DISCOVERY_REVIEW_DAYS})`);
  }
  const disc = okRep('discovery');
  if (!disc) return;

  if (disc.nav.length) {
    const known = KNOWN_SURFACES.nav;
    for (const n of disc.nav) {
      const match = known.find((k) => labelKey(k.label) === labelKey(n.label));
      if (!match || (n.path !== null && match.path !== null && match.path !== n.path) || (match.path === null && n.path)) {
        add('surface-new', `nav:${n.label}`, `a navigation item this skill has not seen${n.path ? ` (view ${n.path})` : ''}`);
      }
    }
    for (const k of known) {
      if (!k.conditional && !disc.nav.some((n) => labelKey(n.label) === labelKey(k.label))) {
        add('surface-gone', `nav:${k.label}`, 'a known navigation item is missing; renamed or removed');
      }
    }
  }

  const lists = [
    ['settings_rows', 'settings'], ['user_settings_rows', 'user-settings'], ['performance_tabs', 'performance-tab'],
    ['removals_tabs', 'removals-tab'],
  ];
  for (const [key, kind] of lists) {
    if (disc[key].length === 0) continue;
    for (const label of disc[key]) {
      if (!has(KNOWN_SURFACES[key], label)) add('surface-new', `${kind}:${label}`, 'an item this skill has not seen');
    }
    for (const label of KNOWN_SURFACES[key]) {
      if (!has(disc[key], label)) add('surface-gone', `${kind}:${label}`, 'a known item is missing; renamed or removed');
    }
  }

  const controls = [...KNOWN_SURFACES.performance_controls, ...KNOWN_SURFACES.time_ranges];
  for (const label of disc.performance_controls) {
    if (!controls.some((c) => labelKey(label).startsWith(labelKey(c)))) add('surface-new', `performance-control:${label}`, 'a Performance control this skill has not seen');
  }
  for (const label of disc.inspection_sections) {
    if (!has(INSPECTION_SECTIONS, label)) add('inspect-section-unknown', label, 'an inspection section this skill has not seen');
  }
  for (const label of disc.enhancement_types) {
    if (!has(ENHANCEMENT_TYPES, label)) add('enhancement-type-unknown', label, 'an enhancement type this skill has not seen');
  }
  for (const label of disc.reason_labels) {
    if (!reasonSlugFor(label)) add('index-reason-unknown', label, 'a reason label this skill has not seen');
  }
  for (const u of disc.unknown) {
    add('surface-new', `${u.kind}:${u.label}`, `recorded for review: ${u.note}`);
  }
}

/**
 * @param {object} capture a normalised, validated capture
 * @param {object} [opts]
 * @param {string[]} [opts.sitemapUrls] live sitemap URLs
 * @param {number} [opts.sitemapCount] a live URL count when per-URL data is unavailable
 * @param {'ok'|'partial'|'unreachable'|'skipped'} [opts.sitemapState]
 * @param {Record<string, {status:number, location:string|null}|null>} [opts.redirectProbes] by host
 * @param {string|null} [opts.previousPeriod] period of the latest comparable performance run
 * @param {number} [opts.propertyAgeDays] overrides the age derived from property_added
 * @param {Date|string|number} [opts.now]
 * @returns {Array<{check:string, severity:string, url:string, detail:string}>}
 */
export function evaluateCapture(capture, opts = {}) {
  const now = opts.now ?? new Date();
  const findings = [];
  const add = (check, subject, detail, severity) => {
    if (!Object.hasOwn(DEFS, check)) throw new Error(`unregistered check id ${JSON.stringify(check)}; add it to DEFS in lib/checks.mjs`);
    findings.push({ check, severity: severity ?? SEVERITY[check], url: String(subject), detail: clip(detail) });
  };
  const reports = capture?.reports ?? {};
  const okRep = (id) => (reports[id]?.status === 'ok' ? reports[id] : null);
  const age = Number.isInteger(opts.propertyAgeDays) ? opts.propertyAgeDays : daysSince(capture?.property_added, now);
  const ctx = { capture, reports, okRep, add, age, now, opts, live: liveSitemap(opts) };

  envelopeChecks(ctx);
  settingsChecks(ctx);
  crawlChecks(ctx);
  associationChecks(ctx);
  removalChecks(ctx);
  messageChecks(ctx);
  sitemapChecks(ctx);
  indexingChecks(ctx);
  inspectionChecks(ctx);
  experienceChecks(ctx);
  enhancementChecks(ctx);
  safetyChecks(ctx);
  linkChecks(ctx);
  performanceChecks(ctx);
  discoveryChecks(ctx);

  // One finding per identity key, keeping the most severe: the discovery inventory and a report
  // can name the same unknown label.
  const byKey = new Map();
  for (const f of findings) {
    const key = findingKey(f);
    const prev = byKey.get(key);
    if (!prev || SEV_RANK[f.severity] < SEV_RANK[prev.severity]) byKey.set(key, f);
  }
  return [...byKey.values()];
}
