import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAttrs, extractTitle, extractMetaByName, extractMetaByProperty,
  extractCanonical, countH1, extractJsonLdBlocks, jsonLdTypes,
  hasBreadcrumbNav, imgAltStats, parsePageType, parseSitemapLocs,
  parseSitemapChildren, decodeEntities,
} from '../lib/extract.mjs';

test('parseAttrs handles double, single, and bare values in any order', () => {
  assert.deepEqual(
    parseAttrs('<meta content="desc text" name=\'description\' data-x=bare>'),
    { content: 'desc text', name: 'description', 'data-x': 'bare' },
  );
});

test('extractTitle collapses whitespace and decodes entities', () => {
  assert.equal(extractTitle('<title>\n  Nurse &amp; EMS\n  Apparel </title>'), 'Nurse & EMS Apparel');
  assert.equal(extractTitle('<head></head>'), null);
});

test('extractMetaByName is attribute-order tolerant and case-insensitive', () => {
  const html = '<meta content="A store." name="Description"><meta name="robots" content="noindex">';
  assert.equal(extractMetaByName(html, 'description'), 'A store.');
  assert.equal(extractMetaByName(html, 'robots'), 'noindex');
  assert.equal(extractMetaByName(html, 'keywords'), null);
});

test('extractMetaByProperty finds og tags', () => {
  const html = '<meta property="og:image" content="http://cdn.example/img.png">';
  assert.equal(extractMetaByProperty(html, 'og:image'), 'http://cdn.example/img.png');
});

test('extractCanonical reads link rel=canonical', () => {
  const html = '<link href="https://example.com/products/x" rel="canonical">';
  assert.equal(extractCanonical(html), 'https://example.com/products/x');
  assert.equal(extractCanonical('<link rel="stylesheet" href="a.css">'), null);
});

test('countH1 counts opening tags only', () => {
  assert.equal(countH1('<h1>One</h1>'), 1);
  assert.equal(countH1('<h1 class="a">One</h1><h1>Two</h1>'), 2);
  assert.equal(countH1('<h2>None</h2>'), 0);
});

test('extractJsonLdBlocks parses valid blocks and reports types', () => {
  const html = `
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"X"}</script>
    <script type="application/ld+json">{"@graph":[{"@type":"WebSite"},{"@type":"BreadcrumbList"}]}</script>`;
  const blocks = extractJsonLdBlocks(html);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].error, null);
  assert.deepEqual(blocks[0].types, ['Organization']);
  assert.deepEqual(blocks[1].types, ['WebSite', 'BreadcrumbList']);
});

test('extractJsonLdBlocks flags the trailing-comma defect as a parse error', () => {
  // The standing hazard: a guarded-out last array entry leaves a dangling
  // comma, the browser surfaces nothing, and the whole node is dead.
  const html = '<script type="application/ld+json">{"@type":"Organization","sameAs":["https://a.example",]}</script>';
  const blocks = extractJsonLdBlocks(html);
  assert.equal(blocks.length, 1);
  assert.notEqual(blocks[0].error, null);
  assert.equal(blocks[0].parsed, null);
});

test('jsonLdTypes handles arrays and null', () => {
  assert.deepEqual(jsonLdTypes({ '@type': ['Product', 'ProductGroup'] }), ['Product', 'ProductGroup']);
  assert.deepEqual(jsonLdTypes(null), []);
});

test('hasBreadcrumbNav matches the theme breadcrumb markup only', () => {
  assert.equal(hasBreadcrumbNav('<nav class="breadcrumbs" aria-label="Breadcrumb"><ol></ol></nav>'), true);
  assert.equal(hasBreadcrumbNav('<nav class="header-nav"></nav>'), false);
});

test('imgAltStats counts images lacking any alt attribute', () => {
  const html = '<img src="a.jpg" alt="A"><img src="b.jpg" alt=""><img src="c.jpg">';
  assert.deepEqual(imgAltStats(html), { total: 3, missing: 1 });
});

test('parsePageType reads Shopify server-timing', () => {
  assert.equal(parsePageType('cfRequestDuration;dur=1, pageType;desc="product", theme;desc="123"'), 'product');
  assert.equal(parsePageType(null), null);
});

test('sitemap parsers extract locs and child sitemaps', () => {
  const xml = `<sitemapindex>
    <sitemap><loc>https://example.com/sitemap_products_1.xml?from=1</loc></sitemap>
    <sitemap><loc>https://example.com/sitemap_pages_1.xml</loc></sitemap>
  </sitemapindex>`;
  assert.deepEqual(parseSitemapChildren(xml), [
    'https://example.com/sitemap_products_1.xml?from=1',
    'https://example.com/sitemap_pages_1.xml',
  ]);
  // A loc containing whitespace is malformed and skipped, matching smoke.mjs.
  const child = '<urlset><url><loc>https://example.com/products/a</loc></url><url><loc>not a url</loc></url></urlset>';
  assert.deepEqual(parseSitemapLocs(child), ['https://example.com/products/a']);
});

test('decodeEntities covers the head-metadata set', () => {
  assert.equal(decodeEntities('A &amp; B &quot;C&#39;s&quot; &lt;tag&gt;'), 'A & B "C\'s" <tag>');
});

// Built with fromCodePoint rather than written as glyphs: this repo bans the
// literal em dash (U+2014) in every file, and naming its neighbours the same
// way keeps the set uniform and greppable.
const NDASH = String.fromCodePoint(0x2013);
const MDASH = String.fromCodePoint(0x2014);
const RSQUO = String.fromCodePoint(0x2019);
const HELLIP = String.fromCodePoint(0x2026);

test('decodeEntities decodes the typographic entities Shopify puts in titles', () => {
  // &ndash; is the separator every <title> in this theme is built with. Missing
  // it made the crawl over-count six real titles by 6 characters on 2026-09-03.
  assert.equal(decodeEntities('Nurse &ndash; Studio'), `Nurse ${NDASH} Studio`);
  assert.equal(decodeEntities('Nurse &mdash; Studio'), `Nurse ${MDASH} Studio`);
  assert.equal(decodeEntities('Women&rsquo;s Vest'), `Women${RSQUO}s Vest`);
  assert.equal(decodeEntities('More&hellip;'), `More${HELLIP}`);
  // Folded to a plain space rather than U+00A0 so it cannot split a duplicate pair.
  assert.equal(decodeEntities('Nurse&nbsp;Apparel'), 'Nurse Apparel');
});

test('decodeEntities decodes numeric entities in both bases', () => {
  assert.equal(decodeEntities('&#8211;&#x2014;&#39;&#x27;'), `${NDASH}${MDASH}''`);
  assert.equal(decodeEntities('&#128512;'), String.fromCodePoint(0x1f600));
});

test('decodeEntities leaves unknown and malformed entities exactly as written', () => {
  // An unrecognised name, a bare ampersand, an unterminated entity, an
  // out-of-range code point, and a lone surrogate all pass through untouched:
  // a decode may shorten what it understands, never mangle what it does not.
  assert.equal(
    decodeEntities('&fnord; & &amp Rock &#1114112; &#xD800;'),
    '&fnord; & &amp Rock &#1114112; &#xD800;',
  );
});

test('decodeEntities does not double-decode', () => {
  // A chained .replace() that decodes &amp; first turns this into '<b>'.
  assert.equal(decodeEntities('&amp;lt;b&amp;gt;'), '&lt;b&gt;');
});

test('extractTitle measures a real store title at its rendered length', () => {
  // Regression fixture for the phantom title-long findings: as Shopify renders
  // it this is 62 raw characters and 56 rendered ones, against a 60 target.
  const raw = '<title>\n  Applique Nurse &amp; Medic Crewneck &ndash; Sapphire Shadow Studio\n</title>';
  const title = extractTitle(raw);
  assert.equal(title, `Applique Nurse & Medic Crewneck ${NDASH} Sapphire Shadow Studio`);
  assert.equal(title.length, 56);
});
