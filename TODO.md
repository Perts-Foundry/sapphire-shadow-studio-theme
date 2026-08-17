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

**Pre-launch product and template review (2026-08-13).** Findings from a correctness / completeness
/ consistency pass over all six product templates and the other 15 templates, cross-checked against
read-only Admin reads (products, variants, media, collections, pages, files, delivery profiles,
menus) through the `scripts/blank-inventory/lib/admin.mjs` token client. Nothing was changed. (The
null variant SKUs, the empty `/blogs/news` and the per-colour hero attach were all on that list; all
three are resolved, see `release-notes.md`.) What the pass verified as clean is recorded in
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
