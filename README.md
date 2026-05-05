# Sapphire Shadow Studio theme

Custom Shopify theme based on Shopify's [Horizon](https://github.com/Shopify/horizon) flagship theme.

[Local development](#local-development) | [CI/CD](#cicd) | [Branches and themes](#branches-and-themes) | [Secrets and rotation](#secrets-and-rotation) | [Rollback](#rollback) | [Staying current with Horizon](#staying-current-with-horizon) | [License](#license)

## Local development

```bash
npm ci                       # install pinned Shopify CLI
npx shopify theme dev        # local dev server (hot reload)
npx shopify theme check      # lint
```

The Shopify CLI version is pinned in `package.json` and `package-lock.json`. Always use `npx shopify` (not a globally installed CLI) to ensure CI and local match.

Branch from `main` for any code change. PRs run validate (theme-check, secret scan, etc.) and deploy a per-PR preview theme; see CI/CD below. To deploy a feature branch, open a PR, wait for Validate to pass, then comment `deploy` on the PR. Direct push to `main` is not part of the workflow.

## CI/CD

Seven workflows in `.github/workflows/`. Deploy is **comment-driven**: a write+ collaborator comments `deploy` on a PR, the workflow validates and ships from the PR head, and the PR squash-merges only after the deploy succeeds. Failures post a sticky comment and the PR stays open.

| Workflow | Triggers | Purpose |
|---|---|---|
| `validate.yml` | PR open/sync/reopen | Four parallel checks (`theme-check`, `pr-reconcile-check`, `lint-workflows`, `secret-scan`) plus an aggregator that posts the sticky validation report. The required checks on `main`. |
| `preview.yml` | PR open/sync/close | Creates a per-PR unpublished theme `pr-<n>-preview`, comments link on the PR, deletes on close. |
| `deploy.yml` | Comment `deploy` on a PR | Verifies validate passed for the PR HEAD SHA, pushes the theme to live, smoke-tests `/`, `/cart`, `/collections/all`, then squash-merges the PR and deletes the branch. Sticky deploy / failure report. |
| `sync-reconcile.yml` | Daily 13:00 UTC; manual | Opens or refreshes a PR from `shopify-sync` -> `main` with the `auto-reconcile` label when admin edits arrive. **Does not auto-merge**; the auto-deploy chain takes over after Validate. |
| `shopify-sync-auto-deploy.yml` | After validate succeeds on the `shopify-sync` PR | Re-runs the diff-sanity gate, signed-commit gate, base-staleness gate; deploys to live; squash-merges. |
| `dependabot-auto-deploy.yml` | After validate succeeds on a `dependabot/**` PR | Same shape as shopify-sync-auto-deploy with Dependabot-specific gates: signed by `dependabot[bot]`, refusal if `.github/{workflows,actions,scripts}` modified, major-version bumps require an `auto-deploy-major` label. `manual-review` label is the escape hatch. |
| `drift-watch.yml` | Weekly Mondays; manual | Detects direct edits to live; sweeps stale rollback snapshots and orphan preview themes. |

All workflows run on `ubuntu-24.04`, pin third-party actions to commit SHAs, and set `permissions: {}` at workflow root with per-job grants. Jobs that handle the Shopify token read it from a repo-level secret directly; there is no GitHub Environment binding. Dependabot keeps action and npm dependencies current (`.github/dependabot.yml`); npm bumps auto-deploy via `dependabot-auto-deploy.yml` after Validate passes, but action-SHA bumps are refused by the auto-deploy guard (it rejects any change under `.github/{workflows,actions,scripts}/` to prevent CI self-modification) and require manual review and a `deploy` comment.

**Deploy gate.** No GitHub Environment is involved at all. Three computed gates govern access: collaborator-permission check on the comment author (`deploy.yml`), validate-on-HEAD-SHA verification (every deploy path), signed-commit gate using GitHub-resolved logins on auto-deploy paths. See `CLAUDE.md` for the trust delta and known compensations.

## Branches and themes

| Ref | Role |
|---|---|
| `main` | Source of truth. Protected: PR + required checks + branch up-to-date. |
| `shopify-sync` | Captures admin edits via the Shopify GitHub Integration on the unpublished `EDIT HERE - Admin Sync` theme. Protected against force-push; `shopify[bot]` writes here. |
| Feature branches | Cut from `main`, PR'd back. Per-PR preview theme `pr-<n>-preview`. |
| Live theme `#181702754604` | Customer-facing. **Disconnected** from GitHub. Only the deploy chain (`deploy.yml`, `shopify-sync-auto-deploy.yml`, `dependabot-auto-deploy.yml`) writes to it; all three paths require Validate green on the PR HEAD SHA before they push. Never edit via admin Customize/Code editor. |

## Secrets and rotation

| Name | Type | Source |
|---|---|---|
| `SHOPIFY_CLI_THEME_TOKEN` | Repository **secret** | Admin API access token from a Custom App on the store with `read_themes` and `write_themes` scopes (token starts with `shpat_`). |
| `SHOPIFY_DOMAIN` | Repository **variable** | Canonical storefront origin host (e.g. `sapphireshadowstudio.com`), no scheme, no trailing slash. The deploy chain prefixes `https://` and uses this as the smoke-test base URL; the smoke test follows the myshopify handle's 301 to this host and asserts a final 200. |
| `SHOPIFY_FLAG_STORE` | Repository **variable** | The store's **internal myshopify handle** (e.g. `yr5ye0-ua.myshopify.com`), not the friendly admin alias. Shopify rejects auth against the alias with a 401. The internal handle is shown on the Theme Access password email and on `admin/.../themes` URL parameters; you can also recover it via `gql { shop { myshopifyDomain } }` against the Admin API. The handle is observable from any storefront response and is correctly classified as a variable, not a secret. |

**Setup (one-time):** In the Shopify admin, Settings -> Apps and sales channels -> Develop apps -> Create an app (e.g. `sapphire-ci-deploy`). Configure Admin API scopes: `read_themes`, `write_themes`. Install the app on the store. Reveal the Admin API access token (shown once) and paste it into the GitHub repo secret (`Settings -> Secrets and variables -> Actions -> Repository secrets -> SHOPIFY_CLI_THEME_TOKEN`). Then under the Variables tab on the same page, create `SHOPIFY_DOMAIN` (canonical storefront host) and `SHOPIFY_FLAG_STORE` (internal myshopify handle). Custom App tokens do not expire on a schedule; rotate by uninstalling and recreating the app whenever a credential needs to change. Do not echo to terminal.

The Shopify CLI accepts the same env var (`SHOPIFY_CLI_THEME_TOKEN`) for either a Custom App access token or a Theme Access app password. This repo standardised on Custom App tokens because they avoid an extra third-party app install, do not auto-expire, and reuse Shopify's native admin auth surface.

## Rollback

If the live theme is in a bad state:

1. **Most recent merged PR was bad**: open a revert PR (`gh pr create --base main` from `git revert <sha>`). Validate runs; comment `deploy` to ship the revert. Total recovery time is one comment-deploy cycle.
2. **CI cannot deploy at all**: pull the last known-good SHA locally and run `npx shopify theme push --live --allow-live` directly. Documented break-glass path; logs the operator's local Shopify identity rather than the CI service-account token.
3. **Need a known-good snapshot**: `drift-watch.yml` keeps weekly `rollback-YYYYMMDDTHHMMSSZ` unpublished themes for 14 days. In admin, publish the most recent one to recover instantly, then dig into what went wrong.

## Staying current with Horizon

Horizon's upstream lives at https://github.com/Shopify/horizon. To pull updates:

```bash
git remote add upstream https://github.com/Shopify/horizon.git  # one-time
git fetch upstream
git switch -c chore/horizon-merge-$(date +%Y-%m-%d)
git merge upstream/main
# resolve conflicts; the customizations under blocks/, snippets/, sections/ usually conflict
git push -u origin HEAD
```

Open a PR; CI runs as normal.

## License

Copyright (c) 2025-present Shopify Inc. See [LICENSE](/LICENSE.md) for further details.
