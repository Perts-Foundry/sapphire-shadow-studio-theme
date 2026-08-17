# Variant SKU scheme

Read this before adding a code, before changing `scripts/sku/tables.json`, and before assigning a
SKU by hand in Admin. The tooling that reads this scheme is `scripts/sku/`
([README](../scripts/sku/README.md)), driven by the `sku` Claude skill.

## Why the store has SKUs at all

SKUs were deferred once (2026-07-29) and adopted on 2026-08-16 on operational merits, not on search
merits. The SEO case was overstated: Google Merchant Center's required per-variant identifier is
`id`, which Shopify populates from the variant id, and SKU maps only to the optional `mpn`.
Made-to-order goods with no GTIN set `identifier_exists: false` either way. What SKUs actually buy
here:

- **Readable packing slips and picking.** `L2CN-RN-BLK-M` says what to make; a variant id does not.
- **Sortable exports.** General-to-specific segment order means an alphabetical sort groups by
  product, then design, then colour, then size, which is the order a batch is actually worked in.
- **A value frozen onto the order line at purchase.** The line item keeps the SKU string as sold,
  so a later rename of an option value does not rewrite history the way a live lookup would.
- **A join key for later barcode or inventory tooling.** Nothing depends on this yet; it is the
  reason not to encode anything volatile.

## The scheme

`<PRODUCT>-<DESIGN>-<COLOR>-<SIZE>`, uppercase, hyphen-separated. The segment shape is fixed per
product code. Products with no Design option drop that segment. The gift card encodes its
denomination instead. The longest SKU the current catalogue produces is 16 characters
(`L2VW-CNA-BLK-2XL`), at the top of the 8 to 16 band that stays readable on a packing slip and
scannable later.

| Product | Code | Shape | Example |
|---|---|---|---|
| Lead II Crewneck | `L2CN` | P-D-C-S | `L2CN-RN-BLK-M` |
| Lead II Quarter-Zip | `L2QZ` | P-D-C-S | `L2QZ-MDC-NVY-XL` |
| Lead II Vest - Women's | `L2VW` | P-D-C-S | `L2VW-CNA-BLK-2XL` |
| Huddle Crewneck | `HDCN` | P-D-C-S | `HDCN-NRS-GRH-S` |
| Shift Fuel Crewneck | `SFCN` | P-C-S | `SFCN-BLK-M` |
| Sapphire Shadow Studio Gift Card | `GIFT` | P-DENOM | `GIFT-050` |

There is deliberately **no brand prefix**. An `SSS-` on every SKU in a single-brand store carries no
information and costs four characters out of the readable band.

## Code tables

The tables live in `scripts/sku/tables.json`, are committed to git, and are the source of truth. A
SKU is always **derived** from a variant's own option values through those tables; it is never typed
in and never stored anywhere else.

**Colours** (store-wide): `BLK` Black, `GRH` Grey Heather, `NVY` Classic Navy.

**Designs** are namespaced per product family, because the two families' design sets are different
vocabularies that happen to overlap:

- `lead-ii` (Lead II Crewneck, Quarter-Zip, Vest): `RN`, `LPN`, `CNA`, `EMT`, `MDC` (Medic), `LVT`,
  `RVT`, `CVT`.
- `huddle` (Huddle Crewneck): `NRS` (Nurse), `EMT`, `MDC` (Medic), `VTT` (Vet Tech).

`EMT` and `MDC` intentionally mean the same thing in both namespaces. Codes must be unique within a
namespace, not across namespaces.

**Sizes pass through as-is** (`XS`, `S`, `M`, `L`, `XL`, `2XL`), uppercased. A new size therefore
needs no table edit, which is the point: sizes are already short uppercase tokens. A size value that
is not `[A-Z0-9]+` after uppercasing is refused as an invalid value rather than mangled.

**Gift denominations** are zero-padded to three digits: `010`, `025`, `050`, `100`, `150`.

> **The leading-zero rule, precisely.** The **full SKU** must never start with `0`: spreadsheets and
> some barcode tooling strip a leading zero and silently change the identifier. **Segments** may
> start with `0`, and the gift-card padding does. `GIFT-050` starts with `G`, so it is compliant.
> Do not "fix" the padding; `check-tables.mjs` enforces the rule on the product code (the first
> segment) only, and `010`/`025`/`050` are deliberately allowed.

### Rules that hold for every code

- Uppercase `A-Z` and digits only, no hyphens inside a segment (the hyphen is the separator).
- Avoid `O` and `I` in **new** codes: they are ambiguous against `0` and `1` when read off a label
  or transcribed by hand. `GIFT` predates the rule and is listed in `ambiguityExemptions` in
  `tables.json`; that list is not a general escape hatch, and additions to it need a reason written
  down here.
- Encode only **stable intrinsic attributes**. Never a price, a season, a supplier, a stock state,
  or anything that can change while the physical thing stays the same.
- Codes are derivable from **public option values only**. This repo is public. Supplier identity
  belongs in `custom.inventory_blank_sku`, which is a different identifier for a different thing
  (see below), and never in a SKU.
- **Append-only. A retired code is never reused.** A reused code makes two different garments
  indistinguishable in every historical order line, export, and packing slip that already carries
  it. Remove a value from the storefront if it is discontinued; leave its code in the table.

## Relationship to `custom.inventory_blank_sku`

The two identifiers are orthogonal and must not be conflated:

| | Variant SKU (this scheme) | `custom.inventory_blank_sku` |
|---|---|---|
| Identifies | the finished piece as sold | the shared blank garment as stocked |
| Lives in | the variant's `inventoryItem.sku` | a variant metafield |
| Derived from | public option values | supplier catalogue data |
| Committable | yes, it is public | **no**, it embeds supplier data |
| Tooling | `scripts/sku/` | `scripts/blank-inventory/` |

Two variants that share a blank (different designs, same garment) have different SKUs and the same
blank id. That is correct and is why one field cannot do both jobs.

## Adding a code (runbook)

Triggered when `sku audit` reports an `unmapped-value` or `unknown-product` row. Audit names the
product and the exact option string; that string is the table key, so copy it rather than retyping
it.

1. **Pick the code.** 2 to 4 characters, mnemonic, no `O`/`I`, unique within its scope (product
   codes store-wide; design codes within their namespace; colour codes store-wide).
2. **Check it has never been used**, including by something now retired: `git log -S<CODE> --
   scripts/sku/tables.json`. Append-only means the git history is the authority, not the current
   file.
3. **Edit `scripts/sku/tables.json`.** A new product also needs its `segments` array and, if it has
   a design axis, its `designNamespace`.
4. **`npm run sku:tables`** locally. It is the same lint CI runs.
5. **Open a PR.** Table changes go through review like any other change; there is no live-write path
   that edits them.
6. **Re-run `sku audit` after merge.** A tables change voids every plan artifact and every approval
   that preceded it: the artifact embeds the tables hash and `sku apply` refuses on a mismatch.
   Start the pipeline again from `audit`.

New **option values on an existing product** are the real ongoing cost, not new products. One new
colour on `lead-ii-crewneck` creates 36 variants (8 designs x 6 sizes) and needs exactly one new
table row; the tool then fills all 36. A half-populated SKU field is worse than an empty one,
because a SKU filter silently returns an incomplete set, so run `audit` after any option change.

## Applique patterns are not in the SKU

Huddle Crewneck applique variations are a required line-item property backed by
`scripts/applique-grid/patterns.json`, not an option and not a variant. A SKU therefore never
encodes the pattern. The pattern travels on the order line as `<n>. <Name> (<thread>)`, and the
registry's git history is the ledger of what each number meant when. Do not add a pattern segment;
it would multiply the SKU space by a set that changes on a different clock from the variants.

## The gift card, and the writability flag

Gift-card variants are written through the same `productVariantsBulkUpdate` path as everything else.
Shopify also offers a dedicated `giftCardProductSet` mutation; this tooling deliberately does not
use it, because that mutation performs a **full replacement** of the variant list, which is a far
wider blast radius than setting one field.

If the API ever refuses a SKU write on gift-card variants, that is not a permanent failing tool.
Set `"skuWritable": false` on the gift-card product entry in `tables.json`. `audit` then counts
those nulls as an **exempt** class rather than actionable ones, `plan` refuses to include them, and
the steady-state target becomes **0 actionable nulls** with exit 0. Record the refusal (the exact
`userErrors` code and message) in `release-notes.md` when flipping the flag.

## Recovery

There is deliberately **no `revert` command**. Every apply receipt records each row's prior SKU (the
baseline is read anyway, to guard against a row that moved between plan and apply), so recovery is
applying those baselines back through the same gated flow that wrote them: build a fresh plan, show
it, approve it, dry-run it, approve again, apply. An automatic rollback would be a second write path
with a fraction of the review, which is the wrong shape for the one thing that is hardest to notice
going wrong.
