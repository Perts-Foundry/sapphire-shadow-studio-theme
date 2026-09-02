// Tier A2 checks: Admin GraphQL reads, run by config.mjs behind the read-only client guard.
// Side effects: none. Lane A2 owns this file.

export const A2_CHECKS = [
  { id: 'admin-scope-missing', tier: 'A2', surface: 'admin-config', severity: 'SKIPPED', description: 'A read was skipped because the app does not grant the named scope (subject = scope).' },
  { id: 'admin-partial-response', tier: 'A2', surface: 'admin-config', severity: 'ERROR', description: 'A GraphQL response carried errors alongside data, or reported a page that was not followed; never treated as complete.' },

  { id: 'shipping-profiles-read', tier: 'A2', surface: 'shipping', severity: 'ERROR', description: 'deliveryProfiles could not be read or returned no rate.' },
  { id: 'shipping-rates-mismatch', tier: 'A2', surface: 'shipping', severity: 'WARN', description: 'The set of Admin rate amounts / rate-name tokens differs from theme settings and copy; both sets printed.' },
  { id: 'shipping-rate-conditions', tier: 'A2', surface: 'shipping', severity: 'INFO', description: 'Rate conditions (price and weight tiers) as read from Admin.' },

  { id: 'variant-weight', tier: 'A2', surface: 'products-admin', severity: 'ERROR', description: 'A shippable variant weighs 0 or nil (unit reported).' },
  { id: 'variant-requires-shipping', tier: 'A2', surface: 'products-admin', severity: 'ERROR', description: 'requiresShipping does not match the product type.' },
  { id: 'variant-sku-missing', tier: 'A2', surface: 'products-admin', severity: 'WARN', description: 'A variant has no SKU.' },
  { id: 'variant-unavailable', tier: 'A2', surface: 'products-admin', severity: 'WARN', description: 'A variant is not availableForSale.' },
  { id: 'variant-inventory', tier: 'A2', surface: 'products-admin', severity: 'INFO', description: 'Inventory quantity summed per product (INFO).' },

  { id: 'policy-missing', tier: 'A2', surface: 'policies', severity: 'ERROR', description: 'A shop policy the theme links does not exist.' },
  { id: 'policy-empty', tier: 'A2', surface: 'policies', severity: 'ERROR', description: 'A linked shop policy has an empty body.' },
  { id: 'policy-shipping-amounts', tier: 'A2', surface: 'policies', severity: 'WARN', description: 'The shipping policy amount set differs from theme settings.' },

  { id: 'locales-published', tier: 'A2', surface: 'locales', severity: 'ERROR', description: 'Published locale count is not exactly one.' },
  { id: 'markets-shipping-countries', tier: 'A2', surface: 'shipping', severity: 'WARN', description: 'Markets / shipping countries disagree with the header show_country setting.' },
  { id: 'shop-currency', tier: 'A2', surface: 'admin-config', severity: 'INFO', description: 'shop.currencyCode as read from Admin.' },
  { id: 'shop-gift-cards', tier: 'A2', surface: 'admin-config', severity: 'ERROR', description: 'shop.features.giftCards is off while a gift-card product is sold.' },
  { id: 'customer-accounts-version', tier: 'A2', surface: 'accounts', severity: 'INFO', description: 'shop.customerAccountsV2 version.' },
  { id: 'digital-wallets', tier: 'A2', surface: 'checkout', severity: 'INFO', description: 'paymentSettings.supportedDigitalWallets.' },

  { id: 'product-template-suffix', tier: 'A2', surface: 'products-admin', severity: 'ERROR', description: 'An ACTIVE product has no templateSuffix or one the catalogue does not declare.' },
  { id: 'product-status', tier: 'A2', surface: 'products-admin', severity: 'WARN', description: 'A catalogue product is not ACTIVE or absent from Admin, or an Admin product is undeclared in catalogue.json.' },
  { id: 'product-media-count', tier: 'A2', surface: 'products-admin', severity: 'WARN', description: 'A product has no media.' },
  { id: 'product-breadcrumb-metafield', tier: 'A2', surface: 'products-admin', severity: 'WARN', description: 'custom.breadcrumb_collection is missing or points at a catch-all collection.' },
  { id: 'menu-catalog-children', tier: 'A2', surface: 'navigation', severity: 'ERROR', description: 'The main menu catalog link has children, which silently disables the generated collections dropdown.' },
];
