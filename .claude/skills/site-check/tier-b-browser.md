# Tier B: browser pass (chrome-devtools MCP)

Read this file only after a user message in this conversation, sent after the automated report,
said yes to the browser pass. Consent never carries over. Tools are the `mcp__chrome-devtools__*`
set: `navigate_page` (with `initScript`), `take_snapshot`, `click`, `fill`, `fill_form`,
`press_key`, `hover`, `wait_for`, `list_console_messages`, `resize_page`, `take_screenshot`,
`list_pages`, `select_page`, `close_page`. Nothing here needs another MCP server.

## Contents

- Scope and the two guard sets
- Session setup (password bypass, nonce, viewport)
- Per-check procedure (`b-*` ids in registry order)
- Checkout-reach (separate consent)
- Console errors and the mobile pass
- What the report records

## Scope

Site-check assertions only. Each check below asserts one customer-visible behaviour. Widget
role, attribute and keyboard contracts are **not** restated here: when a check names a widget
(accordion, modal, carousel, dropdown navigation, disclosure, combobox, jump nav, form, product
card, cart drawer), its contract is the matching entry in `docs/accessibility-patterns.md`, and
a deviation from that entry is a WARN finding pointing at the entry, not a rewrite of it.

Navigation allowlist: storefront URLs only, plus the Admin themes page for the Preview link.
No other Admin page, no Admin action, no Customize, no Edit code. A Preview URL carries `key=`,
which sets the password-bypass cookie for the whole browser session: it is a credential. Never
paste it into a committed file, a report, a PR, or a commit message; refer to it as "the Preview
link".

## Two guard sets

**Storefront guard** (every storefront page). The four seo-review guards plus a nonce:

1. Gate the `initScript` on `window.top === window`, or it executes in a CDN-origin frame and
   reports the Shopify CDN's own page.
2. Allow both the production hostname and `*.myshopify.com`; a production-only guard silently
   produces no output on a preview host, indistinguishable from a clean pass.
3. Log a start banner with the resolved hostname and the URL, so "no output" is diagnosable.
4. Confirm which theme is actually rendering via `Shopify.theme.id` before trusting any result;
   the served id goes in the report header and every finding is tagged with it.
5. **Per-run nonce**: generate one random token at the start of the pass and put it in the
   banner (`site-check <nonce> host=... url=... theme=...`). Only console lines carrying this
   run's nonce are evidence; anything else in the console (a stale page, an injected script, a
   line that merely looks like a banner) is not.

**Checkout guard** (checkout-reach only). A hostname allowlist: the storefront host,
`*.myshopify.com`, and the checkout host observed when the cart's checkout button is followed
(record it in the report; it is `checkout.shopify.com` or the shop's own domain under
`/checkouts/`). Any redirect to a host outside the list (a wallet, `shop.app`, an accounts host)
ends the checkout-reach step with a GATE finding. No theme-id assertion here: checkout does not
render the theme.

## Session setup

1. Storefront while LOCKED: open the Admin themes page, open the live theme's "more theme
   actions" menu, click **Preview**. The bypass cookie is now set for the session. If Admin
   login loops, stop; the workaround in CLAUDE.md > Browser testing is a manual operator step.
   While PUBLIC: navigate straight to the storefront.
2. Generate the nonce. Every `navigate_page` from here on carries an `initScript` that prints the
   banner (guarded as above) and, where the check needs it, computed state via `console.log`.
3. Desktop viewport first (`resize_page` 1280x900). The mobile pass is at the end.
4. After each page: `list_console_messages`, keep only nonce-tagged lines and `error`-level
   entries, then `take_snapshot` for the assertions below.

## Per-check procedure

For each check: the page, the steps, the assertion, and the evidence to keep (200 characters
max, extracted, never a whole body). Severity is the registry default unless stated.

### Product page (one garment template per body; the gift card for its own rows)

- `b-product-variant-picker`: on a product whose option count meets
  `settings.variant_dropdown_threshold`, the collapsed option renders as a dropdown and the rest
  as pills. Select a colour then a size; the pill state and the URL `?variant=` follow. Evidence:
  the selected option labels and the variant id. Widget contract: combobox / disclosure entries.
- `b-product-gallery-filter`: pick a second colour; the visible media set changes and every
  visible slide's alt contains that colour value (`docs/product-media-alt-text.md` explains the
  match). Evidence: colour value and visible slide count before and after.
- `b-product-size-guide`: click the size-guide link; the `#SizeChart` accordion row is open and
  in view (`details[open]`). Widget contract: accordion entry (native `<details>`, latch rule).
- `b-product-applique-required` (huddle template only): with no pattern selected, submit the
  form; the browser blocks with a validity message and no `/cart/add` request fires. Select one;
  the request carries `properties[Applique Pattern]`.
- `b-product-custom-text-counter` (lead-ii templates): type into the custom property field; the
  counter shows the length and the max, and stops at the max.
- `b-product-return-policy-gate` (every garment except the template without the block): with
  the checkbox unticked, add to cart is blocked and the accelerated-checkout container is hidden
  (`:has()` gate). Tick it; both open. Evidence: the property key posted with the add.
- `b-product-vacation-checkbox` (only when `settings.vacation_mode_enabled` is on): same shape as
  the return-policy gate; the posted value contains `vacation_processing_date`.
- `b-product-request-combination`: open the modal from each of its three paths (the sold-out
  variant path, the not-offered path, the explicit link); each opens a dialog whose form posts to
  `/contact`. Do not submit (hCaptcha; Tier C). Widget contract: modal entry.
- `b-product-sticky-atc`: scroll past the buy buttons; the sticky bar appears and mirrors the
  selected variant and price. Scroll back; it hides.
- `b-product-judgeme` (WARN only): the Judge.me widget mounts (its container is non-empty after
  `wait_for`). Third-party; never an ERROR.

### Header (from the homepage)

- `b-header-collections-dropdown`: open the generated collections submenu; it lists every
  collection A2 reported. Evidence: the list. Widget contract: dropdown navigation entry.
- `b-header-mobile-drawer` (mobile viewport): open the drawer; it is a dialog, Tab stays inside,
  Escape closes and focus returns to the launcher.
- `b-header-announcement`: the announcement carousel rotates (slide text changes within the
  interval) and its pause control stops it. Widget contract: carousel entry, including the
  deviation on file for it.
- `b-header-search-modal`: open search, type a catalogue term; predictive results include at
  least one product. Widget contract: modal + combobox entries.
- `b-header-account-popover`: open the account control; its links point at the hosted account
  host. Do not follow them.
- `b-header-country-selector`: open the selector; the country list equals A2's
  `markets-shipping-countries` list.

### Cart page

Add one garment (with its acknowledgment ticked) from the product page first; the theme
redirects to `/cart`.

- `b-cart-quantity-remove`: change quantity to 2 then back; remove the line; totals and the
  empty-cart state follow each step.
- `b-cart-progress-bar`: with a garment under the threshold the bar shows the remainder; add a
  gift card; the remainder does not move (gift-card value is not shippable subtotal).
- `b-cart-discount-hidden`: no discount-code disclosure is rendered (the setting is off).
- `b-cart-checkout-button`: the checkout button is enabled and its target is a checkout URL.
  Read the target only; following it is checkout-reach.

### Policies, FAQ, 404, password page

- `b-policy-jump-nav`: on the refund policy the "On this page" nav is visible with one link per
  `h2`; on terms of service it is hidden. Widget contract: jump nav entry.
- `b-faq-expand-deep-link`: expand-all opens every row; navigating to
  `/pages/faq#away-from-studio` lands with that row open and in view.
- `b-404`: a garbage path renders the theme 404 template (its heading and the product card).
- `b-password-page` (LOCKED only, in a fresh page without the bypass cookie): countdown, email
  signup and follow-us render. Do not submit the signup (Tier C).

## Checkout-reach (`b-checkout-reach`, separate consent)

Ask in its own message after every other B check has run. State the side effect plainly: this
creates an abandoned checkout in Admin and may send an abandoned-checkout email to the address
used. Only a yes in reply proceeds, and that reply is the only source of the real values behind
`<test-email>` and `<test-address>`: never a memory file, `.env`, a run file, a prior run, or
Admin. If the reply lacks either value, ask once and stop.

1. From `/cart` with one garment, click checkout. Apply the checkout guard from here.
2. Contact: `<test-email>`, an operator-owned plus-tagged address never used with Shop Pay
   (a Shop Pay match would jump to a wallet and leave the allowlist). Marketing checkbox
   unticked.
3. Address: `<test-address>`, a public non-residential address in the operator's state (a state
   office, a public library), never the fulfilment address and never a residential one.
4. Read the shipping options offered (names, prices) and the tax line. Compare with A2's
   `shipping-rate-conditions` and the cart copy. Evidence: the option names and amounts.
5. **Stop before payment.** Never enter a card, never click pay, never pick a wallet.
6. If the checkout challenge (captcha) blocks the automation browser, record a GATE and move the
   item to Tier C for this run: pass `--extra b-checkout-reach` to `runfile.mjs --write` so the
   run file carries a pre-written row for the operator.
7. Repeat once with a gift card added for the mixed-cart rate check if the operator asked for
   it; every checkout created is counted in the report so the operator can find and delete them.

## Console errors and the mobile pass

- `b-console-errors` (WARN): after every page, record `error`-level console entries, one finding
  per page, evidence the first message text. Ignore third-party origins by naming them.
- `b-mobile-viewport`: `resize_page` to 390x844 and repeat: one product page (picker, sticky
  bar, gate), the cart page, and the header drawer. Any assertion that held on desktop and fails
  here is its own finding tagged `mobile`.

## What the report records

Under `## Tier B`: the served theme id, the nonce, the pages visited (paths only), findings by
check id in NEW / RESOLVED / UNCHANGED order, the number of checkouts created (0 when
checkout-reach did not run), and any item moved to Tier C. Never the Preview link, never a cookie,
never the test email or address (use the placeholders), never a checkout URL.
