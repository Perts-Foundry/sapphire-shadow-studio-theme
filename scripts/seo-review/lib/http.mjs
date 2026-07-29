// http.mjs -- storefront fetch helpers for the SEO review.
//
// WHY node fetch, not curl: Shopify/Cloudflare bot-management blocklists curl's
// TLS/HTTP fingerprint (hard 429 on content routes); node's fetch (undici) is
// not flagged. Ported from the deploy smoke test and the diagnostics probe.
//
// SECURITY (public repo): the storefront password and cookie VALUES are never
// logged or returned to callers; only cookie names could ever be printed, and
// nothing here prints at all. Callers must keep bodies out of their logs.

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

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function newJar() { return new Map(); }

function updateJar(jar, res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1));
  }
}
const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

/**
 * Fetch a URL following redirects, with cookie jar, timeout, and 429 backoff.
 * @returns {Promise<{status:number|null, url:string, body:string, serverTiming:string|null, headers:Headers|null}>}
 */
export async function fetchPage(url, {
  jar = null, timeoutMs = 30000, backoff = [8000, 20000],
  fetchImpl = globalThis.fetch, sleepImpl = sleep, anonymous = false,
} = {}) {
  let attempt = 0;
  while (true) {
    const headers = { ...BROWSER_HEADERS };
    if (!anonymous && jar && jar.size) headers.cookie = cookieHeader(jar);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, { headers, redirect: 'follow', signal: ctl.signal });
    } catch {
      clearTimeout(timer);
      return { status: null, url, body: '', serverTiming: null, headers: null };
    } finally {
      clearTimeout(timer);
    }
    if (!anonymous && jar) updateJar(jar, res);
    if (res.status === 429 && attempt < backoff.length) {
      await sleepImpl(backoff[attempt]);
      attempt += 1;
      continue;
    }
    let body = '';
    try { body = await res.text(); } catch { /* keep headers-only result */ }
    return {
      status: res.status,
      url: res.url || url,
      body,
      serverTiming: res.headers.get('server-timing'),
      headers: res.headers,
    };
  }
}

/**
 * Authenticate past the storefront password gate. Mirrors the smoke test's
 * flow: seed the jar from GET /password, POST the form, treat a redirect AWAY
 * from /password as success.
 * @returns {Promise<'success'|'rejected'|'failed'>}
 */
export async function authenticate(baseUrl, password, {
  jar, fetchImpl = globalThis.fetch,
} = {}) {
  try {
    updateJar(jar, await fetchImpl(`${baseUrl}/password`, { headers: BROWSER_HEADERS, redirect: 'manual' }));
  } catch { /* seed is best-effort */ }
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/password`, {
      method: 'POST',
      headers: { ...BROWSER_HEADERS, cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ form_type: 'storefront_password', utf8: '✓', password }).toString(),
      redirect: 'manual',
    });
  } catch {
    return 'failed';
  }
  updateJar(jar, res);
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') || '';
    let path;
    try { path = new URL(loc, `${baseUrl}/password`).pathname; } catch { path = loc; }
    return /^\/password/.test(path) ? 'rejected' : 'success';
  }
  if (res.status === 200) return 'rejected';
  return 'failed';
}

/**
 * Is the store locked? fetchPage FOLLOWS redirects, so a locked store's root
 * resolves to /password with a 200; the final URL, not the status, is the
 * signal. A non-200 (429 wall, outage) is also treated as locked.
 */
export async function isLocked(baseUrl, opts = {}) {
  const res = await fetchPage(`${baseUrl}/`, { ...opts, anonymous: true });
  if (res.status !== 200) return true;
  try { return new URL(res.url).pathname.startsWith('/password'); } catch { return true; }
}

/** Did this response end up on the password gate rather than real content? */
export function landedOnPassword(res) {
  try { return new URL(res.url).pathname.startsWith('/password'); } catch { return false; }
}
