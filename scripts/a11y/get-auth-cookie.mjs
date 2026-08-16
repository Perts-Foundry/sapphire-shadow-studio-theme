#!/usr/bin/env node
// Obtain a Cookie header that lets pa11y-ci reach a PREVIEW theme.
//
// Two gates stand between a CI runner and a renderable preview page:
//
//   1. The storefront password. Every host (custom domain and *.myshopify.com)
//      is password-gated until launch. curl cannot get through: Cloudflare bot
//      management blocklists its TLS fingerprint. Node's fetch (undici) does,
//      which is why .github/actions/shopify-theme-push/smoke.mjs is built on it
//      and why the header set and cookie handling are imported from there
//      rather than reinvented.
//
//   2. Theme selection. A draft theme renders only when the session is pinned
//      to it. `?preview_theme_id=<id>` sets that pin as a cookie on first
//      request; subsequent requests carry it in the jar.
//
// The script ASSERTS both worked before printing anything, by fetching the
// preview URL and reading the theme id back out of the `server-timing` header.
// That assertion is the whole value of this file: a silent fallback to the LIVE
// theme would mean pa11y audits production and reports green on a PR that
// broke the page, and a Cloudflare interstitial would mean it audits a
// challenge page and reports green on that. Neither may pass quietly.
//
// PUBLIC mode: once the storefront password is removed at launch,
// STOREFRONT_PASSWORD disappears from the repo secrets. That is not an error.
// The script detects an unlocked storefront, skips the password step, and emits
// only the preview-theme cookie.
//
// Inputs are environment-only, never argv: a password in a process argument is
// world-readable in /proc on the runner.
//   STOREFRONT_PASSWORD  optional; absent/empty means PUBLIC mode
//   BASE_URL             e.g. https://sapphire-shadow-studio.myshopify.com
//   THEME_ID             the preview theme's numeric id
//   CANONICAL_BASE_URL_FILE  optional; path to write the resolved origin to
//
// stdout: the Cookie header value (possibly empty). Diagnostics go to stderr so
// stdout can be captured directly.
// Exit 0 on success, 1 on any failure to reach the preview theme.

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  BROWSER_HEADERS, updateJar, cookieHeader, parseThemeId, hostOf,
} from '../../.github/actions/shopify-theme-push/smoke.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Origin of a URL string, or null if unparseable. Companion to smoke.mjs's hostOf. */
export function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

/**
 * Build the URL that pins a session to a specific theme.
 * @param {string} baseUrl
 * @param {string} themeId
 * @param {string} [path]
 * @returns {string}
 * @example
 *   previewUrl('https://x.example', '123', '/cart') // 'https://x.example/cart?preview_theme_id=123'
 */
export function previewUrl(baseUrl, themeId, path = '/') {
  const url = new URL(path, baseUrl);
  url.searchParams.set('preview_theme_id', String(themeId));
  return url.href;
}

/**
 * Decide what a post-auth preview probe proves. Pure, so the decision table is
 * unit-tested without touching the network.
 *
 * ON HOSTS. A store's `*.myshopify.com` host 302s to its primary custom domain,
 * so the probe legitimately finishes on a different host than it started on.
 * That is canonicalisation, not a hijack, and rejecting it made this script
 * fail against the very BASE_URL the workflow passes (`vars.SHOPIFY_FLAG_STORE`
 * is the myshopify host). Verified against the live store on 2026-08-16: both
 * hosts authenticate and both activate the preview theme; only the host
 * assertion differed.
 *
 * So the THEME ID, not the host, is the identity proof, and it is the stronger
 * of the two: `server-timing: theme;desc=<id>` carrying this store's specific
 * unpublished theme id is something only this store emits. A host that is not
 * the store cannot produce it. The resolved host is reported back rather than
 * judged, so the caller can point pa11y straight at the canonical origin
 * instead of eating a redirect on every URL.
 *
 * @param {object} o
 * @param {number|null} o.status
 * @param {string|null} o.themeDesc    theme id from `server-timing`
 * @param {string} o.expectedThemeId
 * @param {string|null} o.finalHost
 * @param {string} o.expectedHost
 * @returns {{ok: boolean, reason: string, redirected: boolean}}
 * @example
 *   classifyPreview({status: 200, themeDesc: '9', expectedThemeId: '9', finalHost: 'a', expectedHost: 'a'})
 */
export function classifyPreview({ status, themeDesc, expectedThemeId, finalHost, expectedHost }) {
  const redirected = Boolean(finalHost && expectedHost && finalHost !== expectedHost);
  const no = (reason) => ({ ok: false, reason, redirected });

  if (status === null) return no('connection failure');
  if (status === 403 || status === 503) {
    // The signature of a Cloudflare challenge: reachable host, refused content.
    return no(`blocked by bot management (${status}); headless Chrome will see the same`);
  }
  if (status !== 200) return no(`expected 200, got ${status}`);
  if (!themeDesc) {
    // No server-timing means the response is not a rendered Shopify theme page.
    // This is also what an interstitial or a genuinely foreign host returns.
    return no('no theme id in server-timing (not a rendered storefront page)');
  }
  if (String(themeDesc) !== String(expectedThemeId)) {
    // THE assertion this script exists for. Auditing the live theme instead of
    // the PR's preview would green every PR regardless of what it changed.
    return no(`served theme ${themeDesc}, expected preview theme ${expectedThemeId}`);
  }
  return {
    ok: true,
    redirected,
    reason: redirected
      ? `preview theme ${expectedThemeId} served, canonical host ${finalHost}`
      : `preview theme ${expectedThemeId} served`,
  };
}

/**
 * One request, following redirects manually so cookies are captured at every
 * hop and a /password bounce is visible rather than followed away.
 * @returns {Promise<{status: number|null, themeDesc: string|null, finalHost: string|null, redirectPath: string|null}>}
 */
async function probe(url, { jar, fetchImpl, timeoutMs, maxHops = 5 }) {
  let current = url;
  let hops = 0;
  let status = null; let themeDesc = null; let finalHost = null; let redirectPath = null;
  let finalOrigin = null;

  while (true) {
    const headers = { ...BROWSER_HEADERS };
    if (jar.size) headers.cookie = cookieHeader(jar);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(current, { headers, redirect: 'manual', signal: ctl.signal });
    } catch {
      return { status: null, themeDesc: null, finalHost, finalOrigin, redirectPath };
    } finally {
      clearTimeout(timer);
    }
    updateJar(jar, res);
    status = res.status;
    finalHost = hostOf(res.url) || finalHost;
    finalOrigin = originOf(res.url) || finalOrigin;
    const loc = res.headers.get('location');
    if (status >= 300 && status < 400 && loc && hops < maxHops) {
      let next = null;
      try { next = new URL(loc, current); } catch { next = null; }
      redirectPath = next ? next.pathname : loc;
      if (!next || /^\/password/.test(redirectPath)) {
        if (next) { finalHost = next.host; finalOrigin = next.origin; }
        break;
      }
      current = next.href;
      hops += 1;
      continue;
    }
    themeDesc = parseThemeId(res.headers.get('server-timing'));
    break;
  }
  return { status, themeDesc, finalHost, finalOrigin, redirectPath };
}

/**
 * Full flow: detect mode, authenticate if locked, pin the preview theme, assert.
 * @param {object} opts
 * @returns {Promise<{ok: boolean, cookie: string, mode: string, reason: string, log: string[]}>}
 * @example
 *   await getAuthCookie({ baseUrl, themeId, password })
 */
export async function getAuthCookie({
  baseUrl,
  themeId,
  password = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000,
  backoff = [8000, 20000],
  sleepImpl = sleep,
} = {}) {
  const jar = new Map();
  const log = [];
  const say = (s) => log.push(s);
  const expectedHost = hostOf(baseUrl);
  const opts = { jar, fetchImpl, timeoutMs };

  // 1. Mode. A 200 on the bare root means the storefront is public.
  const root = await probe(`${baseUrl}/`, opts);
  const mode = root.status === 200 ? 'PUBLIC' : 'LOCKED';
  say(`mode: ${mode} (root -> ${root.status ?? '000'})`);

  // 2. Authenticate when locked. Mirrors smoke.mjs's classification: a 3xx away
  //    from /password is success, a 200 or a bounce back to /password is a
  //    refused password, everything else is transient and retried.
  if (mode === 'LOCKED') {
    if (!password) {
      return {
        ok: false, cookie: '', mode, log,
        reason: 'storefront is password-locked but STOREFRONT_PASSWORD is empty',
      };
    }
    try {
      updateJar(jar, await fetchImpl(`${baseUrl}/password`, { headers: BROWSER_HEADERS, redirect: 'manual' }));
    } catch { /* seeding the cookie is best-effort; the POST below still works */ }

    let attempt = 0;
    let outcome = 'error';
    while (true) {
      let status = null; let locPath = null;
      try {
        const res = await fetchImpl(`${baseUrl}/password`, {
          method: 'POST',
          headers: { ...BROWSER_HEADERS, cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ form_type: 'storefront_password', utf8: '✓', password }).toString(),
          redirect: 'manual',
        });
        updateJar(jar, res);
        status = res.status;
        const loc = res.headers.get('location');
        if (loc) { try { locPath = new URL(loc, `${baseUrl}/password`).pathname; } catch { locPath = loc; } }
      } catch { status = null; }

      if ((status === 429 || (status !== null && status >= 500)) && attempt < backoff.length) {
        await sleepImpl(backoff[attempt]);
        attempt += 1;
        continue;
      }
      if (status === null) outcome = 'error';
      else if (status === 429 || status >= 500) outcome = 'throttled';
      else if (status >= 300 && status < 400) outcome = (locPath && /^\/password/.test(locPath)) ? 'rejected' : 'success';
      else if (status === 200) outcome = 'rejected';
      else outcome = 'error';
      break;
    }
    say(`auth: ${outcome}`);
    if (outcome !== 'success') {
      return { ok: false, cookie: '', mode, log, reason: `storefront password ${outcome}` };
    }
  }

  // 3. Pin the preview theme, then assert we actually got it. The pin arrives
  //    as a cookie on this request, so the same request both sets and proves it.
  const pinned = await probe(previewUrl(baseUrl, themeId), opts);
  say(`preview probe: ${pinned.status ?? '000'} theme=${pinned.themeDesc ?? '-'}`);
  const verdict = classifyPreview({
    status: pinned.status,
    themeDesc: pinned.themeDesc,
    expectedThemeId: themeId,
    finalHost: pinned.finalHost,
    expectedHost,
  });
  if (!verdict.ok) {
    return { ok: false, cookie: '', canonicalBaseUrl: baseUrl, mode, log, reason: verdict.reason };
  }

  // Hand back the origin the store actually canonicalised to, so pa11y can
  // request it directly. Pointing pa11y at the pre-redirect host would work
  // (Chrome follows the 302) but would cost an extra hop on all 19 URLs and
  // make every audited URL differ from the one reported.
  const canonicalBaseUrl = pinned.finalOrigin || baseUrl;
  if (verdict.redirected) say(`canonical origin: ${canonicalBaseUrl}`);

  return { ok: true, cookie: cookieHeader(jar), canonicalBaseUrl, mode, log, reason: verdict.reason };
}

function envConfig() {
  const baseUrl = (process.env.BASE_URL || '').replace(/\/+$/, '');
  const themeId = process.env.THEME_ID || '';
  const password = process.env.STOREFRONT_PASSWORD || '';
  const problems = [];
  if (!baseUrl) problems.push('BASE_URL is required');
  else if (!/^https:\/\//.test(baseUrl)) problems.push('BASE_URL must be https');
  if (!/^\d+$/.test(themeId)) problems.push('THEME_ID must be numeric');
  return { baseUrl, themeId, password, problems };
}

async function main() {
  const { baseUrl, themeId, password, problems } = envConfig();
  if (problems.length) {
    for (const p of problems) process.stderr.write(`get-auth-cookie: ${p}\n`);
    process.exitCode = 1;
    return;
  }

  const { ok, cookie, canonicalBaseUrl, mode, reason, log } = await getAuthCookie({ baseUrl, themeId, password });
  for (const line of log) process.stderr.write(`get-auth-cookie: ${line}\n`);
  if (!ok) {
    process.stderr.write(`get-auth-cookie: FAILED (${reason})\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`get-auth-cookie: ok, mode=${mode}, ${reason}\n`);

  // The canonical origin goes to a file, not to stdout (which carries the
  // cookie and nothing else) and not to $GITHUB_OUTPUT (which the writing step
  // cannot read back; step outputs are only visible to LATER steps, and the
  // caller needs this value in the same step to build the pa11y config). It is
  // a public storefront URL, not a secret, so it needs no masking.
  if (process.env.CANONICAL_BASE_URL_FILE) {
    writeFileSync(process.env.CANONICAL_BASE_URL_FILE, canonicalBaseUrl);
  }

  // stdout carries the cookie and nothing else. The caller masks it before it
  // can reach a log; see the a11y-audit job in preview.yml.
  process.stdout.write(cookie);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
