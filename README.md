# Sapphire Shadow Studio theme

A custom Shopify storefront theme for Sapphire Shadow Studio, built on Shopify's [Horizon](https://github.com/Shopify/horizon) flagship theme and shipped through a PR-comment-driven CI/CD pipeline.

The interesting part of this repo is not the theme; it is the deploy model. `main` is the source of truth. The live customer-facing theme is **disconnected from GitHub** and is written to only by the deploy workflow. You ship a change by commenting `deploy` on a green pull request. Admin edits made in the Shopify Customize/Code editor are captured separately on a `shopify-sync` branch and reconciled back into `main`, never pushed straight to live.

**Status:** single-merchant private storefront theme in active use. It is standalone (conceptually based on Horizon, but not a GitHub fork), and it is not a Shopify Theme Store submission. See the [license](#deeper-docs-and-license) for the use restriction this inherits from Horizon.

[Quick start](#quick-start) | [Repo layout](#repo-layout) | [How shipping works](#how-shipping-works) | [Workflows](#workflows) | [Branches and themes](#branches-and-themes) | [Secrets and variables](#secrets-and-variables) | [Rollback](#rollback) | [Troubleshooting](#troubleshooting) | [Staying current with Horizon](#staying-current-with-horizon) | [Development](#development-and-contributing) | [Deeper docs](#deeper-docs-and-license)

## At a glance

| | |
|---|---|
| Stack | Liquid + theme blocks. No build step; files in `assets/` ship as-is. |
| Tooling | Shopify CLI pinned as the `@shopify/cli` devDependency in `package.json` |
| Runtime | Node and npm, at the version `package.json`'s `engines` field requires |
| Deploy model | Comment `deploy` on a green PR (plus auto-deploy for `shopify-sync` reconcile and Dependabot PRs) |
| Live theme | `#181702754604` (disconnected from GitHub; only the deploy workflow writes to it) |
| Workflows | `validate`, `preview`, `sync`, `deploy` (in `.github/workflows/`) |
| License | Shopify Horizon license (MIT-style with a theme-interop restriction) |

## Prerequisites

- **Node and npm**, at the version required by `package.json`'s `engines` field (CI installs the same version). The Shopify CLI is pinned in `package.json` / `package-lock.json`; run it through `npm`/`npx`, never a globally installed CLI, so local and CI match.
- **A Shopify store with a Custom App token.** Local pushes and CI both authenticate with an Admin API access token (`shpat_...`) that has `read_themes` and `write_themes` scopes. See [Secrets and variables](#secrets-and-variables) for setup.
- **Repo write access (or higher)** and the `gh` CLI (or the GitHub UI) to comment `deploy` on a PR, the only path code takes to the live theme.

## Quick start

```bash
npm ci                       # install the pinned Shopify CLI
npx shopify theme dev        # local dev server (hot reload)
npx shopify theme check      # lint with theme-check
```

`npx shopify theme dev` is the safe first win: it serves the theme from an **ephemeral, unpublished** dev theme that is torn down when you stop the process. It touches neither the live theme nor `shopify-sync`, so there is zero production blast radius. When `theme dev` is running and the storefront renders your local edits with hot reload, you know your environment works.

`npx shopify theme check` runs the same linter CI runs. Its configuration lives in [`.theme-check.yml`](.theme-check.yml) (extends `theme-check:recommended`; see [Development](#development-and-contributing) for the two intentionally disabled checks).

> **Do not** run `npx shopify theme push` or `theme pull` against your working tree. Live pushes happen exclusively through the deploy workflow; pulling live into the working tree can clobber local work. To inspect what is live read-only: `npx shopify theme pull -s sapphire-shadow-studio --live --path /tmp/live --nodelete`.

## Repo layout

Standard Shopify theme structure. There is no bundler or transpiler; the directories below are the shipped surface, except where a row says otherwise.

| Path | Contents |
|---|---|
| `layout/` | Theme layout files (`theme.liquid`, `password.liquid`) |
| `templates/` | JSON/Liquid templates per page type |
| `sections/` | Section files with `{% schema %}` |
| `blocks/` | Reusable, nestable theme blocks |
| `snippets/` | Reusable Liquid partials rendered with `{% render %}` |
| `assets/` | Flat directory of CSS, JS, images, fonts (shipped as-is, no build) |
| `locales/` | Translation files; `en.default.json` is canonical |
| `config/` | `settings_schema.json` and `settings_data.json` |
| `marketing/emails/` | Shopify Email campaign templates. **Not shipped**: pasted by hand into the Shopify Email editor, ignored by `theme-check`. See [`marketing/emails/README.md`](marketing/emails/README.md) |
| `marketing/notifications/` | Shopify notification templates: 46 stock snapshots under `stock/` and 46 generated branded copies. **Not shipped**: pasted by hand into Admin > Settings > Notifications, ignored by `theme-check`. See [`marketing/notifications/README.md`](marketing/notifications/README.md) |
| `marketing/policies/` | The five shop policies (shipping, refund, terms, contact, privacy) plus a manifest pinning each body's hash and heading anchors. **Not shipped**: Shopify renders the policy pages from Admin. Unlike the two directories above, the repo is the source of truth here and **pushes** to Admin through a gated `policies:push`. See [`marketing/policies/README.md`](marketing/policies/README.md) |
| `scripts/site-check/` | Operator-run whole-site sanity test (storefront probe, Admin config reads, repo cross-checks). **Not shipped**; driven by the `/site-check` skill. See [`scripts/site-check/README.md`](scripts/site-check/README.md) |

Theme conventions (component framework, BEM/CSS rules, block development) live in [`docs/theme-conventions.md`](docs/theme-conventions.md); accessibility rules and widget patterns in [`docs/accessibility-patterns.md`](docs/accessibility-patterns.md). [`CLAUDE.md`](CLAUDE.md) carries the condensed directives and points at both.

## How shipping works

The normal path for a code change:

1. Branch from `main` and open a pull request. (Direct push to `main` is not part of the workflow; `main` is protected.)
2. **Validate** first spins up a per-PR unpublished theme `pr-<n>-preview` and comments the link, then runs theme-check, the security/lint suite, and an accessibility audit of that preview theme, and posts a sticky CI report covering everything.
3. When Validate is green, comment `deploy` on the PR (you must be a write+ collaborator).
4. The deploy workflow pushes to the live theme, smoke-tests it, squash-merges the PR, and deletes the preview theme. If anything fails, the PR stays open and a sticky failure comment is posted.

Two paths **auto-deploy** after Validate passes, with no comment needed: the single `shopify-sync` reconcile PR (capturing admin edits) and Dependabot PRs (minor/patch bumps). Major-version bumps and any change touching `.github/{workflows,actions,scripts}/` are held for a manual `deploy` comment after review.

> **Cost and side effects.** Commenting `deploy` mutates the live, customer-facing storefront and (on success) squash-merges the PR into `main`. There is no staging gate between `deploy` and customers seeing the change; the preview theme and Validate are the review surface.

The deploy gate is deliberately layered: a collaborator check on the comment author, a re-verification that Validate is green on the exact HEAD SHA, a signed-commit / PR-opener-identity check on the auto-deploy paths, and a draft-PR escape hatch that halts auto-deploy. The Shopify token is scoped only to the job that pushes to live, never to the gate job. The full rationale (attack surface and mitigations) lives in [`release-notes.md`](release-notes.md); the trust delta summary is in [`CLAUDE.md`](CLAUDE.md), full gate mechanics and known compensations in [`docs/deploy-gate-reference.md`](docs/deploy-gate-reference.md).

## Workflows

Four workflows in `.github/workflows/`. All run on `ubuntu-24.04`, pin third-party actions to commit SHAs, and set `permissions: {}` at the workflow root with per-job grants.

| Workflow | Triggers | Purpose |
|---|---|---|
| `validate` | PR opened / synchronize / reopened (same-repo heads) | Two jobs. `deploy-preview` (skipped for drafts and Dependabot) creates a per-PR unpublished theme `pr-<n>-preview` and comments the link. `validate` (needs `deploy-preview`, runs even when it is skipped or fails) sequentially runs `theme-check`, `reconcile`, the tooling suites (`size-chart`, `blank-inventory`, `sku`, `seo-review`, `site-check`, `applique-grid`, `email-icons`, `notifications` (regeneration check plus tests), `policies` (repo-consistency check plus tests), `product-images`, `smoke` deploy smoke-test units, the blank-id guard, the tracked-media guard (fails on any tracked file under `product-images/` or any tracked `.heic` anywhere), the SKU tables lint, the catalogue manifest lint, and the contrast lint), `actionlint + shellcheck` (workflow YAML plus the shell inside the composite actions), `zizmor`, `gitleaks`, and a pa11y-ci accessibility audit of the preview theme, plus an aggregator that posts a sticky CI report. The single required check on `main` is `validate / validate`. |
| `preview` | PR closed | Deletes the PR's `pr-<n>-preview` theme and marks the preview comment deleted. |
| `sync` | Push to `shopify-sync`; daily 13:00 UTC; manual | Opens or refreshes the single reconcile PR (`head: shopify-sync` into `base: main`) for admin edits. Does not auto-merge; `deploy` takes over after Validate. |
| `deploy` | (1) comment `deploy` on a PR; (2) `workflow_run` after Validate on `shopify-sync`; (3) `workflow_run` after Validate on `dependabot/**`. Both `workflow_run` paths gate on Validate's `validate` **job**, not the whole run, so a failed `deploy-preview` (a Shopify hiccup, not a code problem) does not block auto-deploy | Three isolated jobs: `gate` (no Shopify token; runs the trigger-conditional access checks), `deploy` (holds the Shopify token; live push + smoke test + squash-merge + preview delete), and `sync` (holds the deploy key, no Shopify token; reconciles `shopify-sync` to the deployed SHA). Live theme ID `181702754604`. |

Dependabot keeps GitHub Actions and npm dependencies current weekly (Monday 13:00 UTC), grouped into one PR per ecosystem ([`.github/dependabot.yml`](.github/dependabot.yml)).

For the internals of the gate (HEAD-SHA re-verification, signed-commit logic, phantom-orphan cleanup, CI-self-modification guard), read [`release-notes.md`](release-notes.md) and [`docs/deploy-gate-reference.md`](docs/deploy-gate-reference.md) rather than re-deriving them from the YAML.

## Branches and themes

| Ref | Role |
|---|---|
| `main` | Source of truth. Protected: PR + exactly one required check, `validate / validate`, + branch up-to-date. The required-context name is configured in the private infrastructure repo (`ci_check_contexts`), not here, so renaming the `validate` job or workflow without updating it there leaves `main` requiring a check that no longer reports. |
| `shopify-sync` | Captures admin Customize/Code edits via the Shopify GitHub Integration on the unpublished `EDIT HERE - Admin Sync` theme. Protected against force-push; `shopify[bot]` writes here. Reconciled into `main` through one auto-deploying PR. |
| Feature branches | Cut from `main`, PR'd back. Each gets a `pr-<n>-preview` unpublished theme. |
| Live theme `#181702754604` | Customer-facing. **Disconnected** from GitHub. Only the `deploy` workflow writes to it, and only after Validate is green on the PR HEAD SHA. |

Make admin edits on the `EDIT HERE - Admin Sync` theme (they flow to `shopify-sync`), never on the live theme directly. There is no automated drift detection; "live = main" is operator discipline.

## Secrets and variables

| Name | Type | Purpose |
|---|---|---|
| `SHOPIFY_CLI_THEME_TOKEN` | Repository **secret** | Admin API access token from a Custom App with `read_themes` + `write_themes` (token starts with `shpat_`). Used by the live push. |
| `STOREFRONT_PASSWORD` | Repository **secret** (optional) | Storefront password. Lets the post-deploy smoke authenticate the password gate and probe real pages while the store is pre-launch. Absent -> the smoke soft-warns and checks the `/password` page instead. **Delete at public launch**; the smoke auto-detects the public store with no code change. |
| `SHOPIFY_DOMAIN` | Repository **variable** | Canonical storefront host (e.g. `sapphireshadowstudio.com`), no scheme, no trailing slash. The deploy chain prefixes `https://` and uses it as the smoke-test base URL. |
| `SHOPIFY_FLAG_STORE` | Repository **variable** | The store's internal myshopify handle. **Use the internal handle, not the friendly admin alias** (`sapphire-shadow-studio.myshopify.com`), or Shopify rejects auth with a 401. |
| `EXPECTED_SYNC_PR_OPENER` | Repository **variable** | Expected GitHub login of the reconcile-PR opener; checked by the auto-deploy gate on the `shopify-sync` path. |
| `SHOPIFY_SYNC_DEPLOY_KEY` | Repository **secret** | SSH deploy key used only by the `sync` job to reconcile `shopify-sync`. Not in scope of the live-push job. |

The smoke test (run after the live push) is a node-`fetch` probe ([`smoke.mjs`](.github/actions/shopify-theme-push/smoke.mjs)), not curl: Cloudflare bot-management blocklists curl's fingerprint and 429s content routes. It asserts `200` + on-host + the live theme id on the structural routes listed in the composite action's `smoke-paths` input default ([`action.yml`](.github/actions/shopify-theme-push/action.yml)), which is the single source of truth for that list, and probes **every published product** (enumerated from the storefront sitemap) so a deploy that breaks a product's availability fails. A `/policies/*` route additionally has its body checked for the jump-nav shell, as a SOFT-WARN. The deploy-report sticky comment renders the per-path results as a markdown table, not a raw log dump, on both the success and failure report. See [`docs/smoke-test-reference.md`](docs/smoke-test-reference.md) for the full behaviour.

A PR that touches no theme files skips the live push and smoke entirely, but still merges. Its deploy report instead queries the live theme's name and ID from Shopify (read-only, `theme list`; flags a mismatch against the pipeline's assumed live theme ID) and reads back a lightweight custom git ref, `refs/deploy-markers/live` (deliberately outside `refs/tags/` so it does not clutter the Tags UI), which the deploy job force-moves to the squash-merge commit after every real live deploy. Both lookups are `continue-on-error`; a Shopify API hiccup can never block a docs-only PR from closing.

**One-time setup.** In Shopify admin: Settings -> Apps and sales channels -> Develop apps -> Create an app. Configure Admin API scopes `read_themes` and `write_themes`, install the app, and reveal the Admin API access token (shown once). Paste it into the repo secret `SHOPIFY_CLI_THEME_TOKEN` (Settings -> Secrets and variables -> Actions). Under the Variables tab, set `SHOPIFY_DOMAIN`, `SHOPIFY_FLAG_STORE`, and `EXPECTED_SYNC_PR_OPENER`. While the store is password-protected, add the repo secret `STOREFRONT_PASSWORD` so the smoke can probe real pages; delete it at public launch. Custom App tokens do not expire on a schedule; rotate by recreating the app. Never echo a token to the terminal or write it to a file.

## Rollback

1. **The last merged change was bad.** Open a revert PR (`git revert <sha>`, then `gh pr create --base main`). Validate runs; comment `deploy` to ship the revert. Recovery is one comment-deploy cycle.
2. **CI cannot deploy at all (break-glass).** Pull the last known-good SHA locally and push directly:
   ```bash
   npx shopify theme push --live --allow-live
   ```
   This logs your local Shopify identity rather than the CI token, so use it only when the pipeline is unavailable.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Auth fails with **401** locally or in CI | `SHOPIFY_FLAG_STORE` is set to the friendly alias. Use the internal myshopify handle (recoverable from the Theme Access email, an `admin/.../themes` URL, or `gql { shop { myshopifyDomain } }`). |
| Validate **reconcile** step fails on a PR | The branch is behind `shopify-sync`'s admin edits. Run the snippet the check posts: `git fetch origin && git merge origin/shopify-sync && git push`. |
| Auto-deploy did not fire on a `shopify-sync` / Dependabot PR | The PR is a draft. The draft-PR escape hatch halts auto-deploy by design; mark it ready (`gh pr ready <n>`), or comment `deploy` manually once reviewed. |
| Orphaned `pr-<n>-preview` theme lingers | Preview cleanup runs on PR close and after deploy; if it silently fails the deploy report shows a cleanup warning. List orphans with `npx shopify theme list -s sapphire-shadow-studio --json` and delete with `npx shopify theme delete --theme <id> --force`. |
| Dependabot **major** bump did not auto-deploy | Major bumps and changes under `.github/` require a manual `deploy` comment after review; there is no pre-authorization label. |
| Deploy fails at **Theme push (assets rejected by Shopify)** | Shopify refused one or more files and `shopify theme push` still exited 0; the push step caught it and failed with exit 97. The report and the workflow log name each rejected file and Shopify's reason. Usual causes: a JSON template setting outside its section schema's range (fix the value or the schema `min`/`max`), or a template whose schema change has not landed on the theme yet. **Live is partially updated**: files that validated were written, the rejected ones were not, so fix and re-deploy rather than assuming the deploy was a no-op. |
| Deploy fails at **List themes** with `theme list failed with a non-transient error ... not retrying` | An auth or permission answer, not weather, so the retry deliberately does not absorb it: sleeping out the backoff before reporting a rotated token helps nobody. Usual causes are a rotated, expired or wrongly-scoped `SHOPIFY_CLI_THEME_TOKEN` (needs `read_themes` + `write_themes`), or `SHOPIFY_FLAG_STORE` set to the friendly alias. The scrubbed CLI stderr is printed under the error. Nothing was pushed; live is untouched. |
| Deploy fails at **Smoke test** with `sitemap HARD-FAIL: product enumeration failed` | The sitemap could not be read after its retries, so the run verified **no product page at all** and is blocked rather than greened on the structural probes alone. Usually Shopify-side weather; re-`deploy` when it clears. An empty catalogue is exempt, so this means unreachable, not empty. **The theme is already live on this SHA** and the PR is unmerged, so `main` is behind until the re-`deploy` succeeds. |
| Deploy fails at **Smoke test** with `products HARD-FAIL: the time budget was exhausted` | The catalogue was enumerated but the deadline hit before a single product was probed, so again zero product coverage. Different recovery from the row above: raise `SMOKE_MAX_SECONDS` or lower `SMOKE_MAX_PRODUCTS` (both in `smoke.mjs`'s config), rather than retrying into the same budget. Same live-and-unmerged state as above. |

## Staying current with Horizon

This repo is **standalone, not a GitHub fork** of [`Shopify/horizon`](https://github.com/Shopify/horizon). The root commit `71b7cc2` (`init: import Horizon baseline at upstream commit 09db732`) carries Horizon's tree at the last sync point as a separate root commit. Upstream updates are pulled with plain `git`.

The **first** upstream sync after the 2026-05-03 republish needs `--allow-unrelated-histories`, because git's merge-base uses the commit graph (not tree equivalence) and the new history shares no ancestry with `Shopify/horizon`. After that merge lands, it becomes the common ancestor and later syncs are ordinary merges.

```bash
git remote add upstream https://github.com/Shopify/horizon.git   # one-time
git fetch upstream
git switch -c chore/horizon-merge-$(date +%Y-%m-%d)

# First sync after the 2026-05-03 republish:
git merge --allow-unrelated-histories upstream/main
# Subsequent syncs:
# git merge upstream/main

# To see what actually changed upstream since the baseline (vs. what conflicts),
# diff against the baseline tree:
#   git diff 71b7cc2 upstream/main -- sections/ snippets/ blocks/ assets/

git push -u origin HEAD
```

Expect add/add conflicts on shared files the first time. Keep ours for diverged customizations; take theirs for Horizon-internal changes worth adopting. Open a PR; CI runs as normal.

### Deviations that must survive a merge

Upstream Horizon files carrying intentional local changes. Taking theirs on any of these silently reverts a fix, and the in-file comments help only if you read the losing side of the conflict.

| File | Deviation |
|---|---|
| `sections/featured-product.liquid` | `structured_data` output guarded on `section.settings.product != blank`, so an unconfigured section stops emitting an empty JSON-LD block. |
| `sections/featured-product-information.liquid` | Same guard. |
| `sections/header.liquid` | Organization JSON-LD removed (now `snippets/structured-data.liquid`) and the `index`-guarded visually-hidden `<h1>` removed (the hero supplies the homepage heading). |
| `snippets/meta-tags.liquid` | `og:image` forced to `https:`; the `twitter:site` tag removed along with its broken handle parse. |
| `blocks/email-signup.liquid` | Input text and placeholder colors read `--color-input-text` / `--color-input-text-rgb` instead of upstream's hardcoded `rgb(255 255 255)`, which rendered white-on-white on any light color scheme (the password page, then on the default scheme it shipped with). |
| `blocks/_header-menu.liquid` | The dynamic collections dropdown trigger (`is_dynamic`) and the `role="menuitem"` / `role="presentation"` removals. |
| `snippets/mega-menu-list.liquid` | The `dynamic_collections` branch. The whole static branch is re-indented inside its `{% else %}`, so an upstream change conflicts across the entire file: resolve by re-applying the `dynamic_collections` branch onto theirs, never by keeping ours wholesale. |
| `snippets/header-drawer.liquid` | The dynamic collections submenu in both 2-level branches, plus `localization_style: 'drawer'` passed to `localization-form`. |
| `layout/password.liquid` | `color-sss-dark-scheme` hardcoded on `<body>`. The layout has no section settings to read a scheme from, and the class has to reach the storefront-password dialog and the footer, which sit outside the section. |
| `sections/password.liquid` | `shop.password_message` is no longer rendered (the Admin value contradicts the countdown), and `background-color` / `color` are forced on `.password-dialog` so the dialog does not flash a white full-screen panel over the dark page. |
| `layout/theme.liquid` | Renders `snippets/policy-page.liquid` inside `<main>` behind `request.page_type == 'policy'`. Policy pages have no template type (Shopify renders `/policies/*` itself into the layout), so the layout guard is the only place the policy restyle and jump nav can live; "take theirs" here silently unstyles all five policy pages. |
| `sections/password-footer.liquid` | The `color_scheme` schema default is `sss-dark-scheme`, not `scheme-1`. There is no stored override, so the schema default is what renders. |

## Development and contributing

```bash
npm ci                       # install pinned tooling
npx shopify theme dev        # local preview (ephemeral, no production impact)
npx shopify theme check      # lint (same as CI)
```

To lint the workflow YAML the way CI does (same shellcheck excludes):

```bash
SHELLCHECK_OPTS="-e SC2016 -e SC2317" actionlint
```

That covers `.github/workflows/` only. `actionlint` has no composite-action mode: handed a
`.github/actions/**/action.yml` it parses the file as a workflow and reports `"jobs" section is
missing` instead of linting the `run:` bodies. CI's `actionlint + shellcheck` step therefore
extracts those bodies to files first and shellchecks them directly, pinned to shellcheck **0.10.0**
so a local run and CI agree. The same pass covers any `lib/*.sh` helper a composite action sources.
To reproduce it:

```bash
# Same pinned build CI uses; the distro package is usually older (Ubuntu 24.04 ships 0.9.0) and
# will not agree with the row.
curl -fsSL https://github.com/koalaman/shellcheck/releases/download/v0.10.0/shellcheck-v0.10.0.linux.x86_64.tar.xz \
  | tar -xJ -C /tmp shellcheck-v0.10.0/shellcheck

rm -rf /tmp/composite-bodies   # CI clears it first; a stale body from a renamed step lints otherwise
node scripts/lib/composite-shell.mjs /tmp/composite-bodies .github/actions/*/action.yml
SHELLCHECK_OPTS='' /tmp/shellcheck-v0.10.0/shellcheck --norc --shell=bash -e SC1091 \
  /tmp/composite-bodies/*.sh .github/actions/*/lib/*.sh
```

`SHELLCHECK_OPTS=''` is not decoration: shellcheck reads that variable from the environment, so
without clearing it the workflow-shell suppressions in the block above would silently apply here
too. CI clears it for the same reason.

The extracted files are left-padded with blank lines, so shellcheck's line numbers are the source
`action.yml`'s line numbers. The extractor fails closed rather than under-reporting: an unsupported
`run:` form, zero bodies extracted, or a GitHub expression surviving into a body each exit non-zero.
`npm run lib:test` runs it over the repo's real composite actions, so drift fails locally before it
reaches CI.

`.theme-check.yml` extends `theme-check:recommended` with two checks disabled as documented false positives: `JSONMissingBlock` (Judge.me app blocks render at runtime and cannot be resolved statically) and `MatchingTranslations` (Horizon ships a wide locale matrix that legitimately lags `en.default.json` between merges). It also ignores three paths: `node_modules/**`; `marketing/**`, whose Shopify Email and notification templates are not theme code and use objects (`unsubscribe_url`, `open_tracking_block`, `email.*`, `fulfillment`) that no theme defines; and `scripts/notifications/test/fixtures/**`, synthetic notification templates for that suite. Triaged findings are tracked in [`THEME_CHECK_NON_ACTIONABLE.md`](THEME_CHECK_NON_ACTIONABLE.md); check it before fixing a theme-check warning.

For a whole-site customer-workflow sanity test against the live store (cart mechanics, shipping copy vs Admin rates, variant weights, forms, accounts, notifications), run the `/site-check` skill from Claude Code; it drives the read-only tooling under `scripts/site-check/` and hands the rest to an operator checklist. See [`scripts/site-check/README.md`](scripts/site-check/README.md).

Before opening a PR, run `theme dev` and `theme check` locally, and follow the conventions in [`docs/theme-conventions.md`](docs/theme-conventions.md) and the accessibility rules and widget patterns in [`docs/accessibility-patterns.md`](docs/accessibility-patterns.md). House style is enforced as a hard rule: no em dashes anywhere in the repo.

## Deeper docs and license

| Doc | Covers |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Always-loaded policy layer: the rules that fail silently, plus the pointer into each reference below |
| [`release-notes.md`](release-notes.md) | Full CI/CD design rationale (attack surface, mitigations) and history |
| [`docs/theme-conventions.md`](docs/theme-conventions.md) | Component framework, theme-editor integration, block file structure, Liquid/CSS/HTML/JS standards |
| [`docs/structured-data.md`](docs/structured-data.md) | Hand-authored JSON-LD: what each snippet emits and the rules that silently invalidate it |
| [`docs/theme-settings-contracts.md`](docs/theme-settings-contracts.md) | Social links, the generated collections dropdown, vacation mode, shipping copy, `data-fieldset-index` |
| [`docs/accessibility-patterns.md`](docs/accessibility-patterns.md) | Global accessibility rules plus the component-specific widget patterns used across the theme |
| [`docs/deploy-gate-reference.md`](docs/deploy-gate-reference.md) | Full mechanical breakdown of the four auto-deploy gates in `deploy.yml` |
| [`docs/smoke-test-reference.md`](docs/smoke-test-reference.md) | Full post-deploy smoke-test behavioral contract (HARD-FAIL/SOFT-WARN, locked-vs-public) |
| [`docs/shopify-mcp-notes.md`](docs/shopify-mcp-notes.md) | Known gaps in the Shopify MCP servers (scopes, media upload, `templateSuffix`, Flow) |
| [`docs/product-media-alt-text.md`](docs/product-media-alt-text.md) | How product alt text drives the colour gallery filter; the only record of that contract |
| [`THEME_CHECK_NON_ACTIONABLE.md`](THEME_CHECK_NON_ACTIONABLE.md) | Triaged, non-actionable theme-check findings |
| [`LICENSE.md`](LICENSE.md) | Full license terms |

**License.** Copyright (c) 2025-present Shopify Inc. This theme inherits Shopify's Horizon license: an MIT-style grant restricted to developing themes that interoperate with Shopify, and prohibiting redistribution of a Derived Theme via the Theme Store or any other channel. See [`LICENSE.md`](LICENSE.md) for the full terms.
