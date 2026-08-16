# scripts/a11y/

pa11y-ci against the PR's deployed preview theme. This is the dynamic half of the two-layer
accessibility check; the static half is `scripts/contrast/`, which lints colour schemes inside the
required `validate / validate` context.

These scripts are driven by the `a11y-audit` job in `.github/workflows/preview.yml`. They are not
useful standalone without a deployed preview theme and the storefront password.

## Why this is harder than the sibling repo

`perts-foundry-website` runs pa11y-ci as a hard WCAG 2.1 AA gate, and its defaults are copied here.
Its plumbing is not: that repo Hugo-builds to `public/`, serves it on localhost, and crawls itself,
needing no secret and no network. Liquid renders server-side, so this repo has no local build
target. The only rendered HTML is a password-gated storefront or a `pr-N-preview` theme.

So every URL is an authenticated remote request, and two gates stand in the way.

**The storefront password.** curl cannot get through it: Cloudflare bot management blocklists
curl's TLS fingerprint on this store. Node's `fetch` (undici) does. That is why
`.github/actions/shopify-theme-push/smoke.mjs` is built on fetch, and why `get-auth-cookie.mjs`
imports `BROWSER_HEADERS`, `updateJar` and `cookieHeader` from it rather than copying them. The
exact header set is what was found to work; two copies would drift apart silently.

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

## PUBLIC mode

`STOREFRONT_PASSWORD` disappears when the storefront opens at launch. That is not an error: the
script detects an unlocked storefront, skips the password step, and still pins and asserts the
preview theme. A locked storefront with an empty password IS an error, and fails loudly rather than
falling back to an unauthenticated audit of the password page.

## Secret handling

- `STOREFRONT_PASSWORD` is scoped to the auth STEP, never the job. The pa11y step launches
  `--no-sandbox` Chrome that executes third-party page JavaScript, and the password must not be in
  that process's environment.
- Inputs are environment-only, never argv: a password in a process argument is world-readable in
  `/proc` on the runner.
- The emitted cookie is a live authenticated session. The job masks it with `::add-mask::` before
  anything else can emit it.
- The generated pa11y config embeds that cookie. It is written to `$RUNNER_TEMP` and must never be
  uploaded as an artifact or printed. pa11y can echo its config into stderr on a config error,
  which is why the job caps stderr rather than dumping it.

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
theme does not control, never to silence a real finding in theme markup.

## Fail-closed behaviour

pa11y-ci exits 0 when it audited nothing. A config that lost its URLs, or a run that died before
the first page, looks exactly like "no accessibility errors". `summarize-pa11y.mjs` therefore reads
the URL count out of the JSON rather than grepping pa11y's prose, and treats zero URLs as a
failure. It also fails a non-zero pa11y exit that reported no errors, which is what a Chrome crash
or an unloadable page looks like.

## Layout

| File | Role |
| --- | --- |
| `get-auth-cookie.mjs` | Password flow, preview-theme pin, and the theme-id assertion |
| `build-pa11yci.mjs` | `paths.json` + base URL + theme id + cookie into a pa11y config |
| `summarize-pa11y.mjs` | Sanitised, length-bounded PR-comment body; fail-closed verdict |
| `paths.json` | The audited path list, one per template |
| `test/` | `node --test` suites; fully offline, with an injected fetch |
