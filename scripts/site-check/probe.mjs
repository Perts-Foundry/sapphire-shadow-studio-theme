#!/usr/bin/env node
// Tier A1 storefront probe: render every audited path, read the storefront JSON endpoints, and
// drive the Ajax cart through a reducer-planned flow, then diff against the baseline.
//
// Side effects on the store: session-scoped cart writes only (add / update / change / clear on
// this session's own cart), cleared in `finally`. No orders, no Admin writes.
//
// This file owns all I/O (fetch, fs, env, argv, clock). Everything it decides with lives in
// lib/ as pure functions the unit tests drive over a scripted fetch. The password is read from
// STORE_PW (preferred) or STOREFRONT_PASSWORD, never from argv, and never printed: the log sink
// is wrapped by createRedactor([password]).
//
// Usage: node scripts/site-check/probe.mjs [--full] [--no-save] [--strict] [--json]
//          [--theme-id <id>] [--pace <ms>] [--max <n>] [--surface <id>] [--skip-cart]

import { promises as fsp, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  authenticateStorefront, updateJar, cookieHeader, BROWSER_HEADERS, hostOf,
  createRetryBudget, fetchWithBody, parseProductLocs, parseProductSitemapChildren,
} from '../../.github/actions/shopify-theme-push/smoke.mjs';
import { fetchPage, landedOnPassword } from '../seo-review/lib/http.mjs';
import { parsePageType } from '../seo-review/lib/extract.mjs';
import { resolvedPaths } from '../a11y/build-pa11yci.mjs';
import {
  readCommittedCatalogue, garmentProducts, nonGarmentProducts, colorValuesFor, sizeValuesFor, optionName,
} from '../lib/catalogue-manifest.mjs';

import { makeFinding, skipFinding, sortFindings } from './lib/finding.mjs';
import { createRedactor } from './lib/redact.mjs';
import { createStore, diffFindings, partitionAccepted, exitCodeFor } from './lib/state.mjs';
import { isSurfaceId } from './lib/registry.mjs';
import { classifyRender, createThemeTracker, coverageFindings } from './lib/render.mjs';
import { markerRuleFor } from './lib/markers.mjs';
import {
  classifyProductJson, classifyCollectionJson, classifySearchSuggest, classifyRecommendations,
  classifyNotFound, safeJson, pickAvailableVariant, expectedVariantCount,
} from './lib/endpoints.mjs';
import { createCartPlan, repoPropertyKeysFor, toCents } from './lib/cart.mjs';
import { DEFAULT_LIVE_THEME_ID } from './lib/tools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const DEFAULT_BASE_URL = 'https://sapphireshadowstudio.com';
const MODE = 'probe';
const A1_SURFACES = ['storefront-render', 'json-endpoints', 'cart'];
const GARBAGE_PATH = '/site-check-intentionally-missing-path';
const BACKOFF = [8000, 20000];
const CART_PACE_MIN_MS = 3000;
const THROTTLE_COOLDOWN_MS = 30000;
const TIMEOUT_MS = 30000;

const USAGE = `Usage: node scripts/site-check/probe.mjs [options]

Tier A1 storefront probe (render, JSON endpoints, Ajax cart). Session-scoped cart writes only.

Options:
  --full              probe every catalogue product in the cart flow (default: one garment per body + gift card)
  --no-save           do not write a run file to the state dir
  --strict            exit 1 on any unaccepted ERROR, not only ERRORs new since the baseline
  --json              print the findings array as JSON after the report
  --theme-id <id>     expected live theme id (else LIVE_THEME_ID; else the first served id, with an INFO note)
  --pace <ms>         delay between requests (default 1200)
  --max <n>           cap on sitemap products probed in the render pass
  --surface <id>      run one surface only (storefront-render | json-endpoints | cart); never saves
  --skip-cart         skip the cart flow
  -h, --help          this text

Environment:
  BASE_URL                       storefront origin (default ${DEFAULT_BASE_URL})
  STORE_PW | STOREFRONT_PASSWORD storefront password while the store is locked (never printed)
  LIVE_THEME_ID                  expected live theme id
  SITE_CHECK_STATE_DIR           baseline dir (default ~/.local/state/site-check)
`;

export function parseArgs(argv) {
  const o = { full: false, noSave: false, strict: false, json: false, themeId: null, pace: 1200, max: null, surface: null, skipCart: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => { i += 1; if (i >= argv.length) throw new Error(`${a} needs a value`); return argv[i]; };
    switch (a) {
      case '--full': o.full = true; break;
      case '--no-save': o.noSave = true; break;
      case '--strict': o.strict = true; break;
      case '--json': o.json = true; break;
      case '--skip-cart': o.skipCart = true; break;
      case '--theme-id': o.themeId = val(); if (!/^\d+$/.test(o.themeId)) throw new Error('--theme-id must be numeric'); break;
      case '--pace': o.pace = Number(val()); if (!Number.isInteger(o.pace) || o.pace < 0) throw new Error('--pace must be a non-negative integer'); break;
      case '--max': o.max = Number(val()); if (!Number.isInteger(o.max) || o.max < 0) throw new Error('--max must be a non-negative integer'); break;
      case '--surface': o.surface = val(); if (!A1_SURFACES.includes(o.surface)) throw new Error(`--surface must be one of ${A1_SURFACES.join(', ')}`); break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  if (o.surface && !isSurfaceId(o.surface)) throw new Error(`unregistered surface ${o.surface}`);
  return o;
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A JSON-endpoint request through the session jar. Returns { status, body, finalUrl }. */
async function fetchJson(url, { jar, fetchImpl, method = 'GET', json = null }) {
  const headers = { ...BROWSER_HEADERS, accept: 'application/json, text/javascript, */*; q=0.01', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' };
  if (jar.size) headers.cookie = cookieHeader(jar);
  if (json !== null) headers['content-type'] = 'application/json';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(url, { method, headers, body: json !== null ? JSON.stringify(json) : undefined, redirect: 'follow', signal: ctl.signal });
  } catch {
    return { status: null, body: '', finalUrl: null };
  } finally {
    clearTimeout(timer);
  }
  updateJar(jar, res);
  let body = '';
  try { body = await res.text(); } catch { body = ''; }
  return { status: res.status, body, finalUrl: res.url || url };
}

function readJsonFile(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** Theme settings the cart flow compares against (defaults mirror snippets/shipping-info.liquid). */
function shippingSettings() {
  const data = readJsonFile(join(REPO, 'config', 'settings_data.json'));
  const current = data && typeof data.current === 'object' ? data.current : {};
  return {
    thresholdCents: toCents(current.free_shipping_threshold || '75.00'),
    flatRateCents: toCents(current.flat_rate_shipping || '8.00'),
    vacationEnabled: Boolean(current.vacation_mode_enabled),
    vacationLabel: current.vacation_property_label || 'Delayed processing acknowledged',
  };
}

function returnPolicyDefaultLabel() {
  const schema = readJsonFile(join(REPO, 'locales', 'en.default.schema.json'));
  return schema?.settings?.return_policy_acknowledgment?.default_property_label || 'Customer confirm size guide & return policy';
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { process.stderr.write(`${e.message}\n${USAGE}`); return 2; }
  if (opts.help) { process.stdout.write(USAGE); return 0; }

  const baseUrl = (env.BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const password = env.STORE_PW || env.STOREFRONT_PASSWORD || '';
  // The live id is public (README, deploy.yml) and stable; the env and flag exist for a preview run.
  const expectedThemeId = opts.themeId || env.LIVE_THEME_ID || DEFAULT_LIVE_THEME_ID;
  const stateDir = env.SITE_CHECK_STATE_DIR || join(homedir(), '.local', 'state', 'site-check');
  const redact = createRedactor([password]);
  const log = (line) => process.stdout.write(`${redact(line)}\n`);
  const fetchImpl = globalThis.fetch;
  const sleep = (ms) => realSleep(ms);
  const pace = () => sleep(opts.pace);
  // Cart endpoints throttle harder than page renders (a full loop tripped 429 at 1200 ms), so the
  // cart flow never runs faster than CART_PACE_MIN_MS whatever --pace says.
  const cartPace = () => sleep(Math.max(opts.pace, CART_PACE_MIN_MS));
  const expectedHost = hostOf(baseUrl);
  const jar = new Map();
  const budget = createRetryBudget();
  const findings = [];
  const surfaces = opts.surface ? [opts.surface] : A1_SURFACES;
  const runs = (s) => surfaces.includes(s);
  const counts = { products: 0, structural: 0, json: 0, cartSteps: 0 };
  const tracker = createThemeTracker({ expectedThemeId });

  // 1. Lock state: anonymous GET of / resolving to 200 not on /password = PUBLIC.
  const root = await fetchPage(`${baseUrl}/`, { fetchImpl, anonymous: true, timeoutMs: TIMEOUT_MS, backoff: BACKOFF, sleepImpl: sleep });
  const lockState = root.status === 200 && !landedOnPassword(root) ? 'PUBLIC' : 'LOCKED';
  log(`site-check probe: ${expectedHost} is ${lockState}`);

  if (lockState === 'LOCKED') {
    if (!password) {
      findings.push(skipFinding('render-gate', 'tier:A1', 'storefront is LOCKED and neither STORE_PW nor STOREFRONT_PASSWORD is set'));
      return finish({ findings, lockState, opts, stateDir, log, meta: { host: expectedHost } });
    }
    const outcome = await authenticateStorefront({ baseUrl, password, jar, fetchImpl, sleep, backoff: BACKOFF, budget, onRetry: log });
    if (outcome !== 'success') {
      findings.push(makeFinding({ check: 'render-gate', subject: '/password', message: `storefront password ${outcome}; nothing probed`, evidence: `auth ${outcome}` }));
      return finish({ findings, lockState, opts, stateDir, log, meta: { host: expectedHost } });
    }
    log('auth: success');
  }

  const manifest = readCommittedCatalogue();
  const garments = garmentProducts(manifest);
  const others = nonGarmentProducts(manifest);
  const colorName = optionName(manifest, 'color');
  const sizeName = optionName(manifest, 'size');
  const sectionIds = new Map();   // handle -> product-recommendations section id, from the render pass
  const productJson = new Map();  // handle -> parsed /products/<handle>.js

  // 2. Storefront render.
  if (runs('storefront-render')) {
    const entries = resolvedPaths().paths.map((e) => ({ ...e }));
    const known = new Set(entries.map((e) => e.path));
    let sitemapProducts = [];
    try {
      const index = await fetchWithBody(`${baseUrl}/sitemap.xml`, { jar, fetchImpl, sleep, backoff: BACKOFF, timeoutMs: TIMEOUT_MS, budget, onRetry: log, maxAttempts: 3 });
      const children = parseProductSitemapChildren(index);
      const locs = children.length ? [] : parseProductLocs(index);
      for (const child of children) {
        locs.push(...parseProductLocs(await fetchWithBody(child, { jar, fetchImpl, sleep, backoff: BACKOFF, timeoutMs: TIMEOUT_MS, budget, onRetry: log })));
      }
      sitemapProducts = [...new Set(locs)].filter((p) => !known.has(p)).map((p) => ({ path: p, label: 'product (sitemap)', template: null }));
    } catch (e) {
      findings.push(makeFinding({ check: 'sitemap-unreadable', subject: '/sitemap.xml', message: 'the product sitemap could not be read', evidence: String(e && e.message ? e.message : e).replace(/https?:\/\/\S+/g, '<url>') }));
    }
    if (opts.max !== null) sitemapProducts = sitemapProducts.slice(0, opts.max);
    for (const entry of [...entries, ...sitemapProducts]) {
      const res = await fetchPage(`${baseUrl}${entry.path}`, { jar, fetchImpl, timeoutMs: TIMEOUT_MS, backoff: BACKOFF, sleepImpl: sleep });
      const pageType = parsePageType(res.serverTiming);
      const rule = markerRuleFor({ ...entry, pageType });
      const isProduct = /^\/products\//.test(entry.path);
      const batch = classifyRender({ path: entry.path, status: res.status, finalUrl: res.url, expectedHost, serverTiming: res.serverTiming, body: res.body, pageType, markerRule: rule });
      if (res.status === 200 && !batch.some((f) => f.check === 'render-gate')) {
        findings.push(...tracker.observe(res.serverTiming, entry.path));
        if (isProduct) counts.products += 1; else counts.structural += 1;
        if (isProduct) {
          const m = res.body.match(/id="shopify-section-(template--\d+__product_recommendations[^"]*)"/);
          if (m) sectionIds.set(entry.path.replace(/^\/products\//, ''), m[1]);
        }
      }
      findings.push(...tracker.tag(batch));
      log(`render ${entry.path} ${res.status ?? 'none'} ${batch.length ? batch.map((f) => f.check).join(',') : 'ok'}`);
      await pace();
    }
  }

  // 3. JSON endpoints.
  if (runs('json-endpoints') || runs('cart')) {
    for (const p of [...garments, ...others]) {
      const res = await fetchJson(`${baseUrl}/products/${p.handle}.js`, { jar, fetchImpl });
      const parsed = safeJson(res.body);
      if (parsed && typeof parsed === 'object') productJson.set(p.handle, parsed);
      if (runs('json-endpoints')) {
        const isGiftCard = p.body === null;
        const expected = isGiftCard
          ? { variantCount: null, requiresShipping: false, isGiftCard: true }
          : { variantCount: expectedVariantCount({ colors: colorValuesFor(manifest, p.handle).length, sizes: sizeValuesFor(manifest, p.handle).length }, parsed, [colorName, sizeName]), requiresShipping: true, isGiftCard: false };
        const batch = classifyProductJson({ handle: p.handle, status: res.status, body: res.body, finalUrl: res.finalUrl, expected });
        findings.push(...tracker.tag(batch));
        counts.json += 1;
        log(`json /products/${p.handle}.js ${res.status ?? 'none'} ${batch.length ? batch.map((f) => f.check).join(',') : 'ok'}`);
      }
      await pace();
    }
  }
  if (runs('json-endpoints')) {
    const census = manifest.products.size;
    const col = await fetchJson(`${baseUrl}/collections/all/products.json?limit=250`, { jar, fetchImpl });
    findings.push(...tracker.tag(classifyCollectionJson({ status: col.status, body: col.body, finalUrl: col.finalUrl, expectedCount: census })));
    counts.json += 1;
    await pace();
    const term = (garments[0]?.title || 'crewneck').split(/\s+/).pop().toLowerCase();
    const sug = await fetchJson(`${baseUrl}/search/suggest.json?q=${encodeURIComponent(term)}&resources[type]=product&resources[limit]=4`, { jar, fetchImpl });
    findings.push(...tracker.tag(classifySearchSuggest({ status: sug.status, body: sug.body, finalUrl: sug.finalUrl, term })));
    counts.json += 1;
    await pace();
    const recHandle = garments[0]?.handle;
    const recProduct = recHandle ? productJson.get(recHandle) : null;
    const sectionId = recHandle ? sectionIds.get(recHandle) : null;
    if (recProduct && sectionId) {
      const rec = await fetchJson(`${baseUrl}/recommendations/products.json?product_id=${recProduct.id}&section_id=${encodeURIComponent(sectionId)}&limit=4`, { jar, fetchImpl });
      findings.push(...tracker.tag(classifyRecommendations({ status: rec.status, body: rec.body, finalUrl: rec.finalUrl, handle: recHandle })));
      counts.json += 1;
      await pace();
    } else if (recHandle) {
      findings.push(skipFinding('recommendations', recHandle, sectionId ? 'product JSON unavailable' : 'no recommendations section id seen in the render pass'));
    }
    const nf = await fetchPage(`${baseUrl}${GARBAGE_PATH}`, { fetchImpl, anonymous: true, timeoutMs: TIMEOUT_MS, backoff: BACKOFF, sleepImpl: sleep });
    findings.push(...tracker.tag(classifyNotFound({ status: nf.status, finalUrl: nf.url, lockState, path: GARBAGE_PATH })));
    counts.json += 1;
    await pace();
  }

  // 4. Cart flow, one plan per sampled garment, cleared in finally.
  if (runs('cart') && !opts.skipCart) {
    const settings = shippingSettings();
    const defaultLabel = returnPolicyDefaultLabel();
    const giftCardProduct = others.map((p) => productJson.get(p.handle)).find((j) => j && j.variants?.some((v) => v.available)) || null;
    const giftCard = giftCardProduct ? { variantId: pickAvailableVariant(giftCardProduct).id } : null;
    const sample = opts.full ? garments : (() => {
      const seen = new Set();
      return garments.filter((p) => {
        if (seen.has(p.body)) return false;
        const j = productJson.get(p.handle);
        if (!j || !pickAvailableVariant(j)) return false;
        seen.add(p.body);
        return true;
      });
    })();
    for (const p of sample) {
      const j = productJson.get(p.handle);
      const variant = j ? pickAvailableVariant(j) : null;
      if (!variant) { findings.push(skipFinding('cart-add', p.handle, 'no available variant to add')); continue; }
      const template = readJsonFile(join(REPO, 'templates', `product.${p.template}.json`));
      const repoPropertyKeys = template ? repoPropertyKeysFor(template, { returnPolicyDefaultLabel: defaultLabel, vacationEnabled: settings.vacationEnabled, vacationLabel: settings.vacationLabel }) : [];
      const properties = repoPropertyKeys.includes('Applique Pattern') ? { 'Applique Pattern': 'site-check' } : {};
      const plan = createCartPlan({ garment: { handle: p.handle, variantId: variant.id, properties }, giftCard, thresholdCents: settings.thresholdCents, flatRateCents: settings.flatRateCents, repoPropertyKeys });
      let state = plan.state;
      let last = null;
      let out;
      try {
        for (;;) {
          out = plan.next(state, last);
          state = out.state;
          if (out.done) break;
          const { step } = out;
          const url = `${baseUrl}${step.path}`;
          if (step.kind === 'html') {
            const r = await fetchPage(url, { jar, fetchImpl, timeoutMs: TIMEOUT_MS, backoff: BACKOFF, sleepImpl: sleep });
            last = { status: r.status, body: r.body, finalUrl: r.url };
          } else {
            last = await fetchJson(url, { jar, fetchImpl, method: step.method, json: step.body ?? null });
          }
          counts.cartSteps += 1;
          log(`cart ${p.handle} ${step.name} ${step.method} ${step.path} ${last.status ?? 'none'}`);
          await cartPace();
        }
      } finally {
        // The reducer always routes to clear.js, so the only way to be here without it is a thrown
        // error mid-flow; clear anyway so the session cart never outlives the run.
        if (!out || !out.done) {
          const c = await fetchJson(`${baseUrl}/cart/clear.js`, { jar, fetchImpl, method: 'POST', json: {} });
          const v = await fetchJson(`${baseUrl}/cart.js`, { jar, fetchImpl });
          const n = safeJson(v.body)?.item_count;
          if (c.status !== 200 || n !== 0) findings.push(makeFinding({ check: 'cart-clear', subject: p.handle, message: 'the session cart is not empty after the emergency clear', evidence: `status ${c.status ?? 'none'} item_count ${n ?? 'unknown'}` }));
        }
      }
      findings.push(...tracker.tag(out.findings));
      // A throttle is one GATE for the run, not one per product: continuing would turn a single
      // 429 into a retry storm where every later product fails the same way. Cool down once so
      // the clear that already ran has a chance to have landed, then stop the cart flow here.
      if (out.findings.some((f) => f.check === 'cart-throttled')) {
        const rest = sample.slice(sample.indexOf(p) + 1);
        for (const q of rest) findings.push(skipFinding('cart-add', q.handle, 'cart flow stopped for the run after a throttle'));
        log(`cart flow stopped after a throttle; cooling down ${THROTTLE_COOLDOWN_MS}ms before the final clear`);
        await sleep(THROTTLE_COOLDOWN_MS);
        const c = await fetchJson(`${baseUrl}/cart/clear.js`, { jar, fetchImpl, method: 'POST', json: {} });
        log(`cart final clear POST /cart/clear.js ${c.status ?? 'none'}`);
        break;
      }
    }
  } else if (runs('cart') && opts.skipCart) {
    findings.push(skipFinding('cart-add', 'tier:A1-cart', '--skip-cart'));
  }

  if (runs('storefront-render')) findings.push(...coverageFindings({ ...counts, catalogueEmpty: manifest.products.size === 0 }));
  if (budget.budgetSpent || budget.tripped) {
    findings.push(makeFinding({ check: 'retry-budget-exhausted', subject: 'run', message: budget.tripped ? 'the edge was degraded and retries were disabled' : 'the run-wide retry sleep budget was spent', evidence: `retries ${budget.retries} slept ${budget.sleptMs}ms` }));
  }
  return finish({ findings, lockState, opts, stateDir, log, meta: { host: expectedHost, surfaces, themeId: tracker.expected } });
}

/** Report (NEW / RESOLVED / SKIPPED / UNCHANGED), accepted risks, save, exit code. */
async function finish({ findings, lockState, opts, stateDir, log, meta }) {
  const all = sortFindings(findings);
  const accepted = readJsonFile(join(HERE, 'accepted-risks.json')) || [];
  const { fresh, accepted: acceptedOut } = partitionAccepted(all, accepted);
  const io = {
    readdir: (d) => fsp.readdir(d),
    readFile: (p) => fsp.readFile(p, 'utf8'),
    writeFile: (p, t) => fsp.writeFile(p, t),
    mkdir: (d) => fsp.mkdir(d, { recursive: true }),
  };
  const store = createStore({ io, dir: stateDir });
  const previous = await store.loadLatest(MODE, lockState);
  const { added, resolved, unchanged, skipped } = diffFindings(previous ? previous.findings : null, fresh);
  log('');
  log(`== site-check probe (${lockState}): ${fresh.length} finding(s), ${acceptedOut.length} accepted risk(s) ==`);
  log(previous ? `baseline: ${previous.generated} (${added.length} new, ${resolved.length} resolved, ${skipped.length} skipped, ${unchanged.length} unchanged)` : 'baseline: none (first run; all findings are new)');
  const printList = (label, list) => {
    if (!list.length) return;
    log(`\n${label}:`);
    for (const f of list) log(`  [${f.severity}] ${f.check} ${f.subject}\n      ${f.message}${f.evidence ? ` (${f.evidence})` : ''}`);
  };
  printList('NEW since baseline', previous ? added : fresh.filter((f) => f.severity !== 'SKIPPED'));
  printList('RESOLVED since baseline', resolved);
  printList('SKIPPED this run (present in baseline)', skipped);
  printList('SKIPPED', fresh.filter((f) => f.severity === 'SKIPPED'));
  if (opts.full) {
    printList('UNCHANGED (still present)', unchanged);
    printList('ACCEPTED RISKS (known, deliberate)', acceptedOut);
  } else {
    if (unchanged.length) log(`\n(${unchanged.length} unchanged finding(s) suppressed; run with --full to see them)`);
    if (acceptedOut.length) log(`(${acceptedOut.length} accepted risk(s) suppressed; run with --full to see them)`);
  }
  const save = !opts.noSave && !opts.surface;
  if (save) log(`\nsaved run -> ${await store.save(MODE, lockState, fresh, meta)}`);
  else log('\n(run not saved)');
  const code = exitCodeFor({ fresh, added, hasBaseline: Boolean(previous), strict: opts.strict });
  log(`exit ${code}${opts.strict ? ' (--strict: any unaccepted ERROR)' : ' (blocks only on ERROR findings new since the baseline)'}`);
  if (opts.json) log(JSON.stringify(all, null, 2));
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`probe failed: ${createRedactor([process.env.STORE_PW || '', process.env.STOREFRONT_PASSWORD || ''])(String(e && e.stack ? e.stack : e))}\n`);
    process.exitCode = 2;
  });
}
