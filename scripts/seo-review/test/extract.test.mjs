import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('decodeEntities decodes at the top of the numeric range and rejects past it', () => {
  // The caps are inclusive. `&#1114112;` below is one past U+10FFFF.
  assert.equal(decodeEntities('&#1114111;'), String.fromCodePoint(0x10ffff));
  assert.equal(decodeEntities('&#x10FFFF;'), String.fromCodePoint(0x10ffff));
  // The hex branch reaching a supplementary character, not just the decimal one.
  assert.equal(decodeEntities('&#x1F600;'), String.fromCodePoint(0x1f600));
});

test('decodeEntities leaves unknown and malformed entities exactly as written', () => {
  // One assertion per rejection reason, so a regression names itself rather
  // than failing as one long string diff.
  assert.equal(decodeEntities('&fnord;'), '&fnord;', 'unrecognised name');
  assert.equal(decodeEntities('a & b'), 'a & b', 'bare ampersand');
  assert.equal(decodeEntities('&amp Rock'), '&amp Rock', 'unterminated entity');
  assert.equal(decodeEntities('&#1114112;'), '&#1114112;', 'one past U+10FFFF');
  assert.equal(decodeEntities('&#xD800;'), '&#xD800;', 'lone surrogate, low end');
  assert.equal(decodeEntities('&#xDFFF;'), '&#xDFFF;', 'lone surrogate, high end');
  assert.equal(decodeEntities('&#0;'), '&#0;', 'NUL');
});

test('decodeEntities holds the entity-name length cap', () => {
  // The regex caps a name at 32 characters. Both of these are unknown names and
  // must come back untouched, but for different reasons: the 32-char one
  // matches the regex and misses the table, the 33-char one never matches. The
  // test exists so a future edit to the {0,31} quantifier is caught either way.
  const name32 = 'a'.repeat(32);
  const name33 = 'a'.repeat(33);
  assert.equal(decodeEntities(`&${name32};`), `&${name32};`);
  assert.equal(decodeEntities(`&${name33};`), `&${name33};`);
});

test('decodeEntities handles back-to-back identical entities', () => {
  // A global regex advancing lastIndex wrongly would skip the second of a pair
  // with no literal text between them.
  assert.equal(decodeEntities('&amp;&amp;&amp;'), '&&&');
  assert.equal(decodeEntities('&ndash;&ndash;'), `${NDASH}${NDASH}`);
});

test('decodeEntities coerces non-string input rather than throwing', () => {
  // The String(s) coercion is deliberate, not an accident of not crashing.
  assert.equal(decodeEntities(null), 'null');
  assert.equal(decodeEntities(undefined), 'undefined');
  assert.equal(decodeEntities(42), '42');
});

test('the entity table covers every named entity the head snippet emits', () => {
  // The table is deliberately a short list rather than the full HTML5 set of
  // 2231 names, because this module has no dependencies and the only entities
  // that reach it are the ones Shopify's `escape` filter produces and the ones
  // this theme hardcodes. That reasoning holds only while the theme does not
  // hardcode a name the table lacks, which is what this pins: `&ndash;` was
  // exactly such a name, and its absence is the defect this test class exists
  // for. Add a named entity to meta-tags.liquid and this fails until the table
  // learns it, rather than waiting for a crawl to report a phantom title-long.
  const snippet = readFileSync(
    new URL('../../../snippets/meta-tags.liquid', import.meta.url), 'utf8',
  );
  const named = new Set(snippet.match(/&[a-zA-Z][a-zA-Z0-9]{0,31};/g) || []);
  assert.ok(named.size > 0, 'expected meta-tags.liquid to contain named entities');
  for (const entity of named) {
    assert.notEqual(
      decodeEntities(entity), entity,
      `${entity} is emitted by snippets/meta-tags.liquid but NAMED_ENTITIES does not decode it`,
    );
  }
});

test('entities are decoded inside attribute values, not just tag text', () => {
  // The real path for this fix: title and description are the two fields the
  // length checks read, and description arrives as an attribute value. Only
  // extractTitle reads tag text.
  const meta = '<meta name="description" content="Nurse &amp; EMS &ndash; Apparel &quot;kit&quot;">';
  assert.equal(extractMetaByName(meta, 'description'), `Nurse & EMS ${NDASH} Apparel "kit"`);

  const og = '<meta property="og:title" content="Women&rsquo;s Vest &ndash; Studio">';
  assert.equal(extractMetaByProperty(og, 'og:title'), `Women${RSQUO}s Vest ${NDASH} Studio`);

  const link = '<link rel="canonical" href="https://example.com/c?a=1&amp;b=2">';
  assert.equal(extractCanonical(link), 'https://example.com/c?a=1&b=2');
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
