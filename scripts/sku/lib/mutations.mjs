// The one write this tool performs.
//
// The SKU lives on the variant's inventory item, so the input is `inventoryItem: { sku }`. There is
// NO top-level `sku` field on ProductVariantsBulkInput: passing one is rejected by the schema
// outright, which is the good failure. Confirmed against the Admin schema at the API version pinned
// in scripts/blank-inventory/lib/admin.mjs; re-check with validate_graphql_codeblocks before
// changing the shape rather than trusting this comment.
//
// The response selects `productVariants { id sku }` and deliberately not `inventoryItem { sku }`:
// reading the nested inventory item adds a read_inventory scope requirement to a tool that
// otherwise needs only write_products, and the variant's own `sku` is the same value.
//
// Shopify also offers giftCardProductSet for gift-card products. It is deliberately not used: it
// performs a FULL REPLACEMENT of the variant list, which is a catastrophic blast radius for setting
// one field. See docs/sku-scheme.md.

export const M_VARIANTS_BULK_UPDATE = `
mutation SkuBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id sku }
    userErrors { field message code }
  }
}`;

/**
 * productVariantsBulkUpdate accepts at most 250 variants per call. 100 keeps a single failed batch
 * small enough to read in a receipt and stays well inside the query cost ceiling.
 */
export const VARIANT_BATCH_SIZE = 100;

/**
 * Split into batches the Admin API will accept.
 * @template T
 * @param {T[]} items
 * @param {number} [size]
 * @returns {T[][]}
 */
export function batch(items, size = VARIANT_BATCH_SIZE) {
  if (size < 1) throw new Error('Batch size must be at least 1.');
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Normalise a bulk-update payload into a per-variant outcome.
 *
 * A userError is not necessarily fatal to the whole batch: the mutation can reject one variant and
 * apply the rest. So the result is per row, keyed by variant id, and a row that appears in neither
 * the returned variants nor a field-addressed error is reported as unknown rather than as success.
 * Assuming success for a row the API did not mention is how a tool reports 431 applied and leaves
 * some of them null.
 *
 * @param {object} payload - the productVariantsBulkUpdate payload
 * @param {string[]} requestedIds - variant ids sent in this batch, in order
 * @returns {{byVariant: Map<string, {ok: boolean, sku: string|null, code: string|null, message: string|null}>, batchErrors: object[]}}
 */
export function readOutcome(payload, requestedIds) {
  const byVariant = new Map();
  const returned = new Map((payload?.productVariants ?? []).map((v) => [v.id, v]));
  const errors = payload?.userErrors ?? [];

  // Errors are addressed by an input path like ["variants", "3", "inventoryItem", "sku"]. Anything
  // without a resolvable index applies to the batch as a whole.
  const perIndex = new Map();
  const batchErrors = [];
  for (const e of errors) {
    const idx = indexFromField(e.field);
    if (idx === null || !requestedIds[idx]) batchErrors.push(e);
    else {
      if (!perIndex.has(idx)) perIndex.set(idx, []);
      perIndex.get(idx).push(e);
    }
  }

  requestedIds.forEach((id, i) => {
    const rowErrors = perIndex.get(i) ?? [];
    if (rowErrors.length) {
      byVariant.set(id, {
        ok: false,
        sku: null,
        code: rowErrors[0].code ?? null,
        message: rowErrors.map((e) => e.message).join('; '),
      });
      return;
    }
    const hit = returned.get(id);
    if (hit) {
      byVariant.set(id, { ok: true, sku: hit.sku ?? null, code: null, message: null });
      return;
    }
    byVariant.set(id, {
      ok: false,
      sku: null,
      code: 'NOT_RETURNED',
      message: batchErrors.length
        ? `not returned by the mutation; batch error: ${batchErrors.map((e) => e.message).join('; ')}`
        : 'not returned by the mutation and not named in any error; treat as unwritten',
    });
  });

  return { byVariant, batchErrors };
}

/**
 * The index in the variants input array that a userError field path points at.
 * @param {string[]|null|undefined} field
 * @returns {number|null}
 */
export function indexFromField(field) {
  if (!Array.isArray(field)) return null;
  for (const part of field) {
    const n = Number(part);
    if (Number.isInteger(n) && n >= 0 && String(n) === String(part)) return n;
  }
  return null;
}

/**
 * Write one batch of SKUs for a single product.
 * @param {object} client
 * @param {string} productId
 * @param {Array<{variantId: string, expectedSku: string}>} rows
 * @returns {Promise<{byVariant: Map<string, object>, batchErrors: object[]}>}
 */
export async function setSkus(client, productId, rows) {
  const data = await client.gql(M_VARIANTS_BULK_UPDATE, {
    productId,
    variants: rows.map((r) => ({ id: r.variantId, inventoryItem: { sku: r.expectedSku } })),
  });
  return readOutcome(data.productVariantsBulkUpdate, rows.map((r) => r.variantId));
}
