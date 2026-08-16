# Deploy gate reference

Full mechanical breakdown of `deploy.yml`'s auto-deploy gates. CLAUDE.md's "Deploy gate trust
delta" section carries the condensed, load-bearing version of this (the "do not remove/weaken
this" directives); this file is the detailed reference for when you're actually touching
`deploy.yml`. Design rationale, alternatives considered, and incident history are in
`release-notes.md`, not here.

## Pipeline shape

The deploy chain has **no GitHub Environment binding**. `SHOPIFY_CLI_THEME_TOKEN` and
`STOREFRONT_PASSWORD` are repo-level secrets; `SHOPIFY_DOMAIN` / `SHOPIFY_FLAG_STORE` /
`EXPECTED_SYNC_PR_OPENER` are repo-level variables. `deploy.yml` is a three-job pipeline:
`gate` (no token; computes the gates below, plus `theme_touched`), `deploy` (Shopify token +
storefront password, no deploy key; `needs: gate`; live push + smoke + squash-merge), and
`sync` (deploy key, no Shopify token; `needs: deploy`; reconciles `shopify-sync`). Each secret
is isolated to one job's bash; `STOREFRONT_PASSWORD` is wired only into the push step's smoke
and is read by `smoke.mjs` from env, never argv.

## The four gates

1. **Collaborator permission** (comment path). `gate` calls `getCollaboratorPermissionLevel`
   on the comment author and proceeds only for `admin` / `write`. Workflow-level `if`
   pre-filters by `author_association` and asserts `github.event.issue.pull_request`.

2. **Validate-on-HEAD-SHA** (all paths). Comment path: `listWorkflowRuns` filtered by
   `validate.yml`, `head_sha`, **and** `event: 'pull_request'` (the event filter blocks a
   future `push` / `workflow_dispatch` trigger on validate.yml from masquerading as proof).
   Workflow_run paths: re-fetch the triggering Validate run via `getWorkflowRun`, assert
   `status: completed`, then assert the **`validate` JOB** is `completed/success` via
   `listJobsForWorkflowRun` (`filter: 'latest'`), and thread the run's `head_sha` as
   `trustedSha` through every downstream API call. HEAD-drift is first asserted via
   `pr.head.sha === trustedSha`; `compareCommits.status === 'identical'` is **defence in
   depth** on top of that.
   - **Gate on the JOB, not the run.** `validate.yml` is two jobs: `deploy-preview` (pushes
     the `pr-N-preview` theme; holds the Shopify CLI token; runs for shopify-sync reconcile
     PRs too) and `validate` (every PR-time check). Only the second is a verdict on the code,
     and `validate / validate` is exactly the context branch protection requires on `main`, so
     the job is what the rest of the system already trusts. The workflow-level `if:`
     accordingly admits `workflow_run.conclusion` of `success` **or** `failure`; `cancelled`
     stays excluded because validate.yml's `cancel-in-progress` group cancels the whole run on
     every push and those carry no verdict. A green job under a red run proceeds with a
     `core.warning` naming `deploy-preview`; a red job under a *green* run is impossible and
     `setFailed`s; a missing job `setFailed`s only under a green run, since a red run can
     legitimately have no jobs (validate.yml failed to parse).
   - **Do not over-credit this.** On its own it does **not** yet unblock a preview-push flake.
     `validate.yml` independently turns a non-success `deploy-preview` into a11y
     `exit_code=1`, which reds the `validate` job too, so "red run, green `validate` job"
     is currently unreachable with two jobs. This is hardening that makes the gate robust to
     that coupling changing and to a third job being added. The validate-side decoupling that
     would actually unblock a preview flake is deferred, not done: key the audit off
     `deploy-preview.outputs.theme_id` (written only after a successful push, so a non-empty
     value means the theme is fully uploaded) rather than off `deploy-preview.result` (which
     also goes non-success when the *comment* step fails after the push landed).
   - **The comment path deliberately still requires the whole RUN green** (`listWorkflowRuns`
     → `latest.conclusion === 'success'`). Gate 2 therefore has two implementations that can
     disagree once the coupling above is relaxed. The asymmetry is intentional and in the safe
     direction: the comment path is the stricter of the two, and it is the one a human reaches
     for when auto-deploy has already refused.
   - The job name `'validate'` is hardcoded in `deploy.yml`'s `resolve` step, the same way the
     workflow name `"validate"` is hardcoded in `on.workflow_run.workflows`. Renaming either
     breaks both auto-deploy paths; `resolve` fails loudly (listing the job names it did see)
     rather than silently passing.
   - **Do not "simplify" the `compareCommits` check away** as redundant with the SHA
     equality. The comparison is commit-object equality, **not** tree equality; same-tree
     amends, cherry-picks, and different-tree force-pushes all return `diverged`, not
     `identical` (see `release-notes.md`).
   - For workflow_run paths, Validate is **advisory** (a malicious PR head could rewrite
     `validate.yml` to pass falsely). The actual integrity boundary for auto-deploys is the
     signed-commit gate below.

3. **Signed-commit gate** (workflow_run paths). Assert `verification.verified === true`,
   `commit.author.login === expectedBot` (`shopify[bot]` for shopify-sync; `dependabot[bot]`
   for dependabot), and `pull_request.user.login === expectedPrOpener` (shopify-sync:
   `vars.EXPECTED_SYNC_PR_OPENER` at runtime, the PAT owner; dependabot: the
   `dependabot[bot]` constant).
   - **`commit.committer.login` may be `expectedBot` OR `web-flow` and is informational, not
     a security signal.** Anyone with `contents: write` can produce a `web-flow` committer
     via web-UI edits, the Update-branch / Rebase buttons, `PUT /contents/{path}`, or
     `@dependabot rebase` / `@dependabot recreate`. Do not re-introduce strict equality on
     committer (prior regression: see `release-notes.md`).
   - Integrity boundary: author identity + signature verification + PR-opener identity.
     Git-commit-header fields are forgeable and not consulted. Trust delta for the post-PAT
     PR-opener (now a PAT-exfiltrable login): bounded by signed-commit-identity above and by
     gate 4 below; full chain in `release-notes.md`.

4. **Defence-in-depth merge-base assertion** (workflow_run paths).
   `repos.compareCommits(base: main_tip, head: trustedSha).behind_by === 0`. Catches "PR head
   was missing main commits at PR creation time"; independent of the base-staleness check in
   gate 2. For shopify-sync, blocks the misleading-revert PR scenario and the PAT-exfil
   stale-PR replay (independently of `sync.yml`'s own merge-base prevention guard at the
   create-PR call site). For dependabot, no-op in the normal flow; belt-and-braces.

All four gates assume workflow files are correct. A compromised `contents: write`
collaborator who can land any PR bypasses all of them and could already exfiltrate any secret
via a malicious workflow change; the PAT and deploy key do not enlarge this surface.

## Deploy-key bypass-row scope

`SHOPIFY_SYNC_DEPLOY_KEY` has full repo push capability across all refs (deploy keys are
repo-scoped by GitHub design). The `Deploy keys` bypass-actor row on ruleset
`shopify-sync-protection` is what scopes its bypass authority to that one branch. **Do NOT
add the deploy key as a bypass actor on any ruleset protecting `main`.** Bypass authority is
decoupled from human role membership.

## Known compensations (deferred)

A preview-only Shopify token; a long-lived `auto-deploy-audit` issue for forensics beyond
90-day log retention.
