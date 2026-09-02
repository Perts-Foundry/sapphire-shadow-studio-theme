// Contract tests: the registry is well-formed, findings obey the shape, redaction strips every
// secret shape, the differ reports SKIPPED not RESOLVED, and surfaces.md matches the registry
// both ways. Every lane's tests build on the same primitives; this file pins them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { installFetchGuard, memoryIo, fixedNow } from './harness.mjs';
installFetchGuard();

import { CHECKS, SURFACES, registryProblems, checkById, isSurfaceId, ID_RE, tierOf } from '../lib/registry.mjs';
import { makeFinding, skipFinding, cleanEvidence, sortFindings, EVIDENCE_MAX } from '../lib/finding.mjs';
import { redact, createRedactor } from '../lib/redact.mjs';
import { diffFindings, partitionAccepted, exitCodeFor, createStore, runFileName, latestRunName } from '../lib/state.mjs';
import { renderSurfacesRegion, parseSurfacesRegion } from '../lib/surfaces-doc.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(HERE, '..', '..', '..', '.claude', 'skills', 'site-check');

test('registry is well-formed', () => {
  assert.deepEqual(registryProblems(), []);
  assert.ok(CHECKS.length > 50);
  for (const s of SURFACES) assert.ok(ID_RE.test(s.id), s.id);
  assert.ok(isSurfaceId('cart'));
  assert.ok(!isSurfaceId('auto'));
  assert.equal(tierOf('cart-add'), 'A1');
  assert.equal(tierOf('nope'), null);
});

test('makeFinding builds the contract shape and refuses unregistered ids', () => {
  const f = makeFinding({ check: 'cart-add', subject: 'lead-ii-crewneck', message: 'add failed', evidence: 'status 500' });
  assert.deepEqual(Object.keys(f).sort(), ['check', 'evidence', 'id', 'message', 'severity', 'subject']);
  assert.equal(f.id, 'cart-add:lead-ii-crewneck');
  assert.equal(f.severity, checkById('cart-add').severity);
  assert.throws(() => makeFinding({ check: 'not-a-check', subject: 'x', message: 'm' }), /unregistered/);
  assert.throws(() => makeFinding({ check: 'cart-add', subject: 'has space', message: 'm' }), /whitespace/);
  assert.throws(() => makeFinding({ check: 'cart-add', subject: '2026-01-01T00:00', message: 'm' }), /timestamp/);
  assert.throws(() => makeFinding({ check: 'cart-add', subject: 'x', message: 'm', severity: 'FATAL' }), /unknown severity/);
});

test('identical inputs produce identical ids across two calls', () => {
  const a = makeFinding({ check: 'render-status', subject: '/cart', message: 'status 500' });
  const b = makeFinding({ check: 'render-status', subject: '/cart', message: 'status 503' });
  assert.equal(a.id, b.id);
});

test('evidence is control-stripped and truncated to 200', () => {
  const raw = `abc\td${'x'.repeat(400)}`;
  const out = cleanEvidence(raw);
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\x00-\x1f\x7f]/.test(out));
  assert.equal(out.length, EVIDENCE_MAX);
  assert.ok(out.endsWith('...'));
  assert.equal(cleanEvidence(null), '');
});

test('skipFinding and sortFindings', () => {
  const s = skipFinding('admin-scope-missing', 'read_shipping', 'scope not granted');
  assert.equal(s.severity, 'SKIPPED');
  const sorted = sortFindings([s, makeFinding({ check: 'variant-weight', subject: 'v1', message: 'm' }),
    makeFinding({ check: 'render-gate', subject: '/', message: 'm' })]);
  assert.deepEqual(sorted.map((f) => f.severity), ['ERROR', 'GATE', 'SKIPPED']);
});

test('redact strips every credential shape from a synthetic error', () => {
  const secrets = ['hunter2-storefront', 'shpss_clientsecretvalue'];
  const raw = [
    'Cookie: _secure_session_id=abc123; storefront_digest=def',
    'Set-Cookie: cart=Z2NwLXVzLWVhc3QxOjAxSkZ; Path=/',
    'POST /password?password=hunter2-storefront',
    'https://x.test/?preview_theme_id=1&key=0123456789abcdef',
    '/cart/c/Z2NwLXVzLWVhc3QxOjAxSkY?key=abc',
    '/checkouts/cn/Z2NwLXVzLWVhc3QxOjAxSkY',
    '{"token":"Z2NwLXVzLWVhc3QxOjAxSkY","items":[{"key":"123:abc"}]}',
    'X-Shopify-Access-Token: shpat_0123456789abcdef',
    'secret shpss_clientsecretvalue leaked; Authorization: Bearer eyJ.abc.def',
  ].join('\n');
  const out = redact(raw, secrets);
  for (const bad of ['abc123', 'Z2NwLXVzLWVhc3QxOjAxSkY', 'hunter2-storefront', '0123456789abcdef', '123:abc',
    'shpat_', 'clientsecretvalue', 'eyJ.abc.def']) {
    assert.ok(!out.includes(bad), `still contains ${bad}: ${out}`);
  }
  assert.ok(out.includes('[redacted'));
  const bound = createRedactor(secrets);
  assert.ok(!bound('pw hunter2-storefront').includes('hunter2'));
});

test('diffFindings reports SKIPPED rather than RESOLVED for a skipped check or tier', () => {
  const prev = [
    makeFinding({ check: 'variant-weight', subject: 'v1', message: '0 lb' }),
    makeFinding({ check: 'variant-sku-missing', subject: 'v1', message: 'no sku' }),
    makeFinding({ check: 'render-status', subject: '/cart', message: '500' }),
    makeFinding({ check: 'cart-add', subject: 'p', message: 'x' }),
  ];
  const cur = [
    skipFinding('variant-weight', 'read_products', 'scope missing'),
    skipFinding('render-status', 'tier:A1', 'STORE_PW absent'),
    makeFinding({ check: 'shop-gift-cards', subject: 'shop', message: 'off' }),
  ];
  const d = diffFindings(prev, cur);
  assert.deepEqual(d.skipped.map((f) => f.id).sort(), ['cart-add:p', 'render-status:/cart', 'variant-weight:v1']);
  assert.deepEqual(d.resolved.map((f) => f.id), ['variant-sku-missing:v1']);
  assert.deepEqual(d.added.map((f) => f.id), ['shop-gift-cards:shop']);
  assert.equal(d.unchanged.length, 0);
});

test('partitionAccepted matches on check and optional subject', () => {
  const findings = [
    makeFinding({ check: 'variant-weight', subject: 'v1', message: 'm' }),
    makeFinding({ check: 'variant-weight', subject: 'v2', message: 'm' }),
    makeFinding({ check: 'variant-sku-missing', subject: 'v1', message: 'm' }),
  ];
  const { fresh, accepted } = partitionAccepted(findings, [
    { check: 'variant-weight', subject: null, note: 'known', accepted_on: '2026-08-02' },
    { check: 'variant-sku-missing', subject: 'v9', note: 'other', accepted_on: '2026-08-02' },
  ]);
  assert.equal(accepted.length, 2);
  assert.deepEqual(fresh.map((f) => f.id), ['variant-sku-missing:v1']);
});

test('exit code: new ERRORs only, --strict any unaccepted ERROR, GATE never blocks', () => {
  const err = makeFinding({ check: 'variant-weight', subject: 'v1', message: 'm' });
  const gate = makeFinding({ check: 'render-gate', subject: '/', message: 'm' });
  assert.equal(exitCodeFor({ fresh: [err, gate], added: [gate], hasBaseline: true }), 0);
  assert.equal(exitCodeFor({ fresh: [err, gate], added: [gate], hasBaseline: true, strict: true }), 1);
  assert.equal(exitCodeFor({ fresh: [err], added: [], hasBaseline: false }), 1);
  assert.equal(exitCodeFor({ fresh: [gate], added: [gate], hasBaseline: false }), 0);
});

test('store: keyed by mode and lock state, save then loadLatest, no save leaves io empty', async () => {
  const io = memoryIo();
  const now = fixedNow();
  const store = createStore({ io, dir: '/state', now });
  assert.equal(await store.loadLatest('auto', 'LOCKED'), null);
  const f = [makeFinding({ check: 'variant-weight', subject: 'v1', message: 'm' })];
  await store.save('auto', 'LOCKED', f, { host: 'example.test' });
  now.tick();
  await store.save('auto', 'PUBLIC', [], {});
  const latest = await store.loadLatest('auto', 'LOCKED');
  assert.deepEqual(latest.findings, f);
  assert.equal((await store.loadLatest('auto', 'PUBLIC')).findings.length, 0);
  assert.equal(io.files.size, 2);
  assert.throws(() => runFileName('auto', 'OPEN', now), /LOCKED or PUBLIC/);
  assert.equal(latestRunName(['auto-LOCKED-a.json', 'auto-LOCKED-b.json', 'x'], 'auto', 'LOCKED'), 'auto-LOCKED-b.json');
  const empty = memoryIo();
  createStore({ io: empty, dir: '/s', now });
  assert.equal(empty.files.size, 0);
});

test('surfaces.md generated region matches the registry both ways', () => {
  const md = readFileSync(join(SKILL_DIR, 'surfaces.md'), 'utf8');
  const { region, ids } = parseSurfacesRegion(md);
  assert.equal(region, renderSurfacesRegion(), 'run: node scripts/site-check/lib/regen-surfaces.mjs');
  const registryIds = CHECKS.map((c) => c.id).sort();
  assert.deepEqual([...new Set(ids)].sort(), registryIds);
});

test('accepted-risks.json is check-id keyed and carries no volatile identifiers', () => {
  const text = readFileSync(join(HERE, '..', 'accepted-risks.json'), 'utf8');
  const entries = JSON.parse(text);
  assert.ok(Array.isArray(entries));
  for (const e of entries) {
    assert.ok(checkById(e.check), `unregistered check ${e.check}`);
    assert.ok(e.note && /^\d{4}-\d{2}-\d{2}$/.test(e.accepted_on), e.check);
    assert.ok(!('subject' in e) || e.subject === null || typeof e.subject === 'string');
  }
  assert.ok(!/@|#\d{4,}|order[- ]?\d/i.test(text), 'no emails, order numbers or addresses in accepted-risks.json');
});

test('importing smoke.mjs with an empty env has no side effects', async () => {
  const saved = { ...process.env };
  const exit = process.exit;
  const writes = [];
  const outWrite = process.stdout.write;
  const errWrite = process.stderr.write;
  for (const k of Object.keys(process.env)) if (/SHOPIFY|SMOKE|STORE|GITHUB|INPUT_/.test(k)) delete process.env[k];
  process.exit = (c) => { throw new Error(`process.exit(${c}) called at import`); };
  process.stdout.write = (s) => { writes.push(String(s)); return true; };
  process.stderr.write = (s) => { writes.push(String(s)); return true; };
  try {
    const smoke = await import('../../../.github/actions/shopify-theme-push/smoke.mjs');
    assert.equal(typeof smoke.authenticateStorefront, 'function');
    assert.equal(typeof smoke.fetchWithBody, 'function');
    assert.equal(typeof smoke.parseThemeId, 'function');
    assert.equal(typeof smoke.createRetryBudget, 'function');
    assert.deepEqual(writes, []);
  } finally {
    process.exit = exit;
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
