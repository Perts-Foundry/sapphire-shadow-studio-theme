// Tier A1 checks: storefront render, JSON endpoints, Ajax cart. Run by probe.mjs.
// Side effects: session-scoped cart writes only, cleared in `finally`.
// Lane A1 owns this file; add ids here, never in another tier's file.

export const A1_CHECKS = [
  // Storefront render (every scripts/a11y/paths.json path plus sitemap products)
  { id: 'render-status', tier: 'A1', surface: 'storefront-render', severity: 'ERROR', description: 'A probed path returned a non-200 final status.' },
  { id: 'render-host', tier: 'A1', surface: 'storefront-render', severity: 'ERROR', description: 'A probed path resolved on a host other than the storefront host.' },
  { id: 'render-theme-id', tier: 'A1', surface: 'storefront-render', severity: 'WARN', description: 'The served theme id differs from the expected live id (one finding per run; every later finding is tagged with the served id).' },
  { id: 'render-theme-id-missing', tier: 'A1', surface: 'storefront-render', severity: 'WARN', description: 'The server-timing header carried no theme id, so the served theme cannot be confirmed.' },
  { id: 'render-gate', tier: 'A1', surface: 'storefront-render', severity: 'GATE', description: 'The probe landed on the password page or a bot challenge; inconclusive, never PASS.' },
  { id: 'render-liquid-error', tier: 'A1', surface: 'storefront-render', severity: 'ERROR', description: 'The body contains a "Liquid error" string.' },
  { id: 'render-translation-missing', tier: 'A1', surface: 'storefront-render', severity: 'ERROR', description: 'The body contains a "translation missing" string.' },
  { id: 'render-h1-count', tier: 'A1', surface: 'storefront-render', severity: 'ERROR', description: 'H1 count is not exactly 1 on index, product, collection, page and article, or exceeds 1 elsewhere.' },
  { id: 'render-marker-missing', tier: 'A1', surface: 'storefront-render', severity: 'ERROR', description: 'A stable page-type marker (#SizeChart, #away-from-studio, a properties[...] input, the policy-nav marker) is absent from a 200 body.' },
  { id: 'render-coverage', tier: 'A1', surface: 'storefront-render', severity: 'ERROR', description: 'Zero products were probed; per-surface coverage counts are reported as INFO.' },
  { id: 'sitemap-unreadable', tier: 'A1', surface: 'storefront-render', severity: 'ERROR', description: 'The product sitemap could not be read, so products could not be enumerated.' },
  { id: 'retry-budget-exhausted', tier: 'A1', surface: 'storefront-render', severity: 'ERROR', description: 'The run-wide retry budget was spent before every path was probed.' },

  // JSON endpoints
  { id: 'product-json-status', tier: 'A1', surface: 'json-endpoints', severity: 'ERROR', description: '/products/<handle>.js returned a non-200 status.' },
  { id: 'product-json-not-json', tier: 'A1', surface: 'json-endpoints', severity: 'GATE', description: 'A JSON endpoint returned a non-JSON body (challenge or password page); never a parse crash.' },
  { id: 'product-json-variant-count', tier: 'A1', surface: 'json-endpoints', severity: 'ERROR', description: 'Variant count differs from the catalogue colour x size matrix for that body.' },
  { id: 'product-json-requires-shipping', tier: 'A1', surface: 'json-endpoints', severity: 'ERROR', description: 'requires_shipping does not match the product type (garments true, gift card false).' },
  { id: 'product-json-weight-zero', tier: 'A1', surface: 'json-endpoints', severity: 'ERROR', description: 'A shippable variant reports grams 0 (Expedited is weight-tiered).' },
  { id: 'product-json-sold-out', tier: 'A1', surface: 'json-endpoints', severity: 'WARN', description: 'A product has no available variant.' },
  { id: 'collection-json', tier: 'A1', surface: 'json-endpoints', severity: 'ERROR', description: '/collections/all/products.json failed or lists a product count that disagrees with the catalogue census.' },
  { id: 'search-suggest', tier: 'A1', surface: 'json-endpoints', severity: 'ERROR', description: '/search/suggest.json with a catalogue-derived term failed or returned no product.' },
  { id: 'recommendations', tier: 'A1', surface: 'json-endpoints', severity: 'INFO', description: '/recommendations/products.json result for the theme section id; informational only.' },
  { id: 'not-found-status', tier: 'A1', surface: 'json-endpoints', severity: 'ERROR', description: 'A garbage path did not return the status expected for the lock mode.' },

  // Ajax cart (serial, reducer-planned, cleared in finally)
  { id: 'cart-precondition', tier: 'A1', surface: 'cart', severity: 'INFO', description: 'The session cart was not empty at start and was cleared first.' },
  { id: 'cart-add', tier: 'A1', surface: 'cart', severity: 'ERROR', description: '/cart/add.js failed for a chosen available variant.' },
  { id: 'cart-add-422', tier: 'A1', surface: 'cart', severity: 'ERROR', description: '/cart/add.js returned 422 for the named variant (unavailable, or a required property was rejected).' },
  { id: 'cart-roundtrip', tier: 'A1', surface: 'cart', severity: 'ERROR', description: '/cart.js does not reflect the line just added (variant, quantity, properties).' },
  { id: 'cart-update-quantity', tier: 'A1', surface: 'cart', severity: 'ERROR', description: '/cart/update.js quantity change did not round-trip.' },
  { id: 'cart-remove', tier: 'A1', surface: 'cart', severity: 'ERROR', description: 'Removal by line key did not round-trip.' },
  { id: 'cart-gift-card-shipping', tier: 'A1', surface: 'cart', severity: 'ERROR', description: 'A gift-card line reports requires_shipping true.' },
  { id: 'cart-threshold-predicate', tier: 'A1', surface: 'cart', severity: 'ERROR', description: 'The mixed-cart free-shipping predicate (shippable cents vs threshold cents) disagrees with the rendered cart copy.' },
  { id: 'cart-render-shipping-copy', tier: 'A1', surface: 'cart', severity: 'ERROR', description: 'The /cart render does not show the shipping-info sentence expected for the cart state.' },
  { id: 'cart-property-keys-mismatch', tier: 'A1', surface: 'cart', severity: 'WARN', description: 'The acknowledgment property keys parsed from the live product form differ from the repo settings.' },
  { id: 'cart-throttled', tier: 'A1', surface: 'cart', severity: 'GATE', description: 'A cart call returned 429/430 or a challenge; the cart flow stops for the run.' },
  { id: 'cart-clear', tier: 'A1', surface: 'cart', severity: 'ERROR', description: '/cart/clear.js in finally did not leave item_count 0.' },
];
