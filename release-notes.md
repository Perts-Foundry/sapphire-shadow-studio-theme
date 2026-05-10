# Release Notes

## CI/CD deploy chain consolidation (unreleased)

Three near-identical deploy workflows (`deploy.yml`, `shopify-sync-auto-deploy.yml`, `dependabot-auto-deploy.yml`) collapse into a single `deploy.yml` with three trigger paths. `sync-reconcile.yml` becomes `sync.yml`, single-direction only. `setup-labels.yml` deleted; the deploy chain no longer gates on labels. Net: 4 workflow files (was 8), ~700 lines of YAML deleted, all three automation paths preserved.

Root cause for the consolidation: the three deploy workflows shared one live-push + smoke-test + squash-merge + delete-preview ladder; they differed only in their gate logic (collaborator-permission vs signed-commit + diff-sanity + label gates). Maintaining three copies of the ladder triples the change-failure surface, and the bidirectional dance in `sync-reconcile.yml` (a `push: main` fast-forward arm plus a `push: shopify-sync` reconcile-PR arm) existed only because the cross-workflow chain after a deploy-driven squash-merge does not fire (GitHub Actions suppresses `push` events triggered by `GITHUB_TOKEN` to prevent infinite loops). PR #7's `push: main` fast-forward arm was dead on arrival for the same reason; the cron was the only mechanism keeping `shopify-sync` in sync, and it failed for six days when an orphan bot commit met a moving `main`.

What changed:

- **MOVED** all three deploy paths into `deploy.yml`. Single workflow file, two-job structure:
  - `gate` runs without `SHOPIFY_CLI_THEME_TOKEN` in scope, with `permissions: { contents: read, pull-requests: write, actions: read, checks: read }`. Resolves trigger context (`comment` | `shopify-sync` | `dependabot`), looks up the PR, re-verifies Validate on the trusted HEAD SHA, then runs trigger-conditional gates (collaborator-permission for `comment`; signed-commit + diff-sanity + label gates for the two `workflow_run` paths). Posts a sticky pre-deploy rejection comment under the unified `<!-- deploy-result -->` marker if any gate fails.
  - `deploy` runs `needs: gate`, with `permissions: { contents: write, pull-requests: write }` and `concurrency: deploy-production`. Pushes to live, squash-merges, deletes the preview theme, runs the new `Sync main -> shopify-sync` post-merge step, and posts the deploy report. The `SHOPIFY_CLI_THEME_TOKEN` enters scope only here; a bug in any gate `if:` cannot leak it because the gate job structurally does not have the secret.
- **NEW** `Sync main -> shopify-sync` post-merge step in `deploy.yml`. Replaces the dead `push: main` fast-forward arm. Anchored on the deployed SHA returned by the squash-merge response (not `origin/main` re-resolved later) so the inline sync is tied to what just went live. Three branches:
  - Fast-forward push when `shopify-sync` is reachable from the deployed SHA.
  - `--force-with-lease=shopify-sync:<expected-sha>` reset when `shopify-sync` is ahead but trees are identical (post-auto-deploy phantom-orphan state). Lease catches admin commits racing the push; on rejection, `sync.yml`'s next firing on the admin push refreshes the reconcile PR.
  - Defer to `sync.yml` when `shopify-sync` has real divergence (admin commit landed mid-deploy).
- **RENAMED** `sync-reconcile.yml` to `sync.yml` and shrunk from ~180 lines to ~50. Single direction: on admin commits to `shopify-sync`, open or refresh the auto-reconcile PR. Phantom-orphan detection (DIFF_LOC=0) skips PR creation; deploy.yml handles cleanup. Stale-PR alarm preserved.
- **DELETED** `.github/workflows/shopify-sync-auto-deploy.yml`, `.github/workflows/dependabot-auto-deploy.yml`, and `.github/workflows/setup-labels.yml`. The two auto-deploy files' logic is now `deploy.yml`'s trigger-conditional gate steps. The setup-labels file is gone because the deploy chain no longer uses any labels (see "Label-free deploy gating" below).
- **WORKFLOW-LEVEL `if:`** rejects two failure classes before any runner starts: (a) `issue_comment` events that are not on a PR (the `deploy` body alone on a plain issue would otherwise dispatch a runner) and (b) `workflow_run` events from `validate.yml`'s `push:` triggers (would otherwise spawn an empty deploy attempt on every admin push).
- **DYNAMIC `run-name`** distinguishes the three trigger paths in the Actions tab so the operator can triage at a glance without opening the run.
- **UNIFIED STICKY MARKER** `<!-- deploy-result -->` replaces the per-workflow markers (`<!-- shopify-sync-auto-deploy -->`, `<!-- dependabot-auto-deploy -->`). One sticky comment per PR carries deploy / failure reports across all three trigger paths.
- **UPDATED** `.github/zizmor.yml`: `dangerous-triggers.ignore` now lists `deploy.yml` with an inline rationale block; the two deleted workflows are gone.
- **UPDATED** `CLAUDE.md` "Deploy gate trust delta", "Admin-side edits", "Live theme", "Token rotation call-site catalog", and "Pre-PR review" sections; `README.md` workflows table.

Trust-model implications: all three computed gates (collaborator-permission, validate-on-HEAD-SHA, signed-commit) survive intact; their housing changes from three workflow files to one. The no-token-sandbox property documented as trust-delta item 1 is preserved by the two-job structure (`gate` lacks `contents: write` and the Shopify secret). For `workflow_run` paths Validate is explicitly treated as advisory: a malicious PR head could rewrite `validate.yml` to pass falsely, but `getWorkflowRun().head_sha` + `compareCommits.status === 'identical'` + the signed-commit assertion (which reads commit metadata from the API, not from the PR's files) form the actual integrity boundary. Token rotation call-site catalog drops from four workflow files to two (`preview.yml` and `deploy.yml`).

Operator action: none post-merge. The unified `deploy.yml` becomes active on main after this PR squash-merges; subsequent admin commits and Dependabot PRs auto-deploy through the new path. Recovery procedure for any future stuck-state incident (one local command with admin bypass): `git push --force-with-lease=shopify-sync:<expected-sha> origin <main-sha>:shopify-sync`.

Label-free deploy gating: this PR also removes all label-based gates from the deploy chain. The previous mechanisms used three labels (`auto-reconcile` to allow shopify-sync auto-deploy, `manual-review` as escape hatch on both auto-deploy paths, `auto-deploy-major` to opt in to Dependabot major-version auto-deploys). Each is replaced by a native GitHub mechanism that does not require operator label hygiene:

- `auto-reconcile` requirement -> PR-opener-identity check (`pr.user.login === 'github-actions[bot]'`, proving `sync.yml` opened the PR) plus the existing signed-commit assertion on the underlying shopify[bot] commits. A hand-opened shopify-sync -> main PR is rejected by auto-deploy and must be shipped via manual `deploy` comment.
- `manual-review` escape hatch -> draft-PR check (`pr.draft === true`). Operator marks the auto-reconcile PR or Dependabot PR as a draft (via `gh pr ready --undo <n>` or the GitHub UI) to halt auto-deploy; convert to ready-for-review to resume. Halt is bidirectional: applies to both shopify-sync and dependabot auto-deploy arms.
- `auto-deploy-major` opt-in -> major-version bumps default-skip auto-deploy (safer default). Operator comments `deploy` after review to ship a major bump.

`setup-labels.yml` is deleted; `.github/dependabot.yml`'s `labels:` block is removed. Existing labels in the repo are unused by the deploy chain after this PR; they can be left in place or pruned manually with `gh label delete`.

Additional reviewer-flagged fixes folded into this PR:

- `gate` and `deploy` jobs now declare `issues: write` for `createForIssueComment` reaction calls (the PR-comment reactions endpoint routes through the issues API even for PR comments; the prior `pull-requests: write`-only grant was undocumentedly permissive).
- `sync.yml`'s stale-PR alarm no longer exits 1, which previously turned every cron firing red whenever an auto-reconcile PR was open >3 days. Stale-PR notice is now a `::warning::` annotation plus the per-PR comment.
- The "Sync main -> shopify-sync" step's race-recovery messaging in the deploy report now correctly states "retry on next admin push or 13:00 UTC cron" rather than implying immediate retry.
- The resolve step's "Unexpected head_branch" case is now a `::warning::` (was silent `::info::`); an unexpected event_name now `setFailed`s (was unreachable but now defensive).
- `sync.yml`'s `Determine sync status` step now writes `ahead=0, loc=0` defaults upfront for clarity even when AHEAD=0 (no functional change).
- CLAUDE.md "Code changes" section documents the local-actionlint invocation that matches CI's `SHELLCHECK_OPTS` for SC2016 / SC2317 suppressions.
- CLAUDE.md "Token rotation call-site catalog" now enumerates the composite action (`shopify-theme-push/action.yml`) as the canonical consumption point in addition to the two workflow passthrough sites.

## CI/CD preview cleanup + install consolidation (unreleased)

Synchronous preview-theme cleanup on auto-merge, plus consolidation of the Shopify CLI install pattern. Closes the leak where `pr-N-preview` themes survived after a token-driven squash-merge.

Root cause: GitHub Actions does not fire downstream workflows for events triggered by the default `GITHUB_TOKEN`. The three deploy paths (`deploy.yml`, `shopify-sync-auto-deploy.yml`, `dependabot-auto-deploy.yml`) all close PRs by calling `pulls.merge` with `GITHUB_TOKEN`, so `preview.yml::cleanup` (gated on `pull_request: closed`) silently never fires after a token-driven merge.

What changed:

- **NEW** composite action `.github/actions/setup-shopify-cli/` — single source for `actions/setup-node` + `npm ci --ignore-scripts`. Used by `shopify-theme-push` and `validate.yml`. The CLI version pin (`@shopify/cli@3.94.3`) lives only in `package.json`.
- **EXTENDED** `.github/actions/shopify-theme-push/` with `mode: delete-preview`. Lists themes named `pr-${PR_NUMBER}-preview` and deletes them. Exits 0 on no-match (informational); non-zero on real Shopify API/auth failure so a token rotation surfaces loudly. New `cleanup-status` output threads into the deploy report comment.
- **REFACTORED** the three deploy workflows: split the prior `Merge PR and report success` mega-step into a four-step ladder (`Live theme push` -> `Squash merge` -> `Delete preview theme` (continue-on-error, gated on merge success) -> `Post (auto-)deploy report`). Cleanup ordering is post-merge intentionally — a runner crash or non-transient cleanup failure cannot leave the system in `live deployed + PR open + preview gone`.
- **UPDATED** `preview.yml::cleanup` to call `shopify-theme-push` with `mode: delete-preview`. Replaces inline `npm install -g @shopify/cli@3.94.3` + bash with the composite action call (after a `ref: main` checkout because the PR head ref may already be deleted).
- **UPDATED** `validate.yml` to use `setup-shopify-cli` (drops a duplicate setup-node + npm-ci block).
- **DELETED** `.github/workflows/drift-watch.yml`. Loss of weekly orphan-preview sweep is accepted; the synchronous cleanup is the primary mechanism, with manual `npx shopify theme list | grep pr-` plus `shopify theme delete --theme <id> --force` as the documented recovery path.
- **UPDATED** `sync-reconcile.yml` to remove issue creation (issues are disabled on this repo). Diff-sanity alarm now relies on workflow-failure notifications; stale-PR alarm posts a `gh pr comment` per stale PR. `issues: write` permission dropped.
- **UPDATED** `setup-labels.yml` to drop the `deploy-attention` label (no remaining callers) and `issues: write` permission.

Trust-model implications: token-rotation call-site catalog drops from 7 sites to 4, and all four now route through `shopify-theme-push`. There is no longer an automated detector for unauthorised admin-side edits to the live theme — the "live = main" invariant is operator discipline, not CI-enforced. Acceptable for a single-developer private repo.

Operator action: after this PR merges, manually delete the leaked `pr-3-preview` theme: `npx shopify theme delete --theme 183494148396 --force`.

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

`pr-checks.yml` was replaced by `validate.yml` (one sequential job with five steps — `theme-check`, `reconcile`, `actionlint`, `zizmor`, `gitleaks` — plus a sticky-comment aggregator). A new composite action `.github/actions/shopify-theme-push/` factors out the live and preview push paths and adds smoke-test, per-attempt timeout, and token-redaction.

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
