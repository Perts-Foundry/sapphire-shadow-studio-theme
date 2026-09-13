import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveSitemapUrls, probeRedirect } from '../lib/sitemap.mjs';
import { readText } from './harness.mjs';

const BASE = 'https://shop.example.test';
const INDEX = `${BASE}/sitemap.xml`;
const PRODUCTS = `${BASE}/sitemap_products_1.xml?from=1&to=99`;
const PAGES = `${BASE}/sitemap_pages_1.xml`;

/** A fetch stub from a url -> response map. An Error value is thrown; a function is called. */
function routes(map) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const r = map[url];
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r(url, init);
    if (!r) return { status: 404, url, headers: new Headers(), text: async () => 'not found' };
    return { status: r.status ?? 200, url: r.url ?? url, headers: new Headers(r.headers ?? {}), text: async () => r.body ?? '' };
  };
  impl.calls = calls;
  return impl;
}

const healthy = () => ({
  [INDEX]: { body: readText('sitemap-index.xml') },
  [PRODUCTS]: { body: readText('sitemap-products-1.xml') },
  [PAGES]: { body: readText('sitemap-pages-1.xml') },
});

test('index plus children: 17 distinct URLs, image locs excluded, &amp; decoded', async () => {
  const fetchImpl = routes(healthy());
  const out = await liveSitemapUrls(BASE, { fetchImpl, backoff: [] });
  assert.equal(out.partial, false);
  assert.equal(out.urls.length, 17);
  assert.ok(!out.urls.some((u) => u.includes('cdn.example.test')));
  assert.ok(fetchImpl.calls.some((c) => c.url === PRODUCTS), 'the child URL was fetched with its query decoded');
});

test('a trailing slash on the base is tolerated', async () => {
  const out = await liveSitemapUrls(`${BASE}/`, { fetchImpl: routes(healthy()), backoff: [] });
  assert.equal(out.urls.length, 17);
});

test('a fetch rejection on the index is null', async () => {
  const out = await liveSitemapUrls(BASE, { fetchImpl: routes({ [INDEX]: new Error('ECONNRESET') }), backoff: [] });
  assert.equal(out, null);
});

test('a non-200 index is null, including a 429 with no retries left', async () => {
  assert.equal(await liveSitemapUrls(BASE, { fetchImpl: routes({ [INDEX]: { status: 500, body: '<sitemapindex></sitemapindex>' } }), backoff: [] }), null);
  assert.equal(await liveSitemapUrls(BASE, { fetchImpl: routes({ [INDEX]: { status: 429, body: '' } }), backoff: [] }), null);
});

test('a non-XML index is null', async () => {
  const out = await liveSitemapUrls(BASE, { fetchImpl: routes({ [INDEX]: { body: '<!doctype html><html><body>password</body></html>' } }), backoff: [] });
  assert.equal(out, null);
});

test('one child failing is partial, with the other child still collected', async () => {
  const map = healthy();
  delete map[PRODUCTS];
  const out = await liveSitemapUrls(BASE, { fetchImpl: routes(map), backoff: [] });
  assert.equal(out.partial, true);
  assert.equal(out.urls.length, 7);
});

test('a timeout is a failure, not a hang', async () => {
  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const started = Date.now();
  const out = await liveSitemapUrls(BASE, { fetchImpl: routes({ [INDEX]: hang }), timeoutMs: 20, backoff: [] });
  assert.equal(out, null);
  assert.ok(Date.now() - started < 5000);
});

test('a redirect to another host is not trusted', async () => {
  const index = await liveSitemapUrls(BASE, {
    fetchImpl: routes({ [INDEX]: { url: 'https://elsewhere.example/sitemap.xml', body: readText('sitemap-index.xml') } }),
    backoff: [],
  });
  assert.equal(index, null);

  const map = healthy();
  map[PAGES] = { url: 'https://elsewhere.example/sitemap_pages_1.xml', body: readText('sitemap-pages-1.xml') };
  const child = await liveSitemapUrls(BASE, { fetchImpl: routes(map), backoff: [] });
  assert.equal(child.partial, true);
  assert.equal(child.urls.length, 10);
});

test('an index that is itself a urlset is read directly', async () => {
  const out = await liveSitemapUrls(BASE, { fetchImpl: routes({ [INDEX]: { body: readText('sitemap-pages-1.xml') } }), backoff: [] });
  assert.deepEqual(out, { urls: out.urls, partial: false });
  assert.equal(out.urls.length, 7);
});

test('requests are anonymous browser-shaped GETs', async () => {
  const fetchImpl = routes(healthy());
  await liveSitemapUrls(BASE, { fetchImpl, backoff: [] });
  for (const c of fetchImpl.calls) {
    assert.ok(!('cookie' in c.init.headers));
    assert.match(c.init.headers['user-agent'], /Mozilla/);
  }
});

test('probeRedirect: 301, 200 and a failure', async () => {
  const fetch301 = routes({ 'https://brand-alias.example/': { status: 301, headers: { location: 'https://shop.example.test/' } } });
  assert.deepEqual(await probeRedirect('brand-alias.example', { fetchImpl: fetch301 }), { status: 301, location: 'https://shop.example.test/' });
  assert.equal(fetch301.calls[0].init.redirect, 'manual');

  const fetch200 = routes({ 'https://brand-alias.example/': { status: 200, body: 'hello' } });
  assert.deepEqual(await probeRedirect('brand-alias.example', { fetchImpl: fetch200 }), { status: 200, location: null });

  const failing = routes({ 'https://brand-alias.example/': new Error('ENOTFOUND') });
  assert.equal(await probeRedirect('brand-alias.example', { fetchImpl: failing }), null);
});

test('a child sitemap on another host is never fetched and marks the read partial', async () => {
  const map = healthy();
  const index = readText('sitemap-index.xml').replace(PAGES, 'https://elsewhere.example/sitemap_pages_1.xml');
  assert.ok(index.includes('elsewhere.example'));
  map[INDEX] = { body: index };
  const fetchImpl = routes(map);
  const out = await liveSitemapUrls(BASE, { fetchImpl, backoff: [] });
  assert.equal(out.partial, true);
  assert.equal(out.urls.length, 10);
  assert.ok(!fetchImpl.calls.some((c) => c.url.includes('elsewhere.example')));
});
