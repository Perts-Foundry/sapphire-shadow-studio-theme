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

Four workflows in `.github/workflows/`. Deploy is unified in one workflow with three trigger paths: a write+ collaborator can comment `deploy` on any PR (manual), or `workflow_run` after Validate succeeds on a `shopify-sync` reconcile PR or a `dependabot/**` PR (auto). All three paths share the same live-push + squash-merge ladder, gated by trigger-specific checks. The PR squash-merges only after the deploy succeeds. Failures post a sticky comment and the PR stays open.

| Workflow | Triggers | Purpose |
|---|---|---|
| `validate.yml` | PR open/sync/reopen | One sequential job with five steps (`theme-check`, `reconcile`, `actionlint`, `zizmor`, `gitleaks`) plus an aggregator that posts a sticky CI Report. Single required check on `main`: `validate / validate`. |
| `preview.yml` | PR open/sync/close | Creates a per-PR unpublished theme `pr-<n>-preview`, comments link on the PR, deletes on close. |
| `deploy.yml` | (1) Comment `deploy` on a PR (dev); (2) `workflow_run` after Validate on `shopify-sync` (auto); (3) `workflow_run` after Validate on `dependabot/**` (auto) | Two-job structure: `gate` (no Shopify token; runs trigger-conditional checks: collaborator-permission for comments, signed-commit + PR-opener-identity + diff-sanity + base-staleness for auto-deploys, plus Validate-on-HEAD-SHA re-verification with `compareCommits.status === 'identical'` for HEAD-drift; **draft-PR escape hatch** halts auto-deploy on any draft PR) and `deploy` (token-bearing; pushes to live, smoke-tests, squash-merges, deletes preview theme, syncs `main -> shopify-sync` via fast-forward or `--force-with-lease` for phantom orphans). Sticky deploy / failure report under the unified `<!-- deploy-result -->` marker. |
| `sync.yml` | Push to `shopify-sync`; daily 13:00 UTC; manual | On admin commits to `shopify-sync`, opens or refreshes the single reconcile PR (`head: shopify-sync, base: main`). Phantom-orphan PRs (same-tree as main) are skipped; `deploy.yml`'s post-merge sync step cleans them up next deploy. **Does not auto-merge**; `deploy.yml`'s `workflow_run` arm takes over after Validate. |

All workflows run on `ubuntu-24.04`, pin third-party actions to commit SHAs, and set `permissions: {}` at workflow root with per-job grants. Jobs that handle the Shopify token read it from a repo-level secret directly; there is no GitHub Environment binding. Dependabot keeps action and npm dependencies current (`.github/dependabot.yml`); minor/patch bumps auto-deploy via `deploy.yml`'s dependabot arm after Validate passes, but major-version bumps default-skip auto-deploy and require manual `deploy` comment after review. Action-SHA changes to any file under `.github/{workflows,actions,scripts}/` are refused by the auto-deploy guard (CI-self-modification protection) and also require manual review and a `deploy` comment.

**Deploy gate.** No GitHub Environment is involved at all. Three computed gates govern access, all in `deploy.yml`'s `gate` job: collaborator-permission check on the comment author (comment path), validate-on-HEAD-SHA verification (all three paths), signed-commit gate using GitHub-resolved logins (`workflow_run` paths). The `gate` job runs without `SHOPIFY_CLI_THEME_TOKEN` in scope; the secret only enters the `deploy` job (`needs: gate`). See `CLAUDE.md` for the trust delta and known compensations.

## Branches and themes

| Ref | Role |
|---|---|
| `main` | Source of truth. Protected: PR + required checks + branch up-to-date. |
| `shopify-sync` | Captures admin edits via the Shopify GitHub Integration on the unpublished `EDIT HERE - Admin Sync` theme. Protected against force-push; `shopify[bot]` writes here. |
| Feature branches | Cut from `main`, PR'd back. Per-PR preview theme `pr-<n>-preview`. |
| Live theme `#181702754604` | Customer-facing. **Disconnected** from GitHub. Only `deploy.yml` writes to it (via three trigger paths: `issue_comment`, `workflow_run` on `shopify-sync`, `workflow_run` on `dependabot/**`); all three paths require Validate green on the PR HEAD SHA before they push. Never edit via admin Customize/Code editor. |

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

## Staying current with Horizon

Horizon's upstream lives at https://github.com/Shopify/horizon. This repo is **standalone, not a GitHub fork**: attribution lives in [`LICENSE.md`](/LICENSE.md) (Shopify MIT, preserved verbatim), and updates are pulled via plain `git`.

The **first** upstream sync after the 2026-05-03 republish needs `--allow-unrelated-histories` because the new history shares no commit ancestry with `Shopify/horizon`. The repo's root commit (`init: import Horizon baseline at upstream commit 09db732`) carries Horizon's tree at the last sync point but is a separate root commit; git's merge-base uses the commit DAG, not tree equivalence, so the flag is the one-time fix. After the first merge lands, the merge commit becomes the common ancestor and subsequent syncs work normally.

```bash
git remote add upstream https://github.com/Shopify/horizon.git  # one-time
git fetch upstream
git switch -c chore/horizon-merge-$(date +%Y-%m-%d)

# First sync after the 2026-05-03 republish:
git merge --allow-unrelated-histories upstream/main

# Subsequent syncs (after the first merge has landed on main):
# git merge upstream/main

# Expect add/add conflicts on every shared file the first time. To inspect
# what actually changed upstream since the baseline (rather than what
# conflicts) diff against the baseline tree:
#   git diff 71b7cc2 upstream/main -- sections/ snippets/ blocks/ assets/
# 71b7cc2 is the "init: import Horizon baseline..." commit at the root of
# this repo's history.

# Resolve conflicts; customisations under blocks/, snippets/, sections/,
# assets/ usually conflict. Keep ours for diverged customisations; take
# theirs for Horizon-internal changes you want to adopt.
git push -u origin HEAD
```

Open a PR; CI runs as normal.

## License

Copyright (c) 2025-present Shopify Inc. See [LICENSE](/LICENSE.md) for further details.
