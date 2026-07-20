// Admin API mutations.
//
// `@idempotent(key: ...)` is REQUIRED on both inventory mutations at API 2026-07. Omitting it fails
// the call outright ("The @idempotent directive is required for this mutation but was not
// provided"). Confirmed by schema introspection and live mutations against the store.
//
// The key is derived from the plan artifact rather than randomised per attempt, which keeps a plan
// reproducible. It is NOT what makes a retry safe: an identical repeat with the same key roughly two
// minutes later was processed as a new call and caught by compare-and-swap, not deduplicated. CAS is
// the real guard. See lib/planner.mjs.
//
// `referenceDocumentUri` tags these adjustments as skill-authored in the inventory history, which
// is what separates them from the Flow's own `flow://blank-inventory-sync` writes.

export const REFERENCE_URI = 'skill://blank-inventory';
export const REASON = 'correction';

export const M_SET_QUANTITIES = `
mutation BlankInventorySet($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
  inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
    userErrors { field message code }
    inventoryAdjustmentGroup { reason referenceDocumentUri changes { name delta } }
  }
}`;

export const M_ADJUST_QUANTITIES = `
mutation BlankInventoryAdjust($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
  inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
    userErrors { field message code }
    inventoryAdjustmentGroup { reason referenceDocumentUri changes { name delta } }
  }
}`;

export const M_METAFIELDS_SET = `
mutation BlankInventoryTag($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id key value ownerType }
    userErrors { field message code }
  }
}`;

export const M_METAFIELDS_DELETE = `
mutation BlankInventoryUntag($metafields: [MetafieldIdentifierInput!]!) {
  metafieldsDelete(metafields: $metafields) {
    deletedMetafields { key ownerId }
    userErrors { field message }
  }
}`;

/** metafieldsSet accepts at most 25 per call. */
export const METAFIELD_BATCH_SIZE = 25;

/**
 * Split into batches the Admin API will accept.
 * @template T
 * @param {T[]} items
 * @param {number} [size]
 * @returns {T[][]}
 */
export function batch(items, size = METAFIELD_BATCH_SIZE) {
  if (size < 1) throw new Error('Batch size must be at least 1.');
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Normalise a mutation payload into a uniform outcome.
 *
 * A no-op set (writing the value a variant already holds) succeeds with a null
 * inventoryAdjustmentGroup. That is a clean machine-readable "nothing happened" signal, and it is
 * exactly the outcome the planner exists to avoid, so it is surfaced rather than treated as success.
 *
 * @param {object} payload
 * @returns {{ok: boolean, noop: boolean, code: string|null, message: string|null}}
 */
export function readOutcome(payload) {
  const errors = payload?.userErrors ?? [];
  if (errors.length) {
    return { ok: false, noop: false, code: errors[0].code ?? null, message: errors.map((e) => e.message).join('; ') };
  }
  const noop = payload?.inventoryAdjustmentGroup == null;
  return { ok: true, noop, code: null, message: null };
}

/**
 * Set an absolute quantity, guarded by compare-and-swap.
 * @param {object} client
 * @param {object} params
 * @returns {Promise<{ok: boolean, noop: boolean, code: string|null, message: string|null}>}
 */
export async function setQuantity(client, { inventoryItemId, locationId, quantity, changeFromQuantity, idempotencyKey }) {
  const data = await client.gql(M_SET_QUANTITIES, {
    idempotencyKey,
    input: {
      name: 'available',
      reason: REASON,
      referenceDocumentUri: REFERENCE_URI,
      quantities: [{ inventoryItemId, locationId, quantity, changeFromQuantity }],
    },
  });
  return readOutcome(data.inventorySetQuantities);
}

/**
 * Apply a delta atomically, guarded by compare-and-swap.
 * @param {object} client
 * @param {object} params
 * @returns {Promise<{ok: boolean, noop: boolean, code: string|null, message: string|null}>}
 */
export async function adjustQuantity(client, { inventoryItemId, locationId, delta, changeFromQuantity, idempotencyKey }) {
  const data = await client.gql(M_ADJUST_QUANTITIES, {
    idempotencyKey,
    input: {
      name: 'available',
      reason: REASON,
      referenceDocumentUri: REFERENCE_URI,
      changes: [{ inventoryItemId, locationId, delta, changeFromQuantity }],
    },
  });
  return readOutcome(data.inventoryAdjustQuantities);
}

/**
 * Tag variants with their blank id, in batches.
 * @param {object} client
 * @param {Array<{ownerId: string, value: string}>} entries
 * @param {object} [opts]
 * @returns {Promise<{written: number, errors: object[]}>}
 */
export async function setBlankMetafields(client, entries, opts = {}) {
  const { namespace = 'custom', key = 'inventory_blank_sku' } = opts;
  let written = 0;
  const errors = [];
  for (const chunk of batch(entries)) {
    const data = await client.gql(M_METAFIELDS_SET, {
      metafields: chunk.map((e) => ({
        ownerId: e.ownerId,
        namespace,
        key,
        type: 'single_line_text_field',
        value: e.value,
      })),
    });
    const payload = data.metafieldsSet;
    if (payload.userErrors?.length) errors.push(...payload.userErrors);
    written += payload.metafields?.length ?? 0;
  }
  return { written, errors };
}

/**
 * Remove the blank tag from variants, in batches.
 * @param {object} client
 * @param {string[]} ownerIds
 * @param {object} [opts]
 * @returns {Promise<{deleted: number, errors: object[]}>}
 */
export async function deleteBlankMetafields(client, ownerIds, opts = {}) {
  const { namespace = 'custom', key = 'inventory_blank_sku' } = opts;
  let deleted = 0;
  const errors = [];
  for (const chunk of batch(ownerIds)) {
    const data = await client.gql(M_METAFIELDS_DELETE, {
      metafields: chunk.map((ownerId) => ({ ownerId, namespace, key })),
    });
    const payload = data.metafieldsDelete;
    if (payload.userErrors?.length) errors.push(...payload.userErrors);
    deleted += payload.deletedMetafields?.length ?? 0;
  }
  return { deleted, errors };
}
