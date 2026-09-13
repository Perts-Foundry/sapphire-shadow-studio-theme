// The strict markup reader and the allowlist, against the payloads that beat the version it replaced.
//
// WHY A TABLE OF REAL PAYLOADS. Each row below is a known way to make a lenient reader and a browser
// disagree, or a known spelling of a dangerous URL that a string comparison misses. The rule is not
// "refuses something": each row names the EXACT set of safety rules it must produce, so a row that
// starts passing for the wrong reason (a malformed refusal where an allowlist refusal was meant)
// fails here instead of hiding the gap it was written to cover.
//
// The positive controls matter as much. A reader that refused every body would pass the whole
// refusal table, and would also refuse every real article.

import test from 'node:test';
import assert from 'node:assert/strict';

import { RULES, hrefsOf, imagesOf, safetyFindings } from '../lib/articles.mjs';
import { ALLOWED_ELEMENTS, NESTED_TABLE_REFUSED, readMarkup } from '../lib/body-markup.mjs';

/** The safety rule ids a body produces, deduplicated and sorted. */
function safetyRules(body) {
  return [...new Set(safetyFindings(body, 'h').map((f) => f.rule).filter((r) => r.startsWith('safety/') || r === RULES.EXTERNAL_NOT_HTTPS))].sort();
}

const TAB = String.fromCharCode(9);

const { MALFORMED_MARKUP: MALFORMED, FORBIDDEN_ELEMENT: ELEMENT, FORBIDDEN_ATTRIBUTE: ATTRIBUTE, EVENT_HANDLER: HANDLER, DANGEROUS_URL: URL_, DUPLICATE_ATTRIBUTE: DUPLICATE } = RULES;

/** `[payload, expected safety rules]`. */
const REFUSED = [
  // Character references and whitespace inside a scheme, which a browser decodes and a prefix test does not.
  ['<a href="jav&#x61;script:alert(1)">x</a>', [URL_]],
  ['<a href="&#106;avascript:x">x</a>', [URL_]],
  ['<a href="javascript&colon;x">x</a>', [URL_]],
  ['<a href="java&Tab;script:x">x</a>', [URL_]],
  [`<a href="java${TAB}script:x">x</a>`, [URL_]],
  // Two readers, two picks: every value is checked, and the duplicate is its own finding.
  ['<a href="javascript:alert(1)" href="https://example.com/">x</a>', [DUPLICATE, URL_].sort()],
  // Comment-parsing disagreements.
  ['<!--><img src=x onerror=alert(1)>-->', [MALFORMED]],
  ['<!-- a --!><img src=x onerror=alert(1)> -->', [MALFORMED]],
  ['<textarea><!--</textarea><img src=x onerror=alert(1)>--></textarea>', [MALFORMED]],
  ['<xmp><p x="</xmp><img src=x onerror=alert(1)>"></p></xmp>', [MALFORMED]],
  ['<p title=a"><img src=x onerror=alert(1)>', [MALFORMED]],
  // Raw-text and document-level elements a blocklist forgot.
  ['<title>x</title>', [ELEMENT]],
  ['<noembed>x</noembed>', [ELEMENT]],
  ['<noframes>x</noframes>', [ELEMENT]],
  ['<plaintext>x', [ELEMENT]],
  ['<base href="https://attacker.example/">', [ELEMENT]],
  ['<meta http-equiv="refresh" content="0;url=https://attacker.example/">', [ELEMENT]],
  ['<link rel="stylesheet" href="https://x/">', [ELEMENT]],
  ['<frame>', [ELEMENT]],
  ['<math>x</math>', [ELEMENT]],
  ['<svg></svg>', [ELEMENT]],
  ['<script>alert(1)</script>', [ELEMENT]],
  ['<style>p{}</style>', [ELEMENT]],
  ['<iframe></iframe>', [ELEMENT]],
  ['<form></form>', [ELEMENT]],
  // Not yet proven against Shopify's normaliser; see ALLOWED_ELEMENTS.
  ['<pre>  spaced</pre>', [ELEMENT]],
  ['<table><tr><td><table><tr><td>x</td></tr></table></td></tr></table>', [ELEMENT]],
  // URLs outside the prefix allowlist.
  ['<a href="data:text/html,x">x</a>', [URL_]],
  ['<a href="vbscript:x">x</a>', [URL_]],
  ['<a href="//evil.example/">x</a>', [URL_]],
  ['<a href="/\\evil.example">x</a>', [URL_]],
  ['<a href="tel:5558675309">x</a>', [URL_]],
  ['<a href="products/x">x</a>', [URL_]],
  ['<a href="https://cdn.example/a?x=1&b=2">x</a>', [URL_]],
  // Attributes outside the allowlist.
  ['<img srcset="x">', [ATTRIBUTE]],
  ['<p style="x">x</p>', [ATTRIBUTE]],
  ['<div OnClick="x">x</div>', [HANDLER]],
  ['<a formaction="javascript:x">x</a>', [ATTRIBUTE]],
];

for (const [payload, expected] of REFUSED) {
  test(`refused: ${JSON.stringify(payload)}`, () => {
    assert.deepEqual(safetyRules(payload), expected);
  });
}

test('a nested table is refused with the reason, not as an unknown element', () => {
  const findings = safetyFindings('<table><tr><td><table></table></td></tr></table>', 'h');
  assert.deepEqual(findings.map((f) => f.detail), [NESTED_TABLE_REFUSED]);
});

test('a refused element names the allowlist, and a malformed body names the offset', () => {
  assert.match(safetyFindings('<title>x</title>', 'h')[0].detail, /not in the allowlist/);
  assert.match(safetyFindings('<p>ok</p><!-- x -->', 'h')[0].detail, /offset 9/);
});

/** Bodies that must produce NO safety finding. */
const ACCEPTED = [
  '<p><a href="https://example.com/a?b=1&amp;c=2">x</a></p>',
  '<p><a href="/policies/shipping-policy">x</a></p>',
  '<p><a href="#top">x</a></p>',
  '<p><a href="mailto:hello@example.com">x</a></p>',
  '<img src="https://cdn.shopify.com/s/files/1/x.jpg?v=1726012345" alt="a" width="800" height="600" loading="lazy">',
  '<ul>\n  <li>One\n    <ol>\n      <li>Nested</li>\n    </ol>\n  </li>\n</ul>',
  '<table>\n<caption>Sizes</caption>\n<thead><tr><th scope="col">Size</th><th colspan="2">Chest</th></tr></thead>\n<tbody><tr><td>M</td><td>40</td><td>42</td></tr></tbody>\n</table>',
  '<table><tr><td>one</td></tr></table>\n<table><tr><td>two, after the first closed</td></tr></table>',
  '<figure><img src="https://cdn.shopify.com/a.jpg" alt="a"><figcaption>A <em>caption</em></figcaption></figure>',
  '<p>A <code>&lt;tag&gt;</code>, a line<br>break, <br/> and <br /> a rule.</p><hr>',
  '<P CLASS="lead" Id=\'x\'>Upper-case names are lowercased, single quotes are fine</P>',
  '<p>Text may hold a bare > and an &amp; entity.</p>',
];

for (const body of ACCEPTED) {
  test(`accepted: ${JSON.stringify(body.slice(0, 70))}`, () => {
    assert.deepEqual(safetyRules(body), []);
  });
}

test('an accepted href and src reach the link and image rules decoded', () => {
  assert.deepEqual(hrefsOf('<a href="https://example.com/a?b=1&amp;c=2">x</a>'), ['https://example.com/a?b=1&c=2']);
  assert.deepEqual(imagesOf('<img src="https://cdn.shopify.com/a.jpg?v=1&amp;w=2" alt="a">'), [
    { src: 'https://cdn.shopify.com/a.jpg?v=1&w=2', alt: 'a' },
  ]);
});

test('a refused href never reaches the link rules, and a refused src reaches the image rules as null', () => {
  assert.deepEqual(hrefsOf('<a href="javascript:x">x</a>'), []);
  assert.deepEqual(imagesOf('<img src="//evil.example/a.jpg" alt="a">'), [{ src: null, alt: 'a' }]);
});

test('a malformed body yields no elements to any element rule', () => {
  const body = '<p><a href="/nowhere">x</a></p><!-- x -->';
  assert.equal(readMarkup(body).error === null, false);
  assert.deepEqual(hrefsOf(body), []);
});

test('the reader stops at the first error, so nothing past it is reported as an element', () => {
  const { elements, error } = readMarkup('<p>a</p><!-- x --><script></script>');
  assert.deepEqual(elements.map((e) => e.tag), ['p']);
  assert.ok(error);
});

test('h1 is readable, so the prose rule rather than the safety rule owns it', () => {
  assert.ok(ALLOWED_ELEMENTS.includes('h1'));
  assert.deepEqual(safetyRules('<h1>x</h1>'), []);
});

test('the allowlist is exactly the set this subsystem has reviewed', () => {
  // Pinned, so adding an element is a visible change to this test and not a one-word edit in a list.
  assert.deepEqual([...ALLOWED_ELEMENTS].sort(), [
    'a', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'div', 'em', 'figcaption', 'figure',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'q', 's', 'small', 'span',
    'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
  ]);
});
