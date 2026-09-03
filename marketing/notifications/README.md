# Shopify notification templates

The 46 customer notification templates (order confirmation, shipping updates, account emails,
gift cards, returns, and the rest), restyled to the look of the welcome email in
`marketing/emails/`. **Nothing here is theme code.** These files are never pushed, never deployed,
and never read by the storefront.

Shopify exposes no API for notification templates. They are read and written in one place only:
Admin > Settings > Notifications > Customer notifications > the template > **Edit code**. So the
model is the same as `marketing/emails/README.md`: **the repo file is the source of truth, and
Admin holds a pasted copy.** Nothing reconciles the two; if a template is tweaked inside the editor,
copy the change back into `lib/` and regenerate in the same sitting.

The accepted cost: a customised template stops receiving Shopify's automatic stock-template updates.
When Shopify ships a fix to, say, the shipping confirmation, a store on the stock template gets it
silently and this store does not. The per-template escape hatch is the editor's **Revert to
default** button, which restores stock for that one template; the drift procedure below is how
the repo catches up afterwards.

## Layout

| Path | What it is |
|---|---|
| `manifest.json` | The list of template ids. Each entry records the subject line, the sha256 and the length of the stock snapshot (UTF-16 code units, as `String.length` reports it, so `wc -c` disagrees on any file with non-ASCII text), the branded `version` and `brandedSha256` (see Versioning), and, where needed, an `override`. Ids come from here, never from a directory glob. |
| `lib/brand-style.css` | The `<style>` rules that replace the stock accent-colour block. The only file that carries the palette. |
| `lib/footer-social.html` | The social icon row and shop-name line inserted at the top of the footer. |
| `lib/header.html` | The stock logo-only header table, inserted into the three templates that ship without one (the `header` override below). |
| `stock/<id>.liquid` | Verbatim snapshot of what the Admin editor held when it was recorded. Never edited by hand. |
| `<id>.liquid` | The generated, ready-to-paste branded template. Never edited by hand. |

**A generated file is stock plus exactly three mechanical edits**, and nothing else:

1. The stock accent-colour `<style>` block (the three `email_accent_color` rules) is replaced by
   `lib/brand-style.css`.
2. `lib/footer-social.html` is inserted immediately before the footer's
   `<p class="disclaimer__subtext">`, followed on its own line by the footer version stamp, an
   HTML comment `<!-- sss-notification <id> v<version> -->`.
3. A one-line `{%- comment -%}` naming the id, the version and the generator is prepended.

Every other byte is identical to the stock snapshot, so `diff stock/<id>.liquid <id>.liquid` shows
only those three hunks, and an upstream change to a stock template stays reviewable as a plain diff.
The one exception is the `header` override (three templates), which adds two more mechanical
edits: `lib/header.html` is inserted before `<table class="row content">`, and every stock
`{% if shop.email_logo_url %}` ... `{% endif %}` logo block in the body is removed, so the logo
appears once, in the band.

To change anything in the branded output, edit `lib/` or `manifest.json` and run
`npm run notifications:generate`. `npm run notifications:check` regenerates in memory and fails if
any committed file differs from what the generator would produce; that is what CI runs, alongside
`npm run notifications:test` for the generator's own suite. The generator is fail-closed: it refuses
when an anchor is not found exactly once, when the style block differs from the known stock block,
when a stock snapshot's sha256 or length disagrees with the manifest, and on any carriage return or
byte-order mark. A refusal writes nothing.

Tooling under `scripts/notifications/`: `brand.mjs` (generate, `--check`, `--status`),
`record-stock.mjs` (record a stock snapshot), `dump.mjs` (the console-dump and hash contract the
browser probes use; `--hash <file>` prints a file's length and FNV), `verify-render.mjs` (checks a
rendered preview against the brand; input is a rendered HTML file, `--dump <console dump...>`,
or `--preview-response <file>`, the editor's EmailTemplateGeneratePreview response and the
reliable way to get a render, since the Preview dialog's iframe is an `about:srcdoc` frame no
script can be injected into; `--manifest` and `--css` override the checkout's for a rollback), `html-walk.mjs` (its
parser), `classify.mjs` (applies the skill's match table to a set of Admin readings and prints the
sync plan table), `before-doc.mjs` (materialises the document Admin held before a paste, from the
stock snapshot or from the editor's `EmailTemplate` response, refused unless it hashes to the
expected numbers), `clipboard.mjs` (copies a file for the paste step), `state.mjs` (the skill's per-store
state file) and `browser/` (the probe scripts the skill injects into the Admin editor).

## Versioning

Every manifest entry carries `version` (an integer from 1) and `brandedSha256`, the sha256 of the
generated output *before* the two stamps are added. **The generator seeds and bumps; never hand-seed
or hand-bump.** On every generate, per entry: both fields absent, seed `version: 1` and record the
hash; hash absent with a valid version, keep the version and record the hash; version absent with a
hash present, seed `version: 1`; both present and the hash differs, `version + 1`; both present and
equal, no change; a version that is not an integer >= 1 is a refusal and nothing is written. The
hash is of the output, not the inputs, so a `reason` edit or a byte-identical re-record does not
bump, while any change to `lib/` bumps every template it reaches (a stylesheet change bumps all 46
by design). `generate` prints one line per seed or bump (`order_confirmation: v3 -> v4`).

The version lives in two stamps, both written by the generator and both parsed with the one
`STAMP_RE` in `brand.mjs`: the first-line Liquid comment (`sss-notification <id> v<n>. ...`), which
the Admin editor shows and the render drops, and the HTML comment after the social row, which the
render keeps, so a received email's source says which version produced it.
`node scripts/notifications/brand.mjs --status` prints the committed version and hash prefix per id.

`npm run notifications:check` refuses a committed file that differs from the output stamped with the
committed version, a core hash that differs from `brandedSha256` (`bytes changed but version not
bumped: run notifications:generate`), and a missing or invalid version. **A green check proves the
repo is self-consistent, not that Admin is in sync**; only the skill's `audit` proves that, by
reading each editor's first line and hashing its document. A hand-bumped version followed by a
regenerate is indistinguishable from a real bump and is not a defect; a version edited without
regenerating is caught as a file mismatch. A `git revert` moves a version backwards by design, which
is why the skill's `sync` decides what to paste by bytes (length plus FNV-1a of the editor document
against the repo file) and treats the version as information. `record-stock.mjs` carries `version`
and `brandedSha256` across a re-record on purpose, so the next generate bumps; do not "fix" that by
dropping them.

`verify-render.mjs` checks a rendered preview (or a test send's source) for the palette on the right
elements, the social row, the footer nesting, the empty-subtotal bug, the mobile media block and the
version stamp: 21 named checks (`version`, `manifest-version`, `header-navy`, `footer-navy`,
`page-colour`, `content-white`, `buttons`, `shop-app-button`, `footer-disclaimer`,
`body-disclaimer`, `headings`, `body-paragraphs`, `social-row`, `footer-inside-body`,
`subtotal-lines`, `no-accent`, `no-liquid-error`, `no-translation-missing`, `mobile-css`,
`header-row`, `no-logosize`), one PASS/FAIL line each; the list is `CHECKS` in the file. It proves the sample-data render only: Liquid branches the preview does not take
(discounts, gift cards, partial fulfilment, refunds) are not exercised.

## Skill

`.claude/skills/notification-templates/` automates the whole lifecycle from a Claude Code session:
`change` (edit, regenerate, render-check, PR), `sync` (paste every template that differs by bytes,
byte-verified before Save and after reload, then render-checked on the stored version, with the
previous document pasted back if that render fails), `audit` (which version each Admin template holds, and
whether it renders), `record` (the drift procedure below) and `rollback` (re-paste an earlier
version from git). It is operator-invoked, drives the Admin editor through the chrome-devtools MCP,
and keeps a per-store state file outside the checkout: a hint for what Admin holds, and the record
of a `sync` in flight, so an interrupted run resumes with `sync --resume` rather than a
hand-written handoff. A single published locale is
assumed; re-check `shopLocales` in Admin if that changes, since notification templates are per
language.

## Paste procedure

The skill's `sync` mode does the same paste with byte verification, saving before it previews
(see below); this is the manual form.

1. Admin > **Settings** > **Notifications** > **Customer notifications** > pick the template >
   **Edit code**. The editor paints Shopify's **stock** body first and swaps the saved override in
   a moment later, so give it a second before judging what is in there; the first thing on screen
   is not necessarily what is stored.
2. In the editor, select all and paste the whole repo file `<id>.liquid` over it.
3. Use the editor's preview to check the render before saving. For the six templates with a
   body-side disclaimer paragraph (see the override list below), preview with a fulfillment that
   carries a tracking number, since the pilot template could not exercise that path: the
   tracking line must read as body text, not footer text.
4. **Save.**

Three templates cannot be previewed before saving: `ready_for_pickup`, `pickup_receipt` and
`change_requested`. Their editor preview renders the stored template and ignores the unsaved editor
contents (verified by pasting a different template's body and getting the same stock render), while
every other template tried so far previews the paste; the list is what has been observed, not a
closed set. For those, save, reload, then preview; if the stored render is wrong, paste back what
the editor held before and save (`stock/<id>.liquid` if that is what it was), or use the editor's
**Revert to default**. The skill's `sync` saves first for every template and restores the previous
document on a failed render, so it does not depend on knowing the list.

Subject lines stay as they are in Admin; the manifest records them for reference and the
generator never touches them. After the paste, the **Accent colour** setting under Settings >
Notifications has no effect on that template: the branded file carries literal hexes and no
`email_accent_color` reference at all.

Shopify's inliner applies the template's own `<style>` rules by class at send time, which is the
whole reason this approach works: the body markup stays stock and the restyle rides on the
stylesheet. The pilot (`order_confirmation`) confirmed in the editor preview that every
`brand-style.css` selector was inlined and the Shop-app button text stayed stock.

## Overrides

Most templates need no manifest entry beyond the subject and the stock hash, because the two
anchors (the stock style block and the footer's disclaimer paragraph) occur exactly once. Where they
do not, the manifest entry carries an `override` object with a `reason` and one of:

- **`footerAnchor`**: the exact text the generator should treat as the footer disclaimer paragraph,
  used when `<p class="disclaimer__subtext">` occurs more than once. Six templates carry it:
  `local_delivered`, `order_link`, `shipment_delivered`, `shipment_out_for_delivery`,
  `shipping_confirmation` and `shipping_update`. Each has a second disclaimer paragraph in the
  body (the tracking-number line, or the email-safety message in `order_link`), so the anchor names
  the footer one by its opening text. The generator still requires the override to resolve inside
  `<table class="row footer">`, so an anchor that names the body paragraph is a refusal, not a
  misplaced insertion. Because of that body-side paragraph, every rule in
  `lib/brand-style.css` that names `disclaimer__subtext` (or an inserted `ssb-` class) is scoped
  under `.footer`; the light-on-navy footer colours would be unreadable on the white body. The test
  suite refuses an unscoped rule.
- **`styleAnchor`**: the whole `<style>` block to replace, used when the stock block is not the
  three-rule one the generator knows. One template carries it: `pos_send_cart`, whose block has an
  extra `.top-border` hairline rule. The whole block is replaced and the hairline is dropped on
  purpose; the branded card layout supplies its own separation.

- **`header`** (`true`): the stock template has no header table, so the generator inserts
  `lib/header.html` immediately before `<table class="row content">` (which must occur exactly
  once, first on its line, between the style block and the footer) and removes every stock logo
  block from the body (a `{% if shop.email_logo_url %}` ... `{% endif %}` span whose only content
  is the logo image; a block holding any other Liquid tag is a refusal). Three templates carry it:
  `gift_card_confirmation`, `gift_card_notification` (two logo blocks, one per branch) and
  `store_credit_issued`. Without it the logo sat inside the white card and the brand band could
  not be applied by stylesheet alone. A stock template that already has a header table refuses
  the override.

- **`replace`** (a list of `{ "from", "to" }` pairs): exact substrings swapped for exact
  substrings, each `from` found exactly once outside a Liquid comment, refused if it overlaps any
  other edit. For a stock markup bug the template must carry as long as Shopify ships it. Two
  templates carry it: `order_invoice` and `pending_payment_failure`, whose "Amount to pay" block
  puts a table directly inside a table row with no cell in the branch where nothing has been paid
  yet; parsers recover by closing the enclosing tables early and leave an empty table whose top
  border draws a hairline under the card. The two replacements give that branch the spacer and
  cell the other branch has. Because the manifest carries the exact stock text, an upstream
  change to that block makes the generator refuse rather than patch the wrong thing.

A fifth field, `skip`, with a reason string, would leave a template stock: no branded file is
generated and the check refuses if one exists. No template is skipped today.

One layout note that no override records, because the generator handles it correctly and it is
stock behaviour: `customer_email_address_changed_confirmation` is the only template with a second
`<style>` block, Shopify-authored, after `</head>`. It is left in place (it references no accent
colour), and because it comes after `brand-style.css` its bare `a` rule wins over the brand link
colour in the body. Header and footer are unaffected. Accept it.

## Drift: catching up with a Shopify change to a stock template

There is no feed of stock-template changes and no API to read one. The only way to see the current
stock is to revert a template in Admin, which means a short window during which that template sends
stock, unbranded:

1. In the template's editor, **Revert to default**. Note the subject line while you are there.
2. Select all in the editor and copy the stock text into a file.
3. Record it: `node scripts/notifications/record-stock.mjs --id <id> --subject "<subject>" --file <path>`.
   The script rewrites `stock/<id>.liquid` and the manifest entry's hash and length. It refuses a
   carriage return, a byte-order mark, a replacement character or a lone surrogate, because the
   snapshot is what every other check trusts. If the content changed, it also drops any `override`
   or `skip` on that entry (they were written against the old snapshot) and says so; re-add one only
   after the next step shows it is still needed.
4. `git diff stock/<id>.liquid` to review what Shopify changed. If the change moved an anchor, the
   next step refuses and the manifest entry needs an override.
5. `npm run notifications:generate`, review `git diff <id>.liquid`, and paste the regenerated
   branded file back into the editor. Save.

`record-stock.mjs` also accepts `--envelope <path>` (a JSON file carrying the id and text) and
`--dump <path...>` (console output from `scripts/notifications/browser/editor-dump.js`, reassembled
by `dump.mjs` and checked against its own length and hash), for recording without the
copy-into-a-file step. The skill's `record` mode is this procedure with its gates.

## Templates

Subjects are copied from the manifest, which copies them from Admin. "override" in the notes
column means the manifest entry carries one (see above).

| Id | Subject | Notes |
|---|---|---|
| `buy_online` | Buy online from {{ shop_name }} when you're ready! | none |
| `change_requested` | Change requested / Cancellation requested / Return requested for order {{ order.name }} (branches on `requested_edit` and `return`) | none |
| `company_contact_welcome_email` | Welcome to B2B ordering with {{shop.name}} | none |
| `company_location_update_payment_method` | Update your payment method for {{ shop.name }}'s {{ location_name }} location | none |
| `contact_buyer` | Message from {{ shop.name }} | none |
| `customer_account_activate` | Customer account activation | none |
| `customer_account_reset` | Customer account password reset | none |
| `customer_account_welcome` | Customer account confirmation | none |
| `customer_add_payment_method` | Add a payment method for {{ shop.name }} | none |
| `customer_email_address_changed_confirmation` | Your email address has been changed | none; second stock `<style>` block, see above |
| `customer_marketing_confirmation` | Confirm you want to receive email marketing | none |
| `customer_restore_payment_method` | Verify your payment information for {{ shop.name }} | none |
| `customer_update_payment_method` | Update your payment method for {{ shop.name }} | none |
| `draft_order_invoice` | Invoice {{name}} | none |
| `failed_payment_processing` | [{{shop.name}}] Payment couldn't be processed | none |
| `gift_card_confirmation` | {{ shop.name }} {{ gift_card.initial_value }} gift card, plus the recipient when there is one | override: `header` |
| `gift_card_notification` | {{ shop.name }} {{ gift_card.initial_value }} gift card, plus the sender when there is one | override: `header` |
| `local_delivered` | Order {{ name }} has been delivered | override: `footerAnchor` |
| `local_missed_delivery` | Delivery from order {{ name }} has been missed | none |
| `local_out_for_delivery` | Order {{ name }} is out for delivery | none |
| `order_cancelled` | Order {{ name }} has been canceled | none |
| `order_confirmation` | Order {{name}} confirmed | none; the pilot |
| `order_edited` | Order {{name}} updated | none |
| `order_invoice` | Invoice {{name}} | override: `replace` |
| `order_link` | Link to order {{ order_name }} | override: `footerAnchor` |
| `order_payment_receipt` | [{{ shop.name }}] Payment receipt for order {{ name }} | none |
| `payment_reminder` | Payment reminder for order {{ name }} | none |
| `pending_payment_failure` | [{{shop.name}}] Payment couldn't be processed for order {{ name }} | override: `replace` |
| `pending_payment_success` | [{{ shop.name }}] Payment for {{ name }} has been received | none |
| `pickup_receipt` | Your order has been picked up ({{ name }}) | none |
| `pos_exchange_v2_receipt` | Exchange receipt from {{ shop.name }} | none |
| `pos_send_cart` | Buy online from {{ shop_name }} when you're ready! | override: `styleAnchor` |
| `ready_for_pickup` | A package from order {{ name }} is ready for pickup | none |
| `refund_notification` | Refund notification | none |
| `requested_edit_declined` | Cancellation request declined for order {{ order.name }} | none |
| `return_approved` | Return approved for order {{ order.name }} | none |
| `return_created` | Complete your return for Order {{ order.name }} | none |
| `return_declined` | Return request declined for order {{ order.name }} | none |
| `return_label_notification` | Return label for order {{ order.name }} | none |
| `return_receipt` | Exchange receipt / Return receipt from {{ shop.name }} (branches on exchange line items) | none |
| `shipment_delivered` | A shipment from order {{ name }} has been delivered | override: `footerAnchor` |
| `shipment_out_for_delivery` | A shipment from order {{ name }} is out for delivery | override: `footerAnchor` |
| `shipping_confirmation` | A shipment from order {{ name }} is on the way | override: `footerAnchor` |
| `shipping_update` | Shipping update for order {{ name }} | override: `footerAnchor` |
| `store_credit_issued` | {{ shop.name }} {{ issued_store_credit.amount }} store credit | override: `header` |
| `store_receipt` | Receipt for order {{name}} | none |

Three subjects are abbreviated above (`change_requested`, `gift_card_*`, `return_receipt`) because
the full Liquid does not fit a table cell; `manifest.json` holds the exact text.

## Palette

The hex set in `lib/brand-style.css` is the one documented under "Branding is duplicated on
purpose" in `marketing/emails/README.md`: navy `#071e3f`, tile face `#0c2c56`, eyebrow `#3aa0e6`,
footer text `#c9d8ea`, button `#0071C2`, page surround `#e1edf5`. That makes four places the
palette lives: the two campaign files under `marketing/emails/`, that README's table, and
`lib/brand-style.css`. A palette change means editing all four and regenerating here.

The social icon URLs in `lib/footer-social.html` are the same three CDN assets listed in that
README's hosted-assets table, served from Shopify Files and not behind the storefront password.
Re-check that they return 200 to an anonymous request after changing one.

## Sweeps that hold

- **No U+2014 anywhere under `marketing/notifications/`.** The stock snapshots contained none, so
  the repo-wide rule applies here with no carve-out.
- **No `{{ open_tracking_block }}` and no `{{ unsubscribe_url }}`.** These are transactional
  notifications, not marketing sends; neither variable exists for them and neither belongs.
- **The `stock/` snapshots are what the editor held when recorded, not certified stock.** Every one
  showed the editor's "Revert changes" control disabled at the time; treat that as the evidence,
  not as a guarantee. That control is not always present (a later run found a clean editor with
  neither Save nor Revert), so the working stock signal is bytes: an editor whose document hashes
  like `stock/<id>.liquid` holds the recorded stock.
- `theme-check` ignores `marketing/**`, and `validate_theme_codeblocks` is syntax-only here:
  notification objects (`fulfillment`, `order_name`, `customer.reset_password_url` and the rest) are
  undefined to a theme validator, so ignore its undefined-object findings. The editor's preview is
  the real check.
