# TODO

Single backlog for the whole repo. Everything goes here; there are no per-directory TODO files.

**This file holds only work that still needs doing.** When an item lands, delete it from this file;
do not tick it and leave it behind. There is no done section and no checked-off history here. If the
work left behind reasoning worth keeping (a corrected mistake, a cross-layer contract, a decision and
why it went that way), write that into `release-notes.md` as part of the same change, then remove the
item here.

Sections: [Product and storefront](#product-and-storefront) (merchandising / UX ideas),
[Size-chart tooling](#size-chart-tooling) (`scripts/size-chart/`),
[Deferred review findings](#deferred-review-findings) (from pre-PR reviews).

## Product and storefront

- [ ] **Triage the 56 contrast findings the new lint baselined.** `scripts/contrast/` landed as a
  merge gate with every pre-existing failure recorded in `accepted-risks.json` rather than fixed, so
  the gate could be introduced without restyling the live storefront. Each entry is dated, carries a
  note, and is ratcheted (the pair may not get worse), but the debt is real and the file should
  shrink rather than persist. Three groups, in rough priority order.
  1. **`scheme-2` `primary_hover` is `#ffffff` on `#f5f5f5`, 1.09:1.** Links become invisible on
     hover. `scheme-2` is referenced by live templates, so this one actually ships. Fix in
     `config/settings_data.json`, then delete the two baseline entries (`current` and
     `presets.Default`); the lint reports a stale exception once it passes, so it will tell you.
  2. **`scheme-ec7ae723-...` and `scheme-8089d18b-...` carry the worst text ratios** (black body text
     on a deep blue, 3.02:1). Both are defined in `settings_data.json` but referenced by no template,
     section or block as of 2026-08-16, so nothing renders them today. Decide: recolour them, or
     delete them from the scheme list so the theme editor cannot offer a broken scheme.
  3. **35 control-border findings are stock Horizon hairlines** below the 3:1 SC 1.4.11 bar
     (input borders, variant swatch outlines, button hover borders). Genuine debt, pre-existing, and
     the largest visual change to fix. Worth doing as one deliberate pass rather than piecemeal.
  Note the two overlay schemes (`background: rgba(0,0,0,0)`) are NOT in the baseline: static colour
  maths cannot reach them, so they are reported as indeterminate and covered by the pa11y layer.

- [ ] **Triage the twelve axe rules the pa11y baseline silences audit-wide.** `scripts/a11y/baseline.json`
  landed on 2026-08-16 so the dynamic audit could gate merges without first restyling the storefront;
  every rule in it fired on the first full audit (PR #105). Each rule silenced is invisible to the
  gate until cleared, so the file should shrink to empty. The dominant patterns: `list` violations
  from `overflow-list` custom elements sitting directly inside `<ul>` (header nav, facet filters);
  `scrollable-region-focusable` on product-card slideshows without keyboard access;
  `aria-prohibited-attr` / `aria-required-parent` / `aria-valid-attr-value` ARIA misuse across
  templates; `color-contrast` (the rendered-page counterpart of the contrast-lint debt above);
  `frame-title` / `frame-tested` on third-party iframes (`#PBarNextFrame`), which may belong in
  paths.json's per-path `hideElements` instead of the baseline; and one `duplicate-id-aria`. The
  second round (the comment caps issues at 10 per URL, so these surfaced only after the first nine
  were silenced): `nested-interactive`, `video-caption`, and, most awkwardly, `target-size`, the
  44x44 rule CLAUDE.md makes a project rule and the audit was configured to add; baselining it was a
  ship-the-gate expedient and it should be the first entry cleared. Fix a rule's findings, delete
  its entry, and the audit enforces it from then on.

- [ ] **Variant SKUs: review the identifier and its lifecycle before adopting one.** Deferred on
  2026-07-29 rather than dropped. All 343 variants have a null SKU today. Three things to settle
  before any backfill. (Re-checked 2026-08-13: the count is now 431 across the six products, and every
  one is still null. The figures below are the 2026-07-29 ones; re-verify uniqueness against 431 before
  adopting the scheme.)
  1. **The SEO justification was overstated.** This was filed under SEO on the premise that Merchant
     Center and free listings need a per-variant identifier. Google's required field is `id`, which
     Shopify already populates from the variant ID; SKU maps to the optional `mpn`, and made-to-order
     goods with no GTIN set `identifier_exists: false` regardless. The real value is operational:
     readable packing slips, sortable exports, a value frozen onto the line item at purchase, and a
     key for barcode or inventory tooling later. Decide on those merits, not on search.
  2. **The lifecycle is the actual cost.** SKUs are never generated by Shopify and are blank by
     default. New products are not the burden; new *option values* on existing products are. Adding
     one colour to `lead-ii-crewneck` creates 36 new variants (6 designs x 6 sizes), each needing a
     SKU by hand. A half-populated SKU field is worse than an empty one, because a SKU filter then
     silently returns an incomplete set. If SKUs are adopted, adopt the tooling with them: a
     `scripts/sku-backfill/` module in the pattern of `scripts/size-chart/` and
     `scripts/blank-inventory/`, dry-run by default, filling only nulls, aborting on duplicates, with
     the product and colour code tables in git rather than in a one-off script.
  3. **Huddle applique is now settled; the scheme can account for it.** Applique variations on
     `huddle-crewneck` are modelled as a required line-item property (the numbered pattern
     dropdown) backed by the committed registry `scripts/applique-grid/patterns.json`, not as
     variants or option values. So a SKU never encodes the pattern: it stays derivable from each
     variant's own options, and the pattern travels on the order line as
     `<n>. <Name> (<thread>)`, with the registry's git history as the ledger of what each number
     meant when.
  A working scheme already exists if it helps: `SSS-<PRODUCT>-<DESIGN>-<COLOR>-<SIZE>`, for example
  `SSS-L2VW-RN-BLK-M`, 24 characters at its longest, verified unique across all 343 variants and
  derived purely from each variant's own options so it needs no lookup state. It is orthogonal to
  `custom.inventory_blank_sku`, which identifies the shared blank garment rather than the finished
  piece, so the two do not collide.

- [ ] **Attach one hero image per colour in Admin.** Separate from the shipped alt-text gallery
  filter, which never touches it: `variant.image` drives cart line-item thumbnails and collection
  cards, and Shopify caps a variant at one attached media, so attachment expresses exactly one hero
  per colour. Per-colour photography plus alt text is the input. See `docs/product-media-alt-text.md`
  for the per-product value table and the traps. Admin.

- [ ] **Market Shift Fuel's Grey Heather as a stealth colourway.** White thread on light heather is
  a deliberate tonal design, not a printing miss: at full-garment scale it reads as a plain
  sweatshirt and only the close-up (`crew-caffeine-trauma-gray-3.jpg`) reveals it. Do not "fix" the
  contrast; sell the subtlety. Two parts. (1) Merchandising: name the intent in copy so a shopper
  understands the low contrast is the point, wording to be drafted. (2) Media order: the colour
  filter now shows Grey Heather only its own three photos, two of which read as blank, so reorder
  that colour's media in Admin to lead with the close-up. Confirm on the storefront first. Admin
  (media order) plus copy.

**Homepage review (2026-07-20).** What is left of a live desktop (1440px) and mobile (390px) review
of the storefront homepage. It lives in admin-owned config, so it is recorded here rather than edited
in a repo PR, which the sync model would clobber.

- [ ] **Optional: set the hero video's alt text in admin.** Won't clear the Lighthouse `image-alt`
  finding (the `video_tag` poster `<img>` is Shopify-internal; see `THEME_CHECK_NON_ACTIONABLE.md`),
  but it does give the `<video>` element a proper `aria-label` for screen readers. Admin (video media alt).

**Pre-launch product and template review (2026-08-13).** Findings from a correctness / completeness
/ consistency pass over all six product templates and the other 15 templates, cross-checked against
read-only Admin reads (products, variants, media, collections, pages, files, delivery profiles,
menus) through the `scripts/blank-inventory/lib/admin.mjs` token client. Nothing was changed. Items
already tracked above are not repeated here: null variant SKUs and attaching one hero image per
colour. (The empty `/blogs/news` was also on that list; it is resolved, see `release-notes.md`.) What the pass verified as clean is recorded in
`release-notes.md`, not here, so it does not get re-audited. The 2026-08-14 backlog triage closed out
several of the pass's other findings.

- [ ] **[LAUNCH BLOCKER] All 431 variants weigh 0 lb while Expedited is weight-tiered.** The live rate
  table on the General profile prices Expedited at $20 (0 to 2.9 lb), $40 (3 to 5.9), $60 (6 to 8.9),
  and $80 (9+).
  Every variant on all six products reports `0 POUNDS`, so every order of any size buys the $20 tier
  and the tiering above it is unreachable. Economy is priced on cart total, not weight, so it is
  unaffected. This is the one finding that loses money per order rather than looking wrong. Fix is
  per-variant (or per-blank) weights in Admin; check the value against the blank's shipped weight, not
  the garment's fabric weight. Admin (variant weights). First recorded in the 2026-08-02 audit.
- [ ] **The About page references a file that does not exist.** `templates/page.about.json` sets
  `team_member_3_image` to `shopify://shop_images/Kitkat-Rory.jpg`, and no file by that name is in
  Files (all 77 enumerated). The block falls back to `placeholder_svg_tag`. Team members 1 and 2 have
  no image set at all, so the team row renders as three placeholder tiles. Either upload the cat photo
  under that exact name, repoint the setting, or drop the images from the block. Admin (file upload)
  plus possibly the template.
- [ ] **The gift card product has no description and one piece of media.** `descriptionHtml` is empty,
  and `product.gift-card.json` renders `{{ closest.product.description }}`, so that block is blank on
  the page. Its only media is the 500x500 `SSS-Square-White-BG-svg.svg` logo. It is the one product
  page with neither body copy nor a photograph; the accordion carries the whole page. Admin (product
  description plus a gift-card image).
- [ ] **Stored SEO titles are null on all four collections and all five pages.** Descriptions are set
  everywhere; only the titles are empty, so they render as the resource title with no keyword control.
  Products all have both. This is the `collection-seo-title-missing` / page-equivalent WARN the
  `seo-review` skill reports, recorded here so it is not rediscovered each run. Admin.
- [ ] **Three of the four collections have no collection image**, and the "Catalog" menu entry points
  at `/collections`, which renders all four as cards. Only The Vitals Collection has an image; the
  other three fall back to a product photo or a placeholder. That page also shows Featured and All
  Products alongside the two real collections, which is the collection-list equivalent of the
  duplicate-grid problem tracked in `docs/collection-differentiation-runbook.md`. Admin (collection images, or point Catalog at
  `/collections/all`).
- [ ] **The `all-products` smart collection's rules are junk that happens to work.** They are
  `VARIANT_PRICE > -1` OR `VARIANT_INVENTORY < 0`, matching on any condition: the first rule catches
  everything and the second matches nothing. Flipping the match to "all conditions" in Admin would
  empty the collection silently. Replace with a single honest rule, or make it manual. Note the footer
  "All Products" link points at `/collections/all` (Shopify's built-in), not at this collection, so
  the blast radius today is the collection-list page. Admin.

## Size-chart tooling

Follow-ups from the customer-needs vs. size-chart gap analysis (2026-07-14). Garment-independent
wording lives in `scripts/size-chart/copy.md`; per-garment data and per-measurement prose live in
`scripts/size-chart/profiles/<blank>.json`; the on-page accordion and the PNG both regenerate from
those. See `scripts/size-chart/README.md` for the tooling. Importance (imp) is 1 (nice-to-have) to
5 (decisive for choosing a size / avoiding a wrong-size order).

- [ ] **Fabric & care block (imp 4/3).** Add an optional `fabric` object to the profile schema
  (`pre_shrunk` bool + `care` string + weight / composition / stretch) and render a compact
  "Fabric & care" line beneath the table in both outputs. Pre-shrunk status is the one fabric fact
  with a direct sizing consequence on a non-returnable garment (buy-measured vs. size-up). The
  current blank is confirmed "premium 8 oz. heavyweight fleece" (live product descriptions); tie any
  shrink figure to the real fiber content, not a cotton default. Consider whether weight/composition
  belong on the product description instead.

- [ ] **Body-chest to size lookup (imp 4).** For shoppers without a reference garment: an optional
  per-size recommended body-chest range in the profile, rendered as a companion column or a small
  "which size fits your chest" lookup. Note the women's microfleece vest has **no** body-measurement
  column at all (no derived circumference, no fits-chest range), so it is the blank this would help
  most.

## Deferred review findings

Deferred findings from pre-PR reviews.

### Important

- [ ] **[SA-9]** Aggregate required-status check. Filed when `main` required four separate contexts. The single-`validate`-job consolidation since then already delivers the practical outcome: `main` requires exactly one context, `validate / validate`, whose final status gate rolls up all twelve steps. What is still open is whether that is the arrangement to keep, and any change lands in the private infrastructure repo (`ci_check_contexts`), not here. (security-auditor, 2026-05-03; re-scoped 2026-08-15)

### Architecture gaps (longer-horizon)

- [ ] **[AR-Gap-1]** No long-lived audit trail beyond GitHub's 90-day workflow log retention. Add a small step at the end of each successful auto-deploy that appends a one-line entry to a long-lived `auto-deploy-audit` GitHub issue. Write each entry in a structured, machine-readable line format (fixed fields, predictable separators) rather than prose, so a later tool can parse the history without scraping. (architecture-reviewer, 2026-05-03; absorbed [AR-Gap-3] 2026-08-14)
