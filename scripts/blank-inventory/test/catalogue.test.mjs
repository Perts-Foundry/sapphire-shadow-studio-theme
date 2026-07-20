import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate, normaliseVariant, assertVariantShape, readCatalogue, createGroupReader } from '../lib/catalogue.mjs';

/** Build a canned Relay connection page source. */
function pager(pages) {
  let i = 0;
  return async (cursor) => {
    const page = pages[i];
    assert.equal(cursor, i === 0 ? null : `cursor-${i - 1}`, 'cursor must be threaded through');
    i++;
    return page;
  };
}

const rawVariant = (over = {}) => ({
  id: over.id ?? 'gid://shopify/ProductVariant/1',
  title: over.title ?? 'RN / Grey Heather / 2XL',
  inventoryQuantity: over.inventoryQuantity ?? 11,
  inventoryPolicy: 'DENY',
  product: { id: 'gid://shopify/Product/1', handle: 'product-a' },
  selectedOptions: over.selectedOptions ?? [
    { name: 'Design', value: 'RN' },
    { name: 'Color', value: 'Grey Heather' },
    { name: 'Size', value: '2XL' },
  ],
  inventoryItem: {
    id: 'gid://shopify/InventoryItem/1',
    tracked: true,
    inventoryLevels: { nodes: over.levels ?? [{ location: { id: 'gid://shopify/Location/1', name: 'Studio' } }] },
  },
  metafield: over.metafield !== undefined ? over.metafield : { id: 'gid://shopify/Metafield/1', value: 'GREY_ACME_FLEECE_0001_2XL' },
});

test('paginate walks every page and threads the cursor', async () => {
  const fetchPage = pager([
    { nodes: [1, 2], pageInfo: { hasNextPage: true, endCursor: 'cursor-0' } },
    { nodes: [3], pageInfo: { hasNextPage: true, endCursor: 'cursor-1' } },
    { nodes: [4, 5], pageInfo: { hasNextPage: false, endCursor: null } },
  ]);
  const { nodes, pages } = await paginate(fetchPage);
  assert.deepEqual(nodes, [1, 2, 3, 4, 5]);
  assert.equal(pages, 3);
});

test('paginate refuses a malformed page rather than silently returning short', async () => {
  await assert.rejects(() => paginate(async () => ({ nodes: [1] })), /Malformed connection page/);
});

test('paginate refuses to spin forever', async () => {
  const endless = async () => ({ nodes: [1], pageInfo: { hasNextPage: true, endCursor: 'c' } });
  await assert.rejects(() => paginate(endless, { maxPages: 3 }), /exceeded 3 pages/);
});

test('normaliseVariant projects the fields the planner needs', () => {
  const v = normaliseVariant(rawVariant());
  assert.equal(v.color, 'Grey Heather');
  assert.equal(v.size, '2XL');
  assert.equal(v.quantity, 11);
  assert.equal(v.blankId, 'GREY_ACME_FLEECE_0001_2XL');
  assert.deepEqual(v.locationIds, ['gid://shopify/Location/1']);
});

test('normaliseVariant treats an absent or whitespace metafield as untagged', () => {
  assert.equal(normaliseVariant(rawVariant({ metafield: null })).blankId, null);
  assert.equal(normaliseVariant(rawVariant({ metafield: { id: 'x', value: '   ' } })).blankId, null);
});

test('assertVariantShape fails loudly when the API drops a field it depends on', () => {
  const broken = rawVariant();
  delete broken.inventoryItem;
  assert.throws(() => assertVariantShape(broken, 3), /missing field\(s\): inventoryItem/);
});

test('assertVariantShape tolerates a null metafield (legitimately untagged)', () => {
  assert.doesNotThrow(() => assertVariantShape(rawVariant({ metafield: null })));
});

test('readCatalogue refuses a truncated read instead of treating it as clean', async () => {
  // products claim 3 variants; the variant connection returns 2.
  await assert.rejects(
    () =>
      readCatalogue({
        fetchProductsPage: pager([{ nodes: [{ handle: 'a', variantsCount: { count: 3 } }], pageInfo: { hasNextPage: false } }]),
        fetchVariantsPage: pager([
          { nodes: [rawVariant({ id: 'gid://shopify/ProductVariant/1' }), rawVariant({ id: 'gid://shopify/ProductVariant/2' })], pageInfo: { hasNextPage: false } },
        ]),
        fetchLocations: async () => [{ id: 'gid://shopify/Location/1', isActive: true }],
      }),
    /Variant read is incomplete/
  );
});

test('readCatalogue returns normalised variants when the counts agree', async () => {
  const { variants, products } = await readCatalogue({
    fetchProductsPage: pager([{ nodes: [{ handle: 'a', variantsCount: { count: 1 } }], pageInfo: { hasNextPage: false } }]),
    fetchVariantsPage: pager([{ nodes: [rawVariant()], pageInfo: { hasNextPage: false } }]),
    fetchLocations: async () => [{ id: 'gid://shopify/Location/1', isActive: true }],
  });
  assert.equal(products.length, 1);
  assert.equal(variants.length, 1);
  assert.equal(variants[0].blankId, 'GREY_ACME_FLEECE_0001_2XL');
});

test('createGroupReader performs an INDEPENDENT read per call, never a cached snapshot', async () => {
  // apply's drift check only works if it sees the store as it is at the moment of each write.
  // Serving every row from one snapshot taken before the run silently disables it, which is exactly
  // the bug this test exists to catch.
  let reads = 0;
  const readGroup = createGroupReader(async () => {
    reads++;
    return new Map([['B', [{ id: 'v1', quantity: reads }]]]);
  });

  const first = await readGroup('B');
  const second = await readGroup('B');
  assert.equal(reads, 2, 'two invocations must trigger two reads');
  assert.equal(first[0].quantity, 1);
  assert.equal(second[0].quantity, 2, 'the second call must observe the newer state');
});

test('createGroupReader returns an empty group for an unknown blank', async () => {
  const readGroup = createGroupReader(async () => new Map());
  assert.deepEqual(await readGroup('missing'), []);
});
