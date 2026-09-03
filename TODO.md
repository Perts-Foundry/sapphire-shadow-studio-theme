# TODO

Single backlog for the whole repo. Everything goes here; there are no per-directory TODO files.

**This file holds only work that still needs doing.** When an item lands, delete it from this file;
do not tick it and leave it behind. There is no done section and no checked-off history here. If the
work left behind reasoning worth keeping (a corrected mistake, a cross-layer contract, a decision and
why it went that way), write that into `release-notes.md` as part of the same change, then remove the
item here.

Sections: [Product and storefront](#product-and-storefront) (merchandising / UX ideas). Add a
`## Deploy and CI` section back when there is deploy or tooling work outstanding; there is none
right now, and an empty heading with a live index entry is the residue this file's rule targets.

## Product and storefront

- [ ] **Fix the low stock alert flow to handle gift cards. Gift card should be excluded.**
- [ ] **Update the huddle crew next and state that the appliqué fabrics are available in the image gallery toward the end for viewing. We want people to understand where to go to lay eyes on that.**
- [ ] **Update the inventory.**
- [ ] **Add nurse practitioner NP to the lead to collection of products for Carol Ann.**
- [ ] **Deploy the Checkly infrastructure PR so there are checks against the store.**
- [ ] **Confirm the judge.me review setup is correct for our store at this point.**
- [ ] **Figure out the blog skill for the store**
- [ ] **Sync the branded notification templates into Admin.** Run
  `/notification-templates sync` with the ids in wave order (the skill never reads this file);
  delete this item when the first full sync lands and `/notification-templates audit` reports all
  46 in sync. Wave 2 (money): `gift_card_confirmation`, `gift_card_notification`,
  `store_credit_issued`, `order_invoice`, `draft_order_invoice`, `order_payment_receipt`,
  `payment_reminder`, `pending_payment_success`, `pending_payment_failure`,
  `failed_payment_processing`, `store_receipt`, `return_created`, `return_approved`,
  `return_declined`, `return_label_notification`, `return_receipt`, `change_requested`,
  `requested_edit_declined`. Wave 3 (everything else): `customer_account_activate`,
  `customer_account_reset`, `customer_account_welcome`,
  `customer_email_address_changed_confirmation`, `customer_add_payment_method`,
  `customer_update_payment_method`, `customer_restore_payment_method`, `contact_buyer`,
  `order_link`, `customer_marketing_confirmation`, `pos_send_cart`, `buy_online`,
  `pos_exchange_v2_receipt`, `company_contact_welcome_email`,
  `company_location_update_payment_method`, `local_out_for_delivery`, `local_delivered`,
  `local_missed_delivery`. The wave-1 order-lifecycle ids are already saved but pre-date the
  version stamp, so the sync pastes them too.

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

- [ ] **Retire the prelaunch welcome email, once the launch send is done.** Two halves, and the
  second is the one that reaches a customer. In Admin, paste `marketing/emails/welcome-postlaunch.liquid`
  over the "Customer signs up" automation's template and set its subject and preview text from the
  metadata table in `marketing/emails/README.md`; **until that happens the automation keeps sending
  the prelaunch email**, date panel and all, to every new subscriber, and nothing in this repo can
  see that it is doing so. Then in the repo, decide whether
  `marketing/emails/welcome-prelaunch-superseded.liquid` still earns its place: it is the only record
  of what existing subscribers were sent, so keeping it is defensible, but it is also a fourth
  self-contained copy of the header, footer, social row and palette, which is the drift cost the
  "Branding is duplicated on purpose" section warns about. Pairs with the countdown item above: the
  countdown block and that file's date panel state the same instant, and both go stale on the same
  day, so retire them together.

- [ ] **Scheduled live-drift detection for the shop policies.** `npm run policies:check` is offline
  and proves only that the repo agrees with itself; nothing automated notices when someone edits a
  policy in Admin. The push-time freshness gate catches it at the one moment it can do damage
  (`scripts/policies/push.mjs` step 4), and the manual cadence is in
  `marketing/policies/README.md`. A scheduled `policies:pull --check` opening a sticky issue is the
  fuller answer, and it was deliberately left out of `validate.yml`: it needs
  `read_legal_policies` credentials, and putting them in a workflow widens the blast radius of the
  whole subsystem to anyone who can trigger one, on a workflow that also runs for Dependabot. If
  this is ever built, it belongs in a separate scheduled workflow with its own minimal secret, not
  in `validate`.

- [ ] **Reconcile the two delay-refund windows.** The shipping policy's "Order Delays and
  Communication" promises a refund "within 7 business days" when a customer cancels a delayed
  order; the refund policy states 10. Pre-existing, not introduced by the 3-5 day change, and
  flagged rather than fixed because picking the right number is an operator decision. Both are now
  in the repo (`marketing/policies/shipping_policy.html`,
  `marketing/policies/refund_policy.html`), so whichever way it goes is one `policies:push` per
  policy.

- [ ] **Read the refund policy's misspellings disclaimer against the new personalisation-pause
  copy.** The refund policy says the studio is "not responsible for misspellings" in
  customer-provided details. The shipping policy now also promises to reach out when a
  personalisation detail is unclear (an ambiguous spelling, a character count that will not fit, a
  thread colour) and to pause production until the customer replies. Those are not contradictory:
  one is about details the customer got wrong, the other about details the studio could not read.
  Worth a read for tone, since they sit one click apart.

- [ ] **Teach `push.mjs` to persist the `shopPolicyUpdate` response, THEN capture one as a fixture.**
  The whole suite runs against a hand-shaped fake client. Three live writes have now been spent
  without a capture, and the reason is not forgetfulness: nothing in `push.mjs` writes the response
  anywhere, and no flag or environment variable dumps it, so "capture it on the next push" is not a
  thing anyone can actually do. Waiting for a fourth push changes nothing. Add the persistence first
  (the backup file it already writes is the obvious home), in its own reviewed PR, since it touches
  the only write path in the repo; then the next push captures itself and `test/helpers.mjs` can be
  reshaped against real bytes. Until then, "the mutation's actual input shape against the live
  schema" stays unproven, though the v3 terms push proves the shape is at least ACCEPTED by the live
  schema.

- [ ] **`real-bodies.test.mjs`'s `parseWindow` silently mis-parses "3 to 5 business days" as
  `[5,5]`,** and its regex should be shared with the one in `templates-cohesion.test.mjs`. The
  offline-by-contract source regexes are also single-quote-only, static-only and non-transitive.

- [ ] **Converge the remaining 14 `GHEOF` heredocs in `validate.yml`.** The four notification and
  policy steps now use the `/dev/urandom` delimiter plus the `sed` neutraliser from the actionlint
  step. Fourteen others still close on the literal `GHEOF`, and several echo repo-file content
  (`theme-check`, `blank-id-guard`), so a file containing a line that is exactly `GHEOF` closes the
  block early; because `exit_code=` is written first, an injected `exit_code=0` would win on a
  last-write-wins parse. Same sweep should decide `if: ${{ !cancelled() }}` job-wide rather than on
  the four-step island it is on now: as it stands, a step timeout skips every later check including
  Gitleaks, which fails closed but is very hard to triage.

- [ ] **Reconcile the anchor contract with `docs/theme-conventions.md`.** That doc recommends
  putting an `id` on an Admin policy heading so the anchor survives rewording, and
  `assets/policy-nav.js` does honour an existing id. But `extractHeadings` never reads attributes,
  so such a heading would be pinned in `marketing/policies/manifest.json` under an id the runtime
  never assigns, and nothing detects it. Either model the attribute or drop the recommendation for
  tracked policies. Related: `uniqueId` collides against the whole document while
  `duplicateHeadingIds` only compares h2s to each other.

- [ ] **Tell `add-product` about the two new template rules.**
  `.claude/skills/add-product/phase-1-repo-pr.md` says to clone an existing
  `templates/product.<suffix>.json`. A seventh product now has to carry the `accordion_row_st001`
  row byte-identically (or be added to `NO_SHIPPING_ROW` with a reason) and must state no
  business-day duration, both enforced by `scripts/policies/test/templates-cohesion.test.mjs`. The
  skill already names the size-chart and Product Details anchor rules for the same reason.

- [ ] **Review the first two `add-product` runs for skill optimisations.** The Shift Fuel Tote run
  (2026-09-02/03, state file `~/.local/state/add-product/shift-fuel-tote.json`, PR #149 for phase 1)
  was the first end-to-end use and the first non-garment. It surfaced enough process defects to be
  worth a deliberate pass over the skill rather than more one-off patches. Read the state file's
  `evidence` strings first: they are a step-by-step record of what was actually verified and how.
  Seed findings from that run, all still worth generalising:
  - **A step existed nowhere and nothing caught it.** The product sat ACTIVE, media-complete and in
    two collections while published to zero sales channels, so it was invisible and absent from the
    sitemap. Fixed by adding `publish` to phase 2 and `published-check` to phase 3. Ask what else
    lives in that class: an Admin field with no repo representation, no CI check, and no crawl
    coverage, where the natural completion signal (`status == ACTIVE`) reads green.
  - **Preflight the scopes phase 2 needs, at its start.** `publishablePublish` needs
    `write_publications`, which the app does not grant, and that surfaced only as a mid-run
    ACCESS_DENIED. The `admin-manual, policy` vs `admin-manual, api-blocked` tags now record which
    steps the API cannot do, but nothing checks the granted scopes up front the way
    `product-images` already does. That one step turns every such surprise into a phase-start fact.
  - **Exit lines are not evidence.** `upload-product-media.mjs` printed `created=4` for a run whose
    first attempt had died with a bare `Fatal: fetch failed`; only a read-back distinguished them.
    Every completion check should name the read-only query that proves it, which most already do.
  - **No retry around live Admin writes.** The uploader has none, and this run hit three transient
    WSL2 IPv6/IPv4 connect failures. It survived because a re-run reported `skip(dupe)`, so the
    write path is idempotent; that property is load-bearing and currently untested and undocumented.
  - **Which checkout to run from is unstated.** The media step only worked from the branch carrying
    the non-garment filename parser; the main checkout rejected all four files.
  - **Approved artefacts were overwritten with no backup.** An approved final image was replaced
    between sessions and recovered only because the operator had shared it to Discord. Consider a
    rule that anything past an approval gate is copied aside before being rewritten.
  Deliverable: proposed edits to `.claude/skills/add-product/*` (and the sub-skills where the defect
  is theirs), presented for review, not applied blind. Delete this item when that pass lands.

- [ ] **Give `site-check` a publication check, so "ACTIVE but invisible" is caught by a machine.**
  `scripts/site-check/lib/admin-checks.mjs`'s `product-status` check is the one that read green on a
  product published to zero sales channels: it tests `status === 'ACTIVE'` and stops there.
  `scripts/site-check/lib/admin-queries.mjs` already selects per-product fields on an authenticated
  query, so adding `resourcePublicationsV2(first: 25) { nodes { isPublished publication { name } } }`
  and a `product-unpublished` ERROR needs no new query and no new scope; the read works today, only
  the write scope is missing. That covers every product forever, including ones added outside
  `add-product` and channels changed months later, which is what the skill's prose cannot do.
  **Do not use `onlineStoreUrl` for this**, the obvious-looking field: it is null on every product
  in this store, published or not, because the storefront is password-protected, so it would fail
  every product until the password comes off and then silently start working. Verified 2026-09-03
  against both `shift-fuel-tote` and the long-live `shift-fuel-crewneck`.

- [ ] **Take the `NP (Nurse Practitioner)` design value live on the three Lead II products.** The
  repo half is done: `scripts/sku/tables.json` carries the `NP` code, `docs/sku-scheme.md` lists it,
  and the pinned cross-product in `scripts/sku/test/derive.test.mjs` is updated. The store half is
  not. The durable reasoning is in `release-notes.md` ("A credential costs one table row"); in order:
  add the option value in Admin on the crewneck, the quarter-zip and the women's vest (42 new
  variants, 18 + 18 + 6, the vest being Black-only), price them at $65 after confirming no active
  price list touches Lead II, set weights rather than inheriting the crewneck's known 0-lb ones, and
  match sibling inventory policy; then `/sku` (audit, plan, dry-run, apply) for the 42 SKUs; then
  `/blank-inventory backfill` (propose, tag, seed). **The backfill is the reason this is not a
  five-minute job**: those 42 variants span 42 distinct blank groups, the inventory-sync Flow's
  burst limit is roughly four groups per batch, so it takes about eleven batched runs with a
  convergence check between each, and the low-stock alert Flow is worth pausing first. A partial run
  is expected and safe: `blank-inventory audit --stale` is both the verification and the
  resume-detection step. Finish with `sku audit` clean and every group converged. New product photos
  are optional (the gallery filters media by colour, not design) and no `/seo-review` run is needed,
  since no URL changes. Delete this item when that lands.
