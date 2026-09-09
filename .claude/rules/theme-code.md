---
paths:
  - "blocks/*.liquid"
  - "sections/*.liquid"
  - "snippets/*.liquid"
  - "layout/*.liquid"
  - "templates/*.json"
  - "assets/*.js"
  - "assets/*.css"
  - "locales/*.json"
  - "config/settings_schema.json"
---

# Theme code

Loaded when a block, section, snippet, layout, template, asset, locale file or the settings schema is read. The root `CLAUDE.md` keeps the pointer for creating a new file of any of these kinds.

## Directory conventions

README's Repo layout table covers the top-level directories. One convention not there: JSON template alternates use a dot-suffix (`product.alternate.json`) and follow one of two page-alternate patterns: keep `main` enabled and append sections (Contact pattern), or disable `main` and compose from generic primitives like `hero` / `section` / `faq` (Custom Orders pattern, also used by About and FAQ). Pick the simplest fit. A third pattern, disabling `main` for one monolithic app block, is what About used to be and is not to be reintroduced: that block owned its own palette and type scale, so the page ignored the theme's color schemes and fonts entirely (rationale: `release-notes.md`). Also: root templates must include an `order` array + `sections` map; asset references use `{{ 'filename' | asset_url }}` and `{{ 'icon.svg' | inline_asset_content }}` for inline icons. **Placing a `_product-card` block in a template copies hand-maintained JSON that nothing in CI compares across templates**; take the values from "The site-standard product card" in `docs/theme-conventions.md` rather than from whatever the editor emits.

## Theme conventions

**Before creating or editing a block, section, snippet, or `assets/component.js`, read `docs/theme-conventions.md`.** It holds the component framework (refs, `on:` event binding, parent/child communication), the theme-editor lifecycle event names, the block file structure, and the Liquid / CSS / HTML / JavaScript standards. Inline here, because each of these fails silently or only at CI time, never at authoring time:

- **Zero external JavaScript dependencies**; native browser APIs only. BEM class names, and scope component CSS with `{% stylesheet %}` inside the section or block rather than adding to `assets/`.
- **NEVER edit a `{% schema %}` block that is generated from source** (e.g. by `scripts/size-chart/`); modify the source and regenerate.
- **Only ONE `{% content_for 'blocks' %}` per file.** Need the region in two places? Capture it once into a variable and emit the variable.
- **A block cannot read another block's settings.** When two must agree on a value, put it in `settings_schema.json` and share a snippet that reads it (see `snippets/size-option-position.liquid`); a setting duplicated per block is two sources of truth that drift apart silently.
- **Do not "fix" the bare `#SizeChart` anchor to `SizeChart-{{ block.id }}`.** Link anchors are deliberately unsuffixed so they stay hand-authorable; suffixing it breaks `snippets/size-guide-link.liquid` and every bookmarked link. `scripts/size-chart/test/anchor-contract.test.mjs` catches it, but at CI time, not while you are editing.
- **The Judge.me review widget app block in `templates/product.*.json` is not misconfigured.** Its `review_data: sample_data` renders only in the theme editor, and `empty_state: empty_widget` is the chosen live state, so a live product page showing an empty widget before the first review is working as decided. Do not edit either value to "fix" the empty widget; the rating badge under the title is hidden by an app setting, not a template one.

## Accessibility

`docs/accessibility-patterns.md` holds both the global rules (skip link, live regions, form-error summaries, touch targets, `title` only on `<iframe>`) and the per-widget role / attribute / keyboard sets. **Load it before implementing or modifying any of these widgets: accordion, breadcrumb, cart drawer, chat window, color swatch, combobox, carousel, disclosure, dropdown navigation, flip card, form, jump nav, modal, product card, slider, switch, tab, tooltip.** Anything that maps to one of these primitives (`<dialog>` is a modal; toasts are an `aria-live` region; a bare "dropdown" is a combobox, disclosure, or dropdown navigation depending on behaviour) uses the nearest match. Anything else: that file's global rules plus WCAG.

One rule that lives outside any widget: **the homepage `<h1>` is the hero lockup**, in `templates/index.json` under section `hero_jVaWmY`, block `headline_lockup`. `sections/header.liquid` deliberately emits no heading; it used to carry an `index`-guarded visually-hidden `<h1>`, which gave the homepage two. Nothing in CI checks heading structure, so verify exactly one `<h1>` per page type by hand after any header or hero change.

## Translations

- Keys live in `locales/en.default.json` (storefront) and `locales/en.default.schema.json` (schema).
- **Add the key to the locale file before referencing it**; theme-check fails red on dangling keys.
- When adding storefront-visible strings, mirror into `locales/it.json` and `locales/ro.json` with `TODO: ` placeholders. Those two only, not the other 30: the store publishes exactly one locale, so nothing else is served, and these are the two anyone has kept current (the rest carry the same 8 upstream-era `TODO:` keys and nothing since). Nothing in CI checks either direction (`MatchingTranslations` is off; pa11y audits the default locale), and the premise is an Admin setting, so confirm it rather than assuming: `{ shopLocales { locale primary published } }` through the Admin client, using `SHOP_LOCALES_QUERY` in `scripts/site-check/lib/admin-queries.mjs`. More than one published locale means backfill the rest first.
