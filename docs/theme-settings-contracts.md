# Theme settings contracts

Full reference for the theme-settings surfaces whose failure modes are silent. CLAUDE.md's "Theme
settings" section carries the condensed, load-bearing index (trigger, failure mode, and file or
setting name for each); this file is the detailed reference for when you are actually changing a
social, navigation, vacation-mode, shipping-copy, or variant-fieldset setting.

## Authoring conventions

Global CSS variables in `snippets/theme-styles-variables.liquid`; color schemes via `color_scheme_group` in `config/settings_schema.json` rendered through `snippets/color-schemes.liquid`. `settings_schema.json` opens with a `theme_info` object. Presets that use nested blocks must declare a `block_order` array. Setting `label` text: under 30 characters, title case, no redundant type qualifier ("Columns", not "Number of columns").

## Social links

**Social links have one source of truth: `settings.social_*_link` (5 platforms), rendered only by `snippets/social-links.liquid`** (via `blocks/follow-us.liquid` in the footer's follow column, the homepage closing section, the About page's closing section, and the password page below its email signup, one placement per page region; directly in the mobile drawer and desktop header, both behind `header.show_social_icons`). It strips the query and fragment, then derives `@handle` from the last path segment; a `profile.php?id=`-style URL yields none and falls back to the platform name, so store vanity-slug URLs, claiming the slug on the platform rather than inventing one. A URL with no path past the host is skipped on the storefront *and* in `sameAs`, showing only as a disabled item in the editor. Adding a platform means editing two hardcoded lists, `social_platforms` here and `social_keys` in `snippets/structured-data-organization.liquid`, plus a glyph and locale keys. `blocks/social-links.liquid`, `blocks/_social-link.liquid`, and `blocks/_footer-social-icons.liquid` are dead upstream leftovers: never edit them; `social-links` is off the footer schemas but its own preset still offers it on generic `section` blocks, and placing one puts a rival URL set back into template JSON. Rationale: release-notes.md.

## The generated collections dropdown

**The main menu's collections dropdown is generated, not authored.** A top-level link with no children whose type is `catalog_link` or `collections_link`, on a store with at least one published collection, gets a submenu built from the global `collections` drop: desktop (`blocks/_header-menu.liquid` computes the trigger, `snippets/mega-menu-list.liquid` renders it, the "More" overflow reuses the same markup) and the mobile drawer (`snippets/header-drawer.liquid` recomputes it, in both the accordion and the flat branch, since `drawer_accordion` is `false` and flat is the live path). An authored submenu always wins, so giving that link one child in Admin silently turns the generated list off; a second catalog link silently gets a second dropdown. The list is plain text even under `collection_images` (no static children to read images from), is capped at 50 (Liquid's per-loop ceiling), and is ordered by the `collections` drop, which the operator cannot reorder. Every published collection's title is therefore storefront nav copy. Nothing in CI checks any of this: the menu lives in Admin, not the repo. Rationale: release-notes.md.

## No `social_twitter_link`

**There is deliberately no `social_twitter_link` setting.** `snippets/meta-tags.liquid` has a comment explaining why: re-adding the setting alone reactivates a broken `twitter:site` handle parse that does not handle `x.com` URLs.

## Vacation mode

**Vacation mode is one toggle, four surfaces, and four sync traps.** `settings.vacation_mode_enabled` drives the announcement slide, the once-per-session popup, the product-page delay checkbox, and the shipping-line note. (1) Four independently dated settings (popup body, checkbox terms, shipping note, `vacation_processing_date`) must be updated together before each enable; nothing reconciles them. `vacation_processing_date` is embedded in each order's acknowledgment property value ("Yes - processing begins after ..."), so it is the record of what the customer agreed to; keep it matching the message text. (2) `settings.vacation_property_label` is the line-item property key on orders; renaming it mid-vacation splits the acknowledgment across orders. (3) The vacation checkbox adds a second fail-closed `:has()` gate on `[ref='acceleratedCheckoutButtonContainer']`, composing with the return-policy gate (both documented in `blocks/accelerated-checkout.liquid`); express checkout shows only when neither is pending. (4) The announcement slide, popup-body default, and checkbox-terms default all deep-link to `/pages/faq#away-from-studio`, which resolves only while `faq_item_vacation` in `templates/page.faq.json` keeps `custom_anchor: "away-from-studio"`; nothing checks the link, so removing or re-anchoring that FAQ entry silently 404s-to-top every vacation surface. The Vacation Mode settings group deliberately uses literal English labels, matching the Shipping Information precedent. Full rationale: release-notes.md.

## Shipping copy

**Shipping copy has four sources of truth and only one is greppable.** (1) Theme settings `flat_rate_shipping` and `free_shipping_threshold`, read by `snippets/shipping-info.liquid`. (2) Inline HTML in template JSON with no locale keys: the "Shipping & Turnaround" accordion in the five garment product templates, the **"Delivery" accordion in `templates/product.gift-card.json`** (a sixth threshold claim, under a different heading, so a grep for "Shipping & Turnaround" does not find it), plus three answers in `templates/page.faq.json`. (3) The announcement slides in `sections/header-group.json`. (4) Two things outside the repo entirely: the Admin shipping-rate names (Settings > Shipping and delivery) and the Shopify shop policy at `/policies/shipping-policy`. A shipping-copy audit that only runs `git grep` misses the last two, which is how "Expedited" in the theme and "Express" at checkout coexisted. Read the out-of-repo half with:

```bash
node --env-file=.env --input-type=module -e '
import { createAdminClient } from "./scripts/blank-inventory/lib/admin.mjs";
const c = createAdminClient();
console.log(JSON.stringify(await c.gql(`{ shop { shopPolicies { type title body } } }`)));'
```

A campaign email would be a fifth source, and the only one that cannot be corrected after it is sent, so `marketing/emails/` templates deliberately link to the policy and FAQ pages instead of restating a rate, a threshold, or a turnaround.

`write_shipping` is not granted, so rate names are read-only from here and renaming is an operator task in Admin. Also note `blocks/price.liquid`'s `show_shipping_info` setting hardcodes "$8 flat rate shipping and free shipping over $75 threshold" in an editor `info` string, so it goes stale if either theme setting changes.

### `show_shipping_info`: product page yes, product card no

**The shipping note belongs under a product-page price and never under a product card, and nothing enforces that.** It is a per-block checkbox on `blocks/price.liquid`, so the rule lives entirely in each template's JSON. The six product templates set `show_shipping_info: true` on both their price blocks; `templates/index.json`, `collection.json`, `search.json`, `cart.json` and `404.json` set it to `false`. The schema default is `false`, so an omitted key now fails toward the card behaviour rather than the product-page one.

**Ticking it has three outcomes, not two.** `blocks/price.liquid` derives `is_gift_card` from `product_resource.gift_card?` and forwards it, so a gift card product renders a delivery line ("Delivered by email, no shipping") rather than the flat-rate or free-shipping sentence. That is why `templates/product.gift-card.json` sets the key `true` like the five garment templates but does not show what they show.

Two consequences worth knowing before changing either side:

- **A price block placed fresh from the editor onto a product page needs the checkbox ticked.** Seven presets embed a price block without the key, two of them product-page surfaces (`blocks/_product-details.liquid`, `sections/featured-product-information.liquid`). This is the accepted cost of the default being `false`: a missing shipping line is visible on the page being edited, whereas the old `true` default silently added the line to every new product card.
- **Do not audit this setting by grepping its name.** That enumerates the templates that opted in; the ones at risk are exactly the templates the name is absent from. Enumerate `"type": "price"` across `templates/` and subtract. Grepping the name is how `templates/404.json` was missed while `templates/cart.json` was being fixed. Rationale: release-notes.md.

### `requires_shipping` is the predicate, and `gift_card?` keeps its question mark

**All shipping math and gating turns on `requires_shipping`, never on `cart.total_price` and never on a gift-card check.** Checkout excludes digital gift card value from its price-based rate conditions: a gift card never enters a shipment, so the tiers evaluate the shippable merchandise subtotal. Verified at live checkout on 2026-08-31 ($65 garment + $50 gift card was charged the flat rate despite the $115 total). So `snippets/shipping-info.liquid` sums `final_line_price` over `requires_shipping` line items, and `snippets/cart-summary.liquid` gates the whole shipping block on the same predicate. Reading `cart.total_price` promises free shipping that checkout will not honour on a mixed cart, and nothing in CI catches it. Use `gift_card?` only where the copy is specifically about gift cards.

**Both bare `gift_card` accessors are nil, and Liquid renders nil as nothing.** On the product drop the property is `gift_card?`, with the question mark; `product.gift_card` is undefined. On a cart line item there is no `product.gift_card` at all. Neither raises, neither warns, and `theme-check` passes, so a condition written either way silently takes the wrong branch forever. Three sites shipped that bug here: `blocks/price.liquid` advertised flat-rate shipping on the gift card page, `snippets/cart-summary.liquid` showed the flat-rate line on a gift-card-only cart, and `snippets/cart-products.liquid` carried a clause that never excluded anything. Rationale: release-notes.md.

## `data-fieldset-index`

**`data-fieldset-index` counts rendered fieldsets, not options.** `assets/variant-picker.js` indexes `refs.fieldsets` with it, so `snippets/variant-main-picker.liquid` must keep the numbering dense: an option collapsed by `settings.variant_dropdown_threshold` emits no fieldset. Numbering by `forloop.index0` instead silently no-ops or, when the collapsed option is not last, mutates the wrong fieldset. Nothing in CI checks it; rationale: release-notes.md.
