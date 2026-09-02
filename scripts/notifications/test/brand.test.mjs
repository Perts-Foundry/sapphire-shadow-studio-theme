// scripts/notifications/brand.mjs turns each recorded stock notification template into the
// branded copy that gets pasted into Admin. Three suites here: a reconstruction invariant that
// rebuilds every committed branded file from its stock file WITHOUT brand.mjs (so a bug in the
// generator cannot also hide in the check), a refusal matrix over synthetic stock shapes, and
// check/generate behaviour over throwaway repo roots. Nothing here reads the 160 KB real stock
// file into a fixture; the real repo is only ever read at run time.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  brandTemplate,
  BrandError,
  locateAnchors,
  check,
  generate,
  plan,
  paths,
  readManifest,
  sha256,
  commentLine,
  normalizeWhitespace,
  STOCK_STYLE_BLOCK,
  FOOTER_TABLE_ANCHOR,
  DISCLAIMER_ANCHOR,
  CONTENT_TABLE_ANCHOR,
  HEADER_TABLE_ANCHOR,
  LOGO_IF_TAG,
  REPO_ROOT,
} from '../brand.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const brandScript = path.join(here, '..', 'brand.mjs');
const repoRoot = path.resolve(here, '../../..');

const fixtureStock = readFileSync(path.join(fixtures, 'minimal.stock.liquid'), 'utf8');
const fixtureBranded = readFileSync(path.join(fixtures, 'minimal.branded.liquid'), 'utf8');
const fixtureCss = readFileSync(path.join(fixtures, 'brand-style.css'), 'utf8');
const fixtureSocial = readFileSync(path.join(fixtures, 'footer-social.html'), 'utf8');
const fixtureHeader = readFileSync(path.join(fixtures, 'header.html'), 'utf8');

const EM_DASH = '\u2014';
const SOCIAL_URLS = new Set([
  'https://cdn.shopify.com/s/files/1/0958/0874/9868/files/email-icon-instagram.png',
  'https://cdn.shopify.com/s/files/1/0958/0874/9868/files/email-icon-facebook.png',
  'https://cdn.shopify.com/s/files/1/0958/0874/9868/files/email-icon-tiktok.png',
  'https://www.instagram.com/sapphire_shadow_studio',
  'https://www.facebook.com/sapphireshadowstudio',
  'https://www.tiktok.com/@sapphire_shadow_studio',
]);

function bytesEqual(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')) === 0;
}

function assertBytesEqual(actual, expected, message) {
  if (bytesEqual(actual, expected)) return;
  let i = 0;
  while (i < actual.length && i < expected.length && actual[i] === expected[i]) i++;
  const ctx = (s) => JSON.stringify(s.slice(Math.max(0, i - 40), i + 40));
  assert.fail(`${message}: first difference at offset ${i}\n  expected ...${ctx(expected)}...\n  actual   ...${ctx(actual)}...`);
}

// A stock template built to order. Defaults produce a well-formed one; every knob breaks one
// thing brand.mjs is supposed to refuse.
function makeStock({
  styleBlocks = 1,
  disclaimers = 1,
  accentInStyle = true,
  extraStyleRule = false,
  anchorInComment = false,
  disclaimerOutsideFooter = false,
  footerTableTag = FOOTER_TABLE_ANCHOR,
  bodyAccentRefs = 0,
  trailingNewline = true,
  // The headerless shape: a content table holding `logoBlocks` stock logo blocks and no header
  // row, the layout the gift card and store credit templates ship with. `headerRow` adds a stock
  // header table anyway; `logoInnerTag` plants a second Liquid tag inside the logo block.
  contentTable = false,
  logoBlocks = 1,
  headerRow = false,
  logoInnerTag = false,
} = {}) {
  const accent = accentInStyle ? '{{ shop.email_accent_color }}' : '#0071C2';
  const styleBlock = [
    '  <style>',
    `    .button__cell { background: ${accent}; }`,
    `    .actions-buttons .button__cell--primary { background-color: ${accent}; }`,
    `    a, a:hover, a:active, a:visited { color: ${accent}; }`,
    ...(extraStyleRule ? ['    .footer { margin: 0; }'] : []),
    '  </style>',
  ].join('\n');
  const disclaimer = '              <p class="disclaimer__subtext">Questions? Reply to this email.</p>';
  const logoBlock = [
    '{% if shop.email_logo_url %}',
    '  <table align="center" class="giftcard__doubletopmargin">',
    ...(logoInnerTag ? ['    {% assign logo_seen = true %}'] : []),
    '    <tr><td><img src="{{shop.email_logo_url}}" alt="{{ shop.name }}" class="giftcard__logosize" width="{{ shop.email_logo_width }}"></td></tr>',
    '  </table>',
    '{% endif %}',
  ];
  const headerBlock = [
    `          ${HEADER_TABLE_ANCHOR}`,
    '  <tr><td class="header__cell"><center><table class="container"><tr><td>',
    '    <h1 class="shop-name__text"><a href="{{ shop.url }}">{{ shop.name }}</a></h1>',
    '  </td></tr></table></center></td></tr>',
    '</table>',
    '',
  ];
  const contentBlock = [
    ...(headerRow ? headerBlock : []),
    `          ${CONTENT_TABLE_ANCHOR}`,
    '  <tr>',
    '    <td class="content__cell">',
    '      <center>',
    '        <table class="container">',
    '          <tr>',
    '            <td>',
    ...Array.from({ length: logoBlocks }, () => logoBlock).flat(),
    '              <p>{{ greeting }}</p>',
    '            </td>',
    '          </tr>',
    '        </table>',
    '      </center>',
    '    </td>',
    '  </tr>',
    '</table>',
    '',
  ];
  const lines = [
    '{% assign greeting = "Hello" %}',
    ...(anchorInComment ? ['{% comment %}stock footer: <p class="disclaimer__subtext"> goes below{% endcomment %}'] : []),
    '<!DOCTYPE html>',
    '<html lang="en">',
    '  <head>',
    '  <title>{{ email_title }}</title>',
    ...Array.from({ length: styleBlocks }, () => styleBlock),
    '</head>',
    '  <body>',
    ...(contentTable ? contentBlock : ['    <p>{{ greeting }}</p>']),
    ...Array.from({ length: bodyAccentRefs }, () => '    <p style="color: {{ shop.email_accent_color }}">accent</p>'),
    `          ${footerTableTag}`,
    '  <tr>',
    '    <td class="footer__cell">',
    '      <center>',
    '        <table class="container">',
    '          <tr>',
    '            <td>',
    '              ',
    ...(disclaimerOutsideFooter ? [] : Array.from({ length: disclaimers }, () => disclaimer)),
    '            </td>',
    '          </tr>',
    '        </table>',
    '      </center>',
    '    </td>',
    '  </tr>',
    '</table>',
    ...(disclaimerOutsideFooter ? [disclaimer] : []),
    '  </body>',
    '</html>',
  ];
  return lines.join('\n') + (trailingNewline ? '\n' : '');
}

const brandOpts = { id: 'synthetic', css: fixtureCss, social: fixtureSocial, header: fixtureHeader };

function assertRefuses(stock, { anchor, detail }, extra = {}) {
  assert.throws(
    () => brandTemplate(stock, { ...brandOpts, ...extra }),
    (err) => {
      assert.ok(err instanceof BrandError, `expected a BrandError, got ${err && err.constructor && err.constructor.name}: ${err && err.message}`);
      assert.equal(err.id, extra.id || 'synthetic');
      assert.equal(err.anchor, anchor);
      if (detail) assert.match(err.detail, detail);
      assert.ok(err.message.startsWith(`${err.id}: refused (${anchor}): `), err.message);
      return true;
    },
  );
}

// --- temp-root helpers ------------------------------------------------------------------------

function stockEntry(text, extra = {}) {
  return { stockSha256: sha256(text), stockLength: text.length, ...extra };
}

// Lays out <root>/marketing/notifications/{manifest.json,lib/*,stock/<id>.liquid} from a spec of
// { [id]: { stock, ...manifestExtras } } and returns the root. Branded files are NOT written; call
// generate() for that, so each test decides what the branded set looks like.
function makeRoot(spec, { css = fixtureCss, social = fixtureSocial, header = fixtureHeader, manifest } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ssb-notifications-'));
  const p = paths(root);
  mkdirSync(p.stockDir, { recursive: true });
  mkdirSync(path.dirname(p.css), { recursive: true });
  writeFileSync(p.css, css, 'utf8');
  writeFileSync(p.social, social, 'utf8');
  if (header !== null) writeFileSync(p.header, header, 'utf8');
  const templates = {};
  for (const [id, { stock, ...extra }] of Object.entries(spec)) {
    if (stock !== undefined) writeFileSync(p.stock(id), stock, 'utf8');
    templates[id] = stock !== undefined ? stockEntry(stock, extra) : extra;
  }
  writeFileSync(p.manifest, JSON.stringify(manifest || { templates }, null, 2) + '\n', 'utf8');
  return root;
}

function cleanRoot(spec = { alpha: { stock: fixtureStock }, beta: { stock: makeStock() } }, opts) {
  const root = makeRoot(spec, opts);
  const g = generate(root);
  assert.deepEqual(g.problems, [], 'fixture root must generate cleanly');
  return root;
}

function snapshotTree(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.set(path.relative(dir, full), readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

function assertTreesEqual(a, b, message) {
  assert.deepEqual([...a.keys()], [...b.keys()], `${message}: file set changed`);
  for (const [name, buf] of a) {
    assert.equal(Buffer.compare(buf, b.get(name)), 0, `${message}: ${name} changed`);
  }
}

function runCli(args) {
  return spawnSync(process.execPath, [brandScript, ...args], { encoding: 'utf8' });
}

// --- 1. reconstruction invariant against the real repo ----------------------------------------

test('every committed branded file is exactly stock + comment + css + social (+ header), rebuilt without brand.mjs', () => {
  const p = paths(repoRoot);
  const manifest = JSON.parse(readFileSync(p.manifest, 'utf8'));
  const ids = Object.keys(manifest.templates).sort();
  const skipped = ids.filter((id) => manifest.templates[id].skip);
  const expected = ids.filter((id) => !skipped.includes(id));
  const liquidIds = (dir) => readdirSync(dir).filter((f) => f.endsWith('.liquid')).map((f) => f.slice(0, -7)).sort();

  assert.ok(ids.length > 0, 'manifest lists no templates');
  assert.deepEqual(liquidIds(p.stockDir), ids, 'stock/ and manifest.json disagree');
  assert.deepEqual(liquidIds(p.dir), expected, 'branded set and manifest.json (minus skips) disagree');
  assert.ok(expected.length > 0, 'nothing branded to verify');

  const css = readFileSync(p.css, 'utf8');
  const social = readFileSync(p.social, 'utf8');

  for (const id of ids) {
    const entry = manifest.templates[id];
    const stock = readFileSync(p.stock(id), 'utf8');
    assert.equal(stock.length, entry.stockLength, `${id}: stock length drifted from manifest`);
    assert.equal(sha256(stock), entry.stockSha256, `${id}: stock sha256 drifted from manifest`);
    if (skipped.includes(id)) continue;
    const override = entry.override || {};

    // Style region: the <style> block holding the accent reference, or the override's literal.
    let styleStart;
    let styleEnd;
    if (override.styleAnchor) {
      styleStart = stock.indexOf(override.styleAnchor);
      assert.notEqual(styleStart, -1, `${id}: override styleAnchor not found`);
      assert.equal(stock.indexOf(override.styleAnchor, styleStart + 1), -1, `${id}: override styleAnchor found twice`);
      styleEnd = styleStart + override.styleAnchor.length;
    } else {
      const accentAt = stock.indexOf('shop.email_accent_color');
      assert.notEqual(accentAt, -1, `${id}: stock has no accent reference`);
      styleStart = stock.lastIndexOf('<style', accentAt);
      styleEnd = stock.indexOf('</style>', accentAt) + '</style>'.length;
      assert.ok(styleStart !== -1 && styleEnd > styleStart, `${id}: could not bracket the style block`);
      assert.equal(stock.indexOf('shop.email_accent_color', styleEnd), -1, `${id}: accent referenced outside the style block; this rebuild assumes one block`);
    }

    // Insertion point: the disclaimer paragraph, or the override's literal; either way exactly once.
    const insertAnchor = override.footerAnchor || DISCLAIMER_ANCHOR;
    const disclaimerStart = stock.indexOf(insertAnchor);
    assert.notEqual(disclaimerStart, -1, `${id}: insertion anchor ${JSON.stringify(insertAnchor)} not found`);
    assert.equal(stock.indexOf(insertAnchor, disclaimerStart + 1), -1, `${id}: insertion anchor ${JSON.stringify(insertAnchor)} found more than once`);
    const lineStart = stock.lastIndexOf('\n', disclaimerStart - 1) + 1;
    const indent = stock.slice(lineStart, disclaimerStart);
    assert.match(indent, /^[ \t]*$/, `${id}: disclaimer is not first on its line`);
    // Containment holds for every id, override or not: the anchor is inside the footer table, so a
    // manifest override that resolved to the body-side disclaimer paragraph would fail here even
    // though the generator and this rebuild use the same literal.
    const tableAt = stock.indexOf(FOOTER_TABLE_ANCHOR);
    assert.notEqual(tableAt, -1, `${id}: footer table not found`);
    assert.equal(stock.indexOf(FOOTER_TABLE_ANCHOR, tableAt + 1), -1, `${id}: footer table found more than once`);
    assert.ok(disclaimerStart > tableAt, `${id}: insertion anchor precedes the footer table`);
    assert.ok(!stock.slice(tableAt, disclaimerStart).includes('</table>'), `${id}: insertion anchor is not inside the footer table`);

    // The header override: lib/header.html goes in front of the content table (exactly once, first
    // on its line, between the style block and the footer) and every stock logo block after it is
    // removed as whole lines. Independent of brand.mjs's own matcher on purpose.
    let middle = stock.slice(styleEnd, disclaimerStart);
    if (override.header) {
      const header = readFileSync(p.header, 'utf8').replace(/\s+$/, '');
      assert.ok(!stock.includes(HEADER_TABLE_ANCHOR), `${id}: stock already has a header table`);
      const contentAt = middle.indexOf(CONTENT_TABLE_ANCHOR);
      assert.notEqual(contentAt, -1, `${id}: content table not found`);
      assert.equal(middle.indexOf(CONTENT_TABLE_ANCHOR, contentAt + 1), -1, `${id}: content table found more than once`);
      assert.ok(contentAt < middle.indexOf(FOOTER_TABLE_ANCHOR), `${id}: content table follows the footer table`);
      const cLineStart = middle.lastIndexOf('\n', contentAt - 1) + 1;
      const cIndent = middle.slice(cLineStart, contentAt);
      assert.match(cIndent, /^[ \t]*$/, `${id}: content table is not first on its line`);
      const logoRe = /^[ \t]*\{% if shop\.email_logo_url %\}\n(?:(?!.*\{%)[^\n]*\n)*?[ \t]*\{% endif %\}[ \t]*\n/gm;
      const after = middle.slice(contentAt);
      const stripped = after.replace(logoRe, '');
      assert.notEqual(stripped, after, `${id}: no logo block found after the content table`);
      assert.ok(!stripped.includes(LOGO_IF_TAG), `${id}: a logo block survived the rebuild`);
      assert.ok(!middle.slice(0, contentAt).includes(LOGO_IF_TAG), `${id}: a logo block precedes the content table`);
      middle = middle.slice(0, contentAt) + header + '\n\n' + cIndent + stripped;
    }

    const rebuilt =
      commentLine(id) +
      stock.slice(0, styleStart) +
      '<style>\n' + css + '  </style>' +
      middle +
      social.replace(/\s+$/, '') + '\n' + indent +
      stock.slice(disclaimerStart);
    const branded = readFileSync(p.branded(id), 'utf8');
    assertBytesEqual(branded, rebuilt, `${id}.liquid is not a faithful rebuild of stock/${id}.liquid; run npm run notifications:generate`);
  }
});

test('the real repo passes check() with no problems and no mismatches', () => {
  const result = check(repoRoot);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.mismatches, []);
  assert.equal(REPO_ROOT, repoRoot, 'REPO_ROOT should resolve to the repo containing scripts/notifications');
});

// --- 2. refusal matrix -------------------------------------------------------------------------

test('a well-formed synthetic stock brands cleanly (control for the refusal matrix)', () => {
  const { output, accentRemaining } = brandTemplate(makeStock(), brandOpts);
  assert.equal(accentRemaining, 0);
  assert.ok(output.startsWith(commentLine('synthetic')));
  assert.ok(!output.includes('email_accent_color'));
  assert.ok(output.includes('class="ssb-social"'));
});

const refusals = [
  ['no accent style block', makeStock({ styleBlocks: 0 }), { anchor: 'style', detail: /not found/ }],
  ['two accent style blocks', makeStock({ styleBlocks: 2 }), { anchor: 'style', detail: /found 2 times/ }],
  ['style block without the accent reference', makeStock({ accentInStyle: false }), { anchor: 'style', detail: /not found/ }],
  ['style block with an extra rule', makeStock({ extraStyleRule: true }), { anchor: 'style', detail: /differs from the known stock block/ }],
  ['no disclaimer paragraph', makeStock({ disclaimers: 0 }), { anchor: 'disclaimer', detail: /not found/ }],
  ['two disclaimer paragraphs', makeStock({ disclaimers: 2 }), { anchor: 'disclaimer', detail: /found 2 times/ }],
  ['disclaimer outside the footer table', makeStock({ disclaimerOutsideFooter: true }), { anchor: 'disclaimer', detail: /not inside the footer table/ }],
  ['disclaimer anchor also inside a Liquid comment', makeStock({ anchorInComment: true }), { anchor: 'disclaimer', detail: /inside a Liquid comment/ }],
  ['a carriage return anywhere in the input', makeStock().replace('<html', '\r<html'), { anchor: 'input', detail: /carriage return/ }],
  ['a leading BOM', '\uFEFF' + makeStock(), { anchor: 'input', detail: /BOM/ }],
  ['attribute-order variant <table class="footer row"> (documented: not recognised as the footer)', makeStock({ footerTableTag: '<table class="footer row">' }), { anchor: 'footer-table', detail: /not found/ }],
  ['an already-branded file fed back in', brandTemplate(makeStock(), brandOpts).output, { anchor: 'style', detail: /not found/ }],
];

for (const [name, stock, expected] of refusals) {
  test(`refuses: ${name}`, () => {
    assertRefuses(stock, expected);
  });
}

test('refuses an override footerAnchor that resolves before the footer table', () => {
  const stock = makeStock();
  assertRefuses(stock, { anchor: 'footer', detail: /precedes the footer table/ }, { override: { footerAnchor: '<title>' } });
});

test('refuses an override footerAnchor that resolves outside the footer table', () => {
  const stock = makeStock({ disclaimerOutsideFooter: true });
  assertRefuses(stock, { anchor: 'footer', detail: /not inside the footer table/ }, { override: { footerAnchor: DISCLAIMER_ANCHOR } });
});

// The real shape behind six manifest overrides: a second disclaimer paragraph in the body. The stock
// path refuses (two anchors); an override naming the body paragraph is refused by containment; an
// override naming the footer paragraph brands with the social row inside the footer table.
test('a body-side disclaimer paragraph: stock path refuses, wrong override refuses, footer override brands', () => {
  const bodyParagraph = '<p class="disclaimer__subtext">Tracking number: 123</p>';
  const stock = makeStock().replace(`\n          ${FOOTER_TABLE_ANCHOR}`, `\n          ${bodyParagraph}\n          ${FOOTER_TABLE_ANCHOR}`);
  assert.equal(stock.split(DISCLAIMER_ANCHOR).length - 1, 2, 'fixture should carry two disclaimer paragraphs');
  assertRefuses(stock, { anchor: 'disclaimer', detail: /found 2 times/ });
  assertRefuses(stock, { anchor: 'footer', detail: /precedes the footer table/ }, { override: { footerAnchor: '<p class="disclaimer__subtext">Tracking' } });
  const footerAnchor = '<p class="disclaimer__subtext">Questions?';
  const { output } = brandTemplate(stock, { ...brandOpts, override: { footerAnchor } });
  const tableAt = output.indexOf(FOOTER_TABLE_ANCHOR);
  const socialAt = output.indexOf('class="ssb-social"');
  assert.ok(socialAt > tableAt, 'social row lands inside the footer table');
  assert.ok(!output.slice(tableAt, socialAt).includes('</table>'));
  assert.ok(output.includes(bodyParagraph), 'the body-side paragraph is untouched');
  assert.ok(output.indexOf(bodyParagraph) < tableAt);
});

test('refuses when the insertion point is not first on its line', () => {
  const stock = makeStock().replace(`\n              ${DISCLAIMER_ANCHOR}`, `\n              <span></span>${DISCLAIMER_ANCHOR}`);
  assertRefuses(stock, { anchor: 'footer', detail: /start of a line/ });
});

test('BrandError carries id, anchor and detail, and the message is built from them', () => {
  const err = new BrandError('x', 'style', 'why');
  assert.equal(err.id, 'x');
  assert.equal(err.anchor, 'style');
  assert.equal(err.detail, 'why');
  assert.equal(err.message, 'x: refused (style): why');
  assert.ok(err instanceof Error);
});

test('locateAnchors reports the stock style block and disclaimer offsets', () => {
  const stock = makeStock();
  const { styleStart, styleEnd, footerStart } = locateAnchors(stock, 'synthetic');
  assert.ok(stock.slice(styleStart).startsWith('<style>'));
  assert.ok(stock.slice(0, styleEnd).endsWith('</style>'));
  assert.equal(normalizeWhitespace(stock.slice(styleStart, styleEnd)), STOCK_STYLE_BLOCK);
  assert.ok(stock.slice(footerStart).startsWith(DISCLAIMER_ANCHOR));
});

test('locateAnchors honours override anchors and does not require the stock style block', () => {
  const stock = makeStock({ extraStyleRule: true });
  assertRefuses(stock, { anchor: 'style', detail: /differs from the known stock block/ });
  const override = { styleAnchor: '<title>{{ email_title }}</title>', footerAnchor: DISCLAIMER_ANCHOR };
  const at = locateAnchors(stock, 'synthetic', override);
  assert.equal(stock.slice(at.styleStart, at.styleEnd), override.styleAnchor);
  assert.equal(stock.slice(at.footerStart).slice(0, DISCLAIMER_ANCHOR.length), DISCLAIMER_ANCHOR);
  const { output } = brandTemplate(stock, { ...brandOpts, override });
  assert.ok(!output.includes('<title>{{ email_title }}</title>'), 'the override style anchor is what gets replaced');
  assert.ok(output.includes('<style>\n' + fixtureCss + '  </style>'));
});

// --- 3. happy path on the synthetic fixture ------------------------------------------------------

test('golden: fixtures/minimal.stock.liquid brands byte-for-byte into fixtures/minimal.branded.liquid', () => {
  const { output, accentRemaining } = brandTemplate(fixtureStock, { id: 'minimal', css: fixtureCss, social: fixtureSocial });
  assert.equal(accentRemaining, 0);
  assertBytesEqual(output, fixtureBranded, 'golden drifted; regenerate fixtures/minimal.branded.liquid deliberately if brand.mjs changed');
});

test('the branded output keeps every stock byte outside the two replaced regions', () => {
  const { output } = brandTemplate(fixtureStock, { id: 'minimal', css: fixtureCss, social: fixtureSocial });
  const { styleStart, styleEnd, footerStart } = locateAnchors(fixtureStock, 'minimal');
  const head = fixtureStock.slice(0, styleStart);
  const middle = fixtureStock.slice(styleEnd, footerStart);
  const tail = fixtureStock.slice(footerStart);
  assert.ok(output.startsWith(commentLine('minimal') + head));
  assert.ok(output.includes('  </style>' + middle + fixtureSocial.trimEnd() + '\n              ' + tail));
  assert.ok(output.endsWith(tail));
  assert.equal(output.split(commentLine('minimal').trim()).length, 2, 'exactly one generated-by comment');
});

test('accentRemaining counts stray accent references left in the body, not the replaced block', () => {
  assert.equal(brandTemplate(makeStock({ bodyAccentRefs: 0 }), brandOpts).accentRemaining, 0);
  assert.equal(brandTemplate(makeStock({ bodyAccentRefs: 1 }), brandOpts).accentRemaining, 1);
  assert.equal(brandTemplate(makeStock({ bodyAccentRefs: 3 }), brandOpts).accentRemaining, 3);
  const { output } = brandTemplate(makeStock({ bodyAccentRefs: 1 }), brandOpts);
  assert.equal(output.split('email_accent_color').length - 1, 1, 'the stray reference is preserved verbatim');
});

test('Unicode passes through bytewise: copyright sign, curly quote, NBSP and an astral character', () => {
  for (const sample of ['©', '’', '\u00A0', '\u{1F9F5}', '“']) {
    assert.ok(fixtureStock.includes(sample), `fixture lacks ${JSON.stringify(sample)}`);
  }
  const { output } = brandTemplate(fixtureStock, { id: 'minimal', css: fixtureCss, social: fixtureSocial });
  const stockBytes = Buffer.from(fixtureStock, 'utf8');
  const tailBytes = Buffer.from(fixtureStock.slice(fixtureStock.indexOf(DISCLAIMER_ANCHOR)), 'utf8');
  const bodyBytes = Buffer.from('<p>Thread colour: \u{1F9F5} Sapphire blue\u00A0(#1).</p>', 'utf8');
  const outBytes = Buffer.from(output, 'utf8');
  assert.notEqual(outBytes.indexOf(tailBytes), -1, 'footer tail (with © and curly quotes) not found bytewise');
  assert.notEqual(outBytes.indexOf(bodyBytes), -1, 'body line (with astral char and NBSP) not found bytewise');
  assert.equal(stockBytes.indexOf(bodyBytes) >= 0, true);
});

test('a trailing newline is preserved, and its absence is preserved too', () => {
  const withNl = brandTemplate(makeStock({ trailingNewline: true }), brandOpts).output;
  const without = brandTemplate(makeStock({ trailingNewline: false }), brandOpts).output;
  assert.ok(withNl.endsWith('</html>\n'));
  assert.ok(without.endsWith('</html>'));
  assert.equal(withNl, without + '\n');
});

test('commentLine names the stock source and ends with exactly one newline', () => {
  const line = commentLine('order_confirmation');
  assert.ok(line.startsWith('{%- comment -%}'));
  assert.ok(line.includes('marketing/notifications/stock/order_confirmation.liquid'));
  assert.ok(line.endsWith('{%- endcomment -%}\n'));
  assert.equal(line.indexOf('\n'), line.length - 1);
});

test('normalizeWhitespace collapses runs and trims, and STOCK_STYLE_BLOCK is already normalised', () => {
  assert.equal(normalizeWhitespace('  a \n\t b  '), 'a b');
  assert.equal(normalizeWhitespace(STOCK_STYLE_BLOCK), STOCK_STYLE_BLOCK);
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

// --- 4. check / generate over temp roots --------------------------------------------------------

test('paths() lays out the notifications directory under the given root', () => {
  const p = paths('/r');
  assert.equal(p.dir, path.join('/r', 'marketing', 'notifications'));
  assert.equal(p.manifest, path.join(p.dir, 'manifest.json'));
  assert.equal(p.css, path.join(p.dir, 'lib', 'brand-style.css'));
  assert.equal(p.social, path.join(p.dir, 'lib', 'footer-social.html'));
  assert.equal(p.stock('x'), path.join(p.dir, 'stock', 'x.liquid'));
  assert.equal(p.branded('x'), path.join(p.dir, 'x.liquid'));
});

test('readManifest rejects a manifest without a templates object', () => {
  const root = makeRoot({}, { manifest: { nope: true } });
  assert.throws(() => readManifest(root), /missing "templates" object/);
  assert.throws(() => plan(root), /missing "templates" object/);
});

test('plan flags an empty manifest', () => {
  const root = makeRoot({});
  assert.deepEqual(plan(root).problems, ['manifest.json lists no templates']);
});

test('clean tree: generate writes every id, then check finds no problems and no mismatches', () => {
  const root = makeRoot({ alpha: { stock: fixtureStock }, beta: { stock: makeStock() } });
  const g = generate(root);
  assert.deepEqual(g.problems, []);
  assert.deepEqual(g.written, ['alpha', 'beta']);
  assert.deepEqual(g.notes, []);
  const p = paths(root);
  assert.ok(existsSync(p.branded('alpha')) && existsSync(p.branded('beta')));
  assert.ok(!existsSync(`${p.branded('alpha')}.tmp`), 'the temp file is renamed away');
  assertBytesEqual(readFileSync(p.branded('alpha'), 'utf8'), fixtureBranded.replace(commentLine('minimal'), commentLine('alpha')), 'alpha.liquid');
  const c = check(root);
  assert.deepEqual(c, { problems: [], mismatches: [], notes: [] });
});

test('a hand-edited branded file is a mismatch naming the id', () => {
  const root = cleanRoot();
  const p = paths(root);
  writeFileSync(p.branded('beta'), readFileSync(p.branded('beta'), 'utf8').replace('Questions?', 'Questions!'), 'utf8');
  const c = check(root);
  assert.deepEqual(c.problems, []);
  assert.equal(c.mismatches.length, 1);
  assert.match(c.mismatches[0], /^beta: beta\.liquid differs from regenerated output at offset \d+ \(line \d+\)/);
  assert.match(c.mismatches[0], /expected: .*Questions\?/);
  assert.match(c.mismatches[0], /actual: .*Questions!/);
});

test('a missing branded file is a mismatch, not a problem', () => {
  const root = cleanRoot();
  rmSync(paths(root).branded('alpha'));
  const c = check(root);
  assert.deepEqual(c.problems, []);
  assert.deepEqual(c.mismatches, ['alpha: alpha.liquid is missing']);
});

test('an orphan branded file with no manifest entry is a problem', () => {
  const root = cleanRoot();
  writeFileSync(paths(root).branded('gamma'), 'orphan\n', 'utf8');
  const c = check(root);
  assert.deepEqual(c.problems, ['gamma: gamma.liquid has no manifest entry']);
  assert.deepEqual(c.mismatches, []);
});

test('a stock file not in the manifest is a problem', () => {
  const root = cleanRoot();
  writeFileSync(paths(root).stock('gamma'), makeStock(), 'utf8');
  const c = check(root);
  assert.deepEqual(c.problems, ['gamma: stock/gamma.liquid is not in manifest.json']);
});

test('a manifest id with no stock file is a problem', () => {
  const root = cleanRoot();
  rmSync(paths(root).stock('beta'));
  const c = check(root);
  assert.deepEqual(c.problems, ['beta: stock/beta.liquid is missing']);
  assert.deepEqual(c.mismatches, [], 'no output was planned, so its branded file is not compared');
});

test('a manifest entry without a recorded snapshot is a problem', () => {
  const root = makeRoot({ alpha: { stock: fixtureStock } });
  const p = paths(root);
  writeFileSync(p.manifest, JSON.stringify({ templates: { alpha: { subject: 'x' } } }), 'utf8');
  assert.deepEqual(check(root).problems, ['alpha: manifest entry lacks stockSha256 / stockLength']);
});

test('a stock file that drifted from its recorded hash is a problem', () => {
  const root = cleanRoot();
  const p = paths(root);
  writeFileSync(p.stock('beta'), readFileSync(p.stock('beta'), 'utf8').replace('Hello', 'Hallo'), 'utf8');
  const c = check(root);
  assert.equal(c.problems.length, 1);
  assert.match(c.problems[0], /^beta: stock\/beta\.liquid does not match the recorded snapshot \(length \d+, expected \d+\)/);
  assert.match(c.problems[0], /record-stock\.mjs/);
  assert.deepEqual(c.mismatches, []);
});

test('a stock file whose length matches but whose bytes differ is still a problem', () => {
  const root = cleanRoot();
  const p = paths(root);
  writeFileSync(p.stock('beta'), readFileSync(p.stock('beta'), 'utf8').replace('Hello', 'Hullo'), 'utf8');
  assert.equal(check(root).problems.length, 1);
});

test('changing lib css is a mismatch on every branded file until regenerate, then clean', () => {
  const root = cleanRoot();
  const p = paths(root);
  writeFileSync(p.css, fixtureCss + '    .extra { color: #fff; }\n', 'utf8');
  const c = check(root);
  assert.deepEqual(c.problems, []);
  assert.deepEqual(c.mismatches.map((m) => m.split(':')[0]), ['alpha', 'beta']);
  assert.deepEqual(generate(root).written, ['alpha', 'beta']);
  assert.deepEqual(check(root).mismatches, []);
  assert.ok(readFileSync(p.branded('alpha'), 'utf8').includes('.extra { color: #fff; }'));
});

test('changing lib social html is a mismatch until regenerate', () => {
  const root = cleanRoot();
  const p = paths(root);
  writeFileSync(p.social, fixtureSocial.replace('TikTok', 'Tik Tok'), 'utf8');
  assert.equal(check(root).mismatches.length, 2);
  generate(root);
  assert.deepEqual(check(root).mismatches, []);
});

test('lib css without a trailing newline is a problem', () => {
  const root = cleanRoot();
  writeFileSync(paths(root).css, fixtureCss.trimEnd(), 'utf8');
  assert.deepEqual(check(root).problems, ['lib/brand-style.css must end with a newline']);
});

test('a carriage return in either lib file is a problem', () => {
  const root = cleanRoot();
  const p = paths(root);
  writeFileSync(p.css, fixtureCss.replace('\n', '\r\n'), 'utf8');
  writeFileSync(p.social, fixtureSocial.replace('\n', '\r\n'), 'utf8');
  assert.deepEqual(check(root).problems, [
    'lib/brand-style.css contains a carriage return',
    'lib/footer-social.html contains a carriage return',
  ]);
});

test('a skip entry is noted, expects no branded file, and complains if one exists', () => {
  const root = makeRoot({ alpha: { stock: fixtureStock }, beta: { stock: makeStock(), skip: 'Admin has no editor for this one' } });
  const g = generate(root);
  assert.deepEqual(g.problems, []);
  assert.deepEqual(g.written, ['alpha']);
  assert.deepEqual(g.notes, ['beta: skipped (Admin has no editor for this one)']);
  assert.deepEqual(check(root), { problems: [], mismatches: [], notes: ['beta: skipped (Admin has no editor for this one)'] });
  writeFileSync(paths(root).branded('beta'), 'should not be here\n', 'utf8');
  const c = check(root);
  assert.deepEqual(c.problems, ['beta: marked skip in manifest.json but beta.liquid exists']);
  assert.deepEqual(c.mismatches, []);
});

test('a skipped id with a drifted stock file is still a problem', () => {
  const root = makeRoot({ beta: { stock: makeStock(), skip: 'later' } });
  const p = paths(root);
  writeFileSync(p.stock('beta'), makeStock() + '\n', 'utf8');
  assert.equal(check(root).problems.length, 1);
  assert.deepEqual(check(root).notes, []);
});

test('an override entry with alternate anchors generates where the stock anchors would refuse', () => {
  const stock = makeStock({ extraStyleRule: true });
  const plain = makeRoot({ odd: { stock } });
  const c = check(plain);
  assert.equal(c.problems.length, 1);
  assert.match(c.problems[0], /^odd: refused \(style\)/);

  const override = { styleAnchor: '<link rel="stylesheet" type="text/css" href="/assets/notifications/styles.css">', footerAnchor: DISCLAIMER_ANCHOR };
  const stockWithLink = stock.replace('<title>{{ email_title }}</title>', `<title>{{ email_title }}</title>\n  ${override.styleAnchor}`);
  const root = makeRoot({ odd: { stock: stockWithLink, override } });
  const g = generate(root);
  assert.deepEqual(g.problems, []);
  assert.deepEqual(g.written, ['odd']);
  const branded = readFileSync(paths(root).branded('odd'), 'utf8');
  assert.ok(!branded.includes(override.styleAnchor));
  assert.ok(branded.includes('<style>\n' + fixtureCss + '  </style>'));
  assert.ok(branded.includes(fixtureSocial.trimEnd() + '\n              ' + DISCLAIMER_ANCHOR));
  assert.ok(branded.includes('shop.email_accent_color'), 'the stock style block is untouched under an override');
  assert.deepEqual(check(root).mismatches, []);
});

test('accent references left in the body surface as a note, never a problem', () => {
  const root = makeRoot({ stray: { stock: makeStock({ bodyAccentRefs: 2 }) } });
  const g = generate(root);
  assert.deepEqual(g.problems, []);
  assert.deepEqual(g.notes, ['stray: 2 email_accent_color reference(s) remain in the body']);
});

test('generate refuses and writes nothing when any id has a problem', () => {
  const root = makeRoot({ alpha: { stock: fixtureStock }, broken: { stock: makeStock({ disclaimers: 0 }) } });
  const before = snapshotTree(root);
  const g = generate(root);
  assert.equal(g.problems.length, 1);
  assert.match(g.problems[0], /^broken: refused \(disclaimer\): anchor not found$/);
  assert.deepEqual(g.written, []);
  assertTreesEqual(snapshotTree(root), before, 'generate must not write on refusal');
  assert.ok(!existsSync(paths(root).branded('alpha')), 'even the healthy id is not written');
});

test('a refusal from one id does not hide problems from another', () => {
  const root = makeRoot({ a: { stock: makeStock({ styleBlocks: 2 }) }, b: { stock: makeStock({ anchorInComment: true }) } });
  const c = check(root);
  assert.deepEqual(c.problems.map((m) => m.split(':')[0]), ['a', 'b']);
});

test('check never modifies any file', () => {
  const root = cleanRoot();
  const p = paths(root);
  writeFileSync(p.branded('beta'), 'edited\n', 'utf8');
  rmSync(p.branded('alpha'));
  writeFileSync(p.stock('alpha'), fixtureStock + '\n', 'utf8');
  writeFileSync(p.branded('orphan'), 'orphan\n', 'utf8');
  const before = snapshotTree(root);
  const c = check(root);
  assert.ok(c.problems.length > 0 && c.mismatches.length > 0, 'this tree is meant to be unhealthy');
  assertTreesEqual(snapshotTree(root), before, 'check must be read-only');
});

test('two consecutive generates produce identical bytes', () => {
  const root = cleanRoot();
  const first = snapshotTree(root);
  assert.deepEqual(generate(root).written, ['alpha', 'beta']);
  assertTreesEqual(snapshotTree(root), first, 'generate is not idempotent');
});

test('generate overwrites a hand-edited branded file back to the regenerated bytes', () => {
  const root = cleanRoot();
  const p = paths(root);
  const good = readFileSync(p.branded('alpha'));
  writeFileSync(p.branded('alpha'), 'edited\n', 'utf8');
  generate(root);
  assert.equal(Buffer.compare(readFileSync(p.branded('alpha')), good), 0);
});

test('CLI: --check --root exits 1 on a mismatch and 0 when clean', () => {
  const root = cleanRoot();
  const p = paths(root);
  const ok = runCli(['--check', '--root', root]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /notifications:check ok/);

  writeFileSync(p.branded('beta'), 'edited\n', 'utf8');
  const bad = runCli(['--check', '--root', root]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /error: beta: beta\.liquid differs from regenerated output/);
  assert.match(bad.stderr, /notifications:check failed: 0 problem\(s\), 1 file\(s\) out of date/);
  assert.equal(Buffer.compare(readFileSync(p.branded('beta')), Buffer.from('edited\n')), 0, '--check must not repair the file');
});

test('CLI: generate --root exits 1 and writes nothing on a problem', () => {
  const root = makeRoot({ broken: { stock: makeStock({ styleBlocks: 0 }) } });
  const before = snapshotTree(root);
  const r = runCli(['--root', root]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /error: broken: refused \(style\): anchor not found/);
  assert.match(r.stderr, /notifications:generate refused: 1 problem\(s\); nothing written/);
  assertTreesEqual(snapshotTree(root), before, 'CLI generate wrote on refusal');
});

// --- 6. hygiene over the real files --------------------------------------------------------------

test('hygiene: lib/ and scripts/notifications/*.mjs carry no CR, no em dash, no tracking or unsubscribe markup', () => {
  const p = paths(repoRoot);
  const scriptsDir = path.join(repoRoot, 'scripts', 'notifications');
  const files = [
    p.css,
    p.social,
    ...readdirSync(scriptsDir).filter((f) => f.endsWith('.mjs')).map((f) => path.join(scriptsDir, f)),
  ];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const rel = path.relative(repoRoot, file);
    assert.ok(!text.includes('\r'), `${rel} contains a carriage return`);
    assert.ok(!text.includes(EM_DASH), `${rel} contains an em dash`);
  }
  for (const file of [p.css, p.social]) {
    const text = readFileSync(file, 'utf8');
    const rel = path.relative(repoRoot, file);
    assert.ok(!text.includes('open_tracking_block'), `${rel} contains open_tracking_block`);
    assert.ok(!/unsubscribe/i.test(text), `${rel} contains unsubscribe`);
  }
});

// Six stock templates carry a second disclaimer__subtext paragraph inside the white content area
// (the tracking-number line in the shipping family, the safety message in order_link). The footer
// colours (#c9d8ea text, white links) are unreadable there, so every rule that names the class,
// or the inserted footer classes, must be scoped under .footer.
test('hygiene: brand-style.css rules naming disclaimer__subtext or ssb- classes are footer-scoped', () => {
  const css = readFileSync(paths(repoRoot).css, 'utf8');
  const rules = css.match(/[^{}]+\{[^}]*\}/g) || [];
  assert.ok(rules.length > 0, 'brand-style.css has no rules');
  let seen = 0;
  for (const rule of rules) {
    const selectorList = rule.slice(0, rule.indexOf('{')).trim();
    if (!/disclaimer__subtext|ssb-/.test(selectorList)) continue;
    seen++;
    for (const selector of selectorList.split(',').map((s) => s.trim())) {
      assert.match(
        selector,
        /^\.footer(__cell)?\s/,
        `brand-style.css selector "${selector}" names a footer class but is not scoped under .footer`,
      );
    }
  }
  assert.ok(seen > 0, 'brand-style.css has no rule naming disclaimer__subtext');
});

test('hygiene: every https URL in footer-social.html is one of the six known brand URLs', () => {
  const social = readFileSync(paths(repoRoot).social, 'utf8');
  const urls = social.match(/https:\/\/[^\s"'<>]+/g) || [];
  assert.ok(urls.length > 0, 'footer-social.html has no https URLs');
  for (const url of urls) assert.ok(SOCIAL_URLS.has(url), `unexpected URL in footer-social.html: ${url}`);
  assert.ok(!social.includes('http://'), 'footer-social.html must not link over plain http');
});

test('hygiene: the inserted regions of every branded file are clean and the style region has no accent reference', () => {
  const p = paths(repoRoot);
  const manifest = readManifest(repoRoot);
  const css = readFileSync(p.css, 'utf8');
  const social = readFileSync(p.social, 'utf8').replace(/\s+$/, '');
  const ids = Object.keys(manifest.templates).filter((id) => !manifest.templates[id].skip);
  assert.ok(ids.length > 0);
  for (const id of ids) {
    const branded = readFileSync(p.branded(id), 'utf8');
    assert.ok(!branded.includes('open_tracking_block'), `${id}.liquid contains open_tracking_block`);
    assert.ok(!/unsubscribe/i.test(branded), `${id}.liquid contains unsubscribe`);

    const styleNeedle = '<style>\n' + css + '  </style>';
    const styleAt = branded.indexOf(styleNeedle);
    assert.notEqual(styleAt, -1, `${id}.liquid lacks the inserted style region`);
    assert.equal(branded.indexOf(styleNeedle, styleAt + 1), -1, `${id}.liquid has the style region twice`);
    const styleRegion = branded.slice(styleAt, styleAt + styleNeedle.length);
    assert.ok(!styleRegion.includes('email_accent_color'), `${id}.liquid style region still references email_accent_color`);

    const socialAt = branded.indexOf(social);
    assert.notEqual(socialAt, -1, `${id}.liquid lacks the inserted social region`);
    assert.equal(branded.indexOf(social, socialAt + 1), -1, `${id}.liquid has the social region twice`);
    const socialRegion = branded.slice(socialAt, socialAt + social.length);

    const regions = [['style', styleRegion], ['social', socialRegion], ['comment', branded.slice(0, branded.indexOf('\n'))]];
    const override = manifest.templates[id].override || {};
    if (override.header) {
      const header = readFileSync(p.header, 'utf8').replace(/\s+$/, '');
      const headerAt = branded.indexOf(header);
      assert.notEqual(headerAt, -1, `${id}.liquid lacks the inserted header region`);
      assert.equal(branded.indexOf(header, headerAt + 1), -1, `${id}.liquid has the header region twice`);
      assert.ok(headerAt > styleAt && headerAt < socialAt, `${id}.liquid header region is not between the style and social regions`);
      assert.ok(!branded.includes(LOGO_IF_TAG), `${id}.liquid still carries a stock logo block`);
      regions.push(['header', branded.slice(headerAt, headerAt + header.length)]);
    }
    for (const [name, region] of regions) {
      assert.ok(!region.includes('\r'), `${id}.liquid ${name} region contains a carriage return`);
      assert.ok(!region.includes(EM_DASH), `${id}.liquid ${name} region contains an em dash`);
    }
    assert.equal(branded.slice(0, branded.indexOf('\n') + 1), commentLine(id));
  }
});

// --- 5. the header override ---------------------------------------------------------------------

const headerOverride = { header: true };

test('header override: lib/header.html lands before the content table and every logo block goes', () => {
  const stock = makeStock({ contentTable: true, logoBlocks: 2 });
  assert.equal([...stock.matchAll(/\{% if shop\.email_logo_url %\}/g)].length, 2, 'control: two logo blocks in');
  const { output } = brandTemplate(stock, { ...brandOpts, override: headerOverride });
  const header = fixtureHeader.trimEnd();
  const headerAt = output.indexOf(header);
  assert.notEqual(headerAt, -1, 'header not inserted');
  assert.equal(output.indexOf(header, headerAt + 1), -1, 'header inserted twice');
  assert.equal(output.indexOf(CONTENT_TABLE_ANCHOR), headerAt + header.length + '\n\n          '.length, 'header is not immediately before the content table');
  assert.ok(!output.includes(LOGO_IF_TAG), 'a logo block survived');
  assert.ok(!output.includes('giftcard__logosize'), 'the logo image survived');
  assert.ok(output.includes('<p>{{ greeting }}</p>'), 'body content lost');
  assert.ok(output.includes('class="ssb-social"'), 'footer insertion lost');
  assert.ok(!output.includes('email_accent_color'));
  // Everything outside the four edits is stock, byte for byte.
  const stripped = output
    .slice(commentLine('synthetic').length)
    .replace('<style>\n' + fixtureCss + '  </style>', '')
    .replace('          ' + header + '\n\n', '')
    .replace(fixtureSocial.trimEnd() + '\n              ', '');
  const stockStripped = stock
    .replace(/<style>[\s\S]*?<\/style>/, '')
    .replace(/^\{% if shop\.email_logo_url %\}\n[\s\S]*?\{% endif %\}\n/gm, '');
  assertBytesEqual(stripped, stockStripped, 'bytes outside the edits changed');
});

test('header override: the same stock without the override brands as before, logo blocks and all', () => {
  const stock = makeStock({ contentTable: true });
  const { output } = brandTemplate(stock, brandOpts);
  assert.ok(output.includes(LOGO_IF_TAG));
  assert.ok(!output.includes(HEADER_TABLE_ANCHOR));
});

const headerRefusals = [
  ['no content table', makeStock(), { anchor: 'content-table', detail: /not found/ }],
  ['two content tables', makeStock({ contentTable: true }).replace('  </body>', `          ${CONTENT_TABLE_ANCHOR}\n  </body>`), { anchor: 'content-table', detail: /found 2 times/ }],
  ['a stock header table already present', makeStock({ contentTable: true, headerRow: true }), { anchor: 'header', detail: /already has a header table/ }],
  ['no logo block', makeStock({ contentTable: true, logoBlocks: 0 }), { anchor: 'logo', detail: /not found/ }],
  ['a logo block holding another Liquid tag', makeStock({ contentTable: true, logoInnerTag: true }), { anchor: 'logo', detail: /not closed by the next Liquid tag/ }],
  ['a logo block whose endif shares its line', makeStock({ contentTable: true }).replace('{% endif %}\n              <p>', '{% endif %} <p>'), { anchor: 'logo', detail: /not alone on its line/ }],
  ['a logo block that is not first on its line', makeStock({ contentTable: true }).replace('\n{% if shop.email_logo_url %}', '\n<br>{% if shop.email_logo_url %}'), { anchor: 'logo', detail: /not first on its line/ }],
  ['a logo block inside a Liquid comment', makeStock({ contentTable: true }).replace('<!DOCTYPE html>', '{% comment %}{% if shop.email_logo_url %}{% endcomment %}\n<!DOCTYPE html>'), { anchor: 'logo', detail: /inside a Liquid comment/ }],
];

for (const [name, stock, expected] of headerRefusals) {
  test(`header override refuses: ${name}`, () => {
    assertRefuses(stock, expected, { override: headerOverride });
  });
}

test('header override refuses when no header text is supplied', () => {
  assertRefuses(makeStock({ contentTable: true }), { anchor: 'header', detail: /lib\/header\.html is required/ }, { override: headerOverride, header: undefined });
  assertRefuses(makeStock({ contentTable: true }), { anchor: 'header', detail: /lib\/header\.html is required/ }, { override: headerOverride, header: '  \n' });
});

test('header override: a root without lib/header.html is a problem only when an entry asks for it', () => {
  const plain = makeRoot({ alpha: { stock: fixtureStock } }, { header: null });
  assert.deepEqual(generate(plain).problems, []);
  const wants = makeRoot({ card: { stock: makeStock({ contentTable: true }), override: headerOverride } }, { header: null });
  const g = generate(wants);
  assert.equal(g.problems.length, 1);
  assert.match(g.problems[0], /lib\/header\.html is missing/);
  assert.deepEqual(g.written, []);
});

test('header override: changing lib header html is a mismatch until regenerate, and only for header ids', () => {
  const root = cleanRoot({ alpha: { stock: fixtureStock }, card: { stock: makeStock({ contentTable: true }), override: headerOverride } });
  const p = paths(root);
  writeFileSync(p.header, fixtureHeader.replace('shop-name__cell', 'shop-name__cell brand'), 'utf8');
  const c = check(root);
  assert.equal(c.mismatches.length, 1);
  assert.match(c.mismatches[0], /^card: /);
  generate(root);
  assert.deepEqual(check(root).mismatches, []);
});

test('header override: a carriage return in lib/header.html is a problem', () => {
  const root = makeRoot({ card: { stock: makeStock({ contentTable: true }), override: headerOverride } }, { header: fixtureHeader.replace('\n', '\r\n') });
  const g = generate(root);
  assert.ok(g.problems.some((m) => /lib\/header\.html contains a carriage return/.test(m)), g.problems.join('\n'));
});
