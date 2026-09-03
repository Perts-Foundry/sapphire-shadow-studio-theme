# Phase 2: Admin completion

Requires `deploy-verified` (phase 1) before anything here. Routed sub-skills own their own gates;
while one is active this skill asks nothing, and its approvals satisfy nothing here.

## Steps

1. `template-suffix` (admin-manual, policy): assign the theme template to the product in Admin. Only now:
   the suffix exists on the live theme only after phase 1's deploy. An API path exists
   (`productUpdate.templateSuffix`), but this skill's no-live-write rule makes it a UI step.
   - Completion check: a read-only query shows `templateSuffix` set to the intended value; record
     it. A preview render is an optional visual confirm on top, under the browser opt-in rules.
2. `skus` (route:/sku): audit, plan, operator-gated apply, verify, for the new variants.
   - Completion check: the sku skill's verify step reports the new variants covered.
3. `blank-inventory` (route:/blank-inventory, shared-blank bodies only): backfill
   `custom.inventory_blank_sku` on the new variants, quiesce, separately approved seed write;
   thresholds entry for a new blank. The Flow pause offer and the write pacing are that skill's
   rules; the tool paces itself now (one group per batch by default), so a seed covering many groups
   takes minutes rather than seconds and that is expected, not a hang.
   - Completion check: that skill's verify converges.
4. `media` (route:/product-images; a new SIZE or DESIGN value needs no new photos, because the
   gallery filters on the COLOUR option and the existing colour-matched shots already serve them,
   while a new COLOUR does need real photography because it has none of its own; every entry needs a
   hero on its new variants, but only some can get one from the tool, see below): stage 0 (studio
   enhance) for raw shots, then the normal naming / alt / gated upload flow. Alt text colour-binding drives the gallery; the rulebook is
   `docs/product-media-alt-text.md`. Include the size-chart PNG upload with its descriptive alt.
   A non-garment product uses the `<handle>_<shot>-<index>` filename form; it has no Color option,
   so its alts are plain description (nothing binds, nothing is rejected) and there is no size-chart
   PNG.
   - Completion check: that skill's final handoff summary lists this product's uploads.
   - **Every new variant needs a hero attached.** This is separate from the gallery, which filters
     on alt text and so serves a new size or design correctly off the existing colour-matched
     photos. A variant with NO attached media falls back to the PRODUCT-level
     featured image, which is one colour, so a new Grey Heather or Classic Navy variant shows a
     Black garment in cart line-item thumbnails and on collection cards. Silent, and invisible on
     the product page where you would look for it.
   - **Whether `--attach-heroes` can do it turns on one question: do the new variants land under a
     colour that ALREADY has attached variants?** `variantsByColor` in
     `scripts/upload-product-media.mjs` is keyed by the Color option value alone, and the run makes
     one `productVariantAppendMedia` call per colour carrying every variant of that colour.
     - **A new COLOUR, or a new product: the tool handles it.** That colour key holds only the new
       variants and none of them has media, so the append succeeds. Run `--attach-heroes` on the
       same batch that ships the new colour's photos, and get its dry-run preview, its dedup and its
       alt sync along with it.
     - **A new SIZE or DESIGN value: the tool cannot, so do it in Admin.** Those variants land under
       EXISTING colours, so the same call also carries the variants that already have media; they
       reject the second attachment, the local `gql` helper throws on the userErrors, and that whole
       colour is abandoned. Two further reasons it does not fit this case anyway: it builds its plan
       only from manifest rows the run is processing, so with no batch there is nothing to attach,
       and running it over an older batch is the documented `admin_color`/`alt` drift trap in
       `docs/product-media-alt-text.md`. Attach the colour's existing hero media to the new variants
       by hand, or with a one-off `productVariantAppendMedia` scoped to just the unattached ones.
   - Completion check for the attach: every variant of every colour reports at least one media, and
     the DISTINCT media ids across a colour's variants number exactly one. A single variant can
     never hold two (the platform caps it at one), so a second id means part of that colour took a
     different hero, which is the signature of a half-applied append.
5. `metafields-seo` (admin-manual, policy): set `custom.breadcrumb_collection` if the breadcrumb cascade
   needs steering (read `docs/breadcrumb-collection-metafield.md` first; the Storefronts-read
   access setting is the silent-fail step). Fill the Admin SEO title and description; SEOInput
   replaces the whole seo object, so never partial-update it.
   - Completion check: read-only query shows the metafield and both SEO fields.
6. `category-metafields` (admin-manual, api-blocked): assign the product Category, then fill the category
   metafields it exposes. **Admin UI only, and not by choice**: the values are metaobject
   references under Shopify's reserved `shopify--*` definitions, which Admin creates the first time
   a value is picked and which the API cannot create. On a category no product has used before
   there is nothing to reference yet, so `metafieldsSet` has no valid value to write. Skipping this
   is a real cost, not cosmetic: these feed Shopify search, storefront filters, and the
   cross-channel catalogues (Google, Facebook, TikTok, Pinterest).
   - Completion check: a read-only query returns `category { name }` plus
     `metafields(namespace: "shopify", first: 50)`, and the run records each definition the Admin
     Category card exposes as either filled or deliberately blank with a reason. Do not check a
     count against a sibling: the hard case is a category no product has used before, where by
     construction there is no same-category sibling, and a sibling in another category exposes a
     different definition set entirely. The Admin card is the only enumeration of what this category
     can answer, which is the same reason the step is Admin-only.
7. `collections` (admin-manual, policy): add the product to its collection(s). The main-menu collections
   dropdown is generated; do not give the catalog link children, and no menu edit is needed.
   - Completion check: the collection lists the product.
8. `activate` (admin-manual, policy): set the product ACTIVE. Gated on `deploy-verified` and
   `template-suffix` both holding; an ACTIVE product with a missing template breaks the sitemap
   smoke for every later deploy.
   - Completion check: status ACTIVE via read-only query. The product URL does not render yet and
     is not expected to; that belongs to step 9, which is what puts it on the storefront.
9. `publish` (admin-manual, api-blocked, LAST): publish the product to its sales channels. **ACTIVE is not
   published, and this is the step whose absence made a product look finished while being invisible
   to every customer.** Status and channel membership are independent: a product can be ACTIVE,
   fully populated, in collections, and reachable by no one, which is what "This product is not
   published anywhere" in the Admin Publishing card means. Nothing in the repo, the smoke test, or
   `seo-review` catches it, because an unpublished product is simply absent from the sitemap the
   crawl reads.
   Gated on `activate` holding.
   Admin UI only: `publishablePublish` needs the `write_publications` scope, which this app does not
   grant, so an API attempt fails with ACCESS_DENIED rather than doing anything. The matching read
   does work, so the completion check below runs normally.
   Admin path: Product page > Publishing card > Manage > tick each channel > Save.
   Read the channel list off a sibling rather than typing one from memory, so a channel added to the
   store later cannot be silently missed.
   - Completion check: `resourcePublicationsV2(first: 25) { nodes { isPublished publication { name } } }`
     returns a **non-empty** published set matching a named sibling's, by name. Three ways this
     check can pass while the product is still invisible, all of which make it FAIL instead:
     an empty set on either side is never a match (the broken product this step was added after
     compared equal to any other unpublished product); the sibling must itself be reachable, ACTIVE
     and published, and named in evidence by handle; and it must not be a product added in this same
     run. Do not accept `status == ACTIVE` as evidence; it is exactly the signal that misled that run.
     Do not substitute `onlineStoreUrl`: it is null on every product in this store, published or
     not, because the storefront is password-protected.
   - Evidence: the sibling handle, the channel names now published, and the count.
