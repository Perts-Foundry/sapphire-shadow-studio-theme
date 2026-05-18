# Release Notes

## CI/CD deploy chain: shopify-sync phantom-orphan force-push via SSH deploy key (unreleased)

PR #21 was the first post-PR-#19 exercise of the auto-deploy chain. It surfaced that the post-merge `Sync main -> shopify-sync` step's phantom-orphan force-with-lease push silently fails on every shopify-sync auto-deploy. The fix swaps that single push from HTTPS+GITHUB_TOKEN to SSH+deploy-key, and folds the step into a new `sync` job to isolate the deploy key from `SHOPIFY_CLI_THEME_TOKEN`. The fast-forward push and the read-only fetch in the same step both stay on HTTPS+GITHUB_TOKEN, since a strict fast-forward to a tip-descendant is not a force push and the `shopify-sync-protection` ruleset's "Block force pushes" rule does not apply.

### Bug and evidence

The `shopify-sync` branch is protected by ruleset `shopify-sync-protection` (ID 16111276) with **Block force pushes** active. The phantom-orphan cleanup arm of the post-merge Sync step force-pushes `shopify-sync` to the deployed SHA (rewriting history to abandon the orphan commits that the just-merged auto-reconcile PR squashed into main). Under HTTPS+GITHUB_TOKEN this push fails with:

```
remote: error: GH013: Repository rule violations found for refs/heads/shopify-sync.
remote: - Cannot force-push to this branch because: Cannot force-push to this branch
```

Empirically confirmed on workflow run 25704994159 (PR #21). The rejection is not transient and not racy; it is structural. The reason it cannot be fixed by adding `Repository role: Admin` to the ruleset's bypass-actors list is that `GITHUB_TOKEN`'s identity `github-actions[bot]` is a synthetic per-workflow identity with no role membership; the GitHub ruleset evaluator's role-based bypass entries (Repository roles, Organization admin) only match identities that hold those roles. Only explicit-actor bypass entries (Deploy keys, Apps, Users) match identities directly.

### Fix

Deploy keys are addable as bypass actors via the ruleset bypass-add modal ("Deploy keys - Role"). A repo-scoped Ed25519 deploy key (`SHOPIFY_SYNC_DEPLOY_KEY` repo secret + matching public key on the deploy-keys page with "Allow write access") is placed on the `shopify-sync-protection` ruleset's bypass list, and the phantom-orphan push switches to SSH using that key.

Workflow structure changes in `deploy.yml`:

- **Sync step extracted into a new `sync` job.** The post-merge Sync moved from being the last step of the `deploy` job to a top-level `sync` job that `needs: deploy`. Rationale: the existing `gate`/`deploy` split establishes "a bug in any step's bash cannot leak a secret because the secret structurally does not exist in this job's scope." Adding `SHOPIFY_SYNC_DEPLOY_KEY` to the `deploy` job would create a defence-in-depth weakness (two secrets in one bash block, exfilable together by a future `set -x` regression). The new `sync` job has `permissions: contents: write` only and zero `SHOPIFY_CLI_THEME_TOKEN` references. The `GH_TOKEN: ${{ github.token }}` binding moves out of the `deploy:` job's env block (no remaining consumer there) and into the new `sync:` job's env (used for the read-only fetch and the fast-forward push, both of which stay on HTTPS).
- **`Validate sync preconditions` step** is a dedicated empty-secret guard in the `sync` job, with no `continue-on-error`. A missing `SHOPIFY_SYNC_DEPLOY_KEY` halts the job visibly red instead of being swallowed by the next step's `continue-on-error: true`. Mirrors `sync.yml`'s `SYNC_RECONCILE_TOKEN` empty-PAT guard in both text and step-failure semantics.
- **SSH setup in the Sync step.** `umask 077` closes the `mktemp` 0600-mode race window across runner profiles; `mktemp -t` produces a templated tempfile path; per-line `::add-mask::` registration of each line of the secret value as defence in depth against a future `set -x` regression (multi-line PEM bodies may not be reliably auto-masked); `tr -d '\r'` line-ending normalisation before writing the key, so a secret pasted with Windows CRLF endings still loads; `unset` of the secret env var after the on-disk write shrinks the shell-env exposure window; `ssh-keyscan -t ed25519,ecdsa github.com` populates known_hosts (RSA omitted because OpenSSH 8+ prefers Ed25519/ECDSA and including RSA only couples the workflow to a future GitHub RSA-key rotation event); `GIT_SSH_COMMAND` is exported with `IdentitiesOnly=yes` + `PreferredAuthentications=publickey` + `BatchMode=yes` + `StrictHostKeyChecking=yes` + `LogLevel=ERROR`; tempfile cleanup `trap` is registered BEFORE `mktemp` runs (with empty-string fallback variables) so a partial-write or ssh-keyscan failure still cleans up.
- **Push call-site changes.** Only the phantom-orphan force-with-lease push switches to SSH. The fast-forward push and the read-only fetch stay on HTTPS+GITHUB_TOKEN. The SSH push URL is derived from `${{ github.repository }}` so an org/repo rename does not silently leave a stale hardcoded URL behind.
- **Multi-pattern stderr classifier.** Push-failure stderr is now run through two grep patterns. `Permission denied (publickey)` / `Load key .*: invalid format` / `Load key .*: bad permissions` / `Host key verification failed` re-emits a "SHOPIFY_SYNC_DEPLOY_KEY appears invalid" hint. `GH013` / `Cannot force-push to this branch` (the bypass-row-removed case) re-emits a "Push rejected by branch ruleset" hint. The raw stderr line still prints either way.

### Alternatives considered

- **Expand bypass to a PAT.** Rejected. Couples bypass authority to the operator's admin status; trust regression spreads to the PAT-create surface.
- **`actions/create-github-app-token` with a minimal install-only app.** Rejected. The short-lived-token and granular-permission properties are real, but the PEM rotation has the same operator-account-coupling problem as a PAT, and setup cost is still strictly larger than a deploy key for a solo-dev repo.
- **Switch to a long-lived custom GitHub App.** Rejected. Over-engineered for a single solo-dev bypass use case.
- **Disable the "Block force pushes" rule.** Rejected. The rule also blocks accidental admin-side rewrites of `shopify-sync`; the operator wants to keep the protection on.
- **Replace force-push with a `--strategy=ours` merge-commit reconcile (no bypass needed).** Rejected. Produces a tangled `shopify-sync` history of merge commits; merge-commit author is `github-actions[bot]` not `shopify[bot]`, complicating any future identity-based assertion downstream.
- **Accept silent failure; rely on `sync.yml`'s reconcile flow and daily cron to clean up.** Rejected. Partially defensible (the post-PR-#18 hardening blocks the latent-bug incident class), but a chain that silently fails on every deploy is hard to monitor and accumulates drift between admin-edit cycles.

### Trust delta

The deploy-key credential has full repo push capability across all refs (deploy keys are repo-scoped by GitHub design). Its **bypass effect** on the `shopify-sync-protection` ruleset is scoped to that one ruleset's "Deploy keys" bypass-actor row; the row must NOT be added to any ruleset protecting `main` or any other branch. Bypass authority is decoupled from any human role membership. The four computed auto-deploy gates (collaborator-permission, validate-on-HEAD-SHA, signed-commit, defence-in-depth merge-base assertion) remain the actual integrity boundary on what content auto-deploys; the SSH push only changes *transport* for an already-validated payload. A compromised collaborator with `contents: write` could exfiltrate the deploy key via a workflow change and force-push `shopify-sync` content, but this is bounded by the same all-bets-are-off threshold the existing trust model already accepts. The new `sync` job has no `SHOPIFY_CLI_THEME_TOKEN` in scope, so the deploy-key surface and the Shopify-token surface are isolated by job boundary.

### Operator action (post-merge)

None for the chain itself. The next admin commit on the unpublished sync theme will auto-exercise the new path. Three one-time tasks accompany this change (operator handles in parallel with the PR):

1. Generate the keypair locally, add the public key to `/settings/keys` with "Allow write access", store the private key in repo secret `SHOPIFY_SYNC_DEPLOY_KEY`, add a `Deploy keys` bypass-actor row to ruleset `shopify-sync-protection` (ID 16111276), securely delete the local key files. (See CLAUDE.md "Token rotation call-site catalog" entry for the full procedure.)
2. Bring `shopify-sync` to byte-for-byte parity with `main`, since PR #21's failed Sync left it in a 1-ahead/1-behind state. The recovery snippet uses operator admin bypass (independent of the new deploy-key bypass):

   ```bash
   git fetch origin
   MAIN_SHA=$(git rev-parse origin/main)
   LEASE_SHA=$(git rev-parse origin/shopify-sync)
   if [ "$LEASE_SHA" = "$MAIN_SHA" ]; then
     echo "Already in sync; nothing to do."
     exit 0
   fi
   git push --force-with-lease=shopify-sync:"$LEASE_SHA" origin "$MAIN_SHA":shopify-sync
   git fetch origin shopify-sync
   [ "$(git rev-parse origin/shopify-sync)" = "$MAIN_SHA" ] || { echo "MISMATCH"; exit 1; }
   ```
3. After the chain is exercised once successfully, `gh api /repos/Perts-Foundry/sapphire-shadow-studio-theme/compare/shopify-sync...main --jq '{status, ahead_by, behind_by}'` returns `{"status":"identical","ahead_by":0,"behind_by":0}`.

If this change is ever reverted: also remove the public key from `/settings/keys` and remove the bypass-actor row from `shopify-sync-protection` to avoid orphaned authority.

## CI/CD deploy chain: sync.yml PAT switch and latent main-has-advanced hardening (unreleased)

PR #17 was the first end-to-end exercise of the consolidated `deploy.yml`'s shopify-sync auto-deploy path. It surfaced a real and previously unobserved bug: `sync.yml`'s `gh pr create` runs under `GITHUB_TOKEN`, and GitHub's documented automatic-token rule (https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication) suppresses downstream workflow_run events from GITHUB_TOKEN-driven actions. validate.yml never fired on the auto-reconcile PR. The fix is a fine-grained PAT scoped narrowly; this PR also folds in a latent-bug discovery and matching two-layer hardening.

### Bug A: validate.yml never fires on auto-reconcile PRs

`sync.yml`'s "Open or refresh reconcile PR" step calls `gh pr create` under the job-level `GH_TOKEN: ${{ github.token }}`. Per GitHub's documented automatic-token rule, events triggered by GITHUB_TOKEN do not cascade into downstream workflow runs. The PR opens silently, no `pull_request:opened` event reaches the events bus, validate.yml is not triggered, and the shopify-sync auto-deploy chain stalls. Empirically confirmed on PR #17: the PR was opened by sync.yml at 2026-05-11 20:41:50Z; the only Validate run on shopify-sync (databaseId 25697345816) was created at 2026-05-11 21:06:18Z, ~25 minutes later, as a result of a manual close+reopen via personal gh credentials.

**FIXED**: introduced a new fine-grained PAT (`SYNC_RECONCILE_TOKEN`, resource owner `Perts-Foundry` org, scoped to `pull_requests: write` + `contents: read` + `metadata: read` on this single repo). sync.yml's `gh pr create` runs under the PAT via an inline `GH_TOKEN="$SYNC_RECONCILE_TOKEN"` override; every other call site stays on GITHUB_TOKEN. `gh pr edit` deliberately keeps GITHUB_TOKEN because `pull_request:edited` is not in validate.yml's trigger set (suppression is harmless there), to minimise PAT-attributed audit-log volume, and to preserve a clean `github-actions[bot]` timeline so any human-attributed action on the PR is a genuine investigation signal. deploy.yml's `pulls.merge` and the post-merge Sync step's git push also stay on GITHUB_TOKEN: the suppression of the merge-commit push to main is intentional (re-running validate against main on every deploy would loop), and the shopify-sync fast-forward push uses HTTP Basic with GITHUB_TOKEN by design.

The PAT call site is wrapped in two fail-closed guards: an empty-PAT check that fires a clear `::error::` if the secret is unset, and a stderr-capture wrapper around `gh pr create` that re-emits a "PAT appears invalid" hint when the gh CLI returns 401/403/404 (revoked, expired, or scope-mismatched). Both surface explicit pointers to CLAUDE.md's "Token rotation call-site catalog."

### Bug A.1: downstream PR-opener gate now expects the PAT-owner identity

After the PAT switch, `pr.user.login` on the auto-reconcile PR is the PAT owner's GitHub account, not `github-actions[bot]`. deploy.yml's shopify-sync gate previously hardcoded `expectedPrBot = 'github-actions[bot]'`. Without a corresponding update, every PAT-opened reconcile PR would pass Validate, then fail the PR-opener-identity gate and post a sticky "Auto-deploy skipped" with a misleading reason.

**FIXED**: renamed `expectedPrBot` to `expectedPrOpener`, source value from a new `vars.EXPECTED_SYNC_PR_OPENER` repository variable (plaintext is fine: the login is already public surface). Added EXPECTED_SYNC_PR_OPENER to the step's env block. Added a JS-side empty guard that fails closed via postSkip if the variable is unset. Preserved the `pr.user?.login` optional chaining and added a comment so a future maintainer doesn't "fix" it to non-optional access (deleted-account responses can produce undefined; the comparison fails closed against that).

### Trust-model regression with mitigation chain

The PR-opener gate's expected value moves from a GitHub-Actions runtime identity (`github-actions[bot]`, essentially unimpersonable from outside a workflow execution context) to a human GitHub login (PAT-exfiltrable). The new attack surface and the mitigations:

1. **Attack:** PAT exfiltration enables hand-opening a `shopify-sync → main` PR with a stale-but-signed `shopify[bot]` HEAD (replay an old `shopify[bot]` commit as a fresh deploy).
2. **Block 1, commit-identity gate (unchanged):** the HEAD commit must be `author=shopify[bot]` AND `verification.verified`. An attacker can only PR commits `shopify[bot]` genuinely authored at some point in history; no novel content injection is possible.
3. **Block 2, defence-in-depth merge-base assertion (NEW, this PR):** `repos.compareCommits(base: main, head: pr.head.sha).behind_by === 0`. A stale `shopify[bot]` commit that predates a subsequent main-tip advance is missing main commits, and the gate skips. Catches the replay attack.
4. **Residual surface:** "hand-open a PR with a current-base `shopify[bot]` commit." Damage is bounded to "auto-deploy ships content `shopify[bot]` genuinely authored, in the same tree-state `shopify[bot]` would naturally produce." Much smaller than "ship arbitrary content."

The all-bets-are-off threshold around `contents: write` collaborator-bypass is unchanged from the existing trust model: a collaborator who can land any PR could already exfiltrate any secret via a malicious workflow change, so the new PAT does not extend that surface.

### Bug B: latent main-has-advanced bug (discovered during this work, hardened in same PR)

After PR #17 squash-merged at 2026-05-11 21:08:42Z, shopify-sync entered phantom-orphan state (1 commit ahead, DIFF_LOC=0). PR #18 (CLAUDE.md consolidation) then landed on main on 2026-05-11. shopify-sync became 1 ahead, 2 behind, DIFF_LOC=375, no longer pure phantom-orphan. sync.yml's existing "Determine sync status" step only short-circuits on the DIFF_LOC=0 case, so the next sync run (cron, admin push, or manual dispatch) would create a reconcile PR whose diff proposes to **revert PR #18's docs changes** (CLAUDE.md and `docs/accessibility-patterns.md`). With the GITHUB_TOKEN status quo, validate.yml wouldn't fire on that PR (harm contained, humans review). With the PAT fix landing, validate.yml DOES fire, the PR could flow through the workflow_run auto-deploy arm, and both the PR-opener gate (PAT-opened) and the commit-identity gate (HEAD commit is real `shopify[bot]`) would pass. The auto-deploy could ship the reverse-application to live.

The PAT fix unmasked this latent bug. Two layers of defence land in this same PR:

**FIXED** (sync.yml prevention guard): added a merge-base check at the top of the "Open or refresh reconcile PR" step's `run:` block, before the PR-create or PR-edit action. The check asserts `git merge-base origin/main HEAD == origin/main`. If not, the workflow fails red with an `::error::` annotation that includes the manual-recovery snippet (force-push main onto shopify-sync). Placement is inside the step, NOT before the LOC fork in "Determine sync status"; this avoids false-firing on the legitimate phantom-orphan post-deploy state (where `AHEAD > 0` AND `DIFF_LOC == 0` AND main has advanced past shopify-sync's merge-base via the squash). The step's existing `if:` condition (`loc != '0'`) already excludes that state from this step.

**FIXED** (deploy.yml defence-in-depth): added a `repos.compareCommits(base: main.commit.sha, head: trustedSha)` call to the shopify-sync gate, after the existing base-staleness check. Asserts `behind_by === 0`. The existing base-staleness check (`main.commit.sha !== pr.base.sha`) only catches "main advanced after the PR was created"; it does NOT catch "PR head was missing main commits at PR creation time." The new assertion catches that case AND the PAT-exfil hand-opened-stale-PR attack from the trust-delta chain above. Defence in depth: even if sync.yml's prevention guard is bypassed (hand-opened PR via PAT exfil), the deploy-side gate still skips.

### Doc-drift fix folded in (zizmor.yml mitigation comment)

`.github/zizmor.yml`'s `dangerous-triggers` ignore-list comment listed "auto-reconcile label present, manual-review label absent" as shopify-sync mitigations. Both labels were replaced by the draft-PR escape hatch in an earlier PR; the comment had drifted. Refreshed the shopify-sync mitigation bullet list to reflect the actual current gates (draft-PR check, no-protected-paths-in-diff, <1000 LOC, base-staleness, new merge-base assertion) and the renamed PR-opener gate sourcing from `vars.EXPECTED_SYNC_PR_OPENER`.

### Operator action (post-merge)

Run a one-time force-push to bring shopify-sync to byte-for-byte parity with main, absorbing PR #18 and discarding the orphan `9b003ae`:

```bash
git fetch origin
MAIN_SHA=$(git rev-parse origin/main)
LEASE_SHA=$(git rev-parse origin/shopify-sync)
if [ "$LEASE_SHA" = "$MAIN_SHA" ]; then
  echo "Already in sync; nothing to do."
  exit 0
fi
git push --force-with-lease=shopify-sync:"$LEASE_SHA" origin "$MAIN_SHA":shopify-sync
git fetch origin shopify-sync
[ "$(git rev-parse origin/shopify-sync)" = "$MAIN_SHA" ] || { echo "MISMATCH"; exit 1; }
```

If `--force-with-lease` aborts (a `shopify[bot]` commit landed between fetch and push), re-run from `git fetch`. After the push, `gh api /repos/Perts-Foundry/sapphire-shadow-studio-theme/compare/shopify-sync...main` returns `identical / 0 / 0` and GitHub's branch view shows shopify-sync at parity with main. The new sync.yml and deploy.yml guards protect the recovered state.

### Comment-deploy escape hatch unaffected

The `Auto-deploy gates - shopify-sync` step that hosts the renamed PR-opener gate only runs on the `workflow_run` trigger path. The `issue_comment` (manual `deploy` comment) trigger uses a separate collaborator-permission check on `comment.user.login` and never asserts `pr.user.login`. A `deploy` comment on an auto-reconcile PR (now opened by the PAT-owner identity instead of `github-actions[bot]`) ships normally.

### Dependabot path: PR-opener identity unchanged, parallel merge-base assertion added

The dependabot/** arm of deploy.yml's gate continues to expect `pr.user.login === dependabot[bot]`. Dependabot opens PRs under its own bot identity via GitHub's native Dependabot service, not via a PAT, so the GITHUB_TOKEN-suppression rule does not apply (Dependabot's pushes already fire workflow events). No PAT is needed for that path; no PR-opener identity change.

The defence-in-depth `repos.compareCommits(base: main, head: trustedSha).behind_by === 0` assertion is also added to the dependabot gate, mirroring the shopify-sync addition. In Dependabot's normal flow this is a no-op: Dependabot rebases its own PRs on every push and updates `pr.base.sha`, so the existing base-staleness check is sufficient and the new assertion always passes. The assertion lands as belt-and-braces against a hypothetical future Dependabot behaviour change where a PR could carry a current `pr.base` but a head SHA missing main commits (e.g. partial-rebase race). Symmetric trust model across both auto-deploy arms.

## CI/CD deploy chain: Dependabot auto-deploy gate fixes (unreleased)

PR #2 (Dependabot `actions/github-script` v8 → v9, open since 2026-05-03) was the first auto-deploy attempt against the post-PR-13 chain. It exposed two bugs in the Dependabot auto-deploy path that the earlier audit missed, plus one latent issue that was masked by the first bug.

### Bug A: `dependabot/fetch-metadata@v3.1.0` does not support `workflow_run` triggers

PR #13 integrated `dependabot/fetch-metadata@v3.1.0` as a new gate step to read the per-dep `update-type` from Dependabot's structured commit trailers. The action's README mentioned `workflow_run` as a viable parent trigger; in practice the action requires the `pull_request` event payload to live in its own job's context, which a `workflow_run`-triggered job does not have. Every Dependabot auto-deploy attempt now hard-failed with:

```
::warning::Event payload missing `pull_request` key. Make sure you're triggering this action on the `pull_request` or `pull_request_target` events.
::error::PR is not from Dependabot, nothing to do.
```

The whole Dependabot auto-deploy path was blocked before reaching the bot-identity gate, the major-version gate, or any deploy step.

**FIXED**: removed the `Fetch Dependabot metadata` step entirely. Replaced with inline commit-trailer parsing inside the existing `Auto-deploy gates - dependabot` github-script step: iterate `pulls.listCommits`, parse each commit message for `update-type: version-update:semver-{major,minor,patch,prerelease}` trailers (Dependabot's documented structured-commit format), classify the bump severity from the parsed values. Same logical behaviour as `fetch-metadata`, no action dependency, no event-payload requirement. The prose-regex secondary parse and the fail-closed "no parseable signal" branch are preserved.

### Bug B: bot-identity gate rejected legitimate `web-flow` committer

Both auto-deploy bot-identity gates (shopify-sync and dependabot arms) asserted `commit.committer.login === expectedBot` with strict equality. When a bot-authored commit is rebased through GitHub's web-flow (which happens on every `@dependabot rebase`, `@dependabot recreate`, and GitHub's automatic "update branch" rebase), the resulting commit has `author.login === bot` but `committer.login === 'web-flow'`. PR #2's head commit was exactly this state: `author=dependabot[bot]`, `committer=web-flow`, `verified=true`.

Pre-PR-13 stickies on PR #2 (2026-05-10 22:39 and 2026-05-11 00:18) had already reported the false positive: "Bot-identity gate failed (verified=true, author=dependabot[bot], committer=web-flow, pr.user=dependabot[bot]; expected dependabot[bot])." After PR #13, the failure was masked by Bug A (the fetch-metadata step crashed first); without this fix it would resurface on the next deploy attempt.

**FIXED**: both gates now allow `committer.login` to be either the expected bot OR `web-flow`. `web-flow` is a GitHub-system identity controlled by GitHub itself; no external actor can impersonate it. The author and PR-opener integrity assertions are unchanged.

### Trust-model impact

The signed-commit gate's integrity property is unchanged: the assertion is still that a verified bot AUTHORED every commit. The committer field was already documented as defence-in-depth (the README explicitly stated "Git commit headers are not consulted; those are forgeable"). Relaxing the committer to {expectedBot, web-flow} accepts a GitHub-controlled identity in addition to the bot, preserving the no-external-impersonation property.

CLAUDE.md "Deploy gate trust delta" section and "Admin-side edits" section both updated to reflect the relaxed committer-identity rule.

### Operator action

None. PR #2 can now be re-auto-deployed by triggering a new Validate cycle on its HEAD (any commit push, or `@dependabot recreate`); the chain will now run the bot-identity gate (passes with `committer=web-flow`), then the major-version gate (detects the major bump via the inline trailer parse and postSkips with "Major-version bump(s) detected"). After review, comment `deploy` to ship.

## CI/CD deploy chain: sync auth + audit-driven hardening (unreleased)

PR #11's test deploy was the first to actually exercise the consolidated `deploy.yml`'s `Sync main -> shopify-sync` post-merge step under realistic conditions. It surfaced three immediate bugs (sync push could never have worked; failure annotation misattributed the cause; deploy report rendered the success icon next to failure text) and prompted a full-chain audit that turned up another fourteen findings ranging from latent gate-bypass risks to documentation drift. All seventeen are folded into this one PR.

### The three bugs that started the audit

- **FIXED** `Sync main -> shopify-sync` push auth. Both push commands (the fast-forward and the `--force-with-lease` phantom-orphan reset) switched from `AUTHORIZATION: bearer $GH_TOKEN` to HTTP Basic auth with `x-access-token` as the username (`AUTHORIZATION: basic <base64('x-access-token:'+token)>`). GitHub's git-over-HTTPS smart server silently ignores the Bearer scheme on git endpoints; git then falls back to credential prompting and exits with `fatal: could not read Username for 'https://github.com': No such device or address`. The Bearer form was inherited from the prior `sync-reconcile.yml` fast-forward arm and never executed in production there because GITHUB_TOKEN-driven pushes do not retrigger workflows, so the bug was latent until the consolidated `deploy.yml` ran the push synchronously inside the deploy job. The `AUTH_HEADER` value is computed once at the top of the step so the two push call-sites stay in lockstep.
- **FIXED** the `::warning::` annotation message in both failed-push branches. The prior text was `Fast-forward push failed (likely raced an admin commit): <err>`, which pre-classified every push failure as a race condition. Auth failures, network blips, and rate-limit hits all surface the same way; the operator needs the raw `$PUSH_ERR` to triage. The annotation is now `Fast-forward push failed: <err>` (and `Phantom cleanup push failed: <err>` for the other arm). The `sync-status` marker was also renamed from `race;` to `push failed;` so the report-comment body reflects the underlying state without prejudging the cause.
- **FIXED** the deploy-report sync-line icon. The `Post deploy report` step previously chose between the success and warning icons based on `steps.sync.outcome === 'success'`, which is always `'success'` because the Sync step's bash explicitly handles errors with `if PUSH_ERR=...; then ... else ... fi` and exits 0 in every branch. The report now inspects the `sync-status` output content: `push failed` or `deferred` prefixes route to the warning icon and wording, anything else routes to success. `syncOutcome === 'success'` is also still consulted as a defence-in-depth signal in case the bash exits non-zero before any status is written. PR #11's report rendered the success icon paired with failure text; the new logic produces `:warning: **shopify-sync sync warning:** push failed; ...`.

### Latent-bug fixes folded in from the audit

- **HARDENED** Dependabot major-version detection (C3). The gate's only safety net against an auto-deployed major bump was a regex over the PR title and body. Grouped-update PRs use non-parseable titles ("bump the github-actions group with N updates") and the regex's-only signal is the per-dep "Updates `X` from A to B" lines in the body; any future change to that template would silently let a major bump auto-deploy. The gate now (1) runs `dependabot/fetch-metadata@v3.1.0` as a step before the dependabot gate and reads its `update-type` output as the primary signal, (2) keeps the regex as belt-and-braces in case the action returns no metadata, and (3) fails closed when BOTH signals come up empty on a Dependabot PR (the bot-identity gate already confirmed Dependabot authorship, so an unparseable PR is an unknown-severity bump that gets routed to manual review).
- **PAGINATED** the deploy chain's sticky-comment finders (C1). Five upsert helpers (gate's `upsertSticky`, both auto-deploy-gate `upsertSticky` closures, `Post deploy report`, and `Report failure`) used a bare `listComments({ per_page: 100 })` lookup with no pagination. On a PR with >100 comments (an auto-reconcile PR accumulating daily-cron stale notices, a long-lived discussion thread) the existing sticky lives past page 1, the finder returns empty, and the upsert posts a duplicate. The duplicate-sweeper at the end of each helper only sees the truncated page so the legacy sticky persists. All five helpers now use `github.paginate(github.rest.issues.listComments, ...)`.
- **MASKED** the base64-wrapped Shopify auth header (C2). `AUTH_B64=$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w 0)` produces a literal Actions has not been told to mask. The bare `$GH_TOKEN` is auto-masked, the base64 form is not. A future `set -x`, debug `echo`, or git error message containing the assembled `http.extraheader` would print the token in base64-plaintext-equivalent form. Added `echo "::add-mask::$AUTH_B64"` immediately after the assignment.
- **FIXED** the `compareCommits` documentation in both `deploy.yml` and `CLAUDE.md` (C4 + N2). The inline comment and the CLAUDE.md "Deploy gate trust delta" section both described `compareCommits.status === 'identical'` as tree-equivalence ("catches force-pushes to the same tree as benign and different trees as suspicious"). GitHub's `compareCommits` actually compares commit objects, not trees: a same-tree amend / cherry-pick / different-tree force-push all return `diverged`, not `identical`. So `compareCommits.status === 'identical'` is functionally redundant with the `pr.head.sha === trustedSha` equality check above it. The actual security posture is *stronger* than the description claimed; the docs now describe what the check actually does (defence in depth on top of SHA equality) so a future refactor doesn't "simplify" away a load-bearing check on a wrong premise.
- **AUTHED** the `git fetch` in the Sync step (S1). The fetch was anonymous because the repo is public; if the repo is ever flipped to private, the unauthed fetch fails with the same `could not read Username` error the Bearer push used to produce. Threading `$AUTH_HEADER` into the fetch costs nothing on the public-repo path and immunises against repo-visibility changes.
- **TIGHTENED** the comment-deploy Validate lookup (S2). `listWorkflowRuns({ workflow_id: 'validate.yml', head_sha })` would accept a Validate run from any triggering event. `validate.yml` is `pull_request`-only today, but adding an `event: 'pull_request'` filter blocks a future push / workflow_dispatch trigger on validate.yml from masquerading as proof for a comment-deploy.
- **SKIPPED** preview cleanup and preview-sticky updates for Dependabot auto-deploys (S4). `preview.yml::deploy-preview` is conditionally skipped for Dependabot PRs (no Shopify token in the Dependabot secrets scope), so there is never a `pr-N-preview` theme to delete and never a `<!-- preview -->` sticky to update. Both downstream steps now check `needs.gate.outputs.trigger_path != 'dependabot'`, removing the misleading `:broom: Preview cleanup: no preview theme found.` line from every Dependabot deploy report.
- **DEFENSIVE** explicit-destination refspec on the Sync step's fetch (S5). `git fetch --prune --no-tags origin "$DEPLOYED_SHA" shopify-sync` could miss force-push updates to `origin/shopify-sync` in the local clone. Switched to `+refs/heads/shopify-sync:refs/remotes/origin/shopify-sync` so the lease-SHA used by `--force-with-lease` reflects the true current tip.
- **TIGHTENED** Dependabot `pulls.list` page size (S6). `per_page: 5` to `per_page: 1`. GitHub guarantees (state, head) uniqueness for open PRs; the explicit `1` makes the assumption visible.
- **ASSERTED** non-empty `deployedSha` after `pulls.merge` (S7). The squash-merge API response is documented to return the new merge-commit SHA in the `sha` field, but a future response-shape change could silently produce an empty refspec for the Sync step (`git push origin :shopify-sync` would DELETE the branch). A defensive `if (!deployedSha)` check now sets `merged = false` with an explicit error message.
- **STRENGTHENED** the HEAD-drifted-post-deploy report copy (S8). When `merged === false` and `mergeError` matches `HEAD drifted post-deploy`, the deploy report now renders a louder `:rotating_light:` notice explicitly warning the operator not to reflexively click Merge in the GitHub UI; the live theme is on the deployed SHA, but the PR head has moved since deploy, so a manual merge would land different commits than what's on the storefront.
- **ADDED** `actions: read` to the deploy job permissions (S9). Forward-compat; any future deploy step that calls `listWorkflowRuns` / `getWorkflowRun` (e.g. to surface the Validate run id in the report) needs the grant. Harmless when unused.
- **SWITCHED** the sync-success icon from `:arrows_clockwise:` to `:white_check_mark:` (N3). Cosmetic: matches the report header's vocabulary and removes the "in-progress" ambiguity.
- **UPSERTED** the stale-reconcile-PR sticky in `sync.yml` (N4). The prior `gh pr comment` form appended a fresh comment on every cron firing; a PR open for a week accumulated seven identical "stale" notices. Tagged with `<!-- stale-reconcile -->` and now upserted via the GitHub API.

### Operator action

None. `shopify-sync` is currently 6 commits behind `main` (PRs #6, #7, #8, #9, #10, #11, #12 all merged after the last successful sync). The next admin commit on the unpublished sync theme will reopen the auto-reconcile PR; Validate will pass on its branch; and the auto-deploy arm will now successfully fast-forward `shopify-sync` to the deployed SHA in its post-merge step. Manual recovery remains available but is not necessary: a local `git push --force-with-lease=shopify-sync:<expected-sha> origin main:shopify-sync` from a workstation with push access would close the drift immediately.

### Deploy chain reorder: merge is the final user-visible action

PR #11's deploy report demonstrated that the prior step order ran the squash-merge BEFORE the deploy-report sticky, preview-deletion sticky update, and rocket reaction. The PR closed first; comments and emojis landed afterward on a closed PR. This entry inverts that order so the squash-merge is the last user-visible event of the chain.

New step order in the `deploy` job:

1. Live theme push
2. Delete preview theme (gated on push success, not merge success)
3. Update preview comment ("Preview theme deleted; live theme is serving this commit; squash-merge to follow")
4. React with rocket
5. Post deploy report (push + smoke + cleanup status; no merge or sync status, since neither has run yet)
6. **Squash merge** (the final user-visible event; PR closes here)
7. Sync main -> shopify-sync (post-merge; not surfaced in PR timeline; warnings via `::warning::` workflow annotations only)
8. React with -1 (failure)
9. Report failure (failure; overwrites pre-merge sticky with merge-specific error copy, including a `:rotating_light:` warning for the HEAD-drifted-post-deploy case)

Key behaviour changes:

- **Deploy report posts once, before merge, without merge or sync status.** The PR's GitHub-rendered "Merged" badge becomes the merge confirmation when the merge step closes the PR. Sync status is observable only via the workflow log; `sync.yml`'s daily cron + admin-push retrigger are the self-heal.
- **Merge failure now calls `core.setFailed`.** Previously the merge step swallowed errors and the job stayed green even on a failed merge, leaving the deploy-report sticky claiming "Deployed successfully" next to an unmerged PR. Now a merge failure trips the job's failure mode, the `Report failure` step fires, and it overwrites the pre-merge sticky with merge-specific error copy.
- **Preview cleanup gated on live push success, not merge success.** Live serving the new code makes the preview obsolete regardless of whether the merge has happened yet. Accepted trade-off: a runner crash between cleanup and merge leaves "live deployed + PR open + preview gone"; live is already serving the new code so the preview's verification value is moot at that point.

### Audit findings deferred or accepted as-is

- **S3** (`deferred` sync status routing): kept routed to the warning path per the original-instruction routing. `deferred` means `shopify-sync` was NOT advanced by this deploy because an admin commit landed mid-flight; the operator should see a visible signal even though `sync.yml` will reconcile on the next admin push. Now surfaces as a `::warning::` workflow annotation rather than a deploy-report comment line (the report is posted before sync runs in the new order, so it no longer carries sync status).
- **N1** (`core.warning` + silent skip in the unexpected-head_branch branch of `gate.resolve`): kept as-is per CLAUDE.md's documented "workflow filter is the real gate; this is belt-and-braces" intent.
- **N5** (release-notes content review for sensitive content per CLAUDE.md "Sensitive Content" rules): self-reviewed; no personal email, machine paths, sub-state location detail, or tokens.

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

- **NEW** composite action `.github/actions/setup-shopify-cli/`: single source for `actions/setup-node` + `npm ci --ignore-scripts`. Used by `shopify-theme-push` and `validate.yml`. The CLI version pin (`@shopify/cli@3.94.3`) lives only in `package.json`.
- **EXTENDED** `.github/actions/shopify-theme-push/` with `mode: delete-preview`. Lists themes named `pr-${PR_NUMBER}-preview` and deletes them. Exits 0 on no-match (informational); non-zero on real Shopify API/auth failure so a token rotation surfaces loudly. New `cleanup-status` output threads into the deploy report comment.
- **REFACTORED** the three deploy workflows: split the prior `Merge PR and report success` mega-step into a four-step ladder (`Live theme push` -> `Squash merge` -> `Delete preview theme` (continue-on-error, gated on merge success) -> `Post (auto-)deploy report`). Cleanup ordering is post-merge intentionally; a runner crash or non-transient cleanup failure cannot leave the system in `live deployed + PR open + preview gone`.
- **UPDATED** `preview.yml::cleanup` to call `shopify-theme-push` with `mode: delete-preview`. Replaces inline `npm install -g @shopify/cli@3.94.3` + bash with the composite action call (after a `ref: main` checkout because the PR head ref may already be deleted).
- **UPDATED** `validate.yml` to use `setup-shopify-cli` (drops a duplicate setup-node + npm-ci block).
- **DELETED** `.github/workflows/drift-watch.yml`. Loss of weekly orphan-preview sweep is accepted; the synchronous cleanup is the primary mechanism, with manual `npx shopify theme list | grep pr-` plus `shopify theme delete --theme <id> --force` as the documented recovery path.
- **UPDATED** `sync-reconcile.yml` to remove issue creation (issues are disabled on this repo). Diff-sanity alarm now relies on workflow-failure notifications; stale-PR alarm posts a `gh pr comment` per stale PR. `issues: write` permission dropped.
- **UPDATED** `setup-labels.yml` to drop the `deploy-attention` label (no remaining callers) and `issues: write` permission.

Trust-model implications: token-rotation call-site catalog drops from 7 sites to 4, and all four now route through `shopify-theme-push`. There is no longer an automated detector for unauthorised admin-side edits to the live theme; the "live = main" invariant is operator discipline, not CI-enforced. Acceptable for a single-developer private repo.

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

`pr-checks.yml` was replaced by `validate.yml` (one sequential job with five steps: `theme-check`, `reconcile`, `actionlint`, `zizmor`, `gitleaks`; plus a sticky-comment aggregator). A new composite action `.github/actions/shopify-theme-push/` factors out the live and preview push paths and adds smoke-test, per-attempt timeout, and token-redaction.

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
