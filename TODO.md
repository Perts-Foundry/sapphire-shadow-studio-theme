# TODO

Single backlog for the whole repo. Everything goes here; there are no per-directory TODO files.

**This file holds only work that still needs doing.** When an item lands, delete it from this file;
do not tick it and leave it behind. There is no done section and no checked-off history here. If the
work left behind reasoning worth keeping (a corrected mistake, a cross-layer contract, a decision and
why it went that way), write that into `release-notes.md` as part of the same change, then remove the
item here.

Sections: [Product and storefront](#product-and-storefront) (merchandising / UX ideas).

## Product and storefront

- [ ] **Remove the launch countdown at public launch.** Delete `blocks/launch-countdown.liquid` and
  `assets/launch-countdown.js`, the password-template script block in `snippets/scripts.liquid`, the
  `launch_countdown` entry in `templates/password.json`, and the countdown deviation entry in
  `docs/accessibility-patterns.md`. Decide separately whether the dark password-page treatment stays
  (the `sss-dark-scheme` defaults in `layout/password.liquid`, `sections/password.liquid` and
  `sections/password-footer.liquid`); it only renders while the gate is on. No locale files are
  involved, so there is nothing to unwind there. **The welcome email states the same instant** in
  its date-tile panel (`marketing/emails/welcome.liquid`), so retire the two together: remove or
  repoint the tiles as part of this item, and work the rest of the six-step launch swap in
  `marketing/emails/README.md` at the same time.

- [ ] **Reconcile the Facebook URL across its four homes.** `config/settings_data.json` and
  `sections/footer-group.json` both hold `facebook.com/profile.php?id=61583934266282`; Shopify's
  Brand settings holds the vanity `facebook.com/sapphireshadowstudio`, which resolves, and
  `marketing/emails/*.liquid` use the vanity form. The theme's two copies are the ones to change.
  `settings_data.json` is an Admin-sync surface, so decide whether the edit goes through the sync
  theme or the repo before making it.

- [ ] **Email the list before announcing the launch publicly.** `marketing/emails/welcome.liquid`
  tells every subscriber "you will hear it from us by email before we announce it anywhere else",
  so the launch sequence is: send the list first, then post to Instagram, Facebook and TikTok, then
  take the storefront password off. Getting that order wrong makes a promise already sitting in
  every subscriber's inbox retroactively false, and there is nothing that can correct it. The
  announcement campaign itself does not exist yet; clone `marketing/emails/campaign-shell.liquid`.

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
- [ ] **The About page references a file that does not exist.** `templates/page.about.json` sets
  `team_member_3_image` to `shopify://shop_images/Kitkat-Rory.jpg`, and no file by that name is in
  Files (all 77 enumerated). The block falls back to `placeholder_svg_tag`. Team members 1 and 2 have
  no image set at all, so the team row renders as three placeholder tiles. Either upload the cat photo
  under that exact name, repoint the setting, or drop the images from the block. Admin (file upload)
  plus possibly the template.
