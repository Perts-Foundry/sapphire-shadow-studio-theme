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

- [ ] **Paste the branded notification templates in waves.** Procedure and per-template caveats in
  `marketing/notifications/README.md`. Delete an id from this list once it is pasted and saved in
  Admin, and delete the whole item when the list is empty.
  - Wave 1 (order lifecycle): `order_confirmation`, `shipping_confirmation`, `shipping_update`,
    `shipment_out_for_delivery`, `shipment_delivered`, `refund_notification`, `order_cancelled`,
    `order_edited`, `ready_for_pickup`, `pickup_receipt`.
  - Wave 2 (money): gift cards (`gift_card_confirmation`, `gift_card_notification`), store credit
    (`store_credit_issued`), invoices (`order_invoice`, `draft_order_invoice`), payments
    (`order_payment_receipt`, `payment_reminder`, `pending_payment_success`,
    `pending_payment_failure`, `failed_payment_processing`, `store_receipt`), returns
    (`return_created`, `return_approved`, `return_declined`, `return_label_notification`,
    `return_receipt`, `change_requested`, `requested_edit_declined`).
  - Wave 3 (everything else): accounts (`customer_account_activate`, `customer_account_reset`,
    `customer_account_welcome`, `customer_email_address_changed_confirmation`,
    `customer_add_payment_method`, `customer_update_payment_method`,
    `customer_restore_payment_method`), contact (`contact_buyer`, `order_link`), marketing
    confirmation (`customer_marketing_confirmation`), POS (`pos_send_cart`, `buy_online`,
    `pos_exchange_v2_receipt`), B2B (`company_contact_welcome_email`,
    `company_location_update_payment_method`), local delivery (`local_out_for_delivery`,
    `local_delivered`, `local_missed_delivery`).

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
  and the tiering above it is unreachable. Economy is priced on the shippable merchandise subtotal, not
  weight, so it is unaffected. This is the one finding that loses money per order rather than looking wrong. Fix is
  per-variant (or per-blank) weights in Admin; check the value against the blank's shipped weight, not
  the garment's fabric weight. Admin (variant weights). First recorded in the 2026-08-02 audit.
