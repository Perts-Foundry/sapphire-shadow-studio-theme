import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs, gidDriftProblem, colorDriftProblem, checkProducts, classifyResolveError,
  fetchAllConnection,
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


// --- fetchAllConnection --------------------------------------------------------------------
// Regression cover for the silent truncation: `variants(first: 100)` with no hasNextPage check
// yielded 100 of a 144-variant product's variants and dropped the other 44 without an error, so 88
// variants across two products would have kept a Black hero for every colour while the run still
// reported success. `media` had the identical shape, where a truncated read makes pollMediaReady
// report a processing timeout for media that was actually fine.

const page = (ids, hasNextPage, endCursor = null) => ({
  pageInfo: { hasNextPage, endCursor },
  nodes: ids.map((i) => ({
    id: `gid://shopify/ProductVariant/${i}`,
    title: `v${i}`,
    selectedOptions: [{ name: 'Color', value: 'Black' }],
  })),
});
const ids = (nodes) => nodes.map((n) => Number(n.id.split('/').pop()));

test('fetchAllConnection returns the first page without querying when there is no next page', async () => {
  let calls = 0;
  const nodes = await fetchAllConnection(
    () => { calls++; throw new Error('should not paginate'); },
    'gid://shopify/Product/1', 'variants', page([1, 2, 3], false),
  );
  assert.deepEqual(ids(nodes), [1, 2, 3]);
  assert.equal(calls, 0, 'the single-page case must cost zero extra round trips');
});

test('fetchAllConnection follows every page, in order, threading the cursor', async () => {
  const rest = [
    { product: { variants: page([101, 102], true, 'c2') } },
    { product: { variants: page([103], false) } },
  ];
  const cursors = [];
  const nodes = await fetchAllConnection(
    async (_q, vars) => { cursors.push(vars.after); return rest.shift(); },
    'gid://shopify/Product/1', 'variants', page([1, 2, 100], true, 'c1'),
  );
  assert.deepEqual(ids(nodes), [1, 2, 100, 101, 102, 103]);
  assert.deepEqual(cursors, ['c1', 'c2'], 'each page must be requested with the prior endCursor');
});

test('fetchAllConnection recovers all 144 variants of an 8-design product', async () => {
  // The exact shape that regressed: a 100-wide first page, 44 beyond it.
  const first = page(Array.from({ length: 100 }, (_, i) => i + 1), true, 'cur');
  const rest = { product: { variants: page(Array.from({ length: 44 }, (_, i) => i + 101), false) } };
  const nodes = await fetchAllConnection(async () => rest, 'gid://shopify/Product/1', 'variants', first);
  assert.equal(nodes.length, 144, 'every variant must be read, not just the first page');
});

test('fetchAllConnection reads the media connection off the media field', async () => {
  const rest = { product: { media: page([2], false) } };
  const seen = [];
  const nodes = await fetchAllConnection(
    async (q) => { seen.push(q); return rest; },
    'gid://shopify/Product/1', 'media', page([1], true, 'c1'),
  );
  assert.deepEqual(ids(nodes), [1, 2]);
  assert.match(seen[0], /ProductMediaPage/, 'the media field must use the media page query');
});

test('fetchAllConnection throws rather than returning a partial read', async () => {
  await assert.rejects(
    () => fetchAllConnection(async () => ({ product: null }), 'gid://shopify/Product/1', 'variants',
      page([1], true, 'c1')),
    /no variants connection/,
  );
  await assert.rejects(
    () => fetchAllConnection(async () => ({ product: { media: null } }), 'gid://shopify/Product/1',
      'media', page([1], true, 'c1')),
    /no media connection/,
  );
});

test('fetchAllConnection stops a runaway connection instead of spinning', async () => {
  await assert.rejects(
    () => fetchAllConnection(
      async () => ({ product: { variants: page([2], true, 'c') } }),
      'gid://shopify/Product/1', 'variants', page([1], true, 'c')),
    /Pagination exceeded 20 pages/,
  );
});
