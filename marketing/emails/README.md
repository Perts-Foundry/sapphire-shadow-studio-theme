# Shopify Email templates

Custom-coded Liquid/HTML emails for Shopify Email (Shopify Messaging) campaigns and automations.
**Nothing here is theme code.** Shopify Email has no API and no theme surface, so these files are
never pushed, never deployed, and never read by the storefront. They exist so campaign markup can be
written, reviewed, and versioned like everything else, then pasted by hand into the Shopify Email
custom-code editor.

| File | Purpose |
|---|---|
| `campaign-shell.liquid` | Reusable base. Clone it to start a new campaign. Its fill-in spots are ALL-CAPS placeholder text. |
| `welcome.liquid` | Welcome automation, **written for prelaunch**. Ready to paste as-is. See the launch swap below. |

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
| `welcome.liquid` | Welcome to Sapphire Shadow Studio | The studio opens September 3 at 9:00 AM Eastern. | "Customer signs up" welcome automation, all new email subscribers while the storefront is password-protected | 2026-08-21, headers reviewed |
| `campaign-shell.liquid` | n/a, clone it | n/a, clone it | n/a | n/a |

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
diverge. This is the same drift pattern as the social links and shipping copy documented in the
repo's `CLAUDE.md`, and nothing reconciles it: no test, no CI check, no script can see inside the
Shopify Email editor.

Reversal is a plain `git revert` plus a re-paste. Nothing here deploys automatically.

## Paste procedure

The Shopify Email custom-code editor is **desktop only**; it cannot be opened on a phone or tablet.

1. Shopify Admin > **Marketing** > **Create campaign** (or **Automations** for the welcome flow) >
   **Shopify Email**.
2. Pick the option for a custom-coded / custom Liquid email rather than a drag-and-drop template.
3. Paste the **whole file**. `welcome.liquid` needs nothing else: it carries no comments and no
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
- **The unsubscribe link does not work while the storefront password is on.** `unsubscribe_url`
  resolves to `/account/unsubscribe/<token>` on the primary online store domain, and that domain is
  behind the gate: an anonymous request to it returns `302 -> /password`, exactly as `/cart` and
  `/policies/*` do. Shopify's docs are explicit that the variable "will always point to the primary
  online store domain and can't be modified to direct elsewhere", so there is no template-side fix.
  Verified against a placeholder token on 2026-08-21; re-test with a real token from a real send
  before treating it as settled. This matters more than it looks: a subscriber who cannot
  unsubscribe reports spam instead, which is the single worst deliverability signal there is, and an
  opt-out mechanism that does not function is a compliance problem, not just an annoyance. Until the
  gate comes down the mitigation is manual: the footer invites a reply, so honour any reply asking
  to be removed by unsubscribing that customer in Admin.
- **`{{ open_tracking_block }}` is the open-tracking variable, not `{{ open_tracking }}`.** Shopify's
  own documentation says both: its prose calls the variable `open_tracking`, its example code in the
  same page uses `{{ open_tracking_block }}`. The editor settles it. With open tracking on and
  `{{ open_tracking }}` in the file, the editor raises "Add `{{ open_tracking_block }}` variable",
  and the 2026-08-21 test send carried no tracking pixel at all, because the unrecognised variable
  simply rendered to nothing. Both templates now use `{{ open_tracking_block }}`. It renders to
  nothing visible either way, so the only symptom of getting it wrong is opens that never record.

  Open tracking itself is a **store-wide** setting, not a campaign or template one: Admin >
  **Apps** > **Messaging** > **Settings** > **Open tracking**, set to "Optimize open tracking" as of
  2026-08-21. Leave it there. The "Tracks all email opens" option sounds stricter but is worse data:
  Apple Mail Privacy Protection prefetches images for every Apple Mail recipient, so it books an
  open whether or not a human looked. "Ask for consent" is the one to avoid outright, because
  Shopify injects an "Opt in to email open tracking" link into the footer, and this footer is
  hand-composed with no room reserved for it.

  With that setting on, **neither 2026-08-21 test send carried a tracking pixel**, with either
  spelling of the variable. Since the store-wide setting is not "Do not track", the likeliest
  explanation is that test sends do not inject the pixel at all. That is inference, not proof: the
  first real automation send is what settles it. Do not go changing the variable again on the
  strength of a test send showing no pixel.
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
  `campaign-shell.liquid` carries that greeting. `welcome.liquid` deliberately does not:
  it uses no `customer` variable at all, so it reads the same for every subscriber and there
  is no fallback to get wrong.

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

**Date tile panel.** Two static tiles on a navy panel, echoing the countdown tiles on the password
page. `welcome.liquid` carries this; the shell does not, because a date is campaign content. An
email cannot tick, so the tiles are hand-typed text and there is nothing to recalculate. The eyebrow
matches `blocks/launch-countdown.liquid`'s own, so a screen reader hears "The studio opens Sep 3
2026 9:00 AM Eastern" as one sentence. At 375 px the two tiles come to roughly 250 px inside a
335 px content box, so no media query is involved.

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

**Social icon row.** Both templates carry this at the top of the navy footer cell. One cell per
network, one link per network, icon and label inside the same anchor so the whole chip is clickable.
The icon is `alt=""` on purpose; see the images-off rule above.

```html
<td align="center" style="padding: 0 8px; white-space: nowrap;">
  <a href="https://www.instagram.com/sapphire_shadow_studio" style="font-family: Helvetica, Arial, sans-serif; font-size: 13px; line-height: 28px; color: #c9d8ea; text-decoration: none;">
    <img src="https://cdn.shopify.com/s/files/1/0958/0874/9868/files/email-icon-instagram.png" alt="" width="28" height="28" style="border: 0; vertical-align: middle;">&nbsp;Instagram
  </a>
</td>
```

**Product grid.** Six product tiles, two across, three rows, each tile an image and a bold label
inside one anchor pointing at `{{ shop.url }}/products/<handle>`. `welcome.liquid` carries it; copy
it from there rather than from here, so there is only one copy to keep current. Two things about it
are load-bearing. The label is not decoration: with images blocked, a tile is a broken-image box
sized to its `width`/`height` attributes, so a grid without labels degrades to six empty boxes and
the reader cannot tell what any of them were. And the cells are `width="50%"` with the image at
`width: 100%`, not fixed pixel widths, which is why the grid reflows on a phone with no media query
of its own.

**The hosted assets.** Everything the templates reference lives in Shopify Files and is served by
the CDN, which is **not** behind the storefront password: all ten URLs return 200 to an anonymous
request, which is the only reason they work in an inbox at all. Re-check that after any change here.

Paths below shown as `.../` are relative to `https://cdn.shopify.com/s/files/1/0958/0874/9868/files`.

| Asset | URL |
|---|---|
| Logo (header, both templates) | `https://cdn.shopify.com/s/files/1/0958/0874/9868/files/SSS-Horizontal-transparent-png.png?width=480` |
| Product grid, Lead II Crewneck (`welcome.liquid`) | `.../lead2_crew-sweater_classic-navy_rn_flat-1.jpg?width=524&height=524&crop=center` |
| Product grid, Huddle Crewneck | `.../huddle_crew-sweater_grey-heather_vet-tech_flat-1.jpg?width=524&height=524&crop=center` |
| Product grid, Shift Fuel Crewneck | `.../shift-fuel_crew-sweater_black_flat-1.jpg?width=524&height=524&crop=center` |
| Product grid, Lead II Quarter-Zip | `.../lead2_quarter-zip_classic-navy_medic_flat-1.jpg?width=524&height=524&crop=center` |
| Product grid, Lead II Vest | `.../lead2_vest_black_rn_flat-1.jpg?width=524&height=524&crop=center` |
| Product grid, Gift Card | `.../SSS-Square-White-BG-png.png?width=500&height=500&crop=center` |
| Instagram icon | `https://cdn.shopify.com/s/files/1/0958/0874/9868/files/email-icon-instagram.png` |
| Facebook icon | `https://cdn.shopify.com/s/files/1/0958/0874/9868/files/email-icon-facebook.png` |
| TikTok icon | `https://cdn.shopify.com/s/files/1/0958/0874/9868/files/email-icon-tiktok.png` |

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
choice, and both files now say `#c9d8ea`. Only `scripts/email-icons/` reads the token set
programmatically (it bakes `BODY` into the icon PNGs); the templates hold literal hexes, because
Shopify Email has no `settings` object and no way to resolve anything.

## `welcome.liquid` is the prelaunch version, and has to be changed at launch

**The storefront links point at the storefront, on purpose, even though it is still gated.** That is
a reversal of what this file used to say. The old reasoning was that every storefront URL resolves
to Shopify's "Opening soon" page, so a link there dead-ends and reads as a broken brand. Two things
changed it. `blocks/launch-countdown.liquid` restyled that gate in the brand scheme and put a live
countdown on it, so a click now lands on an on-brand page that answers "when?" instead of a generic
wall. And a link written as `{{ shop.url }}/products/<handle>` starts resolving to the real product
on launch day with no edit at all, which takes work out of the swap below rather than adding it.

What that costs: while the gate is up, the six product tiles, the header logo and the button all
land on the same countdown page. The line above the grid ("A preview of what is available at launch")
is what keeps that honest, so do not delete it before the gate comes down. The button is labelled
"Visit the studio" rather than anything promising browsable product, for the same reason, and the
Instagram link under it is the one destination in the email that is genuinely browsable today.

The file is still **wrong the day the password comes off**, and nothing will tell you so. Nothing in
the file itself says this either, because notes in a template ship to subscribers. This section is
the only record. Make all five edits in one sitting; each one alone leaves the email half-migrated.

1. **Remove or repoint the date tiles.** Once the store is open, "The studio opens Sep 3" is stale
   on the day it stops being true. Delete the row, or repoint the panel at whatever the next dated
   thing is. This is tracked alongside the password-page countdown in `TODO.md`, because the two
   surfaces state the same instant and should be retired together.
2. **Delete the "A preview of what is available at launch" line** above the product grid. It no
   longer names a date, so it will not go stale on a specific day, but it still reads as prelaunch
   and once the tiles reach real product pages it is unnecessary.
3. **Rewrite the "What happens next" section**, which is written for a shop that has not opened, and
   update the subject, the preview text, and the metadata table above in the same sitting. Note what it currently promises: "you will hear it from us by email before we
   announce it anywhere else." That fixes the order of launch day, list first and social second,
   and it is tracked in `TODO.md` because it is a commitment the email has already made to every
   subscriber who received it. It cannot be corrected after the fact.
4. **Relabel the button.** "Visit the studio" was chosen to promise nothing the gate could not
   deliver. With the gate down it can say what it means, in **both** halves: the VML `<center>` text
   and the anchor text have to match each other or Outlook and everyone else read different labels.
5. **Re-check the product grid.** Six tiles, two across, hardcoded to the six products that existed
   when it was written. A product added, renamed, or unpublished since then leaves a tile pointing
   at a 404 or the catalogue looking smaller than it is, and nothing checks the handles. The grid
   deliberately uses varied colourways rather than each product's featured image, which are all the
   black colourway and would have made six near-identical tiles.

Two things about the buttons and links. The Instagram URL is **hardcoded**, because Shopify Email
has no `settings` object to read `settings.social_instagram_link` from, so it duplicates the value
in `config/settings_data.json` and nothing reconciles the two: change the profile URL in theme
settings and this file goes stale silently. The same is true of the three URLs in the social row.
The storefront links are the opposite case and that is why they are written as `{{ shop.url }}`
rather than a literal domain: Shopify resolves it at send time, so there is nothing to keep in sync.

**The copy names a launch date, and that is a reversal.** This file used to argue the opposite: that
a date in a sent email cannot be corrected, so no date was better than a date that slips. The reason
it changed is that the date stopped being the email's to withhold. `blocks/launch-countdown.liquid`
commits publicly to 2026-09-03 09:00 ET, the password page ticks down to it, and the Instagram bio
repeats it, so a subscriber reads this email minutes after watching that countdown. Saying only "not
open yet" there reads as evasion, not caution. The residual risk is real and cannot be designed away:
this is an **automation**, so every send carries whatever date the template said at the time, and
editing the template fixes future sends only. If September 3 slips, the correction is a follow-up
campaign to the list, not an edit here.

## Shipping and policy copy: do not restate it here

Shipping rates, thresholds, and turnaround times already have four sources of truth (theme settings,
inline template JSON, announcement slides, and the Admin rate names plus the shop policy pages, all
covered in the repo's `CLAUDE.md`). An email is a fifth that nothing reconciles **and that cannot be
corrected after it is sent**. Link to the shipping policy or the FAQ page instead of restating a
number. `welcome.liquid` deliberately contains no shipping figures.

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
