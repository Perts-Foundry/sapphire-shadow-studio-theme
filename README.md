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

Branch from `main` for any code change. PRs run theme-check and deploy a per-PR preview theme; see CI/CD below.

## CI/CD

Five workflows in `.github/workflows/`:

| Workflow | Triggers | Purpose |
|---|---|---|
| `pr-checks.yml` | PR; push to `main`/`shopify-sync` (theme-check job only) | Three parallel jobs. `theme-check`: lints theme via `Shopify/theme-check-action`. `pr-reconcile-check`: fails the PR if `shopify-sync` has commits not in the branch. `lint-workflows`: runs `actionlint` and `zizmor` when `.github/` paths change. All three jobs are required checks on `main` (context: `pr-checks / <job-name>`). |
| `preview.yml` | PR open/sync/close | Creates a per-PR unpublished theme `pr-<n>-preview`, comments link on the PR, deletes on close. |
| `sync-reconcile.yml` | Daily 13:00 UTC; manual | Opens an auto-merge PR from `shopify-sync` to `main` when admin edits arrive. |
| `deploy.yml` | Push to `main`; manual | Deploys to live theme `#181702754604`. Asserts live ID, runs smoke checks, files an issue on failure. |
| `drift-watch.yml` | Weekly Mondays; manual | Detects direct edits to live; sweeps stale rollback snapshots and orphan preview themes. |

All workflows run on `ubuntu-24.04`, pin third-party actions to commit SHAs, set `permissions: {}` at workflow root, and bind any job that handles the Shopify token to the `shopify-write` GitHub Environment. Action SHAs are kept current by Dependabot (`.github/dependabot.yml`).

## Branches and themes

| Ref | Role |
|---|---|
| `main` | Source of truth. Protected: PR + required checks + branch up-to-date. |
| `shopify-sync` | Captures admin edits via the Shopify GitHub Integration on the unpublished `EDIT HERE - Admin Sync` theme. Protected against force-push; `shopify[bot]` writes here. |
| Feature branches | Cut from `main`, PR'd back. Per-PR preview theme `pr-<n>-preview`. |
| Live theme `#181702754604` | Customer-facing. **Disconnected** from GitHub. Only `deploy.yml` writes to it. Never edit via admin Customize/Code editor. |

## Secrets and rotation

| Name | Type | Source |
|---|---|---|
| `SHOPIFY_CLI_THEME_TOKEN` | Repo **secret** | Shopify "Theme Access" app on the store. **Rotate every 90 days.** |
| `SHOPIFY_FLAG_STORE` | Repo **variable** | `sapphire-shadow-studio.myshopify.com`. |
| `shopify-write` | GitHub Environment | Required reviewer = self. Token doesn't hydrate without explicit approval. |

To rotate the token: in admin, regenerate the Theme Access password; paste it into the GitHub repo secret (`Settings -> Secrets and variables -> Actions`). Do not echo to terminal.

## Rollback

If the live theme is in a bad state:

1. **Most recent commit was bad**: revert it on `main` (`git revert <sha> && git push`). `deploy.yml` re-runs and ships the revert. Total recovery time is one deploy cycle (~3 min).
2. **CI is broken and you need a hotfix**: bypass branch protection and push directly to `main` with a `[hotfix]` commit prefix. `deploy.yml` runs and files an audit issue automatically.
3. **CI cannot deploy at all**: pull the last known-good SHA locally and `npx shopify theme push --live --allow-live` directly until CI is fixed.
4. **Need a known-good snapshot**: `drift-watch.yml` keeps weekly `rollback-YYYYMMDDTHHMMSSZ` unpublished themes for 14 days. In admin, publish the most recent one to recover instantly, then dig into what went wrong.

The cutover-state baseline is tagged `v1-ci-cutover`.

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
