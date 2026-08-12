import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs, gidDriftProblem, colorDriftProblem, checkProducts, classifyResolveError,
} from './upload-product-media.mjs';
import { PRODUCTS, recognizedColorValues } from './lib/photo-naming.mjs';

// No test here touches the network: the drift predicates are pure, and checkProducts takes an
// injected resolver. Importing the module must not run main() (the entrypoint guard).

const KEY = 'lead2/crew-sweater';
const RECORD = PRODUCTS[KEY];

// --- gidDriftProblem -----------------------------------------------------------------------
test('gidDriftProblem passes a matching GID and flags a drifted one', () => {
  assert.equal(gidDriftProblem(RECORD.gid, KEY), null);
  const msg = gidDriftProblem('gid://shopify/Product/1', KEY);
  assert.match(msg, /GID drift/);
  assert.match(msg, new RegExp(RECORD.handle));
});

test('gidDriftProblem returns null for an unknown key', () => {
  assert.equal(gidDriftProblem('gid://shopify/Product/1', 'nope/nope'), null);
  assert.equal(gidDriftProblem('gid://shopify/Product/1', null), null);
});

// --- colorDriftProblem ---------------------------------------------------------------------
test('colorDriftProblem passes when live values equal the recorded set', () => {
  assert.equal(colorDriftProblem(recognizedColorValues(KEY), KEY), null);
});

test('colorDriftProblem flags missing, extra, and renamed values', () => {
  assert.match(colorDriftProblem(['Black', 'Grey Heather'], KEY), /Color option drift/);
  assert.match(colorDriftProblem([...recognizedColorValues(KEY), 'Chartreuse'], KEY), /Color option drift/);
  // A rename shows up as one missing + one extra.
  assert.match(colorDriftProblem(['Black', 'Gray', 'Classic Navy'], KEY), /Color option drift/);
});

test('colorDriftProblem returns null for an unknown key', () => {
  assert.equal(colorDriftProblem(['Anything'], 'nope/nope'), null);
});

// --- classifyResolveError ------------------------------------------------------------------
test('classifyResolveError distinguishes drift, auth, and other failures', () => {
  assert.equal(classifyResolveError(new Error(colorDriftProblem(['Black'], KEY))), 'drift');
  assert.equal(classifyResolveError(new Error(gidDriftProblem('gid://shopify/Product/1', KEY))), 'drift');
  assert.equal(classifyResolveError(new Error('Token exchange failed (401): {}')), 'auth');
  assert.equal(classifyResolveError(new Error('Missing required scope(s): write_files')), 'auth');
  assert.equal(classifyResolveError(new Error('HTTP 403: forbidden')), 'auth');
  assert.equal(classifyResolveError(new Error('no product resolves for handle "x"')), 'other');
  assert.equal(classifyResolveError(null), 'other');
});

// --- checkProducts (injected resolver, no network) -----------------------------------------
test('checkProducts reports ok for every product and exits clean', async () => {
  const { ok, lines } = await checkProducts(PRODUCTS, async (handle) => ({
    colorValues: ['Black'],
    product: { id: 'x' },
    key: null,
    variantsByColor: new Map(),
  }));
  assert.equal(ok, true);
  assert.equal(lines.length, Object.keys(PRODUCTS).length);
  for (const p of Object.values(PRODUCTS)) {
    assert.ok(lines.some((l) => l.startsWith('ok') && l.includes(p.handle)), `line for ${p.handle}`);
  }
});

test('checkProducts labels a drift failure DRIFT and reports not-ok', async () => {
  const { ok, lines } = await checkProducts(PRODUCTS, async (handle) => {
    if (handle === RECORD.handle) throw new Error(colorDriftProblem(['Black'], KEY));
    return { colorValues: ['Black'] };
  });
  assert.equal(ok, false);
  const bad = lines.find((l) => l.includes(RECORD.handle));
  assert.match(bad, /^DRIFT /);
  assert.equal(lines.filter((l) => l.startsWith('ok')).length, Object.keys(PRODUCTS).length - 1);
});

test('checkProducts labels an auth failure distinctly from drift', async () => {
  const { ok, lines } = await checkProducts(PRODUCTS, async () => {
    throw new Error('HTTP 401 unauthorized');
  });
  assert.equal(ok, false);
  for (const l of lines) assert.match(l, /^AUTH {2}/);
});

// --- parseArgs -----------------------------------------------------------------------------
test('parseArgs accepts --check-products alone', () => {
  const opts = parseArgs(['--check-products']);
  assert.equal(opts.checkProducts, true);
  assert.equal(opts.product, null);
  assert.equal(opts.all, false);
});

test('parseArgs refuses --check-products combined with upload scoping', () => {
  assert.throws(() => parseArgs(['--check-products', '--product', 'x']), /standalone preflight/);
  assert.throws(() => parseArgs(['--check-products', '--all']), /standalone preflight/);
  assert.throws(() => parseArgs(['--check-products', '--dry-run']), /standalone preflight/);
  assert.throws(() => parseArgs(['--check-products', '--manifest', 'm.csv']), /standalone preflight/);
});

test('parseArgs still refuses an unscoped run without --check-products', () => {
  assert.throws(() => parseArgs([]), /Refusing an unscoped run/);
  assert.throws(() => parseArgs(['--dry-run']), /Refusing an unscoped run/);
  assert.equal(parseArgs(['--product', 'x']).product, 'x');
  assert.equal(parseArgs(['--all']).all, true);
});
