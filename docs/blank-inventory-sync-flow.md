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

The Flow's own "Send Admin API request" action takes only `name`, `reason`, `referenceDocumentUri`,
and `quantities`; each quantity is `{ inventoryItemId, locationId, quantity }`, so the call it makes
simply sets the absolute value with no compare-and-swap.

**Scope that claim to the Flow action; it is not a property of the store.** An earlier version of
this document said this store's schema had no compare-and-swap at all. That is wrong, and it was
proven wrong against the live store: on the direct Admin API at `2026-07`,
`InventoryQuantityInput` **does** expose `changeFromQuantity`, and sending a stale value returns
`CHANGE_FROM_QUANTITY_STALE` with the quantity unchanged. `inventoryAdjustQuantities` /
`InventoryChangeInput` likewise expose an atomic `delta` plus `changeFromQuantity`. The
`blank-inventory` tooling relies on both. Do not re-derive the old claim from the Flow blob below.

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

## Measured behaviour

Established by testing against the live store on 2026-07-19 and 2026-07-20, on one blank group,
restored byte-for-byte afterwards. These numbers and rules are what `scripts/blank-inventory/` is
built on. Settle time was measured twice end to end through the tooling: 89s and 101s.

- **Settle time is 80 to 90 seconds** from the triggering write to every sibling agreeing.
- **Propagation is NOT atomic.** A mid-cascade read legitimately shows some siblings updated and some
  not (observed `12,12,11,11,11,11,11,11` at t+78s of a 90s settle). Anything checking convergence
  must poll to a verdict, never sample once, or it will report drift on a healthy group.
- **A no-op write fires nothing.** Writing a variant's current value succeeds but returns
  `inventoryAdjustmentGroup: null`, produces no inventory-changed event, and therefore never runs the
  Flow. Consequence: a change must be written to a variant whose quantity actually **differs** from
  the target, or the stale siblings are never reached. That `null` is also a useful machine-readable
  "nothing happened" signal.
- **Tagging a variant is inert.** `metafieldsSet` fires no inventory event, so on a quiet group a
  newly tagged variant stays at its current quantity indefinitely (observed: 150s at 0 while its
  siblings held 12). Adding the metafield is therefore never enough on its own; something must write
  an inventory change afterwards to seed it.
- **But a cascade in flight sweeps in new tags.** Each sibling write re-fires the trigger, and every
  re-triggered run re-scans the whole catalogue, so a variant tagged while a cascade is still
  settling gets picked up without a seed write (observed: converged in 30s). This is a race, not a
  mechanism: do not rely on it, and quiesce before tagging so the outcome is deterministic.
- **`@idempotent(key: "<uuid>")` is required** on `inventorySetQuantities` and
  `inventoryAdjustQuantities` at API `2026-07`. Omitting it fails the call outright. Deriving the key
  from the work being done (rather than randomising per attempt) keeps a plan reproducible, but do
  **not** rely on it to make a retry safe: an identical repeat with the same key roughly two minutes
  later was processed as a NEW call and stopped by compare-and-swap, not deduplicated. Whatever
  dedup window applies did not cover that gap. Compare-and-swap is the actual protection against a
  double-apply.
- An adjustment applies its delta to **both** `available` and `on_hand`, and `quantityAfterChange`
  comes back `null`, so the resulting quantity must be re-read rather than taken from the response.

### Untagging order is destructive if reversed

To remove a variant from a group, **delete the metafield first**, confirm the deletion with a
re-read, and only then change its quantity. Zeroing a variant that is still tagged fires the trigger
and propagates 0 across the entire blank group, wiping real stock on every sibling. The
`untag` command in `scripts/blank-inventory/` enforces this interlock; doing it by hand in Admin does
not, so use the tool.

## Tooling

`scripts/blank-inventory/` implements all of the above (see its README), and the `blank-inventory`
Claude skill drives it with the operator approval gates. Use it in preference to hand-editing
quantities or metafields in Admin, which has none of these guards.

The same tooling also carries a read-only reorder review (`reorder` and `demand`), which compares
on-hand stock against committed per-cell minimums and proposes adjustments to them. It changes
nothing about this flow: see `scripts/blank-inventory/README.md`.

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
  `changeFromQuantity`, which **Flow's own action does not accept**, so every write errored and
  nothing propagated. Confirm the blob matches the shape above. Note the scoping: `changeFromQuantity`
  **is** a valid field on the direct Admin API (see the write-step section above); it is Flow's
  restricted action that rejects it. Do not generalise this v1 failure into a claim about the store's
  schema.
- **Runaway or escalating runs.** Check that the third guard clause
  (`inventoryQuantity != inventoryQuantity`) is present on the sibling condition. Its absence is
  what turns one change into a wave of self-triggering writes.
- **Some siblings update, others do not.** Suspect the fetch cap: the missing siblings are likely
  on products past `max_root_records`. Raise the cap or adopt the roll-up approach.
- **A non-blank product triggered work.** It should exit at the gate. Verify the gate condition is
  the first step after the trigger and checks `inventory_blank_sku` is non-empty.
- **`plan` refuses with "N group(s) are not converged".** This is the designed gate, not a tool
  fault. Read the per-group histogram it prints, because the deduped quantity list cannot tell the
  two cases apart and they need opposite responses. A histogram of `{"0": 1, "12": 7}` is a cascade
  that has nearly finished: wait and re-check with `audit --group <blankId>`. A histogram of
  `{"0": 7, "12": 1}` is a cascade that never ran, so the seed write did not fire or the Flow
  errored; check the run log per the first entry above. In both cases the group's state may read
  `awaiting-seed` rather than `drift`. That state explains why the group is non-uniform; it never
  means the group can be planned on top of.
- **`audit` reports archiving expired seeding receipts.** A `--stage tag` receipt records that a
  seed is outstanding, which is what makes a non-uniform group report `awaiting-seed` instead of
  `drift`. Those receipts expire after 24 hours, far beyond the 80 to 90 second settle. `audit`
  moves the expired ones into `<workdir>/archive/` and summarises the move in one line; `plan` still
  names them. Either way it means a tag stage was abandoned without its seed, and any group it
  covered is now reported as drift. Complete or discard that backfill. The receipts themselves are
  only a record: archiving one changes no stock, and nothing reads it afterwards.
