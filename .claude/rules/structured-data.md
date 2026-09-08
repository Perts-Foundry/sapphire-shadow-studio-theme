---
paths:
  - "snippets/structured-data*.liquid"
  - "snippets/breadcrumbs.liquid"
  - "sections/header.liquid"
  - "sections/faq.liquid"
  - "layout/*.liquid"
  - "templates/page.faq.json"
---

# Structured data

**Before editing `snippets/structured-data*.liquid`, or adding any `application/ld+json` block, read `docs/structured-data.md`.** All hand-authored JSON-LD routes through one snippet, `snippets/structured-data.liquid`, rendered from `layout/theme.liquid`'s head and deliberately not from `layout/password.liquid`. These five have no automatic check behind them and fail silently:

- **Entity nodes (Organization, WebSite) are homepage-only**, guarded on `request.page_type == 'index'` so the store has exactly one of each. And **do not put JSON-LD back in `sections/header.liquid`**, where the Organization node used to live.
- **Derive `@id` and `url` from `shop.url`, never `request.origin`.** A preview theme and the `*.myshopify.com` host differ in origin, which would mint a second identifier for one entity.
- **Never emit an unguarded trailing comma.** A blank setting inside an array or object silently invalidates the whole node, with no browser parse error. Collect non-blank values first, then emit with `forloop.last`.
- **Do not divide by an image's `aspect_ratio` inside a script tag.** An SVG can report it as zero or nil, and Liquid renders the divide-by-zero as an error string that lands inside the JSON-LD.
- **`hasMerchantReturnPolicy` is hardcoded on the Organization node, not a theme setting.** Do not add a settings dropdown for the category; the categories are not one-field swaps.

`snippets/breadcrumbs.liquid` emits its own `BreadcrumbList` and picks a product's parent collection through a four-step cascade whose second step is the `custom.breadcrumb_collection` product metafield. Read `docs/breadcrumb-collection-metafield.md` before setting a value, changing the cascade, or renaming a collection; the metafield definition's Storefronts-read access setting is the setup step whose omission fails silently.
