# Phase 2: Admin completion

Requires `deploy-verified` (phase 1) before anything here. Routed sub-skills own their own gates;
while one is active this skill asks nothing, and its approvals satisfy nothing here.

## Steps

1. `template-suffix` (admin-manual): assign the theme template to the product in Admin. Only now:
   the suffix exists on the live theme only after phase 1's deploy. An API path exists
   (`productUpdate.templateSuffix`), but this skill's no-live-write rule makes it a UI step.
   - Completion check: a read-only query shows `templateSuffix` set to the intended value; record
     it. A preview render is an optional visual confirm on top, under the browser opt-in rules.
2. `skus` (route:/sku): audit, plan, operator-gated apply, verify, for the new variants.
   - Completion check: the sku skill's verify step reports the new variants covered.
3. `blank-inventory` (route:/blank-inventory, shared-blank bodies only): backfill
   `custom.inventory_blank_sku` on the new variants, quiesce, separately approved seed write;
   thresholds entry for a new blank. The Flow pause offer and the ~4-group batch limit are that
   skill's rules.
   - Completion check: that skill's verify converges.
4. `media` (route:/product-images): stage 0 (studio enhance) for raw shots, then the normal
   naming / alt / gated upload flow. Alt text colour-binding drives the gallery; the rulebook is
   `docs/product-media-alt-text.md`. Include the size-chart PNG upload with its descriptive alt.
   A non-garment product uses the `<handle>_<shot>-<index>` filename form; its alts are colour-free
   and there is no size-chart PNG.
   - Completion check: that skill's final handoff summary lists this product's uploads.
5. `metafields-seo` (admin-manual): set `custom.breadcrumb_collection` if the breadcrumb cascade
   needs steering (read `docs/breadcrumb-collection-metafield.md` first; the Storefronts-read
   access setting is the silent-fail step). Fill the Admin SEO title and description; SEOInput
   replaces the whole seo object, so never partial-update it.
   - Completion check: read-only query shows the metafield and both SEO fields.
6. `collections` (admin-manual): add the product to its collection(s). The main-menu collections
   dropdown is generated; do not give the catalog link children, and no menu edit is needed.
   - Completion check: the collection lists the product.
7. `activate` (admin-manual, LAST): set the product ACTIVE. Gated on `deploy-verified` and
   `template-suffix` both holding; an ACTIVE product with a missing template breaks the sitemap
   smoke for every later deploy.
   - Completion check: status ACTIVE via read-only query; the product URL renders.
