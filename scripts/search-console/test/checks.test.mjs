import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCapture, CHECK_IDS, SEVERITY, SUBJECT_KIND, REPORT_OF, REASON_SEVERITY, ERROR, WARN, INFO,
  CTR_MIN, CTR_MIN_IMPRESSIONS, CTR_MAX_POSITION, OPPORTUNITY_POSITIONS, OPPORTUNITY_MIN_IMPRESSIONS,
  NOISE_FLOOR_IMPRESSIONS, COUNTRY_OUTSIDE_US_SHARE, CRAWL_5XX_SHARE, CRAWL_4XX_SHARE, ROBOTS_GRACE_DAYS,
  STALE_CAPTURE_DAYS, STALE_CRAWL_DAYS, SITEMAP_STALE_READ_DAYS, SITEMAP_TOLERANCE, BRAND_ONLY_MIN_AGE_DAYS,
  PAGE_NO_IMPRESSIONS_MIN_AGE_DAYS, DISCOVERY_REVIEW_DAYS, PROPERTY, PROPERTY_HOST, isNoindexOk, isBrandQuery,
  daysSince,
} from '../lib/checks.mjs';
import { findingKey } from '../../seo-review/lib/checks.mjs';
import { KNOWN_REASONS, REPORTS, validateCapture } from '../lib/schema.mjs';
import { KNOWN_SURFACES_REVIEWED_ON } from '../lib/known-surfaces.mjs';
import {
  FIXTURE_FOR, baseCapture, healthyOpts, readFixture, notReady, NOW, PREINDEX_NOW, ORIGIN, SITEMAP_URLS,
} from './harness.mjs';

const DAY_MS = 86_400_000;
const healthyFindings = evaluateCapture(baseCapture(), healthyOpts());

/** Evaluate the healthy capture after a mutation; returns the findings for one check id. */
function run(check, mutate = () => {}, optsMutate = () => {}) {
  const c = baseCapture();
  const o = healthyOpts();
  mutate(c.reports, c);
  optsMutate(o);
  return evaluateCapture(c, o).filter((f) => f.check === check);
}
const fires = (...args) => run(...args).length > 0;

test('the healthy capture produces no findings at all', () => {
  assert.deepEqual(healthyFindings, []);
});

for (const id of CHECK_IDS) {
  test(`fixture fires: ${id}`, () => {
    const make = FIXTURE_FOR[id];
    if (!make) throw new Error(`FIXTURE_FOR in test/harness.mjs has no mapping for ${id}`);
    const out = make();
    const findings = out.findings ?? evaluateCapture(out.capture, out.opts);
    assert.ok(findings.some((f) => f.check === id), `${id} did not fire: ${JSON.stringify(findings.map((f) => f.check))}`);
    assert.ok(!healthyFindings.some((f) => f.check === id), `${id} fires on the healthy capture`);
  });
}

test('FIXTURE_FOR names only registered check ids', () => {
  assert.deepEqual(Object.keys(FIXTURE_FOR).filter((id) => !CHECK_IDS.includes(id)), []);
});

function allFixtureFindings() {
  const out = [];
  for (const make of Object.values(FIXTURE_FOR)) {
    const r = make();
    out.push(...(r.findings ?? evaluateCapture(r.capture, r.opts)));
  }
  out.push(...evaluateCapture(readFixture('capture-problems.json'), healthyOpts()));
  out.push(...evaluateCapture(readFixture('capture-preindex.json'), { sitemapCount: 17, now: PREINDEX_NOW }));
  return out;
}

test('every emitted check id is registered, with a known severity', () => {
  for (const f of allFixtureFindings()) {
    assert.ok(CHECK_IDS.includes(f.check), f.check);
    assert.ok([ERROR, WARN, INFO].includes(f.severity), `${f.check} ${f.severity}`);
    assert.equal(typeof f.detail, 'string');
    assert.ok(f.detail.length <= 240);
  }
});

test('the registry tables cover the same ids', () => {
  assert.deepEqual(Object.keys(SEVERITY).sort(), [...CHECK_IDS]);
  assert.deepEqual(Object.keys(SUBJECT_KIND).sort(), [...CHECK_IDS]);
  assert.deepEqual(Object.keys(REPORT_OF).sort(), [...CHECK_IDS]);
  for (const report of Object.values(REPORT_OF)) assert.ok(report === 'envelope' || REPORTS.includes(report), report);
});

test('SUBJECT_KIND is honoured by every finding', () => {
  const isPage = (u) => {
    try {
      const url = new URL(u);
      return url.host === PROPERTY_HOST || url.host.endsWith(`.${PROPERTY_HOST}`);
    } catch {
      return false;
    }
  };
  for (const f of allFixtureFindings()) {
    const kind = SUBJECT_KIND[f.check];
    const s = f.url;
    const ok = {
      singleton: s === f.check,
      report: REPORTS.includes(s),
      page: isPage(s),
      'page-or-reason': isPage(s) || KNOWN_REASONS.includes(s),
      'page-or-singleton': isPage(s) || s === f.check,
      label: typeof s === 'string' && s.length > 0 && !isPage(s),
      service: ['analytics', 'merchant-center'].includes(s),
      host: /^[a-z0-9.-]+$/.test(s),
      device: ['mobile', 'desktop'].includes(s),
      'enhancement-type': typeof s === 'string' && s.length > 0 && !isPage(s),
      pointer: s.startsWith('/'),
    }[kind];
    assert.ok(ok, `${f.check} (${kind}) has subject ${s}`);
  }
});

test('performance findings are keyed by page, never by query', () => {
  const queries = new Set(baseCapture().reports.performance.queries.rows.map((q) => q.query));
  for (const f of allFixtureFindings().filter((x) => x.check.startsWith('perf-'))) {
    assert.ok(!queries.has(f.url), `${f.check} is keyed by a query`);
  }
});

test('REASON_SEVERITY covers exactly the known reasons', () => {
  assert.deepEqual(Object.keys(REASON_SEVERITY).sort(), KNOWN_REASONS.filter((r) => r !== 'unknown').sort());
});

test('the problems fixture fires every coexisting ERROR and WARN trigger, each key once', () => {
  const findings = evaluateCapture(readFixture('capture-problems.json'), healthyOpts());
  const keys = findings.map(findingKey);
  assert.equal(new Set(keys).size, keys.length, 'duplicate finding keys');
  const blocking = new Set(findings.filter((f) => f.severity !== INFO).map((f) => f.check));
  const expected = [
    'property-url-prefix', 'verification-lost', 'users-unexpected', 'change-of-address-set', 'ai-control-exclude',
    'email-notifications-off', 'robots-fetch-error', 'crawl-host-issues', 'crawl-5xx-share', 'crawl-4xx-share',
    'removal-active', 'sitemap-error', 'sitemap-child-submitted', 'sitemap-discovered-mismatch',
    'index-count-below-sitemap', 'index-reason-noindex', 'index-reason-crawled-not-indexed',
    'index-reason-duplicate-no-canonical', 'index-reason-duplicate-google-chose-different', 'index-reason-not-found',
    'index-reason-soft-404', 'index-reason-blocked-robots', 'index-reason-server-error', 'index-reason-forbidden',
    'index-reason-other-4xx', 'inspect-not-indexed', 'inspect-canonical-mismatch', 'inspect-crawl-blocked',
    'inspect-fetch-failed', 'cwv-poor', 'https-non-https', 'enhancement-invalid', 'enhancement-warning',
    'manual-action', 'security-issue', 'perf-brand-only', 'perf-page-no-impressions', 'perf-low-ctr',
  ];
  for (const id of expected) assert.ok(blocking.has(id), `problems fixture lost ${id}`);
});

test('the pre-index fixture raises nothing above INFO', () => {
  const findings = evaluateCapture(readFixture('capture-preindex.json'), { sitemapCount: 17, now: PREINDEX_NOW });
  assert.deepEqual(findings.filter((f) => f.severity !== INFO), []);
  const notReady = findings.filter((f) => f.check === 'gsc-not-ready').map((f) => f.url).sort();
  assert.deepEqual(notReady, ['indexing-pages', 'inspections', 'links', 'performance']);
  assert.ok(findings.some((f) => f.check === 'robots-not-seen' && f.severity === INFO), 'robots.txt state survives with no crawl data');
  assert.equal(findings.filter((f) => f.check === 'cwv-no-data').length, 2);
  assert.ok(!findings.some((f) => f.check === 'enhancement-absent'), 'an absent Enhancements section is not judged');
  assert.ok(findings.some((f) => f.check === 'https-no-data'));
  assert.ok(findings.some((f) => f.check === 'messages-unread'));
});

// Both sides of every threshold constant.
test('CTR_MIN, CTR_MIN_IMPRESSIONS and CTR_MAX_POSITION', () => {
  const row = (over) => (r) => { r.performance.pages.rows[0] = { ...r.performance.pages.rows[0], impressions: 200, position: 5, ctr: CTR_MIN - 0.005, ...over }; };
  assert.ok(fires('perf-low-ctr', row({})));
  assert.ok(!fires('perf-low-ctr', row({ ctr: CTR_MIN })));
  assert.ok(fires('perf-low-ctr', row({ impressions: CTR_MIN_IMPRESSIONS })));
  assert.ok(!fires('perf-low-ctr', row({ impressions: CTR_MIN_IMPRESSIONS - 1 })));
  assert.ok(fires('perf-low-ctr', row({ position: CTR_MAX_POSITION })));
  assert.ok(!fires('perf-low-ctr', row({ position: CTR_MAX_POSITION + 0.1 })));
});

test('OPPORTUNITY_POSITIONS (inclusive) and OPPORTUNITY_MIN_IMPRESSIONS', () => {
  const [lo, hi] = OPPORTUNITY_POSITIONS;
  const row = (over) => (r) => { Object.assign(r.performance.pages.rows[0], { impressions: 50, ...over }); };
  assert.ok(fires('perf-position-opportunity', row({ position: lo })));
  assert.ok(!fires('perf-position-opportunity', row({ position: lo - 0.1 })));
  assert.ok(fires('perf-position-opportunity', row({ position: hi })));
  assert.ok(!fires('perf-position-opportunity', row({ position: hi + 0.1 })));
  assert.ok(fires('perf-position-opportunity', row({ position: lo, impressions: OPPORTUNITY_MIN_IMPRESSIONS })));
  assert.ok(!fires('perf-position-opportunity', row({ position: lo, impressions: OPPORTUNITY_MIN_IMPRESSIONS - 1 })));
});

test('NOISE_FLOOR_IMPRESSIONS gates brand-only and the country share', () => {
  const brand = (total) => (r) => { r.performance.queries.rows = r.performance.queries.rows.slice(0, 1); r.performance.totals.impressions = total; };
  assert.ok(fires('perf-brand-only', brand(NOISE_FLOOR_IMPRESSIONS)));
  assert.ok(!fires('perf-brand-only', brand(NOISE_FLOOR_IMPRESSIONS - 1)));
  const country = (total) => (r) => { r.performance.totals.impressions = total; r.performance.countries.rows[1].impressions = total; };
  assert.ok(fires('perf-country-outside-us', country(NOISE_FLOOR_IMPRESSIONS)));
  assert.ok(!fires('perf-country-outside-us', country(NOISE_FLOOR_IMPRESSIONS - 1)));
});

test('COUNTRY_OUTSIDE_US_SHARE', () => {
  const at = (n) => (r) => { r.performance.countries.rows[1].impressions = n; };
  const exact = 2000 * COUNTRY_OUTSIDE_US_SHARE;
  assert.ok(!fires('perf-country-outside-us', at(exact)));
  assert.ok(fires('perf-country-outside-us', at(exact + 1)));
});

test('CRAWL_5XX_SHARE and CRAWL_4XX_SHARE, and no fire on zero or null requests', () => {
  const set = (over) => (r) => { Object.assign(r['crawl-stats'], over); };
  assert.ok(!fires('crawl-5xx-share', set({ share_5xx: CRAWL_5XX_SHARE })));
  assert.ok(fires('crawl-5xx-share', set({ share_5xx: CRAWL_5XX_SHARE + 0.001 })));
  assert.ok(!fires('crawl-4xx-share', set({ share_4xx: CRAWL_4XX_SHARE })));
  assert.ok(fires('crawl-4xx-share', set({ share_4xx: CRAWL_4XX_SHARE + 0.001 })));
  assert.ok(!fires('crawl-5xx-share', set({ share_5xx: 0.5, requests: 0 })));
  assert.ok(!fires('crawl-5xx-share', set({ share_5xx: 0.5, requests: null })));
});

test('ROBOTS_GRACE_DAYS gates robots-not-seen severity by property age', () => {
  const notSeen = (r) => { r['crawl-stats'].robots_state = 'not-seen'; };
  assert.equal(run('robots-not-seen', notSeen, (o) => { o.propertyAgeDays = ROBOTS_GRACE_DAYS; })[0].severity, INFO);
  assert.equal(run('robots-not-seen', notSeen, (o) => { o.propertyAgeDays = ROBOTS_GRACE_DAYS + 1; })[0].severity, WARN);
});

test('STALE_CAPTURE_DAYS', () => {
  const captured = Date.parse(baseCapture().captured_at);
  assert.ok(!fires('capture-stale', () => {}, (o) => { o.now = new Date(captured + STALE_CAPTURE_DAYS * DAY_MS); }));
  assert.ok(fires('capture-stale', () => {}, (o) => { o.now = new Date(captured + (STALE_CAPTURE_DAYS + 1) * DAY_MS); }));
});

test('STALE_CRAWL_DAYS', () => {
  const crawl = (days) => (r) => { r.inspections.items[0].last_crawl = new Date(NOW.getTime() - days * DAY_MS).toISOString(); };
  assert.ok(!fires('inspect-stale-crawl', crawl(STALE_CRAWL_DAYS)));
  assert.ok(fires('inspect-stale-crawl', crawl(STALE_CRAWL_DAYS + 1)));
});

test('SITEMAP_STALE_READ_DAYS', () => {
  const read = (days) => (r) => { r.sitemaps.rows[0].last_read = new Date(NOW.getTime() - days * DAY_MS).toISOString().slice(0, 10); };
  assert.ok(!fires('sitemap-stale-read', read(SITEMAP_STALE_READ_DAYS)));
  assert.ok(fires('sitemap-stale-read', read(SITEMAP_STALE_READ_DAYS + 1)));
});

test('SITEMAP_TOLERANCE', () => {
  const discovered = (n) => (r) => { r.sitemaps.rows[0].discovered_pages = n; };
  assert.ok(!fires('sitemap-discovered-mismatch', discovered(SITEMAP_URLS.length + SITEMAP_TOLERANCE)));
  assert.ok(fires('sitemap-discovered-mismatch', discovered(SITEMAP_URLS.length + SITEMAP_TOLERANCE + 1)));
  assert.ok(!fires('sitemap-discovered-mismatch', discovered(SITEMAP_URLS.length - SITEMAP_TOLERANCE)));
  assert.ok(fires('sitemap-discovered-mismatch', discovered(SITEMAP_URLS.length - SITEMAP_TOLERANCE - 1)));
});

test('BRAND_ONLY_MIN_AGE_DAYS gates brand-only severity', () => {
  const brand = (r) => { r.performance.queries.rows = r.performance.queries.rows.slice(0, 1); };
  assert.equal(run('perf-brand-only', brand, (o) => { o.propertyAgeDays = BRAND_ONLY_MIN_AGE_DAYS; })[0].severity, INFO);
  assert.equal(run('perf-brand-only', brand, (o) => { o.propertyAgeDays = BRAND_ONLY_MIN_AGE_DAYS + 1; })[0].severity, WARN);
});

test('PAGE_NO_IMPRESSIONS_MIN_AGE_DAYS gates page-no-impressions; truncation and count-only runs skip it', () => {
  const drop = (r) => { r.performance.pages.rows = r.performance.pages.rows.slice(1); };
  assert.equal(run('perf-page-no-impressions', drop, (o) => { o.propertyAgeDays = PAGE_NO_IMPRESSIONS_MIN_AGE_DAYS - 1; })[0].severity, INFO);
  assert.equal(run('perf-page-no-impressions', drop, (o) => { o.propertyAgeDays = PAGE_NO_IMPRESSIONS_MIN_AGE_DAYS; })[0].severity, WARN);
  assert.ok(!fires('perf-page-no-impressions', (r) => { drop(r); r.performance.pages.truncated = true; }));
  assert.ok(!fires('perf-page-no-impressions', drop, (o) => { delete o.sitemapUrls; o.sitemapCount = 17; }));
});

test('DISCOVERY_REVIEW_DAYS', () => {
  const reviewed = Date.parse(`${KNOWN_SURFACES_REVIEWED_ON}T00:00:00Z`);
  assert.ok(!fires('discovery-review-due', () => {}, (o) => { o.now = new Date(reviewed + DISCOVERY_REVIEW_DAYS * DAY_MS); }));
  assert.ok(fires('discovery-review-due', () => {}, (o) => { o.now = new Date(reviewed + (DISCOVERY_REVIEW_DAYS + 1) * DAY_MS); }));
});

test('brand-only is vacuous on zero queries and on zero impressions', () => {
  assert.ok(!fires('perf-brand-only', (r) => { r.performance.queries.rows = []; }));
  const zero = run('perf-brand-only', (r) => {
    r.performance.queries.rows = r.performance.queries.rows.slice(0, 1);
    r.performance.totals = { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  });
  assert.deepEqual(zero, []);
  assert.ok(isBrandQuery('Sapphire  Shadow studio hoodie'));
  assert.ok(isBrandQuery('sapphireshadow'));
  assert.ok(!isBrandQuery('nurse sweatshirt'));
});

test('the NOINDEX_OK remainder rule', () => {
  const noindex = (count, paths) => (r) => {
    r['indexing-pages'].reasons[0] = { reason: 'noindex', source: 'Website', count, examples: paths.map((p) => `${ORIGIN}${p}`) };
  };
  assert.deepEqual(run('index-reason-noindex', noindex(1, ['/blogs/shift-notes'])), []);
  const remainder = run('index-reason-noindex', noindex(3, ['/blogs/shift-notes', '/cart']));
  assert.equal(remainder.length, 1);
  assert.equal(remainder[0].severity, WARN);
  assert.equal(remainder[0].url, 'noindex');
  assert.match(remainder[0].detail, /unverified remainder/);
  const flagged = run('index-reason-noindex', noindex(2, ['/blogs/shift-notes', '/pages/faq']));
  assert.deepEqual(flagged.map((f) => [f.severity, new URL(f.url).pathname]), [[ERROR, '/pages/faq']]);
  assert.ok(isNoindexOk('/policies/refund-policy'));
  assert.ok(isNoindexOk('/account'));
  assert.ok(!isNoindexOk('/pages/policies'));
});

test('not-found is WARN only for a URL still in the live sitemap', () => {
  const nf = (p) => (r) => { r['indexing-pages'].reasons.push({ reason: 'not-found', source: 'Website', count: 1, examples: [`${ORIGIN}${p}`] }); };
  assert.equal(run('index-reason-not-found', nf('/pages/faq'))[0].severity, WARN);
  assert.equal(run('index-reason-not-found', nf('/pages/retired'))[0].severity, INFO);
});

test('a reason with no examples is one finding keyed by its slug', () => {
  const f = run('index-reason-soft-404', (r) => { r['indexing-pages'].reasons.push({ reason: 'soft-404', source: null, count: 4, examples: [] }); });
  assert.deepEqual(f.map((x) => x.url), ['soft-404']);
});

test('index-count-below-sitemap is INFO while performance is not ready or has no impressions', () => {
  const below = (r) => { r['indexing-pages'].indexed = 5; };
  assert.equal(run('index-count-below-sitemap', below)[0].severity, WARN);
  assert.equal(run('index-count-below-sitemap', (r) => { below(r); r.performance = notReady('performance'); })[0].severity, INFO);
  assert.equal(run('index-count-below-sitemap', (r) => { below(r); r.performance.totals = { clicks: 0, impressions: 0, ctr: 0, position: 0 }; })[0].severity, INFO);
  assert.ok(!fires('index-count-below-sitemap', below, (o) => { delete o.sitemapUrls; o.sitemapState = 'skipped'; }));
});

test('secondary-domain-redirect: permanent redirect INFO, anything else WARN, failure INFO, offline skipped', () => {
  const host = 'brand-alias.example';
  const probe = (p) => [(r) => { r.settings.secondary_domains = [host]; }, (o) => { o.redirectProbes = { [host]: p }; }];
  assert.equal(run('secondary-domain-redirect', ...probe({ status: 301, location: `https://${PROPERTY_HOST}/` }))[0].severity, INFO);
  assert.equal(run('secondary-domain-redirect', ...probe({ status: 308, location: `https://www.${PROPERTY_HOST}/` }))[0].severity, INFO);
  assert.equal(run('secondary-domain-redirect', ...probe({ status: 302, location: `https://${PROPERTY_HOST}/` }))[0].severity, WARN);
  assert.equal(run('secondary-domain-redirect', ...probe({ status: 301, location: 'https://elsewhere.example/' }))[0].severity, WARN);
  assert.equal(run('secondary-domain-redirect', ...probe(null))[0].severity, INFO);
  assert.deepEqual(run('secondary-domain-redirect', (r) => { r.settings.secondary_domains = [host]; }), []);
});

test('removal-active is ERROR only for a URL in the live sitemap', () => {
  const removal = (p) => (r) => { r.removals.temporary_active = 1; r.removals.temporary_urls = [`${ORIGIN}${p}`]; };
  assert.equal(run('removal-active', removal('/pages/about'))[0].severity, ERROR);
  assert.equal(run('removal-active', removal('/pages/retired'))[0].severity, WARN);
  assert.equal(run('removal-active', (r) => { r.removals.temporary_active = 2; })[0].severity, WARN);
});

test('inspect-crawl-blocked skips a URL absent from the live sitemap and NOINDEX_OK paths', () => {
  assert.ok(!fires('inspect-crawl-blocked', (r) => {
    r.inspections.items[2].url = `${ORIGIN}/collections/retired`;
    r.inspections.items[2].indexing_allowed = false;
  }));
  assert.ok(!fires('inspect-not-indexed'), 'the noindexed blog listing in the healthy capture is exempt');
});

test('enhancement checks judge only a present report: not-present and not-ready stay quiet', () => {
  assert.ok(!fires('enhancement-absent', (r) => { r.enhancements = notReady('enhancements', 'not-present'); }));
  assert.ok(!fires('enhancement-absent', (r) => { r.enhancements = notReady('enhancements'); }));
  assert.ok(fires('enhancement-absent', (r) => { r.enhancements.items = r.enhancements.items.slice(0, 1); }));
});

test('crawl-stats with no crawl data yet still carries the robots.txt state', () => {
  const c = baseCapture();
  c.reports['crawl-stats'] = {
    captured_at: c.captured_at, report: 'crawl-stats', status: 'ok', robots_state: 'not-seen', host_status: 'no-data',
    requests: null, share_5xx: null, share_4xx: null,
  };
  assert.deepEqual(validateCapture(c).errors, []);
  const o = healthyOpts();
  o.propertyAgeDays = 0;
  const crawl = evaluateCapture(c, o).filter((f) => REPORT_OF[f.check] === 'crawl-stats');
  assert.deepEqual(crawl.map((f) => [f.check, f.severity]), [['robots-not-seen', INFO]]);
});

test('surface-gone ignores conditional items and lists that were not inventoried', () => {
  assert.ok(!fires('surface-gone', (r) => { r.discovery.nav = r.discovery.nav.filter((n) => !['HTTPS', 'Enhancements'].includes(n.label)); }));
  assert.ok(!fires('surface-gone', (r) => { r.discovery.settings_rows = []; r.discovery.nav = []; }));
  assert.ok(fires('surface-gone', (r) => { r.discovery.settings_rows = r.discovery.settings_rows.slice(1); }));
  assert.ok(fires('surface-new', (r) => { r.discovery.nav.find((n) => n.label === 'Links').path = 'links-v2'; }));
  assert.ok(fires('surface-new', (r) => { r.discovery.unknown.push({ kind: 'nav', label: 'Shopping', path: 'shopping', note: 'a new report' }); }));
});

test('the same unknown label from discovery and a report is one finding', () => {
  const f = run('enhancement-type-unknown', (r) => {
    r.enhancements.items.push({ type: 'Shopping', valid: 1, invalid: 0, warning: 0 });
    r.discovery.enhancement_types.push('Shopping');
  });
  assert.equal(f.length, 1);
});

test('property constants and date helper', () => {
  assert.equal(PROPERTY, `sc-domain:${PROPERTY_HOST}`);
  assert.equal(daysSince('2026-11-30', NOW), 1);
  assert.equal(daysSince('not a date', NOW), null);
  assert.equal(daysSince(null, NOW), null);
});
