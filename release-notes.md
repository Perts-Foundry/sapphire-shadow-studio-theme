# Release Notes

## CI/CD GitHub Environment removed (unreleased)

The `shopify-deploy` GitHub Environment is gone. All six jobs that previously bound to it (`preview.yml::deploy-preview`, `preview.yml::cleanup`, `deploy.yml::deploy`, `drift-watch.yml::drift-watch`, `shopify-sync-auto-deploy.yml::auto-deploy`, `dependabot-auto-deploy.yml::auto-deploy`) now read the Shopify CLI token from a repo-level secret directly, with no environment binding.

`SHOPIFY_FLAG_STORE` was demoted from secret to a repo-level variable. The myshopify handle is observable from any storefront response (it appears in `Set-Cookie` and on every checkout redirect) and is not credential material; treating it as a variable is correct, surfaces the value in workflow logs without redaction, and slightly improves debuggability.

`SMOKE_BASE_URL` was retired and replaced by a new `SHOPIFY_DOMAIN` repo-level variable holding just the canonical host (e.g. `sapphireshadowstudio.com`). The deploy workflows prefix `https://` and pass that as the `smoke-base-url` input to the composite action; the smoke action's contract is unchanged.

Trust-model implication: the three computed deploy gates (collaborator-permission check, validate-on-HEAD-SHA, signed-commit) are unchanged and remain the access control. With no env binding, the Shopify token is now readable by any workflow run that the actor can dispatch with the right `permissions:` grant, instead of only by jobs explicitly bound to the env. This is an accepted reduction in defence-in-depth; the env's required-reviewer gate had already been removed earlier (it was self-approval anyway), so the env was no longer a meaningful boundary.

Operator action that accompanied this change (already done): three repo-level entries created (`SHOPIFY_CLI_THEME_TOKEN` secret, `SHOPIFY_DOMAIN` variable, `SHOPIFY_FLAG_STORE` variable). After this change ships, delete the `shopify-deploy` environment in `Settings -> Environments` and clear out the orphaned env-scoped `SMOKE_BASE_URL` secret.

## CI/CD comment-driven deploy (unreleased)

Switched the deploy chain from "merge-then-deploy" to "deploy-then-merge". A write+ collaborator comments `deploy` on a PR; `deploy.yml` validates that the latest validate run on the PR HEAD SHA was green, pushes the theme to live, smoke-tests `/`, `/cart`, and `/collections/all`, then squash-merges the PR and deletes the branch. Failures post a sticky comment and the PR stays open so the developer can push a fix and re-comment.

The `shopify-sync` reconcile PR is now shipped automatically by a new `shopify-sync-auto-deploy.yml` workflow after Validate succeeds (mirroring the dependabot-auto-deploy pattern), with bot-identity, signed-commit, base-staleness, and diff-sanity gates. Dependabot PRs auto-deploy too via a new `dependabot-auto-deploy.yml` with PFW-style safety gates: signed by `dependabot[bot]`, refusal if `.github/{workflows,actions,scripts}` modified, major-version bumps require an `auto-deploy-major` label, `manual-review` label as escape hatch.

The `shopify-write` GitHub Environment was renamed to `shopify-deploy` and now holds `SHOPIFY_CLI_THEME_TOKEN` and `SHOPIFY_FLAG_STORE` as environment-scoped secrets. Required reviewers removed; the deploy gate is now the comment-trigger plus validate-on-HEAD-SHA verification plus the signed-commit gates on auto-deploy paths. The `[hotfix]` push-to-main bypass is gone; CLI break-glass (`npx shopify theme push --live --allow-live`) remains documented for true CI outages.

`pr-checks.yml` was replaced by `validate.yml` (four parallel checks plus a sticky-comment aggregator). A new composite action `.github/actions/shopify-theme-push/` factors out the live and preview push paths and adds smoke-test, per-attempt timeout, and token-redaction.

## CI/CD cutover (2026-05-03)

Switched from Shopify's bidirectional GitHub Integration on `main` to a PR-based deploy model.

### What changed

- Live theme `#181702754604` is no longer GitHub-connected. Production deploys are owned by `.github/workflows/deploy.yml`, which runs on every push to `main`.
- Admin theme-customizer and code-editor edits now flow through a separate unpublished theme `EDIT HERE - Admin Sync`, which is connected to the new `shopify-sync` branch. A daily `sync-reconcile` workflow opens an auto-merge PR from `shopify-sync` to `main` so admin edits reach production through the same gated path as code.
- Every PR runs `theme-check`, deploys a per-PR preview theme `pr-<n>-preview`, and is blocked from merging if `shopify-sync` has unmerged commits (`pr-reconcile-check`).
- Branch protection on `main`: PR required, branches must be up to date, theme-check + pr-reconcile-check required, force-push blocked, branch deletion blocked. Admin bypass enabled for hotfix flow.
- Repo settings: "Allow auto-merge" enabled. GitHub Environment `shopify-write` requires self-approval before the Shopify Theme Access token hydrates in any job.
- New cutover tag: `v1-ci-cutover`.

### Why

The old model auto-deployed every push to `main` without CI, mixing developer commits and admin-side `shopify[bot]` commits on the same branch with no review. Bad commits hit live instantly. The new model adds Theme Check gates, a per-PR preview, and isolates admin edits onto their own branch so they reconcile through PRs.

### Files added

- `.github/workflows/{pr-checks,preview,sync-reconcile,deploy,drift-watch}.yml` (five workflows; `pr-checks.yml` runs three parallel jobs: `theme-check`, `pr-reconcile-check`, `lint-workflows`).
- `.github/dependabot.yml`.
- `package.json`, `package-lock.json` (Shopify CLI pinned to 3.94.3).
- `blocks/CLAUDE.md`, `assets/CLAUDE.md` (per-directory rules for block authoring and CSS/JS coding standards).

### Files removed

- `.cursor/` (45 Cursor-specific rule files). Unique authoring guidance was migrated into the root `CLAUDE.md` and the new per-directory `CLAUDE.md` files; the Cursor regex-DSL files were not (theme-check + review agents cover that role).

### Files modified

- `CLAUDE.md`: rewrote "Before Making Changes" for the new branch-from-main / reconcile-check model; trimmed inline Shopify-doc duplication; added Pre-PR review notes; relocated component-specific rules to per-directory `CLAUDE.md` files.
- `README.md`: replaced Horizon upstream boilerplate with project-specific CI/CD docs.
- `.theme-check.yml`: disabled `JSONMissingBlock` to suppress 3 known false-positives from Judge.me Reviews app blocks.
- `THEME_CHECK_NON_ACTIONABLE.md`: noted the `JSONMissingBlock` items are now suppressed in config.

---

# Release Notes - Version 3.2.1

This release delivers extensive performance optimizations across many components and resolves issues in the menu drawer, cart, and sticky add-to-cart behavior.

## What's Changed

### Fixes and improvements

- [Performance] Improved Liquid rendering performance by reducing snippet use
- [Performance] Improved overall CSS performance
- [Performance] Improved animation performance
- [Performance] Improved header, email signup, quick-add, meta color, predictive search, hero banner, fly-to-cart, jumbo text, and slideshow performance
- [Performance] Improved page load speed when page transitions are turned off
- [Performance] Disabled all view transitions for low-powered devices
- [Performance] Improved interaction performance for various components
- [Menu drawer] Fixed menu drawer not closing on Firefox
- [Footer] Fixed footer copyright text wrapping
- [Quick add] Fixed quick add modal variant selector appearance issues after opening multiple modals
- [Collection cards] Collection cards in lists and grids match height of tallest card
- [Slideshow] Fixed slideshow controls visibility on transparent product images
- [Marquee] Fixed marquee jump on mobile scroll
- [Sticky add to cart] Polished sticky add to cart behaviors
- [Cart drawer] Entire cart drawer becomes scrollable when its footer is too tall
- [Cart drawer] Addressed UI inconsistencies in the cart drawer
- [Gift cards] Fixed "copy gift card code" button
- [Cart] Fixed discount field sizing for narrow viewports
- [Blog] Removed section title uppercase styling
- [Editor] Added recommended blocks to Slideshow and Layered slideshow
- [Editor] Improved the clarity of a number of labels in the editor
