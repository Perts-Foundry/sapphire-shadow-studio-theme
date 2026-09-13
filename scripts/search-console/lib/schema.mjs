// schema.mjs -- the capture contract, and the validator that is the transcription guard.
//
// WHY A STRICT SCHEMA. There is no Search Console API here (the operator declined a Cloud project),
// so every number in a capture was read off an accessibility snapshot and typed by Claude. The
// failure mode of transcription is not a crash, it is a plausible wrong number: clicks and
// impressions swapped, a percentage left as 3.2 instead of 0.032, a reason count that does not add
// up. So the schema refuses unknown keys at every depth and checks the cross-field invariants a
// real report always satisfies; a capture that fails is not evaluated, not saved and not diffed.
//
// SECURITY (public repo). Messages name the JSON pointer and the rule, never the offending value:
// a validation error is exactly the output someone pastes into an issue, and the value could be a
// query string, a token-shaped URL or an email address the capture should never have held.
//
// This module is a leaf: it imports nothing, so normalise.mjs, checks.mjs and known-surfaces.mjs
// can all depend on it without a cycle.

export const REPORTS = Object.freeze([
  'settings', 'associations', 'crawl-stats', 'removals', 'messages', 'sitemaps',
  'indexing-pages', 'inspections', 'cwv', 'https', 'enhancements', 'security-manual', 'links',
  'performance', 'discovery',
]);

// A capture missing one of these is refused outright: without it the run has nothing to stand on.
// Everything else a mode expects is EXPECTED_REPORTS_BY_MODE, and an absent one is an INFO finding
// (capture-missing-report), because a run the Login STOP cut short is still worth saving.
export const REQUIRED_REPORTS_BY_MODE = Object.freeze({
  audit: Object.freeze(['settings']),
  insights: Object.freeze(['performance']),
});

export const EXPECTED_REPORTS_BY_MODE = Object.freeze({
  audit: REPORTS,
  insights: Object.freeze(['performance', 'enhancements', 'links', 'discovery']),
});

export const STATUSES = Object.freeze(['ok', 'not-ready', 'not-present']);
export const PERIODS = Object.freeze(['24h', '7d', '28d', '3mo', '6mo', '12mo', '16mo']);

// Page indexing reason slugs. `unknown` carries the label as Search Console printed it.
export const KNOWN_REASONS = Object.freeze([
  'crawled-not-indexed', 'discovered-not-indexed', 'alternate-canonical', 'duplicate-no-canonical',
  'duplicate-google-chose-different', 'noindex', 'not-found', 'redirect', 'soft-404',
  'blocked-robots', 'server-error', 'forbidden', 'other-4xx', 'unknown',
]);

// Labels as observed or documented, keyed by their comparison form (see reasonKey).
export const REASON_LABELS = Object.freeze({
  'crawled - currently not indexed': 'crawled-not-indexed',
  'discovered - currently not indexed': 'discovered-not-indexed',
  'alternate page with proper canonical tag': 'alternate-canonical',
  'duplicate without user-selected canonical': 'duplicate-no-canonical',
  'duplicate, google chose different canonical than user': 'duplicate-google-chose-different',
  "excluded by 'noindex' tag": 'noindex',
  'not found (404)': 'not-found',
  'page with redirect': 'redirect',
  'soft 404': 'soft-404',
  'blocked by robots.txt': 'blocked-robots',
  'server error (5xx)': 'server-error',
  'blocked due to access forbidden (403)': 'forbidden',
  'blocked due to other 4xx issue': 'other-4xx',
});

/**
 * Comparison form of a label: case, quote style (straight or curly), dash style (hyphen, en or em
 * dash, written here as escapes) and spacing do not matter.
 */
export function reasonKey(label) {
  return String(label)
    .toLowerCase()
    .replace(/[‘’“”"]/g, "'")
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The slug for a label or an existing slug, or null when Search Console printed something new. */
export function reasonSlugFor(value) {
  if (typeof value !== 'string') return null;
  if (KNOWN_REASONS.includes(value) && value !== 'unknown') return value;
  return REASON_LABELS[reasonKey(value)] ?? null;
}

// The documented rich-result families that get an Enhancements report. An inspection's
// "Enhancements & Experience" rows use the same names.
export const ENHANCEMENT_TYPES = Object.freeze([
  'Product snippets', 'Merchant listings', 'Breadcrumbs', 'FAQ', 'Review snippets', 'Videos',
  'Sitelinks searchbox', 'Logos', 'Image metadata',
]);
export const RICH_RESULT_TYPES = ENHANCEMENT_TYPES;

// Section headings of an expanded URL inspection panel. Rich-result rows go in `rich_results`.
export const INSPECTION_SECTIONS = Object.freeze([
  'Page indexing', 'Discovery', 'Crawl', 'Indexing', 'Video indexing', 'Enhancements & Experience',
  'HTTPS',
]);

export const SITEMAP_STATUSES = Object.freeze(['Success', "Couldn't fetch", 'Has errors', 'Pending']);
export const SERVICES = Object.freeze(['analytics', 'merchant-center', 'youtube', 'ads']);

// Storefront routes whose URLs carry a customer or session token; never allowed in a capture. Each
// is matched as whole path segments anywhere in the path, case-insensitively: a checkout URL is
// often prefixed with the shop id, and `/accounts-receivable-tote` is a handle, not the account route.
export const FORBIDDEN_ROUTES = Object.freeze(['checkouts', 'account', 'orders', 'cart/c']);
const FORBIDDEN_ROUTE_RES = FORBIDDEN_ROUTES.map((r) => new RegExp(`(?:^|/)${r}(?:/|$)`, 'i'));

// A token is a run of 20 or more letters, digits or underscores that carries a digit or a capital.
// Hyphens break the run, so a product handle passes, and so does a long all-lowercase word. Shopify's
// child sitemap names (`sitemap_collections_1.xml`) are public and exempt by shape. A UUID is
// hyphenated, so it has its own pattern.
const TOKEN_RUN_RE = /[A-Za-z0-9_]{20,}/g;
const SITEMAP_CHILD_SEGMENT_RE = /^sitemap_[a-z]+_\d+\.xml$/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const NONCE_RE = /^[a-z0-9]{8,16}$/;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const VIEW_PATH_RE = /^[a-z0-9/-]*$/;

/**
 * The bare host a property covers: `sc-domain:example.com` is `example.com`, a URL-prefix property
 * is the host of its URL. Null when the value is neither.
 */
export function propertyHost(property) {
  if (typeof property !== 'string') return null;
  if (property.startsWith('sc-domain:')) {
    const host = property.slice('sc-domain:'.length).toLowerCase();
    return HOST_RE.test(host) ? host : null;
  }
  try {
    const u = new URL(property);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Is `host` covered by the property? A Domain property covers its subdomains; a URL prefix does not. */
export function onPropertyHost(host, property) {
  const ph = propertyHost(property);
  if (!ph || typeof host !== 'string') return false;
  const h = host.toLowerCase();
  if (h === ph) return true;
  return property.startsWith('sc-domain:') && h.endsWith(`.${ph}`);
}

/** Is one path segment token-shaped? */
export function isTokenSegment(segment) {
  if (SITEMAP_CHILD_SEGMENT_RE.test(segment)) return false;
  if (UUID_RE.test(segment)) return true;
  return (segment.match(TOKEN_RUN_RE) ?? []).some((run) => /[0-9A-Z]/.test(run));
}

/** Does a URL path sit on a forbidden route or carry a token-shaped segment? */
export function isSensitivePath(pathname) {
  if (FORBIDDEN_ROUTE_RES.some((re) => re.test(pathname))) return true;
  return pathname.split('/').some(isTokenSegment);
}

// ---------------------------------------------------------------------------------------------
// Validator combinators. Each is (value, pointer, ctx) and pushes { path, message } on failure.

const esc = (key) => String(key).replace(/~/g, '~0').replace(/\//g, '~1');
const at = (p, key) => `${p}/${esc(key)}`;
const fail = (ctx, path, message) => ctx.errors.push({ path, message });

const int = (v, p, ctx) => {
  if (!Number.isInteger(v) || v < 0) fail(ctx, p, 'expected a non-negative integer');
};
const num = (v, p, ctx) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) fail(ctx, p, 'expected a non-negative number');
};
const rate = (v, p, ctx) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) fail(ctx, p, 'expected a rate between 0 and 1');
};
const bool = (v, p, ctx) => {
  if (typeof v !== 'boolean') fail(ctx, p, 'expected a boolean');
};
const str = (max) => (v, p, ctx) => {
  if (typeof v !== 'string' || v.length === 0) fail(ctx, p, 'expected a non-empty string');
  else if (v.length > max) fail(ctx, p, `string longer than ${max} characters`);
};
const date = (v, p, ctx) => {
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    fail(ctx, p, 'expected a YYYY-MM-DD date');
  }
};
const isoOffset = (v, p, ctx) => {
  if (typeof v !== 'string' || !ISO_OFFSET_RE.test(v) || Number.isNaN(Date.parse(v))) {
    fail(ctx, p, 'expected an ISO 8601 timestamp with an offset');
  }
};
const dateOrIso = (v, p, ctx) => {
  if (typeof v === 'string' && DATE_RE.test(v)) return date(v, p, ctx);
  return isoOffset(v, p, ctx);
};
const oneOf = (values) => (v, p, ctx) => {
  if (!values.includes(v)) fail(ctx, p, `expected one of: ${values.join(', ')}`);
};
const nullable = (inner) => (v, p, ctx) => {
  if (v !== null) inner(v, p, ctx);
};
const host = (v, p, ctx) => {
  if (typeof v !== 'string' || !HOST_RE.test(v)) fail(ctx, p, 'expected a bare lowercase host');
};
const viewPath = (v, p, ctx) => {
  if (typeof v !== 'string' || !VIEW_PATH_RE.test(v)) fail(ctx, p, 'expected a Search Console view path');
  else if (v.split('/').some(isTokenSegment)) fail(ctx, p, 'view path carries a token-shaped segment');
};
const service = (v, p, ctx) => {
  if (SERVICES.includes(v)) return;
  if (typeof v === 'string' && /^other:.{1,60}$/.test(v)) return;
  fail(ctx, p, `expected one of: ${SERVICES.join(', ')}, or other:<text>`);
};

function urlShape(v, p, ctx) {
  if (typeof v !== 'string') {
    fail(ctx, p, 'expected an absolute URL');
    return null;
  }
  let u;
  try {
    u = new URL(v);
  } catch {
    fail(ctx, p, 'expected an absolute URL');
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    fail(ctx, p, 'expected an http(s) URL');
    return null;
  }
  if (u.search || v.includes('?')) fail(ctx, p, 'URL carries a query string');
  if (u.hash || v.includes('#')) fail(ctx, p, 'URL carries a fragment');
  if (isSensitivePath(u.pathname)) fail(ctx, p, 'URL path is a token-bearing or customer route');
  return u;
}

/** A storefront page URL: on the property host, no query, no fragment, no token-shaped path. */
const pageUrl = (v, p, ctx) => {
  const u = urlShape(v, p, ctx);
  if (u && ctx.property && !onPropertyHost(u.host, ctx.property)) fail(ctx, p, 'URL is not on the property host');
};
/** A canonical: any host (a canonical pointing at another host is a finding, not a typo). */
const anyUrl = (v, p, ctx) => {
  urlShape(v, p, ctx);
};

const arrayOf = (inner, { max = 1000 } = {}) => (v, p, ctx) => {
  if (!Array.isArray(v)) return fail(ctx, p, 'expected an array');
  if (v.length > max) fail(ctx, p, `array longer than ${max} entries`);
  v.forEach((item, i) => inner(item, at(p, i), ctx));
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const obj = (shape, optional = {}) => (v, p, ctx) => {
  if (!isPlainObject(v)) return fail(ctx, p, 'expected an object');
  for (const key of Object.keys(v)) {
    if (!(key in shape) && !(key in optional)) fail(ctx, at(p, key), 'unknown key');
  }
  for (const [key, check] of Object.entries(shape)) {
    if (!(key in v)) fail(ctx, at(p, key), 'required key missing');
    else check(v[key], at(p, key), ctx);
  }
  for (const [key, check] of Object.entries(optional)) {
    if (key in v) check(v[key], at(p, key), ctx);
  }
};

const cwvDevice = (v, p, ctx) => {
  if (v === 'no-data') return;
  obj({ good: int, needs_improvement: int, poor: int })(v, p, ctx);
};

const metrics = { clicks: int, impressions: int, ctr: rate, position: num };
const tab = (keyField, keyCheck) => obj({
  rows: arrayOf(obj({ [keyField]: keyCheck, ...metrics }), { max: 500 }),
  truncated: bool,
});
const linkRow = obj({ url: pageUrl, links: int });

export const REPORT_FIELDS = Object.freeze({
  settings: {
    required: {
      property_type: oneOf(['domain', 'url-prefix']), verified: bool, method: str(120), owners: int,
      users: int, unused_tokens: int, ownership_events: int, change_of_address_set: bool,
      bulk_export_configured: bool, ai_control: oneOf(['include', 'exclude']), email_notifications: bool,
    },
    optional: { secondary_domains: arrayOf(host, { max: 10 }) },
  },
  associations: { required: { services: arrayOf(service, { max: 20 }), pending: int } },
  'crawl-stats': {
    required: {
      robots_state: oneOf(['not-seen', 'fetched', 'error']), host_status: oneOf(['ok', 'issues', 'no-data']),
      requests: nullable(int), share_5xx: nullable(rate), share_4xx: nullable(rate),
    },
  },
  removals: {
    required: { temporary_active: int, outdated_active: int, safesearch_active: int },
    optional: { temporary_urls: arrayOf(pageUrl, { max: 50 }) },
  },
  messages: { required: { unread: int, total: int, subjects: arrayOf(str(120), { max: 100 }) } },
  sitemaps: {
    required: {
      rows: arrayOf(obj({
        path: pageUrl, type: str(40), status: oneOf(SITEMAP_STATUSES), discovered_pages: int,
        discovered_videos: int, submitted: nullable(date), last_read: nullable(date),
      }), { max: 500 }),
    },
  },
  'indexing-pages': {
    required: {
      indexed: int, not_indexed: int,
      reasons: arrayOf(obj(
        { reason: oneOf(KNOWN_REASONS), source: nullable(str(40)), count: int, examples: arrayOf(pageUrl, { max: 5 }) },
        { label: str(200) },
      ), { max: 50 }),
    },
  },
  inspections: {
    required: {
      items: arrayOf(obj({
        url: pageUrl, verdict: oneOf(['on-google', 'not-on-google']), indexed: bool,
        user_canonical: nullable(anyUrl), google_canonical: nullable(anyUrl), last_crawl: nullable(dateOrIso),
        crawled_as: nullable(str(60)), crawl_allowed: nullable(bool), page_fetch: nullable(str(60)),
        indexing_allowed: nullable(bool), discovery: arrayOf(str(200), { max: 20 }), videos: int,
        sections: arrayOf(str(80), { max: 30 }), rich_results: arrayOf(str(80), { max: 30 }),
      }), { max: 8 }),
    },
  },
  cwv: { required: { mobile: cwvDevice, desktop: cwvDevice } },
  https: { required: { https_urls: int, non_https_urls: int } },
  enhancements: {
    required: { items: arrayOf(obj({ type: str(80), valid: int, invalid: int, warning: int }), { max: 30 }) },
  },
  'security-manual': {
    required: {
      manual_actions: oneOf(['none', 'present']), security_issues: oneOf(['none', 'present']), text: str(200),
    },
  },
  links: {
    required: {
      top_linking_sites: int, top_linked_pages: arrayOf(linkRow, { max: 50 }), internal_top: arrayOf(linkRow, { max: 50 }),
    },
  },
  performance: {
    required: {
      period: oneOf(PERIODS), data_freshness: str(80), search_type: str(40), totals: obj(metrics),
      queries: tab('query', str(200)), pages: tab('url', pageUrl), countries: tab('country', str(60)),
      devices: obj({ desktop: obj(metrics), mobile: obj(metrics), tablet: obj(metrics) }),
    },
    optional: { search_appearance: tab('appearance', str(80)), days: tab('date', date) },
  },
  discovery: {
    required: {
      nav: arrayOf(obj({ label: str(80), path: nullable(viewPath) }), { max: 100 }),
      settings_rows: arrayOf(str(80), { max: 100 }), user_settings_rows: arrayOf(str(80), { max: 100 }),
      performance_tabs: arrayOf(str(80), { max: 50 }), performance_controls: arrayOf(str(80), { max: 50 }),
      removals_tabs: arrayOf(str(80), { max: 20 }), inspection_sections: arrayOf(str(80), { max: 50 }),
      enhancement_types: arrayOf(str(80), { max: 50 }), reason_labels: arrayOf(str(200), { max: 50 }),
      unknown: arrayOf(obj({ kind: str(40), label: str(80), path: nullable(viewPath), note: str(200) }), { max: 50 }),
    },
  },
});

const BASE_REPORT_KEYS = ['captured_at', 'report', 'status'];

function validateReport(id, rep, p, ctx) {
  if (!isPlainObject(rep)) return fail(ctx, p, 'expected an object');
  isoOffset(rep.captured_at, at(p, 'captured_at'), ctx);
  if (rep.report !== id) fail(ctx, at(p, 'report'), 'report must equal its key');
  if (!STATUSES.includes(rep.status)) {
    fail(ctx, at(p, 'status'), `expected one of: ${STATUSES.join(', ')}`);
    return;
  }
  if (rep.status !== 'ok') {
    for (const key of Object.keys(rep)) {
      if (!BASE_REPORT_KEYS.includes(key)) fail(ctx, at(p, key), `a ${rep.status} report carries no data fields`);
    }
    return;
  }
  const { required, optional = {} } = REPORT_FIELDS[id];
  const base = Object.fromEntries(BASE_REPORT_KEYS.map((k) => [k, () => {}]));
  obj({ ...base, ...required }, optional)(rep, p, ctx);
}

// Cross-field invariants a real report always satisfies. Each guard re-checks types, because these
// run even when the structural pass already failed, so every error is reported in one run.
function metricInvariants(m, p, ctx) {
  if (!isPlainObject(m)) return;
  const { clicks, impressions, ctr, position } = m;
  if (![clicks, impressions, ctr, position].every((x) => typeof x === 'number')) return;
  if (clicks > impressions) fail(ctx, p, 'clicks exceed impressions');
  if (impressions > 0) {
    if (Math.abs(ctr - clicks / impressions) > 0.005) fail(ctx, at(p, 'ctr'), 'ctr disagrees with clicks / impressions');
    if (position < 1 || position > 100) fail(ctx, at(p, 'position'), 'position must be between 1 and 100');
  } else {
    if (ctr !== 0) fail(ctx, at(p, 'ctr'), 'ctr must be 0 when impressions are 0');
    if (position !== 0 && (position < 1 || position > 100)) fail(ctx, at(p, 'position'), 'position must be 0 or between 1 and 100');
  }
}

function invariants(capture, ctx) {
  const reports = isPlainObject(capture.reports) ? capture.reports : {};
  const okRep = (id) => (isPlainObject(reports[id]) && reports[id].status === 'ok' ? reports[id] : null);

  const settings = okRep('settings');
  if (settings && Number.isInteger(settings.owners) && Number.isInteger(settings.users) && settings.owners > settings.users) {
    fail(ctx, '/reports/settings/owners', 'owners exceed users');
  }

  const messages = okRep('messages');
  if (messages && Number.isInteger(messages.unread) && Number.isInteger(messages.total) && messages.unread > messages.total) {
    fail(ctx, '/reports/messages/unread', 'unread exceeds total');
  }

  const idx = okRep('indexing-pages');
  if (idx && Array.isArray(idx.reasons) && Number.isInteger(idx.not_indexed)) {
    const sum = idx.reasons.reduce((s, r) => s + (Number.isInteger(r?.count) ? r.count : 0), 0);
    if (sum !== idx.not_indexed) fail(ctx, '/reports/indexing-pages/reasons', 'reason counts do not sum to not_indexed');
    idx.reasons.forEach((r, i) => {
      if (r?.reason === 'unknown' && !r.label) fail(ctx, `/reports/indexing-pages/reasons/${i}/label`, 'an unknown reason must carry its label');
      if (Number.isInteger(r?.count) && Array.isArray(r.examples) && r.examples.length > r.count) {
        fail(ctx, `/reports/indexing-pages/reasons/${i}/examples`, 'more examples than the reason count');
      }
    });
  }

  const perf = okRep('performance');
  if (perf) {
    metricInvariants(perf.totals, '/reports/performance/totals', ctx);
    for (const t of ['queries', 'pages', 'countries', 'search_appearance', 'days']) {
      if (isPlainObject(perf[t]) && Array.isArray(perf[t].rows)) {
        perf[t].rows.forEach((row, i) => metricInvariants(row, `/reports/performance/${t}/rows/${i}`, ctx));
      }
    }
    const total = perf.totals?.impressions;
    if (isPlainObject(perf.devices)) {
      for (const d of ['desktop', 'mobile', 'tablet']) metricInvariants(perf.devices[d], `/reports/performance/devices/${d}`, ctx);
      const sum = ['desktop', 'mobile', 'tablet'].reduce((s, d) => s + (Number.isInteger(perf.devices[d]?.impressions) ? perf.devices[d].impressions : 0), 0);
      if (Number.isInteger(total) && sum > total) fail(ctx, '/reports/performance/devices', 'device impressions exceed the total');
    }
    if (isPlainObject(perf.countries) && Array.isArray(perf.countries.rows) && Number.isInteger(total)) {
      const sum = perf.countries.rows.reduce((s, r) => s + (Number.isInteger(r?.impressions) ? r.impressions : 0), 0);
      if (sum > total) fail(ctx, '/reports/performance/countries', 'country impressions exceed the total');
    }
  }
}

function scanEmails(value, p, ctx) {
  if (typeof value === 'string') {
    if (EMAIL_RE.test(value)) fail(ctx, p, 'email-shaped string; record counts and roles, never an address');
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => scanEmails(v, at(p, i), ctx));
  } else if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (EMAIL_RE.test(k)) fail(ctx, at(p, k), 'email-shaped key');
      scanEmails(v, at(p, k), ctx);
    }
  }
}

const ENVELOPE_KEYS = ['schema', 'mode', 'property', 'property_added', 'captured_at', 'nonce', 'reports'];

/**
 * Validate a normalised capture. Every error is aggregated; no value is echoed back.
 * @param {unknown} capture
 * @returns {{ errors: Array<{ path: string, message: string }> }}
 */
export function validateCapture(capture) {
  const ctx = { errors: [], property: null };
  if (!isPlainObject(capture)) {
    fail(ctx, '', 'expected a JSON object');
    return { errors: ctx.errors };
  }
  for (const key of Object.keys(capture)) {
    if (!ENVELOPE_KEYS.includes(key)) fail(ctx, at('', key), 'unknown key');
  }
  if (capture.schema !== 1) fail(ctx, '/schema', 'expected schema 1');
  const modeOk = Object.hasOwn(REQUIRED_REPORTS_BY_MODE, capture.mode);
  if (!modeOk) fail(ctx, '/mode', 'expected audit or insights');
  if (propertyHost(capture.property)) ctx.property = capture.property;
  else fail(ctx, '/property', 'expected sc-domain:<host> or an http(s) URL prefix');
  date(capture.property_added, '/property_added', ctx);
  isoOffset(capture.captured_at, '/captured_at', ctx);
  if (typeof capture.nonce !== 'string' || !NONCE_RE.test(capture.nonce)) fail(ctx, '/nonce', 'expected 8 to 16 lowercase letters and digits');

  if (!isPlainObject(capture.reports)) {
    fail(ctx, '/reports', 'expected an object');
  } else {
    for (const [id, rep] of Object.entries(capture.reports)) {
      if (!REPORTS.includes(id)) fail(ctx, at('/reports', id), 'unknown report id');
      else validateReport(id, rep, at('/reports', id), ctx);
    }
    if (modeOk) {
      for (const id of REQUIRED_REPORTS_BY_MODE[capture.mode]) {
        if (!(id in capture.reports)) fail(ctx, at('/reports', id), `required for mode ${capture.mode}`);
      }
    }
    invariants(capture, ctx);
  }
  scanEmails(capture, '', ctx);
  return { errors: ctx.errors };
}
