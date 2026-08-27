// node --test unit tests for smoke.mjs. No real network, no real waiting:
// fetch is a scripted mock and sleep is a recording no-op.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync as readFile, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  classify, parseThemeId, hostOf, parseProductLocs, parseProductSitemapChildren,
  summarize, runSmoke, authenticateStorefront, DEFAULT_SMOKE_PATHS, POLICY_MARKERS,
  isPolicyPath, PASS, SOFT_WARN, HARD_FAIL,
} from './smoke.mjs';

const THEME = '181702754604';
const HOST = 'sapphireshadowstudio.com';
const BASE = `https://${HOST}`;

// --- Response + fetch mock -------------------------------------------------
function mkRes({ status = 200, url = `${BASE}/`, location = null, serverTiming = null, setCookie = [], body = '' } = {}) {
  const headers = {
    get(name) {
      const n = name.toLowerCase();
      if (n === 'location') return location;
      if (n === 'server-timing') return serverTiming;
      return null;
    },
    getSetCookie() { return setCookie; },
  };
  return { status, url, headers, text: async () => body };
}

const themeTiming = (id = THEME) => `db;dur=1, theme;desc="${id}"`;

/**
 * Build a scripted fetch. `routes` maps a matcher to either a response
 * descriptor, an array of descriptors consumed per-call, or a function
 * (url, opts, callIndex) => descriptor | 'THROW'.
 */
function scriptedFetch(routeFns) {
  const calls = [];
  const perKey = new Map();
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    for (const [match, resolver] of routeFns) {
      if (!match(url, opts)) continue;
      const key = resolver;
      const n = perKey.get(key) ?? 0;
      perKey.set(key, n + 1);
      let desc;
      if (typeof resolver === 'function') desc = resolver(url, opts, n);
      else if (Array.isArray(resolver)) desc = resolver[Math.min(n, resolver.length - 1)];
      else desc = resolver;
      if (desc === 'THROW') throw new Error('boom');
      return mkRes({ url, ...desc });
    }
    return mkRes({ url, status: 200, serverTiming: themeTiming() });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function recordingSleep() {
  const delays = [];
  const sleep = async (ms) => { delays.push(ms); };
  sleep.delays = delays;
  return sleep;
}

const baseArgs = (over = {}) => ({
  baseUrl: BASE,
  structuralPaths: ['/', '/cart'],
  liveThemeId: THEME,
  sleep: recordingSleep(),
  paceMs: 4000,
  backoff: [8000, 20000],
  timeoutMs: 30000,
  ...over,
});

// --- parseThemeId ----------------------------------------------------------
test('parseThemeId: quoted, unquoted, absent, malformed', () => {
  assert.equal(parseThemeId(`theme;desc="181702754604"`), THEME);
  assert.equal(parseThemeId(`x, theme;desc=181702754604`), THEME);
  assert.equal(parseThemeId(`cache;desc="hit"`), null);
  assert.equal(parseThemeId(null), null);
  assert.equal(parseThemeId(''), null);
  assert.equal(parseThemeId(`theme;desc="abc"`), null);
});

test('hostOf', () => {
  assert.equal(hostOf(`${BASE}/products/x`), HOST);
  assert.equal(hostOf('not a url'), null);
});

// --- classify: full decision table ----------------------------------------
const cbase = { expectedHost: HOST, expectedThemeId: THEME, finalHost: HOST, themeDesc: THEME, redirectPath: null, retriesExhausted: false };

test('classify: 200 on-theme same-host -> PASS', () => {
  assert.equal(classify({ ...cbase, status: 200 }).verdict, PASS);
});
test('classify: residual 429 -> SOFT-WARN', () => {
  assert.equal(classify({ ...cbase, status: 429, retriesExhausted: true }).verdict, SOFT_WARN);
});
test('classify: connection failure (null) -> HARD-FAIL', () => {
  assert.equal(classify({ ...cbase, status: null }).verdict, HARD_FAIL);
});
test('classify: 5xx -> HARD-FAIL', () => {
  assert.equal(classify({ ...cbase, status: 503 }).verdict, HARD_FAIL);
});
test('classify: 404 on product -> HARD-FAIL product unavailable', () => {
  const r = classify({ ...cbase, status: 404, isProduct: true });
  assert.equal(r.verdict, HARD_FAIL);
  assert.match(r.reason, /product unavailable/);
});
test('classify: 404 on structural -> HARD-FAIL not found', () => {
  assert.equal(classify({ ...cbase, status: 404, isProduct: false }).verdict, HARD_FAIL);
});
test('classify: 410 gone -> HARD-FAIL', () => {
  assert.equal(classify({ ...cbase, status: 410, isProduct: true }).verdict, HARD_FAIL);
});
test('classify: same-host non-/password 3xx -> HARD-FAIL unexpected redirect', () => {
  const r = classify({ ...cbase, status: 301, redirectPath: '/somewhere', finalHost: HOST });
  assert.equal(r.verdict, HARD_FAIL);
  assert.match(r.reason, /unexpected redirect/);
});
test('classify: 3xx to /password -> HARD-FAIL auth wall', () => {
  const r = classify({ ...cbase, status: 302, redirectPath: '/password' });
  assert.equal(r.verdict, HARD_FAIL);
  assert.match(r.reason, /auth wall/);
});
test('classify: 3xx cross-host -> HARD-FAIL', () => {
  const r = classify({ ...cbase, status: 302, finalHost: 'evil.example', redirectPath: '/x' });
  assert.equal(r.verdict, HARD_FAIL);
  assert.match(r.reason, /cross-host/);
});
test('classify: 200 cross-host final -> HARD-FAIL', () => {
  assert.equal(classify({ ...cbase, status: 200, finalHost: 'evil.example' }).verdict, HARD_FAIL);
});
test('classify: 200 missing theme-id -> HARD-FAIL', () => {
  assert.equal(classify({ ...cbase, status: 200, themeDesc: null }).verdict, HARD_FAIL);
});
test('classify: 200 theme-id mismatch -> HARD-FAIL', () => {
  const r = classify({ ...cbase, status: 200, themeDesc: '999' });
  assert.equal(r.verdict, HARD_FAIL);
  assert.match(r.reason, /mismatch/);
});
test('classify: unexpected 401 -> HARD-FAIL', () => {
  assert.equal(classify({ ...cbase, status: 401 }).verdict, HARD_FAIL);
});
test('classify: retriesExhausted takes precedence over status', () => {
  // A 429 that exhausted retries is a throttle artifact, not a 5xx-style fail.
  assert.equal(classify({ ...cbase, status: 429, retriesExhausted: true }).verdict, SOFT_WARN);
});

// --- sitemap parsing -------------------------------------------------------
test('parseProductLocs: extracts /products/handle, skips non-product + malformed', () => {
  const xml = `<urlset>
    <url><loc>${BASE}/products/huddle-crewneck</loc></url>
    <url><loc>${BASE}/products/vest-navy</loc></url>
    <url><loc>${BASE}/collections/all</loc></url>
    <url><loc>not-a-url</loc></url>
    <url><loc>${BASE}/products/huddle-crewneck</loc></url>
  </urlset>`;
  const locs = parseProductLocs(xml);
  assert.deepEqual(locs, ['/products/huddle-crewneck', '/products/vest-navy', '/products/huddle-crewneck']);
});
test('parseProductLocs: empty/garbage input', () => {
  assert.deepEqual(parseProductLocs(''), []);
  assert.deepEqual(parseProductLocs('<xml>broken'), []);
});
test('parseProductSitemapChildren: finds product child sitemaps only', () => {
  const xml = `<sitemapindex>
    <sitemap><loc>${BASE}/sitemap_products_1.xml?from=1&to=9</loc></sitemap>
    <sitemap><loc>${BASE}/sitemap_collections_1.xml</loc></sitemap>
    <sitemap><loc>${BASE}/sitemap_products_2.xml</loc></sitemap>
  </sitemapindex>`;
  const kids = parseProductSitemapChildren(xml);
  assert.equal(kids.length, 2);
  assert.match(kids[0], /sitemap_products_1/);
});

// --- summarize -------------------------------------------------------------
test('summarize: any hard-fail -> exit 1', () => {
  assert.equal(summarize([{ verdict: PASS }, { verdict: HARD_FAIL }]).exitCode, 1);
});
test('summarize: all soft-warn (nothing verified) -> exit 1', () => {
  assert.equal(summarize([{ verdict: SOFT_WARN }, { verdict: SOFT_WARN }]).exitCode, 1);
});
test('summarize: at least one pass + a soft-warn -> exit 0', () => {
  assert.equal(summarize([{ verdict: PASS }, { verdict: SOFT_WARN }]).exitCode, 0);
});
test('summarize: empty -> exit 0', () => {
  assert.equal(summarize([]).exitCode, 0);
});

// --- orchestration: PUBLIC mode -------------------------------------------
test('runSmoke PUBLIC: all structural PASS, exit 0, no products enumerated', async () => {
  const fetchImpl = scriptedFetch([
    [(u) => u.endsWith('/sitemap.xml'), { status: 200, body: '<sitemapindex></sitemapindex>' }],
    [() => true, { status: 200, serverTiming: themeTiming() }],
  ]);
  const args = baseArgs({ fetchImpl });
  const r = await runSmoke(args);
  assert.equal(r.mode, 'PUBLIC');
  assert.equal(r.exitCode, 0);
  // structural '/' and '/cart' both PASS
  assert.ok(r.lines.some(l => l.startsWith('/ PASS')));
  assert.ok(r.lines.some(l => l.startsWith('/cart PASS')));
});

test('runSmoke PUBLIC: 429-then-200 retry -> PASS and backoff slept once', async () => {
  const sleep = recordingSleep();
  const fetchImpl = scriptedFetch([
    [(u) => u.endsWith('/sitemap.xml'), { status: 200, body: '' }],
    // '/cart' returns 429 first, then 200.
    [(u) => u.endsWith('/cart'), [{ status: 429 }, { status: 200, serverTiming: themeTiming() }]],
    [() => true, { status: 200, serverTiming: themeTiming() }],
  ]);
  const r = await runSmoke(baseArgs({ fetchImpl, sleep, structuralPaths: ['/cart'] }));
  assert.equal(r.exitCode, 0);
  assert.ok(r.lines.some(l => l.startsWith('/cart PASS')));
  assert.ok(sleep.delays.includes(8000), 'first backoff used');
});

test('runSmoke PUBLIC: residual 429 exhausts retries -> SOFT-WARN, and all-softwarn exits 1', async () => {
  const sleep = recordingSleep();
  const fetchImpl = scriptedFetch([
    [(u) => u.includes('sitemap'), { status: 200, body: '' }], // sitemap not throttled
    [(u) => u.endsWith('/'), { status: 200, serverTiming: themeTiming() }], // root detect = PUBLIC
    [() => true, { status: 429 }],
  ]);
  // Only a 429 structural path, so nothing verifies -> exit 1 by the >=1-PASS rule.
  const r = await runSmoke(baseArgs({ fetchImpl, sleep, structuralPaths: ['/cart'] }));
  assert.ok(r.lines.some(l => l.startsWith('/cart SOFT-WARN')));
  assert.equal(r.exitCode, 1);
  // Backoff order must be [8000, 20000], not e.g. the first delay used twice.
  assert.deepEqual(sleep.delays, [8000, 20000]);
});

test('runSmoke PUBLIC: theme-id mismatch -> HARD-FAIL exit 1', async () => {
  const fetchImpl = scriptedFetch([
    [(u) => u.endsWith('/sitemap.xml'), { status: 200, body: '' }],
    [() => true, { status: 200, serverTiming: themeTiming('999') }],
  ]);
  const r = await runSmoke(baseArgs({ fetchImpl }));
  assert.equal(r.exitCode, 1);
  assert.ok(r.lines.some(l => /HARD-FAIL.*mismatch/.test(l)));
});

test('runSmoke PUBLIC: 5xx -> HARD-FAIL exit 1', async () => {
  const fetchImpl = scriptedFetch([
    [(u) => u.endsWith('/sitemap.xml'), { status: 200, body: '' }],
    [(u) => u.endsWith('/'), { status: 200, serverTiming: themeTiming() }],
    [(u) => u.endsWith('/cart'), { status: 503 }],
  ]);
  const r = await runSmoke(baseArgs({ fetchImpl }));
  assert.equal(r.exitCode, 1);
  assert.ok(r.lines.some(l => /\/cart HARD-FAIL 503/.test(l)));
});

test('runSmoke PUBLIC: connection failure -> HARD-FAIL', async () => {
  const fetchImpl = scriptedFetch([
    [(u) => u.endsWith('/sitemap.xml'), { status: 200, body: '' }],
    [(u) => u.endsWith('/'), { status: 200, serverTiming: themeTiming() }],
    [(u) => u.endsWith('/cart'), 'THROW'],
  ]);
  const r = await runSmoke(baseArgs({ fetchImpl }));
  assert.equal(r.exitCode, 1);
  assert.ok(r.lines.some(l => /\/cart HARD-FAIL 000/.test(l)));
});

test('runSmoke PUBLIC: cross-host redirect -> HARD-FAIL', async () => {
  const fetchImpl = scriptedFetch([
    [(u) => u.endsWith('/sitemap.xml'), { status: 200, body: '' }],
    [(u) => u.endsWith('/'), { status: 200, serverTiming: themeTiming() }],
    [(u) => u.endsWith('/cart'), { status: 200, url: 'https://evil.example/cart', serverTiming: themeTiming() }],
  ]);
  const r = await runSmoke(baseArgs({ fetchImpl }));
  assert.equal(r.exitCode, 1);
  assert.ok(r.lines.some(l => /\/cart HARD-FAIL.*evil\.example/.test(l)));
});

// --- orchestration: LOCKED mode -------------------------------------------
test('runSmoke LOCKED + password: authenticates, probes with cookie, products PASS', async () => {
  let sawCookieOnProduct = false;
  const fetchImpl = scriptedFetch([
    // root detect: 302 -> /password (LOCKED)
    [(u, o) => u.endsWith('/') && (!o.method) && !o.headers?.cookie, { status: 302, location: '/password', serverTiming: null }],
    // GET /password (seed) then POST /password (auth) -> 302 to /
    [(u, o) => u.endsWith('/password') && o.method === 'POST', { status: 302, location: '/', setCookie: ['_shopify_essential=SECRET_SESSION; path=/'] }],
    [(u, o) => u.endsWith('/password') && o.method !== 'POST', { status: 200, setCookie: ['_shopify_essential=SEED; path=/'] }],
    [(u) => u.endsWith('/sitemap.xml'), { status: 200, body: `<sitemapindex><sitemap><loc>${BASE}/sitemap_products_1.xml</loc></sitemap></sitemapindex>` }],
    [(u) => u.endsWith('/sitemap_products_1.xml'), { status: 200, body: `<urlset><url><loc>${BASE}/products/huddle-crewneck</loc></url></urlset>` }],
    // product + structural authed probes: assert cookie present, return 200 on-theme
    [(u, o) => u.includes('/products/'), (u, o) => { if ((o.headers?.cookie || '').includes('_shopify_essential')) sawCookieOnProduct = true; return { status: 200, serverTiming: themeTiming() }; }],
    [() => true, { status: 200, serverTiming: themeTiming() }],
  ]);
  const r = await runSmoke(baseArgs({ fetchImpl, password: 'hunter2' }));
  assert.equal(r.mode, 'LOCKED');
  assert.equal(r.exitCode, 0);
  assert.ok(sawCookieOnProduct, 'product probe carried the session cookie');
  assert.ok(r.lines.some(l => /\/products\/huddle-crewneck PASS/.test(l)));
});

test('runSmoke LOCKED + no password: /password on-theme -> PASS, greens with reduced coverage', async () => {
  const fetchImpl = scriptedFetch([
    [(u, o) => u.endsWith('/') && !o.headers?.cookie, { status: 302, location: '/password' }],
    [(u) => u.endsWith('/password'), { status: 200, serverTiming: themeTiming() }],
  ]);
  const r = await runSmoke(baseArgs({ fetchImpl, password: '' }));
  assert.equal(r.mode, 'LOCKED');
  // /password renders on-theme -> PASS (deploy verified via password.liquid).
  // Absent secret must not block the deploy, so exit 0.
  assert.ok(r.lines.some(l => /\/password PASS/.test(l)));
  assert.equal(r.exitCode, 0);
});

test('runSmoke LOCKED + no password: /password renders but no theme-id -> SOFT-WARN, still greens', async () => {
  const fetchImpl = scriptedFetch([
    [(u, o) => u.endsWith('/') && !o.headers?.cookie, { status: 302, location: '/password' }],
    [(u) => u.endsWith('/password'), { status: 200, serverTiming: null }],
  ]);
  const r = await runSmoke(baseArgs({ fetchImpl, password: '' }));
  assert.ok(r.lines.some(l => /\/password SOFT-WARN/.test(l)));
  assert.equal(r.exitCode, 0); // rendered page, absent secret -> green, flagged
});

test('runSmoke LOCKED + no password: /password itself broken (503) -> HARD-FAIL', async () => {
  const fetchImpl = scriptedFetch([
    [(u, o) => u.endsWith('/') && !o.headers?.cookie, { status: 302, location: '/password' }],
    [(u) => u.endsWith('/password'), { status: 503 }],
  ]);
  const r = await runSmoke(baseArgs({ fetchImpl, password: '' }));
  assert.ok(r.lines.some(l => /\/password HARD-FAIL 503/.test(l)));
  assert.equal(r.exitCode, 1);
});

test('runSmoke LOCKED + REJECTED password (POST 302 back to /password): HARD-FAIL, does not fall back green', async () => {
  const fetchImpl = scriptedFetch([
    [(u, o) => u.endsWith('/') && !o.headers?.cookie, { status: 302, location: '/password' }],
    // Wrong/rotated password: Shopify redirects BACK to /password (auth refused).
    [(u, o) => u.endsWith('/password') && o.method === 'POST', { status: 302, location: '/password' }],
    [(u, o) => u.endsWith('/password') && o.method !== 'POST', { status: 200, serverTiming: themeTiming() }],
  ]);
  const r = await runSmoke(baseArgs({ fetchImpl, password: 'wrong' }));
  assert.equal(r.mode, 'LOCKED');
  // A provided-but-refused password must block: a silent green fallback would
  // let a rotated secret drop content coverage on unattended auto-deploys.
  assert.ok(r.lines.some(l => /\/password HARD-FAIL - AUTH/.test(l)));
  assert.equal(r.exitCode, 1);
});

test('runSmoke LOCKED + REJECTED password (POST 200 re-render): HARD-FAIL', async () => {
  const fetchImpl = scriptedFetch([
    [(u, o) => u.endsWith('/') && !o.headers?.cookie, { status: 302, location: '/password' }],
    [(u, o) => u.endsWith('/password') && o.method === 'POST', { status: 200 }], // form re-render, no redirect
    [(u, o) => u.endsWith('/password') && o.method !== 'POST', { status: 200, serverTiming: themeTiming() }],
  ]);
  const r = await runSmoke(baseArgs({ fetchImpl, password: 'wrong' }));
  assert.ok(r.lines.some(l => /HARD-FAIL - AUTH/.test(l)));
  assert.equal(r.exitCode, 1);
});

test('runSmoke LOCKED + password POST 429-then-302: retries auth, then succeeds', async () => {
  const sleep = recordingSleep();
  const fetchImpl = scriptedFetch([
    [(u, o) => u.endsWith('/') && !o.headers?.cookie, { status: 302, location: '/password' }],
    // POST throttled once, then accepted (302 away from /password).
    [(u, o) => u.endsWith('/password') && o.method === 'POST', [{ status: 429 }, { status: 302, location: '/', setCookie: ['_shopify_essential=S'] }]],
    [(u, o) => u.endsWith('/password') && o.method !== 'POST', { status: 200, setCookie: ['_shopify_essential=SEED'] }],
    [(u) => u.endsWith('/sitemap.xml'), { status: 200, body: '<sitemapindex></sitemapindex>' }],
    [() => true, { status: 200, serverTiming: themeTiming() }],
  ]);
  const r = await runSmoke(baseArgs({ fetchImpl, sleep, password: 'right' }));
  assert.equal(r.exitCode, 0);
  assert.ok(sleep.delays.includes(8000), 'auth backoff slept');
  assert.ok(r.lines.some(l => /^\/ PASS/.test(l)), 'content probed after successful auth');
});

test('runSmoke LOCKED + password POST persistent 429: throttled -> SOFT-WARN fallback, greens', async () => {
  const sleep = recordingSleep();
  const fetchImpl = scriptedFetch([
    [(u, o) => u.endsWith('/') && !o.headers?.cookie, { status: 302, location: '/password' }],
    [(u, o) => u.endsWith('/password') && o.method === 'POST', { status: 429 }],
    [(u, o) => u.endsWith('/password') && o.method !== 'POST', { status: 200, serverTiming: themeTiming() }],
  ]);
  const r = await runSmoke(baseArgs({ fetchImpl, sleep, password: 'right' }));
  // Transient throttle on auth is NOT a rejected password: soft-warn + fallback.
  assert.ok(r.lines.some(l => /AUTH SOFT-WARN.*throttled/.test(l)));
  assert.ok(r.lines.some(l => /\/password PASS/.test(l)));
  assert.equal(r.exitCode, 0);
});

test('runSmoke LOCKED + password POST persistent 503: transient error -> SOFT-WARN fallback, NOT rejected', async () => {
  const sleep = recordingSleep();
  const fetchImpl = scriptedFetch([
    [(u, o) => u.endsWith('/') && !o.headers?.cookie, { status: 302, location: '/password' }],
    [(u, o) => u.endsWith('/password') && o.method === 'POST', { status: 503 }],
    [(u, o) => u.endsWith('/password') && o.method !== 'POST', { status: 200, serverTiming: themeTiming() }],
  ]);
  const r = await runSmoke(baseArgs({ fetchImpl, sleep, password: 'right' }));
  // A 503 on the auth POST is a transient edge error, NOT a rejected password:
  // must not HARD-FAIL. Retries, then soft-warns and falls back.
  assert.ok(r.lines.some(l => /AUTH SOFT-WARN.*error/.test(l)));
  assert.ok(!r.lines.some(l => /HARD-FAIL - AUTH/.test(l)));
  assert.ok(sleep.delays.includes(8000), 'auth POST retried on 5xx');
  assert.equal(r.exitCode, 0);
});

test('runSmoke LOCKED + password POST 503-then-302: retries 5xx, then authenticates', async () => {
  const sleep = recordingSleep();
  const fetchImpl = scriptedFetch([
    [(u, o) => u.endsWith('/') && !o.headers?.cookie, { status: 302, location: '/password' }],
    [(u, o) => u.endsWith('/password') && o.method === 'POST', [{ status: 503 }, { status: 302, location: '/', setCookie: ['_shopify_essential=S'] }]],
    [(u, o) => u.endsWith('/password') && o.method !== 'POST', { status: 200, setCookie: ['_shopify_essential=SEED'] }],
    [(u) => u.endsWith('/sitemap.xml'), { status: 200, body: '<sitemapindex></sitemapindex>' }],
    [() => true, { status: 200, serverTiming: themeTiming() }],
  ]);
  const r = await runSmoke(baseArgs({ fetchImpl, sleep, password: 'right' }));
  assert.equal(r.exitCode, 0);
  assert.ok(r.lines.some(l => /^\/ PASS/.test(l)), 'content probed after 5xx retry recovered');
});

test('runSmoke LOCKED + password POST throws: error -> SOFT-WARN fallback', async () => {
  const fetchImpl = scriptedFetch([
    [(u, o) => u.endsWith('/') && !o.headers?.cookie, { status: 302, location: '/password' }],
    [(u, o) => u.endsWith('/password') && o.method === 'POST', 'THROW'],
    [(u, o) => u.endsWith('/password') && o.method !== 'POST', { status: 200, serverTiming: themeTiming() }],
  ]);
  const r = await runSmoke(baseArgs({ fetchImpl, password: 'right' }));
  assert.ok(r.lines.some(l => /AUTH SOFT-WARN.*error/.test(l)));
  assert.equal(r.exitCode, 0);
});

test('runSmoke: 5xx root -> HARD-FAIL (broken storefront, not treated as LOCKED)', async () => {
  const fetchImpl = scriptedFetch([
    [(u) => u.endsWith('/'), { status: 503 }],
  ]);
  // Even with no password, a broken root must not green via the /password path.
  const r = await runSmoke(baseArgs({ fetchImpl, password: '' }));
  assert.ok(r.lines.some(l => /^\/ HARD-FAIL 503/.test(l)));
  assert.equal(r.exitCode, 1);
});

test('runSmoke LOCKED + no password + /password 429: throttle -> SOFT-WARN, greens', async () => {
  const sleep = recordingSleep();
  const fetchImpl = scriptedFetch([
    [(u, o) => u.endsWith('/') && !o.headers?.cookie, { status: 302, location: '/password' }],
    [(u) => u.endsWith('/password'), { status: 429 }],
  ]);
  const r = await runSmoke(baseArgs({ fetchImpl, sleep, password: '' }));
  assert.ok(r.lines.some(l => /\/password SOFT-WARN.*throttled/.test(l)));
  assert.equal(r.exitCode, 0);
});

test('runSmoke PUBLIC: multi-hop redirect followed to a same-host 200 -> PASS', async () => {
  const fetchImpl = scriptedFetch([
    [(u) => u.endsWith('/sitemap.xml'), { status: 200, body: '' }],
    [(u) => u.endsWith('/'), { status: 200, serverTiming: themeTiming() }], // root detect PUBLIC
    // /cart 301 -> /cart-new (same host) -> 200 on-theme
    [(u) => u.endsWith('/cart'), { status: 301, location: '/cart-new' }],
    [(u) => u.endsWith('/cart-new'), { status: 200, url: `${BASE}/cart-new`, serverTiming: themeTiming() }],
  ]);
  const r = await runSmoke(baseArgs({ fetchImpl, structuralPaths: ['/cart'] }));
  assert.equal(r.exitCode, 0);
  assert.ok(r.lines.some(l => /\/cart PASS 200/.test(l)));
});

test('runSmoke PUBLIC: redirect loop beyond maxHops -> HARD-FAIL (does not hang)', async () => {
  const fetchImpl = scriptedFetch([
    [(u) => u.endsWith('/sitemap.xml'), { status: 200, body: '' }],
    [(u) => u.endsWith('/'), { status: 200, serverTiming: themeTiming() }],
    // /cart always 301s to /loop (same host) -> exceeds maxHops (5)
    [(u) => u.includes('/cart') || u.includes('/loop'), { status: 301, location: '/loop' }],
  ]);
  const r = await runSmoke(baseArgs({ fetchImpl, structuralPaths: ['/cart'] }));
  assert.equal(r.exitCode, 1);
  assert.ok(r.lines.some(l => /\/cart HARD-FAIL 301/.test(l)));
});

test('runSmoke: maxProducts cap truncates enumeration', async () => {
  const fetchImpl = scriptedFetch([
    [(u) => u.endsWith('/sitemap.xml'), { status: 200, body: `<urlset><url><loc>${BASE}/products/a</loc></url><url><loc>${BASE}/products/b</loc></url><url><loc>${BASE}/products/c</loc></url></urlset>` }],
    [(u) => u.endsWith('/sitemap_products_1.xml'), { status: 200, body: `<urlset><url><loc>${BASE}/products/a</loc></url><url><loc>${BASE}/products/b</loc></url><url><loc>${BASE}/products/c</loc></url></urlset>` }],
    [() => true, { status: 200, serverTiming: themeTiming() }],
  ]);
  const r = await runSmoke(baseArgs({ fetchImpl, structuralPaths: [], maxProducts: 2 }));
  const productLines = r.lines.filter(l => /^\/products\//.test(l));
  assert.equal(productLines.length, 2);
});

test('runSmoke: whitespace-only SMOKE_PATHS entries are not probed', async () => {
  const fetchImpl = scriptedFetch([
    [(u) => u.endsWith('/sitemap.xml'), { status: 200, body: `<urlset><url><loc>${BASE}/products/x</loc></url></urlset>` }],
    [(u) => u.endsWith('/sitemap_products_1.xml'), { status: 200, body: `<urlset><url><loc>${BASE}/products/x</loc></url></urlset>` }],
    [(u) => u.endsWith('/'), { status: 200, serverTiming: themeTiming() }],
    [() => true, { status: 200, serverTiming: themeTiming() }],
  ]);
  // Pass raw whitespace entries (NOT pre-filtered) to prove runSmoke drops them.
  const r = await runSmoke(baseArgs({ fetchImpl, structuralPaths: ['', '  ', '\t'] }));
  // No structural probe line for a blank/whitespace path (would be `  PASS ...`).
  assert.ok(!r.lines.some(l => /^\s+(PASS|HARD-FAIL|SOFT-WARN)/.test(l)));
  assert.ok(r.lines.some(l => /\/products\/x PASS/.test(l)));
});

test('runSmoke: session cookie is registered with ::add-mask:: under Actions', async () => {
  const prevActions = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = 'true';
  const writes = [];
  const origWrite = process.stdout.write;
  process.stdout.write = (s) => { writes.push(String(s)); return true; };
  try {
    const fetchImpl = scriptedFetch([
      [(u, o) => u.endsWith('/') && !o.headers?.cookie, { status: 302, location: '/password' }],
      [(u, o) => u.endsWith('/password') && o.method === 'POST', { status: 302, location: '/', setCookie: ['_shopify_essential=MASKME'] }],
      [(u, o) => u.endsWith('/password') && o.method !== 'POST', { status: 200, setCookie: ['_shopify_essential=SEED'] }],
      [(u) => u.endsWith('/sitemap.xml'), { status: 200, body: '<sitemapindex></sitemapindex>' }],
      [() => true, { status: 200, serverTiming: themeTiming() }],
    ]);
    await runSmoke(baseArgs({ fetchImpl, password: 'pw' }));
  } finally {
    process.stdout.write = origWrite;
    if (prevActions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = prevActions;
  }
  assert.ok(writes.some(w => /::add-mask::MASKME/.test(w)), 'cookie value masked');
});

// --- sitemap unreachable ---------------------------------------------------
test('runSmoke PUBLIC: sitemap unreachable -> SOFT-WARN, structural still gate', async () => {
  const fetchImpl = scriptedFetch([
    [(u) => u.endsWith('/sitemap.xml'), 'THROW'],
    [() => true, { status: 200, serverTiming: themeTiming() }],
  ]);
  const r = await runSmoke(baseArgs({ fetchImpl }));
  assert.ok(r.lines.some(l => /sitemap SOFT-WARN/.test(l)));
  // structural passes still verify -> exit 0
  assert.equal(r.exitCode, 0);
});

// --- output hygiene --------------------------------------------------------
test('runSmoke: emitted lines never contain the password or a cookie value', async () => {
  const fetchImpl = scriptedFetch([
    [(u, o) => u.endsWith('/') && !o.headers?.cookie, { status: 302, location: '/password' }],
    [(u, o) => u.endsWith('/password') && o.method === 'POST', { status: 302, location: '/', setCookie: ['_shopify_essential=SUPERSECRETVALUE; path=/'] }],
    [(u, o) => u.endsWith('/password') && o.method !== 'POST', { status: 200, setCookie: ['_shopify_essential=SEED'] }],
    [(u) => u.endsWith('/sitemap.xml'), { status: 200, body: '<sitemapindex></sitemapindex>' }],
    [() => true, { status: 200, serverTiming: themeTiming() }],
  ]);
  const r = await runSmoke(baseArgs({ fetchImpl, password: 'MYSTOREPASSWORD' }));
  const blob = r.lines.join('\n');
  assert.doesNotMatch(blob, /MYSTOREPASSWORD/);
  assert.doesNotMatch(blob, /SUPERSECRETVALUE/);
  assert.doesNotMatch(blob, /set-cookie|_shopify_essential=/i);
});

// --- input validation ------------------------------------------------------
test('runSmoke: empty/whitespace structural paths -> no structural probes, sitemap-only', async () => {
  const fetchImpl = scriptedFetch([
    [(u) => u.endsWith('/sitemap.xml'), { status: 200, body: `<urlset><url><loc>${BASE}/products/x</loc></url></urlset>` }],
    [(u) => u.endsWith('/sitemap_products_1.xml'), { status: 200, body: `<urlset><url><loc>${BASE}/products/x</loc></url></urlset>` }],
    [(u) => u.endsWith('/'), { status: 200, serverTiming: themeTiming() }],
    [() => true, { status: 200, serverTiming: themeTiming() }],
  ]);
  const r = await runSmoke(baseArgs({ fetchImpl, structuralPaths: ['', '  '].filter(s => s.trim()) }));
  // structuralPaths filtered to empty; product still probed
  assert.ok(r.lines.some(l => /\/products\/x PASS/.test(l)));
});

// --- time budget -----------------------------------------------------------
test('runSmoke: exhausted time budget -> SOFT-WARN remainder, does not hard-fail', async () => {
  const fetchImpl = scriptedFetch([
    [(u) => u.endsWith('/sitemap.xml'), { status: 200, body: `<urlset><url><loc>${BASE}/products/a</loc></url><url><loc>${BASE}/products/b</loc></url></urlset>` }],
    [(u) => u.endsWith('/sitemap_products_1.xml'), { status: 200, body: `<urlset><url><loc>${BASE}/products/a</loc></url><url><loc>${BASE}/products/b</loc></url></urlset>` }],
    [() => true, { status: 200, serverTiming: themeTiming() }],
  ]);
  // maxSeconds negative forces the deadline to be in the past for products.
  const r = await runSmoke(baseArgs({ fetchImpl, maxSeconds: -1 }));
  assert.ok(r.lines.some(l => /products SOFT-WARN: time budget/.test(l)));
  // structural still passed -> exit 0
  assert.equal(r.exitCode, 0);
});

// --- authenticateStorefront (shared with scripts/a11y/get-auth-cookie.mjs) ---
//
// runSmoke's own auth tests above cover the deploy-facing consequences. These
// pin the exported contract directly, because the a11y auth helper now depends
// on these four outcome strings and on the retry rule behind them.
const auth = (fetchImpl, { sleep = recordingSleep(), backoff = [8000, 20000] } = {}) =>
  authenticateStorefront({ baseUrl: BASE, password: 'p', jar: new Map(), fetchImpl, sleep, backoff });

test('authenticateStorefront: 3xx away from /password -> success', async () => {
  const fetchImpl = scriptedFetch([
    [(u, o) => u.endsWith('/password') && o.method === 'POST', { status: 302, location: '/' }],
    [() => true, { status: 200 }],
  ]);
  assert.equal(await auth(fetchImpl), 'success');
});

test('authenticateStorefront: 200 re-render and 3xx back to /password -> rejected', async () => {
  const reRender = scriptedFetch([
    [(u, o) => u.endsWith('/password') && o.method === 'POST', { status: 200 }],
    [() => true, { status: 200 }],
  ]);
  assert.equal(await auth(reRender), 'rejected');
  const bounce = scriptedFetch([
    [(u, o) => u.endsWith('/password') && o.method === 'POST', { status: 302, location: '/password' }],
    [() => true, { status: 200 }],
  ]);
  assert.equal(await auth(bounce), 'rejected');
});

test('authenticateStorefront: a persistent 429 is throttled, a 5xx is error, never rejected', async () => {
  const throttled = scriptedFetch([
    [(u, o) => u.endsWith('/password') && o.method === 'POST', { status: 429 }],
    [() => true, { status: 200 }],
  ]);
  assert.equal(await auth(throttled), 'throttled');
  const broken = scriptedFetch([
    [(u, o) => u.endsWith('/password') && o.method === 'POST', { status: 503 }],
    [() => true, { status: 200 }],
  ]);
  assert.equal(await auth(broken), 'error');
});

test('authenticateStorefront: a network failure is error, and the retries are bounded by backoff', async () => {
  const dead = scriptedFetch([
    [(u, o) => u.endsWith('/password') && o.method === 'POST', 'THROW'],
    [() => true, { status: 200 }],
  ]);
  assert.equal(await auth(dead), 'error');

  const sleep = recordingSleep();
  const throttled = scriptedFetch([
    [(u, o) => u.endsWith('/password') && o.method === 'POST', { status: 429 }],
    [() => true, { status: 200 }],
  ]);
  await auth(throttled, { sleep, backoff: [1, 2] });
  assert.deepEqual(sleep.delays, [1, 2], 'exactly one POST per backoff entry, then give up');
});


// --- policy jump-nav markers ----------------------------------------------
//
// The five /policies/* pages are not themeable: Shopify renders them, and the
// only theme code that runs there is snippets/policy-page.liquid, injected by
// layout/theme.liquid's policy guard. Status/host/theme-id all stay green when
// that snippet stops rendering, so the body is checked for the custom-element
// tag. SOFT-WARN only: a rollback to a theme predating the snippet ships
// through the same comment-deploy cycle and must not be blocked by this check.

const POLICY_PATH = '/policies/refund-policy';
// A needle that appears nowhere in the marker list, so any leak of body text
// into a line, a reason or GITHUB_OUTPUT is detectable.
const BODY_NEEDLE = 'ZZBODYNEEDLEZZ';
const POLICY_BODY_OK = `<main>${BODY_NEEDLE}<policy-nav-component><nav hidden><ul></ul></nav></policy-nav-component></main>`;
const POLICY_BODY_BROKEN = `<main>${BODY_NEEDLE}<div class="shopify-policy__body"></div></main>`;

/** Wrap a scripted fetch so every res.text() call is recorded by URL. */
function trackBodyReads(fetchImpl) {
  const reads = [];
  const wrapped = async (url, opts) => {
    const res = await fetchImpl(url, opts);
    const orig = res.text.bind(res);
    res.text = async () => { reads.push(url); return orig(); };
    return res;
  };
  wrapped.reads = reads;
  return wrapped;
}

/** Run `fn` with GITHUB_OUTPUT pointed at a temp file; returns its contents. */
async function withGithubOutput(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-out-'));
  const file = join(dir, 'gh-output');
  const prev = process.env.GITHUB_OUTPUT;
  process.env.GITHUB_OUTPUT = file;
  try {
    await fn();
    return readFile(file, 'utf8');
  } finally {
    if (prev === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Scripted fetch whose policy route serves `body`; everything else is 200 on-theme. */
const policyFetch = (policyDesc) => scriptedFetch([
  [(u) => u.includes('sitemap'), { status: 200, body: '<sitemapindex></sitemapindex>' }],
  [(u) => u.includes('/policies/'), policyDesc],
  [() => true, { status: 200, serverTiming: themeTiming() }],
]);

test('isPolicyPath: prefix test, not a hardcoded single path', () => {
  assert.equal(isPolicyPath('/policies/refund-policy'), true);
  assert.equal(isPolicyPath('/policies/privacy-policy'), true);
  assert.equal(isPolicyPath('/'), false);
  assert.equal(isPolicyPath('/collections/all'), false);
  // Not a substring match: only a path that actually starts /policies/.
  assert.equal(isPolicyPath('/pages/policies/refund'), false);
  // Case-insensitive, so a hand-written override does not silently skip the check.
  assert.equal(isPolicyPath('/Policies/refund-policy'), true);
});

test('classify: markers checked after every HARD-FAIL condition, so they cannot mask one', () => {
  const missing = { ...cbase, markersMissing: ['policy-nav-component'] };
  assert.equal(classify({ ...missing, status: 404 }).verdict, HARD_FAIL);
  assert.equal(classify({ ...missing, status: 503 }).verdict, HARD_FAIL);
  assert.equal(classify({ ...missing, status: 200, themeDesc: '999' }).verdict, HARD_FAIL);
  assert.equal(classify({ ...missing, status: 200, finalHost: 'evil.example' }).verdict, HARD_FAIL);
  // Only an otherwise-clean 200 degrades to SOFT-WARN.
  const r = classify({ ...missing, status: 200 });
  assert.equal(r.verdict, SOFT_WARN);
  assert.match(r.reason, /policy-nav-component/);
});

test('classify: an unreadable body is its own SOFT-WARN reason, never a HARD-FAIL', () => {
  const r = classify({ ...cbase, status: 200, markerReadError: true });
  assert.equal(r.verdict, SOFT_WARN);
  assert.match(r.reason, /unreadable/);
  assert.doesNotMatch(r.reason, /missing markup/);
});

test('classify: empty markersMissing on a clean 200 is still PASS', () => {
  assert.equal(classify({ ...cbase, status: 200, markersMissing: [] }).verdict, PASS);
});

test('runSmoke: policy page with the jump-nav marker present -> PASS, exit 0', async () => {
  const fetchImpl = policyFetch({ status: 200, serverTiming: themeTiming(), body: POLICY_BODY_OK });
  const r = await runSmoke(baseArgs({ fetchImpl, structuralPaths: ['/', POLICY_PATH] }));
  assert.ok(r.lines.some(l => l.startsWith(`${POLICY_PATH} PASS`)), r.lines.join('\n'));
  assert.equal(r.exitCode, 0);
});

test('runSmoke: policy page missing the jump-nav marker -> SOFT-WARN, still exit 0 (rollback safety)', async () => {
  const fetchImpl = policyFetch({ status: 200, serverTiming: themeTiming(), body: POLICY_BODY_BROKEN });
  const r = await runSmoke(baseArgs({ fetchImpl, structuralPaths: ['/', POLICY_PATH] }));
  const line = r.lines.find(l => l.startsWith(POLICY_PATH));
  assert.match(line, /SOFT-WARN/);
  assert.match(line, /policy-nav-component/);
  // A rollback deploy must not be blocked by the check that exists to notice it.
  assert.equal(r.exitCode, 0);
});

test('runSmoke: policy page 404 still HARD-FAILs, marker logic swallows no existing verdict', async () => {
  const fetchImpl = policyFetch({ status: 404, body: POLICY_BODY_BROKEN });
  const r = await runSmoke(baseArgs({ fetchImpl, structuralPaths: ['/', POLICY_PATH] }));
  assert.ok(r.lines.some(l => new RegExp(`^${POLICY_PATH} HARD-FAIL 404`).test(l)));
  assert.equal(r.exitCode, 1);
});

test('runSmoke: no policy body text reaches lines, reasons or GITHUB_OUTPUT (PASS and SOFT-WARN)', async () => {
  for (const body of [POLICY_BODY_OK, POLICY_BODY_BROKEN]) {
    const fetchImpl = policyFetch({ status: 200, serverTiming: themeTiming(), body });
    let lines = [];
    const logged = [];
    const written = await withGithubOutput(async () => {
      const r = await runSmoke(baseArgs({
        fetchImpl, structuralPaths: ['/', POLICY_PATH], log: (l) => logged.push(l),
      }));
      lines = r.lines;
    });
    // The probe of this exact path ran, so the assertion is not vacuous.
    assert.ok(lines.some(l => l.startsWith(POLICY_PATH)), 'policy path was probed');
    const blob = [lines.join('\n'), logged.join('\n'), written].join('\n');
    assert.doesNotMatch(blob, new RegExp(BODY_NEEDLE));
    assert.doesNotMatch(blob, /shopify-policy__body|<nav|<main/);
    // Only the marker NAME may appear, and only in the SOFT-WARN reason.
    if (body === POLICY_BODY_OK) assert.doesNotMatch(blob, /policy-nav-component/);
  }
});

test('runSmoke: with a redirect, only the final hop body is read', async () => {
  const inner = scriptedFetch([
    [(u) => u.includes('sitemap'), { status: 200, body: '<sitemapindex></sitemapindex>' }],
    [(u) => u.endsWith(POLICY_PATH), { status: 301, location: '/policies/refund', body: POLICY_BODY_BROKEN }],
    [(u) => u.endsWith('/policies/refund'), { status: 200, url: `${BASE}/policies/refund`, serverTiming: themeTiming(), body: POLICY_BODY_OK }],
    [() => true, { status: 200, serverTiming: themeTiming() }],
  ]);
  const fetchImpl = trackBodyReads(inner);
  const r = await runSmoke(baseArgs({ fetchImpl, structuralPaths: ['/', POLICY_PATH] }));
  assert.equal(r.exitCode, 0);
  assert.ok(r.lines.some(l => l.startsWith(`${POLICY_PATH} PASS`)), r.lines.join('\n'));
  const policyReads = fetchImpl.reads.filter(u => u.includes('/policies/'));
  assert.deepEqual(policyReads, [`${BASE}/policies/refund`], 'only the final hop was read');
});

test('runSmoke: the 429 retry path reads no body, and the retried 200 does', async () => {
  const sleep = recordingSleep();
  const inner = scriptedFetch([
    [(u) => u.includes('sitemap'), { status: 200, body: '<sitemapindex></sitemapindex>' }],
    [(u) => u.includes('/policies/'), [
      { status: 429, body: POLICY_BODY_BROKEN },
      { status: 200, serverTiming: themeTiming(), body: POLICY_BODY_OK },
    ]],
    [() => true, { status: 200, serverTiming: themeTiming() }],
  ]);
  const fetchImpl = trackBodyReads(inner);
  const r = await runSmoke(baseArgs({ fetchImpl, sleep, structuralPaths: ['/', POLICY_PATH] }));
  assert.ok(r.lines.some(l => l.startsWith(`${POLICY_PATH} PASS`)), r.lines.join('\n'));
  // Exactly one body read on this path: the 200, not the 429.
  assert.equal(fetchImpl.reads.filter(u => u.includes('/policies/')).length, 1);
});

test('runSmoke: a body read that throws -> SOFT-WARN "unreadable", never HARD-FAIL, exit 0', async () => {
  const inner = policyFetch({ status: 200, serverTiming: themeTiming(), body: POLICY_BODY_OK });
  const fetchImpl = async (url, opts) => {
    const res = await inner(url, opts);
    if (url.includes('/policies/')) res.text = async () => { throw new Error('ECONNRESET'); };
    return res;
  };
  const r = await runSmoke(baseArgs({ fetchImpl, structuralPaths: ['/', POLICY_PATH] }));
  const line = r.lines.find(l => l.startsWith(POLICY_PATH));
  assert.match(line, /SOFT-WARN/);
  assert.match(line, /unreadable/);
  assert.ok(!r.lines.some(l => /HARD-FAIL/.test(l)));
  assert.equal(r.exitCode, 0);
});

test('runSmoke: non-policy structural paths are never body-read', async () => {
  const inner = scriptedFetch([
    [(u) => u.includes('sitemap'), { status: 200, body: '<sitemapindex></sitemapindex>' }],
    [() => true, { status: 200, serverTiming: themeTiming(), body: POLICY_BODY_BROKEN }],
  ]);
  const fetchImpl = trackBodyReads(inner);
  await runSmoke(baseArgs({ fetchImpl, structuralPaths: ['/', '/cart', '/search'] }));
  assert.deepEqual(fetchImpl.reads.filter(u => !u.includes('sitemap')), []);
});

test('POLICY_MARKERS matches what the theme actually server-renders on a policy page', () => {
  // Two halves, because either one alone can go stale silently. The snippet must
  // still emit the marker, AND layout/theme.liquid must still render the snippet:
  // the dead templates/policy.liquid attempt is the standing proof that a file
  // which is never invoked looks identical to one that works.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const snippet = readFileSync(join(repoRoot, 'snippets', 'policy-page.liquid'), 'utf8');
  for (const m of POLICY_MARKERS) {
    assert.ok(snippet.includes(m), `snippet no longer renders the ${m} marker`);
  }
  const layout = readFileSync(join(repoRoot, 'layout', 'theme.liquid'), 'utf8');
  assert.match(layout, /render 'policy-page'/, 'layout no longer renders the policy-page snippet');
  assert.match(layout, /request\.page_type == 'policy'/, 'the policy guard is gone from the layout');
});

// --- action.yml drift ------------------------------------------------------

test('the standalone path default matches the smoke-paths default in action.yml', () => {
  // Two copies of the structural path list exist: action.yml's input default,
  // which is what every deploy actually probes, and smoke.mjs's fallback, which
  // is what a standalone --dry-run probes. A drift between them means the
  // pre-flight check verifies a different set of routes than the gate does,
  // which is precisely the check that is supposed to de-risk the gate.
  // Parsed with a regex rather than a YAML dependency: the repo installs none,
  // and the line is a plain double-quoted scalar.
  const actionYml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'action.yml'),
    'utf8'
  );
  const block = actionYml.slice(actionYml.indexOf('  smoke-paths:'));
  const match = /^ {4}default: "([^"]*)"$/m.exec(block);
  assert.ok(match, 'could not find the smoke-paths default in action.yml');
  assert.equal(match[1], DEFAULT_SMOKE_PATHS);
});
