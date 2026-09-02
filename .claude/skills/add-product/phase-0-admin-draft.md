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
   different one). For a new-colour or new-size entry on an existing product, skip to step 2.
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
the post-deploy smoke never probes it until phase 2 sets it ACTIVE.
