import test from 'node:test';
import assert from 'node:assert/strict';

import { cookiesFromHeader, classifyAuditedTheme, toReportEntry, runAudit } from '../run-audit.mjs';
import { summarize } from '../summarize-pa11y.mjs';

const ORIGIN = 'https://shop.example';
const PREVIEW = '123';
const LIVE = '900000000001';

// ── cookiesFromHeader ─────────────────────────────────────────────────────────

test('cookiesFromHeader: two pairs become host-only cookies scoped by url', () => {
  assert.deepEqual(cookiesFromHeader('a=b; c=d', ORIGIN), [
    { name: 'a', value: 'b', url: ORIGIN },
    { name: 'c', value: 'd', url: ORIGIN },
  ]);
});

test('cookiesFromHeader: a trailing semicolon and empty pairs are skipped', () => {
  assert.deepEqual(cookiesFromHeader('a=b;; ;', ORIGIN), [{ name: 'a', value: 'b', url: ORIGIN }]);
});

test('cookiesFromHeader: a value containing = is split on the first = only', () => {
  assert.deepEqual(cookiesFromHeader('a==b; c=x=y==', ORIGIN), [
    { name: 'a', value: '=b', url: ORIGIN },
    { name: 'c', value: 'x=y==', url: ORIGIN },
  ]);
});

test('cookiesFromHeader: an empty header, or a pair with no name, gives nothing', () => {
  assert.deepEqual(cookiesFromHeader('', ORIGIN), []);
  assert.deepEqual(cookiesFromHeader(undefined, ORIGIN), []);
  assert.deepEqual(cookiesFromHeader('=v; novalue', ORIGIN), []);
});

test('cookiesFromHeader: no cookie is ever scoped by domain', () => {
  // A domain cookie would sit beside Shopify's host-only one of the same name.
  for (const c of cookiesFromHeader('a=b; c=d', ORIGIN)) assert.ok(!('domain' in c));
});

// ── classifyAuditedTheme ──────────────────────────────────────────────────────

test('classifyAuditedTheme: the preview theme on both witnesses passes', () => {
  const v = classifyAuditedTheme({ pageTheme: { id: 123, role: 'unpublished' }, docThemeId: '123', expectedThemeId: PREVIEW });
  assert.equal(v.ok, true);
});

test('classifyAuditedTheme: the live theme fails, naming both ids and the role', () => {
  const v = classifyAuditedTheme({ pageTheme: { id: Number(LIVE), role: 'main' }, docThemeId: LIVE, expectedThemeId: PREVIEW });
  assert.equal(v.ok, false);
  assert.equal(v.reason, `audited theme ${LIVE} (main), expected preview theme ${PREVIEW}`);
});

test('classifyAuditedTheme: the decision is on id, not role', () => {
  // A preview id with an unexpected role still passes; a live id calling itself unpublished fails.
  assert.equal(classifyAuditedTheme({ pageTheme: { id: 123, role: 'main' }, docThemeId: '123', expectedThemeId: PREVIEW }).ok, true);
  assert.equal(classifyAuditedTheme({ pageTheme: { id: LIVE, role: 'unpublished' }, docThemeId: '123', expectedThemeId: PREVIEW }).ok, false);
});

test('classifyAuditedTheme: no Shopify.theme on the page fails', () => {
  const v = classifyAuditedTheme({ pageTheme: null, docThemeId: '123', expectedThemeId: PREVIEW });
  assert.equal(v.ok, false);
  assert.match(v.reason, /no Shopify\.theme on the page/);
});

test('classifyAuditedTheme: a document served by another theme fails even when the page id matches', () => {
  const v = classifyAuditedTheme({ pageTheme: { id: 123, role: 'unpublished' }, docThemeId: LIVE, expectedThemeId: PREVIEW });
  assert.equal(v.ok, false);
  assert.match(v.reason, new RegExp(`served by theme ${LIVE}`));
});

test('classifyAuditedTheme: a missing doc id alone passes, and says so', () => {
  const v = classifyAuditedTheme({ pageTheme: { id: 123, role: 'unpublished' }, docThemeId: null, expectedThemeId: PREVIEW });
  assert.equal(v.ok, true);
  assert.match(v.reason, /no theme id in server-timing/);
});

test('classifyAuditedTheme: a page-derived role cannot inject text into the reason', () => {
  const v = classifyAuditedTheme({ pageTheme: { id: LIVE, role: 'main\n```<details>' }, docThemeId: null, expectedThemeId: PREVIEW });
  assert.equal(v.reason, `audited theme ${LIVE} (?), expected preview theme ${PREVIEW}`);
});

// ── toReportEntry ─────────────────────────────────────────────────────────────

test('toReportEntry: an ok verdict keeps pa11y issues as they are', () => {
  const issues = [{ type: 'error', code: 'x', message: 'm' }];
  assert.deepEqual(toReportEntry({ issues }, { ok: true, reason: 'fine' }), issues);
  assert.deepEqual(toReportEntry({}, { ok: true, reason: 'fine' }), []);
});

test('toReportEntry: a failed verdict discards the issues for one typeless entry', () => {
  const out = toReportEntry({ issues: [{ type: 'error', code: 'x' }] }, { ok: false, reason: 'wrong theme' });
  assert.deepEqual(out, [{ message: 'wrong theme' }]);
  assert.ok(!('type' in out[0]), 'no type is what makes the summariser count it as malformed');
});

// ── runAudit with fakes ───────────────────────────────────────────────────────

/**
 * A fake browser. Each page "loads" the theme named by `themeFor(url)`: the fake pa11y emits one
 * main-frame document response carrying that theme's server-timing, and the page's evaluate
 * returns that theme as `Shopify.theme`.
 */
function fakeWorld({ themeFor = () => ({ id: Number(PREVIEW), role: 'unpublished' }), docFor, throwFor = () => null, issuesFor = () => [] } = {}) {
  const contexts = [];
  const pa11yCalls = [];
  let browserClosed = false;

  const browser = {
    async createBrowserContext() {
      const context = { cookies: [], closed: false, pages: [] };
      context.setCookie = async (...cookies) => { context.cookies.push(...cookies); };
      context.newPage = async () => {
        const listeners = [];
        const mainFrame = { name: 'main' };
        const page = {
          url: null,
          on(event, fn) { if (event === 'response') listeners.push(fn); },
          mainFrame: () => mainFrame,
          emit(resp) { for (const fn of listeners) fn(resp); },
          async evaluate(fn) {
            // Run the real function against a fake window, so the page script is exercised too.
            const saved = globalThis.window;
            globalThis.window = { Shopify: page.theme ? { theme: page.theme } : undefined };
            try { return fn(); } finally { globalThis.window = saved; }
          },
          theme: null,
          mainFrameRef: mainFrame,
        };
        context.pages.push(page);
        return page;
      };
      context.close = async () => { context.closed = true; };
      contexts.push(context);
      return context;
    },
    async close() { browserClosed = true; },
  };

  const response = (frame, type, serverTiming) => ({
    request: () => ({ resourceType: () => type, frame: () => frame }),
    headers: () => (serverTiming ? { 'server-timing': serverTiming } : {}),
  });

  const pa11y = async (url, options) => {
    pa11yCalls.push({ url, options });
    const { page } = options;
    const thrown = throwFor(url);
    if (thrown) throw thrown;
    const theme = themeFor(url);
    page.theme = theme;
    const docId = docFor ? docFor(url) : theme?.id;
    // A subresource and a child-frame document must not count; only the main-frame document does.
    page.emit(response(page.mainFrameRef, 'document', docId ? `processing;dur=1, theme;desc=${docId}` : ''));
    page.emit(response({ name: 'child' }, 'document', `theme;desc=999`));
    page.emit(response(page.mainFrameRef, 'script', `theme;desc=998`));
    return { pageUrl: url, issues: issuesFor(url) };
  };

  return { browser, launch: async () => browser, pa11y, contexts, pa11yCalls, isBrowserClosed: () => browserClosed };
}

const CONFIG = {
  defaults: {
    standard: 'WCAG2AA',
    runners: ['axe'],
    timeout: 60000,
    chromeLaunchConfig: { args: ['--no-sandbox'] },
  },
  concurrency: 1,
  urls: [
    { url: `${ORIGIN}/?preview_theme_id=${PREVIEW}` },
    { url: `${ORIGIN}/products/x?preview_theme_id=${PREVIEW}`, ignore: ['target-size'] },
  ],
};

const run = (world, extra = {}) => {
  const lines = [];
  return runAudit({
    config: CONFIG,
    themeId: PREVIEW,
    origin: ORIGIN,
    cookieHeader: 'storefront_digest=SECRETDIGEST; preview_theme=SECRETPIN',
    pa11y: world.pa11y,
    launch: world.launch,
    log: (l) => lines.push(l),
    ...extra,
  }).then((report) => ({ report, lines }));
};

test('runAudit: a clean preview run passes every URL, and summarize() agrees', async () => {
  const world = fakeWorld();
  const { report, lines } = await run(world);
  assert.equal(report.total, 2);
  assert.equal(report.passes, 2);
  assert.equal(report.errors, 0);
  assert.deepEqual(Object.keys(report.results), CONFIG.urls.map((u) => u.url), 'keyed by configured URL, in order');
  assert.equal(summarize(report).ok, true);
  assert.equal(lines.length, 2);
  assert.match(lines[0], new RegExp(`doc theme ${PREVIEW}, page theme ${PREVIEW} \\(unpublished\\): ok`));
  assert.ok(!lines[0].includes('preview_theme_id'), 'the log shows the path without the pin');
});

test('runAudit FAIL CLOSED: a page reporting the live theme fails the summarised report', async () => {
  // The end-to-end proof: a wrong-theme page turns into a malformed entry that summarize() fails,
  // even though pa11y found no issues on it.
  const world = fakeWorld({
    themeFor: (url) => (url.includes('/products/x') ? { id: Number(LIVE), role: 'main' } : { id: Number(PREVIEW), role: 'unpublished' }),
  });
  const { report, lines } = await run(world);
  const bad = report.results[CONFIG.urls[1].url];
  assert.deepEqual(bad, [{ message: `audited theme ${LIVE} (main), expected preview theme ${PREVIEW}` }]);
  assert.equal(report.passes, 1);
  const summary = summarize(report);
  assert.equal(summary.ok, false);
  assert.equal(summary.malformed, 1);
  assert.match(lines[1], /WRONG THEME/);
});

test('runAudit: the doc theme id comes from the main-frame document only', async () => {
  // The fake emits a child-frame document (999) and a main-frame script (998) after the real
  // document; neither may overwrite the main-frame document's id.
  const world = fakeWorld();
  const { lines } = await run(world);
  assert.ok(!lines.some((l) => /99[89]/.test(l)));
});

test('runAudit: a document from the live theme fails even when the page global says preview', async () => {
  const world = fakeWorld({ docFor: () => LIVE });
  const { report } = await run(world);
  assert.equal(report.passes, 0);
  assert.equal(summarize(report).ok, false);
});

test('runAudit: a pa11y throw becomes a failing entry for that URL and the run continues', async () => {
  const world = fakeWorld({ throwFor: (url) => (url.endsWith(`/?preview_theme_id=${PREVIEW}`) ? new Error('Navigation timeout of 60000 ms exceeded') : null) });
  const { report, lines } = await run(world);
  assert.deepEqual(report.results[CONFIG.urls[0].url], [{ message: 'Navigation timeout of 60000 ms exceeded' }]);
  assert.equal(report.passes, 1);
  assert.equal(report.errors, 1);
  assert.equal(summarize(report).ok, false);
  assert.match(lines[0], /pa11y failed/);
});

test('runAudit: real pa11y errors count toward errors and keep the URL from passing', async () => {
  const world = fakeWorld({ issuesFor: () => [{ type: 'error', code: 'image-alt', message: 'm' }, { type: 'warning', code: 'color-contrast', message: 'w' }] });
  const { report } = await run(world);
  assert.equal(report.errors, 2);
  assert.equal(report.passes, 0);
  assert.equal(report.results[CONFIG.urls[0].url].length, 2, 'warnings stay in the report for the summariser');
});

test('runAudit: cookies reach setCookie scoped to the origin, and never the log', async () => {
  const world = fakeWorld();
  const { lines } = await run(world);
  for (const context of world.contexts) {
    assert.deepEqual(context.cookies, [
      { name: 'storefront_digest', value: 'SECRETDIGEST', url: ORIGIN },
      { name: 'preview_theme', value: 'SECRETPIN', url: ORIGIN },
    ]);
  }
  assert.ok(!lines.join('\n').includes('SECRET'));
});

test('runAudit: PUBLIC mode sets no cookies at all', async () => {
  const world = fakeWorld();
  await run(world, { cookieHeader: '' });
  for (const context of world.contexts) assert.deepEqual(context.cookies, []);
});

test('runAudit: no header, method or launch option reaches pa11y, so it never intercepts requests', async () => {
  const world = fakeWorld();
  const config = {
    ...CONFIG,
    defaults: { ...CONFIG.defaults, headers: { Cookie: 'x=y' }, method: 'POST', postData: 'z' },
  };
  await run(world, { config });
  for (const { options } of world.pa11yCalls) {
    for (const key of ['headers', 'method', 'postData', 'chromeLaunchConfig', 'url', 'concurrency']) {
      assert.ok(!(key in options), `${key} must not reach pa11y`);
    }
    assert.ok(!JSON.stringify(Object.keys(options)).includes('Cookie'));
  }
  // The rest of the config does reach pa11y, with the URL's own keys merged in.
  assert.equal(world.pa11yCalls[0].options.standard, 'WCAG2AA');
  assert.deepEqual(world.pa11yCalls[1].options.ignore, ['target-size']);
  assert.ok(world.pa11yCalls[0].options.browser === world.contexts[0], 'pa11y runs in the cookie-holding context');
  assert.ok(world.pa11yCalls[0].options.page === world.contexts[0].pages[0], 'and on the page the runner inspects');
});

test('runAudit: every context is closed, on success and on a throw, and the browser too', async () => {
  const world = fakeWorld({ throwFor: (url) => (url.includes('/products/') ? new Error('boom') : null) });
  await run(world);
  assert.equal(world.contexts.length, 2);
  assert.ok(world.contexts.every((c) => c.closed));
  assert.ok(world.isBrowserClosed());
});

test('runAudit: a screen capture path is set per URL only when asked for', async () => {
  const world = fakeWorld();
  await run(world, { screenCaptureDir: '/tmp/caps' });
  assert.equal(world.pa11yCalls[0].options.screenCapture, '/tmp/caps/01-index.png');
  assert.equal(world.pa11yCalls[1].options.screenCapture, '/tmp/caps/02-products-x.png');
  const plain = fakeWorld();
  await run(plain);
  assert.ok(!('screenCapture' in plain.pa11yCalls[0].options));
});

test('runAudit: a browser that will not launch throws, so no report is written', async () => {
  await assert.rejects(
    runAudit({ config: CONFIG, themeId: PREVIEW, origin: ORIGIN, pa11y: async () => ({}), launch: async () => { throw new Error('no chrome'); } }),
    /no chrome/
  );
});
