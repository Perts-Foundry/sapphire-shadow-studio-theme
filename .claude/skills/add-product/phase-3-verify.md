# Phase 3: verify

All read-only. Browser steps follow CLAUDE.md's Browser testing rules (opt-in, password bypass via
the admin Preview link).

## Steps

1. `published-check` (verify, FIRST, do not reorder): confirm the product is published, using the
   same check as phase 2 step 9. Neither of the steps below can name this failure. The crawl is
   blind by construction: `seo-review` reads the sitemap, which an unpublished product is absent
   from, so it reports nothing rather than a finding. The browser step is worse than blind: the
   theme preview link this phase uses (CLAUDE.md, Browser testing) returns a bare 404 for an
   unpublished product, and a 404 there has a dozen other causes, so it misdirects rather than
   informs. One publications read names the cause outright. Running this after either of them is
   how the first run closed green. `status == ACTIVE` is not evidence here.
   - Completion check: the same read as phase 2 step 9, run fresh rather than trusted from the state
     file. That is deliberate duplication, not waste: it catches a state file claiming done, and a
     channel unpublished between the phases.
   - On failure this is a HALT, not a finding. Stop phase 3, return to phase 2 step 9, and say
     plainly that no customer can see the product. Do not run the steps below; they will read green
     around it, which is exactly how this got missed the first time.
2. `preview-checks` (verify, browser, operator-invited): on the live product page: the gallery
   filters by colour selection (the alt-text binding, checkable nowhere in the repo), the size
   chart accordion renders and its `#SizeChart` anchor works, the variant picker behaves with any
   collapsed option, and the page has exactly one h1 (nothing in CI checks heading structure).
3. `seo-review` (route:/seo-review): the full read-only audit; adding products is one of its named
   triggers.
   - Completion check: its report exists and any finding is presented to the operator.
4. `converge` (verify): the sku skill's verify and, where run, blank-inventory's verify both
   report convergence (propagation is not atomic).
5. `close`: mark the state file's last step, summarise the whole run (every step, its evidence),
   and note that the state file can be deleted once the operator is satisfied.
