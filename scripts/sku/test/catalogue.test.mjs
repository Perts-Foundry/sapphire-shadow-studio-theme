import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCatalogue, readProductSkus, normaliseVariant, assertVariantShape, liveFetchers } from '../lib/catalogue.mjs';
import { pagedFetcher, rawVariant, resetIds, PRODUCT_IDS } from './fixtures.mjs';

const productsPage = (count) =>
  pagedFetcher([[{ id: PRODUCT_IDS['lead-ii-crewneck'], handle: 'lead-ii-crewneck', title: 'Lead II Crewneck', status: 'ACTIVE', isGiftCard: false, variantsCount: { count } }]]);

test('a multi-page variant read is merged and normalised', async () => {
  resetIds();
  const variants = await readCatalogue({
    fetchProductsPage: productsPage(3),
    fetchVariantsPage: pagedFetcher([[rawVariant(), rawVariant()], [rawVariant({ sku: 'L2CN-RN-BLK-M' })]]),
  });
  assert.equal(variants.variants.length, 3);
  assert.equal(variants.variants[0].sku, null);
  assert.equal(variants.variants[2].sku, 'L2CN-RN-BLK-M');
  assert.deepEqual(variants.variants[0].options, { Design: 'RN (Registered Nurse)', Color: 'Black', Size: 'M' });
});

test('a truncated read is refused rather than reported as a clean catalogue', async () => {
  resetIds();
  await assert.rejects(
    readCatalogue({ fetchProductsPage: productsPage(431), fetchVariantsPage: pagedFetcher([[rawVariant()]]) }),
    /Variant read is incomplete: fetched 1, products report 431/
  );
});

test('an unselected sku field is refused, because it is indistinguishable from a null one', () => {
  const node = rawVariant();
  delete node.sku;
  assert.throws(() => assertVariantShape(node), /has no "sku" key/);
});

test('a missing structural field is refused', () => {
  assert.throws(() => assertVariantShape({ ...rawVariant(), selectedOptions: null }), /missing field/);
  assert.throws(() => assertVariantShape({ ...rawVariant(), selectedOptions: 'Black' }), /is not an array/);
  assert.throws(() => assertVariantShape(null, 4), /Variant #4 is not an object/);
});

test('an empty-string SKU normalises to null: it is an absent value, not a value', () => {
  assert.equal(normaliseVariant(rawVariant({ sku: '   ' })).sku, null);
  assert.equal(normaliseVariant(rawVariant({ sku: ' L2CN-RN-BLK-M ' })).sku, 'L2CN-RN-BLK-M');
});

test('isGiftCard comes from the product node when the variant read has one', async () => {
  resetIds();
  const giftProduct = { id: PRODUCT_IDS['sapphire-shadow-studio-gift-card'], handle: 'gift', title: 'Gift Card', isGiftCard: true, status: 'ACTIVE', variantsCount: { count: 1 } };
  const { variants } = await readCatalogue({
    fetchProductsPage: pagedFetcher([[giftProduct]]),
    fetchVariantsPage: pagedFetcher([[rawVariant({ product: { id: giftProduct.id, handle: 'gift', title: 'Gift Card', isGiftCard: true } })]]),
  });
  assert.equal(variants[0].isGiftCard, true);
});

test('readProductSkus accepts the nested per-product shape, which carries no product field', async () => {
  // The baseline re-read reads variants under a product, so its nodes have no `product` and no
  // options. Demanding the full catalogue shape here failed every row of a 431-row plan.
  resetIds();
  const map = await readProductSkus(
    pagedFetcher([
      [
        { id: 'v1', title: 'a', sku: 'L2CN-RN-BLK-M', selectedOptions: [] },
        { id: 'v2', title: 'b', sku: null, selectedOptions: [] },
      ],
    ])
  );
  assert.equal(map.get('v1'), 'L2CN-RN-BLK-M');
  assert.equal(map.get('v2'), null);
  assert.equal(map.has('v3'), false);
});

test('readProductSkus still refuses a node with no sku selection or no id', async () => {
  await assert.rejects(readProductSkus(pagedFetcher([[{ id: 'v1', title: 'a' }]])), /has no "sku" key/);
  await assert.rejects(readProductSkus(pagedFetcher([[{ sku: 'A' }]])), /has no id/);
});

test('liveFetchers binds the queries and refuses a product that vanished', async () => {
  const calls = [];
  const client = {
    gql: async (query, vars) => {
      calls.push(vars);
      if (query.includes('SkuProductVariants')) return { product: null };
      if (query.includes('SkuProducts')) return { products: { nodes: [], pageInfo: { hasNextPage: false } } };
      return { productVariants: { nodes: [], pageInfo: { hasNextPage: false } } };
    },
  };
  const f = liveFetchers(client);
  assert.deepEqual(await f.fetchProductsPage(null), { nodes: [], pageInfo: { hasNextPage: false } });
  await f.fetchVariantsPage('c1');
  assert.deepEqual(calls.at(-1), { cursor: 'c1' });
  await assert.rejects(f.fetchProductVariantsPage('gid://shopify/Product/9')(null), /was not found on re-read/);
});
