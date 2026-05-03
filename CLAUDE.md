# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Screenshots

When the user references screenshots, or when troubleshooting any issue, always proactively check for the latest screenshot without waiting to be asked. Use this command to find the most recent file:

```bash
ls -t "/c/Users/Seth/Pictures/Screenshots/" | head -5
```

Then read the most recent file returned. The screenshots directory is `/c/Users/Seth/Pictures/Screenshots/` (use forward-slash path format, not backslash).

## Project Overview

This is a **custom Shopify theme based on Horizon**, Shopify's flagship theme. It uses the latest Liquid Storefronts features including theme blocks, following a server-rendered, progressive enhancement philosophy with native web platform features.

## Before Making Changes

**ALWAYS pull the latest theme from Shopify before making any changes** to ensure the local codebase is in sync with the live store:

```bash
shopify theme pull -s sapphire-shadow-studio --live
```

This is critical because merchants or apps may have made changes directly in the Shopify admin. Failing to pull first risks overwriting those changes.

## Shopify Best Practices

All code changes must follow Shopify's official best practices: https://shopify.dev/docs/storefronts/themes/best-practices

### Core Principles

- **Performance first**: Minimize JavaScript, leverage native browser capabilities, optimize for speed
- **Mobile-first design**: Prioritize mobile device experience as the majority of traffic is mobile
- **Accessibility built-in**: Design inclusively from the start, not as an afterthought
- **No deceptive practices**: No code obfuscation, no search engine manipulation
- **Merchant customization**: Provide flexible options for brand expression while keeping configuration intuitive

### Required Reading

**Design & Coding:**

#### [Templates, Sections, and Blocks](https://shopify.dev/docs/storefronts/themes/best-practices/templates-sections-blocks)

**Sections:**
- Structure templates so default content lives in a main section
- Ensure sections are fully customizable (add, remove, reorder)
- Use sections for layout and content control at the page/section-group level

**Blocks:**
- Scope theme settings to individual blocks
- Choose layouts that maintain logical flow regardless of block type or sequence
- Balance flexibility with simplicity—avoid excessive granularity

**Block Layout Do's:**
- Stack blocks vertically for hierarchical text content
- Stack horizontally with wrapping or sliding controls on narrow viewports
- Group related settings into single blocks to simplify editing
- Design layouts independent of specific block types/order

**Block Layout Don'ts:**
- Don't squeeze blocks into narrow viewports without wrapping
- Don't rely on specific block sequences to dictate grid layouts
- Don't create overly granular blocks (e.g., separate blocks for author, date, comments)

**App Blocks:** Include only when clear conversion use cases exist, layout won't break with unexpected types, and section purpose remains consistent

---

#### [Performance](https://shopify.dev/docs/storefronts/themes/best-practices/performance)

**JavaScript Optimization:**
- Minified bundle size must not exceed **16 KB**
- Prioritize HTML/CSS for core functionality; JavaScript is progressive enhancement only
- Wrap JS in function scope (IIFE pattern) to avoid global namespace collisions
- Avoid large frameworks (React, Angular, Vue) and utility libraries (jQuery)
- Use `defer` or `async` attributes to prevent parser-blocking
- Target modern browsers with >1% market share; skip polyfills for older browsers

**Images & Resources:**
- Use `image_tag` filter with srcset for responsive images
- Apply `loading: 'lazy'` to below-the-fold images; never lazy-load above-the-fold content
- Limit to **2 resource hints per template** using `preload_tag`
- Use system fonts to eliminate additional resource downloads
- Use import-on-interaction patterns for components not always needed

**CDN & Assets:**
- Host all assets on Shopify's CDN via `/assets` folder (enables HTTP/2 prioritization)

**Liquid Optimization:**
- Perform complex operations (sorting, filtering) before loops, not within them
- Use Shopify Theme Inspector for Chrome to identify slow-rendering code
- Use Theme Check to identify performance issues

**Lighthouse Requirements:**
- Minimum average score of **60** across home, product, and collection pages for Theme Store
- Formula: `[(product × 31) + (collection × 33) + (home × 13)] / 77`
- Use Shopify's Lighthouse CI GitHub action for continuous integration

##### [Platform-Level Optimizations](https://shopify.dev/docs/storefronts/themes/best-practices/performance/platform)

**CDN & Delivery:**
- Shopify CDN backed by Cloudflare with Brotli/gzip compression
- HTTP/3 and TLS 1.3 protocols
- Most assets load via `cdn.shopify.com`; storefront-specific content uses `{shop}.myshopify.com/cdn`

**Automatic Asset Versioning:**
- `asset_url` filter appends version numbers (e.g., `?v=1384022871`) for rapid cache invalidation
- Without this filter, changes may take 24+ hours to propagate
- Only the `v` parameter is recognized; arbitrary query parameters won't bypass caching

**Automatic Minification:**
- Shopify minifies CSS and ES5-valid JavaScript upon request
- Results cached until file updates
- Original files delivered if minification would increase size or extension is `.min.js`/`.min.css`

**Built-in Optimizations:**
- Speculation rules auto-injected to preload likely next pages (supporting browsers)
- `es-module-shims` polyfill included automatically for import map compatibility
- Storefront Renderer (SFR) improves performance for cache misses

**Pagination Limits:** Array pagination caps at 25,000 objects; counts above return 25,001

---

#### [Accessibility](https://shopify.dev/docs/storefronts/themes/best-practices/accessibility)

**WCAG 2.0 Core Principles:** Perceivable, Operable, Understandable, Robust

**Keyboard Navigation:**
- All interactive elements must be keyboard-accessible
- Focus indicators must be visible and consistent
- Focus order follows DOM sequence (top-to-bottom, left-to-right)
- Avoid positive `tabindex` values and `autofocus` attributes; use only `0` or `-1`
- Never rely on mouse hover for visibility or functionality
- Dropdowns: Enter/Space to open, Tab into menu, Escape to close and return focus

**Page Structure:**
- Set `lang` attribute on `<html>` element
- Enable viewport zooming; avoid `maximum-scale` and `user-scalable="no"`
- Include skip links with `tabindex="-1"` on main content
- Use `<h1>` through `<h6>` in sequential order
- Wrap navigation in `<nav>` elements; use `aria-current` for active items
- Avoid `role="menu"` for navigation; use semantic HTML

**Forms:**
- All fields require associated `<label>` with `for` attribute or `aria-label`
- Mark required inputs with `required` attribute
- Use `autocomplete` attributes for browser field population
- Apply `aria-describedby` to inputs with error messages
- Use `aria-live` for dynamic changes (price updates, form errors)

**Contrast Requirements:**
- Small text (<24px regular, <18.5px bold): **4.5:1** ratio
- Large text (≥24px regular, ≥18.5px bold): **3.0:1** ratio
- Icons and input borders: **3.0:1** ratio
- Never use color alone to convey information

**Media:**
- No autoplay for media content
- Provide closed captions and descriptive audio for videos
- Support Space key to pause/play media
- All `<img>` elements need `alt` attributes; use empty `alt=""` for decorative images

**Modals/Drawers:**
- Move focus to labeling element when opened
- Keep keyboard focus contained within modal
- Support Escape to close and restore focus
- Use `role="dialog"` to identify modals

**Touch Targets:** Primary touch targets must be at least **44×44 pixels**

---

#### [Design](https://shopify.dev/docs/storefronts/themes/best-practices/design)

**Merchant Experience:**
- Design sections tailored to target audience with template-specific functionality
- Minimize theme settings to essentials; avoid niche configurations
- Use blocks to improve section usability and enable content reordering
- Create empty states and placeholders that leverage existing store data
- Design "antifragile" components that look professional despite inconsistent assets
- Provide robust layouts regardless of content amount
- Prevent critical actions from being obscured by third-party floating elements

**Customer Experience:**
- Include sections for brand identity, value proposition, and differentiation
- Design prominent, discoverable navigation with clear menu interactions
- Emphasize product title, price, and buy button prominence
- Maintain consistent scale, spacing, weight, and layouts across all pages
- Limit steps required to make a purchase
- Enable accelerated checkout by default
- Optimize for mobile-first experience
- Use standard, recognizable iconography to minimize cognitive load

##### [Color System](https://shopify.dev/docs/storefronts/themes/best-practices/design/color-system)

**Color Schemes:**
- Group related elements and their colors in visually representative ways
- Create distinct yet visually balanced schemes
- Include elements used throughout the theme
- Prioritize optimizing for when multiple objects can share the same color reference
- Avoid overwhelming merchants with unnecessary granular color options

**Color Roles (10 required for ecosystem compatibility):**
- Use semantically predictable role names to prevent ambiguity
- Enable consistent scheme previews across Shopify ecosystem
- Allow predictable integration with third-party apps

**Implementation:**
- Apply color schemes consistently for optimal contrast, legibility, and accessibility
- Use clear, descriptive names that communicate each color picker's purpose
- Supplement with separate color settings for decorative elements without accessibility requirements
- Never hardcode colors on elements requiring accessible contrast ratios—always use configurable settings

---

#### [Deceptive Code Practices](https://shopify.dev/docs/storefronts/themes/best-practices/deceptive-code)

**Prohibited Practices (subject to Partner governance action):**

**Code Obfuscation:**
- Never convert clear, readable code into intentionally difficult-to-understand versions
- "There is no legitimate reason for developers to inject obfuscated code into themes"
- Obfuscation degrades site performance and hides behavior from users

**Search Engine Manipulation:**
- Never include code that misleads search engines about site content
- No cloaking (presenting different content to search engines than users)
- Never attempt to artificially improve page speed scores through deceptive means

---

**Tools & Build Processes:**

#### [Version Control](https://shopify.dev/docs/storefronts/themes/best-practices/version-control)

**Branch Strategy:**
- Connect `main` or `master` branch to store with published themes
- Use non-main branches for temporary campaigns/sales events
- When using build pipeline, establish a dedicated deploy branch separate from master

**Source and Compiled Code:**
- GitHub integration requires default theme folder structure (no custom `src`/`dist` directories)
- Recommended: Use separate branches with `git subtree` to extract compiled code
- "The only commits in production branches are updates to production code"
- Changes to compiled code must be manually backfilled into source code

**Alternative Approaches:**
- Separate repositories (for transitioning from source-only models)
- Mixed structure (`main.js` and `main.min.js` together)—risks merchant edits to compiled code
- Source-only versioning with CI/CD deployment (sacrifices GitHub integration tracking)

---

#### [File Transformation](https://shopify.dev/docs/storefronts/themes/best-practices/file-transformation)

**Common Transformations:**
- Stylesheet consolidation (combining scoped CSS into fewer bundles)
- SCSS preprocessing to Shopify-compatible CSS
- PostCSS (linting, variables, transpilation, vendor prefixing via Autoprefixer)
- Section modularization (separate Liquid, JS, CSS, JSON files before compilation)
- Critical CSS inlining for above-the-fold styles
- JavaScript bundling for reduced file sizes

**Managing Compiled Code:**
- Track changes when merchants/apps edit compiled files through admin
- Backfill merchant modifications from compiled to source code before recompilation

**Just-in-Time (JIT) Transformations:**
- Generate optimized runtime files on-demand from source code
- Eliminates backfilling overhead and maintains unified codebase
- Note: Shopify automatically minifies CSS and JavaScript files

---

#### [Theme Editor](https://shopify.dev/docs/storefronts/themes/best-practices/editor)

Build themes that integrate smoothly with the theme editor, providing merchants with a clear, intuitive, and powerful editing experience.

##### [Integrating Sections and Blocks](https://shopify.dev/docs/storefronts/themes/best-practices/editor/integrate-sections-and-blocks)

**Core Principle:** When the editor modifies sections/blocks, it dynamically updates the DOM without full page reloads. Associated JavaScript won't automatically re-execute.

**JavaScript Events (all bubble with `event.target`, `blockId`, `sectionId`, `load` details):**
- `shopify:section:load` — Section added or re-rendered; re-execute initialization code
- `shopify:section:unload` — Section deleted or re-rendering; cleanup listeners and variables
- `shopify:section:select` — Section selected; ensure it remains visible
- `shopify:section:deselect` — Section deselected
- `shopify:block:select` — Block selected; maintain visibility during selection
- `shopify:block:deselect` — Block deselected
- `shopify:inspector:activate` / `shopify:inspector:deactivate` — Preview inspector state changes

**Detection Methods:**

*Liquid:*
- `request.design_mode` — Returns `true` in theme editor
- `request.visual_preview_mode` — Detects preview mode

*JavaScript:*
- `Shopify.designMode` — `true` if in theme editor, `undefined` if not
- `Shopify.inspectMode` — `true` if preview inspector is active
- `Shopify.visualPreviewMode` — Detects visual preview mode

**Implementation Requirements:**
- Sections require `presets` in schema to be added via theme editor
- Blocks must include `shopify_attributes` property for proper targeting
- When a section/block is selected, it must become and remain visible while selected

##### [Preview Inspector](https://shopify.dev/docs/storefronts/themes/best-practices/editor/preview-inspector)

The preview inspector draws outlines around sections and blocks using `Element.getBoundingClientRect()`.

**CSS Guidelines:**
- **Avoid negative margins** to position blocks inside sections—blocks will show outside section outline
- Use `margin` or `gap` for spacing between blocks, **not padding** (causes outline misalignment)
- Remove hidden elements from DOM entirely or use `display: none`—visually hidden elements generate outlines without interactive elements

**Layout Considerations:**
- Deactivate fixed-position elements (sticky headers) when preview inspector is active
- Fixed elements can obstruct inspection experience

**Data Attributes:**
- Sections use `data-shopify-editor-section` attribute
- Blocks use `data-shopify-editor-blocks` attribute
- During duplication, ensure only target element retains these attributes

## Development Commands

```bash
# Linting and validation
shopify theme check

# Development server (requires Shopify CLI)
shopify theme dev

# Push theme to store
shopify theme push

# Pull theme from store
shopify theme pull
```

## Architecture

### Directory Structure

- **layout/** - Base templates (`theme.liquid`, `password.liquid`)
- **templates/** - JSON templates defining page structure with section/block composition
- **sections/** - Page sections with `{% schema %}` blocks for merchant configuration
- **blocks/** - Reusable theme blocks that can be nested (new Shopify architecture)
- **snippets/** - Reusable Liquid partials rendered with `{% render %}`
- **assets/** - CSS, JavaScript, and static files
- **locales/** - Translation files (`en.default.json` is required)
- **config/** - Theme settings schema and data

### Component Framework

JavaScript uses a custom web component framework in `assets/component.js`:

```javascript
import { Component } from '@theme/component';

class MyComponent extends Component {
  // Use refs for DOM element access
  refs = {}; // Auto-populated from ref="name" attributes

  // Declarative event handlers via on:click="/methodName"
  handleClick(event) { }
}
```

**Key patterns:**
- Use `ref="elementName"` attributes in HTML for element references
- Use `ref="items[]"` for array refs
- Use `on:eventname="/methodName"` for declarative event binding
- Events: click, change, select, focus, blur, submit, input, keydown, keyup, toggle

### Theme Blocks vs Snippets

- **Blocks** (`blocks/`): Have `{% schema %}` definitions, appear in theme editor, support nesting via `{% content_for 'blocks' %}`
- **Snippets** (`snippets/`): Pure Liquid partials with `{% doc %}` documentation, no schema

## Coding Standards

### Liquid

- Use `{% liquid %}` for multiline logic blocks
- Inline variables in HTML attributes rather than declaring many variables upfront
- All snippets require `{% doc %}` documentation with `@param` and `@example`
- Use translation keys: `{{ 'namespace.key' | t }}`
- **NEVER edit `{% schema %}` blocks directly** - schemas may be generated from source

### CSS

- **BEM naming**: `.block__element--modifier`
- **Single class selectors** (`0 1 0` specificity) where possible
- **CSS variables**: Namespace to component (e.g., `--product-card-padding`)
- **No IDs as selectors**, avoid `!important`
- **Logical properties**: Use `padding-inline`, `margin-block`, `inset` for RTL support
- **Container queries** for responsive components
- **Mobile-first** media queries (`min-width`)
- Use `{% stylesheet %}` tag in sections/blocks for scoped CSS

### JavaScript

- Zero external dependencies - use native browser APIs
- `const` over `let`, `for...of` over `.forEach()`
- `async/await` over `.then()` chaining
- Early returns over nested conditionals
- JSDoc type annotations for parameters and return types

### HTML

- Use native elements: `<details>`, `<dialog>`, `popover` attribute
- IDs use CamelCase with section/block ID suffix: `id="ProductModal-{{ section.id }}"`
- Semantic HTML with proper ARIA attributes
- `tabindex="0"` for custom interactive elements, never positive values

### Accessibility (Always Applied)

- Skip link required at page top
- `lang` attribute on `<html>`
- Viewport must allow zoom (no `maximum-scale=1.0` or `user-scalable=no`)
- Respect `prefers-reduced-motion`
- WCAG AA contrast ratios (4.5:1 normal text, 3:1 large text)
- Focus indicators on all interactive elements (`:focus-visible`)

### Translations

- Keys in `locales/en.default.json` (required), max 3 levels deep
- Schema translations in `locales/en.default.schema.json`
- Use snake_case for key names
- Translation key format: `'t:names.keyname'` for schemas

## Block Development

### Static Blocks
```liquid
{% content_for 'block', type: 'text', id: 'unique-id' %}
```

### Dynamic Blocks
```liquid
{% content_for 'blocks' %}
```

**Critical**: Only ONE `{% content_for 'blocks' %}` per file. Capture first if needed in multiple places.

### Block Structure
```liquid
{% doc %}
  Description and @example
{% enddoc %}

<div {{ block.shopify_attributes }} class="block-name">
  {{ block.settings.text }}
  {% content_for 'blocks' %}  {# if nesting blocks #}
</div>

{% stylesheet %}
  .block-name { }
{% endstylesheet %}

{% schema %}
{
  "name": "t:names.block_name",
  "settings": []
}
{% endschema %}
```

## Theme Settings

Global CSS variables are defined in `snippets/theme-styles-variables.liquid`.

Color schemes use `color_scheme_group` in `config/settings_schema.json` and are rendered via `snippets/color-schemes.liquid`.
