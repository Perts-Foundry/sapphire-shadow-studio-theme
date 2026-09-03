// scripts/notifications/verify-render.mjs checks a rendered notification against the brand. The
// good fixtures are built here from the real lib/brand-style.css palette (one per shape: plain,
// a footerAnchor id with a body-side disclaimer, a header-override id, with and without the
// Shop-app button, and the gift-card layout whose body copy is table cells rather than
// paragraphs), and each defect is a single programmatic mutation of a good fixture, asserted
// to fail exactly its own check with every other check passing. One committed fixture is derived
// from a real preview dump (fixtures/render.order_confirmation.html, scrubbed to synthetic data
// and patched to the current stylesheet) so the parser meets real inlined output once.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { verifyRender, parsePalette, formatResults, previewHtmlFromResponse, CHECKS, SHOP_APP_BUTTON, PALETTE_TOKENS } from '../verify-render.mjs';
import { paths, readManifest, footerStamp, sha256 } from '../brand.mjs';
import { parseHtml, select, closest, hasClass } from '../html-walk.mjs';
import { fnv1a } from '../dump.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const repoRoot = path.resolve(here, '../../..');
const script = path.join(here, '..', 'verify-render.mjs');
const css = readFileSync(paths(repoRoot).css, 'utf8');
const palette = parsePalette(css);
const EM_DASH = '\u2014';

const CHECK_NAMES = CHECKS.map(([name]) => name);

// A manifest of exactly the ids the fixtures use, at known versions.
const manifest = { templates: { plain_id: { version: 3 }, anchored_id: { version: 1 }, banded_id: { version: 12 }, order_confirmation: { version: 1 } } };

const ICON = (name) => `<img src="https://cdn.shopify.com/s/files/1/0958/0874/9868/files/email-icon-${name}.png" alt="" width="28" height="28" style="vertical-align: middle; border-width: 0;">`;

// The brand media block as the inliner keeps it in the head: reflowed, one declaration per line.
function mediaBlock(rules = palette.mobileRules) {
  const body = rules.map((r) => `  ${r.selector} {\n    ${Object.entries(r.declarations).map(([p, d]) => `${p}: ${d.value}${d.important ? ' !important' : ''};`).join(' ')}\n  }`).join('\n');
  return `@media (max-width: 600px) {\n  .container {\n    width: 94% !important;\n  }\n${body}\n}\n`;
}

// A rendered notification the way the inliner emits one: colours inlined as style/bgcolor, the
// non-inlinable rules kept in the head. `shape` picks the template family; `shopApp` adds the
// stock Shop-app button cell next to the primary one.
function makeRender({ id = 'plain_id', version = 3, shape = 'plain', body = 'paragraphs', copy = true, shopApp = false, stamp = true } = {}) {
  const P = palette;
  const button = `<td class="button__cell button__cell--primary" width="50%" style="border-radius: 4px;" align="center" bgcolor="${P.button.toUpperCase()}"><a href="#" class="button__text" style="color: #ffffff;">View your order</a></td>`;
  const shop = shopApp ? `<td class="button__cell--separator" style="width: 15px;"></td><td class="button__cell button__cell--shop-app" width="50%" style="border-radius: 4px; color-scheme: light only;" align="center" bgcolor="${SHOP_APP_BUTTON.toUpperCase()}"><a href="#" class="button__text button__text--shop-app" style="color: #ffffff;">Track order with Shop</a></td>` : '';
  const headerInner = shape === 'header'
    ? `<img src="https://cdn.shopify.com/s/files/1/0958/0874/9868/files/logo.png" alt="Shop" width="200" style="max-width: 100%; height: auto;">`
    : `<h1 class="shop-name__text" style="font-size: 30px;"><a href="#" style="color: #ffffff;">Shop</a></h1>`;
  const bodyDisclaimer = shape === 'anchored' ? `<p class="disclaimer__subtext" style="color: ${P.bodyText}; font-size: 12px;">Tracking number: <a href="#" style="color: ${P.button};">123</a></p>` : '';
  const stampLine = stamp ? `${footerStamp(id, version)}\n` : '';
  // `body: 'cells'` is the layout the gift-card family and return_label_notification have: the whole
  // body lives in table cells, so the render carries no body paragraph anywhere, and there is no
  // .section row to hold the one the subtotal table would contribute. `copy: false` then empties
  // the white card the way a content branch that rendered nothing would.
  const cells = body === 'cells';
  const contentCopy = !cells
    ? `<h2 style="font-weight: bold; font-size: 30px; color: ${P.heading};">Thank you for your order!</h2>
<p style="color: ${P.bodyText}; line-height: 150%; font-size: 16px;">We are getting your order ready.</p>
${bodyDisclaimer}`
    : copy
      ? `<table align="center" class="row giftcard__topmargin" style="width: 100%;">
<tr>
<td class="giftcard__title" style="font-family: Helvetica, Arial, sans-serif; font-size: 24px; color: ${P.bodyText};" align="center">Here is your gift card.</td>
</tr>
</table>
<table align="center" class="giftcard__topmargin">
<tr>
<td class="giftcard__balance" style="font-family: Helvetica, Arial, sans-serif; font-size: 40px; color: ${P.bodyText};" align="center">$50.00</td>
</tr>
<tr>
<td class="giftcard__smalltext" style="font-family: Helvetica, Arial, sans-serif; font-size: 14px; color: #737373;" align="center">Expires January 1, 2027</td>
</tr>
</table>`
      : `<table align="center" class="row giftcard__topmargin" style="width: 100%;">
<tr>
<td class="giftcard__title" align="center">&nbsp;</td>
</tr>
</table>`;
  const actions = cells && !copy
    ? ''
    : `<table class="row actions" style="width: 100%;">
<tr>
<td class="actions__cell" style="padding-bottom: 20px;">
<table class="button main-action-cell" style="float: left;">
<tr>
${button}${shop}
</tr>
</table>
</td>
</tr>
</table>`;
  return `<html><head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<style>body {
margin: 0;
}
a:hover {
color: ${P.button};
}
.footer .disclaimer__subtext a:hover {
color: ${P.footerLink}; text-decoration: underline;
}
${mediaBlock()}</style>
<title>Order #9999 confirmed</title>
</head>
<body style="margin: 0;" bgcolor="${P.page}">
<table class="body" style="height: 100% !important; width: 100% !important;" bgcolor="${P.page}">
<tr>
<td style="font-family: Helvetica, Arial, sans-serif;">
<table class="header row" style="width: 100%; margin: 0;" bgcolor="${P.page}">
<tr>
<td class="header__cell" style="padding: 24px 12px 0;">
<center>
<table class="container" style="width: 600px; border-color: ${P.navy}; border-style: solid; border-width: 28px 32px;" bgcolor="${P.navy}">
<tr>
<td>
<table class="row" style="width: 100%;">
<tr>
<td class="shop-name__cell" style="display: block; text-align: center;">
${headerInner}
</td>
</tr>
</table>
</td>
</tr>
</table>
</center>
</td>
</tr>
</table>
<table class="row content" style="width: 100%;" bgcolor="${P.page}">
<tr>
<td class="content__cell" style="padding: 0 12px;">
<center>
<table class="container" style="width: 600px; border-color: ${P.white}; border-style: solid; border-width: 36px 32px 8px;" bgcolor="${P.white}">
<tr>
<td>
${contentCopy}
${actions}
</td>
</tr>
</table>
</center>
</td>
</tr>
</table>
${cells ? '' : `<table class="row section" style="width: 100%;" bgcolor="${P.page}">
<tr>
<td class="section__cell" style="padding: 0 12px;">
<center>
<table class="container" style="width: 600px; border-color: ${P.white}; border-style: solid; border-width: 24px 32px;" bgcolor="${P.white}">
<tr>
<td>
<h3 style="font-weight: bold; font-size: 20px; color: ${P.heading};">Order summary</h3>
<h4 class="order-list__delivery-method-type" style="font-weight: bold; font-size: 12px; color: ${P.eyebrow};">Shipping items</h4>
<table class="row subtotal-lines" style="width: 100%; margin-top: 15px; border-top-width: 1px;">
<tr>
<td class="subtotal-spacer" style="width: 55%;"></td>
<td>
<table class="row subtotal-table" style="width: 100%;">
<tr>
<td class="subtotal-line__title"><p style="color: #555555;"><span>Subtotal</span></p></td>
<td class="subtotal-line__value"><strong style="font-size: 16px; color: #555;">$12.99</strong></td>
</tr>
</table>
</td>
</tr>
</table>
</td>
</tr>
</table>
</center>
</td>
</tr>
</table>`}
<table class="row footer" style="width: 100%; border-top-width: 0; margin: 0;" bgcolor="${P.page}">
<tr>
<td class="footer__cell" style="padding: 0 12px 24px;">
<center>
<table class="container" style="width: 600px; border-color: ${P.navy}; border-style: solid; border-width: 28px 32px; text-align: center;" bgcolor="${P.navy}">
<tr>
<td>
<table role="presentation" class="ssb-social" cellpadding="0" cellspacing="0" border="0" align="center" style="margin: 0 auto 18px;">
<tr>
<td align="center" style="padding: 0 8px; white-space: nowrap;"><a href="#" style="color: ${P.footerText}; text-decoration: none;">${ICON('instagram')}&nbsp;Instagram</a></td>
<td align="center" style="padding: 0 8px; white-space: nowrap;"><a href="#" style="color: ${P.footerText}; text-decoration: none;">${ICON('facebook')}&nbsp;Facebook</a></td>
<td align="center" style="padding: 0 8px; white-space: nowrap;"><a href="#" style="color: ${P.footerText}; text-decoration: none;">${ICON('tiktok')}&nbsp;TikTok</a></td>
</tr>
</table>
<p class="ssb-shop-name" style="font-size: 14px; color: ${P.shopName}; margin: 0 0 10px;" align="center">Sapphire Shadow Studio</p>
${stampLine}<p class="disclaimer__subtext" style="color: ${P.footerText}; line-height: 18px; font-size: 12px; margin: 15px 0 0;" align="center">If you have any questions, reply to this email or contact us at <a href="mailto:hello@example.com" style="color: ${P.footerLink}; text-decoration: underline;">hello@example.com</a>.<!-- shopify-shop-marketplace-footer --></p>
</td>
</tr>
</table>
</center>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body></html>
`;
}

function run(html, opts) {
  return verifyRender(html, { manifest, css, ...opts });
}

function assertAllPass(result, label) {
  const failed = result.results.filter((r) => !r.ok);
  assert.deepEqual(failed, [], `${label}: ${failed.map((r) => `${r.name}: ${r.detail}`).join(' | ')}`);
  assert.equal(result.passed, CHECKS.length, `${label}: PASS count must equal the number of checks`);
  assert.equal(result.failed, 0);
}

function assertOnlyFails(result, name, label) {
  const failed = result.results.filter((r) => !r.ok).map((r) => r.name);
  assert.deepEqual(failed, [name], `${label}: expected only ${name} to fail, got ${JSON.stringify(result.results.filter((r) => !r.ok))}`);
  assert.equal(result.passed, CHECKS.length - 1);
}

// --- good fixtures -------------------------------------------------------------------------------

const good = [
  ['plain', { id: 'plain_id', version: 3, shape: 'plain' }],
  ['plain with the Shop-app button', { id: 'plain_id', version: 3, shape: 'plain', shopApp: true }],
  ['footerAnchor id with a body-side disclaimer', { id: 'anchored_id', version: 1, shape: 'anchored' }],
  ['footerAnchor id with the Shop-app button', { id: 'anchored_id', version: 1, shape: 'anchored', shopApp: true }],
  ['header-override id', { id: 'banded_id', version: 12, shape: 'header' }],
  ['header-override id with the Shop-app button', { id: 'banded_id', version: 12, shape: 'header', shopApp: true }],
  ['gift-card layout: body copy in cells, no body paragraph anywhere', { id: 'banded_id', version: 12, shape: 'header', body: 'cells' }],
];

for (const [label, opts] of good) {
  test(`good render: ${label} passes every check`, () => {
    const html = makeRender(opts);
    assertAllPass(run(html, { id: opts.id, version: opts.version }), label);
  });
}

test('the check list is the documented one, in order, with unique names', () => {
  assert.deepEqual(CHECK_NAMES, [
    'version', 'manifest-version', 'header-navy', 'footer-navy', 'page-colour', 'content-white', 'buttons', 'shop-app-button',
    'footer-disclaimer', 'body-disclaimer', 'headings', 'body-paragraphs', 'social-row', 'footer-inside-body', 'subtotal-lines',
    'no-accent', 'no-liquid-error', 'no-translation-missing', 'mobile-css', 'header-row', 'no-logosize',
  ]);
  assert.equal(new Set(CHECK_NAMES).size, CHECK_NAMES.length);
});

// --- one defect per mutation ---------------------------------------------------------------------

const P = palette;
const base = { id: 'plain_id', version: 3, shape: 'plain', shopApp: true };
const anchored = { id: 'anchored_id', version: 1, shape: 'anchored' };

function mutate(html, from, to, label) {
  assert.ok(html.includes(from), `${label}: mutation anchor ${JSON.stringify(from.slice(0, 60))} not in the fixture`);
  return html.replace(from, to);
}

const mutations = [
  ['footer-outside-body', 'footer-inside-body', base, (h) => mutate(h, '<table class="row footer"', '</td></tr></table><table class="row footer"', 'footer-outside-body')],
  ['empty-subtotal-lines', 'subtotal-lines', base, (h) => h.replace(/(<table class="row subtotal-lines"[^>]*>)[\s\S]*?<\/table>\n<\/td>\n<\/tr>\n<\/table>/, '$1\n<tr>\n</tr>\n</table>')],
  ['row-table-navy', 'page-colour', base, (h) => mutate(h, `<table class="row content" style="width: 100%;" bgcolor="${P.page}">`, `<table class="row content" style="width: 100%;" bgcolor="${P.navy}">`, 'row-table-navy')],
  ['body-element-white', 'page-colour', base, (h) => mutate(h, `<body style="margin: 0;" bgcolor="${P.page}">`, '<body style="margin: 0;">', 'body-element-white')],
  ['button-wrong-colour', 'buttons', base, (h) => mutate(h, `bgcolor="${P.button.toUpperCase()}"`, 'bgcolor="#FF0000"', 'button-wrong-colour')],
  ['shop-app-recoloured', 'shop-app-button', base, (h) => mutate(h, `bgcolor="${SHOP_APP_BUTTON.toUpperCase()}"`, `bgcolor="${P.button}"`, 'shop-app-recoloured')],
  ['missing-media-block', 'mobile-css', base, (h) => mutate(h, mediaBlock(), '', 'missing-media-block')],
  ['media-block-without-fixed-layout', 'mobile-css', base, (h) => mutate(h, 'table-layout: fixed !important;', '', 'media-block-without-fixed-layout')],
  ['media-block-stock-header-margin', 'mobile-css', base, (h) => mutate(h, 'margin-bottom: 0 !important;', 'margin-bottom: 2px !important;', 'media-block-stock-header-margin')],
  ['logosize-left-in-body', 'no-logosize', base, (h) => mutate(h, '<h2 style=', '<img src="logo.png" class="giftcard__logosize" width="200"><h2 style=', 'logosize-left-in-body')],
  ['stamp-missing', 'version', base, (h) => mutate(h, footerStamp('plain_id', 3) + '\n', '', 'stamp-missing')],
  ['stamp-wrong-version', 'version', base, (h) => mutate(h, footerStamp('plain_id', 3), footerStamp('plain_id', 4), 'stamp-wrong-version')],
  ['stamp-wrong-id', 'version', base, (h) => mutate(h, footerStamp('plain_id', 3), footerStamp('other_id', 3), 'stamp-wrong-id')],
  ['stamp-twice', 'version', base, (h) => mutate(h, footerStamp('plain_id', 3), footerStamp('plain_id', 3) + footerStamp('plain_id', 3), 'stamp-twice')],
  ['liquid-error', 'no-liquid-error', base, (h) => mutate(h, 'We are getting your order ready.', 'Liquid error: undefined method', 'liquid-error')],
  ['translation-missing', 'no-translation-missing', base, (h) => mutate(h, 'We are getting your order ready.', 'translation missing: en.notifications.x', 'translation-missing')],
  ['accent-reference', 'no-accent', base, (h) => mutate(h, 'We are getting your order ready.', '{{ shop.email_accent_color }}', 'accent-reference')],
  ['body-disclaimer-light', 'body-disclaimer', anchored, (h) => mutate(h, `<p class="disclaimer__subtext" style="color: ${P.bodyText}; font-size: 12px;">Tracking`, `<p class="disclaimer__subtext" style="color: ${P.footerText}; font-size: 12px;">Tracking`, 'body-disclaimer-light')],
  ['social-icon-count', 'social-row', base, (h) => mutate(h, ICON('facebook'), '', 'social-icon-count')],
  ['social-shop-name-missing', 'social-row', base, (h) => mutate(h, 'class="ssb-shop-name"', 'class="ssb-shop-name-x"', 'social-shop-name-missing')],
  ['footer-container-white', 'footer-navy', base, (h) => h.replace(/(<table class="row footer"[\s\S]*?<table class="container"[^>]*)bgcolor="[^"]*"/, '$1bgcolor="#ffffff"')],
  ['header-container-white', 'header-navy', base, (h) => h.replace(/(<table class="header row"[\s\S]*?<table class="container"[^>]*)bgcolor="[^"]*"/, '$1bgcolor="#ffffff"')],
  ['content-container-navy', 'content-white', base, (h) => h.replace(/(<table class="row content"[\s\S]*?<table class="container"[^>]*)bgcolor="[^"]*"/, `$1bgcolor="${P.navy}"`)],
  ['footer-disclaimer-dark', 'footer-disclaimer', base, (h) => mutate(h, `<p class="disclaimer__subtext" style="color: ${P.footerText};`, `<p class="disclaimer__subtext" style="color: ${P.bodyText};`, 'footer-disclaimer-dark')],
  ['footer-link-not-white', 'footer-disclaimer', base, (h) => mutate(h, `<a href="mailto:hello@example.com" style="color: ${P.footerLink};`, `<a href="mailto:hello@example.com" style="color: ${P.button};`, 'footer-link-not-white')],
  ['heading-wrong-colour', 'headings', base, (h) => mutate(h, `color: ${P.heading};">Order summary`, `color: ${P.bodyText};">Order summary`, 'heading-wrong-colour')],
  ['h4-wrong-colour', 'headings', base, (h) => mutate(h, `color: ${P.eyebrow};">Shipping`, `color: ${P.heading};">Shipping`, 'h4-wrong-colour')],
  ['body-paragraph-light', 'body-paragraphs', base, (h) => mutate(h, `<p style="color: ${P.bodyText}; line-height: 150%;`, `<p style="color: ${P.footerText}; line-height: 150%;`, 'body-paragraph-light')],
  ['header-row-missing', 'header-row', base, (h) => mutate(h, '<table class="header row"', '<table class="header"', 'header-row-missing')],
];

for (const [label, expected, opts, fn] of mutations) {
  test(`defect ${label} fails exactly ${expected}`, () => {
    const html = fn(makeRender(opts));
    assert.notEqual(html, makeRender(opts), `${label}: the mutation changed nothing`);
    assertOnlyFails(run(html, { id: opts.id, version: opts.version }), expected, label);
  });
}

// --- body-paragraphs on the layouts that have no body paragraph ----------------------------------
//
// gift_card_confirmation, gift_card_notification, store_credit_issued and return_label_notification
// hold their whole body in headings and table cells. The rule used to fail them on
// "no body paragraphs", which no amount of correct branding could satisfy.

const giftCard = { id: 'banded_id', version: 12, shape: 'header', body: 'cells' };

test('the cells layout really has no body paragraph, so the good fixture is not passing by accident', () => {
  const html = makeRender(giftCard);
  const { root } = parseHtml(html);
  const bodyParagraphs = select(root, (e) => e.tag === 'p' && !closest(e, (a) => hasClass(a, 'footer')));
  assert.deepEqual(bodyParagraphs, [], 'the fixture must carry no body-side <p> at all');
  assert.ok(select(root, (e) => e.tag === 'p').length > 0, 'the footer paragraphs are still there');
  assert.ok(!html.includes('class="row section"'), 'no .section row: its subtotal table would contribute a body <p>');
});

test('an emptied white card still fails body-paragraphs, and an &nbsp; spacer does not count as copy', () => {
  const html = makeRender({ ...giftCard, copy: false });
  assert.ok(html.includes('&nbsp;'), 'the emptied card holds a spacer entity and nothing else');
  const r = run(html, { id: giftCard.id, version: giftCard.version });
  assertOnlyFails(r, 'body-paragraphs', 'emptied white card');
  assert.match(r.results.find((x) => x.name === 'body-paragraphs').detail, /^no body copy: no body paragraph, and no text in any \.content or \.section container$/);
});

test('the colour clauses still govern the moment a cells layout grows a body paragraph', () => {
  const anchor = '<table align="center" class="row giftcard__topmargin" style="width: 100%;">';
  const withParagraph = (colour) => mutate(makeRender(giftCard), anchor, `<p style="color: ${colour}; font-size: 16px;">Redeem it whenever you like.</p>\n${anchor}`, 'cells-layout paragraph');
  assertAllPass(run(withParagraph(P.bodyText), { id: giftCard.id, version: giftCard.version }), 'cells layout with a correct body paragraph');
  const light = run(withParagraph(P.footerText), { id: giftCard.id, version: giftCard.version });
  assertOnlyFails(light, 'body-paragraphs', 'cells layout with a footer-coloured body paragraph');
  assert.match(light.results.find((x) => x.name === 'body-paragraphs').detail, /1 body paragraph\(s\) in a footer colour/);
  const wrong = run(withParagraph('#999999'), { id: giftCard.id, version: giftCard.version });
  assertOnlyFails(wrong, 'body-paragraphs', 'cells layout with an off-palette body paragraph');
  assert.match(wrong.results.find((x) => x.name === 'body-paragraphs').detail, new RegExp(`no body paragraph is ${P.bodyText}`));
});

test('the paragraph-free layouts are the four this rule was relaxed for, and no others', () => {
  const dir = path.join(repoRoot, 'marketing', 'notifications');
  const none = readdirSync(dir)
    .filter((f) => f.endsWith('.liquid'))
    .sort()
    .filter((f) => {
      const { root } = parseHtml(readFileSync(path.join(dir, f), 'utf8'));
      return select(root, (e) => e.tag === 'p' && !closest(e, (a) => hasClass(a, 'footer')) && !hasClass(e, 'disclaimer__subtext')).length === 0;
    })
    .map((f) => f.replace(/\.liquid$/, ''));
  assert.deepEqual(
    none,
    ['gift_card_confirmation', 'gift_card_notification', 'return_label_notification', 'store_credit_issued'],
    'a template joined or left the set whose body copy is cells and headings only. That is not a defect, but the body-paragraphs comment names these four: update it, and check the newcomer renders body copy the fallback can see.',
  );
});

test('header-row-missing also breaks header-navy when there is no header row at all', () => {
  const html = makeRender(base).replace('<table class="header row"', '<table class="row"');
  const failed = run(html, { id: 'plain_id', version: 3 }).results.filter((r) => !r.ok).map((r) => r.name);
  assert.deepEqual(failed, ['header-navy', 'header-row']);
});

test('the version check reports unstamped, and the manifest cross-check is its own line', () => {
  const html = makeRender({ ...base, stamp: false });
  const r = run(html, { id: 'plain_id', version: 3 });
  assert.deepEqual(r.results.filter((x) => !x.ok).map((x) => [x.name, x.detail]), [['version', 'unstamped']]);
  const stale = run(makeRender({ ...base, version: 4 }), { id: 'plain_id', version: 4 });
  assert.deepEqual(stale.results.filter((x) => !x.ok).map((x) => [x.name, x.detail]), [['manifest-version', 'manifest says v3, asked for v4']]);
  const unknown = run(makeRender({ ...base, id: 'nope' }), { id: 'nope', version: 3 });
  assert.deepEqual(unknown.results.filter((x) => !x.ok).map((x) => x.detail), ['nope is not in the manifest']);
  assert.throws(() => run(makeRender(base), { id: 'Bad Id', version: 3 }), /bad id/);
  assert.throws(() => run(makeRender(base), { id: 'plain_id', version: '3' }), /bad version/);
  assert.throws(() => run(makeRender(base), { id: 'plain_id', version: 0 }), /bad version/);
});

test('parsePalette reads every token from the real stylesheet and fails loudly on a renamed selector', () => {
  for (const token of Object.keys(PALETTE_TOKENS)) assert.match(palette[token], /^#[0-9a-f]{6}$/, token);
  assert.equal(palette.button, '#0071c2');
  assert.equal(palette.navy, '#071e3f');
  assert.ok(palette.mobileRules.length >= 3);
  assert.throws(() => parsePalette(css.replace('.header__cell .container {', '.header__cell .box {')), /no rule "\.header__cell \.container \{ background-color \}" for palette token navy/);
  assert.throws(() => parsePalette(css.replace(/@media \(max-width: 600px\)/, '@media (max-width: 480px)')), /no @media/);
  assert.throws(() => parsePalette(css.replace('.button__cell { background: #0071C2;', '.button__cell { background: url(x);')), /is not a colour/);
});

test('formatResults prints one line per check and a final count', () => {
  const out = formatResults(run(makeRender(base), { id: 'plain_id', version: 3 }));
  const lines = out.trimEnd().split('\n');
  assert.equal(lines.length, CHECKS.length + 1);
  assert.ok(lines.slice(0, -1).every((l) => /^PASS [a-z-]+$/.test(l)), out);
  assert.equal(lines.at(-1), `verify-render: ${CHECKS.length} passed, 0 failed`);
  const bad = formatResults(run(makeRender({ ...base, stamp: false }), { id: 'plain_id', version: 3 }));
  assert.match(bad, /^FAIL version: unstamped$/m);
  assert.match(bad, new RegExp(`verify-render: ${CHECKS.length - 1} passed, 1 failed`));
});

// --- the real-derived fixture --------------------------------------------------------------------

const realFixture = path.join(fixtures, 'render.order_confirmation.html');

test('the real-derived fixture passes every check against the real manifest and stylesheet', () => {
  const html = readFileSync(realFixture, 'utf8');
  const real = readManifest(repoRoot);
  const r = verifyRender(html, { id: 'order_confirmation', version: real.templates.order_confirmation.version, manifest: real, css });
  assertAllPass(r, 'render.order_confirmation.html');
});

test('the real-derived fixture is scrubbed: no em dash, no real address or email, synthetic sample data only', () => {
  const html = readFileSync(realFixture, 'utf8');
  assert.ok(!html.includes(EM_DASH));
  assert.ok(!html.includes('\r'));
  assert.ok(!/@(gmail|icloud|outlook|yahoo|hotmail)\./i.test(html));
  assert.ok(!/sapphireshadowstudio\.com/.test(html), 'the shop contact address is replaced by a placeholder');
  assert.ok(html.includes('hello@example.com'));
  assert.ok(html.includes('Steve Shipper') && html.includes('Bob Biller'), 'the Shopify sample customers are the only people in it');
});

// --- CLI -----------------------------------------------------------------------------------------

test('CLI: exit 0 on PASS, 1 on FAIL, 2 on usage; --dump reassembles a console dump first', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ssb-verify-'));
  const manifestPath = path.join(dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  const html = makeRender(base);
  const file = path.join(dir, 'render.html');
  writeFileSync(file, html, 'utf8');
  const cli = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: dir });
  const ok = cli([file, '--id', 'plain_id', '--version', '3', '--manifest', manifestPath]);
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.match(ok.stdout, new RegExp(`verify-render: ${CHECKS.length} passed, 0 failed`));
  const bad = cli([file, '--id', 'plain_id', '--version', '4', '--manifest', manifestPath]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /FAIL version: stamp says v3, expected v4/);
  assert.match(bad.stdout, /FAIL manifest-version: manifest says v3, asked for v4/);
  assert.equal(cli([file, '--id', 'plain_id']).status, 2, 'version is required');
  assert.equal(cli(['--id', 'plain_id', '--version', '3']).status, 2, 'a file or --dump is required');
  // A console dump of the same document, chunked, with the real dump.mjs contract.
  const chunks = [];
  for (let i = 0, k = 0; i < html.length; i += 5000, k++) chunks.push(`msgid=${k + 3} [log] SSSCHUNK${k} ${html.slice(i, i + 5000)} (1 args)\n`);
  const dumpText = `msgid=1 [log] SSSLEN ${html.length} (1 args)\nmsgid=2 [log] SSSHASH ${fnv1a(html)} (1 args)\n` + chunks.join('');
  const dumpFile = path.join(dir, 'dump.txt');
  writeFileSync(dumpFile, dumpText, 'utf8');
  const fromDump = cli(['--dump', dumpFile, '--id', 'plain_id', '--version', '3', '--manifest', manifestPath]);
  assert.equal(fromDump.status, 0, fromDump.stderr + fromDump.stdout);
  writeFileSync(dumpFile, dumpText.replace(fnv1a(html), 'deadbeef'), 'utf8');
  const badDump = cli(['--dump', dumpFile, '--id', 'plain_id', '--version', '3', '--manifest', manifestPath]);
  assert.notEqual(badDump.status, 0);
  assert.match(badDump.stderr, /hash mismatch/);
  assert.equal(sha256('x').length, 64);
  // The saved EmailTemplateGeneratePreview response: CRLF inside bodyHtml, as Shopify sends it.
  const response = path.join(dir, 'preview.network-response');
  writeFileSync(response, JSON.stringify({ data: { emailTemplateGeneratePreview: { preview: { subject: 'Order #9999 confirmed', bodyHtml: html.replace(/\n/g, '\r\n') } } } }), 'utf8');
  const fromResponse = cli(['--preview-response', response, '--id', 'plain_id', '--version', '3', '--manifest', manifestPath]);
  assert.equal(fromResponse.status, 0, fromResponse.stderr + fromResponse.stdout);
  assert.equal(previewHtmlFromResponse(readFileSync(response, 'utf8')), html);
  assert.throws(() => previewHtmlFromResponse('{"data":{}}'), /carries no data\.emailTemplateGeneratePreview/);
  assert.equal(cli(['--preview-response', response, file, '--id', 'plain_id', '--version', '3']).status, 2, 'two sources is a usage error');
});
