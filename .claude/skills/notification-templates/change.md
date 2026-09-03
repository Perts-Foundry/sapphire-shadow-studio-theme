# change

Make a change to the branded templates, regenerate, verify a render, and take it through git to a
green PR. Ends with one STOP that decides whether Admin is synced now or after merge.

1. **Map the change to the file that owns it.** The operator describes the change; the table
   decides where it goes. Never edit `<id>.liquid` or `stock/<id>.liquid`.

   | Change | File |
   |---|---|
   | palette, spacing, type, mobile rules | `marketing/notifications/lib/brand-style.css` |
   | footer social row or shop-name line | `marketing/notifications/lib/footer-social.html` |
   | header band (the three `header`-override ids) | `marketing/notifications/lib/header.html` |
   | a template's anchors, or a stock markup bug | `manifest.json` override: `footerAnchor` / `styleAnchor` / `header` / `replace` (README, Overrides) |
   | Shopify changed a stock template | return to SKILL.md and run `record` first |

2. **Worktree, branch, regenerate, check.** Per the global git rules, then
   `npm run notifications:generate`, `npm run notifications:check`, `npm run notifications:test`,
   and the em-dash sweep. Report the version deltas by diffing
   `node scripts/notifications/brand.mjs --status` on the branch against
   `node scripts/notifications/brand.mjs --status --root <scratch>`, where `<scratch>` holds
   `origin/main` (`git worktree add <scratch> origin/main`, or
   `git archive origin/main marketing/notifications | tar -x -C <scratch>`); not from the
   generate's stdout, which shows only the last hop. A stylesheet change bumps every id in the
   manifest by design; say so rather than treating it as noise.

3. **Render check** (browser opt-in ask first, its own turn). Per `browser.md`: paste the branded
   file into the editor of at least one template whose preview shows unsaved edits (`browser.md`
   names the ones that do not) without saving, read the preview from the network response, and run
   `node scripts/notifications/verify-render.mjs --preview-response <file> --id <id> --version <n>`
   with the version from `--status` on the branch. For a stylesheet change also run the mobile procedure.
   For a `replace` or `header` override, check that template specifically, unless its preview
   ignores unsaved edits, in which case the check is deferred to `sync` and the STOP in step 6
   says so. Then discard the unsaved paste per the dirty-editor rule. Declined browser: skip, and every later report
   says "render check not run (browser declined)".

4. **Pre-push and PR.** Commit with a message naming the ids bumped and why, then the repo
   CLAUDE.md pre-push checklist (branch-diff scan, commit-message scan,
   `git config --local user.email`), fetch and rebase onto `origin/main`, push. Then the repo's pre-PR gate (`/pre-pr`: doc-sync-checker,
   test-engineer for `scripts/notifications/`, prompt-reviewer for `.claude/` content, the
   headless code review, `/security-review`), presented and waited on per that gate's own rules.
   Then open the PR (MCP github tools preferred); no attribution trailer in the commit or the
   PR body.

5. **Wait for the PR's checks** (`gh pr checks <n> --watch`) and report `validate` and
   `deploy-preview` by name (the per-tool results are steps inside the `validate` job, not
   checks of their own). Then read the sticky CI report comment on the PR and quote its
   "Notification templates: check", "Notification templates: tests" and "Gitleaks" rows
   verbatim. A red `validate`, or a failed row, ends the run with the failure text; do not offer
   a sync on a red PR.

6. **STOP** on green. Report: the PR, the check results, the ids whose version bumped in this PR
   (from the step 2 diff; they are now behind wherever Admin held the previous version, the
   state file's `seen` is the hint and `sync` is the proof), the render-check result (or "not
   run"), and any deferred render check (ids whose preview ignores unsaved edits). This STOP
   presents a choice, not a single action, so a bare affirmative is re-asked, never read as
   `sync now`. Three legal answers,
   anything else is not approval:
   - `sync now`: return to SKILL.md and run `sync --from <branch> <ids>`; it asks its own
     browser opt-in and presents its own plan-table STOP (three operator turns in total).
   - `after merge`: for each id, `node scripts/notifications/state.mjs --store <store>
     pending-add <id> --version <n> --fnv <fnv> --branch <branch> --pr <n>`, then end. The skill
     does not poll for the merge; the operator runs `sync` later.
   - `no`: end, nothing recorded.
