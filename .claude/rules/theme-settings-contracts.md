---
paths:
  - "snippets/social-links.liquid"
  - "blocks/social-links.liquid"
  - "blocks/_social-link.liquid"
  - "blocks/_footer-social-icons.liquid"
  - "snippets/structured-data-organization.liquid"
  - "snippets/meta-tags.liquid"
  - "snippets/shipping-info.liquid"
  - "snippets/cart-summary.liquid"
  - "snippets/cart-products.liquid"
  - "blocks/price.liquid"
  - "snippets/variant-main-picker.liquid"
  - "snippets/product-media-gallery-content.liquid"
  - "assets/variant-picker.js"
  - "sections/header.liquid"
  - "snippets/header-drawer.liquid"
  - "blocks/_header-menu.liquid"
  - "snippets/mega-menu-list.liquid"
  - "snippets/vacation-popup.liquid"
  - "blocks/_vacation-announcement.liquid"
  - "blocks/vacation-acknowledgment.liquid"
  - "blocks/_announcement.liquid"
  - "sections/header-announcements.liquid"
  - "blocks/accelerated-checkout.liquid"
  - "sections/faq.liquid"
  - "templates/page.faq.json"
  - "config/settings_schema.json"
  - "config/settings_data.json"
  - "marketing/policies/shipping_policy.html"
---

# Theme settings contracts

**Before changing any social, navigation, vacation-mode or shipping-copy setting, the shipping predicates in `snippets/shipping-info.liquid` / `snippets/cart-summary.liquid` / `snippets/cart-products.liquid` / `blocks/price.liquid`, or the fieldset-indexing logic in `snippets/variant-main-picker.liquid` / `assets/variant-picker.js`, read `docs/theme-settings-contracts.md`.** Every item below fails silently, and nothing in CI checks any of them:

1. **Adding a social platform means editing two hardcoded lists**, `social_platforms` in `snippets/social-links.liquid` and `social_keys` in `snippets/structured-data-organization.liquid`, or `sameAs` silently drifts from the storefront links. The one source of truth is `settings.social_*_link`, rendered only by `snippets/social-links.liquid`; `blocks/social-links.liquid`, `blocks/_social-link.liquid` and `blocks/_footer-social-icons.liquid` are dead upstream leftovers, so never edit them or place one.
2. **The main menu's collections dropdown is generated, not authored.** A top-level `catalog_link` / `collections_link` with no children builds its own submenu; giving that link even one child in Admin silently turns the generated list off, and a second catalog link silently gets a second dropdown.
3. **Never add a `settings.social_twitter_link`.** The setting alone reactivates a broken `twitter:site` handle parse that mishandles `x.com` URLs; `snippets/meta-tags.liquid` carries a comment saying so.
4. **Vacation mode is one toggle, four surfaces, four sync traps.** Four independently dated settings (popup body, checkbox terms, shipping note, `vacation_processing_date`) must be updated together before each enable; nothing reconciles them, and `vacation_processing_date` is the record of what each customer agreed to.
5. **Shipping copy has five sources of truth and only the Admin shipping-rate names sit outside the repo.** The `/policies/shipping-policy` body is `marketing/policies/shipping_policy.html`, so grep it too, but a grep proves the *intended* text, not the live one: a green `policies:check` proves repo consistency only, never that Admin is in sync (`policies:pull -- --check`). No product template may restate a duration; each defers to the policy, byte-identical, per `scripts/policies/test/templates-cohesion.test.mjs`.
6. **`requires_shipping` is the predicate for all shipping math and gating, never `cart.total_price`** (right for displaying a cart total, wrong for anything shipping): checkout excludes gift card value from its price-based rate conditions, so a mixed cart over the threshold is still charged the flat rate. Spellings differ by object: `product.gift_card?` carries the question mark, `item.gift_card` does not, and `product.gift_card` / `item.product.gift_card` are both nil with no error and no `theme-check` warning. Canonical shape: `snippets/shipping-info.liquid`.
7. **`data-fieldset-index` counts rendered fieldsets, not options.** An option collapsed by `settings.variant_dropdown_threshold` emits no fieldset, so numbering by `forloop.index0` in `snippets/variant-main-picker.liquid` silently no-ops or mutates the wrong fieldset when the collapsed option is not last.

**The FAQ page is its own silent-failure surface, and neither the structured-data trigger nor this file's opening trigger names it.** Before editing `sections/faq.liquid` or `templates/page.faq.json`, read the `FAQPage` rules in `docs/structured-data.md` (a new block type defining a `question` starts appearing in the markup with no other change, and rewording a question rewrites its `handleize`d anchor, breaking every shared link) and the vacation-mode entry in `docs/theme-settings-contracts.md` (the announcement slide, popup body and checkbox terms all deep-link to `/pages/faq#away-from-studio`, which resolves only while `faq_item_vacation` keeps `custom_anchor: "away-from-studio"`; nothing checks the link).

**Product media alt text drives the gallery.** `snippets/product-media-gallery-content.liquid` filters media by matching alt text against the values of that product's option named by `settings.color_option_name`, so those values are reserved words in alt text. The data lives in Admin, no test reaches it, and every failure is silent. Read `docs/product-media-alt-text.md` before authoring alt text or changing the filter.
