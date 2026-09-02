// Tier A3 tests over a synthetic in-memory theme tree. Nothing here reads the real theme or the
// committed catalogue; the fixture mirrors the shapes (section groups, nested blocks, the
// catalogue manifest v2) with made-up handles and GIDs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFetchGuard } from './harness.mjs';
installFetchGuard();

import { parseCatalogue } from '../../lib/catalogue-manifest.mjs';
import {
  parseShopifyJson, schemaDefaults, effectiveSettings, walkBlocks, normaliseAmount, extractAmounts,
  inShippingContext, flattenLeaves, parseLiquidList, requiredBlockTypes,
  checkAnnouncementAmounts, checkTemplateShippingAmounts, checkVacationDates, checkVacationFaqAnchor,
  checkPriceShowShippingInfo, checkCatalogueTemplateMissing, checkCatalogueTemplateBlocks,
  checkSocialListParity, checkLocaleKeys, runRepoChecks,
} from '../lib/repo-checks.mjs';

// ---------------------------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------------------------

const CATALOGUE_TEXT = JSON.stringify({
  version: 2,
  options: { color: 'Color', size: 'Size', design: 'Design', denomination: 'Denominations' },
  colors: { black: { display: 'Black', slug: 'black' } },
  sizes: { s: { display: 'S' }, m: { display: 'M' } },
  bodies: { crewneck: { colors: ['black'], sizes: ['s', 'm'] } },
  products: {
    'huddle-crewneck': { line: 'huddle', body: 'crewneck', template: 'huddle-crewneck', title: 'Test Huddle', gid: 'gid://shopify/Product/1000000000001' },
    'lead-ii-crewneck': { line: 'lead2', body: 'crewneck', template: 'lead-ii-crewneck', title: 'Test Lead', gid: 'gid://shopify/Product/1000000000002' },
    'shift-fuel-crewneck': { line: 'shift-fuel', body: 'crewneck', template: 'shift-fuel-crewneck', title: 'Test Shift', gid: 'gid://shopify/Product/1000000000003' },
    'test-gift-card': { line: null, body: null, template: 'gift-card', title: 'Test Gift Card', gid: 'gid://shopify/Product/1000000000004' },
  },
});
const catalogue = parseCatalogue(CATALOGUE_TEXT);

const GARMENT_TYPES = ['variant-picker', 'buy-buttons', 'add-to-cart', 'return-policy-acknowledgment', 'vacation-acknowledgment', 'price'];

function productTemplate(types, { shipping = true, extraText = '', priceSettings } = {}) {
  const blocks = {};
  types.forEach((t, i) => {
    blocks[`${t.replace(/[^a-z]/g, '_')}_${i}`] = t === 'price'
      ? { type: 'price', settings: priceSettings ?? { show_shipping_info: shipping } }
      : { type: t, settings: {} };
  });
  blocks.accordion_1 = {
    type: 'accordion',
    settings: {},
    blocks: { row_1: { type: '_accordion-row', settings: { heading: 'Shipping & Turnaround' }, blocks: { text_1: { type: 'text', settings: { text: `<p>Economy shipping takes 5-8 business days.${extraText}</p>` } } } } },
  };
  return JSON.stringify({ sections: { main: { type: 'product-information', blocks, block_order: Object.keys(blocks) } }, order: ['main'] });
}

function cardTemplate(priceSettings = { show_shipping_info: false }) {
  return JSON.stringify({ sections: { list: { type: 'product-list', blocks: { card: { type: '_product-card', blocks: { price_1: { type: 'price', settings: priceSettings } } } } } }, order: ['list'] });
}

function headerGroup(slides) {
  const blocks = {};
  slides.forEach((text, i) => { blocks[`announcement_${i}`] = { type: '_announcement', settings: { text } }; });
  blocks.vacation_1 = { type: '_vacation-announcement', settings: {} };
  return JSON.stringify({ sections: { ann: { type: 'header-announcements', blocks } }, order: ['ann'] });
}

function faqTemplate({ anchor = 'away-from-studio', answer = '<p>Orders over $75.00 ship free; below that a flat $8.00 rate applies.</p>' } = {}) {
  return JSON.stringify({
    sections: { faq: { type: 'faq', blocks: {
      faq_item_free: { type: 'faq_item', settings: { question: 'Is there free shipping?', answer, custom_anchor: '' } },
      faq_item_vacation: { type: 'faq_item', settings: { question: 'Away?', answer: '<p>We pause.</p>', custom_anchor: anchor } },
    } } },
    order: ['faq'],
  });
}

const SCHEMA = [
  { name: 'Shipping', settings: [
    { type: 'text', id: 'flat_rate_shipping', default: '8.00' },
    { type: 'text', id: 'free_shipping_threshold', default: '75.00' },
  ] },
  { name: 'Vacation', settings: [
    { type: 'checkbox', id: 'vacation_mode_enabled', default: false },
    { type: 'richtext', id: 'vacation_popup_body', default: '<p>Processing after <strong>[SET DATE]</strong>. <a href="/pages/faq#away-from-studio">FAQ</a>.</p>' },
    { type: 'richtext', id: 'vacation_checkbox_terms', default: '<p>Orders begin after <strong>[SET DATE]</strong>. <a href="/pages/faq#away-from-studio">FAQ</a>.</p>' },
    { type: 'text', id: 'vacation_processing_date', default: '[SET DATE]' },
    { type: 'text', id: 'vacation_shipping_message', default: 'Ships after [SET DATE]' },
  ] },
];

const SOCIAL_LINKS = `{%- liquid\n  assign social_platforms = 'facebook,instagram,tiktok' | split: ','\n-%}`;
const ORG = `{%- liquid\n  assign social_keys = 'social_facebook_link,social_instagram_link,social_tiktok_link' | split: ','\n-%}`;
const VACATION_BLOCK = `{%- if settings.vacation_mode_enabled -%}<a class="x" href="/pages/faq#away-from-studio">go</a>{%- endif -%}`;

const EN = `/* banner */\n{\n  "a": {\n    // comment\n    "b": "Hello",\n    "url": "https://example.test/x"\n  },\n  "c": "Bye"\n}`;
const IT = `{ "a": { "b": "Ciao", "url": "https://example.test/x" }, "c": "TODO: Bye" }`;
const RO = `{ "a": { "b": "Salut" }, "c": "Pa" }`;

function baseFiles(overrides = {}) {
  const files = new Map([
    ['sections/header-group.json', headerGroup(['<strong>$8.00 Flat Rate Shipping</strong> on Orders under $75.00', '<strong>Free Shipping</strong> on Orders $75.00 and up'])],
    ['config/settings_schema.json', JSON.stringify(SCHEMA)],
    ['config/settings_data.json', '/* generated */\n{ "current": { "logo_height": 87 } }'],
    ['locales/en.default.json', EN],
    ['locales/it.json', IT],
    ['locales/ro.json', RO],
    ['snippets/social-links.liquid', SOCIAL_LINKS],
    ['snippets/structured-data-organization.liquid', ORG],
    ['blocks/_vacation-announcement.liquid', VACATION_BLOCK],
    ['templates/page.faq.json', faqTemplate()],
    ['templates/product.huddle-crewneck.json', productTemplate([...GARMENT_TYPES, 'applique-pattern-select'])],
    ['templates/product.lead-ii-crewneck.json', productTemplate([...GARMENT_TYPES, 'product-custom-property'])],
    ['templates/product.shift-fuel-crewneck.json', productTemplate(GARMENT_TYPES.filter((t) => t !== 'return-policy-acknowledgment'))],
    ['templates/product.gift-card.json', productTemplate(['variant-picker', 'buy-buttons', 'add-to-cart', 'price'], { shipping: true })],
    ['templates/index.json', cardTemplate()],
    ['templates/collection.json', cardTemplate()],
  ]);
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) files.delete(k); else files.set(k, v);
  }
  return files;
}

function ctx(overrides = {}, current = {}) {
  const files = baseFiles(overrides);
  const schema = parseShopifyJson(files.get('config/settings_schema.json'));
  const settings = effectiveSettings(schema, { current });
  return { files, catalogue, settings, schemaDefaults: schemaDefaults(schema) };
}

const ids = (findings) => findings.map((f) => f.id).sort();

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

test('parseShopifyJson strips banner and line comments but not slashes inside strings', () => {
  const doc = parseShopifyJson(EN);
  assert.deepEqual(doc, { a: { b: 'Hello', url: 'https://example.test/x' }, c: 'Bye' });
  assert.deepEqual(parseShopifyJson('{"s": "a \\" // not a comment", "n": 1} // trailing'), { s: 'a " // not a comment', n: 1 });
  assert.throws(() => parseShopifyJson('{ nope'), SyntaxError);
});

test('effectiveSettings merges current over schema defaults and resolves a preset name', () => {
  const s = effectiveSettings(SCHEMA, { current: { flat_rate_shipping: '9.00' } });
  assert.equal(s.flat_rate_shipping, '9.00');
  assert.equal(s.free_shipping_threshold, '75.00');
  assert.equal(s.vacation_mode_enabled, false);
  const p = effectiveSettings(SCHEMA, { current: 'Default', presets: { Default: { free_shipping_threshold: '100' } } });
  assert.equal(p.free_shipping_threshold, '100');
  assert.deepEqual(schemaDefaults([{ settings: [{ type: 'header', content: 'x' }, { id: 'k', default: 1 }] }]), { k: 1 });
});

test('walkBlocks yields nested blocks with stable paths', () => {
  const doc = JSON.parse(productTemplate(['price']));
  const paths = [...walkBlocks(doc)].map((b) => b.path);
  assert.ok(paths.includes('main/price_0'));
  assert.ok(paths.includes('main/accordion_1/row_1/text_1'));
});

test('amount helpers', () => {
  assert.equal(normaliseAmount('$8'), '8.00');
  assert.equal(normaliseAmount(' 75.5 '), '75.50');
  assert.equal(normaliseAmount('1,000'), '1000.00');
  assert.equal(normaliseAmount('abc'), null);
  assert.deepEqual(extractAmounts('<b>$8.00</b> under $75').map((a) => a.amount), ['8.00', '75.00']);
  const text = 'Gift cards start at $25.00. Free shipping on orders over $75.00 and up; below that a flat $8.00 rate applies.';
  assert.ok(!inShippingContext(text, text.indexOf('$25')), 'a neighbouring sentence does not make a price a shipping amount');
  assert.ok(inShippingContext(text, text.indexOf('$75')));
  assert.ok(inShippingContext(text, text.indexOf('$8.00')));
  assert.ok(!inShippingContext('Priced at $25 each.', 10));
});

test('flattenLeaves and parseLiquidList', () => {
  assert.deepEqual([...flattenLeaves({ a: { b: 1, c: { d: 'x' } }, e: [1] })], [['a.b', 1], ['a.c.d', 'x'], ['e', [1]]]);
  assert.deepEqual(parseLiquidList(SOCIAL_LINKS, 'social_platforms'), ['facebook', 'instagram', 'tiktok']);
  assert.equal(parseLiquidList(SOCIAL_LINKS, 'social_keys'), null);
});

// ---------------------------------------------------------------------------------------------
// 1. announcement-amounts
// ---------------------------------------------------------------------------------------------

test('announcement-amounts: matching slides pass, drifted slide is an ERROR keyed by block id', () => {
  assert.deepEqual(checkAnnouncementAmounts(ctx()), []);
  const drifted = ctx({ 'sections/header-group.json': headerGroup(['<strong>$8.00 Flat Rate Shipping</strong> on Orders under $50.00', '<strong>Free Shipping</strong> on Orders $75.00 and up']) });
  const out = checkAnnouncementAmounts(drifted);
  assert.deepEqual(ids(out), ['announcement-amounts:sections/header-group.json#announcement_0']);
  assert.equal(out[0].severity, 'ERROR');
  assert.match(out[0].message, /50\.00/);
});

test('announcement-amounts: compares against current settings and a swapped pair fails', () => {
  const c = ctx({}, { flat_rate_shipping: '9', free_shipping_threshold: '100' });
  const out = checkAnnouncementAmounts(c);
  assert.equal(out.length, 2);
  const swapped = ctx({ 'sections/header-group.json': headerGroup(['<strong>$75.00 Flat Rate</strong> under $8.00']) });
  assert.equal(checkAnnouncementAmounts(swapped).length, 1);
  const single = ctx({ 'sections/header-group.json': headerGroup(['Free shipping over $75', 'Flat rate $8']) });
  assert.deepEqual(checkAnnouncementAmounts(single), []);
});

test('announcement-amounts: missing header group is SKIPPED, not an error', () => {
  const out = checkAnnouncementAmounts(ctx({ 'sections/header-group.json': null }));
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'SKIPPED');
});

// ---------------------------------------------------------------------------------------------
// 2. template-shipping-amounts
// ---------------------------------------------------------------------------------------------

test('template-shipping-amounts: shipping amounts that disagree are flagged; non-shipping amounts are not', () => {
  assert.deepEqual(checkTemplateShippingAmounts(ctx()), []);
  const bad = ctx({
    'templates/product.huddle-crewneck.json': productTemplate(GARMENT_TYPES, { extraText: ' Flat rate shipping is $6.00.' }),
    'templates/page.faq.json': faqTemplate({ answer: '<p>Free shipping on orders over $100.00.</p>' }),
  });
  const out = checkTemplateShippingAmounts(bad);
  assert.deepEqual(ids(out), [
    'template-shipping-amounts:templates/page.faq.json#faq_item_free',
    'template-shipping-amounts:templates/product.huddle-crewneck.json#text_1',
  ]);
  const price = ctx({ 'templates/product.huddle-crewneck.json': productTemplate(GARMENT_TYPES, { extraText: ' Each piece is $45.00 and comes with a pattern.' }) });
  assert.deepEqual(checkTemplateShippingAmounts(price), []);
});

// ---------------------------------------------------------------------------------------------
// 3. vacation dates
// ---------------------------------------------------------------------------------------------

const VAC_ON = {
  vacation_mode_enabled: true,
  vacation_processing_date: 'March 3, 2027',
  vacation_popup_body: '<p>Processing after <strong>March 3, 2027</strong>. <a href="/pages/faq#away-from-studio">FAQ</a>.</p>',
  vacation_checkbox_terms: '<p>Orders begin after <strong>March 3, 2027</strong>.</p>',
  vacation_shipping_message: 'Ships after March 3, 2027',
};

test('vacation-date-sync: nothing while off, nothing when all four agree', () => {
  assert.deepEqual(checkVacationDates(ctx()), []);
  assert.deepEqual(checkVacationDates(ctx({}, VAC_ON)), []);
});

test('vacation-date-sync: placeholder while enabled is an ERROR; a stray setting is named', () => {
  const placeholder = checkVacationDates(ctx({}, { vacation_mode_enabled: true }));
  assert.deepEqual(ids(placeholder), [
    'vacation-date-sync:vacation_checkbox_terms', 'vacation-date-sync:vacation_popup_body',
    'vacation-date-sync:vacation_processing_date', 'vacation-date-sync:vacation_shipping_message',
  ]);
  assert.ok(placeholder.every((f) => f.severity === 'ERROR'));
  const stray = checkVacationDates(ctx({}, { ...VAC_ON, vacation_shipping_message: 'Ships after March 4, 2027' }));
  assert.deepEqual(ids(stray), ['vacation-date-sync:vacation_shipping_message']);
});

test('vacation-date-format: a real date outside the pinned format is a WARN and still drives sync', () => {
  const out = checkVacationDates(ctx({}, {
    ...VAC_ON, vacation_processing_date: '2027-03-03',
    vacation_popup_body: 'after 2027-03-03', vacation_checkbox_terms: 'after 2027-03-03', vacation_shipping_message: 'Ships after 2027-03-03',
  }));
  assert.deepEqual(ids(out), ['vacation-date-format:vacation_processing_date']);
  assert.equal(out[0].severity, 'WARN');
});

// ---------------------------------------------------------------------------------------------
// 4. vacation-faq-anchor
// ---------------------------------------------------------------------------------------------

test('vacation-faq-anchor: passes on the fixture, fails on anchor drift, block drift and setting drift', () => {
  assert.deepEqual(checkVacationFaqAnchor(ctx()), []);
  const anchor = checkVacationFaqAnchor(ctx({ 'templates/page.faq.json': faqTemplate({ anchor: 'away' }) }));
  assert.deepEqual(ids(anchor), ['vacation-faq-anchor:templates/page.faq.json#faq_item_vacation']);
  const block = checkVacationFaqAnchor(ctx({ 'blocks/_vacation-announcement.liquid': '<a href="/pages/faq">x</a>' }));
  assert.deepEqual(ids(block), ['vacation-faq-anchor:blocks/_vacation-announcement.liquid']);
  const setting = checkVacationFaqAnchor(ctx({}, { vacation_popup_body: '<p><a href="/pages/faq#away">FAQ</a></p>', vacation_checkbox_terms: 'no link at all' }));
  assert.deepEqual(ids(setting), ['vacation-faq-anchor:settings_data:vacation_popup_body']);
  const missing = checkVacationFaqAnchor(ctx({ 'templates/page.faq.json': faqTemplate().replace('faq_item_vacation', 'faq_item_other') }));
  assert.deepEqual(ids(missing), ['vacation-faq-anchor:templates/page.faq.json#faq_item_vacation']);
});

// ---------------------------------------------------------------------------------------------
// 5. price-show-shipping-info
// ---------------------------------------------------------------------------------------------

test('price-show-shipping-info: garments true, cards false, gift card exempt, absent key reported', () => {
  assert.deepEqual(checkPriceShowShippingInfo(ctx()), []);
  const out = checkPriceShowShippingInfo(ctx({
    'templates/product.huddle-crewneck.json': productTemplate(GARMENT_TYPES, { shipping: false }),
    'templates/index.json': cardTemplate({ show_shipping_info: true }),
    'templates/collection.json': cardTemplate({}),
    'templates/product.gift-card.json': productTemplate(['price'], { shipping: false }),
  }));
  assert.deepEqual(ids(out), [
    'price-show-shipping-info:templates/collection.json#list/card/price_1',
    'price-show-shipping-info:templates/index.json#list/card/price_1',
    'price-show-shipping-info:templates/product.huddle-crewneck.json#main/price_5',
  ]);
  const absent = out.find((f) => f.subject.startsWith('templates/collection.json'));
  assert.match(absent.message, /absent/);
});

// ---------------------------------------------------------------------------------------------
// 6 and 7. catalogue templates
// ---------------------------------------------------------------------------------------------

test('catalogue-template-missing: every catalogue product needs its template file', () => {
  assert.deepEqual(checkCatalogueTemplateMissing(ctx()), []);
  const out = checkCatalogueTemplateMissing(ctx({ 'templates/product.lead-ii-crewneck.json': null }));
  assert.deepEqual(ids(out), ['catalogue-template-missing:lead-ii-crewneck']);
});

test('catalogue-template-blocks: rule table per product', () => {
  assert.deepEqual([...requiredBlockTypes(catalogue.products.get('shift-fuel-crewneck'))].sort(),
    ['add-to-cart', 'buy-buttons', 'price', 'vacation-acknowledgment', 'variant-picker']);
  assert.ok(requiredBlockTypes(catalogue.products.get('huddle-crewneck')).has('applique-pattern-select'));
  assert.ok(requiredBlockTypes(catalogue.products.get('lead-ii-crewneck')).has('product-custom-property'));
  assert.ok(!requiredBlockTypes(catalogue.products.get('test-gift-card')).has('vacation-acknowledgment'));
  assert.deepEqual(checkCatalogueTemplateBlocks(ctx()), []);
  const out = checkCatalogueTemplateBlocks(ctx({
    'templates/product.huddle-crewneck.json': productTemplate(GARMENT_TYPES.filter((t) => t !== 'vacation-acknowledgment')),
    'templates/product.lead-ii-crewneck.json': null,
  }));
  assert.deepEqual(ids(out), [
    'catalogue-template-blocks:templates/product.huddle-crewneck.json#applique-pattern-select',
    'catalogue-template-blocks:templates/product.huddle-crewneck.json#vacation-acknowledgment',
  ]);
});

// ---------------------------------------------------------------------------------------------
// 8. social-list-parity
// ---------------------------------------------------------------------------------------------

test('social-list-parity: equal sets pass; each side reports the platform the other lacks', () => {
  assert.deepEqual(checkSocialListParity(ctx()), []);
  const out = checkSocialListParity(ctx({
    'snippets/social-links.liquid': `assign social_platforms = 'facebook,instagram,youtube' | split: ','`,
  }));
  assert.deepEqual(ids(out), ['social-list-parity:tiktok', 'social-list-parity:youtube']);
  const unparsable = checkSocialListParity(ctx({ 'snippets/structured-data-organization.liquid': 'nothing here' }));
  assert.deepEqual(ids(unparsable), ['social-list-parity:snippets/structured-data-organization.liquid']);
  assert.equal(checkSocialListParity(ctx({ 'snippets/social-links.liquid': null }))[0].severity, 'SKIPPED');
});

// ---------------------------------------------------------------------------------------------
// 9. locales
// ---------------------------------------------------------------------------------------------

test('locale keys: missing is WARN per locale and key, TODO: is INFO', () => {
  const out = checkLocaleKeys(ctx());
  assert.deepEqual(ids(out), ['locale-key-missing:ro:a.url', 'locale-key-todo:it:c']);
  assert.equal(out.find((f) => f.check === 'locale-key-missing').severity, 'WARN');
  assert.equal(out.find((f) => f.check === 'locale-key-todo').severity, 'INFO');
  const gone = checkLocaleKeys(ctx({ 'locales/ro.json': null }));
  assert.ok(gone.some((f) => f.id === 'locale-key-missing:ro'));
});

// ---------------------------------------------------------------------------------------------
// All together
// ---------------------------------------------------------------------------------------------

test('runRepoChecks on the clean fixture reports only the locale findings, sorted, and is deterministic', () => {
  const a = runRepoChecks(ctx());
  const b = runRepoChecks(ctx());
  assert.deepEqual(a, b);
  assert.deepEqual(ids(a), ['locale-key-missing:ro:a.url', 'locale-key-todo:it:c']);
  for (const f of a) assert.ok(!/\s/.test(f.subject));
});
