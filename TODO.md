# Review TODO

> Deferred findings from pre-PR reviews. Check off items as resolved.

## Important

- [ ] **[AR-2]** Six identical `withRetry` IIFEs across `deploy.yml`, `shopify-sync-auto-deploy.yml`, `dependabot-auto-deploy.yml` (success + failure paths). The plan deliberately inlines this to avoid cross-branch script-availability dependencies; revisit once back-dated PRs are unlikely. Consider extracting to a single composite action with the upsert-comment logic too. (architecture-reviewer, 2026-05-03)
- [ ] **[AR-4]** Composite action's mode dispatch (`live` vs `preview`) is asymmetric in practice; the shared prologue is small relative to the divergent branches. Either add a `delete` mode and route preview-cleanup through the action (eliminates the hardcoded `@shopify/cli@3.94.3` in `preview.yml` cleanup), or split into `shopify-theme-push-live` and `shopify-theme-push-preview` actions. (architecture-reviewer, 2026-05-03)
- [ ] **[AR-5]** Preview push has no retry/timeout, unlike live push. A transient blip during a preview push fails the PR. Wrap with a 2-attempt loop and `timeout --kill-after=10s 5m`. (architecture-reviewer, 2026-05-03)
- [ ] **[AR-6 / IR-1]** Inconsistent npm install patterns: composite action uses `npm ci --ignore-scripts`, drift-watch uses `npm ci --ignore-scripts` (now fixed), preview cleanup uses `npm install -g @shopify/cli@3.94.3` (hardcoded version drifts from `package.json`). Route preview-cleanup through the composite action via a new `delete` mode. (architecture-reviewer + infra-reviewer, 2026-05-03)
- [ ] **[AR-9]** Validate aggregator's UX value over individual check_run statuses is mostly redundant; consider trimming to a one-line banner ("Validation green; comment `deploy`") and dropping the table. (architecture-reviewer, 2026-05-03)
- [ ] **[AR-10]** Dependabot major-version regex matches "Bump foo from X.Y.Z to A.B.C" but misses grouped PR titles ("Bump the github-actions group with N updates"). The dependabot config now groups all bumps; a major bump in a group ships unattended. Parse PR body for grouped PRs, or treat any grouped PR as requiring `auto-deploy-major` label. (architecture-reviewer, 2026-05-03)
- [ ] **[AR-13]** Preview deploy uses `cancel-in-progress: true`; a fast push-storm can leave the preview theme partially uploaded. Either change to `cancel-in-progress: false` and accept queueing, or document the partial-push trade-off. (architecture-reviewer, 2026-05-03)
- [ ] **[CR-8]** Preview cleanup `setup-node` lacks `cache: npm` and uses global install. Same root cause as AR-6/IR-1; bundle. (code-reviewer, 2026-05-03)
- [ ] **[CR-11]** `listWorkflowRuns` `per_page: 100` may miss the latest run on a SHA with extreme re-validation count. Paginate, or accept the cap and document. (code-reviewer, 2026-05-03)
- [ ] **[DS-5 / DS-6]** `release-notes.md` historical "CI/CD cutover (2026-05-03)" section has not been frame as superseded; its file inventory still lists `pr-checks.yml` and the old workflow set as current. Add `(superseded by the comment-driven deploy refactor)` to the heading. (doc-sync-checker, 2026-05-03)
- [ ] **[IR-3]** `LIVE_THEME_ID` is hardcoded as `"181702754604"` in three workflow files. Move to a repo variable (`vars.LIVE_THEME_ID`) so a republish only updates one place. (infra-reviewer, 2026-05-03)
- [ ] **[IR-4]** Auto-deploy workflows inline the same `withRetry` helper four times each. Once back-dated PRs are unlikely, move to `.github/scripts/with-retry.js` and load via `actions/github-script`'s `script-file`. (infra-reviewer, 2026-05-03)
- [ ] **[IR-5]** `drift-watch.yml` `shopify theme pull` step has no per-step timeout; a hung CLI consumes the full 15-minute job budget. Wrap with `timeout --kill-after=10s 5m`. (infra-reviewer, 2026-05-03)
- [ ] **[SA-4]** `compareCommits` after `pr.head.sha === trustedSha` is a tautology (compares a SHA to itself, always returns `identical`). Either remove or refactor to compare `trustedSha` against the PR base to detect history rewrites. (security-auditor, 2026-05-03)
- [ ] **[SA-6]** `permission-check` job reacts with `eyes` before identity is verified. Minor info leak (eyes is non-authenticated, no SHA exposed). Move the eyes-reaction call after permission check succeeds, or accept. (security-auditor, 2026-05-03)
- [ ] **[SA-9]** Consider adding an aggregate-style required-status check whose conclusion rolls up the four required jobs; would let branch protection require a single `validate` check instead of four. (security-auditor, 2026-05-03)
- [ ] **[SA-10]** Soft rate limit on the `deploy` comment trigger (e.g., reject if previous deploy on this PR completed less than 60s ago). Defends against compromised-collaborator deploy storms. (security-auditor, 2026-05-03)
- [ ] **[SA-11]** Auto-deploy gate could explicitly assert `pr.merged === false` before merging; currently relies on `pulls.merge` 409 to surface the race. (security-auditor, 2026-05-03)

## Suggestions

- [ ] **[AR-11]** Three failure-stage-detection ladders are identical. Extract to a shared composite or add inline cross-reference comments. (architecture-reviewer, 2026-05-03)
- [ ] **[AR-12]** Smoke-test step's `if: success() && inputs.mode == 'live'` (now fixed) means failure-ladder ordering is load-bearing. Add a one-line comment noting "pushExit must be checked before smokeExit." (architecture-reviewer, 2026-05-03)
- [ ] **[AR-14]** Add inline comment above each `concurrency: deploy-production` block noting it is shared across `deploy.yml`, `shopify-sync-auto-deploy.yml`, `dependabot-auto-deploy.yml`. (architecture-reviewer, 2026-05-03)
- [ ] **[CR-9]** A pre-commit / CI check verifying the six `withRetry` IIFEs remain byte-identical (md5 hash) would catch drift. (code-reviewer, 2026-05-03)
- [ ] **[CR-12]** Add comment in composite action explaining why `--ignore-scripts` is safe (esbuild + @ast-grep/napi use optionalDependencies for platform binaries). (code-reviewer, 2026-05-03)
- [ ] **[CR-13]** `deploy` comment trigger uses strict equality; document the exact-match requirement in README so `Deploy`, `/deploy`, `deploy ` (trailing space) variants don't silently fail. (code-reviewer, 2026-05-03)
- [ ] **[DS-7]** CLAUDE.md "Code changes" step 3 doesn't mention the aggregator or which checks are required for branch protection. Tighten or align with README. (doc-sync-checker, 2026-05-03)
- [ ] **[DS-10]** README "Branches and themes" table doesn't enumerate the four required checks on `main`. (doc-sync-checker, 2026-05-03)
- [ ] **[DS-11]** `THEME_CHECK_NON_ACTIONABLE.md` says "the new `--fail-level error` CI gate" without naming `validate.yml`. (doc-sync-checker, 2026-05-03)
- [ ] **[DS-12]** README "Local development" line uses informal "etc." for the validate jobs; tighten. (doc-sync-checker, 2026-05-03)
- [ ] **[DS-13]** Smoke-test default paths are duplicated in README, release-notes, and the action default. Composite action says "commit it to CLAUDE.md as a permanent fixture"; CLAUDE.md doesn't mention them. Pick one source of truth. (doc-sync-checker, 2026-05-03)
- [ ] **[DS-14]** Lift the `validate`-name-is-load-bearing warning into CLAUDE.md prose; today it lives only in workflow file headers. (doc-sync-checker, 2026-05-03)
- [ ] **[DS-15]** CLAUDE.md does not mention `.github/zizmor.yml` or its suppression rationale. (doc-sync-checker, 2026-05-03)
- [ ] **[DS-16]** Release-notes top section says "mirroring the dependabot-auto-deploy pattern" as if it pre-existed; both auto-deploys are net-new. Reword. (doc-sync-checker, 2026-05-03)
- [ ] **[SA-7]** Consider `defaults.run.shell: 'bash --noprofile --norc -euo pipefail {0}'` at workflow root for forward-looking defence against future steps inheriting a non-clean shell. (security-auditor, 2026-05-03)
- [ ] **[SA-8]** Annotate the two SC2016 false positives in `actionlint` output (`drift-watch.yml:70`, `sync-reconcile.yml:88`) so lint output is clean. (security-auditor, 2026-05-03)
- [ ] **[SA-12]** Replace `gh issue create --body "$BODY"` with `--body-file` in any sites still using shell interpolation (already done in sync-reconcile.yml and drift-watch.yml as part of this refactor). Audit for any new sites. (security-auditor, 2026-05-03)
- [ ] **[SA-13]** Add architecture-gap audit issue: long-lived `auto-deploy-audit` GitHub issue to record every auto-deploy past the 90-day workflow log retention. (architecture-reviewer + security-auditor, 2026-05-03)

## Architecture gaps (longer-horizon)

- [ ] **[AR-Gap-1]** No long-lived audit trail beyond GitHub's 90-day workflow log retention. Add a small step at the end of each successful auto-deploy that appends a one-line entry to a long-lived `auto-deploy-audit` GitHub issue. (architecture-reviewer, 2026-05-03)
- [ ] **[AR-Gap-2]** No mechanism to test the composite action independently of a live deploy. Add a `workflow_dispatch`-only `action-self-test.yml` that exercises the action in `mode: preview`. (architecture-reviewer, 2026-05-03)
- [ ] **[AR-Gap-3]** No structured logging in the workflow scripts. When the audit issue is added (gap 1), use a structured machine-readable line format so future tools can parse it. (architecture-reviewer, 2026-05-03)
