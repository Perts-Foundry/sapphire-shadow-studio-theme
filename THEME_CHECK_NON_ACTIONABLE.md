# Theme Check: Non-Actionable Findings

**Last Updated:** May 3, 2026
**Theme Version:** Horizon (Custom)
**Remaining Non-Actionable Findings:** 20 warnings (3 errors moved to suppressed-via-config as of 2026-05-03)

## Overview

This document catalogs all non-actionable findings from Shopify Theme Check. These findings are either false positives, app-managed content, or intentional design decisions that do not require code changes.

All genuinely actionable issues have been resolved. The remaining findings documented here are safe to ignore.

### Suppressed-via-config

As of the CI/CD cutover (2026-05-03), the JSONMissingBlock check is **disabled in `.theme-check.yml`** so that the known false-positive errors from Judge.me Reviews app blocks do not block PRs under `validate.yml`'s `--fail-level error` gate. The findings are still documented below for historical context. Re-enable the check if Judge.me is uninstalled.

The MatchingTranslations check is also **disabled** as of the comment-driven deploy refactor (2026-05-04). Horizon ships a wide locale matrix and Shopify's translators add keys at different paces per language, so non-English locale files legitimately drift behind `en.default.json` between upstream merges. The newer Shopify CLI's theme-check engine (used by `validate.yml`) flags this as cross-locale key mismatch errors; the older `Shopify/theme-check-action@v2.2.0` did not. Canonical source is `en.default.json`; stale-but-non-empty translations in other locales are acceptable for a downstream theme.

---

## Suppressed Errors (formerly Errors, now disabled in config)

### 1. JSONMissingBlock - Judge.me Reviews App Blocks

**Severity:** Disabled in `.theme-check.yml` (was Error)
**Count:** 3 block types, repeated once per product template
**Files:** every `templates/product.*.json` (one per product; there is no shared `templates/product.json`)

#### Details

Each per-product template carries the same three Judge.me app-block references. Line numbers differ per
template, so locate them by block type rather than by line:

```
shopify://apps/judge-me-reviews/blocks/preview_badge/61ccd3b1-a9f2-4160-9fe9-4fec8413e5d8
shopify://apps/judge-me-reviews/blocks/medals/61ccd3b1-a9f2-4160-9fe9-4fec8413e5d8
shopify://apps/judge-me-reviews/blocks/review_widget/61ccd3b1-a9f2-4160-9fe9-4fec8413e5d8
```

Find every occurrence with `git grep -n judge-me-reviews templates/`.

#### Why Not Actionable

These are **app blocks** provided by the Judge.me Reviews app (App ID: `61ccd3b1-a9f2-4160-9fe9-4fec8413e5d8`). App blocks use the URL scheme `shopify://apps/{app-handle}/blocks/{block-type}/{app-id}` and are served dynamically by the installed app, not stored in the theme's `blocks/` directory.

The Theme Check linter cannot access app-provided blocks, which causes these false errors. This is expected and documented behavior for Shopify app blocks.

#### References

- [Shopify App Blocks Documentation](https://shopify.dev/docs/apps/online-store/theme-app-extensions)
- [Judge.me Reviews App](https://apps.shopify.com/judgeme)

#### Resolution

**No action required.** These blocks will render correctly when the Judge.me app is installed and active on the store.

---

## Warnings (20 total)

### 2. RemoteAsset - Internal Anchor Links

**Severity:** Warning
**Count:** 2 occurrences
**Files:** `layout/password.liquid:21`, `layout/theme.liquid:21`

#### Details

```liquid
<link
  rel="expect"
  href="#MainContent"
  blocking="render"
  id="view-transition-render-blocker"
>
```

#### Why Not Actionable

The Theme Check linter flags `href="#MainContent"` as a "remote asset" that should use `asset_url` filters. This is a **false positive**.

The code uses an internal anchor link (`#MainContent`) with the `rel="expect"` attribute, which is part of the HTML Speculation Rules API for view transitions. This is:

1. **Not a remote asset** - it's a document fragment identifier
2. **Correct modern web platform code** - used for optimizing page transitions
3. **Part of Shopify's performance optimization** - enables smooth navigation between pages

The `rel="expect"` with `blocking="render"` ensures the main content loads before the view transition completes, preventing layout shift.

#### References

- [HTML rel="expect" Specification](https://html.spec.whatwg.org/multipage/semantics.html#link-type-expect)
- [View Transitions API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transitions_API)

#### Resolution

**No action required.** This is correct, production-ready code. The linter's remote asset detection is not sophisticated enough to distinguish between external URLs and internal anchor links.

---

### 3. UndefinedObject: 'back' Variable

**Severity:** Warning
**Count:** 1 occurrence
**File:** `snippets/localization-form.liquid:51`

#### Details

```liquid
{%- form 'localization',
  id: 'LocalizationForm',
  class: 'localization-form',
  ref: 'form',
  return_to: back,
  aria-label: localization_label
-%}
```

#### Why Not Actionable

The variable `back` is intentionally undefined. This is a **design pattern** that leverages Liquid's behavior with undefined variables.

**How it works:**
- In Liquid, undefined variables render as empty strings
- `return_to: back` becomes `return_to: ""`
- An empty `return_to` parameter causes the form to use its **default redirect behavior**
- For localization forms, the default is to stay on the current page

**Why this approach:**
The snippet is designed to be flexible. If needed, callers can pass a `back` parameter to override the redirect:

```liquid
{% render 'localization-form', back: request.path, ... %}
```

If no `back` parameter is provided, it gracefully falls back to default behavior.

#### Alternative Implementation

If you want to eliminate the warning, you could:

```liquid
return_to: back | default: "",
```

However, this is purely cosmetic and provides no functional benefit.

#### References

- [Shopify Liquid: form tag](https://shopify.dev/docs/api/liquid/tags/form)
- [Liquid Variable Default Filter](https://shopify.dev/docs/api/liquid/filters/default)

#### Resolution

**No action required.** This is intentional design that works correctly in production. The warning is cosmetic only.

---

### 4. UndefinedObject: Valid Liquid Objects in Snippets

**Severity:** Warning
**Count:** 17 occurrences
**Multiple files**

#### Affected Objects and Locations

##### `policy` object (2 warnings)
- `sections/main-policy.liquid:16` - `{{ policy.title }}`
- `sections/main-policy.liquid:41` - `{{ policy.body }}`

##### `comment` object (1 warning)
- `snippets/blog-comment-form.liquid:52` - `comment.status`

##### `block` object (9 warnings)
- `sections/header.liquid:182, 255` - `block.id`
- `snippets/divider.liquid:24` - `block.shopify_attributes`
- `snippets/jumbo-text.liquid:12, 61` - `block.settings`, `block.shopify_attributes`
- `snippets/product-media-gallery-content.liquid:232, 239` - `block` parameter
- `snippets/quantity-selector.liquid:40` - `block.shopify_attributes`

##### `section` object (5 warnings)
- `snippets/cart-summary.liquid:142` - `section.id`
- `snippets/product-media-gallery-content.liquid:232, 239` - `section` parameter
- `snippets/variant-main-picker.liquid:12, 22, 50` - `section.settings`, `section.id`

#### Why Not Actionable

These are **false positives** caused by Theme Check's static analysis limitations. All flagged objects are valid Shopify Liquid objects that exist in their proper runtime contexts.

##### The Issue with Static Analysis

Theme Check analyzes files in isolation and cannot determine:
1. What variables are passed to snippets via `{% render %}` parameters
2. What objects are available in the template/section context where snippets are rendered
3. The full scope chain when snippets render other snippets

##### Why These Are Valid

**`policy` object:**
- Available in policy templates (`templates/policy.liquid`; Shopify refuses a JSON policy template)
- Documentation: [Shopify Liquid: policy object](https://shopify.dev/docs/api/liquid/objects/policy)
- Properties: `title`, `body`, `id`, `url`

**`block` object:**
- Available when iterating through `section.blocks` or within block rendering contexts
- Passed explicitly to snippets via parameters: `{% render 'snippet', block: block %}`
- Documentation: [Shopify Liquid: block object](https://shopify.dev/docs/api/liquid/objects/block)
- Properties: `id`, `type`, `settings`, `shopify_attributes`

**`section` object:**
- Available globally within section files
- Passed explicitly to snippets via parameters: `{% render 'snippet', section: section %}`
- Documentation: [Shopify Liquid: section object](https://shopify.dev/docs/api/liquid/objects/section)
- Properties: `id`, `settings`, `blocks`, etc.

**`comment` object:**
- Available when iterating through `article.comments`
- Used in blog comment contexts
- Documentation: [Shopify Liquid: comment object](https://shopify.dev/docs/api/liquid/objects/comment)
- Properties: `author`, `content`, `created_at`, `status`, etc.

#### Example: Why snippets/header.liquid warnings are incorrect

```liquid
# In sections/header.liquid (line 177)
{% render 'localization-form',
  show_country: show_country,
  show_language: show_language,
  block_id: block.id        # block IS defined in section context
%}
```

The linter sees `block.id` at line 182 inside the snippet and flags it as undefined because it's analyzing the snippet file independently. In reality, `block` is:
1. Available in the section's scope (all sections have access to `section.blocks`)
2. Passed explicitly as a parameter (`block_id: block.id`)

#### References

- [Shopify Liquid Objects Reference](https://shopify.dev/docs/api/liquid/objects)
- [Theme Architecture: Sections and Blocks](https://shopify.dev/docs/storefronts/themes/architecture/sections)
- [Rendering Snippets with Parameters](https://shopify.dev/docs/api/liquid/tags/render)

#### Resolution

**No action required.** All flagged objects are valid and work correctly in production. The warnings are a limitation of static analysis tools, not actual code issues.

---

## Lighthouse (not Theme Check)

These are not Theme Check offenses; they surface in a Lighthouse audit of the rendered
storefront. Recorded here because the root cause is a Shopify Liquid filter's fixed output,
not something theme code can override.

### 5. image-alt - Hero video poster `<img>`

**Severity:** Lighthouse accessibility audit (`image-alt`)
**Source:** `sections/hero.liquid` hero video (via the `video_tag` filter)

#### Details

The hero uses `{{ section.settings.video_1 | video_tag: poster: nil, ... }}`. Shopify's
`video_tag` filter always emits a trailing poster `<img>` inside the `<video>` element:

```html
<video ... poster="//.../preview.jpg"><source ...><img src="//.../preview.jpg"></video>
```

That inner `<img>` has no `alt` attribute, which Lighthouse flags as `image-alt`.

#### Why Not Actionable

`video_tag` exposes only an `image_size` parameter; it has no `alt` parameter, and the
`poster:` argument sets only the poster URL, not the inner `<img>`'s `alt`. Setting the
media's alt text in Admin adds an `aria-label` to the `<video>` element (a real screen-reader
improvement, tracked as an optional Admin task in `TODO.md`), but it does not add `alt` to the
generated `<img>`. The element is filter-internal and cannot be reached from theme code without
abandoning `video_tag` and hand-rolling the `<video>`/`<source>` markup, which the project
declined as a hack that trades a cosmetic audit line for real fragility (source-format
handling, quality tiers).

#### References

- [Liquid filters: video_tag](https://shopify.dev/docs/api/liquid/filters/video_tag)

#### Resolution

**No action required in theme code.** Optionally set the video media's alt text in Admin for the
`<video>` `aria-label`. Revisit if Shopify adds `alt` support to `video_tag`.

**Status update:** largely resolved. `snippets/hero-video.liquid` now hand-rolls the
`<video>`/`<source>` markup in order to cap the rendition at 720p, and emits the fallback `<img>`
itself with an `alt` drawn from the media's alt text. The `video_tag` path survives only as the
fallback for a video with no rendition at or below the ceiling, so this finding applies only to
that branch.

---

## Warnings, continued

### 6. AssetPreload - Hero video poster preload

**Severity:** Warning
**Count:** 1 occurrence
**File:** `snippets/hero-video.liquid`

#### Details

The hero video preloads its poster frame with a hand-written tag:

```liquid
<link rel="preload" as="image" fetchpriority="high" href="{{ poster_url }}">
```

Theme Check reports: *"For better performance, prefer using the preload argument of the
`image_tag` filter."*

#### Why Not Actionable

Neither filter the check steers toward can express this preload.

`image_tag`'s `preload` argument emits an `<img>` alongside the preload. The resource being
preloaded here is a `<video>` element's `poster`, not an `<img>`, so using `image_tag` would add a
second, visible image to the page rather than replacing anything.

`preload_tag` is the filter that emits a bare `<link rel="preload">`, but its documented input
must come from `asset_url`, `global_asset_url`, or `shopify_asset_url`. A poster derivative comes
from `image_url` against a merchant-uploaded video's `preview_image`, which is not one of those,
and `preload_tag` also has no `fetchpriority` parameter.

The `fetchpriority="high"` is the entire point of the tag: a `poster` attribute is fetched at Low
priority and cannot carry `fetchpriority` itself, which on a throttled mobile connection measured
as 1529 ms of load delay for a file that downloads in under a millisecond.

#### References

- [Liquid filters: preload_tag](https://shopify.dev/docs/api/liquid/filters/preload_tag)
- [Liquid filters: image_tag](https://shopify.dev/docs/api/liquid/filters/image_tag)

#### Resolution

**No action required.** Revisit if `preload_tag` gains `fetchpriority` support and accepts
`image_url` output.

---

## Summary

| Finding Type | Count | Actionable? | Reason |
|-------------|-------|-------------|---------|
| JSONMissingBlock (App blocks) | 3 | No | App-provided content, not theme files |
| RemoteAsset (Internal anchors) | 2 | No | False positive - valid HTML anchor links |
| UndefinedObject: 'back' | 1 | No | Intentional design - undefined renders as empty string |
| UndefinedObject: Valid objects | 17 | No | False positives from static analysis limitations |
| image-alt (Lighthouse, video poster) | 1 | No | `video_tag` filter output; no `alt` param, filter-internal `<img>` |
| AssetPreload (hero poster preload) | 1 | No | No filter emits a `<link rel="preload">` with `fetchpriority` for an `image_url` derivative |
| **Total (Theme Check)** | **23** | **No** | All findings documented and justified |

---

## Theme Check Results

### Current Status
```
307 files inspected
23 total offenses found across 13 files
3 errors, 20 warnings
```

### Improvement History
- **Initial:** 89 offenses (4 errors, 85 warnings) across 16 files
- **After fixes:** 23 offenses (3 errors, 20 warnings) across 13 files
- **Reduction:** 74% reduction in total offenses
- **Date:** February 2, 2026

### What Was Fixed
1. ✅ Duplicate static block IDs (2 errors)
2. ✅ Missing schema translations (1 error + 20 warnings)
3. ✅ Temporary AI-generated files (1 error + 66 warnings)
4. ✅ Unused variable assignments (1 warning)
5. ✅ Unused documentation parameters (3 warnings)

---

## Notes for Future Developers

### When to Revisit This Document

- **Judge.me app removed:** If the Judge.me Reviews app is uninstalled, remove the app block references from every `templates/product.*.json` to eliminate the JSONMissingBlock errors
- **Theme Check updates:** Future versions of Theme Check may fix the false positive detection, reducing warnings
- **Code refactoring:** If refactoring snippets, consider the context where they're used to avoid introducing actual undefined object issues

### How to Verify Findings Are Still Non-Actionable

1. Run `shopify theme check`
2. Compare output against this document
3. If new findings appear, investigate whether they're actionable
4. Update this document if the non-actionable status changes

### Suppressing Warnings (Not Recommended)

You can add `# theme-check-disable` comments to suppress specific warnings, but this is **not recommended** for these findings because:
- It clutters the code
- The warnings don't affect functionality
- It makes actual issues harder to spot
- This document already provides the rationale

---

## Additional Resources

### Shopify Documentation
- [Theme Check Tool](https://shopify.dev/docs/themes/tools/theme-check)
- [Liquid Reference](https://shopify.dev/docs/api/liquid)
- [Theme Architecture](https://shopify.dev/docs/storefronts/themes/architecture)

### Best Practices
- [Shopify Theme Best Practices](https://shopify.dev/docs/storefronts/themes/best-practices)
- [Performance Optimization](https://shopify.dev/docs/storefronts/themes/best-practices/performance)
- [Accessibility Guidelines](https://shopify.dev/docs/storefronts/themes/best-practices/accessibility)

---

*This document is maintained as part of the theme's quality assurance process. It should be reviewed whenever theme check results change significantly.*
