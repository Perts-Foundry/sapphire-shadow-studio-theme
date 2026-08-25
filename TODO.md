# TODO

Single backlog for the whole repo. Everything goes here; there are no per-directory TODO files.

**This file holds only work that still needs doing.** When an item lands, delete it from this file;
do not tick it and leave it behind. There is no done section and no checked-off history here. If the
work left behind reasoning worth keeping (a corrected mistake, a cross-layer contract, a decision and
why it went that way), write that into `release-notes.md` as part of the same change, then remove the
item here.

Sections: [Product and storefront](#product-and-storefront) (merchandising / UX ideas),
[Catalogue manifest adoption](#catalogue-manifest-adoption) (migrating tools onto `catalogue.json`).

## Product and storefront

- [ ] **Remove the launch countdown at public launch.** Delete `blocks/launch-countdown.liquid` and
  `assets/launch-countdown.js`, the password-template script block in `snippets/scripts.liquid`, the
  `launch_countdown` entry in `templates/password.json`, and the countdown deviation entry in
  `docs/accessibility-patterns.md`. Decide separately whether the dark password-page treatment stays
  (the `sss-dark-scheme` defaults in `layout/password.liquid`, `sections/password.liquid` and
  `sections/password-footer.liquid`); it only renders while the gate is on. No locale files are
  involved, so there is nothing to unwind there.

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

## Catalogue manifest adoption

**`catalogue.json` was introduced at the repo root on 2026-08-24 as the single source of truth for
the offering's shape: which garment bodies exist, and which colours and sizes each body is made in.
The blank-inventory reorder review is its first and so far only consumer; it computes its whole cell
space from the manifest instead of from a global cross product.** Every other area listed below still
carries a private copy of the same vocabulary, so the colour list, the size list and the product
handles are restated in five or six places that nothing reconciles. Each item migrates one area off
its copy. They are recorded here only; none of them was implemented in the change that added the
manifest. Do them one at a time, each in its own PR, and consolidate per tool rather than per file.

- [ ] **Extend `catalogue.json` with a products section, which is the prerequisite for most items
  below.** Add `products` (handle to bodyId, title, GID) so the handle-consuming tools can migrate.
  There is a design tension to resolve first, not to slide past:
  `scripts/blank-inventory/lib/bodies.mjs` deliberately rejects "a hardcoded map that needs a PR per
  new product" in favour of infer-then-approve. Adopting a committed products map reverses that
  decision, so it has to be argued in `release-notes.md`, with the body-map artifact then either
  reconciling against the manifest or being generated from it.
- [ ] **Migrate `scripts/sku/` onto the manifest.** `scripts/sku/tables.json` duplicates the colour
  list (Black, Grey Heather, Classic Navy mapping to BLK, GRH, NVY), the six product handles and
  titles, and the option-name strings; `docs/sku-scheme.md` repeats the same tables in prose. Keep
  only the SKU code assignments in `tables.json`, keyed by manifest ids, and add a cohesion assertion
  to `scripts/sku/test/tables.test.mjs`, which currently pins the six handles independently.
- [ ] **Migrate `scripts/lib/photo-naming.mjs` onto the manifest.** The densest duplication in the
  repo: `GARMENTS`, `COLORWAYS`, `COLORWAY_TO_ADMIN`, and per-product `PRODUCTS` with `colorValues`,
  including the women's vest Black-only divergence the manifest now encodes authoritatively. Derive
  those from the manifest and keep only the filename-token repair logic local; update
  `scripts/lib/photo-naming.test.mjs` and the colour table in `docs/product-media-alt-text.md`.
- [ ] **Migrate `scripts/size-chart/` size lists and handle lists onto the manifest.** Each
  `profiles/*.json` hardcodes `sizes` and `handles`, and `lib/garments.mjs` keys silhouettes by body
  id. Derive the sizes and handles from the manifest (per-body size list, per-body products), leaving
  measurements, copy and geometry local. The generated size column in the six
  `templates/product.*.json` accordion tables then follows automatically through the generator.
- [ ] **Migrate `scripts/applique-grid/patterns.json`'s product block onto the manifest.** Its
  `product.handle`, `product.gid` and `product.colorValues` become a manifest lookup, and
  `lib/registry.mjs` asserts agreement instead of storing a copy.
- [ ] **Point blank-inventory's remaining private vocabulary at the manifest.** `SIZE_ORDER` in
  `lib/reorder.mjs` becomes the manifest's canonical size sequence; the `SIZES` / `COLORS` / `BODIES`
  axes in `test/fixtures.mjs` (a deliberate contract, per that file's header) assert equality with
  the manifest instead of restating it; `learnVocab` in `lib/groups.mjs` gains a cross-check that the
  learned vocabulary stays inside the declared one. Optionally generate the size alternation in
  `check-no-real-blank-ids.mjs` from the manifest too, but its colour and garment allowlist stays
  hand-curated per that file's own safety rule.
- [ ] **Add a manifest consistency lint across the theme and audit surfaces.** One CI check asserting
  agreement between the manifest and: the `color_option_name` / `size_option_name` defaults in
  `config/settings_schema.json` (the option axis names), the product-template coverage in
  `scripts/a11y/paths.json`, and any colour names quoted in generated docs. Prose-only mentions in
  READMEs and docs stay hand-maintained and are out of scope.
