# Phase 3: verify

All read-only. Browser steps follow CLAUDE.md's Browser testing rules (opt-in, password bypass via
the admin Preview link).

## Steps

1. `published-check` (verify, FIRST): confirm `resourcePublicationsV2` lists the same sales
   channels as a sibling product. This runs before the browser and crawl steps because both are
   blind to it in opposite directions: the product page renders fine in the Admin preview while
   unpublished, and `seo-review` crawls the sitemap, which an unpublished product is simply absent
   from, so it reports nothing rather than a finding. `status == ACTIVE` is not evidence here.
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
