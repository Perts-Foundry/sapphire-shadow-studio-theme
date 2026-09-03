# Collection differentiation runbook

Admin-side work, no theme code. Read this before changing what is in `featured`, `healthcare-collection`,
or `the-vitals-collection` (the built-in `/collections/all` covers the whole-catalogue browse path; the `all-products` collection was deleted on 2026-08-16).

**Run this before setting any `custom.breadcrumb_collection` value**
(`docs/breadcrumb-collection-metafield.md`). That metafield names a collection per product, and
setting values before membership is settled means pointing products at a collection they are about
to leave. This work also shifts the theme's *fallback*: `preferred_handles` in
`snippets/breadcrumbs.liquid` scans `healthcare-collection`, `the-vitals-collection`, `featured` in
order, so a product leaving `healthcare-collection` gets a different fallback parent. Check the
resulting trail is still the one you want.

**Renaming a collection is the trap this file should make you check.** The handle is what the
snippet matches, and it is not derivable from the title: "Healthcare Collection" is
`healthcare-collection`, and this document said `healthcare` for months while the snippet did too,
so the first rung of the cascade matched nothing and every multi-collection product silently fell
to step 4. Read handles out of Admin, change `preferred_handles` and `BREADCRUMB_PREFERRED_HANDLES`
together, and let `npm run seo-review:test` and the `breadcrumb-preferred-handle-missing` check
confirm it.

## The problem

`featured` and `healthcare-collection` list an identical five products. Both are indexable. Their meta
descriptions differ but the grid does not, so which one Google treats as canonical is a coin flip,
and the loser's ranking signals go to a page nobody chose.

## Three constraints, stated up front

**With seven products you cannot differentiate two five-product collections by adding.** One must
shrink. The symmetric difference has to be non-empty in **both** directions: each collection needs
at least one product the other lacks. A subset is still a duplicate candidate against its superset,
so swapping identical grids for nested ones fixes nothing.

**Membership alone will not fix it.** `templates/collection.json` renders the H1 from
`{{ closest.collection.title }}` and the body from `{{ closest.collection.description }}`. Two pages
with different grids and templated everything-else still cluster. This is the most likely way the
work lands and still fails. `scripts/seo-review/admin.mjs` already flags the class through
`collection-body-empty` and `collection-seo-description-missing`.

**The structural answer is fewer collections.** `featured`, `healthcare-collection`, and
`the-vitals-collection` over seven products (plus the built-in `all`) is still several names for one catalogue. What follows is a holding
action until the catalogue grows, recorded as such so it is not rediscovered as a fresh idea.

## Step 1: query before drafting

Read-only. Nothing below should be drafted against assumptions about membership.

```bash
node --env-file=.env --input-type=module -e '
import { createAdminClient } from "./scripts/blank-inventory/lib/admin.mjs";
const c = createAdminClient();
console.log(JSON.stringify(await c.gql(`{
  collections(first: 20) {
    pageInfo { hasNextPage }
    edges { node {
      handle title description
      seo { title description }
      sortOrder templateSuffix
      ruleSet { appliedDisjunctively rules { column relation condition } }
      productsCount { count }
      products(first: 50) { edges { node { handle title tags productType } } }
    } }
  }
}`), null, 2));'
```

This settles three things the repo cannot answer:

- exact membership of all four collections;
- whether each is **smart** (has a `ruleSet`, so membership changes by editing product tags) or
  **manual**;
- whether `the-vitals-collection` holds the same five, which would make this a three-way
  duplication rather than a pair.

## Step 2: the split

Adjust against what step 1 actually returned.

**`healthcare-collection` becomes a real category with a stated rule.** Contents: `lead-ii-crewneck`,
`lead-ii-quarter-zip`, `lead-ii-vest-womens`, `huddle-crewneck`. The rule is
"credential-embroidered pieces made for healthcare workers", an editorial rule anyone can apply to a
seventh product without asking. Excluded: `shift-fuel-crewneck` (no Design option, no custom text,
resellable, returnable, so precisely not credential merchandise) and `gift-card`.

**`featured` becomes a merchandising shelf, not a category.** Three hand-picked products, and **at
least one must be a product `healthcare-collection` does not contain**. `gift-card` is the natural pick,
because it will never belong in `healthcare-collection` and so guarantees the difference in that direction
permanently. Manual and curated, never a rule set.

Result: `healthcare-collection \ featured` is non-empty and `featured \ healthcare-collection` is
non-empty. No subset
relationship either way.

**`the-vitals-collection`:** if step 1 shows it holds the same five, give it its own rule or merge
it away. Do not leave a three-way duplicate half-fixed.

**Copy is the other half and is not optional.** Each of the four needs a distinct body description
(two to four sentences saying what belongs in it and why, not keyword filler), a distinct stored SEO
title, and a distinct stored SEO description of 50 to 160 characters. `checkSeoText` in
`scripts/seo-review/admin.mjs` enforces the lengths and `admin-description-duplicate` catches two
collections sharing a description. This closes part of two other open backlog items: the null stored
SEO titles on all four collections, and the missing collection images.

## Risks

- **Rule sets versus manual.** If `featured` is currently smart and tag-driven, keeping it smart
  while calling it hand-picked is a lie that will drift back to five products the next time a
  product is tagged.
- **Discovery.** Shrinking `featured` removes two products from one browse path. With seven products,
  one nav, and the built-in `/collections/all` existing, the real cost is near zero, but it is a real change.
- **You will not see the result for weeks.** Canonical clustering is a Google-side judgement, and
  the only genuine verification is Search Console after a re-crawl. Everything before that is a
  proxy.

**Fallback if it does not work:** noindex `featured`. The blog-listing noindex in
`snippets/meta-tags.liquid` is the working precedent for how to do that in this theme.
