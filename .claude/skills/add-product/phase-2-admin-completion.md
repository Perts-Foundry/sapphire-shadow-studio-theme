# Phase 2: Admin completion

Requires `deploy-verified` (phase 1) before anything here. Routed sub-skills own their own gates;
while one is active this skill asks nothing, and its approvals satisfy nothing here.

## Steps

1. `template-suffix` (admin-manual): assign the theme template to the product in Admin. Only now:
   the suffix exists on the live theme only after phase 1's deploy. There is no API path for this
   field; it is a UI step.
   - Completion check: the product page under the live theme's preview renders the new template
     (or Admin shows the suffix selected); record the suffix.
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
   - Completion check: that skill's step-7 handoff summary lists this product's uploads.
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
