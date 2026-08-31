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
  `server-timing: theme;desc="<LIVE_THEME_ID>"`, plus, on `/policies/*` only, a body-marker
  check (two bullets below). Structural routes verify the deploy landed; the
  list is the `smoke-paths` input default in `action.yml`, which is the single source of truth
  and carries the reasoning for each entry. `smoke.mjs` keeps a copy for standalone `--dry-run`
  and `smoke.test.mjs` fails if the two drift. One of them is `/policies/refund-policy`, standing
  in for all five shop policies: Shopify renders them itself, but inside `layout/theme.liquid`
  (whose policy guard hosts the restyle and jump nav), the sitemap does not list them, and a
  `404` there usually means an emptied Admin policy rather than broken Liquid.
- **Policy pages also get a markup assertion (SOFT-WARN only).** Status, host and theme-id all
  stay green when `snippets/policy-page.liquid` stops rendering, which is exactly how the dead
  `templates/policy.liquid` attempt failed: a file that uploads cleanly and never runs. So any
  structural path starting `/policies/` (a prefix test, so an overridden `SMOKE_PATHS` is covered)
  has its response body checked for every string in `POLICY_MARKERS`, today the
  `policy-nav-component` custom-element tag. The whole shell is server-rendered, heading
  included, so the tag is not the only candidate marker; it is the most stable one, being neither
  locale-dependent (the heading text is) nor a CSS class anyone may rename. What is *not*
  assertable without a browser is the list content and the visible state: the `<nav>` ships
  `hidden` and the `<ul>` ships empty, because `assets/policy-nav.js` fills the list from the
  body's `h2`s and unhides it only at three or more headings. A missing marker is a **SOFT-WARN, never a HARD-FAIL**. That changes the failure
  mode from silent green to a visible non-blocking warning; it deliberately does not block a bad
  deploy, because the smoke cannot tell a forward deploy that broke the snippet from a rollback
  to a theme predating it, and `README.md`'s primary rollback is a revert PR through the same
  comment-deploy cycle, so the smoke does run against the older theme. The SOFT-WARN never fails
  the run *on its own*, but it is not a free pass either: it removes a PASS from the count, and
  the run still needs at least one verified PASS overall (the verdicts bullet below). Narrowing
  `SMOKE_PATHS` to a single policy path and then rolling back would therefore exit 1, on the
  `passes == 0` rule rather than on the marker. A body that cannot be read
  at all (reset mid-stream, decode failure) is a separate SOFT-WARN reason, "markers unknown",
  so a network fault stays diagnosable apart from genuinely absent markup. The body read shares
  the probe's existing `timeoutMs` budget and never runs on a redirect hop, a non-200, or a
  retry path.
- **Transient failures are retried; answers are not.** Every request the script makes (content
  probes, root mode-detection, `/password` fallback, both sitemap fetches, and both halves of
  the auth step: the cookie-seed GET and the password POST) shares one predicate,
  `isRetryableStatus`: `408`, `429`, `502`, `503`, `504` and a thrown
  network error are retried on the injected `backoff` array; `500` is retried **at most once**
  (a broken Liquid template `500`s deterministically, so retrying it to the cap only spends the
  run's budget on a failure that will stand); every other `4xx` (`401`, `403`, `404`, `410`,
  bot-rejection statuses) is an answer and is never retried. A `Retry-After` header, in either
  the delta-seconds or the HTTP-date form, wins over the backoff array, clamped to 30s. This
  exists because the content probes used to retry `429` only, so the identical transient `503`
  that `authenticateStorefront` is written to absorb HARD-FAILed a deploy that had *already*
  gone live (`release-notes.md` has the incident).
  **Exhaustion classification is unchanged and is the point of the whole design**: a `429` that
  survives its retries is still a SOFT-WARN, a `5xx` that survives is still a HARD-FAIL. A
  bot-management event that persists past the retries therefore still blocks; that is
  deliberate, because silently passing an unverifiable deploy is the worse failure.
- **Retries are bounded run-wide, not just per probe.** Products are probed sequentially and
  there can be ~200 of them, so a run-scoped budget is threaded through every probe and through
  the auth step: a total retry-sleep cap (`retryBudgetMs`, default 120s) plus a circuit breaker
  that stops retrying entirely once `retryBreakerProbes` (default 3) probes have exhausted their
  retries on a `5xx` or a network error. A `429` exhaustion deliberately does **not** count
  toward the breaker: throttling is already a SOFT-WARN, and a busy-but-healthy storefront must
  not disable retries for the rest of the run. Past the trip point the run fails fast rather
  than paying the backoff ~200 more times.
  What the budget actually protects is **coverage**, not the job: the product loop has its own
  240s deadline (`SMOKE_MAX_SECONDS`), and overrunning that soft-warns the unprobed remainder
  rather than timing out the 15-minute job. Retry sleeps are wall clock against that same
  deadline, so a degraded edge can spend up to half the product-probing window asleep and green
  the deploy with `products SOFT-WARN: time budget reached; N product(s) unprobed`. That reduced
  catalogue coverage, not a job timeout, is the failure mode to look for after an edge incident.
  Anything absorbed stays visible: one stderr line per retry, and a `retries: ...` summary line
  in the smoke output (emitted only when something was actually retried, on every exit path)
  naming the retry count, the total sleep, and whether the budget or the breaker tripped.
  The sitemap **index** fetch gets one more retry than a content probe (`sitemapIndexAttempts`,
  default 3 **retries**, against the backoff array's 2), because its failure zeroes product
  coverage for the whole run rather than costing one path.
  `retryBudgetMs`, `retryBreakerProbes` and `sitemapIndexAttempts` are `runSmoke` parameters
  only: unlike `SMOKE_MAX_PRODUCTS` / `SMOKE_MAX_SECONDS` they have no env override and
  `action.yml` passes none, so CI always runs the defaults. Changing one during an incident
  means editing the code.
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
  `path verdict status host theme-id` tuples plus a trailing parenthesised reason, which is
  built from literals and those same fields: never the password, cookie jar,
  `Set-Cookie`/`Cookie` headers, or bodies. A body may be **read** for an assertion (the policy
  marker check above); it may never be **emitted**. Only marker names, drawn from the fixed
  `POLICY_MARKERS` list in the script, reach a reason string, and nothing puts body text into
  the emitted lines or `GITHUB_OUTPUT`. `smoke.test.mjs` asserts that on both the PASS and the
  SOFT-WARN policy branches.
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
  The run uses `smoke.mjs`'s own copy of the structural list unless `SMOKE_PATHS` is set, and the
  drift test above is what keeps that copy honest; pass `SMOKE_PATHS` explicitly to pre-flight a
  single new route before it becomes a deploy gate.
