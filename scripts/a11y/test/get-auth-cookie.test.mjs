import test from 'node:test';
import assert from 'node:assert/strict';

import { previewUrl, classifyPreview, getAuthCookie, originOf } from '../get-auth-cookie.mjs';

const BASE = 'https://shop.example';
const THEME = '999';

/** Minimal Response stand-in with the bits the script reads. */
function res({ status = 200, headers = {}, cookies = [], url = `${BASE}/` } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    url,
    headers: {
      get: (k) => h.get(k.toLowerCase()) ?? null,
      getSetCookie: () => cookies,
    },
  };
}

const timing = (id) => ({ 'server-timing': `db;dur=1, theme;desc="${id}"` });

test('previewUrl pins the theme and preserves the path', () => {
  assert.equal(previewUrl(BASE, '1'), 'https://shop.example/?preview_theme_id=1');
  assert.equal(previewUrl(BASE, '1', '/cart'), 'https://shop.example/cart?preview_theme_id=1');
});

test('classifyPreview accepts only the expected theme on a 200 same-host', () => {
  const ok = classifyPreview({ status: 200, themeDesc: '999', expectedThemeId: '999', finalHost: 'shop.example', expectedHost: 'shop.example' });
  assert.equal(ok.ok, true);
});

test('classifyPreview REJECTS the live theme being served instead', () => {
  // The single most important case: without it a preview that never activated
  // would audit production and green the PR.
  const v = classifyPreview({ status: 200, themeDesc: '111', expectedThemeId: '999', finalHost: 'h', expectedHost: 'h' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /served theme 111, expected preview theme 999/);
});

test('classifyPreview rejects the non-200, off-host and challenge cases', () => {
  assert.equal(classifyPreview({ status: null, expectedThemeId: '9' }).ok, false);
  assert.match(classifyPreview({ status: 403, expectedThemeId: '9' }).reason, /bot management/);
  assert.match(classifyPreview({ status: 503, expectedThemeId: '9' }).reason, /bot management/);
  assert.match(classifyPreview({ status: 404, expectedThemeId: '9' }).reason, /expected 200/);
  // No server-timing at all means it is not a rendered storefront page.
  assert.match(
    classifyPreview({ status: 200, themeDesc: null, expectedThemeId: '9', finalHost: 'h', expectedHost: 'h' }).reason,
    /not a rendered storefront page/
  );
});

test('LOCKED: full password flow yields a cookie pinned to the preview theme', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push(`${opts.method || 'GET'} ${url}`);
    if (url.endsWith('/password') && opts.method === 'POST') {
      return res({ status: 302, headers: { location: '/' }, cookies: ['storefront_digest=abc; Path=/'] });
    }
    if (url.endsWith('/password')) return res({ status: 200, cookies: ['_secure_session_id=s1; Path=/'] });
    if (url.includes('preview_theme_id')) {
      return res({ status: 200, headers: timing(THEME), cookies: ['preview_theme=999; Path=/'] });
    }
    // Bare root while locked: bounced to the password wall.
    return res({ status: 302, headers: { location: '/password' } });
  };

  const out = await getAuthCookie({ baseUrl: BASE, themeId: THEME, password: 'hunter2', fetchImpl });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.mode, 'LOCKED');
  assert.match(out.cookie, /storefront_digest=abc/);
  assert.match(out.cookie, /preview_theme=999/);
  assert.ok(calls.some((c) => c.startsWith('POST')), 'the password must actually be posted');
});

test('PUBLIC: no password needed, still pins and asserts the preview theme', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('preview_theme_id')) {
      return res({ status: 200, headers: timing(THEME), cookies: ['preview_theme=999; Path=/'] });
    }
    return res({ status: 200, headers: timing('111') }); // public root, live theme
  };
  const out = await getAuthCookie({ baseUrl: BASE, themeId: THEME, password: '', fetchImpl });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.mode, 'PUBLIC');
  assert.match(out.cookie, /preview_theme=999/);
});

test('LOCKED with no password is a hard failure, not a quiet public fallback', async () => {
  const fetchImpl = async () => res({ status: 302, headers: { location: '/password' } });
  const out = await getAuthCookie({ baseUrl: BASE, themeId: THEME, password: '', fetchImpl });
  assert.equal(out.ok, false);
  assert.match(out.reason, /password-locked but STOREFRONT_PASSWORD is empty/);
});

test('a refused password fails rather than auditing the password page', async () => {
  const fetchImpl = async (url, opts = {}) => {
    if (url.endsWith('/password') && opts.method === 'POST') return res({ status: 200 });
    if (url.endsWith('/password')) return res({ status: 200 });
    return res({ status: 302, headers: { location: '/password' } });
  };
  const out = await getAuthCookie({ baseUrl: BASE, themeId: THEME, password: 'wrong', fetchImpl });
  assert.equal(out.ok, false);
  assert.match(out.reason, /rejected/);
  assert.equal(out.cookie, '');
});

test('a bounce back to /password after POST is also a rejection', async () => {
  const fetchImpl = async (url, opts = {}) => {
    if (url.endsWith('/password') && opts.method === 'POST') {
      return res({ status: 302, headers: { location: '/password' } });
    }
    if (url.endsWith('/password')) return res({ status: 200 });
    return res({ status: 302, headers: { location: '/password' } });
  };
  const out = await getAuthCookie({ baseUrl: BASE, themeId: THEME, password: 'wrong', fetchImpl });
  assert.equal(out.ok, false);
  assert.match(out.reason, /rejected/);
});

test('a throttled POST is retried before being given up on', async () => {
  let posts = 0;
  const fetchImpl = async (url, opts = {}) => {
    if (url.endsWith('/password') && opts.method === 'POST') {
      posts += 1;
      if (posts === 1) return res({ status: 429 });
      return res({ status: 302, headers: { location: '/' }, cookies: ['d=1'] });
    }
    if (url.endsWith('/password')) return res({ status: 200 });
    if (url.includes('preview_theme_id')) return res({ status: 200, headers: timing(THEME) });
    return res({ status: 302, headers: { location: '/password' } });
  };
  const out = await getAuthCookie({
    baseUrl: BASE, themeId: THEME, password: 'p', fetchImpl, sleepImpl: async () => {},
  });
  assert.equal(posts, 2);
  assert.equal(out.ok, true, out.reason);
});

test('authenticating but landing on the LIVE theme is a failure', async () => {
  // Auth succeeded, the pin did not take. This is the exact silent-fallback
  // scenario the whole script exists to detect.
  const fetchImpl = async (url, opts = {}) => {
    if (url.endsWith('/password') && opts.method === 'POST') return res({ status: 302, headers: { location: '/' }, cookies: ['d=1'] });
    if (url.endsWith('/password')) return res({ status: 200 });
    if (url.includes('preview_theme_id')) return res({ status: 200, headers: timing('111') });
    return res({ status: 302, headers: { location: '/password' } });
  };
  const out = await getAuthCookie({ baseUrl: BASE, themeId: THEME, password: 'p', fetchImpl });
  assert.equal(out.ok, false);
  assert.match(out.reason, /served theme 111/);
  assert.equal(out.cookie, '', 'no cookie may be emitted on a failed assertion');
});

test('a network failure on the preview probe fails closed', async () => {
  const fetchImpl = async (url, opts = {}) => {
    if (url.endsWith('/password') && opts.method === 'POST') return res({ status: 302, headers: { location: '/' } });
    if (url.endsWith('/password')) return res({ status: 200 });
    if (url.includes('preview_theme_id')) throw new Error('ECONNRESET');
    return res({ status: 302, headers: { location: '/password' } });
  };
  const out = await getAuthCookie({ baseUrl: BASE, themeId: THEME, password: 'p', fetchImpl });
  assert.equal(out.ok, false);
  assert.match(out.reason, /connection failure/);
});

test('a canonical-host redirect is ACCEPTED when the theme id still matches', () => {
  // Verified against the live store on 2026-08-16: *.myshopify.com 302s to the
  // primary custom domain, and the preview theme is served correctly on the far
  // side. Rejecting that made the script fail against the very BASE_URL the
  // workflow passes. The theme id is the identity proof, not the host.
  const v = classifyPreview({
    status: 200, themeDesc: '9', expectedThemeId: '9',
    finalHost: 'shop.custom.example', expectedHost: 'shop.myshopify.example',
  });
  assert.equal(v.ok, true);
  assert.equal(v.redirected, true);
  assert.match(v.reason, /canonical host shop\.custom\.example/);
});

test('a redirect to a host serving the WRONG theme is still rejected', () => {
  const v = classifyPreview({
    status: 200, themeDesc: '111', expectedThemeId: '9',
    finalHost: 'elsewhere.example', expectedHost: 'shop.example',
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /served theme 111/);
});

test('a redirect to a host that is not a storefront at all is rejected', () => {
  // No server-timing theme id: an interstitial, or a genuinely foreign host.
  const v = classifyPreview({
    status: 200, themeDesc: null, expectedThemeId: '9',
    finalHost: 'attacker.example', expectedHost: 'shop.example',
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /not a rendered storefront page/);
});

test('getAuthCookie reports the canonical origin it resolved to', async () => {
  const canonical = 'https://custom.example';
  const fetchImpl = async (url, opts = {}) => {
    if (url.endsWith('/password') && opts.method === 'POST') {
      return res({ status: 302, headers: { location: '/' }, cookies: ['d=1'] });
    }
    if (url.endsWith('/password')) return res({ status: 200 });
    if (url.includes('preview_theme_id')) {
      return res({ status: 200, headers: timing(THEME), url: `${canonical}/?preview_theme_id=${THEME}` });
    }
    return res({ status: 302, headers: { location: '/password' } });
  };
  const out = await getAuthCookie({ baseUrl: BASE, themeId: THEME, password: 'p', fetchImpl });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.canonicalBaseUrl, canonical);
});

test('canonicalBaseUrl falls back to the input when no redirect happened', async () => {
  const fetchImpl = async (url, opts = {}) => {
    if (url.endsWith('/password') && opts.method === 'POST') {
      return res({ status: 302, headers: { location: '/' }, cookies: ['d=1'] });
    }
    if (url.endsWith('/password')) return res({ status: 200 });
    if (url.includes('preview_theme_id')) {
      return res({ status: 200, headers: timing(THEME), url: `${BASE}/?preview_theme_id=${THEME}` });
    }
    return res({ status: 302, headers: { location: '/password' } });
  };
  const out = await getAuthCookie({ baseUrl: BASE, themeId: THEME, password: 'p', fetchImpl });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.canonicalBaseUrl, BASE);
});

test('originOf extracts an origin and tolerates junk', () => {
  assert.equal(originOf('https://a.example/x?y=1'), 'https://a.example');
  assert.equal(originOf('not a url'), null);
});

/** The password flow, up to but not including the preview probe. */
function authedFetch(previewHandler) {
  return async (url, opts = {}) => {
    if (url.endsWith('/password') && opts.method === 'POST') {
      return res({ status: 302, headers: { location: '/' }, cookies: ['d=1'] });
    }
    if (url.endsWith('/password')) return res({ status: 200 });
    if (url.includes('preview_theme_id')) return previewHandler();
    return res({ status: 302, headers: { location: '/password' } });
  };
}

test('a throttled preview probe is retried rather than read as a challenge', async () => {
  // The storefront is behind Cloudflare bot management, so a 429 on the probe
  // is a realistic way to lose a run. classifyPreview treats a surviving 429 as
  // a failure, so this retry is what keeps a transient throttle from failing
  // the audit job.
  const slept = [];
  let probes = 0;
  const fetchImpl = authedFetch(() => {
    probes += 1;
    if (probes === 1) return res({ status: 429 });
    return res({ status: 200, headers: timing(THEME), cookies: ['preview_theme=999'] });
  });
  const out = await getAuthCookie({
    baseUrl: BASE, themeId: THEME, password: 'p', fetchImpl,
    backoff: [1, 2], sleepImpl: async (ms) => { slept.push(ms); },
  });
  assert.equal(probes, 2);
  assert.deepEqual(slept, [1]);
  assert.equal(out.ok, true, out.reason);
});

test('a 5xx preview probe is retried, and one that survives still fails closed', async () => {
  let probes = 0;
  const fetchImpl = authedFetch(() => { probes += 1; return res({ status: 503 }); });
  const out = await getAuthCookie({
    baseUrl: BASE, themeId: THEME, password: 'p', fetchImpl,
    backoff: [1, 2], sleepImpl: async () => {},
  });
  assert.equal(probes, 3, 'one attempt per backoff entry, then give up');
  assert.equal(out.ok, false);
  assert.match(out.reason, /bot management/);
  assert.equal(out.cookie, '');
});

test('a connection failure on the probe is NOT retried; it fails closed at once', async () => {
  let probes = 0;
  const fetchImpl = authedFetch(() => { probes += 1; throw new Error('ECONNRESET'); });
  const out = await getAuthCookie({
    baseUrl: BASE, themeId: THEME, password: 'p', fetchImpl,
    backoff: [1, 2], sleepImpl: async () => {},
  });
  assert.equal(probes, 1);
  assert.equal(out.ok, false);
  assert.match(out.reason, /connection failure/);
});

test('a 5xx on the password POST reports error, matching smoke.mjs', async () => {
  // The outcome strings come from smoke.mjs's authenticateStorefront now, so a
  // transient 5xx reads as 'error' where this file used to say 'throttled'.
  // Either way it fails: unlike smoke.mjs there is no reduced-coverage
  // fallback to drop to, since pa11y would just audit the password page.
  let posts = 0;
  const fetchImpl = async (url, opts = {}) => {
    if (url.endsWith('/password') && opts.method === 'POST') { posts += 1; return res({ status: 503 }); }
    if (url.endsWith('/password')) return res({ status: 200 });
    return res({ status: 302, headers: { location: '/password' } });
  };
  const out = await getAuthCookie({
    baseUrl: BASE, themeId: THEME, password: 'p', fetchImpl,
    backoff: [1], sleepImpl: async () => {},
  });
  assert.equal(posts, 2, 'retried once before giving up');
  assert.equal(out.ok, false);
  assert.match(out.reason, /storefront password error/);
});
