# Shopify Email templates

Custom-coded Liquid/HTML emails for Shopify Email (Shopify Messaging) campaigns and automations.
**Nothing here is theme code.** Shopify Email has no API and no theme surface, so these files are
never pushed, never deployed, and never read by the storefront. They exist so campaign markup can be
written, reviewed, and versioned like everything else, then pasted by hand into the Shopify Email
custom-code editor.

| File | Purpose |
|---|---|
| `campaign-shell.liquid` | Reusable base. Clone it to start a new campaign. |
| `welcome.liquid` | "You are on the list" welcome automation. |

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
3. Paste the **whole file**, including the leading `{% comment %}` header. The header is a comment,
   so it never renders; leaving it in keeps the pasted copy traceable back to this repo.
4. Set the **subject line** and **preview text** from the file's header block. They are campaign
   fields in the editor, not part of the pasted body, which is why they live in the header here.
5. Send a **test email to the owner address** and check it in Gmail desktop and Gmail mobile at
   minimum. This test send is the real validation for these files; see below.
6. Confirm the unsubscribe link resolves in the test send.
7. Update `LAST VERIFIED` in the file's header with the date of that successful test, and commit.

## Shopify's contract

These are the platform requirements the templates satisfy. Getting them wrong usually fails
**silently** until a test send, which is why step 5 above is not optional.

- **`{{ unsubscribe_url }}` is required** in every custom Liquid email. (`{{ unsubscribe_link }}`,
  which emits a whole ready-made link instead of a bare URL, is the accepted alternative. These
  templates use `unsubscribe_url` inside their own styled `<a>`.)
- **`{{ open_tracking }}` is required when open tracking is on** for the campaign. Shopify's own
  example puts it in the footer, which is where these templates put it. Some of Shopify's docs
  spell the example variable `open_tracking_block`; if a test send fails to record opens, try that
  spelling before assuming the markup is at fault.
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
- **600 px content width**, centred, with a `max-width: 100%` mobile fallback.
- **Inline styles for everything that matters.** The single `<style>` block holds media queries only,
  because Gmail's web client drops most of what a `<style>` block declares.
- **No web fonts.** `Helvetica, Arial, sans-serif`. The storefront's Inter does not load reliably in
  email clients, and a half-loaded font is worse than a consistent fallback.
- **Explicit `width` and `height` attributes on every `<img>`, plus real `alt` text.** Clients do not
  compute intrinsic size, and many block images by default, so the alt text has to carry the meaning
  on its own.
- **Bulletproof buttons.** A VML `<v:roundrect>` for Outlook inside `<!--[if mso]>`, a padded anchor
  for everyone else. When you change a button label, change it in **both** halves.
- **Dark-mode-safe colours.** `color-scheme: light` plus `supported-color-schemes: light` in the head,
  and explicit background *and* foreground colours on every element that sets either. A background
  set without its text colour is the classic dark-mode invisibility bug.
- **Absolute URLs only**, built from `{{ shop.url }}`. There is no relative base in an inbox.
- **No JavaScript, no external stylesheets, no forms.** They are stripped or blocked.

## Branding is duplicated on purpose

Each file is self-contained: no partials, no includes, no build step (an org rule, and Shopify Email
would not resolve them anyway, since it takes one pasted document). The header, footer, and palette
are therefore copied into every template. **A palette or footer change has to be made in every file
in this directory.** The palette comes from the theme's Sapphire scheme in
`config/settings_data.json`: navy `#071e3f`, accent blue `#0071C2`, light blue `#e1edf5`.

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
  pass: act on unclosed tags and bad filters, ignore anything it says about undefined objects.
- Opening a file in a browser is a useful structural check. Liquid tags render as literal text, but
  the layout and styles are inspectable.
- **The test send is the real test.** Nothing before it proves the email renders in an inbox.
