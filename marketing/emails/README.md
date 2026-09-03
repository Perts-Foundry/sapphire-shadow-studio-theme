# Shopify Email templates

Custom-coded Liquid/HTML emails for Shopify Email (Shopify Messaging) campaigns and automations.
**Nothing here is theme code.** Shopify Email has no API and no theme surface, so these files are
never pushed, never deployed, and never read by the storefront. They exist so campaign markup can be
written, reviewed, and versioned like everything else, then pasted by hand into the Shopify Email
custom-code editor.

| File | Purpose |
|---|---|
| `campaign-shell.liquid` | Reusable base. Clone it to start a new campaign. Its fill-in spots are ALL-CAPS placeholder text. |
| `welcome-postlaunch.liquid` | Welcome automation for an open store. This is the one the "Customer signs up" automation should be running. Ready to paste as-is. |
| `launch-announcement.liquid` | One-time launch campaign to the whole list. Ready to paste as-is. It discharges the promise the prelaunch welcome made; see the launch swap below. |
| `welcome-prelaunch-superseded.liquid` | **Superseded, retained for history, do not paste.** The prelaunch welcome, written for a store behind the password gate. Replaced by `welcome-postlaunch.liquid`. |

The filename is the warning, and that is deliberate. These files are copy-pasted into a web editor by
hand, so a note in this table only helps if someone reads it at the moment of pasting, and nothing in
the workflow forces that. `welcome-prelaunch-superseded.liquid` carries the warning in the one string
that is on screen while the paste is happening.

## The templates carry no comments. This file carries the documentation.

**Shopify Email's custom-code editor rejects Liquid comment tags outright.** One anywhere in the
document turns the whole template invalid: the editor shows `Syntax not valid on line N` and the
preview pane goes blank. The line number tracks the comment, so moving it just moves the error.
This was confirmed in the live editor on 2026-08-19, against the real files, both with the
whitespace-stripping form and the plain one.

HTML comments are the only kind that work, and that is exactly why the templates have none:
**anything in an HTML comment ships inside the sent email's source**, where any recipient can read
it. Notes, rationale, launch checklists, and TODO markers all belong in this file instead. So does
anything that must not travel with the email, a discount code most of all.

One exception, and it is markup rather than prose: the Outlook conditional comments around each
button (`<!--[if mso]> ... <![endif]-->` and `<!--[if !mso]><!-- --> ... <!--<![endif]-->`). Those
are how the bulletproof button works. Leave them.

## Campaign metadata

Subject line and preview text are fields in the Shopify Email editor, not markup, so they live here
rather than in the file. Read the row, type the two fields, paste the template.

| Template | Subject | Preview text | Automation / segment | Last verified |
|---|---|---|---|---|
| `welcome-postlaunch.liquid` | Welcome to Sapphire Shadow Studio | Made to order, stitched in-house, by the two of us. | "Customer signs up" welcome automation, all new email subscribers | not yet |
| `launch-announcement.liquid` | The store is open | Everything we have been stitching is live now. | One-time campaign, the whole email list | not yet |
| `welcome-prelaunch-superseded.liquid` | Welcome to Sapphire Shadow Studio! | The studio opens September 3 at 9:00 AM Eastern. | Historical. Was the "Customer signs up" automation while the storefront was password-protected | 2026-08-21, test sends, first campaign, and the live automation |
| `campaign-shell.liquid` | n/a, clone it | n/a, clone it | n/a | n/a |

The two new subjects were checked against the usual filters before being written down: no capitals,
no exclamation point, no "free", no percentage or currency symbol. "Welcome to Sapphire Shadow
Studio" is 33 characters, which is borderline for a narrow Gmail-app list view and fits most
everywhere else; "The store is open" is 17. The preview lines are 51 and 46 characters, both inside
what an inbox shows.

**The announcement's headline carries an exclamation point and its subject line does not**, and that
split is deliberate rather than an oversight. In the body it is the one place the voice allows one.
In the subject it is a mild bulk-sender signal, and the subject is the half a spam filter scores, so
the inbox sees "The store is open" and the reader sees "The store is open!". Do not "fix" the
mismatch by adding one to the table.

Preview text lives in the editor field and in this table, and **nowhere in the template**. Both
files used to carry a hidden preheader `<div>` as a second home for it. A real test send on
2026-08-21 showed why that was wrong: **Shopify injects its own preheader `div` from the field**,
followed by its own spacer run, so the template's copy made the text appear twice in the delivered
source, with the inbox preview line at risk of reading it twice over. The template's copy is gone;
the field is the only source. Leave the field blank and the preview falls back to the first visible
text, which is the headline, and that is an acceptable failure.

## The repo file is the source of truth

Whatever is in Shopify Email's editor is a copy. If you tweak a template inside the editor while
testing, **copy the change back into the repo file in the same sitting**, or the two silently
diverge. This is the same drift pattern as the social links and shipping copy documented in
`docs/theme-settings-contracts.md`, and nothing reconciles it: no test, no CI check, no script can see inside the
Shopify Email editor.

Reversal is a plain `git revert` plus a re-paste. Nothing here deploys automatically.

## Paste procedure

The Shopify Email custom-code editor is **desktop only**; it cannot be opened on a phone or tablet.

1. Shopify Admin > **Marketing** > **Create campaign** (or **Automations** for the welcome flow) >
   **Shopify Email**.
2. Pick the option for a custom-coded / custom Liquid email rather than a drag-and-drop template.
3. Paste the **whole file**. `welcome-postlaunch.liquid` and `launch-announcement.liquid` need
   nothing else: they carry no comments and no
   placeholders. A clone of `campaign-shell.liquid` still has its ALL-CAPS placeholders to replace,
   and they are visible text, so anything you miss is obvious in the preview and in the test send.
4. Set the **subject line** and **preview text** from the campaign metadata table above. If you
   change either, update the table in the same sitting. There is nothing to change in the template:
   Shopify builds the preheader from the field.

   **Re-check both fields every time you re-paste the template.** They belong to the campaign or
   automation, not to the saved custom template, so pasting new markup does not carry them over.
   Two test sends on 2026-08-21 show the failure: the first arrived as
   `Subject: [TEST] Welcome to Sapphire Shadow Studio` with a Shopify-built preheader, the second,
   after a re-paste, as a bare `Subject: [TEST]` with no preheader at all, because both fields were
   empty. A blank subject on a real send is worse than a bad one: it reads as broken to a recipient
   and to a spam filter. An empty preview-text field is milder, since the inbox then falls back to
   the first visible text, which is the headline.
5. Send a **test email to the owner address** and check it in Gmail desktop and Gmail mobile at
   minimum. This test send is the real validation for these files; see below.
6. Confirm the unsubscribe link resolves in the test send.
7. Update **Last verified** in the metadata table with the date of that successful test, and commit.

## Shopify's contract

These are the platform requirements the templates satisfy. Getting them wrong usually fails
**silently** until a test send, which is why step 5 above is not optional.

- **`{{ unsubscribe_url }}` is required** in every custom Liquid email, and it works: in the live
  editor it resolved to a real `/account/unsubscribe/...` URL inside these templates' own styled
  `<a>`. Note that the editor's placeholder text names `{{ unsubscribe_link }}` instead, which emits
  a whole ready-made link rather than a bare URL. Both are accepted; do not "fix" one to the other.
- **There are two unsubscribe paths, and only one of them is in the template.** This was written up
  the other way round first, as a single broken link, which overstated it.

  The one that matters most is a **header**, and Shopify adds it without being asked. The first real
  automation send, 2026-08-21, carried
  `List-Unsubscribe: <https://email.shopifyapps.com/subscriptions/unsubscribe?token=...>` together
  with `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, both inside the DKIM `h=` list, so both
  are signed. That is what Gmail and Yahoo require of bulk senders and what Gmail renders as its own
  Unsubscribe control beside the sender name. `email.shopifyapps.com` is a Shopify host on Shopify
  infrastructure, unrelated to this storefront, so **it is not behind the password gate**: a bogus
  token there answers `302 -> /login` on its own domain, where `/cart` on the storefront answers
  `302 -> /password`. The header path works today.

  The one in the footer is `{{ unsubscribe_url }}`, which resolves to `/account/unsubscribe/<token>`
  on the storefront domain. On a real send it is first rewritten through `/_t/c/v3/<token>`, which
  clears the gate, but what that forwards to is an ordinary storefront path, and the placeholder
  form of it answers `302 -> /password`. Whether a real token does the same is **still untested**,
  because the only way to find out is to click it in a delivered email; resolving it from a terminal
  would either register a false click or unsubscribe a real person. Shopify's docs say the URL
  cannot be repointed, so there is no template-side fix either way.

  If the footer link does turn out to dead-end, the consequence is smaller than it first appeared,
  because the header path still gives every Gmail and Yahoo recipient a working one-click opt-out.
  It is still worth knowing: a subscriber who cannot unsubscribe reports spam instead, which is the
  worst deliverability signal there is. The manual fallback is that the footer invites a reply, so
  honour any reply asking to be removed by unsubscribing that customer in Admin.
- **`{{ open_tracking_block }}` is the open-tracking variable, not `{{ open_tracking }}`.** Shopify's
  own documentation says both: its prose calls the variable `open_tracking`, its example code in the
  same page uses `{{ open_tracking_block }}`. The editor settles it. With open tracking on and
  `{{ open_tracking }}` in the file, the editor raises "Add `{{ open_tracking_block }}` variable",
  and the 2026-08-21 test send carried no tracking pixel at all, because the unrecognised variable
  simply rendered to nothing. Every template here uses `{{ open_tracking_block }}`. It renders to
  nothing visible either way, so the only symptom of getting it wrong is opens that never record.

  Open tracking itself is a **store-wide** setting, not a campaign or template one: Admin >
  **Apps** > **Messaging** > **Settings** > **Open tracking**, set to "Optimize open tracking" as of
  2026-08-21. Leave it there. The "Tracks all email opens" option sounds stricter but is worse data:
  Apple Mail Privacy Protection prefetches images for every Apple Mail recipient, so it books an
  open whether or not a human looked. "Ask for consent" is the one to avoid outright, because
  Shopify injects an "Opt in to email open tracking" link into the footer, and this footer is
  hand-composed with no room reserved for it.

  **Test sends do not carry the pixel. Real sends do.** Neither 2026-08-21 test send contained one,
  with either spelling of the variable, which is what made the wrong spelling so hard to spot. The
  first real campaign the same day ended with
  `<img src="https://sapphireshadowstudio.com/_t/open/...` immediately before `</body>`, so
  `{{ open_tracking_block }}` is confirmed working. Never diagnose this from a test send.
- **A real send is not what you pasted, in two ways a test send never shows.** Confirmed against the
  first campaign, 2026-08-21.

  **Every link is rewritten** to `https://<shop domain>/_t/c/v3/<token>`, the unsubscribe link
  included. That redirector is **exempt from the storefront password gate**: `/_t/c/v3/<bad token>`
  answers `301` to the store root and `/_t/open/<bad token>` answers `200`, where `/cart` answers
  `302 -> /password`. So click and open tracking both work while the gate is up. The link
  *destinations* are still ordinary storefront URLs and still gated, so a click lands on the
  password page exactly as before, no better and no worse.

  **The `<head>` is emptied.** Shopify moves `<meta>`, `<title>` and the whole `<style>` block into
  the top of `<body>`, after its own preheader divs, and drops `lang="en"` from `<html>`. Test sends
  keep the head intact, so this only appears on the real thing. Two consequences worth knowing and
  neither fixable from the template: the mobile media query now lives in `<body>`, which most
  clients still honour but none promise to, so check a real send on a phone rather than a test one;
  and the missing `lang` costs screen readers their language hint.

- **500 KB cap** on a custom-coded Liquid email (a custom Liquid *section* inside a drag-and-drop
  email is capped at 50 KB instead). These templates are a few KB; the cap only becomes real if
  someone inlines a base64 image, so do not.
- **Available Liquid objects**, per Shopify's documented list: `shop.name`, `shop.domain`,
  `shop.url`, `shop.shopify_domain`, `shop.address` (with its subfields), `customer.*` (name, email,
  orders_count, tags, and so on), `email.subject`, `email.preview_text`, `all_products`,
  `unsubscribe_url`, `open_tracking_block`, and, on the abandoned-checkout automation only,
  `abandoned_checkout.*` (checkout url, first five line items, totals, addresses) and
  `abandoned_visit.*`. Theme objects such as `section`, `block`, `settings`, and `collections` **do
  not exist here**.
- **`shop.email` is not on that list**, which is why neither template uses it any more. It may
  render empty, and an empty contact line is a silent failure: the footer looks fine and simply
  offers the reader no address. The store's account address is also not the customer-facing one, so
  even a working `shop.email` would have printed the wrong mailbox. Both footers now hardcode
  `contact@sapphireshadowstudio.com`.
- **`shop.address` exists and is deliberately unused.** No postal address appears in these templates.
- **Personalization limits**: keep it to about 2 variables in the subject or preview text and about
  10 in the body. Every personalization variable needs a fallback, because a subscriber who joined
  through a footer form has an email and nothing else. That is what
  `{{ customer.first_name | default: 'friend' }}` is for; do not drop the `default`.
  `campaign-shell.liquid` carries that greeting. The three welcome and announcement templates
  deliberately do not: they use no `customer` variable at all, so they read the same for every
  subscriber and there is no fallback to get wrong. That matters most for
  `launch-announcement.liquid`, which goes to the whole list, and the list is mostly footer-form
  subscribers who have never ordered.

## Email-HTML rules these templates follow

Email clients are not browsers. Keep to these when editing or cloning:

- **Tables for layout.** No flexbox, no grid, no floats. `role="presentation"` on every layout table
  so screen readers do not announce them as data tables.
- **600 px content width**, centred. The container carries `width: 600px; max-width: 600px` inline,
  and the thing that makes it reflow on a phone is the one rule in the `@media (max-width: 620px)`
  block: `.ssb-container { width: 100% !important; }`. Keep both halves; the inline width alone does
  not reflow, and the media query alone does not constrain the desktop width.
- **Inline styles for everything that matters.** The single `<style>` block holds media queries only,
  because Gmail's web client drops most of what a `<style>` block declares. That is also why the
  responsive behaviour above is the one thing not inline: there is nowhere else a media query can go.
- **No web fonts.** `Helvetica, Arial, sans-serif`. The storefront's Inter does not load reliably in
  email clients, and a half-loaded font is worse than a consistent fallback.
- **Explicit `width` and `height` attributes on every `<img>`, plus real `alt` text.** Clients do not
  compute intrinsic size, and many block images by default, so the alt text has to carry the meaning
  on its own.
- **Bulletproof buttons.** A VML `<v:roundrect>` for Outlook inside `<!--[if mso]>`, a padded anchor
  for everyone else. When you change a button label, change it in **both** halves. The mobile
  full-width behaviour takes two rules together, `.ssb-button, .ssb-button td { width: 100% }` and
  `.ssb-button a { display: block }`: the anchor rule alone does nothing, because the button table is
  shrink-to-fit and the anchor can only fill what the table gives it.
- **Dark-mode-safe colours.** `color-scheme: light` plus `supported-color-schemes: light` in the head,
  and explicit background *and* foreground colours on every element that sets either. A background
  set without its text colour is the classic dark-mode invisibility bug.
- **An icon row carries its own visible label.** A row of bare icons is one of the ugliest
  images-off failures there is: three broken-image boxes and no way to tell what they linked to. The
  footer's social row therefore pairs each icon with the network's name in text, and the icon itself
  is `alt=""` (decorative), because the visible label already says what the alt text would have.
  With images blocked the row degrades to "Instagram Facebook TikTok" in the footer's own body
  colour. Do **not** try to carry the meaning in `alt` alone: a client sizes a blocked image to its
  `width`/`height` attributes and clips the alt text to that box, so a 28 px icon shows about four
  characters of it.
- **Absolute URLs only**, built from `{{ shop.url }}`. There is no relative base in an inbox.
- **No JavaScript, no external stylesheets, no forms.** They are stripped or blocked.

## Snippets

Markup that some campaigns need and most do not. It is kept here rather than commented out inside
the shell, because a comment in a template ships with the email.

**Image row.** Paste inside the container table, and set a real Shopify Files URL along with the
image's real width and height. Both attributes are required: email clients do not compute intrinsic
size, and many block images by default, which is why the `alt` text has to stand on its own.

```html
<tr>
  <td style="padding: 0;">
    <img src="https://cdn.shopify.com/REPLACE-ME.jpg" alt="Describe the image in a few words" width="600" height="400" style="display: block; width: 100%; max-width: 600px; height: auto; border: 0;">
  </td>
</tr>
```

**Two-tile navy panel.** Two static tiles on a navy panel, echoing the countdown tiles on the
password page. The shell does not carry it, because what goes in the tiles is campaign content.

`welcome-prelaunch-superseded.liquid` carries the original **date** form, below: "Sep 3" over "2026"
and "9:00 AM" over "Eastern". An email cannot tick, so the tiles are hand-typed text and there is
nothing to recalculate. The eyebrow matched `blocks/launch-countdown.liquid`'s own, so a screen
reader heard "The studio opens Sep 3 2026 9:00 AM Eastern" as one sentence. At 375 px those two
tiles came to roughly 250 px inside a 335 px content box, so no media query was involved.

`welcome-postlaunch.liquid` and `launch-announcement.liquid` carry a **brand-promises** form of the
same panel: the same markup, no sublabel `<span>`, and the tiles read "Made to order" and "Stitched
in-house" under an eyebrow of "How we work" and "Open now" respectively. Three things about it are
deliberate. The two strings are **identical in both files**, so a panel that is edited in one and
not the other reads as an obvious mismatch rather than drifting quietly, which matters in a
directory where nothing reconciles two copies. The value is **20 px rather than the date form's
24 px**, and that is a measured choice, not a taste one: at 13 and 17 characters these strings are
two and three times the length of "Sep 3" and "9:00 AM". Measured against Helvetica Bold advance
widths, 24 px needs 283 px on a 375 px phone where the panel offers 279 px, so it overflows by a
hair; 20 px needs 251 px there and 392 px of the 504 px available on desktop, so it sets on one line
on a desktop and on two lines on a phone with room to spare. And the cells are sized **by padding
alone, with no fixed height**, so the wrapped tile grows instead of clipping against the navy edge.

**"in-house" is wrapped in its own `<span style="white-space: nowrap;">`, and that is not
decoration.** Left alone, a browser breaks a hyphenated word *at the hyphen*, so the tile rendered
as "Stitched in-" over "house". Predicting the break from advance widths does not catch this: a
greedy word-wrap assumes the space is the only break opportunity, and the hyphen is one too. It was
found by rendering the file at 375 px and looking, which is the argument for that pass in the
Testing section below. The `nowrap` span makes the space the only break opportunity again, so the
tile reads "Stitched" over "in-house". Remove the span and the bad wrap comes back silently, on
mobile only.

```html
<tr>
  <td class="ssb-pad" align="center" style="padding: 8px 32px 24px 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#071e3f" style="background-color: #071e3f; border-radius: 4px;">
      <tr>
        <td align="center" style="padding: 24px 16px;">
          <p style="margin: 0 0 14px 0; font-family: Helvetica, Arial, sans-serif; font-size: 12px; line-height: 16px; font-weight: bold; letter-spacing: 3px; text-transform: uppercase; color: #3aa0e6;">The studio opens</p>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
            <tr>
              <td align="center" bgcolor="#0c2c56" style="background-color: #0c2c56; padding: 14px 20px; border-radius: 4px;">
                <span style="font-family: Helvetica, Arial, sans-serif; font-size: 24px; line-height: 28px; font-weight: bold; color: #ffffff;">Sep 3</span><br>
                <span style="font-family: Helvetica, Arial, sans-serif; font-size: 12px; line-height: 18px; letter-spacing: 1px; color: #c9d8ea;">2026</span>
              </td>
              <td style="width: 12px; font-size: 1px; line-height: 1px;">&nbsp;</td>
              <td align="center" bgcolor="#0c2c56" style="background-color: #0c2c56; padding: 14px 20px; border-radius: 4px;">
                <span style="font-family: Helvetica, Arial, sans-serif; font-size: 24px; line-height: 28px; font-weight: bold; color: #ffffff;">9:00 AM</span><br>
                <span style="font-family: Helvetica, Arial, sans-serif; font-size: 12px; line-height: 18px; letter-spacing: 1px; color: #c9d8ea;">Eastern</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </td>
</tr>
```

**Social icon row.** Every template carries this at the top of the navy footer cell. One cell per
network, one link per network, icon and label inside the same anchor so the whole chip is clickable.
The icon is `alt=""` on purpose; see the images-off rule above.

```html
<td align="center" style="padding: 0 8px; white-space: nowrap;">
  <a href="https://www.instagram.com/sapphire_shadow_studio" style="font-family: Helvetica, Arial, sans-serif; font-size: 13px; line-height: 28px; color: #c9d8ea; text-decoration: none;">
    <img src="https://cdn.shopify.com/s/files/1/0958/0874/9868/files/email-icon-instagram.png" alt="" width="28" height="28" style="border: 0; vertical-align: middle;">&nbsp;Instagram
  </a>
</td>
```

**Product grid.** Seven product tiles: six two across in three rows, then a seventh centred on its
own. Each tile is an image and a bold label inside one anchor pointing at
`{{ shop.url }}/products/<handle>`. `welcome-postlaunch.liquid` and `launch-announcement.liquid`
carry it, identically; copy it from one of them rather than from here, so there is only one copy to
keep current. (`welcome-prelaunch-superseded.liquid` carries the older six-tile version, which had
the gift card in the sixth slot and no tote. Do not copy from that one.)

Four things about it are load-bearing:

- The label is not decoration. With images blocked a tile is a broken-image box sized to its
  `width`/`height` attributes, so a grid without labels degrades to seven empty boxes and the reader
  cannot tell what any of them were.
- The cells are `width="50%"` with the image at `width: 100%`, not fixed pixel widths, which is why
  the grid reflows on a phone with no media query of its own.
- **Row 4 is a separate table, not a `colspan` row.** The two-column table is closed after row 3 and
  the seventh tile gets its own single-cell table. A `<td colspan="2">` with no explicit width
  sitting under `width="50%"` siblings is the exact shape that trips Outlook's Word engine into
  mis-inferring column widths across the whole table.
- **Centring the row-4 tile is the `align="center"` attribute**, on both the outer `<td>` and the
  inner `<table>`. Outlook does not honour `margin: auto`. The `margin: 0 auto` is kept as a second
  mechanism for clients that do honour it, and must never be the only one. Its sizing is likewise
  the `width="262"` and `height="262"` attributes plus the inline `max-width: 262px`, never a class
  in the `<style>` block: the tile reverts to the CDN's native 524 px the moment a client drops
  `<style>`.

```html
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td align="center" style="padding: 0 6px 18px 6px;">
      <table role="presentation" width="262" cellpadding="0" cellspacing="0" border="0" align="center">
        <tr>
          <td align="center">
            <a href="{{ shop.url }}/products/sapphire-shadow-studio-gift-card" style="text-decoration: none;">
              <img src="https://cdn.shopify.com/s/files/1/0958/0874/9868/files/SSS-Square-White-BG-png.png?width=500&amp;height=500&amp;crop=center" alt="The Sapphire Shadow Studio logo on a white square." width="262" height="262" style="display: block; width: 100%; max-width: 262px; height: auto; margin: 0 auto; border: 0; border-radius: 4px;">
              <span style="display: block; padding-top: 8px; font-family: Helvetica, Arial, sans-serif; font-size: 14px; line-height: 20px; font-weight: bold; color: #071e3f;">Gift Card</span>
            </a>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
```

The tile order is Lead II Crewneck, Huddle Crewneck, Shift Fuel Crewneck, Lead II Quarter-Zip,
Lead II Vest, Shift Fuel Tote, then the Gift Card alone in row 4. The alt text keeps the descriptive
pattern the six original tiles use (colour, garment, laid flat, what is embroidered on it) rather
than echoing the visible label. The label and the alt say different things, so an anchor's
accessible name reads as description then name: verbose, but the description is real information
for a screen-reader user, and the alt is the only thing carrying it.

**Nothing checks the handles.** A product added, renamed, or unpublished after these files were
written leaves a tile pointing at a 404 or the catalogue looking smaller than it is. Re-check all
seven immediately before pasting, not after.

**The hosted assets.** Everything the templates reference lives in Shopify Files and is served by
the CDN, which is **not** behind the storefront password: all eleven URLs return 200 to an anonymous
request, which is the only reason they work in an inbox at all. Re-check that after any change here.

Paths below shown as `.../` are relative to `https://cdn.shopify.com/s/files/1/0958/0874/9868/files`.
The three colourways were **wrong in this table** until 2026-09-03: it named classic-navy RN,
grey-heather vet-tech and black where the templates have always referenced grey-heather LPN, black
nurse and classic-navy. The templates were right and the table was wrong, which is the failure mode
to expect from a hand-maintained list of URLs that nothing compares against the files.

| Asset | URL |
|---|---|
| Logo (header, every template) | `https://cdn.shopify.com/s/files/1/0958/0874/9868/files/SSS-Horizontal-transparent-png.png?width=480` |
| Product grid, Lead II Crewneck | `.../lead2_crew-sweater_grey-heather_lpn_flat-1.jpg?width=524&height=524&crop=center` |
| Product grid, Huddle Crewneck | `.../huddle_crew-sweater_black_nurse_flat-1.jpg?width=524&height=524&crop=center` |
| Product grid, Shift Fuel Crewneck | `.../shift-fuel_crew-sweater_classic-navy_flat-1.jpg?width=524&height=524&crop=center` |
| Product grid, Lead II Quarter-Zip | `.../lead2_quarter-zip_classic-navy_medic_flat-1.jpg?width=524&height=524&crop=center` |
| Product grid, Lead II Vest | `.../lead2_vest_black_rn_flat-1.jpg?width=524&height=524&crop=center` |
| Product grid, Shift Fuel Tote (not in the superseded prelaunch file) | `.../shift-fuel-tote_flat-1.jpg?width=524&height=524&crop=center` |
| Product grid, Gift Card | `.../SSS-Square-White-BG-png.png?width=500&height=500&crop=center` |
| Instagram icon | `https://cdn.shopify.com/s/files/1/0958/0874/9868/files/email-icon-instagram.png` |
| Facebook icon | `https://cdn.shopify.com/s/files/1/0958/0874/9868/files/email-icon-facebook.png` |
| TikTok icon | `https://cdn.shopify.com/s/files/1/0958/0874/9868/files/email-icon-tiktok.png` |

The tote image is the one uploaded on 2026-09-02, and a retouch pass on the studio's tote photography
was still in progress when these templates were written. **A `curl` 200 cannot tell a final asset
from a soon-to-be-superseded one**, since both answer 200. Confirm the tote image is the final asset
before the first paste; if a retouch lands first, update the URL in **both** templates before the
send, not after.

The `?width=` and `?width=&height=&crop=` suffixes are Shopify's CDN image transforms, so the
inbox downloads a 240 px logo and a 600x400 hero rather than a 2048 px original and a 4000x4000
one. In the `src` attribute the `&` between transform parameters is written `&amp;`. Drop any `?v=`
cache buster: it is not part of the file's identity.

The three icons are generated, not hand-drawn. `scripts/email-icons/render-email-icons.mjs`
rasterises them from path data copied out of `snippets/icon.liquid` into 56 px PNGs (2x the 28 px
display size) under `marketing/emails/assets/`, and
`scripts/email-icons/upload-email-icons.mjs` uploads those committed PNGs to Shopify Files. Email
cannot render SVG, which is why the theme's own inline icons could not be reused directly. Re-run
the renderer if the theme's icons change; `npm run email-icons:test` fails if the copied path data
and the committed PNGs stop agreeing with their sources.

## Branding is duplicated on purpose

Each file is self-contained: no partials, no includes, no build step. The repo has no bundler or
transpiler to begin with, and Shopify Email would not resolve a partial anyway, since it takes one
pasted document and nothing else. The header, footer, social row, and palette are therefore copied
into every template. **A palette or footer change has to be made in every file in this directory.**
That is now **four** files rather than two, and the launch swap is what raised the count: a change
to the header, the footer, the social row or the palette has to be made in `campaign-shell.liquid`,
`welcome-postlaunch.liquid`, `launch-announcement.liquid` and
`welcome-prelaunch-superseded.liquid`. The superseded file is included on purpose: it is the record
of what was sent, so leaving it visually stale is fine, but a palette change made in three of four
files is the drift this paragraph exists to warn about. Decide deliberately which it is.

The palette also lives outside this directory, in `marketing/notifications/lib/brand-style.css`, the
stylesheet behind the 46 branded Shopify notification templates, documented in
`marketing/notifications/README.md`. A palette change goes there too, followed by a regenerate.

The palette is the resolved-hex token set in `scripts/size-chart/lib/svg-shared.mjs`, which already
solved this problem for the size-chart PNGs: a renderer outside Liquid cannot read a colour scheme,
so the storefront's "Sapphire Shadow" scheme is written out there as literal hexes. The email uses
the same file as its reference rather than resolving `config/settings_data.json` a second time.

| Role | Value | Token |
|---|---|---|
| Navy header, footer, tile panel | `#071e3f` | `BG` |
| Tile faces | `#0c2c56` | `PANEL` |
| Eyebrow on navy | `#3aa0e6` | `ACCENT_LT` |
| Footer text, tile sublabels, social labels | `#c9d8ea` | `BODY` |
| Button | `#0071C2` | not a token; see below |
| Page surround | `#e1edf5` | not a token; `scheme-4`'s `background` |

Two of those are deliberate exceptions. The **button** keeps `#0071C2`, which is
`sss-dark-scheme`'s `primary_button_background` in `config/settings_data.json` and therefore the
storefront's actual CTA colour: a button a subscriber clicks in the email should be the same blue as
the button they land on. The **page surround** is `scheme-4`'s `background`, and has no equivalent
in the size-chart token set because a PNG has no surround.

The footer text used to be `#c9d8e6`, one digit off from `BODY`. That was a transcription slip, not a
choice, and every file here now says `#c9d8ea`. Only `scripts/email-icons/` reads the token set
programmatically (it bakes `BODY` into the icon PNGs); the templates hold literal hexes, because
Shopify Email has no `settings` object and no way to resolve anything.

## The launch swap: what changed, and what still has to be done in Admin

This section used to be a to-do list headed "`welcome.liquid` is the prelaunch version, and has to
be changed at launch". The five edits it described were made on 2026-09-03. It is now the record of
what they were and where they landed.

**The edits went into a new file, not into the old one.** `welcome.liquid` became
`welcome-prelaunch-superseded.liquid` (a `git mv`, so its history is intact) and the post-launch
version is `welcome-postlaunch.liquid`. Keeping the stale copy is deliberate: it is the only record
of what every existing subscriber was actually sent. The rename is what makes that safe. Two
near-identical files in a directory that is copy-pasted by hand is a live paste hazard, and
`welcome-postlaunch.liquid` would have sorted immediately *before* `welcome.liquid` in a plain
listing. The filename now carries the warning, which survives a rushed paste in a way a row in a
table above does not.

The five edits, for the record:

1. **The date tiles went.** "The studio opens Sep 3 2026, 9:00 AM Eastern" is stale on the day it
   stops being true. The panel stayed, with the same markup and two tiles that cannot go stale:
   "Made to order" and "Stitched in-house", under an eyebrow of "How we work". See the two-tile
   navy panel snippet above for the sizing, which is not a straight copy of the date form's.
   `blocks/launch-countdown.liquid` states the same instant on the password page and is still there;
   the two should be retired together, and `TODO.md` now says so.
2. **The "A preview of what is available at launch" line went**, along with the reason it existed:
   with the gate down, the tiles reach real product pages.
3. **"What happens next" was rewritten** for an open store: what made-to-order means for the wait,
   that every piece is looked at before it is packed, and where to ask a question. It links the
   shipping policy and the FAQ page and states no number or duration itself, per the rule below.
4. **The button says "Shop the collection"** and points at `{{ shop.url }}/collections/all`, in
   **both** halves. "Visit the studio" was chosen to promise nothing the gate could not deliver.
5. **The product grid went from six tiles to seven**, adding the Shift Fuel Tote and moving the Gift
   Card to a row of its own. The grid snippet above has the markup and the Outlook reason for the
   fourth row being a separate table.

**The email-first promise, and why it fixes launch-day order.** The prelaunch welcome told every
subscriber who received it: "you will hear it from us by email before we announce it anywhere else."
That is a commitment already made, it cannot be corrected after the fact, and nothing in the repo
enforces it. So the order on launch day is: **send `launch-announcement.liquid` to the list first,
then post to social, then take the storefront password off.** This paragraph is the only record of
that, which is why it survives the rewrite of the section around it.

`launch-announcement.liquid` is what discharges the promise. It is a one-time campaign to the whole
list, not an automation. It carries no discount and no launch offer, and no product count: the list
is mostly people who have never ordered, and a count is a claim that becomes false the first time a
product is added or retired, in an email that cannot be recalled.

### Still to do in Admin, and nothing here does it

**Re-paste the "Customer signs up" automation.** Until `welcome-postlaunch.liquid` is pasted over
it, the live automation keeps sending the prelaunch email, date panel and all, to every new
subscriber. Nothing in this repo can see or change what that automation is running.

**Re-check the seven product handles and the tote image immediately before the first paste.** A
product added, renamed, unpublished or entirely sold out since 2026-09-03 leaves a tile pointing at
a 404 or the catalogue looking smaller than it is. Confirm the tote asset is the final one and not a
version the retouch work is about to supersede; a 200 answer cannot tell those apart.

**Update the subject and preview text**, and **Last verified** in the metadata table, in the same
sitting as each paste. Both fields belong to the campaign, not to the template, so a re-paste drops
them.

### Two accepted limitations, neither fixable from a template

**Shopify drops `lang="en"` from `<html>` on a real send**, along with emptying the whole `<head>`
(see Shopify's contract above). A screen reader therefore loses its language hint on the delivered
email. This already affected the live prelaunch file and affects the new ones identically; there is
nothing template-side to change, so it is a note rather than a defect.

**The social URLs are hardcoded in every template**, because Shopify Email has no `settings` object
to read `settings.social_instagram_link` from. They duplicate the values in
`config/settings_data.json` and nothing reconciles the two: change a profile URL in theme settings
and every file here goes stale silently. The storefront links are the opposite case, and that is
why they are written as `{{ shop.url }}` rather than a literal domain: Shopify resolves it at send
time, so there is nothing to keep in sync.

### Why the prelaunch file named a date

Kept because the reasoning outlived the file. This README used to argue that a date in a sent email
cannot be corrected, so no date was better than a date that slips. It changed because the date
stopped being the email's to withhold: `blocks/launch-countdown.liquid` committed publicly to
2026-09-03 09:00 ET, the password page ticked down to it, and the Instagram bio repeated it, so a
subscriber read that email minutes after watching that countdown. Saying only "not open yet" there
would have read as evasion, not caution. The residual risk was real and could not be designed away:
that file was an **automation**, so every send carried whatever date the template said at the time,
and editing it would have fixed future sends only.

The new templates carry no date, no duration and no product count, for the same underlying reason
and with none of the residual risk.

## Shipping and policy copy: do not restate it here

Shipping rates, thresholds, and turnaround times already have five sources of truth (theme settings,
inline template JSON, announcement slides, the Admin rate names, and the shop policies now tracked at
`marketing/policies/`, all covered in `docs/theme-settings-contracts.md`). An email is a sixth that
nothing reconciles **and that cannot be corrected after it is sent**. Link to the shipping policy or
the FAQ page instead of restating a number. Every template here deliberately contains no shipping
figures. `welcome-postlaunch.liquid` and `launch-announcement.liquid` both link the shipping policy
and the FAQ page and state no duration of their own, which is the whole reason they can talk about
made-to-order at all.

The rule is unchanged by the policies moving into the repo: a policy can be re-pushed, a sent email
cannot be recalled.

## This repo is public

Campaign copy is committed to a public repository and gets the same treatment as any other commit
(see the Sensitive Content section of the repo's `CLAUDE.md`): no personal emails, phone numbers, or
addresses; no test-send address, which is why this file says "the owner address" rather than naming
one; no sub-state location detail; no discount codes that are meant to stay private until launch.
The footers name `contact@sapphireshadowstudio.com` as a literal. That is a brand address, already
published on the storefront's contact page, and it is committed here on purpose: `shop.email` is not
a documented variable for these emails (see Shopify's contract above), and it holds the store's
account address rather than the customer-facing one. `{{ shop.domain }}` still renders at send
time.

## Testing and validation

There is no automated check for these files, by design:

- `theme-check` ignores `marketing/**` (see `.theme-check.yml`). Email Liquid uses objects
  (`unsubscribe_url`, `open_tracking_block`, `email.*`) that do not exist in a theme, so every one of them
  would be flagged as undefined.
- `validate_theme_codeblocks` is worth running once on a new template as a **syntax-only** sanity
  pass: act on unclosed tags and bad filters, ignore anything it says about undefined objects. Note
  that it will not catch the one defect that actually blocks a paste, since a Liquid comment tag is
  perfectly valid theme Liquid and only Shopify Email rejects it.
- **Pasting into the editor is itself a check, and a cheap one.** It validates on every keystroke and
  renders a live preview against a sample customer, so it catches what nothing local can. It is safe:
  a template is not a campaign and cannot send. This is where the Liquid-comment prohibition above was
  found, after the file had already passed `theme check` and an HTML structural parse.
- Opening a file in a browser is a useful structural check for layout and styles, and worth doing at
  a desktop width and at a phone width. Liquid tags render as literal text unless you substitute
  values first, which is worth doing for anything inside an `href`. Two more browser passes are worth
  the minute they cost: **with the `<style>` block deleted** (the client-drops-CSS case, which is
  most of them) and **with every image `src` pointed at a dead URL** (the images-off case, which is
  the default in a lot of inboxes). The second one is how the footer's icon labels got there.
- `npm run email-icons:test` covers the icon tooling, not the templates: it fails if the path data
  copied into `scripts/email-icons/lib/icons.mjs` drifts from `snippets/icon.liquid`, or if the PNGs
  committed under `assets/` stop matching what the renderer produces. Nothing tests the templates
  themselves.
- **Confirm every CDN asset URL returns 200 to an anonymous request** after changing one. The
  storefront is password-protected and the CDN is not, so it is easy to paste a URL that works in
  your logged-in browser and reaches no subscriber.
- **The test send is the real test.** Nothing before it proves the email renders in an inbox.
