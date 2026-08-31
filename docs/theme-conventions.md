# Theme conventions

Full reference for authoring theme code in this repo: the component framework, theme-editor
integration, the block / snippet / section split, block file structure, and the Liquid / CSS /
HTML / JavaScript standards. CLAUDE.md's "Theme conventions" section carries the condensed,
load-bearing directives; this file is the detailed reference for when you are actually creating or
editing a block, section, snippet, or `assets/component.js`.

## Component framework

Custom web-component framework in `assets/component.js`:

```javascript
import { Component } from '@theme/component';

class MyComponent extends Component {
  refs = {};                    // auto-populated from ref="name"
  handleClick(event) { }        // bound via on:click="/methodName"
}
```

- **Element refs**: declare via `ref="elementName"` (or `ref="items[]"` for arrays); access through `this.refs`. Validate required refs in `connectedCallback`; throw on missing.
- **Event binding**: `on:event="/methodName"` in HTML, never `addEventListener` for DOM events the framework can wire. Supported: click, change, select, focus, blur, submit, input, keydown, keyup, toggle.
- **Parent-to-child**: invoke public methods directly. **Child-to-parent**: emit a `CustomEvent` with a typed `detail` payload.
- Build URLs with `URL` and `URLSearchParams`; never concatenate query strings by hand.
- Cancel in-flight `fetch` with `AbortController` before issuing a new request; cancel in `disconnectedCallback`.
- Optimistic UI must revert on error; dispatch a custom event on success for cross-component sync.
- **JSDoc**: `@typedef` the refs object and pass as `Component<Refs>` generic. Optional refs `[name]`; document custom events' `detail` shape.

## Theme editor integration

Sections / blocks update without full reload; JS doesn't auto-execute. Listen on `document`: `shopify:section:load|unload`, `shopify:section:select|deselect`, `shopify:block:select|deselect`, `shopify:inspector:activate|deactivate`. Detect editor mode via `Shopify.designMode` (JS) or `request.design_mode` (Liquid).

When the inspector is active, deactivate fixed-position elements (sticky headers) so they don't obscure inspection outlines. Use `margin` / `gap` for block spacing, not `padding` (padding misaligns the inspector outline).

## Theme blocks vs snippets vs sections

- **Blocks** (`blocks/`): have `{% schema %}`, appear in editor, nest via `{% content_for 'blocks' %}`.
- **Snippets** (`snippets/`): Liquid partials with `{% doc %}`, no schema.
- **Sections** (`sections/`): page-scope. Convention: class `'section-' | append: section.type`; scope per-section CSS vars to the wrapper, apply via inline `style`. `block_order` only when the preset declares blocks as an object (not array).

## Block development

### File structure

```liquid
{% doc %}
  Description.
  @param {string} [optional_param] - Optional inputs in brackets.
{% enddoc %}

<div {{ block.shopify_attributes }} class="block-name">
  {{ block.settings.text }}
  {% content_for 'blocks' %}        {# only if nesting blocks #}
</div>

{% stylesheet %}
  .block-name { }
{% endstylesheet %}

{% schema %}
{ "name": "t:names.block_name", "settings": [] }
{% endschema %}
```

### Block-nesting gotchas

Static vs dynamic `content_for` invocation syntax and schema-targeting (`"blocks": [...]`, `"tag": null`) are standard Shopify theme-block features; look them up via `validate_theme_codeblocks` or the shopify-dev MCP rather than trusting a memorised summary. Two project-specific gotchas that aren't in Shopify's docs:

- **Only ONE `{% content_for 'blocks' %}` per file.** Need the same dynamic-block region in multiple places? **Capture** it once into a variable and emit the variable.
- **A block cannot read another block's settings.** When two blocks must agree on a value, put it in `settings_schema.json` and share a snippet that reads it (see `snippets/size-option-position.liquid`, read by both the variant picker and the acknowledgement block); duplicating the setting on each block gives two sources of truth that drift apart silently.
- **NEVER edit `{% schema %}` directly** when it's generated from source (e.g. by `scripts/size-chart/`); modify the source and regenerate.

## The site-standard product card

Every `_product-card` block in a JSON template is hand-copied JSON. There is no schema default, no
preset and nothing in CI that checks one template's card against another's, so the shape below is
the only definition of "the standard card" and a new template gets whatever the theme editor emitted
unless someone copies it. It has drifted silently once already: the cart card sat on the pre-standard
shape and, because its price block omitted `show_shipping_info`, restated the shipping policy under
every recommendation.

Copy these values when placing a product card, or copy the block wholesale out of
`templates/collection.json`:

| Level | Settings |
| --- | --- |
| `_product-card` | `product_card_gap: 8`, `inherit_color_scheme: false`, `color_scheme: "scheme-1"`, `border_radius: 24`, all four paddings `16` |
| `_product-card-gallery` | `image_ratio: "portrait"`, `border_radius: 8`, all four paddings `0` |
| `product-title` | `type_preset: "custom"`, `font: "var(--font-subheading--family)"`, `font_size: "1rem"`, `line_height: "tight"`, `color: "var(--color-foreground-heading)"`, `padding-block-start: 4` |
| `price` | `type_preset: "custom"`, `font: "var(--font-body--family)"`, `font_size: "0.875rem"`, `show_shipping_info: false` |

`templates/index.json`, `templates/collection.json`, `templates/search.json` and `templates/cart.json`
all match this. `templates/404.json` is the known holdout and is tracked in `TODO.md`; do not treat it
as a model. Section-level settings (which collection, column count, gaps, headers) are per-template
and deliberately not part of the standard.

## Coding standards

### Liquid

- Use `{% liquid %}` for multiline logic blocks.
- Inline variables in HTML attributes rather than declaring many upfront.
- All snippets require `{% doc %}` with `@param` and `@example`. Type in braces, optional params in brackets, nested as `object.property`.
- Translation keys: `{{ 'namespace.key' | t }}`. Schema-side: `t:names.<key>`.
- **NEVER edit `{% schema %}` blocks directly** when generated from source (see "Block-nesting gotchas" above).
- Use `{% assign %}` only when needed (complex filter params, reused calculations, deep logic). Use `{% capture %}` only for multi-line content that won't fit inline.

### CSS

- **BEM**: `.block__element--modifier`. Single-class selectors where possible. No IDs as selectors. Avoid `!important`. Logical properties (`padding-inline`, `margin-block`, `inset`) for RTL; container queries for responsive components.
- **CSS variables**: namespace to component (e.g. `--product-card-padding`). Apply per-section / per-block setting values via inline `style="--var: value"`; do not generate per-instance class names.
- Use `{% stylesheet %}` inside sections / blocks for scoped CSS. Standalone CSS in `assets/` is for shared / global styles. `@layer` order: resets → base → components → utilities.

### HTML

- IDs: CamelCase + section/block ID suffix, like `id="ProductModal-{{ section.id }}"`. The suffix is there to keep repeated blocks unique. **Exception: link anchors**, whose job is to be stable and hand-authorable, so they are bare. The only one today is `SizeChart` (`anchor_id` on `_accordion-row`, emitted by `scripts/size-chart/`, targeted by `snippets/size-guide-link.liquid` and by shared `#SizeChart` URLs). Do NOT "fix" it to `SizeChart-{{ block.id }}`; that silently breaks the size-guide link and every bookmarked link. `scripts/size-chart/test/anchor-contract.test.mjs` fails if you do. A second narrow exception: snippets rendered exactly once from `layout/theme.liquid` have no section or block ID to suffix with, so their IDs are bare singletons (today `VacationPopupHeading` in `snippets/vacation-popup.liquid` and `PolicyNavHeading` in `snippets/policy-page.liquid`). A third: `assets/policy-nav.js` slugifies every policy-body `h2` into a bare runtime ID (no Liquid ever sees them) and finishes an incoming `#hash` itself, so `/policies/...#section` links are supported customer-facing URLs. Unlike `SizeChart` they are only as durable as the heading wording: rewording changes the anchor and nothing checks sent links. For one that survives rewording, put an `id` in the Admin body: the component only assigns when a heading has none. That works on operator-authored policies, not the auto-managed privacy policy, whose body Shopify rewrites.

### JavaScript

- Zero external dependencies; native browser APIs. JSDoc types on params and returns. Component-framework conventions: see "Component framework" above.

