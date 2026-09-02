// Tier B checks: chrome-devtools MCP browser procedure, opt-in behind a STOP every run.
// No script runs these; the ids exist so the report and surfaces.md can name them.
// Side effects: browser session; checkout-reach creates an abandoned checkout in Admin.

export const B_CHECKS = [
  { id: 'b-product-variant-picker', tier: 'B', surface: 'product-page', severity: 'ERROR', description: 'Collapsed-dropdown variant picker and pill state follow the option chosen.' },
  { id: 'b-product-gallery-filter', tier: 'B', surface: 'product-page', severity: 'ERROR', description: 'The media gallery filters to the selected colour.' },
  { id: 'b-product-size-guide', tier: 'B', surface: 'product-page', severity: 'ERROR', description: 'The size-guide link opens the #SizeChart accordion row.' },
  { id: 'b-product-applique-required', tier: 'B', surface: 'product-page', severity: 'ERROR', description: 'The applique pattern select is required before add to cart.' },
  { id: 'b-product-custom-text-counter', tier: 'B', surface: 'product-page', severity: 'ERROR', description: 'The custom-text counter tracks input length and the max.' },
  { id: 'b-product-return-policy-gate', tier: 'B', surface: 'product-page', severity: 'ERROR', description: 'Add to cart is gated on the return-policy checkbox and express buttons hide until it is ticked.' },
  { id: 'b-product-vacation-checkbox', tier: 'B', surface: 'vacation', severity: 'ERROR', description: 'With vacation mode on, the vacation checkbox gates add to cart and posts the dated property.' },
  { id: 'b-product-request-combination', tier: 'B', surface: 'product-page', severity: 'ERROR', description: 'The request-combination modal opens on each of its three paths and targets /contact.' },
  { id: 'b-product-sticky-atc', tier: 'B', surface: 'product-page', severity: 'ERROR', description: 'The sticky add-to-cart bar appears on scroll and mirrors the form state.' },
  { id: 'b-product-judgeme', tier: 'B', surface: 'product-page', severity: 'WARN', description: 'The Judge.me widget renders (third-party; WARN only).' },
  { id: 'b-header-collections-dropdown', tier: 'B', surface: 'header', severity: 'ERROR', description: 'The generated collections dropdown lists every collection.' },
  { id: 'b-header-mobile-drawer', tier: 'B', surface: 'header', severity: 'ERROR', description: 'The mobile menu drawer opens, traps focus and closes.' },
  { id: 'b-header-announcement', tier: 'B', surface: 'header', severity: 'ERROR', description: 'The announcement carousel rotates and its pause control works.' },
  { id: 'b-header-search-modal', tier: 'B', surface: 'search', severity: 'ERROR', description: 'The predictive search modal opens and returns products.' },
  { id: 'b-header-account-popover', tier: 'B', surface: 'accounts', severity: 'ERROR', description: 'The account popover opens and links to the hosted account pages.' },
  { id: 'b-header-country-selector', tier: 'B', surface: 'header', severity: 'ERROR', description: 'The country selector lists the shipping countries.' },
  { id: 'b-cart-quantity-remove', tier: 'B', surface: 'cart', severity: 'ERROR', description: 'Cart-page quantity change and remove update the totals.' },
  { id: 'b-cart-progress-bar', tier: 'B', surface: 'cart', severity: 'ERROR', description: 'The free-shipping progress bar tracks the shippable subtotal.' },
  { id: 'b-cart-discount-hidden', tier: 'B', surface: 'cart', severity: 'ERROR', description: 'The discount-code disclosure is hidden (setting off).' },
  { id: 'b-cart-checkout-button', tier: 'B', surface: 'cart', severity: 'ERROR', description: 'The checkout button leads to checkout.' },
  { id: 'b-checkout-reach', tier: 'B', surface: 'checkout', severity: 'ERROR', description: 'Checkout shows the expected shipping options and tax line for the placeholder address; stops before payment (separate consent).' },
  { id: 'b-policy-jump-nav', tier: 'B', surface: 'policies', severity: 'ERROR', description: 'The policy jump nav builds at 3 or more h2s and hides otherwise.' },
  { id: 'b-faq-expand-deep-link', tier: 'B', surface: 'faq', severity: 'ERROR', description: 'FAQ expand-all works and /pages/faq#away-from-studio opens and scrolls to the item.' },
  { id: 'b-404', tier: 'B', surface: 'storefront-render', severity: 'ERROR', description: 'The 404 page renders the theme template with its product card.' },
  { id: 'b-password-page', tier: 'B', surface: 'storefront-render', severity: 'ERROR', description: 'While gated, the password page shows countdown, email signup and follow-us.' },
  { id: 'b-console-errors', tier: 'B', surface: 'storefront-render', severity: 'WARN', description: 'Console errors observed per page.' },
  { id: 'b-mobile-viewport', tier: 'B', surface: 'storefront-render', severity: 'ERROR', description: 'One mobile-viewport pass over product, cart and header.' },
];
