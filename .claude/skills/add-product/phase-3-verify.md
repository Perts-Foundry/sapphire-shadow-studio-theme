# Phase 3: verify

All read-only. Browser steps follow CLAUDE.md's Browser testing rules and docs/browser-testing.md (opt-in, password bypass via
the admin Preview link).

## Steps

1. `published-check` (verify, FIRST, do not reorder): confirm the product is published, using the
   same check as phase 2 step 9. Neither of the steps below can name this failure. The crawl is
   blind by construction: `seo-review` reads the sitemap, which an unpublished product is absent
   from, so it reports nothing rather than a finding. The browser step is worse than blind: the
   theme preview link this phase uses (docs/browser-testing.md) returns a bare 404 for an
   unpublished product, and a 404 there has a dozen other causes, so it misdirects rather than
   informs. One publications read names the cause outright. Running this after either of them is
   how the first run closed green. `status == ACTIVE` is not evidence here.
   - Completion check: the same read as phase 2 step 9, through the same helper
     (`scripts/add-product/publication-check.mjs --all --sibling <handle> --sibling <handle>`), run
     fresh rather than trusted from the state file. That is deliberate duplication, not waste: it
     catches a state file claiming done, and a channel unpublished between the phases.
   - On failure this is a HALT, not a finding. Stop phase 3, return to phase 2 step 9, and say
     plainly that no customer can see the product. Do not run the steps below; they will read green
     around it, which is exactly how this got missed the first time.
2. `preview-checks` (verify, browser, operator-invited): on the live product page: the gallery
   filters by colour selection (the alt-text binding, checkable nowhere in the repo), the size
   chart accordion renders and its `#SizeChart` anchor works, the variant picker behaves with any
   collapsed option, and the page has exactly one h1 (nothing in CI checks heading structure).
3. `seo-review` (route:/seo-review; skip for a new design value): the full read-only audit; adding
   products is one of its named triggers.
   - The skip is on the merits, not for speed: a design value mints no URL and no sitemap entry,
     and nothing this audit reads changes. Record it as not-applicable with that reason. Every
     other entry runs it, including a new colour, which does change what a crawl sees.
   - Completion check: its report exists and any finding is presented to the operator.
4. `converge` (verify): the sku skill's verify and, where run, blank-inventory's verify both
   report convergence (propagation is not atomic).
5. `close`: summarise the whole run (every step, its evidence, and every `na_confirmed` with the
   reason it was confirmed under), then `scripts/add-product/state.mjs close --archive`, which marks
   the run closed and moves the file under the state dir's `archive/`.
   - **Then clean up, by list and not by pattern.** List the artifacts the state file recorded
     (receipts, plan artifacts, survey output), and delete only those, and only the ones git does
     not track. Anything inside the checkout that `git status` reports is not yours to delete here:
     an untracked file in a worktree is as likely to be work in progress as it is to be scratch, and
     a wildcard cleanup cannot tell them apart. Receipts hold live-store ids, so they are deleted or
     left under the state dir, never moved into the repo.
   - Completion check: the worktree the run used is gone, the primary checkout is on `main`, and the
     state file is under `archive/`. Phase 1 step 10 is what leaves the first two true; if it did
     not run, run it now rather than closing over it.
