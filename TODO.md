# TODO

Single backlog for the whole repo. Everything goes here; there are no per-directory TODO files.

**This file holds only work that still needs doing.** When an item lands, delete it from this file;
do not tick it and leave it behind. There is no done section and no checked-off history here. If the
work left behind reasoning worth keeping (a corrected mistake, a cross-layer contract, a decision and
why it went that way), write that into `release-notes.md` as part of the same change, then remove the
item here.

Sections: [Product and storefront](#product-and-storefront) (merchandising / UX ideas),
[Deploy and CI](#deploy-and-ci) (workflow and tooling reliability).

## Product and storefront

- [ ] **Remove the launch countdown at public launch.** Delete `blocks/launch-countdown.liquid` and
  `assets/launch-countdown.js`, the password-template script block in `snippets/scripts.liquid`, the
  `launch_countdown` entry in `templates/password.json`, and the countdown deviation entry in
  `docs/accessibility-patterns.md`. Also decide on the pre-launch social links added alongside it:
  the `follow_heading` and `follow_links` entries in `templates/password.json` and the
  `.password-follow__*` rules in `sections/password.liquid`. Unlike the countdown these may be worth
  keeping once the gate is off, since the block is just a wrapper around the shared
  `snippets/social-links.liquid`; the decision is whether the password page still earns them when the
  footer and homepage are reachable. Decide separately whether the dark password-page treatment stays
  (the `sss-dark-scheme` defaults in `layout/password.liquid`, `sections/password.liquid` and
  `sections/password-footer.liquid`); it only renders while the gate is on. No locale files are
  involved, so there is nothing to unwind there.
- [ ] Bring `templates/404.json`'s product card onto the site-standard card shape. Its
  `static-product-card` is the only remaining copy of the old format (gap 4, inherit colour scheme,
  radius 0, gallery `adapt`, title `rte`); the cart card was moved onto the standard shape used by
  `templates/index.json`, `templates/collection.json` and `templates/search.json`, and 404 only had
  its `show_shipping_info` made explicit, not its styling aligned.
- [ ] Add a free shipping visual to the cart for easier understanding on where the customer is at in getting the free shipping tier. See if this is available as an existing setting today.
- [ ] Fix contact footer link vs contact nav link, also contact us button is darkened, text isn't white?

**Pre-launch product and template review (2026-08-13).** Findings from a correctness / completeness
/ consistency pass over all six product templates and the other 15 templates, cross-checked against
read-only Admin reads (products, variants, media, collections, pages, files, delivery profiles,
menus) through the `scripts/blank-inventory/lib/admin.mjs` token client. Nothing was changed. (The
null variant SKUs, the empty `/blogs/news` and the per-colour hero attach were all on that list; all
three are resolved, see `release-notes.md`.) What the pass verified as clean is recorded in
`release-notes.md`, not here, so it does not get re-audited. The 2026-08-14 backlog triage closed out
several of the pass's other findings.

- [ ] **[LAUNCH BLOCKER] All 431 variants weigh 0 lb while Expedited is weight-tiered.** The live rate
  table on the General profile prices Expedited at $20 (0 to 2.9 lb), $40 (3 to 5.9), $60 (6 to 8.9),
  and $80 (9+).
  Every variant on all six products reports `0 POUNDS`, so every order of any size buys the $20 tier
  and the tiering above it is unreachable. Economy is priced on cart total, not weight, so it is
  unaffected. This is the one finding that loses money per order rather than looking wrong. Fix is
  per-variant (or per-blank) weights in Admin; check the value against the blank's shipped weight, not
  the garment's fabric weight. Admin (variant weights). First recorded in the 2026-08-02 audit.

## Deploy and CI

- [ ] **Retry 5xx on the smoke test's content probes, the way the auth step already does.** In
  `.github/actions/shopify-theme-push/smoke.mjs`, `authenticateStorefront` retries on `429` **or any
  `>= 500`**, with a comment saying the storefront password endpoint "intermittently 503s under bot
  management". The content probes retry on `429` only (the `status === 429` guards in
  `fetchObservation` and `fetchWithBody`), so the identical transient 503 that the auth step is
  written to absorb instead becomes a HARD-FAIL and blocks the deploy. The asymmetry runs one step
  further: a `429` that exhausts its retries still only SOFT-WARNs (`classify`, asserted twice in
  `smoke.test.mjs`), while a single 5xx neither retries nor soft-warns. Observed on PR #137: the live
  push succeeded, then `/policies/refund-policy`, `/products/lead-ii-crewneck` and
  `/products/lead-ii-quarter-zip` each returned `503` with `theme=-` while
  `/products/lead-ii-vest-womens` (near-identical template) and six other paths passed; all eleven
  paths were healthy again minutes later. Three PRs' preview theme pushes were hitting the store in
  the same minute, which is the likely aggravator. The failure mode is expensive: the theme is
  already live by the time the smoke runs, so a false HARD-FAIL leaves the live theme serving the new
  SHA with the PR unmerged and `main` behind, recoverable only by a manual re-`deploy`. Reuse the
  existing `backoff` array rather than inventing a second policy, keep a 5xx that survives every
  retry a HARD-FAIL (a genuinely broken page must still block), and extend `smoke.test.mjs`, whose
  `runSmoke PUBLIC: 429-then-200 retry` case is the shape to copy for a 503. Consider whether a
  surviving 5xx on a path that passed earlier in the same run deserves a distinct reason string, so a
  real outage reads differently from a broken template in the deploy report.
