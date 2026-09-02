// Storefront render classifier (Tier A1). Pure: one observation in, findings out.
//
// An observation is what the orchestrator saw for one path: final status, final URL, the
// server-timing header, the body. Nothing here fetches, and nothing here puts body text into a
// finding: evidence is a status, a host, a count, or a marker NAME from lib/markers.mjs.
//
// The gate rule is the load-bearing one. A password page or a bot challenge renders as a
// perfectly healthy 200 with an h1 and no Liquid errors, so it must be recognised FIRST and must
// end classification for that path: a GATE finding, never a PASS and never a cascade of
// misleading marker-missing errors on top of it.

import { makeFinding } from './finding.mjs';
import { countH1, parsePageType } from '../../seo-review/lib/extract.mjs';
import { parseThemeId, hostOf } from '../../../.github/actions/shopify-theme-push/smoke.mjs';
import { requiredMarkers, expectedStatusFor } from './markers.mjs';

/** Statuses an edge returns for a challenge or a throttle; none of them is a render verdict. */
export const GATE_STATUSES = new Set([403, 429, 430]);

/** Body literals that mark a Cloudflare / Shopify challenge interstitial. */
export const CHALLENGE_MARKERS = ['cf-chl', 'Just a moment', 'challenge-platform', 'challenge-error-text'];

/** Page types where exactly one h1 is required; everywhere else at most one is allowed. */
export const ONE_H1_PAGE_TYPES = new Set(['index', 'product', 'collection', 'page', 'article']);

/** Pathname of a URL string, or null. */
export function pathOf(url) {
  try { return new URL(url).pathname; } catch { return null; }
}

/** Did the final URL land on the storefront password page? */
export function isPasswordPath(url) {
  const p = pathOf(url);
  return typeof p === 'string' && /^\/password/.test(p);
}

/**
 * Why a response is a gate, or null when it is not. Exported because the JSON endpoints and the
 * cart reducer apply the same rule to their own responses.
 * @param {{status?: number|null, finalUrl?: string|null, body?: string|null}} o
 * @returns {string|null}
 */
export function gateReason({ status, finalUrl, body }) {
  if (finalUrl && isPasswordPath(finalUrl)) return 'landed on the password page';
  if (typeof status === 'number' && GATE_STATUSES.has(status)) return `edge status ${status}`;
  const text = typeof body === 'string' ? body : '';
  if (text) {
    for (const m of CHALLENGE_MARKERS) {
      if (text.includes(m)) return 'bot challenge page';
    }
    // The password form itself, when the final URL was rewritten rather than redirected.
    if (/name="password"/.test(text) && /storefront_password/.test(text)) return 'password form in body';
  }
  return null;
}

/**
 * Classify one rendered path.
 * @param {object} o
 * @param {string} o.path              probed path (the finding subject)
 * @param {number|null} o.status       final status; null = connection failure
 * @param {string|null} o.finalUrl     final URL after redirects
 * @param {string} o.expectedHost      storefront host
 * @param {string|null} [o.serverTiming]
 * @param {string} [o.body]
 * @param {string|null} [o.pageType]   from server-timing, when the caller parsed it already
 * @param {object|null} [o.markerRule] from markerRuleFor(); null = no rule (no marker check)
 * @param {number} [o.expectedStatus]  overrides the rule's expected status
 * @returns {Array} findings (empty = PASS for this path)
 */
export function classifyRender({
  path, status, finalUrl, expectedHost, serverTiming = null, body = '', pageType = null,
  markerRule = null, expectedStatus,
}) {
  const findings = [];
  const gate = gateReason({ status, finalUrl, body });
  if (gate) {
    findings.push(makeFinding({ check: 'render-gate', subject: path, message: `inconclusive: ${gate}`, evidence: `status ${status ?? 'none'}` }));
    return findings;
  }
  const want = Number.isInteger(expectedStatus) ? expectedStatus : expectedStatusFor(markerRule);
  if (status === null || status === undefined) {
    findings.push(makeFinding({ check: 'render-status', subject: path, message: 'connection failure (no response)', evidence: 'status none' }));
    return findings;
  }
  if (status !== want) {
    findings.push(makeFinding({ check: 'render-status', subject: path, message: `final status ${status}, expected ${want}`, evidence: `status ${status}` }));
    return findings;
  }
  const host = finalUrl ? hostOf(finalUrl) : null;
  if (expectedHost && host && host !== expectedHost) {
    findings.push(makeFinding({ check: 'render-host', subject: path, message: `resolved on ${host}, expected ${expectedHost}`, evidence: `host ${host}` }));
  }
  const text = typeof body === 'string' ? body : '';
  if (/Liquid error/i.test(text)) {
    const n = (text.match(/Liquid error/gi) || []).length;
    findings.push(makeFinding({ check: 'render-liquid-error', subject: path, message: `body contains "Liquid error" (${n} occurrence${n === 1 ? '' : 's'})`, evidence: `count ${n}` }));
  }
  if (/translation missing/i.test(text)) {
    const n = (text.match(/translation missing/gi) || []).length;
    findings.push(makeFinding({ check: 'render-translation-missing', subject: path, message: `body contains "translation missing" (${n} occurrence${n === 1 ? '' : 's'})`, evidence: `count ${n}` }));
  }
  const type = pageType || parsePageType(serverTiming);
  const h1 = countH1(text);
  if (ONE_H1_PAGE_TYPES.has(type)) {
    if (h1 !== 1) findings.push(makeFinding({ check: 'render-h1-count', subject: path, message: `${h1} h1 elements on a ${type} page, expected exactly 1`, evidence: `h1 ${h1}` }));
  } else if (h1 > 1) {
    findings.push(makeFinding({ check: 'render-h1-count', subject: path, message: `${h1} h1 elements on a ${type || 'unknown'} page, expected at most 1`, evidence: `h1 ${h1}` }));
  }
  for (const marker of requiredMarkers(markerRule)) {
    if (!text.includes(marker)) {
      findings.push(makeFinding({ check: 'render-marker-missing', subject: path, message: 'a stable page marker is absent from the body', evidence: `marker ${marker}` }));
    }
  }
  return findings;
}

/**
 * Run-wide theme-id bookkeeping. One render-theme-id WARN per run on the first mismatch; after
 * it, every finding the orchestrator passes through `tag()` carries `theme=<served id>` in its
 * evidence. With no expected id configured, the first served id becomes the reference and an
 * INFO note says so (render-theme-id-missing carries that note, at INFO, so a run with no
 * LIVE_THEME_ID is visibly unconfirmed rather than silently green).
 * @param {{expectedThemeId?: string|null}} o
 */
export function createThemeTracker({ expectedThemeId = null } = {}) {
  let expected = expectedThemeId ? String(expectedThemeId) : null;
  let warned = false;
  let noted = false;
  let served = null;
  return {
    get expected() { return expected; },
    get served() { return served; },
    /**
     * Record the server-timing header of a 200 render.
     * @param {string|null} serverTiming
     * @param {string} path  finding subject
     * @returns {Array} findings
     */
    observe(serverTiming, path) {
      const id = parseThemeId(serverTiming);
      const out = [];
      if (!id) {
        out.push(makeFinding({ check: 'render-theme-id-missing', subject: path, message: 'server-timing carried no theme id; served theme unconfirmed', evidence: 'theme none' }));
        return out;
      }
      if (!expected) {
        expected = id;
        if (!noted) {
          noted = true;
          out.push(makeFinding({
            check: 'render-theme-id-missing', subject: 'run', severity: 'INFO',
            message: `no expected live theme id configured (LIVE_THEME_ID or --theme-id); taking the first served id as the reference`,
            evidence: `theme=${id}`,
          }));
        }
      }
      if (id !== expected) {
        served = id;
        if (!warned) {
          warned = true;
          out.push(makeFinding({ check: 'render-theme-id', subject: path, message: `served theme ${id} differs from expected ${expected}`, evidence: `theme=${id}` }));
        }
      }
      return out;
    },
    /** Prefix evidence with the served id once a mismatch has been seen. */
    tag(findings) {
      if (!served) return findings;
      return findings.map((f) => (f.evidence.startsWith('theme=') ? f : { ...f, evidence: `theme=${served} ${f.evidence}`.trim() }));
    },
  };
}

/**
 * Coverage summary: zero products probed is an ERROR (the deploy smoke's rule), else INFO with
 * per-surface counts.
 * @param {{products:number, structural:number, json:number, cartSteps:number, catalogueEmpty?:boolean}} counts
 */
export function coverageFindings(counts) {
  const { products = 0, structural = 0, json = 0, cartSteps = 0, catalogueEmpty = false } = counts;
  const summary = `products ${products}, structural ${structural}, json ${json}, cart steps ${cartSteps}`;
  if (products === 0 && !catalogueEmpty) {
    return [makeFinding({ check: 'render-coverage', subject: 'run', message: 'zero product pages were probed; the run verified no product', evidence: summary })];
  }
  return [makeFinding({ check: 'render-coverage', subject: 'run', severity: 'INFO', message: 'paths probed per surface', evidence: summary })];
}
