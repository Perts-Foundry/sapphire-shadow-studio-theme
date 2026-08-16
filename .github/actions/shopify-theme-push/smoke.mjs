#!/usr/bin/env node
//
// smoke.mjs -- post-deploy storefront smoke test (node fetch, not curl).
//
// WHY node, not curl: Shopify/Cloudflare bot-management blocklists curl's
// TLS/HTTP fingerprint and returns a hard 429 on cacheable content routes.
// node's fetch (undici) is not blocklisted. See release-notes.md and
// scripts/diagnostics/storefront-probe-node.mjs (the prototype this ports).
//
// WHAT it asserts, per path: HTTP 200 + final host == expected host +
// server-timing theme;desc == the live theme id. Structural routes (/, /cart,
// ...) verify the deploy landed; every published product (enumerated from the
// sitemap) is probed so a deploy that breaks a product's availability fails.
//
// OUTPUT HYGIENE (public repo): only "path verdict status host theme-id"
// tuples are ever emitted. The password, POST body, cookie jar, Set-Cookie /
// Cookie / Authorization / Location headers, and response bodies are NEVER
// printed or written to GITHUB_OUTPUT, on any branch. The minted session
// cookie value is registered with ::add-mask:: so Actions redacts it even if a
// future edit leaks it.
//
// USAGE:
//   Wired from action.yml via env: SMOKE_BASE_URL, SMOKE_PATHS, LIVE_THEME_ID,
//   STOREFRONT_PASSWORD (optional), SMOKE_MAX_PRODUCTS, SMOKE_MAX_SECONDS.
//   Local pre-flight: STOREFRONT_PASSWORD='...' node smoke.mjs --dry-run

import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// --- verdict constants -----------------------------------------------------
export const PASS = 'PASS';
export const SOFT_WARN = 'SOFT-WARN';
export const HARD_FAIL = 'HARD-FAIL';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
export const BROWSER_HEADERS = {
  'user-agent': UA,
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'upgrade-insecure-requests': '1',
};

// --- pure helpers (unit-tested directly) -----------------------------------

/**
 * Parse the live theme id from a server-timing header value.
 * Shopify emits e.g. `... theme;desc="181702754604"`. Tolerant of quoting and
 * spacing. Returns the digit string, or null if absent/malformed.
 * @param {string|null|undefined} serverTiming
 * @returns {string|null}
 */
export function parseThemeId(serverTiming) {
  if (!serverTiming) return null;
  const m = String(serverTiming).match(/theme;desc=\s*"?(\d+)"?/);
  return m ? m[1] : null;
}

/** Host portion of a URL string, or null if unparseable. */
export function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}

/**
 * Pure classifier for a single probed path. No I/O.
 * @param {object} o
 * @param {number|null} o.status       final HTTP status; null = connection failure
 * @param {string|null} o.finalHost    host of the final response
 * @param {string} o.expectedHost      configured expected host
 * @param {string|null} o.themeDesc    parsed theme id from server-timing (200s)
 * @param {string} o.expectedThemeId   the live theme id
 * @param {string|null} o.redirectPath pathname of a final 3xx Location, if any
 * @param {boolean} o.retriesExhausted true when a 429 survived all retries
 * @param {boolean} [o.isProduct]      path is an enumerated product (404 label)
 * @returns {{verdict: string, reason: string}}
 */
export function classify(o) {
  const {
    status, finalHost, expectedHost, themeDesc, expectedThemeId,
    redirectPath, retriesExhausted, isProduct,
  } = o;

  if (retriesExhausted) return { verdict: SOFT_WARN, reason: 'throttled (429 after retries)' };
  if (status === null || status === undefined) return { verdict: HARD_FAIL, reason: 'connection failure' };

  if (status >= 500) return { verdict: HARD_FAIL, reason: `server error ${status}` };
  if (status === 404 || status === 410) {
    return { verdict: HARD_FAIL, reason: isProduct ? 'product unavailable' : `not found ${status}` };
  }
  if (status >= 300 && status < 400) {
    if (redirectPath && /^\/password/.test(redirectPath)) {
      return { verdict: HARD_FAIL, reason: 'auth wall (redirect to /password)' };
    }
    if (finalHost && expectedHost && finalHost !== expectedHost) {
      return { verdict: HARD_FAIL, reason: `cross-host redirect to ${finalHost}` };
    }
    return { verdict: HARD_FAIL, reason: `unexpected redirect ${status}` };
  }
  if (status !== 200) return { verdict: HARD_FAIL, reason: `unexpected status ${status}` };

  // 200:
  if (finalHost && expectedHost && finalHost !== expectedHost) {
    return { verdict: HARD_FAIL, reason: `cross-host final ${finalHost}` };
  }
  if (!themeDesc) return { verdict: HARD_FAIL, reason: 'no theme-id in server-timing' };
  if (themeDesc !== expectedThemeId) {
    return { verdict: HARD_FAIL, reason: `theme-id mismatch ${themeDesc} != ${expectedThemeId}` };
  }
  return { verdict: PASS, reason: 'ok' };
}

/**
 * Extract product paths from Shopify sitemap XML (index or child). Tolerant of
 * malformed markup; returns pathnames like `/products/handle`.
 * @param {string} xml
 * @returns {string[]}
 */
export function parseProductLocs(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    try {
      const u = new URL(m[1]);
      if (/^\/products\/[^/]+$/.test(u.pathname)) out.push(u.pathname);
    } catch { /* skip malformed loc */ }
  }
  return out;
}

/** Child sitemap URLs from a sitemap index that look like product sitemaps. */
export function parseProductSitemapChildren(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (/sitemap_products_\d+\.xml/.test(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * Aggregate per-path results into an exit code and a summary. Enforces the
 * ">=1 verified PASS before exit 0" rule.
 * @param {Array<{path:string, verdict:string, reason:string}>} results
 * @returns {{exitCode: number, hardFails: number, softWarns: number, passes: number}}
 */
export function summarize(results) {
  const passes = results.filter(r => r.verdict === PASS).length;
  const hardFails = results.filter(r => r.verdict === HARD_FAIL).length;
  const softWarns = results.filter(r => r.verdict === SOFT_WARN).length;
  let exitCode = 0;
  if (hardFails > 0) exitCode = 1;
  // Nothing was ever verified (e.g. a wholesale 429 wall): do not merge blind.
  else if (passes === 0 && results.length > 0) exitCode = 1;
  return { exitCode, hardFails, softWarns, passes };
}

// --- cookie jar (over fetch's getSetCookie) --------------------------------
//
// `updateJar`, `cookieHeader`, `BROWSER_HEADERS` above and
// `authenticateStorefront` below are exported for
// scripts/a11y/get-auth-cookie.mjs, which drives the same storefront password
// flow to obtain a cookie for pa11y-ci. They are exported rather than copied so
// the two callers cannot drift: this store is behind Cloudflare bot management,
// and the exact header set and manual-redirect cookie handling here are what
// was found to get through it. Nothing else about smoke.mjs is shared.
export function updateJar(jar, res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1));
  }
}
export const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

const realSleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Drive the storefront password form and classify the outcome. Exported for
 * the same reason as the jar helpers above: scripts/a11y/get-auth-cookie.mjs
 * needs this exact flow, and a hand-rolled second copy would drift from the
 * one that is known to get through bot management.
 *
 * The outcome distinction is load-bearing here: `rejected` HARD-FAILs a deploy,
 * everything else is transient and falls back. So `rejected` is reserved for a
 * DEFINITIVE wrong-password signal: Shopify re-renders the form (200) or
 * redirects BACK to /password. Success is a 3xx AWAY from /password (to the
 * return URL). A 429 that survives every retry is `throttled`; a network
 * failure, a 5xx, or any other status is `error`. Neither means the password
 * was wrong.
 *
 * `jar` is mutated with every cookie seen, on failure as well as success.
 * @param {object} o
 * @param {string} o.baseUrl
 * @param {string} o.password
 * @param {Map<string,string>} o.jar
 * @param {Function} o.fetchImpl
 * @param {Function} o.sleep
 * @param {number[]} o.backoff  per-retry delays; its length caps the retries
 * @returns {Promise<'success'|'rejected'|'throttled'|'error'>}
 */
export async function authenticateStorefront({ baseUrl, password, jar, fetchImpl, sleep, backoff }) {
  try { updateJar(jar, await fetchImpl(`${baseUrl}/password`, { headers: BROWSER_HEADERS, redirect: 'manual' })); } catch { /* seed cookie best-effort */ }
  let attempt = 0;
  while (true) {
    let postStatus = null;
    let postLocPath = null;
    try {
      const postRes = await fetchImpl(`${baseUrl}/password`, {
        method: 'POST',
        headers: { ...BROWSER_HEADERS, cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ form_type: 'storefront_password', utf8: '✓', password }).toString(),
        redirect: 'manual',
      });
      updateJar(jar, postRes);
      postStatus = postRes.status;
      const loc = postRes.headers.get('location');
      if (loc) { try { postLocPath = new URL(loc, `${baseUrl}/password`).pathname; } catch { postLocPath = loc; } }
    } catch { postStatus = null; }
    // Retry a throttled (429) or transient server/edge error (5xx) POST: the
    // storefront password endpoint intermittently 503s under bot-management.
    if ((postStatus === 429 || (postStatus !== null && postStatus >= 500)) && attempt < backoff.length) {
      await sleep(backoff[attempt]);
      attempt += 1;
      continue;
    }
    if (postStatus === null) return 'error';
    if (postStatus === 429) return 'throttled';
    if (postStatus >= 500) return 'error';
    if (postStatus >= 300 && postStatus < 400) return (postLocPath && /^\/password/.test(postLocPath)) ? 'rejected' : 'success';
    if (postStatus === 200) return 'rejected';
    return 'error';
  }
}

/**
 * Fetch with a per-request timeout, manual-redirect hop-following (stopping at
 * a /password wall), and retry-on-429 with backoff.
 * @returns {Promise<{status:number|null, finalHost:string|null, themeDesc:string|null, redirectPath:string|null, retriesExhausted:boolean}>}
 */
async function fetchObservation(url, {
  jar, fetchImpl, sleep, backoff, timeoutMs, maxHops = 5,
}) {
  let attempt = 0;
  while (true) {
    let current = url;
    let hops = 0;
    let status = null, finalHost = null, themeDesc = null, redirectPath = null;
    let hitError = false;
    while (true) {
      const headers = { ...BROWSER_HEADERS };
      if (jar && jar.size) headers.cookie = cookieHeader(jar);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(current, { headers, redirect: 'manual', signal: ctl.signal });
      } catch {
        hitError = true;
        break;
      } finally {
        clearTimeout(timer);
      }
      if (jar) updateJar(jar, res);
      status = res.status;
      finalHost = hostOf(res.url) || finalHost;
      const loc = res.headers.get('location');
      if (status >= 300 && status < 400 && loc) {
        let locUrl;
        try { locUrl = new URL(loc, current); } catch { locUrl = null; }
        redirectPath = locUrl ? locUrl.pathname : loc;
        // Stop at the /password auth wall or after maxHops; otherwise follow.
        if (/^\/password/.test(redirectPath) || hops >= maxHops || !locUrl) {
          finalHost = locUrl ? locUrl.host : finalHost;
          break;
        }
        current = locUrl.href;
        hops += 1;
        continue;
      }
      themeDesc = parseThemeId(res.headers.get('server-timing'));
      break;
    }

    if (!hitError && status === 429 && attempt < backoff.length) {
      await sleep(backoff[attempt]);
      attempt += 1;
      continue;
    }
    const retriesExhausted = !hitError && status === 429;
    return {
      status: hitError ? null : status,
      finalHost, themeDesc, redirectPath, retriesExhausted,
    };
  }
}

// --- GitHub Actions helpers ------------------------------------------------
function maskCookieValues(jar) {
  if (!process.env.GITHUB_OUTPUT && !process.env.GITHUB_ACTIONS) return;
  for (const v of jar.values()) {
    if (v) process.stdout.write(`::add-mask::${v}\n`);
  }
}

function writeGithubOutput(smokeOutput, exitCode) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delim = `GHEOF_${randomUUID()}`;
  appendFileSync(file,
    `smoke_output<<${delim}\n${smokeOutput}\n${delim}\n` +
    `smoke_exit_code=${exitCode}\n`);
}

// --- orchestration ---------------------------------------------------------

/**
 * Run the smoke test. Injectable fetch/sleep make the whole flow unit-testable.
 * @returns {Promise<{exitCode:number, lines:string[], mode:string}>}
 */
export async function runSmoke({
  baseUrl,
  structuralPaths,
  liveThemeId,
  password = '',
  fetchImpl = globalThis.fetch,
  sleep = realSleep,
  paceMs = 4000,
  backoff = [8000, 20000],
  timeoutMs = 30000,
  maxProducts = 200,
  maxSeconds = 240,
  log = () => {},
} = {}) {
  const expectedHost = hostOf(baseUrl);
  const jar = new Map();
  const lines = [];
  const results = [];
  const deadline = Date.now() + maxSeconds * 1000;

  const probeOpts = { jar, fetchImpl, sleep, backoff, timeoutMs };

  const record = (path, obs, isProduct) => {
    const { verdict, reason } = classify({
      ...obs, expectedHost, expectedThemeId: liveThemeId, isProduct,
    });
    results.push({ path, verdict, reason });
    const line = `${path} ${verdict} ${obs.status ?? '000'} host=${obs.finalHost ?? '-'} theme=${obs.themeDesc ?? '-'} (${reason})`;
    lines.push(line);
    log(line);
    return verdict;
  };

  // 1. Detect mode (paced/retried so a transient 429 does not misclassify).
  // A 200 root is PUBLIC; anything else (redirect to /password, 429, connection
  // failure) is treated as LOCKED. A 5xx root is handled separately below as a
  // broken storefront, so it never reaches the /password green fallback.
  const rootObs = await fetchObservation(`${baseUrl}/`, probeOpts);
  const mode = rootObs.status === 200 ? 'PUBLIC' : 'LOCKED';
  log(`mode: ${mode} (root / -> ${rootObs.status ?? '000'})`);

  // 5xx on the root itself is a broken storefront, not a lock: fail loudly
  // rather than defaulting to LOCKED and greening on the /password fallback.
  if (rootObs.status !== null && rootObs.status >= 500) {
    results.push({ path: '/', verdict: HARD_FAIL, reason: `server error ${rootObs.status}` });
    lines.push(`/ HARD-FAIL ${rootObs.status} host=${rootObs.finalHost ?? '-'} theme=- (server error ${rootObs.status})`);
    log(lines[lines.length - 1]);
    writeGithubOutput(lines.join('\n'), 1);
    return { exitCode: 1, lines, mode };
  }

  // 2. LOCKED + password: authenticate. Classify the auth outcome so a *rejected*
  // password (wrong/rotated) is distinguished from a *transient* failure
  // (throttle/network). Rejected must HARD-FAIL: on unattended auto-deploys a
  // silent green fallback would let a rotated secret drop all content coverage
  // while deploys keep merging. Transient failures stay SOFT-WARN + fallback.
  let authed = false;
  if (mode === 'LOCKED' && password) {
    // Retry/outcome rules live in authenticateStorefront (shared with the a11y
    // auth helper); only the deploy-facing consequences are decided here.
    const authResult = await authenticateStorefront({ baseUrl, password, jar, fetchImpl, sleep, backoff });
    maskCookieValues(jar);
    authed = authResult === 'success';
    if (authResult === 'rejected') {
      // A provided password that the gate refuses is a config error (rotated /
      // wrong secret). Block the deploy so the lost coverage is not silent.
      results.push({ path: '/password', verdict: HARD_FAIL, reason: 'auth rejected (password provided but refused; rotated/wrong secret)' });
      lines.push('/password HARD-FAIL - AUTH: password provided but the gate refused it (rotated or wrong secret); content coverage would be lost');
      log(lines[lines.length - 1]);
      writeGithubOutput(lines.join('\n'), 1);
      return { exitCode: 1, lines, mode };
    }
    if (!authed) {
      // Transient (throttle/network): loud SOFT-WARN, fall through to the
      // /password fallback. Never a silent outage, never a hard block.
      lines.push(`/password AUTH SOFT-WARN: could not establish session (${authResult}; content probing skipped)`);
      log(lines[lines.length - 1]);
    }
  }

  const canProbeContent = mode === 'PUBLIC' || (mode === 'LOCKED' && authed);

  if (!canProbeContent) {
    // LOCKED + (no password OR auth failed): degraded fallback. Assert the
    // /password page itself renders. This branch deliberately does NOT apply
    // the ">=1 content PASS" rule: an absent/failed secret must not hard-fail a
    // deploy (the plan's rollout keeps this path green with reduced coverage).
    //   - non-200 / cross-host / connection failure -> HARD-FAIL (page broken)
    //   - 200 + theme-id match                        -> PASS  (deploy verified)
    //   - 200 + theme-id absent/mismatch on this page -> SOFT-WARN (can't confirm
    //     the theme-id on password.liquid; still green, flagged)
    const obs = await fetchObservation(`${baseUrl}/password`, probeOpts);
    let verdict, reason;
    if (obs.retriesExhausted) { verdict = SOFT_WARN; reason = 'password page throttled (429 after retries)'; }
    else if (obs.status === null) { verdict = HARD_FAIL; reason = 'password page connection failure'; }
    else if (obs.status !== 200) { verdict = HARD_FAIL; reason = `password page ${obs.status}`; }
    else if (obs.finalHost && expectedHost && obs.finalHost !== expectedHost) { verdict = HARD_FAIL; reason = `password page cross-host ${obs.finalHost}`; }
    else if (obs.themeDesc === liveThemeId) { verdict = PASS; reason = 'locked fallback: /password on-theme (content probing skipped)'; }
    else { verdict = SOFT_WARN; reason = 'locked fallback: /password rendered but theme-id unconfirmed'; }
    results.push({ path: '/password', verdict, reason });
    lines.push(`/password ${verdict} ${obs.status ?? '000'} host=${obs.finalHost ?? '-'} theme=${obs.themeDesc ?? '-'} (${reason})`);
    log(lines[lines.length - 1]);
    // Block only on a broken page; a rendered page greens regardless of the
    // >=1-PASS rule (which governs the content-probe paths, not this fallback).
    const exitCode = verdict === HARD_FAIL ? 1 : 0;
    writeGithubOutput(lines.join('\n'), exitCode);
    return { exitCode, lines, mode };
  }

  // 4b. Enumerate products from the sitemap.
  const bodyOpts = { jar, fetchImpl, sleep, backoff, timeoutMs };
  let productPaths = [];
  try {
    const idxObs = await fetchWithBody(`${baseUrl}/sitemap.xml`, bodyOpts);
    let children = parseProductSitemapChildren(idxObs);
    if (children.length === 0) children = [`${baseUrl}/sitemap_products_1.xml`];
    const seen = new Set();
    for (const child of children) {
      if (productPaths.length >= maxProducts) break;
      const childXml = await fetchWithBody(child, bodyOpts);
      for (const p of parseProductLocs(childXml)) {
        if (!seen.has(p)) { seen.add(p); productPaths.push(p); }
        if (productPaths.length >= maxProducts) break;
      }
    }
  } catch { productPaths = []; }
  if (productPaths.length === 0) {
    lines.push('sitemap SOFT-WARN: product enumeration skipped (sitemap unreachable/empty); probing structural routes only');
    log(lines[lines.length - 1]);
    results.push({ path: 'sitemap', verdict: SOFT_WARN, reason: 'enumeration skipped' });
  } else {
    log(`enumerated ${productPaths.length} product path(s) from sitemap`);
  }

  // 5. Probe structural routes, then products, paced. Stop products at deadline.
  // Drop empty AND whitespace-only entries (a bare "  " path would otherwise be
  // probed as `${baseUrl}  `); env parsing splits on \s+, this guards callers.
  const structural = structuralPaths.filter((p) => p && p.trim());
  let first = true;
  for (const path of structural) {
    if (!first) await sleep(paceMs);
    first = false;
    const obs = await fetchObservation(`${baseUrl}${path}`, probeOpts);
    record(path, obs, false);
  }
  let probed = 0;
  for (const path of productPaths) {
    if (Date.now() > deadline) {
      const remaining = productPaths.length - probed;
      lines.push(`products SOFT-WARN: time budget reached; ${remaining} product(s) unprobed`);
      log(lines[lines.length - 1]);
      results.push({ path: 'products-remainder', verdict: SOFT_WARN, reason: `${remaining} unprobed` });
      break;
    }
    await sleep(paceMs);
    const obs = await fetchObservation(`${baseUrl}${path}`, probeOpts);
    record(path, obs, true);
    probed += 1;
  }

  const { exitCode, hardFails, softWarns, passes } = summarize(results);
  log(`summary: ${passes} pass, ${softWarns} soft-warn, ${hardFails} hard-fail -> exit ${exitCode}`);
  writeGithubOutput(lines.join('\n'), exitCode);
  return { exitCode, lines, mode };
}

// Fetch a URL's body text (for sitemap XML), following redirects, with the same
// 429 backoff/retry the content probes use so a transient throttle on the
// sitemap does not needlessly collapse the run to structural-only.
async function fetchWithBody(url, { jar, fetchImpl, sleep, backoff, timeoutMs }) {
  let attempt = 0;
  while (true) {
    const headers = { ...BROWSER_HEADERS };
    if (jar && jar.size) headers.cookie = cookieHeader(jar);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, { headers, redirect: 'follow', signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (jar) updateJar(jar, res);
    if (res.status === 429 && attempt < backoff.length) {
      await sleep(backoff[attempt]);
      attempt += 1;
      continue;
    }
    return await res.text();
  }
}

// --- CLI entry -------------------------------------------------------------
function envConfig() {
  const base = process.env.SMOKE_BASE_URL
    || (process.env.SHOPIFY_FLAG_STORE ? `https://${process.env.SHOPIFY_FLAG_STORE}` : '');
  const paths = (process.env.SMOKE_PATHS || '/ /cart /collections/all /search')
    .split(/\s+/).filter(Boolean);
  // Parse a positive integer env override, falling back to the default when the
  // value is absent, non-numeric (NaN), or non-positive. A bare Number() would
  // let a typo'd env var become NaN and silently disable the cap.
  const posInt = (raw, dflt) => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  return {
    baseUrl: base.replace(/\/+$/, ''),
    structuralPaths: paths,
    liveThemeId: process.env.LIVE_THEME_ID || '',
    password: process.env.STOREFRONT_PASSWORD || process.env.STORE_PW || '',
    maxProducts: posInt(process.env.SMOKE_MAX_PRODUCTS, 200),
    maxSeconds: posInt(process.env.SMOKE_MAX_SECONDS, 240),
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const cfg = envConfig();
  if (!cfg.baseUrl) {
    process.stderr.write('smoke: no SMOKE_BASE_URL / SHOPIFY_FLAG_STORE configured\n');
    process.exit(1);
  }
  if (!cfg.liveThemeId) {
    process.stderr.write('smoke: no LIVE_THEME_ID configured\n');
    process.exit(1);
  }
  const { exitCode, mode } = await runSmoke({
    ...cfg,
    log: (l) => process.stdout.write(l + '\n'),
    // In a real dry run against live, keep the paced cadence; tests inject fakes.
  });
  if (dryRun) process.stdout.write(`\n[dry-run] mode=${mode} exit=${exitCode}\n`);
  process.exit(exitCode);
}

// Only run the CLI when executed directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    // Never print the error object verbatim (could carry a request/url with creds).
    process.stderr.write(`smoke: fatal (${e && e.name ? e.name : 'error'})\n`);
    process.exit(1);
  });
}
