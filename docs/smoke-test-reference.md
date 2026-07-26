# Smoke test reference

Full behavioral contract for the post-deploy smoke, `.github/actions/shopify-theme-push/smoke.mjs`
(unit-tested by `smoke.test.mjs`). Note that the `npm run smoke:test` script gating the required
`validate` job is broader than this file's subject: it also runs `report-format.test.mjs` and
`check-push-rejections.test.mjs`, so a red `smoke:test` is not necessarily a smoke-script failure.
CLAUDE.md's "Smoke test" section carries the condensed, load-bearing "do not do X" directives;
this file is the detailed reference for when you're actually touching the smoke script or
diagnosing a deploy failure it reported.

- **Why node, not curl.** Cloudflare bot-management blocklists curl's TLS/HTTP2 fingerprint
  and returns a hard `429` on content routes; node's `fetch` (undici) is not blocklisted. Do
  not reintroduce a curl probe of content routes. Empirical proof:
  `scripts/diagnostics/storefront-probe-node.mjs` (operator diagnostic; `.log` gitignored).
  Full root cause in `release-notes.md`.
- **What it asserts.** Per path: HTTP `200` + final host == expected host +
  `server-timing: theme;desc="<LIVE_THEME_ID>"`. Structural routes (`smoke-paths` default
  `/ /cart /collections/all /search`) verify the deploy landed.
- **Catalog coverage, no maintained list.** Product handles are not in this repo
  (`templates/` holds template suffixes, not handles; products are Admin data), so the smoke
  enumerates **every published product from the sitemap** (`/sitemap.xml` ->
  `sitemap_products_*.xml`) and probes each. A product `404` is a HARD-FAIL ("product
  unavailable"), which also catches a broken/removed template suffix. Do not "optimise" this
  back to a single hardcoded fixture. Caps: `SMOKE_MAX_PRODUCTS`, `SMOKE_MAX_SECONDS` (see
  `smoke.mjs` for current defaults; exhausting the time cap soft-warns the remainder, never
  blocks).
- **Locked vs public.** The store is password-protected pre-launch. When
  `STOREFRONT_PASSWORD` (repo **secret**, isolated to the `deploy` job's push step) is set,
  the smoke authenticates the password gate and probes real pages while locked. A password
  that the gate **refuses** (wrong / rotated secret) is a HARD-FAIL, so a stale secret cannot
  silently drop coverage on unattended auto-deploys. A **transient** auth failure (throttle /
  network) is a loud SOFT-WARN plus the `/password`+theme-id fallback. An **absent** secret
  skips auth entirely and takes the same `/password` fallback (PASS if that page is
  on-theme). **Delete the secret at public launch**; the smoke auto-detects PUBLIC mode with
  no code change.
- **Verdicts.** HARD-FAIL -> exit 1, blocks the deploy (sticky failure, PR stays open).
  SOFT-WARN (throttle, enumeration skipped, password fallback) -> exit 0, deploy proceeds,
  surfaced in the report. On the content-probe path at least one verified PASS is required to
  exit 0, so a wholesale `429` wall cannot green a deploy blind (the locked no-secret
  `/password` fallback is exempt: a rendered page greens with reduced coverage). Output is
  `path verdict status host theme-id` tuples only: never the password, cookie jar,
  `Set-Cookie`/`Cookie` headers, or bodies.
- **Docs-only PRs skip the push entirely.** The `gate` job computes `theme_touched` (any of
  the 8 theme dirs, or a rename out of one; fail-safe `true` on listing error); the `deploy`
  job's "Live theme push" step (which runs both push and smoke) is guarded on it, so a
  docs/scripts/`.github`-only PR merges and fast-forwards `shopify-sync` without touching
  live.
- **Pre-flight before first deploy.** Run `SMOKE_BASE_URL='https://<domain>'
  LIVE_THEME_ID='<live-theme-id>' STOREFRONT_PASSWORD='...' node
  .github/actions/shopify-theme-push/smoke.mjs --dry-run` against live once (all three env
  vars are required or the script exits 1); confirm LOCKED-mode PASS with the theme-id match
  (it is the only check that the live `server-timing` format and the password-POST cookie
  behaviour hold). Whether the gated sitemap is reachable is confirmed here too; if it is
  not, enumerate products via the Admin API by hand (there is no automatic Admin-API fallback
  in `smoke.mjs`; on an unreachable sitemap it soft-warns and probes structural routes only).
