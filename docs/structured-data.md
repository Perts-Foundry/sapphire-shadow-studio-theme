# Structured data

Full reference for the theme's hand-authored JSON-LD. CLAUDE.md's "Structured data" section
carries the condensed, load-bearing directives (the silent-failure prohibitions); this file is the
detailed reference for when you are actually editing `snippets/structured-data*.liquid` or adding
an `application/ld+json` block.


All hand-authored JSON-LD routes through one snippet: `snippets/structured-data.liquid`, rendered from `layout/theme.liquid`'s head right after `meta-tags`, and deliberately **not** from `layout/password.liquid`. It dispatches to per-type snippets (`structured-data-organization.liquid`, `structured-data-website.liquid`).

Rules that are easy to break and have no automatic check behind them; the `seo-review` skill covers JSON-LD parse validity and entity placement, but only when an operator runs it, never in CI:

- **Entity nodes (Organization, WebSite) are homepage-only.** They are guarded on `request.page_type == 'index'` so the store has exactly one of each. Emitting them per page is the defect this structure replaced.
- **Do not put JSON-LD back in `sections/header.liquid`.** That is where the Organization node used to live, and a comment there says so.
- **Derive `@id` and `url` from `shop.url`, never `request.origin`.** A preview theme and the `*.myshopify.com` host have a different origin, which would mint a second identifier for one entity.
- **Never emit an unguarded trailing comma.** A blank setting inside an array or object silently invalidates the whole node, and browsers surface no parse error. Build optional arrays by collecting non-blank values first, then emitting with `forloop.last`.
- **Do not divide by an image's `aspect_ratio` inside a script tag.** An SVG can report it as zero or nil, and Liquid renders a divide-by-zero as an error string that lands inside the JSON-LD.
- Product / ProductGroup markup is **not** routed here. It comes from Shopify's `{{ product | structured_data }}` filter and is not extensible.
- **`hasMerchantReturnPolicy` is a hardcoded property of the Organization node, not a theme setting.** Do not add a settings dropdown for the category; the categories are not one-field swaps and nothing in CI parses JSON-LD (details in the snippet's doc block). Keep it tracking `/policies/refund-policy`. The node is known to over-state a 14-day window store-wide; that is a recorded accepted risk, not a bug.
- **`ItemList` on collection pages** comes from `snippets/structured-data-collection-list.liquid`, rendered from inside `sections/main-collection.liquid`'s `{% paginate %}` block, not from the shared `snippets/product-grid.liquid` (which search results also render). It is suppressed on filtered views (they canonicalise elsewhere) and re-sorted views (they reorder what the positions assert) but deliberately not on `?page=N`; full rationale in the snippet's doc block.

- **`FAQPage` comes from `sections/faq.liquid`, and its `faq_heading` blocks are excluded by construction.** The loop emits a `Question` only for blocks whose `question` and `answer` are both non-blank, and a heading block carries neither setting, so nothing filters it explicitly. A new block type that happens to define a `question` would start appearing in the markup with no other change. Anchors come from `question | handleize | truncate: 50`, so rewording a question breaks every shared link to it; reordering `block_order` is free.

`snippets/breadcrumbs.liquid` emits its own `BreadcrumbList` and picks a product's parent collection through a four-step cascade whose second step is the `custom.breadcrumb_collection` product metafield. Read `docs/breadcrumb-collection-metafield.md` before setting a value, changing the cascade, or renaming a collection; the metafield definition's Storefronts-read access setting is the setup step whose omission fails silently.

Validate with `validate_theme_codeblocks`, then assert every `application/ld+json` block on the page parses as JSON. Rich Results Test never validated Organization or WebSite, and its URL mode cannot reach a password-gated storefront; use validator.schema.org in code-paste mode.
