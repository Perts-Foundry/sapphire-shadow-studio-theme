# Phase 2: Admin completion

Requires `deploy-verified` (phase 1) before anything here. Routed sub-skills own their own gates;
while one is active this skill asks nothing, and its approvals satisfy nothing here. An approval
given before phase 1's step-8 STOP is void in this phase, and so is one that survives only as a
summary: every gate below needs a fresh operator message, quoted verbatim in the response that
invokes the write.

## Entry-type step matrix

For every option-value entry (`new-colour`, `new-size`, `new-design-value`) six of the nine steps
below do not apply, because they belong to the PRODUCT and the product already has them. The same
six, for the same reason, whichever axis gained the value. `state.mjs init` pre-fills those six as
`na_presumed` with a fixed reason each, which is the point: nine not-applicable steps written to
state in one batch at the end of a run, with reasons typed from memory, is how a step that DID apply
gets waved through. Print this list once at the start of the phase, then let each owning step
promote its own row with `state.mjs confirm-na` after the one-line check.

The reasons themselves live in one place, `NA_PREFILL` in `scripts/add-product/lib/state.mjs`, read
by the tool and by its tests. The column below paraphrases them; that file is authoritative.

| Step | Why it is presumed N/A for an option-value entry | The check that promotes it to `na_confirmed` |
|---|---|---|
| 1 `template-suffix` | the suffix is a product field and the product already carries it | a read-only query returns the suffix, non-empty and unchanged |
| 5 `metafields-seo` | the SEO fields and the breadcrumb metafield describe the product, and an option value adds no URL | both SEO fields and the metafield read back unchanged |
| 6 `category-metafields` | category and its metafields are product-level; no new category is involved | `category { name }` reads back unchanged |
| 7 `collections` | collection membership is per product, not per variant | the product is still listed in its collections |
| 8 `activate` | the product is already ACTIVE, which is exactly why phase 0 needed its containment | status reads ACTIVE |
| 9 `publish` | channel membership is per product, and the parent is already published where its siblings are | `publication-check.mjs` returns a non-empty set matching a reachable sibling |

Steps 2, 3 and 4 apply to every entry type and are never pre-filled.

**Step 9 is on this list and it is the one to be uneasy about.** `publish` is the step whose absence
once shipped a product that was ACTIVE, media-complete, in two collections and visible to nobody, so
presuming it not-applicable is exactly the move that failure was made of. It is presumed here for a
narrow and checkable reason: an option value adds no product, so there is no new resource to publish
and the parent's channel set is the answer. That reason is a claim about the parent, and a claim can
be wrong (a product unpublished by hand between runs, a channel added store-wide since). So this row
in particular gets its `confirm-na` from a real read rather than a glance, and phase 3 step 1 runs
`publication-check.mjs` again from scratch regardless of what this file says. Two reads is the
deliberate cost of presuming this one at all.

## Steps

1. `template-suffix` (admin-manual, policy): assign the theme template to the product in Admin. Only now:
   the suffix exists on the live theme only after phase 1's deploy. An API path exists
   (`productUpdate.templateSuffix`), but this skill's no-live-write rule makes it a UI step.
   - Completion check: a read-only query shows `templateSuffix` set to the intended value; record
     it. A preview render is an optional visual confirm on top, under the browser opt-in rules.
2. `skus` (route:/sku): audit, plan, operator-gated apply, verify, for the new variants.
   - **Start from a fresh `audit`, not from anything phase 1 produced.** The tables changed in the
     PR that just merged, and a tables change voids every plan artifact and every approval that
     preceded it: the artifact embeds the tables hash and `apply` refuses on a mismatch
     (`docs/sku-scheme.md`, the runbook's last step). Re-running `audit` after the merge is the
     cheap path; carrying a pre-merge artifact forward is a refusal at the gate at best.
   - Each gate in that skill is its own approval, and this skill's routing is not one of them.
   - Completion check: the sku skill's verify step reports the new variants covered.
3. `blank-inventory` (route:/blank-inventory, shared-blank bodies only): backfill
   `custom.inventory_blank_sku` on the new variants, quiesce, separately approved seed write;
   thresholds entry for a new blank. The Flow pause offer and the write pacing are that skill's
   rules.
   - **Describe the seed gate by its customer-facing effect first, then clarify what it does not
     do.** The seed write is what makes the new option value **purchasable**: the variants have been
     sitting at quantity 0 and DENY since phase 0, and this is the step that ends that. Only then
     the clarification, which an operator will otherwise ask for and should not have to: it sets
     each NEW variant to the quantity its blank group already holds, there is no physical count
     involved, and no sibling's number changes. Leading with the mechanism and burying the effect is
     what produced the question "is this actually changing the stock?" mid-gate, which is the gate
     failing at its one job.
   - **Timing, so the estimate is not built from the wrong figure.** A seed onto siblings that
     already agree converges in about **20 seconds per group** (two 10-second polls), so 42 groups
     is roughly 14 minutes. The 80 to 90 second fan-out and the 40 to 60 minute figure describe a
     count-sheet **apply**, where the values actually change; quoting them for a seed turns a
     14-minute step into a 2-hour warning and invites the operator to skip or split it.
   - **Halt recovery.** The convergence poll is READ-ONLY, so a transient `fetch failed` inside it
     halts a run that has already written correctly. Run `audit`; if DRIFT is 0 and the halted
     group is converged, the work is done and `--resume` is finishing the walk, not redoing it. It
     is still a live-write command, so it needs its own fresh approval.
   - **There is no `--help` on that tool today.** `backfill --help` falls through to `propose` and
     leaves a stray artifact behind; read `scripts/blank-inventory/README.md` for the flags instead.
     A separate PR fixes the flag; until it lands, do not use `--help` to check a stage's spelling.
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
   - **For an option-value entry this step is VERIFY ONLY.** The heroes were attached in phase 0
     step 3, in the same visit that created the variants, so what is left here is one read:
     `scripts/add-product/media-survey.mjs --all --namespace <ns>` (or `--handle a,b,c`), which
     reports per product and per colour the
     variant count, the distinct media ids, the unattached count and the hero id, and exits non-zero
     if any colour carries more than one distinct id or any variant has none. Do not write ad-hoc
     survey scripts for this; two of them, one with a GraphQL syntax error, were the cost of not
     having this sentence. If the survey does find unattached variants, that is a phase 0 step 3
     re-run under its own gate, not a repair improvised here.
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
     - **A new SIZE or DESIGN value: this tool cannot, and phase 0 step 3 already did it.** Those
       variants land under EXISTING colours, so the same call also carries the variants that already
       have media; they reject the second attachment, the local `gql` helper throws on the
       userErrors, and that whole colour is abandoned. Two further reasons it does not fit the case
       anyway: it builds its plan only from manifest rows the run is processing, so with no batch
       there is nothing to attach, and running it over an older batch is the documented
       `admin_color`/`alt` drift trap in `docs/product-media-alt-text.md`. The attach for these
       entries belongs to phase 0 step 3, where `add-option-value.mjs --attach-heroes` appends the
       colour's existing hero to just the unattached variants under its own gate, or the operator
       does the same by hand in the Admin visit that created them.
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
   This step is its own approval like every other write here; routing, or a continue given in
   phase 1, does not cover it.
   - Completion check: `scripts/add-product/publication-check.mjs --all --namespace <ns> --sibling
     huddle-crewneck --sibling shift-fuel-crewneck` (`--handle a,b,c` for a single new product,
     which no namespace covers), which reads
     `resourcePublicationsV2(first: 25) { nodes { isPublished publication { name } } }` per product
     and compares the published set by name against each sibling. It must return a **non-empty**
     published set matching a sibling's. Three ways this
     check can pass while the product is still invisible, all of which make it FAIL instead:
     an empty set on either side is never a match (the broken product this step was added after
     compared equal to any other unpublished product); the sibling must itself be reachable, ACTIVE
     and published, and named in evidence by handle; and it must not be a product added in this same
     run. Do not accept `status == ACTIVE` as evidence; it is exactly the signal that misled that run.
     Do not substitute `onlineStoreUrl` either. The storefront password is off, so it is non-null on
     a published product now and its old always-null reading no longer applies, but it still cannot
     name WHICH channels the product reached, and an absent URL has a dozen causes besides
     "published to nothing". The publications read answers both questions; a URL is at most a
     corroborating glance.
   - Evidence: the sibling handle, the channel names now published, and the count.
