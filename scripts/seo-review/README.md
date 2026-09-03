# scripts/seo-review/

Read-only SEO regression tooling. It re-runs the July 2026 site audit as repeatable checks so
new products, pages, and collections cannot silently reopen the gaps that audit closed. Nothing
here writes to the store, the repo, or Admin; the only writes are run artifacts in a state dir
outside the checkout.

The `seo-review` Claude skill (`.claude/skills/seo-review/`) drives these scripts and layers the
repo-invariant review (structured-data rules, meta-tags regressions, template hygiene) on top;
these scripts are the deterministic half.

## Modes

| Script | Mode | Auth | What it checks |
| --- | --- | --- | --- |
| `crawl.mjs` | crawl | `STORE_PW` while the store is locked; none once public | Every sitemap URL plus fixed paths: titles, descriptions, canonicals, robots, H1 count, JSON-LD parse + type placement, og:image scheme, breadcrumbs, alt coverage, cross-page duplicates |
| `surface.mjs` | surface | deliberately none (sees what a crawler sees) | Password-gate status, robots.txt + its `Sitemap:` host, sitemap host consistency, per-page noindex and canonical host once the store is public |
| `admin.mjs` | admin | `MYSHOPIFY_DOMAIN` + `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` | Stored (not rendered) SEO fields: product/collection `seo.title`/`seo.description` presence, length, duplicates; page `global.title_tag`/`description_tag` metafields; collection body copy; variant SKU coverage; empty blogs |

All three share flags: `--full` (print unchanged findings and accepted risks), `--no-save`
(do not record this run as the new baseline). `crawl.mjs` also takes `--max <n>` (URL cap,
default 80) and `--pace <ms>` (default 1500; be gentle, the storefront rate-limits).

```bash
# While the store is password-locked:
STORE_PW='...' node scripts/seo-review/crawl.mjs
node scripts/seo-review/surface.mjs
node scripts/seo-review/admin.mjs        # needs the three Admin env vars

# See everything, not just deltas:
STORE_PW='...' node scripts/seo-review/crawl.mjs --full
```

## Check criteria

Severities: **ERROR** blocks (exit 1 when new since the baseline), **WARN** reports, **INFO** is
context. Thresholds: title <= 60 chars; description 50 to 160 chars.

Crawl-mode checks and why each exists:

- `jsonld-parse`: every `application/ld+json` block must `JSON.parse`. The Liquid trailing-comma
  bug renders markup that looks fine, parses nowhere, and surfaces no browser error. This is the
  single highest-value check in the module.
- `jsonld-entity-home` / `jsonld-entity-leak`: Organization and WebSite exactly once on the
  homepage, never elsewhere. Emitting them per page is the defect `snippets/structured-data.liquid`
  replaced (see `docs/structured-data.md`).
- `jsonld-breadcrumb-missing` / `breadcrumb-missing` / `breadcrumb-unexpected`: visible trail and
  `BreadcrumbList` follow the allow-list in `snippets/breadcrumbs.liquid` (`product`, `collection`,
  `page`, `article`, `blog`, `list-collections`; `policy` deliberately absent). The constant in
  `lib/checks.mjs` mirrors that snippet's case list; change them together.
- `jsonld-itemlist-missing` (WARN): a collection page should carry the `ItemList` emitted by
  `snippets/structured-data-collection-list.liquid`. WARN rather than ERROR because an empty
  collection legitimately emits nothing. The snippet also suppresses the node on filtered and
  re-sorted views; the crawl walks sitemap URLs, which are neither, so the suppression never trips
  this check.
- `h1-count`: exactly one `<h1>` per page. Nothing in CI checks heading structure; the homepage
  once had two (header + hero), the FAQ page once had zero, and so did the search page until
  2026-09-03. It has no page-type exemption, and that is not an oversight: a missing `<h1>` is a
  document structure problem whether or not the page is indexed, so noindexing a page does not clear
  it. The search page proved it, and the fix there was the heading, not the robots tag.
- `description-duplicate` (ERROR): the exact defect class of the original audit's worst content
  finding (two products carrying a third product's description verbatim).
- `og-image-scheme`: `og:image` must be https. Regressed once in inherited Horizon boilerplate.
- `canonical-host`: canonicals must live on the primary domain, never `*.myshopify.com` and never
  a preview host.
- `robots-noindex`: an indexable page type carrying noindex is an error; `cart`, `search`, `404`,
  `password`, and `policy` are exempt. `/search` carries a deliberate noindex as of 2026-09-03
  (`snippets/meta-tags.liquid`) and needs no accepted-risks entry precisely because `search` is on
  that exempt list. The empty blog listing is deliberately noindexed and is suppressed through
  `accepted-risks.json` instead, not through the exempt list: `blog` stays an indexable page type so
  the day it has articles and still carries noindex, the check reds.
- `404-status`: a garbage path must return a real 404 (soft-404s poison crawl budget).

Admin-mode checks read what is **stored**, because the storefront renders fallbacks: a null
product SEO title renders as the product title, which is exactly how the original audit
miscounted B5. Page metadata lives in the `global` namespace metafields (`title_tag`,
`description_tag`); the Page resource has no `seo` field. The Admin client is reused from
`scripts/blank-inventory/lib/admin.mjs` (lazy token mint, error redaction, throttle retries).
Two guard behaviours worth knowing: any GraphQL connection reporting another page past the
query caps raises an `admin-read-truncated` ERROR rather than silently auditing a subset, and
collection body copy is judged after stripping editor artifacts (`<p></p>`, `&nbsp;`), so a
visually blank body cannot pass as content.

Admin mode also reads the `custom.breadcrumb_collection` product metafield that
`snippets/breadcrumbs.liquid` uses to pick a breadcrumb parent, and reports
`product-breadcrumb-collection-missing` and `product-breadcrumb-collection-catchall`. Both are WARN
and both are keyed per product (`admin:product/<handle>`) rather than aggregated, so the baseline
differ names which product regressed instead of moving a counter. The catch-all variant is the more
valuable of the two: a value pointing at `all`, `frontpage`, or `all-products` is ignored by the
theme while still looking correct in Admin. A third breadcrumb finding,
`breadcrumb-preferred-handle-missing`, backs a different rung: it is **ERROR**, and it is keyed
`admin:collection/<handle>` rather than per product, because it reports on the theme's hardcoded
preferred-handle list rather than on any one product. It fires when an entry in that list names no
collection in the store, which the snippet skips in silence. ERROR rather than WARN because the two
metafield findings each have a working fallback behind them, while a dead entry removes a rung from
the cascade outright and drops every multi-collection product to the arbitrary last resort. It is
the only breadcrumb check that can red a run. Two constants in `lib/checks.mjs` mirror the snippet
and must change with it: `BREADCRUMB_EXCLUDED_HANDLES` mirrors `excluded_handles`, and
`BREADCRUMB_PREFERRED_HANDLES` mirrors `preferred_handles`. Both pairs are pinned by tests in
`test/admin.test.mjs` that parse the snippet, so drift fails the suite. Products documented as
intentionally blank are exempt from the missing-value WARN so the check can reach zero findings.
That set is derived: `breadcrumbBlankOkHandles()` in `admin.mjs` reads every product `catalogue.json`
declares with `"body": null`, which is exactly the class with no parent collection to name, and
covers each one under BOTH its handle and its template suffix. It was a literal `['gift-card']`
compared against the Admin handle `sapphire-shadow-studio-gift-card`, so the skip had never fired
and the gift card had been WARNing since the check shipped. Full context, including the definition
and the per-product values: `docs/breadcrumb-collection-metafield.md`.

Surface mode is the generalized launch-day checklist (B7): it runs anonymously on purpose.
Pre-launch, the password gate is reported as status and the page sweep is skipped with a reason.
Post-launch it is the standing "nothing is accidentally blocked, nothing lists the wrong host"
regression check. The GSC/Bing submission steps stay manual; they need operator accounts.

## Baselines and accepted risks

Each run saves its findings to `~/.local/state/seo-review/` (`SEO_REVIEW_STATE_DIR` overrides;
never point it inside the repo). The next run diffs against the latest saved run for its mode and
reports NEW / RESOLVED / UNCHANGED; the exit code blocks only on new ERRORs, so a standing known
issue never re-reds a run.

`accepted-risks.json` (committed, deliberately public: it records decisions already documented in
TODO.md) suppresses findings the operator has explicitly accepted. Entries match on `check` id
plus an optional `path`. When a decision is revisited (say the blog gets its first post), delete
the entry so the check goes live again. Finding `check` ids are the matching key for both this
file and the baseline history, so renaming one orphans its entries; rename only with a matching
edit here.

## Design notes

- **node fetch, never curl**: Shopify/Cloudflare bot management blocklists curl's fingerprint
  (hard 429). Same reason as the deploy smoke test; see `docs/smoke-test-reference.md`.
- **Password and token hygiene**: `STORE_PW` is read from the environment and never printed;
  the Admin token is minted at runtime from `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`, held
  in memory, and redacted from fatal errors. Page bodies and cookie values are never logged.
  All of these come from the repo-root `.env` via `node --env-file=.env ...`
  (see [`../README.md`](../README.md) > Credentials).
- **Extraction is hand-rolled** (`lib/extract.mjs`): the repo's only runtime dep is sharp and node
  has no DOMParser. Every extractor targets Shopify-rendered markup, tolerates attribute order,
  and is fixture-tested. If a check misfires on real markup, fix the extractor and add the
  fixture, do not loosen the check.
- **`decodeEntities` is load-bearing for the length checks.** Every `<title>` this theme renders is
  joined with a literal `&ndash;` (`snippets/meta-tags.liquid`), so an entity table that stops at
  `&amp;` measures every title on the store 6 characters too long and reports a phantom `title-long`
  on anything past 54 real characters. It did, on six URLs, until 2026-09-03. It decodes in one pass
  (a chain that decodes `&amp;` first would turn `&amp;lt;` into `<`) and returns anything it does
  not recognise exactly as written. Non-ASCII values are `\u` escapes and the tests build theirs with
  `String.fromCodePoint`, because this repo bans the literal em dash in every file.
- **Tests**: `npm run seo-review:test` (`node --test scripts/seo-review/test/*.test.mjs`).
  Unit-only; no network, no store access, temp-dir state.
