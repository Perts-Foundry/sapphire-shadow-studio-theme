# Release Notes

## Launch countdown on the password page (unreleased)

The pre-launch gate showed "Opening soon" with no date, in the Horizon default white scheme, so it
read as a placeholder rather than as the store. It now carries a live countdown to a hardcoded
launch instant and renders in the brand's `sss-dark-scheme`. The whole surface is temporary: the
removal list is the standing `TODO.md` item, not this file.

**The launch instant is three literals that move together, and nothing checks that they agree.**
`blocks/launch-countdown.liquid` assigns `launch_at` (the machine-readable instant, also handed to
JS through `data-launch-at`) plus two hand-authored display strings: the visible date line and the
screen-reader sentence. The obvious alternative, deriving all three from
`launch_at` with the `date` filter, was rejected because that filter renders in the **shop's**
timezone, so the page would silently misstate the time if the shop timezone were ever not Eastern.
The cost of that choice is that changing the date in one place and not the others ticks the digits
toward the new date while the visible lockup and the accessible sentence keep asserting the old one.
Nothing errors and nothing in CI catches it, so the three assignments are kept adjacent in one
`{% liquid %}` block with a doc note saying they move as a unit.

**The date line is set in the heading face, not the brand cursive.** It was cursive, and the
cursive looked like two fonts in one line: Dancing Script draws its lowercase as connected script
and its capitals and digits as upright formal letters, and a date is mostly digits and capitals.
Verified rather than assumed, since "two fonts" normally means a missing glyph falling back:
`document.fonts.check` returns true for lowercase, uppercase, digits and the middot, and the string
renders whole with no fallback in the stack. So it was always one font, and the fix was typographic,
not a font swap. That also made the block the only thing on the password page using Dancing Script,
so its duplicated `@font-face` and 42 KB preload came out; `sections/hero.liquid` still carries the
original for the homepage lockup.

**The countdown's eyebrow is the page's `<h1>`.** The template used to carry an "Opening soon" text
block for that, which the gradient panel behind the countdown ended up washing out, and which said
less than the countdown directly beneath it. Removing it took the page's only heading with it, so
the heading role moved onto the eyebrow. Nothing in CI checks heading structure, so adding a heading
back to the template means demoting that one by hand.

**Zero-padding is asymmetric on purpose, on both sides of the wire.** The house idiom
`value | prepend: '0' | slice: -2, 2` is correct for 1 and 2 digit inputs but truncates 3 digit
ones: `100` becomes `"0100"`, and the slice returns `"00"`, dropping the hundreds digit. Days can
exceed 99, so days renders unpadded and only hours, minutes and seconds are padded. This is a
cross-layer contract: `assets/launch-countdown.js` has to mirror it exactly, because the Liquid
output is what paints first and the JS output is what replaces it a moment later. A mismatch is not
a crash, it is a visible jump between first paint and the first tick.

**The digits are `aria-hidden` with a static visually-hidden equivalent, not an `aria-live`
region.** That is a deliberate exception to the repo's global "auto-updating regions get
`aria-live`" rule, since a per-second live region floods a screen reader for no benefit. It is not
what discharges WCAG 2.2.2 for the page's three decorative loops; that is a separate accepted
deviation, recorded in `docs/accessibility-patterns.md` next to the announcement bar's existing
one.

**The brand gradient is contained to a panel behind the countdown, not run across the page.**
It started section-wide, which is how the announcement bar does it. Previewing that showed the
cost: the logo is a mid-blue wordmark on transparency, and a shifting multi-hue field behind it
left it reading as blue on blue. The gradient now lives on the countdown block's `::before`, masked
to a radial fade so it ends without an edge, and everything outside it is the flat `#071e3f` scheme
ground, where the logo reads in its own colour at its own size. `settings.logo_inverse` is the
theme's intended answer to a logo on a dark ground, but it currently points at the same asset as
`settings.logo`, so asking for it changes nothing.

**The dark treatment reaches outside the section, so it is hardcoded in the layout.** A scheme class
on the section alone leaves the storefront-password dialog and the footer white, and the dialog is
full-viewport, so it would flash a white panel over a dark page. The class therefore sits on
`<body>` in `layout/password.liquid`, where there are no section settings to read a scheme id from.
Deleting `sss-dark-scheme` in Admin degrades the page to the default scheme rather than breaking it.
All three password files are upstream Horizon files and now carry rows in README's
"Deviations that must survive a merge" table.

## Shopify Email templates live in the repo, outside the theme (unreleased)

`marketing/emails/` holds custom-coded Liquid/HTML emails for Shopify Email campaigns and
automations: `campaign-shell.liquid` (clone it for a new campaign) and `welcome.liquid` (the
"you are on the list" automation), plus a README that is the operating manual.

**They sit outside the theme directories because Shopify Email has no API and no theme surface.**
There is no way to push a campaign template; the only path into a campaign is a human pasting the
whole document into the custom-code editor, which is desktop-only. Keeping the files in `templates/`
or `snippets/` would have put non-theme code inside the deployed surface, where `shopify theme push`
would ship it and a future reader would reasonably assume it renders somewhere. A top-level
`marketing/` directory reads as what it is, and nothing in it reaches the live theme. Note where
that protection actually comes from: there is no `.shopifyignore`, and `deploy.yml` pushes the whole
working tree, so what keeps `marketing/` out of the upload is the Shopify CLI's own allowlist of
recognised theme directories, not anything repo-side. A future CLI that widened that allowlist would
change the answer silently.

**`marketing/**` is in `.theme-check.yml`'s ignore list for the same reason, not as a convenience.**
Email Liquid resolves objects that a theme does not have (`unsubscribe_url`, `open_tracking`,
`email.*`) and lacks the ones a theme does (`section`, `block`, `settings`). Every email template
would therefore emit undefined-object findings forever. The ignore landed in the same change as the
templates so CI never went red on an intermediate push.

**The repo file is canonical, and drift is the failure mode to watch.** An edit made inside the
Shopify Email editor while testing is invisible to everything here: no CI check, no script, and no
Admin API can read it back. This is the same shape as the social-links and shipping-copy drift
already documented in `CLAUDE.md`, and the README states the rule (copy editor changes back in the
same sitting). Reversal is a `git revert` plus a re-paste; nothing here deploys.

**`welcome.liquid` is written for a store that has not opened, and that is a state with an expiry
date.** The storefront password is on, so every storefront URL resolves to Shopify's "Opening soon"
page. The first draft of this email led with a "Meet the studio" button pointing at `/pages/about`,
which is a password wall to every recipient: the one thing most likely to make a new subscriber
conclude the brand is broken. The prelaunch version links nobody to the storefront. The wordmark is
plain text, the footer names the domain without linking it, and the single button goes to Instagram,
which is public. The file header and the directory README both carry the four-part launch swap, because
the file becomes wrong the day the password comes off and nothing anywhere will say so.

The Instagram URL is hardcoded, and has to be: Shopify Email has no `settings` object, so
`settings.social_instagram_link` is unreachable from an email. That is a fourth copy of a social URL
in a repo whose `CLAUDE.md` already documents two of them drifting. It is recorded rather than solved;
there is no mechanism available that would solve it.

The copy also promises no launch date. A date cannot be corrected once the send is out, and a date
that slips reads worse than no date at all.

**`welcome.liquid` deliberately carries no shipping figures.** Shipping rates, the free-shipping
threshold, and turnaround already have four sources of truth. A sent email would be a fifth, and the
only one that cannot be corrected after the fact, so the templates link to the policy and FAQ pages
instead of restating numbers.

**Branding is duplicated per file on purpose.** No partials and no build step (the repo has no
bundler, and Shopify Email accepts exactly one pasted document anyway), so header, footer, and
palette are copied into each template and a palette change has to be made in all of them. The README
says so, and records that the palette is lifted from two different colour schemes in
`config/settings_data.json`: navy and accent blue from `sss-dark-scheme`, the light-blue surround
from `scheme-4`.

Two platform details worth keeping: `{{ unsubscribe_url }}` is required in every custom Liquid email
and `{{ open_tracking }}` is required whenever open tracking is on, both conventionally in the
footer, and both fail **silently** until a test send. Shopify's own example spells the second one
`open_tracking_block` in one place, so that is the first thing to try if a send records no opens.
The cap is 500 KB per custom-coded email (50 KB for a custom Liquid section inside a drag-and-drop
email). Validation is the operator's test send; nothing automated proves an email renders in an inbox.

## Dynamic collections dropdown on the main menu (unreleased)

The Shop link's dropdown is not authored in Admin. **A top-level menu link that has no children of
its own, points at the catalog or the collection list (`catalog_link` / `collections_link`, which is
what "All products" and "All collections" become in the menu editor), and sits on a store with at
least one published collection gets a submenu built from Liquid's global `collections` drop.** Add a
collection in Admin and it appears in the nav on the next page render; no menu edit, no repo script,
no sync run. This is the whole reason the feature exists: a static Shopify menu cannot track the
catalog, and the alternative was a scheduled job reconciling menu items against collections.

**The trigger is the thing to know before editing the menu.** It is implicit, so a future editor
adding a second "All products" link somewhere in the main menu will silently get a second dynamic
dropdown, and giving the Shop link a single hand-authored child in Admin silently turns the dynamic
list off (an authored submenu always wins). Neither is checked anywhere: nothing in CI parses the
menu, and the menu lives outside the repo entirely. The `collections.size > 0` half of the trigger
is not defensive noise; without it a store with no published collections renders a link that
advertises a dropdown (`aria-haspopup`, `aria-expanded`) over an empty panel.

**Three surfaces, one convention.** `blocks/_header-menu.liquid` computes the trigger and passes
`dynamic_collections` into `snippets/mega-menu-list.liquid` (desktop, including the "More" overflow
popover, which reuses the same markup); `snippets/header-drawer.liquid` recomputes it for the mobile
drawer. The drawer's accordion and flat branches both handle it, because `drawer_accordion` is
currently `false` and the flat branch is the live path; implementing only the accordion branch, as
originally planned, would have shipped nothing on mobile. The drawer's 3-level branch deliberately
does not support it: the menu is two levels, and the feature would disappear if a third level were
ever added there.

**The dynamic list is always plain text, even when the block's media type is `collection_images`.**
That mode reads images off static child links, and a dynamic parent has none, so both files downgrade
to text for this branch. The featured-content column is unaffected: it keys off the parent link's own
type, and a catalog parent still resolves `collections.all`, which is why the desktop dropdown keeps
its product cards alongside the generated list.

**Hovering or focusing a collection previews its products, from pre-rendered panels.** The
featured-products column used to be a fixed set (the first three of `collections.all`), which read as
decoration rather than a preview of whatever the cursor was on. Each collection now has its own panel
in the same column and `assets/mega-menu-preview.js` toggles which one is shown. Pre-rendering beats
fetching here only because the catalog is six products: a Section Rendering API call would add a
loading state, an abort path, and a visible delay on the first hover of every item, in exchange for
markup that is currently cheap. That trade flips as the catalog grows, and the panels are the first
thing to reconsider when it does.

**Four accessibility properties hold this feature up, and three of them are invisible until broken.**
Focus previews exactly as hover does, so the feature is not pointer-only. Inactive panels are
`hidden`, not merely transparent, because a transparent panel keeps its product links in the tab
order and a keyboard user would tab into cards nobody can see. Each panel carries its own accessible
name, so the swap is identifiable rather than an unannounced content change. The fade is dropped
under `prefers-reduced-motion`. None of these are covered by CI.

**The pointer bindings sit on the exact elements entered and left, and that is not a style choice.**
`assets/component.js` resolves `pointerenter` and `pointerleave` against the event target only, with
no ancestor walk (`focus` and `blur` are the ones allowed to bubble). Moving `on:pointerleave` up to a
wrapper for tidiness would silently stop the reset from ever firing.

**Order is the `collections` drop's order, and it is not operator-controllable.** No `sort` filter is applied, so the dropdown lists collections the way Liquid hands them over. There is no way to pin one first short of renaming it or giving the link an authored submenu again, which turns the whole feature off. That is also what the 50-item cap means in practice: at 51 collections it is the tail of that order that silently stops appearing.

**The list is capped at 50, which is Liquid's own per-loop ceiling, not a design choice.** The cap is
written out explicitly (`limit: 50`, and the desktop column math takes `collections.size | at_most:
50`) so the column count cannot describe more items than the loop emits. The span is clamped to 4 for
the same reason: `mega-menu__column--span-N` is only defined up to 4, and 41 collections were enough
to compute 5, at which point the column would fall back to a single grid cell while its inner
`column-count` kept laying out five. At three collections none of this is visible; at 51 the nav
would silently stop listing everything, which is the point at which a generated dropdown stops being
the right shape for the menu.

## Fits Chest column on the women's microfleece vest size chart (unreleased)

The vest was the one blank whose chart offered no way in for a shopper without a reference garment:
bust laid flat and body length only, no derived circumference and no fit range. It now carries a
`body_chest_range` column, "Fits Chest", in both outputs. No engine change was needed; the `range`
kind, the role's sane-range and monotonicity validation, and the accordion paragraph all already
existed and had no user.

**Where the numbers come from, since they are otherwise unexplainable later.** Bust laid flat
doubles to garment circumference (34.5 / 36.5 / 38.5 / 41.5 / 44.5 / 47.5 in). Each size's range is
that circumference minus layering ease, which is what a vest worn over a base layer needs: the low
end of every range sits a constant 4.5 inches under the circumference, and the high end sits 2.5
inches under at XS and S, 1.5 inches at M and up, which is what tiling the ranges contiguously
(30-32, 32-34, 34-37, 37-40, 40-43, 43-46) costs once the blank's own size steps stop being even.
Contiguity is the property worth preserving: no chest measurement can fall between two sizes. The
constant low-end ease is the fit promise; the high-end figure is a consequence of it. The operator
confirmed the table before
it was written; a fit range is a merchandising claim, not a transcription of a manufacturer spec, so
it does not get regenerated from the blank's numbers on a whim. Widening the ease shifts every row.

**Two conventions this column follows on purpose.** It carries no `badge` and no `how`: those bind a
column to an anchor point on the garment diagram, and this is a body measurement, so a badge would
also fail validation. Its body-measurement instruction (soft tape, fullest part of the chest,
parallel to the floor) lives in the column's own `explain`, per the rule in `copy.md` that shared
copy never tells a shopper to measure themselves; the other two blanks have no such column and must
not inherit the instruction. The vest profile's `how_to.note` gained an exception clause for the
same reason, while the shared accordion intro's laid-flat framing was left alone.

`test/table-block.test.mjs` pins the vest's paragraph-label list, so the assertion that the vest
grows no sleeve or circumference prose keeps its teeth; the added label is the only edit it needed.
The refreshed PNG is an operator upload in Admin, not a repo artifact.

## Collection-list cleanup: all-products deleted, bare collections imaged (2026-08-16, Admin-only)

Two pre-launch-review findings closed with no theme change; recorded here because both were
resolved by a judgment call worth not re-litigating.

**The `all-products` smart collection was deleted rather than repaired.** Its rules were
`VARIANT_PRICE > -1` OR `VARIANT_INVENTORY < 0` on match-any: the first condition matched every
product and the second matched nothing, so it worked by accident, and flipping the match toggle to
"all" in Admin would have silently emptied it. Deletion won over an honest rule because nothing
referenced it: every "shop all" surface in the theme (footer, hero buttons, 404, button defaults)
points at Shopify's built-in `/collections/all`, and `snippets/breadcrumbs.liquid` deliberately
excluded the handle from breadcrumb parents (the exclusion entry is a harmless string and stays).
If catalog-page control (image, description, SEO fields, sort, exclusions) is ever wanted, the
move is a new collection with the handle `all`, which overrides the built-in at the same URL; do
not recreate `all-products`.

**The collection-list finding was resolved with collection images, not a menu repoint.** Featured
and Healthcare got images in Admin (logo-tag closeup and Huddle nurse closeup; Vitals already had
`blue-zip-3.jpg`), so `/collections` now renders three imaged cards. The Catalog menu entry still
points at `/collections`, which is deliberate. Residual known issue: Featured and Healthcare hold
the same five products, so the list page still shows overlapping slices; that is the
`docs/collection-differentiation-runbook.md` problem, not this one.

## Variant SKUs adopted, with the tooling that maintains them (unreleased)

All 431 variants had a null SKU. The identifier was deferred on 2026-07-29 pending three questions,
and this change answers them and adopts one: `<PRODUCT>-<DESIGN>-<COLOR>-<SIZE>`, derived from each
variant's own public option values through committed code tables. The scheme, the code inventory and
the runbook for adding a code live in `docs/sku-scheme.md`; the tool is `scripts/sku/`; the operator
gates are the `sku` skill. No SKU has been written yet: this change ships the tooling, and the
backfill is an operator-gated run after merge.

### The decision, on operational merits rather than SEO ones

The original SEO framing was overstated and is recorded here so it is not re-litigated. Google
Merchant Center's required per-variant identifier is `id`, which Shopify fills from the variant id;
SKU maps only to the optional `mpn`, and made-to-order goods with no GTIN set
`identifier_exists: false` either way. What SKUs actually buy is operational: readable packing
slips, exports that sort into the order a batch is worked in, a value frozen onto the order line at
purchase, and a join key for later barcode tooling. There is no `SSS-` brand prefix; on a
single-brand store it carries no information and costs four characters of a 16-character budget.

The real cost was never new products, it was new option values. One new colour on a Lead II product
creates 48 variants. That is why the tables are data (`scripts/sku/tables.json`) rather than logic:
adding a colour is one row and the tool then fills all 48, and `audit` names the exact live option
string to use as the key.

### Cross-layer contracts worth knowing before touching this

- **The tables are the source of truth and are append-only.** A retired code is never reused,
  because every historical order line, export and packing slip already carries it. The git history
  of `tables.json`, not the current file, is the authority on what has been used.
- **A tables edit voids every approved plan.** Each plan artifact embeds the tables hash and `apply`
  refuses on a mismatch. Without that, an edit between approval and apply would produce a different
  but perfectly plausible set of writes under the same approval, because a SKU is a pure function of
  the tables.
- **The leading-zero rule is about the assembled SKU, not the segments.** A SKU must never start
  with `0` (spreadsheets and some barcode tooling strip it), but gift denominations are deliberately
  zero-padded (`GIFT-050`). Do not "fix" the padding.
- **A half-populated SKU field is worse than an empty one**, because a SKU filter then silently
  returns an incomplete set. That is why the planner refuses the whole plan on any unmapped value,
  duplicate expected SKU, or collision with a live SKU, rather than writing the rows it can.
- **A SKU is not `custom.inventory_blank_sku`.** One identifies the finished piece as sold and is
  public; the other identifies the shared blank garment and embeds supplier data that must never
  reach this public repo. `docs/sku-scheme.md` has the comparison table.
- **Applique patterns stay out of the SKU.** They are a line-item property backed by
  `scripts/applique-grid/patterns.json`, on a different change clock from the variants.

### Two things settled against the live API rather than from memory

**`ProductVariantsBulkInput` has no top-level `sku` field.** The SKU lives on the variant's inventory
item, so the input is `inventoryItem: { sku }`; a top-level `sku` is rejected by the schema outright.
Verified with `validate_graphql_codeblocks` against the pinned API version. The response selects
`productVariants { id sku }` and deliberately not `inventoryItem { sku }`, because reading the nested
inventory item adds a `read_inventory` scope requirement to a tool that otherwise needs only
`write_products`. `assertScopes` in `scripts/blank-inventory/lib/admin.mjs` grew an optional
`required` parameter for that reason: demanding `write_inventory` of a tool that never touches
inventory would train the operator to widen the app's grants for no reason.

**Gift cards go through the same write path.** Shopify's dedicated `giftCardProductSet` is
deliberately not used: it performs a full replacement of the variant list, a catastrophic blast
radius for setting one field. If the API turns out to refuse SKU writes on gift-card variants, the
answer is the `skuWritable: false` flag on that product entry, which moves its nulls into an
**exempt** class so the steady state stays "0 actionable nulls and exit 0" instead of permanent
failure.

### A defect the dry run caught before any write existed

The first end-to-end rehearsal failed all 431 rows with "missing field(s): product". `apply`'s
baseline guard re-reads each product's variants **nested under the product**, so those nodes carry no
`product` field and no options, but the read was asserting the full catalogue-wide variant shape.
The fix splits the assertion: `assertVariantShape` for the catalogue read, `assertSkuShape` (an id
and a selected `sku`) for the baseline re-read. Each read is now strict about what it consumes rather
than about what some other read consumes. The regression is covered in
`scripts/sku/test/catalogue.test.mjs`.

The narrower assertion still refuses a node with no `sku` **key**, which is not pedantry: an
unselected field and a null value are indistinguishable downstream, so a query that stopped selecting
`sku` would read as "no SKU everywhere" and plan a write over every real one.

### Recovery is manual from the receipt, by design

There is no `revert` command. Every receipt row records the prior SKU (the baseline is read anyway,
to guard against a row that moved between plan and apply), so recovery is applying those baselines
back through the same gated flow. An automatic rollback would be a second write path with a fraction
of the review, which is the wrong shape for the one field whose corruption is hardest to notice. A
plan artifact is also single-use: the receipt file's existence is the spend record, because
re-running a partially applied plan would skip the rows that landed while retrying the rest against a
store that has since moved.

### CI

`npm run sku:test` and `npm run sku:tables` are two separate `validate` steps so a failure attributes
cleanly: a broken table is an operator edit, a broken test is a code change. Both are offline. The
test step's zero-tests guard is anchored to the reporter's own summary line by field position rather
than a loose `grep` for "tests N", which a test *name* can match; the lint step fails when it reports
zero codes checked, so an emptied `tables.json` cannot pass vacuously. Nothing live runs in CI, and
the enforcement behind that is the credential boundary: the validate job holds no Shopify token.

## The last two deferred review findings closed without code (unreleased)

[SA-9] and [AR-Gap-1] were the final entries in `TODO.md`'s "Deferred review findings" section;
both are now closed as decisions rather than implementations, and the section is gone.

**[SA-9] closed: keep the single `validate` required context.** The item's original complaint
(four separate required contexts on `main`) was already solved by the single-`validate`-job
consolidation; what remained was only whether to keep that arrangement or split it back out. The
answer is keep it. Splitting into per-check jobs would buy parallel wall-clock time and per-check
status badges, at the cost of more `ci_check_contexts` entries to keep in sync in the private
infrastructure repo, the loss of the one consolidated CI report comment, and more surface for the
failure mode [DS-10] documented: rename a job here and `main` requires a context that no longer
reports. For a solo-dev repo with a fast validate job, one rolled-up context is the right shape.
The infrastructure repo's `github.tf` already carries an in-file comment explaining why
`["validate"]` is sufficient, so nothing changes there either.

**[AR-Gap-1] closed as won't-do: no issue-based deploy audit ledger.** The gap (workflow logs
expire after 90 days, so no durable auto-deploy history) is real but already half-covered:
`deploy.yml`'s "Record live-deploy marker" step keeps `refs/deploy-markers/live` on the last
actually-deployed commit, and `main`'s squash-merge history is itself a permanent, ordered record
of every deploy, since a deploy and a squash-merge are the same event in this pipeline. The
proposed extra step (append a structured one-line comment per deploy to a pinned
`auto-deploy-audit` issue) would add a second bookkeeping surface, a hardcoded issue number, and a
public-repo issue to keep locked, to answer questions the merge history already answers. If a
parseable ledger is ever actually needed, the design is on record: a `continue-on-error`
github-script step after the marker step, `issues: write` is already granted, fields from
`needs.gate.outputs`, fixed-separator line format.

## Admin backlog batch, and a silent truncation in the media uploader (unreleased)

Five Admin-side backlog items were cleared against the live store: the gift card's empty
`descriptionHtml`, null SEO titles on all four collections and all five pages, per-colour hero
attachment across all 426 colour-bearing variants, the Shift Fuel Grey Heather stealth-colourway
copy, and the hero video's alt text. The repo side of that is `TODO.md` plus two doc notes. Two
findings from the pass are worth more than the items themselves.

### `variants(first: 100)` was silently dropping 88 variants

`scripts/upload-product-media.mjs` read a product's variants with a hardcoded `first: 100` and no
`pageInfo { hasNextPage }` check. The two 8-design products carry 144 variants each (8 designs x 3
colours x 6 sizes), so `variantsByColor` was built from the first 100 and the remaining 44 on each
were dropped. Those variants then fell through `if (!hero.mediaId || !variantIds.length) continue;`
with no error and no warning, and the run printed success.

Had it run unfixed, 88 variants across two products would have kept showing the product-level
featured image, which is a **Black** garment on every one of these products, so a customer buying
Grey Heather or Classic Navy would have seen a black sweatshirt in their cart, and nothing in the
output would have said so. A truncated read that reports success is the fail-open shape
`scripts/seo-review/admin.mjs` refuses by design with its `admin-read-truncated` ERROR; this script
had simply never been given the same treatment.

The fix is `fetchAllConnection`, which follows the connection's pages and throws rather than
returning a partial read. It delegates the walk to `paginate()` from
`scripts/blank-inventory/lib/catalogue.mjs` rather than reimplementing it: that helper already
carries the malformed-page guard and the runaway-page backstop, and reusing it means one tested
pagination path instead of two. The first page comes from the caller, since `Q_PRODUCT` has already
fetched it, so the single-page case still costs zero extra round trips. It takes an injected `gqlFn`
so the pagination is unit-testable without a network, and `scripts/upload-product-media.test.mjs`
covers the exact regressing shape: a 144-variant product with a 100-wide first page.

`media` had the identical unguarded read at two call sites and now goes through the same helper. Its
consequence was worse than a miscount: `pollMediaReady` looks the newly-created media up by id in
the returned page, so a truncated read would leave that lookup undefined, and the poll would run to
its two-minute deadline and report a **processing timeout for media that had uploaded fine**. That
one is not reachable at the current catalogue size (the largest product carries 15 media against a
250 cap), but it is the same fail-open shape, and leaving it while fixing its twin would have made
this note untrue of the file it describes.

`resolveProduct` now also overwrites both first-page connections on the object it returns with the
complete node sets. Callers read `product.media.nodes` directly, and a partial first page left
reachable there reads as the whole set and silently is not.

What caught it is worth recording, because the obvious check would not have. The hero *lines* in the
dry-run output were all 13 present and correct; only reconciling their variant counts against a
live-derived colour matrix exposed the gap, and 36 + 30 + 34 = 100 is the signature. A verification
that counts one attachment per colour, or that compares only the variants which did get attached,
passes cleanly while 88 variants sit unattached. Derive the expected matrix from a live read, and
compare totals, not just presence.

### The variant hero outranks Admin media order

`snippets/product-media-gallery-content.liquid` pins the selected variant's attached media to gallery
position 1. So the hero is not only the cart line-item thumbnail and collection card: it also decides
which photo the product page opens on for that colour, and **no Admin media reorder can override it**.

This retires a standing assumption that a colour's gallery lead is fixed by reordering media in
Admin. It is not, once a hero is attached. Combined with Shopify's one-media-per-variant cap, that
means changing which photo leads a colour requires detaching the hero first, not reordering anything.
A planned one-off reorder script for Shift Fuel's Grey Heather was dropped on this basis: it would
have been a live write with no visible effect.

### Two halves deliberately did not land, and are not in `TODO.md`

The backlog is kept to open actions, and the operator's call on this pass was to close both parent
items out rather than carry a remainder. Recorded here instead so the decisions are not lost:

**Shift Fuel's Grey Heather is still a blank-looking garment**, and a media reorder will not fix it.
White thread on light heather shows no design at the 96px a cart thumbnail renders, on the flat and
angled shots alike; only the close-up reveals it. The hero decision was flat-everywhere with no
per-product exception, so that colour's cart thumbnail and gallery lead are both the blank flat.
Anyone revisiting this should reach for the camera, not the media order: the position-1 pin above
means the hero has to be detached and re-pointed, and the durable fix is a full-garment shot that
survives downscaling (raking light, or a tighter crop that keeps the lettering large). The other
three Grey Heather products are unaffected, so this is one photograph on one product.

**The gift card still has no photograph.** The description shipped and the page is no longer blank,
but its only media remains the 500x500 logo SVG, making it the one product page with no photograph.
The photograph was out of scope for this pass by design; the description was the whole of it.

## Accessibility baseline burn-down (unreleased)

PR #104 shipped the two accessibility gates with their pre-existing failures
recorded rather than fixed, so the gates could be introduced without restyling a
live storefront: twelve axe rules silenced audit-wide in
`scripts/a11y/baseline.json` (hiding 357 findings on PR #105's first full run)
and 44 measured colour pairs waived in `scripts/contrast/accepted-risks.json`.
This change takes the pa11y baseline to empty and the contrast waivers to 32.

### The last rule out was hiding almost nothing measurable

`color-contrast` was the entry expected to stay, on the theory that what sat
behind it was `scheme-6`, the transparent hero overlay, whose text is composited
over whatever photograph the section shows. Recovering the hidden findings from
a local run against the preview theme showed the real composition: nearly every
one was an axe INCOMPLETE result, not a measured failure. axe returns two sets,
`violations` (a measured ratio below the bar) and `incomplete` (it could not
resolve the background: an image, a gradient, an overlapping element, Shopify's
chat widget), and pa11y's axe runner promotes incomplete to a gating error by
impact unless capped. The unmeasurable set was drowning the gate, and the only
measured violation on any audited page was inside Judge.me's widget, which
`paths.json` already hides.

So `build-pa11yci.mjs` now sets `levelCapWhenNeedsReview: 'warning'` (committed
side, so a `paths.json` edit cannot raise it back) with `includeWarnings: true`,
and the baseline is empty. Measured colour-contrast violations gate again for
the first time since the audit landed; the can't-measure set flows through as
warnings, which the summariser counts per rule and per page in the CI Report
comment ("Needs review") so the trend is trackable run over run without failing
anything. A verification run over all 19 paths with this config reported 0
errors.

What the overlay text sits on is still a design property of the hero imagery:
no audit setting can measure text composited over a photograph, capped or not.
The needs-review counts in each run's report are where that surface stays
visible; if a scrim, gradient, or image-selection rule ever lands, those counts
are the before/after instrument.

Three of the other eleven were never theme debt. `frame-title` and
`frame-tested` (38 findings) are Shopify's `#PBarNextFrame` preview-bar iframe,
injected by the platform into every preview-theme page and absent from the live
storefront. `video-caption` is the homepage hero montage: autoplay, loop, muted,
no controls, no speech, nothing to caption. Both are handled where the audit
config can see them rather than by silencing a rule store-wide, which is the
point of the mechanisms below.

The remaining eight were each ONE defect, multiplied by a snippet the header or
the product grid renders many times per page. That is why the counts looked
large: 47 `duplicate-id-aria` findings were three ids, 19 `aria-required-parent`
findings were a single `role="menuitem"` (one per page, nineteen pages).

### paths.json grows a top-level `defaults`

`build-pa11yci.mjs` spreads it UNDER the committed pa11y defaults, so a future
edit there can add an option but cannot downgrade the standard, drop the axe
runner, or unpin Chrome's sandbox flags. An audit-wide `ignore` is rejected
outright rather than merged: that is the one option that would re-hide findings
from the summariser, which is precisely why the baseline was moved out of this
file in the first place. A per-entry `hideElements` now CONCATENATES with the
audit-wide one, because pa11y overrides rather than merges and a page-scoped hide
would otherwise silently un-hide the preview bar on the one page that needed an
extra selector.

Three escape hatches now exist and they are ordered by blast radius: per-path
`ignore` (one page, one rule) < top-level `defaults` (every page, no rule
suppressed) < `baseline.json` (every page, whole rule). Reach left first.

### The localization form was a combobox with no listbox

The country rows are `role="option"` and the search input is a `role="combobox"`
that points `aria-activedescendant` at one of them by id. The element holding
those options was `role="list"`, which is not a valid parent for an option, so
every row was an orphan; the no-results message was a bare `<span>` sitting
directly inside that list, which is what the `list` rule was reporting. The lists
are listboxes now and the message is their sibling.

Two things there are easy to reintroduce. `aria-owns`/`aria-controls` named
`country-results`, an id no element on the page has ever had (the real one is
prefixed), and the row ids were the country NAME: spaces in an id, and the same
id in both the popular and the full list, for an attribute whose entire job is to
name exactly one row. Every id in the snippet is namespaced by
`localization_style` now, defaulted rather than required, because a call site
that omitted it was minting ids like `-CountryLabel`.

### role="menuitem" outside a menu

The theme's only `role="menuitem"` had no `menu` or `menubar` anywhere above it.
`menuitem` also means an application-style menu, which the header nav is not, so
the role was removed rather than a `menubar` invented to satisfy it. A nav
disclosure should be announced as the button it is.

### The product card's link wrapped its own arrows

`card-gallery` wrapped the whole slideshow in the product anchor, arrow buttons
included: a control inside a control. The arrows could not move out instead,
because `on:click="/previous"` binds to the closest component ancestor and they
have to stay inside `<slideshow-component>`. The anchor moved in to wrap the
SLIDES, which is the same clickable area minus the arrows.

The consequence to remember: that anchor is `display: contents`, so it adds no
box to layout, but it is still a DOM node, and `base.css` had a deliberately
structural selector (`slideshow-slides > slideshow-slide`) carrying a Safari
repaint fix. That selector grew a matching branch. A `display: contents` wrapper
is invisible to layout and to the reader, and fully visible to the child
combinator.

### Carousels are keyboard-reachable

`slideshow-slides` went from `tabindex="-1"` to `tabindex="0"`, but only when
there is more than one slide: a one-slide gallery is not scrollable, so a tab
stop there would do nothing. The browser provides arrow-key scrolling for a
focused scroll container on its own, so no JS was involved, and the existing
`focusin` handler already suspends autoplay, so arriving by keyboard does not
fight the rotation. This is a deliberate keyboard-UX change: one tab stop per
carousel, approved as the cost of the slides being reachable at all.

### Contrast: what moved and what deliberately did not

One change is visible by design: `scheme-2`'s `primary_hover` was `#ffffff` on a
`#f5f5f5` page, so links vanished on hover. It follows schemes 1 and 3 to
`#000000`. Everything else is imperceptible: an input text colour a hair darker,
the dark scheme's white hairlines from 19-31% alpha to 37%, `scheme-4`'s border
from 50% to 60%, four hardcoded CSS opacities replaced by the
`--opacity-subdued-text` token the theme already had.

Each new value clears its threshold with margin rather than landing on it. A
value that rounds to exactly 3.00 would be a ratchet set at the bar, and the next
rounding change to the lint would fail it.

The 32 survivors are two deliberate decisions, and their notes now say so instead
of pointing at a TODO entry:

- The light schemes' hairline borders ARE the light theme's look. Raising them to
  3:1 would darken a line the storefront uses as a whisper, on every card, input
  and swatch. The dark scheme and `scheme-4` were raised in the same pass because
  there the same change cannot be seen.
- A "border" that holds the same colour as its own fill is a borderless control,
  not a failing border. What tells it apart from the page is the fill, which is
  what the lint actually scores (it takes the better of the two edges). Fixing it
  would mean painting a border the design does not have.

## Orphaned colour schemes deleted (unreleased)

The three unreferenced colour schemes (`scheme-58084d4c-...` transparent dark-text,
`scheme-ec7ae723-...` deep blue, `scheme-8089d18b-...` light blue) were removed from
`config/settings_data.json` (`current`, plus the one preset copy). No template,
section, block, schema default, or settings key referenced them; they only added
inline CSS to every page and broken-contrast choices to the editor's scheme
pickers. The contrast triage decision for the two blue ones (TODO item, resolved
2026-08-16) was delete-not-recolour: nothing rendered them, so their 12
`accepted-risks.json` waivers were deleted in the same change (a waiver matching
no existing scheme hard-fails the contrast gate). The remaining schemes are all
load-bearing; the storefront is not dark-only (product, collection, cart, and
search bodies sit on `scheme-1`/`scheme-3`), so no further scheme deletion is
safe without a repoint-everything pass.

## Accessibility checks in CI, in two layers (unreleased)

### What changed

`validate.yml` gains a `Contrast + a11y tests` step plus a dynamic pa11y-ci audit
of the PR's preview theme. To make the audit possible inside the required check,
the preview-theme push moved from `preview.yml` into `validate.yml` as a
`deploy-preview` job that the `validate` job `needs`, so the theme the audit
reads is known to exist and to match the head SHA; `preview.yml` retains only the
PR-close cleanup. Everything reports into the one sticky CI Report comment.
Before this, the twelve validate steps contained no
accessibility check of any kind, so a failing colour scheme shipped silently: the
`sss-dark-scheme` accent sat at 3.86:1 until a hand-run Lighthouse audit caught it
on 2026-08-15. A hand-run audit is not a gate.

New: `scripts/contrast/` (static colour-scheme lint, plus `accepted-risks.json`),
`scripts/a11y/` (preview-theme auth, pa11y config builder, result summariser), and
a `pa11y-ci` devDependency. `TODO.md`'s "Add an accessibility check to CI" row is
replaced by a triage row for the debt the lint surfaced.

### Why two layers rather than one

They fail in different directions and neither subsumes the other.

**The static lint** reads `config/settings_data.json` directly. No network, no
browser, no storefront password, so it can sit inside the required
`validate / validate` context and block a merge. What it cannot see is a rendered
page: font sizes, focus order, what actually composites over a hero image.

**pa11y-ci** sees exactly that, but only against a deployed `pr-N-preview` theme,
which means an authenticated remote request and a secret. It started life as an
advisory job in `preview.yml`; the operator then chose to make it gate merges,
accepting the trade that every validate run now waits on a preview deploy and
depends on a live storefront round trip. Draft and Dependabot PRs get no preview
by design, so for them the audit records a benign skip rather than a failure,
while a FAILED preview deploy is a red check: "could not audit" must never read
as "no accessibility errors".

Like the contrast lint, the pa11y gate landed with its pre-existing debt
baselined rather than fixed: `scripts/a11y/baseline.json` silences the nine axe
rules the first full audit surfaced, audit-wide, so the gate catches regressions
from day one (TODO.md holds the triage row). Rule-level rather than per-finding
is deliberate: pa11y findings key on generated selectors that churn with section
ids, so a per-finding baseline would go stale on every editor edit. The trade,
recorded in the file's header, is that a new instance of a baselined rule stays
invisible until that rule is cleared.

The `perts-foundry-website` precedent supplied the pa11y defaults (`WCAG2AA`, axe
runner, `target-size`) and the reporting shape. Its plumbing did NOT port: that
repo Hugo-builds to `public/` and serves it on localhost, needing no secret and no
network. Liquid renders server-side, so this repo has no local build target.

### Design points that are load-bearing

**`STOREFRONT_PASSWORD` is scoped to one STEP, not to the `validate` job.** The
pa11y step launches `--no-sandbox` Chrome that executes third-party page
JavaScript (consent banner, chat widget, Shopify's own scripts). The storefront
password must not be in that process's environment. No Shopify token appears
anywhere in the `validate` job (the CLI theme token lives only in
`deploy-preview`), so the per-job secret isolation described in CLAUDE.md's
deploy-gate section survives. The password is the one secret the validate job now
holds at all, and it is read access to a password-gated storefront, not a write
capability.

**The preview-theme assertion is the point of `get-auth-cookie.mjs`.** Passing the
storefront password proves only that the storefront opened. It does not prove the
session is pinned to the PR's DRAFT theme. If `?preview_theme_id=` silently failed,
pa11y would audit the LIVE theme and report green on a PR that broke the page. So
the script fetches the preview URL and reads the theme id back out of the
`server-timing` header, asserting it matches the expected id specifically. The
same assertion catches a Cloudflare interstitial, which returns a page that is not
a rendered storefront at all.

**The preview-activation mechanism was verified against the live store before this
shipped (2026-08-16), read-only, using the existing unpublished sync theme.** A bare
`?preview_theme_id=` does activate an unpublished theme for an authenticated
session, so the share/`key=` URL fallback the plan held in reserve is not needed.
All 19 paths in `paths.json` returned their expected status and reported the
preview theme id rather than the live one.

**That verification caught a bug that would have failed the first CI run.** The
`*.myshopify.com` host 302s to the primary custom domain, and the original
off-host assertion rejected it, even though auth and theme activation had both
succeeded. `vars.SHOPIFY_FLAG_STORE` is the myshopify host, so the check failed
against the exact BASE_URL the workflow passes. The fix is not to loosen the
assertion but to move it: the THEME ID is the identity proof, and it is strictly
stronger than a host comparison, because `server-timing: theme;desc=<id>` naming
this store's specific unpublished theme is something only this store emits. The
resolved origin is now returned so pa11y requests the canonical host directly
instead of eating a redirect on all 19 URLs. It travels via a file rather than
`$GITHUB_OUTPUT`, because a step cannot read back its own outputs and the caller
needs it in the same step.

**curl cannot do any of this.** Cloudflare bot management blocklists its TLS
fingerprint on this store. Node's `fetch` (undici) gets through, which is why
`smoke.mjs` is built on it and why `get-auth-cookie.mjs` IMPORTS `BROWSER_HEADERS`,
`updateJar`, `cookieHeader` and `authenticateStorefront` from `smoke.mjs` rather
than copying them. The exact header set is what was found to work; two copies
would drift.

That claim was originally only half-true: the header and cookie helpers were
imported, but the password POST and its outcome classification had been
hand-rolled a second time in `get-auth-cookie.mjs`, which is exactly the drift
the exports exist to prevent. The loop now lives in `smoke.mjs` as the exported
`authenticateStorefront`, and both callers share it. The four outcome strings
(`success` / `rejected` / `throttled` / `error`) are load-bearing on the smoke
side, where `rejected` HARD-FAILs a deploy and everything else falls back to
reduced coverage, so the extraction preserves that classification exactly.
One visible consequence on the a11y side: a 5xx on the password POST now reports
`error` where the copy said `throttled`. Both fail there regardless, because an
unauthenticated pa11y run would audit the password page and green on it.

**`probe()` retries a throttle, for the same reason `smoke.mjs` does.** The store
sits behind bot management, so a 429 or a transient 5xx on either of the two
probes is a realistic way to lose an audit run to something it should have
survived. `probe()` now takes the same `backoff` / `sleepImpl` the password POST
already had. A connection failure is deliberately NOT retried: it fails closed,
matching `fetchObservation`. A 5xx that outlives the retries still reaches
`classifyPreview`, which reads it as a challenge.

**Every `node` call in the audit job has its exit status captured.** The job runs
`set +e` throughout, so each step decides its own verdict and writes one
`exit_code`; a status that is never read is a silent pass. Two were not read.
The URL count was interpolated straight from a command substitution, so a crash
in that `node -e` produced an empty count and still wrote `exit_code=0`; it now
fails closed on a non-zero status or a count that is not a positive integer,
which is also the earlier of the two zero-URL guards (`summarize-pa11y.mjs`
catches it downstream, but only after pa11y has run). The summary was parsed
twice, and the body parse fell back to an empty string independently of the exit
code, so a malformed summary could log a verdict while posting an empty comment
and still report success. It is parsed once now: the log line goes to stderr and
the body to stdout from the same parse, and a parse failure sets `exit_code=1`
and says so in the comment.

**Non-text contrast is checked against the PAGE, not against the control's own
fill.** The naive reading (border vs its own background) scores a solid black
button on white at 1:1 and fails it, which is nonsense, and would have demanded a
baseline entry for nearly every scheme. What SC 1.4.11 actually requires is that
the control be tellable apart from the page, so the check passes when EITHER the
border OR the component's fill reaches 3:1 against the scheme background. For the
page-level `border` role the component background IS the scheme background, so it
reduces to the plain border-vs-page check.

**`foreground_heading` is checked at 3:1, not 4.5:1, and this is a judgment call.**
The role is one colour shared by all six heading levels. h1-h3 are 32px and up,
clearing the large-text bar comfortably; h5 and h6 are 14px and 12px and do not, so
a strict reading would demand 4.5:1. It was left at 3:1 so the gate could land
without an immediate baseline. Tightening it is one line in `lib/pairs.mjs`.
Revisit if a small heading ever becomes the sole carrier of information.

**Overlay schemes are reported INDETERMINATE, not passed and not failed.** Two
schemes have `background: rgba(0,0,0,0)`: they paint nothing and composite over
whatever section media sits beneath. What a static reader would have to assume
about the surface underneath is invention, and reporting `#f2f2f2` text as "1:1
against white" would be a fabricated number that 44 fabricated baseline entries
then silenced. They are excluded from the tally, reported by name, and left to the
pa11y layer, which renders the real image behind the real text. This is the
clearest case for why one layer was not enough.

**The baseline ratchets and self-clears.** `accepted-risks.json` records the ratio
measured when each exception was accepted. Score below it later and the lint fails:
accepting "this border is at 2.1:1" must not also accept a later 1.2:1. Reach the
threshold and the entry is reported STALE so it gets deleted, because a file that
only grows eventually hides a regression behind an entry nobody remembers. A
malformed entry is a hard error, never a silent no-op, since a typo'd scheme name
would otherwise look like a granted exception while suppressing nothing.

**It landed with 56 recorded exceptions and zero colour changes.** That was a
deliberate instruction, not an oversight: the operator chose to ship the gate first
and triage the debt separately (`TODO.md`). The consequence worth knowing is that
the gate catches REGRESSIONS from day one but asserts nothing about the current
palette's absolute quality.

**The unblock path for a false positive is a baseline entry, never a threshold
change.** The lint sits inside the required check, so a false positive blocks every
merge. Widening a threshold in `lib/pairs.mjs` removes the check for every scheme
forever; an `accepted-risks.json` row is scoped, dated, noted and reversible.

**Every open `npm audit` high in the new dependency tree is unreachable.** All six
trace to `extract-zip` via `@puppeteer/browsers`, which lives in puppeteer's
browser-DOWNLOAD path. `npm ci --ignore-scripts` (setup-shopify-cli) blocks that
script, `PUPPETEER_SKIP_DOWNLOAD=1` reinforces it, and pa11y is pointed at the
runner's `/usr/bin/google-chrome`. The audit's suggested fix is a downgrade to
pa11y-ci 3.x, which is strictly worse. The `setup-shopify-cli` comment enumerating
`hasInstallScript` packages was updated, since puppeteer is now the second one.

**The audit and the preview push share one cancellation scope.** A new push must
cancel a running audit BEFORE redeploying the theme that audit is reading; letting
them race produces findings for a tree that no longer exists. With both inside
`validate.yml`, the workflow-level `validate-<pr>` concurrency group
(`cancel-in-progress: true`) provides this for free: a new push cancels the whole
prior run, preview push and audit alike, so the moved `deploy-preview` job carries
no job-level concurrency group of its own. The residual race (a redeploy landing
inside the cancellation window) is accepted and commented: the cost is a stale
report on a PR that is about to get a fresh run.

**Both new capture steps use a random `$GITHUB_OUTPUT` heredoc delimiter**, not the
fixed `GHEOF` the older steps use. Their captured text is PR-controlled (scheme
names, baseline notes, page-derived pa11y findings), so a fixed delimiter would let
a PR close the heredoc early and inject arbitrary step outputs.

### Follow-ups from the infra review of the two-job layout

**Auto-deploy gates on the `validate` JOB, not on the validate RUN.** Folding the
preview push into `validate.yml` gave the run two jobs with very different
meanings, and `deploy.yml`'s `workflow_run` arm was still reading
`workflow_run.conclusion`. Only `validate` is a verdict on the code;
`deploy-preview` talks to Shopify over the network and runs for shopify-sync
reconcile PRs as well. The gate now resolves the `validate` job via
`listJobsForWorkflowRun` (`filter: 'latest'`, so a superseded re-run attempt
cannot supply the verdict) and requires `completed/success` on it; the
workflow-level `if:` was widened to admit a `failure` run conclusion so the job
check can be reached at all.

**What this does not do, stated plainly.** It was filed as the fix for "a Shopify
hiccup in `deploy-preview` fails the run with every validation green and blocks
auto-deploy", and that premise is wrong on this branch: `validate.yml` turns any
non-success `deploy-preview` into a11y `exit_code=1`, which reds the `validate`
job as well. With two jobs in the run, "red run, green `validate` job" is
therefore unreachable, the `core.warning` branch is currently dead code, and a
preview flake still blocks auto-deploy. What landed is hardening: the gate now
trusts the same artifact branch protection trusts, and it stays correct if a third
job is added to `validate.yml` or the audit's coupling to `deploy-preview.result`
is relaxed. The actual flake fix is keying the audit off
`deploy-preview.outputs.theme_id` (written only after a successful push, so a
non-empty value means the theme is fully uploaded, while `result != 'success'` can
also mean the *comment* step failed afterwards). That is deliberately not shipped
here, because it changes what the required check asserts.

The rejected alternative was `continue-on-error: true` on `deploy-preview`. It is
a smaller diff, but it renders the job GREEN in the Actions tab when the theme
push actually failed, which is the same class of dishonest-green problem as the
three items below. A red job with a gate that knows which job matters is the
honest shape.

Properties kept deliberately: `cancelled` is still excluded at the workflow level,
because `validate.yml`'s `cancel-in-progress` group cancels the whole run on every
new push and those runs carry no verdict; a red `validate` job under a GREEN run
still `setFailed`s, because that combination should be impossible and must not
read as an ordinary red validate; and a MISSING `validate` job `setFailed`s only
under a green run, since a red run can legitimately have no jobs at all
(validate.yml failed to parse), and reddening `deploy` for that would put a red
run on a PR that was never a deploy candidate. None of the four documented deploy
gates were touched.

The comment path still requires the whole run green. That asymmetry is deliberate
and in the safe direction (stricter), and is now recorded in
`docs/deploy-gate-reference.md` rather than left to be rediscovered.

**The baseline moved out of pa11y and into the summariser, so the report can
disclose it.** `baseline.json` silences twelve axe rules audit-wide, but it was
handed to pa11y as `defaults.ignore`, which drops matching findings inside the
browser. The report therefore could not say what it had hidden, and the comment
claimed "N URL(s) audited against WCAG 2.1 AA (axe runner, plus `target-size`)"
while `target-size` itself was one of the twelve. pa11y now runs unbaselined;
`summarize-pa11y.mjs` applies the filter and publishes the rule list, a per-rule
count of what each entry hid on that run, and a per-URL suppressed column. A rule
at 0 is flagged as clearable, which is the signal for deleting it. The audited-
standard sentence is qualified for as long as `target-size` sits in the baseline.

A second benefit that was itself a prior bug: the per-URL display cap is no longer
spent on baselined noise, which is what hid three baselined rules for a whole PR
(commit `d060587`).

The cost, and it is real: pa11y-ci now exits non-zero on any run with a baselined
finding, so its exit code is no longer a usable crash signal. That signal is
replaced by a stronger, per-URL one. pa11y-ci stores a caught exception as that
URL's entire result array and an `Error` serialises to `{}`, so a page that never
loaded had no `type: 'error'` entry and was already being counted as a clean pass;
only the exit code had been catching it. The summariser now detects such an entry
structurally, names the URL, and fails the run. A result that is not an array at
all (or is absent) is treated the same way, rather than falling back to "no
issues" as it used to. The exit-code check is kept as a last resort for a run that
reported nothing at all; it cannot be unconditional, because a non-zero exit is now
the normal case whenever anything baselined fired.

Still missing, and deliberately deferred: nothing asserts the report covered every
URL the config declared. The floor is one URL, not all of them, so a run whose
browser pool died after three pages would report "3 URL(s) audited" and pass.
`validate.yml` already computes and validates that count as
`steps.a11y-config.outputs.url_count`; threading it into the summariser as an
expected-URL assertion is the remaining piece.

**A skipped-by-design audit no longer renders as "All checks passed".** Draft and
Dependabot PRs get no preview theme, so the a11y step writes `exit_code=0` on
purpose: the required context must not go red or skip, or those PRs are blocked
forever. But the aggregator counted that 0 as a pass, so the banner asserted a full
green over an audit that never ran. `Collect results` now classifies it as a skip
and separately records that the skip was EXPECTED, and the banner has a dedicated
clause saying the dynamic audit did not run and only the static contrast lint
covered accessibility. `Check for failures` is untouched, so mergeability for
drafts and Dependabot is unchanged.

**The CI Report comment is bounded as a whole, not just section by section.** Only
the a11y section had a cap (30k). GitHub rejects a body over 65536 characters with
a 422, and the upsert is `continue-on-error`, so an oversized report would have
silently posted nothing at all: the worst possible failure mode for the thing
reporting the failures. The detail blocks are now data rather than string literals,
and if the assembled body exceeds 60000 characters they are replaced one at a time
with a "see the run log" placeholder, PASSING sections first and largest first, so
a failing check's output survives longest. The banner and the four result tables
are never dropped. Every degraded form still emits a matched `<details>` pair and a
matched fence pair.

Fixed in passing, found by an offline harness over the assembler: the a11y cap's
blind-cut fallback appended a fixed ` ``` ` + `</details>` pair, which assumed the
cut had landed inside both. When it had not, the spurious `</details>` closed the
WRAPPER around the a11y section and spilled every later section out of it. The
closers are now computed from what the retained text actually leaves open, after
dropping the partial final line.

**zizmor gets a token.** Without one it silently drops its online audits
(`impostor-commit`, `ref-confusion`, `known-vulnerable-actions`) and still reports
a clean run, so a green "Security audit" row was asserting more than the tool had
checked. `GH_TOKEN: ${{ github.token }}` is enough: those audits only read public
action repositories.

## Collection differentiation is a runbook, not a code change (unreleased)

### What changed

No theme code. `docs/collection-differentiation-runbook.md` is new, and it replaces
the accepted-risk paragraph further down this file that recorded `featured` and
`healthcare` holding an identical five products as "reviewed and accepted rather
than merged; revisit after launch with real Search Console data." That accept is
superseded, and the `TODO.md` row is deleted.

**The runbook is the tracker, not a backlog row.** No `TODO.md` entry replaces the
deleted one. The open Admin work is stated in the runbook itself, and
`scripts/seo-review/admin.mjs` reports it on every run through
`admin-description-duplicate`, `collection-body-empty`, and
`collection-seo-title-missing`, which is a better progress signal than a checkbox
because it clears itself when the work is actually done.

### Design points that are load-bearing

**With six products the two collections cannot be differentiated by adding.** One
has to shrink, and the symmetric difference has to be non-empty in **both**
directions. A subset page is still a duplicate candidate against its superset, so
turning identical grids into nested ones fixes nothing. The proposed split makes
`healthcare` a real category with an editorial rule (credential-embroidered pieces
for healthcare workers: the two Lead II crewnecks, the quarter-zip, the women's
vest, and the Huddle crewneck) and `featured` a hand-picked merchandising shelf of
three that includes `gift-card`, which will never belong in `healthcare` and so
guarantees the difference in that direction permanently.

**Copy is half the job and is the most likely way this lands and still fails.**
`templates/collection.json` renders the H1 from `{{ closest.collection.title }}`
and the body from `{{ closest.collection.description }}`, so two pages with
different grids and templated everything-else still cluster. Each collection needs
distinct body copy and distinct stored SEO fields.

**The structural answer is fewer collections.** `all-products`, `featured`,
`healthcare`, and `the-vitals-collection` over six products is four names for one
catalogue. The split is a holding action until the catalogue grows, recorded as
such so it is not rediscovered as a fresh idea.

**The named fallback is noindexing `featured`**, using the blog-listing noindex in
`snippets/meta-tags.liquid` as the working precedent. It is recorded here rather
than as a backlog row, because it is a contingency and not an open action.

**Verification is Search Console after a re-crawl, weeks out.** Canonical
clustering is a Google-side judgement and everything checkable sooner is a proxy.

## Breadcrumb parent collection is a product metafield (unreleased)

### What changed

`snippets/breadcrumbs.liquid` gains a second step in its parent-collection
cascade, reading `product.metafields.custom.breadcrumb_collection.value`. The
snippet's doc header goes from "three steps" to four. `scripts/seo-review/admin.mjs`
reads the metafield through the Admin API and reports two new checks, backed by an
exported pure function and unit tests. `docs/breadcrumb-collection-metafield.md`
is new and `CLAUDE.md` points at it. The Admin work (definition plus values) is
stated in that doc rather than in `TODO.md`; the two new checks report it on every
admin-mode run and stop reporting when it is done, so no backlog row is carried.

### Design points that are load-bearing

**The definition, verbatim, because one field of it fails silently.** Owner
Product, namespace `custom`, key `breadcrumb_collection`, type **Collection
reference, single**, access **Storefronts: read**. Single and not a list, because a
trail has exactly one parent and a list reintroduces the "which one" ambiguity the
metafield exists to remove. Without storefront read access the value returns nil to
Liquid, indistinguishable from unset, while Admin keeps showing what you set.

**Step 2, not step 1.** A collection-scoped URL still wins outright. The snippet's
documented reason for that step is that the shopper actually walked through that
collection and the trail should reflect the path taken. The canonical-contradiction
argument that would otherwise favour overriding it does not apply here, because the
last `ListItem` deliberately omits `item`.

**`preferred_handles` stays permanently, demoted to step 3.** Removing it once
values are set would regress any newly created product to the last-resort "first
non-catch-all" scan, which is the "Home > All Products > Lead II Crewneck" defect
recorded further down this file. It is a safety net, not a migration artifact, so
there is no follow-up row to delete it. Its quiet failure mode (a renamed handle
skipped without error) is now covered by a check rather than by nothing.

**The catch-all guard applies to a hand-set value too.** Pointing the metafield at
`all-products` would reintroduce exactly the trail the exclusion list exists to
prevent, so a misconfigured value falls through to the preferred list rather than
to the worst available trail.

**One blank check covers four nil causes on purpose:** unset, definition absent,
definition not storefront-readable, and referenced collection deleted. All four
should behave identically, so the snippet does not try to tell them apart and
neither does the check.

**Both checks are WARN and keyed per product** (`admin:product/<handle>`) rather
than aggregated into a counter, so the baseline differ names which product
regressed. `product-breadcrumb-collection-catchall` is the higher-value of the two,
because a set-but-ignored value looks correct in Admin.
`BREADCRUMB_EXCLUDED_HANDLES` in `lib/checks.mjs` mirrors the snippet's exclusion
list and carries the same change-them-together comment `BREADCRUMB_PAGE_TYPES`
already has.

**Shipping the Liquid before the Admin work is safe.** The metafield read returns
nil until a value exists and the code falls through to the existing fallback, so
there is no window where the site is worse off.

## ItemList markup on collection pages (unreleased)

### What changed

New `snippets/structured-data-collection-list.liquid`, rendered from
`sections/main-collection.liquid`. New `jsonld-itemlist-missing` WARN in
`scripts/seo-review/lib/checks.mjs` with a test. The exception list in
`snippets/structured-data.liquid`'s doc block gains a third entry.

### Design points that are load-bearing

**A standalone `ItemList`, not a `CollectionPage` with `mainEntity`.** Google does
not consume `CollectionPage`, and it would want an `isPartOf` back to the `WebSite`
`@id`, which puts an entity relationship on a non-homepage page: the neighbourhood
of the `jsonld-entity-leak` rule the rest of this theme's structured data is built
around.

**`ListItem`s carry a `url` and nothing else.** Full `Product` nodes would duplicate
the offers and prices Shopify's `structured_data` filter already emits on each
product page, and would breach the standing rule that Product markup is never
hand-authored.

**Positions are absolute** (`forloop.index | plus: paginate.current_offset`). Page 2
restarting at position 1 would assert that a different product is the first item in
the same list.

**Paginated views are not suppressed; filtered and re-sorted ones are.** Shopify
canonicalises `?page=N` to itself, so each page is its own indexable URL and a list
naming that page's slice with absolute positions is accurate. Infinite scroll does
not change that, because the JSON-LD describes the HTML that was served. A filtered
collection URL canonicalises back to the base collection, so a list emitted there
describes one page under a URL pointing at another; a non-default sort changes the
ordering the positions assert. An empty list is suppressed too, so a suppressed case
emits no `<script>` tag rather than an empty array. The price-range filter needs its
own check in the guard, because a price filter with no selected values still reports
`active_values.size` as 0.

**`itemListOrder` and `numberOfItems` are both deliberately absent.** An earlier
draft carried `itemListOrder: ItemListOrderAscending`, which asserts an ordering
semantic without checking the collection's actual sort; for a `manual`,
`best-selling`, or `created-descending` collection that is simply untrue, and it is
semantically valid JSON so no validator catches it. `numberOfItems` must equal the
`itemListElement` count, and the obvious source (`paginate.items`, the collection
total) does not equal it on any page of a multi-page collection, so emitting it
would be wrong by construction. Both are optional; omitting beats deriving.

**It lives in `sections/main-collection.liquid`, inside the `{% paginate %}` block.**
Inside, because it needs `paginate.current_offset`. Not in the shared
`snippets/product-grid.liquid`, which `sections/search-results.liquid` also renders,
where an `ItemList` would assert a stable list for a query-dependent result set. Not
in `templates/collection.json`, which Shopify generates and the theme editor can
overwrite.

**The loop over `collection.products` is a deliberate second pass**, not folded into
the existing `{% capture children %}` card loop. Building JSON inside that loop is
where trailing-comma bugs live, and at 24 items the second pass is free.

**The check is WARN, not ERROR.** `exitCodeFor` blocks only on fresh errors, and an
empty collection legitimately emits nothing.

## Return policy on the Organization node (unreleased)

### What changed

`snippets/structured-data-organization.liquid` gains a `hasMerchantReturnPolicy`
property declaring a 14-day return window. Edited in place rather than split into a
new snippet: `hasMerchantReturnPolicy` is a property *of* Organization, and every
`structured-data-*.liquid` in this theme emits a complete `<script>` node, so a
snippet emitting a bare JSON fragment would make the router's dispatch model a lie.
`CLAUDE.md` gains a matching rule.

### The premise this was filed under was wrong, in both directions

The `TODO.md` row said the item was blocked by Shopify's `structured_data` filter
not being extensible, "**not** by the return policy varying per product," and that
`MerchantReturnNotPermitted` expressed "Shift Fuel's final-sale case precisely." The
"Out of scope" paragraph further down this file recorded the same reasoning. Both
are wrong. The published refund policy is a **14-day return window** with a
non-returnable list covering custom or personalized designs, items marked final
sale, and gift cards. `shift-fuel-crewneck` is the one product that is **not** final
sale, which is exactly why it is the only one of six product templates carrying no
`return-policy-acknowledgment` block; the final-sale case belongs to the
custom-embroidered Lead II and Huddle products. So the store has a real return
policy, and policy non-uniformity is precisely the difficulty rather than a
non-issue.

### Design points that are load-bearing

**The over-statement is a chosen trade, recorded so it is not filed as a bug.** The
node asserts a 14-day window store-wide, and the policy's exclusion list covers five
of the six products. Google's org-level node is meant for a policy applying to most
or all products; here it applies to one. The mitigation is that `merchantReturnLink`
points at the live policy that enumerates every exclusion, and that this paragraph
exists.

**The product-level override is closed, not merely unimplemented.** Google's
override path is a `MerchantReturnPolicy` nested under **`Offer`**, not `Product`.
Shopify's filter owns that node and emits
`"@id": "/products/handle?variant=N#offer"`. Shadowing that `@id` to merge in a
property would mean reproducing Shopify's exact relative id including the variant
parameter, on products with hundreds of variants, relying on undocumented node-merge
behaviour. That is the silent-invalidity class the structured-data rules exist to
prevent. Do not re-propose it.

**Not a theme setting.** The categories are not one-field swaps:
`MerchantReturnFiniteReturnWindow` additionally requires `merchantReturnDays`, and
Google wants `returnFees`, `returnMethod`, and `refundType`. A dropdown would let
the operator pick a category that renders a structurally invalid node, with nothing
in CI to catch it, since `shopify theme check` does not parse JSON-LD and
`seo-review:test` is unit tests only. It is also a legal-adjacent claim that has to
track `/policies/refund-policy`, and a theme-editor dropdown can drift from that
silently. Changing it should cost a code edit and a release note.

**`applicableCountry` is the literal `"US"`.** Not from
`localization.available_countries`, which is market config that would silently widen
a legal claim the day international markets are enabled. Not from `shop.address`,
because the snippet's doc block bans postal detail and pulling a country code out of
that object invites the next reader to pull the rest. If the active delivery profile
ever ships outside the US, this becomes an array listing every country served.

**Every field traces to the published policy, not to a plausible default.**
`returnFees` is `ReturnFeesCustomerResponsibility` because the policy says the
customer arranges and pays for return shipping and no prepaid labels are provided;
`refundType` is `FullRefund` to the original payment method; `returnMethod` is
`ReturnByMail`.

**`merchantReturnLink` comes from `shop.refund_policy.url`**, prepended with
`shop.url`, so the policy text has a single source of truth and none of it is
duplicated into the theme. It is guarded, because `shop.refund_policy` is nil when
the policy is unpublished, and it follows the established leading-comma-inside-its-
own-`if` idiom. The outer comma is unconditional because the property itself always
emits.

## Empty blog listing is noindexed by article count (unreleased)

### What changed

`snippets/meta-tags.liquid` emits `<meta name="robots" content="noindex, follow">`
on a blog listing whose `articles_count` is zero. `/blogs/news` has no articles, so
that is the one page affected today. Three `scripts/seo-review/accepted-risks.json`
rows go with it: `blog-empty` is rewritten from "revisit at launch" to the decision
that was made, and `robots-noindex` plus `surface-noindex` are accepted on
`/blogs/news`.

**The guard is the article count, not the blog handle, and that is the whole
design.** The three options on the table were noindex, unpublish, or start
publishing. Publishing is content work and was explicitly not to be chosen by
default; unpublishing 404s the route and costs a nav edit to undo. Noindex was
picked because it is the only one that is reversible without anybody remembering
to reverse it: an unconditional noindex on the `blog` page type would survive the
first real post and quietly bury it, whereas counting articles means the tag
removes itself the moment there is something worth indexing. Do not "simplify" the
condition to a page-type check.

**`follow`, not `nofollow`.** The listing still links into the catalogue and those
links should keep passing through; the thin-content problem is the page being
indexed, not the page existing.

**Two seo-review checks fire on this by design, and are suppressed rather than
exempted.** Shopify's generated sitemap lists the blog regardless of the robots
meta, so the crawl reports `robots-noindex` and the anonymous surface sweep will
report `surface-noindex` once the password gate is off. Both are accepted-risk
rows keyed to `/blogs/news`. `blog` was deliberately **not** added to
`lib/checks.mjs`'s `NOINDEX_OK` set: keeping it an indexable page type means that
if the blog ever has articles and still carries a noindex, the check reds instead
of staying silent. The accepted-risk rows are self-clearing in the same way as the
tag, since the findings disappear with the first published article.

## Shipping copy: Expedited/Express standardised, announcement bar corrected (unreleased)

### What changed

`sections/header-group.json` rewords two announcement slides: slide 2 from "$8.00
Flat Rate Shipping **for All Items**" to "on Orders under $75.00", and slide 3
from "Free Shipping on Orders over $75.00" to "on Orders $75.00 and up". The
theme's "Expedited" wording is unchanged everywhere it appears; the other half of
the mismatch was closed by hand in Admin, where the four `Express` rate rows were
renamed to `Expedited`. That step could not be scripted because `write_shipping`
is not granted to the custom app. Verified read-only afterwards: four `Expedited`
rows at $20/$40/$60/$80 on the same weight tiers, both `Economy` rows and the
North America zone untouched, zero rows named `Express`.

**The direction of the Expedited/Express fix was decided by counting surfaces and
by the zero-orders window, not by which side looked cheaper to edit.** `TODO.md`
had recorded the Admin rate name as the cheap side to change, on a count of eight
template locations. That count was short. "Expedited" appears in 13+
customer-facing places once the live Shopify shop policy is included: five
product-template accordions, three FAQ answers, and roughly six mentions in the
Shipping Policy, which is not a repo file at all. Against that, "Express" is four
Admin rate rows. The policy is also the half that would degrade most under a
rename, because it deliberately contrasts "Expedited Shipping" with "Rush
Production" as a teaching point. The second, time-boxed reason: `orders(query:
"status:any")` returns zero, so no historical `shippingLine.title` carries the old
name. Order history freezes that string, so the rename is free now and is not free
after the first order. If this is read after launch, the calculus has changed.

**The boundary wording on slide 3 is a correctness fix, not a copy edit.** The
live rate is free at order total **>= $75.00**, so "over $75.00" mispriced exactly
$75. "$75.00 and up" matches both the rate condition and the FAQ, which already
said "Orders $75 and up ship free".

**The rename interacts with the 0-lb weight blocker, and does not fix it.** The
Shipping Policy says Expedited pricing "varies based on order weight". That is
true of the rate configuration (four weight tiers at $20/$40/$60/$80) and false in
practice while every variant weighs 0 lb, because every order of any size buys the
$20 tier. The rename makes the *name* honest; the *pricing* claim stays wrong
until per-variant weights are set. The policy wording was deliberately not
softened to match the bug, and the blocker stays open in `TODO.md`.

Rate descriptions at checkout are a separate matter, noted and declined here: all
six live rate rows have an empty description, so checkout shows a bare name and
price.

## Footer touch targets, dark-scheme contrast, and three stale findings retired (unreleased)

### What changed

`blocks/footer-policy-links.liquid` gives each policy link its own 44px touch
target. Separately and outside this branch, the `sss-dark-scheme` colour scheme
had six values corrected in Admin and reconciled through `shopify-sync`. Three
"Homepage review (2026-07-20)" backlog entries and the `og:image` entry turned
out to describe states that no longer exist and were deleted after visual
confirmation on the PR preview theme. Two pieces of reasoning outlive the tasks.

**The breadcrumb negative-margin pattern does not generalise to a wrapping
list.** `.breadcrumbs__link` in `assets/base.css` buys its 44px target with
`padding-block` plus an equal negative `margin-block`, so the hit box grows
while the line box, and therefore the visual density, stays put. The footer
backlog entry recommended copying it, and that recommendation was wrong for a
reason worth stating plainly: breadcrumbs never wrap. The footer links do. A hit
box that bleeds past its line box has nothing to collide with on a single row,
but on a wrapping list it overlaps the row beneath it, and with a 15px line in a
44px box across an 8px row gap the overlap is about 21px. The top row would
swallow taps aimed at the row below, which is a worse accessibility outcome than
the small target it set out to fix. The pattern here is the opposite trade:
`min-block-size` on an `inline-flex` anchor, with the list's row gap dropped to
zero so the padded boxes tile rather than overlap. Visual spacing between
wrapped rows goes from 8px to roughly 29px and the footer grows; that is the
cost of a compliant target on a list that wraps, and it is not avoidable by
being cleverer about margins. A comment in the block's stylesheet says so, since
the next reader will otherwise "fix" it back to the breadcrumb pattern.

**`primary` and `primary_button_background` are separate scheme variables whose
contrast fixes move in opposite directions.** `snippets/color-schemes.liquid`
renders them as genuinely distinct CSS variables, and `#007dd5` occupied five
slots in `sss-dark-scheme` at once: the accent, the primary button background
and border, and the selected-variant background and border. A single
find-and-replace across those five would have been wrong, because the two roles
are measured against different backdrops. The button and variant fields sit
*under white text*, so raising their ratio means going darker (`#0071c2`, 4.29
to 5.07). The accent is *text on the `#071e3f` navy*, so darkening it makes it
worse (3.86 to 3.27); it had to go lighter instead (`#3399e0`, 3.86 to 5.35),
absorbing the shade that had been the hover state, with hover stepping one
lighter again (`#66b3ea`, 7.26) to stay distinct. The general rule: measure each
colour field against what it actually renders on, not against the scheme's
nominal background. Nothing in CI checks any of this, which is why an
accessibility CI check is now its own backlog entry. Worth knowing when that
entry is picked up: the sibling `perts-foundry-website` repo already runs
`pa11y-ci` as a hard-failing WCAG 2.1 AA gate, but it can only do so because
Hugo gives it a local build to serve and crawl. Liquid renders server-side, so
there is no equivalent local target here, and the honest options are a preview
theme URL (which needs `STOREFRONT_PASSWORD` in a workflow that does not have it
today) or a JSON-level lint of `color_schemes` that catches less.

The two `selected_variant_*` values were latent rather than live when fixed. No
product template uses `sss-dark-scheme` today (all six use `scheme-1`, whose
selected-variant pair is 21:1), so no swatch on the storefront was failing. They
were corrected anyway so the scheme is not a trap if it is ever applied to a
product page.

One note on the reconcile diff, recorded because it was not caused by the colour
edit and will confuse whoever bisects for it later: the same `shopify-sync` PR
also reordered the three `social_*_link` keys within `current` (same values) and
**deleted** `secondary_color` and `ternary_color` from the chat app-embed block
settings. Neither was intended by the colour-scheme change.

## Ten CI/workflow and docs backlog items cleared (unreleased)

### What changed

Ten more `TODO.md` entries, all repo-local and needing no Admin access: seven
workflow changes and three docs items, two of which were close-outs rather than
edits. The reasoning worth keeping is below.

**`withRetry` is now a file, because `github-script` steps do not share scope
([AR-2]).** Three steps in `deploy.yml`'s `deploy` job (Post deploy report,
Squash merge, Report failure) each carried a byte-identical copy of the helper
plus its `RETRYABLE` / `isTransient` preamble. GitHub Actions does not support
YAML anchors, and two `github-script` steps in the same job share no JS scope,
so hoisting inside the file was not available: the only single definition is a
file, `.github/scripts/with-retry.js`, `require`d per step. Two things about
that require are load-bearing. The path must be absolute
(`path.resolve(process.env.GITHUB_WORKSPACE, ...)`); a relative `require`
resolves against `actions/github-script`'s own directory, not the workspace.
And it exports `makeWithRetry(core)` rather than `withRetry`, because the
helper's only external dependency is `core.warning`, which does not exist at
module load. The trust position is unchanged, not widened: the same step
already dynamically imports `report-format.mjs` from the same checkout into the
same token-holding process.

**Preview pushes now retry with a timeout, and the retry is always addressed by
theme ID ([AR-5]).** Live mode had 3 attempts at `timeout --kill-after=10s 8m`;
preview had neither, so one transient blip failed the PR. Preview now gets 2
attempts at 5m, proportionate to `preview.yml`'s 15-minute job budget. The trap
this had to avoid is the one the pre-existing exit-97 retry already documented:
retrying with `--unpublished` would create a SECOND `pr-N-preview` theme, which
the duplicate-name guard then refuses on every later run, permanently. So the
loop resolves a target ID before any retry, from the push report and, failing
that, from a fresh `theme list` lookup by name, because a create attempt killed
by `timeout` may still have registered the theme.

**Preview `cancel-in-progress: true` is a decision, now recorded beside itself
([AR-13]).** A cancelled preview push can leave the theme partially uploaded,
but the state is self-healing (the next run pushes the whole tree) and the theme
is an unpublished draft with no customer exposure, so queueing a push-storm buys
nothing. The cleanup job stays `false` for the opposite reason: a cancelled
delete leaks a theme that nothing sweeps up. The two settings differ on purpose;
the comment exists so the next reader does not "fix" the asymmetry.

**The `deploy` comment trigger is two checks, and only one of them is
authoritative ([CR-13]).** A YAML `if:` expression cannot trim or lowercase, so
the workflow-level condition is a cheap allow-list of exact bodies covering the
real miss cases (auto-capitalised `Deploy`, an invisible trailing space,
`/deploy`). The real match is re-asserted in JS in the gate job's first step,
which normalises (`trim().toLowerCase().replace(/^\//, '')`) and `setFailed`s on
anything that is not exactly `deploy`. Both layers are equality tests on the
WHOLE body. Never relax either to a substring match: the word `deploy` in
ordinary PR prose would then push to the live theme.

**A missing `exit_code` in `validate.yml` now fails instead of warning
([CR-15]).** It covers twelve steps, `gitleaks` among them, and a secret scan
that silently recorded no result must not merge green on a warning. It is
near-unreachable today because every step is `set +e` and always writes its
code, which is exactly why changing it costs nothing and closes the case where
one stops doing so.

**`defaults.run.shell` is behaviour-changing, and the audit is the work
([SA-7]).** All four workflows now run steps under
`bash --noprofile --norc -euo pipefail {0}`. GitHub's default is `bash -e {0}`,
so the delta is `-u` and `-o pipefail`. Every existing `run:` block was read
against it first: `deploy.yml` and `sync.yml` steps already set `-euo pipefail`
themselves, and `validate.yml`'s capture steps open with `set +e`, which clears
`-e` but deliberately does NOT clear `-u` or `-o pipefail`. Their pipelines
(`grep | tail | grep`) and unset reads (`${TESTS_RUN:-0}`) were checked
individually. Composite actions declare their own shell and are untouched; the
composite's `set +e` comment already explains why its own `-e` must be cleared.

**[AR-10] was verified fixed, not dropped.** The grouped-Dependabot gap the item
describes is closed in `deploy.yml`: the gate reads `update-type:
version-update:semver-*` commit trailers across every commit on the PR as the
PRIMARY signal (authoritative for grouped updates), keeps the `Bump|Updates X
from A to B` title regex as SECONDARY, and fails closed when neither yields a
severity. That is stronger than what the item asked for.

**[DS-15] closed as won't-do.** `.github/zizmor.yml` already carries a 40-line
rationale for its single `dangerous-triggers` suppression, verified accurate
against `deploy.yml`'s gate. The outstanding half was a CLAUDE.md pointer, and
it was declined: the rationale lives beside what it explains, and a second
location is a thing that can drift out of agreement with the first.

**[DS-10] was stale, so it was re-scoped rather than implemented.** It asked
README to enumerate the four required checks on `main`; `main` has required
exactly one, `validate / validate`, since the single-`validate`-job
consolidation. The README row now says "exactly one" and names where the context
string is actually configured (the private infrastructure repo's
`ci_check_contexts`), which is the part that can silently break: rename the
`validate` job or workflow here and `main` requires a check that no longer
reports. The same staleness ran through [SA-9], whose entry was re-scoped in
place rather than closed.

**Smoke-test paths: the action input default is the single source ([DS-13]).**
README restated the list; it now links the composite action's `smoke-paths`
input instead, the same treatment [DS-17] gave the CLI version. The
`release-notes.md` mention stays as written because it is a historical record of
what shipped then, not a second live copy. The item's third leg was already
gone: the composite action no longer carries the "commit it to CLAUDE.md as a
permanent fixture" instruction that would have created a third copy.

## Ten fast backlog items cleared in one pass (unreleased)

### What changed

Ten `TODO.md` entries that needed no Admin access and no product decision, cleared
together: two stale docs, two missing CI comments, the vacation date placeholders,
one real gallery defect, one template padding drift, and the size-chart table's
accessibility gap. The reasoning worth keeping is below.

**Gallery counts must come from the rendered set, not the filtered set ([CR-16]).**
`snippets/product-media-gallery-content.liquid` built `sorted_media` well below the
two places that size the slideshow against it, so the counter threshold
(`> 15` switches dots to a counter) and the `--single-media` class both read
`filtered_media.size`. That is the wrong number whenever `hide_variants: true`: the
sort loop `continue`s past any media whose `src` is in `variant_images`, so
`sorted_media` can be strictly smaller than `filtered_media`. A two-item filtered
set could render one slide while still getting arrows and no `--single-media`
class. The fix is a hoist, not new logic: the `sorted_media` block depends only on
`filtered_media`, `selected_variant_media`, `block_settings.hide_variants`, and
`variant_images`, all assigned by the end of the colour-filter block, so it moves
up unchanged and both consumers repoint to `sorted_media.size`. The contract to
keep: **anything that sizes the gallery reads `sorted_media`.** `filtered_media` is
an intermediate, and reading it downstream is the bug, not a shortcut.
`has_image_drop` and `is_single_column` already read `sorted_media` and were
correct.

**Two of the three "cosmetic template drifts" were not drift.** Only Shift Fuel's
`request_combination_001` `padding-block-start: 8` was real (now 0, matching the
other four apparel templates). The other two are load-bearing and were re-filed
once already, so they are recorded here and in `TODO.md` rather than left to be
rediscovered. Shift Fuel has no `<h5>Final Sale</h5>` in its Returns Policy body
because it is not final sale: it is the only apparel product with a 14-day return
and correspondingly the only one with no `return-policy-acknowledgment` block.
The gift card's `property_label` override is the documented garment-vs-gift-card
split (see that block's own `{% doc %}`), and the value is a live cart line-item
property key, so changing it splits the acknowledgment across orders placed either
side of the change. The lesson generalises: on these templates, "make them
identical" is not automatically the right diff.

**`--ignore-scripts` in the composite action, from verified facts ([CR-12]).** The
TODO text was partly stale. `esbuild` and `@ast-grep/napi` are *transitive* deps of
`@shopify/cli`, not direct ones, and their platform binaries arrive as
`optionalDependencies` (per-platform packages npm resolves at install time), not
via a postinstall download. `esbuild` is the only entry in `package-lock.json` with
`hasInstallScript`. `sharp` is a direct devDependency but ships no install script at
the pinned version, so the flag is a no-op for it. The reason the flag stays is that
this job holds the Shopify token; re-check `hasInstallScript` across the lockfile
after a dependency bump rather than assuming the list is still accurate.

**README version numbers were removed rather than synced ([DS-17], decided
2026-08-14).** The "At a glance" table restated the CLI version and the Node
floor; both had drifted (`3.94.3` vs `4.6.0`, `>=20` vs `>=22.12.0` with CI on 22).
Restating a number that lives in `package.json` guarantees it drifts again on the
next Dependabot bump, and no CI check would catch it. Both now point at
`package.json`'s `engines` / devDependency instead of quoting a value.
`release-notes.md`'s historical `3.94.3` mention is a record of what shipped and
stays as it is.

**Vacation date defaults are now `[SET DATE]`.** `settings_data.json` holds no
`vacation_*` key, so the four schema defaults in `config/settings_schema.json` are
literally what a future enable starts from. A plausible-looking date can ship by
accident; a placeholder cannot. `vacation_processing_date` is stamped onto each
order as the term the customer agreed to, so a stale value there is wrong on the
order record, not just in copy.

**The `theme-color` meta tag was deleted, not filled in.** It shipped with
`content=""`, which is not a valid colour, so it did nothing on every page render.
Nothing usable is in Liquid scope at that point in `snippets/meta-tags.liquid`: the
colour-scheme snippets render after it and emit CSS custom properties, not a
Liquid-readable value. A comment in its place records that re-adding it means
sourcing a literal colour.

**`blocks/table.liquid` row headers keep the data-cell styling.** Each body row's
first cell is now `<th scope="row">`, plus an optional visually-hidden `<caption>`.
Two constraints worth knowing before touching this file again. (1) The `<th>` must
be styled back to `font-weight: inherit; text-align: start` or the size chart
visibly changes; the semantics are for screen readers, not for looks. (2) The
`[data-columns="N"] .table-block__cell:nth-child(n+N+1)` hiding rules match on
`nth-child`, which is element-type-agnostic, so they keep working across the
`<td>`-to-`<th>` change. The setting ids (`column_count`, `show_header`,
`stripe_rows`, `colN_heading`, `rMcN`) and the 8x6 ceiling are generated by
`scripts/size-chart/lib/table-block.mjs` and compared against the shipped templates
by its golden tests; adding an optional `caption` setting changes no generated JSON,
so those tests stay green.

## Backlog triage: completed work moved out of TODO.md (unreleased)

### What changed

`TODO.md` now holds only items that still need action. Completed entries are
deleted from it rather than ticked, so the backlog never accumulates a history
section. The write-ups that were carrying real reasoning are preserved here.

**Per-variant image matching for colours.** Shipped as an alt-text filter. The
gallery shows photos whose alt text names the selected `Color` option value, plus
photos naming no value at all (group shots and design-only shots), and falls back
to the full gallery for a colour with nothing of its own rather than rendering
empty. Driven by one global `color_option_name` setting with blank as the kill
switch, mirroring `size_option_name`. Both gallery surfaces render
`product-media-gallery-content.liquid`, so no block schema and no product template
changed. The contract is `docs/product-media-alt-text.md`. The `alt` column in
`product-images/processed/manifest.csv` is where the strings are drafted, but that
path is gitignored on purpose, so it is a local convenience only: nothing in the
repo or in CI can catch wrong alt text, and Admin holds the only live copy.

*The original note was wrong about the mechanism.* It claimed the theme already
did the swap, reading that off `snippets/product-media-gallery-content.liquid:30`
and `snippets/card-gallery.liquid:88` filtering on
`where: 'attached_to_variant?', true`. They do filter on it, but Shopify caps a
variant at one attached media (`PRODUCT_VARIANT_ALREADY_HAS_MEDIA`), so attachment
expresses one hero per colour and can never express "all three black photos".
`hide_variants: true` was a no-op only because nothing was attached yet; with
heroes attached it would have hidden the other colours' heroes and left every one
of their secondary photos in the carousel. Recorded because the mistake is the
useful part: "the plumbing exists" was read off a filter that answers a different
question than the one being asked, and acting on it would have bought a day of
Admin work for the wrong result.

Photography coverage at the time, by *filename* colour: the crewnecks had black /
blue / gray, the quarter-zip black / blue / gray, the women's vest black only.
Those are not the Admin option values: every product's values are `Black` /
`Grey Heather` / `Classic Navy` (the vest, `Black` only; the repo vocabulary was
reconciled to these on 2026-08-11, though the live media alts written on
2026-07-17 still say the old `Gray` / `Navy`), and the `blue-*` files are the
Classic Navy ones. All 53 media across the five products were alt-tagged on
2026-07-17. Huddle is deliberately left unbound because its colour and design are
locked 1:1, so filtering by colour would hide the shopper's chosen design.

**Return-policy acknowledgement before add-to-cart.** Shipped as a terms summary
(merchant-editable `richtext`) plus one required "I agree" checkbox, wired together
with `aria-describedby`, and a policy link outside the label. The checkbox unticks
itself on any option change, which is what lets the
`properties[Return policy acknowledged]` value name the confirmed size honestly:
the box can only ever be ticked for the variant on screen. Unticking re-hides
accelerated checkout and is announced in a polite live region. Blank `terms` hides
the block entirely (hence `"tag": null`, so no empty element trips the fail-closed
`:has()` rule). Validation renders as visible text with `aria-invalid`, not just
the native bubble.

*The original note had gap (1) backwards*: it called for adding the block to
`product.shift-fuel-crewneck.json`. That is the one product with no personalization
and a plain 14-day return window, so it is the one product the checkbox must not
appear on. The real inconsistency was `product.huddle-crewneck.json`, which carried
the checkbox while its own Returns Policy accordion promised a 14-day return.
Recorded because the mistake is the useful part: block placement, not block
content, is what expresses the policy.

**Gift card template.** Added `templates/product.gift-card.json` (cloned from the
Huddle crewneck, then stripped of garment framing: no size chart, no applique, no
combination request). Keeps the native recipient form via `gift_card_form: true`
and a gift-card-specific acknowledgement and accordion.

**Size-guide link at the size selector.** `snippets/size-guide-link.liquid` plus
`assets/size-guide-link.js` render a real `<a href="#SizeChart">` beside the size
option on both variant-picker styles; it opens the accordion row, scrolls, and
moves focus to the summary. The size option is identified by a global
`size_option_name` setting resolved through `snippets/size-option-position.liquid`,
shared with the acknowledgement block because a theme block cannot read another
block's settings. `_accordion-row.liquid` gained an optional `anchor_id` setting,
emitted as `SizeChart` by `table-block.mjs`, so it survives `apply-size-chart.mjs`
(a hand-edited value would be upserted away). `accordion-custom.js` gained a
`data-latched-open` latch so a row opened this way is not slammed shut by the 750px
breakpoint handler, and it honours a direct `#SizeChart` page load.

*Cross-layer contract*: the anchor literal is duplicated across the generator, the
Liquid, and the link's href, because the theme has no build step.
`test/anchor-contract.test.mjs` is the only thing holding those together; the
goldens cannot, since they compare the generator to its own output.

**Size-chart tooling, completed follow-ups.** "Choosing your size" guidance ships
in both the accordion and the PNG intro (deciding measurement, between-sizes
tie-breaker, no-reference-garment path, and a contact-us help line). *Correction
(2026-07-16):* that paragraph was originally claimed to be garment independent and
living once in `copy.md`. The vests disproved it: the paragraph named chest (the
women's vest measures bust) and named sleeve (a vest has none). It was split. The
tie-breaker and help line stayed shared, the deciding measurement became the
`{{deciding_label}}` token, and the measure-yourself instruction moved onto the
columns that can support it.

Also landed: column-driven generalisation (profiles declare their own ordered
`columns` and pick a `garment` silhouette, with the quarter-zip and women's
microfleece vest onboarded end to end); a vertical-rhythm pass deriving PNG canvas
height from content with per-garment `garmentTop` collar extents; per-garment
accordion prose composed from each column's `explain` so a measurement is explained
if and only if the blank has that column (adding `garment_noun` and `decides_size`
to the schema); and the unisex microfleece vest profile dropped, since only the
women's vest launched.

**Deferred CI findings closed 2026-05-05.** `[AR-4]` and `[AR-6 / IR-1]`: the
composite action gained `mode: delete-preview`, routing preview cleanup through it
and removing the hardcoded `@shopify/cli` version; the install pattern consolidated
into a `setup-shopify-cli` composite action shared by `shopify-theme-push` and
`validate.yml`. `[CR-8]` landed alongside them. `[IR-5]` and `[SA-12]` went
obsolete when `drift-watch.yml` was deleted; `[SA-8]`'s surviving half is covered
by `validate.yml`'s `SHELLCHECK_OPTS: "-e SC2016 -e SC2317"`.

**Default `templates/product.json` gap accepted (2026-08-14).** Every product this
store sells is expected to carry its own custom template rather than fall back to a
generic one, so the absence is intentional. The standing obligation it creates:
assigning a template suffix is a required step when creating any product, because
nothing renders behind a cleared or unset suffix.

**Size-chart scope: deliberately excluded (operator decision, 2026-07-14).** These
were considered and dropped; they are not backlog gaps. Returns / exchange line in
the chart (handled by the return-policy-acknowledgment block near the buy buttons,
do not duplicate). Made-by-hand measurement-tolerance line (skipped). Model /
on-body fit reference photo, imp 4 (photography and merchandising, out of tooling
scope; add a "model is X tall, wears M" gallery caption when on-body shots exist).
Aggregate runs-small / true / large review subscore, imp 3 (cold-start; revisit
once review volume exists). No-tape string-and-ruler fallback, imp 3 (redundant
with the "measure a top you already own" method that is already the primary
instruction). Pre-purchase / add-to-cart size nudge, imp 2 (covered by the existing
return-policy-acknowledgment block; avoid extra checkout friction).

**Pre-launch review (2026-08-13): verified clean.** Recorded so nobody re-audits
these. The six product templates are structurally identical (same block trees, same
gallery settings with `hide_variants: true`, same accordion row ids and headings,
`anchor_id: "SizeChart"` on all five apparel templates). The Huddle applique
dropdown matches `scripts/applique-grid/patterns.json` exactly, all 18 entries, so
the old "3. Test" placeholder is gone. All three size-chart tables match their
profiles cell for cell. Alt-text colour binding is correct on every product (three
photos bound per colour, charts and size guides and group shots correctly shared).
Every product has a `templateSuffix` that resolves. The FAQ's shipping claims match
the live rates exactly, territories included. The footer social block and the theme
settings agree, so `sameAs` is accurate. The `#away-from-studio` FAQ anchor is
intact.

## applique-grid: consent is now a token, and four fail-open guards closed (unreleased)

### What changed

Pre-PR review of the tooling branch surfaced four guards that were open in a way
their own comments said they were not, plus one gate whose strength was inverted
relative to its blast radius. All five are mechanisms here, not prose.

**The live publish gate had no consent step.** The only thing between a dry run
and the irreversible live write was `publish-plan.json`, a file the same process
had just written, valid for 24 hours. That checks freshness, which is not the
same question as whether anyone said yes; a process could satisfy it by talking
to itself. Meanwhile the *reversible* local registry write did have `--confirm`.
`--dry-run` now prints a 12-character approval token for exactly the plan it
printed, and the live run requires it back as `--approved <token>`. The token has
to travel out to the operator and return through argv, which is the one step no
amount of self-persuasion performs. A token-less live run refuses before reading
or consuming anything, so a mistyped command costs no gate round trip.

**`defaultBranch()` failed open.** When `origin/HEAD` was unset it returned the
first conventional name that existed *locally*, so in a repo whose real default is
`master` but which also carries a stale local `main`, it answered `main` and
`draft.mjs --write` ran happily on `master`. It now returns every name that must be
refused, and refuses all of them when it cannot be certain. The cost of being wrong
is renaming a branch; the cost of the old behaviour was an unreviewed commit on the
default branch.

**`lib/registry.mjs`'s `save()` was a plain `writeFile`.** `publish.mjs` calls it
immediately after the live media writes, to record the new chart GIDs, which makes
it the highest-stakes write in the module: a truncation there loses the mapping from
published charts to live media and the next publish would re-create them with nothing
to reconcile against. It is now the same atomic temp-file-plus-rename that `draft.mjs`
already used for the reversible write. The implementation is shared rather than
duplicated, so there is one of it.

**The reorder's "target still achievable" check was set membership.** A length
compare plus `every(includes)` cannot see a duplicate, so a target of `[A, A, C]`
against a live `[A, B, C]` scored achievable and the reorder issued would have dropped
B out of the gallery entirely. It is a multiset comparison now.

**`APPLIQUE_REVIEW_DIR`'s containment check was lexical only.** A symlink whose own
path sits outside the repo but which points into it passed clean, and review images
landed in the public working tree, which is the exact thing that guard exists to
prevent. The check now re-runs against the resolved real path.

Also: the `--out-dir` containment rule was a module-private regex in four entry
points, unreachable from a test, so deleting it outright left the whole suite green.
It is one exported function with its own cases now, and a subprocess test per tool
pins the call sites. Markdown cells in both gate tables escape `|`, which is legal in
a filename and could otherwise forge a row in the artifact the operator approves from.

## applique-grid: pinned gallery media and a corrected reorder verdict (unreleased)

### What changed

Two defects in `scripts/applique-grid/`'s publish path, both of which produced a
confident wrong answer against irreversible live writes.

**The charts were hard-coded as the contiguous gallery tail.** The operator wants
the logo last, so the audit showed a permanent STALE line and the next publish
would have moved the charts past the logo and silently undone their Admin fix.
The registry now takes an optional `gallery.pin_after_charts`, and the desired
order becomes untouched live media (minus the pinned), then the charts in page
order, then the pinned media in declared order. With the key absent the computed
order is byte-identical to before, which a test locks against every existing
ordering fixture.

Regex validation of a pinned GID proves shape, not existence, so each way this
could go quietly wrong is a hard stop naming the GID: absent from live media,
overlapping the chart set (re-checked at plan time, since the registry can be
hand-edited in between), overlapping the delete set, duplicated, malformed. An
empty list and an absent key are exactly equivalent. Unknown keys are now
rejected by name throughout the registry, because a misspelled `pin_after_chart`
would otherwise validate clean, do nothing, and let the next publish undo the fix
while the registry looked correct.

**The first publish computed `reorder not required` and was wrong.** The planner
simulated post-create gallery positions on the assumption that Shopify appends
new media at the end. The real run disproved it: the dry run said no reorder was
needed, both creates landed mid-gallery, and the next audit reported STALE.

With creates pending there is no honest verdict to give before they land, so the
dry run now reports `undetermined until post-create` and prints the TARGET final
order. The operator approves a destination and a possibility rather than a false
negative.

### Why the fix is not "re-read and reorder"

The naive fix buys correctness by executing a live gallery mutation the operator
never approved, which is what the plan/approve/execute split exists to prevent.
So after the readiness barrier `publish.mjs` re-reads, reconciles, checks the
approved target is still achievable, snapshots, and only then moves anything.
Every failure path returns without issuing a reorder at all.

Reconciliation is scoped so it still catches foreign drift while tolerating our
own writes: the re-read set must be exactly (plan-time media minus our deletes)
plus our creates, and every untouched media must still carry the alt and filename
it had at plan time. A concurrent Admin edit trips it; a CDN-rewritten filename on
one of our own creates does not.

The stored dry-run plan is now stamped with version, time, shop, product, the
live-state hash, and the approved reorder verdict, and a live run refuses
anything that does not match, including a plan older than 24 hours against
otherwise identical live state.

### Deploy impact

None on the storefront. `patterns.json` gains an optional key, and the dropdown
text derived from it is unchanged (a test asserts the regenerated template diffs
empty). The live gallery is already in the order the new rule wants, so adding
the logo GID to `gallery.pin_after_charts` turns the audit's gallery-order line
PASS with no live write.

### Rollback

Revert the commit. Adding the registry field touches no live state, and if a
reorder has already fired, the pre-reorder gallery order is in
`product-images/applique/publish-snapshots/`.

## Custom Orders redesign + FAQ section color-scheme migration (unreleased)

### What changed

`templates/page.custom-orders.json` is rebuilt to match the homepage's design
language: uppercase eyebrow + heading lockups above every section, a navy
`sss-dark-scheme` hero and a rounded navy closing-CTA card (cloned from the
homepage's `closing_Zx4Vn8` card, with fresh block keys), an alternating
scheme rhythm (navy / scheme-3 / scheme-1 / scheme-3 / white FAQ / scheme-3),
72px section padding, and the four process steps arranged as a 2x2 grid via
two row-direction group wrappers. The oversized `jumbo-text` closing block,
which overflowed the viewport on mobile, is replaced by the card.

A second pass ports two homepage signature elements. The hero section
converts from the generic `section` type to `hero` and reuses the homepage's
custom-liquid headline lockup (Dancing Script cursive word flanked by
`sss-star.svg` stars); no hero media is set, so the section renders as a navy
band. That surfaced a latent hero.liquid behavior: a media-less hero rendered
the `hero-apparel-1` placeholder SVG on the storefront, not just in the
editor, so the three placeholder emissions are now guarded on
`request.design_mode` (inert for the homepage hero, which always has media).
A scoped `.hero-lockup--custom-orders` override drops the cursive
word to 1.3em because "Custom Orders" is longer than "Obsessed". The four
process steps become rounded `scheme-3` cards (24px radius, 28px padding) on
the white section, echoing the homepage product-card language; the
numbered-circle CSS keys off `h4` elements in DOM order, so the card wrappers
do not disturb it. Because the two row-direction wrappers size each card to
its own text, the `hiw_styles` block also converts the section content
wrapper to a 2-column grid at 750px+: the rows and their `group-block-content`
divs collapse via `display: contents`, the lockup spans both columns, and
`grid-auto-rows: 1fr` equalizes all four cards to the tallest. The
`:nth-child(2..4)` selectors bind to the section's block order (styles,
lockup, row 1, row 2); reordering blocks in the editor breaks the grid.

Two rendering bugs fixed rather than worked around:

- **Bullet lists rendered center-aligned with left markers.** Text blocks with
  `width: fit-content` never emit `--text-align` (see
  `snippets/text.liquid`), so their `alignment: left` was silently ignored and
  the section's centered `--horizontal-alignment` leaked in as the default.
  Both bullet-list body blocks now use `width: 100%` + `max_width: normal`,
  the code path that honors the alignment setting. (A desktop visual pass then
  centered the text sections' lockups and body columns on one axis; the body
  copy stays left-aligned inside its centered `normal`-width column, since
  `narrow` at 22.75em left-pinned a skinny column under full-width headings.)
- **Headings referenced `var(--font-primary--family)`, which is defined
  nowhere in the theme** and is not even an option in the text block's font
  select. It is inert on non-custom type presets, so this was hygiene, not a
  visible fix; this template now uses `var(--font-heading--family)`. The same
  stale value remains in 15 other templates and is deliberately out of scope
  here (candidate for a separate cleanup pass).

`sections/faq.liquid` moves onto the color-scheme system: the hardcoded
`text_color` / `border_color` settings are removed and the CSS reads
`var(--color-foreground)`, `var(--color-foreground-heading)`, and
`var(--color-border)` instead; a `color_scheme` setting (default `scheme-1`)
plus a scheme-classed wrapper div (which also carries
`section.shopify_attributes`) give both instances an explicit color contract;
the title uses `var(--font-heading--family)`; max-width widens from 600px to
720px. `highlight_color` deliberately stays a hex picker: the deep-link flash
is a semantic highlight (yellow on every scheme), not a scheme color. This
supersedes the stage-2a claim below that the FAQ style block sets its colours
explicitly; colour now comes from scheme variables.

### Ordering

The stage-2a/2b entries below record that Shopify validates a JSON template
against the section schema already stored on the theme, which forced that pair
to deploy in two stages. This change avoids the hazard instead of re-testing
it: neither `page.faq.json` nor `page.custom-orders.json` sets the new
`color_scheme` setting, so no template references a setting the live schema
does not know, and the schema default carries the value. Single-stage deploy
is safe in both directions (the removed `text_color` / `border_color` values
are cleaned out of both templates in the same commit, and unknown instance
settings are ignored at render anyway).

### Rollback

`git revert` plus deploy, as one unit. The removed color settings come back
with their old stored values on revert since the template cleanup is in the
same commit.

## Vacation mode: one admin toggle, four storefront surfaces (unreleased)

### What changed

A new "Vacation Mode" theme-settings group (checkbox `vacation_mode_enabled`,
default off) drives four surfaces at once, so the operator can flip the whole
feature from the theme editor on the sync theme with no hand-authored PR:

- **Announcement bar**: a new `blocks/_vacation-announcement.liquid` slide,
  registered in `sections/header-announcements.liquid` and added to
  `sections/header-group.json` as `vacation_announcement_001`. Dormant blocks
  render nothing, so the entry stays in the group JSON permanently.
- **Popup**: `snippets/vacation-popup.liquid` + `assets/vacation-popup.js`,
  rendered from `layout/theme.liquid`, auto-opens once per browsing session
  (sessionStorage key `vacation-popup:seen`, fail-closed when storage is
  blocked, never auto-opens in the theme editor). No light dismiss: a
  capture-phase guard stops `DialogComponent`'s outside-click close, so the
  popup closes only via the dismiss button, the X, or Esc (kept per the modal
  pattern in docs/accessibility-patterns.md).
- **Product-page checkbox**: `blocks/vacation-acknowledgment.liquid` +
  `assets/vacation-acknowledgment.js`, a trimmed clone of the return-policy
  acknowledgment (no variant-change untick; text from global settings since
  blocks cannot read each other's settings). Records a line-item property
  named by `vacation_property_label` whose value embeds
  `vacation_processing_date` ("Yes - processing begins after August 15"), so
  each order records the exact date the customer acknowledged; a blank date
  degrades to plain "Yes". Added as `vacation_ack_001` to all five garment
  product templates.
- **Shipping line**: `snippets/shipping-info.liquid` appends the
  `vacation_shipping_message` note in both branches, which surfaces on the
  product page and directly above the cart's checkout button.

### Operating constraints (the sync traps)

- **Four independently dated settings must be updated together** before each
  enable: popup body, checkbox terms, shipping note, and `vacation_processing_date`
  (the announcement default carries no date). The settings-group paragraph
  enumerates them; nothing reconciles them. `vacation_processing_date` matters
  most: it is the date recorded on orders.
- **The FAQ deep link is a repo-side contract**: the announcement slide links
  (and the popup-body / checkbox-terms defaults link) to
  `/pages/faq#away-from-studio`, which exists only while `faq_item_vacation`
  in `templates/page.faq.json` keeps `custom_anchor: "away-from-studio"`.
  Nothing validates the fragment; a removed or re-anchored FAQ entry turns
  every vacation link into a scroll-to-top.
- **Do not rename `vacation_property_label` mid-vacation**: the value is the
  line-item property key, so renaming splits the acknowledgment across orders.
- **The gift-card template deliberately has no vacation checkbox**: nothing
  ships, so there is nothing to delay. The popup, announcement, and gift-card
  free-shipping line still appear.
- **Settings-group labels are deliberately literal English**, not `t:` keys,
  matching the custom "Shipping Information" settings precedent: operator-only
  UI, and the storefront-visible strings are all operator-editable settings
  anyway.

### Announcement bar: first-visible replaces index-0

The stock `_announcement.liquid` hardcoded `aria-hidden="false"` only for
block index 0, which was correct while every block always rendered. A dormant
vacation slide (or a blanked announcement) at index 0 would have started every
slide hidden, blanking the bar until JS hydrates, and the editor rewrites
`block_order` freely, so "keep the vacation block last" was not an invariant
worth documenting. Instead `snippets/announcement-visible-blocks.liquid`
computes the first block that actually renders, and both announcement block
types compare against that. Block order is now cosmetically free. The same
snippet's `output: 'count'` mode replaces the section's `section.blocks.size`
gates, so one real announcement plus a dormant vacation block does not render
dead carousel controls (a headless-review catch).

### Express checkout now has two composing gates

`blocks/vacation-acknowledgment.liquid` adds a second fail-closed `:has()`
rule hiding `[ref='acceleratedCheckoutButtonContainer']` while its checkbox is
unticked. It composes with the return-policy gate: the container shows only
when neither acknowledgment is pending. This supersedes the earlier
release-note claim that Shift Fuel is "the only product showing express
checkout" and that the ref has a single dependent: with vacation mode enabled,
Shift Fuel's express checkout is gated too (by the vacation checkbox alone,
since it still has no return-policy block), and the ref now has two CSS
dependents, both documented in `blocks/accelerated-checkout.liquid`.

### Accepted enforcement gap

The acknowledgment checkbox covers product-page checkout only. The cart page's
checkout button (and items added before the toggle was enabled) can complete
checkout without the recorded acknowledgment; the announcement, popup, and the
vacation note on the cart's shipping line are the mitigations. A cart-level
gate is deliberately out of scope unless bypass orders become a real dispute
problem.

## SEO: reset the default page template to stock (unreleased)

Stage 4b, and the highest-risk change in the SEO remediation. It is the only one
that can blank a live page.

### What changed

`templates/page.json` is restored to **Horizon's actual upstream stock
template**, taken verbatim from the `Horizon v3.0.0` import commit: `main`
enabled, carrying a `text` block that renders `<h1>{{ closest.page.title }}</h1>`
and a `page-content` block that renders the page body. The `_blocks` section and
its `order` entry are gone.

### The first attempt at this was wrong, and preview caught it

Worth recording, because the failure was silent and would have shipped. The
first draft removed `_blocks` and left `main` with settings but **no blocks**,
on the assumption that `main-page` renders `page.content` itself. It does not:
`sections/main-page.liquid` renders `{% content_for 'blocks' %}` and nothing
else, so a blockless `main` renders an empty section.

On the preview theme that produced a `/pages/data-sharing-opt-out` with **zero
`<h1>`** and 286 characters inside `<main>`, essentially all of it breadcrumb
and JSON-LD. The page body was gone. That is precisely the "turns wrong content
into no content" outcome the staging was designed to prevent, and neither
theme-check nor `validate` flags it, because the template is perfectly valid
JSON referencing a real section.

### Why

The default page template was not a default. It hardcoded About's content, so
every page assigned to it rendered About's hero, mission, values, story, and
team blocks instead of its own body. `/pages/data-sharing-opt-out` has been
serving About's content, complete with an "About Sapphire Shadow Studio" H1.

### Preconditions, both verified before this was written

1. `templates/page.about.json` is live (stage 4a, deployed).
2. The About page is assigned to the `about` template in Admin. Confirmed
   through the Admin API rather than by eye: `pages(first: 50)` reports
   `templateSuffix: "about"` for handle `about`.

Order matters. Deploying this before that assignment would have blanked
`/pages/about` on the live storefront.

### Every page was enumerated, not sampled

The plan called for an exhaustive Admin enumeration because an empty body would
turn *wrong content* into *no content*, which is worse. There are five pages:

| Handle | Template | Body |
|---|---|---|
| `data-sharing-opt-out` | (default) | 2602 chars |
| `about` | `about` | 0 |
| `contact` | `contact` | 0 |
| `custom-orders` | `custom-orders` | 0 |
| `faq` | `faq` | 0 |

Exactly one page uses the default template, and it has real body content, so
this change gives that page its own content back rather than blanking anything.
The four zero-length bodies are all on templates that disable `main` and compose
from sections, which is what makes an empty Admin body correct for them.

### The smoke test does not cover this

`.github/actions/shopify-theme-push/smoke.mjs` probes published **products**
from the sitemap. It reaches no page templates at all, so a regression here
deploys green. Verify `/pages/about` and `/pages/data-sharing-opt-out` by hand
after deploy.

### Rollback

`git revert` plus deploy. `blocks/ai_gen_block_23c928c.liquid` is never deleted,
so the block type still exists and the reverted template renders as before.

## SEO: add a dedicated About page template (unreleased)

Stage 4a, the first half of a change that needs an Admin step in the middle.

### What changed

New `templates/page.about.json`, a **byte-for-byte copy** of the current
`templates/page.json`, preserving section key `176956306257ea4668` and block key
`ai_gen_block_23c928c_UaLftP`. `templates/page.json` is untouched.

### Why

The default `page` template is not a default at all today: it hardcodes the
About page's content. Every page on the default template therefore renders
About's hero, mission, values, story, and team blocks instead of its own body.
`/pages/data-sharing-opt-out` shows About's content right now.

Splitting the About content into its own template is the precondition for
resetting `page.json` to stock, which is stage 4b.

### After this deploys

Both templates render About and nothing changes on the storefront.
`/pages/about` is unchanged; `/pages/data-sharing-opt-out` is still wrong, as it
already was. That is the intended no-op.

### Rollback stops being simple after the Admin step

Revertable in isolation right now. It stops being independently revertable the
moment the About page is assigned to the `about` template in Admin: reverting
then would strand a live page pointing at a template the theme no longer has.
To roll back after assignment, un-assign in Admin **first**, then revert.

## SEO: breadcrumbs (unreleased)

Stage 3 of the SEO remediation, and independent of the FAQ pair below. The
storefront had no breadcrumb trail and no `BreadcrumbList` markup on any page.

### What changed

New `snippets/breadcrumbs.liquid`, rendered from `layout/theme.liquid` as the
first child of `<main>`. It emits the visible `<nav>` and its `BreadcrumbList`
JSON-LD **from one trail computation**, which is the whole point of the single
snippet: the markup and the structured data cannot drift apart.

Not rendered from `layout/password.liquid`.

### Design points that are load-bearing

**Page types are an allow-list, not a deny-list**: `product`, `collection`,
`page`, `article`, `blog`, `list-collections`. A page type Shopify adds later
therefore defaults to no breadcrumb rather than to a guessed trail.

**`policy` is deliberately excluded.** "Home > Policies > Refund policy" invents
an intermediate level with no page behind it, and Google expects breadcrumbs to
reflect a hierarchy the user can actually navigate. A two-item
"Home > Refund policy" is not worth the markup. The same test keeps
`list-collections` in: `/collections` is a real page.

**The last `ListItem` omits `item`.** Spec-legal, and it sidesteps a real trap:
on a collection-scoped product URL `product.url` returns
`/collections/x/products/y` while `canonical_url` returns `/products/y`.
Emitting either would risk contradicting the page's own canonical. The visible
last crumb is still a link, per the accessibility contract.

**The trail is carried as two delimiter-joined strings**, not arrays, because
Liquid cannot append to an array. Home is always first, so every later entry
appends the delimiter unconditionally and there is no leading-empty-element
edge case.

**Product parent collection is chosen by an explicit preference list.** Three
steps: the collection the shopper actually browsed through when the URL is
collection-scoped, else the first hit in a hand-maintained preferred-handle list
(`healthcare`, `the-vitals-collection`, `featured`), else any collection that is
not a catch-all.

The first draft of this snippet simply took the first entry in
`product.collections` that was not `all` or `frontpage`, and preview
verification caught what that produces: `all-products` is a **real** collection
in this store, not one of Shopify's virtual ones, and it sorts first. So every
**canonical** product URL rendered "Home > All Products > Lead II Crewneck",
while only the collection-scoped URL got "Home > Healthcare > ...". The
canonical URL is the one Google indexes, so the breadcrumb it would have shown
was the least informative of the four available, which throws away most of the
reason to emit the markup. `all-products` is now excluded alongside `all` and
`frontpage`.

The tradeoff moved rather than vanished. Ordering is now deterministic, but the
preferred list is hardcoded and hand-maintained: **a handle that no longer
exists is skipped silently**, with no error, so renaming or removing a
collection degrades the trail without failing anything. Nothing in CI checks it.
A `custom.breadcrumb_collection` metafield remains the fix that needs no
maintenance; it is recorded in `TODO.md`.

### Accessibility

Matches the breadcrumb contract in `docs/accessibility-patterns.md`: `<nav>` with
`aria-label` wrapping an `<ol>`, and the current page **is** a link carrying
`aria-current="page"`.

The separator is drawn as a rotated CSS border chevron, never `content: '/'`,
which several screen readers announce as "slash" on every crumb. A
`[dir='rtl']` rule flips it.

Links get `padding-block` with an equal negative `margin-block`, so they reach a
usable touch-target height without changing the visual density.

**Honest tradeoff:** putting the breadcrumb inside `<main>` is the correct
placement, but it means skip-link users tab through the breadcrumb links before
reaching content. That is the normal cost of correct placement, not a benefit.

### `#MainContent` was missing `tabindex="-1"`

Found while verifying the skip-link interaction, and fixed here in both
`layout/theme.liquid` and `layout/password.liquid`. It is a precondition for
this change rather than a drive-by: without it the skip link scrolls the page
but focus stays on the link, so the next Tab goes back into the header instead
of into the breadcrumb and content. The repo's global accessibility rules
already required it. A comment on the attribute says why, so it does not get
tidied away.

### Locale strings

Three storefront-visible keys: `accessibility.breadcrumb`,
`content.breadcrumb_home`, `content.breadcrumb_collections`. Added to
`locales/en.default.json` with real values and mirrored into all 30 other
locale files with `TODO:` placeholders, per the existing convention. That is
why this is a 31-file diff for three strings, and why it shipped as its own PR.

The locale files were edited byte-wise rather than through a JSON round trip.
They use CRLF, and they carry a `/* */` header plus `//` comments, so `json.load`
fails on them and a naive read/write rewrites every line ending into a
several-thousand-line diff. Insertions were anchored on the top-level block
opening line, because key names repeat across blocks in these files and a
first-match search lands in the wrong one.

## SEO: FAQ template opts into an H1 (unreleased)

Stage 2b, and the other half of the pair described in the entry below. Stage 2a
added the `title_heading_tag` select to `sections/faq.liquid` with a default of
H2, which made it a deliberate no-op. This change is what actually gives
`/pages/faq` a top-level heading.

### What changed

`templates/page.faq.json` sets `"title_heading_tag": "h1"` on
`sections.faq_section.settings`. That is the whole diff. The FAQ title now
renders as the page's `<h1>`, resolving the zero-H1 finding on `/pages/faq`.

`templates/page.custom-orders.json` is deliberately left alone. It omits the key,
takes the H2 default, and keeps the H1 it already has in its hero.

### Ordering

Stage 2a is already deployed to live, which is the precondition for this push.
Shopify validates a JSON template server-side against the section schema stored
on the theme and rejects the whole asset if a setting is unknown, so the reverse
order would have failed the deploy. The setting `id` was also confirmed wired
end to end in the theme editor on the preview theme before this was written.

Rollback is `git revert` plus deploy, but not in isolation: reverting 2a while
this is live leaves the template referencing an unknown setting. Revert both
together.

### Out of scope

Everything else in the SEO remediation: breadcrumbs, the page-template split, and
all Admin-side work (meta descriptions, collection descriptions, SEO titles,
contact copy, variant SKUs). The theme diff is not the complete remediation.

## SEO: FAQ page heading and FAQPage markup (unreleased)

Stage 2a of the SEO remediation. `/pages/faq` had **no `<h1>` at all**: the FAQ
section hardcoded an `<h2>`, and the page's template disables `main`, so nothing
else supplied a top-level heading.

### What changed

`sections/faq.liquid` gains a `title_heading_tag` select (H1 / H2, **default
H2**) on the section schema, and renders the title with the chosen tag. The
default is deliberately H2, so this change alone is a no-op: every existing
placement keeps rendering exactly what it rendered before, and only a template
that opts in gets an H1.

Editing this `{% schema %}` by hand is allowed here. Nothing in `scripts/`
generates `sections/faq.liquid`; the "never edit schema directly" rule applies to
generated schemas such as the size-chart output.

The label is plain English rather than a `t:` key, matching the twelve labels
already in this file. Theme-check has no rule requiring `t:` keys on schema
labels, so this is consistent rather than a shortcut.

No CSS change was needed. The title is selected by class, and the section's
`{% style %}` block sets font-size, colour, alignment, margin, and weight
explicitly, so swapping the element is a visual no-op.

`FAQPage` JSON-LD is now emitted from the section's own `faq_item` blocks, only
when the section has blocks.

### Deployment ordering, not optional

**This must be deployed before the template change (2b) is pushed.** Shopify
validates a JSON template server-side against the section schema *already stored
on the theme* and rejects the entire asset if a setting is unknown. Pushing a
template that sets `title_heading_tag` before this section is live gets the
template rejected wholesale. Merging is not enough; it has to be deployed.

The same coupling runs backwards: once 2b is live, reverting this alone makes
`templates/page.faq.json` reference an unknown setting. Revert both together.

### On FAQPage's actual value

Close to zero, and it is worth saying so plainly so nobody restores it later
expecting more. FAQ rich results were deprecated on 2025-05-08 and **removed
outright on 2026-05-07** for all sites, including government and health, with
Rich Results Test and Search Console support withdrawn alongside. `FAQPage`
remains valid schema.org and is emitted for entity and LLM comprehension only.
Expect no SERP effect, and do not validate it in Rich Results Test, which no
longer recognises the type.

### Why the array is built with a leading-comma flag

The obvious `{%- unless forloop.last -%},{%- endunless -%}` is wrong here, and
subtly so. Blocks with a blank question or answer are skipped, so if the *last*
block is skipped the previous one still emits its separator and the array closes
on a trailing comma. That invalidates the entire JSON-LD node, and browsers
surface no parse error for it. The loop therefore tracks whether anything has
been emitted and writes the comma *before* each subsequent entry.

## SEO: Organization and WebSite structured data, header cleanup (unreleased)

A full SEO crawl of the storefront (25 URLs, all sitemaps, cross-checked against
the Admin API) found one content bug, four code defects, missing metadata, and
three absent structured-data types. The store is password-protected pre-launch,
so nothing is indexed and there is no ranking damage to undo. That is what makes
this cheap now: every fix lands before Google ever crawls the site.

This entry covers the first repo change. The rest of the remediation ships as
separate PRs (FAQ heading, breadcrumbs, page templates) and as Admin-side work.

### What changed

**Structured data moved out of the header and into snippets.** A new
`snippets/structured-data.liquid` router renders from `layout/theme.liquid`, in
the head, right after `meta-tags`. It currently emits Organization and WebSite,
and only on the homepage. Two design points are load-bearing:

- **The `@id` and `url` derive from `shop.url`, not `request.origin`.** On a
  preview theme or the `*.myshopify.com` host, `request.origin` differs, which
  would mint a second identifier for what is supposed to be one entity.
- **The Organization node deliberately omits `address`, `telephone`, and email,**
  and the snippet doc block says so. This repo is public and the operation is
  home-based. Organization markup is exactly the shape that invites a later
  contributor to "complete" the node with a postal address; the doc block is
  there to stop that.

The node it replaced, in `sections/header.liquid`, rendered on every page and set
`url` to `request.origin | append: page.url`, so every page claimed to be the
Organization's canonical URL.

**No `potentialAction` / `SearchAction` on the WebSite node.** Google deprecated
the sitelinks search box on 2024-10-21 and retired it globally on 2024-11-21. The
WebSite node is kept only as the graph anchor that `publisher` points at, and for
non-Google consumers. Do not add `SearchAction` back expecting a search box.

**The homepage was shipping two `<h1>` elements.** `sections/header.liquid` had an
`index`-guarded visually-hidden `<h1>{{ shop.name }}</h1>`, while the hero lockup
in `templates/index.json` (section `hero_jVaWmY`, block `headline_lockup`) emits a
real `<h1>`. The header one is gone and a comment names where the surviving
heading lives, because nothing in CI checks heading structure and the next person
to look will not otherwise know where the homepage H1 comes from.

**`og:image` was hardcoded to `http:`** in `snippets/meta-tags.liquid`, on both
layouts, while `og:image:secure_url` beside it was already `https:`.

**Theme-level social link settings** now exist, and back the Organization
`sameAs` array. Blank settings are skipped and the array is omitted entirely when
all are blank, so a partially configured store cannot emit a trailing comma. That
matters more than it sounds: a trailing comma invalidates the whole JSON-LD node
and browsers surface no parse error for it.

**There is deliberately no `social_twitter_link` setting, and `twitter:site` is
gone.** This is the one place the settings addition would have changed behaviour
beyond structured data, so it is worth stating plainly. `snippets/meta-tags.liquid`
already read `settings.social_twitter_link` to emit `twitter:site`, against a
setting that had never existed in `settings_schema.json`. Simply defining the
setting would have reactivated that dead branch on every page, and the branch is
broken: it extracts the handle with `split: 'twitter.com/'`, which does not match
an `x.com` URL, so an X profile renders `content="@https://x.com/handle"` instead
of `@handle`. Naming the setting "X (Twitter)" would have invited exactly the URL
that breaks it. Both the setting and the tag are therefore out; a comment in
`meta-tags.liquid` records what a correct restoration needs.

**The `logo` ImageObject carries no `width` / `height`.** Deriving them requires
dividing by `settings.logo.aspect_ratio`, and an SVG can report that as zero or
nil. Liquid renders a divide-by-zero as an error string, which would land inside
the script tag and invalidate the node with no visible symptom. Google does not
require the dimensions, so they are omitted rather than guarded.

The footer's social URLs were placeholders pointing at platform home pages
(`https://www.facebook.com` and the like). Those are broken links for customers,
not only bad `sameAs` data, since a bare platform URL asserts that this
Organization *is* that platform. They now hold the real brand profiles, and the
two platforms with no profile are blank rather than pointing at a home page.

### Why the featured-product guards are a Horizon deviation

`sections/featured-product.liquid` and `sections/featured-product-information.liquid`
now wrap their `{{ section.settings.product | structured_data }}` output in an
`{%- if section.settings.product != blank -%}` guard. With no product selected the
filter renders nothing and the section shipped an empty, unparseable
`application/ld+json` block. Both files are upstream Horizon; keep the guards
through the next upstream merge.

### Out of scope

Product, collection, and page metadata live in Shopify Admin, not in this repo,
and are handled Admin-side: the quarter-zip and women's vest SEO descriptions
(both of which carried the crewneck's text verbatim and called the garment a
"crewneck sweatshirt"), the missing collection meta descriptions, collection body
descriptions, product SEO titles, and the homepage title and description. Reading
this diff as the whole remediation would be a mistake.

Also out of scope and tracked in `TODO.md`: return-policy structured data (blocked
by Shopify's `structured_data` filter not being extensible, not by policy
non-uniformity), `ItemList` markup on collections, and blog content.

> **Superseded.** The return-policy parenthetical above is wrong on the point it
> makes: the policy does vary per product, and that variation is the difficulty
> rather than a non-issue. See "Return policy on the Organization node" at the top
> of this file. `ItemList` shipped; see "ItemList markup on collection pages".

### Accepted risks, recorded so they are not rediscovered as bugs

- **`featured` and `healthcare` hold an identical set of five products** and both
  stay indexable. Their meta descriptions differ, but the product grid does not,
  so canonical selection between them is Google's coin flip. Reviewed and
  accepted rather than merged; revisit after launch with real Search Console data.
  > **Superseded.** This accept no longer stands. See "Collection differentiation
  > is a runbook, not a code change" at the top of this file.
- **The empty `/blogs/news` stays indexable.** A thin-content signal at launch on
  a small indexable surface, accepted deliberately.

## Product consistency pass: long-option dropdown + copy backports (unreleased)

A catalogue-wide audit compared all six products across three sources: Admin API data, the five committed `templates/product.*.json` files, and each rendered storefront page. The page architecture held up (identical block skeleton, identical accordion row order and headings, byte-identical Shipping & Turnaround copy). What it found was copy cloned from the crewneck and never updated for the garment it now describes, plus one layout problem.

### Long option lists now collapse to a dropdown

The Lead II products carry eight Design values, one per credential, and the list is expected to grow. Rendered as full-width buttons it pushed Color, Size, and Add to cart below the fold.

`blocks/variant-picker.liquid` already had a `variant_style` setting with a working `dropdowns` value, and `snippets/variant-main-picker.liquid` already had a complete dropdown branch. Nothing needed building. The blocker was that `variant_style` is a single **block-level** setting applied to every option at once, so switching it would have taken Color and Size with it. The decision had to become per-option.

`settings.variant_dropdown_threshold` (default 4, `0` disables) now collapses any option with at least that many values. The rule is value-count based rather than option-name based so that adding a design or a color needs no settings change.

**The rule has no exceptions, deliberately.** An earlier revision exempted the size option and let swatches take precedence. That was dropped: every option is measured the same way, so a customer never has to learn why Design collapses but Size does not. The override therefore runs last and is not gated on the current `variant_style`.

Two consequences to know before changing the threshold:

- **The size option collapses too**, once it has enough values (`XS`..`2XL` is six). The select branch renders the size-guide link itself, so `#SizeChart` survives the switch.
- **A swatch option past the threshold loses its swatches**, because the select branch renders plain text options and the theme has no swatch-inside-dropdown rendering. Not hit today: no color option has swatches configured, and at the default threshold of 4 a three-color product stays on buttons anyway.

The other half of the change is easy to miss and is what actually makes it render: the loop already computed a per-option `variant_style` local, but **both render branches tested `block_settings.variant_style` directly and ignored it**. Overriding the local alone changed nothing visible. Both conditions now read the per-option value.

Not fixed here, and still latent: `snippets/variant-main-picker.liquid` tests `block_settings.variant_style == 'dropdown'` (singular) against a schema whose only dropdown value is `dropdowns` (plural), so the `swatch_dropdown` style is unreachable dead code.

### Copy backports

Three drifts had been fixed on the two newest products (quarter-zip, vest) and never backported to the three older ones. All three were corrected in `product.lead-ii-crewneck.json`, `product.huddle-crewneck.json`, and `product.shift-fuel-crewneck.json`: the "Have questions **about the something?**" typo, `your shirt's tag` to `your garment's tag`, and a stray double space after "shortcuts.".

### Divergences confirmed intentional, recorded so they are not "fixed" later

The audit flagged these as inconsistencies. Each was reviewed and kept deliberately:

- **Shift Fuel returns.** It is the only product offering 14-day returns rather than final sale, because it carries no Design option and no custom text and is therefore resellable. Two consequences follow and must be preserved: it intentionally has no `return-policy-acknowledgment` block, and it is therefore intentionally the only product showing express checkout. The mechanism is non-obvious: the acknowledgment block hides express checkout with a CSS `:has()` rule in `blocks/return-policy-acknowledgment.liquid` targeting `[ref='acceleratedCheckoutButtonContainer']`, a cross-block dependency on that literal ref. *(Partially superseded by the vacation-mode entry above: the no-return-policy-block decision stands, but the ref now has a second CSS dependent, and while vacation mode is enabled Shift Fuel's express checkout is gated by the vacation checkbox.)*
- **Vest gallery.** The size-chart PNG and the studio logo SVG are intentional gallery media, which is why the vest shows four slides where its siblings show six or eight. They appear on every color because `snippets/product-media-gallery-content.liquid` treats media whose alt text names no color option value as shared.
- **Huddle Design values.** "Nurse" and "Vet Tech" deliberately do not follow Lead II's `ABBREV (Expansion)` form, and Huddle deliberately does not split LVT/RVT/CVT. The option values track what the applique artwork actually reads.

### Out of scope, tracked separately

Product descriptions live in Shopify Admin, not in this repo, so two factual errors the audit found (the quarter-zip and vest descriptions claiming the crewneck's "Premium 8 oz. heavyweight fleece", and all three Lead II descriptions advertising "optional" custom text against a field that is `required: true`) are corrected Admin-side and are not part of this change.

## Asset-rejection detection: a green deploy that changed nothing (unreleased)

### The incident

A homepage redesign never reached its preview theme across three separate CI runs, all of which reported green. The cause was one integer: a JSON template carried a range setting one below the `min` its section schema declared. Shopify validates a JSON template's settings server-side against the section schema **already stored on the theme** and rejects the entire asset when a value is out of range:

```
Asset upload failed for templates/index.json: Setting 'autoplay_speed' can't be less than 3
```

`shopify theme push` retried the upload, gave up, and **exited 0**. The error text was reachable only under `--verbose`, inside the analytics JSON blob under `cmd_theme_errors`. The template stayed frozen on its last version that validated, CI stayed green, and the post-deploy smoke stayed green too, because every probed page still rendered correctly from stale content. On the live path this would have reported a successful deploy, passed smoke, squash-merged, and left the storefront unchanged.

The schema floor itself was a one-line fix. The observability gap is what made a one-integer mistake invisible for three runs, and that is what this change addresses.

### What changed

- **`check-push-rejections.mjs`** (new, with `check-push-rejections.test.mjs` folded into `npm run smoke:test`) audits the push report after every push, live and preview alike. A rejection fails the step with **exit 97**, naming each rejected file and Shopify's reason as `::error file=...::` annotations plus a plain-text summary. A clean push prints nothing, so a good deploy is not made noisy.
- **`deploy.yml`** gains a failure-ladder branch for exit 97 that states plainly that live is **partially** updated: files that validated were written, the rejected ones were not.
- **`capture_push_output`** now takes `--rejections <file>` and appends the summary in full after the 30-line tail, instead of letting it compete for room inside that window. A 20-file rejection runs to roughly 40 lines and would otherwise push its own header out of the PR comment at exactly the moment an operator needs it. It also neutralises any captured line that is exactly the heredoc delimiter, so server-sourced text cannot close the block early and forge step outputs.

### Why the CLI's `--json` payload, not stderr

The detection signal is structured, not scraped. `@shopify/cli` 4.5.2's theme-push service sets, on the object it serialises to stdout, whenever any upload result has `success === false`:

```js
theme.warning = "The theme '<name>' was pushed with errors"
theme.errors  = { "<filename>": ["<reason>", ...] }
```

and then returns normally, which is precisely why the exit code is 0. Asserting on those two fields beats grepping human-readable stderr: it names both the file and the reason, needs no `--verbose`, and is a contract rather than a message format. The auditor treats `warning` present with `errors` absent as a rejection too, so a future CLI that drops one of the two fields degrades to a loud failure rather than a silent pass. An unparseable report is deliberately a distinct code (2) that leaves the existing `require_json` to own that diagnosis as exit 98, rather than being mislabelled a rejection.

### The batch-ordering defect, and why the fix is a retry

A schema change and a JSON template that depends on it fail when pushed in the same batch: the template is validated against the schema version already stored on the theme, not the one in the same upload. Pushing the section first and the template second succeeds; both together fail.

Two fixes were considered. An **explicit two-phase push** (non-JSON files first, then JSON templates) is deterministic and self-documenting, but it hardcodes an ordering rule the CLI does not guarantee and doubles the passes on every deploy, including clean ones. The chosen fix is a **single immediate retry** when a push exits 0 with rejected assets: the schema landed on the first pass, so the template validates on the second, and a value that is genuinely out of range still fails every attempt and stops the deploy. It needs no knowledge of which file types must precede which, and it costs nothing on a clean push. The retry skips the 60s backoff because a rejection is not a transient network condition.

In preview mode the retry is always addressed by **theme ID**, never by repeating `--unpublished`. Repeating the create flag would produce a second `pr-N-preview` theme, which the duplicate-name guard then refuses on every later run for that PR.

### A second defect, found by reproducing the first

The reproduction itself surfaced an unrelated latent bug. A composite step's default shell is `bash --noprofile --norc -e -o pipefail`, and the push step's `set -uo pipefail` does **not** clear that injected `-e`. Every failure path in the step captures an exit code and branches on it, which `-e` pre-empts: the shell exits on the failing command itself, before any capture, retry, or `GITHUB_OUTPUT` write.

The first CI reproduction attempt therefore died in 7 seconds with exit 1 and no captured output at all, instead of reporting what Shopify had refused. The same defect had silently disabled the live 3-attempt retry loop, where a failed first attempt killed the step rather than retrying, and left `push_exit_code` empty, which the caller's failure ladder reads as "step never ran". The step now sets `set +e` explicitly, with a comment saying why it must not be simplified away.

### Verification

Verified against a real rejection in CI, not a simulated one. A deliberately out-of-range `max_products` (99, against the section schema's `max: 16`) was pushed through the real preview workflow on the PR branch. The push exited 0, the audit caught it, the retry fired once and the rejection persisted, and the step failed with exit 97:

```
Shopify rejected 1 asset during theme push. The push command exited 0, but these files were NOT written to the theme.
Setting 'max_products' can't be greater than 16
Rejected assets (theme push exited 0; Shopify refused these files):
  templates/index.json: Setting 'max_products' can't be greater than 16
Push left rejected assets; retrying once against theme <id>
[...retry, same rejection...]
Process completed with exit code 97.
```

Reverting that one value returned both `preview` and `validate` to green, with zero rejection output in the log: the good path is not made noisy.

## Deploy-report messaging: docs-only close message + smoke markdown table (unreleased)

### What changed

The previous smoke-test redesign (below) shipped the `theme_touched` push-skip mechanic; this pass finishes the reporting UX on both branches of that gate.

- **Docs-only PRs** now get an explicit `:page_facing_up: **Docs-only PR.**` headline instead of the more implicit "Live push skipped" phrasing, plus two new rows: the live theme's current name/ID (queried read-only from Shopify) and the last commit actually deployed through this pipeline (read from a new git ref, see below). Both lookups are `continue-on-error`; a Shopify API hiccup can never block a docs-only merge from closing, which was the entire point of the original `theme_touched` gate.
- **`refs/deploy-markers/live`**: a lightweight custom ref (deliberately outside `refs/tags/` so it does not appear on the public repo's Tags page), force-moved to the squash-merge commit SHA whenever a real live deploy succeeds. Guarded by a commit-date comparison, not graph ancestry, before overwriting: squash commits are never ancestors of one another, so `compareCommits` ahead/behind does not hold across squashes, but commit date does. A write that would move the marker backward in time is skipped with a `core.warning` instead of applied.
- **Smoke output as a markdown table.** New pure module `.github/actions/shopify-theme-push/report-format.mjs` (`report-format.test.mjs`, folded into `npm run smoke:test`) parses `smoke.mjs`'s existing plain-text `path verdict status host theme (reason)` lines into a GitHub-rendered table with pass/warn/fail badges, on both the success report and, for a smoke-triggered failure, the failure report. `smoke.mjs` itself is untouched: this is a text-to-structure re-parse of its existing, hygiene-tested output contract, done in a separate file specifically so the parse can evolve without touching that contract's 50+ existing assertions. Both call sites wrap the render in try/catch and fall back to the original raw-fenced-dump on any import or render failure, so a formatting bug can never suppress the report itself (the failure report in particular is the last line of defense on a broken deploy).
- **Live theme ID drift check.** The docs-only "Query live theme" step now also captures the live theme's actual `.id`, not just its name, and the report flags a mismatch against the hardcoded `LIVE_THEME_ID` constant instead of silently pairing freshly-queried data with an unverified assumed ID.

### Post-merge verification and a follow-up fix

Two throwaway PRs (a whitespace-only doc change and a comment-only theme-asset change) were merged through the real `deploy` comment flow to exercise the code the "Known limitation" below flagged as untestable pre-merge. Both deploys succeeded; every mechanic behaved as designed (docs-only headline, ID-drift check with no false positive, marker `createRef` on the first-ever real deploy verified by SHA, smoke table rendered as a real GitHub table with correct pass/warn/fail counts).

One bug surfaced: the live-theme "last updated" field was always empty. Root cause, confirmed by reading the installed `@shopify/cli` package's own theme-object formatter: `theme list --json` returns only `{id, name, processing, createdAtRuntime, role}`; there is no `updated_at` field, and `createdAtRuntime` is a boolean session flag, not a timestamp. The claim was based on a wrong assumption about the CLI's JSON schema, not a transient API gap. Fix: dropped the "last updated" claim from the "Live theme (unchanged)" row entirely (`formatLiveThemeRow` now takes only name + ID); the git-side "Last live deploy" marker row remains the source of temporal information, which it can back with a real, previously-verified commit date. `continue-on-error: true` meant this was cosmetic (`unknown` shown, nothing blocked) rather than a deploy-blocking regression.

### Trust-boundary note

Rendering the smoke table via `report-format.mjs` means both `github-script` steps that build the sticky comment now dynamically `import()` a file living on the checked-out PR branch, inside the same process that holds this job's `contents:write`/`pull-requests:write` token. On the comment-deploy path specifically (which, unlike the shopify-sync and dependabot auto-deploy paths, has no gate blocking a `.github/`-touching diff), this is a real widening from the prior Shopify-token-only exposure. Accepted under this repo's existing documented threat model (a compromised `contents:write` collaborator can already exfiltrate any secret via a malicious workflow change; see CLAUDE.md's Deploy gate trust delta), not a categorically new hole, but called out explicitly here rather than silently, per `/security-review` finding during this change's review.

### Known limitation

`deploy.yml` triggers on `issue_comment` and `workflow_run`. GitHub resolves the *workflow file* for both event types from the default branch, never a PR head, so none of this was end-to-end testable via a real `deploy` comment on a feature branch pre-merge; the automated test suite plus code review were the actual pre-merge gate, and the first real activation was the first `deploy` comment after this merged to `main`.

## Deploy smoke-test redesign: node fetch, catalog-wide, locked-and-public (unreleased)

### Symptom

On PR #56 (docs-only) the live push succeeded but the post-push smoke reported `/ -> 503`, `/cart -> 503`, `/collections/all -> 503` and killed the deploy before squash-merge. It was not the docs change (Shopify ships only the 8 theme directories; `docs/` is never uploaded).

### Root cause (two independent edge layers)

Proven empirically against the live store (`scripts/diagnostics/storefront-probe-node.mjs`):

1. **Cloudflare bot-management** fingerprints the client by JA3/JA4 (TLS ClientHello + HTTP/2) on cacheable content routes (`/`, `/collections/*`, `/search`). `curl`'s fingerprint is blocklisted, yielding a hard `429` (`retry-after: 60`) on every content route, 100% of the time. The old smoke used `curl`, so it never saw a real page; the reported `503`/`429` were edge rejections, not theme errors. node's `fetch` (undici) is not blocklisted. node is not fully immune under a rapid burst (scattered 429s), so the smoke paces and retries on 429.
2. **Password gate** (pre-launch). Independent of the fingerprint. Cleared by an authenticated `_shopify_essential` session (POST the store password to `/password`, carry the whole cookie jar). Authenticated node fetch returns real `200` content while the store is locked; every rendered response carries `server-timing: ... theme;desc="<live-theme-id>"`.

### Fix

`.github/actions/shopify-theme-push/smoke.mjs` (new, zero-dep, `node --test` unit-tested and gated in `validate`) replaces the curl smoke:

- **node fetch**, auto-detects LOCKED vs PUBLIC, authenticates with the optional `STOREFRONT_PASSWORD` secret when locked, paces + retries on 429, and asserts `200` + on-host + `theme;desc == LIVE_THEME_ID`.
- **Catalog-wide.** Structural routes (`/ /cart /collections/all /search`) verify the deploy; every published product is enumerated from the sitemap and probed, so a broken product (including an unresolved template suffix) fails the deploy. No maintained handle list (handles are not in the theme repo).
- **Verdict model.** HARD-FAIL blocks (exit 1); SOFT-WARN (throttle, enumeration skipped, absent/wrong password) proceeds (exit 0) and is surfaced in the report; at least one verified PASS is required to exit 0 so a wholesale 429 wall cannot green a deploy blind. Output is `path verdict status host theme-id` tuples only; the password, cookie jar, and headers are never emitted (the derived session cookie is `::add-mask::`ed).
- **Path-scoped skip.** The `gate` job computes `theme_touched`; the push+smoke step is guarded on it, so a docs/scripts/`.github`-only PR merges and fast-forwards `shopify-sync` without touching live. Permanent fix for the #56 class. Rename-out of a theme dir is caught via `previous_filename`; file-listing errors fail safe to `true` (push).
- **Launch.** Delete `STOREFRONT_PASSWORD` at public launch; auto-detect flips to PUBLIC mode with no code change.

Deferred: Shopify Web Bot Auth (native crawler allowlist) would let even curl through, but its signatures expire within 3 months with no auto-renew; reconsider for post-launch uptime monitoring, not the CI primary.

## CI/CD deploy chain: shopify-sync phantom-orphan force-push via SSH deploy key (unreleased)

PR #21 was the first post-PR-#19 exercise of the auto-deploy chain. It surfaced that the post-merge `Sync main -> shopify-sync` step's phantom-orphan force-with-lease push silently fails on every shopify-sync auto-deploy. The fix swaps that single push from HTTPS+GITHUB_TOKEN to SSH+deploy-key, and folds the step into a new `sync` job to isolate the deploy key from `SHOPIFY_CLI_THEME_TOKEN`. The fast-forward push and the read-only fetch in the same step both stay on HTTPS+GITHUB_TOKEN, since a strict fast-forward to a tip-descendant is not a force push and the `shopify-sync-protection` ruleset's "Block force pushes" rule does not apply.

### Bug and evidence

The `shopify-sync` branch is protected by ruleset `shopify-sync-protection` (ID 16111276) with **Block force pushes** active. The phantom-orphan cleanup arm of the post-merge Sync step force-pushes `shopify-sync` to the deployed SHA (rewriting history to abandon the orphan commits that the just-merged auto-reconcile PR squashed into main). Under HTTPS+GITHUB_TOKEN this push fails with:

```
remote: error: GH013: Repository rule violations found for refs/heads/shopify-sync.
remote: - Cannot force-push to this branch because: Cannot force-push to this branch
```

Empirically confirmed on workflow run 25704994159 (PR #21). The rejection is not transient and not racy; it is structural. The reason it cannot be fixed by adding `Repository role: Admin` to the ruleset's bypass-actors list is that `GITHUB_TOKEN`'s identity `github-actions[bot]` is a synthetic per-workflow identity with no role membership; the GitHub ruleset evaluator's role-based bypass entries (Repository roles, Organization admin) only match identities that hold those roles. Only explicit-actor bypass entries (Deploy keys, Apps, Users) match identities directly.

### Fix

Deploy keys are addable as bypass actors via the ruleset bypass-add modal ("Deploy keys - Role"). A repo-scoped Ed25519 deploy key (`SHOPIFY_SYNC_DEPLOY_KEY` repo secret + matching public key on the deploy-keys page with "Allow write access") is placed on the `shopify-sync-protection` ruleset's bypass list, and the phantom-orphan push switches to SSH using that key.

Workflow structure changes in `deploy.yml`:

- **Sync step extracted into a new `sync` job.** The post-merge Sync moved from being the last step of the `deploy` job to a top-level `sync` job that `needs: deploy`. Rationale: the existing `gate`/`deploy` split establishes "a bug in any step's bash cannot leak a secret because the secret structurally does not exist in this job's scope." Adding `SHOPIFY_SYNC_DEPLOY_KEY` to the `deploy` job would create a defence-in-depth weakness (two secrets in one bash block, exfilable together by a future `set -x` regression). The new `sync` job has `permissions: contents: write` only and zero `SHOPIFY_CLI_THEME_TOKEN` references. The `GH_TOKEN: ${{ github.token }}` binding moves out of the `deploy:` job's env block (no remaining consumer there) and into the new `sync:` job's env (used for the read-only fetch and the fast-forward push, both of which stay on HTTPS).
- **`Validate sync preconditions` step** is a dedicated empty-secret guard in the `sync` job, with no `continue-on-error`. A missing `SHOPIFY_SYNC_DEPLOY_KEY` halts the job visibly red instead of being swallowed by the next step's `continue-on-error: true`. Mirrors `sync.yml`'s `SYNC_RECONCILE_TOKEN` empty-PAT guard in both text and step-failure semantics.
- **SSH setup in the Sync step.** `umask 077` closes the `mktemp` 0600-mode race window across runner profiles; `mktemp -t` produces a templated tempfile path; per-line `::add-mask::` registration of each line of the secret value as defence in depth against a future `set -x` regression (multi-line PEM bodies may not be reliably auto-masked); `tr -d '\r'` line-ending normalisation before writing the key, so a secret pasted with Windows CRLF endings still loads; `unset` of the secret env var after the on-disk write shrinks the shell-env exposure window; `ssh-keyscan -t ed25519,ecdsa github.com` populates known_hosts (RSA omitted because OpenSSH 8+ prefers Ed25519/ECDSA and including RSA only couples the workflow to a future GitHub RSA-key rotation event); `GIT_SSH_COMMAND` is exported with `IdentitiesOnly=yes` + `PreferredAuthentications=publickey` + `BatchMode=yes` + `StrictHostKeyChecking=yes` + `LogLevel=ERROR`; tempfile cleanup `trap` is registered BEFORE `mktemp` runs (with empty-string fallback variables) so a partial-write or ssh-keyscan failure still cleans up.
- **Push call-site changes.** Only the phantom-orphan force-with-lease push switches to SSH. The fast-forward push and the read-only fetch stay on HTTPS+GITHUB_TOKEN. The SSH push URL is derived from `${{ github.repository }}` so an org/repo rename does not silently leave a stale hardcoded URL behind.
- **Multi-pattern stderr classifier.** Push-failure stderr is now run through two grep patterns. `Permission denied (publickey)` / `Load key .*: invalid format` / `Load key .*: bad permissions` / `Host key verification failed` re-emits a "SHOPIFY_SYNC_DEPLOY_KEY appears invalid" hint. `GH013` / `Cannot force-push to this branch` (the bypass-row-removed case) re-emits a "Push rejected by branch ruleset" hint. The raw stderr line still prints either way.

### Alternatives considered

- **Expand bypass to a PAT.** Rejected. Couples bypass authority to the operator's admin status; trust regression spreads to the PAT-create surface.
- **`actions/create-github-app-token` with a minimal install-only app.** Rejected. The short-lived-token and granular-permission properties are real, but the PEM rotation has the same operator-account-coupling problem as a PAT, and setup cost is still strictly larger than a deploy key for a solo-dev repo.
- **Switch to a long-lived custom GitHub App.** Rejected. Over-engineered for a single solo-dev bypass use case.
- **Disable the "Block force pushes" rule.** Rejected. The rule also blocks accidental admin-side rewrites of `shopify-sync`; the operator wants to keep the protection on.
- **Replace force-push with a `--strategy=ours` merge-commit reconcile (no bypass needed).** Rejected. Produces a tangled `shopify-sync` history of merge commits; merge-commit author is `github-actions[bot]` not `shopify[bot]`, complicating any future identity-based assertion downstream.
- **Accept silent failure; rely on `sync.yml`'s reconcile flow and daily cron to clean up.** Rejected. Partially defensible (the post-PR-#18 hardening blocks the latent-bug incident class), but a chain that silently fails on every deploy is hard to monitor and accumulates drift between admin-edit cycles.

### Trust delta

The deploy-key credential has full repo push capability across all refs (deploy keys are repo-scoped by GitHub design). Its **bypass effect** on the `shopify-sync-protection` ruleset is scoped to that one ruleset's "Deploy keys" bypass-actor row; the row must NOT be added to any ruleset protecting `main` or any other branch. Bypass authority is decoupled from any human role membership. The four computed auto-deploy gates (collaborator-permission, validate-on-HEAD-SHA, signed-commit, defence-in-depth merge-base assertion) remain the actual integrity boundary on what content auto-deploys; the SSH push only changes *transport* for an already-validated payload. A compromised collaborator with `contents: write` could exfiltrate the deploy key via a workflow change and force-push `shopify-sync` content, but this is bounded by the same all-bets-are-off threshold the existing trust model already accepts. The new `sync` job has no `SHOPIFY_CLI_THEME_TOKEN` in scope, so the deploy-key surface and the Shopify-token surface are isolated by job boundary.

### Operator action (post-merge)

None for the chain itself. The next admin commit on the unpublished sync theme will auto-exercise the new path. Three one-time tasks accompany this change (operator handles in parallel with the PR):

1. Generate the keypair locally, add the public key to `/settings/keys` with "Allow write access", store the private key in repo secret `SHOPIFY_SYNC_DEPLOY_KEY`, add a `Deploy keys` bypass-actor row to ruleset `shopify-sync-protection` (ID 16111276), securely delete the local key files. (See CLAUDE.md "Token rotation call-site catalog" entry for the full procedure.)
2. Bring `shopify-sync` to byte-for-byte parity with `main`, since PR #21's failed Sync left it in a 1-ahead/1-behind state. The recovery snippet uses operator admin bypass (independent of the new deploy-key bypass):

   ```bash
   git fetch origin
   MAIN_SHA=$(git rev-parse origin/main)
   LEASE_SHA=$(git rev-parse origin/shopify-sync)
   if [ "$LEASE_SHA" = "$MAIN_SHA" ]; then
     echo "Already in sync; nothing to do."
     exit 0
   fi
   git push --force-with-lease=shopify-sync:"$LEASE_SHA" origin "$MAIN_SHA":shopify-sync
   git fetch origin shopify-sync
   [ "$(git rev-parse origin/shopify-sync)" = "$MAIN_SHA" ] || { echo "MISMATCH"; exit 1; }
   ```
3. After the chain is exercised once successfully, `gh api /repos/Perts-Foundry/sapphire-shadow-studio-theme/compare/shopify-sync...main --jq '{status, ahead_by, behind_by}'` returns `{"status":"identical","ahead_by":0,"behind_by":0}`.

If this change is ever reverted: also remove the public key from `/settings/keys` and remove the bypass-actor row from `shopify-sync-protection` to avoid orphaned authority.

## CI/CD deploy chain: sync.yml PAT switch and latent main-has-advanced hardening (unreleased)

PR #17 was the first end-to-end exercise of the consolidated `deploy.yml`'s shopify-sync auto-deploy path. It surfaced a real and previously unobserved bug: `sync.yml`'s `gh pr create` runs under `GITHUB_TOKEN`, and GitHub's documented automatic-token rule (https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication) suppresses downstream workflow_run events from GITHUB_TOKEN-driven actions. validate.yml never fired on the auto-reconcile PR. The fix is a fine-grained PAT scoped narrowly; this PR also folds in a latent-bug discovery and matching two-layer hardening.

### Bug A: validate.yml never fires on auto-reconcile PRs

`sync.yml`'s "Open or refresh reconcile PR" step calls `gh pr create` under the job-level `GH_TOKEN: ${{ github.token }}`. Per GitHub's documented automatic-token rule, events triggered by GITHUB_TOKEN do not cascade into downstream workflow runs. The PR opens silently, no `pull_request:opened` event reaches the events bus, validate.yml is not triggered, and the shopify-sync auto-deploy chain stalls. Empirically confirmed on PR #17: the PR was opened by sync.yml at 2026-05-11 20:41:50Z; the only Validate run on shopify-sync (databaseId 25697345816) was created at 2026-05-11 21:06:18Z, ~25 minutes later, as a result of a manual close+reopen via personal gh credentials.

**FIXED**: introduced a new fine-grained PAT (`SYNC_RECONCILE_TOKEN`, resource owner `Perts-Foundry` org, scoped to `pull_requests: write` + `contents: read` + `metadata: read` on this single repo). sync.yml's `gh pr create` runs under the PAT via an inline `GH_TOKEN="$SYNC_RECONCILE_TOKEN"` override; every other call site stays on GITHUB_TOKEN. `gh pr edit` deliberately keeps GITHUB_TOKEN because `pull_request:edited` is not in validate.yml's trigger set (suppression is harmless there), to minimise PAT-attributed audit-log volume, and to preserve a clean `github-actions[bot]` timeline so any human-attributed action on the PR is a genuine investigation signal. deploy.yml's `pulls.merge` and the post-merge Sync step's git push also stay on GITHUB_TOKEN: the suppression of the merge-commit push to main is intentional (re-running validate against main on every deploy would loop), and the shopify-sync fast-forward push uses HTTP Basic with GITHUB_TOKEN by design.

The PAT call site is wrapped in two fail-closed guards: an empty-PAT check that fires a clear `::error::` if the secret is unset, and a stderr-capture wrapper around `gh pr create` that re-emits a "PAT appears invalid" hint when the gh CLI returns 401/403/404 (revoked, expired, or scope-mismatched). Both surface explicit pointers to CLAUDE.md's "Token rotation call-site catalog."

### Bug A.1: downstream PR-opener gate now expects the PAT-owner identity

After the PAT switch, `pr.user.login` on the auto-reconcile PR is the PAT owner's GitHub account, not `github-actions[bot]`. deploy.yml's shopify-sync gate previously hardcoded `expectedPrBot = 'github-actions[bot]'`. Without a corresponding update, every PAT-opened reconcile PR would pass Validate, then fail the PR-opener-identity gate and post a sticky "Auto-deploy skipped" with a misleading reason.

**FIXED**: renamed `expectedPrBot` to `expectedPrOpener`, source value from a new `vars.EXPECTED_SYNC_PR_OPENER` repository variable (plaintext is fine: the login is already public surface). Added EXPECTED_SYNC_PR_OPENER to the step's env block. Added a JS-side empty guard that fails closed via postSkip if the variable is unset. Preserved the `pr.user?.login` optional chaining and added a comment so a future maintainer doesn't "fix" it to non-optional access (deleted-account responses can produce undefined; the comparison fails closed against that).

### Trust-model regression with mitigation chain

The PR-opener gate's expected value moves from a GitHub-Actions runtime identity (`github-actions[bot]`, essentially unimpersonable from outside a workflow execution context) to a human GitHub login (PAT-exfiltrable). The new attack surface and the mitigations:

1. **Attack:** PAT exfiltration enables hand-opening a `shopify-sync → main` PR with a stale-but-signed `shopify[bot]` HEAD (replay an old `shopify[bot]` commit as a fresh deploy).
2. **Block 1, commit-identity gate (unchanged):** the HEAD commit must be `author=shopify[bot]` AND `verification.verified`. An attacker can only PR commits `shopify[bot]` genuinely authored at some point in history; no novel content injection is possible.
3. **Block 2, defence-in-depth merge-base assertion (NEW, this PR):** `repos.compareCommits(base: main, head: pr.head.sha).behind_by === 0`. A stale `shopify[bot]` commit that predates a subsequent main-tip advance is missing main commits, and the gate skips. Catches the replay attack.
4. **Residual surface:** "hand-open a PR with a current-base `shopify[bot]` commit." Damage is bounded to "auto-deploy ships content `shopify[bot]` genuinely authored, in the same tree-state `shopify[bot]` would naturally produce." Much smaller than "ship arbitrary content."

The all-bets-are-off threshold around `contents: write` collaborator-bypass is unchanged from the existing trust model: a collaborator who can land any PR could already exfiltrate any secret via a malicious workflow change, so the new PAT does not extend that surface.

### Bug B: latent main-has-advanced bug (discovered during this work, hardened in same PR)

After PR #17 squash-merged at 2026-05-11 21:08:42Z, shopify-sync entered phantom-orphan state (1 commit ahead, DIFF_LOC=0). PR #18 (CLAUDE.md consolidation) then landed on main on 2026-05-11. shopify-sync became 1 ahead, 2 behind, DIFF_LOC=375, no longer pure phantom-orphan. sync.yml's existing "Determine sync status" step only short-circuits on the DIFF_LOC=0 case, so the next sync run (cron, admin push, or manual dispatch) would create a reconcile PR whose diff proposes to **revert PR #18's docs changes** (CLAUDE.md and `docs/accessibility-patterns.md`). With the GITHUB_TOKEN status quo, validate.yml wouldn't fire on that PR (harm contained, humans review). With the PAT fix landing, validate.yml DOES fire, the PR could flow through the workflow_run auto-deploy arm, and both the PR-opener gate (PAT-opened) and the commit-identity gate (HEAD commit is real `shopify[bot]`) would pass. The auto-deploy could ship the reverse-application to live.

The PAT fix unmasked this latent bug. Two layers of defence land in this same PR:

**FIXED** (sync.yml prevention guard): added a merge-base check at the top of the "Open or refresh reconcile PR" step's `run:` block, before the PR-create or PR-edit action. The check asserts `git merge-base origin/main HEAD == origin/main`. If not, the workflow fails red with an `::error::` annotation that includes the manual-recovery snippet (force-push main onto shopify-sync). Placement is inside the step, NOT before the LOC fork in "Determine sync status"; this avoids false-firing on the legitimate phantom-orphan post-deploy state (where `AHEAD > 0` AND `DIFF_LOC == 0` AND main has advanced past shopify-sync's merge-base via the squash). The step's existing `if:` condition (`loc != '0'`) already excludes that state from this step.

**FIXED** (deploy.yml defence-in-depth): added a `repos.compareCommits(base: main.commit.sha, head: trustedSha)` call to the shopify-sync gate, after the existing base-staleness check. Asserts `behind_by === 0`. The existing base-staleness check (`main.commit.sha !== pr.base.sha`) only catches "main advanced after the PR was created"; it does NOT catch "PR head was missing main commits at PR creation time." The new assertion catches that case AND the PAT-exfil hand-opened-stale-PR attack from the trust-delta chain above. Defence in depth: even if sync.yml's prevention guard is bypassed (hand-opened PR via PAT exfil), the deploy-side gate still skips.

### Doc-drift fix folded in (zizmor.yml mitigation comment)

`.github/zizmor.yml`'s `dangerous-triggers` ignore-list comment listed "auto-reconcile label present, manual-review label absent" as shopify-sync mitigations. Both labels were replaced by the draft-PR escape hatch in an earlier PR; the comment had drifted. Refreshed the shopify-sync mitigation bullet list to reflect the actual current gates (draft-PR check, no-protected-paths-in-diff, <1000 LOC, base-staleness, new merge-base assertion) and the renamed PR-opener gate sourcing from `vars.EXPECTED_SYNC_PR_OPENER`.

### Operator action (post-merge)

Run a one-time force-push to bring shopify-sync to byte-for-byte parity with main, absorbing PR #18 and discarding the orphan `9b003ae`:

```bash
git fetch origin
MAIN_SHA=$(git rev-parse origin/main)
LEASE_SHA=$(git rev-parse origin/shopify-sync)
if [ "$LEASE_SHA" = "$MAIN_SHA" ]; then
  echo "Already in sync; nothing to do."
  exit 0
fi
git push --force-with-lease=shopify-sync:"$LEASE_SHA" origin "$MAIN_SHA":shopify-sync
git fetch origin shopify-sync
[ "$(git rev-parse origin/shopify-sync)" = "$MAIN_SHA" ] || { echo "MISMATCH"; exit 1; }
```

If `--force-with-lease` aborts (a `shopify[bot]` commit landed between fetch and push), re-run from `git fetch`. After the push, `gh api /repos/Perts-Foundry/sapphire-shadow-studio-theme/compare/shopify-sync...main` returns `identical / 0 / 0` and GitHub's branch view shows shopify-sync at parity with main. The new sync.yml and deploy.yml guards protect the recovered state.

### Comment-deploy escape hatch unaffected

The `Auto-deploy gates - shopify-sync` step that hosts the renamed PR-opener gate only runs on the `workflow_run` trigger path. The `issue_comment` (manual `deploy` comment) trigger uses a separate collaborator-permission check on `comment.user.login` and never asserts `pr.user.login`. A `deploy` comment on an auto-reconcile PR (now opened by the PAT-owner identity instead of `github-actions[bot]`) ships normally.

### Dependabot path: PR-opener identity unchanged, parallel merge-base assertion added

The dependabot/** arm of deploy.yml's gate continues to expect `pr.user.login === dependabot[bot]`. Dependabot opens PRs under its own bot identity via GitHub's native Dependabot service, not via a PAT, so the GITHUB_TOKEN-suppression rule does not apply (Dependabot's pushes already fire workflow events). No PAT is needed for that path; no PR-opener identity change.

The defence-in-depth `repos.compareCommits(base: main, head: trustedSha).behind_by === 0` assertion is also added to the dependabot gate, mirroring the shopify-sync addition. In Dependabot's normal flow this is a no-op: Dependabot rebases its own PRs on every push and updates `pr.base.sha`, so the existing base-staleness check is sufficient and the new assertion always passes. The assertion lands as belt-and-braces against a hypothetical future Dependabot behaviour change where a PR could carry a current `pr.base` but a head SHA missing main commits (e.g. partial-rebase race). Symmetric trust model across both auto-deploy arms.

## CI/CD deploy chain: Dependabot auto-deploy gate fixes (unreleased)

PR #2 (Dependabot `actions/github-script` v8 → v9, open since 2026-05-03) was the first auto-deploy attempt against the post-PR-13 chain. It exposed two bugs in the Dependabot auto-deploy path that the earlier audit missed, plus one latent issue that was masked by the first bug.

### Bug A: `dependabot/fetch-metadata@v3.1.0` does not support `workflow_run` triggers

PR #13 integrated `dependabot/fetch-metadata@v3.1.0` as a new gate step to read the per-dep `update-type` from Dependabot's structured commit trailers. The action's README mentioned `workflow_run` as a viable parent trigger; in practice the action requires the `pull_request` event payload to live in its own job's context, which a `workflow_run`-triggered job does not have. Every Dependabot auto-deploy attempt now hard-failed with:

```
::warning::Event payload missing `pull_request` key. Make sure you're triggering this action on the `pull_request` or `pull_request_target` events.
::error::PR is not from Dependabot, nothing to do.
```

The whole Dependabot auto-deploy path was blocked before reaching the bot-identity gate, the major-version gate, or any deploy step.

**FIXED**: removed the `Fetch Dependabot metadata` step entirely. Replaced with inline commit-trailer parsing inside the existing `Auto-deploy gates - dependabot` github-script step: iterate `pulls.listCommits`, parse each commit message for `update-type: version-update:semver-{major,minor,patch,prerelease}` trailers (Dependabot's documented structured-commit format), classify the bump severity from the parsed values. Same logical behaviour as `fetch-metadata`, no action dependency, no event-payload requirement. The prose-regex secondary parse and the fail-closed "no parseable signal" branch are preserved.

### Bug B: bot-identity gate rejected legitimate `web-flow` committer

Both auto-deploy bot-identity gates (shopify-sync and dependabot arms) asserted `commit.committer.login === expectedBot` with strict equality. When a bot-authored commit is rebased through GitHub's web-flow (which happens on every `@dependabot rebase`, `@dependabot recreate`, and GitHub's automatic "update branch" rebase), the resulting commit has `author.login === bot` but `committer.login === 'web-flow'`. PR #2's head commit was exactly this state: `author=dependabot[bot]`, `committer=web-flow`, `verified=true`.

Pre-PR-13 stickies on PR #2 (2026-05-10 22:39 and 2026-05-11 00:18) had already reported the false positive: "Bot-identity gate failed (verified=true, author=dependabot[bot], committer=web-flow, pr.user=dependabot[bot]; expected dependabot[bot])." After PR #13, the failure was masked by Bug A (the fetch-metadata step crashed first); without this fix it would resurface on the next deploy attempt.

**FIXED**: both gates now allow `committer.login` to be either the expected bot OR `web-flow`. `web-flow` is a GitHub-system identity controlled by GitHub itself; no external actor can impersonate it. The author and PR-opener integrity assertions are unchanged.

### Trust-model impact

The signed-commit gate's integrity property is unchanged: the assertion is still that a verified bot AUTHORED every commit. The committer field was already documented as defence-in-depth (the README explicitly stated "Git commit headers are not consulted; those are forgeable"). Relaxing the committer to {expectedBot, web-flow} accepts a GitHub-controlled identity in addition to the bot, preserving the no-external-impersonation property.

CLAUDE.md "Deploy gate trust delta" section and "Admin-side edits" section both updated to reflect the relaxed committer-identity rule.

### Operator action

None. PR #2 can now be re-auto-deployed by triggering a new Validate cycle on its HEAD (any commit push, or `@dependabot recreate`); the chain will now run the bot-identity gate (passes with `committer=web-flow`), then the major-version gate (detects the major bump via the inline trailer parse and postSkips with "Major-version bump(s) detected"). After review, comment `deploy` to ship.

## CI/CD deploy chain: sync auth + audit-driven hardening (unreleased)

PR #11's test deploy was the first to actually exercise the consolidated `deploy.yml`'s `Sync main -> shopify-sync` post-merge step under realistic conditions. It surfaced three immediate bugs (sync push could never have worked; failure annotation misattributed the cause; deploy report rendered the success icon next to failure text) and prompted a full-chain audit that turned up another fourteen findings ranging from latent gate-bypass risks to documentation drift. All seventeen are folded into this one PR.

### The three bugs that started the audit

- **FIXED** `Sync main -> shopify-sync` push auth. Both push commands (the fast-forward and the `--force-with-lease` phantom-orphan reset) switched from `AUTHORIZATION: bearer $GH_TOKEN` to HTTP Basic auth with `x-access-token` as the username (`AUTHORIZATION: basic <base64('x-access-token:'+token)>`). GitHub's git-over-HTTPS smart server silently ignores the Bearer scheme on git endpoints; git then falls back to credential prompting and exits with `fatal: could not read Username for 'https://github.com': No such device or address`. The Bearer form was inherited from the prior `sync-reconcile.yml` fast-forward arm and never executed in production there because GITHUB_TOKEN-driven pushes do not retrigger workflows, so the bug was latent until the consolidated `deploy.yml` ran the push synchronously inside the deploy job. The `AUTH_HEADER` value is computed once at the top of the step so the two push call-sites stay in lockstep.
- **FIXED** the `::warning::` annotation message in both failed-push branches. The prior text was `Fast-forward push failed (likely raced an admin commit): <err>`, which pre-classified every push failure as a race condition. Auth failures, network blips, and rate-limit hits all surface the same way; the operator needs the raw `$PUSH_ERR` to triage. The annotation is now `Fast-forward push failed: <err>` (and `Phantom cleanup push failed: <err>` for the other arm). The `sync-status` marker was also renamed from `race;` to `push failed;` so the report-comment body reflects the underlying state without prejudging the cause.
- **FIXED** the deploy-report sync-line icon. The `Post deploy report` step previously chose between the success and warning icons based on `steps.sync.outcome === 'success'`, which is always `'success'` because the Sync step's bash explicitly handles errors with `if PUSH_ERR=...; then ... else ... fi` and exits 0 in every branch. The report now inspects the `sync-status` output content: `push failed` or `deferred` prefixes route to the warning icon and wording, anything else routes to success. `syncOutcome === 'success'` is also still consulted as a defence-in-depth signal in case the bash exits non-zero before any status is written. PR #11's report rendered the success icon paired with failure text; the new logic produces `:warning: **shopify-sync sync warning:** push failed; ...`.

### Latent-bug fixes folded in from the audit

- **HARDENED** Dependabot major-version detection (C3). The gate's only safety net against an auto-deployed major bump was a regex over the PR title and body. Grouped-update PRs use non-parseable titles ("bump the github-actions group with N updates") and the regex's-only signal is the per-dep "Updates `X` from A to B" lines in the body; any future change to that template would silently let a major bump auto-deploy. The gate now (1) runs `dependabot/fetch-metadata@v3.1.0` as a step before the dependabot gate and reads its `update-type` output as the primary signal, (2) keeps the regex as belt-and-braces in case the action returns no metadata, and (3) fails closed when BOTH signals come up empty on a Dependabot PR (the bot-identity gate already confirmed Dependabot authorship, so an unparseable PR is an unknown-severity bump that gets routed to manual review).
- **PAGINATED** the deploy chain's sticky-comment finders (C1). Five upsert helpers (gate's `upsertSticky`, both auto-deploy-gate `upsertSticky` closures, `Post deploy report`, and `Report failure`) used a bare `listComments({ per_page: 100 })` lookup with no pagination. On a PR with >100 comments (an auto-reconcile PR accumulating daily-cron stale notices, a long-lived discussion thread) the existing sticky lives past page 1, the finder returns empty, and the upsert posts a duplicate. The duplicate-sweeper at the end of each helper only sees the truncated page so the legacy sticky persists. All five helpers now use `github.paginate(github.rest.issues.listComments, ...)`.
- **MASKED** the base64-wrapped Shopify auth header (C2). `AUTH_B64=$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w 0)` produces a literal Actions has not been told to mask. The bare `$GH_TOKEN` is auto-masked, the base64 form is not. A future `set -x`, debug `echo`, or git error message containing the assembled `http.extraheader` would print the token in base64-plaintext-equivalent form. Added `echo "::add-mask::$AUTH_B64"` immediately after the assignment.
- **FIXED** the `compareCommits` documentation in both `deploy.yml` and `CLAUDE.md` (C4 + N2). The inline comment and the CLAUDE.md "Deploy gate trust delta" section both described `compareCommits.status === 'identical'` as tree-equivalence ("catches force-pushes to the same tree as benign and different trees as suspicious"). GitHub's `compareCommits` actually compares commit objects, not trees: a same-tree amend / cherry-pick / different-tree force-push all return `diverged`, not `identical`. So `compareCommits.status === 'identical'` is functionally redundant with the `pr.head.sha === trustedSha` equality check above it. The actual security posture is *stronger* than the description claimed; the docs now describe what the check actually does (defence in depth on top of SHA equality) so a future refactor doesn't "simplify" away a load-bearing check on a wrong premise.
- **AUTHED** the `git fetch` in the Sync step (S1). The fetch was anonymous because the repo is public; if the repo is ever flipped to private, the unauthed fetch fails with the same `could not read Username` error the Bearer push used to produce. Threading `$AUTH_HEADER` into the fetch costs nothing on the public-repo path and immunises against repo-visibility changes.
- **TIGHTENED** the comment-deploy Validate lookup (S2). `listWorkflowRuns({ workflow_id: 'validate.yml', head_sha })` would accept a Validate run from any triggering event. `validate.yml` is `pull_request`-only today, but adding an `event: 'pull_request'` filter blocks a future push / workflow_dispatch trigger on validate.yml from masquerading as proof for a comment-deploy.
- **SKIPPED** preview cleanup and preview-sticky updates for Dependabot auto-deploys (S4). `preview.yml::deploy-preview` is conditionally skipped for Dependabot PRs (no Shopify token in the Dependabot secrets scope), so there is never a `pr-N-preview` theme to delete and never a `<!-- preview -->` sticky to update. Both downstream steps now check `needs.gate.outputs.trigger_path != 'dependabot'`, removing the misleading `:broom: Preview cleanup: no preview theme found.` line from every Dependabot deploy report.
- **DEFENSIVE** explicit-destination refspec on the Sync step's fetch (S5). `git fetch --prune --no-tags origin "$DEPLOYED_SHA" shopify-sync` could miss force-push updates to `origin/shopify-sync` in the local clone. Switched to `+refs/heads/shopify-sync:refs/remotes/origin/shopify-sync` so the lease-SHA used by `--force-with-lease` reflects the true current tip.
- **TIGHTENED** Dependabot `pulls.list` page size (S6). `per_page: 5` to `per_page: 1`. GitHub guarantees (state, head) uniqueness for open PRs; the explicit `1` makes the assumption visible.
- **ASSERTED** non-empty `deployedSha` after `pulls.merge` (S7). The squash-merge API response is documented to return the new merge-commit SHA in the `sha` field, but a future response-shape change could silently produce an empty refspec for the Sync step (`git push origin :shopify-sync` would DELETE the branch). A defensive `if (!deployedSha)` check now sets `merged = false` with an explicit error message.
- **STRENGTHENED** the HEAD-drifted-post-deploy report copy (S8). When `merged === false` and `mergeError` matches `HEAD drifted post-deploy`, the deploy report now renders a louder `:rotating_light:` notice explicitly warning the operator not to reflexively click Merge in the GitHub UI; the live theme is on the deployed SHA, but the PR head has moved since deploy, so a manual merge would land different commits than what's on the storefront.
- **ADDED** `actions: read` to the deploy job permissions (S9). Forward-compat; any future deploy step that calls `listWorkflowRuns` / `getWorkflowRun` (e.g. to surface the Validate run id in the report) needs the grant. Harmless when unused.
- **SWITCHED** the sync-success icon from `:arrows_clockwise:` to `:white_check_mark:` (N3). Cosmetic: matches the report header's vocabulary and removes the "in-progress" ambiguity.
- **UPSERTED** the stale-reconcile-PR sticky in `sync.yml` (N4). The prior `gh pr comment` form appended a fresh comment on every cron firing; a PR open for a week accumulated seven identical "stale" notices. Tagged with `<!-- stale-reconcile -->` and now upserted via the GitHub API.

### Operator action

None. `shopify-sync` is currently 6 commits behind `main` (PRs #6, #7, #8, #9, #10, #11, #12 all merged after the last successful sync). The next admin commit on the unpublished sync theme will reopen the auto-reconcile PR; Validate will pass on its branch; and the auto-deploy arm will now successfully fast-forward `shopify-sync` to the deployed SHA in its post-merge step. Manual recovery remains available but is not necessary: a local `git push --force-with-lease=shopify-sync:<expected-sha> origin main:shopify-sync` from a workstation with push access would close the drift immediately.

### Deploy chain reorder: merge is the final user-visible action

PR #11's deploy report demonstrated that the prior step order ran the squash-merge BEFORE the deploy-report sticky, preview-deletion sticky update, and rocket reaction. The PR closed first; comments and emojis landed afterward on a closed PR. This entry inverts that order so the squash-merge is the last user-visible event of the chain.

New step order in the `deploy` job:

1. Live theme push
2. Delete preview theme (gated on push success, not merge success)
3. Update preview comment ("Preview theme deleted; live theme is serving this commit; squash-merge to follow")
4. React with rocket
5. Post deploy report (push + smoke + cleanup status; no merge or sync status, since neither has run yet)
6. **Squash merge** (the final user-visible event; PR closes here)
7. Sync main -> shopify-sync (post-merge; not surfaced in PR timeline; warnings via `::warning::` workflow annotations only)
8. React with -1 (failure)
9. Report failure (failure; overwrites pre-merge sticky with merge-specific error copy, including a `:rotating_light:` warning for the HEAD-drifted-post-deploy case)

Key behaviour changes:

- **Deploy report posts once, before merge, without merge or sync status.** The PR's GitHub-rendered "Merged" badge becomes the merge confirmation when the merge step closes the PR. Sync status is observable only via the workflow log; `sync.yml`'s daily cron + admin-push retrigger are the self-heal.
- **Merge failure now calls `core.setFailed`.** Previously the merge step swallowed errors and the job stayed green even on a failed merge, leaving the deploy-report sticky claiming "Deployed successfully" next to an unmerged PR. Now a merge failure trips the job's failure mode, the `Report failure` step fires, and it overwrites the pre-merge sticky with merge-specific error copy.
- **Preview cleanup gated on live push success, not merge success.** Live serving the new code makes the preview obsolete regardless of whether the merge has happened yet. Accepted trade-off: a runner crash between cleanup and merge leaves "live deployed + PR open + preview gone"; live is already serving the new code so the preview's verification value is moot at that point.

### Audit findings deferred or accepted as-is

- **S3** (`deferred` sync status routing): kept routed to the warning path per the original-instruction routing. `deferred` means `shopify-sync` was NOT advanced by this deploy because an admin commit landed mid-flight; the operator should see a visible signal even though `sync.yml` will reconcile on the next admin push. Now surfaces as a `::warning::` workflow annotation rather than a deploy-report comment line (the report is posted before sync runs in the new order, so it no longer carries sync status).
- **N1** (`core.warning` + silent skip in the unexpected-head_branch branch of `gate.resolve`): kept as-is per CLAUDE.md's documented "workflow filter is the real gate; this is belt-and-braces" intent.
- **N5** (release-notes content review for sensitive content per CLAUDE.md "Sensitive Content" rules): self-reviewed; no personal email, machine paths, sub-state location detail, or tokens.

## CI/CD deploy chain consolidation (unreleased)

Three near-identical deploy workflows (`deploy.yml`, `shopify-sync-auto-deploy.yml`, `dependabot-auto-deploy.yml`) collapse into a single `deploy.yml` with three trigger paths. `sync-reconcile.yml` becomes `sync.yml`, single-direction only. `setup-labels.yml` deleted; the deploy chain no longer gates on labels. Net: 4 workflow files (was 8), ~700 lines of YAML deleted, all three automation paths preserved.

Root cause for the consolidation: the three deploy workflows shared one live-push + smoke-test + squash-merge + delete-preview ladder; they differed only in their gate logic (collaborator-permission vs signed-commit + diff-sanity + label gates). Maintaining three copies of the ladder triples the change-failure surface, and the bidirectional dance in `sync-reconcile.yml` (a `push: main` fast-forward arm plus a `push: shopify-sync` reconcile-PR arm) existed only because the cross-workflow chain after a deploy-driven squash-merge does not fire (GitHub Actions suppresses `push` events triggered by `GITHUB_TOKEN` to prevent infinite loops). PR #7's `push: main` fast-forward arm was dead on arrival for the same reason; the cron was the only mechanism keeping `shopify-sync` in sync, and it failed for six days when an orphan bot commit met a moving `main`.

What changed:

- **MOVED** all three deploy paths into `deploy.yml`. Single workflow file, two-job structure:
  - `gate` runs without `SHOPIFY_CLI_THEME_TOKEN` in scope, with `permissions: { contents: read, pull-requests: write, actions: read, checks: read }`. Resolves trigger context (`comment` | `shopify-sync` | `dependabot`), looks up the PR, re-verifies Validate on the trusted HEAD SHA, then runs trigger-conditional gates (collaborator-permission for `comment`; signed-commit + diff-sanity + label gates for the two `workflow_run` paths). Posts a sticky pre-deploy rejection comment under the unified `<!-- deploy-result -->` marker if any gate fails.
  - `deploy` runs `needs: gate`, with `permissions: { contents: write, pull-requests: write }` and `concurrency: deploy-production`. Pushes to live, squash-merges, deletes the preview theme, runs the new `Sync main -> shopify-sync` post-merge step, and posts the deploy report. The `SHOPIFY_CLI_THEME_TOKEN` enters scope only here; a bug in any gate `if:` cannot leak it because the gate job structurally does not have the secret.
- **NEW** `Sync main -> shopify-sync` post-merge step in `deploy.yml`. Replaces the dead `push: main` fast-forward arm. Anchored on the deployed SHA returned by the squash-merge response (not `origin/main` re-resolved later) so the inline sync is tied to what just went live. Three branches:
  - Fast-forward push when `shopify-sync` is reachable from the deployed SHA.
  - `--force-with-lease=shopify-sync:<expected-sha>` reset when `shopify-sync` is ahead but trees are identical (post-auto-deploy phantom-orphan state). Lease catches admin commits racing the push; on rejection, `sync.yml`'s next firing on the admin push refreshes the reconcile PR.
  - Defer to `sync.yml` when `shopify-sync` has real divergence (admin commit landed mid-deploy).
- **RENAMED** `sync-reconcile.yml` to `sync.yml` and shrunk from ~180 lines to ~50. Single direction: on admin commits to `shopify-sync`, open or refresh the auto-reconcile PR. Phantom-orphan detection (DIFF_LOC=0) skips PR creation; deploy.yml handles cleanup. Stale-PR alarm preserved.
- **DELETED** `.github/workflows/shopify-sync-auto-deploy.yml`, `.github/workflows/dependabot-auto-deploy.yml`, and `.github/workflows/setup-labels.yml`. The two auto-deploy files' logic is now `deploy.yml`'s trigger-conditional gate steps. The setup-labels file is gone because the deploy chain no longer uses any labels (see "Label-free deploy gating" below).
- **WORKFLOW-LEVEL `if:`** rejects two failure classes before any runner starts: (a) `issue_comment` events that are not on a PR (the `deploy` body alone on a plain issue would otherwise dispatch a runner) and (b) `workflow_run` events from `validate.yml`'s `push:` triggers (would otherwise spawn an empty deploy attempt on every admin push).
- **DYNAMIC `run-name`** distinguishes the three trigger paths in the Actions tab so the operator can triage at a glance without opening the run.
- **UNIFIED STICKY MARKER** `<!-- deploy-result -->` replaces the per-workflow markers (`<!-- shopify-sync-auto-deploy -->`, `<!-- dependabot-auto-deploy -->`). One sticky comment per PR carries deploy / failure reports across all three trigger paths.
- **UPDATED** `.github/zizmor.yml`: `dangerous-triggers.ignore` now lists `deploy.yml` with an inline rationale block; the two deleted workflows are gone.
- **UPDATED** `CLAUDE.md` "Deploy gate trust delta", "Admin-side edits", "Live theme", "Token rotation call-site catalog", and "Pre-PR review" sections; `README.md` workflows table.

Trust-model implications: all three computed gates (collaborator-permission, validate-on-HEAD-SHA, signed-commit) survive intact; their housing changes from three workflow files to one. The no-token-sandbox property documented as trust-delta item 1 is preserved by the two-job structure (`gate` lacks `contents: write` and the Shopify secret). For `workflow_run` paths Validate is explicitly treated as advisory: a malicious PR head could rewrite `validate.yml` to pass falsely, but `getWorkflowRun().head_sha` + `compareCommits.status === 'identical'` + the signed-commit assertion (which reads commit metadata from the API, not from the PR's files) form the actual integrity boundary. Token rotation call-site catalog drops from four workflow files to two (`preview.yml` and `deploy.yml`).

Operator action: none post-merge. The unified `deploy.yml` becomes active on main after this PR squash-merges; subsequent admin commits and Dependabot PRs auto-deploy through the new path. Recovery procedure for any future stuck-state incident (one local command with admin bypass): `git push --force-with-lease=shopify-sync:<expected-sha> origin <main-sha>:shopify-sync`.

Label-free deploy gating: this PR also removes all label-based gates from the deploy chain. The previous mechanisms used three labels (`auto-reconcile` to allow shopify-sync auto-deploy, `manual-review` as escape hatch on both auto-deploy paths, `auto-deploy-major` to opt in to Dependabot major-version auto-deploys). Each is replaced by a native GitHub mechanism that does not require operator label hygiene:

- `auto-reconcile` requirement -> PR-opener-identity check (`pr.user.login === 'github-actions[bot]'`, proving `sync.yml` opened the PR) plus the existing signed-commit assertion on the underlying shopify[bot] commits. A hand-opened shopify-sync -> main PR is rejected by auto-deploy and must be shipped via manual `deploy` comment.
- `manual-review` escape hatch -> draft-PR check (`pr.draft === true`). Operator marks the auto-reconcile PR or Dependabot PR as a draft (via `gh pr ready --undo <n>` or the GitHub UI) to halt auto-deploy; convert to ready-for-review to resume. Halt is bidirectional: applies to both shopify-sync and dependabot auto-deploy arms.
- `auto-deploy-major` opt-in -> major-version bumps default-skip auto-deploy (safer default). Operator comments `deploy` after review to ship a major bump.

`setup-labels.yml` is deleted; `.github/dependabot.yml`'s `labels:` block is removed. Existing labels in the repo are unused by the deploy chain after this PR; they can be left in place or pruned manually with `gh label delete`.

Additional reviewer-flagged fixes folded into this PR:

- `gate` and `deploy` jobs now declare `issues: write` for `createForIssueComment` reaction calls (the PR-comment reactions endpoint routes through the issues API even for PR comments; the prior `pull-requests: write`-only grant was undocumentedly permissive).
- `sync.yml`'s stale-PR alarm no longer exits 1, which previously turned every cron firing red whenever an auto-reconcile PR was open >3 days. Stale-PR notice is now a `::warning::` annotation plus the per-PR comment.
- The "Sync main -> shopify-sync" step's race-recovery messaging in the deploy report now correctly states "retry on next admin push or 13:00 UTC cron" rather than implying immediate retry.
- The resolve step's "Unexpected head_branch" case is now a `::warning::` (was silent `::info::`); an unexpected event_name now `setFailed`s (was unreachable but now defensive).
- `sync.yml`'s `Determine sync status` step now writes `ahead=0, loc=0` defaults upfront for clarity even when AHEAD=0 (no functional change).
- CLAUDE.md "Code changes" section documents the local-actionlint invocation that matches CI's `SHELLCHECK_OPTS` for SC2016 / SC2317 suppressions.
- CLAUDE.md "Token rotation call-site catalog" now enumerates the composite action (`shopify-theme-push/action.yml`) as the canonical consumption point in addition to the two workflow passthrough sites.

## CI/CD preview cleanup + install consolidation (unreleased)

Synchronous preview-theme cleanup on auto-merge, plus consolidation of the Shopify CLI install pattern. Closes the leak where `pr-N-preview` themes survived after a token-driven squash-merge.

Root cause: GitHub Actions does not fire downstream workflows for events triggered by the default `GITHUB_TOKEN`. The three deploy paths (`deploy.yml`, `shopify-sync-auto-deploy.yml`, `dependabot-auto-deploy.yml`) all close PRs by calling `pulls.merge` with `GITHUB_TOKEN`, so `preview.yml::cleanup` (gated on `pull_request: closed`) silently never fires after a token-driven merge.

What changed:

- **NEW** composite action `.github/actions/setup-shopify-cli/`: single source for `actions/setup-node` + `npm ci --ignore-scripts`. Used by `shopify-theme-push` and `validate.yml`. The CLI version pin (`@shopify/cli@3.94.3`) lives only in `package.json`.
- **EXTENDED** `.github/actions/shopify-theme-push/` with `mode: delete-preview`. Lists themes named `pr-${PR_NUMBER}-preview` and deletes them. Exits 0 on no-match (informational); non-zero on real Shopify API/auth failure so a token rotation surfaces loudly. New `cleanup-status` output threads into the deploy report comment.
- **REFACTORED** the three deploy workflows: split the prior `Merge PR and report success` mega-step into a four-step ladder (`Live theme push` -> `Squash merge` -> `Delete preview theme` (continue-on-error, gated on merge success) -> `Post (auto-)deploy report`). Cleanup ordering is post-merge intentionally; a runner crash or non-transient cleanup failure cannot leave the system in `live deployed + PR open + preview gone`.
- **UPDATED** `preview.yml::cleanup` to call `shopify-theme-push` with `mode: delete-preview`. Replaces inline `npm install -g @shopify/cli@3.94.3` + bash with the composite action call (after a `ref: main` checkout because the PR head ref may already be deleted).
- **UPDATED** `validate.yml` to use `setup-shopify-cli` (drops a duplicate setup-node + npm-ci block).
- **DELETED** `.github/workflows/drift-watch.yml`. Loss of weekly orphan-preview sweep is accepted; the synchronous cleanup is the primary mechanism, with manual `npx shopify theme list | grep pr-` plus `shopify theme delete --theme <id> --force` as the documented recovery path.
- **UPDATED** `sync-reconcile.yml` to remove issue creation (issues are disabled on this repo). Diff-sanity alarm now relies on workflow-failure notifications; stale-PR alarm posts a `gh pr comment` per stale PR. `issues: write` permission dropped.
- **UPDATED** `setup-labels.yml` to drop the `deploy-attention` label (no remaining callers) and `issues: write` permission.

Trust-model implications: token-rotation call-site catalog drops from 7 sites to 4, and all four now route through `shopify-theme-push`. There is no longer an automated detector for unauthorised admin-side edits to the live theme; the "live = main" invariant is operator discipline, not CI-enforced. Acceptable for a single-developer private repo.

Operator action: after this PR merges, manually delete the leaked `pr-3-preview` theme: `npx shopify theme delete --theme 183494148396 --force`.

## CI/CD GitHub Environment removed (unreleased)

The `shopify-deploy` GitHub Environment is gone. All six jobs that previously bound to it (`preview.yml::deploy-preview`, `preview.yml::cleanup`, `deploy.yml::deploy`, `drift-watch.yml::drift-watch`, `shopify-sync-auto-deploy.yml::auto-deploy`, `dependabot-auto-deploy.yml::auto-deploy`) now read the Shopify CLI token from a repo-level secret directly, with no environment binding.

`SHOPIFY_FLAG_STORE` was demoted from secret to a repo-level variable. The myshopify handle is observable from any storefront response (it appears in `Set-Cookie` and on every checkout redirect) and is not credential material; treating it as a variable is correct, surfaces the value in workflow logs without redaction, and slightly improves debuggability.

`SMOKE_BASE_URL` was retired and replaced by a new `SHOPIFY_DOMAIN` repo-level variable holding just the canonical host (e.g. `sapphireshadowstudio.com`). The deploy workflows prefix `https://` and pass that as the `smoke-base-url` input to the composite action; the smoke action's contract is unchanged.

Trust-model implication: the three computed deploy gates (collaborator-permission check, validate-on-HEAD-SHA, signed-commit) are unchanged and remain the access control. With no env binding, the Shopify token is now readable by any workflow run that the actor can dispatch with the right `permissions:` grant, instead of only by jobs explicitly bound to the env. This is an accepted reduction in defence-in-depth; the env's required-reviewer gate had already been removed earlier (it was self-approval anyway), so the env was no longer a meaningful boundary.

Operator action that accompanied this change (already done): three repo-level entries created (`SHOPIFY_CLI_THEME_TOKEN` secret, `SHOPIFY_DOMAIN` variable, `SHOPIFY_FLAG_STORE` variable). After this change ships, delete the `shopify-deploy` environment in `Settings -> Environments` and clear out the orphaned env-scoped `SMOKE_BASE_URL` secret.

## CI/CD comment-driven deploy (unreleased)

Switched the deploy chain from "merge-then-deploy" to "deploy-then-merge". A write+ collaborator comments `deploy` on a PR; `deploy.yml` validates that the latest validate run on the PR HEAD SHA was green, pushes the theme to live, smoke-tests `/`, `/cart`, and `/collections/all`, then squash-merges the PR and deletes the branch. Failures post a sticky comment and the PR stays open so the developer can push a fix and re-comment.

The `shopify-sync` reconcile PR is now shipped automatically by a new `shopify-sync-auto-deploy.yml` workflow after Validate succeeds (mirroring the dependabot-auto-deploy pattern), with bot-identity, signed-commit, base-staleness, and diff-sanity gates. Dependabot PRs auto-deploy too via a new `dependabot-auto-deploy.yml` with PFW-style safety gates: signed by `dependabot[bot]`, refusal if `.github/{workflows,actions,scripts}` modified, major-version bumps require an `auto-deploy-major` label, `manual-review` label as escape hatch.

The `shopify-write` GitHub Environment was renamed to `shopify-deploy` and now holds `SHOPIFY_CLI_THEME_TOKEN` and `SHOPIFY_FLAG_STORE` as environment-scoped secrets. Required reviewers removed; the deploy gate is now the comment-trigger plus validate-on-HEAD-SHA verification plus the signed-commit gates on auto-deploy paths. The `[hotfix]` push-to-main bypass is gone; CLI break-glass (`npx shopify theme push --live --allow-live`) remains documented for true CI outages.

`pr-checks.yml` was replaced by `validate.yml` (one sequential job with five steps: `theme-check`, `reconcile`, `actionlint`, `zizmor`, `gitleaks`; plus a sticky-comment aggregator). A new composite action `.github/actions/shopify-theme-push/` factors out the live and preview push paths and adds smoke-test, per-attempt timeout, and token-redaction.

## CI/CD cutover (2026-05-03)

Switched from Shopify's bidirectional GitHub Integration on `main` to a PR-based deploy model.

### What changed

- Live theme `#181702754604` is no longer GitHub-connected. Production deploys are owned by `.github/workflows/deploy.yml`, which runs on every push to `main`.
- Admin theme-customizer and code-editor edits now flow through a separate unpublished theme `EDIT HERE - Admin Sync`, which is connected to the new `shopify-sync` branch. A daily `sync-reconcile` workflow opens an auto-merge PR from `shopify-sync` to `main` so admin edits reach production through the same gated path as code.
- Every PR runs `theme-check`, deploys a per-PR preview theme `pr-<n>-preview`, and is blocked from merging if `shopify-sync` has unmerged commits (`pr-reconcile-check`).
- Branch protection on `main`: PR required, branches must be up to date, theme-check + pr-reconcile-check required, force-push blocked, branch deletion blocked. Admin bypass enabled for hotfix flow.
- Repo settings: "Allow auto-merge" enabled. GitHub Environment `shopify-write` requires self-approval before the Shopify Theme Access token hydrates in any job.
- New cutover tag: `v1-ci-cutover`.

### Why

The old model auto-deployed every push to `main` without CI, mixing developer commits and admin-side `shopify[bot]` commits on the same branch with no review. Bad commits hit live instantly. The new model adds Theme Check gates, a per-PR preview, and isolates admin edits onto their own branch so they reconcile through PRs.

### Files added

- `.github/workflows/{pr-checks,preview,sync-reconcile,deploy,drift-watch}.yml` (five workflows; `pr-checks.yml` runs three parallel jobs: `theme-check`, `pr-reconcile-check`, `lint-workflows`).
- `.github/dependabot.yml`.
- `package.json`, `package-lock.json` (Shopify CLI pinned to 3.94.3).
- `blocks/CLAUDE.md`, `assets/CLAUDE.md` (per-directory rules for block authoring and CSS/JS coding standards).

### Files removed

- `.cursor/` (45 Cursor-specific rule files). Unique authoring guidance was migrated into the root `CLAUDE.md` and the new per-directory `CLAUDE.md` files; the Cursor regex-DSL files were not (theme-check + review agents cover that role).

### Files modified

- `CLAUDE.md`: rewrote "Before Making Changes" for the new branch-from-main / reconcile-check model; trimmed inline Shopify-doc duplication; added Pre-PR review notes; relocated component-specific rules to per-directory `CLAUDE.md` files.
- `README.md`: replaced Horizon upstream boilerplate with project-specific CI/CD docs.
- `.theme-check.yml`: disabled `JSONMissingBlock` to suppress 3 known false-positives from Judge.me Reviews app blocks.
- `THEME_CHECK_NON_ACTIONABLE.md`: noted the `JSONMissingBlock` items are now suppressed in config.

---

# Release Notes - Version 3.2.1

This release delivers extensive performance optimizations across many components and resolves issues in the menu drawer, cart, and sticky add-to-cart behavior.

## What's Changed

### Fixes and improvements

- [Performance] Improved Liquid rendering performance by reducing snippet use
- [Performance] Improved overall CSS performance
- [Performance] Improved animation performance
- [Performance] Improved header, email signup, quick-add, meta color, predictive search, hero banner, fly-to-cart, jumbo text, and slideshow performance
- [Performance] Improved page load speed when page transitions are turned off
- [Performance] Disabled all view transitions for low-powered devices
- [Performance] Improved interaction performance for various components
- [Menu drawer] Fixed menu drawer not closing on Firefox
- [Footer] Fixed footer copyright text wrapping
- [Quick add] Fixed quick add modal variant selector appearance issues after opening multiple modals
- [Collection cards] Collection cards in lists and grids match height of tallest card
- [Slideshow] Fixed slideshow controls visibility on transparent product images
- [Marquee] Fixed marquee jump on mobile scroll
- [Sticky add to cart] Polished sticky add to cart behaviors
- [Cart drawer] Entire cart drawer becomes scrollable when its footer is too tall
- [Cart drawer] Addressed UI inconsistencies in the cart drawer
- [Gift cards] Fixed "copy gift card code" button
- [Cart] Fixed discount field sizing for narrow viewports
- [Blog] Removed section title uppercase styling
- [Editor] Added recommended blocks to Slideshow and Layered slideshow
- [Editor] Improved the clarity of a number of labels in the editor
