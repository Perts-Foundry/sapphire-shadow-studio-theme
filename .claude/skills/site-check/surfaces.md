# Surfaces

Every customer-facing surface the site-check skill covers, the tier that covers it, and the check
ids that tier can report. The `<surface-id>` argument to `/site-check` must be one of the surface
ids in the first column. The table is generated from `scripts/site-check/lib/registry.mjs`
(`node scripts/site-check/lib/regen-surfaces.mjs`); the contract test pins it, so edit the
registry, not the table.

Tiers: A3 repo consistency, A4 existing tools, A1 storefront probe, A2 Admin reads, B browser
(opt-in), C operator checklist. `scripts/site-check/README.md` explains each check id and its
severity; `tier-b-browser.md` and `tier-c-operator.md` hold the procedures for B and C.

<!-- registry:begin (generated from scripts/site-check/lib/registry.mjs; do not hand-edit) -->

| Surface | Tier | Check ids |
|---|---|---|
| storefront-render | A1 | `render-status`, `render-host`, `render-theme-id`, `render-theme-id-missing`, `render-gate`, `render-liquid-error`, `render-translation-missing`, `render-h1-count`, `render-marker-missing`, `render-coverage`, `sitemap-unreadable`, `retry-budget-exhausted` |
| storefront-render | B | `b-404`, `b-password-page`, `b-console-errors`, `b-mobile-viewport` |
| json-endpoints | A1 | `product-json-status`, `product-json-not-json`, `product-json-variant-count`, `product-json-requires-shipping`, `product-json-weight-zero`, `product-json-sold-out`, `collection-json`, `search-suggest`, `recommendations`, `not-found-status` |
| cart | A1 | `cart-precondition`, `cart-add`, `cart-add-422`, `cart-roundtrip`, `cart-update-quantity`, `cart-remove`, `cart-gift-card-shipping`, `cart-threshold-predicate`, `cart-render-shipping-copy`, `cart-property-keys-mismatch`, `cart-throttled`, `cart-clear` |
| cart | B | `b-cart-quantity-remove`, `b-cart-progress-bar`, `b-cart-discount-hidden`, `b-cart-checkout-button` |
| shipping | A3 | `announcement-amounts`, `template-shipping-amounts` |
| shipping | A2 | `shipping-profiles-read`, `shipping-rates-mismatch`, `shipping-rate-conditions`, `markets-shipping-countries` |
| product-page | B | `b-product-variant-picker`, `b-product-gallery-filter`, `b-product-size-guide`, `b-product-applique-required`, `b-product-custom-text-counter`, `b-product-return-policy-gate`, `b-product-request-combination`, `b-product-sticky-atc`, `b-product-judgeme` |
| header | B | `b-header-collections-dropdown`, `b-header-mobile-drawer`, `b-header-announcement`, `b-header-country-selector` |
| navigation | A2 | `menu-catalog-children` |
| search | B | `b-header-search-modal` |
| checkout | A2 | `digital-wallets` |
| checkout | B | `b-checkout-reach` |
| policies | A2 | `policy-missing`, `policy-empty`, `policy-shipping-amounts` |
| policies | B | `b-policy-jump-nav` |
| faq | B | `b-faq-expand-deep-link` |
| vacation | A3 | `vacation-date-sync`, `vacation-date-format`, `vacation-faq-anchor` |
| vacation | B | `b-product-vacation-checkbox` |
| vacation | C | `c-vacation-surfaces` |
| catalogue | A3 | `catalogue-template-missing`, `catalogue-template-blocks` |
| templates | A3 | `price-show-shipping-info` |
| locales | A3 | `locale-key-missing`, `locale-key-todo` |
| locales | A2 | `locales-published` |
| social | A3 | `social-list-parity` |
| tooling | A4 | `tool-seo-surface`, `tool-seo-crawl`, `tool-smoke-dry-run`, `tool-contrast-lint`, `tool-theme-check` |
| admin-config | A2 | `admin-scope-missing`, `admin-partial-response`, `shop-currency`, `shop-gift-cards` |
| products-admin | A2 | `variant-weight`, `variant-requires-shipping`, `variant-sku-missing`, `variant-unavailable`, `variant-inventory`, `product-template-suffix`, `product-status`, `product-media-count`, `product-breadcrumb-metafield` |
| orders | C | `c-orders-precondition`, `c-orders-under-threshold`, `c-orders-over-threshold`, `c-orders-gift-card-only`, `c-orders-mixed`, `c-orders-expedited`, `c-orders-discount-code`, `c-orders-express-wallet`, `c-orders-properties`, `c-orders-note`, `c-orders-teardown` |
| lifecycle | C | `c-lifecycle-capture`, `c-lifecycle-fulfil`, `c-lifecycle-partial-refund`, `c-lifecycle-cancel`, `c-lifecycle-return`, `c-lifecycle-reorder` |
| notifications | C | `c-notifications-received`, `c-notifications-headers` |
| forms | C | `c-forms-contact`, `c-forms-request-combination`, `c-forms-newsletter`, `c-forms-blog-comment` |
| accounts | A2 | `customer-accounts-version` |
| accounts | B | `b-header-account-popover` |
| accounts | C | `c-accounts-signup`, `c-accounts-login`, `c-accounts-order-view`, `c-accounts-addresses`, `c-accounts-marketing` |
| flow | C | `c-flow-low-stock`, `c-flow-auto-cancel`, `c-flow-inventory-sync` |
| admin-settings | C | `c-admin-capture-mode`, `c-admin-gift-card-expiry`, `c-admin-checkout-account`, `c-admin-notification-sender`, `c-admin-skipped-reads` |
| devices | C | `c-devices-ios`, `c-devices-android`, `c-devices-apple-wallet` |
| launch | C | `c-launch-smoke-public`, `c-launch-a1-public` |

<!-- registry:end -->
