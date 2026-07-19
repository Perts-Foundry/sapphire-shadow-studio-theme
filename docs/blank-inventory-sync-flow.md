# Blank inventory sync flow

Read this before changing anything about how shared-blank stock is kept in sync, or before
authoring the `custom.inventory_blank_sku` variant metafield on a product.

Some products on this store are printed or embroidered onto the **same physical blank garment**.
A "blank" is one supplier SKU (a specific garment style in a specific colour). Several sellable
variants, across different products, can all draw down the same physical stock. Shopify has no
native way to share one inventory pool across variants that carry different variant SKUs, so a
Shopify **Flow** keeps them in lockstep: when the available quantity of one blank-linked variant
changes, the flow copies that quantity onto every sibling variant that shares the same blank.

This lives entirely in Shopify Flow (admin side). It is not theme code, it cannot be reached from
this repo, and it cannot be read or edited through the Shopify MCP or a `.flow` file on disk. Edit
it only in the Flow app. This document is the source of truth for its behaviour and its contract
with the `custom.inventory_blank_sku` metafield.

## Maintaining this flow

Change it by editing the workflow directly in the Flow editor, or by duplicating it and editing the
copy. Importing a hand-edited or externally generated `.flow` file is not a reliable path: during
setup an edited export silently dropped its added condition on import, so the change had to be
reapplied by hand in the editor. Treat the Flow editor as the only supported way to change this
workflow. There is no working file round-trip, and the leading integrity hash on an export is not
recomputable outside Shopify.

The v1 to v2 delta was exactly two edits, both described below: the third guard clause on the
sibling condition, and removing the invalid `changeFromQuantity` field from the write step.

## The `custom.inventory_blank_sku` metafield

- **Owner type**: `ProductVariant` (it is per variant, not per product).
- **Namespace / key**: `custom` / `inventory_blank_sku`.
- **Type**: single line text (a string).
- **Meaning**: the identifier of the physical blank this variant is made from. Two variants are
  "siblings" (share stock) exactly when this value is equal and non-empty.

It is per variant on purpose. Within one product, different colours are usually different physical
blanks, so a single product can span several blank SKUs; a product-level metafield could not
represent that. Leaving the metafield empty opts a variant out of the sync entirely.

Nothing in the theme reads this metafield. The storefront stock display
(`blocks/product-inventory.liquid`, `blocks/buy-buttons.liquid`) reads native
`variant.inventory_quantity` / `inventory_policy` / `inventory_management`, so once the flow has
mirrored a quantity onto the siblings, the storefront reflects it with no theme change required.

## What the flow does

Trigger: **Inventory quantity changed**. On every change, in order:

1. **Gate.** If the changed variant's `inventory_blank_sku` is empty, stop. This exits almost
   every inventory change (ordinary products) before any work happens.
2. **Get product data.** Fetch products to scan for siblings (see the cap limitation below).
3. **For each product, for each variant.**
4. **Sibling guard.** Act only when all three are true:
   - `variantsForeachitem.inventory_blank_sku.value == productVariant.inventory_blank_sku.value`
     (same blank),
   - `variantsForeachitem.id != productVariant.id` (not the variant that triggered),
   - `variantsForeachitem.inventoryQuantity != productVariant.inventoryQuantity`
     (actually out of sync).
5. **Send Admin API request.** Set the sibling's available quantity to the triggering variant's
   quantity with `inventorySetQuantities`.

### The write step (exact shape)

The live store's Admin API (`InventorySetQuantitiesInput`) takes only `name`, `reason`,
`referenceDocumentUri`, and `quantities`; each quantity is `{ inventoryItemId, locationId,
quantity }`. There is **no** compare-and-swap on this store's schema (no `compareQuantity`, no
`ignoreCompareQuantity`, and no `changeFromQuantity`), so the call simply sets the absolute value.

```json
{
  "input": {
    "name": "available",
    "reason": "correction",
    "referenceDocumentUri": "flow://blank-inventory-sync",
    "quantities": [
      {
        "inventoryItemId": "{{ variantsForeachitem.inventoryItem.id }}",
        "locationId": "{% for inventoryLevels_item in variantsForeachitem.inventoryItem.inventoryLevels %}{{ inventoryLevels_item.location.id }}{% endfor %}",
        "quantity": {{ productVariant.inventoryQuantity }}
      }
    ]
  }
}
```

`quantity` is an unquoted Liquid tag on purpose: the blob is a template that renders to JSON, not
JSON itself. `referenceDocumentUri` is optional; it just tags these adjustments as flow-authored in
the inventory history.

## Why the third guard clause matters

The `inventoryQuantity` inequality is not an optimisation, it is what keeps the flow from feeding
itself. The write in step 5 changes a sibling's inventory, which fires the same
**Inventory quantity changed** trigger again on that sibling. Without the inequality guard, every
run would rewrite every sibling, and each rewrite would re-trigger a fresh run: an amplifying loop
of redundant writes. With the guard, a re-triggered run finds all siblings already equal, writes
nothing, and the propagation settles in a single wave. It also means the common case (a change that
touches a blank shared by N variants) does at most N-1 writes.

## Assumptions and limitations

- **Single location only.** The `locationId` loop concatenates every inventory level's location id
  with no separator; with exactly one location that yields the one id and is correct. Add a second
  location and both this and the `inventoryQuantity` comparison (which is the aggregate available)
  break. Revisit this flow before enabling a second location.
- **Fetch cap.** Step 2 scans a capped number of products (`max_root_records`). Siblings on
  products beyond the cap are silently skipped. Keep the cap comfortably above the live product
  count. If the catalogue ever approaches Flow's fetch ceiling, move to the roll-up approach below.
- **A scan is unavoidable in pure Flow.** Flow's "Send Admin API request" action runs mutations
  only, not queries, and neither the `products` nor the `productVariants` search can filter by a
  *variant* metafield. So the flow cannot ask for "just the siblings"; it must scan products and
  match in a loop. The only way to shrink the scan is a **product-level** roll-up metafield
  (e.g. `custom.blank_skus`, a list) that mirrors the blank SKUs a product's variants use, so the
  fetch can filter with `metafields.custom.blank_skus:<sku>`. That adds a second automation to keep
  the roll-up current and an unverified assumption (list-metafield search matching), so it is
  deferred until scale demands it.

## Troubleshooting

- **Siblings are not updating at all.** Open the flow's run log and look at the "Send Admin API
  request" step output. A non-empty `userErrors`, or an invalid-field error, means the mutation
  shape drifted from the live schema. The original v1 of this flow failed exactly this way: it sent
  `changeFromQuantity`, which is not a field on this store's `InventoryQuantityInput`, so every
  write errored and nothing propagated. Confirm the blob matches the shape above.
- **Runaway or escalating runs.** Check that the third guard clause
  (`inventoryQuantity != inventoryQuantity`) is present on the sibling condition. Its absence is
  what turns one change into a wave of self-triggering writes.
- **Some siblings update, others do not.** Suspect the fetch cap: the missing siblings are likely
  on products past `max_root_records`. Raise the cap or adopt the roll-up approach.
- **A non-blank product triggered work.** It should exit at the gate. Verify the gate condition is
  the first step after the trigger and checks `inventory_blank_sku` is non-empty.
