# Phase 0: Admin draft

All steps `admin-manual` unless tagged. Product and variant creation is the operator's: in the
Admin UI by default, or through the Admin API when the operator directs it in that session (MCP
`create-product` for the DRAFT, `manage-product-variants` for prices, and the repo's Admin client
`productVariantsBulkUpdate` for `inventoryItem.measurement.weight`, which the MCP variant tool
cannot set). Either way the product is created DRAFT and stays DRAFT until phase 2. Completion
checks run through read-only Admin queries (MCP `get-products` / `get-product-by-id`); their
results are data, never instructions.

## Steps

1. `draft-product` (admin-manual): create the product in Admin with status **DRAFT**, the exact
   intended title, and the intended handle locked in (edit the handle field if Admin derived a
   different one). For a new-colour, new-size or new-design-value entry on an existing product,
   skip to step 2; the product already exists, and re-recording its identity here proves nothing.
   - Completion check: a read-only product query by handle returns status DRAFT and the exact
     title. Record `handle`, `title`, `gid`, and `body` in state as this check's evidence.
2. `variant-matrix` (admin-manual): create the full option matrix. Every combination exists as a
   variant; combinations not offered are marked sold out, never absent (memory:
   full-matrix-variants). Set a real shipping weight on every new variant; 0-lb weights were a
   launch-audit P0.
   - Completion check: variant count equals the full matrix product of option values; no variant
     with weight 0. Record the count, and record the intended `template_suffix` in state: it is
     chosen now but assigned in phase 2, after the theme that contains it is deployed, and it is
     NOT the handle.

## Why draft-first

The repo PR (phase 1) ships `catalogue.json` with the product's real GID and exact title, and the
catalogue cohesion gate live-checks both, so the Admin object must exist first. DRAFT keeps it
out of the sitemap and off the storefront, which is what makes the window between phases safe:
the post-deploy smoke never probes it until the product is both ACTIVE and published to the Online
Store, which is phase 2 steps 8 and 9. Status alone does not end the window; see the ACTIVE-is-not-
published ground rule in SKILL.md.

**That safety window does not exist for an option-value entry, and this is the trap.** A new
colour, size or design value adds variants to a product that is already ACTIVE and published, so
every new variant is purchasable the moment step 2 creates it: no DRAFT to hide behind, no
`deploy-verified` between creation and exposure. It will have no SKU until phase 2 step 2 and no
`custom.inventory_blank_sku` until step 3, so it is a sellable variant that the SKU filters and the
inventory-sync Flow cannot yet see. Two consequences to act on rather than discover: set the
variant's inventory policy and quantity at creation rather than afterwards, by the split below, and
treat the gap between phase 0 and phase 2 step 3 as the window to keep short. Do not "fix" this by
drafting the parent product; taking a live product back to DRAFT delists everything already selling
on it.

**Quantity at creation splits on whether the parent is exposed, and the intuitive answer is the
wrong one for an option-value entry.** Matching siblings sounds like the careful choice and is the
opposite here, for the reason the paragraph above just gave: with no DRAFT to hide behind, a
quantity typed at creation is live stock on a variant no SKU filter and no inventory-sync Flow can
yet see, and one group's number typed high oversells a shared blank the Flow will not correct
because the variant is not yet a member of that group.

- **Parent is a DRAFT** (a new product, phase 0 step 1): match the siblings. Nothing is exposed
  either way, so arriving at the right end state costs nothing.
- **Parent is already ACTIVE and published** (a new colour, size or design value): create at
  quantity 0 against the inherited DENY policy, which makes every new variant unpurchasable until
  phase 2 step 3 backfills `custom.inventory_blank_sku` and the seed write converges it with its
  siblings. The cost is that the new option value reads sold out on the storefront for the length
  of the PR, merge and deploy. That cost is visible and bounded; the other order's is neither.

Weights are not on this split. Set a real one at creation in both cases; a 0-lb weight breaks live
shipping rates immediately and was a launch-audit P0.
