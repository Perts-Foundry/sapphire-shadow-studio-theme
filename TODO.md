# TODO

Single backlog for the whole repo. Everything goes here; there are no per-directory TODO files.
Check off items as they land, and keep the note about what actually shipped.

Sections: [Product and storefront](#product-and-storefront) (merchandising / UX ideas),
[Size-chart tooling](#size-chart-tooling) (`scripts/size-chart/`),
[Deferred review findings](#deferred-review-findings) (from pre-PR reviews).

## Product and storefront

- [ ] **Per-variant image matching for colours.** Show the photo for the colour the shopper picked,
  rather than a fixed gallery. **The theme already does the swap**: both
  `snippets/product-media-gallery-content.liquid:31` and `snippets/card-gallery.liquid:88` filter on
  `where: 'attached_to_variant?', true`, so the plumbing exists and this is mostly an Admin task
  (attach each colour's photos to its variants) plus a decision about
  `_product-media-gallery`'s `"hide_variants": true` setting, which the shipped product templates all
  set. Start by checking what that flag does with variant-attached media before writing any code.
  Blocked in practice on having per-colour photography: the quarter-zip has black / blue / gray, the
  women's vest is black only.

- [x] **Require acknowledging the return policy and reviewing the size guide before add-to-cart.**
  Shipped as a terms summary (merchant-editable `richtext`) plus one required "I agree" checkbox,
  wired together with `aria-describedby`, and a policy link outside the label. The checkbox unticks
  itself on any option change, which is what lets the `properties[Return policy acknowledged]` value
  name the confirmed size honestly: the box can only ever be ticked for the variant on screen.
  Unticking re-hides accelerated checkout and is announced in a polite live region. Blank `terms`
  hides the block entirely (hence `"tag": null`, so no empty element trips the fail-closed
  `:has()` rule). Validation now renders as visible text with `aria-invalid`, not just the native
  bubble.
  **The original note here had gap (1) backwards**: it called for adding the block to
  `product.shift-fuel-crewneck.json`. That is the one product with no personalization and a plain
  14-day return window, so it is the one product the checkbox must not appear on. The real
  inconsistency was `product.huddle-crewneck.json`, which carried the checkbox while its own Returns
  Policy accordion promised a 14-day return. Kept rather than deleted, because the mistake is the
  useful part: block placement, not block content, is what expresses the policy.

- [ ] **Gift card template.** The gift card product is active, has no product template, and this
  theme ships no default `templates/product.json`. Decide what it renders with. The FAQ copy already
  states gift cards are not returnable, so that answer does not depend on this; the open question is
  what the product page itself uses.

- [ ] **Revisit the Shift Fuel return window for consistency.** It is the only product that accepts
  returns. Worth confirming that is still the intent once the catalogue settles.

- [ ] **Size-guide link on products with no chart.** `assets/size-guide-link.js` removes the link
  when `#SizeChart` is absent, so a product with a size option but no generated chart degrades
  cleanly with JS on. With JS off the link renders and does nothing. Gate it in Liquid instead if a
  chartless product with sizes ever ships.

## Size-chart tooling

Follow-ups from the customer-needs vs. size-chart gap analysis (2026-07-14). Garment-independent
wording lives in `scripts/size-chart/copy.md`; per-garment data and per-measurement prose live in
`scripts/size-chart/profiles/<blank>.json`; the on-page accordion and the PNG both regenerate from
those. See `scripts/size-chart/README.md` for the tooling. Importance (imp) is 1 (nice-to-have) to
5 (decisive for choosing a size / avoiding a wrong-size order).

### Done

- **"Choosing your size" guidance** in both the accordion and the PNG intro: chest is the deciding
  measurement; between-sizes tie-breaker (size up for room, down for a closer fit); a
  no-reference-garment path; and a "contact us before you order" help line.
  **Correction (2026-07-16):** this bullet originally claimed the paragraph was "garment independent,
  so it lives once in `copy.md` and applies to every blank". That was wrong, and the vests proved it:
  the paragraph named chest (the women's vest measures bust) and named sleeve (a vest has none). It
  has since been split. The tie-breaker and help line stayed shared; the deciding measurement became
  the `{{deciding_label}}` token; the measure-yourself instruction moved onto the columns that can
  support it. Kept rather than deleted, because the mistake is the useful part.

- **Column-driven generalisation.** Profiles declare their own ordered `columns` (role + kind +
  authored heading/how + optional `derive`) and pick a `garment` silhouette (crewneck / quarter-zip /
  vest, with a no-diagram fallback). The quarter-zip and the women's microfleece vest are onboarded
  end to end: profile, PNG, and on-page row in `templates/product.lead-ii-quarter-zip.json` and
  `product.lead-ii-vest-womens.json`. Neither product exists in Shopify Admin yet, so their
  storefront URLs do not resolve; Admin creation is the remaining step, not template work.

- **Vertical-rhythm pass on the PNG.** Tightened the top whitespace and derived canvas height from
  content plus a fixed bottom margin, so every garment gets matching top/bottom whitespace
  (`canvas_height` became an optional override). Each garment declares its own collar-crown extent
  (`garmentTop` in `garments.mjs`), and the diagram and legend are co-centred.

- **Per-garment accordion prose (2026-07-16).** `copy.md` now holds only garment-independent framing;
  per-measurement prose lives on each column's `explain`, composed as `intro + choosing + one <p> per
  column that declares explain + trailer`. A measurement is explained if and only if the blank has
  that column, so the vest loses the sleeve paragraph and the quarter-zip gains a zipper one with no
  conditionals. Added `garment_noun` and `decides_size` to the schema, plus `{{garment_noun}}` /
  `{{deciding_label}}` tokens. Before this, every blank shipped the crewneck's wording: the women's
  vest explained "Sleeve length" and "Chest (circumference)" while its own table read Bust and Body
  Length.

- **Unisex microfleece vest dropped (2026-07-16).** Only the women's vest is launching, so its
  profile was removed rather than carried unused. Recoverable from git history.

### High priority

- [ ] **Per-garment fit descriptor (imp 5).** Do NOT hardcode in `copy.md`; fit differs per blank.
  Make it a dynamic question the skill asks per garment at onboarding, stored in a new profile `fit`
  object (e.g. `{ "cut": "true-to-size" | "relaxed" | "oversized", "note": "..." }`), rendered at the
  top of the accordion and in the PNG intro band. This also carries the **unisex-to-women's
  size-down direction (imp 5)**, since which way to size depends on the cut. Steps: (1) extend
  `lib/profile-schema.mjs` with an optional `fit` object; (2) render it in `lib/table-block.mjs`
  (accordion) and `lib/render-svg.mjs` (PNG); (3) add a "gather fit character" step to
  `.claude/skills/size-chart/SKILL.md`; (4) fill `fit` in `profiles/crewneck-fleece.json` once the
  operator confirms how the fleece wears.
  **Cheapened by the per-garment prose work**: step (2)'s accordion insertion point now exists, as a
  third `copy.md`-adjacent paragraph between intro and choosing. `fit.cut` should eventually own the
  "size up for room / down for a closer fit" sentence currently sitting in the shared choosing copy,
  since the direction depends on the cut.

- [x] **Size-guide link at the size selector (imp 4).** Shipped. `snippets/size-guide-link.liquid` +
  `assets/size-guide-link.js` render a real `<a href="#SizeChart">` beside the size option on both
  variant-picker styles; it opens the accordion row, scrolls, and moves focus to the summary. The
  size option is identified by a global `size_option_name` setting resolved through
  `snippets/size-option-position.liquid`, shared with the acknowledgement block because a theme
  block cannot read another block's settings. `_accordion-row.liquid` gained an optional `anchor_id`
  setting, emitted as `SizeChart` by `table-block.mjs`, so it does survive `apply-size-chart.mjs`
  (a hand-edited value would be upserted away). `accordion-custom.js` gained a `data-latched-open`
  latch so a row opened this way is not slammed shut by the 750px breakpoint handler, and it now
  honours a direct `#SizeChart` page load.
  **Cross-layer contract**: the anchor literal is duplicated across the generator, the Liquid, and
  the link's href, because the theme has no build step. `test/anchor-contract.test.mjs` is the only
  thing holding those together; the goldens cannot, since they compare the generator to its own
  output.

- [ ] **Fabric & care block (imp 4/3).** Add an optional `fabric` object to the profile schema
  (`pre_shrunk` bool + `care` string + weight / composition / stretch) and render a compact
  "Fabric & care" line beneath the table in both outputs. Pre-shrunk status is the one fabric fact
  with a direct sizing consequence on a non-returnable garment (buy-measured vs. size-up). The
  current blank is confirmed "premium 8 oz. heavyweight fleece" (live product descriptions); tie any
  shrink figure to the real fiber content, not a cotton default. Consider whether weight/composition
  belong on the product description instead.

- [ ] **Body-chest to size lookup (imp 4).** For shoppers without a reference garment: an optional
  per-size recommended body-chest range in the profile, rendered as a companion column or a small
  "which size fits your chest" lookup. Note the women's microfleece vest has **no** body-measurement
  column at all (no derived circumference, no fits-chest range), so it is the blank this would help
  most.

### Medium / polish

- [ ] **Table accessibility (imp 3).** In `blocks/table.liquid`, make each data row's first cell a
  `<th scope="row">` (currently a `<td>`) and add a `<caption>` / `<figcaption>` naming the chart.
  Already a semantic table with `<th scope="col">` headers; this closes the remaining gap.

- [ ] **Torso-drop descriptor (imp 3).** Plain-language note on where the (long) body length lands,
  framed for shorter and women wearers. Rides the fit-descriptor copy; no new field.

- [ ] **Body-length start-point note (imp 2).** The shipped crewneck copy measures body length from
  the high point of the shoulder (HPS); the vest measures "at back" (`body_length_back`) with its
  own definition. If a future blank's manufacturer measures from the shoulder-sleeve seam instead,
  spell that out in that column's `how` and `explain` text so a shopper comparing charts is not
  thrown by a shorter number.

### Intentionally excluded (operator decision, 2026-07-14)

- **Returns / exchange line in the chart:** handled by the return-policy-acknowledgment block near
  the buy buttons. Do not duplicate in the size chart.
- **Made-by-hand measurement-tolerance line:** skipped.
- **Model / on-body fit reference photo (imp 4):** photography / merchandising task, out of tooling
  scope. Add a "model is X tall, wears M" gallery caption when on-body shots exist.
- **Aggregate runs-small / true / large review subscore (imp 3):** cold-start; revisit once review
  volume exists.
- **No-tape string-and-ruler fallback (imp 3):** redundant with the "measure a top you already own"
  method that is already the primary instruction.
- **Pre-purchase / add-to-cart size nudge (imp 2):** covered by the existing
  return-policy-acknowledgment block; avoid extra checkout friction.

## Deferred review findings

Deferred findings from pre-PR reviews.

### Important

- [ ] **[AR-2]** Six identical `withRetry` IIFEs across `deploy.yml`, `shopify-sync-auto-deploy.yml`, `dependabot-auto-deploy.yml` (success + failure paths). The plan deliberately inlines this to avoid cross-branch script-availability dependencies; revisit once back-dated PRs are unlikely. Consider extracting to a single composite action with the upsert-comment logic too. (architecture-reviewer, 2026-05-03). Related: `validate.yml` now carries a sixth copy of the per-step capture boilerplate (code-reviewer, 2026-07-16).
- [x] **[AR-4]** Composite action's mode dispatch (`live` vs `preview`) is asymmetric in practice; the shared prologue is small relative to the divergent branches. Either add a `delete` mode and route preview-cleanup through the action (eliminates the hardcoded `@shopify/cli@3.94.3` in `preview.yml` cleanup), or split into `shopify-theme-push-live` and `shopify-theme-push-preview` actions. (architecture-reviewer, 2026-05-03). Landed 2026-05-05 as `mode: delete-preview`.
- [ ] **[AR-5]** Preview push has no retry/timeout, unlike live push. A transient blip during a preview push fails the PR. Wrap with a 2-attempt loop and `timeout --kill-after=10s 5m`. (architecture-reviewer, 2026-05-03)
- [x] **[AR-6 / IR-1]** Inconsistent npm install patterns: composite action uses `npm ci --ignore-scripts`, drift-watch uses `npm ci --ignore-scripts` (now fixed), preview cleanup uses `npm install -g @shopify/cli@3.94.3` (hardcoded version drifts from `package.json`). Route preview-cleanup through the composite action via a new `delete` mode. (architecture-reviewer + infra-reviewer, 2026-05-03). Landed 2026-05-05; install pattern further consolidated into a new `setup-shopify-cli` composite action shared by `shopify-theme-push` and `validate.yml`.
- [ ] **[AR-9]** Validate aggregator's UX value over individual check_run statuses is mostly redundant; consider trimming to a one-line banner ("Validation green; comment `deploy`") and dropping the table. (architecture-reviewer, 2026-05-03)
- [ ] **[AR-10]** Dependabot major-version regex matches "Bump foo from X.Y.Z to A.B.C" but misses grouped PR titles ("Bump the github-actions group with N updates"). The dependabot config now groups all bumps; a major bump in a group ships unattended. Parse PR body for grouped PRs, or treat any grouped PR as requiring `auto-deploy-major` label. (architecture-reviewer, 2026-05-03)
- [ ] **[AR-13]** Preview deploy uses `cancel-in-progress: true`; a fast push-storm can leave the preview theme partially uploaded. Either change to `cancel-in-progress: false` and accept queueing, or document the partial-push trade-off. (architecture-reviewer, 2026-05-03)
- [x] **[CR-8]** Preview cleanup `setup-node` lacks `cache: npm` and uses global install. Same root cause as AR-6/IR-1; bundle. (code-reviewer, 2026-05-03). Landed 2026-05-05 alongside AR-6/IR-1.
- [ ] **[CR-11]** `listWorkflowRuns` `per_page: 100` may miss the latest run on a SHA with extreme re-validation count. Paginate, or accept the cap and document. (code-reviewer, 2026-05-03)
- [ ] **[CR-14]** The `GHEOF` heredoc delimiter in every `validate.yml` capture step is a fixed literal. Test output echoes arbitrary assertion values, so a line reading exactly `GHEOF` would truncate the heredoc and corrupt `$GITHUB_OUTPUT`. Use a random delimiter. Not a trust boundary (anyone who can add such a fixture can edit the workflow), so this is robustness, not security. (code-reviewer, 2026-07-16)
- [ ] **[CR-15]** `check_exit` in `validate.yml` treats a missing `exit_code` as a `::warning::`, not a failure, so a check that never recorded a result still merges green. Near-unreachable today (every step is `set +e` and always writes its code), but it covers `gitleaks`, where a silently skipped secret scan is worth more than a warning. (code-reviewer, 2026-07-16)
- [ ] **[DS-5 / DS-6]** `release-notes.md` historical "CI/CD cutover (2026-05-03)" section has not been frame as superseded; its file inventory still lists `pr-checks.yml` and the old workflow set as current. Add `(superseded by the comment-driven deploy refactor)` to the heading. (doc-sync-checker, 2026-05-03)
- [ ] **[DS-17]** `README.md` "At a glance" says the Shopify CLI is pinned at `3.94.3`; `package.json` says `4.5.1`. Dependabot has bumped the dependency twice without touching the prose. Either drop the version from the prose or add a check. (doc-sync-checker, 2026-07-16)
- [ ] **[IR-3]** `LIVE_THEME_ID` is hardcoded as `"181702754604"` in three workflow files. Move to a repo variable (`vars.LIVE_THEME_ID`) so a republish only updates one place. (infra-reviewer, 2026-05-03)
- [ ] **[IR-4]** Auto-deploy workflows inline the same `withRetry` helper four times each. Once back-dated PRs are unlikely, move to `.github/scripts/with-retry.js` and load via `actions/github-script`'s `script-file`. (infra-reviewer, 2026-05-03)
- [x] **[IR-5]** `drift-watch.yml` `shopify theme pull` step has no per-step timeout; a hung CLI consumes the full 15-minute job budget. Wrap with `timeout --kill-after=10s 5m`. (infra-reviewer, 2026-05-03). Obsolete 2026-05-05: `drift-watch.yml` deleted entirely.
- [ ] **[SA-4]** `compareCommits` after `pr.head.sha === trustedSha` is a tautology (compares a SHA to itself, always returns `identical`). Either remove or refactor to compare `trustedSha` against the PR base to detect history rewrites. (security-auditor, 2026-05-03)
- [ ] **[SA-6]** `permission-check` job reacts with `eyes` before identity is verified. Minor info leak (eyes is non-authenticated, no SHA exposed). Move the eyes-reaction call after permission check succeeds, or accept. (security-auditor, 2026-05-03)
- [ ] **[SA-9]** Consider adding an aggregate-style required-status check whose conclusion rolls up the four required jobs; would let branch protection require a single `validate` check instead of four. (security-auditor, 2026-05-03)
- [ ] **[SA-10]** Soft rate limit on the `deploy` comment trigger (e.g., reject if previous deploy on this PR completed less than 60s ago). Defends against compromised-collaborator deploy storms. (security-auditor, 2026-05-03)
- [ ] **[SA-11]** Auto-deploy gate could explicitly assert `pr.merged === false` before merging; currently relies on `pulls.merge` 409 to surface the race. (security-auditor, 2026-05-03)

### Suggestions

- [ ] **[AR-11]** Three failure-stage-detection ladders are identical. Extract to a shared composite or add inline cross-reference comments. (architecture-reviewer, 2026-05-03)
- [ ] **[AR-12]** Smoke-test step's `if: success() && inputs.mode == 'live'` (now fixed) means failure-ladder ordering is load-bearing. Add a one-line comment noting "pushExit must be checked before smokeExit." (architecture-reviewer, 2026-05-03)
- [ ] **[AR-14]** Add inline comment above each `concurrency: deploy-production` block noting it is shared across `deploy.yml`, `shopify-sync-auto-deploy.yml`, `dependabot-auto-deploy.yml`. (architecture-reviewer, 2026-05-03)
- [ ] **[CR-9]** A pre-commit / CI check verifying the six `withRetry` IIFEs remain byte-identical (md5 hash) would catch drift. (code-reviewer, 2026-05-03)
- [ ] **[CR-12]** Add comment in composite action explaining why `--ignore-scripts` is safe (esbuild + @ast-grep/napi use optionalDependencies for platform binaries). (code-reviewer, 2026-05-03). Note 2026-07-16: sharp 0.35.3 ships no install script at all, so `--ignore-scripts` is a no-op for it; its binaries arrive as plain optionalDependencies.
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
- [x] **[SA-8]** Annotate the two SC2016 false positives in `actionlint` output (`drift-watch.yml:70`, `sync-reconcile.yml:88`) so lint output is clean. (security-auditor, 2026-05-03). Partially obsolete 2026-05-05: `drift-watch.yml` deleted; `sync-reconcile.yml` SC2016 already covered by `validate.yml`'s `SHELLCHECK_OPTS: "-e SC2016 -e SC2317"`.
- [x] **[SA-12]** Replace `gh issue create --body "$BODY"` with `--body-file` in any sites still using shell interpolation (already done in sync-reconcile.yml and drift-watch.yml as part of this refactor). Audit for any new sites. (security-auditor, 2026-05-03). Obsolete 2026-05-05: drift-watch deleted; sync-reconcile no longer creates issues.
- [ ] **[SA-13]** Add architecture-gap audit issue: long-lived `auto-deploy-audit` GitHub issue to record every auto-deploy past the 90-day workflow log retention. (architecture-reviewer + security-auditor, 2026-05-03)

### Architecture gaps (longer-horizon)

- [ ] **[AR-Gap-1]** No long-lived audit trail beyond GitHub's 90-day workflow log retention. Add a small step at the end of each successful auto-deploy that appends a one-line entry to a long-lived `auto-deploy-audit` GitHub issue. (architecture-reviewer, 2026-05-03)
- [ ] **[AR-Gap-2]** No mechanism to test the composite action independently of a live deploy. Add a `workflow_dispatch`-only `action-self-test.yml` that exercises the action in `mode: preview`. (architecture-reviewer, 2026-05-03)
- [ ] **[AR-Gap-3]** No structured logging in the workflow scripts. When the audit issue is added (gap 1), use a structured machine-readable line format so future tools can parse it. (architecture-reviewer, 2026-05-03)
