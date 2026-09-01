# Phase 3: verify

All read-only. Browser steps follow CLAUDE.md's Browser testing rules (opt-in, password bypass via
the admin Preview link).

## Steps

1. `preview-checks` (verify, browser, operator-invited): on the live product page: the gallery
   filters by colour selection (the alt-text binding, checkable nowhere in the repo), the size
   chart accordion renders and its `#SizeChart` anchor works, the variant picker behaves with any
   collapsed option, and the page has exactly one h1 (nothing in CI checks heading structure).
2. `seo-review` (route:/seo-review): the full read-only audit; adding products is one of its named
   triggers.
   - Completion check: its report exists and any finding is presented to the operator.
3. `converge` (verify): the sku skill's verify and, where run, blank-inventory's verify both
   report convergence (propagation is not atomic).
4. `close` : mark the state file's last step, summarise the whole run (every step, its evidence),
   and note that the state file can be deleted once the operator is satisfied.
