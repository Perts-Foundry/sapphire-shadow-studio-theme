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

**Pre-launch product and template review (2026-08-13).** Findings from a correctness / completeness
/ consistency pass over all seven product templates and the other 15 templates, cross-checked against
read-only Admin reads (products, variants, media, collections, pages, files, delivery profiles,
menus) through the `scripts/blank-inventory/lib/admin.mjs` token client. Nothing was changed. (The
null variant SKUs, the empty `/blogs/news` and the per-colour hero attach were all on that list; all
three are resolved, see `release-notes.md`.) What the pass verified as clean is recorded in
`release-notes.md`, not here, so it does not get re-audited. The 2026-08-14 backlog triage closed out
several of the pass's other findings.

- [ ] **[LAUNCH BLOCKER] All 431 variants weigh 0 lb while Expedited is weight-tiered.** The live rate
  table on the General profile prices Expedited at $20 (0 to 2.9 lb), $40 (3 to 5.9), $60 (6 to 8.9),
  and $80 (9+).
  Every variant on the six products audited on 2026-08-13 reports `0 POUNDS` (the tote, added later, carries a real weight), so every order of any size buys the $20 tier
  and the tiering above it is unreachable. Economy is priced on the shippable merchandise subtotal, not
  weight, so it is unaffected. This is the one finding that loses money per order rather than looking wrong. Fix is
  per-variant (or per-blank) weights in Admin; check the value against the blank's shipped weight, not
  the garment's fabric weight. Admin (variant weights). First recorded in the 2026-08-02 audit.

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

- [ ] **Close the remaining test gaps in `scripts/policies/`.** A mutation-test pass over the
  subsystem (93 seeded defects, 68 caught) found the survivors cluster in three places, none of
  which is a live bug today:
  - `lib/backups.mjs` has no test file. `FILE_MODE 0o600 -> 0o644` survives because the assertion
    compares the observed mode against the imported constant, which holds for any value; use a
    literal. `displayPath`, `resolveBackupDir`'s `POLICIES_BACKUP_DIR` and `path.resolve`, and the
    timestamp in `backupFileName` are all uncovered.
  - `push.mjs` step 8: a re-read that THROWS (a transient 5xx seconds after the write) is the one
    post-mutation failure path that does not print the `--restore` command, and no test covers a
    read that throws anywhere. Retry on throw, and add the restore command to that message.
  - `main()` in `push.mjs` is untested end to end, so `PUSH_SCOPES` losing `write_legal_policies`
    survives and the interactive/review gates are never tied to a run.
  Also: `real-bodies.test.mjs`'s `parseWindow` silently mis-parses "3 to 5 business days" as
  `[5,5]`, and its regex should be shared with the one in `templates-cohesion.test.mjs`; the
  offline-by-contract source regexes are single-quote-only, static-only and non-transitive.

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
