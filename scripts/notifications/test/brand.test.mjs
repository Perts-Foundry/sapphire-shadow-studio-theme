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
  footerStamp,
  stamp,
  brandCore,
  parseStamp,
  findStamps,
  isValidVersion,
  nextStamp,
  status,
  formatManifest,
  STAMP_RE_SOURCE,
  STAMP_PREFIX,
  CHECK_VERSION_MESSAGE,
  CHECK_BUMP_MESSAGE,
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

const brandOpts = { id: 'synthetic', version: 7, css: fixtureCss, social: fixtureSocial, header: fixtureHeader };
const minimalOpts = { id: 'minimal', version: 7, css: fixtureCss, social: fixtureSocial };

// The two stamp lines a branded file carries, as the rebuild expects them: the comment line first,
// and the footer HTML comment on its own line at `indent`, directly after the social row.
function footerStampLine(id, version, indent) {
  return footerStamp(id, version) + '\n' + indent;
}

// Re-labels a branded text from one (id, version) to another at both stamp positions.
function restamp(text, fromId, fromVersion, toId, toVersion) {
  const a = text.split(commentLine(fromId, fromVersion));
  assert.equal(a.length, 2, 'restamp: comment line not found exactly once');
  const b = a[1].split(footerStamp(fromId, fromVersion));
  assert.equal(b.length, 2, 'restamp: footer stamp not found exactly once');
  return commentLine(toId, toVersion) + b[0] + footerStamp(toId, toVersion) + b[1];
}

function readManifestRaw(root) {
  return readFileSync(paths(root).manifest);
}

function writeManifestObject(root, manifest) {
  writeFileSync(paths(root).manifest, formatManifest(manifest), 'utf8');
}

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
    let stock = readFileSync(p.stock(id), 'utf8');
    assert.equal(stock.length, entry.stockLength, `${id}: stock length drifted from manifest`);
    assert.equal(sha256(stock), entry.stockSha256, `${id}: stock sha256 drifted from manifest`);
    if (skipped.includes(id)) continue;
    const override = entry.override || {};

    // The replace override: each `from` exactly once, swapped for `to`, before anything else is
    // located. Disjoint from the other edits by construction (the generator refuses an overlap).
    for (const r of override.replace || []) {
      const at = stock.indexOf(r.from);
      assert.notEqual(at, -1, `${id}: replace anchor ${JSON.stringify(r.from.slice(0, 40))} not found`);
      assert.equal(stock.indexOf(r.from, at + 1), -1, `${id}: replace anchor ${JSON.stringify(r.from.slice(0, 40))} found more than once`);
      stock = stock.slice(0, at) + r.to + stock.slice(at + r.from.length);
    }

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

    assert.ok(Number.isInteger(entry.version) && entry.version >= 1, `${id}: manifest version is not an integer >= 1 (run npm run notifications:generate)`);
    const rebuilt =
      commentLine(id, entry.version) +
      stock.slice(0, styleStart) +
      '<style>\n' + css + '  </style>' +
      middle +
      social.replace(/\s+$/, '') + '\n' + indent +
      footerStampLine(id, entry.version, indent) +
      stock.slice(disclaimerStart);
    const branded = readFileSync(p.branded(id), 'utf8');
    assertBytesEqual(branded, rebuilt, `${id}.liquid is not a faithful rebuild of stock/${id}.liquid; run npm run notifications:generate`);
    // Both stamps name this id and the manifest version, and nothing else in the file looks like one.
    const stamps = findStamps(branded);
    assert.deepEqual(stamps, [{ id, version: entry.version }, { id, version: entry.version }], `${id}.liquid: stamps do not name the id and manifest version exactly twice`);
    assert.equal(branded.indexOf(footerStamp(id, entry.version)), branded.indexOf(social.replace(/\s+$/, '')) + social.replace(/\s+$/, '').length + 1 + indent.length, `${id}.liquid: footer stamp is not on the line after the social row`);
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
  assert.ok(output.startsWith(commentLine('synthetic', 7)));
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
  const { output, accentRemaining } = brandTemplate(fixtureStock, minimalOpts);
  assert.equal(accentRemaining, 0);
  assertBytesEqual(output, fixtureBranded, 'golden drifted; regenerate fixtures/minimal.branded.liquid deliberately if brand.mjs changed');
});

test('the branded output keeps every stock byte outside the two replaced regions', () => {
  const { output } = brandTemplate(fixtureStock, minimalOpts);
  const { styleStart, styleEnd, footerStart } = locateAnchors(fixtureStock, 'minimal');
  const head = fixtureStock.slice(0, styleStart);
  const middle = fixtureStock.slice(styleEnd, footerStart);
  const tail = fixtureStock.slice(footerStart);
  assert.ok(output.startsWith(commentLine('minimal', 7) + head));
  assert.ok(output.includes('  </style>' + middle + fixtureSocial.trimEnd() + '\n              ' + footerStampLine('minimal', 7, '              ') + tail));
  assert.ok(output.endsWith(tail));
  assert.equal(output.split(commentLine('minimal', 7).trim()).length, 2, 'exactly one generated-by comment');
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
  const { output } = brandTemplate(fixtureStock, minimalOpts);
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

test('commentLine names the stamp, the stock source, ends with exactly one newline, and refuses a bad version', () => {
  const line = commentLine('order_confirmation', 3);
  assert.ok(line.startsWith('{%- comment -%}' + STAMP_PREFIX + ' order_confirmation v3. '));
  assert.ok(line.includes('marketing/notifications/stock/order_confirmation.liquid'));
  assert.ok(line.endsWith('{%- endcomment -%}\n'));
  assert.equal(line.indexOf('\n'), line.length - 1);
  for (const bad of [undefined, null, 0, -1, 1.5, '2', NaN]) {
    assert.throws(() => commentLine('x', bad), /integer version >= 1/, `commentLine accepted ${JSON.stringify(bad)}`);
    assert.throws(() => footerStamp('x', bad), /integer version >= 1/, `footerStamp accepted ${JSON.stringify(bad)}`);
    assert.throws(() => brandTemplate(makeStock(), { ...brandOpts, version: bad }), /integer version >= 1/, `brandTemplate accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(footerStamp('order_confirmation', 3), '<!-- sss-notification order_confirmation v3 -->');
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
  assertBytesEqual(readFileSync(p.branded('alpha'), 'utf8'), restamp(fixtureBranded, 'minimal', 7, 'alpha', 1), 'alpha.liquid: seeded at v1 with both stamps');
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
  // Two lines per id: the file differs, and the core hash no longer matches the recorded one.
  assert.deepEqual(c.mismatches.map((m) => m.split(':')[0]), ['alpha', 'alpha', 'beta', 'beta']);
  assert.deepEqual(c.mismatches.filter((m) => m.endsWith(CHECK_BUMP_MESSAGE)).map((m) => m.split(':')[0]), ['alpha', 'beta']);
  assert.deepEqual(generate(root).written, ['alpha', 'beta']);
  assert.deepEqual(check(root).mismatches, []);
  assert.ok(readFileSync(p.branded('alpha'), 'utf8').includes('.extra { color: #fff; }'));
});

test('changing lib social html is a mismatch until regenerate', () => {
  const root = cleanRoot();
  const p = paths(root);
  writeFileSync(p.social, fixtureSocial.replace('TikTok', 'Tik Tok'), 'utf8');
  assert.deepEqual(new Set(check(root).mismatches.map((m) => m.split(':')[0])), new Set(['alpha', 'beta']));
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
  assert.ok(branded.includes(fixtureSocial.trimEnd() + '\n              ' + footerStampLine('odd', 1, '              ') + DISCLAIMER_ANCHOR));
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

    const version = manifest.templates[id].version;
    const stampNeedle = footerStamp(id, version);
    const stampAt = branded.indexOf(stampNeedle);
    assert.notEqual(stampAt, -1, `${id}.liquid lacks the footer stamp`);
    assert.equal(branded.indexOf(stampNeedle, stampAt + 1), -1, `${id}.liquid has the footer stamp twice`);
    const socialEnd = socialAt + social.length;
    assert.match(branded.slice(socialEnd, stampAt), /^\n[ \t]*$/, `${id}.liquid footer stamp is not on the line right after the social region`);
    const regions = [['style', styleRegion], ['social', socialRegion], ['stamp', branded.slice(stampAt, stampAt + stampNeedle.length)], ['comment', branded.slice(0, branded.indexOf('\n'))]];
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
    assert.equal(branded.slice(0, branded.indexOf('\n') + 1), commentLine(id, version));
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
    .slice(commentLine('synthetic', 7).length)
    .replace('<style>\n' + fixtureCss + '  </style>', '')
    .replace('          ' + header + '\n\n', '')
    .replace(fixtureSocial.trimEnd() + '\n              ' + footerStampLine('synthetic', 7, '              '), '');
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
  assert.deepEqual(new Set(c.mismatches.map((m) => m.split(':')[0])), new Set(['card']));
  generate(root);
  assert.deepEqual(check(root).mismatches, []);
});

// --- 6. the replace override ---------------------------------------------------------------------

test('replace override: each entry is swapped exactly once and the output equals branding the patched stock', () => {
  const stock = makeStock();
  const replace = [
    { from: '<p>{{ greeting }}</p>', to: '<p class="greeting">{{ greeting }}</p>' },
    { from: 'Questions? Reply to this email.', to: 'Questions? Just reply.' },
  ];
  const { output } = brandTemplate(stock, { ...brandOpts, override: { replace } });
  let patched = stock;
  for (const r of replace) patched = patched.replace(r.from, r.to);
  assertBytesEqual(output, brandTemplate(patched, brandOpts).output, 'replace output differs from branding the patched stock');
  assert.ok(output.includes('<p class="greeting">{{ greeting }}</p>'));
  assert.ok(!output.includes('<p>{{ greeting }}</p>'));
});

test('replace override composes with the header override', () => {
  const stock = makeStock({ contentTable: true });
  const override = { header: true, replace: [{ from: '<p>{{ greeting }}</p>', to: '<p class="greeting">{{ greeting }}</p>' }] };
  const { output } = brandTemplate(stock, { ...brandOpts, override });
  assert.ok(output.includes(fixtureHeader.trimEnd()));
  assert.ok(!output.includes(LOGO_IF_TAG));
  assert.ok(output.includes('<p class="greeting">{{ greeting }}</p>'));
});

const replaceRefusals = [
  ['from not found', { replace: [{ from: '<p>nowhere</p>', to: 'x' }] }, { anchor: 'replace[0]', detail: /not found/ }],
  ['from found twice', { replace: [{ from: '<tr>', to: '<tr class="x">' }] }, { anchor: 'replace[0]', detail: /found \d+ times/ }],
  ['an empty list', { replace: [] }, { anchor: 'replace', detail: /non-empty array/ }],
  ['not an array', { replace: { from: 'a', to: 'b' } }, { anchor: 'replace', detail: /non-empty array/ }],
  ['an entry without to', { replace: [{ from: '<p>{{ greeting }}</p>' }] }, { anchor: 'replace', detail: /entry 0 needs/ }],
  ['an entry with an empty from', { replace: [{ from: '', to: 'x' }] }, { anchor: 'replace', detail: /entry 0 needs/ }],
  ['a replacement inside the style block', { replace: [{ from: '.button__cell { background: {{ shop.email_accent_color }}; }', to: '' }] }, { anchor: 'replace', detail: /overlaps another edit/ }],
  ['a replacement inside the footer disclaimer paragraph', { replace: [{ from: DISCLAIMER_ANCHOR, to: '<p class="disclaimer__subtext x">' }] }, { anchor: 'replace', detail: /overlaps another edit/ }],
];

for (const [name, override, expected] of replaceRefusals) {
  test(`replace override refuses: ${name}`, () => {
    assertRefuses(makeStock(), expected, { override });
  });
}

test('replace override refuses an anchor that sits inside a Liquid comment', () => {
  const stock = makeStock().replace('<!DOCTYPE html>', '{% comment %}<p>{{ greeting }}</p>{% endcomment %}\n<!DOCTYPE html>');
  assertRefuses(stock, { anchor: 'replace[0]', detail: /inside a Liquid comment/ }, { override: { replace: [{ from: '<p>{{ greeting }}</p>', to: 'x' }] } });
});

test('replace override: a root entry generates, checks clean, and drifts when the manifest entry changes', () => {
  const replace = [{ from: '<p>{{ greeting }}</p>', to: '<p class="greeting">{{ greeting }}</p>' }];
  const root = cleanRoot({ patched: { stock: makeStock(), override: { replace } } });
  const p = paths(root);
  assert.ok(readFileSync(p.branded('patched'), 'utf8').includes('class="greeting"'));
  assert.deepEqual(check(root).mismatches, []);
  const manifest = JSON.parse(readFileSync(p.manifest, 'utf8'));
  manifest.templates.patched.override.replace[0].to = '<p class="hello">{{ greeting }}</p>';
  writeFileSync(p.manifest, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  assert.deepEqual(new Set(check(root).mismatches.map((m) => m.split(':')[0])), new Set(['patched']));
});

test('header override: a carriage return in lib/header.html is a problem', () => {
  const root = makeRoot({ card: { stock: makeStock({ contentTable: true }), override: headerOverride } }, { header: fixtureHeader.replace('\n', '\r\n') });
  const g = generate(root);
  assert.ok(g.problems.some((m) => /lib\/header\.html contains a carriage return/.test(m)), g.problems.join('\n'));
});

// --- 7. versioning -------------------------------------------------------------------------------
// Each manifest entry carries `version` and `brandedSha256` (the hash of the stamp-free core).
// generate seeds and bumps them; check refuses disagreement; --status prints the committed view.

function readVersion(root, id) {
  return JSON.parse(readFileSync(paths(root).manifest, 'utf8')).templates[id];
}

test('stamp: the stamped outputs differ by version and neither hashes to the recorded core hash', () => {
  const { core, footerAt } = brandCore(makeStock(), brandOpts);
  const v1 = stamp(core, 'synthetic', 1, footerAt);
  const v2 = stamp(core, 'synthetic', 2, footerAt);
  assert.notEqual(v1, v2);
  assert.equal(restamp(v1, 'synthetic', 1, 'synthetic', 2), v2, 'the two outputs differ only at the two stamps');
  assert.notEqual(sha256(core), sha256(v1));
  assert.notEqual(sha256(core), sha256(v2));
  assert.ok(!core.includes(STAMP_PREFIX), 'core carries no stamp');
  assert.equal(brandTemplate(makeStock(), brandOpts).core, core, 'brandTemplate exposes the same core');
  assert.equal(brandTemplate(makeStock(), { ...brandOpts, version: 1 }).output, v1);
  assert.throws(() => stamp(core, 'synthetic', 1, -1), /footer offset/);
  assert.throws(() => stamp(core, 'synthetic', 1, footerAt + 3), /start of a line/);
});

test('parseStamp and findStamps read both stamp positions, ids with digits and underscores, and refuse near misses', () => {
  const stock = makeStock();
  for (const id of ['order_confirmation', 'pos_exchange_v2_receipt', 'a1', 'x']) {
    const { output } = brandTemplate(stock, { ...brandOpts, id, version: 12 });
    assert.deepEqual(findStamps(output), [{ id, version: 12 }, { id, version: 12 }]);
    assert.deepEqual(parseStamp(output), { id, version: 12, count: 2, consistent: true });
    assert.deepEqual(parseStamp(output.split('\n')[0]), { id, version: 12, count: 1, consistent: true });
    assert.deepEqual(parseStamp(footerStamp(id, 12)), { id, version: 12, count: 1, consistent: true });
  }
  assert.equal(parseStamp('nothing here'), null);
  assert.equal(parseStamp(''), null);
  assert.equal(parseStamp('sss-notification order_confirmation v0'), null, 'v0 is not a version');
  assert.equal(parseStamp('sss-notification order_confirmation v01'), null, 'a leading zero is not a version');
  assert.equal(parseStamp('sss-notification Order v1'), null, 'uppercase is not an id');
  assert.equal(parseStamp('xsss-notification order v1'), null, 'the prefix must start a word');
  assert.equal(parseStamp('sss-notification order v1a'), null, 'the version must end the token');
  assert.deepEqual(parseStamp('sss-notification order v1 and sss-notification other v2'), { id: 'order', version: 1, count: 2, consistent: false });
  assert.equal(STAMP_RE_SOURCE.includes('sss-notification'), true);
  assert.ok(new RegExp(STAMP_RE_SOURCE).test(commentLine('id_9', 3)));
  assert.ok(new RegExp(STAMP_RE_SOURCE).test(footerStamp('id_9', 3)));
});

test('nextStamp: the seed and bump table', () => {
  const h = 'a'.repeat(64);
  const g = 'b'.repeat(64);
  assert.deepEqual(nextStamp({}, h), { version: 1, brandedSha256: h, bumped: true, prevVersion: null, seeded: true });
  assert.deepEqual(nextStamp({ version: 4 }, h), { version: 4, brandedSha256: h, bumped: false, prevVersion: 4, seeded: true });
  assert.deepEqual(nextStamp({ brandedSha256: h }, h), { version: 1, brandedSha256: h, bumped: true, prevVersion: null, seeded: true });
  assert.deepEqual(nextStamp({ brandedSha256: g }, h), { version: 1, brandedSha256: h, bumped: true, prevVersion: null, seeded: true });
  assert.deepEqual(nextStamp({ version: 4, brandedSha256: g }, h), { version: 5, brandedSha256: h, bumped: true, prevVersion: 4, seeded: false });
  assert.deepEqual(nextStamp({ version: 4, brandedSha256: h }, h), { version: 4, brandedSha256: h, bumped: false, prevVersion: 4, seeded: false });
  for (const bad of ['2', 1.5, 0, -1, null, true]) {
    const r = nextStamp({ version: bad, brandedSha256: h }, h);
    assert.match(r.problem, /version must be an integer >= 1/, `nextStamp accepted ${JSON.stringify(bad)}`);
  }
  for (const v of [1, 2, 10]) assert.ok(isValidVersion(v));
  for (const v of ['1', 0, -3, 1.2, undefined, null, NaN, Infinity]) assert.ok(!isValidVersion(v));
});

test('seed and bump sequence over one synthetic root', async (t) => {
  const root = makeRoot({
    plain: { stock: makeStock() },
    anchored: { stock: makeStock().replace(`\n          ${FOOTER_TABLE_ANCHOR}`, `\n          <p class="disclaimer__subtext">Tracking number: 123</p>\n          ${FOOTER_TABLE_ANCHOR}`), override: { footerAnchor: '<p class="disclaimer__subtext">Questions?' } },
    banded: { stock: makeStock({ contentTable: true }), override: { header: true } },
  });
  const p = paths(root);
  const ids = ['anchored', 'banded', 'plain'];
  let manifestBytes;

  await t.test('first generate seeds v1 everywhere and reports unversioned -> v1', () => {
    const g = generate(root);
    assert.deepEqual(g.problems, []);
    assert.deepEqual(g.written, ids);
    assert.deepEqual(g.bumps, ids.map((id) => ({ id, prevVersion: null, version: 1 })));
    for (const id of ids) {
      const e = readVersion(root, id);
      assert.equal(e.version, 1);
      assert.equal(e.brandedSha256, sha256(brandCore(readFileSync(p.stock(id), 'utf8'), { ...brandOpts, id, override: e.override }).core));
      assert.deepEqual(findStamps(readFileSync(p.branded(id), 'utf8')), [{ id, version: 1 }, { id, version: 1 }]);
    }
    assert.deepEqual(check(root).mismatches, []);
    manifestBytes = readManifestRaw(root);
  });

  await t.test('a second generate leaves the manifest bytes and every file identical and no .tmp behind', () => {
    const before = snapshotTree(root);
    const g = generate(root);
    assert.deepEqual(g.bumps, []);
    assert.ok(readManifestRaw(root).equals(manifestBytes));
    assertTreesEqual(snapshotTree(root), before, 'second generate');
    assert.ok(!readdirSync(p.dir).some((f) => f.endsWith('.tmp')));
  });

  await t.test('a css change bumps every id to v2 and rewrites the manifest', () => {
    writeFileSync(p.css, fixtureCss + '    .extra { color: #fff; }\n', 'utf8');
    const g = generate(root);
    assert.deepEqual(g.bumps, ids.map((id) => ({ id, prevVersion: 1, version: 2 })));
    assert.ok(!readManifestRaw(root).equals(manifestBytes));
    for (const id of ids) {
      assert.equal(readVersion(root, id).version, 2);
      assert.deepEqual(findStamps(readFileSync(p.branded(id), 'utf8')), [{ id, version: 2 }, { id, version: 2 }]);
    }
    assert.deepEqual(check(root).mismatches, []);
    manifestBytes = readManifestRaw(root);
  });

  await t.test('a per-id override change bumps only that id', () => {
    const manifest = JSON.parse(readFileSync(p.manifest, 'utf8'));
    manifest.templates.plain.override = { replace: [{ from: '<p>{{ greeting }}</p>', to: '<p class="g">{{ greeting }}</p>' }] };
    writeManifestObject(root, manifest);
    const g = generate(root);
    assert.deepEqual(g.bumps, [{ id: 'plain', prevVersion: 2, version: 3 }]);
    assert.equal(readVersion(root, 'plain').version, 3);
    assert.equal(readVersion(root, 'anchored').version, 2);
    assert.equal(readVersion(root, 'banded').version, 2);
    assert.deepEqual(check(root).mismatches, []);
    manifestBytes = readManifestRaw(root);
  });

  await t.test('a reason edit changes the manifest only in that field and bumps nothing', () => {
    const manifest = JSON.parse(readFileSync(p.manifest, 'utf8'));
    manifest.templates.plain.override.reason = 'because';
    writeManifestObject(root, manifest);
    const expected = readManifestRaw(root);
    const before = snapshotTree(root);
    const g = generate(root);
    assert.deepEqual(g.bumps, []);
    assert.ok(readManifestRaw(root).equals(expected));
    assertTreesEqual(snapshotTree(root), before, 'reason edit');
    assert.equal(readVersion(root, 'plain').version, 3);
    manifestBytes = readManifestRaw(root);
  });

  await t.test('a simulated re-record (changed stock, entry keeps version and hash) bumps that id only and preserves key order', () => {
    const newStock = makeStock().replace('Hello', 'Hallo');
    writeFileSync(p.stock('plain'), newStock, 'utf8');
    const manifest = JSON.parse(readFileSync(p.manifest, 'utf8'));
    const prev = manifest.templates.plain;
    // record-stock's shape: { ...prev, stockSha256, stockLength }, override dropped on a content change.
    const { override, ...rest } = prev;
    manifest.templates.plain = { ...rest, stockSha256: sha256(newStock), stockLength: newStock.length };
    writeManifestObject(root, manifest);
    const keysBefore = Object.keys(JSON.parse(readFileSync(p.manifest, 'utf8')).templates.plain);
    const g = generate(root);
    assert.deepEqual(g.bumps, [{ id: 'plain', prevVersion: 3, version: 4 }]);
    assert.deepEqual(Object.keys(readVersion(root, 'plain')), keysBefore, 'key order churned');
    assert.equal(readVersion(root, 'anchored').version, 2);
    const third = readManifestRaw(root);
    generate(root);
    assert.ok(readManifestRaw(root).equals(third), 'third generate rewrote the manifest');
    assert.deepEqual(check(root).mismatches, []);
  });

  await t.test('a hand edit of a version 4 -> 9 followed by generate does not bump; files carry v9; check is clean', () => {
    const manifest = JSON.parse(readFileSync(p.manifest, 'utf8'));
    manifest.templates.plain.version = 9;
    writeManifestObject(root, manifest);
    const c = check(root);
    assert.deepEqual(c.mismatches.map((m) => m.split(':')[0]), ['plain'], 'the file still says v4, so it is a mismatch until regenerate');
    assert.match(c.mismatches[0], /differs from regenerated output/);
    const g = generate(root);
    assert.deepEqual(g.bumps, []);
    assert.equal(readVersion(root, 'plain').version, 9);
    assert.deepEqual(findStamps(readFileSync(p.branded('plain'), 'utf8')), [{ id: 'plain', version: 9 }, { id: 'plain', version: 9 }]);
    assert.deepEqual(check(root).mismatches, []);
  });

  await t.test('version 9 with a changed core becomes 10', () => {
    writeFileSync(p.stock('plain'), readFileSync(p.stock('plain'), 'utf8').replace('Hallo', 'Hullo'), 'utf8');
    const manifest = JSON.parse(readFileSync(p.manifest, 'utf8'));
    manifest.templates.plain.stockSha256 = sha256(readFileSync(p.stock('plain'), 'utf8'));
    writeManifestObject(root, manifest);
    assert.deepEqual(generate(root).bumps, [{ id: 'plain', prevVersion: 9, version: 10 }]);
  });

  await t.test('partial seeds: hash present without version seeds v1; version present without hash keeps the version', () => {
    const manifest = JSON.parse(readFileSync(p.manifest, 'utf8'));
    delete manifest.templates.anchored.version;
    delete manifest.templates.banded.brandedSha256;
    writeManifestObject(root, manifest);
    const c = check(root);
    assert.ok(c.mismatches.includes(`anchored: ${CHECK_VERSION_MESSAGE}`), c.mismatches.join('\n'));
    assert.ok(c.mismatches.includes(`banded: ${CHECK_BUMP_MESSAGE}`), c.mismatches.join('\n'));
    const g = generate(root);
    assert.deepEqual(g.bumps, [{ id: 'anchored', prevVersion: null, version: 1 }, { id: 'banded', prevVersion: 2, version: 2 }]);
    assert.equal(readVersion(root, 'anchored').version, 1);
    assert.equal(readVersion(root, 'banded').version, 2);
    assert.equal(typeof readVersion(root, 'banded').brandedSha256, 'string');
    assert.deepEqual(check(root).mismatches, []);
  });

  await t.test('a malformed version is a problem: generate refuses and writes nothing', () => {
    for (const bad of ['2', 1.5, 0, -1]) {
      const manifest = JSON.parse(readFileSync(p.manifest, 'utf8'));
      manifest.templates.plain.version = bad;
      writeManifestObject(root, manifest);
      const before = snapshotTree(root);
      const g = generate(root);
      assert.deepEqual(g.written, [], `generate wrote with version ${JSON.stringify(bad)}`);
      assert.deepEqual(g.problems, [`plain: version must be an integer >= 1, got ${JSON.stringify(bad)}`]);
      assertTreesEqual(snapshotTree(root), before, `generate touched the tree with version ${JSON.stringify(bad)}`);
      const c = check(root);
      assert.deepEqual(c.problems, g.problems);
      assert.ok(!c.mismatches.some((m) => m.startsWith('plain:')), 'a refused id is not also a mismatch');
    }
  });
});

test('generate with a problem in one id leaves manifest, branded files and directory listing identical', () => {
  const root = cleanRoot();
  const p = paths(root);
  writeFileSync(p.css, fixtureCss + '    .bump { color: #000; }\n', 'utf8');
  writeFileSync(p.stock('gamma'), makeStock({ disclaimers: 0 }), 'utf8');
  const manifest = JSON.parse(readFileSync(p.manifest, 'utf8'));
  manifest.templates.gamma = stockEntry(makeStock({ disclaimers: 0 }));
  writeManifestObject(root, manifest);
  const before = snapshotTree(root);
  const g = generate(root);
  assert.equal(g.problems.length, 1);
  assert.deepEqual(g.bumps, []);
  assertTreesEqual(snapshotTree(root), before, 'a refused generate must not bump or write');
});

test('crash recovery: a manifest already bumped but files not yet written is healed by a rerun without a second bump', () => {
  const root = cleanRoot();
  const p = paths(root);
  writeFileSync(p.css, fixtureCss + '    .bump { color: #000; }\n', 'utf8');
  // Simulate the crash: write the bumped manifest by hand, leave the v1 files in place.
  const { stamps } = plan(root);
  const manifest = JSON.parse(readFileSync(p.manifest, 'utf8'));
  for (const [id, s] of stamps) {
    assert.equal(s.version, 2);
    manifest.templates[id].version = s.version;
    manifest.templates[id].brandedSha256 = s.brandedSha256;
  }
  writeManifestObject(root, manifest);
  const c = check(root);
  assert.deepEqual(c.mismatches.map((m) => m.split(':')[0]), ['alpha', 'beta']);
  assert.ok(c.mismatches.every((m) => /differs from regenerated output/.test(m)), 'only the files are behind');
  const g = generate(root);
  assert.deepEqual(g.bumps, []);
  assert.deepEqual(g.written, ['alpha', 'beta']);
  assert.equal(readVersion(root, 'alpha').version, 2);
  assert.deepEqual(check(root).mismatches, []);
});

test('generate writes the manifest before the files: a crash on the first file leaves a bumped manifest and old files, which the rerun heals', () => {
  const root = cleanRoot();
  const p = paths(root);
  writeFileSync(p.css, fixtureCss + '    .bump { color: #000; }\n', 'utf8');
  // A directory where the first branded file goes makes renameSync throw after the manifest write.
  rmSync(p.branded('alpha'));
  mkdirSync(p.branded('alpha'));
  assert.throws(() => generate(root), /EISDIR|EPERM|ENOTEMPTY|EEXIST/);
  assert.equal(readVersion(root, 'alpha').version, 2, 'the manifest was written first');
  assert.equal(readVersion(root, 'beta').version, 2);
  rmSync(p.branded('alpha'), { recursive: true });
  const c = check(root);
  assert.ok(c.mismatches.every((m) => /differs from regenerated output|is missing/.test(m)), c.mismatches.join('\n'));
  assert.ok(!c.mismatches.some((m) => m.endsWith(CHECK_BUMP_MESSAGE)), 'the hash is already recorded, so no bump message');
  const g = generate(root);
  assert.deepEqual(g.bumps, [], 'the rerun does not bump again');
  assert.deepEqual(g.written, ['alpha', 'beta']);
  assert.deepEqual(check(root).mismatches, []);
});

test('plan() is side-effect free: the manifest on disk and the parsed object are unchanged', () => {
  const root = cleanRoot();
  const p = paths(root);
  writeFileSync(p.css, fixtureCss + '    .bump { color: #000; }\n', 'utf8');
  const before = snapshotTree(root);
  const r = plan(root);
  assert.equal(r.stamps.get('alpha').version, 2, 'plan computes the bump');
  assert.equal(r.manifest.templates.alpha.version, 1, 'plan does not apply it to the object');
  assert.equal(r.manifest.templates.alpha.brandedSha256, readVersion(root, 'alpha').brandedSha256);
  assertTreesEqual(snapshotTree(root), before, 'plan wrote something');
  assert.ok(r.outputs.get('alpha').startsWith(commentLine('alpha', 2)), 'outputs are stamped with the would-be version');
});

test('check classes, each with its pinned message', () => {
  const cases = [
    ['file differs', (m, p) => writeFileSync(p.branded('alpha'), readFileSync(p.branded('alpha'), 'utf8') + '\n', 'utf8'), /^alpha: alpha\.liquid differs from regenerated output/],
    ['css changed without regenerate', (m, p) => writeFileSync(p.css, fixtureCss + '    .x { color: #000; }\n', 'utf8'), new RegExp(`^alpha: ${CHECK_BUMP_MESSAGE}$`)],
    ['version absent', (m) => { delete m.templates.alpha.version; }, new RegExp(`^alpha: ${CHECK_VERSION_MESSAGE}$`)],
    ['hash absent', (m) => { delete m.templates.alpha.brandedSha256; }, new RegExp(`^alpha: ${CHECK_BUMP_MESSAGE}$`)],
  ];
  for (const [name, mutate, re] of cases) {
    const root = cleanRoot();
    const p = paths(root);
    const manifest = JSON.parse(readFileSync(p.manifest, 'utf8'));
    mutate(manifest, p);
    writeManifestObject(root, manifest);
    const c = check(root);
    assert.deepEqual(c.problems, [], name);
    assert.ok(c.mismatches.some((x) => re.test(x)), `${name}: ${JSON.stringify(c.mismatches)}`);
  }
  for (const bad of ['2', 1.5, 0, -1]) {
    const root = cleanRoot();
    const p = paths(root);
    const manifest = JSON.parse(readFileSync(p.manifest, 'utf8'));
    manifest.templates.alpha.version = bad;
    writeManifestObject(root, manifest);
    const c = check(root);
    assert.deepEqual(c.problems, [`alpha: version must be an integer >= 1, got ${JSON.stringify(bad)}`]);
    assert.ok(!c.mismatches.some((m) => m.startsWith('alpha:')));
    assert.ok(check(root).mismatches.length === 0, 'beta is still clean');
  }
});

test('a manifest with no version anywhere is a mismatch on every id, never "unversioned, pass"', () => {
  const root = makeRoot({ alpha: { stock: fixtureStock }, beta: { stock: makeStock() } });
  const p = paths(root);
  // Branded files written by hand at v1 so only the manifest is behind.
  for (const [id, s] of plan(root).outputs) writeFileSync(p.branded(id), s, 'utf8');
  const c = check(root);
  assert.deepEqual(c.problems, []);
  assert.deepEqual(c.mismatches, [`alpha: ${CHECK_VERSION_MESSAGE}`, `beta: ${CHECK_VERSION_MESSAGE}`]);
});

test('status() reports the committed view and never the would-be-bumped one, and --status writes nothing', () => {
  const root = cleanRoot();
  const p = paths(root);
  writeFileSync(p.css, fixtureCss + '    .bump { color: #000; }\n', 'utf8');
  const before = snapshotTree(root);
  const rows = status(root);
  assert.deepEqual(rows.map((r) => [r.id, r.version]), [['alpha', 1], ['beta', 1]]);
  assert.equal(rows[0].brandedSha256, readVersion(root, 'alpha').brandedSha256);
  const r = runCli(['--status', '--root', root]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `alpha 1 ${rows[0].brandedSha256.slice(0, 12)}\nbeta 1 ${rows[1].brandedSha256.slice(0, 12)}\n`);
  assertTreesEqual(snapshotTree(root), before, '--status wrote something');
  const manifest = JSON.parse(readFileSync(p.manifest, 'utf8'));
  delete manifest.templates.alpha.version;
  manifest.templates.beta.skip = 'left stock';
  writeManifestObject(root, manifest);
  assert.match(runCli(['--status', '--root', root]).stdout, /^alpha unversioned [0-9a-f]{12}\nbeta 1 [0-9a-f]{12} skip\n$/);
});

test('CLI: the bump report on stdout is pinned', () => {
  const root = makeRoot({ alpha: { stock: fixtureStock }, beta: { stock: makeStock() } });
  const first = runCli(['--root', root]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, 'alpha: unversioned -> v1\nbeta: unversioned -> v1\nnotifications:generate wrote 2 file(s), 2 version(s) seeded or bumped\n');
  const second = runCli(['--root', root]);
  assert.equal(second.stdout, 'notifications:generate wrote 2 file(s), 0 version(s) seeded or bumped\n');
  writeFileSync(paths(root).css, fixtureCss + '    .bump { color: #000; }\n', 'utf8');
  const third = runCli(['--root', root]);
  assert.equal(third.stdout, 'alpha: v1 -> v2\nbeta: v1 -> v2\nnotifications:generate wrote 2 file(s), 2 version(s) seeded or bumped\n');
  const bad = runCli(['--check', '--root', root]);
  assert.equal(bad.status, 0, 'clean after regenerate');
  writeFileSync(paths(root).css, fixtureCss + '    .bump { color: #111; }\n', 'utf8');
  const stale = runCli(['--check', '--root', root]);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, new RegExp(`error: alpha: ${CHECK_BUMP_MESSAGE}`));
});

test('the real manifest: every entry carries an integer version >= 1 and a 64-hex brandedSha256', () => {
  for (const row of status(repoRoot)) {
    assert.ok(row.version !== null, `${row.id}: unversioned`);
    assert.match(row.brandedSha256 || '', /^[0-9a-f]{64}$/, `${row.id}: bad brandedSha256`);
  }
});
