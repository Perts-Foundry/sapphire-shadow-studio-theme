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
| `welcome.liquid` | Welcome to Sapphire Shadow Studio | You are in early. The shop is not open yet, and you will be first through the door. | "Customer signs up" welcome automation, all new email subscribers while the storefront is password-protected | Not yet test-sent |
| `campaign-shell.liquid` | n/a, clone it | n/a, clone it | n/a | n/a |

The preview text has a second home: the hidden **preheader `<div>`** at the top of `<body>`, which
many inboxes render in place of the campaign field. Change one and you change three things: this
table, that `<div>`, and the field in the editor.

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
   change either, update the table and the preheader `<div>` in the same sitting.
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
- **`{{ open_tracking }}` is required when open tracking is on** for the campaign, and the editor
  accepts it. It renders to nothing visible, which is expected. The editor's placeholder text names
  `{{ open_tracking_block }}`; if a test send records no opens, try that spelling before assuming
  the markup is at fault.
- **500 KB cap** on a custom-coded Liquid email (a custom Liquid *section* inside a drag-and-drop
  email is capped at 50 KB instead). These templates are a few KB; the cap only becomes real if
  someone inlines a base64 image, so do not.
- **Available Liquid objects**: `shop.*` (name, domain, url, email, address), `customer.*` (name,
  email, orders_count, tags, and so on), `email.*` (subject, preview text), `all_products`, and, on
  the abandoned-checkout automation only, `abandoned_checkout.*` (checkout url, first five line
  items, totals, addresses) and `abandoned_visit.*`. Theme objects such as `section`, `block`,
  `settings`, and `collections` **do not exist here**.
- **Personalization limits**: keep it to about 2 variables in the subject or preview text and about
  10 in the body. Every personalization variable needs a fallback, because a subscriber who joined
  through a footer form has an email and nothing else. That is what
  `{{ customer.first_name | default: 'friend' }}` is for; do not drop the `default`.

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

## Branding is duplicated on purpose

Each file is self-contained: no partials, no includes, no build step. The repo has no bundler or
transpiler to begin with, and Shopify Email would not resolve a partial anyway, since it takes one
pasted document and nothing else. The header, footer, and palette are therefore copied into every
template. **A palette or footer change has to be made in every file in this directory.** The palette
is lifted from `config/settings_data.json`, from two different colour schemes: navy `#071e3f`
(`sss-dark-scheme`'s `background`) and accent blue `#0071C2` (`sss-dark-scheme`'s
`primary_button_background`), plus light blue `#e1edf5` (`scheme-4`'s `background`), used here as
the page surround.

## `welcome.liquid` is the prelaunch version, and has to be changed at launch

While the storefront password is on, every storefront URL resolves to Shopify's "Opening soon"
page. A welcome email whose links all dead-end on a password wall is the fastest way to make a new
subscriber think the brand is broken, so the prelaunch welcome sends nobody there: the header
wordmark is plain text, the footer names the domain without linking it, and the single button points
at Instagram, which is public.

That makes the file **wrong the day the password comes off**, and nothing will tell you so. Nothing
in the file itself says this either, because notes in a template ship to subscribers. This section is
the only record. Make all four edits in one sitting; each one alone leaves the email half-migrated.

1. **Relink the wordmark.** Wrap the header `<span>` in
   `<a href="{{ shop.url }}" style="color: #ffffff; text-decoration: none;"> ... </a>`, matching
   `campaign-shell.liquid`.
2. **Repoint the button** at `{{ shop.url }}` in **both** halves, the VML `href` and the anchor
   `href`, and change both labels to match each other.
3. **Relink the footer domain.** Wrap `{{ shop.domain }}` in
   `<a href="{{ shop.url }}" style="color: #ffffff; text-decoration: underline;"> ... </a>`.
4. **Rewrite the "What happens next" section**, which is written for a shop that has not opened, and
   update the subject, the preview text, the preheader `<div>`, and the metadata table above together.

Two things about that button. Its URL is **hardcoded**, because Shopify Email has no `settings`
object to read `settings.social_instagram_link` from, so it duplicates the value in
`config/settings_data.json` and nothing reconciles the two: change the profile URL in theme settings
and this file goes stale silently. And the prelaunch copy **promises no launch date**, deliberately.
A date in a sent email cannot be corrected, and a date that slips is worse than no date at all.

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
Contact details in the footers come from `{{ shop.email }}` and `{{ shop.domain }}` at render time
rather than being typed in as literals, which keeps them correct and keeps them out of the diff.

## Testing and validation

There is no automated check for these files, by design:

- `theme-check` ignores `marketing/**` (see `.theme-check.yml`). Email Liquid uses objects
  (`unsubscribe_url`, `open_tracking`, `email.*`) that do not exist in a theme, so every one of them
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
  values first, which is worth doing for anything inside an `href`.
- **The test send is the real test.** Nothing before it proves the email renders in an inbox.
