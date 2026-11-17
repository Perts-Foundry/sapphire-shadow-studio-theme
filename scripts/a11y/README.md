# scripts/a11y/

pa11y against the PR's deployed preview theme. This is the dynamic half of the two-layer
accessibility check; the static half is `scripts/contrast/`, which lints colour schemes inside the
required `validate / validate` context.

The flow, one step per file:

1. `get-auth-cookie.mjs` gets through the storefront password with Node `fetch`, pins the session
   to the preview theme, proves the pin from the `server-timing` header, and prints the session
   cookie.
2. The workflow writes that cookie to an owner-only file in `$RUNNER_TEMP`.
3. `build-pa11yci.mjs` builds the pa11y config: the URL list, each URL pinned with
   `?preview_theme_id=`, and the WCAG 2.1 AA defaults. It carries no cookie.
4. `run-audit.mjs` puts the cookie into each Chrome context's cookie jar, runs pa11y on each URL,
   checks which theme the audited page came from, and writes the report.
5. `summarize-pa11y.mjs` turns the report into the CI Report comment and the pass/fail verdict.

These scripts are driven by the "A11y audit" steps of the `validate` job in
`.github/workflows/validate.yml`, which `needs: deploy-preview` so the theme it audits is known to
exist. They are not useful standalone without a deployed preview theme and the storefront password.

## Why this is harder than the sibling repo

`perts-foundry-website` runs pa11y-ci as a hard WCAG 2.1 AA gate, and its defaults are copied here.
Its plumbing is not: that repo Hugo-builds to `public/`, serves it on localhost, and crawls itself,
needing no secret and no network. Liquid renders server-side, so this repo has no local build
target. The only rendered HTML is a password-gated storefront or a `pr-N-preview` theme.

So every URL is an authenticated remote request, and two gates stand in the way.

**The storefront password.** curl cannot get through it: Cloudflare bot management blocklists
curl's TLS fingerprint on this store. Node's `fetch` (undici) does. That is why
`.github/actions/shopify-theme-push/smoke.mjs` is built on fetch, and why `get-auth-cookie.mjs`
imports `BROWSER_HEADERS`, `updateJar`, `cookieHeader` and `authenticateStorefront` from it rather
than copying them. The exact header set is what was found to work; two copies would drift apart
silently. `authenticateStorefront` is the password POST and its outcome classification
(`success` / `rejected` / `throttled` / `error`); on the smoke side `rejected` HARD-FAILs a deploy,
here every non-success outcome fails, because an unauthenticated run would just audit the password
page. The preview probe retries a 429 or a transient 5xx on the same backoff, and fails closed on a
connection failure.

**Theme selection.** A draft theme renders only when the session is pinned to it, via
`?preview_theme_id=<id>`.

## The assertion that matters

Passing the password proves the storefront opened. It does NOT prove the session is pinned to the
PR's draft theme. If the pin silently failed, pa11y would audit the LIVE theme and report green on
a PR that broke the page.

So `get-auth-cookie.mjs` fetches the preview URL and reads the theme id back out of the
`server-timing` header, asserting it matches the expected id specifically. The same assertion
catches a Cloudflare interstitial, which returns something that is not a rendered storefront at all.
Nothing is printed unless that assertion passes.

That proves Node's session, not Chrome's. Chrome is a separate client with its own cookie jar, so
`run-audit.mjs` checks the theme again, on every audited page; see the next section.

## The theme-identity check in run-audit.mjs

pa11y-ci used to run the audit, with the cookie passed as a `Cookie` header. pa11y applies
`headers` by intercepting requests and overriding the **first request only**. Redirect hops,
subresources and in-page fetches went out with Chrome's own jar, which never held the preview pin.
The audit ran against the live theme, and nothing noticed. pa11y-ci also gives no hook into the
page after the audit, so nothing could have checked.

`run-audit.mjs` drives pa11y's own API instead. For each URL it:

- opens a fresh browser context and puts the cookies into its jar with `setCookie`, scoped by URL
  so they are host-only, like the ones Shopify sets. It never passes `headers`, so pa11y never
  intercepts requests, and Shopify's own `Set-Cookie` preview pin lands in the jar the way it does
  for a person following a preview link;
- records the `server-timing` theme id of each main-frame document response (the last one is the
  final redirect hop);
- after pa11y finishes, reads `window.Shopify.theme` (`id`, `role`) from the page pa11y audited.

When the page's theme id is not the preview theme, or the document was served by another theme,
the URL's findings are discarded and replaced with one entry naming both ids. That entry has no
`type`, so the summariser counts it as an untested URL and fails the audit. A page with no
`Shopify.theme` at all (not a rendered storefront page) fails the same way. A final document with
no theme id in `server-timing` does not fail on its own; the page's own global decides.

The job log has one line per URL from the runner, for example:

```
run-audit: /products/x: doc theme 123, page theme 123 (unpublished): ok
run-audit: /cart: doc theme 456, page theme 456 (main): WRONG THEME
```

A `WRONG THEME` line means Chrome rendered a theme other than the PR's preview on that page: the
session was not pinned. `page theme -` means the page had no `Shopify.theme`. Neither is an
accessibility finding, and rerunning will not fix it; the preview session handoff needs looking at.

For a one-off diagnosis, set `SCREEN_CAPTURE_DIR` and the runner saves one full-page screenshot per
URL there.

## Verified against the live store, 2026-08-16

The activation mechanism was the plan's flagged load-bearing assumption, so it was checked
read-only against the real store using the existing unpublished `EDIT HERE - shopify-sync` theme
(the same class of theme as a `pr-N-preview` theme).

- A bare `?preview_theme_id=<id>` **does** activate an unpublished theme for an authenticated
  session. No share/`key=` URL fallback is needed.
- All 19 paths in `paths.json` returned their expected status (200, and 404 for the deliberate
  missing page) **and** reported the preview theme id, not the live one.
- The `*.myshopify.com` host 302s to the primary custom domain. This is why `classifyPreview` does
  not reject a host change: `vars.SHOPIFY_FLAG_STORE` is the myshopify host, so a strict host
  assertion failed against the exact BASE_URL the workflow passes. The theme id is the identity
  proof instead, and it is the stronger one. The resolved origin is handed back so pa11y requests
  the canonical host directly rather than eating a redirect on all 19 URLs.

## Host handling

`getAuthCookie` returns `canonicalBaseUrl`, written to the file named by `CANONICAL_BASE_URL_FILE`.
It goes to a file rather than `$GITHUB_OUTPUT` because a step cannot read back its own outputs, and
the workflow needs the value in the same step to build the config. It is a public storefront URL,
not a secret.

## PUBLIC mode

`STOREFRONT_PASSWORD` disappears when the storefront opens at launch. That is not an error: the
script detects an unlocked storefront, skips the password step, and still pins and asserts the
preview theme. A locked storefront with an empty password IS an error, and fails loudly rather than
falling back to an unauthenticated audit of the password page.

## Secret handling

- `STOREFRONT_PASSWORD` is scoped to the auth STEP, never the job. The audit step launches
  `--no-sandbox` Chrome that executes third-party page JavaScript, and the password must not be in
  that process's environment.
- Inputs are environment-only, never argv: a password in a process argument is world-readable in
  `/proc` on the runner.
- The emitted cookie is a live authenticated session. The job masks it with `::add-mask::` before
  anything else can emit it.
- The cookie reaches the audit step through one file, `$RUNNER_TEMP/a11y-cookie`, written with
  `umask 077` and read only by `run-audit.mjs`. It must never be uploaded as an artifact or printed.
  The pa11y config carries no cookie, and `build-pa11yci.mjs` refuses a `headers` key in
  `paths.json` defaults. `run-audit.mjs` logs no cookie name or value, and the job caps
  its stderr, which carries page-derived error text.

## Chrome

pa11y uses the runner's preinstalled `/usr/bin/google-chrome`, not puppeteer's bundled Chromium.
`npm ci --ignore-scripts` blocks puppeteer's download script and `PUPPETEER_SKIP_DOWNLOAD=1`
reinforces it. This is deliberate rather than a workaround: every open `npm audit` high in this
dependency tree lives in that download path, so never running it is what keeps them unreachable.

## paths.json

One path per distinct template, committed rather than crawled so a PR that breaks a page cannot
shrink the audit's own coverage. `test/paths.test.mjs` asserts every JSON template has an entry, so
adding `templates/product.new-thing.json` without one fails the build instead of shipping a page
nothing audits.

It cannot check handles against the live store (no network in unit tests), so a renamed product
handle surfaces as a 404 in the audit rather than at test time.

Per-entry `ignore` and `hideElements` pass through to pa11y. Use them for third-party embeds this
theme does not control, never to silence a real finding in theme markup. These are the only
suppressions pa11y itself applies, and they are invisible to the summariser by design: they are
scoped to one URL, not to the whole audit.

## baseline.json

The audit-wide known-debt list, as axe rule ids. An entry silences that whole rule on every audited
page, so the gate reports **regressions** rather than the launch state.

`summarize-pa11y.mjs` owns it, **not** `build-pa11yci.mjs`. Handing the list to pa11y as
`defaults.ignore` dropped matching findings inside the browser, which had two consequences worth
not repeating: the report could not say what it had hidden (so the comment claimed a clean
WCAG 2.1 AA pass over rules it never gated), and the per-URL display cap was spent on baselined
noise, which is how three baselined rules stayed invisible for a whole PR. pa11y now runs
unbaselined and reports everything; the filter runs in the summariser, which publishes the rule
list and a per-rule count of what each entry hid on that run. A rule showing **0** hid nothing and
should be deleted; an entry that outlives its debt hides the next regression behind it.

Consequence to know when reading the logs: `run-audit.mjs` exits 2 on any run that has a
baselined finding, so its exit code is no longer a crash signal. See below.

The list is empty as of the burn-down and should stay that way; the mechanism remains for the next
genuine known-debt situation.

## Needs review (axe incomplete)

axe returns `violations` (a measured failure) and `incomplete` (it could not resolve the
background: text over an image, a gradient, an overlapping element). pa11y promotes incomplete to a
gating error unless capped, which is what once forced `color-contrast` into the baseline: the
unmeasurable set drowned the measured one. `build-pa11yci.mjs` caps needs-review findings at
`warning` (`levelCapWhenNeedsReview`, committed side so `paths.json` cannot raise it) and keeps
them in the JSON (`includeWarnings`). The summariser counts them per page and per rule in a
non-gating "Needs review" block of the CI Report comment; a jump between runs means new
unmeasurable text landed and deserves a manual look.

## Fail-closed behaviour

A runner that audited nothing exits 0 (pa11y-ci did, and `run-audit.mjs` does on an empty URL
list). A config that lost its URLs, or a run that died before the first page, looks exactly like
"no accessibility errors". `summarize-pa11y.mjs` therefore reads
the URL count out of the JSON rather than grepping pa11y's prose, and treats zero URLs as a
failure.

A page pa11y could not load at all is the other silent pass. The runner stores the caught exception
as that URL's whole result array (pa11y-ci did too, and its `Error` serialised to `{}`; the runner
stores `{ message }`), so a `type === 'error'` filter counted the page as clean. The exit code used to catch it; with the baseline applied in the
summariser that no longer works, so the summariser detects such an entry structurally and fails the
run, naming the URL. The theme-identity check uses the same path: a wrong-theme page becomes one
such entry. The exit-code net is kept as a last resort for a run that reported nothing at all.

A browser that will not launch makes `run-audit.mjs` exit 1 without writing a report, which the
summariser reads as a failed audit. pa11y-ci retried one launch; the runner does not, so a rerun
of the job is the recovery.

## Layout

| File | Role |
| --- | --- |
| `get-auth-cookie.mjs` | Password flow, preview-theme pin, and the theme-id assertion |
| `build-pa11yci.mjs` | `paths.json` + base URL + theme id into a pa11y config (no cookie, no `headers`) |
| `run-audit.mjs` | Cookies into Chrome's jar, pa11y per URL, per-page theme-identity check, the JSON report |
| `summarize-pa11y.mjs` | Baseline filter + disclosure; sanitised, length-bounded PR-comment body; fail-closed verdict |
| `paths.json` | The audited path list, one per template |
| `baseline.json` | Audit-wide known-debt axe rules, read by `summarize-pa11y.mjs` |
| `test/` | `node --test` suites; fully offline, with an injected fetch, pa11y and browser |
