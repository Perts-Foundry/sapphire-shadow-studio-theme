// Tier A1 cart flow: the reducer is driven end to end by a tiny test driver over a scripted
// fetch and an in-memory fake cart, with the session jar threaded through exactly as the
// orchestrator threads it. Synthetic fixtures throughout: the line key and cart token below are
// made up, and the tests assert they never reach a finding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFetchGuard, fakeResponse, scriptedFetch } from './harness.mjs';
installFetchGuard();

import { updateJar, cookieHeader } from '../../../.github/actions/shopify-theme-push/smoke.mjs';
import {
  createCartPlan, next, toCents, shippableCents, qualifiesForFreeShipping, renderedShippingState,
  parsePropertyKeys, parseCheckboxValues, repoPropertyKeysFor, FREE_SHIPPING_COPY,
} from '../lib/cart.mjs';

const BASE = 'https://example.test';
const GARMENT = { handle: 'lead-ii-crewneck', variantId: 41001, properties: {} };
const GIFT = { variantId: 49001 };
const LINE_KEY_PREFIX = 'fakekey';
const CART_TOKEN = 'faketoken-Z2NwLXVzLWVhc3Qx';
const ACK_KEY = 'Customer confirm size guide & return policy';

const PRODUCT_HTML = `<html><body><h1>Lead II</h1><form id="pf">
<input type="checkbox" name="properties[Customer confirm size guide &amp; return policy]" value="Yes" required>
<input type="hidden" name="properties[_embroidery_price_adjustment]" value="0">
</form></body></html>`;

/** A fake Ajax cart: enough of Shopify's cart API for the flow. */
function fakeCart({ garmentPrice = 6500, giftPrice = 5000, throttleAt = null, add422 = false, clearFails = false, giftRequiresShipping = false } = {}) {
  const items = [];
  let calls = 0;
  const cartJson = () => ({
    token: CART_TOKEN,
    item_count: items.reduce((n, it) => n + it.quantity, 0),
    items: items.map((it) => ({ ...it, final_line_price: it.price * it.quantity })),
  });
  const cartHtml = () => {
    const shippable = items.filter((it) => it.requires_shipping).reduce((s, it) => s + it.price * it.quantity, 0);
    const free = shippable >= 7500;
    return `<html><body><div class="cart-page"><a class="shipping-info">${free ? FREE_SHIPPING_COPY : "You're $10.00 away from free shipping $8.00 shipping within the USA"}</a></div></body></html>`;
  };
  const json = (body, status = 200) => fakeResponse({ status, body, url: `${BASE}/cart.js`, setCookie: ['cart=fakecartcookie; Path=/'] });
  return {
    items,
    fetch: scriptedFetch([{
      match: () => true,
      respond: (url, init) => {
        calls += 1;
        const u = new URL(url);
        const p = u.pathname;
        if (throttleAt !== null && calls === throttleAt) return fakeResponse({ status: 429, body: 'Too many requests', url });
        if (p === `/products/${GARMENT.handle}`) return fakeResponse({ status: 200, body: PRODUCT_HTML, url, setCookie: ['_shopify_y=fakesession; Path=/'] });
        if (p === '/cart') return fakeResponse({ status: 200, body: cartHtml(), url });
        if (p === '/cart.js') return json(cartJson());
        const body = init.body ? JSON.parse(init.body) : {};
        if (p === '/cart/add.js') {
          if (add422) return json({ status: 422, message: 'Cart Error', description: 'The product is sold out' }, 422);
          const added = [];
          for (const it of body.items) {
            const isGift = it.id === GIFT.variantId;
            const line = { key: `${LINE_KEY_PREFIX}${it.id}:abc`, id: it.id, variant_id: it.id, quantity: it.quantity, properties: it.properties || {}, price: isGift ? giftPrice : garmentPrice, requires_shipping: isGift ? giftRequiresShipping : true };
            items.push(line);
            added.push(line);
          }
          return json({ items: added.map((it) => ({ ...it, final_line_price: it.price * it.quantity })) });
        }
        if (p === '/cart/update.js') {
          for (const [key, q] of Object.entries(body.updates)) { const it = items.find((x) => x.key === key); if (it) it.quantity = q; }
          return json(cartJson());
        }
        if (p === '/cart/change.js') {
          const i = items.findIndex((x) => x.key === body.id);
          if (i >= 0 && body.quantity === 0) items.splice(i, 1);
          return json(cartJson());
        }
        if (p === '/cart/clear.js') {
          if (!clearFails) items.length = 0;
          return json(cartJson());
        }
        return fakeResponse({ status: 404, body: 'nope', url });
      },
    }]),
  };
}

/** The orchestrator's loop in miniature: jar in, jar out, response shape as probe.mjs builds it. */
async function drive(plan, fetchImpl) {
  const jar = new Map();
  let state = plan.state;
  let last = null;
  const steps = [];
  for (;;) {
    const out = plan.next(state, last);
    state = out.state;
    if (out.done) return { findings: out.findings, steps, jar };
    const { step } = out;
    steps.push(step.name);
    const headers = {};
    if (jar.size) headers.cookie = cookieHeader(jar);
    const res = await fetchImpl(`${BASE}${step.path}`, { method: step.method, headers, body: step.body ? JSON.stringify(step.body) : undefined });
    updateJar(jar, res);
    last = { status: res.status, body: await res.text(), finalUrl: res.url };
  }
}

const plan = (over = {}) => createCartPlan({ garment: GARMENT, giftCard: GIFT, thresholdCents: 7500, flatRateCents: 800, repoPropertyKeys: [ACK_KEY], ...over });

function assertNoSecrets(findings) {
  const text = JSON.stringify(findings);
  assert.ok(!text.includes(LINE_KEY_PREFIX), `line key leaked: ${text}`);
  assert.ok(!text.includes(CART_TOKEN), `cart token leaked: ${text}`);
  assert.ok(!text.includes('fakecartcookie'), `cookie leaked: ${text}`);
}

test('happy path: every step in order, no findings, cart cleared, cookie continuity', async () => {
  const server = fakeCart();
  const { findings, steps, jar } = await drive(plan(), server.fetch);
  assert.deepEqual(findings, []);
  assert.deepEqual(steps, ['product-page', 'precondition', 'add-garment', 'roundtrip', 'update-quantity', 'remove', 'add-gift-card', 'add-garment-mixed', 'mixed-cart', 'cart-render', 'clear', 'verify-clear']);
  assert.equal(server.items.length, 0);
  assert.ok(jar.has('cart'));
  const calls = server.fetch.calls;
  assert.equal(calls[0].headers.cookie, undefined);
  for (const c of calls.slice(1)) assert.ok(c.headers.cookie && c.headers.cookie.includes('_shopify_y='), `no cookie on ${c.method} ${c.url}`);
  for (const c of calls.slice(3)) assert.ok(c.headers.cookie.includes('cart='), `cart cookie missing on ${c.method} ${c.url}`);
  const add = calls.find((c) => c.url.endsWith('/cart/add.js'));
  const body = JSON.parse(add.body);
  assert.equal(body.items[0].id, GARMENT.variantId);
  assert.equal(body.items[0].properties[ACK_KEY], 'Yes', 'checkbox value learned from the form');
  const update = calls.find((c) => c.url.endsWith('/cart/update.js'));
  assert.deepEqual(Object.values(JSON.parse(update.body).updates), [2]);
});

test('422 on add names the variant and still clears', async () => {
  const server = fakeCart({ add422: true });
  const { findings, steps } = await drive(plan(), server.fetch);
  assert.deepEqual(findings.map((f) => f.check), ['cart-add-422']);
  assert.match(findings[0].message, /41001/);
  assert.equal(findings[0].subject, GARMENT.handle);
  assert.ok(steps.includes('clear') && steps.includes('verify-clear'));
  assert.ok(!steps.includes('roundtrip'));
  assertNoSecrets(findings);
});

test('throttle mid-flow: one GATE, abort straight to clear, clear still runs', async () => {
  // Call 4 is the roundtrip GET /cart.js after the add.
  const server = fakeCart({ throttleAt: 4 });
  const { findings, steps } = await drive(plan(), server.fetch);
  assert.deepEqual(findings.map((f) => f.check), ['cart-throttled']);
  assert.equal(findings[0].severity, 'GATE');
  assert.match(findings[0].message, /roundtrip/);
  assert.deepEqual(steps, ['product-page', 'precondition', 'add-garment', 'roundtrip', 'clear', 'verify-clear']);
  assert.equal(server.items.length, 0, 'the clear ran after the abort');
  assertNoSecrets(findings);
});

test('throttle on clear itself: still one GATE, verify-clear still attempted, no retry storm', async () => {
  const server = fakeCart({ throttleAt: 11 });
  const { findings, steps } = await drive(plan(), server.fetch);
  assert.equal(steps.filter((s) => s === 'clear').length, 1);
  assert.equal(steps[steps.length - 1], 'verify-clear');
  assert.equal(findings.filter((f) => f.check === 'cart-throttled').length, 1);
  assert.equal(server.fetch.calls.length, 12);
});

test('clear that leaves items behind is cart-clear', async () => {
  const server = fakeCart({ clearFails: true });
  const { findings } = await drive(plan(), server.fetch);
  assert.deepEqual(findings.map((f) => f.check), ['cart-clear']);
  assertNoSecrets(findings);
});

test('gift card reporting requires_shipping true is cart-gift-card-shipping', async () => {
  const server = fakeCart({ giftRequiresShipping: true });
  const { findings } = await drive(plan(), server.fetch);
  assert.ok(findings.some((f) => f.check === 'cart-gift-card-shipping'));
  assert.equal(findings.find((f) => f.check === 'cart-gift-card-shipping').subject, 'gift-card');
});

test('cents boundary: shippable exactly at threshold qualifies; one cent under does not', async () => {
  assert.equal(qualifiesForFreeShipping(7500, 7500), true);
  assert.equal(qualifiesForFreeShipping(7499, 7500), false);
  // Garment at exactly the threshold + a $50 gift card: predicate free, fake render free.
  const at = fakeCart({ garmentPrice: 7500 });
  assert.deepEqual((await drive(plan(), at.fetch)).findings, []);
  // One cent under with a gift card that would push the raw total over: predicate flat, render flat.
  const under = fakeCart({ garmentPrice: 7499 });
  assert.deepEqual((await drive(plan(), under.fetch)).findings, []);
  // A render that disagrees with the predicate (the fake render counts the gift card) is caught.
  const cart = { items: [{ requires_shipping: true, final_line_price: 7499 }, { requires_shipping: false, final_line_price: 5000 }] };
  assert.equal(shippableCents(cart), 7499);
  assert.equal(renderedShippingState(`<a class="shipping-info">${FREE_SHIPPING_COPY}</a>`), 'free');
  assert.equal(renderedShippingState('<a class="shipping-info">$8.00 shipping within the USA</a>'), 'flat');
  assert.equal(renderedShippingState('<a class="shipping-info">You\'re $0.01 away from free shipping</a>'), 'flat');
  assert.equal(renderedShippingState('<div class="cart-page--empty"></div>'), null);
  assert.equal(toCents('75.00'), 7500);
  assert.equal(toCents('$8'), 800);
  assert.equal(toCents(6500), 6500);
});

test('threshold predicate vs render: a wrong sentence is cart-threshold-predicate; no sentence is cart-render-shipping-copy', () => {
  const p = plan();
  let s = p.state;
  // Walk to cart-render with hand-fed responses.
  const feed = (res) => { const out = next(s, res); s = out.state; return out; };
  next(s, null);
  feed({ status: 200, body: PRODUCT_HTML });                                     // product-page
  feed({ status: 200, body: JSON.stringify({ item_count: 0, items: [] }) });    // precondition
  feed({ status: 200, body: JSON.stringify({ items: [{ id: 41001 }] }) });       // add-garment
  feed({ status: 200, body: JSON.stringify({ items: [{ key: 'k1', variant_id: 41001, quantity: 1, properties: { [ACK_KEY]: 'Yes' } }] }) }); // roundtrip
  feed({ status: 200, body: JSON.stringify({ items: [{ key: 'k1', variant_id: 41001, quantity: 2 }] }) }); // update
  feed({ status: 200, body: JSON.stringify({ items: [] }) });                    // remove
  feed({ status: 200, body: JSON.stringify({ items: [{ variant_id: 49001, requires_shipping: false }] }) }); // add gift card
  feed({ status: 200, body: JSON.stringify({ items: [{ id: 41001 }] }) });       // add garment mixed
  const mixed = { items: [{ key: 'k2', variant_id: 41001, quantity: 1, requires_shipping: true, final_line_price: 6500 }, { key: 'k3', variant_id: 49001, quantity: 1, requires_shipping: false, final_line_price: 5000 }] };
  feed({ status: 200, body: JSON.stringify(mixed) });                            // mixed-cart
  assert.equal(s.step, 'cart-render');
  const wrong = next(s, { status: 200, body: `<a class="shipping-info">${FREE_SHIPPING_COPY}</a>` });
  const f = wrong.state.findings;
  assert.deepEqual(f.map((x) => x.check), ['cart-threshold-predicate']);
  assert.equal(f[0].subject, 'lead-ii-crewneck+gift-card');
  assert.match(f[0].message, /6500 cents vs threshold 7500/);
  const none = next(s, { status: 200, body: '<html><body>no summary</body></html>' });
  assert.deepEqual(none.state.findings.map((x) => x.check), ['cart-render-shipping-copy']);
  assertNoSecrets([...f, ...none.state.findings]);
});

test('precondition: a non-empty cart is cleared first with an INFO', async () => {
  const server = fakeCart();
  server.items.push({ key: 'fakekeyold', id: 1, variant_id: 1, quantity: 1, properties: {}, price: 100, requires_shipping: true });
  const { findings, steps } = await drive(plan(), server.fetch);
  assert.deepEqual(findings.map((f) => f.check), ['cart-precondition']);
  assert.equal(findings[0].severity, 'INFO');
  assert.equal(steps[2], 'clear-precondition');
  assertNoSecrets(findings);
});

test('property keys: mismatch is a WARN naming the keys; parsers skip hidden keys', async () => {
  assert.deepEqual(parsePropertyKeys(PRODUCT_HTML), [ACK_KEY]);
  assert.deepEqual(parseCheckboxValues(PRODUCT_HTML), { [ACK_KEY]: 'Yes' });
  const server = fakeCart();
  const { findings } = await drive(plan({ repoPropertyKeys: [ACK_KEY, 'Applique Pattern'] }), server.fetch);
  assert.deepEqual(findings.map((f) => f.check), ['cart-property-keys-mismatch']);
  assert.equal(findings[0].severity, 'WARN');
  assert.match(findings[0].evidence, /missing \[Applique Pattern\]/);
});

test('repoPropertyKeysFor walks a template and respects the dormant vacation block', () => {
  const template = { sections: { main: { blocks: { a: { type: 'return-policy-acknowledgment', settings: {} }, b: { type: 'vacation-acknowledgment' }, c: { type: 'applique-pattern-select', settings: { property_key: 'Applique Pattern' } }, d: { type: 'group', blocks: { e: { type: 'product-custom-property', settings: { property_key: 'Custom Text' } } } } } } } };
  assert.deepEqual(repoPropertyKeysFor(template, { returnPolicyDefaultLabel: ACK_KEY }), [ACK_KEY, 'Applique Pattern', 'Custom Text']);
  assert.ok(repoPropertyKeysFor(template, { returnPolicyDefaultLabel: ACK_KEY, vacationEnabled: true }).includes('Delayed processing acknowledged'));
  const gift = { sections: { main: { blocks: { a: { type: 'return-policy-acknowledgment', settings: { property_label: 'Customer confirm final sale' } } } } } };
  assert.deepEqual(repoPropertyKeysFor(gift, { returnPolicyDefaultLabel: ACK_KEY }), ['Customer confirm final sale']);
});

test('no gift card: the mixed-cart steps are skipped and the flow still clears', async () => {
  const server = fakeCart();
  const { findings, steps } = await drive(plan({ giftCard: null }), server.fetch);
  assert.deepEqual(findings, []);
  assert.deepEqual(steps, ['product-page', 'precondition', 'add-garment', 'roundtrip', 'update-quantity', 'remove', 'clear', 'verify-clear']);
});

test('the reducer is pure: input state is never mutated', () => {
  const p = plan();
  const before = JSON.stringify(p.state);
  const out = next(p.state, null);
  next(out.state, { status: 429, body: '' });
  assert.equal(JSON.stringify(p.state), before);
  assert.ok(Object.isFrozen(p.state));
});
