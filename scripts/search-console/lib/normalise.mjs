// normalise.mjs -- turn what a person reads off Search Console into what the schema accepts.
//
// WHY A SEPARATE PASS. The transcription is easiest to get right when it copies the page's own
// text: "3.2%", "1,234", "Crawled - currently not indexed", "URL is on Google", "Yes". Asking the
// transcriber to convert each of those by hand is asking for the unit slips the schema then has to
// catch. So this pass does the mechanical conversions, runs BEFORE validation, and is idempotent:
// a capture that is already normalised comes back unchanged, so re-running review.mjs on a saved
// capture never drifts it.
//
// It refuses exactly one convenience: "1.2K" and "1.5M". An abbreviated count is not a number, it
// is a range, and guessing its value would put an invented figure into a baseline.

import { propertyHost, onPropertyHost, reasonSlugFor } from './schema.mjs';

const INT_KEYS = new Set([
  'clicks', 'impressions', 'count', 'indexed', 'not_indexed', 'owners', 'users', 'unused_tokens',
  'ownership_events', 'pending', 'requests', 'temporary_active', 'outdated_active', 'safesearch_active',
  'unread', 'total', 'discovered_pages', 'discovered_videos', 'videos', 'good', 'needs_improvement',
  'poor', 'https_urls', 'non_https_urls', 'valid', 'invalid', 'warning', 'top_linking_sites', 'links',
]);
const RATE_KEYS = new Set(['ctr', 'share_5xx', 'share_4xx']);
const DECIMAL_KEYS = new Set(['position']);
const BOOL_KEYS = new Set([
  'verified', 'change_of_address_set', 'bulk_export_configured', 'email_notifications', 'indexed',
  'crawl_allowed', 'indexing_allowed', 'truncated',
]);

// JSON pointer shapes (as segment arrays, `*` for any one segment) whose string is a URL.
const PAGE_URL_PATHS = [
  ['reports', 'sitemaps', 'rows', '*', 'path'],
  ['reports', 'indexing-pages', 'reasons', '*', 'examples', '*'],
  ['reports', 'inspections', 'items', '*', 'url'],
  ['reports', 'links', 'top_linked_pages', '*', 'url'],
  ['reports', 'links', 'internal_top', '*', 'url'],
  ['reports', 'performance', 'pages', 'rows', '*', 'url'],
  ['reports', 'removals', 'temporary_urls', '*'],
];
const CANONICAL_PATHS = [
  ['reports', 'inspections', 'items', '*', 'user_canonical'],
  ['reports', 'inspections', 'items', '*', 'google_canonical'],
];

const VERDICTS = { 'url is on google': 'on-google', 'url is not on google': 'not-on-google' };

const matches = (segments, pattern) =>
  segments.length === pattern.length && pattern.every((p, i) => p === '*' || p === segments[i]);

const pointer = (segments) => segments.map((s) => `/${String(s).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');

const round4 = (n) => Math.round(n * 10000) / 10000;

function parseNumber(s, key, segments, errors) {
  if (/^[\d.,]+\s*[kmb]$/i.test(s)) {
    errors.push({ path: pointer(segments), message: 'abbreviated number (K, M or B); transcribe the exact value shown on hover or in the table' });
    return s;
  }
  if (RATE_KEYS.has(key)) {
    if (/^<\s*0\.1\s*%$/.test(s)) return 0.0005;
    const pct = s.match(/^([\d,]*\.?\d+)\s*%$/);
    if (pct) return round4(Number(pct[1].replace(/,/g, '')) / 100);
  }
  if (/^[\d,]*\.?\d+$/.test(s)) {
    const n = Number(s.replace(/,/g, ''));
    if (Number.isFinite(n)) return RATE_KEYS.has(key) ? round4(n) : n;
  }
  return s;
}

function normaliseUrl(s, kind, origin, property, segments, errors) {
  let u;
  try {
    u = s.startsWith('/') && origin ? new URL(s, origin) : new URL(s);
  } catch {
    return s;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return s;
  u.search = '';
  u.hash = '';
  if (kind === 'page' && property && !onPropertyHost(u.host, property)) {
    errors.push({ path: pointer(segments), message: 'URL is on a host outside the property; drop it from the capture' });
  }
  return u.href;
}

function normaliseString(raw, key, segments, ctx) {
  const s = raw.trim();
  // The discovery inventory records labels and view paths as the page shows them, and the Overview
  // view path is legitimately the empty string; only report data turns a blank or a dash into null.
  if (segments[1] === 'discovery') return s;
  if (s === '' || /^[-‐-―]$/.test(s)) return null;
  if (PAGE_URL_PATHS.some((p) => matches(segments, p))) return normaliseUrl(s, 'page', ctx.origin, ctx.property, segments, ctx.errors);
  if (CANONICAL_PATHS.some((p) => matches(segments, p))) return normaliseUrl(s, 'canonical', ctx.origin, ctx.property, segments, ctx.errors);
  if (segments[0] === 'reports' && segments[1] !== 'discovery') {
    if (BOOL_KEYS.has(key) && /^(yes|no|true|false)$/i.test(s)) return /^(yes|true)$/i.test(s);
    if (INT_KEYS.has(key) || RATE_KEYS.has(key) || DECIMAL_KEYS.has(key)) return parseNumber(s, key, segments, ctx.errors);
    if (key === 'verdict' && VERDICTS[s.toLowerCase()]) return VERDICTS[s.toLowerCase()];
    if (key === 'status') return s.replace(/[‘’]/g, "'");
  }
  return s;
}

function walk(value, segments, ctx) {
  const key = segments[segments.length - 1];
  if (typeof value === 'string') return normaliseString(value, key, segments, ctx);
  if (typeof value === 'number' && RATE_KEYS.has(key) && segments[0] === 'reports') return round4(value);
  if (Array.isArray(value)) return value.map((v, i) => walk(v, [...segments, String(i)], ctx));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, [...segments, k], ctx);
    return out;
  }
  return value;
}

/**
 * @param {unknown} input a parsed capture, as transcribed
 * @returns {{ capture: unknown, errors: Array<{ path: string, message: string }> }}
 */
export function normaliseCapture(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { capture: input, errors: [] };
  const property = typeof input.property === 'string' ? input.property.trim() : input.property;
  const host = propertyHost(property);
  const ctx = { errors: [], property: host ? property : null, origin: host ? `https://${host}` : null };
  const capture = walk(input, [], ctx);

  const reports = capture.reports;
  if (reports && typeof reports === 'object' && !Array.isArray(reports)) {
    for (const [id, rep] of Object.entries(reports)) {
      if (rep && typeof rep === 'object' && !Array.isArray(rep) && !('report' in rep)) rep.report = id;
    }
    const reasons = reports['indexing-pages']?.reasons;
    if (Array.isArray(reasons)) {
      for (const r of reasons) {
        if (!r || typeof r !== 'object' || typeof r.reason !== 'string') continue;
        const slug = reasonSlugFor(r.reason);
        if (slug) {
          r.reason = slug;
        } else if (r.reason !== 'unknown') {
          if (!r.label) r.label = r.reason;
          r.reason = 'unknown';
        }
      }
    }
  }
  return { capture, errors: ctx.errors };
}
