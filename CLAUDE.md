# CLAUDE.md

Guidance for Claude Code working in this repo. The repo is a custom Shopify theme based on Horizon, deployed via a PR-based comment-deploy model. `README.md` documents the surface (workflow tables, branches, secrets, rollback, upstream-merge mechanics); this file holds Claude-specific policy, gotchas, and theme conventions.

## Sensitive Content

This repository is **public**. Real personal contact metadata, internal strategy / legal advisory content, and dev-machine identifiers must never appear in the repo, git history, PRs, issues, comments, or release artifacts. Brand-personality copy that already appears on the storefront (founder narrative, About / FAQ pages, photography filenames that don't expose personal identifiers) is intentional and fine to commit. The repo was deleted-and-recreated once already to scrub embedded metadata; do not reintroduce it.

The `secret-scan` job (Gitleaks) catches token-shaped strings but does not catch personal emails, addresses, or merchant-keyed prose — the author's responsibility per the checklist below.

### What is sensitive (do not commit)

- **Personal contact metadata**: personal email addresses (Gmail, iCloud, etc.), personal phone numbers, full home / fulfilment addresses, personal social handles. The brand identifies itself via the public storefront; individual operators do not need to.
- **Commit-author email**: local `git config user.email` must be `seth@pertsfoundry.com` or the GitHub no-reply form. Personal Gmail in `Author:` lines is a commit-metadata leak that **no diff will ever show**, so it slips through every other check.
- **Dev-machine identifiers**: absolute filesystem paths with a username (`/Users/Seth/...`, `/c/Users/Seth/...`, `/mnt/c/Users/Seth/...`, `~/repos/...`). Use placeholders in docs (`<screenshots-dir>`, `<repo-root>`); the user's private global `~/.claude/CLAUDE.md` holds the real path.
- **Internal advisory / strategy docs**: legal-exposure analyses, ADA-risk playbooks, insurance posture notes, settlement-range guidance, demand-letter response checklists, tax / accounting research. These belong in a private notes location (1Password, private gist, `~/notes/`), never in `docs/` of a public theme repo.
- **Operating location below state level**: city, county, ZIP, or any detail that could pinpoint a home-based operation. Brand-level state-or-larger framing in storefront copy is fine; legal-exposure framing tied to a specific jurisdiction is not.
- **Tokens of any kind**: `SHOPIFY_CLI_THEME_TOKEN`, GitHub PATs, Shopify Admin API tokens, third-party app keys (Judge.me, Klaviyo, etc.), AI keys. CI references `${{ secrets.* }}` only.
- **Real customer / order / financial data**, even truncated. Use synthetic fixtures (`Test Customer`, `order-id-12345`, `Acme Corp`).
- **Pre-publish drafts** that name real third parties (vendors, suppliers, partners) outside what's already on the storefront.

### What is NOT sensitive (and is fine to commit)

- Founder narrative and brand voice: anything already on the storefront's About / FAQ page (first names, husband-and-wife framing, prior-career mentions, pet references). Image filenames encoding pet names (`Kitkat-Rory.jpg`) are fine when the same names appear in visible copy.
- The brand name "Sapphire Shadow Studio" and the public store handle `sapphire-shadow-studio`.
- Live theme numeric ID (`#181702754604`) — public on every storefront page render, not authentication material.
- The `*.myshopify.com` storefront domain and any custom storefront domain.
- App-embed install UUIDs assigned to installed apps (Shopify Inbox, Judge.me) — observable in any browser DOM inspection.
- Public Shopify policies content (shipping, returns, refund) served under `/policies/...`.
- State-level location framing in storefront copy (not in legal / strategy context).
- Synthetic test fixtures.
- The `EXPECTED_SYNC_PR_OPENER` repo variable's value (a GitHub login). The opener identity is necessarily public surface — visible on every PR the PAT opens, on every commit attributed to the user, in the repo contributors page — so storing it as a secret would not protect it; it is a configuration value the deploy gate must read at runtime.
- The `SHOPIFY_SYNC_DEPLOY_KEY` deploy key's **public-key fingerprint and title** as shown on the repo's deploy-keys page (`/settings/keys`). The page is admin-only, and the fingerprint is not credential material in any case (deploy-key authentication requires possession of the private key). The deploy key's **numeric ID** (returned by `GET /repos/{owner}/{repo}/keys`) and the bypass-actor entry's **`actor_id`** (returned by `GET /repos/{owner}/{repo}/rulesets/{ruleset_id}`) are admin-observable identifiers, not authentication material; they are fine to cite in release notes and CLAUDE.md when forensically useful.

### Pre-push checklist

Before every `git push`, every `gh pr create`, every `gh pr comment`, and every `gh issue create`:

1. **Scan the full branch diff** (`git diff origin/main..HEAD`) and **every commit message** (`git log origin/main..HEAD --format=%B`) for: personal emails, personal phone, machine paths, tokens, merchant-keyed strategy framing, sub-state location detail.
2. **Scan the rendered PR / issue / comment body** for the same categories. Content typed into `gh pr create --body` does not pass through the diff scan and is not covered by Gitleaks.
3. **Verify the `secret-scan` CI check is green** on the latest PR run. Red means stop and triage, not "rebase past it."
4. **Verify `git config --local user.email`** is `seth@pertsfoundry.com` or the no-reply form — Gmail in author metadata is the "no diff will ever show" leak from the bullet list above and slips through every other check.
5. If anything sensitive is found:
   - **Pre-push (history not yet on remote)**: rewrite locally with `git rebase -i` or `git commit --amend`. Replace with neutral descriptors. Re-run all checks before pushing.
   - **Already on remote**: stop. Surface to the user before any further action — force-pushing rewritten history to a public repo is a visible event that warrants explicit consent. For a confirmed token, treat as compromised and rotate in addition to (not instead of) history rewrite.
6. Default to redacted-by-default in commit messages and doc entries: describe the *change* (what was edited in the template / block / workflow), not the *real-world entity* that prompted it.

### Memory notes

Memory files under `~/.claude/projects/.../memory/` may contain real operator and merchant context **for the assistant's use only**. Never paste memory content into the repo, PR bodies, or commit messages.

## Screenshots

When the user references a screenshot, or when troubleshooting any issue, proactively check for the latest screenshot. The user's screenshots directory lives in their private global `~/.claude/CLAUDE.md`; ask for it the first time it's referenced in a session if you don't already have it. **Do not commit literal local-machine paths to this repo** (see Sensitive Content above).

## Project overview

Custom Shopify theme based on **Horizon** (Shopify's flagship). Server-rendered Liquid, progressive enhancement, native web platform features. Latest Liquid Storefronts features including theme blocks. Private, single-merchant theme — **not** a Shopify Theme Store submission, so Theme-Store gating criteria (Lighthouse thresholds, 10-color-role ecosystem requirement) do not apply unless explicitly called out below. The repo is **standalone, not a GitHub fork** of `Shopify/horizon`; attribution lives in `LICENSE.md` (Shopify MIT, preserved verbatim) and `README.md`'s "Staying current with Horizon" section, which also documents the upstream-merge mechanics.

## Workflow

PR-based deploy model. Direct edits to `main` and to the live theme are not part of the workflow. `README.md` documents the workflow tables (`validate` / `preview` / `deploy` / `sync`, branches, secrets); this section holds Claude-specific do/don't, the auto-deploy gates, and the deploy-gate trust delta.

### Code changes

1. `git switch -c <feature-branch> origin/main`.
2. Local dev: `npm ci && npx shopify theme dev`. The dev server runs against an unpublished development theme created on the fly; storefront edits to it do not touch live or `shopify-sync`.
3. Open a PR. Validate runs `theme-check`, `reconcile`, `actionlint`, `zizmor --pedantic`, `gitleaks` as one sequential job plus a sticky CI Report aggregator. The single required check on `main` is `validate / validate`. To re-run, push a new commit to the PR branch (there is no `validate` comment trigger; `issue_comment`-dispatched runs would not be associated with the PR HEAD SHA).
4. To run `actionlint` locally with the same shellcheck exclusions CI uses: `SHELLCHECK_OPTS="-e SC2016 -e SC2317" actionlint` (suppressions documented at `validate.yml` lines 113-119).
5. If `reconcile` fails, run the snippet it posts: `git fetch origin && git merge origin/shopify-sync && git push`.
6. Comment `deploy` on the PR. `deploy.yml` handles live push, smoke-test, preview cleanup, deploy-report, squash-merge, and `shopify-sync` fast-forward; see `README.md` for the full step ladder. On any step failure a sticky failure report overwrites the deploy report and the PR stays open.

### Admin-side edits

All theme-customizer / code-editor edits **must** be made on the unpublished `EDIT HERE - Admin Sync` theme (connected to `shopify-sync` via the Shopify GitHub Integration), NEVER on live. Admin edits auto-commit to `shopify-sync` via `shopify[bot]`. `sync.yml` opens or refreshes the single reconcile PR (`head: shopify-sync, base: main`) on each push, with a 13:00 UTC daily safety-net cron. After Validate succeeds on the auto-reconcile PR, `deploy.yml`'s `workflow_run` arm fires, deploys, and squash-merges automatically.

Auto-deploy halts (with a sticky skip-comment naming the reason) on signed-commit-identity failure, PR-opener mismatch, HEAD drift, stale base, missing-main-commits (the defence-in-depth merge-base assertion), or out-of-scope diff (touches `.github/` or `layout/theme.liquid`, or exceeds 1000 LOC). The specific assertions are in Deploy gate trust delta below; a hand-opened shopify-sync PR by any identity other than the configured PAT owner is rejected by the PR-opener check and must be deployed manually via `deploy` comment.

**Escape hatch**: mark the auto-reconcile PR as a draft (`gh pr ready --undo <n>` or the GitHub UI). Draft PRs skip auto-deploy entirely; a human can still comment `deploy` manually. Convert back to ready-for-review to resume. The `shopify-sync` branch is never deleted on merge (long-lived integration target).

To inspect what is currently live without altering the working tree: `npx shopify theme pull -s sapphire-shadow-studio --live --path /tmp/live --nodelete`. **Never** pull live into the working tree (the working tree is the source of truth, not the storefront).

### Live theme

Live theme is `#181702754604`. **Disconnected** from GitHub. Only the unified `deploy.yml` writes to it (three trigger paths: `issue_comment` for dev PRs, `workflow_run` on validate for `shopify-sync`, `workflow_run` on validate for `dependabot/**`); all three paths require Validate green on the PR HEAD SHA. Do not click "Customize" or "Edit code" on the live theme card in admin — use the sync theme. There is no automated drift detection; "live = main" is operator discipline.

### Preview-theme cleanup

`pr-N-preview` themes are deleted synchronously by the deploy workflows after a successful merge (via `shopify-theme-push`'s `mode: delete-preview`), and by `preview.yml::cleanup` on user-driven PR closes. There is no scheduled sweep. Accepted trade-off: if synchronous cleanup silently fails (`continue-on-error: true` masks non-zero exits in the deploy chain) or `preview.yml::cleanup` skips (concurrency cancellation, runner outage), the orphan persists indefinitely. The deploy-report comment's `cleanup_status` line surfaces this; a `:warning: **Preview cleanup warning**` line in that comment is the signal that manual recovery is needed.

Manual recovery (run locally with `SHOPIFY_CLI_THEME_TOKEN` set):

```bash
# List orphans
npx shopify theme list -s sapphire-shadow-studio --json \
  | jq -r '.[] | select(.name | test("^pr-[0-9]+-preview$")) | "\(.id)\t\(.name)"'

# Delete a specific orphan
npx shopify theme delete --theme <id> --force
```

### Smoke test fixtures

None currently defined. `.github/actions/shopify-theme-push/action.yml`'s `smoke-paths` default covers `/`, `/cart`, and `/collections/all`. Per the comment at `action.yml:39`, commit a stable product handle (e.g. `/products/<handle>`) here as a permanent fixture once one exists, then extend the action's `smoke-paths` default at the call site.

### Deploy gate trust delta

The deploy chain has **no GitHub Environment binding**. `SHOPIFY_CLI_THEME_TOKEN` is a repo-level secret; `SHOPIFY_DOMAIN` / `SHOPIFY_FLAG_STORE` are repo-level variables. The previous `shopify-deploy` env was retired because its required-reviewer gate was self-approval (zero security, only friction). The three computed gates below are the actual access controls. `deploy.yml` is a two-job pipeline: `gate` (no-token) sets outputs; `deploy` (token-bearing) consumes them via `needs: gate`, so a bug in any gate `if:` clause cannot leak the token.

1. **Collaborator-permission check** (comment path only). The `gate` job runs `getCollaboratorPermissionLevel` on the `issue_comment` author and proceeds only for `admin` / `write`. The workflow-level `if` also pre-filters by `author_association` and asserts `github.event.issue.pull_request` (a `deploy` comment on a plain issue cannot dispatch a runner).

2. **Validate-on-HEAD-SHA verification** (all paths). The comment path uses `listWorkflowRuns` filtered by `validate.yml`, `head_sha`, and `event: 'pull_request'` — the event filter blocks a future `push` / `workflow_dispatch` trigger on `validate.yml` from masquerading as proof. The two `workflow_run` paths are stronger: they re-fetch the *triggering* Validate run by `workflow_run.id` via `getWorkflowRun`, assert `conclusion: success`, and thread the returned `head_sha` as `trustedSha` through every downstream API call (checkout, merge `sha:`, getCommit). HEAD-drift is first asserted via `pr.head.sha === trustedSha`; `compareCommits.status === 'identical'` is **defence in depth** on top of that. The comparison is commit-object equality, **not** tree equality — same-tree amends, cherry-picks, and different-tree force-pushes all return `diverged`, not `identical`. **Do not "simplify" the `compareCommits` check away** as redundant with the SHA equality above it: `release-notes.md` documents that this guardrail was added explicitly so a future refactor wouldn't remove a load-bearing check on a wrong premise. For `workflow_run` paths, Validate is **advisory** (a malicious PR head could rewrite `validate.yml` to pass falsely); the signed-commit gate below is the actual integrity boundary for auto-deploys.

3. **Signed-commit gate** (workflow_run paths only). Assert `verification.verified === true`, `commit.author.login` equal to the expected bot (`shopify[bot]` for shopify-sync; `dependabot[bot]` for dependabot), and `pull_request.user.login` equal to the expected PR opener. For shopify-sync the expected opener is sourced at runtime from `vars.EXPECTED_SYNC_PR_OPENER` (the `SYNC_RECONCILE_TOKEN` PAT owner; see "Token rotation call-site catalog" below). For dependabot, the expected opener is the `dependabot[bot]` constant. The integrity boundary is `author.login` + `verification.verified` + PR-opener identity (the bot's GPG/SSH signature is bound to its key; rewriting commit content invalidates the signature). `commit.committer.login` may be the expected bot OR `web-flow` and is **informational, not a security signal** — anyone with `contents: write` can produce a `committer=web-flow` commit via web-UI edits, the Update-branch / Rebase buttons, `PUT /contents/{path}` REST calls, or `@dependabot rebase` / `@dependabot recreate` comments, so committer cannot be treated as unimpersonable. Accepting both committer values avoids the false-positive failures the earlier strict-equality form produced on every rebased PR. Git-commit-header fields are not consulted (those are forgeable).

   PR-opener trust delta vs the prior `github-actions[bot]` form: the shopify-sync expected opener was once the GitHub-Actions runtime identity, essentially unimpersonable from outside a workflow execution context. After the PAT switch the expected opener is a human GitHub login — the PAT-owner account — which is PAT-exfiltrable. The mitigation chain (in order):
   - **Block 1, commit-identity (unchanged):** even if an attacker hand-opens a PR via PAT exfil, the HEAD commit must still be `author.login === shopify[bot]` AND signature-verified. The attacker can only PR commits `shopify[bot]` genuinely authored at some point in history.
   - **Block 2, defence-in-depth merge-base assertion (new):** `repos.compareCommits(base: main, head: pr.head.sha)` must report `behind_by === 0`. A stale `shopify[bot]` commit that predates a subsequent main-tip advance is missing main commits and the gate skips. This catches the "replay an old shopify[bot] commit" attack that PAT exfil otherwise enables.
   - **Residual surface:** "hand-open a PR with a current-base shopify[bot] commit." The damage is bounded to "auto-deploy ships content shopify[bot] genuinely authored, in the same tree-state shopify[bot] would naturally produce" — much smaller than "ship arbitrary content."

4. **Defence-in-depth merge-base assertion** (both workflow_run paths, after the base-staleness check in each gate). Assert `repos.compareCommits(base: main_tip, head: trustedSha).behind_by === 0`. The base-staleness check at gate item 3 only catches "main advanced after the PR was created"; it does NOT catch "PR head was missing main commits at PR creation time." For shopify-sync this assertion catches both the misleading-revert PR scenario (sync.yml opened a PR while shopify-sync was missing main commits) and the PAT-exfil hand-opened-stale-PR attack from Block 2 above. sync.yml has its own prevention guard at the create-PR call site that fails closed in the same scenario; the deploy-side assertion is the independent defence-in-depth so a hand-opened PR that bypasses sync.yml's guard still cannot ship. For dependabot the assertion is belt-and-braces against a hypothetical Dependabot behaviour change where a PR could carry a current `pr.base` but a head SHA missing main commits (e.g. partial-rebase race); in Dependabot's normal flow `pr.base` and `pr.head` advance together on every rebase and the assertion is a no-op. Symmetric across both arms.

All four gates depend on the workflow files being correct. A compromised collaborator account that can land any PR (or force-push `shopify-sync`, or open a `dependabot/`-named PR with a forged signature) bypasses all of them. The `SYNC_RECONCILE_TOKEN` PAT does not enlarge this surface: a collaborator with `contents: write` could already exfiltrate any secret via a malicious workflow change, so the PAT is bounded by the same all-bets-are-off threshold the trust model already accepts.

`deploy.yml` is a three-job pipeline: `gate` (no token, runs the four gate checks) sets outputs; `deploy` (Shopify-token-bearing) consumes them via `needs: gate` and pushes to live + smoke-tests + squash-merges; `sync` (SSH-deploy-key-bearing, no Shopify token) runs `needs: deploy` and reconciles `shopify-sync` to the deployed SHA. The job split is load-bearing: a bug in any `gate` `if:` clause cannot leak the Shopify token (gate has no token); a bug in `sync` bash cannot leak the Shopify token (sync has no Shopify token); a bug in `deploy` bash cannot leak the deploy key (deploy has no deploy key).

**Known compensations** (deferred, not implemented today): a separate preview-only Shopify token so a leaked preview token cannot push live; a long-lived `auto-deploy-audit` GitHub issue recording every auto-deploy (SHA, bot, PR, merge-as) for forensics beyond the 90-day workflow-log retention.

Post-merge force-push to `shopify-sync` (the phantom-orphan cleanup arm of the `sync` job in `deploy.yml`) goes via the `SHOPIFY_SYNC_DEPLOY_KEY` SSH deploy key. The key itself has full repo push capability across all refs (deploy keys are repo-scoped by GitHub design); its **bypass effect** on the `shopify-sync-protection` ruleset is scoped to that one ruleset's "Deploy keys" bypass-actor row (no other ruleset in this repo lists Deploy keys as a bypass actor today, and the row must NOT be added to any ruleset protecting `main`). The bypass is decoupled from any human role membership; a PAT-based bypass was rejected as it would couple bypass authority to the operator's admin status. A compromised collaborator with `contents: write` could exfiltrate the deploy key via a workflow change and force-push `shopify-sync` content (or push to any other branch in the repo subject to its ruleset protections), but this is bounded by the same all-bets-are-off threshold the existing trust model already accepts. The `sync` job runs in its own permissions scope with no `SHOPIFY_CLI_THEME_TOKEN` reference, so the deploy-key surface and the Shopify-token surface are isolated by job boundary; a bug in `sync` job bash cannot leak the Shopify token because the Shopify token structurally does not exist in that job.

### Secrets vs variables policy

GitHub Actions auto-redacts `secrets.*` values in workflow logs (`***`); `vars.*` is plaintext.

- **Secret**: anything granting write access to live infrastructure or a third-party API. Today:
  - `SHOPIFY_CLI_THEME_TOKEN` — Shopify storefront API token. Consumption point: `.github/actions/shopify-theme-push/action.yml` is the single place that reads `inputs.shopify-cli-theme-token` and invokes the Shopify CLI; workflows (`preview.yml`, `deploy.yml`) pass the secret through but do not read it. A rename or storage-location change requires updating that composite action plus every workflow that threads it.
  - `SYNC_RECONCILE_TOKEN` — fine-grained GitHub PAT used by `sync.yml`'s `gh pr create` so the auto-reconcile PR fires `pull_request:opened` events (GITHUB_TOKEN-driven creates do not). Single call site: `.github/workflows/sync.yml`'s "Open or refresh reconcile PR" step, create branch only. See "Token rotation call-site catalog" below.
  - `SHOPIFY_SYNC_DEPLOY_KEY` — Ed25519 SSH deploy-key private key used by `deploy.yml`'s `sync` job to bypass the `shopify-sync` branch's "Block force pushes" rule on the phantom-orphan force-with-lease push. Single call site: `.github/workflows/deploy.yml`'s `sync` job's `Sync main -> shopify-sync` step, phantom-orphan branch only (the fast-forward arm and the `git fetch` in the same step stay on HTTPS+GITHUB_TOKEN; neither needs the bypass). The matching public key is registered on the repo's deploy-keys page with "Allow write access"; the ruleset `shopify-sync-protection` has a `Deploy keys` bypass-actor row pointing at it. See "Token rotation call-site catalog" below.
- **Variable**: anything observable on any unauthenticated storefront request or in the GitHub repo's public surface. Today:
  - `SHOPIFY_DOMAIN` — canonical host, printed on every page.
  - `SHOPIFY_FLAG_STORE` — myshopify handle, appears in `Server` headers and theme-editor URLs.
  - `EXPECTED_SYNC_PR_OPENER` — the GitHub login that the deploy.yml shopify-sync gate expects on `pr.user.login` (the `SYNC_RECONCILE_TOKEN` PAT owner). The login is necessarily public surface (visible on every PR the PAT opens, the contributors page, etc.); storing it as a secret would not protect it.

Before adding a new `vars.*` entry, ask: would I be comfortable seeing this value in a workflow log, a smoke-test PR comment, or quoted by a reviewer? If not, classify as a secret.

### Token rotation call-site catalog

Each token used by CI lives at a single call site; rotation only requires updating the secret and (if relevant) re-issuing the token at its source.

- **`SHOPIFY_CLI_THEME_TOKEN`** — Shopify storefront API token. Consumed only by `.github/actions/shopify-theme-push/action.yml`'s `shopify theme push` invocation; workflows pass it through but do not read it. Rotation: regenerate the token in Shopify admin, update the repo secret.

- **`SYNC_RECONCILE_TOKEN`** — fine-grained GitHub PAT (scope: `pull_requests: write` + `contents: read` + `metadata: read` on this single repo only; resource owner: `Perts-Foundry` org). Consumed only by `.github/workflows/sync.yml`'s "Open or refresh reconcile PR" step, in the `gh pr create` branch (the `gh pr edit` branch intentionally stays on `GITHUB_TOKEN` for audit-trail hygiene; see comment in that step). Required because GITHUB_TOKEN-driven `gh pr create` does not fire `pull_request:opened` and validate.yml would not run on the new PR. Rotation: regenerate the PAT at https://github.com/settings/personal-access-tokens, update the repo secret. Failure modes:
  - **Secret unset:** the bash empty-PAT guard fires with a clear `::error::`; sync.yml fails red. Recovery: re-add the secret.
  - **PAT revoked / expired / scope-changed:** the secret value is still present so the empty guard does NOT fire. `gh pr create` returns 401/403/404; the wrapper captures stderr and re-emits with explicit "PAT appears invalid" hint. Recovery: re-issue the PAT with the correct scope, update the repo secret, then either close+reopen the open auto-reconcile PR or wait for the next admin commit on shopify-sync.
  - **`vars.EXPECTED_SYNC_PR_OPENER` deleted:** unrelated to the PAT itself, but worth co-locating: deploy.yml's shopify-sync gate refuses to deploy when the variable is empty (postSkip with explicit "set it to the PAT owner" message). Recovery: re-create the variable.

- **`SHOPIFY_SYNC_DEPLOY_KEY`** — Ed25519 SSH private key. Credential capability: full push to this single repo across all refs (deploy keys are repo-scoped by GitHub design). Bypass-row effect: the matching public key's deploy-key entry is a bypass actor on the `shopify-sync-protection` ruleset only — do NOT add it as a bypass actor on any other ruleset, including any ruleset protecting `main`. Consumed only by `.github/workflows/deploy.yml`'s `sync` job's `Sync main -> shopify-sync` step's phantom-orphan force-with-lease push branch; the fetch and the fast-forward push in the same step stay on HTTPS+GITHUB_TOKEN. Required because `GITHUB_TOKEN`'s identity `github-actions[bot]` is a synthetic per-workflow identity with no role membership and cannot match the ruleset's role-based bypass entries (see workflow run 25704994159 for the empirical rejection). Rotation procedure:
  1. Generate a new Ed25519 keypair locally: `ssh-keygen -t ed25519 -f /tmp/shopify-sync-push -C "deploy.yml shopify-sync force-push" -N ""`.
  2. Add the new public key to the repo's deploy-keys page with "Allow write access" checked. Do NOT delete the old key yet.
  3. Note the new deploy key's numeric ID (visible on the deploy-keys page URL after creation).
  4. On ruleset `shopify-sync-protection` (ID 16111276), edit the existing Deploy keys bypass-actor row to point at the new deploy key ID (adding a new row and removing the old works equivalently).
  5. Update the `SHOPIFY_SYNC_DEPLOY_KEY` repo secret with the new private key content (full file, LF line endings, trailing newline).
  6. Trigger one synthetic admin edit on the unpublished sync theme and verify the next auto-deploy's `sync` job completes without `::warning::` annotations from the Sync step.
  7. Delete the old public key from the deploy-keys page.
  8. Delete the local key files: `rm -f /tmp/shopify-sync-push /tmp/shopify-sync-push.pub` (or `shred -u` on a non-journaling filesystem; on ext4/btrfs/zfs `shred` is best-effort because the journal / extents / CoW may retain copies of the original blocks).

  Failure modes:
  - **Secret unset:** `Validate sync preconditions` step in the `sync` job fires `::error::` and exits 1; the job halts visibly red (no `continue-on-error` on that step). Recovery: re-add the secret.
  - **Key revoked / regenerated mismatch / removed from deploy-keys page / wrong line endings in the secret value:** `git push` returns `Permission denied (publickey)` or `Load key ...: invalid format`. The stderr-classifier in the Sync step re-emits a "SHOPIFY_SYNC_DEPLOY_KEY appears invalid" hint, then the existing `::warning::` path. Recovery: re-issue the keypair via the rotation procedure above.
  - **Bypass-actor row removed from the ruleset (or `actor_id` stale after a regenerate-without-bypass-update):** `git push` returns `GH013: ... Cannot force-push to this branch because: ...`. The stderr-classifier re-emits a "Push rejected by branch ruleset" hint. Recovery: re-add or correct the Deploy keys bypass-actor row on `shopify-sync-protection`.

## Pre-PR review

Standard agent set (`code-reviewer`, `doc-sync-checker`, `architecture-reviewer`, `security-auditor`) applies. Project-specific notes:

- **infra-reviewer**: run on any change touching `.github/workflows/` or `.github/actions/`. The unified `deploy.yml` handles all three trigger paths and serialises with `concurrency: deploy-production` on the `deploy` job. `workflow_run` paths depend on the literal name `validate` for `workflow_run.workflows: ["validate"]` and on the `dependabot/**` glob. `sync.yml` is single-direction (admin → `shopify-sync` only); the reverse direction is inlined in `deploy.yml`'s separate `sync` job that `needs: deploy` and holds `SHOPIFY_SYNC_DEPLOY_KEY` in isolation from `SHOPIFY_CLI_THEME_TOKEN`. No workflow binds a GitHub Environment.
- **test-engineer**: skip. No JavaScript test framework configured.
- **prompt-reviewer**: run only when this `CLAUDE.md`, `docs/accessibility-patterns.md`, agent definitions, or `.claude/` content change.
- **security-auditor focus areas** for theme work: Liquid output filters (`| escape`, `| json`, `| script_tag`), metafield exposure, form CSRF tokens, untrusted user input rendered into HTML attributes.

Before proposing fixes for theme-check warnings, check `THEME_CHECK_NON_ACTIONABLE.md` first — the project may have triaged the finding as a known false positive.

## Development commands

```bash
npm ci
npx shopify theme dev                                                                # local dev server
npx shopify theme check                                                              # linter
npx shopify theme pull -s sapphire-shadow-studio --live --path /tmp/live --nodelete  # inspect live read-only
```

**Do NOT run** `shopify theme push` or `shopify theme pull` against the working tree. Live pushes happen exclusively via `deploy.yml`. Admin-side edits flow through the sync theme into `shopify-sync`.

## Shopify best practices

Follow https://shopify.dev/docs/storefronts/themes/best-practices when relevant. When a task depends on a specific best-practice page, fetch it on demand with `WebFetch` — the `shopify.dev` Liquid reference is authoritative; do not rely on memorized summaries.

## Architecture

### Directory structure

- **layout/** — Base templates (`theme.liquid`, `password.liquid`).
- **templates/** — JSON templates defining page structure via section/block composition. Alternate templates use the dot-suffix form (e.g. `product.alternate.json`). The template root must include an `order` array (section sequence) and a `sections` map keyed by those names.
- **sections/** — Page sections with `{% schema %}` blocks for merchant configuration.
- **blocks/** — Reusable theme blocks that can be nested.
- **snippets/** — Reusable Liquid partials rendered with `{% render %}`.
- **assets/** — CSS, JS, static files. **Flat directory** (no subdirectories). **No build step**: files ship as-is via `deploy.yml`. Reference via `{{ 'filename' | asset_url }}` or `{{ ... | asset_url | image_tag }}`. Inline icons / small SVGs via `{{ 'icon-name.svg' | inline_asset_content }}`.
- **locales/** — Translation files. `en.default.json` is canonical; non-English locales are kept in sync but English is the source of truth.
- **config/** — `settings_schema.json` and `settings_data.json`.

### Component framework

JavaScript uses a custom web-component framework in `assets/component.js`:

```javascript
import { Component } from '@theme/component';

class MyComponent extends Component {
  refs = {};                    // auto-populated from ref="name"

  handleClick(event) { }        // bound via on:click="/methodName"
}
```

Key patterns:

- **Element refs**: declare via `ref="elementName"` (or `ref="items[]"` for arrays); access through `this.refs`.
- **Event binding**: `on:event="/methodName"` in HTML, never `addEventListener` for DOM events the framework can wire. Supported: click, change, select, focus, blur, submit, input, keydown, keyup, toggle.
- Validate required refs in `connectedCallback`; throw a descriptive error if missing.
- Private methods use `#`; public API stays explicit.
- **Parent-to-child**: invoke public methods on the child component directly. **Child-to-parent**: emit a `CustomEvent` with a typed `detail` payload.
- Cancel in-flight `fetch` with `AbortController` before issuing a new request; cancel in `disconnectedCallback` to prevent leaks.
- Optimistic UI must revert on error; dispatch a custom event on success for cross-component sync.
- Build URLs with `URL` and `URLSearchParams`; never concatenate query strings by hand.
- **JSDoc**: declare a `@typedef` for the refs object and pass as the `Component<Refs>` generic. Mark optional refs with `[name]`. Document custom events including the shape of `detail`.

### Theme editor integration

Sections / blocks update without full page reload in the theme editor; associated JS will not auto-execute. Listen on `document`:

- `shopify:section:load` / `shopify:section:unload` — re-init / cleanup for sections.
- `shopify:section:select` / `shopify:section:deselect` — section selection state.
- `shopify:block:select` / `shopify:block:deselect` — block selection state.
- `shopify:inspector:activate` / `shopify:inspector:deactivate` — preview-inspector toggling.

Detect editor mode in JavaScript via `Shopify.designMode` (`true` in editor); in Liquid via `request.design_mode`.

When the preview inspector is active, deactivate fixed-position elements (sticky headers) so they don't obscure inspection outlines. Use `margin` / `gap` for spacing between blocks, not `padding` (padding misaligns the inspector outline).

### Theme blocks vs snippets vs sections

- **Blocks** (`blocks/`): have `{% schema %}`, appear in the theme editor, support nesting via `{% content_for 'blocks' %}`.
- **Snippets** (`snippets/`): pure Liquid partials with `{% doc %}`, no schema.
- **Sections** (`sections/`): page-scope containers. Conventional class: `'section-' | append: section.type`. Scope per-section CSS variables to the wrapper (e.g. `--section-padding-block`) and apply via inline `style`. Use `block_order` only when a preset declares blocks as an object (not an array).

## Block development

### File structure

```liquid
{% doc %}
  Description of the block.
  @param {string} [optional_param] - Optional inputs in brackets.

  @example
  {% content_for 'block', type: 'block-name', id: 'unique-id' %}
{% enddoc %}

<div {{ block.shopify_attributes }} class="block-name">
  {{ block.settings.text }}
  {% content_for 'blocks' %}        {# only if nesting blocks #}
</div>

{% stylesheet %}
  .block-name { }
{% endstylesheet %}

{% schema %}
{ "name": "t:names.block_name", "settings": [] }
{% endschema %}
```

### Static vs dynamic invocations

- **Static** (locked into schema, cannot be removed / reordered in editor): `{% content_for 'block', type: 'text', id: 'unique-id' %}`. May pre-set defaults via `settings: { ... }` on the call site.
- **Dynamic** (merchant adds via editor): `{% content_for 'blocks' %}`.

**Critical**: only ONE `{% content_for 'blocks' %}` per file. If you need the same dynamic-block region in multiple places, **capture** it once into a variable and emit the variable.

### Schema targeting

- Restrict which block types nest inside a section / block via `"blocks": [...]`. Use `{ "type": "@theme" }` for any theme block, `{ "type": "@app" }` for app blocks, or specific names.
- `{% schema %} ... "tag": null` removes the auto-wrapping element. When you do, you must emit `{{ block.shopify_attributes }}` on your own root element.
- **NEVER edit `{% schema %}` blocks directly** when schemas are generated from source — modify the source and regenerate.

## Coding standards

### Liquid

- Use `{% liquid %}` for multiline logic blocks.
- Inline variables in HTML attributes rather than declaring many upfront.
- All snippets require `{% doc %}` with `@param` and `@example`. Type in braces (`{string}`, `{object}`, `{array}`), optional params in brackets (`[name]`), nested as `object.property`.
- Translation keys: `{{ 'namespace.key' | t }}`. Schema-side: `t:names.<key>`.
- **NEVER edit `{% schema %}` blocks directly** (see Block development).
- Use `{% assign %}` only when needed (filter parameters that need a complex string, the same calculation reused more than once, or extreme logical complexity); inline otherwise. Use `{% capture %}` only for multi-line content that won't fit inline.
- Never invent custom Liquid filters, tags, or objects; only documented Shopify Liquid.

### CSS

- **BEM**: `.block__element--modifier`. Single-class selectors (specificity `0 1 0`) where possible. No IDs as selectors. Avoid `!important`.
- **CSS variables**: namespace to component (e.g. `--product-card-padding`). Apply per-section / per-block setting values via inline `style="--var: value"`; do not generate per-instance class names.
- **Logical properties**: `padding-inline`, `margin-block`, `inset` for RTL support.
- **Container queries** for responsive components; declare `container-type: inline-size` on the wrapper.
- **Mobile-first** media queries (`min-width`).
- Use `{% stylesheet %}` inside sections / blocks for scoped CSS. Standalone CSS in `assets/` is for shared / global styles. Use `@layer` (resets, base, components, utilities) to prevent specificity wars.
- `:has()` performance: anchor selectors as close to the matched child as possible; prefer `>` / `+` combinators inside `:has()`. For dynamic state, prefer server-rendered classes over client-side `:has()` checks.
- Never animate layout properties (`width`, `height`, `margin`, `padding`); animate `transform` / `opacity`. Use `contain` on grid / list containers for rendering perf.
- Property order inside a rule: layout → box model → typography → visual → animation / transform.
- Defensive: `min-width: 0` on flex children to prevent overflow; `aspect-ratio` to reserve space; clamp long content rather than letting it spill. Use `dvh` (not `vh`) for mobile to account for the on-screen keyboard.

### HTML

- Use native elements: `<details>`, `<dialog>`, `popover`. Semantic HTML with proper ARIA.
- IDs: CamelCase + section/block ID suffix — `id="ProductModal-{{ section.id }}"`.
- `tabindex="0"` for custom interactive elements; never positive values.
- `<search>` for search forms, `<output>` for calculated form results.
- Typed inputs (`type="search|tel|url|date|time|datetime-local|month|week|color"`) for native validation and mobile keyboards. `pattern=` for regex validation; `formnovalidate` / `formaction` on submit buttons that need to bypass validation or post elsewhere.
- Pair `@supports` feature queries with `@media` for progressive enhancement.
- Provide `@media print` styles for receipts / order pages.
- View transitions: declare `@view-transition` and per-element `view-transition-name` for smooth navigation.
- Avoid `position: fixed` near the bottom of the viewport on mobile (the on-screen keyboard overlaps it).

### JavaScript

- Zero external dependencies; native browser APIs.
- `const` over `let`; `for...of` over `.forEach()`; `async / await` over `.then()` chaining; early returns over nested conditionals.
- JSDoc types on parameters and return values. Component-framework conventions are under Architecture > Component framework.

### Accessibility (global rules)

- **Skip link** at page top; element referenced by `href="#main"` must have `tabindex="-1"` to receive focus. Hide with sr-only / clip-path techniques, never `display: none`.
- `lang` on `<html>`. Viewport must allow zoom (no `maximum-scale=1.0` / `user-scalable=no`).
- Respect `prefers-reduced-motion`. Provide `@media (prefers-contrast: more)` overrides for help text, borders, focus indicators.
- WCAG AA contrast: 4.5:1 for normal text, 3:1 for large text and UI elements.
- Focus indicators on all interactive elements (`:focus-visible`).
- Animation: never exceed 3 Hz flashing (no sub-0.33s strobes). Parallax / scroll-jacking needs a user-controllable off switch. Auto-running content longer than 5 s needs a pause control.
- Landmark hygiene: cap at ~10; multiple `<nav>` / `<aside>` / `<section>` regions each need an `aria-label` or `aria-labelledby`.
- Form error / success summaries: heading gets `tabindex="-1"`; on submission, use `requestAnimationFrame` to ensure the heading is visible before calling `.focus()` and `.scrollIntoView()`.
- Auto-updating regions: `aria-live="polite"` (or `role="log"` for chronological message history); pair with a visible pause control. Notifications combine sound + visual badge + title-bar change + `aria-live`.
- Time limits: warn 20 s before expiry and offer to extend / disable; minimum interaction window 20 hours for non-critical flows.
- `title` attribute: only on `<iframe>`; never elsewhere (redundant tooltips, inconsistent SR output).
- Touch targets: at least 44×44 CSS pixels.
- All `<img>` need `alt`; use empty `alt=""` for decorative images.

### Component-specific accessibility patterns

Before implementing or modifying any of these widgets — **accordion, breadcrumb, cart drawer, chat window, color swatch, combobox, carousel, disclosure, dropdown navigation, flip card, form, modal, product card, slider, switch, tab, tooltip** — load `docs/accessibility-patterns.md` for the exact role / attribute / keyboard set. If the widget you're building doesn't appear above but maps to one of these primitives (e.g., a `<dialog>` is a modal; a banner / toast / alert / snackbar is an `aria-live` region paired with the form-error patterns from the global rules; a context menu or a bare "dropdown" maps to combobox, disclosure, or dropdown navigation depending on behaviour), load `docs/accessibility-patterns.md` anyway and check the nearest match. Anything that doesn't map to a listed primitive is governed by the global rules above plus WCAG.

## Translations

- Keys live in `locales/en.default.json` (storefront) and `locales/en.default.schema.json` (schema).
- Max nesting depth: 3. snake_case key names.
- Schema-side reference: `t:names.<key>`. Storefront-side: `'namespace.key' | t`.
- **Add the key to the appropriate locale file before referencing it** — theme-check fails on dangling keys.
- When adding storefront-visible strings, mirror the key into non-English locale files (`locales/it.json`, `locales/ro.json`, etc.) with `TODO` placeholders if real translations aren't available yet.

## Theme settings

Global CSS variables: `snippets/theme-styles-variables.liquid`. Color schemes: `color_scheme_group` in `config/settings_schema.json`, rendered via `snippets/color-schemes.liquid`.

### Settings authoring

- `config/settings_schema.json` opens with a `theme_info` object (`theme_name`, `theme_version`, `theme_author`, support / docs URLs). Group later entries by category (Typography, Layout, Performance, etc.).
- Setting `label` text: under 30 characters, title case, no redundant type qualifier ("Columns", not "Number of columns").
- Translation keys for setting labels: `t:names.<key>`. Add the key to `locales/en.default.schema.json` first; theme-check will flag dangling keys.
- Within a settings group, order: resource pickers (collection / product / blog / page) first, then visual-impact order (layout → typography → color), with `header` entries to introduce groups.
- Presets that use nested blocks must declare a `block_order` array.
