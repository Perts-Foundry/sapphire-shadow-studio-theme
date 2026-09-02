// Ajax cart flow (Tier A1), planned by a pure reducer.
//
// The orchestrator owns the network: it calls `next(state, lastResponse)`, executes the returned
// step with the session jar and a pacing delay, and feeds the response back. The reducer decides
// what to do next and what it learned; it never fetches, never sleeps, never reads the clock.
// That split is what lets a test drive the whole flow through a scripted fetch and assert the
// two properties that matter most:
//
//   - a throttle or challenge at ANY step ends the flow with one cart-throttled GATE and skips
//     straight to the clear step (abort-then-clear; no retry storm against a rate-limited edge),
//   - clear.js ALWAYS runs, and the run asserts item_count 0 afterwards (cart-clear otherwise).
//
// Line keys and the cart token are session secrets: they live in the state only, never in a
// finding's subject, message or evidence. The orchestrator's log sink is redacted as well, but
// the reducer's own rule is "nothing from them reaches a finding" regardless.

import { makeFinding } from './finding.mjs';
import { gateReason } from './render.mjs';
import { safeJson } from './endpoints.mjs';

export const FREE_SHIPPING_COPY = 'Free shipping on this order';
export const AWAY_FROM_FREE_COPY = 'away from free shipping';
export const FLAT_RATE_COPY_RE = /\$\d+(?:\.\d{2})?\s+shipping within the USA/;

/** Cents of a money value that may arrive as an integer (cents) or a decimal string. */
export function toCents(value) {
  if (typeof value === 'number') return Math.round(value);
  const n = Number(String(value ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Sum of final_line_price over lines that require shipping (the predicate checkout uses). */
export function shippableCents(cart) {
  const items = cart && Array.isArray(cart.items) ? cart.items : [];
  return items.reduce((sum, it) => (it.requires_shipping ? sum + toCents(it.final_line_price ?? 0) : sum), 0);
}

/** The free-shipping predicate, in cents: exactly equal qualifies. */
export function qualifiesForFreeShipping(shippable, thresholdCents) {
  return shippable >= thresholdCents;
}

/**
 * Which shipping sentence a rendered /cart body shows.
 * @returns {'free'|'flat'|null}
 */
export function renderedShippingState(html) {
  const text = typeof html === 'string' ? html : '';
  if (!text.includes('shipping-info')) return null;
  if (text.includes(FREE_SHIPPING_COPY)) return 'free';
  if (text.includes(AWAY_FROM_FREE_COPY) || FLAT_RATE_COPY_RE.test(text)) return 'flat';
  return null;
}

/** Decode the few entities an attribute value can carry. */
function decodeAttr(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/**
 * Line-item property keys the product form posts: every `name="properties[<key>]"` input or
 * select, deduplicated, in document order. Keys starting with `_` are hidden internals (the
 * embroidery price adjustment, the gift card offset) and are excluded from the comparison.
 * @param {string} html
 * @returns {string[]}
 */
export function parsePropertyKeys(html) {
  const text = typeof html === 'string' ? html : '';
  const out = [];
  const re = /name="properties\[([^\]"]+)\]"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const key = decodeAttr(m[1]);
    if (key.startsWith('_') || out.includes(key)) continue;
    out.push(key);
  }
  return out;
}

/** The checkbox values posted for the acknowledgment inputs, keyed by property key. */
export function parseCheckboxValues(html) {
  const text = typeof html === 'string' ? html : '';
  const out = {};
  const re = /<input\b[^>]*>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const tag = m[0];
    if (!/type="checkbox"/.test(tag)) continue;
    const name = tag.match(/name="properties\[([^\]"]+)\]"/);
    const value = tag.match(/value="([^"]*)"/);
    if (name && value) out[decodeAttr(name[1])] = decodeAttr(value[1]);
  }
  return out;
}

/**
 * The acknowledgment / custom property keys a committed product template declares, walking its
 * blocks recursively. The vacation block is dormant unless vacation mode is on, so it counts
 * only when `vacationEnabled`; the return-policy label falls back to the schema default.
 * @param {object} templateJson  parsed templates/product.<suffix>.json
 * @param {{returnPolicyDefaultLabel:string, vacationEnabled?:boolean, vacationLabel?:string}} o
 * @returns {string[]}
 */
export function repoPropertyKeysFor(templateJson, { returnPolicyDefaultLabel, vacationEnabled = false, vacationLabel = 'Delayed processing acknowledged' }) {
  const out = [];
  const add = (k) => { if (k && !out.includes(k)) out.push(k); };
  const walk = (blocks) => {
    if (!blocks || typeof blocks !== 'object') return;
    for (const b of Object.values(blocks)) {
      if (!b || typeof b !== 'object') continue;
      const st = b.settings || {};
      switch (b.type) {
        case 'return-policy-acknowledgment': add(st.property_label || returnPolicyDefaultLabel); break;
        case 'vacation-acknowledgment': if (vacationEnabled) add(vacationLabel); break;
        case 'applique-pattern-select':
        case 'product-custom-property': add(st.property_key); break;
        case 'embroidery-custom-text': add('Custom Embroidery Text'); break;
        default: break;
      }
      walk(b.blocks);
    }
  };
  for (const section of Object.values(templateJson?.sections || {})) walk(section?.blocks);
  return out;
}

const STEPS = [
  'product-page', 'precondition', 'clear-precondition', 'add-garment', 'roundtrip', 'update-quantity',
  'remove', 'add-gift-card', 'add-garment-mixed', 'mixed-cart', 'cart-render', 'clear', 'verify-clear', 'done',
];

/**
 * @param {object} o
 * @param {{handle:string, variantId:number|string, properties?:object}} o.garment
 * @param {{variantId:number|string}|null} [o.giftCard]
 * @param {number} o.thresholdCents
 * @param {number} o.flatRateCents
 * @param {string[]} [o.repoPropertyKeys]  acknowledgment keys the repo templates declare
 * @returns {{state: object, next: Function}}
 */
export function createCartPlan({ garment, giftCard = null, thresholdCents, flatRateCents, repoPropertyKeys = [] }) {
  if (!garment || !garment.handle || garment.variantId === undefined) throw new Error('createCartPlan needs a garment {handle, variantId}');
  if (!Number.isInteger(thresholdCents)) throw new Error('thresholdCents must be integer cents');
  const config = Object.freeze({
    garment: { handle: garment.handle, variantId: garment.variantId, properties: garment.properties || {} },
    giftCard: giftCard && giftCard.variantId !== undefined ? { variantId: giftCard.variantId } : null,
    thresholdCents,
    flatRateCents: Number.isInteger(flatRateCents) ? flatRateCents : 0,
    repoPropertyKeys: [...repoPropertyKeys],
  });
  const state = Object.freeze({
    config,
    step: 'product-page',
    findings: [],
    lineKey: null,          // session secret; never leaves the state
    learnedProperties: null,
    aborted: false,
    mixedCart: null,
  });
  return { state, next };
}

const subjectFor = (config) => config.garment.handle;
const mixedSubject = (config) => `${config.garment.handle}+gift-card`;

function stepRequest(name, config, state) {
  const g = config.garment;
  switch (name) {
    case 'product-page': return { method: 'GET', path: `/products/${g.handle}`, kind: 'html' };
    case 'precondition': return { method: 'GET', path: '/cart.js' };
    case 'clear-precondition': return { method: 'POST', path: '/cart/clear.js' };
    case 'add-garment':
    case 'add-garment-mixed':
      return { method: 'POST', path: '/cart/add.js', body: { items: [{ id: g.variantId, quantity: 1, properties: state.learnedProperties || g.properties }] } };
    case 'roundtrip': return { method: 'GET', path: '/cart.js' };
    case 'update-quantity': return { method: 'POST', path: '/cart/update.js', body: { updates: { [state.lineKey]: 2 } } };
    case 'remove': return { method: 'POST', path: '/cart/change.js', body: { id: state.lineKey, quantity: 0 } };
    case 'add-gift-card': return { method: 'POST', path: '/cart/add.js', body: { items: [{ id: config.giftCard.variantId, quantity: 1 }] } };
    case 'mixed-cart': return { method: 'GET', path: '/cart.js' };
    case 'cart-render': return { method: 'GET', path: '/cart', kind: 'html' };
    case 'clear': return { method: 'POST', path: '/cart/clear.js' };
    case 'verify-clear': return { method: 'GET', path: '/cart.js' };
    default: return null;
  }
}

/** Advance to a step, skipping the gift-card steps when no gift card was configured. */
function advance(state, to) {
  const { config } = state;
  let step = to;
  if (!config.giftCard && (step === 'add-gift-card' || step === 'add-garment-mixed' || step === 'mixed-cart' || step === 'cart-render')) step = 'clear';
  return { ...state, step };
}

function withFinding(state, finding) {
  return { ...state, findings: [...state.findings, finding] };
}

/** A cart response, or null when the body is not JSON (the caller decides what that means). */
function cartOf(res) {
  const j = safeJson(res.body);
  return j && typeof j === 'object' ? j : null;
}

function lineFor(cart, variantId) {
  const items = cart && Array.isArray(cart.items) ? cart.items : [];
  return items.find((it) => String(it.variant_id ?? it.id) === String(variantId)) || null;
}

/**
 * The reducer. `lastResponse` is { status, body, finalUrl? } for the step the previous call
 * returned, or null on the first call.
 * @returns {{step: {method:string, path:string, body?:object, kind?:string}, state: object}
 *   | {done: true, findings: Array, state: object}}
 */
export function next(state, lastResponse = null) {
  let s = state;
  if (lastResponse !== null) s = absorb(s, lastResponse);
  if (s.step === 'done') return { done: true, findings: s.findings, state: s };
  const req = stepRequest(s.step, s.config, s);
  return { step: { ...req, name: s.step }, state: s };
}

/** Fold the response to the current step into the state and pick the next step. */
function absorb(state, res) {
  const { config } = state;
  const subject = subjectFor(config);
  const status = res.status ?? null;

  // Gate first, at every step. Clear and verify-clear are exempt from the abort branch (they are
  // the abort target), but a throttle there is still recorded as the run's GATE.
  const gate = gateReason({ status, body: res.body, finalUrl: res.finalUrl });
  if (gate) {
    let s = state;
    if (!s.findings.some((f) => f.check === 'cart-throttled')) {
      s = withFinding(s, makeFinding({ check: 'cart-throttled', subject, message: `inconclusive at step ${state.step}: ${gate}`, evidence: `status ${status ?? 'none'}` }));
    }
    if (state.step === 'clear') return advance({ ...s, aborted: true }, 'verify-clear');
    if (state.step === 'verify-clear') return { ...s, step: 'done' };
    return advance({ ...s, aborted: true }, 'clear');
  }

  switch (state.step) {
    case 'product-page': {
      let s = state;
      if (status === 200) {
        const keys = parsePropertyKeys(res.body);
        const values = parseCheckboxValues(res.body);
        // Only checkbox acknowledgments carry a fixed value the form posts; free-text and select
        // properties are left to the configured garment properties.
        const learned = { ...config.garment.properties };
        for (const [k, v] of Object.entries(values)) learned[k] = v;
        s = { ...s, learnedProperties: learned };
        const repo = [...config.repoPropertyKeys].sort();
        const live = [...keys].sort();
        if (repo.length && JSON.stringify(repo) !== JSON.stringify(live)) {
          const missing = repo.filter((k) => !live.includes(k));
          const extra = live.filter((k) => !repo.includes(k));
          s = withFinding(s, makeFinding({
            check: 'cart-property-keys-mismatch', subject,
            message: 'acknowledgment property keys on the live product form differ from the repo templates',
            evidence: `missing [${missing.join('; ')}] extra [${extra.join('; ')}]`,
          }));
        }
      }
      return advance(s, 'precondition');
    }
    case 'precondition': {
      const cart = cartOf(res);
      if (cart && Number(cart.item_count) > 0) {
        const s = withFinding(state, makeFinding({ check: 'cart-precondition', subject, message: `session cart held ${cart.item_count} item(s) at start; cleared first`, evidence: `item_count ${cart.item_count}` }));
        return advance(s, 'clear-precondition');
      }
      return advance(state, 'add-garment');
    }
    case 'clear-precondition':
      return advance(state, 'add-garment');
    case 'add-garment':
    case 'add-garment-mixed': {
      const nextStep = state.step === 'add-garment' ? 'roundtrip' : 'mixed-cart';
      if (status === 422) {
        const j = cartOf(res);
        const desc = j && typeof j.description === 'string' ? j.description : (j && typeof j.message === 'string' ? j.message : '');
        const s = withFinding(state, makeFinding({ check: 'cart-add-422', subject, message: `/cart/add.js returned 422 for variant ${config.garment.variantId}`, evidence: desc || 'status 422' }));
        return advance({ ...s, aborted: true }, 'clear');
      }
      if (status !== 200) {
        const s = withFinding(state, makeFinding({ check: 'cart-add', subject, message: `/cart/add.js returned ${status ?? 'no response'} for variant ${config.garment.variantId}`, evidence: `status ${status ?? 'none'}` }));
        return advance({ ...s, aborted: true }, 'clear');
      }
      return advance(state, nextStep);
    }
    case 'roundtrip': {
      const cart = cartOf(res);
      const line = lineFor(cart, config.garment.variantId);
      const want = state.learnedProperties || config.garment.properties;
      const problems = [];
      if (!line) problems.push('variant absent');
      else {
        if (Number(line.quantity) !== 1) problems.push(`quantity ${line.quantity}`);
        const got = line.properties || {};
        for (const [k, v] of Object.entries(want)) {
          if (String(got[k] ?? '') !== String(v)) problems.push(`property ${k} not echoed`);
        }
      }
      if (problems.length) {
        const s = withFinding(state, makeFinding({ check: 'cart-roundtrip', subject, message: '/cart.js does not reflect the line just added', evidence: problems.join('; ') }));
        return advance({ ...s, aborted: true }, 'clear');
      }
      return advance({ ...state, lineKey: line.key }, 'update-quantity');
    }
    case 'update-quantity': {
      const cart = cartOf(res);
      const line = lineFor(cart, config.garment.variantId);
      if (status !== 200 || !line || Number(line.quantity) !== 2) {
        const s = withFinding(state, makeFinding({ check: 'cart-update-quantity', subject, message: 'quantity change to 2 did not round-trip', evidence: `status ${status ?? 'none'} quantity ${line ? line.quantity : 'absent'}` }));
        return advance({ ...s, aborted: true }, 'clear');
      }
      return advance(state, 'remove');
    }
    case 'remove': {
      const cart = cartOf(res);
      const line = lineFor(cart, config.garment.variantId);
      if (status !== 200 || line) {
        const s = withFinding(state, makeFinding({ check: 'cart-remove', subject, message: 'removal by line key did not round-trip', evidence: `status ${status ?? 'none'} ${line ? 'line still present' : ''}`.trim() }));
        return advance({ ...s, aborted: true }, 'clear');
      }
      return advance({ ...state, lineKey: null }, 'add-gift-card');
    }
    case 'add-gift-card': {
      if (status !== 200) {
        const s = withFinding(state, makeFinding({ check: 'cart-add', subject: 'gift-card', message: `/cart/add.js returned ${status ?? 'no response'} for gift card variant ${config.giftCard.variantId}`, evidence: `status ${status ?? 'none'}` }));
        return advance({ ...s, aborted: true }, 'clear');
      }
      const j = cartOf(res);
      const items = j && Array.isArray(j.items) ? j.items : (j ? [j] : []);
      const gc = items.find((it) => String(it.variant_id ?? it.id) === String(config.giftCard.variantId)) || items[0] || null;
      let s = state;
      if (gc && gc.requires_shipping) {
        s = withFinding(s, makeFinding({ check: 'cart-gift-card-shipping', subject: 'gift-card', message: 'the gift card line reports requires_shipping true', evidence: 'requires_shipping true' }));
      }
      return advance(s, 'add-garment-mixed');
    }
    case 'mixed-cart': {
      const cart = cartOf(res);
      const shippable = shippableCents(cart);
      const predicate = qualifiesForFreeShipping(shippable, config.thresholdCents);
      return advance({ ...state, mixedCart: { shippable, predicate } }, 'cart-render');
    }
    case 'cart-render': {
      let s = state;
      const rendered = renderedShippingState(res.body);
      const subj = mixedSubject(config);
      const { shippable, predicate } = state.mixedCart || { shippable: 0, predicate: false };
      if (status !== 200 || rendered === null) {
        s = withFinding(s, makeFinding({ check: 'cart-render-shipping-copy', subject: subj, message: 'the /cart render shows no shipping-info sentence for a cart with lines in it', evidence: `status ${status ?? 'none'}` }));
      } else if ((rendered === 'free') !== predicate) {
        s = withFinding(s, makeFinding({
          check: 'cart-threshold-predicate', subject: subj,
          message: `shippable ${shippable} cents vs threshold ${config.thresholdCents} cents predicts ${predicate ? 'free shipping' : 'the flat rate'}, but the cart renders ${rendered === 'free' ? 'free shipping' : 'the flat rate'}`,
          evidence: `shippable ${shippable} threshold ${config.thresholdCents} rendered ${rendered}`,
        }));
      }
      return advance(s, 'clear');
    }
    case 'clear':
      return advance(state, 'verify-clear');
    case 'verify-clear': {
      const cart = cartOf(res);
      const count = cart ? Number(cart.item_count) : null;
      let s = state;
      if (status !== 200 || count !== 0) {
        s = withFinding(s, makeFinding({ check: 'cart-clear', subject, message: 'the session cart is not empty after clear.js', evidence: `status ${status ?? 'none'} item_count ${count ?? 'unknown'}` }));
      }
      return { ...s, step: 'done' };
    }
    default:
      return { ...state, step: 'done' };
  }
}

export const CART_STEPS = Object.freeze([...STEPS]);
