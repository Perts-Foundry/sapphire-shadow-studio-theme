// Names, alt text, filenames, and spec hashing for the applique pattern charts. Pure and
// dependency-free (node:crypto only) so every rule here is unit-testable without a network.
//
// Two contracts live here and must not drift apart:
//
//   1. The colour guard wraps matchedColorValues() from scripts/lib/photo-naming.mjs, the same
//      whole-word, separator-aware, case-insensitive match the storefront gallery filter applies
//      (docs/product-media-alt-text.md). A pattern name or a rendered chart alt that names ANY
//      Color option value would bind the chart to that colour and un-share it, so the guard
//      rejects it outright.
//   2. The charset constant below is the single source of truth for what may appear in a pattern
//      name or thread word: word characters plus exactly the separator set the guard treats as
//      word boundaries. Anything outside that set (an en dash in "Black-Watch" typed as U+2013,
//      any em dash) could carry a colour value past the guard without whole-word-matching it, so
//      it is rejected at validation rather than special-cased in the matcher.

import { createHash } from 'node:crypto';
import { matchedColorValues } from '../../lib/photo-naming.mjs';

// Word characters plus the guard's separator set: - _ , . / ( ) : ; ' and the plain space.
// (photo-naming.mjs's separator set also spans other whitespace; names are single-line, so only
// the space is admitted here.) Consumed by both registry validation and the guard tests.
export const NAME_CHARSET_RE = /^[A-Za-z0-9\-_,./():;' ]+$/;

export const ALT_MAX = 512; // Shopify's media alt limit; charset above is ASCII, so length = bytes

/**
 * Why a string is unacceptable as a pattern name / thread word / chart title, or null when it is
 * fine. Em and en dashes get named messages (the repo bans em dashes outright; an en dash is the
 * verified guard-evasion hole); everything else falls to the shared charset rule.
 * @param {string} value
 * @param {string} [what] - label used in the message ("name", "thread", ...)
 * @returns {string | null}
 */
export function charsetProblem(value, what = 'name') {
  const s = String(value ?? '');
  if (!s.trim()) return `${what} is empty`;
  // The dash literals are written as \u escapes so the repo's em-dash sweep stays clean.
  if (s.includes('\u{2014}')) return `${what} contains an em dash (banned repo-wide); use a comma, colon, or period`;
  if (s.includes('\u{2013}')) return `${what} contains an en dash, which the colour guard does not treat as a word boundary; use a plain hyphen`;
  if (!NAME_CHARSET_RE.test(s)) {
    return `${what} contains characters outside the allowed set (letters, digits, space, and - _ , . / ( ) : ; ')`;
  }
  return null;
}

/**
 * The Color option values a string would bind to on the storefront, under the exact gallery
 * semantics (whole word, phrase-only for multi-word values, case-insensitive).
 * @param {string} text
 * @param {string[]} colorValues
 * @returns {string[]}
 */
export function colorConflicts(text, colorValues) {
  return matchedColorValues(text, colorValues);
}

/**
 * Reject a pattern name that names any Color option value. Thread words never enter alt text, so
 * they are not guarded here; only names (and the rendered alt built from them) are.
 * @param {string} name
 * @param {string[]} colorValues
 * @returns {string | null} an error string, or null when the name is safe
 */
export function nameColorProblem(name, colorValues) {
  const hits = colorConflicts(name, colorValues);
  if (!hits.length) return null;
  return `name "${name}" whole-word-matches Color value(s) [${hits.join(', ')}]; the chart would bind to that colour instead of staying shared`;
}

/**
 * The pinned alt template for a chart page. Pattern names only, never thread words. Hard-fails
 * past ALT_MAX rather than truncating (a truncated alt silently changes what the guard checked).
 * @param {object} input
 * @param {number} input.page - 1-based page number
 * @param {number} input.pages - total pages
 * @param {number} input.first - first pattern number on the page
 * @param {number} input.last - last pattern number on the page
 * @param {string[]} input.names - pattern names on the page, in display order
 * @returns {string}
 */
export function buildChartAlt({ page, pages, first, last, names }) {
  const alt = `Applique pattern chart ${page} of ${pages}: patterns ${first}-${last}, ${names.join(', ')}`;
  if (alt.length > ALT_MAX) {
    throw new Error(`chart ${page} alt text is ${alt.length} characters (limit ${ALT_MAX}); shorten pattern names or split pages`);
  }
  return alt;
}

// The alt-side identification signal for chart media. Anchored to the pinned template's opening.
export const CHART_ALT_RE = /^Applique pattern chart \d+ of \d+/;

/** @param {string} alt @returns {boolean} */
export function isChartAlt(alt) {
  return CHART_ALT_RE.test(String(alt ?? ''));
}

/**
 * The canonical chart filename. hash8 is the spec hash's first 8 hex chars, so a spec change
 * changes the filename and a re-publish is detectable by name alone.
 * @param {object} input
 * @param {string} input.handle
 * @param {number} input.page
 * @param {number} input.pages
 * @param {string} input.hash8
 * @returns {string}
 */
export function chartFilename({ handle, page, pages, hash8 }) {
  return `${handle}-applique-pattern-chart-${page}-of-${pages}-${hash8}.jpg`;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The filename-side identification signal for chart media. Tolerates the CDN's collision suffix
 * (Shopify may append `_<token>` before the extension when a filename already exists).
 * @param {string} basename
 * @param {string} handle
 * @returns {boolean}
 */
export function isChartFilename(basename, handle) {
  const re = new RegExp(
    `^${escapeRe(handle)}-applique-pattern-chart-\\d+-of-\\d+-[0-9a-f]{8}(?:_[A-Za-z0-9-]+)?\\.jpe?g$`,
    'i',
  );
  return re.test(String(basename ?? ''));
}

/**
 * The decoded basename of a CDN URL, with query and version params dropped. Returns '' for
 * anything that does not parse as a URL, so callers can treat '' as "no filename signal".
 * @param {string} url
 * @returns {string}
 */
export function basenameFromUrl(url) {
  try {
    const u = new URL(String(url));
    const last = u.pathname.split('/').pop() || '';
    return decodeURIComponent(last);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Spec hashing. The spec captures everything that changes a chart's pixels or its alt: the page's
// patterns (number, id, name, thread, hero content hash, crop) in display order, every grid
// param, and styleVersion (bumped on any renderer restyle so existing charts republish).
// Discontinued patterns are not in the spec at all, so editing one never churns hashes.
// ---------------------------------------------------------------------------

// Deterministic serialization: object keys sorted recursively, arrays kept in order. Input key
// order therefore never affects the hash; array (display) order deliberately does.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Build the hashable spec for one chart page.
 * @param {object} input
 * @param {object} input.chart - the registry's chart params
 * @param {number} input.page
 * @param {number} input.pages
 * @param {Array<{number: number, id: string, name: string, thread: string, heroSha256: string,
 *   crop: {left: number, top: number, width: number, height: number}}>} input.patterns
 * @returns {object}
 */
export function chartSpec({ chart, page, pages, patterns }) {
  return {
    styleVersion: chart.styleVersion,
    grid: {
      columns: chart.columns,
      rows: chart.rows,
      cell_aspect: chart.cell_aspect,
      cell_fit: chart.cell_fit,
      title: chart.title,
      width_units: chart.width_units,
      scale: chart.scale,
    },
    page,
    pages,
    patterns: patterns.map((p) => ({
      number: p.number,
      id: p.id,
      name: p.name,
      thread: p.thread,
      heroSha256: p.heroSha256,
      crop: { left: p.crop.left, top: p.crop.top, width: p.crop.width, height: p.crop.height },
    })),
  };
}

/** @param {object} spec @returns {string} 64-char sha256 hex */
export function specHash(spec) {
  return createHash('sha256').update(canonical(spec)).digest('hex');
}

/** @param {string} hash @returns {string} the filename-embedded prefix */
export function hash8(hash) {
  return String(hash).slice(0, 8);
}
