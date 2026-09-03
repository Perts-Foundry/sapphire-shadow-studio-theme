# Breadcrumb collection metafield

Read this before setting `custom.breadcrumb_collection` on a product, before changing the parent
cascade in `snippets/breadcrumbs.liquid`, and before adding or renaming a collection.

A product usually belongs to several collections, so "which one does the breadcrumb name?" has no
answer the theme can derive. Before this metafield existed the answer came from a hardcoded
preferred-handle list in the snippet, which is deterministic but hand-maintained and fails quietly:
a handle that no longer exists is skipped with no error, so renaming or removing a collection
degrades every affected trail. That used to go unnoticed; `breadcrumb-preferred-handle-missing`
now fails the seo-review run on it, added after `healthcare` sat in the list for months against a
store whose collection is `healthcare-collection`. This metafield is the per-product answer that
needs no list maintenance. The list stays behind it as a permanent fallback.

## The `custom.breadcrumb_collection` metafield

- **Owner type**: `Product` (a breadcrumb parent is per product, not per variant).
- **Namespace / key**: `custom` / `breadcrumb_collection`.
- **Type**: **Collection reference**, single. Not a list: a breadcrumb trail has exactly one parent,
  and a list would reintroduce the "which one" ambiguity this metafield exists to remove.
- **Name**: Breadcrumb collection.
- **Description**: The collection this product's breadcrumb trail names when the shopper did not
  arrive through a collection. Leave blank to fall back to the theme's preferred-collection order.
- **Access**: **Storefronts: read.** This is the step that silently breaks everything if missed. A
  definition the storefront cannot read returns nil to Liquid, which is indistinguishable from
  unset, so the trail quietly falls back and Admin still shows the value you set.
- **Pin**: yes, to the product page.

A value must name a collection the product is actually in. The theme reads the reference directly
and does not validate membership, so a mismatch produces a trail whose parent link leads to a page
that does not contain the product.

## The four-step parent cascade

`snippets/breadcrumbs.liquid` picks a product's parent crumb in this order, first hit wins:

1. **The collection in the URL**, when the URL is collection-scoped
   (`/collections/x/products/y`) and `x` is not a catch-all. The shopper actually walked through
   that collection, and the trail should reflect the path taken. This deliberately beats the
   metafield. There is no canonical contradiction to worry about, because the last `ListItem` in the
   JSON-LD omits `item` entirely.
2. **`custom.breadcrumb_collection`**, when it resolves to a non-catch-all collection.
3. **The preferred-handle list** (`healthcare-collection`, `the-vitals-collection`, `featured`), scanned in
   order against the product's collections.
4. **Any collection that is not a catch-all**, in whatever order `product.collections` returns.

Step 3 is permanent, not a migration artifact. Removing it once every product has a metafield value
would regress any newly created product straight to step 4, and step 4 is what produced the
"Home > All Products > Lead II Crewneck" trail on every canonical product URL that
`release-notes.md` records fixing. There is no follow-up task to delete it.

**What blank means.** One `!= blank` check in the snippet covers four distinct causes, and they are
deliberately not told apart: the metafield is unset, the definition does not exist, the definition
is not readable by the storefront, or the referenced collection has been deleted. All four reach
Liquid as nil and all four should behave the same way, which is to fall through to step 3.

**Why a catch-all value is ignored.** `all`, `frontpage`, and `all-products` are excluded even when
hand-set. `all-products` was a real collection in this store (deleted in Admin on 2026-08-16; the
exclusion stays as a guard) that sorted first in `product.collections`, and naming it was exactly the
defect the exclusion list exists to prevent. A misconfigured value
therefore falls through to the preferred list rather than to the worst available trail.

## Per-product values

Confirm each against actual collection membership before setting it. This table said `healthcare`
for four products until 2026-09-03; no such collection exists, and the metafield is a **Collection
reference**, so those values were not merely wrong, they were unsettable. The handle is
`healthcare-collection`. Read the handle out of Admin rather than from a title: "Healthcare
Collection" does not handleize to what a reader would guess.

| Product handle | Value | Why |
|---|---|---|
| `lead-ii-crewneck` | `healthcare-collection` | Credential-embroidered; the vertical the trail should name |
| `lead-ii-quarter-zip` | `healthcare-collection` | Same |
| `lead-ii-vest-womens` | `healthcare-collection` | Same |
| `huddle-crewneck` | `healthcare-collection` | Same |
| `shift-fuel-crewneck` | whichever collection it is actually in | Not credential merchandise; must not name `healthcare-collection` if it is no longer a member |
| `shift-fuel-tote` | whichever collection it is actually in | Non-garment; in `featured` and `healthcare-collection` as of 2026-09-03 |
| `gift-card` | **leave blank** | Blank correctly yields a two-item "Home > Gift Card" trail |

Set these only after collection membership is settled. Pointing a product at a collection it is
about to leave is the one ordering mistake worth avoiding.

## Verification

The metafield is inert until a value exists, so the Liquid can ship first with no window where the
site is worse off. Once values are set, check on a preview theme:

- A **canonical** product URL (`/products/lead-ii-crewneck`) names the metafield's collection, and
  the `BreadcrumbList` second `ListItem` matches the visible middle crumb.
- A **collection-scoped** URL (`/collections/featured/products/lead-ii-crewneck`) still says
  Featured, proving step 1 beats the metafield.
- The **catch-all guard** only exercises by temporarily pointing one product at a catch-all handle and
  confirming the trail falls through to the preferred list. Revert afterwards.
- The **gift card**, with a blank value, renders a two-item trail and does not crash.

## The checks that back this

`scripts/seo-review/admin.mjs` emits three findings. The first two read the metafield through the
Admin API and are keyed per product (`admin:product/<handle>`) so the baseline differ names which
product regressed instead of moving a counter:

- **`product-breadcrumb-collection-missing`**: no resolved reference. The detail names the
  preferred-handle list the product falls back to.
- **`product-breadcrumb-collection-catchall`**: the reference resolves to an excluded handle. This
  is the higher-value of the two, because a set-but-ignored value looks correct in Admin.

Those two are `WARN`, which is non-blocking under `exitCodeFor`, so no `accepted-risks.json`
entries are needed while values are still being filled in. The third backs step 3 of the cascade
instead, and it blocks:

- **`breadcrumb-preferred-handle-missing`** (`ERROR`, keyed `admin:collection/<handle>`): an entry
  in the preferred-handle list names no collection in the store. `ERROR` rather than `WARN` because
  the other two have a working fallback behind them, while a dead entry silently removes a rung
  from the cascade and every multi-collection product drops to step 4's arbitrary order.

Two mirrored constants sit in `scripts/seo-review/lib/checks.mjs` and must change together with the
snippet: `BREADCRUMB_EXCLUDED_HANDLES` mirrors `excluded_handles`, and `BREADCRUMB_PREFERRED_HANDLES`
mirrors `preferred_handles`. Both pairs are pinned by tests in `scripts/seo-review/test/admin.test.mjs`
that parse the snippet, so drift now fails the suite rather than waiting for someone to notice.
