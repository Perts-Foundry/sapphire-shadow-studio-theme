// Tier A3 checks: repo-only cross-checks, run by consistency.mjs. Side effects: none.
// Lane A3 owns this file.

export const A3_CHECKS = [
  { id: 'announcement-amounts', tier: 'A3', surface: 'shipping', severity: 'ERROR', description: 'Announcement-bar amounts (flat rate, threshold) do not match theme settings as ordered pairs.' },
  { id: 'template-shipping-amounts', tier: 'A3', surface: 'shipping', severity: 'ERROR', description: 'Product-template accordion or FAQ copy states a shipping amount that differs from settings.' },
  { id: 'vacation-date-sync', tier: 'A3', surface: 'vacation', severity: 'ERROR', description: 'With vacation mode enabled, the four dated settings do not share one date string.' },
  { id: 'vacation-date-format', tier: 'A3', surface: 'vacation', severity: 'WARN', description: 'The vacation date string does not match the pinned format.' },
  { id: 'vacation-faq-anchor', tier: 'A3', surface: 'vacation', severity: 'ERROR', description: 'faq_item_vacation no longer carries custom_anchor "away-from-studio", or a vacation surface links elsewhere.' },
  { id: 'price-show-shipping-info', tier: 'A3', surface: 'templates', severity: 'ERROR', description: 'A price block show_shipping_info value is wrong for its template (garments true, gift card exempt, non-product false, absent key reported).' },
  { id: 'catalogue-template-missing', tier: 'A3', surface: 'catalogue', severity: 'ERROR', description: 'A catalogue product has no matching product template file.' },
  { id: 'catalogue-template-blocks', tier: 'A3', surface: 'catalogue', severity: 'ERROR', description: 'A product template lacks a block its product type requires.' },
  { id: 'social-list-parity', tier: 'A3', surface: 'social', severity: 'ERROR', description: 'social_platforms in snippets/social-links.liquid and social_keys in snippets/structured-data-organization.liquid differ.' },
  { id: 'locale-key-missing', tier: 'A3', surface: 'locales', severity: 'WARN', description: 'A storefront key in en.default.json is absent from it.json or ro.json.' },
  { id: 'locale-key-todo', tier: 'A3', surface: 'locales', severity: 'INFO', description: 'A mirrored locale key still carries a TODO: placeholder.' },
];
