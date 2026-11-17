#!/usr/bin/env node
// Run the pa11y audit over the built config and prove, per page, which theme was audited.
//
// This replaces `npx pa11y-ci` for one reason: pa11y-ci could audit the LIVE theme and report
// green. It passed the preview session to pa11y as a `Cookie` header, and pa11y applies `headers`
// by intercepting requests and overriding the headers of the FIRST request only. Redirect hops,
// subresources and in-page fetches went out with Chrome's own cookie jar, which never held the
// preview pin, because a header override does not populate the jar. pa11y-ci also gives no hook
// into the page after the audit, so nothing could check what had been audited.
//
// What this runner does instead, per URL:
//   1. puts the session cookies into a fresh browser context's jar with `setCookie`, and never
//      passes `headers`, so pa11y never turns on request interception and Shopify's own
//      `Set-Cookie` pin lands in Chrome's jar the way a human preview link does;
//   2. records the `server-timing` theme id of every main-frame document response (the last one
//      wins, which is the final redirect hop);
//   3. after pa11y finishes, reads `window.Shopify.theme` from the same page pa11y audited;
//   4. replaces the URL's result with one hard-error entry when either id is not the preview
//      theme. That entry has no `type`, which summarize-pa11y.mjs already counts as malformed and
//      fails, so a run that audited the wrong theme cannot go green.
//
// The report has the same shape `pa11y-ci --json` wrote, so the summariser needs no change.
// pa11y and puppeteer are loaded through pa11y-ci's own install, so package.json still names one
// package and Dependabot keeps bumping it.
//
// Inputs are environment-only, matching get-auth-cookie.mjs:
//   CONFIG_PATH         the config build-pa11yci.mjs wrote
//   THEME_ID            the preview theme's numeric id
//   BASE_URL            the canonical origin the cookies belong to
//   COOKIE_FILE         optional; a Cookie header value. Absent or empty means no cookies (PUBLIC mode)
//   REPORT_PATH         where the JSON report goes
//   SCREEN_CAPTURE_DIR  optional; one full-page screenshot per URL, for a one-off diagnostic run
//
// stdout: one line per URL naming the document and page theme ids, the theme role and the verdict.
// It never carries a cookie value. stderr: problems only.
// Exit 0 when every URL passed, 2 when any did not, 1 when the run could not start (bad input,
// or a browser that would not launch); exit 1 writes no report, which the summariser reads as a
// failed audit.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseThemeId } from '../../.github/actions/shopify-theme-push/smoke.mjs';

// pa11y options this runner owns or must never forward. `headers`, `method` and `postData` are the
// three that turn on pa11y's request interception; `chromeLaunchConfig` is consumed by the launch,
// and `url` is passed positionally. `concurrency` is a pa11y-ci option, not a pa11y one.
const STRIPPED_OPTIONS = ['url', 'chromeLaunchConfig', 'headers', 'method', 'postData', 'concurrency', 'log', 'browser', 'page'];

/**
 * Turn a Cookie header value into cookie objects for `BrowserContext.setCookie`.
 *
 * Each cookie is scoped by `url`, never by `domain`. CDP's `Storage.setCookies` accepts `url` and
 * makes a host-only cookie, which is what Shopify's own `Set-Cookie` creates. A `domain` cookie
 * would sit beside Shopify's host-only one of the same name, Chrome would send both, and the
 * storefront could read the stale injected value: the original bug in a new form.
 *
 * @param {string} header
 * @param {string} origin
 * @returns {Array<{name: string, value: string, url: string}>}
 * @example
 *   cookiesFromHeader('a=b; c=d==', 'https://x.example')
 *   // [{ name: 'a', value: 'b', url: 'https://x.example' }, { name: 'c', value: 'd==', url: 'https://x.example' }]
 */
export function cookiesFromHeader(header, origin) {
  const out = [];
  for (const pair of String(header ?? '').split(';')) {
    const at = pair.indexOf('=');
    if (at < 0) continue;
    // Split on the FIRST `=` only: a value may itself contain `=` (base64 padding).
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (!name) continue;
    out.push({ name, value, url: origin });
  }
  return out;
}

/**
 * Decide whether the page pa11y audited is the preview theme. Pure.
 *
 * `pageTheme` is `window.Shopify.theme` as read from the audited page; `docThemeId` is the
 * `server-timing` theme id of the last main-frame document response. The page's own global is the
 * primary proof; the header is a second witness. A missing header alone does not fail, because a
 * redirect chain can end on a response without it, but the reason says so.
 *
 * @param {object} o
 * @param {{id: unknown, role: unknown}|null} o.pageTheme
 * @param {string|null} o.docThemeId
 * @param {string} o.expectedThemeId
 * @returns {{ok: boolean, reason: string}}
 * @example
 *   classifyAuditedTheme({ pageTheme: { id: 9, role: 'unpublished' }, docThemeId: '9', expectedThemeId: '9' })
 *   // { ok: true, reason: 'audited preview theme 9 (unpublished)' }
 */
export function classifyAuditedTheme({ pageTheme, docThemeId, expectedThemeId }) {
  const expected = String(expectedThemeId);
  if (!pageTheme) {
    return { ok: false, reason: `no Shopify.theme on the page (not a rendered storefront page), expected preview theme ${expected}` };
  }
  const id = safeToken(pageTheme.id);
  const role = safeToken(pageTheme.role);
  if (String(pageTheme.id) !== expected) {
    return { ok: false, reason: `audited theme ${id} (${role}), expected preview theme ${expected}` };
  }
  if (docThemeId && String(docThemeId) !== expected) {
    return {
      ok: false,
      reason: `page reports theme ${id} (${role}) but the document was served by theme ${safeToken(docThemeId)}, expected preview theme ${expected}`,
    };
  }
  if (!docThemeId) {
    return { ok: true, reason: `audited preview theme ${expected} (${role}); no theme id in server-timing on the final document` };
  }
  return { ok: true, reason: `audited preview theme ${expected} (${role})` };
}

/**
 * The report entry for one URL: pa11y's issues when the theme check passed, otherwise one entry
 * carrying the reason. That entry has no `type`, which summarize() counts as malformed and fails.
 * The issues are discarded on a failed check, since they belong to the wrong page.
 *
 * @param {{issues?: Array<object>}} results
 * @param {{ok: boolean, reason: string}} verdict
 * @returns {Array<object>}
 * @example
 *   toReportEntry({ issues: [] }, { ok: false, reason: 'audited theme 1 (main), expected preview theme 2' })
 *   // [{ message: 'audited theme 1 (main), expected preview theme 2' }]
 */
export function toReportEntry(results, verdict) {
  if (!verdict.ok) return [{ message: verdict.reason }];
  return Array.isArray(results?.issues) ? results.issues : [];
}

/**
 * Audit every URL in the config, one at a time, each in its own browser context.
 *
 * `pa11y` and `launch` are injected so the orchestration is unit-tested without Chrome or the
 * network. `launch` is called once; a throw from it propagates, so the caller can exit without a
 * report.
 *
 * @param {object} o
 * @param {object} o.config        the built config ({ defaults, urls })
 * @param {string} o.themeId       the preview theme id every page must report
 * @param {string} o.origin        the origin the cookies belong to
 * @param {string} [o.cookieHeader] Cookie header value; empty in PUBLIC mode
 * @param {Function} o.pa11y       pa11y(url, options) -> results
 * @param {Function} o.launch      () -> puppeteer Browser
 * @param {Function} [o.log]       one line per URL; never receives a cookie value
 * @param {string} [o.screenCaptureDir]
 * @returns {Promise<{total: number, passes: number, errors: number, results: object}>}
 * @example
 *   await runAudit({ config, themeId: '9', origin: 'https://x.example', cookieHeader: '', pa11y, launch })
 */
export async function runAudit({ config, themeId, origin, cookieHeader = '', pa11y, launch, log = () => {}, screenCaptureDir = '' }) {
  const urls = Array.isArray(config?.urls) ? config.urls : [];
  const defaults = config?.defaults ?? {};
  const cookies = cookiesFromHeader(cookieHeader, origin);
  const report = { total: urls.length, passes: 0, errors: 0, results: {} };

  const browser = await launch();
  try {
    // Serial on purpose: the config's concurrency is 1 because a burst of headless page loads is
    // the shape the storefront's bot management reacts to.
    for (const [index, entry] of urls.entries()) {
      const url = typeof entry === 'string' ? entry : entry.url;
      const urlOptions = typeof entry === 'string' ? {} : entry;
      const options = pa11yOptions(defaults, urlOptions);
      if (screenCaptureDir) options.screenCapture = join(screenCaptureDir, captureName(index, url));

      const context = await browser.createBrowserContext();
      let issues;
      let line;
      try {
        if (cookies.length) await context.setCookie(...cookies);
        const page = await context.newPage();
        let docThemeId = null;
        page.on('response', (response) => {
          const request = response.request();
          if (request.resourceType() !== 'document' || request.frame() !== page.mainFrame()) return;
          // Last one wins: the final redirect hop is the document pa11y audited.
          docThemeId = parseThemeId(response.headers()['server-timing']);
        });

        let results;
        try {
          results = await pa11y(url, { ...options, browser: context, page });
        } catch (error) {
          // As pa11y-ci did: the URL's whole result is the error, which the summariser fails.
          issues = [{ message: String(error?.message ?? error) }];
          line = `${pathOf(url)}: pa11y failed: ${safeText(error?.message ?? error)}`;
        }

        if (results) {
          let pageTheme = null;
          try {
            pageTheme = await page.evaluate(() => (window.Shopify && window.Shopify.theme
              ? { id: window.Shopify.theme.id, role: window.Shopify.theme.role }
              : null));
          } catch {
            pageTheme = null;
          }
          const verdict = classifyAuditedTheme({ pageTheme, docThemeId, expectedThemeId: themeId });
          issues = toReportEntry(results, verdict);
          line = `${pathOf(url)}: doc theme ${safeToken(docThemeId)}, page theme ${safeToken(pageTheme?.id)} `
            + `(${safeToken(pageTheme?.role)}): ${verdict.ok ? 'ok' : 'WRONG THEME'}`;
        }
      } catch (error) {
        issues = [{ message: String(error?.message ?? error) }];
        line = `${pathOf(url)}: browser error: ${safeText(error?.message ?? error)}`;
      } finally {
        try { await context.close(); } catch { /* the browser is closed below regardless */ }
      }

      report.results[url] = issues;
      const failed = issues.filter((i) => !i || typeof i.type !== 'string' || i.type === 'error').length;
      report.errors += failed;
      if (failed === 0) report.passes += 1;
      log(line);
    }
  } finally {
    await browser.close();
  }
  return report;
}

/** pa11y options for one URL: the config defaults, then the URL's own keys, minus the owned ones. */
function pa11yOptions(defaults, urlOptions) {
  const options = { ...defaults, ...urlOptions };
  for (const key of STRIPPED_OPTIONS) delete options[key];
  return options;
}

/** A screenshot filename that sorts in config order. */
function captureName(index, url) {
  let slug = 'page';
  try {
    slug = new URL(url).pathname.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'index';
  } catch { /* keep the fallback */ }
  return `${String(index + 1).padStart(2, '0')}-${slug}.png`;
}

/** Path + query of a URL, with the preview_theme_id pin dropped for legibility. */
function pathOf(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('preview_theme_id');
    return `${u.pathname}${u.search}`;
  } catch {
    return safeText(url);
  }
}

/** A page-derived id or role, reduced to something that cannot drive a log renderer. */
function safeToken(value) {
  if (value === null || value === undefined || value === '') return '-';
  const s = String(value);
  return /^[A-Za-z0-9_-]{1,40}$/.test(s) ? s : '?';
}

/** Page-derived free text for a log line: control characters removed, length clamped. */
function safeText(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
}

function envConfig() {
  const configPath = process.env.CONFIG_PATH || '';
  const themeId = process.env.THEME_ID || '';
  const baseUrl = (process.env.BASE_URL || '').replace(/\/+$/, '');
  const cookieFile = process.env.COOKIE_FILE || '';
  const reportPath = process.env.REPORT_PATH || '';
  const screenCaptureDir = process.env.SCREEN_CAPTURE_DIR || '';
  const problems = [];
  if (!configPath) problems.push('CONFIG_PATH is required');
  if (!/^\d+$/.test(themeId)) problems.push('THEME_ID must be numeric');
  if (!baseUrl) problems.push('BASE_URL is required');
  else if (!/^https:\/\//.test(baseUrl)) problems.push('BASE_URL must be https');
  if (!reportPath) problems.push('REPORT_PATH is required');
  return { configPath, themeId, baseUrl, cookieFile, reportPath, screenCaptureDir, problems };
}

/** Read the cookie file; absent or empty means PUBLIC mode. */
function readCookieFile(file) {
  if (!file) return '';
  try {
    return readFileSync(file, 'utf8').trim();
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function main() {
  const { configPath, themeId, baseUrl, cookieFile, reportPath, screenCaptureDir, problems } = envConfig();
  const fail = (message) => {
    process.stderr.write(`run-audit: ${message}\n`);
    process.exitCode = 1;
  };
  if (problems.length) {
    for (const p of problems) fail(p);
    return;
  }

  let config;
  let cookieHeader;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
    cookieHeader = readCookieFile(cookieFile);
  } catch (error) {
    // The message names a path or a JSON position, never file contents.
    fail(`could not read inputs: ${error.message}`);
    return;
  }

  // pa11y and puppeteer come from pa11y-ci's own install, so the lockfile pins them through it.
  const fromHere = createRequire(import.meta.url);
  const fromPa11yCi = createRequire(fromHere.resolve('pa11y-ci/package.json'));
  const pa11y = fromPa11yCi('pa11y');
  // Resolved through pa11y, so the runner and pa11y share one puppeteer.
  const puppeteer = createRequire(fromPa11yCi.resolve('pa11y'))('puppeteer');

  if (screenCaptureDir) mkdirSync(screenCaptureDir, { recursive: true });

  let report;
  try {
    report = await runAudit({
      config,
      themeId,
      origin: new URL(baseUrl).origin,
      cookieHeader,
      pa11y,
      launch: () => puppeteer.launch({ headless: true, ...(config?.defaults?.chromeLaunchConfig ?? {}) }),
      log: (line) => process.stdout.write(`run-audit: ${line}\n`),
      screenCaptureDir,
    });
  } catch (error) {
    fail(`audit could not run: ${safeText(error?.message ?? error)}`);
    return;
  }

  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`run-audit: ${report.passes}/${report.total} URL(s) passed\n`);
  process.exitCode = report.passes === report.total ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
