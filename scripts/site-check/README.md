# scripts/site-check/

Read-only whole-site sanity tooling. It checks what the customer-facing surfaces actually do
(render, JSON endpoints, the Ajax cart, Admin configuration, repo cross-checks) and reports
deltas against a saved baseline. Nothing here writes to the store, the repo, or Admin beyond
session-scoped cart writes that are cleared before exit; the only files written are run artifacts
in a state dir outside the checkout.

The `site-check` Claude skill (`.claude/skills/site-check/`) drives these scripts, runs the
existing tools as Tier A4, holds the opt-in browser pass (Tier B) and renders the operator
checklist (Tier C); these scripts are the deterministic half.

## Scripts

| Script | Tier | Auth | What it checks |
| --- | --- | --- | --- |
| `consistency.mjs` | A3 | none (repo only) | Announcement, template and FAQ shipping amounts vs settings; vacation date sync, format and FAQ anchor; `show_shipping_info` per template; catalogue products have templates with the required blocks; social list parity; `it`/`ro` locale mirroring |
| `probe.mjs` | A1 | `STOREFRONT_PASSWORD` or `STORE_PW` (`STORE_PW` wins when both are set) while the store is locked; none once public | Every `scripts/a11y/paths.json` path plus sitemap products: status, host, served theme id, gate, Liquid errors, H1 count, page-type markers, coverage; the JSON endpoints; a serial Ajax cart flow cleared in `finally` |
| `config.mjs` | A2 | `MYSHOPIFY_DOMAIN` + `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` | Admin reads only: delivery profiles, variants, shop policies, locales, markets, shop features, products, the main menu |
| `runfile.mjs` | C | none | `--write` renders the operator checklist from the registry into the state dir (refusing a path inside the checkout; `--lock`, `--from-a2 <config --json file>` for skipped-read rows, repeatable `--extra <check-id>` for a carried-over Tier B item) and prints its path and item count; `--read <path>` prints only checkbox state and evidence per id |
| `tools.mjs` | A4 | `STOREFRONT_PASSWORD` for the two tools that need it, passed by name from this process's env | Runs the existing tools in a clean allow-listed env (seo-review `surface` and `crawl` with `--no-save`, the smoke `--dry-run`, `contrast:lint`, `theme check` from `--primary-root` when this is a worktree); each non-zero exit is one finding, each tool that cannot run is SKIPPED |

Shared flags: `--full` (print unchanged findings and accepted risks; not on `tools.mjs`),
`--no-save` (do not record this run as the new baseline), `--strict` (exit non-zero on any
unaccepted ERROR, not only new ones), `--json` (machine-readable findings on stdout).
`probe.mjs` also takes `--theme-id <id>` (expected live id; `LIVE_THEME_ID` env is the
fallback), `--pace <ms>` (be gentle, the storefront rate-limits), `--max <n>` (product cap),
`--surface <id>` and `--skip-cart`; `BASE_URL` env overrides the storefront origin.
`--full` on `probe.mjs` also runs the cart flow over every catalogue product rather than one
garment per body plus the gift card (more session-cart writes, a longer run).
`config.mjs`, `consistency.mjs` and `tools.mjs` take `--public` (assert the PUBLIC lock state);
`consistency.mjs` takes `--root <path>` (repo root override, mainly for tests);
`config.mjs` takes `--surface <id>`; `tools.mjs` takes `--primary-root <path>` (the primary
checkout, for `theme check` from a worktree) and repeatable `--skip <check-id>`. A `--surface`
run never saves.

```bash
node --env-file=.env scripts/site-check/consistency.mjs
node --env-file=.env scripts/site-check/tools.mjs
node --env-file=.env scripts/site-check/probe.mjs
node --env-file=.env scripts/site-check/config.mjs

# See everything, not just deltas:
node --env-file=.env scripts/site-check/probe.mjs --full --no-save
```

`--env-file=.env` is harmless for `consistency.mjs` (it reads no env) and is written the same way
so no command in the skill ever puts a secret on argv.

## Check criteria

Severities: **ERROR** blocks (exit 1 when new since the baseline), **WARN** reports, **INFO** is
context, **SKIPPED** names a check that could not run (missing scope, missing env), **GATE** is
inconclusive (the probe landed on the password page or a bot challenge) and is never a pass.
Thresholds: H1 count exactly 1 on index, product, collection, page and article and at most 1
elsewhere; variant weight strictly greater than 0; evidence fields 200 characters.

### Tier A3 `consistency.mjs`

- `announcement-amounts` (ERROR): the announcement slides state the flat rate and threshold as an
  ordered pair that must equal settings; the slides are inline copy with no locale key.
- `template-shipping-amounts` (ERROR): the product-template accordions and the FAQ answers repeat
  the amounts; "Shipping copy" in `docs/theme-settings-contracts.md` lists all six places.
- `vacation-date-sync` (ERROR) / `vacation-date-format` (WARN) / `vacation-faq-anchor` (ERROR):
  the four dated vacation settings share one date string in the pinned format, and
  `faq_item_vacation` keeps `custom_anchor: "away-from-studio"`; nothing else reconciles them.
- `price-show-shipping-info` (ERROR): every `price` block enumerated, then judged by template
  (garments true, gift card exempt, non-product false, an absent key is a finding).
- `catalogue-template-missing` / `catalogue-template-blocks` (ERROR): each `catalogue.json`
  product has a template file carrying the blocks its type requires.
- `social-list-parity` (ERROR): the two hardcoded platform lists must agree or `sameAs` drifts.
- `locale-key-missing` (WARN) / `locale-key-todo` (INFO): `it.json` and `ro.json` mirror every
  storefront key; a `TODO:` placeholder counts as mirrored.

### Tier A4 `tools.mjs`

- `tool-seo-surface`, `tool-seo-crawl`, `tool-smoke-dry-run`, `tool-contrast-lint`,
  `tool-theme-check` (ERROR): one finding per tool that exits non-zero, its output attached, not
  parsed. The smoke dry-run is local and labelled so; it is not the post-deploy path.

### Tier A1 `probe.mjs`

- `render-status` / `render-host` (ERROR): 200 on the storefront host, final URL after redirects.
- `render-theme-id` (WARN, once per run) / `render-theme-id-missing` (WARN): the `server-timing`
  header names the served theme; a mismatch with the live id tags every later finding.
- `render-gate` (GATE): password page or challenge; inconclusive, never PASS.
- `render-liquid-error` / `render-translation-missing` (ERROR): the two strings Shopify renders
  in place of a broken tag or key.
- `render-h1-count` (ERROR): nothing in CI checks heading structure.
- `render-marker-missing` (ERROR): stable anchors only (`#SizeChart`, `#away-from-studio`, a
  `properties[...]` input, the policy-nav marker); a unit test asserts every `paths.json` entry
  has a marker rule or an explicit `noMarker`.
- `render-coverage` (ERROR at zero products) / `sitemap-unreadable` / `retry-budget-exhausted`
  (ERROR): the smoke's rule, a run that verified no product page must not green.
- `product-json-status` (ERROR) / `product-json-not-json` (GATE): `/products/<handle>.js`.
- `product-json-variant-count` (ERROR): vs the catalogue colour x size matrix (full-matrix
  variants; dead combinations are sold out, not absent).
- `product-json-requires-shipping` (ERROR): garments true, gift card false.
- `product-json-weight-zero` (ERROR): Expedited is weight-tiered; a 0 g variant is mis-rated.
  The known 0 lb state belongs in `accepted-risks.json` until fixed in Admin.
- `product-json-sold-out` (WARN): no available variant.
- `collection-json` / `search-suggest` (ERROR) / `recommendations` (INFO) / `not-found-status`
  (ERROR, status expected per lock mode): the remaining JSON endpoints.
- `cart-precondition` (INFO): the session cart was not empty and was cleared first.
- `cart-add` / `cart-add-422` (ERROR, the 422 names the variant) / `cart-roundtrip` /
  `cart-update-quantity` / `cart-remove` / `cart-clear` (ERROR): the serial Ajax flow, property
  keys parsed from the live product form.
- `cart-gift-card-shipping` (ERROR): a gift-card line must report `requires_shipping: false`.
- `cart-threshold-predicate` / `cart-render-shipping-copy` (ERROR): the mixed-cart predicate is
  shippable cents vs threshold cents, never the cart total; the `/cart` render must show the
  sentence `en.default.json` holds for that state.
- `cart-property-keys-mismatch` (WARN): live form vs repo settings.
- `cart-throttled` (GATE): 429/430 or a challenge stops the cart flow for the run; no retry storm.

### Tier A2 `config.mjs`

- `admin-scope-missing` (SKIPPED, subject = scope) / `admin-partial-response` (ERROR): a read
  without its scope skips by name; `errors` beside `data` or an unfollowed page is never complete.
- `shipping-profiles-read` (ERROR) / `shipping-rates-mismatch` (WARN, both sets printed) /
  `shipping-rate-conditions` (INFO): Admin rate names and amounts vs theme settings and copy,
  compared as sets of amounts and rate-name tokens.
- `variant-weight` (ERROR, 0 or nil, unit reported) / `variant-requires-shipping` (ERROR) /
  `variant-sku-missing` (WARN) / `variant-unavailable` (WARN) / `variant-inventory` (INFO):
  paged `first: 100`, honouring `throttleStatus`.
- `policy-missing` / `policy-empty` (ERROR) / `policy-shipping-amounts` (WARN): every policy the
  theme links exists, is non-empty, and the shipping policy's amount set matches settings.
- `locales-published` (ERROR): exactly one published locale, the premise of the `it`/`ro` rule.
- `markets-shipping-countries` (WARN): vs the header `show_country` setting.
- `shop-currency` (INFO) / `shop-gift-cards` (ERROR while a gift card is sold) /
  `customer-accounts-version` (INFO) / `digital-wallets` (INFO): shop features.
- `product-template-suffix` (ERROR) / `product-status` (WARN) / `product-media-count` (WARN) /
  `product-breadcrumb-metafield` (WARN): per ACTIVE product; suffix and handle are different
  strings.
- `menu-catalog-children` (ERROR): one child silently turns the generated dropdown off.

### Tier B (`b-*`) and Tier C (`c-*`)

Registered so their findings share the contract and the baseline, but produced by the skill
(browser pass) and the operator (run file), never by a script here. Procedures:
`.claude/skills/site-check/tier-b-browser.md` and `tier-c-operator.md`. All ERROR unless marked.

- B product page: `b-product-variant-picker`, `b-product-gallery-filter`, `b-product-size-guide`,
  `b-product-applique-required`, `b-product-custom-text-counter`, `b-product-return-policy-gate`,
  `b-product-vacation-checkbox` (vacation on only), `b-product-request-combination`,
  `b-product-sticky-atc`, `b-product-judgeme` (WARN, third-party).
- B header, search, accounts: `b-header-collections-dropdown`, `b-header-mobile-drawer`,
  `b-header-announcement`, `b-header-search-modal`, `b-header-account-popover`,
  `b-header-country-selector`.
- B cart and checkout: `b-cart-quantity-remove`, `b-cart-progress-bar`, `b-cart-discount-hidden`,
  `b-cart-checkout-button`, `b-checkout-reach` (separate consent; creates an abandoned checkout).
- B pages: `b-policy-jump-nav`, `b-faq-expand-deep-link`, `b-404`, `b-password-page` (LOCKED
  only), `b-console-errors` (WARN, per page), `b-mobile-viewport`.
- C test orders: `c-orders-precondition`, `c-orders-under-threshold`, `c-orders-over-threshold`,
  `c-orders-gift-card-only`, `c-orders-mixed`, `c-orders-expedited`, `c-orders-discount-code`,
  `c-orders-express-wallet`, `c-orders-properties`, `c-orders-note`, `c-orders-teardown`.
- C post-order: `c-lifecycle-capture`, `c-lifecycle-fulfil`, `c-lifecycle-partial-refund`,
  `c-lifecycle-cancel`, `c-lifecycle-return`, `c-lifecycle-reorder`.
- C notifications and forms: `c-notifications-received`, `c-notifications-headers`,
  `c-forms-contact`, `c-forms-request-combination`, `c-forms-newsletter`,
  `c-forms-blog-comment` (WARN).
- C accounts and Flow: `c-accounts-signup`, `c-accounts-login`, `c-accounts-order-view`,
  `c-accounts-addresses`, `c-accounts-marketing`, `c-flow-low-stock`, `c-flow-auto-cancel`,
  `c-flow-inventory-sync`.
- C Admin settings, devices, launch, vacation: `c-admin-capture-mode`,
  `c-admin-gift-card-expiry`, `c-admin-checkout-account`, `c-admin-notification-sender`,
  `c-admin-skipped-reads` (pre-filled from A2's skips), `c-devices-ios`, `c-devices-android`,
  `c-devices-apple-wallet`, `c-launch-smoke-public`, `c-launch-a1-public`,
  `c-vacation-surfaces` (vacation on only).

## Finding contract

`{ id, check, severity, subject, message, evidence }`, built only through `makeFinding` in
`lib/finding.mjs`. `id` is `<check>:<subject>`; the subject is a stable identifier (handle,
template path, variant id, URL path, scope name), never a token, line-item key, timestamp, count
or price, so two runs over the same state produce identical ids. `evidence` is an extracted
field, truncated to 200 characters with control characters stripped, never a raw body or header.
`redact()` in `lib/redact.mjs` runs at the single serialisation point of every orchestrator.

## Exit codes, baselines, accepted risks

Exit code: non-zero on ERROR findings new since the baseline (first run: any ERROR); `--strict`
non-zero on any unaccepted ERROR. GATE and SKIPPED never block.

Each run saves its findings to `~/.local/state/site-check/` (`SITE_CHECK_STATE_DIR` overrides;
never point it inside the repo) under `<mode>-<LOCKED|PUBLIC>-<stamp>.json`. The next run diffs
against the latest run for the same mode **and lock state**, since a locked store and a public
one legitimately differ, and reports NEW / RESOLVED / UNCHANGED. A previous finding absent
because its check (or whole tier) was SKIPPED this run is reported as SKIPPED, never RESOLVED;
`lib/state.mjs` holds the rule.

`accepted-risks.json` (committed, deliberately public: it records decisions already documented
in TODO.md) suppresses findings the operator has explicitly accepted. Entries match on `check`
id plus an optional `subject`, and carry a `note` and `accepted_on`. **Never an order number, an
email, an address or any other identifier**; the contract test greps for them. When a decision
is revisited (the weights get fixed), delete the entry so the check goes live again. Finding
`check` ids are the matching key for this file and the baseline history, so renaming one
orphans its entries; rename only with a matching edit here.

## Required Admin scopes

Expected, verified at preflight against the granted list (never assumed): `read_shipping`,
`read_legal_policies`, `read_locales`, `read_markets`, `read_online_store_navigation`,
`read_inventory`, `read_products`. A missing scope skips its reads by name
(`admin-scope-missing`) and the skill lists them under Tier C `c-admin-skipped-reads`. Widening
the custom app's scopes is an operator task in Admin; the tooling never asks for a write scope.

## Design notes

- **node fetch, never curl**: Shopify/Cloudflare bot management blocklists curl's fingerprint
  (hard 429). Same reason as the deploy smoke test; see `docs/smoke-test-reference.md`.
- **Reuse over rewrite**: storefront HTTP (`authenticateStorefront`, the cookie jar, theme-id
  parsing, the retry budget) is imported from `.github/actions/shopify-theme-push/smoke.mjs`
  exactly as `scripts/a11y/get-auth-cookie.mjs` already does, and HTML extraction from
  `scripts/seo-review/lib/extract.mjs`; the Admin client is
  `scripts/blank-inventory/lib/admin.mjs` behind a guard that rejects any `mutation` document.
- **`lib/` has no `fetch`, no `fs`, no `process.env`**: orchestrators inject data, `io` and
  `now`, so every classifier is a pure function over a body or a tree.
- **Password and token hygiene**: the password and the minted Admin token are read from the
  environment, held in memory, and redacted from every output. Page bodies and cookie values are
  never logged. All of these come from the repo-root `.env` via `node --env-file=.env ...`
  (see [`../README.md`](../README.md) > Credentials).
- **Tests**: `npm run site-check:test` (`node --test scripts/site-check/test/*.test.mjs`).
  Unit-only; `fetch` is stubbed to throw, state goes to temp dirs, every fixture is synthetic.

## Reversibility

Delete `scripts/site-check/`, `.claude/skills/site-check/`, the two wiring lines (the
`site-check:test` script in `package.json` and its step in `validate.yml`), and the state dir.
Nothing persists on the store except abandoned checkouts from Tier B and cancelled test orders
from Tier C, both operator-visible in Admin.
