// The pure layer: canonicalise, hashing, entity decoding, heading extraction, the slugify that
// mirrors assets/policy-nav.js, the list contracts, and manifest diffing.
//
// Fixtures here are SYNTHETIC and small, one per property. The real bodies are read in place from
// marketing/policies/ by real-bodies.test.mjs and only for properties, never pinned content: a
// 23 KB duplicate under test/fixtures/ rots silently and turns every wording edit red.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DIFFED_FIELDS,
  EM_DASH_FORMS,
  NOT_WRITABLE_REASON,
  POLICY_TYPES,
  PolicyError,
  STOREFRONT_HANDLES,
  WRITABLE,
  bodyFromFileText,
  buildEntry,
  canonicalise,
  decodeEntities,
  diffEntry,
  diffHeadings,
  duplicateHeadingIds,
  extractHeadings,
  fileNameForType,
  fileTextFor,
  formatManifest,
  hasEmDash,
  hygieneProblems,
  keyForType,
  lengthOf,
  remoteToken,
  sha256,
  slugify,
  typeForFileName,
  typeForKey,
} from '../lib/policies.mjs';

const NOW = '2026-01-02T03:04:05.000Z';

// ---------------------------------------------------------------------------------------------
// sha256: a known-answer vector plus encoding coverage
// ---------------------------------------------------------------------------------------------

test('sha256 matches the published empty-string vector', () => {
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('sha256 hashes UTF-8 bytes, so an en dash and a BOM change the digest', () => {
  // The real bug class is *what* gets hashed, not the digest algorithm. An en dash is two bytes in
  // UTF-8 and one UTF-16 code unit, so a length-based comparison and a hash disagree about it.
  const plain = 'a-b';
  const enDash = 'a–b';
  assert.notEqual(sha256(plain), sha256(enDash));
  assert.equal(enDash.length, 3);
  assert.equal(Buffer.byteLength(enDash, 'utf8'), 5);
  assert.notEqual(sha256('x'), sha256('\ufeffx'));
});

// ---------------------------------------------------------------------------------------------
// canonicalise and the file round trip
// ---------------------------------------------------------------------------------------------

test('canonicalise strips a BOM, normalises CRLF and lone CR, and trims the document end', () => {
  assert.equal(canonicalise('\ufeff<p>a</p>'), '<p>a</p>');
  assert.equal(canonicalise('<p>a</p>\r\n<p>b</p>'), '<p>a</p>\n<p>b</p>');
  assert.equal(canonicalise('<p>a</p>\r<p>b</p>'), '<p>a</p>\n<p>b</p>');
  assert.equal(canonicalise('<p>a</p>\n\n  \n'), '<p>a</p>');
});

test('canonicalise leaves per-line trailing whitespace alone', () => {
  // A space before a newline is significant between inline elements. Tidying it would change what
  // the storefront renders, which is exactly what this tool must never do on its own.
  assert.equal(canonicalise('<em>a</em> \n<em>b</em>'), '<em>a</em> \n<em>b</em>');
});

test('canonicalise is idempotent', () => {
  const messy = '\ufeff<p>a</p>\r\n<p>b</p> \r\n\n';
  assert.equal(canonicalise(canonicalise(messy)), canonicalise(messy));
});

test('the file round trip recovers the canonical body exactly', () => {
  for (const body of ['<p>a</p>', '<p>a</p>\n<p>b</p>', '<h2>T–t</h2>']) {
    assert.equal(bodyFromFileText(fileTextFor(body)), body);
    assert.equal(fileTextFor(body).endsWith('\n'), true);
    assert.equal(fileTextFor(body).endsWith('\n\n'), false);
  }
});

test('lengthOf counts UTF-16 code units of the canonical body', () => {
  assert.equal(lengthOf('a–b\n'), 3);
});

// ---------------------------------------------------------------------------------------------
// decodeEntities
// ---------------------------------------------------------------------------------------------

test('decodeEntities handles named, decimal and hex forms in one pass', () => {
  assert.equal(decodeEntities('Production &amp; Delivery'), 'Production & Delivery');
  assert.equal(decodeEntities('&#8211;'), '–');
  assert.equal(decodeEntities('&#x2014;'), '\u2014');
  assert.equal(decodeEntities('&nbsp;'), ' ');
});

test('decodeEntities does not double-decode', () => {
  // One pass, so `&amp;lt;` yields the four characters `&lt;` and not `<`.
  assert.equal(decodeEntities('&amp;lt;'), '&lt;');
});

test('decodeEntities leaves an unknown entity alone', () => {
  assert.equal(decodeEntities('&notarealentity;'), '&notarealentity;');
  assert.equal(decodeEntities('&#999999999;'), '&#999999999;');
});

// ---------------------------------------------------------------------------------------------
// slugify and extractHeadings
// ---------------------------------------------------------------------------------------------

test('slugify mirrors assets/policy-nav.js', () => {
  assert.equal(slugify('Production & Delivery Times'), 'production-delivery-times');
  assert.equal(slugify('  Rush Orders  '), 'rush-orders');
  assert.equal(slugify('Questions?'), 'questions');
  assert.equal(slugify('Café Crème'), 'cafe-creme');
  assert.equal(slugify('!!!'), '');
  assert.equal(slugify('A'.repeat(80)).length, 50);
});

test('extractHeadings reads nested markup, entities and attributes', () => {
  const html = [
    '<h2 class="x" data-y="1">Production &amp; <em>Delivery</em> Times</h2>',
    '<H3>Total Estimated Delivery</H3>',
    '<p>body</p>',
  ].join('\n');
  assert.deepEqual(extractHeadings(html), [
    { level: 2, text: 'Production & Delivery Times', id: 'production-delivery-times' },
    { level: 3, text: 'Total Estimated Delivery', id: null },
  ]);
});

test('extractHeadings trims and skips whitespace-only headings', () => {
  assert.deepEqual(extractHeadings('<h2>  Spaced  </h2>'), [{ level: 2, text: 'Spaced', id: 'spaced' }]);
  assert.deepEqual(extractHeadings('<h2>   </h2><h2>&nbsp;</h2>').filter((h) => h.text !== ' '), []);
});

test('extractHeadings returns an empty array for a heading-free body', () => {
  // Two of the five tracked policies (terms of service, contact information) genuinely have none.
  assert.deepEqual(extractHeadings('<p>no headings at all</p>'), []);
  assert.deepEqual(extractHeadings(''), []);
});

test('extractHeadings ignores h1 and h4, which policy-nav.js never touches', () => {
  assert.deepEqual(extractHeadings('<h1>One</h1><h4>Four</h4>'), []);
});

test('an h3 gets no id, because the runtime assigns ids to h2 only', () => {
  const [h2, h3] = extractHeadings('<h2>Same Text</h2><h3>Same Text</h3>');
  assert.equal(h2.id, 'same-text');
  assert.equal(h3.id, null);
  assert.deepEqual(duplicateHeadingIds([h2, h3]), []);
});

test('duplicateHeadingIds catches two h2s that slugify alike', () => {
  const headings = extractHeadings('<h2>Rush Orders</h2><h2>Rush  Orders!</h2>');
  assert.deepEqual(duplicateHeadingIds(headings), ['rush-orders']);
});

test('a heading that slugifies to nothing falls back to "section", as the runtime does', () => {
  assert.deepEqual(extractHeadings('<h2>!!!</h2>'), [{ level: 2, text: '!!!', id: 'section' }]);
});

// ---------------------------------------------------------------------------------------------
// Hygiene
// ---------------------------------------------------------------------------------------------

test('hygiene passes a clean body and an en dash', () => {
  assert.deepEqual(hygieneProblems('<p>5–8 business days</p>'), []);
});

test('hygiene refuses every em dash form, a BOM, a CR, and script or style tags', () => {
  for (const form of EM_DASH_FORMS) {
    assert.equal(hasEmDash(`<p>a${form}b</p>`), true, form);
    assert.ok(hygieneProblems(`<p>a${form}b</p>`).some((p) => p.includes('em dash')), form);
  }
  assert.ok(hygieneProblems('\ufeff<p>a</p>').some((p) => p.includes('byte-order mark')));
  assert.ok(hygieneProblems('<p>a</p>\r\n').some((p) => p.includes('carriage return')));
  assert.ok(hygieneProblems('<script>x</script>').some((p) => p.includes('<script>')));
  assert.ok(hygieneProblems('<style>x</style>').some((p) => p.includes('<style>')));
});

test('hygiene does not mistake a word starting with "script" for a tag', () => {
  assert.deepEqual(hygieneProblems('<p>a scriptorium and a stylesheet</p>'), []);
  assert.deepEqual(hygieneProblems('<p>&lt;script&gt; as text</p>'), []);
});

// ---------------------------------------------------------------------------------------------
// The list contracts
// ---------------------------------------------------------------------------------------------

test('every POLICY_TYPES member has a WRITABLE and a STOREFRONT_HANDLES entry, and vice versa', () => {
  assert.deepEqual(Object.keys(WRITABLE).sort(), [...POLICY_TYPES].sort());
  assert.deepEqual(Object.keys(STOREFRONT_HANDLES).sort(), [...POLICY_TYPES].sort());
});

test('PRIVACY_POLICY is the only non-writable policy', () => {
  assert.deepEqual(POLICY_TYPES.filter((t) => !WRITABLE[t]), ['PRIVACY_POLICY']);
});

test('the type-to-filename map round-trips both ways', () => {
  for (const type of POLICY_TYPES) {
    assert.equal(typeForFileName(fileNameForType(type)), type);
    assert.equal(typeForKey(keyForType(type)), type);
  }
  assert.equal(typeForFileName('README.md'), null);
  assert.equal(typeForFileName('manifest.json'), null);
  assert.equal(typeForFileName('terms_of_sale.html'), null);
  assert.equal(typeForKey('not_a_policy'), null);
});

test('keyForType refuses an untracked ShopPolicyType', () => {
  assert.throws(() => keyForType('TERMS_OF_SALE'), PolicyError);
});

// ---------------------------------------------------------------------------------------------
// buildEntry and manifest diffing
// ---------------------------------------------------------------------------------------------

const BODY = '<h2>One</h2>\n<p>a</p>\n<h2>Two</h2>\n<p>b</p>';

test('buildEntry records the derived fields and a remote token', () => {
  const entry = buildEntry(undefined, { type: 'SHIPPING_POLICY', title: 'Shipping', body: BODY, now: NOW });
  assert.equal(entry.handle, 'shipping-policy');
  assert.equal(entry.writable, true);
  assert.equal(entry.sha256, sha256(BODY));
  assert.equal(entry.length, BODY.length);
  assert.deepEqual(entry.remote, { sha256: sha256(BODY), length: BODY.length, observedAt: NOW });
  assert.equal(entry.pulledAt, NOW);
  assert.equal('reason' in entry, false);
});

test('buildEntry attaches the reason to the non-writable policy only', () => {
  const entry = buildEntry(undefined, { type: 'PRIVACY_POLICY', title: 'Privacy policy', body: BODY, now: NOW });
  assert.equal(entry.writable, false);
  assert.equal(entry.reason, NOT_WRITABLE_REASON);
});

test('an unchanged body carries both timestamps forward, so a second pull is a no-op', () => {
  const first = buildEntry(undefined, { type: 'SHIPPING_POLICY', title: 'Shipping', body: BODY, now: NOW });
  const later = '2027-05-05T05:05:05.000Z';
  const second = buildEntry(first, { type: 'SHIPPING_POLICY', title: 'Shipping', body: BODY, now: later });
  assert.deepEqual(second, first);
  assert.equal(formatManifest({ policies: { shipping_policy: second } }), formatManifest({ policies: { shipping_policy: first } }));
});

test('a changed body moves both timestamps', () => {
  const first = buildEntry(undefined, { type: 'SHIPPING_POLICY', title: 'Shipping', body: BODY, now: NOW });
  const later = '2027-05-05T05:05:05.000Z';
  const second = buildEntry(first, { type: 'SHIPPING_POLICY', title: 'Shipping', body: `${BODY}\n<p>c</p>`, now: later });
  assert.equal(second.pulledAt, later);
  assert.equal(second.remote.observedAt, later);
});

test('buildEntry spreads the previous entry first, so unknown keys and key order survive', () => {
  const prev = { note: 'kept', title: 'Shipping', handle: 'shipping-policy', writable: true, sha256: 'x', length: 0, headings: [], remote: { sha256: 'x', length: 0, observedAt: NOW }, pulledAt: NOW };
  const next = buildEntry(prev, { type: 'SHIPPING_POLICY', title: 'Shipping', body: BODY, now: NOW });
  assert.equal(next.note, 'kept');
  assert.equal(Object.keys(next)[0], 'note');
});

test('remoteToken is the same shape pull writes', () => {
  assert.deepEqual(remoteToken(BODY, NOW), { sha256: sha256(BODY), length: BODY.length, observedAt: NOW });
});

test('diffEntry is silent when the entry matches, and names each field that does not', () => {
  const computed = { handle: 'shipping-policy', writable: true, sha256: 'a'.repeat(64), length: 10, headings: [] };
  assert.deepEqual(diffEntry('shipping_policy', { ...computed }, computed), []);
  const bad = diffEntry('shipping_policy', { ...computed, sha256: 'b'.repeat(64), length: 11 }, computed);
  assert.equal(bad.length, 2);
  assert.ok(bad.some((m) => m.includes('sha256')));
  assert.ok(bad.some((m) => m.includes('length')));
});

test('diffEntry never compares title, which cannot be recomputed offline', () => {
  assert.equal(DIFFED_FIELDS.includes('title'), false);
  const computed = { handle: 'shipping-policy', writable: true, sha256: 'a'.repeat(64), length: 1, headings: [] };
  assert.deepEqual(diffEntry('k', { ...computed, title: 'anything at all' }, computed), []);
});

test('diffEntry reports a missing manifest entry', () => {
  assert.deepEqual(diffEntry('shipping_policy', undefined, {}), ['shipping_policy: no manifest entry']);
});

test('diffHeadings, recomputed by direct comparison over small fixtures', () => {
  // Deliberately an independent implementation of the SAME question, which is where an
  // independent implementation actually pays: the comparison, not the digest.
  const a = extractHeadings('<h2>One</h2><h3>Sub</h3>');
  const b = extractHeadings('<h2>One</h2><h3>Sub</h3>');
  assert.deepEqual(diffHeadings('k', a, b), []);
  assert.equal(JSON.stringify(a), JSON.stringify(b));

  const reworded = extractHeadings('<h2>One!</h2><h3>Sub</h3>');
  const changes = diffHeadings('k', a, reworded);
  assert.equal(changes.length, 1);
  assert.ok(changes[0].includes('anchor'));

  const shorter = extractHeadings('<h2>One</h2>');
  assert.ok(diffHeadings('k', a, shorter).some((m) => m.includes('records 2 heading(s), the body has 1')));

  const missingInManifest = diffHeadings('k', undefined, a);
  assert.ok(missingInManifest.some((m) => m.includes('records 0 heading(s)')));
});

test('a level change alone is a mismatch, so an h2 demoted to h3 cannot pass', () => {
  const a = extractHeadings('<h2>Same</h2>');
  const b = extractHeadings('<h3>Same</h3>');
  assert.equal(diffHeadings('k', a, b).length, 1);
});

test('formatManifest ends with exactly one newline and is stable', () => {
  const m = { policies: { a: { x: 1 } } };
  assert.equal(formatManifest(m), '{\n  "policies": {\n    "a": {\n      "x": 1\n    }\n  }\n}\n');
});
