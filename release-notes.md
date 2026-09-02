# Release Notes

## Branded notification templates, generated from committed stock (unreleased)

The 46 customer notification templates (Admin > Settings > Notifications) now have branded,
ready-to-paste copies under `marketing/notifications/`, restyled to the welcome email's look. The
README there documents the surface; this entry records the decisions.

**The restyle lives in the template's own `<style>` block, and the body stays byte-identical to
stock.** Shopify's notification inliner applies the template's stylesheet by class at send time
(verified on the `order_confirmation` pilot: every rule in `lib/brand-style.css` was inlined and
the Shop-app button text stayed stock). That means the brand can ride on a stylesheet swap plus one
footer insertion, with no markup rewrite. The payoff is reviewability: a generated file is stock
plus exactly three mechanical edits (style block replaced, social row inserted before the footer
disclaimer, a generator comment prepended), so a future upstream change to a stock template shows
up as a plain diff against `stock/<id>.liquid` rather than a three-way merge across hand-edited
markup.

**There is no API.** Notification templates are read and written only through the Admin editor,
so the repo file is the source of truth and Admin holds a pasted copy, the same model as
`marketing/emails/`. Nothing reconciles the two.

**Customising opts each template out of Shopify's stock updates.** That is accepted. The drift
procedure is: revert the one template to default in Admin (a short window of stock sends), copy the
editor's text to a file, `record-stock.mjs` it, diff the snapshot, regenerate, re-paste. The
snapshots in `stock/` are what the editor held when recorded, with "Revert changes" disabled as the
only stock signal Shopify offers; they are not certified stock.

**Committing Shopify's stock templates is merchant use of merchant-editable templates.** The
templates are handed to every store as editable source in the store's own admin, and are already
served in full to every customer who receives one; they are committed here so the branded output
can be generated, checked and reviewed, not redistributed as a product.

**Overrides, ten of them.** The generator is manifest-driven and fail-closed: an anchor that does
not occur exactly once is a refusal, never a guess. Six templates (`local_delivered`, `order_link`,
`shipment_delivered`, `shipment_out_for_delivery`, `shipping_confirmation`, `shipping_update`)
carry two `disclaimer__subtext` paragraphs, one in the body and the stock one in the footer, so
their manifest entry names the footer paragraph by its opening text (`footerAnchor`). One
(`pos_send_cart`) carries a fourth rule in its stock style block, a `.top-border` hairline, so its
entry names the whole block (`styleAnchor`) and the hairline is dropped on purpose. Three
(`gift_card_confirmation`, `gift_card_notification`, `store_credit_issued`) ship with no header
table and the logo inside the white card, so no stylesheet could give them the navy band; their
entry sets `header`, which inserts `lib/header.html` (the stock logo-only header) before the
content row and removes the in-body logo block, the only override that touches body markup. It was
added during the paste session after the first gift-card preview showed a bare white card where
every other template has the band; the "stock plus a stylesheet" principle gave way to the brand
reading the same on all 46. A `skip` field exists for a template that should stay stock; none uses
it.

**A mistake those six templates caught, corrected before release.** The first draft of
`brand-style.css` coloured `.disclaimer__subtext` for the navy footer without scoping it to the
footer, so the body-side paragraph in those six (the tracking-number line, or the email-safety
message) would have rendered light grey on white with a white link. The pilot had no body-side
disclaimer, so its preview could not show this; a verification pass over the stock files did. Every
rule naming `disclaimer__subtext` or an inserted `ssb-` class is now scoped under `.footer`, and a
suite test refuses an unscoped one. The lesson for the next stylesheet change: a stock class is
not a location, so check where else the stock templates use it before restyling it.

**Two findings from the wave-1 paste session (order lifecycle, ten templates).** First, the editor
preview for `ready_for_pickup` and `pickup_receipt` renders the stored template and ignores the
unsaved editor contents. The preview mutation was sent with the branded body and returned no error,
yet the HTML that came back carried the stock accent-colour rule and no brand CSS, and pasting a
different template's body produced the same stock render, so it is the server ignoring the input,
not a paste or timing fault. The other eight wave-1 templates previewed their unsaved paste. For
those two the procedure is save first, then preview the stored version; both rendered correctly
once saved. Second, `.order-list__item-price` renders `#333333` rather than the `#071e3f` the
stylesheet asks for, in every template that has a price column; Shopify's inliner applies its
default paragraph colour after the class rule. Cosmetic, consistent, and left alone: fixing it means
a higher-specificity rule, a regeneration of all 46 files and a re-paste of every saved template,
so it is a decision for after the paste waves, not during them.

**The page background is painted on the row tables and the body, not only on the `.body`
table.** In `order_invoice` and `pending_payment_failure`, the stock "Amount to pay" block puts a
`<table>` directly inside a `<tr>` with no `<td>` in the branch where nothing has been paid yet.
HTML parsers recover by closing the enclosing tables early, so the `.body` table (the one that
carried the pale-blue background) ended before the footer and the navy footer sat on plain white.
The stock markup is Shopify's and the body stays byte-identical, so the fix is the stylesheet:
`body`, `.header`, `.content`, `.section` and `.footer` all carry the page colour, which is
invisible where the nesting is sound and restores the surround where it is not. Found on the
wave-2 preview of `pending_payment_failure`; the static stock files balance their tables, so a
count of open and close tags would not have caught it. Only a render does. The same recovery
leaves an empty `subtotal-lines` table behind, and its 15px top margin and 1px top border draw a
hairline under the card, faint on white and bright under a dark-mode recolour. That one cannot be
styled away, since the class is shared with the real subtotal table, so the generator gained a
`replace` override (exact substring, exactly once, refused on overlap) and the two templates'
manifest entries give the broken branch the cell it lacks. The page-colour rules stay: they cost
nothing and cover any similar stock bug not yet found.

**On a phone, each card is its own table, so each card can end up its own width.** A test send
opened in the Proton Mail Android app showed the header, the body cards and the footer at three
different widths, stepped against each other, where the web preview shows one column. The app
overrides table widths to auto (capped at the screen), so a card ends at the larger of the stock
94% mobile width and its own unshrinkable content: the header at the logo image's fixed width, an
order card at a nowrap price row, the footer at the social row. Reproduced in Chrome with a
411px mobile viewport and `table { width: auto !important; max-width: 100% !important }`
injected; the squeeze test (force each card to 200px, list what stays wider) named the culprits.
The stylesheet now lets the logo scale inside its cell (`max-width: 100%`), and a media block
gives `.container` a fixed table layout under 600px so content wraps inside the card instead of
stretching it, with the social row's cell padding trimmed to fit. Every card then measures the
same width at the same left edge. A second test send showed one more seam, a thin line between
the header and the body card: Shopify's own mobile stylesheet gives `.header` a 2px bottom margin
under 600px, so the brand media block zeroes it. The dark surfaces in the same screenshots are the app's dark
mode recolouring the white and pale-blue cards; `color-scheme: light only` on the page table is
Shopify's own technique for its Shop-app button and is applied as an opt-out hint, with no
guarantee every client honours it.

**Per-template versions, auto-bumped, stamped twice, and a skill that owns the lifecycle.** During
the first paste session the shared stylesheet changed four times and the generator twice, and every
change regenerated all 46 files and silently put every already-saved template one step behind the
repo, with nothing in Admin to say which bytes a template held. Each manifest entry now carries a
`version` and a `brandedSha256`; `generate` seeds and bumps them itself and `check` refuses
disagreement, so an un-bumped change cannot merge. Decisions worth keeping: the hash is of the
generated output, not the inputs, so a `reason` edit or a byte-identical re-record does not bump;
the stamp lives in two places because the Liquid comment is what the editor shows and the HTML
comment is what survives into a sent email; `sync` decides what to paste by bytes (length plus
FNV-1a of the editor document) and treats the version as information, because a `git revert` moves
a version backwards on purpose; the skill clicks Save itself but only after the paste is
byte-verified, and re-verifies after a reload, because the first session found that an unsaved
paste and a saved one look the same in the editor; one STOP covers a whole `sync` batch, the
operator's call, since the batch is up to 46 identical mechanical writes each verified before and
after; and the render checker is a tag-stack walker rather than regex, which is what produced three
false positives in the first checker (the navy test matched the row tables, not the containers).
The browser probes are committed files run under `node:vm` by the tests so the FNV in the browser
is provably the FNV in Node. The first end-to-end run of the `change` mode paid for the byte check at
once: the editor held one character too many after the paste, a U+FEFF from the byte-order mark
`clip.exe` had been fed, and the check stopped the run before Preview; the fix is to send
UTF-16LE with no mark. The same run found that the Preview dialog's iframe is an `about:srcdoc`
frame no init script reaches, so the render is read from the `EmailTemplateGeneratePreview`
response instead, and that a clean editor shows neither a Save nor a "Revert changes" control,
so the stock signal the skill trusts is the document's bytes equalling `stock/<id>.liquid`.

**Repo weight.** 92 template files (46 stock, 46 generated) of a few tens of KB each. Git stores
them delta-compressed and the generated file differs from its stock twin by three hunks, so the
packed cost is well under the on-disk size. `npm run notifications:check` in CI refuses a generated
file that drifts from what the generator would produce, and `npm run notifications:test` covers the
generator itself; `.gitattributes` pins LF for the directory because the generator refuses a
carriage return.

## Gift cards are emailed, and do not count toward the free-shipping threshold (unreleased)

Checkout excludes digital gift card value from price-based shipping rate conditions. This is
platform behaviour, not a store misconfiguration: a gift card never enters a shipment, and the rate
tiers evaluate the shippable merchandise subtotal. It is undocumented and changed silently around
late 2023. **The decision is to accept the platform semantics and make the theme say so
accurately**, rather than to work around it with a shipping-rate script or a discount.

Verified at live checkout on 2026-08-31, three carts, all abandoned before payment:

| Cart | Shippable subtotal | Order total | Shipping charged |
| --- | --- | --- | --- |
| $65 garment + $50 gift card | $65 | $115 | $8.00 Economy |
| $50 gift card only | $0 | $50 | no shipping step at all |
| 2 x $65 garment (control) | $130 | $130 | FREE Economy |

So the free tier is real and works; it simply does not see the gift card. The storefront was
promising the opposite on the middle case.

Three things worth keeping:

- **`requires_shipping` is the predicate for all shipping math and gating**, because it is what
  checkout itself evaluates. `gift_card?` is used only where the copy is specifically about gift
  cards (the product-page delivery line). That rule generalises: a future non-shipping item gets
  the right treatment with no further edits.
- **Three nil accessors, one of which was load-bearing.** The product drop spells it `gift_card?`
  and `blocks/price.liquid` was reading `gift_card`; the cart snippets were reading
  `item.product.gift_card`, which is nil on every line item. So the gift card page advertised
  "$8.00 shipping within the USA" and a gift-card-only cart showed the flat-rate line. The third
  site, `snippets/cart-products.liquid`, was excluding gift cards from the variant list and the nil
  accidentally produced the behaviour we want (the denomination is the option, and the customer
  needs to see it), so that clause is now gone rather than fixed: the intent is expressed directly.
- **The threshold math sums `final_line_price` over `requires_shipping` line items.** Assumption,
  accepted rather than tested: Shopify evaluates the rate condition against the *discounted*
  shippable subtotal. The store runs no discounts today, so there is nothing to test against; if
  discounts are ever introduced, re-verify this at checkout before trusting the cart message.

The "Free-shipping progress bar in the cart" entry below reads the Admin policy as "$8
flat under $75, free at $75+". That is still right, with the qualifier this entry adds: the
comparison is against shippable merchandise, not the order total. The bar and its sentence now
derive from the same shippable subtotal, so they cannot disagree with each other or with checkout.

Sequencing: the theme goes conservative first and the `/policies/shipping-policy` edit follows the
deploy, so the storefront never over-promises relative to policy.

The shipping-copy contract in `docs/theme-settings-contracts.md` names four sources of truth, and
this change moves two of them (the in-repo copy, and the shop policy in the step above). The third,
the announcement slides in `sections/header-group.json`, is **deliberately left unqualified**: they
are two lines of rotating banner ("$8.00 Flat Rate Shipping on Orders under $75.00" and "Free
Shipping on Orders $75.00 and up"), and a mixed-cart caveat would swamp them. Both slides link
`shopify://policies/shipping-policy`, which carries the exception, and the gift card's own product
page states it where a gift card buyer will actually read it. The fourth source, the Admin rate
names, needs nothing: they are "Economy" and "Expedited", which make no threshold claim.

## An illustration on the 404 page, and the transparency trap behind it (unreleased)

`templates/404.json` gains an `image` block above the "Page not found" heading: a black line-art cat,
sized to 10% of the content column on desktop and 35% on mobile so the heading and the "Continue
shopping" button stay above the fold. Settings-only, no new code.

Two things worth keeping from how the asset got there.

**An AI image generator will hand you the transparency checkerboard as pixels.** The first upload
looked transparent in every preview, but the file was a JPEG with no alpha channel whose background
was two greys, roughly `#e4e4e4` and `#fafafa`, alternating in squares: the generator had drawn the
checkerboard that *represents* transparency and then flattened it. On the white 404 page that renders
as a grey checkered box around the cat. It is invisible in a thumbnail and obvious at full size, so
check the alpha channel rather than the preview: a file with `channels: 3` and no `hasAlpha` is opaque
no matter what it looks like. The fix was to rebuild alpha from luminance (opaque at or below 100,
transparent at or above 200, which keeps the antialiased stroke edges while discarding both checker
greys and the JPEG ringing beneath them), force the ink to pure black, and trim to the drawing.

The durable lesson is to stop asking a generator for transparency at all. Ask for a solid white
background, which is what `scheme-1` renders on anyway, and rebuild the alpha locally where the
result can be measured. The second-pass asset was generated that way and came back clean on every
check: white ground at 254 to 255, ink at 0, and a maximum RGB channel spread of 5.

**`blocks/image.liquid` calls `image_tag` without an `alt:` parameter**, so for an `image_picker`
setting the rendered `alt` is whatever alt text the Files asset carries in Admin. (The scoping
matters: `image_tag` falls back to the resource title for article, collection, line item, product and
variant images, so the theme's other no-`alt` call sites do not behave this way.) An empty Admin alt
is the correct outcome here, because the illustration restates "Page not found" and should be skipped
by a screen reader rather than announced to someone who just hit a dead link.

The consequence is that this block's a11y behaviour is a property of Admin, not of the repo. CI is
not blind to it: `scripts/a11y/paths.json` lists `/404-intentionally-missing`, so `pa11y-ci` renders
and audits this page on every PR, and an `<img>` with no `alt` attribute at all fails axe's
`image-alt`. What CI cannot distinguish is a deliberately empty alt from a filled one, since both
pass. So leave the alt on `404-image.png` empty on purpose; "fixing" it in Admin would reverse this
decision silently, with the repo and CI both none the wiser.

## The 404 card joins the standard, and the real holdouts turn out to be the product pages (unreleased)

`templates/404.json`'s "Discover something new" card was the last template still carrying the
pre-standard card the theme editor emits by default: gap 4, inheriting the section's colour scheme,
square corners, an `adapt` gallery and an `rte` title. Its block structure was already right, so this
is a settings-only edit; the four blocks now match `templates/collection.json` field for field,
block IDs and order untouched.

Worth recording is what checking the "only remaining copy" claim turned up. It was true as written,
because it was written about the gap-4 shape, and 404 was the only template with that. It was not
true of the standard: all six product templates' "You may also like" cards sit on a near-identical
pre-standard shape that differs only in having gap 8, so a grep for the marker the TODO named missed
them entirely. `docs/theme-conventions.md` said 404 was the known holdout; that sentence now names
the product templates instead. They are deliberately left as they are, and the record of the
divergence lives in that doc rather than in `TODO.md`: it is a styling judgement to make when
someone next touches those templates, not queued work.

Their `show_shipping_info: true` is not part of that drift. The product-page rule in
`docs/theme-settings-contracts.md` puts the shipping note on product-page surfaces, so it stays
whichever way the styling decision goes. The general lesson: a divergence recorded by one of its
symptoms gets closed when that symptom goes, while the divergence continues elsewhere under a
different value. Describe the shape the standard requires, not the wrong value one instance had.

The doc now also names where the pre-standard shape comes from, which it never did: the `presets`
blocks in `sections/product-list.liquid`, `sections/product-recommendations.liquid`,
`blocks/product-recommendations.liquid` and `blocks/product-card.liquid` all emit
`product_card_gap: 4` with an `adapt` gallery. Placing a card in the editor and leaving it produces
the pre-standard shape by default, so the drift is re-seeded on every new template until someone
copies the standard over it. The holdout list is written out in full there rather than by its most
visible symptoms, for the same reason the gap-4 marker failed.

Nothing in CI compares one template's card to another's, so the only checks behind this are the
written table in `docs/theme-conventions.md` and a hand-run field diff at edit time.

## Go to cart page after adding (unreleased)

A new Cart setting, `redirect_to_cart_on_add` (default off, visible only when `cart_type` is
`page`, mirroring how `auto_open_cart_drawer` gates to drawer mode), navigates to the cart page
after a successful add. Two decisions worth keeping:

- **It is an event listener, not a `product-form.js` edit.** Horizon's adds are always AJAX and
  `assets/product-form.js` is upstream code; a document-level listener in
  `snippets/cart-redirect-on-add.liquid` (rendered from `layout/theme.liquid` only when the
  setting is on) keeps upstream merges clean.
- **The listener filters on `source === 'product-form-component'` and skips `didError`.**
  `CartAddEvent` dispatches under the shared `cart:update` name, which `CartUpdateEvent`
  (cart-page quantity edits) and quick-order-list changes also use; without the source filter,
  editing a quantity on the cart page would reload it, and a failed add would still navigate.

Known and accepted trade-off: every successful add navigates, interrupting multi-item adds from a
collection. That is the intended "review before checkout" flow, not a bug.

The setting is enabled for this store in `config/settings_data.json`. The schema default stays
`false` (a checkbox default only applies where settings_data carries no value), so shipping the
snippet without the settings_data entry rendered nothing; the first preview test failed exactly
that way.

## Free-shipping progress bar in the cart (unreleased)

`snippets/shipping-info.liquid` now renders a progress bar toward the free-shipping threshold in
cart context (drawer and cart page, via the shared `cart-summary` snippet), with a "You're $X away
from free shipping" line below it. Two decisions worth keeping:

- **The bar is `aria-hidden` and there is no `aria-live` region.** The sentence carries the state
  for assistive tech, and the cart re-renders by section morphing; a live region inside morphed
  DOM risks duplicate or spurious announcements on every quantity change. The drawer's existing
  quantity announcements already cover the update event.
- **The bar disables itself unless the parsed threshold is greater than zero.**
  `free_shipping_threshold` is a free-text setting, so a cleared value, or one like "$75" that
  Liquid coerces to 0, would otherwise pin the bar at 100% permanently with no error anywhere.
  The pre-existing text line's behavior on a bad value is unchanged.

The Admin shipping policy was read before building this (US-only shipping, $8 flat under $75,
free at $75+, threshold pre-tax), so the bar's promise matches checkout. If the threshold ever
changes, the setting, the Admin rate, the shop policy, and the announcement slide all move
together per the shipping-copy contract in `docs/theme-settings-contracts.md`.
## Smoke and CI: transient failures retry, answers do not (unreleased)

The smoke test's auth step retried `429` **or any `>= 500`**, with a comment saying the storefront
password endpoint "intermittently 503s under bot management". Every other network call in the CI
path retried `429` only, or not at all. So the exact transient the auth step was written to absorb
HARD-FAILed a deploy on any content probe. Observed on PR #137: the live push succeeded, then three
paths returned `503` with no theme id while eight near-identical ones passed, and all eleven were
healthy minutes later. That failure mode is expensive in a specific way: the theme is already live
by the time the smoke runs, so a false HARD-FAIL leaves live serving the new SHA with the PR
unmerged and `main` behind, recoverable only by a manual re-`deploy`.

**One predicate now, shared by every request the file makes.** `isRetryableStatus` in `smoke.mjs`
retries `408`, `429`, `502`, `503`, `504` and thrown network errors; the content probes, the root
mode-detection probe, the `/password` fallback, both sitemap fetches and **both halves of the auth
step** (the cookie-seed GET and the password POST) all route through it. `Retry-After` is honoured
when present (delta-seconds or HTTP-date), clamped to 30s.

Converting the POST was the second half of the fix, and it nearly did not happen. The first pass
left the POST hand-rolling its old `429 || >= 500` test while the comment above it claimed the
predicate was shared by everything, which is the same class of drift the change exists to end: a
`408` POST went unretried while a `408` GET was retried, a `501` POST was retried while a `501` GET
was not, `Retry-After` was ignored there, and its sleeps counted against neither the budget nor the
breaker, so the run's stated 120s cap could be silently overrun by 28s. The predicate is only worth
having if nothing is allowed to keep a private copy of it. `authenticateStorefront` still creates
its own budget when called outside a run, because `scripts/a11y/get-auth-cookie.mjs` imports it and
has no run to account against; its sleeps are bounded by the same policy either way.

**`500` is retried at most once, and that asymmetry is deliberate.** A broken Liquid template
`500`s deterministically. Retrying it to the cap would spend the run's budget on a failure that is
going to stand anyway, and slow down the report an operator needs. One retry buys the genuine
edge-`500` case without paying for the template case.

**Exhaustion classification is unchanged, and that is the point.** A `429` that survives its
retries is still a SOFT-WARN; a `5xx` that survives is still a HARD-FAIL. So a bot-management event
that persists past the retries still blocks the deploy. That trade was taken knowingly: silently
greening a deploy nobody could verify is worse than a slow, loud, manually re-triggerable failure.
The widened predicate makes the smoke survive weather, not blindness.

**Why a run-scoped budget, not just per-probe retries.** Products are probed sequentially and there
can be ~200 of them. The thing unbounded retries actually threaten is not the `deploy` job's
`timeout-minutes: 15`, which is what the first draft of this note claimed: the product loop already
had its own 240s deadline (`SMOKE_MAX_SECONDS`), and overrunning that soft-warns the unprobed
remainder rather than timing out the job. What they threaten is **coverage**. Retry sleeps are wall
clock against that same deadline, so a degraded edge can spend half the probing window asleep and
green a deploy having checked a fraction of the catalogue. So a budget object threads through every
probe and through the auth step: a total retry-sleep cap (120s) plus a breaker that disables
retrying entirely after three probes exhaust theirs on a `5xx` or network error. A `429` exhaustion
deliberately does not count toward the breaker, since throttling is already a SOFT-WARN and a
busy-but-healthy storefront must not disable retries for the rest of the run. Nothing is silently
absorbed: one stderr line per retry, plus a `retries: ...` line in the smoke output when anything
was retried, on every exit path including the auth-rejected HARD-FAIL, which is precisely the branch
an operator is diagnosing when the retry evidence matters. No jitter, deliberately: the probes are
sequential, so there is no herd to spread, and deterministic delays keep the unit tests'
`sleep.delays` assertions exact.

**The sitemap index is not just another probe.** A failure there zeroes product coverage for the
whole run, where a content probe's failure costs one path, so the index fetch gets three retries
rather than the backoff array's two. `fetchWithBody`'s `fetchImpl` call was also not inside a
try/catch, so a single network throw during enumeration collapsed the run to structural-only with
zero product coverage. It is caught and retried now, and only rethrown once the attempts are spent,
so the existing "enumeration skipped" SOFT-WARN path is reached exactly as before.

**`action.yml`'s pre-push `theme list` got the same treatment, plus a stderr filter.** It is a
read-only GET, so retrying is idempotent by construction; three attempts with backoff (10s then
20s) and a per-attempt `timeout 60s`. It does **not** retry on an auth or permission answer: those
are not weather, and sleeping out the backoff before reporting a rotated token helps nobody.

Two things about that filter are worth the words, because the obvious version of it is wrong in
both directions. Bare digit alternatives (`401|403`) match durations and byte counts, so
`Timed out after 401ms` and `Done in 4031ms` both read as auth failures and abandon the retry on
exactly the transient it exists for; the codes are anchored to a status context instead. And
`unauthoriz` does not match `not authorized`, the spacing Shopify actually uses, so the real
permanent failures were the ones being retried. A timeout is also short-circuited ahead of the
filter: exit 124 or 137 means no answer was received, so no answer can have been classified, and a
fragment of partial output must not be pattern-matched as one. The captured stderr is now printed
back on the failure path, through the same ANSI-strip and token-redaction `scrub()` the Push step
uses. Capturing stderr to a file is what stops the CLI printing it, so without that the change
would have made a failed `theme list` undiagnosable from the run log: the redirect was the only
sink those diagnostics had. The step also needed `set +e`, for the same reason the Push step
documents at length: the composite default shell's injected `-e` kills the step on attempt 1, before
any retry or exit-code capture can run. The two existing push retry loops were left alone;
consolidating all three into one helper is backlogged, not done here, because the three have
genuinely different retry semantics (exit 97, theme-ID re-resolution) and folding them together
under a deploy-critical path was more risk than the duplication costs.

**A coupling worth knowing about**: `preview.yml`'s cleanup job had `timeout-minutes: 5`, and the
list retry's worst successful case is now ~3.5 minutes on top of checkout, `npm ci` and a delete
loop that allows `timeout 2m` per theme. Overrunning that cap cancels the job mid-delete, which
leaks a preview theme that nothing sweeps up: the exact outcome the job's `cancel-in-progress:
false` exists to prevent. Raised to 10 minutes, with a comment naming the arithmetic so the next
person to change either number sees the other. Nothing lints composite-action shell in this repo
(CI's `actionlint` walks `.github/workflows/` only, so its `SHELLCHECK_OPTS` never reaches the
largest shell script here), which is why that coupling had to be found by reading.

**The composite-action shell is linted now, by extraction.** That last paragraph's parenthesis was
the backlog item: `actionlint` walks `.github/workflows/` only, and it has no composite-action mode
to walk anything else with. Handed a `.github/actions/**/action.yml` directly it parses the file as
a workflow and reports `"jobs" section is missing`, having linted no shell at all, so the step's
`SHELLCHECK_OPTS` never reached the largest shell script in the repo. The CI step is now
`actionlint + shellcheck`: `scripts/lib/composite-shell.mjs` pulls each `run: |` body out to its own
file and shellcheck lints those, plus any `lib/*.sh` a composite action sources.

**Extraction beat committing the shell as `.sh` files**, which was the other option. Moving ~450
lines of deploy-critical shell out of `action.yml` and into files loaded at runtime is a change to
how the live push executes, and it was proposed in the same PR that rewrites the retry loops those
lines contain. Extraction changes nothing about how the action runs; it only reads it. The cost is
that the extractor is a line scanner rather than a YAML parser (`scripts/lib/` takes no
dependencies), so the risk it carries is silent under-coverage: a scan that stops matching leaves
shellcheck linting an empty directory, and a green row looks identical either way.

So it **fails closed three ways**, and each one is the answer to a way this could have been
worthless. A `run:` key in any form other than `run: |` (`|-`, `|+`, `|2`, `>`, a trailing comment,
a single-line body) exits non-zero naming the line, with the counting scan deliberately broader than
the extraction scan so a variant cannot pass by uncounted. Zero extracted bodies is an error, not an
empty success. And a `${{ }}` surviving into a body is an error: it is not valid bash and would
spray parse errors across the row that gates auto-deploy. The CLI also prints `extracted N run
bodies`, because "green" and "green having linted nothing" are otherwise indistinguishable from
outside, and a unit test runs the extractor over the repo's real `action.yml` files so drift fails
`npm run lib:test` rather than first appearing as a red CI row.

Two consequences worth recording. `setup-shopify-cli`'s `run: npm ci --ignore-scripts` was the
repo's only single-line `run:`, and guard 1 refuses that form, so it is block form now; one shape
everywhere beats a parser that has to guess. And the composite pass gets its **own** options
variable rather than sharing `SHELLCHECK_OPTS`: extraction structurally forces `SC1091` (the
runtime-resolved `source` in commit 2 cannot be followed from an extracted file), and a suppression
that extraction forces must not quietly weaken linting of `.github/workflows/`, which has none of
the same excuses.

**Declaring a separate options variable did not achieve that, though, and the reason is worth
knowing: shellcheck reads `SHELLCHECK_OPTS` from the ENVIRONMENT, not only from actionlint.** The
variable is a step-level `env:`, so the composite pass inherited the workflow suppressions and ran
with `-e SC2016 -e SC2317 -e SC1091` while a comment three lines above claimed the opposite. It
changed nothing on the day (both option sets are clean over these files), which is exactly why it
would have gone unnoticed until it mattered: `SC2317` in particular is the check most likely to fire
on `retry.sh`, which is built on indirect dispatch, and that is the shape that both provokes
unreachable-code false positives and can hide real dead code. The invocation clears the variable on
the command line now, and adds `--norc` so a future repo-root `.shellcheckrc` cannot widen the pass
either. README's local recipe does the same, and says why. shellcheck itself is pinned to 0.10.0 by download, the same pattern the step
already used for actionlint: a runner-image bump must not be able to flip an auto-deploy gate with
zero repo changes.

The first run found **nothing** in either composite action, which was not the expectation. Two rules
that were forecast do not fire: shellcheck does not raise `SC2154` for all-caps names, so the
composite `env:` variables (`$MODE`, `$LIVE_THEME_ID`, `$PR_NUMBER`) need no annotations, and it
does not raise `SC2086` for an unquoted variable inside the command substitution of a `for ... in`
list, so `for i in $(seq 1 $ATTEMPTS)` passed. Both loops are gone in the next commit anyway. A
clean first run is the weakest possible evidence that a lint works, which is exactly why the body
count is printed and asserted rather than inferred from the colour of the row.

**The three retry loops are one engine and three named policies now.** The note above says the
consolidation was backlogged because "the three have genuinely different retry semantics". They do,
and that turned out to be the design rather than the objection: the differences are exactly three,
they are all hooks, and each one is a function.

| | live push | preview push | `theme list` |
|---|---|---|---|
| run attempt | `run_push_attempt` (audits, synthesises 97) | same, plus theme-ID re-resolution | direct, stderr to `list.err` |
| classify | `retry_always` | `retry_always` | stop on the auth/permission stderr pattern |
| before retry | flat 60s, 0s on 97 | flat 30s, 0s on 97, re-resolve the theme ID first | linear `i * 10`s |

**The policies live in `retry.sh` too, not inline in `action.yml`, and that placement is the whole
point.** The engine is the boring part. What breaks production is exit-97 handling, the preview
theme-ID re-resolution and the transient-only stderr filter, and those are only unit-testable if
they are functions in a file a test can source. Leaving them inline would have produced a suite that
tested a generic loop while the three behaviours that actually cost money stayed uncovered.
`retry.test.mjs` spawns a real `bash`, stubs `sleep` as a shell function (so it shadows the command
`retry_sleep` calls, rather than exercising a parallel path), and asserts on the recorded backoff
arguments, never on wall-clock time.

**A timeout retries; it does not stop.** Exit 124, or 137 after `--kill-after`'s SIGKILL, means no
answer was received, so no answer can have been classified: the classify hook is skipped entirely
and the attempt counts normally toward the cap with its usual backoff. Writing that down because
the other reading of "short-circuit on 124" is "stop retrying", which would quietly reverse the
widening this whole change is about. There is a test for both halves, including one where the
partial stderr says `not authorized` and the exit code is 124, which must still retry.

**The engine suite runs twice, the second time under `bash -euo pipefail`.** That is the composite
default shell GitHub injects (plus the `-u` both callers set), and an `errexit` interaction is the
specific regression this refactor was most likely to reintroduce: a failed attempt 1 killing the
step before any capture or retry. A non-`-e` harness passes straight through that.

**Writing that harness is where this nearly went wrong, and the shape of the mistake is worth
keeping.** The first version spawned `bash -eo pipefail` and then called `retry_run ... || :` in
every case, mirroring how the callers tolerate a non-zero return. But **bash disables `errexit` for
the entire dynamic extent of a function called on the left of `||`**, so `set -e` was off inside
`retry_run` and every hook it called: seven doubled tests and one standalone test, all asserting
that the option was handled, none of them running with it on. Deleting the `|| :` guard from
retry.sh's own loop left the suite fully green, including the case commented "the historical
regression, verbatim". Production calls `retry_run` bare and relies on `set +e`, and with a bare
call that same mutant dies on attempt 1 with empty stdout.

The fix is to call `retry_run` bare in the harness too and move the reporting into an `EXIT` trap,
so the assertions survive the exit they exist to detect. The mutation now fails the suite, which is
the only evidence worth having that a test of a shell option tests anything. The general lesson: a
harness that tolerates the failure it is testing for has usually disabled the thing under test. Two consequences in the helper itself. The hook dispatch is
`"$run_fn" "$i" || :` (not `cmd || retry`; the attempt's real code is always captured explicitly
into `RETRY_EXIT` by the hook), and every command whose exit code is wanted is captured in condition
context (`if cmd; then rc=0; else rc=$?; fi`) rather than by a bare `$?` on the line after. The
callers' `set +e` stays load-bearing and keeps its comment; sourcing a file does not change shell
options.

**`scrub()` had drifted into two definitions and is one now.** The List step's copy lacked the
delimiter neutralisation the Push step's had. Consolidating the function is not by itself the fix,
because the sinks are separate: `list.err` is a direct-to-file capture on two different failure
paths, and `require_json`'s dump of a non-JSON report was doing a bare ANSI strip with no token
redaction at all. All of them route through the one definition now. The `GITHUB_OUTPUT` heredoc
delimiter is also generated per run instead of the fixed `GHEOF`; the scrub already neutralised a
forged delimiter line, so this is defence in depth rather than a hole being closed. For the record,
the reviewer's related worry does not apply: nothing evaluates the captured text as shell, the body
is written with `cat file | scrub | tail` and never expanded.

**One budget coupling that this change makes sharper, stated because the comment first written here
got it backwards.** `timeout-minutes` on the calling job does not bound the retry loop to a safe
stopping point; it cancels the job. The live push's `3 x 8m` plus backoff is 26 minutes against
`deploy.yml`'s 15, which predates this change, but the list retry adds up to 3.5 minutes *ahead of*
the first push attempt and so converts previously survivable runs into cancellations. A cancelled
`deploy` job skips every step after the push: no report comment, no squash merge, no marker, and a
live theme left half-pushed, which nothing self-heals. The caps and the job budget are one coupled
pair and `retry.sh` now says so at the point where the numbers live. Reconciling the numbers
themselves is a separate decision about how long a live push may take, not a comment fix.

**Two smaller things folded in while both steps were open.** The preview loop's in-loop theme-ID
re-resolution (`npx shopify theme list --json > themes-retry.json`) had no `timeout` and no retry;
it was the one unbounded CLI call left on the preview path, and it now takes the same per-attempt
bound as the push. And `deploy.yml`'s `Query live theme` deliberately does **not** adopt the helper,
with a comment there saying so: it only fills a string in the deploy-report comment, it is
`continue-on-error: true` so a blip already degrades to "unknown", and adding up to 30s of backoff
to a live deploy report buys no reliability. The `delete-preview` loop stays unretried for a
different reason: it is a per-theme loop, not a retry loop, and a delete failure is already
surfaced through `cleanup_status` and the preview-cleanup warning.

**Residual risk, stated rather than papered over.** The preview push in `validate.yml`'s
`deploy-preview` job is the only real traffic this helper sees before merge. The live-push policies are covered by unit tests and by
nothing else until the next production deploy, so the first post-merge deploy's Push step output is
worth reading rather than treating CI green as full confidence for that path.

**Zero product coverage now HARD-FAILs, which reverses what this note said two paragraphs up.**
"The existing 'enumeration skipped' SOFT-WARN path is reached exactly as before" was true when it
was written and is not the behaviour any more. The reason it had to change: the structural probes
satisfy the `>= 1 PASS` rule on their own, so a run whose sitemap was unreachable greened having
verified no product page at all. That is the failure the smoke exists to catch, greening.

One rule, stated as a table so there is no room to implement it two ways:

| enumeration | products probed | verdict |
|---|---|---|
| failed (index or child non-OK / threw after retries) | 0 | **HARD-FAIL** |
| succeeded, sitemap lists no products | 0 | SOFT-WARN (exempt) |
| succeeded, products enumerated | 0 (deadline hit first) | **HARD-FAIL** |
| failed partway, earlier children yielded paths | >= 1 | normal run, plus a partial-coverage warn |

**The failure flag never hard-fails on its own; only zero probed products does.** Partial coverage
is coverage: a run that probed real product pages must not be blocked because a later child sitemap
failed. The flag exists only to separate row 1 from row 2.

**Separating those two rows needed one fix in `fetchWithBody`.** A non-thrown retryable status that
exhausted its attempts fell through to `return await res.text()`, so a persistent `503` error page
was parsed as XML, yielded zero locs, and was indistinguishable from an empty catalogue: the
difference between "we could not look" and "there is nothing there", which is exactly what the new
rule turns on. It throws on a spent non-OK status now. The blast radius is bounded and was checked
rather than assumed: `fetchWithBody` has exactly two call sites, both inside the enumeration `try`.
Product and structural probes go through `fetchObservation`, untouched.

**One carve-out, because the naive version breaks an empty store.** `/sitemap_products_1.xml` is a
GUESS, used only when the index parsed and named no product sitemap at all, which is what an empty
catalogue looks like. A guess that misses is not evidence of an outage, so a non-OK there does not
set the failure flag. Without that, an empty store would be permanently undeployable.

**Known limit, deliberately accepted:** a CDN error page served with a `200` parses to zero locs and
lands in row 2 (SOFT-WARN), not row 1. It is not reliably distinguishable from an empty catalogue,
and the empty-catalogue exemption is what stops a legitimately empty store being blocked forever.
There is a test pinning that behaviour, so it is chosen rather than accidental.

**Two failure messages, not one, because the recoveries differ.** Row 1 says the sitemap was
unreachable after N attempts: likely Shopify-side weather, re-`deploy` when it clears. Row 3 says
the time budget was exhausted before any product was probed: that wants a longer
`SMOKE_MAX_SECONDS` or a smaller `SMOKE_MAX_PRODUCTS`, not a retry. Both state the same recovery
context, because it is the expensive part of this trade: **the theme is already live by the time
the smoke runs**, so a block leaves live serving the new SHA with the PR unmerged, recoverable by a
`deploy` comment. That cost was accepted knowingly. A Shopify-side sitemap outage can now fail a
deploy the theme did not break. Blocking on genuine exhaustion is the condition it was accepted
under, and there is retry underneath it: the index gets three attempts, the children get the
backoff array, both inside the run-scoped retry budget.

One piece of incidental evidence worth recording. Many existing tests serve a 200-but-empty sitemap
and expect exit 0, and they still pass. The empty-catalogue exemption is what keeps them valid,
which is direct evidence it is load-bearing rather than a theoretical nicety.

**A failed child sitemap costs its own slice and no more.** The first cut of this rethrew out of the
child loop, so one bad shard skipped every later child and could zero the coverage of a catalogue
that was otherwise entirely reachable, hard-failing the deploy over it. The failure is counted and
the loop continues; only the total decides the verdict. That also means the two failure causes need
different words, because they are reached after different attempt counts: the index gets its own
retry count, a child gets the backoff array, and both are reported as **requests** rather than
retries (`fetchWithBody` spends its retries on top of the first attempt, so calling the retry count
the attempt count undercounts every message by one).

**A non-positive `maxProducts` is now refused rather than reported as an empty store.** It broke out
of the child loop before the first fetch, leaving zero paths with no failure recorded, which landed
on the empty-catalogue exemption: the entire zero-coverage rule silently off, and the deploy report
asserting the catalogue was empty when nothing had been looked at. `envConfig`'s `posInt` already
rejected a non-positive `SMOKE_MAX_PRODUCTS`; the guard covers the programmatic callers it does not
sit in front of.

**Aggregate verdict lines count toward the deploy comment's summary now.** `renderSmokeMarkdownTable`
only tallied lines matching the per-path row shape, and the aggregate lines (`sitemap SOFT-WARN: ...`,
`/password HARD-FAIL - AUTH: ...`) have no status/host/theme, so they render as notes. Until this
change every aggregate line was a SOFT-WARN and leaving them out of the tally happened to be
accurate. A run can now exit 1 on an aggregate line alone, which would have printed
`N passed, 0 warned, 0 failed` directly above a failed deploy.

**Recorded as a won't-do, since the item is gone from `TODO.md`:** distinguishing a surviving `5xx`
from a first-shot one with a distinct reason string, so a real outage reads differently from a
broken template in the deploy report. Not done. The retry evidence is already in the run, in the
per-retry stderr lines and the `retries: ...` summary line, and splitting `server error 503` into
two reason strings adds a classifier branch to earn a distinction an operator can already make from
the line above it.

## Contact routing, and two button rules that fail silently (unreleased)

The footer's "Contact" link and the Admin main menu's "Contact" item disagreed: the footer went to
`shopify://policies/contact-information` while the nav went to `/pages/contact`. **Both now go to
the Contact information policy**, `/policies/contact-information`.

That is the opposite of the obvious fix, and the reason is what the policy actually contains. It is
not a bare legal notice; it carries the phone number, the note that email is the faster route, and a
link on to the `/pages/contact` form. So it works as the contact landing page, with the form one
click away, while `/pages/contact` is the form alone and mentions the phone number nowhere. Sending
both "Contact" entry points there means a customer who would rather call can find the number, and
one who wants the form is one link from it.

Two things deliberately did **not** change. The twelve inline calls to action in
`templates/page.faq.json` and `templates/page.custom-orders.json` ("message us", "send it over",
`/pages/contact?subject=custom-order`) still go straight to the form: those are mid-sentence prompts
to *do* something, not navigation, and routing them through a policy page would add a hop to an
action the sentence already committed the reader to. And `/pages/contact` itself stays exactly as it
is, including its `templates/page.contact.json` template and its `scripts/a11y/paths.json` entry.

**The `contact` branch in `blocks/footer-link.liquid` is the one branch with a hardcoded URL, and it
has to be.** Liquid's `shop` object exposes `privacy_policy`, `refund_policy`, `terms_of_service`,
`shipping_policy` and `subscription_policy`, and nothing for Contact information, so unlike its five
siblings this branch has no policy object to resolve a `url` and `title` from. That is why the
schema option labelled "Contact information" used to resolve to a *page*: nobody had a policy object
to hand. Its default label is now "Contact information" rather than "Contact", matching the policy
titles the sibling branches inherit; the footer block overrides it to "Contact" for the visible link.

**A link-color rule inside a rich-text container has to carve out `.button`, or it repaints the
label.** `snippets/policy-page.liquid` styled `.shopify-policy__body .rte a` with no exclusion. A
policy body is Admin rich text, so an operator can paste `<a class="button">` into it, and the
Contact information policy ends with exactly that. The two-class selector scores (0,2,1) against
`.button`'s own `color: var(--button-color)` at (0,1,0), so it won and painted the label
`--color-primary`, which on scheme-1 is `#000000cf`, over `--color-primary-button-background`, which
is `#000000`. The result was a solid black box with no readable text. It rendered that way for as
long as the rule has existed; it only became visible when the nav and footer started pointing at
that page.

The fix is the carve-out `assets/base.css` already uses for its own `.rte` link rule:
`a:where(:not(.button, .button-primary, .button-secondary))`. `:where()` keeps the specificity at
(0,2,1) so ordinary policy links are unchanged. Nothing in CI catches this class of bug and no policy
page appears in `scripts/a11y/paths.json`, so contrast tooling never saw it either. Contact
information is currently the only policy body containing a button-classed link; the other four have
none.

**`blocks/contact-form-submit-button.liquid` emitted both a hardcoded `button` class and the
selected `style_class`.** With the style set to Secondary the element carried `button` and
`button-secondary` at once, and because `.button-secondary`'s custom-property block in
`assets/base.css` comes after `.button`'s, secondary silently won: transparent background, black
text, on a button the editor still labelled Primary. The block now emits only
`style_class | default: 'button'`; `snippets/button.liquid` and `blocks/add-to-cart.liquid` follow
the same "setting alone, no hardcoded `button`" rule, though neither adds a `default` and
`snippets/button.liquid` also emits a per-block `{{ style_class }}--{{ block.id }}` variant this
button has no use for. `.button-secondary` is self-sufficient in `base.css` (the shared geometry
selector at the top of the Buttons section names both classes), so dropping the hardcoded `button`
loses no applied styling. The only `.button`-only rules left behind are the `[hidden]`, `:disabled`
and `outline-color` states, and nothing in `blocks/contact-form.liquid` or any JS puts this button
into them. The general rule is now in `docs/theme-conventions.md` under CSS.

A read-only pull of the live theme (`shopify theme pull --live --nodelete`) found **no drift** in
`templates/page.contact.json`, `sections/footer-group.json` or `config/settings_data.json`: the live
submit button is `style_class: "button"` under `scheme-1`, which is black background and white text.
So the collision above was latent, not the cause of a current misrender, and any remaining
appearance complaint about that button is a design question about scheme-1's black primary, not a
bug in the block.

## `show_shipping_info` now defaults to false (unreleased)

The cart's "You may also like" cards restated the shipping policy under every price, because the
`show_shipping_info` checkbox in `blocks/price.liquid` defaulted to `true` and the cart card's price
block (`price_yXfkPX` in `templates/cart.json`) simply omitted the key. Nothing in the template said
"show shipping here"; the line appeared because a schema default reached across from the product-page
use case, where the shipping note belongs, into a product card, where it does not.

The fix flips that default to `false` and, in the same change, brings the cart card's four settings
blocks in line with the site-standard card copied from `templates/index.json` and
`templates/collection.json`: card gap 8, `scheme-1` with inherit off, radius 24, padding 16; gallery
ratio portrait with radius 8; title on the `custom` preset in the subheading font at 1rem/tight with
the heading color; price on the `custom` preset at 0.875rem, with `show_shipping_info` now written
out explicitly.

**The cart was not the only card inheriting the default.** `templates/404.json`'s product card
(`price_A6DYPt`) omitted the key too, in exactly the same state the cart card was in, so it was
quietly printing the shipping note as well. It now sets `show_shipping_info: false` explicitly. The
lesson generalises: auditing a schema default by grepping for the setting name only enumerates the
templates that opted in, and the ones at risk are precisely the ones that name is absent from.
Enumerate the block type (`"type": "price"`) and subtract, rather than enumerating the setting.

**Why the default flip is safe, and what it costs.** With those two written out, every consumer now
sets the key explicitly: `false` on the collection, index, search, 404 and cart cards, `true` on all
six product templates' own price blocks, both occurrences per template. So the only rendering
changes are the two cards that were the bug. The trade-off is that a price block newly placed from the editor on a
product page now needs the checkbox ticked to get the shipping note back. That was accepted
deliberately: a missing shipping line on a product page is visible on the page the operator is
editing, whereas the old default failed silently, adding the line to every new product card anyone
ever placed. The preset in `blocks/price.liquid` carries no settings of its own, so it takes the
schema default either way.

That cost is not hypothetical, and it is not limited to a hand-placed price block. Seven presets
embed a price block without the key and so now render without the shipping note: the three in
`sections/product-list.liquid`, plus `sections/product-recommendations.liquid`,
`blocks/product-recommendations.liquid`, `blocks/product-card.liquid` (all card surfaces, where the
new behaviour is the wanted one) and `blocks/_product-details.liquid` plus
`sections/featured-product-information.liquid` (product-page surfaces, where a newly placed section
needs the checkbox ticked). The six shipped product templates are unaffected; they carry their own
explicit `true`.

## CLAUDE.md becomes a policy-and-trigger layer (unreleased)

`CLAUDE.md` had reached 39,844 characters, 99% of the 40,000-char hard limit, because every merge
since the July 2026 consolidation appended a paragraph. The deep reference prose is now in three
new `docs/` files and one existing one, and `CLAUDE.md` keeps the always-loaded policy layer plus a
trigger-conditioned pointer at each of them.

**The governing test for what stayed inline was not length, it was signal at the moment of the
mistake.** A rule whose violation fails silently, with no CI check and no error, stays in
`CLAUDE.md` even when its rationale moves out; a rule the tooling would catch anyway, or that a
model can reconstruct (BEM, logical properties, container queries, typed inputs, view transitions),
was collapsed or dropped. That is why the moves are not symmetric: the theme-editor event names
moved rather than being deleted, because an exact-string API surface misspells silently, while the
generic CSS concepts around them did not survive at all.

Where the material went:

- `docs/theme-conventions.md`: component framework, theme-editor integration, the block / snippet /
  section split, block file structure, and the Liquid / CSS / HTML / JavaScript standards.
- `docs/structured-data.md`: what each `structured-data*` snippet emits, and the full set of rules
  that silently invalidate a node.
- `docs/theme-settings-contracts.md`: social links, the generated collections dropdown, the absent
  `social_twitter_link`, vacation mode, shipping copy (including the Admin shop-policy read
  snippet), and `data-fieldset-index`.
- `docs/accessibility-patterns.md` absorbed the global accessibility rules. That file used to
  delegate globals back to `CLAUDE.md`; the direction is now inverted, so one file holds both the
  globals and the widget patterns.

Sections that already had a fuller authority elsewhere (the four deploy gates, the smoke test, dev
commands, repo layout, the secrets-vs-variables policy) collapsed to the directive plus the
citation. Everything cited in the pointers is a live path: `README.md`'s "Deeper docs and license"
table lists the three new files, and the inbound references in `marketing/emails/README.md`,
`scripts/seo-review/README.md`, `.claude/skills/seo-review/SKILL.md`, `scripts/a11y/`,
`blocks/_accordion-row.liquid`, `snippets/policy-page.liquid`,
`snippets/structured-data-organization.liquid` and `snippets/size-guide-link.liquid` were repointed
in the same change.

**Two corrections the consolidation surfaced, recorded because both were wrong in a way a reader
would have trusted.**

1. The Pre-PR review section named a "standard agent set" of `code-reviewer`,
   `architecture-reviewer` and `security-auditor`. **None of those three agents exists.** The
   installed set is `doc-sync-checker`, `infra-reviewer`, `prompt-reviewer` and `test-engineer`;
   general code review comes from the headless `/code-review` gate plus `/security-review`. The
   section now says so.
2. The structured-data rules were introduced as having "no CI check behind them". The accurate
   statement is *no automatic check*: `package.json` has no top-level `test` script, and
   `seo-review:test` runs the unit suite only, so the `jsonld-parse`, `jsonld-entity-home` and
   `jsonld-entity-leak` checks run when an operator invokes the `seo-review` skill and never in CI.

A `prompt-reviewer` pass on the result caught two gaps the extraction created and one label that
would not have fired. The **FAQ page** is a silent-failure surface that neither the structured-data
trigger (scoped to `snippets/structured-data*.liquid`) nor the theme-settings trigger named, yet
both docs carry a rule about it: the `FAQPage` block-exclusion and anchor rules, and the
vacation-mode deep link to `/pages/faq#away-from-studio`. Editing `templates/page.faq.json` for FAQ
reasons is exactly the task that trips both, so it now has its own trigger. The **Screenshots**
section had been dropped as duplicated by the global profile, but the profile only says where
screenshots land; the repo-specific "check proactively when troubleshooting, not only when the user
mentions one" directive had no successor, and is now a bullet under Browser testing. And
"variant-fieldset setting" was an invented category label matching no file or setting name, so the
trigger names `snippets/variant-main-picker.liquid` and `assets/variant-picker.js` instead.

That is the general lesson for the next restructure of this kind: converting always-loaded prose
into trigger-conditioned pointers only works if every plausible editing entry point is named by
some trigger. A rule can be faithfully preserved in a doc and still become unreachable, because the
trigger meant to surface it names the file the rule is *about* rather than the file where the
mistake is actually made.

**On the size target.** The plan called for 15,000-18,000 characters. The result is about 25,600,
and the gap is arithmetic rather than under-delivery: the plan budgeted roughly 1,800 characters of
residue for pointers that, written to carry trigger plus failure mode plus file name as the same
plan required, cost about 7,000. Cutting to 18,000 from here would mean deleting triggers the
governing test says to keep, or abridging Sensitive Content, which stays whole. 25,600 is a 36%
reduction, 64% of the hard limit, and below the 32,000 warn threshold with real headroom. The next
consolidation should treat "what fails silently" as the budget, not a character count.

## Smoke: the policy pages get a markup assertion (unreleased)

The post-deploy smoke probed `/policies/refund-policy` for HTTP 200, the right host and the right
theme id in `server-timing`, and never looked at the page content. The five `/policies/*` pages are
not themeable: Shopify renders them, and the only theme code that runs there is
`snippets/policy-page.liquid`, which `layout/theme.liquid` injects behind its
`request.page_type == 'policy'` guard. So if that snippet stopped rendering, all five pages would
silently lose the restyle and the jump nav while the deploy still reported green. That is not a
hypothetical failure mode; it is exactly how the dead `templates/policy.liquid` attempt recorded
below failed, as a file that uploads cleanly and never runs.

`fetchObservation` now takes an optional `markers` list, and `runSmoke` passes
`POLICY_MARKERS = ['policy-nav-component']` for any structural path starting `/policies/`. The
custom-element tag is the marker not because it is the only candidate (the whole shell is
server-rendered, heading included) but because it is the most stable one: it is neither
locale-dependent, as the heading text is, nor a CSS class anyone may rename. What is not assertable
without a browser is the list content and the visible state: the `<nav>` ships `hidden` and the
`<ul>` ships empty, since `assets/policy-nav.js` fills the list from the body's `h2`s and unhides it
only at three or more headings.

**Why SOFT-WARN, stated precisely, because "it's the safe default" is not the reason.** This changes
the failure mode from silent green to a visible non-blocking warning. It does not block a bad
deploy, and it is not meant to. The smoke cannot distinguish a forward deploy that broke the snippet
from a rollback to a theme that predates it, so one verdict has to serve both cases and the safe
direction is the non-blocking one. The rollback case is real rather than theoretical: `README.md`
makes the primary rollback a revert PR shipped through the same comment-deploy cycle, so the smoke
does run against the older theme. A SOFT-WARN seen immediately after a deploy may also be edge-cache
lag rather than broken markup; re-check the page before acting on it.

SOFT-WARN is not a free pass, and the docs say so rather than promising more than the code delivers:
a SOFT-WARN is not a PASS, and `summarize` still requires at least one verified PASS overall, so
narrowing `SMOKE_PATHS` to a single policy path and then rolling back exits 1 on that rule rather
than on the marker. The four other structural paths are what keeps that from biting on a normal
deploy.

**Three things the body read had to get right, all of which a naive version gets wrong.**

1. **It is bounded by the existing timeout.** `clearTimeout(timer)` used to run in a `finally` the
   moment the headers arrived. The hop is now wrapped so the timer stays live across the body read
   and is cleared once the hop is completely done, so a stalled trickle after the headers aborts on
   the same `timeoutMs` budget. An unbounded read would hang the job to a CI step timeout, which is
   a job failure rather than a smoke verdict and is far harder to read off a deploy report.
   `fetchWithBody` still has that unbounded-read shape for the sitemap read: `clearTimeout` fires
   as soon as the headers arrive, and the `try`/`catch` around the enumeration catches a throw but
   not a hang, so a stalled sitemap body parks the run until the job's own 15-minute cap with the
   theme already live. It was left alone rather than fixed in passing, to keep this change to one
   subject; the pattern to copy is now one function above it.
2. **The read is wrapped in try/catch.** A connection reset mid-body or a decode failure becomes
   "markers unknown (body unreadable)", its own SOFT-WARN reason, so a network fault stays
   diagnosable apart from genuinely absent markup. An uncaught throw would escape the structural
   probe loop and fail the deploy job, a harder failure than the regression this check exists to
   warn about, and a failure mode that did not exist before.
3. **No body text is ever returned.** The function returns only the names of the missing markers,
   drawn from the fixed list passed in. `docs/smoke-test-reference.md` states that output is
   path/verdict/status/host/theme-id tuples and never bodies; reading a body for an assertion is
   compatible with that rule, emitting one is not. The no-leak test asserts this on both the PASS
   and the SOFT-WARN policy branches, not on a non-policy path, which would be vacuous because a
   non-policy path never calls the read at all.

**Brotli was checked rather than assumed.** The storefront serves
`content-encoding: br`, and a decode mismatch here would surface as a spurious SOFT-WARN with no
visible cause, the worst kind of false signal for this check. A live probe with this script's own
`BROWSER_HEADERS` confirmed undici decodes it losslessly (a 145 KB response arriving as complete
HTML through `res.text()`), so no explicit `accept-encoding` override is set. Re-check that if the
probe headers ever change.

The check lives in `classify`, after every existing HARD-FAIL condition, so a marker warning can
never mask a genuine failure and `classify` stays the single verdict authority for content probes.
The path test is a `/policies/` prefix rather than a hardcoded path, so an overridden `SMOKE_PATHS`
listing a different or an additional policy is covered. Markers are opt-in per call, so the
sitemap-wide product sweep gains no body reads.

## catalogue.json becomes the repo's single source of truth (unreleased)

`catalogue.json` was added at the repo root to end a real bug: `thresholds.json` was silently the only
record of the catalogue's body x colour x size shape, inferred as a global cross product, which
invented twelve women's-vest cells in colours the vest is not made in. The manifest declared the shape
instead, and the blank-inventory reorder review became its first consumer.

It stayed its only consumer. The same vocabulary was restated across seven other places that nothing
reconciled: **five spellings of three garment bodies** (`crewneck`/`quarter-zip`/`vest-womens` in the
manifest, `crew-sweater`/`quarter-zip`/`vest` in `scripts/lib/photo-naming.mjs`,
`crewneck`/`quarter-zip`/`vest` in `scripts/size-chart/lib/garments.mjs`), **three casings of one
colour** (`grey heather`, `Grey Heather`, `grey-heather`) with no derivation between them, and **one
product GID written four times**. This change makes the manifest the authority for all of it and adds
the lint that stops a copy drifting back in.

### The schema, and the two order contracts

Version 2 adds four sections to the three v1 had: `options` (the Admin option axis names), `colors`
and `sizes` (every value with its Admin display spelling, and for a colour its kebab slug), and
`products` (the complete census: handle, product line, body, theme template suffix, title and GID,
with gift cards included and carrying `"line": null, "body": null` explicitly).

**One rule generates every validator.** An IDENTITY is rejected unless it is already normalised. A
DISPLAY string is rejected unless it normalises back to the identity it hangs off. An option name, a
product title and a GID are checked on shape and uniqueness only, and are never case-folded.

The option axes are the one place where a key and its value are *not* two spellings of one thing, and
that is live data rather than a wart: `options.denomination` is `"Denominations"`, which normalises to
`denominations` and not to its key. So an option key is an internal axis id from a closed set, and its
value is the nearby Admin label. Applying the round-trip rule there would refuse the committed file.

`colors[].slug` is a stored, checked projection: it must equal the key with spaces hyphenated. Storing
it rather than computing it is deliberate, so a reviewer adding a colour sees all three spellings
adjacent in one diff hunk.

**Two independent order contracts are load-bearing, and the manifest's own `comment` now names both
side by side** so a future editor cannot discover them one at a time. Product declaration order drives
the accessibility audit's product block and photo-naming's line list. Colour and size key order must
equal the first-seen union across `bodies`, which is itself the reorder matrix's row order; a reshuffle
there silently reorders a printed count sheet, so it refuses rather than sorting.

**Why `template` earns its place.** It settles all three divergent gift-card identifiers at once:
`templates/product.<template>.json` is the theme file, `<template>` is what the SEO review's
non-garment allowlist compares against, and `product (<template, hyphens as spaces>)` is the
accessibility audit label. That last one is byte-verified against all six shipped entries: deriving the
label from the handle gives `product (sapphire shadow studio gift card)`, which is not what ships;
deriving it from the template reproduces all six exactly. It also means the size-chart profiles'
`handles` derive from `template` rather than from the handle, which *preserves*
`scripts/size-chart/README.md`'s statement that those are alternate template suffixes.

The GID uniqueness check is not tidiness. A shared GID is exactly what would make
`upload-product-media.mjs` write photos onto the wrong product.

### The authority reversal, and what it cost

`scripts/blank-inventory/lib/bodies.mjs` used to INFER a body per product from keyword matches on the
handle and title, present the proposal at a `bodies --stage propose|approve` operator gate, and seal
the approved result in a hash-checked artifact under `~/.local/state/`. All of that is deleted. The
manifest is the only authority on a product's body, existing and future, and it must be updated for CI
to pass.

`bodies.mjs`'s own header argued that a hardcoded map "needs a PR per new product" and that inference
avoids the cost. **That premise was empirically false here, and this backlog section is the evidence.**
A new product already required a PR in six places: the SKU tables, the photo-naming product table, a
size-chart profile's handle list, the applique registry, the accessibility path list, and a product
template. Inference bought no PR-avoidance at all. What it bought was an authority living in
`~/.local/state/`, uncommitted and invisible to CI, which is precisely why all six of those places grew
a private copy of the same vocabulary.

**Lost, exactly: the operator gate.** Body assignment was machine-proposed, re-presented in full for
approval, and sealed in a `contentHash` that refused hand edits. There is now no re-presentation and no
seal.

**What replaces it:** the manifest changes only in a reviewed PR; the offline lint refuses
inconsistency; seven consumers derive from it, so a wrong `body` appears in the same diff as a wrong
size-chart binding and a wrong photo token; and the networked gate gained live title and GID checks it
did not have. **Genuinely weaker: the hash seal.** A manifest edit is now a signed, reviewed, auditable
event instead of a silent local file write, which is a different guarantee, not a strictly stronger one.

**The blind spot, recorded because it outlives the task.** Nothing catches a manifest that declares the
WRONG body for a product that really exists. Nothing offline can know, and the live store carries no
body field, which is the very observation that motivated inference in the first place. Mitigation is a
diff, not a check. That is the honest limit of the reversal and it is stated here rather than left for
someone to rediscover.

A leftover `bodies.json` or `bodies-proposal.json` produces a one-time "this file is inert" notice
rather than being silently ignored or deleted for the operator: it is the record of what the old gate
approved.

### `reconcileCatalogue`'s counterparty changes

The two-way body-set check against the approved body map is deleted. The body index is derived FROM the
manifest now, so that check would compare the manifest against a derivative of itself and could never
fail for a real reason. The live store replaces it, because it is the only thing that can disagree with
the manifest about facts. Five refusal codes are new: `catalogue-undeclared-products`,
`catalogue-stale-products`, `catalogue-title-mismatch`, `catalogue-gid-mismatch` (networked), and
`catalogue-dangling-body` (offline, and therefore fired by the CI lint).

**Drift coverage, stated honestly.** Offline: every repo-side surface naming an undeclared handle or
failing to name a declared one, plus every internal manifest rule. Networked, at the reorder gate only:
a live product absent from the manifest, a declared handle with no live product, a title mismatch, a
GID mismatch, a tagged variant outside a declared cell. Those five can only *fire* against a real
store, so a PR can merge green with an internally perfect but factually stale manifest; their decision
logic is unit-tested offline against hand-authored Admin payloads, which makes this a data-freshness
exposure rather than an untested-code one. Nothing forces the reorder review to run on a schedule.

### Module location, and why it moved

`catalogue-manifest.mjs` sat under `scripts/blank-inventory/lib/` and imported `groups.mjs` ->
`planner.mjs` -> `input.mjs`. Seven areas import it now, so leaving it there would have given the SKU
tooling, photo naming, size charts, applique grids, the accessibility audit and the SEO review a
load-time dependency on the blank-inventory planner, one module away from `lib/mutations.mjs`.

It is `scripts/lib/catalogue-manifest.mjs` now, importing exactly two zero-import leaves extracted for
the purpose: `scripts/lib/vocab.mjs` (`normaliseAxis`, `SEP`) and `scripts/lib/json-keys.mjs`
(`findDuplicateKeys`). `groups.mjs` and `reorder.mjs` re-export both names. **Those two re-exports are a
permanent compatibility layer, deliberately, and are not shims awaiting removal**; the "no shim" rule
applies to the deleted blank-inventory copy of `catalogue-manifest.mjs`, and the two statements are not
in tension.

`ID_RE` and `PRODUCT_GID_RE` are **copied** into the schema module rather than moved. The applique
registry still owns its copy until its own migration lands, and deleting it there in this change would
break trunk in the window between the two PRs. A test asserts the two copies are byte-identical for as
long as both exist, and it is deleted with the copy.

### The read-only guard, strengthened

Three modules carry a header saying they must never import `lib/mutations.mjs`, and each was pinned by
asserting its own one-line import list. That catches the direct edge and nothing else: a module could
import a freshly-added neighbour that imports `admin.mjs`, the pinned list would be updated to name the
neighbour, and the prohibition would be gone with every assertion still green.

`scripts/lib/import-closure.mjs` walks the whole transitive relative-import graph instead. It ships with
its controls, because a guard is only as good as those: a **depth-2 positive control** over a throwaway
fixture (without which a bug collapsing the closure to depth 1 passes everything else and silently
degrades the guard back into the check it replaced), and fail-loud behaviour on every specifier form a
static walk cannot follow, so an unresolvable path, a dynamic import and an `export ... from` are all
failures rather than silent leaves.

### The lint, and why it is not a new CI step

`scripts/catalogue/check-catalogue.mjs` grew the cohesion checks rather than gaining a sibling. A new
step costs four coordinated `validate.yml` edits and buys nothing: the existing `catalogue` step already
runs the suite and the lint together, offline, with the vacuity floor and the random-delimiter heredoc
in place.

Sixteen checks live in `scripts/lib/catalogue-cohesion.mjs`. Two of them WARN rather than refuse, and
that split is the design: `config/settings_data.json` is Admin-editable and is reconciled onto `main` by
`sync.yml`, so refusing there would let an Admin theme-settings edit red a reconcile PR nobody in this
repo authored and halt `deploy.yml`'s gate on something unfixable from Admin. The WARN text renders in
the PR comment, not only the job log, and it says the variant picker stops matching option values until
one side is corrected. A warning nobody sees is worse than none.

**Half the checks are scheduled to retire, and that is the point.** Each check records the SOURCE it
reads. Once a consumer derives its list from the manifest, comparing the two is comparing the manifest
against itself, and a tautology in a lint reads as coverage while asserting nothing. Those checks are
deleted and replaced by a derivation test in the owning suite.

**Two mechanisms make all sixteen green against unmigrated consumers**, which is what lets this ship
before the migration. First, **normalise before comparing**: the SKU colour check compares values, not
spellings, so `Grey Heather` in `tables.json` and `grey heather` in the manifest agree; and the
photo-naming census is compared on handle, title, GID and colour values, never on body ids, whose five
spellings genuinely disagree today and are not what that check asserts. Second, a **declared source path
per check**, so the reader for a source that moves is updated in the same commit that moves it.

### Untrusted input, and the CI output contract

The lint now reads PR-authored content from six new files, and their strings can reach failure text that
flows into `$GITHUB_OUTPUT`. The existing surface had exactly two guards: the random heredoc delimiter,
and `nameList()`'s JSON-quoting of manifest keys. Neither covered the new sources, and this repo has
already had one incident of exactly this bypass class.

Every PR-authored string from all sixteen checks now routes through `nameList()`, which JSON-escapes each
entry so a newline cannot span lines, **and bounds the list** while still stating the true total, so a
PR-inflated set difference cannot trip the Actions output limit or produce an unreviewable comment.
There is a fixture test per source file asserting that a payload carrying a newline plus a delimiter and
a forged `exit_code=0` cannot escape.

Sixteen checks collapse into one row in the PR comment, so a failure would otherwise be diagnosable only
from the raw job log. `check-catalogue.mjs` prints a fixed-shape `catalogue FAILING CHECKS (n): ...`
line, `validate.yml` lifts it into its own step output, and the comment renders it beside the status.

The count line grew from three numbers to six:

```
catalogue OK: 3 bodies, 3 colour values, 6 size values, 6 products, 4 option names, 16 cohesion checks.
```

Seven of those sixteen retired with the consumer migration, so the shipped line reads 9:

```
catalogue OK: 3 bodies, 3 colour values, 6 size values, 6 products, 4 option names, 9 cohesion checks.
```

The cohesion figure is the count of checks that RAN, not the count declared, so a module that failed to
load reads 0 and reds the build rather than reading as "all clear". The workflow's `sed` output is
captured once and all six `cut` extractions read that variable; the lint is never re-invoked per
extraction. And because the wording lives in one file and the anchored regex in another, a test now runs
the workflow's own `sed` and `cut` against the lint's own count line, so the two cannot drift apart with
only a manual pre-push check between them.

### The byte-stability baseline

Five shipped artifacts are generated from data this work moves under the manifest: the size-chart render
golden, the generated accordion rows in the five garment product templates, the applique dropdown text,
the six accessibility labels, and `templates/product.huddle-crewneck.json`'s `pattern_options`.

A manual `git diff` at merge time is not a test. It leaves no regression coverage once the migration has
merged, and "regenerate and confirm a clean tree" compares the new generator against **its own** output,
which is the self-referential-golden failure mode: a generator that changed its mind consistently
passes. So their bytes are frozen into `scripts/catalogue/test/fixtures/pre-migration-baseline.json`
*before* any migration code exists, and the migration's own tests byte-compare fresh generator output
against that snapshot from the owning suites.

`EMPTY_SENTINEL` in the applique registry is the one **declared exception**: it is a byte-equality check
over `serialize(emptyRegistry())`, the registry's schema changes with the migration, so its bytes change
and its own unit test updates in the same commit. That is an intentional, tested exception to the
criterion, not a violation of it, and it is deliberately not captured in the frozen snapshot.

### Migration

`CATALOGUE_VERSION` went 1 -> 2. A v1 document refuses. It shipped with
`scripts/catalogue/migrate-catalogue.mjs`, a read-only one-shot that PRINTED a v2 **skeleton** and
wrote nothing: the manifest is hand-edited in a reviewed PR, and that rule does not get an exception
for the command that changes its shape.

It is a skeleton rather than a migration because two of the four new sections cannot be derived from a
v1 document. The Admin display spellings are not in it (`xs` title-cases to `Xs` and the live value is
`XS`, so every size guess it printed was wrong by construction and its notes said so), and the product
census is not in it at all. Its output deliberately did not validate: the schema refuses every
placeholder it emitted, so an unfinished migration could not merge looking done. It was deleted once
the migration landed rather than left as cruft that reads like a supported path, and the v1 refusal now
says the correction is a hand edit in a reviewed PR. It is recoverable from git history if a v1
document ever turns up.

## Every consumer derives its vocabulary from catalogue.json (unreleased)

The manifest, its schema, its lint and the authority reversal shipped first; this is the other half,
migrating all seven consumers onto it. What follows is only what the migration itself taught. The
design rationale is in the entry above.

### A latent bug the work surfaced: a skip that had never fired

`scripts/seo-review/admin.mjs` allowlisted products where a blank `custom.breadcrumb_collection` is
correct, as the literal `new Set(['gift-card'])`, and compared it against the product handle the Admin
API returns, which is `sapphire-shadow-studio-gift-card`. The two never matched. The skip had not fired
once since the check shipped, so the gift card produced a `product-breadcrumb-collection-missing` WARN
on every run and the check could never reach the zero findings it was designed to reach.

`gift-card` is the TEMPLATE suffix, not the handle. That is the same distinction the size-chart template
list and the accessibility label rule turn on, and it is most of why the manifest carries `template` at
all: this bug is what a repo looks like when the two are conflated in a literal nobody re-reads. The set
now derives as every product declared with `"body": null`, under **both** spellings. A non-garment is
exactly the class with no parent collection to name, so the manifest already knew the answer.

It is tested against a hand-authored manifest with two non-garment products, one whose handle and
template differ, because the live census has exactly one non-garment shape and would leave the flatMap
and the dedup unexercised for any other.

### Materialisation, and why a stale copy is refused rather than overwritten

Three consumers took the same shape: the committed file states the one fact that is genuinely its own,
and the loader attaches the rest from the manifest before validation, so nothing downstream changed
signature. A size-chart profile declares a `body` and `profile-io.mjs` materialises its `sizes` and
`handles`; the applique registry declares a scalar `handle` and `registry.mjs` materialises the
`product` block the whole tool already read; the SKU tables hold codes and `tables.mjs` merges back the
titles, option names and per-product size ranges.

In all three, a committed file still carrying the derived field is **REFUSED, not overwritten**. Silently
replacing a stale literal leaves it sitting in the file where nobody reads it and nobody corrects it,
which is the failure this whole migration removes. In the applique case it is stronger than tidiness:
the block held a GID and a colour snapshot the audit compares against the live store, so overwriting it
would hide the very drift that comparison exists to find.

`serialize()` in the applique registry drops a materialised `product` block rather than writing it back,
so no save can reintroduce one. That is enforced at the one function every write goes through, not at
each call site.

### The SKU hash: what it covers, and the two controls that pin both directions

SKUs freeze onto order lines, so this is the highest-consequence change in the set. `hashTables` now
covers a **derivation-inputs projection of the merged tables**, manifest contribution included. Hashing
only the committed file would let a manifest edit silently change every derived SKU while
`assertTablesUnchanged` went on passing an old approved plan.

The projection is load-bearing in the other direction too. Hashing the merged whole indiscriminately
would invalidate every approved plan store-wide on a title typo fix, and nothing in the tool would
notice it had. So there are two named tests, not one: a **positive control** (an option axis renamed, a
body's size range narrowed, a colour renamed in the coupled way validation requires) and a **negative
control** (a title fix, a corrected GID, a display spelling changed without its id, a manifest product
with no codes).

One derivation ordering changed with it, and it closes a real hole: `derive.mjs` validates a size
against the product's declared size range **before** the passthrough shape test. The old order accepted
any uppercase alphanumeric token, so a Size option that had drifted in Admin to something the product
does not sell produced a plausible-looking SKU on a field nothing downstream would question.

### One table stayed hand-authored, deliberately

`BODY_PHOTO_TOKEN` in `scripts/lib/photo-naming.mjs` maps a manifest body id to the token that appears
in a photo filename (`crewneck` -> `crew-sweater`, `vest-womens` -> `vest`). It is not derived, because a
photo filename is already printed on files on disk and on filenames already uploaded to Shopify: a body
renamed in the manifest must not silently rename them. A both-directions test asserts the map covers
every declared body and names none that is not declared, which is what keeps it from going stale.

The same reasoning left `scripts/size-chart/lib/garments.mjs` untouched. Silhouette geometry is drawing,
not vocabulary, and it is byte-pinned by the render golden.

### The a11y product block: a marker, not an append

`build-pa11yci.mjs` expands a single `{ "marker": "catalogue:products" }` entry in `paths.json` into one
audited path per declared product. A marker rather than appending the block, because the block's
POSITION in the audit list is that file's to choose. A `paths.json` with no marker **throws**: without
that, the audit would quietly run over every page except the products and still report a clean WCAG
pass. `productOverrides` ships empty so a product later needing a pa11y `ignore` has somewhere to put it
rather than that becoming a follow-up item.

The label rule is `product (${template.replace(/-/g, ' ')})`, and it reproduces all six shipped labels
byte for byte. Deriving from the handle instead gives `product (sapphire shadow studio gift card)`.

### Check retirements, and the count that came out of it

The plan projected the cohesion count dropping 16 -> 8. It is **9**. The projection counted the
`sku/tables.json` census rows 9 and 10 as one row in the table it was read off; seven checks retired,
not eight, and 16 - 7 = 9. The number is pinned by a test either way, so the arithmetic slip was caught
by the pin rather than by review.

Retired, each replaced by a derivation test in the owning suite: the a11y coverage pair, the SKU census
pair, the SKU title and colour checks, the size-chart handle check, and the photo-naming census. A check
whose non-manifest side became manifest-derived is comparing the manifest against itself; a tautology in
a lint reads as coverage while asserting nothing, so those are deleted rather than kept green. The
retirement reasoning is recorded in `catalogue-cohesion.mjs`'s own header, next to the checks that
remain, so the next reader finds it where the decision applies.

Retiring the photo-naming check also removed the lint's only import of `photo-naming.mjs`, which shrank
`check-catalogue.mjs`'s read-only import closure. The pinned closure test moved with it.

### EMPTY_SENTINEL, the one declared exception

The applique registry's bootstrap sentinel is a byte-equality check over `serialize(emptyRegistry())`.
The schema changed, so its bytes changed. Its own unit test updates in the same commit and now pins the
new opening bytes and asserts no `gid://` survives in it. This was declared as an exception in advance,
which is why it is not in the frozen snapshot.

Separately verified and now asserted structurally: `published[].specHash` cannot churn. `chartSpec()`
carries the style version, the grid params, the page numbers and each pattern's id, name, thread, hero
digest and crop, and none of the product facts. Asserting that structurally rather than against the
capture matters here, because the capture holds zero published charts and would have passed by saying
nothing.

### The byte-stability snapshot did its job

The frozen `pre-migration-baseline.json` is compared from the owning suites: the size-chart seed SVG,
all five generated accordion rows and the prose fixtures; the applique dropdown text and the pattern
list; the six accessibility entries. Every one matched on the first run, which is the outcome the
snapshot exists to be able to claim rather than assume.

One thing to know about the capture itself: `captureBaseline` reads the a11y product entries through
`resolvedPaths()` now, not off the raw `paths.json`. Reading the raw file after the migration would
return an empty list and the comparison would have quietly become vacuous.

## blank-inventory's vocabulary comes from catalogue.json (unreleased)

`catalogue.json` was the single source of truth for the catalogue's shape, and the reorder review
already computed its cell space from it. Three other places inside blank-inventory still restated the
same vocabulary, and nothing reconciled them. Each is now **derived from** the manifest rather than
merely checked against it, so exactly one list exists.

**The manifest is the size ruler now, not a list that has to agree with one.** `SIZE_ORDER` existed
because sizes do not sort alphabetically ("2XL" before "S"). `buildAxes` used to sort the manifest's
declared sizes against it, which made two lists for one fact. On the manifest path nothing sorts:
`parseCatalogue` already documented that declaration order is preserved into its Map and is
load-bearing, so carrying it through makes the file itself the ruler. The order the reorder matrix,
the reorder table and the purchase list print is the order written in `catalogue.json`.

`SIZE_ORDER` stays, as the fallback for two cases: the legacy path where no `ranges` were passed, and
any size the manifest does not declare, which must still rank sensibly rather than landing in an
alphabetical heap. `3xl` and `4xl` stay in it for that second reason even though no body declares
them.

**Five of the six `compareSizes` call sites moved together, and the sixth stayed on purpose.** There
were six: three inside `buildAxes` and three downstream (`selectReorders`, and two in
`buildPurchaseList`). Five moved. The one that stayed is `globalSizes` inside `buildAxes`, which is
reached only when no `ranges` were passed, so it is the legacy ruler doing its job rather than a
missed site; anyone auditing the claim will find that surviving call and should read it that way.
Migrating only some of the other five would have left half the report in manifest order and half in
`SIZE_ORDER`, which is a worse
regression than the one being fixed: an internally inconsistent report is harder to notice than a
uniformly wrong one. `selectReorders` and `buildPurchaseList` therefore each gained an optional
`sizeOrder` in their existing options object, defaulting to `SIZE_ORDER` so every current caller keeps
working, and `cmdReorder` passes `axes.sizes` to both. A new `makeSizeComparator(order)` export is
what ranks by declared position, falling back to `SIZE_ORDER` and then alphabetical for anything
undeclared.

**`reorder.mjs` cannot import the manifest, and the size order arrives as data for that reason.** A
test asserts that module's import list is exactly `['./groups.mjs']` (it is how "this module cannot
reach a mutation" is proved), and `catalogue-manifest.mjs` already imports `reorder.mjs`, so importing
back would be a cycle and a red test. The wiring already existed and is single-caller: `axesFromStore`
is the only production caller of `buildAxes` and already passes `ranges: manifest.bodies`.

**The default fixtures cannot prove any of this, so the tests use an override.** The real declared
order is already ascending, so "preserves declaration order" and "sorts by `SIZE_ORDER`" produce
identical output and a test built on the committed catalogue would be vacuous. The ordering tests run
on a deliberately non-alphabetical declared order instead, and a consistency test asserts the four
manifest-path sites agree with each other so a future partial migration cannot split the report.

**One existing contract test changed meaning and was updated deliberately.** `serializeThresholds`
was asserted to order colours in manifest order but sizes in garment order; sizes now follow the
manifest too, for the same reason colours do. Body order still does not, so reordering bodies in the
manifest still cannot churn the committed thresholds file.

**The test fixtures' axes are derived, and the rule about which tests may use them is the
load-bearing part.** `BODIES`, `COLORS` and `SIZES` in `test/fixtures.mjs` were a hand-written second
copy in display case; they are read from the manifest at module load now (`readFileSync` plus
`parseCatalogue`, synchronous, so no top-level `await` and no change to how anything imports
fixtures). The rule, stated in that file's header: a test that validates LOGIC (sorting, derivation,
reconciliation, anything order-sensitive) must use a hand-authored `manifestFor()` override, because
otherwise its expected output is computed from the same data as its actual output and it checks
self-consistency rather than correctness. Only a test whose intent is genuinely "matches production"
may use the derived defaults. `MID_SIZES_ONLY` stays hand-written: it is a deliberately narrow
scenario, not a statement about the catalogue.

`VEST_BLACK_ONLY` reads the vest's actual declared range instead of restating `['black']`, and
`fixtures.mjs` throws at load if that range is ever more than one colour. That assertion is the point
rather than a formality: every consumer of the constant models "one body is narrower than the
others", and a derived-but-unchecked constant would silently convert all of them into multi-colour
scenarios with nothing failing to flag the shift.

**Known consequence, and the limit of the existing compensating control.** Editing `catalogue.json`
now changes what the derived-default tests exercise, with no review moment of their own. The
cross-artifact cohesion test reconciles `thresholds.json` against the manifest, so *adding* a colour
or a size fails CI until a matching minimum exists. It says nothing about *reordering* existing
entries, which is exactly what the size-ruler change is sensitive to. The override tests are what
covers reordering; do not lean on the cohesion test for it.

**The blank-id guard is unioned with the manifest, never replaced by it.** `check-no-real-blank-ids.mjs`
detects the shape of a supplier-encoded blank id, and its size alternation is the tail of that regex.
Deriving it outright would have narrowed it from eight size tokens to the six the catalogue declares,
so a real id ending `_3XL` would stop being detected: a leak detector getting weaker in exchange for
tidiness. Both the alternation and `ALLOWED_SEGMENTS` are therefore the hand-curated list unioned with
the manifest's colour, body and size words (hyphens and spaces both split and flattened, so
`quarter-zip` yields QUARTER, ZIP and QUARTERZIP).

**The size union is a no-op today; the allowlist union is not, and saying otherwise would give the
next reviewer the wrong baseline.** All six declared sizes are already among the legacy eight, so the
alternation is unchanged. The allowlist genuinely widens, by four tokens the hand list did not carry:
`GREYHEATHER`, `CLASSICNAVY`, `VESTWOMENS` (the flattened forms, which the hand list only ever had
split) and the bare `QUARTER`. All four are colour or garment words and so satisfy the
positive-detection rule stated in the file, but "the union changes nothing" would be false, and the
question a future reviewer asks is exactly whether widening this list is safe. Beyond today, the
value is forward-looking: a new colour joins the allowlist automatically instead of tripping the
guard on the fixture that uses it.

**Manifest sizes are filtered to `[A-Z0-9]+` before they reach the regex, not escaped.** They are
interpolated into a `RegExp` source, and `normaliseAxis` lowercases and trims but does not restrict
characters, so `parseCatalogue` would accept a size of `3xl(tall)`, which throws a `SyntaxError` at
module load and takes the guard down on an otherwise valid catalogue edit, or `s?`, which compiles
and silently changes what the alternation matches. Escaping would preserve both as literals, but a
blank id's segments are `[A-Z0-9]+` by construction, so a size carrying punctuation could never
appear in one and is not something to detect. Dropping it is both safe and correct, and the legacy
eight are unaffected either way, so this can never narrow detection below the old behaviour. A
digit-LEADING word is kept, though: a body `tee-2pack` must yield `2PACK`, because that is a legal
non-leading blank-id segment and dropping it would trip the guard on the fixture using the new body.

The union is added AFTER the `ALLOWED_SEGMENTS` declaration rather than folded into it, because the
positive-detection rule comment has to stay immediately above that declaration: a test matches on the
text between the two so a reviewer widening the list cannot miss the rule. Importing the manifest
means a malformed `catalogue.json` crashes the guard, which is fail-closed and consistent with the
file's existing stance that a leak detector failing open is worse than none.

**`blank-inventory:guard` printing "scanned N file(s)" proves nothing about detection power**, which
is why the union has its own tests rather than relying on that line. A union that silently degraded
into a replacement would print the same output and still exit 0. Three tests close it: a negative
regression proving a legacy-only `_3XL` id is still flagged, a positive one proving a manifest-only
size or token is now also covered, and a collision check proving no derived token can itself form or
launder a blank-id shape. All three use synthetic vocabulary only.

**The `learnVocab` cross-check in the backlog item was deliberately not implemented.** The proposal
was that `learnVocab` in `lib/groups.mjs` gain a check that the learned store vocabulary stays inside
the declared one. It would be strictly weaker than what already exists. `learnVocab` records a colour
or size only *after* skipping untagged and bodiless variants, so its vocabulary covers exactly the
variants `reconcileCatalogue` already walks, and that function already refuses any tagged variant
whose full body+colour+size cell the manifest does not declare. A per-axis check over the same
population adds nothing to a per-cell refusal. Nothing about `learnVocab` changed, so no test was
orphaned.

## About page rebuilt on native theme sections (unreleased)

`templates/page.about.json` was a single AI-generated app block (`ai_gen_block_23c928c`) carrying its
own hardcoded hex palette, fixed pixel type sizes, stock icon cards and a rotating team carousel. It
ignored the theme's color schemes, heading fonts, star lockup and eyebrow idiom, so it read as a
different site next to the homepage. The page is now composed from native sections following the
Custom Orders pattern (`main` disabled, `hero` plus generic `section` sections), and the block file is
deleted. Every sentence of body copy survives; three were moved rather than kept in place. The hero
sub-line was split, its first sentence becoming the lockup's pre-line. And the old block's mission
paragraph repeated its own first value card word for word, a duplication the rebuild inherited
unchanged: the values intro now ends at its three-sentence thesis, and the two repeated sentences
plus the one sentence that appeared nowhere else ("If the print quality seems questionable, it's
out.") live only on the Quality First card. The starred word in the `<h1>` lockup is "The Studio"
rather than the old "About Us", so it carries voice like the other two lockups on the site and pays
off the homepage button ("Meet the studio") that links here.

**Settings objects were copied from named analogues, not hand-authored.** A section or group in this
theme carries 30 to 40 settings, and a template that omits one silently falls back to the schema
default rather than failing, so a hand-typed object drifts from its neighbours in ways no check
catches. Each new piece here started as a verbatim copy of the closest existing one (custom-orders
`hero`, `what_we_can_do`, `hiw_row_1` / `hiw_step_1`, `closing_cta`; index `editorial_Qw7Rt2`,
`follow_along`) with only the called-out keys changed. That is the method to repeat for the next
page, not a one-off.

**A card must not inherit the scheme of the section it sits on.** The values cards are scheme-4 on a
scheme-3 section and the team cards are scheme-3 on scheme-1; a scheme-3 card on the scheme-3 values
section would have been invisible, which is why those groups set `inherit_color_scheme: false`.

**The team cards shipped text only, then gained photos in a follow-up on this same branch.** The
first pass omitted images because `blocks/image.liquid` renders a generic apparel placeholder SVG
when its `image` setting is blank, and the cat photo the old block referenced
(`shopify://shop_images/Kitkat-Rory.jpg`) did not exist in Files and never did. Four photos were then
processed offline (downscaled under Shopify's 20-megapixel cap, sRGB, EXIF stripped; one collar tag
carrying a scannable pet-recovery QR code was feather-blurred before upload), uploaded to Files as
`about-*.jpg` with alt set on the file (`blocks/image.liquid` exposes no alt setting), and added as
`image` blocks: one leading each human card, and a stacked group of both cats on the cats card.

**The cat crops are load-bearing geometry and nothing enforces them.** `blocks/image.liquid` sets
`image_ratio: "adapt"`, so every photo renders at whatever aspect its file happens to be. The two
human cards carry one 1600x2000 portrait each (ratio 0.800, so `1.25 x W` tall at card content width
`W`); the cats card carries two 2000x1227 landscapes stacked (ratio 1.630, so `1.227 x W` plus the
group's 8px gap). Those land within half a pixel of each other at this page's real card width, which
is why the row reads level. Re-crop or replace either cat file at a different aspect and the cats
card changes height, the team row goes ragged, and nothing in the repo, theme-check or CI says a
word. `height: "fill"` on the three card groups bounds the damage but does not prevent it. Keep both
cat files at 1.630, or recompute all four together.

**The follow-us card now appears on a second page, and that is not a breach of the one-placement
rule.** That rule is per page region: the homepage carries the card once, the footer's follow column
once. This is a second page carrying the card, not a second placement on one page. Its star lockup
renders styled only because `.hero-lockup` and the Dancing Script face ship with `sections/hero.liquid`
and this page has a `hero` section; a page without one would render the lockup unstyled.

**The password page is the third page to carry it, and it is the one that could not reuse the star
lockup.** The gate is the only page a pre-launch visitor sees, so the social links are the one
low-friction way to follow the studio before launch; the newsletter signup was previously the only
one. The `follow-us` block itself dropped in unchanged, settings byte-identical to the homepage's,
because it is only a wrapper around `snippets/social-links.liquid`. The heading could not be: the
paragraph above says the homepage lockup renders styled only because `.hero-lockup` and the
self-hosted Dancing Script ship with `sections/hero.liquid`, and this page has no `hero` section,
which is exactly the "page without one" case. Re-hosting the face here was rejected on the same
grounds `blocks/launch-countdown.liquid` records for dropping it: the duplicated `@font-face` and its
42 KB preload were removed from this page on purpose. So `.password-follow__heading` in
`sections/password.liquid` is modelled on `.launch-countdown__eyebrow` instead, tracked caps in the
heading font, which also reads as one voice with the countdown directly above it. Its star size and
gap are the countdown's `0.6em` and `0.35em` of h1 restated against the smaller eyebrow size
(`0.6 / 0.36` and `0.35 / 0.36`), and the stars inherit the heading's own foreground rather than
taking `var(--color-primary-button-background)` the way `.follow-lockup` does on the homepage:
against this page's navy that accent blue read as a near-miss of the pills below it rather than a
match, so they follow `.launch-countdown__star` and stay white. The heading is a `custom-liquid` block rather than a `text` block deliberately: the
section's mobile rule `.section-password .text-block.custom-font-size` is documented as catching
every text block on the page, so a second one would silently inherit the newsletter line's size, and
a richtext setting strips the class attributes the CSS needs. Teardown at launch is tracked in
`TODO.md` alongside the countdown, with the note that unlike the countdown these may be worth keeping. The heading's rules are prefixed `.section-password ` for a reason worth
knowing before anyone "simplifies" them back to a single class: `assets/base.css` carries
`:first-child:is(p, h1, h2, ...) { margin-block-start: 0 }`, the h2 is the only child of its
custom-liquid wrapper, and that selector lands at (0,1,1) against a bare class's (0,1,0). Its top
margin therefore resolved to zero at every value it was given, with no warning from theme-check or
CI, until the prefix outranked it. This is the same specificity trick the neighbouring
`.section-password .text-block.custom-font-size` rule documents, and the second time this one file
has needed it.

**The story section's studio.jpg is a section background, not an inline image.** It started as a
verbatim copy of the homepage editorial treatment (full-width, navy `#071e3f` gradient overlay) with
`section_height` set to `""` rather than the homepage's fixed `custom` height, because the About copy
is three paragraphs and would be clipped at a fixed height.

**Freeing that height is what broke the overlay, and the two settings are coupled.**
`snippets/overlay.liquid` renders `overlay_style: "gradient"` as
`linear-gradient(to top, <color>, <color 0% alpha>)`: fully opaque at the bottom edge, fully
transparent at the top. That works on the homepage because `editorial_Qw7Rt2` is a fixed 78vh holding
an eyebrow, an h2, one sentence and a button, so all of its text sits in the bottom third, deep in
the opaque end. Copy the same overlay onto a content-height section holding a heading plus three
paragraphs and the text column fills the section, which pushes the eyebrow, the h2 and the first
paragraph into the transparent end, rendering white type over the bare photograph. The overlay is now
`overlay_style: "solid"`, which is uniform over the whole passage and, as a side
effect, stops the section reading as a duplicate of the homepage slab whose "Meet the studio" button
links here. **A gradient overlay only protects text it is tall enough to reach: pair it with a fixed
`section_height`, or use a solid overlay.** Nothing validates this; the failure is silent and
visual-only.

**The solid overlay's alpha is a contrast floor, not a taste setting.** It started at `#071e3fcc`
(80%) and was lightened to `#071e3f99` (60%) to let studio.jpg read through. 60% is about as far as
it goes: the section's white body copy sits at roughly 4.6:1 where the photograph is at its
brightest, and 50% drops that to about 3.3:1, under the 4.5:1 minimum. Because the contrast depends
on the photograph rather than on the colour scheme, the automated audits report this section
INDETERMINATE and no check will catch a regression here. Re-check by hand against the brightest part
of the image if the alpha or the background image ever changes.

## Policy pages: restyled in place, with a jump nav (unreleased)

`/policies/*` read off-brand next to the FAQ and About pages: full-width, default type, no
navigation. The first attempt fixed this with `templates/policy.json`, then `templates/policy.liquid`
plus a reworked `sections/main-policy.liquid`, and every check passed while neither file ever
rendered. What shipped instead restyles Shopify's own markup from the layout. The dead end is
documented here at length because each step of it looked like progress.

**Policy pages are not themeable, and nothing tells you so.** There is no `policy` template type
(shopify.dev's template-type table simply omits it), so Shopify renders `/policies/*` itself:
`.shopify-policy__container` straight into `content_for_layout`, title and body included. A
`templates/policy.liquid` uploads cleanly and is then ignored; `theme push` exits 0, theme-check is
quiet, and the earlier `Template type 'policy' does not support JSON templates` error reads as "use
Liquid" when it means only that the JSON form is checked and rejected while the Liquid form is
accepted and never routed. Horizon shipping `sections/main-policy.liquid` with no policy template was
the upstream tell, misread twice as "unused section" instead of "unreachable page type".

**CI stayed green on a page where the feature did not exist.** The a11y audit crawled the three
policy paths on the preview theme and passed, which read as confirmation the nav rendered. It was
auditing Shopify's default markup, which is accessible and was always going to pass; nothing in the
audit asserts *which* markup rendered. The browser, not the pipeline, is what finally showed
`<main>` holding only `shopify-policy__container` with the section nowhere in it. The lesson written
into this entry on purpose: a green check is evidence only of what it asserts, and none of these
checks asserted rendering.

**What is themeable: the layout runs on policy pages.** `request.page_type` is `policy` there
(proved with a marker probe on the preview theme before rebuilding anything), the theme's CSS and
header/footer groups all load, and the body div already carries `rte`. So `layout/theme.liquid` now
renders `snippets/policy-page.liquid` behind a `request.page_type == 'policy'` guard: CSS targeting
Shopify's `.shopify-policy__*` classes for the measure and title, and a server-rendered jump-nav
shell that `assets/policy-nav.js` relocates under the title, fills from the body's `h2`s, and
unhides at three or more. The old sync-deleted `templates/policy.json` turns out to have been
harmless to delete: it never rendered either. `sections/main-policy.liquid` is back to its untouched
upstream state, dead code here exactly as it is dead code in Horizon; the reconcile-deletion halt
rule in CLAUDE.md stays, because "a deletion trips no gate" is true regardless of how this one file
turned out.

**The measure is explicit because the token it replaced never existed.** The upstream section set
`max-width: var(--page-width-narrow)`; the real token is `--narrow-page-width`, applied through a
class, and an undefined custom property resolves to nothing. The snippet carries the same explicit
narrow measure as `sections/faq.liquid`, 720px with 20px inline padding stepping down to 16px under
768px, rather than a token indirection a rename can silently empty again.

**The `rte` class on Shopify's body wrapper is load-bearing.** The branded table (uppercase header
row, mobile scroll), list indentation and blockquote rule all come from `.rte` in `assets/base.css`,
which Shopify's own markup happens to carry. The snippet styles around it, not instead of it.

**Jump-nav anchors are runtime-assigned, and shareable on purpose.** JS cannot read a locale key,
so the `<nav>` and its "On this page" heading are server-rendered in the snippet, hidden, and
`policy-nav.js` fills and unhides. Heading `id`s are slugified from heading text at runtime, on
every section heading regardless of the nav threshold, and the component finishes an incoming
`#hash` by hand (native fragment scroll ran before the ids existed, so without that step every sent
link lands at the top). So `/policies/shipping-policy#custom-personalized-orders`-style links are
supported customer-facing URLs, but they are only as durable as the wording: a reworded heading
changes its anchor and nothing notices, unlike the FAQ's `custom_anchor` values. The escape hatch:
the component assigns an `id` only to a heading that has none, so an `id` written into the Admin
body wins; that works on operator-authored policies, not the auto-managed privacy body, which
Shopify rewrites. The nav also depends on the Admin bodies having real `h2`s at all,
which is why the body cleanup (paste-artifact classes, `&nbsp;`, `<strong>`-wrapped headings, `h4`s
collapsed to `h3`) ran against `REFUND_POLICY` and `SHIPPING_POLICY` via `shopPolicyUpdate` before
this shipped, gated on byte-identical wording assertions and durable backups.

**`scroll-margin-top: 150px` is duplicated between the snippet and `sections/faq.liquid`, and a
third offset already exists.** `--scroll-margin: 50px` in `snippets/theme-styles-variables.liquid`
is consumed by `blocks/_accordion-row.liquid`; reusing it meant changing its value under an existing
consumer or minting a second token, so the duplication won on cost. A header height change has to
visit both hardcoded sites; both carry a comment saying so.

**Coverage changes, and why each one is shaped the way it is.** `scripts/a11y/paths.json` takes its
first deliberate exception to one-path-per-template: three policy paths with `"template": null`,
because the pages share one rendering path whose nav branches on Admin content: refund (9 `h2`s)
exercises the nav, terms of service (none) the hidden branch on the largest body in the store, and
privacy is auto-managed so its body changes with no commit here. `paths.test.mjs` now also asserts
every declared template exists on disk, closing the direction that a deletion used to slip through.
`/policies/refund-policy` joined the `smoke-paths` default: the sitemap does not list policy pages,
`hasMerchantReturnPolicy` points at this one, and a 404 there usually means an emptied Admin policy.
The list's two copies (action.yml authoritative, `smoke.mjs` fallback for standalone `--dry-run`)
are held together by a drift test. None of these checks asserted that the nav actually renders,
which was recorded here as the open gap; that presence probe has since shipped, as a SOFT-WARN, and
is written up under "Smoke: the policy pages get a markup assertion" above.

**A drift report is a claim to verify, not a diff to apply.** `THEME_CHECK_NON_ACTIONABLE.md`'s note
that the `policy` object lives in `templates/policy.liquid` was "corrected" mid-change to `.json`
because it looked stale; it was the one place recording a real constraint. It now records the deeper
one: the section never renders anywhere, so its two `UndefinedObject` warnings are doubly inert.

## FAQ: category headings, and the content to justify them (unreleased)

The page went from 12 questions to 30 in one change, which is the part that forced the theme work:
a flat list of 30 rows is not scannable, and five headings make it one.

**One section, not five.** Grouping by splitting the page into five `faq` sections would have been
the smaller diff, and it would have emitted five `FAQPage` nodes and five Expand All buttons on one
page. So the grouping lives inside the section instead, as a `faq_heading` block type carrying a
single `heading` text setting.

**A heading block is excluded from the `FAQPage` JSON-LD by construction, not by a guard.** The
loop already skipped any block whose `question` or `answer` was blank, and a `faq_heading` block has
neither setting, so it never satisfies the condition. That is worth knowing before adding a third
block type: one that happens to carry a `question` setting would start appearing in the structured
data with nothing added to the loop to let it.

**The heading renders outside `.faq-row`, which breaks the first-child border, and that is fine.**
The top border of the list came from `.faq-row:first-child .faq-item`, and that selector stops
matching the moment a heading opens the list. Nothing replaces it: the heading's own 2px rule is the
top border of its group's first row, and a hairline sitting 10px under that rule reads as a mistake.

**A category label is smaller than a question, not bigger.** The first pass styled the headings as
scaled-up questions, which is exactly what makes a heading disappear: at a glance it is one more bold
row in a column of bold rows, and the grouping buys nothing. They are instead set smaller than the
question text, uppercase, tracked out at 0.14em, dimmed slightly, and carried on a rule across the
column, with 56px of air above. Different axis, not more of the same one.

**The schema had no `max_blocks`, and Shopify's default is 16.** The page now holds 35 blocks (30
questions plus five headings), so the section declares `max_blocks: 50`: headroom rather than an
exact fit, and 50 is the ceiling the platform allows. A future editor who hits that limit is not
looking at a bug in the section.

**Existing block ids and question wording are unchanged on purpose.** Anchors are generated as
`question | handleize | truncate: 50`, so rewording a question silently breaks every link anyone has
shared to it. Reordering the `block_order` array is free; editing the `question` string is not. The
vacation entry keeps its `away-from-studio` custom anchor, which every vacation surface deep-links
and nothing in CI checks.

**Several of the new answers state facts that live nowhere in this repo.** Cat-allergy handling,
gift-note and packing-slip behaviour, PO box and APO/FPO deliverability, local pickup, and whether
promo codes exist are operator knowledge, not code. They were drafted from the shop policies and the
Admin API where those could answer, and flagged for the operator where they could not. Shipping
numbers, tracking behaviour, split-shipment behaviour and the response-time figure are copied from
the Shopify policy pages, which makes them a fifth thing to update when a policy changes: the
four sources of truth in CLAUDE.md's shipping-copy note, plus this page.

## Reorder review: a purchase list the tool renders, not the operator (unreleased)

Another follow-up in the read-only half. Nothing here writes to the store, edits `thresholds.json` or
`catalogue.json`, or changes a gate, and the existing `reorder` and `reorder --json` output is
byte-identical to before.

**The reorder list and a purchase list are different questions, and one shape cannot serve both.**
The list is sorted by shortfall because it answers "where do I look first", so it mixes bodies,
colours and states together. At a supplier's size run the operator needs the opposite: one garment
body at a time, then one colour, only the short sizes, with a count per colour and per body.
`reorder --purchase-list` renders exactly that, from `buildPurchaseList` and `renderPurchaseList` in
`lib/reorder.mjs`; the command reads the flag and prints, as the rest of that file's commands do, and
the two functions add no import, so the existing test asserting the module cannot reach a mutation
still covers them.

**This existed before as a hand-rendered view, and that is the mistake being corrected.** The format
took four rounds of throwaway scratchpad scripts to reach, and every one of those rounds re-derived
buy quantities off the printed matrix. Three kinds of cell must never become a buy line, and a
hand-built list silently includes all three: a `min: 0` cell, which is how "we do not make this
combination" is recorded; an unsettled cell, whose group has a member range and not a reading, so
both ends are wrong (the low end over-orders by the whole fan-out, the high end under-orders); and a
cell with a minimum but no blank group at all, whose full minimum looks like a quantity while
actually meaning "this blank does not exist yet", which is a tagging problem for `audit`. None of the
three is a rounding decision. The filter now lives in the tool, and the skill says to produce an
order sheet only through the flag for exactly that reason.

**An unsettled cell is named only when the unknown reading could change the order.** A range whose
lowest member already meets the minimum buys nothing whichever reading turns out to be true, so
listing it would send the operator to recount a group that can never need a purchase. That mirrors
`flagReorders`, which flags an unsettled cell only when even its highest member is short: both refuse
to cry wolf over a group that is merely mid-fan-out.

**The excluded cells print before the total and say "none" when there are none.** A block that
appeared only when it had something to say would make its absence ambiguous: an operator cannot tell
"nothing was excluded" from "the tool did not check" by looking at a gap. When nothing is short at
all the output says so in a sentence rather than printing a bare zero total, which reads as a failed
run. A negative on-hand stays unclamped, mirroring the reorder list, so an oversold cell buys the
oversell back as well as refilling the minimum.

**There is deliberately no `--purchase-list --json`, and the combination is refused.** `--json` exists
to be consumed by a program, and a program consuming buy quantities is precisely the write-adjacent
path this output must not open: these numbers are a supplier-ordering aid, never a restock quantity,
never a count-sheet entry, never an input to an inventory write. Receiving a shipment still needs an
independent physical count. Do not add a JSON form without revisiting that guardrail, which is stated
in the skill and echoed as a footer on the output itself; the footer is a reminder, and the skill
clause is the enforcement.

## The catalogue's shape moves into catalogue.json (unreleased)

Read-only throughout. Nothing here writes to the store or changes a deploy gate.

**The problem: one file was doing two jobs, and only one of them was written down.**
`scripts/blank-inventory/thresholds.json` held inventory policy (minimums, budgets, provenance), and
it was also, silently, the only record of the catalogue's body by colour by size shape. That shape
was never stated; it was inferred as a full cross product of the approved bodies against the global
colour vocabulary and the global size vocabulary learned from the store. The women's vest is made in
Black only, so the product invented twelve vest cells in Grey Heather and Classic Navy that no
variant can ever fill. The 2026-08-24 blanket floor then raised all twelve to `min: 2`, and they
became permanent `no-group` flags in every reorder report. The floor was not the bug; the invented
cells were, and the floor made them visible.

**The split: facts in one file, policy in the other.** `catalogue.json` at the repo root declares
which bodies exist and which colours and sizes each one is made in. `thresholds.json` keeps its path,
its name and its schema, and becomes policy only: its required keyspace is now computed from the
manifest rather than stored anywhere. The reorder review builds its cells per body, so the vest
matrix is one colour row.

**Why the repo root, and not beside the tool.** The same vocabulary is restated in at least five
other places (`scripts/sku/tables.json`, `scripts/lib/photo-naming.mjs`, the `scripts/size-chart/`
profiles, `scripts/applique-grid/patterns.json`, and blank-inventory's own `SIZE_ORDER` and test
fixtures), and nothing reconciles any of them. A shape file living inside one tool would have become
that tool's private copy, which is the problem it exists to end. Nothing else was rewired here; each
migration is its own item under `TODO.md` > Catalogue manifest adoption, so this change stays one
revertable commit.

**Why not derive the axes from what is tagged.** Because coverage would then shrink silently: a body
whose variants are not yet in a blank group would drop out of the table exactly when it most needs a
minimum. The header comment on `buildAxes` in `lib/reorder.mjs` has said so since the review was
written, and that reasoning survives the split unchanged.

**Why not put the colour ranges in the body map.** The approved body-map artifact is machine-local
state in `~/.local/state/blank-inventory/`, hash-sealed, never hand-edited, and regenerated on every
re-propose. A hand-authored range would not survive a re-propose, and it would not appear in a PR
diff, which is the only review surface this feature has. The two artifacts stay separate with a
declared contract instead: the body map is the authority on which product is which physical garment,
the manifest is the authority on each body's range, and they must agree exactly on the set of bodies.
Both directions of that disagreement refuse. That is safe to make a refusal rather than a warning
because the body map is loaded fresh on every command invocation, so a mismatch at reconcile time is
always real drift and never a stale read.

**One new refusal, and the change adds no others: a live tagged variant whose body plus colour plus
size the manifest does not declare.** The old cross product provided this check by accident, since an
undeclared colour showed up as unthresholded cells. Declaring the shape would have removed that
accident, so the check is now explicit and stronger: a new colour is loud the moment a variant is
tagged into it, whether or not the thresholds file has caught up. Untagged variants are out of scope
for the same reason they are out of scope for `learnVocab`: nothing untagged is in a blank group. The
gate runs before `thresholds.json` is even read, in one helper both `reorder` and `demand` call, so a
wrong cell space cannot be reported as a list of its own downstream consequences.

**The data migration, in the same change.** The twelve undeclared vest rows are deleted from
`thresholds.json`, `provenance.budgets["vest-womens"]` is recomputed from 36 to 12 to match the
remaining cell sum (the same precedent the 2026-08-24 floor set, so `demand` reports no
`budgetDrift`), and `provenance.colorCurve["vest-womens"]` is trimmed to Black alone. One appended
`provenance.adjustments` entry records the twelve moves as 2 to 0 with a note saying the rows were
then removed; the log stays append-only and its entries are still validated by shape alone, never
cross-referenced against current cells. The arithmetic is CI-verified rather than eyeballed: a new
test reconciles the two committed artifacts against each other offline and asserts every body's cells
sum to its stated budget.

**`lib/reorder.mjs` deliberately does not import the new module.** A test asserts its import list is
exactly `['./groups.mjs']`, which is what makes "this module cannot reach a mutation" a proof rather
than a claim. `buildAxes` therefore takes the per-body ranges as plain data, and only the CLI and the
new lint import `lib/catalogue-manifest.mjs`. The same test now pins the new module's import list and
the lint's.

**Ordering rules, pinned in tests because a silent change to either churns a committed file.** Bodies
are sorted by code point, not by manifest declaration order, so reordering bodies in the manifest can
never move a line in `thresholds.json`. Colours follow manifest order, because that is the matrix row
order a reader sees. Sizes stay in garment order.

**A refused key name is JSON-quoted, and the CI step uses a random heredoc delimiter.** Two guards
for one hole found in review. The lint's refusal messages quote key names out of `catalogue.json`,
and CI captures that text into `$GITHUB_OUTPUT` under a heredoc. With the fixed `GHEOF` delimiter the
repo used everywhere, a key containing a real newline plus a `GHEOF` line closed the block early and
let a following `exit_code=0` overwrite the honest exit code, so a refused lint merged green. This
was reproduced, not theorised. The delimiter fix matches the precedent the contrast step already set
for the same reason; the escaping is the half that closes the class rather than the instance, since
a key can no longer span lines in any message at all.

**One refusal shape, including for a malformed manifest.** A parse or schema failure used to print
its own narrower `{error, message, keys}` while every other gate failure went through
`refusalPayload`'s four fields. A `--json` consumer reading `refusals` therefore crashed on exactly
the case the shape exists to describe. `assessCatalogue` now carries the parse failure as a
`catalogue-invalid` refusal, so the command layer has one path and one shape.

**Rollback posture.** The whole change is one revertable commit plus one data file. If the new
undeclared-variant refusal ever blocks routine use after merge, the fix is to declare the missing
colour or size in `catalogue.json` in a reviewed PR. Never relax the check, and never untag a variant
to make it pass.

## Reorder review: readable output, per-body totals, a receipt archive (unreleased)

Follow-up to the reorder review below, all of it in the read-only half. Nothing here writes to the
store or changes a gate.

**The report now answers the question it is read for, without arithmetic by hand.** `reorder` prints
a per-body totals block: on-hand units against minimum units, with the shortfall and the surplus
counted separately rather than netted, and the same figures go into `--json` under `totals`. That
distinction is the one the matrix cannot show at a glance: a body that is short with no surplus needs
more units, and a body with both is holding roughly enough units in the wrong sizes or colours. The
computation is `bodyTotals` in `lib/reorder.mjs`, deliberately in that file rather than a new one so
the existing test asserting the module imports no mutation path covers it too, and the command layer
only prints it.

**Those sums are not the reorder list's total, on purpose.** The list counts a cell with no group at
its full minimum and an unsettled cell from its highest member, which is right for "where do I look
first" and wrong for "how does this body's settled stock compare with its settled minimums". The
totals block therefore sums settled cells only, and prints how many cells it excluded, so an excluded
cell can never be read as a settled zero. Averaging a mid-fan-out range would invent a number no
variant holds, which the pivot already refuses to do.

**The shortfall column leads the reorder list**, which was already sorted by it, and the heading
carries the total units short. It stays named "short" rather than becoming an order quantity: this
report tells the operator where to look, never what to buy, and a column that reads as a purchase
figure would quietly undo that.

**`audit` archives expired seeding receipts instead of listing them.** A seeding receipt older than
24 hours has stopped explaining anything, and 78 of them printed one per line buried the report that
named them; the run had to be repeated with a redirect just to be readable. They now move to
`<workdir>/archive/`, summarised in one line (count, date range, destination). The decision of which
files may move is a pure function in `lib/receipt.mjs` (`receiptsToArchive`), handed the full
population so no caller can widen the selection; only the command layer touches the filesystem. A
fresh seeding receipt is never archived, because it is the only thing distinguishing awaiting-seed
from drift. Failures are skip-and-report: a vanished source or a name already in the archive costs
that one file, never the audit. **The move is one-way and local**: reverting this change does not put
an archived receipt back in the working directory root, and nothing reads it there anyway, since the
reader globs the root and does not recurse.

That step is why `audit`'s `--json` `staleSeedReceipts` is now an object (`archived`, `skipped`,
`dir`) rather than a list of filenames: the files it used to name have moved, so the old shape would
hand a consumer paths that no longer resolve.

**thresholds.json: every minimum floored at 2, operator-directed.** Thirty-five cells moved (sixteen
from 0, nineteen from 1), nineteen were already at 2 or above, and the per-body totals went from
36/28/8 to 47/40/36. Budgets were recomputed in the same edit because a body's cell sum is expected
to equal its budget, and leaving them stale would make every future demand pass report budgetDrift.
The consequence to know: `min: 0` was also how "we do not make this combination" was recorded, so
cells with a minimum and no blank group on the store now sit permanently in the reorder list flagged
`no-group` until a blank exists or the operator zeroes them again. That is the directive's intent
(every colour and size), not an oversight. No regression test asserts `min >= 2`: the operator may
legitimately re-zero a cell later, and a test would fossilise today's policy rather than protect it.

The skill gained the rule that follows from all of this: every derived number comes from `--json`,
never re-typed off the terminal and never lifted from a rendering built earlier, because a
transcription step is exactly where one wrong digit becomes a wrong conclusion. An organised
rendering on top of the verbatim output is sanctioned, provided the raw output survives unabridged in
an appendix and the rendering stays inside the conversation, since it carries live stock quantities.
It also gained a procedure for operator-directed threshold edits, whose two load-bearing points are
that a prior instruction sets the shape of an edit and never approves its numbers, and that a budget
change is always its own STOP rather than a rider on a cell edit.

## Reorder review: on-hand against a committed threshold table (unreleased)

The blank-inventory tooling could report what stock exists and keep it in sync, but it could not
answer the question that actually precedes a purchase order: where are we thin, per size and colour,
and what should I reorder. Two read-only commands now do. `reorder` pivots the tagged catalogue into
a colour x size matrix per garment body and compares each cell against
`scripts/blank-inventory/thresholds.json`, a committed table of recommended minimum on-hand
quantities. `demand` reads recent orders and proposes adjustments to that table. Neither writes to
the store, neither is in `writeCommands`, and `lib/reorder.mjs` imports nothing but `lib/groups.mjs`
(a test asserts the import list, because the module header names `mutations.mjs` in order to forbid
it and a substring grep could not tell the prohibition from the violation).

**The resolved cells are the source of truth, not the curves and budgets they came from.** The
minimums were derived from published size-distribution and colour-popularity figures scaled by one
operator-stated budget per garment body, and all three are kept in the file as provenance. But the
file stores the resolved per-cell number, because the file's whole review surface is a PR diff: a
reviewer can read "crewneck black M: 6" and judge it, where two curves plus a budget plus a rounding
rule is four things to re-derive by hand before the diff means anything. Storing the inputs and
computing the cells at read time would have been smaller and strictly worse to review.

**Colour is derived, not stated, exactly as size is.** The first cut asked the operator for a budget
per body+colour and derived only the size split. That is a second source of truth for a number a
popularity curve already determines, and this repo has been bitten by that shape before (the social
links entry below is the same lesson). So the budget is one number per body, a colour curve splits it
across colours, and the size curve splits each colour's share; both stages are largest remainder, so
a body's cells sum to its budget exactly with no rounding leak between them. The demand pass then
redistributes across colour and size together, because a recalibration that only reshuffled sizes
would leave the colour mix on its original guess with nothing ever testing it.

**An unsettled group is flagged only when its highest member is below the minimum.** A blank group
holds several different quantities for the 80 to 90 seconds the sync Flow takes to fan a change out.
Averaging them would invent a number no variant holds, so the cell prints the range and its `onHand`
is null. The flagging rule then has to pick an end of that range, and picking the low end means every
group mid-fan-out reports a shortfall: right after an apply that is most of them, and a report that
cries wolf during normal operation is one nobody reads. The high end under-reports briefly and
corrects itself on the next run, which is the survivable direction. The counts of unsettled and
no-group cells are printed in both the full and the `--below` view for the same reason: those are
exactly the cells a terse list would otherwise hide, and "not listed" reads as "fine".

**thresholds.json is never touched by a command, including the commands that read it.** Every
refusal path was an opportunity to "fix" the file so the report would run: a missing cell, a stale
key, an absent file. All of them stop and report instead. The file is generated once, reviewed in a
PR, and afterwards hand-edited only behind a per-run operator approval, because the PR diff is the
only review this feature's numbers ever get, and a tool that edits its own thresholds to make its
own output pass has removed it. `provenance.adjustments` is append-only for the same reason: a
rewritten history cannot be audited.

**Why business quantities are safe in a public repo, and where the line is.** The keys are the
normalised vocabulary form (lowercase `body|color|size`), which by construction cannot match the
blank-id guard's uppercase-underscore shape, so no supplier-encoded id can hide in one. The values
are unit counts the operator chose. What must never enter the file, an `adjustments` note, or a PR
body touching it: supplier or wholesaler names, vendor SKUs, case-pack sizes, unit or wholesale
costs, contract minimums, lead times, supplier URLs, dollar amounts of any kind, and anything
order-derived that identifies a customer or a single order. The demand pass enters the file only in
aggregate.

**Duplicate keys are detected in the raw text, not after parsing.** `JSON.parse` is last-wins and
silent, so a bad merge leaving two entries for one cell parses cleanly and applies the minimum
nobody reviewed. The check walks the document's tokens before the parsed object is trusted, and a
test asserts that `JSON.parse` on the same text really does take the wrong number.

**The demand window is bounded by the scope, and the command refuses rather than shortening it.**
`read_orders` reaches about 60 days; older history needs `read_all_orders`, which this app
deliberately does not request. Asking for a longer window than the granted scopes can serve is a
refusal, and every run prints the earliest order date actually returned, because a proposal built on
a window the operator did not get is worse than no proposal. Two holds keep the model from ratcheting
a blank out of existence: a body+colour with almost no observed sales holds its minimums, and a cell
whose on-hand sat at or below its own minimum is held out of the redistribution, since a stocked-out
cell's zero sales are not evidence of zero demand. The model itself is deliberately thin: proportional
redistribution of a fixed budget by recent share, with no lead-time or safety-stock term, and sales
attributed through the current variant-to-blank mapping, so re-tagging a variant rewrites its own
history.

`demand` has been run against the live store, and returned zero orders: `read_orders` and
`read_all_orders` are both granted, but the storefront is still password-gated, so the window is
genuinely empty and every cell held at `insufficient-data`. That exercises the scope gate, the
pagination and the holds, and leaves exactly one thing unexercised: aggregating a real line item.
The README says so rather than calling the command verified.

## Social links on every surface, from one source of truth (unreleased)

Social links used to render in exactly one place, as three muted icons in the footer utilities
bar, and their URLs lived in two unreconciled places. They now render on the footer, the homepage,
the desktop header and the mobile drawer, all from the five `settings.social_*_link` theme
settings, through the single new `snippets/social-links.liquid`. The first cut of this work also
placed them on About, Contact and FAQ and kept the utilities-bar icons; a visual walk cut those
back, for the reasons in the last three paragraphs of this entry.

**The consolidation was the point, not a side effect.** The old footer block
(`blocks/social-links.liquid`) carried its own thirteen `*_url` block settings in
`sections/footer-group.json`, while `snippets/structured-data-organization.liquid` read the theme
settings for `sameAs`. They happened to agree, but nothing reconciled them and no test covered it.
Adding six more surfaces on top of two sources would have multiplied the drift, so the URLs moved
to theme settings only. This is the pattern `CLAUDE.md` already prescribes for two blocks that must
agree on a value, and `snippets/size-option-position.liquid` is the model it names.

**The eight extra platforms were dropped rather than promoted to settings.** The old block had
thirteen URL fields; the five that survive leave Threads, LinkedIn, Bluesky, Snapchat, Tumblr,
Vimeo, a custom URL, and X/Twitter. All eight were blank, and none of them reached `sameAs`, so
keeping them would have meant adding eight `settings_schema.json` entries and eight `sameAs`
branches to preserve capability nobody was using. X is a special case: `CLAUDE.md` records why
there is deliberately no `social_twitter_link` theme setting, so it cannot come back by the
settings route either.
The trade accepted here is that adding a platform later is a code change to the snippet plus a
theme setting, not an editor field. If one becomes a near-term plan, it goes in as a settings entry
rather than being wedged into the block.

**`blocks/social-links.liquid` was left in place rather than migrated or deleted, but it was taken
off the footer schemas.** The file itself is upstream Horizon; editing it creates conflicts at the
next upstream merge, and deleting it makes that merge noisier still. Leaving the file alone is not
the same as making it unreachable, though: `social-links` stayed an allowed block type in
`sections/footer.liquid` and `sections/footer-utilities.liquid`, and the latter's
`policies_and_links` preset still placed one. Either route hands an operator a fresh thirteen-field
URL block through the editor, restoring the second source of truth as a `footer-group.json` diff on
a reconcile PR that no grep for the block *file* would catch. So both schema entries are gone and
the preset now places `follow-us`. One route survives on purpose: the block carries its own
`presets` entry, so it is still offered on sections that declare `@theme`, and closing that would
mean editing the upstream file. `CLAUDE.md` names it, along with `blocks/_social-link.liquid` and
`blocks/_footer-social-icons.liquid`, so a grep for any of the three lands on the warning.
Its `footer-utilities__icons` class was declared and styled nowhere, so nothing had to be carried
forward.

**The shared CSS lives in the snippet's `{% stylesheet %}`, not in `blocks/follow-us.liquid`.**
This is load-bearing rather than stylistic. `snippets/header-actions.liquid` and
`snippets/header-drawer.liquid` render the snippet directly and never touch the block, and Shopify
subsets block CSS to the pages where that block renders. Rules kept in the block would have left
the header and drawer styled only by accident, via the always-present footer instance, and would
have broken silently the moment that footer block was removed or hidden. Only the block wrapper's
own alignment rules stayed in the block, where their scope is correct.

**Handle derivation is why the Facebook URL had to change.** The snippet shows an `@handle` derived
from each URL's last path segment. The query string and fragment are dropped first, so a profile
URL carrying `?utm_source=...` still yields its real handle; the fallback guard (`.php`, `?`, `=`,
or a blank result) is then applied to the extracted segment only, never to the whole URL. The
stored Facebook value was `facebook.com/profile.php?id=61583934266282`, which passes the
has-a-profile-path check but yields no usable handle, so it would have rendered the bare word
"Facebook" beside four real handles. It was changed to the vanity form
`facebook.com/sapphireshadowstudio`, which also makes the `sameAs` entry a nicer identifier. The
forward-looking rule, recorded in `CLAUDE.md` because nothing in CI enforces it: keep these
settings in vanity-slug form.

**The header row went into `header-actions`, not the header-row slot machinery.**
`sections/header.liquid` builds its slot `order` string across eight `assign order = ...` branches,
one per localization-by-search-position combination. A `social` token would have meant editing all
eight, adding a `capture`, adding a `when` arm to `snippets/header-row.liquid`, and adding two
position and row schema selects, for a row that only ever appears in one place. Inserting into
`header-actions` is one insertion point and reuses the existing `.header-actions__action` sizing.
The cost is that the row cannot be repositioned from the editor, only toggled, via the new
`show_social_icons` header setting (schema default `false`, on for this store). Mobile is covered
by the drawer, so the header row is `mobile:hidden` and the mobile header stays uncrowded. The
drawer row is gated on that same setting rather than being unconditional: a merchant switching off
"Social icons" means the header, and the drawer is this feature's mobile half, not a separate
surface, so one toggle governing both is the least surprising behaviour.

**The `sameAs` array gained the renderer's has-a-profile-path test.** It previously skipped only
blank settings, so a bare platform homepage would have rendered nowhere on the storefront while
still asserting the entity claim that snippet's own doc block prohibits. That was invisible before,
because there was no second consumer of the same settings to disagree with. Today's three URLs all
have path segments, so the emitted array is byte-identical; the change closes a divergence rather
than fixing a live defect. The platform list is still duplicated between the two snippets, which is
the one piece of coupling this consolidation did not remove: `social_keys` there and
`social_platforms` in the renderer must be edited together, and `CLAUDE.md` says so.

**The footer gained a third column.** It is a heading plus a stacked list of handles.
`sections/footer.liquid` derives its grid from `section.blocks.size`, so two columns became three
with no CSS work. The utilities bar briefly carried a second instance as well, reusing the old
block id with the type swapped to `follow-us` in compact form; that instance is gone (see the
one-treatment-per-region paragraph below) and the utilities bar is back to copyright and policy
links.

**The header row uses `compact` (icon only) rather than visible handles, for space, not by
downgrade.** It sits inside the right-side actions cluster beside search, account and cart, where
three `@handle` strings would crowd out what is there. The utilities-bar instance was compact for
the same reason, a single `text-wrap: nowrap` line already holding the copyright, before it was
removed. `variant` is a per-instance block setting, so switching the header to handles is a
one-word JSON change.

**One handle treatment per page region, which cost three placements and the utilities-bar icons.**
A visual walk of the preview theme showed the same three handles four times in a single homepage
viewport: header icons, the new closing section, the new footer column, and the utilities bar under
it. Repetition at that density stops reading as an invitation and starts reading as a template
artifact, and the footer's two instances sat close enough that they looked like one list broken in
half. So the utilities-bar instance came out (the footer column is the footer's follow surface) and
the About, Contact and FAQ page-level blocks came out with it. Those three were the weakest of the
set on their own terms as well: each was a bare heading and three handles appended after the page
content, with no supporting copy, and About and Contact left-aligned theirs while FAQ centred its,
so the same component read as three different things. The footer follow column carries those pages
now. What stayed placeable did not change: `follow-us` is still an allowed block type on both footer
schemas and the block is still offered in the editor, so restoring any of these is an editor action
rather than a code change. `social-links` stays off both schemas; that is the reintroduction route
this branch deliberately closed, and it is not reopened by removing an instance.

**The homepage section kept its place by being differentiated, not by being defended.** It sits
last before the footer, and on `scheme-1` it painted a white band across the cream-to-dark run that
the editorial and closing sections establish, so it read as a seam before the footer rather than as
a section of the page. Moving it to `scheme-3` (`#eef1ea`) puts it on the same band as its two
siblings, and an eyebrow (`FOLLOW ALONG`, copying `cta_eyebrow`'s settings verbatim) gives it the
same three-part lockup they use. The section now differs from its neighbours in content, not in
chrome, which is the reason to keep it while the page-level blocks go: the homepage placement earns
its space by matching the page, and the page placements earned nothing by not matching theirs.

**The accessible name follows the handle, not the variant.** It used to be branch on
`social_variant`: `handles` got "Facebook: @sapphireshadowstudio", `compact` got "Facebook". Same
destination, two names, which is the thing a screen-reader user notices when the header and the
footer disagree. WCAG 2.5.3 (Label in Name) settles which way to unify: where the visible label is
the handle, the accessible name has to contain it, so the compact variant lengthens to match rather
than the handles variant shortening. Keying on `social_handle_valid` instead also fixes a latent
case the variant test could not see: a URL that derives no handle falls back to the platform name
for its label, which the old handles branch would have rendered as "Facebook: Facebook". No new
locale keys, since both message forms already existed.

## Variant button index: fieldset numbering vs. option numbering (unreleased)

Selecting the LAST color on a product page left the button blank: white label text on a white
button, with no selected pill behind it. Only the last value of a button-style option could show it,
and only after a click.

The cause is a contract between `snippets/variant-main-picker.liquid` and
`assets/variant-picker.js` that the theme's long-option dropdown addition broke. The snippet
numbered `data-fieldset-index` with `forloop.index0`, the option's position among ALL options. The
JS reads that attribute as an index into `refs.fieldsets`, which holds only the fieldsets that
actually rendered. Upstream Horizon renders one fieldset per option, so the two numberings agree.
Once an option past `settings.variant_dropdown_threshold` collapses to the select branch, which
emits no fieldset, they diverge: on a Design / Color / Size product where Design and Size both
collapse, Color rendered `data-fieldset-index="1"` while it sat at index 0 of a one-element array.
`updateSelectedOption` looks up `fieldsets[1]`, gets `undefined`, and its whole state-update block is
guarded behind `if (radios && checkedIndices && fieldset)`, so it silently did nothing.

The visible failure came from that no-op leaving `data-current-checked="true"` on the FIRST value
forever. The 3-or-more wrap-around rule
`.variant-option--buttons:has(:nth-of-type(3)) ...:has([data-current-checked=true]):first-of-type ~
label:last-of-type` then held the last label's pill at `calc(100% + 1px)`, translated out of the
button and clipped away, while `:has(:checked)` still applied the selected white text color. Middle
values were unaffected, which is why the bug looked specific to one color.

The fix numbers `data-fieldset-index` by rendered fieldsets, not by loop position. The durable rule:
`data-fieldset-index` is an index into the rendered-fieldset array, so anything that makes an option
skip the fieldset branch has to keep that numbering dense. Nothing in CI checks it, and the failure
is silent in the DOM and only visible on the last value of the last button option.

## Launch countdown on the password page (unreleased)

The pre-launch gate showed "Opening soon" with no date, in the Horizon default white scheme, so it
read as a placeholder rather than as the store. It now carries a live countdown to a hardcoded
launch instant and renders in the brand's `sss-dark-scheme`. The whole surface is temporary: the
removal list is the standing `TODO.md` item, not this file.

**The launch instant is three literals that move together, and nothing checks that they agree.**
`blocks/launch-countdown.liquid` assigns `launch_at` (the machine-readable instant, also handed to
JS through `data-launch-at`) plus two hand-authored display strings: the visible date line and the
screen-reader sentence. The obvious alternative, deriving all three from
`launch_at` with the `date` filter, was rejected because that filter renders in the **shop's**
timezone, so the page would silently misstate the time if the shop timezone were ever not Eastern.
The cost of that choice is that changing the date in one place and not the others ticks the digits
toward the new date while the visible lockup and the accessible sentence keep asserting the old one.
Nothing errors and nothing in CI catches it, so the three assignments are kept adjacent in one
`{% liquid %}` block with a doc note saying they move as a unit.

**The date line is set in the heading face, not the brand cursive.** It was cursive, and the
cursive looked like two fonts in one line: Dancing Script draws its lowercase as connected script
and its capitals and digits as upright formal letters, and a date is mostly digits and capitals.
Verified rather than assumed, since "two fonts" normally means a missing glyph falling back:
`document.fonts.check` returns true for lowercase, uppercase, digits and the middot, and the string
renders whole with no fallback in the stack. So it was always one font, and the fix was typographic,
not a font swap. That also made the block the only thing on the password page using Dancing Script,
so its duplicated `@font-face` and 42 KB preload came out; `sections/hero.liquid` still carries the
original for the homepage lockup.

**The countdown's eyebrow is the page's `<h1>`.** The template used to carry an "Opening soon" text
block for that, which the gradient panel behind the countdown ended up washing out, and which said
less than the countdown directly beneath it. Removing it took the page's only heading with it, so
the heading role moved onto the eyebrow. Nothing in CI checks heading structure, so adding a heading
back to the template means demoting that one by hand.

**Zero-padding is asymmetric on purpose, on both sides of the wire.** The house idiom
`value | prepend: '0' | slice: -2, 2` is correct for 1 and 2 digit inputs but truncates 3 digit
ones: `100` becomes `"0100"`, and the slice returns `"00"`, dropping the hundreds digit. Days can
exceed 99, so days renders unpadded and only hours, minutes and seconds are padded. This is a
cross-layer contract: `assets/launch-countdown.js` has to mirror it exactly, because the Liquid
output is what paints first and the JS output is what replaces it a moment later. A mismatch is not
a crash, it is a visible jump between first paint and the first tick.

**The digits are `aria-hidden` with a static visually-hidden equivalent, not an `aria-live`
region.** That is a deliberate exception to the repo's global "auto-updating regions get
`aria-live`" rule, since a per-second live region floods a screen reader for no benefit. It is not
what discharges WCAG 2.2.2 for the page's three decorative loops; that is a separate accepted
deviation, recorded in `docs/accessibility-patterns.md` next to the announcement bar's existing
one.

**The brand gradient is contained to a panel behind the countdown, not run across the page.**
It started section-wide, which is how the announcement bar does it. Previewing that showed the
cost: the logo is a mid-blue wordmark on transparency, and a shifting multi-hue field behind it
left it reading as blue on blue. The gradient now lives on the countdown block's `::before`, masked
to a radial fade so it ends without an edge, and everything outside it is the flat `#071e3f` scheme
ground, where the logo reads in its own colour at its own size. `settings.logo_inverse` is the
theme's intended answer to a logo on a dark ground, but it currently points at the same asset as
`settings.logo`, so asking for it changes nothing.

**The dark treatment reaches outside the section, so it is hardcoded in the layout.** A scheme class
on the section alone leaves the storefront-password dialog and the footer white, and the dialog is
full-viewport, so it would flash a white panel over a dark page. The class therefore sits on
`<body>` in `layout/password.liquid`, where there are no section settings to read a scheme id from.
Deleting `sss-dark-scheme` in Admin degrades the page to the default scheme rather than breaking it.
All three password files are upstream Horizon files and now carry rows in README's
"Deviations that must survive a merge" table.

## Shopify Email templates live in the repo, outside the theme (unreleased)

`marketing/emails/` holds custom-coded Liquid/HTML emails for Shopify Email campaigns and
automations: `campaign-shell.liquid` (clone it for a new campaign) and `welcome.liquid` (the
"you are on the list" automation), plus a README that is the operating manual.

**They sit outside the theme directories because Shopify Email has no API and no theme surface.**
There is no way to push a campaign template; the only path into a campaign is a human pasting the
whole document into the custom-code editor, which is desktop-only. Keeping the files in `templates/`
or `snippets/` would have put non-theme code inside the deployed surface, where `shopify theme push`
would ship it and a future reader would reasonably assume it renders somewhere. A top-level
`marketing/` directory reads as what it is, and nothing in it reaches the live theme. Note where
that protection actually comes from: there is no `.shopifyignore`, and `deploy.yml` pushes the whole
working tree, so what keeps `marketing/` out of the upload is the Shopify CLI's own allowlist of
recognised theme directories, not anything repo-side. A future CLI that widened that allowlist would
change the answer silently.

**`marketing/**` is in `.theme-check.yml`'s ignore list for the same reason, not as a convenience.**
Email Liquid resolves objects that a theme does not have (`unsubscribe_url`, `open_tracking`,
`email.*`) and lacks the ones a theme does (`section`, `block`, `settings`). Every email template
would therefore emit undefined-object findings forever. The ignore landed in the same change as the
templates so CI never went red on an intermediate push.

**The repo file is canonical, and drift is the failure mode to watch.** An edit made inside the
Shopify Email editor while testing is invisible to everything here: no CI check, no script, and no
Admin API can read it back. This is the same shape as the social-links and shipping-copy drift
already documented in `CLAUDE.md`, and the README states the rule (copy editor changes back in the
same sitting). Reversal is a `git revert` plus a re-paste; nothing here deploys.

**`welcome.liquid` is written for a store that has not opened, and that is a state with an expiry
date.** The storefront password is on, so every storefront URL resolves to Shopify's "Opening soon"
page. The first draft of this email led with a "Meet the studio" button pointing at `/pages/about`,
which is a password wall to every recipient: the one thing most likely to make a new subscriber
conclude the brand is broken. The prelaunch version links nobody to the storefront. The header
logo is an unlinked image, the footer names the domain without linking it, and the single button
goes to Instagram, which is public, as do the three links in the footer's social row. The directory README carries the four-part launch swap, and is the only place that does, because
the file becomes wrong the day the password comes off and nothing anywhere will say so.

The Instagram URL is hardcoded, and has to be: Shopify Email has no `settings` object, so
`settings.social_instagram_link` is unreachable from an email. That is a fourth copy of a social URL
in a repo whose `CLAUDE.md` already documents two of them drifting. It is recorded rather than solved;
there is no mechanism available that would solve it.

The copy originally promised no launch date, for the reason that a date cannot be corrected once the
send is out. That was later reversed on purpose; see the entry below.

**`welcome.liquid` deliberately carries no shipping figures.** Shipping rates, the free-shipping
threshold, and turnaround already have four sources of truth. A sent email would be a fifth, and the
only one that cannot be corrected after the fact, so the templates link to the policy and FAQ pages
instead of restating numbers.

**Branding is duplicated per file on purpose.** No partials and no build step (the repo has no
bundler, and Shopify Email accepts exactly one pasted document anyway), so header, footer, and
palette are copied into each template and a palette change has to be made in all of them. The README
says so, and records that the palette is lifted from two different colour schemes in
`config/settings_data.json`: navy and accent blue from `sss-dark-scheme`, the light-blue surround
from `scheme-4`.

**Shopify Email rejects Liquid comment tags, and that was only discoverable by pasting.** Both
templates originally opened with a Liquid comment block carrying the campaign metadata. The editor
refuses it: one comment tag anywhere makes the whole template invalid, with `Syntax not valid on
line N` and a blank preview. Verified in the live editor on 2026-08-19 by bisection: removing the
header block moved the error from line 1 to line 23, the inline preheader comment, and converting
every comment to HTML form cleared it and rendered the email correctly. Neither form of whitespace
control makes a difference, and the variable names were ruled out as the cause along the way.

The consequence is a rule rather than a one-time fix: HTML comments are the only kind available, so
**every comment ships in the sent email's source**, where any recipient can read it. The first answer
to that was discipline (delete each TODO as it is satisfied, keep discount codes out of comments),
which is a rule that has to hold on every future edit to stay true. The rule the templates settled on
instead is structural: **they carry no comments at all.** Campaign metadata, launch checklists,
rationale, and TODO markers live in `marketing/emails/README.md`, which nobody receives. The shell
marks its fill-in spots with ALL-CAPS visible text (`HEADLINE GOES HERE`, `BUTTON LABEL`), so a
forgotten one is glaring in the editor preview and in the test send rather than invisible in a
comment. The only comments left in either file are the Outlook conditionals around the button, which
are functional markup.

**The welcome email now names the launch date, reversing this entry's own earlier rule.** The first
version promised no date, on the reasoning that a sent email cannot be corrected and a date that
slips reads worse than no date at all. That reasoning assumed the date was the email's to withhold,
and it is not: `blocks/launch-countdown.liquid` commits publicly to 2026-09-03 09:00 ET, the
password page ticks down to it, and the Instagram bio repeats it. A subscriber reads the welcome
minutes after watching that countdown, so "the shop is not open yet" followed by "we would rather
open a little late" read as evasion rather than caution, and the hedge is gone. The residual risk is
unchanged and unmitigable: this is an **automation**, so every message already sent carries whatever
the template said when it sent, and editing the template only fixes future sends. If the date slips,
the correction is a follow-up campaign to the list, not an edit to this file. The date is rendered as
two static tiles echoing the password page's countdown tiles, because an email cannot tick.

**`{{ shop.email }}` came out of both footers.** It is not on Shopify's documented object list for
custom Liquid emails, so it may render empty, and an empty contact line fails silently: the footer
looks intact and simply offers the reader no address. It was also the wrong mailbox even when it
worked, since the store's account address is not the customer-facing one. Both footers now hardcode
`contact@sapphireshadowstudio.com`, a brand address already published on the storefront.
`shop.address` is documented and available, and is deliberately unused: no postal address appears in
these templates.

**The social icons are rasterised PNGs hosted on Shopify Files, and the path data is duplicated on
purpose.** Email clients do not render SVG, so the theme's own `inline_asset_content` route was
unavailable, and `snippets/icon.liquid`'s `currentColor` fills have no cascade to inherit from in an
inbox. `scripts/email-icons/render-email-icons.mjs` wraps three path strings copied out of that
snippet (its `instagram`, `facebook` and `tiktok` branches) in a standalone SVG with the fill baked
to the footer's body colour, and rasterises them with the `sharp` devDependency the size-chart
renderer already uses; no new dependency. The alternative, parsing the Liquid `{% case %}` at build
time to extract the paths, is worse than the duplication: it makes tooling depend on the shape of a
template that has no contract. The copy is guarded by a test that fails when either side drifts, and
a second test fails when the committed PNGs stop matching what the renderer produces.
`upload-email-icons.mjs` puts those PNGs into Shopify Files behind a per-file `--upload` flag and
skips any name already present, because `fileCreate` has no content dedup and a duplicate would
silently orphan the URL the templates point at.

**A bare icon row is an images-off trap, and `alt` does not save it.** A client that blocks images
sizes the blocked image to its `width`/`height` attributes and clips the alt text to that box, so a
28 px icon shows about four characters: "Insta", "Face", "TikT". That was verified in a browser
against the real markup, which is why the row pairs each icon with a visible text label inside the
same anchor and marks the icon `alt=""`, the visible label carrying the meaning. With images blocked
the footer reads "Instagram Facebook TikTok" in its own body colour. The header logo has the same
exposure and no room for a label, so its cell sets an explicit light `color` and its alt text lands
white on navy rather than near-black on navy.

**The email's Facebook URL is a fourth spelling of a link this repo already stores twice.**
`config/settings_data.json` and `sections/footer-group.json` both hold the numeric
`facebook.com/profile.php?id=...` form; Shopify's Brand settings holds the vanity
`facebook.com/sapphireshadowstudio`, which resolves. The email uses the vanity form, because that is
what a reader should see. Reconciling the theme's two copies is a separate change and is not tracked
anywhere: `settings_data.json` is an Admin-sync surface, so whoever picks it up has to decide first
whether the edit goes through the sync theme or the repo.

**The footer body colour was `#c9d8e6`, one digit off from the brand token.**
`scripts/size-chart/lib/svg-shared.mjs` says `#c9d8ea`. That was a transcription slip rather than a
choice, and both templates now match that token set, which this change adopts as the emails'
reference palette: navy `BG`, tile-face `PANEL`, eyebrow `ACCENT_LT`, body `BODY`. It is the same
answer the size-chart renderer reached, for the same reason: a renderer outside Liquid cannot read a
colour scheme. Two colours stay outside the set on purpose. The button keeps `#0071C2` because that
is `sss-dark-scheme`'s `primary_button_background`, the storefront's real CTA colour, so the button
a subscriber clicks matches the button they land on; and the page surround keeps `scheme-4`'s
`#e1edf5`, which has no size-chart equivalent because a PNG has no surround.

Two things this also settled, both of which the docs left ambiguous. `{{ unsubscribe_url }}` works,
resolving to a real `/account/unsubscribe/...` URL, even though the editor's placeholder text names
`{{ unsubscribe_link }}`; and `{{ open_tracking }}` is accepted, even though the placeholder names
`{{ open_tracking_block }}`. Do not "fix" either one to the other spelling.

Worth recording for the next time: `theme check` and an HTML structural parse both passed this file
while it was unpastable. Pasting into the editor is the only check that catches this class of defect,
it is free, and it is safe, because a template is not a campaign and cannot send.

Two platform details worth keeping: `{{ unsubscribe_url }}` is required in every custom Liquid email
and `{{ open_tracking }}` is required whenever open tracking is on, both conventionally in the
footer, and both fail **silently** until a test send. Shopify's own example spells the second one
`open_tracking_block` in one place, so that is the first thing to try if a send records no opens.
The cap is 500 KB per custom-coded email (50 KB for a custom Liquid section inside a drag-and-drop
email). Validation is the operator's test send; nothing automated proves an email renders in an inbox.

## Dynamic collections dropdown on the main menu (unreleased)

The Shop link's dropdown is not authored in Admin. **A top-level menu link that has no children of
its own, points at the catalog or the collection list (`catalog_link` / `collections_link`, which is
what "All products" and "All collections" become in the menu editor), and sits on a store with at
least one published collection gets a submenu built from Liquid's global `collections` drop.** Add a
collection in Admin and it appears in the nav on the next page render; no menu edit, no repo script,
no sync run. This is the whole reason the feature exists: a static Shopify menu cannot track the
catalog, and the alternative was a scheduled job reconciling menu items against collections.

**The trigger is the thing to know before editing the menu.** It is implicit, so a future editor
adding a second "All products" link somewhere in the main menu will silently get a second dynamic
dropdown, and giving the Shop link a single hand-authored child in Admin silently turns the dynamic
list off (an authored submenu always wins). Neither is checked anywhere: nothing in CI parses the
menu, and the menu lives outside the repo entirely. The `collections.size > 0` half of the trigger
is not defensive noise; without it a store with no published collections renders a link that
advertises a dropdown (`aria-haspopup`, `aria-expanded`) over an empty panel.

**Three surfaces, one convention.** `blocks/_header-menu.liquid` computes the trigger and passes
`dynamic_collections` into `snippets/mega-menu-list.liquid` (desktop, including the "More" overflow
popover, which reuses the same markup); `snippets/header-drawer.liquid` recomputes it for the mobile
drawer. The drawer's accordion and flat branches both handle it, because `drawer_accordion` is
currently `false` and the flat branch is the live path; implementing only the accordion branch, as
originally planned, would have shipped nothing on mobile. The drawer's 3-level branch deliberately
does not support it: the menu is two levels, and the feature would disappear if a third level were
ever added there.

**The dynamic list is always plain text, even when the block's media type is `collection_images`.**
That mode reads images off static child links, and a dynamic parent has none, so both files downgrade
to text for this branch. The featured-content column is unaffected: it keys off the parent link's own
type, and a catalog parent still resolves `collections.all`, which is why the desktop dropdown keeps
its product cards alongside the generated list.

**Hovering or focusing a collection previews its products, from pre-rendered panels.** The
featured-products column used to be a fixed set (the first three of `collections.all`), which read as
decoration rather than a preview of whatever the cursor was on. Each collection now has its own panel
in the same column and `assets/mega-menu-preview.js` toggles which one is shown. Pre-rendering beats
fetching here only because the catalog is six products: a Section Rendering API call would add a
loading state, an abort path, and a visible delay on the first hover of every item, in exchange for
markup that is currently cheap. That trade flips as the catalog grows, and the panels are the first
thing to reconsider when it does.

**Four accessibility properties hold this feature up, and three of them are invisible until broken.**
Focus previews exactly as hover does, so the feature is not pointer-only. Inactive panels are
`hidden`, not merely transparent, because a transparent panel keeps its product links in the tab
order and a keyboard user would tab into cards nobody can see. Each panel carries its own accessible
name, so the swap is identifiable rather than an unannounced content change. The fade is dropped
under `prefers-reduced-motion`. None of these are covered by CI.

**The pointer bindings sit on the exact elements entered and left, and that is not a style choice.**
`assets/component.js` resolves `pointerenter` and `pointerleave` against the event target only, with
no ancestor walk (`focus` and `blur` are the ones allowed to bubble). Moving `on:pointerleave` up to a
wrapper for tidiness would silently stop the reset from ever firing.

**Order is the `collections` drop's order, and it is not operator-controllable.** No `sort` filter is applied, so the dropdown lists collections the way Liquid hands them over. There is no way to pin one first short of renaming it or giving the link an authored submenu again, which turns the whole feature off. That is also what the 50-item cap means in practice: at 51 collections it is the tail of that order that silently stops appearing.

**The list is capped at 50, which is Liquid's own per-loop ceiling, not a design choice.** The cap is
written out explicitly (`limit: 50`, and the desktop column math takes `collections.size | at_most:
50`) so the column count cannot describe more items than the loop emits. The span is clamped to 4 for
the same reason: `mega-menu__column--span-N` is only defined up to 4, and 41 collections were enough
to compute 5, at which point the column would fall back to a single grid cell while its inner
`column-count` kept laying out five. At three collections none of this is visible; at 51 the nav
would silently stop listing everything, which is the point at which a generated dropdown stops being
the right shape for the menu.

## Fits Chest column on the women's microfleece vest size chart (unreleased)

The vest was the one blank whose chart offered no way in for a shopper without a reference garment:
bust laid flat and body length only, no derived circumference and no fit range. It now carries a
`body_chest_range` column, "Fits Chest", in both outputs. No engine change was needed; the `range`
kind, the role's sane-range and monotonicity validation, and the accordion paragraph all already
existed and had no user.

**Where the numbers come from, since they are otherwise unexplainable later.** Bust laid flat
doubles to garment circumference (34.5 / 36.5 / 38.5 / 41.5 / 44.5 / 47.5 in). Each size's range is
that circumference minus layering ease, which is what a vest worn over a base layer needs: the low
end of every range sits a constant 4.5 inches under the circumference, and the high end sits 2.5
inches under at XS and S, 1.5 inches at M and up, which is what tiling the ranges contiguously
(30-32, 32-34, 34-37, 37-40, 40-43, 43-46) costs once the blank's own size steps stop being even.
Contiguity is the property worth preserving: no chest measurement can fall between two sizes. The
constant low-end ease is the fit promise; the high-end figure is a consequence of it. The operator
confirmed the table before
it was written; a fit range is a merchandising claim, not a transcription of a manufacturer spec, so
it does not get regenerated from the blank's numbers on a whim. Widening the ease shifts every row.

**Two conventions this column follows on purpose.** It carries no `badge` and no `how`: those bind a
column to an anchor point on the garment diagram, and this is a body measurement, so a badge would
also fail validation. Its body-measurement instruction (soft tape, fullest part of the chest,
parallel to the floor) lives in the column's own `explain`, per the rule in `copy.md` that shared
copy never tells a shopper to measure themselves; the other two blanks have no such column and must
not inherit the instruction. The vest profile's `how_to.note` gained an exception clause for the
same reason, while the shared accordion intro's laid-flat framing was left alone.

`test/table-block.test.mjs` pins the vest's paragraph-label list, so the assertion that the vest
grows no sleeve or circumference prose keeps its teeth; the added label is the only edit it needed.
The refreshed PNG is an operator upload in Admin, not a repo artifact.

## Collection-list cleanup: all-products deleted, bare collections imaged (2026-08-16, Admin-only)

Two pre-launch-review findings closed with no theme change; recorded here because both were
resolved by a judgment call worth not re-litigating.

**The `all-products` smart collection was deleted rather than repaired.** Its rules were
`VARIANT_PRICE > -1` OR `VARIANT_INVENTORY < 0` on match-any: the first condition matched every
product and the second matched nothing, so it worked by accident, and flipping the match toggle to
"all" in Admin would have silently emptied it. Deletion won over an honest rule because nothing
referenced it: every "shop all" surface in the theme (footer, hero buttons, 404, button defaults)
points at Shopify's built-in `/collections/all`, and `snippets/breadcrumbs.liquid` deliberately
excluded the handle from breadcrumb parents (the exclusion entry is a harmless string and stays).
One reference was missed: `scripts/a11y/paths.json` still audited `/collections/all-products` as
the collection template, so from the deletion until 2026-09-01 the pa11y "collection" row was
auditing the 404 page. The first `site-check` probe run caught it (`render-status` on that path);
the audit path is now `/collections/all`.
If catalog-page control (image, description, SEO fields, sort, exclusions) is ever wanted, the
move is a new collection with the handle `all`, which overrides the built-in at the same URL; do
not recreate `all-products`.

**The collection-list finding was resolved with collection images, not a menu repoint.** Featured
and Healthcare got images in Admin (logo-tag closeup and Huddle nurse closeup; Vitals already had
`blue-zip-3.jpg`), so `/collections` now renders three imaged cards. The Catalog menu entry still
points at `/collections`, which is deliberate. Residual known issue: Featured and Healthcare hold
the same five products, so the list page still shows overlapping slices; that is the
`docs/collection-differentiation-runbook.md` problem, not this one.

## Variant SKUs adopted, with the tooling that maintains them (unreleased)

All 431 variants had a null SKU. The identifier was deferred on 2026-07-29 pending three questions,
and this change answers them and adopts one: `<PRODUCT>-<DESIGN>-<COLOR>-<SIZE>`, derived from each
variant's own public option values through committed code tables. The scheme, the code inventory and
the runbook for adding a code live in `docs/sku-scheme.md`; the tool is `scripts/sku/`; the operator
gates are the `sku` skill. No SKU has been written yet: this change ships the tooling, and the
backfill is an operator-gated run after merge.

### The decision, on operational merits rather than SEO ones

The original SEO framing was overstated and is recorded here so it is not re-litigated. Google
Merchant Center's required per-variant identifier is `id`, which Shopify fills from the variant id;
SKU maps only to the optional `mpn`, and made-to-order goods with no GTIN set
`identifier_exists: false` either way. What SKUs actually buy is operational: readable packing
slips, exports that sort into the order a batch is worked in, a value frozen onto the order line at
purchase, and a join key for later barcode tooling. There is no `SSS-` brand prefix; on a
single-brand store it carries no information and costs four characters of a 16-character budget.

The real cost was never new products, it was new option values. One new colour on a Lead II product
creates 48 variants. That is why the tables are data (`scripts/sku/tables.json`) rather than logic:
adding a colour is one row and the tool then fills all 48, and `audit` names the exact live option
string to use as the key.

### Cross-layer contracts worth knowing before touching this

- **The tables are the source of truth and are append-only.** A retired code is never reused,
  because every historical order line, export and packing slip already carries it. The git history
  of `tables.json`, not the current file, is the authority on what has been used.
- **A tables edit voids every approved plan.** Each plan artifact embeds the tables hash and `apply`
  refuses on a mismatch. Without that, an edit between approval and apply would produce a different
  but perfectly plausible set of writes under the same approval, because a SKU is a pure function of
  the tables.
- **The leading-zero rule is about the assembled SKU, not the segments.** A SKU must never start
  with `0` (spreadsheets and some barcode tooling strip it), but gift denominations are deliberately
  zero-padded (`GIFT-050`). Do not "fix" the padding.
- **A half-populated SKU field is worse than an empty one**, because a SKU filter then silently
  returns an incomplete set. That is why the planner refuses the whole plan on any unmapped value,
  duplicate expected SKU, or collision with a live SKU, rather than writing the rows it can.
- **A SKU is not `custom.inventory_blank_sku`.** One identifies the finished piece as sold and is
  public; the other identifies the shared blank garment and embeds supplier data that must never
  reach this public repo. `docs/sku-scheme.md` has the comparison table.
- **Applique patterns stay out of the SKU.** They are a line-item property backed by
  `scripts/applique-grid/patterns.json`, on a different change clock from the variants.

### Two things settled against the live API rather than from memory

**`ProductVariantsBulkInput` has no top-level `sku` field.** The SKU lives on the variant's inventory
item, so the input is `inventoryItem: { sku }`; a top-level `sku` is rejected by the schema outright.
Verified with `validate_graphql_codeblocks` against the pinned API version. The response selects
`productVariants { id sku }` and deliberately not `inventoryItem { sku }`, because reading the nested
inventory item adds a `read_inventory` scope requirement to a tool that otherwise needs only
`write_products`. `assertScopes` in `scripts/blank-inventory/lib/admin.mjs` grew an optional
`required` parameter for that reason: demanding `write_inventory` of a tool that never touches
inventory would train the operator to widen the app's grants for no reason.

**Gift cards go through the same write path.** Shopify's dedicated `giftCardProductSet` is
deliberately not used: it performs a full replacement of the variant list, a catastrophic blast
radius for setting one field. If the API turns out to refuse SKU writes on gift-card variants, the
answer is the `skuWritable: false` flag on that product entry, which moves its nulls into an
**exempt** class so the steady state stays "0 actionable nulls and exit 0" instead of permanent
failure.

### A defect the dry run caught before any write existed

The first end-to-end rehearsal failed all 431 rows with "missing field(s): product". `apply`'s
baseline guard re-reads each product's variants **nested under the product**, so those nodes carry no
`product` field and no options, but the read was asserting the full catalogue-wide variant shape.
The fix splits the assertion: `assertVariantShape` for the catalogue read, `assertSkuShape` (an id
and a selected `sku`) for the baseline re-read. Each read is now strict about what it consumes rather
than about what some other read consumes. The regression is covered in
`scripts/sku/test/catalogue.test.mjs`.

The narrower assertion still refuses a node with no `sku` **key**, which is not pedantry: an
unselected field and a null value are indistinguishable downstream, so a query that stopped selecting
`sku` would read as "no SKU everywhere" and plan a write over every real one.

### Recovery is manual from the receipt, by design

There is no `revert` command. Every receipt row records the prior SKU (the baseline is read anyway,
to guard against a row that moved between plan and apply), so recovery is applying those baselines
back through the same gated flow. An automatic rollback would be a second write path with a fraction
of the review, which is the wrong shape for the one field whose corruption is hardest to notice. A
plan artifact is also single-use: the receipt file's existence is the spend record, because
re-running a partially applied plan would skip the rows that landed while retrying the rest against a
store that has since moved.

### CI

`npm run sku:test` and `npm run sku:tables` are two separate `validate` steps so a failure attributes
cleanly: a broken table is an operator edit, a broken test is a code change. Both are offline. The
test step's zero-tests guard is anchored to the reporter's own summary line by field position rather
than a loose `grep` for "tests N", which a test *name* can match; the lint step fails when it reports
zero codes checked, so an emptied `tables.json` cannot pass vacuously. Nothing live runs in CI, and
the enforcement behind that is the credential boundary: the validate job holds no Shopify token.

## The last two deferred review findings closed without code (unreleased)

[SA-9] and [AR-Gap-1] were the final entries in `TODO.md`'s "Deferred review findings" section;
both are now closed as decisions rather than implementations, and the section is gone.

**[SA-9] closed: keep the single `validate` required context.** The item's original complaint
(four separate required contexts on `main`) was already solved by the single-`validate`-job
consolidation; what remained was only whether to keep that arrangement or split it back out. The
answer is keep it. Splitting into per-check jobs would buy parallel wall-clock time and per-check
status badges, at the cost of more `ci_check_contexts` entries to keep in sync in the private
infrastructure repo, the loss of the one consolidated CI report comment, and more surface for the
failure mode [DS-10] documented: rename a job here and `main` requires a context that no longer
reports. For a solo-dev repo with a fast validate job, one rolled-up context is the right shape.
The infrastructure repo's `github.tf` already carries an in-file comment explaining why
`["validate"]` is sufficient, so nothing changes there either.

**[AR-Gap-1] closed as won't-do: no issue-based deploy audit ledger.** The gap (workflow logs
expire after 90 days, so no durable auto-deploy history) is real but already half-covered:
`deploy.yml`'s "Record live-deploy marker" step keeps `refs/deploy-markers/live` on the last
actually-deployed commit, and `main`'s squash-merge history is itself a permanent, ordered record
of every deploy, since a deploy and a squash-merge are the same event in this pipeline. The
proposed extra step (append a structured one-line comment per deploy to a pinned
`auto-deploy-audit` issue) would add a second bookkeeping surface, a hardcoded issue number, and a
public-repo issue to keep locked, to answer questions the merge history already answers. If a
parseable ledger is ever actually needed, the design is on record: a `continue-on-error`
github-script step after the marker step, `issues: write` is already granted, fields from
`needs.gate.outputs`, fixed-separator line format.

## Admin backlog batch, and a silent truncation in the media uploader (unreleased)

Five Admin-side backlog items were cleared against the live store: the gift card's empty
`descriptionHtml`, null SEO titles on all four collections and all five pages, per-colour hero
attachment across all 426 colour-bearing variants, the Shift Fuel Grey Heather stealth-colourway
copy, and the hero video's alt text. The repo side of that is `TODO.md` plus two doc notes. Two
findings from the pass are worth more than the items themselves.

### `variants(first: 100)` was silently dropping 88 variants

`scripts/upload-product-media.mjs` read a product's variants with a hardcoded `first: 100` and no
`pageInfo { hasNextPage }` check. The two 8-design products carry 144 variants each (8 designs x 3
colours x 6 sizes), so `variantsByColor` was built from the first 100 and the remaining 44 on each
were dropped. Those variants then fell through `if (!hero.mediaId || !variantIds.length) continue;`
with no error and no warning, and the run printed success.

Had it run unfixed, 88 variants across two products would have kept showing the product-level
featured image, which is a **Black** garment on every one of these products, so a customer buying
Grey Heather or Classic Navy would have seen a black sweatshirt in their cart, and nothing in the
output would have said so. A truncated read that reports success is the fail-open shape
`scripts/seo-review/admin.mjs` refuses by design with its `admin-read-truncated` ERROR; this script
had simply never been given the same treatment.

The fix is `fetchAllConnection`, which follows the connection's pages and throws rather than
returning a partial read. It delegates the walk to `paginate()` from
`scripts/blank-inventory/lib/catalogue.mjs` rather than reimplementing it: that helper already
carries the malformed-page guard and the runaway-page backstop, and reusing it means one tested
pagination path instead of two. The first page comes from the caller, since `Q_PRODUCT` has already
fetched it, so the single-page case still costs zero extra round trips. It takes an injected `gqlFn`
so the pagination is unit-testable without a network, and `scripts/upload-product-media.test.mjs`
covers the exact regressing shape: a 144-variant product with a 100-wide first page.

`media` had the identical unguarded read at two call sites and now goes through the same helper. Its
consequence was worse than a miscount: `pollMediaReady` looks the newly-created media up by id in
the returned page, so a truncated read would leave that lookup undefined, and the poll would run to
its two-minute deadline and report a **processing timeout for media that had uploaded fine**. That
one is not reachable at the current catalogue size (the largest product carries 15 media against a
250 cap), but it is the same fail-open shape, and leaving it while fixing its twin would have made
this note untrue of the file it describes.

`resolveProduct` now also overwrites both first-page connections on the object it returns with the
complete node sets. Callers read `product.media.nodes` directly, and a partial first page left
reachable there reads as the whole set and silently is not.

What caught it is worth recording, because the obvious check would not have. The hero *lines* in the
dry-run output were all 13 present and correct; only reconciling their variant counts against a
live-derived colour matrix exposed the gap, and 36 + 30 + 34 = 100 is the signature. A verification
that counts one attachment per colour, or that compares only the variants which did get attached,
passes cleanly while 88 variants sit unattached. Derive the expected matrix from a live read, and
compare totals, not just presence.

### The variant hero outranks Admin media order

`snippets/product-media-gallery-content.liquid` pins the selected variant's attached media to gallery
position 1. So the hero is not only the cart line-item thumbnail and collection card: it also decides
which photo the product page opens on for that colour, and **no Admin media reorder can override it**.

This retires a standing assumption that a colour's gallery lead is fixed by reordering media in
Admin. It is not, once a hero is attached. Combined with Shopify's one-media-per-variant cap, that
means changing which photo leads a colour requires detaching the hero first, not reordering anything.
A planned one-off reorder script for Shift Fuel's Grey Heather was dropped on this basis: it would
have been a live write with no visible effect.

### Two halves deliberately did not land, and are not in `TODO.md`

The backlog is kept to open actions, and the operator's call on this pass was to close both parent
items out rather than carry a remainder. Recorded here instead so the decisions are not lost:

**Shift Fuel's Grey Heather is still a blank-looking garment**, and a media reorder will not fix it.
White thread on light heather shows no design at the 96px a cart thumbnail renders, on the flat and
angled shots alike; only the close-up reveals it. The hero decision was flat-everywhere with no
per-product exception, so that colour's cart thumbnail and gallery lead are both the blank flat.
Anyone revisiting this should reach for the camera, not the media order: the position-1 pin above
means the hero has to be detached and re-pointed, and the durable fix is a full-garment shot that
survives downscaling (raking light, or a tighter crop that keeps the lettering large). The other
three Grey Heather products are unaffected, so this is one photograph on one product.

**The gift card still has no photograph.** The description shipped and the page is no longer blank,
but its only media remains the 500x500 logo SVG, making it the one product page with no photograph.
The photograph was out of scope for this pass by design; the description was the whole of it.

## Accessibility baseline burn-down (unreleased)

PR #104 shipped the two accessibility gates with their pre-existing failures
recorded rather than fixed, so the gates could be introduced without restyling a
live storefront: twelve axe rules silenced audit-wide in
`scripts/a11y/baseline.json` (hiding 357 findings on PR #105's first full run)
and 44 measured colour pairs waived in `scripts/contrast/accepted-risks.json`.
This change takes the pa11y baseline to empty and the contrast waivers to 32.

### The last rule out was hiding almost nothing measurable

`color-contrast` was the entry expected to stay, on the theory that what sat
behind it was `scheme-6`, the transparent hero overlay, whose text is composited
over whatever photograph the section shows. Recovering the hidden findings from
a local run against the preview theme showed the real composition: nearly every
one was an axe INCOMPLETE result, not a measured failure. axe returns two sets,
`violations` (a measured ratio below the bar) and `incomplete` (it could not
resolve the background: an image, a gradient, an overlapping element, Shopify's
chat widget), and pa11y's axe runner promotes incomplete to a gating error by
impact unless capped. The unmeasurable set was drowning the gate, and the only
measured violation on any audited page was inside Judge.me's widget, which
`paths.json` already hides.

So `build-pa11yci.mjs` now sets `levelCapWhenNeedsReview: 'warning'` (committed
side, so a `paths.json` edit cannot raise it back) with `includeWarnings: true`,
and the baseline is empty. Measured colour-contrast violations gate again for
the first time since the audit landed; the can't-measure set flows through as
warnings, which the summariser counts per rule and per page in the CI Report
comment ("Needs review") so the trend is trackable run over run without failing
anything. A verification run over all 19 paths with this config reported 0
errors.

What the overlay text sits on is still a design property of the hero imagery:
no audit setting can measure text composited over a photograph, capped or not.
The needs-review counts in each run's report are where that surface stays
visible; if a scrim, gradient, or image-selection rule ever lands, those counts
are the before/after instrument.

Three of the other eleven were never theme debt. `frame-title` and
`frame-tested` (38 findings) are Shopify's `#PBarNextFrame` preview-bar iframe,
injected by the platform into every preview-theme page and absent from the live
storefront. `video-caption` is the homepage hero montage: autoplay, loop, muted,
no controls, no speech, nothing to caption. Both are handled where the audit
config can see them rather than by silencing a rule store-wide, which is the
point of the mechanisms below.

The remaining eight were each ONE defect, multiplied by a snippet the header or
the product grid renders many times per page. That is why the counts looked
large: 47 `duplicate-id-aria` findings were three ids, 19 `aria-required-parent`
findings were a single `role="menuitem"` (one per page, nineteen pages).

### paths.json grows a top-level `defaults`

`build-pa11yci.mjs` spreads it UNDER the committed pa11y defaults, so a future
edit there can add an option but cannot downgrade the standard, drop the axe
runner, or unpin Chrome's sandbox flags. An audit-wide `ignore` is rejected
outright rather than merged: that is the one option that would re-hide findings
from the summariser, which is precisely why the baseline was moved out of this
file in the first place. A per-entry `hideElements` now CONCATENATES with the
audit-wide one, because pa11y overrides rather than merges and a page-scoped hide
would otherwise silently un-hide the preview bar on the one page that needed an
extra selector.

Three escape hatches now exist and they are ordered by blast radius: per-path
`ignore` (one page, one rule) < top-level `defaults` (every page, no rule
suppressed) < `baseline.json` (every page, whole rule). Reach left first.

### The localization form was a combobox with no listbox

The country rows are `role="option"` and the search input is a `role="combobox"`
that points `aria-activedescendant` at one of them by id. The element holding
those options was `role="list"`, which is not a valid parent for an option, so
every row was an orphan; the no-results message was a bare `<span>` sitting
directly inside that list, which is what the `list` rule was reporting. The lists
are listboxes now and the message is their sibling.

Two things there are easy to reintroduce. `aria-owns`/`aria-controls` named
`country-results`, an id no element on the page has ever had (the real one is
prefixed), and the row ids were the country NAME: spaces in an id, and the same
id in both the popular and the full list, for an attribute whose entire job is to
name exactly one row. Every id in the snippet is namespaced by
`localization_style` now, defaulted rather than required, because a call site
that omitted it was minting ids like `-CountryLabel`.

### role="menuitem" outside a menu

The theme's only `role="menuitem"` had no `menu` or `menubar` anywhere above it.
`menuitem` also means an application-style menu, which the header nav is not, so
the role was removed rather than a `menubar` invented to satisfy it. A nav
disclosure should be announced as the button it is.

### The product card's link wrapped its own arrows

`card-gallery` wrapped the whole slideshow in the product anchor, arrow buttons
included: a control inside a control. The arrows could not move out instead,
because `on:click="/previous"` binds to the closest component ancestor and they
have to stay inside `<slideshow-component>`. The anchor moved in to wrap the
SLIDES, which is the same clickable area minus the arrows.

The consequence to remember: that anchor is `display: contents`, so it adds no
box to layout, but it is still a DOM node, and `base.css` had a deliberately
structural selector (`slideshow-slides > slideshow-slide`) carrying a Safari
repaint fix. That selector grew a matching branch. A `display: contents` wrapper
is invisible to layout and to the reader, and fully visible to the child
combinator.

### Carousels are keyboard-reachable

`slideshow-slides` went from `tabindex="-1"` to `tabindex="0"`, but only when
there is more than one slide: a one-slide gallery is not scrollable, so a tab
stop there would do nothing. The browser provides arrow-key scrolling for a
focused scroll container on its own, so no JS was involved, and the existing
`focusin` handler already suspends autoplay, so arriving by keyboard does not
fight the rotation. This is a deliberate keyboard-UX change: one tab stop per
carousel, approved as the cost of the slides being reachable at all.

### Contrast: what moved and what deliberately did not

One change is visible by design: `scheme-2`'s `primary_hover` was `#ffffff` on a
`#f5f5f5` page, so links vanished on hover. It follows schemes 1 and 3 to
`#000000`. Everything else is imperceptible: an input text colour a hair darker,
the dark scheme's white hairlines from 19-31% alpha to 37%, `scheme-4`'s border
from 50% to 60%, four hardcoded CSS opacities replaced by the
`--opacity-subdued-text` token the theme already had.

Each new value clears its threshold with margin rather than landing on it. A
value that rounds to exactly 3.00 would be a ratchet set at the bar, and the next
rounding change to the lint would fail it.

The 32 survivors are two deliberate decisions, and their notes now say so instead
of pointing at a TODO entry:

- The light schemes' hairline borders ARE the light theme's look. Raising them to
  3:1 would darken a line the storefront uses as a whisper, on every card, input
  and swatch. The dark scheme and `scheme-4` were raised in the same pass because
  there the same change cannot be seen.
- A "border" that holds the same colour as its own fill is a borderless control,
  not a failing border. What tells it apart from the page is the fill, which is
  what the lint actually scores (it takes the better of the two edges). Fixing it
  would mean painting a border the design does not have.

## Orphaned colour schemes deleted (unreleased)

The three unreferenced colour schemes (`scheme-58084d4c-...` transparent dark-text,
`scheme-ec7ae723-...` deep blue, `scheme-8089d18b-...` light blue) were removed from
`config/settings_data.json` (`current`, plus the one preset copy). No template,
section, block, schema default, or settings key referenced them; they only added
inline CSS to every page and broken-contrast choices to the editor's scheme
pickers. The contrast triage decision for the two blue ones (TODO item, resolved
2026-08-16) was delete-not-recolour: nothing rendered them, so their 12
`accepted-risks.json` waivers were deleted in the same change (a waiver matching
no existing scheme hard-fails the contrast gate). The remaining schemes are all
load-bearing; the storefront is not dark-only (product, collection, cart, and
search bodies sit on `scheme-1`/`scheme-3`), so no further scheme deletion is
safe without a repoint-everything pass.

## Accessibility checks in CI, in two layers (unreleased)

### What changed

`validate.yml` gains a `Contrast + a11y tests` step plus a dynamic pa11y-ci audit
of the PR's preview theme. To make the audit possible inside the required check,
the preview-theme push moved from `preview.yml` into `validate.yml` as a
`deploy-preview` job that the `validate` job `needs`, so the theme the audit
reads is known to exist and to match the head SHA; `preview.yml` retains only the
PR-close cleanup. Everything reports into the one sticky CI Report comment.
Before this, the twelve validate steps contained no
accessibility check of any kind, so a failing colour scheme shipped silently: the
`sss-dark-scheme` accent sat at 3.86:1 until a hand-run Lighthouse audit caught it
on 2026-08-15. A hand-run audit is not a gate.

New: `scripts/contrast/` (static colour-scheme lint, plus `accepted-risks.json`),
`scripts/a11y/` (preview-theme auth, pa11y config builder, result summariser), and
a `pa11y-ci` devDependency. `TODO.md`'s "Add an accessibility check to CI" row is
replaced by a triage row for the debt the lint surfaced.

### Why two layers rather than one

They fail in different directions and neither subsumes the other.

**The static lint** reads `config/settings_data.json` directly. No network, no
browser, no storefront password, so it can sit inside the required
`validate / validate` context and block a merge. What it cannot see is a rendered
page: font sizes, focus order, what actually composites over a hero image.

**pa11y-ci** sees exactly that, but only against a deployed `pr-N-preview` theme,
which means an authenticated remote request and a secret. It started life as an
advisory job in `preview.yml`; the operator then chose to make it gate merges,
accepting the trade that every validate run now waits on a preview deploy and
depends on a live storefront round trip. Draft and Dependabot PRs get no preview
by design, so for them the audit records a benign skip rather than a failure,
while a FAILED preview deploy is a red check: "could not audit" must never read
as "no accessibility errors".

Like the contrast lint, the pa11y gate landed with its pre-existing debt
baselined rather than fixed: `scripts/a11y/baseline.json` silences the nine axe
rules the first full audit surfaced, audit-wide, so the gate catches regressions
from day one (TODO.md holds the triage row). Rule-level rather than per-finding
is deliberate: pa11y findings key on generated selectors that churn with section
ids, so a per-finding baseline would go stale on every editor edit. The trade,
recorded in the file's header, is that a new instance of a baselined rule stays
invisible until that rule is cleared.

The `perts-foundry-website` precedent supplied the pa11y defaults (`WCAG2AA`, axe
runner, `target-size`) and the reporting shape. Its plumbing did NOT port: that
repo Hugo-builds to `public/` and serves it on localhost, needing no secret and no
network. Liquid renders server-side, so this repo has no local build target.

### Design points that are load-bearing

**`STOREFRONT_PASSWORD` is scoped to one STEP, not to the `validate` job.** The
pa11y step launches `--no-sandbox` Chrome that executes third-party page
JavaScript (consent banner, chat widget, Shopify's own scripts). The storefront
password must not be in that process's environment. No Shopify token appears
anywhere in the `validate` job (the CLI theme token lives only in
`deploy-preview`), so the per-job secret isolation described in CLAUDE.md's
deploy-gate section survives. The password is the one secret the validate job now
holds at all, and it is read access to a password-gated storefront, not a write
capability.

**The preview-theme assertion is the point of `get-auth-cookie.mjs`.** Passing the
storefront password proves only that the storefront opened. It does not prove the
session is pinned to the PR's DRAFT theme. If `?preview_theme_id=` silently failed,
pa11y would audit the LIVE theme and report green on a PR that broke the page. So
the script fetches the preview URL and reads the theme id back out of the
`server-timing` header, asserting it matches the expected id specifically. The
same assertion catches a Cloudflare interstitial, which returns a page that is not
a rendered storefront at all.

**The preview-activation mechanism was verified against the live store before this
shipped (2026-08-16), read-only, using the existing unpublished sync theme.** A bare
`?preview_theme_id=` does activate an unpublished theme for an authenticated
session, so the share/`key=` URL fallback the plan held in reserve is not needed.
All 19 paths in `paths.json` returned their expected status and reported the
preview theme id rather than the live one.

**That verification caught a bug that would have failed the first CI run.** The
`*.myshopify.com` host 302s to the primary custom domain, and the original
off-host assertion rejected it, even though auth and theme activation had both
succeeded. `vars.SHOPIFY_FLAG_STORE` is the myshopify host, so the check failed
against the exact BASE_URL the workflow passes. The fix is not to loosen the
assertion but to move it: the THEME ID is the identity proof, and it is strictly
stronger than a host comparison, because `server-timing: theme;desc=<id>` naming
this store's specific unpublished theme is something only this store emits. The
resolved origin is now returned so pa11y requests the canonical host directly
instead of eating a redirect on all 19 URLs. It travels via a file rather than
`$GITHUB_OUTPUT`, because a step cannot read back its own outputs and the caller
needs it in the same step.

**curl cannot do any of this.** Cloudflare bot management blocklists its TLS
fingerprint on this store. Node's `fetch` (undici) gets through, which is why
`smoke.mjs` is built on it and why `get-auth-cookie.mjs` IMPORTS `BROWSER_HEADERS`,
`updateJar`, `cookieHeader` and `authenticateStorefront` from `smoke.mjs` rather
than copying them. The exact header set is what was found to work; two copies
would drift.

That claim was originally only half-true: the header and cookie helpers were
imported, but the password POST and its outcome classification had been
hand-rolled a second time in `get-auth-cookie.mjs`, which is exactly the drift
the exports exist to prevent. The loop now lives in `smoke.mjs` as the exported
`authenticateStorefront`, and both callers share it. The four outcome strings
(`success` / `rejected` / `throttled` / `error`) are load-bearing on the smoke
side, where `rejected` HARD-FAILs a deploy and everything else falls back to
reduced coverage, so the extraction preserves that classification exactly.
One visible consequence on the a11y side: a 5xx on the password POST now reports
`error` where the copy said `throttled`. Both fail there regardless, because an
unauthenticated pa11y run would audit the password page and green on it.

**`probe()` retries a throttle, for the same reason `smoke.mjs` does.** The store
sits behind bot management, so a 429 or a transient 5xx on either of the two
probes is a realistic way to lose an audit run to something it should have
survived. `probe()` now takes the same `backoff` / `sleepImpl` the password POST
already had. A connection failure is deliberately NOT retried: it fails closed,
matching `fetchObservation`. A 5xx that outlives the retries still reaches
`classifyPreview`, which reads it as a challenge.

**Every `node` call in the audit job has its exit status captured.** The job runs
`set +e` throughout, so each step decides its own verdict and writes one
`exit_code`; a status that is never read is a silent pass. Two were not read.
The URL count was interpolated straight from a command substitution, so a crash
in that `node -e` produced an empty count and still wrote `exit_code=0`; it now
fails closed on a non-zero status or a count that is not a positive integer,
which is also the earlier of the two zero-URL guards (`summarize-pa11y.mjs`
catches it downstream, but only after pa11y has run). The summary was parsed
twice, and the body parse fell back to an empty string independently of the exit
code, so a malformed summary could log a verdict while posting an empty comment
and still report success. It is parsed once now: the log line goes to stderr and
the body to stdout from the same parse, and a parse failure sets `exit_code=1`
and says so in the comment.

**Non-text contrast is checked against the PAGE, not against the control's own
fill.** The naive reading (border vs its own background) scores a solid black
button on white at 1:1 and fails it, which is nonsense, and would have demanded a
baseline entry for nearly every scheme. What SC 1.4.11 actually requires is that
the control be tellable apart from the page, so the check passes when EITHER the
border OR the component's fill reaches 3:1 against the scheme background. For the
page-level `border` role the component background IS the scheme background, so it
reduces to the plain border-vs-page check.

**`foreground_heading` is checked at 3:1, not 4.5:1, and this is a judgment call.**
The role is one colour shared by all six heading levels. h1-h3 are 32px and up,
clearing the large-text bar comfortably; h5 and h6 are 14px and 12px and do not, so
a strict reading would demand 4.5:1. It was left at 3:1 so the gate could land
without an immediate baseline. Tightening it is one line in `lib/pairs.mjs`.
Revisit if a small heading ever becomes the sole carrier of information.

**Overlay schemes are reported INDETERMINATE, not passed and not failed.** Two
schemes have `background: rgba(0,0,0,0)`: they paint nothing and composite over
whatever section media sits beneath. What a static reader would have to assume
about the surface underneath is invention, and reporting `#f2f2f2` text as "1:1
against white" would be a fabricated number that 44 fabricated baseline entries
then silenced. They are excluded from the tally, reported by name, and left to the
pa11y layer, which renders the real image behind the real text. This is the
clearest case for why one layer was not enough.

**The baseline ratchets and self-clears.** `accepted-risks.json` records the ratio
measured when each exception was accepted. Score below it later and the lint fails:
accepting "this border is at 2.1:1" must not also accept a later 1.2:1. Reach the
threshold and the entry is reported STALE so it gets deleted, because a file that
only grows eventually hides a regression behind an entry nobody remembers. A
malformed entry is a hard error, never a silent no-op, since a typo'd scheme name
would otherwise look like a granted exception while suppressing nothing.

**It landed with 56 recorded exceptions and zero colour changes.** That was a
deliberate instruction, not an oversight: the operator chose to ship the gate first
and triage the debt separately (`TODO.md`). The consequence worth knowing is that
the gate catches REGRESSIONS from day one but asserts nothing about the current
palette's absolute quality.

**The unblock path for a false positive is a baseline entry, never a threshold
change.** The lint sits inside the required check, so a false positive blocks every
merge. Widening a threshold in `lib/pairs.mjs` removes the check for every scheme
forever; an `accepted-risks.json` row is scoped, dated, noted and reversible.

**Every open `npm audit` high in the new dependency tree is unreachable.** All six
trace to `extract-zip` via `@puppeteer/browsers`, which lives in puppeteer's
browser-DOWNLOAD path. `npm ci --ignore-scripts` (setup-shopify-cli) blocks that
script, `PUPPETEER_SKIP_DOWNLOAD=1` reinforces it, and pa11y is pointed at the
runner's `/usr/bin/google-chrome`. The audit's suggested fix is a downgrade to
pa11y-ci 3.x, which is strictly worse. The `setup-shopify-cli` comment enumerating
`hasInstallScript` packages was updated, since puppeteer is now the second one.

**The audit and the preview push share one cancellation scope.** A new push must
cancel a running audit BEFORE redeploying the theme that audit is reading; letting
them race produces findings for a tree that no longer exists. With both inside
`validate.yml`, the workflow-level `validate-<pr>` concurrency group
(`cancel-in-progress: true`) provides this for free: a new push cancels the whole
prior run, preview push and audit alike, so the moved `deploy-preview` job carries
no job-level concurrency group of its own. The residual race (a redeploy landing
inside the cancellation window) is accepted and commented: the cost is a stale
report on a PR that is about to get a fresh run.

**Both new capture steps use a random `$GITHUB_OUTPUT` heredoc delimiter**, not the
fixed `GHEOF` the older steps use. Their captured text is PR-controlled (scheme
names, baseline notes, page-derived pa11y findings), so a fixed delimiter would let
a PR close the heredoc early and inject arbitrary step outputs.

### Follow-ups from the infra review of the two-job layout

**Auto-deploy gates on the `validate` JOB, not on the validate RUN.** Folding the
preview push into `validate.yml` gave the run two jobs with very different
meanings, and `deploy.yml`'s `workflow_run` arm was still reading
`workflow_run.conclusion`. Only `validate` is a verdict on the code;
`deploy-preview` talks to Shopify over the network and runs for shopify-sync
reconcile PRs as well. The gate now resolves the `validate` job via
`listJobsForWorkflowRun` (`filter: 'latest'`, so a superseded re-run attempt
cannot supply the verdict) and requires `completed/success` on it; the
workflow-level `if:` was widened to admit a `failure` run conclusion so the job
check can be reached at all.

**What this does not do, stated plainly.** It was filed as the fix for "a Shopify
hiccup in `deploy-preview` fails the run with every validation green and blocks
auto-deploy", and that premise is wrong on this branch: `validate.yml` turns any
non-success `deploy-preview` into a11y `exit_code=1`, which reds the `validate`
job as well. With two jobs in the run, "red run, green `validate` job" is
therefore unreachable, the `core.warning` branch is currently dead code, and a
preview flake still blocks auto-deploy. What landed is hardening: the gate now
trusts the same artifact branch protection trusts, and it stays correct if a third
job is added to `validate.yml` or the audit's coupling to `deploy-preview.result`
is relaxed. The actual flake fix is keying the audit off
`deploy-preview.outputs.theme_id` (written only after a successful push, so a
non-empty value means the theme is fully uploaded, while `result != 'success'` can
also mean the *comment* step failed afterwards). That is deliberately not shipped
here, because it changes what the required check asserts.

The rejected alternative was `continue-on-error: true` on `deploy-preview`. It is
a smaller diff, but it renders the job GREEN in the Actions tab when the theme
push actually failed, which is the same class of dishonest-green problem as the
three items below. A red job with a gate that knows which job matters is the
honest shape.

Properties kept deliberately: `cancelled` is still excluded at the workflow level,
because `validate.yml`'s `cancel-in-progress` group cancels the whole run on every
new push and those runs carry no verdict; a red `validate` job under a GREEN run
still `setFailed`s, because that combination should be impossible and must not
read as an ordinary red validate; and a MISSING `validate` job `setFailed`s only
under a green run, since a red run can legitimately have no jobs at all
(validate.yml failed to parse), and reddening `deploy` for that would put a red
run on a PR that was never a deploy candidate. None of the four documented deploy
gates were touched.

The comment path still requires the whole run green. That asymmetry is deliberate
and in the safe direction (stricter), and is now recorded in
`docs/deploy-gate-reference.md` rather than left to be rediscovered.

**The baseline moved out of pa11y and into the summariser, so the report can
disclose it.** `baseline.json` silences twelve axe rules audit-wide, but it was
handed to pa11y as `defaults.ignore`, which drops matching findings inside the
browser. The report therefore could not say what it had hidden, and the comment
claimed "N URL(s) audited against WCAG 2.1 AA (axe runner, plus `target-size`)"
while `target-size` itself was one of the twelve. pa11y now runs unbaselined;
`summarize-pa11y.mjs` applies the filter and publishes the rule list, a per-rule
count of what each entry hid on that run, and a per-URL suppressed column. A rule
at 0 is flagged as clearable, which is the signal for deleting it. The audited-
standard sentence is qualified for as long as `target-size` sits in the baseline.

A second benefit that was itself a prior bug: the per-URL display cap is no longer
spent on baselined noise, which is what hid three baselined rules for a whole PR
(commit `d060587`).

The cost, and it is real: pa11y-ci now exits non-zero on any run with a baselined
finding, so its exit code is no longer a usable crash signal. That signal is
replaced by a stronger, per-URL one. pa11y-ci stores a caught exception as that
URL's entire result array and an `Error` serialises to `{}`, so a page that never
loaded had no `type: 'error'` entry and was already being counted as a clean pass;
only the exit code had been catching it. The summariser now detects such an entry
structurally, names the URL, and fails the run. A result that is not an array at
all (or is absent) is treated the same way, rather than falling back to "no
issues" as it used to. The exit-code check is kept as a last resort for a run that
reported nothing at all; it cannot be unconditional, because a non-zero exit is now
the normal case whenever anything baselined fired.

Still missing, and deliberately deferred: nothing asserts the report covered every
URL the config declared. The floor is one URL, not all of them, so a run whose
browser pool died after three pages would report "3 URL(s) audited" and pass.
`validate.yml` already computes and validates that count as
`steps.a11y-config.outputs.url_count`; threading it into the summariser as an
expected-URL assertion is the remaining piece.

**A skipped-by-design audit no longer renders as "All checks passed".** Draft and
Dependabot PRs get no preview theme, so the a11y step writes `exit_code=0` on
purpose: the required context must not go red or skip, or those PRs are blocked
forever. But the aggregator counted that 0 as a pass, so the banner asserted a full
green over an audit that never ran. `Collect results` now classifies it as a skip
and separately records that the skip was EXPECTED, and the banner has a dedicated
clause saying the dynamic audit did not run and only the static contrast lint
covered accessibility. `Check for failures` is untouched, so mergeability for
drafts and Dependabot is unchanged.

**The CI Report comment is bounded as a whole, not just section by section.** Only
the a11y section had a cap (30k). GitHub rejects a body over 65536 characters with
a 422, and the upsert is `continue-on-error`, so an oversized report would have
silently posted nothing at all: the worst possible failure mode for the thing
reporting the failures. The detail blocks are now data rather than string literals,
and if the assembled body exceeds 60000 characters they are replaced one at a time
with a "see the run log" placeholder, PASSING sections first and largest first, so
a failing check's output survives longest. The banner and the four result tables
are never dropped. Every degraded form still emits a matched `<details>` pair and a
matched fence pair.

Fixed in passing, found by an offline harness over the assembler: the a11y cap's
blind-cut fallback appended a fixed ` ``` ` + `</details>` pair, which assumed the
cut had landed inside both. When it had not, the spurious `</details>` closed the
WRAPPER around the a11y section and spilled every later section out of it. The
closers are now computed from what the retained text actually leaves open, after
dropping the partial final line.

**zizmor gets a token.** Without one it silently drops its online audits
(`impostor-commit`, `ref-confusion`, `known-vulnerable-actions`) and still reports
a clean run, so a green "Security audit" row was asserting more than the tool had
checked. `GH_TOKEN: ${{ github.token }}` is enough: those audits only read public
action repositories.

## Collection differentiation is a runbook, not a code change (unreleased)

### What changed

No theme code. `docs/collection-differentiation-runbook.md` is new, and it replaces
the accepted-risk paragraph further down this file that recorded `featured` and
`healthcare` holding an identical five products as "reviewed and accepted rather
than merged; revisit after launch with real Search Console data." That accept is
superseded, and the `TODO.md` row is deleted.

**The runbook is the tracker, not a backlog row.** No `TODO.md` entry replaces the
deleted one. The open Admin work is stated in the runbook itself, and
`scripts/seo-review/admin.mjs` reports it on every run through
`admin-description-duplicate`, `collection-body-empty`, and
`collection-seo-title-missing`, which is a better progress signal than a checkbox
because it clears itself when the work is actually done.

### Design points that are load-bearing

**With six products the two collections cannot be differentiated by adding.** One
has to shrink, and the symmetric difference has to be non-empty in **both**
directions. A subset page is still a duplicate candidate against its superset, so
turning identical grids into nested ones fixes nothing. The proposed split makes
`healthcare` a real category with an editorial rule (credential-embroidered pieces
for healthcare workers: the two Lead II crewnecks, the quarter-zip, the women's
vest, and the Huddle crewneck) and `featured` a hand-picked merchandising shelf of
three that includes `gift-card`, which will never belong in `healthcare` and so
guarantees the difference in that direction permanently.

**Copy is half the job and is the most likely way this lands and still fails.**
`templates/collection.json` renders the H1 from `{{ closest.collection.title }}`
and the body from `{{ closest.collection.description }}`, so two pages with
different grids and templated everything-else still cluster. Each collection needs
distinct body copy and distinct stored SEO fields.

**The structural answer is fewer collections.** `all-products`, `featured`,
`healthcare`, and `the-vitals-collection` over six products is four names for one
catalogue. The split is a holding action until the catalogue grows, recorded as
such so it is not rediscovered as a fresh idea.

**The named fallback is noindexing `featured`**, using the blog-listing noindex in
`snippets/meta-tags.liquid` as the working precedent. It is recorded here rather
than as a backlog row, because it is a contingency and not an open action.

**Verification is Search Console after a re-crawl, weeks out.** Canonical
clustering is a Google-side judgement and everything checkable sooner is a proxy.

## Breadcrumb parent collection is a product metafield (unreleased)

### What changed

`snippets/breadcrumbs.liquid` gains a second step in its parent-collection
cascade, reading `product.metafields.custom.breadcrumb_collection.value`. The
snippet's doc header goes from "three steps" to four. `scripts/seo-review/admin.mjs`
reads the metafield through the Admin API and reports two new checks, backed by an
exported pure function and unit tests. `docs/breadcrumb-collection-metafield.md`
is new and `CLAUDE.md` points at it. The Admin work (definition plus values) is
stated in that doc rather than in `TODO.md`; the two new checks report it on every
admin-mode run and stop reporting when it is done, so no backlog row is carried.

### Design points that are load-bearing

**The definition, verbatim, because one field of it fails silently.** Owner
Product, namespace `custom`, key `breadcrumb_collection`, type **Collection
reference, single**, access **Storefronts: read**. Single and not a list, because a
trail has exactly one parent and a list reintroduces the "which one" ambiguity the
metafield exists to remove. Without storefront read access the value returns nil to
Liquid, indistinguishable from unset, while Admin keeps showing what you set.

**Step 2, not step 1.** A collection-scoped URL still wins outright. The snippet's
documented reason for that step is that the shopper actually walked through that
collection and the trail should reflect the path taken. The canonical-contradiction
argument that would otherwise favour overriding it does not apply here, because the
last `ListItem` deliberately omits `item`.

**`preferred_handles` stays permanently, demoted to step 3.** Removing it once
values are set would regress any newly created product to the last-resort "first
non-catch-all" scan, which is the "Home > All Products > Lead II Crewneck" defect
recorded further down this file. It is a safety net, not a migration artifact, so
there is no follow-up row to delete it. Its quiet failure mode (a renamed handle
skipped without error) is now covered by a check rather than by nothing.

**The catch-all guard applies to a hand-set value too.** Pointing the metafield at
`all-products` would reintroduce exactly the trail the exclusion list exists to
prevent, so a misconfigured value falls through to the preferred list rather than
to the worst available trail.

**One blank check covers four nil causes on purpose:** unset, definition absent,
definition not storefront-readable, and referenced collection deleted. All four
should behave identically, so the snippet does not try to tell them apart and
neither does the check.

**Both checks are WARN and keyed per product** (`admin:product/<handle>`) rather
than aggregated into a counter, so the baseline differ names which product
regressed. `product-breadcrumb-collection-catchall` is the higher-value of the two,
because a set-but-ignored value looks correct in Admin.
`BREADCRUMB_EXCLUDED_HANDLES` in `lib/checks.mjs` mirrors the snippet's exclusion
list and carries the same change-them-together comment `BREADCRUMB_PAGE_TYPES`
already has.

**Shipping the Liquid before the Admin work is safe.** The metafield read returns
nil until a value exists and the code falls through to the existing fallback, so
there is no window where the site is worse off.

## ItemList markup on collection pages (unreleased)

### What changed

New `snippets/structured-data-collection-list.liquid`, rendered from
`sections/main-collection.liquid`. New `jsonld-itemlist-missing` WARN in
`scripts/seo-review/lib/checks.mjs` with a test. The exception list in
`snippets/structured-data.liquid`'s doc block gains a third entry.

### Design points that are load-bearing

**A standalone `ItemList`, not a `CollectionPage` with `mainEntity`.** Google does
not consume `CollectionPage`, and it would want an `isPartOf` back to the `WebSite`
`@id`, which puts an entity relationship on a non-homepage page: the neighbourhood
of the `jsonld-entity-leak` rule the rest of this theme's structured data is built
around.

**`ListItem`s carry a `url` and nothing else.** Full `Product` nodes would duplicate
the offers and prices Shopify's `structured_data` filter already emits on each
product page, and would breach the standing rule that Product markup is never
hand-authored.

**Positions are absolute** (`forloop.index | plus: paginate.current_offset`). Page 2
restarting at position 1 would assert that a different product is the first item in
the same list.

**Paginated views are not suppressed; filtered and re-sorted ones are.** Shopify
canonicalises `?page=N` to itself, so each page is its own indexable URL and a list
naming that page's slice with absolute positions is accurate. Infinite scroll does
not change that, because the JSON-LD describes the HTML that was served. A filtered
collection URL canonicalises back to the base collection, so a list emitted there
describes one page under a URL pointing at another; a non-default sort changes the
ordering the positions assert. An empty list is suppressed too, so a suppressed case
emits no `<script>` tag rather than an empty array. The price-range filter needs its
own check in the guard, because a price filter with no selected values still reports
`active_values.size` as 0.

**`itemListOrder` and `numberOfItems` are both deliberately absent.** An earlier
draft carried `itemListOrder: ItemListOrderAscending`, which asserts an ordering
semantic without checking the collection's actual sort; for a `manual`,
`best-selling`, or `created-descending` collection that is simply untrue, and it is
semantically valid JSON so no validator catches it. `numberOfItems` must equal the
`itemListElement` count, and the obvious source (`paginate.items`, the collection
total) does not equal it on any page of a multi-page collection, so emitting it
would be wrong by construction. Both are optional; omitting beats deriving.

**It lives in `sections/main-collection.liquid`, inside the `{% paginate %}` block.**
Inside, because it needs `paginate.current_offset`. Not in the shared
`snippets/product-grid.liquid`, which `sections/search-results.liquid` also renders,
where an `ItemList` would assert a stable list for a query-dependent result set. Not
in `templates/collection.json`, which Shopify generates and the theme editor can
overwrite.

**The loop over `collection.products` is a deliberate second pass**, not folded into
the existing `{% capture children %}` card loop. Building JSON inside that loop is
where trailing-comma bugs live, and at 24 items the second pass is free.

**The check is WARN, not ERROR.** `exitCodeFor` blocks only on fresh errors, and an
empty collection legitimately emits nothing.

## Return policy on the Organization node (unreleased)

### What changed

`snippets/structured-data-organization.liquid` gains a `hasMerchantReturnPolicy`
property declaring a 14-day return window. Edited in place rather than split into a
new snippet: `hasMerchantReturnPolicy` is a property *of* Organization, and every
`structured-data-*.liquid` in this theme emits a complete `<script>` node, so a
snippet emitting a bare JSON fragment would make the router's dispatch model a lie.
`CLAUDE.md` gains a matching rule.

### The premise this was filed under was wrong, in both directions

The `TODO.md` row said the item was blocked by Shopify's `structured_data` filter
not being extensible, "**not** by the return policy varying per product," and that
`MerchantReturnNotPermitted` expressed "Shift Fuel's final-sale case precisely." The
"Out of scope" paragraph further down this file recorded the same reasoning. Both
are wrong. The published refund policy is a **14-day return window** with a
non-returnable list covering custom or personalized designs, items marked final
sale, and gift cards. `shift-fuel-crewneck` is the one product that is **not** final
sale, which is exactly why it is the only one of six product templates carrying no
`return-policy-acknowledgment` block; the final-sale case belongs to the
custom-embroidered Lead II and Huddle products. So the store has a real return
policy, and policy non-uniformity is precisely the difficulty rather than a
non-issue.

### Design points that are load-bearing

**The over-statement is a chosen trade, recorded so it is not filed as a bug.** The
node asserts a 14-day window store-wide, and the policy's exclusion list covers five
of the six products. Google's org-level node is meant for a policy applying to most
or all products; here it applies to one. The mitigation is that `merchantReturnLink`
points at the live policy that enumerates every exclusion, and that this paragraph
exists.

**The product-level override is closed, not merely unimplemented.** Google's
override path is a `MerchantReturnPolicy` nested under **`Offer`**, not `Product`.
Shopify's filter owns that node and emits
`"@id": "/products/handle?variant=N#offer"`. Shadowing that `@id` to merge in a
property would mean reproducing Shopify's exact relative id including the variant
parameter, on products with hundreds of variants, relying on undocumented node-merge
behaviour. That is the silent-invalidity class the structured-data rules exist to
prevent. Do not re-propose it.

**Not a theme setting.** The categories are not one-field swaps:
`MerchantReturnFiniteReturnWindow` additionally requires `merchantReturnDays`, and
Google wants `returnFees`, `returnMethod`, and `refundType`. A dropdown would let
the operator pick a category that renders a structurally invalid node, with nothing
in CI to catch it, since `shopify theme check` does not parse JSON-LD and
`seo-review:test` is unit tests only. It is also a legal-adjacent claim that has to
track `/policies/refund-policy`, and a theme-editor dropdown can drift from that
silently. Changing it should cost a code edit and a release note.

**`applicableCountry` is the literal `"US"`.** Not from
`localization.available_countries`, which is market config that would silently widen
a legal claim the day international markets are enabled. Not from `shop.address`,
because the snippet's doc block bans postal detail and pulling a country code out of
that object invites the next reader to pull the rest. If the active delivery profile
ever ships outside the US, this becomes an array listing every country served.

**Every field traces to the published policy, not to a plausible default.**
`returnFees` is `ReturnFeesCustomerResponsibility` because the policy says the
customer arranges and pays for return shipping and no prepaid labels are provided;
`refundType` is `FullRefund` to the original payment method; `returnMethod` is
`ReturnByMail`.

**`merchantReturnLink` comes from `shop.refund_policy.url`**, prepended with
`shop.url`, so the policy text has a single source of truth and none of it is
duplicated into the theme. It is guarded, because `shop.refund_policy` is nil when
the policy is unpublished, and it follows the established leading-comma-inside-its-
own-`if` idiom. The outer comma is unconditional because the property itself always
emits.

## Empty blog listing is noindexed by article count (unreleased)

### What changed

`snippets/meta-tags.liquid` emits `<meta name="robots" content="noindex, follow">`
on a blog listing whose `articles_count` is zero. `/blogs/news` has no articles, so
that is the one page affected today. Three `scripts/seo-review/accepted-risks.json`
rows go with it: `blog-empty` is rewritten from "revisit at launch" to the decision
that was made, and `robots-noindex` plus `surface-noindex` are accepted on
`/blogs/news`.

**The guard is the article count, not the blog handle, and that is the whole
design.** The three options on the table were noindex, unpublish, or start
publishing. Publishing is content work and was explicitly not to be chosen by
default; unpublishing 404s the route and costs a nav edit to undo. Noindex was
picked because it is the only one that is reversible without anybody remembering
to reverse it: an unconditional noindex on the `blog` page type would survive the
first real post and quietly bury it, whereas counting articles means the tag
removes itself the moment there is something worth indexing. Do not "simplify" the
condition to a page-type check.

**`follow`, not `nofollow`.** The listing still links into the catalogue and those
links should keep passing through; the thin-content problem is the page being
indexed, not the page existing.

**Two seo-review checks fire on this by design, and are suppressed rather than
exempted.** Shopify's generated sitemap lists the blog regardless of the robots
meta, so the crawl reports `robots-noindex` and the anonymous surface sweep will
report `surface-noindex` once the password gate is off. Both are accepted-risk
rows keyed to `/blogs/news`. `blog` was deliberately **not** added to
`lib/checks.mjs`'s `NOINDEX_OK` set: keeping it an indexable page type means that
if the blog ever has articles and still carries a noindex, the check reds instead
of staying silent. The accepted-risk rows are self-clearing in the same way as the
tag, since the findings disappear with the first published article.

## Shipping copy: Expedited/Express standardised, announcement bar corrected (unreleased)

### What changed

`sections/header-group.json` rewords two announcement slides: slide 2 from "$8.00
Flat Rate Shipping **for All Items**" to "on Orders under $75.00", and slide 3
from "Free Shipping on Orders over $75.00" to "on Orders $75.00 and up". The
theme's "Expedited" wording is unchanged everywhere it appears; the other half of
the mismatch was closed by hand in Admin, where the four `Express` rate rows were
renamed to `Expedited`. That step could not be scripted because `write_shipping`
is not granted to the custom app. Verified read-only afterwards: four `Expedited`
rows at $20/$40/$60/$80 on the same weight tiers, both `Economy` rows and the
North America zone untouched, zero rows named `Express`.

**The direction of the Expedited/Express fix was decided by counting surfaces and
by the zero-orders window, not by which side looked cheaper to edit.** `TODO.md`
had recorded the Admin rate name as the cheap side to change, on a count of eight
template locations. That count was short. "Expedited" appears in 13+
customer-facing places once the live Shopify shop policy is included: five
product-template accordions, three FAQ answers, and roughly six mentions in the
Shipping Policy, which is not a repo file at all. Against that, "Express" is four
Admin rate rows. The policy is also the half that would degrade most under a
rename, because it deliberately contrasts "Expedited Shipping" with "Rush
Production" as a teaching point. The second, time-boxed reason: `orders(query:
"status:any")` returns zero, so no historical `shippingLine.title` carries the old
name. Order history freezes that string, so the rename is free now and is not free
after the first order. If this is read after launch, the calculus has changed.

**The boundary wording on slide 3 is a correctness fix, not a copy edit.** The
live rate is free at order total **>= $75.00**, so "over $75.00" mispriced exactly
$75. "$75.00 and up" matches both the rate condition and the FAQ, which already
said "Orders $75 and up ship free".

**The rename interacts with the 0-lb weight blocker, and does not fix it.** The
Shipping Policy says Expedited pricing "varies based on order weight". That is
true of the rate configuration (four weight tiers at $20/$40/$60/$80) and false in
practice while every variant weighs 0 lb, because every order of any size buys the
$20 tier. The rename makes the *name* honest; the *pricing* claim stays wrong
until per-variant weights are set. The policy wording was deliberately not
softened to match the bug, and the blocker stays open in `TODO.md`.

Rate descriptions at checkout are a separate matter, noted and declined here: all
six live rate rows have an empty description, so checkout shows a bare name and
price.

## Footer touch targets, dark-scheme contrast, and three stale findings retired (unreleased)

### What changed

`blocks/footer-policy-links.liquid` gives each policy link its own 44px touch
target. Separately and outside this branch, the `sss-dark-scheme` colour scheme
had six values corrected in Admin and reconciled through `shopify-sync`. Three
"Homepage review (2026-07-20)" backlog entries and the `og:image` entry turned
out to describe states that no longer exist and were deleted after visual
confirmation on the PR preview theme. Two pieces of reasoning outlive the tasks.

**The breadcrumb negative-margin pattern does not generalise to a wrapping
list.** `.breadcrumbs__link` in `assets/base.css` buys its 44px target with
`padding-block` plus an equal negative `margin-block`, so the hit box grows
while the line box, and therefore the visual density, stays put. The footer
backlog entry recommended copying it, and that recommendation was wrong for a
reason worth stating plainly: breadcrumbs never wrap. The footer links do. A hit
box that bleeds past its line box has nothing to collide with on a single row,
but on a wrapping list it overlaps the row beneath it, and with a 15px line in a
44px box across an 8px row gap the overlap is about 21px. The top row would
swallow taps aimed at the row below, which is a worse accessibility outcome than
the small target it set out to fix. The pattern here is the opposite trade:
`min-block-size` on an `inline-flex` anchor, with the list's row gap dropped to
zero so the padded boxes tile rather than overlap. Visual spacing between
wrapped rows goes from 8px to roughly 29px and the footer grows; that is the
cost of a compliant target on a list that wraps, and it is not avoidable by
being cleverer about margins. A comment in the block's stylesheet says so, since
the next reader will otherwise "fix" it back to the breadcrumb pattern.

**`primary` and `primary_button_background` are separate scheme variables whose
contrast fixes move in opposite directions.** `snippets/color-schemes.liquid`
renders them as genuinely distinct CSS variables, and `#007dd5` occupied five
slots in `sss-dark-scheme` at once: the accent, the primary button background
and border, and the selected-variant background and border. A single
find-and-replace across those five would have been wrong, because the two roles
are measured against different backdrops. The button and variant fields sit
*under white text*, so raising their ratio means going darker (`#0071c2`, 4.29
to 5.07). The accent is *text on the `#071e3f` navy*, so darkening it makes it
worse (3.86 to 3.27); it had to go lighter instead (`#3399e0`, 3.86 to 5.35),
absorbing the shade that had been the hover state, with hover stepping one
lighter again (`#66b3ea`, 7.26) to stay distinct. The general rule: measure each
colour field against what it actually renders on, not against the scheme's
nominal background. Nothing in CI checks any of this, which is why an
accessibility CI check is now its own backlog entry. Worth knowing when that
entry is picked up: the sibling `perts-foundry-website` repo already runs
`pa11y-ci` as a hard-failing WCAG 2.1 AA gate, but it can only do so because
Hugo gives it a local build to serve and crawl. Liquid renders server-side, so
there is no equivalent local target here, and the honest options are a preview
theme URL (which needs `STOREFRONT_PASSWORD` in a workflow that does not have it
today) or a JSON-level lint of `color_schemes` that catches less.

The two `selected_variant_*` values were latent rather than live when fixed. No
product template uses `sss-dark-scheme` today (all six use `scheme-1`, whose
selected-variant pair is 21:1), so no swatch on the storefront was failing. They
were corrected anyway so the scheme is not a trap if it is ever applied to a
product page.

One note on the reconcile diff, recorded because it was not caused by the colour
edit and will confuse whoever bisects for it later: the same `shopify-sync` PR
also reordered the three `social_*_link` keys within `current` (same values) and
**deleted** `secondary_color` and `ternary_color` from the chat app-embed block
settings. Neither was intended by the colour-scheme change.

## Ten CI/workflow and docs backlog items cleared (unreleased)

### What changed

Ten more `TODO.md` entries, all repo-local and needing no Admin access: seven
workflow changes and three docs items, two of which were close-outs rather than
edits. The reasoning worth keeping is below.

**`withRetry` is now a file, because `github-script` steps do not share scope
([AR-2]).** Three steps in `deploy.yml`'s `deploy` job (Post deploy report,
Squash merge, Report failure) each carried a byte-identical copy of the helper
plus its `RETRYABLE` / `isTransient` preamble. GitHub Actions does not support
YAML anchors, and two `github-script` steps in the same job share no JS scope,
so hoisting inside the file was not available: the only single definition is a
file, `.github/scripts/with-retry.js`, `require`d per step. Two things about
that require are load-bearing. The path must be absolute
(`path.resolve(process.env.GITHUB_WORKSPACE, ...)`); a relative `require`
resolves against `actions/github-script`'s own directory, not the workspace.
And it exports `makeWithRetry(core)` rather than `withRetry`, because the
helper's only external dependency is `core.warning`, which does not exist at
module load. The trust position is unchanged, not widened: the same step
already dynamically imports `report-format.mjs` from the same checkout into the
same token-holding process.

**Preview pushes now retry with a timeout, and the retry is always addressed by
theme ID ([AR-5]).** Live mode had 3 attempts at `timeout --kill-after=10s 8m`;
preview had neither, so one transient blip failed the PR. Preview now gets 2
attempts at 5m, proportionate to `preview.yml`'s 15-minute job budget. The trap
this had to avoid is the one the pre-existing exit-97 retry already documented:
retrying with `--unpublished` would create a SECOND `pr-N-preview` theme, which
the duplicate-name guard then refuses on every later run, permanently. So the
loop resolves a target ID before any retry, from the push report and, failing
that, from a fresh `theme list` lookup by name, because a create attempt killed
by `timeout` may still have registered the theme.

**Preview `cancel-in-progress: true` is a decision, now recorded beside itself
([AR-13]).** A cancelled preview push can leave the theme partially uploaded,
but the state is self-healing (the next run pushes the whole tree) and the theme
is an unpublished draft with no customer exposure, so queueing a push-storm buys
nothing. The cleanup job stays `false` for the opposite reason: a cancelled
delete leaks a theme that nothing sweeps up. The two settings differ on purpose;
the comment exists so the next reader does not "fix" the asymmetry.

**The `deploy` comment trigger is two checks, and only one of them is
authoritative ([CR-13]).** A YAML `if:` expression cannot trim or lowercase, so
the workflow-level condition is a cheap allow-list of exact bodies covering the
real miss cases (auto-capitalised `Deploy`, an invisible trailing space,
`/deploy`). The real match is re-asserted in JS in the gate job's first step,
which normalises (`trim().toLowerCase().replace(/^\//, '')`) and `setFailed`s on
anything that is not exactly `deploy`. Both layers are equality tests on the
WHOLE body. Never relax either to a substring match: the word `deploy` in
ordinary PR prose would then push to the live theme.

**A missing `exit_code` in `validate.yml` now fails instead of warning
([CR-15]).** It covers twelve steps, `gitleaks` among them, and a secret scan
that silently recorded no result must not merge green on a warning. It is
near-unreachable today because every step is `set +e` and always writes its
code, which is exactly why changing it costs nothing and closes the case where
one stops doing so.

**`defaults.run.shell` is behaviour-changing, and the audit is the work
([SA-7]).** All four workflows now run steps under
`bash --noprofile --norc -euo pipefail {0}`. GitHub's default is `bash -e {0}`,
so the delta is `-u` and `-o pipefail`. Every existing `run:` block was read
against it first: `deploy.yml` and `sync.yml` steps already set `-euo pipefail`
themselves, and `validate.yml`'s capture steps open with `set +e`, which clears
`-e` but deliberately does NOT clear `-u` or `-o pipefail`. Their pipelines
(`grep | tail | grep`) and unset reads (`${TESTS_RUN:-0}`) were checked
individually. Composite actions declare their own shell and are untouched; the
composite's `set +e` comment already explains why its own `-e` must be cleared.

**[AR-10] was verified fixed, not dropped.** The grouped-Dependabot gap the item
describes is closed in `deploy.yml`: the gate reads `update-type:
version-update:semver-*` commit trailers across every commit on the PR as the
PRIMARY signal (authoritative for grouped updates), keeps the `Bump|Updates X
from A to B` title regex as SECONDARY, and fails closed when neither yields a
severity. That is stronger than what the item asked for.

**[DS-15] closed as won't-do.** `.github/zizmor.yml` already carries a 40-line
rationale for its single `dangerous-triggers` suppression, verified accurate
against `deploy.yml`'s gate. The outstanding half was a CLAUDE.md pointer, and
it was declined: the rationale lives beside what it explains, and a second
location is a thing that can drift out of agreement with the first.

**[DS-10] was stale, so it was re-scoped rather than implemented.** It asked
README to enumerate the four required checks on `main`; `main` has required
exactly one, `validate / validate`, since the single-`validate`-job
consolidation. The README row now says "exactly one" and names where the context
string is actually configured (the private infrastructure repo's
`ci_check_contexts`), which is the part that can silently break: rename the
`validate` job or workflow here and `main` requires a check that no longer
reports. The same staleness ran through [SA-9], whose entry was re-scoped in
place rather than closed.

**Smoke-test paths: the action input default is the single source ([DS-13]).**
README restated the list; it now links the composite action's `smoke-paths`
input instead, the same treatment [DS-17] gave the CLI version. The
`release-notes.md` mention stays as written because it is a historical record of
what shipped then, not a second live copy. The item's third leg was already
gone: the composite action no longer carries the "commit it to CLAUDE.md as a
permanent fixture" instruction that would have created a third copy.

## Ten fast backlog items cleared in one pass (unreleased)

### What changed

Ten `TODO.md` entries that needed no Admin access and no product decision, cleared
together: two stale docs, two missing CI comments, the vacation date placeholders,
one real gallery defect, one template padding drift, and the size-chart table's
accessibility gap. The reasoning worth keeping is below.

**Gallery counts must come from the rendered set, not the filtered set ([CR-16]).**
`snippets/product-media-gallery-content.liquid` built `sorted_media` well below the
two places that size the slideshow against it, so the counter threshold
(`> 15` switches dots to a counter) and the `--single-media` class both read
`filtered_media.size`. That is the wrong number whenever `hide_variants: true`: the
sort loop `continue`s past any media whose `src` is in `variant_images`, so
`sorted_media` can be strictly smaller than `filtered_media`. A two-item filtered
set could render one slide while still getting arrows and no `--single-media`
class. The fix is a hoist, not new logic: the `sorted_media` block depends only on
`filtered_media`, `selected_variant_media`, `block_settings.hide_variants`, and
`variant_images`, all assigned by the end of the colour-filter block, so it moves
up unchanged and both consumers repoint to `sorted_media.size`. The contract to
keep: **anything that sizes the gallery reads `sorted_media`.** `filtered_media` is
an intermediate, and reading it downstream is the bug, not a shortcut.
`has_image_drop` and `is_single_column` already read `sorted_media` and were
correct.

**Two of the three "cosmetic template drifts" were not drift.** Only Shift Fuel's
`request_combination_001` `padding-block-start: 8` was real (now 0, matching the
other four apparel templates). The other two are load-bearing and were re-filed
once already, so they are recorded here and in `TODO.md` rather than left to be
rediscovered. Shift Fuel has no `<h5>Final Sale</h5>` in its Returns Policy body
because it is not final sale: it is the only apparel product with a 14-day return
and correspondingly the only one with no `return-policy-acknowledgment` block.
The gift card's `property_label` override is the documented garment-vs-gift-card
split (see that block's own `{% doc %}`), and the value is a live cart line-item
property key, so changing it splits the acknowledgment across orders placed either
side of the change. The lesson generalises: on these templates, "make them
identical" is not automatically the right diff.

**`--ignore-scripts` in the composite action, from verified facts ([CR-12]).** The
TODO text was partly stale. `esbuild` and `@ast-grep/napi` are *transitive* deps of
`@shopify/cli`, not direct ones, and their platform binaries arrive as
`optionalDependencies` (per-platform packages npm resolves at install time), not
via a postinstall download. `esbuild` is the only entry in `package-lock.json` with
`hasInstallScript`. `sharp` is a direct devDependency but ships no install script at
the pinned version, so the flag is a no-op for it. The reason the flag stays is that
this job holds the Shopify token; re-check `hasInstallScript` across the lockfile
after a dependency bump rather than assuming the list is still accurate.

**README version numbers were removed rather than synced ([DS-17], decided
2026-08-14).** The "At a glance" table restated the CLI version and the Node
floor; both had drifted (`3.94.3` vs `4.6.0`, `>=20` vs `>=22.12.0` with CI on 22).
Restating a number that lives in `package.json` guarantees it drifts again on the
next Dependabot bump, and no CI check would catch it. Both now point at
`package.json`'s `engines` / devDependency instead of quoting a value.
`release-notes.md`'s historical `3.94.3` mention is a record of what shipped and
stays as it is.

**Vacation date defaults are now `[SET DATE]`.** `settings_data.json` holds no
`vacation_*` key, so the four schema defaults in `config/settings_schema.json` are
literally what a future enable starts from. A plausible-looking date can ship by
accident; a placeholder cannot. `vacation_processing_date` is stamped onto each
order as the term the customer agreed to, so a stale value there is wrong on the
order record, not just in copy.

**The `theme-color` meta tag was deleted, not filled in.** It shipped with
`content=""`, which is not a valid colour, so it did nothing on every page render.
Nothing usable is in Liquid scope at that point in `snippets/meta-tags.liquid`: the
colour-scheme snippets render after it and emit CSS custom properties, not a
Liquid-readable value. A comment in its place records that re-adding it means
sourcing a literal colour.

**`blocks/table.liquid` row headers keep the data-cell styling.** Each body row's
first cell is now `<th scope="row">`, plus an optional visually-hidden `<caption>`.
Two constraints worth knowing before touching this file again. (1) The `<th>` must
be styled back to `font-weight: inherit; text-align: start` or the size chart
visibly changes; the semantics are for screen readers, not for looks. (2) The
`[data-columns="N"] .table-block__cell:nth-child(n+N+1)` hiding rules match on
`nth-child`, which is element-type-agnostic, so they keep working across the
`<td>`-to-`<th>` change. The setting ids (`column_count`, `show_header`,
`stripe_rows`, `colN_heading`, `rMcN`) and the 8x6 ceiling are generated by
`scripts/size-chart/lib/table-block.mjs` and compared against the shipped templates
by its golden tests; adding an optional `caption` setting changes no generated JSON,
so those tests stay green.

## Backlog triage: completed work moved out of TODO.md (unreleased)

### What changed

`TODO.md` now holds only items that still need action. Completed entries are
deleted from it rather than ticked, so the backlog never accumulates a history
section. The write-ups that were carrying real reasoning are preserved here.

**Per-variant image matching for colours.** Shipped as an alt-text filter. The
gallery shows photos whose alt text names the selected `Color` option value, plus
photos naming no value at all (group shots and design-only shots), and falls back
to the full gallery for a colour with nothing of its own rather than rendering
empty. Driven by one global `color_option_name` setting with blank as the kill
switch, mirroring `size_option_name`. Both gallery surfaces render
`product-media-gallery-content.liquid`, so no block schema and no product template
changed. The contract is `docs/product-media-alt-text.md`. The `alt` column in
`product-images/processed/manifest.csv` is where the strings are drafted, but that
path is gitignored on purpose, so it is a local convenience only: nothing in the
repo or in CI can catch wrong alt text, and Admin holds the only live copy.

*The original note was wrong about the mechanism.* It claimed the theme already
did the swap, reading that off `snippets/product-media-gallery-content.liquid:30`
and `snippets/card-gallery.liquid:88` filtering on
`where: 'attached_to_variant?', true`. They do filter on it, but Shopify caps a
variant at one attached media (`PRODUCT_VARIANT_ALREADY_HAS_MEDIA`), so attachment
expresses one hero per colour and can never express "all three black photos".
`hide_variants: true` was a no-op only because nothing was attached yet; with
heroes attached it would have hidden the other colours' heroes and left every one
of their secondary photos in the carousel. Recorded because the mistake is the
useful part: "the plumbing exists" was read off a filter that answers a different
question than the one being asked, and acting on it would have bought a day of
Admin work for the wrong result.

Photography coverage at the time, by *filename* colour: the crewnecks had black /
blue / gray, the quarter-zip black / blue / gray, the women's vest black only.
Those are not the Admin option values: every product's values are `Black` /
`Grey Heather` / `Classic Navy` (the vest, `Black` only; the repo vocabulary was
reconciled to these on 2026-08-11, though the live media alts written on
2026-07-17 still say the old `Gray` / `Navy`), and the `blue-*` files are the
Classic Navy ones. All 53 media across the five products were alt-tagged on
2026-07-17. Huddle is deliberately left unbound because its colour and design are
locked 1:1, so filtering by colour would hide the shopper's chosen design.

**Return-policy acknowledgement before add-to-cart.** Shipped as a terms summary
(merchant-editable `richtext`) plus one required "I agree" checkbox, wired together
with `aria-describedby`, and a policy link outside the label. The checkbox unticks
itself on any option change, which is what lets the
`properties[Return policy acknowledged]` value name the confirmed size honestly:
the box can only ever be ticked for the variant on screen. Unticking re-hides
accelerated checkout and is announced in a polite live region. Blank `terms` hides
the block entirely (hence `"tag": null`, so no empty element trips the fail-closed
`:has()` rule). Validation renders as visible text with `aria-invalid`, not just
the native bubble.

*The original note had gap (1) backwards*: it called for adding the block to
`product.shift-fuel-crewneck.json`. That is the one product with no personalization
and a plain 14-day return window, so it is the one product the checkbox must not
appear on. The real inconsistency was `product.huddle-crewneck.json`, which carried
the checkbox while its own Returns Policy accordion promised a 14-day return.
Recorded because the mistake is the useful part: block placement, not block
content, is what expresses the policy.

**Gift card template.** Added `templates/product.gift-card.json` (cloned from the
Huddle crewneck, then stripped of garment framing: no size chart, no applique, no
combination request). Keeps the native recipient form via `gift_card_form: true`
and a gift-card-specific acknowledgement and accordion.

**Size-guide link at the size selector.** `snippets/size-guide-link.liquid` plus
`assets/size-guide-link.js` render a real `<a href="#SizeChart">` beside the size
option on both variant-picker styles; it opens the accordion row, scrolls, and
moves focus to the summary. The size option is identified by a global
`size_option_name` setting resolved through `snippets/size-option-position.liquid`,
shared with the acknowledgement block because a theme block cannot read another
block's settings. `_accordion-row.liquid` gained an optional `anchor_id` setting,
emitted as `SizeChart` by `table-block.mjs`, so it survives `apply-size-chart.mjs`
(a hand-edited value would be upserted away). `accordion-custom.js` gained a
`data-latched-open` latch so a row opened this way is not slammed shut by the 750px
breakpoint handler, and it honours a direct `#SizeChart` page load.

*Cross-layer contract*: the anchor literal is duplicated across the generator, the
Liquid, and the link's href, because the theme has no build step.
`test/anchor-contract.test.mjs` is the only thing holding those together; the
goldens cannot, since they compare the generator to its own output.

**Size-chart tooling, completed follow-ups.** "Choosing your size" guidance ships
in both the accordion and the PNG intro (deciding measurement, between-sizes
tie-breaker, no-reference-garment path, and a contact-us help line). *Correction
(2026-07-16):* that paragraph was originally claimed to be garment independent and
living once in `copy.md`. The vests disproved it: the paragraph named chest (the
women's vest measures bust) and named sleeve (a vest has none). It was split. The
tie-breaker and help line stayed shared, the deciding measurement became the
`{{deciding_label}}` token, and the measure-yourself instruction moved onto the
columns that can support it.

Also landed: column-driven generalisation (profiles declare their own ordered
`columns` and pick a `garment` silhouette, with the quarter-zip and women's
microfleece vest onboarded end to end); a vertical-rhythm pass deriving PNG canvas
height from content with per-garment `garmentTop` collar extents; per-garment
accordion prose composed from each column's `explain` so a measurement is explained
if and only if the blank has that column (adding `garment_noun` and `decides_size`
to the schema); and the unisex microfleece vest profile dropped, since only the
women's vest launched.

**Deferred CI findings closed 2026-05-05.** `[AR-4]` and `[AR-6 / IR-1]`: the
composite action gained `mode: delete-preview`, routing preview cleanup through it
and removing the hardcoded `@shopify/cli` version; the install pattern consolidated
into a `setup-shopify-cli` composite action shared by `shopify-theme-push` and
`validate.yml`. `[CR-8]` landed alongside them. `[IR-5]` and `[SA-12]` went
obsolete when `drift-watch.yml` was deleted; `[SA-8]`'s surviving half is covered
by `validate.yml`'s `SHELLCHECK_OPTS: "-e SC2016 -e SC2317"`.

**Default `templates/product.json` gap accepted (2026-08-14).** Every product this
store sells is expected to carry its own custom template rather than fall back to a
generic one, so the absence is intentional. The standing obligation it creates:
assigning a template suffix is a required step when creating any product, because
nothing renders behind a cleared or unset suffix.

**Size-chart scope: deliberately excluded (operator decision, 2026-07-14).** These
were considered and dropped; they are not backlog gaps. Returns / exchange line in
the chart (handled by the return-policy-acknowledgment block near the buy buttons,
do not duplicate). Made-by-hand measurement-tolerance line (skipped). Model /
on-body fit reference photo, imp 4 (photography and merchandising, out of tooling
scope; add a "model is X tall, wears M" gallery caption when on-body shots exist).
Aggregate runs-small / true / large review subscore, imp 3 (cold-start; revisit
once review volume exists). No-tape string-and-ruler fallback, imp 3 (redundant
with the "measure a top you already own" method that is already the primary
instruction). Pre-purchase / add-to-cart size nudge, imp 2 (covered by the existing
return-policy-acknowledgment block; avoid extra checkout friction).

**Pre-launch review (2026-08-13): verified clean.** Recorded so nobody re-audits
these. The six product templates are structurally identical (same block trees, same
gallery settings with `hide_variants: true`, same accordion row ids and headings,
`anchor_id: "SizeChart"` on all five apparel templates). The Huddle applique
dropdown matches `scripts/applique-grid/patterns.json` exactly, all 18 entries, so
the old "3. Test" placeholder is gone. All three size-chart tables match their
profiles cell for cell. Alt-text colour binding is correct on every product (three
photos bound per colour, charts and size guides and group shots correctly shared).
Every product has a `templateSuffix` that resolves. The FAQ's shipping claims match
the live rates exactly, territories included. The footer social block and the theme
settings agree, so `sameAs` is accurate. The `#away-from-studio` FAQ anchor is
intact.

## applique-grid: consent is now a token, and four fail-open guards closed (unreleased)

### What changed

Pre-PR review of the tooling branch surfaced four guards that were open in a way
their own comments said they were not, plus one gate whose strength was inverted
relative to its blast radius. All five are mechanisms here, not prose.

**The live publish gate had no consent step.** The only thing between a dry run
and the irreversible live write was `publish-plan.json`, a file the same process
had just written, valid for 24 hours. That checks freshness, which is not the
same question as whether anyone said yes; a process could satisfy it by talking
to itself. Meanwhile the *reversible* local registry write did have `--confirm`.
`--dry-run` now prints a 12-character approval token for exactly the plan it
printed, and the live run requires it back as `--approved <token>`. The token has
to travel out to the operator and return through argv, which is the one step no
amount of self-persuasion performs. A token-less live run refuses before reading
or consuming anything, so a mistyped command costs no gate round trip.

**`defaultBranch()` failed open.** When `origin/HEAD` was unset it returned the
first conventional name that existed *locally*, so in a repo whose real default is
`master` but which also carries a stale local `main`, it answered `main` and
`draft.mjs --write` ran happily on `master`. It now returns every name that must be
refused, and refuses all of them when it cannot be certain. The cost of being wrong
is renaming a branch; the cost of the old behaviour was an unreviewed commit on the
default branch.

**`lib/registry.mjs`'s `save()` was a plain `writeFile`.** `publish.mjs` calls it
immediately after the live media writes, to record the new chart GIDs, which makes
it the highest-stakes write in the module: a truncation there loses the mapping from
published charts to live media and the next publish would re-create them with nothing
to reconcile against. It is now the same atomic temp-file-plus-rename that `draft.mjs`
already used for the reversible write. The implementation is shared rather than
duplicated, so there is one of it.

**The reorder's "target still achievable" check was set membership.** A length
compare plus `every(includes)` cannot see a duplicate, so a target of `[A, A, C]`
against a live `[A, B, C]` scored achievable and the reorder issued would have dropped
B out of the gallery entirely. It is a multiset comparison now.

**`APPLIQUE_REVIEW_DIR`'s containment check was lexical only.** A symlink whose own
path sits outside the repo but which points into it passed clean, and review images
landed in the public working tree, which is the exact thing that guard exists to
prevent. The check now re-runs against the resolved real path.

Also: the `--out-dir` containment rule was a module-private regex in four entry
points, unreachable from a test, so deleting it outright left the whole suite green.
It is one exported function with its own cases now, and a subprocess test per tool
pins the call sites. Markdown cells in both gate tables escape `|`, which is legal in
a filename and could otherwise forge a row in the artifact the operator approves from.

## applique-grid: pinned gallery media and a corrected reorder verdict (unreleased)

### What changed

Two defects in `scripts/applique-grid/`'s publish path, both of which produced a
confident wrong answer against irreversible live writes.

**The charts were hard-coded as the contiguous gallery tail.** The operator wants
the logo last, so the audit showed a permanent STALE line and the next publish
would have moved the charts past the logo and silently undone their Admin fix.
The registry now takes an optional `gallery.pin_after_charts`, and the desired
order becomes untouched live media (minus the pinned), then the charts in page
order, then the pinned media in declared order. With the key absent the computed
order is byte-identical to before, which a test locks against every existing
ordering fixture.

Regex validation of a pinned GID proves shape, not existence, so each way this
could go quietly wrong is a hard stop naming the GID: absent from live media,
overlapping the chart set (re-checked at plan time, since the registry can be
hand-edited in between), overlapping the delete set, duplicated, malformed. An
empty list and an absent key are exactly equivalent. Unknown keys are now
rejected by name throughout the registry, because a misspelled `pin_after_chart`
would otherwise validate clean, do nothing, and let the next publish undo the fix
while the registry looked correct.

**The first publish computed `reorder not required` and was wrong.** The planner
simulated post-create gallery positions on the assumption that Shopify appends
new media at the end. The real run disproved it: the dry run said no reorder was
needed, both creates landed mid-gallery, and the next audit reported STALE.

With creates pending there is no honest verdict to give before they land, so the
dry run now reports `undetermined until post-create` and prints the TARGET final
order. The operator approves a destination and a possibility rather than a false
negative.

### Why the fix is not "re-read and reorder"

The naive fix buys correctness by executing a live gallery mutation the operator
never approved, which is what the plan/approve/execute split exists to prevent.
So after the readiness barrier `publish.mjs` re-reads, reconciles, checks the
approved target is still achievable, snapshots, and only then moves anything.
Every failure path returns without issuing a reorder at all.

Reconciliation is scoped so it still catches foreign drift while tolerating our
own writes: the re-read set must be exactly (plan-time media minus our deletes)
plus our creates, and every untouched media must still carry the alt and filename
it had at plan time. A concurrent Admin edit trips it; a CDN-rewritten filename on
one of our own creates does not.

The stored dry-run plan is now stamped with version, time, shop, product, the
live-state hash, and the approved reorder verdict, and a live run refuses
anything that does not match, including a plan older than 24 hours against
otherwise identical live state.

### Deploy impact

None on the storefront. `patterns.json` gains an optional key, and the dropdown
text derived from it is unchanged (a test asserts the regenerated template diffs
empty). The live gallery is already in the order the new rule wants, so adding
the logo GID to `gallery.pin_after_charts` turns the audit's gallery-order line
PASS with no live write.

### Rollback

Revert the commit. Adding the registry field touches no live state, and if a
reorder has already fired, the pre-reorder gallery order is in
`product-images/applique/publish-snapshots/`.

## Custom Orders redesign + FAQ section color-scheme migration (unreleased)

### What changed

`templates/page.custom-orders.json` is rebuilt to match the homepage's design
language: uppercase eyebrow + heading lockups above every section, a navy
`sss-dark-scheme` hero and a rounded navy closing-CTA card (cloned from the
homepage's `closing_Zx4Vn8` card, with fresh block keys), an alternating
scheme rhythm (navy / scheme-3 / scheme-1 / scheme-3 / white FAQ / scheme-3),
72px section padding, and the four process steps arranged as a 2x2 grid via
two row-direction group wrappers. The oversized `jumbo-text` closing block,
which overflowed the viewport on mobile, is replaced by the card.

A second pass ports two homepage signature elements. The hero section
converts from the generic `section` type to `hero` and reuses the homepage's
custom-liquid headline lockup (Dancing Script cursive word flanked by
`sss-star.svg` stars); no hero media is set, so the section renders as a navy
band. That surfaced a latent hero.liquid behavior: a media-less hero rendered
the `hero-apparel-1` placeholder SVG on the storefront, not just in the
editor, so the three placeholder emissions are now guarded on
`request.design_mode` (inert for the homepage hero, which always has media).
A scoped `.hero-lockup--custom-orders` override drops the cursive
word to 1.3em because "Custom Orders" is longer than "Obsessed". The four
process steps become rounded `scheme-3` cards (24px radius, 28px padding) on
the white section, echoing the homepage product-card language; the
numbered-circle CSS keys off `h4` elements in DOM order, so the card wrappers
do not disturb it. Because the two row-direction wrappers size each card to
its own text, the `hiw_styles` block also converts the section content
wrapper to a 2-column grid at 750px+: the rows and their `group-block-content`
divs collapse via `display: contents`, the lockup spans both columns, and
`grid-auto-rows: 1fr` equalizes all four cards to the tallest. The
`:nth-child(2..4)` selectors bind to the section's block order (styles,
lockup, row 1, row 2); reordering blocks in the editor breaks the grid.

Two rendering bugs fixed rather than worked around:

- **Bullet lists rendered center-aligned with left markers.** Text blocks with
  `width: fit-content` never emit `--text-align` (see
  `snippets/text.liquid`), so their `alignment: left` was silently ignored and
  the section's centered `--horizontal-alignment` leaked in as the default.
  Both bullet-list body blocks now use `width: 100%` + `max_width: normal`,
  the code path that honors the alignment setting. (A desktop visual pass then
  centered the text sections' lockups and body columns on one axis; the body
  copy stays left-aligned inside its centered `normal`-width column, since
  `narrow` at 22.75em left-pinned a skinny column under full-width headings.)
- **Headings referenced `var(--font-primary--family)`, which is defined
  nowhere in the theme** and is not even an option in the text block's font
  select. It is inert on non-custom type presets, so this was hygiene, not a
  visible fix; this template now uses `var(--font-heading--family)`. The same
  stale value remains in 15 other templates and is deliberately out of scope
  here (candidate for a separate cleanup pass).

`sections/faq.liquid` moves onto the color-scheme system: the hardcoded
`text_color` / `border_color` settings are removed and the CSS reads
`var(--color-foreground)`, `var(--color-foreground-heading)`, and
`var(--color-border)` instead; a `color_scheme` setting (default `scheme-1`)
plus a scheme-classed wrapper div (which also carries
`section.shopify_attributes`) give both instances an explicit color contract;
the title uses `var(--font-heading--family)`; max-width widens from 600px to
720px. `highlight_color` deliberately stays a hex picker: the deep-link flash
is a semantic highlight (yellow on every scheme), not a scheme color. This
supersedes the stage-2a claim below that the FAQ style block sets its colours
explicitly; colour now comes from scheme variables.

### Ordering

The stage-2a/2b entries below record that Shopify validates a JSON template
against the section schema already stored on the theme, which forced that pair
to deploy in two stages. This change avoids the hazard instead of re-testing
it: neither `page.faq.json` nor `page.custom-orders.json` sets the new
`color_scheme` setting, so no template references a setting the live schema
does not know, and the schema default carries the value. Single-stage deploy
is safe in both directions (the removed `text_color` / `border_color` values
are cleaned out of both templates in the same commit, and unknown instance
settings are ignored at render anyway).

### Rollback

`git revert` plus deploy, as one unit. The removed color settings come back
with their old stored values on revert since the template cleanup is in the
same commit.

## Vacation mode: one admin toggle, four storefront surfaces (unreleased)

### What changed

A new "Vacation Mode" theme-settings group (checkbox `vacation_mode_enabled`,
default off) drives four surfaces at once, so the operator can flip the whole
feature from the theme editor on the sync theme with no hand-authored PR:

- **Announcement bar**: a new `blocks/_vacation-announcement.liquid` slide,
  registered in `sections/header-announcements.liquid` and added to
  `sections/header-group.json` as `vacation_announcement_001`. Dormant blocks
  render nothing, so the entry stays in the group JSON permanently.
- **Popup**: `snippets/vacation-popup.liquid` + `assets/vacation-popup.js`,
  rendered from `layout/theme.liquid`, auto-opens once per browsing session
  (sessionStorage key `vacation-popup:seen`, fail-closed when storage is
  blocked, never auto-opens in the theme editor). No light dismiss: a
  capture-phase guard stops `DialogComponent`'s outside-click close, so the
  popup closes only via the dismiss button, the X, or Esc (kept per the modal
  pattern in docs/accessibility-patterns.md).
- **Product-page checkbox**: `blocks/vacation-acknowledgment.liquid` +
  `assets/vacation-acknowledgment.js`, a trimmed clone of the return-policy
  acknowledgment (no variant-change untick; text from global settings since
  blocks cannot read each other's settings). Records a line-item property
  named by `vacation_property_label` whose value embeds
  `vacation_processing_date` ("Yes - processing begins after August 15"), so
  each order records the exact date the customer acknowledged; a blank date
  degrades to plain "Yes". Added as `vacation_ack_001` to all five garment
  product templates.
- **Shipping line**: `snippets/shipping-info.liquid` appends the
  `vacation_shipping_message` note in all three of its output branches (gift
  card, qualifies-for-free, does-not-qualify), which surfaces on the product
  page and directly above the cart's checkout button.

### Operating constraints (the sync traps)

- **Four independently dated settings must be updated together** before each
  enable: popup body, checkbox terms, shipping note, and `vacation_processing_date`
  (the announcement default carries no date). The settings-group paragraph
  enumerates them; nothing reconciles them. `vacation_processing_date` matters
  most: it is the date recorded on orders.
- **The FAQ deep link is a repo-side contract**: the announcement slide links
  (and the popup-body / checkbox-terms defaults link) to
  `/pages/faq#away-from-studio`, which exists only while `faq_item_vacation`
  in `templates/page.faq.json` keeps `custom_anchor: "away-from-studio"`.
  Nothing validates the fragment; a removed or re-anchored FAQ entry turns
  every vacation link into a scroll-to-top.
- **Do not rename `vacation_property_label` mid-vacation**: the value is the
  line-item property key, so renaming splits the acknowledgment across orders.
- **The gift-card template deliberately has no vacation checkbox**: nothing
  ships, so there is nothing to delay. The popup, the announcement and the gift
  card's own delivery line still appear. That line said "Free shipping" when
  this was written; it now reads "Delivered by email • No shipping" (the
  `content.gift_card_delivery` locale key), and the
  vacation note still appends to it. See the gift-card entry at the top of this
  file.
- **Settings-group labels are deliberately literal English**, not `t:` keys,
  matching the custom "Shipping Information" settings precedent: operator-only
  UI, and the storefront-visible strings are all operator-editable settings
  anyway.

### Announcement bar: first-visible replaces index-0

The stock `_announcement.liquid` hardcoded `aria-hidden="false"` only for
block index 0, which was correct while every block always rendered. A dormant
vacation slide (or a blanked announcement) at index 0 would have started every
slide hidden, blanking the bar until JS hydrates, and the editor rewrites
`block_order` freely, so "keep the vacation block last" was not an invariant
worth documenting. Instead `snippets/announcement-visible-blocks.liquid`
computes the first block that actually renders, and both announcement block
types compare against that. Block order is now cosmetically free. The same
snippet's `output: 'count'` mode replaces the section's `section.blocks.size`
gates, so one real announcement plus a dormant vacation block does not render
dead carousel controls (a headless-review catch).

### Express checkout now has two composing gates

`blocks/vacation-acknowledgment.liquid` adds a second fail-closed `:has()`
rule hiding `[ref='acceleratedCheckoutButtonContainer']` while its checkbox is
unticked. It composes with the return-policy gate: the container shows only
when neither acknowledgment is pending. This supersedes the earlier
release-note claim that Shift Fuel is "the only product showing express
checkout" and that the ref has a single dependent: with vacation mode enabled,
Shift Fuel's express checkout is gated too (by the vacation checkbox alone,
since it still has no return-policy block), and the ref now has two CSS
dependents, both documented in `blocks/accelerated-checkout.liquid`.

### Accepted enforcement gap

The acknowledgment checkbox covers product-page checkout only. The cart page's
checkout button (and items added before the toggle was enabled) can complete
checkout without the recorded acknowledgment; the announcement, popup, and the
vacation note on the cart's shipping line are the mitigations. A cart-level
gate is deliberately out of scope unless bypass orders become a real dispute
problem.

## SEO: reset the default page template to stock (unreleased)

Stage 4b, and the highest-risk change in the SEO remediation. It is the only one
that can blank a live page.

### What changed

`templates/page.json` is restored to **Horizon's actual upstream stock
template**, taken verbatim from the `Horizon v3.0.0` import commit: `main`
enabled, carrying a `text` block that renders `<h1>{{ closest.page.title }}</h1>`
and a `page-content` block that renders the page body. The `_blocks` section and
its `order` entry are gone.

### The first attempt at this was wrong, and preview caught it

Worth recording, because the failure was silent and would have shipped. The
first draft removed `_blocks` and left `main` with settings but **no blocks**,
on the assumption that `main-page` renders `page.content` itself. It does not:
`sections/main-page.liquid` renders `{% content_for 'blocks' %}` and nothing
else, so a blockless `main` renders an empty section.

On the preview theme that produced a `/pages/data-sharing-opt-out` with **zero
`<h1>`** and 286 characters inside `<main>`, essentially all of it breadcrumb
and JSON-LD. The page body was gone. That is precisely the "turns wrong content
into no content" outcome the staging was designed to prevent, and neither
theme-check nor `validate` flags it, because the template is perfectly valid
JSON referencing a real section.

### Why

The default page template was not a default. It hardcoded About's content, so
every page assigned to it rendered About's hero, mission, values, story, and
team blocks instead of its own body. `/pages/data-sharing-opt-out` has been
serving About's content, complete with an "About Sapphire Shadow Studio" H1.

### Preconditions, both verified before this was written

1. `templates/page.about.json` is live (stage 4a, deployed).
2. The About page is assigned to the `about` template in Admin. Confirmed
   through the Admin API rather than by eye: `pages(first: 50)` reports
   `templateSuffix: "about"` for handle `about`.

Order matters. Deploying this before that assignment would have blanked
`/pages/about` on the live storefront.

### Every page was enumerated, not sampled

The plan called for an exhaustive Admin enumeration because an empty body would
turn *wrong content* into *no content*, which is worse. There are five pages:

| Handle | Template | Body |
|---|---|---|
| `data-sharing-opt-out` | (default) | 2602 chars |
| `about` | `about` | 0 |
| `contact` | `contact` | 0 |
| `custom-orders` | `custom-orders` | 0 |
| `faq` | `faq` | 0 |

Exactly one page uses the default template, and it has real body content, so
this change gives that page its own content back rather than blanking anything.
The four zero-length bodies are all on templates that disable `main` and compose
from sections, which is what makes an empty Admin body correct for them.

### The smoke test does not cover this

`.github/actions/shopify-theme-push/smoke.mjs` probes published **products**
from the sitemap. It reaches no page templates at all, so a regression here
deploys green. Verify `/pages/about` and `/pages/data-sharing-opt-out` by hand
after deploy.

### Rollback

`git revert` plus deploy. `blocks/ai_gen_block_23c928c.liquid` is never deleted,
so the block type still exists and the reverted template renders as before.

## SEO: add a dedicated About page template (unreleased)

Stage 4a, the first half of a change that needs an Admin step in the middle.

### What changed

New `templates/page.about.json`, a **byte-for-byte copy** of the current
`templates/page.json`, preserving section key `176956306257ea4668` and block key
`ai_gen_block_23c928c_UaLftP`. `templates/page.json` is untouched.

### Why

The default `page` template is not a default at all today: it hardcodes the
About page's content. Every page on the default template therefore renders
About's hero, mission, values, story, and team blocks instead of its own body.
`/pages/data-sharing-opt-out` shows About's content right now.

Splitting the About content into its own template is the precondition for
resetting `page.json` to stock, which is stage 4b.

### After this deploys

Both templates render About and nothing changes on the storefront.
`/pages/about` is unchanged; `/pages/data-sharing-opt-out` is still wrong, as it
already was. That is the intended no-op.

### Rollback stops being simple after the Admin step

Revertable in isolation right now. It stops being independently revertable the
moment the About page is assigned to the `about` template in Admin: reverting
then would strand a live page pointing at a template the theme no longer has.
To roll back after assignment, un-assign in Admin **first**, then revert.

## SEO: breadcrumbs (unreleased)

Stage 3 of the SEO remediation, and independent of the FAQ pair below. The
storefront had no breadcrumb trail and no `BreadcrumbList` markup on any page.

### What changed

New `snippets/breadcrumbs.liquid`, rendered from `layout/theme.liquid` as the
first child of `<main>`. It emits the visible `<nav>` and its `BreadcrumbList`
JSON-LD **from one trail computation**, which is the whole point of the single
snippet: the markup and the structured data cannot drift apart.

Not rendered from `layout/password.liquid`.

### Design points that are load-bearing

**Page types are an allow-list, not a deny-list**: `product`, `collection`,
`page`, `article`, `blog`, `list-collections`. A page type Shopify adds later
therefore defaults to no breadcrumb rather than to a guessed trail.

**`policy` is deliberately excluded.** "Home > Policies > Refund policy" invents
an intermediate level with no page behind it, and Google expects breadcrumbs to
reflect a hierarchy the user can actually navigate. A two-item
"Home > Refund policy" is not worth the markup. The same test keeps
`list-collections` in: `/collections` is a real page.

**The last `ListItem` omits `item`.** Spec-legal, and it sidesteps a real trap:
on a collection-scoped product URL `product.url` returns
`/collections/x/products/y` while `canonical_url` returns `/products/y`.
Emitting either would risk contradicting the page's own canonical. The visible
last crumb is still a link, per the accessibility contract.

**The trail is carried as two delimiter-joined strings**, not arrays, because
Liquid cannot append to an array. Home is always first, so every later entry
appends the delimiter unconditionally and there is no leading-empty-element
edge case.

**Product parent collection is chosen by an explicit preference list.** Three
steps: the collection the shopper actually browsed through when the URL is
collection-scoped, else the first hit in a hand-maintained preferred-handle list
(`healthcare`, `the-vitals-collection`, `featured`), else any collection that is
not a catch-all.

The first draft of this snippet simply took the first entry in
`product.collections` that was not `all` or `frontpage`, and preview
verification caught what that produces: `all-products` is a **real** collection
in this store, not one of Shopify's virtual ones, and it sorts first. So every
**canonical** product URL rendered "Home > All Products > Lead II Crewneck",
while only the collection-scoped URL got "Home > Healthcare > ...". The
canonical URL is the one Google indexes, so the breadcrumb it would have shown
was the least informative of the four available, which throws away most of the
reason to emit the markup. `all-products` is now excluded alongside `all` and
`frontpage`.

The tradeoff moved rather than vanished. Ordering is now deterministic, but the
preferred list is hardcoded and hand-maintained: **a handle that no longer
exists is skipped silently**, with no error, so renaming or removing a
collection degrades the trail without failing anything. Nothing in CI checks it.
A `custom.breadcrumb_collection` metafield remains the fix that needs no
maintenance; it is recorded in `TODO.md`.

### Accessibility

Matches the breadcrumb contract in `docs/accessibility-patterns.md`: `<nav>` with
`aria-label` wrapping an `<ol>`, and the current page **is** a link carrying
`aria-current="page"`.

The separator is drawn as a rotated CSS border chevron, never `content: '/'`,
which several screen readers announce as "slash" on every crumb. A
`[dir='rtl']` rule flips it.

Links get `padding-block` with an equal negative `margin-block`, so they reach a
usable touch-target height without changing the visual density.

**Honest tradeoff:** putting the breadcrumb inside `<main>` is the correct
placement, but it means skip-link users tab through the breadcrumb links before
reaching content. That is the normal cost of correct placement, not a benefit.

### `#MainContent` was missing `tabindex="-1"`

Found while verifying the skip-link interaction, and fixed here in both
`layout/theme.liquid` and `layout/password.liquid`. It is a precondition for
this change rather than a drive-by: without it the skip link scrolls the page
but focus stays on the link, so the next Tab goes back into the header instead
of into the breadcrumb and content. The repo's global accessibility rules
already required it. A comment on the attribute says why, so it does not get
tidied away.

### Locale strings

Three storefront-visible keys: `accessibility.breadcrumb`,
`content.breadcrumb_home`, `content.breadcrumb_collections`. Added to
`locales/en.default.json` with real values and mirrored into all 30 other
locale files with `TODO:` placeholders, per the existing convention. That is
why this is a 31-file diff for three strings, and why it shipped as its own PR.

The locale files were edited byte-wise rather than through a JSON round trip.
They use CRLF, and they carry a `/* */` header plus `//` comments, so `json.load`
fails on them and a naive read/write rewrites every line ending into a
several-thousand-line diff. Insertions were anchored on the top-level block
opening line, because key names repeat across blocks in these files and a
first-match search lands in the wrong one.

## SEO: FAQ template opts into an H1 (unreleased)

Stage 2b, and the other half of the pair described in the entry below. Stage 2a
added the `title_heading_tag` select to `sections/faq.liquid` with a default of
H2, which made it a deliberate no-op. This change is what actually gives
`/pages/faq` a top-level heading.

### What changed

`templates/page.faq.json` sets `"title_heading_tag": "h1"` on
`sections.faq_section.settings`. That is the whole diff. The FAQ title now
renders as the page's `<h1>`, resolving the zero-H1 finding on `/pages/faq`.

`templates/page.custom-orders.json` is deliberately left alone. It omits the key,
takes the H2 default, and keeps the H1 it already has in its hero.

### Ordering

Stage 2a is already deployed to live, which is the precondition for this push.
Shopify validates a JSON template server-side against the section schema stored
on the theme and rejects the whole asset if a setting is unknown, so the reverse
order would have failed the deploy. The setting `id` was also confirmed wired
end to end in the theme editor on the preview theme before this was written.

Rollback is `git revert` plus deploy, but not in isolation: reverting 2a while
this is live leaves the template referencing an unknown setting. Revert both
together.

### Out of scope

Everything else in the SEO remediation: breadcrumbs, the page-template split, and
all Admin-side work (meta descriptions, collection descriptions, SEO titles,
contact copy, variant SKUs). The theme diff is not the complete remediation.

## SEO: FAQ page heading and FAQPage markup (unreleased)

Stage 2a of the SEO remediation. `/pages/faq` had **no `<h1>` at all**: the FAQ
section hardcoded an `<h2>`, and the page's template disables `main`, so nothing
else supplied a top-level heading.

### What changed

`sections/faq.liquid` gains a `title_heading_tag` select (H1 / H2, **default
H2**) on the section schema, and renders the title with the chosen tag. The
default is deliberately H2, so this change alone is a no-op: every existing
placement keeps rendering exactly what it rendered before, and only a template
that opts in gets an H1.

Editing this `{% schema %}` by hand is allowed here. Nothing in `scripts/`
generates `sections/faq.liquid`; the "never edit schema directly" rule applies to
generated schemas such as the size-chart output.

The label is plain English rather than a `t:` key, matching the twelve labels
already in this file. Theme-check has no rule requiring `t:` keys on schema
labels, so this is consistent rather than a shortcut.

No CSS change was needed. The title is selected by class, and the section's
`{% style %}` block sets font-size, colour, alignment, margin, and weight
explicitly, so swapping the element is a visual no-op.

`FAQPage` JSON-LD is now emitted from the section's own `faq_item` blocks, only
when the section has blocks.

### Deployment ordering, not optional

**This must be deployed before the template change (2b) is pushed.** Shopify
validates a JSON template server-side against the section schema *already stored
on the theme* and rejects the entire asset if a setting is unknown. Pushing a
template that sets `title_heading_tag` before this section is live gets the
template rejected wholesale. Merging is not enough; it has to be deployed.

The same coupling runs backwards: once 2b is live, reverting this alone makes
`templates/page.faq.json` reference an unknown setting. Revert both together.

### On FAQPage's actual value

Close to zero, and it is worth saying so plainly so nobody restores it later
expecting more. FAQ rich results were deprecated on 2025-05-08 and **removed
outright on 2026-05-07** for all sites, including government and health, with
Rich Results Test and Search Console support withdrawn alongside. `FAQPage`
remains valid schema.org and is emitted for entity and LLM comprehension only.
Expect no SERP effect, and do not validate it in Rich Results Test, which no
longer recognises the type.

### Why the array is built with a leading-comma flag

The obvious `{%- unless forloop.last -%},{%- endunless -%}` is wrong here, and
subtly so. Blocks with a blank question or answer are skipped, so if the *last*
block is skipped the previous one still emits its separator and the array closes
on a trailing comma. That invalidates the entire JSON-LD node, and browsers
surface no parse error for it. The loop therefore tracks whether anything has
been emitted and writes the comma *before* each subsequent entry.

## SEO: Organization and WebSite structured data, header cleanup (unreleased)

A full SEO crawl of the storefront (25 URLs, all sitemaps, cross-checked against
the Admin API) found one content bug, four code defects, missing metadata, and
three absent structured-data types. The store is password-protected pre-launch,
so nothing is indexed and there is no ranking damage to undo. That is what makes
this cheap now: every fix lands before Google ever crawls the site.

This entry covers the first repo change. The rest of the remediation ships as
separate PRs (FAQ heading, breadcrumbs, page templates) and as Admin-side work.

### What changed

**Structured data moved out of the header and into snippets.** A new
`snippets/structured-data.liquid` router renders from `layout/theme.liquid`, in
the head, right after `meta-tags`. It currently emits Organization and WebSite,
and only on the homepage. Two design points are load-bearing:

- **The `@id` and `url` derive from `shop.url`, not `request.origin`.** On a
  preview theme or the `*.myshopify.com` host, `request.origin` differs, which
  would mint a second identifier for what is supposed to be one entity.
- **The Organization node deliberately omits `address`, `telephone`, and email,**
  and the snippet doc block says so. This repo is public and the operation is
  home-based. Organization markup is exactly the shape that invites a later
  contributor to "complete" the node with a postal address; the doc block is
  there to stop that.

The node it replaced, in `sections/header.liquid`, rendered on every page and set
`url` to `request.origin | append: page.url`, so every page claimed to be the
Organization's canonical URL.

**No `potentialAction` / `SearchAction` on the WebSite node.** Google deprecated
the sitelinks search box on 2024-10-21 and retired it globally on 2024-11-21. The
WebSite node is kept only as the graph anchor that `publisher` points at, and for
non-Google consumers. Do not add `SearchAction` back expecting a search box.

**The homepage was shipping two `<h1>` elements.** `sections/header.liquid` had an
`index`-guarded visually-hidden `<h1>{{ shop.name }}</h1>`, while the hero lockup
in `templates/index.json` (section `hero_jVaWmY`, block `headline_lockup`) emits a
real `<h1>`. The header one is gone and a comment names where the surviving
heading lives, because nothing in CI checks heading structure and the next person
to look will not otherwise know where the homepage H1 comes from.

**`og:image` was hardcoded to `http:`** in `snippets/meta-tags.liquid`, on both
layouts, while `og:image:secure_url` beside it was already `https:`.

**Theme-level social link settings** now exist, and back the Organization
`sameAs` array. Blank settings are skipped and the array is omitted entirely when
all are blank, so a partially configured store cannot emit a trailing comma. That
matters more than it sounds: a trailing comma invalidates the whole JSON-LD node
and browsers surface no parse error for it.

**There is deliberately no `social_twitter_link` setting, and `twitter:site` is
gone.** This is the one place the settings addition would have changed behaviour
beyond structured data, so it is worth stating plainly. `snippets/meta-tags.liquid`
already read `settings.social_twitter_link` to emit `twitter:site`, against a
setting that had never existed in `settings_schema.json`. Simply defining the
setting would have reactivated that dead branch on every page, and the branch is
broken: it extracts the handle with `split: 'twitter.com/'`, which does not match
an `x.com` URL, so an X profile renders `content="@https://x.com/handle"` instead
of `@handle`. Naming the setting "X (Twitter)" would have invited exactly the URL
that breaks it. Both the setting and the tag are therefore out; a comment in
`meta-tags.liquid` records what a correct restoration needs.

**The `logo` ImageObject carries no `width` / `height`.** Deriving them requires
dividing by `settings.logo.aspect_ratio`, and an SVG can report that as zero or
nil. Liquid renders a divide-by-zero as an error string, which would land inside
the script tag and invalidate the node with no visible symptom. Google does not
require the dimensions, so they are omitted rather than guarded.

The footer's social URLs were placeholders pointing at platform home pages
(`https://www.facebook.com` and the like). Those are broken links for customers,
not only bad `sameAs` data, since a bare platform URL asserts that this
Organization *is* that platform. They now hold the real brand profiles, and the
two platforms with no profile are blank rather than pointing at a home page.

### Why the featured-product guards are a Horizon deviation

`sections/featured-product.liquid` and `sections/featured-product-information.liquid`
now wrap their `{{ section.settings.product | structured_data }}` output in an
`{%- if section.settings.product != blank -%}` guard. With no product selected the
filter renders nothing and the section shipped an empty, unparseable
`application/ld+json` block. Both files are upstream Horizon; keep the guards
through the next upstream merge.

### Out of scope

Product, collection, and page metadata live in Shopify Admin, not in this repo,
and are handled Admin-side: the quarter-zip and women's vest SEO descriptions
(both of which carried the crewneck's text verbatim and called the garment a
"crewneck sweatshirt"), the missing collection meta descriptions, collection body
descriptions, product SEO titles, and the homepage title and description. Reading
this diff as the whole remediation would be a mistake.

Also out of scope and tracked in `TODO.md`: return-policy structured data (blocked
by Shopify's `structured_data` filter not being extensible, not by policy
non-uniformity), `ItemList` markup on collections, and blog content.

> **Superseded.** The return-policy parenthetical above is wrong on the point it
> makes: the policy does vary per product, and that variation is the difficulty
> rather than a non-issue. See "Return policy on the Organization node" at the top
> of this file. `ItemList` shipped; see "ItemList markup on collection pages".

### Accepted risks, recorded so they are not rediscovered as bugs

- **`featured` and `healthcare` hold an identical set of five products** and both
  stay indexable. Their meta descriptions differ, but the product grid does not,
  so canonical selection between them is Google's coin flip. Reviewed and
  accepted rather than merged; revisit after launch with real Search Console data.
  > **Superseded.** This accept no longer stands. See "Collection differentiation
  > is a runbook, not a code change" at the top of this file.
- **The empty `/blogs/news` stays indexable.** A thin-content signal at launch on
  a small indexable surface, accepted deliberately.

## Product consistency pass: long-option dropdown + copy backports (unreleased)

A catalogue-wide audit compared all six products across three sources: Admin API data, the five committed `templates/product.*.json` files, and each rendered storefront page. The page architecture held up (identical block skeleton, identical accordion row order and headings, byte-identical Shipping & Turnaround copy). What it found was copy cloned from the crewneck and never updated for the garment it now describes, plus one layout problem.

### Long option lists now collapse to a dropdown

The Lead II products carry eight Design values, one per credential, and the list is expected to grow. Rendered as full-width buttons it pushed Color, Size, and Add to cart below the fold.

`blocks/variant-picker.liquid` already had a `variant_style` setting with a working `dropdowns` value, and `snippets/variant-main-picker.liquid` already had a complete dropdown branch. Nothing needed building. The blocker was that `variant_style` is a single **block-level** setting applied to every option at once, so switching it would have taken Color and Size with it. The decision had to become per-option.

`settings.variant_dropdown_threshold` (default 4, `0` disables) now collapses any option with at least that many values. The rule is value-count based rather than option-name based so that adding a design or a color needs no settings change.

**The rule has no exceptions, deliberately.** An earlier revision exempted the size option and let swatches take precedence. That was dropped: every option is measured the same way, so a customer never has to learn why Design collapses but Size does not. The override therefore runs last and is not gated on the current `variant_style`.

Two consequences to know before changing the threshold:

> **Later amended.** There was a third consequence, unknown when this shipped: collapsing an option
> to the select branch emits no fieldset, which broke the `data-fieldset-index` numbering the
> variant-picker JS depends on. See "Variant button index: fieldset numbering vs. option numbering"
> at the top of this file.

- **The size option collapses too**, once it has enough values (`XS`..`2XL` is six). The select branch renders the size-guide link itself, so `#SizeChart` survives the switch.
- **A swatch option past the threshold loses its swatches**, because the select branch renders plain text options and the theme has no swatch-inside-dropdown rendering. Not hit today: no color option has swatches configured, and at the default threshold of 4 a three-color product stays on buttons anyway.

The other half of the change is easy to miss and is what actually makes it render: the loop already computed a per-option `variant_style` local, but **both render branches tested `block_settings.variant_style` directly and ignored it**. Overriding the local alone changed nothing visible. Both conditions now read the per-option value.

Not fixed here, and still latent: `snippets/variant-main-picker.liquid` tests `block_settings.variant_style == 'dropdown'` (singular) against a schema whose only dropdown value is `dropdowns` (plural), so the `swatch_dropdown` style is unreachable dead code.

### Copy backports

Three drifts had been fixed on the two newest products (quarter-zip, vest) and never backported to the three older ones. All three were corrected in `product.lead-ii-crewneck.json`, `product.huddle-crewneck.json`, and `product.shift-fuel-crewneck.json`: the "Have questions **about the something?**" typo, `your shirt's tag` to `your garment's tag`, and a stray double space after "shortcuts.".

### Divergences confirmed intentional, recorded so they are not "fixed" later

The audit flagged these as inconsistencies. Each was reviewed and kept deliberately:

- **Shift Fuel returns.** It is the only product offering 14-day returns rather than final sale, because it carries no Design option and no custom text and is therefore resellable. Two consequences follow and must be preserved: it intentionally has no `return-policy-acknowledgment` block, and it is therefore intentionally the only product showing express checkout. The mechanism is non-obvious: the acknowledgment block hides express checkout with a CSS `:has()` rule in `blocks/return-policy-acknowledgment.liquid` targeting `[ref='acceleratedCheckoutButtonContainer']`, a cross-block dependency on that literal ref. *(Partially superseded by the vacation-mode entry above: the no-return-policy-block decision stands, but the ref now has a second CSS dependent, and while vacation mode is enabled Shift Fuel's express checkout is gated by the vacation checkbox.)*
- **Vest gallery.** The size-chart PNG and the studio logo SVG are intentional gallery media, which is why the vest shows four slides where its siblings show six or eight. They appear on every color because `snippets/product-media-gallery-content.liquid` treats media whose alt text names no color option value as shared.
- **Huddle Design values.** "Nurse" and "Vet Tech" deliberately do not follow Lead II's `ABBREV (Expansion)` form, and Huddle deliberately does not split LVT/RVT/CVT. The option values track what the applique artwork actually reads.

### Out of scope, tracked separately

Product descriptions live in Shopify Admin, not in this repo, so two factual errors the audit found (the quarter-zip and vest descriptions claiming the crewneck's "Premium 8 oz. heavyweight fleece", and all three Lead II descriptions advertising "optional" custom text against a field that is `required: true`) are corrected Admin-side and are not part of this change.

## Asset-rejection detection: a green deploy that changed nothing (unreleased)

### The incident

A homepage redesign never reached its preview theme across three separate CI runs, all of which reported green. The cause was one integer: a JSON template carried a range setting one below the `min` its section schema declared. Shopify validates a JSON template's settings server-side against the section schema **already stored on the theme** and rejects the entire asset when a value is out of range:

```
Asset upload failed for templates/index.json: Setting 'autoplay_speed' can't be less than 3
```

`shopify theme push` retried the upload, gave up, and **exited 0**. The error text was reachable only under `--verbose`, inside the analytics JSON blob under `cmd_theme_errors`. The template stayed frozen on its last version that validated, CI stayed green, and the post-deploy smoke stayed green too, because every probed page still rendered correctly from stale content. On the live path this would have reported a successful deploy, passed smoke, squash-merged, and left the storefront unchanged.

The schema floor itself was a one-line fix. The observability gap is what made a one-integer mistake invisible for three runs, and that is what this change addresses.

### What changed

- **`check-push-rejections.mjs`** (new, with `check-push-rejections.test.mjs` folded into `npm run smoke:test`) audits the push report after every push, live and preview alike. A rejection fails the step with **exit 97**, naming each rejected file and Shopify's reason as `::error file=...::` annotations plus a plain-text summary. A clean push prints nothing, so a good deploy is not made noisy.
- **`deploy.yml`** gains a failure-ladder branch for exit 97 that states plainly that live is **partially** updated: files that validated were written, the rejected ones were not.
- **`capture_push_output`** now takes `--rejections <file>` and appends the summary in full after the 30-line tail, instead of letting it compete for room inside that window. A 20-file rejection runs to roughly 40 lines and would otherwise push its own header out of the PR comment at exactly the moment an operator needs it. It also neutralises any captured line that is exactly the heredoc delimiter, so server-sourced text cannot close the block early and forge step outputs.

### Why the CLI's `--json` payload, not stderr

The detection signal is structured, not scraped. `@shopify/cli` 4.5.2's theme-push service sets, on the object it serialises to stdout, whenever any upload result has `success === false`:

```js
theme.warning = "The theme '<name>' was pushed with errors"
theme.errors  = { "<filename>": ["<reason>", ...] }
```

and then returns normally, which is precisely why the exit code is 0. Asserting on those two fields beats grepping human-readable stderr: it names both the file and the reason, needs no `--verbose`, and is a contract rather than a message format. The auditor treats `warning` present with `errors` absent as a rejection too, so a future CLI that drops one of the two fields degrades to a loud failure rather than a silent pass. An unparseable report is deliberately a distinct code (2) that leaves the existing `require_json` to own that diagnosis as exit 98, rather than being mislabelled a rejection.

### The batch-ordering defect, and why the fix is a retry

A schema change and a JSON template that depends on it fail when pushed in the same batch: the template is validated against the schema version already stored on the theme, not the one in the same upload. Pushing the section first and the template second succeeds; both together fail.

Two fixes were considered. An **explicit two-phase push** (non-JSON files first, then JSON templates) is deterministic and self-documenting, but it hardcodes an ordering rule the CLI does not guarantee and doubles the passes on every deploy, including clean ones. The chosen fix is a **single immediate retry** when a push exits 0 with rejected assets: the schema landed on the first pass, so the template validates on the second, and a value that is genuinely out of range still fails every attempt and stops the deploy. It needs no knowledge of which file types must precede which, and it costs nothing on a clean push. The retry skips the 60s backoff because a rejection is not a transient network condition.

In preview mode the retry is always addressed by **theme ID**, never by repeating `--unpublished`. Repeating the create flag would produce a second `pr-N-preview` theme, which the duplicate-name guard then refuses on every later run for that PR.

### A second defect, found by reproducing the first

The reproduction itself surfaced an unrelated latent bug. A composite step's default shell is `bash --noprofile --norc -e -o pipefail`, and the push step's `set -uo pipefail` does **not** clear that injected `-e`. Every failure path in the step captures an exit code and branches on it, which `-e` pre-empts: the shell exits on the failing command itself, before any capture, retry, or `GITHUB_OUTPUT` write.

The first CI reproduction attempt therefore died in 7 seconds with exit 1 and no captured output at all, instead of reporting what Shopify had refused. The same defect had silently disabled the live 3-attempt retry loop, where a failed first attempt killed the step rather than retrying, and left `push_exit_code` empty, which the caller's failure ladder reads as "step never ran". The step now sets `set +e` explicitly, with a comment saying why it must not be simplified away.

### Verification

Verified against a real rejection in CI, not a simulated one. A deliberately out-of-range `max_products` (99, against the section schema's `max: 16`) was pushed through the real preview workflow on the PR branch. The push exited 0, the audit caught it, the retry fired once and the rejection persisted, and the step failed with exit 97:

```
Shopify rejected 1 asset during theme push. The push command exited 0, but these files were NOT written to the theme.
Setting 'max_products' can't be greater than 16
Rejected assets (theme push exited 0; Shopify refused these files):
  templates/index.json: Setting 'max_products' can't be greater than 16
Push left rejected assets; retrying once against theme <id>
[...retry, same rejection...]
Process completed with exit code 97.
```

Reverting that one value returned both `preview` and `validate` to green, with zero rejection output in the log: the good path is not made noisy.

## Deploy-report messaging: docs-only close message + smoke markdown table (unreleased)

### What changed

The previous smoke-test redesign (below) shipped the `theme_touched` push-skip mechanic; this pass finishes the reporting UX on both branches of that gate.

- **Docs-only PRs** now get an explicit `:page_facing_up: **Docs-only PR.**` headline instead of the more implicit "Live push skipped" phrasing, plus two new rows: the live theme's current name/ID (queried read-only from Shopify) and the last commit actually deployed through this pipeline (read from a new git ref, see below). Both lookups are `continue-on-error`; a Shopify API hiccup can never block a docs-only merge from closing, which was the entire point of the original `theme_touched` gate.
- **`refs/deploy-markers/live`**: a lightweight custom ref (deliberately outside `refs/tags/` so it does not appear on the public repo's Tags page), force-moved to the squash-merge commit SHA whenever a real live deploy succeeds. Guarded by a commit-date comparison, not graph ancestry, before overwriting: squash commits are never ancestors of one another, so `compareCommits` ahead/behind does not hold across squashes, but commit date does. A write that would move the marker backward in time is skipped with a `core.warning` instead of applied.
- **Smoke output as a markdown table.** New pure module `.github/actions/shopify-theme-push/report-format.mjs` (`report-format.test.mjs`, folded into `npm run smoke:test`) parses `smoke.mjs`'s existing plain-text `path verdict status host theme (reason)` lines into a GitHub-rendered table with pass/warn/fail badges, on both the success report and, for a smoke-triggered failure, the failure report. `smoke.mjs` itself is untouched: this is a text-to-structure re-parse of its existing, hygiene-tested output contract, done in a separate file specifically so the parse can evolve without touching that contract's 50+ existing assertions. Both call sites wrap the render in try/catch and fall back to the original raw-fenced-dump on any import or render failure, so a formatting bug can never suppress the report itself (the failure report in particular is the last line of defense on a broken deploy).
- **Live theme ID drift check.** The docs-only "Query live theme" step now also captures the live theme's actual `.id`, not just its name, and the report flags a mismatch against the hardcoded `LIVE_THEME_ID` constant instead of silently pairing freshly-queried data with an unverified assumed ID.

### Post-merge verification and a follow-up fix

Two throwaway PRs (a whitespace-only doc change and a comment-only theme-asset change) were merged through the real `deploy` comment flow to exercise the code the "Known limitation" below flagged as untestable pre-merge. Both deploys succeeded; every mechanic behaved as designed (docs-only headline, ID-drift check with no false positive, marker `createRef` on the first-ever real deploy verified by SHA, smoke table rendered as a real GitHub table with correct pass/warn/fail counts).

One bug surfaced: the live-theme "last updated" field was always empty. Root cause, confirmed by reading the installed `@shopify/cli` package's own theme-object formatter: `theme list --json` returns only `{id, name, processing, createdAtRuntime, role}`; there is no `updated_at` field, and `createdAtRuntime` is a boolean session flag, not a timestamp. The claim was based on a wrong assumption about the CLI's JSON schema, not a transient API gap. Fix: dropped the "last updated" claim from the "Live theme (unchanged)" row entirely (`formatLiveThemeRow` now takes only name + ID); the git-side "Last live deploy" marker row remains the source of temporal information, which it can back with a real, previously-verified commit date. `continue-on-error: true` meant this was cosmetic (`unknown` shown, nothing blocked) rather than a deploy-blocking regression.

### Trust-boundary note

Rendering the smoke table via `report-format.mjs` means both `github-script` steps that build the sticky comment now dynamically `import()` a file living on the checked-out PR branch, inside the same process that holds this job's `contents:write`/`pull-requests:write` token. On the comment-deploy path specifically (which, unlike the shopify-sync and dependabot auto-deploy paths, has no gate blocking a `.github/`-touching diff), this is a real widening from the prior Shopify-token-only exposure. Accepted under this repo's existing documented threat model (a compromised `contents:write` collaborator can already exfiltrate any secret via a malicious workflow change; see CLAUDE.md's Deploy gate trust delta), not a categorically new hole, but called out explicitly here rather than silently, per `/security-review` finding during this change's review.

### Known limitation

`deploy.yml` triggers on `issue_comment` and `workflow_run`. GitHub resolves the *workflow file* for both event types from the default branch, never a PR head, so none of this was end-to-end testable via a real `deploy` comment on a feature branch pre-merge; the automated test suite plus code review were the actual pre-merge gate, and the first real activation was the first `deploy` comment after this merged to `main`.

## Deploy smoke-test redesign: node fetch, catalog-wide, locked-and-public (unreleased)

### Symptom

On PR #56 (docs-only) the live push succeeded but the post-push smoke reported `/ -> 503`, `/cart -> 503`, `/collections/all -> 503` and killed the deploy before squash-merge. It was not the docs change (Shopify ships only the 8 theme directories; `docs/` is never uploaded).

### Root cause (two independent edge layers)

Proven empirically against the live store (`scripts/diagnostics/storefront-probe-node.mjs`):

1. **Cloudflare bot-management** fingerprints the client by JA3/JA4 (TLS ClientHello + HTTP/2) on cacheable content routes (`/`, `/collections/*`, `/search`). `curl`'s fingerprint is blocklisted, yielding a hard `429` (`retry-after: 60`) on every content route, 100% of the time. The old smoke used `curl`, so it never saw a real page; the reported `503`/`429` were edge rejections, not theme errors. node's `fetch` (undici) is not blocklisted. node is not fully immune under a rapid burst (scattered 429s), so the smoke paces and retries on 429.
2. **Password gate** (pre-launch). Independent of the fingerprint. Cleared by an authenticated `_shopify_essential` session (POST the store password to `/password`, carry the whole cookie jar). Authenticated node fetch returns real `200` content while the store is locked; every rendered response carries `server-timing: ... theme;desc="<live-theme-id>"`.

### Fix

`.github/actions/shopify-theme-push/smoke.mjs` (new, zero-dep, `node --test` unit-tested and gated in `validate`) replaces the curl smoke:

- **node fetch**, auto-detects LOCKED vs PUBLIC, authenticates with the optional `STOREFRONT_PASSWORD` secret when locked, paces + retries on 429, and asserts `200` + on-host + `theme;desc == LIVE_THEME_ID`.
- **Catalog-wide.** Structural routes (`/ /cart /collections/all /search`) verify the deploy; every published product is enumerated from the sitemap and probed, so a broken product (including an unresolved template suffix) fails the deploy. No maintained handle list (handles are not in the theme repo).
- **Verdict model.** HARD-FAIL blocks (exit 1); SOFT-WARN (throttle, enumeration skipped, absent/wrong password) proceeds (exit 0) and is surfaced in the report; at least one verified PASS is required to exit 0 so a wholesale 429 wall cannot green a deploy blind. Output is `path verdict status host theme-id` tuples only; the password, cookie jar, and headers are never emitted (the derived session cookie is `::add-mask::`ed).
- **Path-scoped skip.** The `gate` job computes `theme_touched`; the push+smoke step is guarded on it, so a docs/scripts/`.github`-only PR merges and fast-forwards `shopify-sync` without touching live. Permanent fix for the #56 class. Rename-out of a theme dir is caught via `previous_filename`; file-listing errors fail safe to `true` (push).
- **Launch.** Delete `STOREFRONT_PASSWORD` at public launch; auto-detect flips to PUBLIC mode with no code change.

Deferred: Shopify Web Bot Auth (native crawler allowlist) would let even curl through, but its signatures expire within 3 months with no auto-renew; reconsider for post-launch uptime monitoring, not the CI primary.

## CI/CD deploy chain: shopify-sync phantom-orphan force-push via SSH deploy key (unreleased)

PR #21 was the first post-PR-#19 exercise of the auto-deploy chain. It surfaced that the post-merge `Sync main -> shopify-sync` step's phantom-orphan force-with-lease push silently fails on every shopify-sync auto-deploy. The fix swaps that single push from HTTPS+GITHUB_TOKEN to SSH+deploy-key, and folds the step into a new `sync` job to isolate the deploy key from `SHOPIFY_CLI_THEME_TOKEN`. The fast-forward push and the read-only fetch in the same step both stay on HTTPS+GITHUB_TOKEN, since a strict fast-forward to a tip-descendant is not a force push and the `shopify-sync-protection` ruleset's "Block force pushes" rule does not apply.

### Bug and evidence

The `shopify-sync` branch is protected by ruleset `shopify-sync-protection` (ID 16111276) with **Block force pushes** active. The phantom-orphan cleanup arm of the post-merge Sync step force-pushes `shopify-sync` to the deployed SHA (rewriting history to abandon the orphan commits that the just-merged auto-reconcile PR squashed into main). Under HTTPS+GITHUB_TOKEN this push fails with:

```
remote: error: GH013: Repository rule violations found for refs/heads/shopify-sync.
remote: - Cannot force-push to this branch because: Cannot force-push to this branch
```

Empirically confirmed on workflow run 25704994159 (PR #21). The rejection is not transient and not racy; it is structural. The reason it cannot be fixed by adding `Repository role: Admin` to the ruleset's bypass-actors list is that `GITHUB_TOKEN`'s identity `github-actions[bot]` is a synthetic per-workflow identity with no role membership; the GitHub ruleset evaluator's role-based bypass entries (Repository roles, Organization admin) only match identities that hold those roles. Only explicit-actor bypass entries (Deploy keys, Apps, Users) match identities directly.

### Fix

Deploy keys are addable as bypass actors via the ruleset bypass-add modal ("Deploy keys - Role"). A repo-scoped Ed25519 deploy key (`SHOPIFY_SYNC_DEPLOY_KEY` repo secret + matching public key on the deploy-keys page with "Allow write access") is placed on the `shopify-sync-protection` ruleset's bypass list, and the phantom-orphan push switches to SSH using that key.

Workflow structure changes in `deploy.yml`:

- **Sync step extracted into a new `sync` job.** The post-merge Sync moved from being the last step of the `deploy` job to a top-level `sync` job that `needs: deploy`. Rationale: the existing `gate`/`deploy` split establishes "a bug in any step's bash cannot leak a secret because the secret structurally does not exist in this job's scope." Adding `SHOPIFY_SYNC_DEPLOY_KEY` to the `deploy` job would create a defence-in-depth weakness (two secrets in one bash block, exfilable together by a future `set -x` regression). The new `sync` job has `permissions: contents: write` only and zero `SHOPIFY_CLI_THEME_TOKEN` references. The `GH_TOKEN: ${{ github.token }}` binding moves out of the `deploy:` job's env block (no remaining consumer there) and into the new `sync:` job's env (used for the read-only fetch and the fast-forward push, both of which stay on HTTPS).
- **`Validate sync preconditions` step** is a dedicated empty-secret guard in the `sync` job, with no `continue-on-error`. A missing `SHOPIFY_SYNC_DEPLOY_KEY` halts the job visibly red instead of being swallowed by the next step's `continue-on-error: true`. Mirrors `sync.yml`'s `SYNC_RECONCILE_TOKEN` empty-PAT guard in both text and step-failure semantics.
- **SSH setup in the Sync step.** `umask 077` closes the `mktemp` 0600-mode race window across runner profiles; `mktemp -t` produces a templated tempfile path; per-line `::add-mask::` registration of each line of the secret value as defence in depth against a future `set -x` regression (multi-line PEM bodies may not be reliably auto-masked); `tr -d '\r'` line-ending normalisation before writing the key, so a secret pasted with Windows CRLF endings still loads; `unset` of the secret env var after the on-disk write shrinks the shell-env exposure window; `ssh-keyscan -t ed25519,ecdsa github.com` populates known_hosts (RSA omitted because OpenSSH 8+ prefers Ed25519/ECDSA and including RSA only couples the workflow to a future GitHub RSA-key rotation event); `GIT_SSH_COMMAND` is exported with `IdentitiesOnly=yes` + `PreferredAuthentications=publickey` + `BatchMode=yes` + `StrictHostKeyChecking=yes` + `LogLevel=ERROR`; tempfile cleanup `trap` is registered BEFORE `mktemp` runs (with empty-string fallback variables) so a partial-write or ssh-keyscan failure still cleans up.
- **Push call-site changes.** Only the phantom-orphan force-with-lease push switches to SSH. The fast-forward push and the read-only fetch stay on HTTPS+GITHUB_TOKEN. The SSH push URL is derived from `${{ github.repository }}` so an org/repo rename does not silently leave a stale hardcoded URL behind.
- **Multi-pattern stderr classifier.** Push-failure stderr is now run through two grep patterns. `Permission denied (publickey)` / `Load key .*: invalid format` / `Load key .*: bad permissions` / `Host key verification failed` re-emits a "SHOPIFY_SYNC_DEPLOY_KEY appears invalid" hint. `GH013` / `Cannot force-push to this branch` (the bypass-row-removed case) re-emits a "Push rejected by branch ruleset" hint. The raw stderr line still prints either way.

### Alternatives considered

- **Expand bypass to a PAT.** Rejected. Couples bypass authority to the operator's admin status; trust regression spreads to the PAT-create surface.
- **`actions/create-github-app-token` with a minimal install-only app.** Rejected. The short-lived-token and granular-permission properties are real, but the PEM rotation has the same operator-account-coupling problem as a PAT, and setup cost is still strictly larger than a deploy key for a solo-dev repo.
- **Switch to a long-lived custom GitHub App.** Rejected. Over-engineered for a single solo-dev bypass use case.
- **Disable the "Block force pushes" rule.** Rejected. The rule also blocks accidental admin-side rewrites of `shopify-sync`; the operator wants to keep the protection on.
- **Replace force-push with a `--strategy=ours` merge-commit reconcile (no bypass needed).** Rejected. Produces a tangled `shopify-sync` history of merge commits; merge-commit author is `github-actions[bot]` not `shopify[bot]`, complicating any future identity-based assertion downstream.
- **Accept silent failure; rely on `sync.yml`'s reconcile flow and daily cron to clean up.** Rejected. Partially defensible (the post-PR-#18 hardening blocks the latent-bug incident class), but a chain that silently fails on every deploy is hard to monitor and accumulates drift between admin-edit cycles.

### Trust delta

The deploy-key credential has full repo push capability across all refs (deploy keys are repo-scoped by GitHub design). Its **bypass effect** on the `shopify-sync-protection` ruleset is scoped to that one ruleset's "Deploy keys" bypass-actor row; the row must NOT be added to any ruleset protecting `main` or any other branch. Bypass authority is decoupled from any human role membership. The four computed auto-deploy gates (collaborator-permission, validate-on-HEAD-SHA, signed-commit, defence-in-depth merge-base assertion) remain the actual integrity boundary on what content auto-deploys; the SSH push only changes *transport* for an already-validated payload. A compromised collaborator with `contents: write` could exfiltrate the deploy key via a workflow change and force-push `shopify-sync` content, but this is bounded by the same all-bets-are-off threshold the existing trust model already accepts. The new `sync` job has no `SHOPIFY_CLI_THEME_TOKEN` in scope, so the deploy-key surface and the Shopify-token surface are isolated by job boundary.

### Operator action (post-merge)

None for the chain itself. The next admin commit on the unpublished sync theme will auto-exercise the new path. Three one-time tasks accompany this change (operator handles in parallel with the PR):

1. Generate the keypair locally, add the public key to `/settings/keys` with "Allow write access", store the private key in repo secret `SHOPIFY_SYNC_DEPLOY_KEY`, add a `Deploy keys` bypass-actor row to ruleset `shopify-sync-protection` (ID 16111276), securely delete the local key files. (See CLAUDE.md "Token rotation call-site catalog" entry for the full procedure.)
2. Bring `shopify-sync` to byte-for-byte parity with `main`, since PR #21's failed Sync left it in a 1-ahead/1-behind state. The recovery snippet uses operator admin bypass (independent of the new deploy-key bypass):

   ```bash
   git fetch origin
   MAIN_SHA=$(git rev-parse origin/main)
   LEASE_SHA=$(git rev-parse origin/shopify-sync)
   if [ "$LEASE_SHA" = "$MAIN_SHA" ]; then
     echo "Already in sync; nothing to do."
     exit 0
   fi
   git push --force-with-lease=shopify-sync:"$LEASE_SHA" origin "$MAIN_SHA":shopify-sync
   git fetch origin shopify-sync
   [ "$(git rev-parse origin/shopify-sync)" = "$MAIN_SHA" ] || { echo "MISMATCH"; exit 1; }
   ```
3. After the chain is exercised once successfully, `gh api /repos/Perts-Foundry/sapphire-shadow-studio-theme/compare/shopify-sync...main --jq '{status, ahead_by, behind_by}'` returns `{"status":"identical","ahead_by":0,"behind_by":0}`.

If this change is ever reverted: also remove the public key from `/settings/keys` and remove the bypass-actor row from `shopify-sync-protection` to avoid orphaned authority.

## CI/CD deploy chain: sync.yml PAT switch and latent main-has-advanced hardening (unreleased)

PR #17 was the first end-to-end exercise of the consolidated `deploy.yml`'s shopify-sync auto-deploy path. It surfaced a real and previously unobserved bug: `sync.yml`'s `gh pr create` runs under `GITHUB_TOKEN`, and GitHub's documented automatic-token rule (https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication) suppresses downstream workflow_run events from GITHUB_TOKEN-driven actions. validate.yml never fired on the auto-reconcile PR. The fix is a fine-grained PAT scoped narrowly; this PR also folds in a latent-bug discovery and matching two-layer hardening.

### Bug A: validate.yml never fires on auto-reconcile PRs

`sync.yml`'s "Open or refresh reconcile PR" step calls `gh pr create` under the job-level `GH_TOKEN: ${{ github.token }}`. Per GitHub's documented automatic-token rule, events triggered by GITHUB_TOKEN do not cascade into downstream workflow runs. The PR opens silently, no `pull_request:opened` event reaches the events bus, validate.yml is not triggered, and the shopify-sync auto-deploy chain stalls. Empirically confirmed on PR #17: the PR was opened by sync.yml at 2026-05-11 20:41:50Z; the only Validate run on shopify-sync (databaseId 25697345816) was created at 2026-05-11 21:06:18Z, ~25 minutes later, as a result of a manual close+reopen via personal gh credentials.

**FIXED**: introduced a new fine-grained PAT (`SYNC_RECONCILE_TOKEN`, resource owner `Perts-Foundry` org, scoped to `pull_requests: write` + `contents: read` + `metadata: read` on this single repo). sync.yml's `gh pr create` runs under the PAT via an inline `GH_TOKEN="$SYNC_RECONCILE_TOKEN"` override; every other call site stays on GITHUB_TOKEN. `gh pr edit` deliberately keeps GITHUB_TOKEN because `pull_request:edited` is not in validate.yml's trigger set (suppression is harmless there), to minimise PAT-attributed audit-log volume, and to preserve a clean `github-actions[bot]` timeline so any human-attributed action on the PR is a genuine investigation signal. deploy.yml's `pulls.merge` and the post-merge Sync step's git push also stay on GITHUB_TOKEN: the suppression of the merge-commit push to main is intentional (re-running validate against main on every deploy would loop), and the shopify-sync fast-forward push uses HTTP Basic with GITHUB_TOKEN by design.

The PAT call site is wrapped in two fail-closed guards: an empty-PAT check that fires a clear `::error::` if the secret is unset, and a stderr-capture wrapper around `gh pr create` that re-emits a "PAT appears invalid" hint when the gh CLI returns 401/403/404 (revoked, expired, or scope-mismatched). Both surface explicit pointers to CLAUDE.md's "Token rotation call-site catalog."

### Bug A.1: downstream PR-opener gate now expects the PAT-owner identity

After the PAT switch, `pr.user.login` on the auto-reconcile PR is the PAT owner's GitHub account, not `github-actions[bot]`. deploy.yml's shopify-sync gate previously hardcoded `expectedPrBot = 'github-actions[bot]'`. Without a corresponding update, every PAT-opened reconcile PR would pass Validate, then fail the PR-opener-identity gate and post a sticky "Auto-deploy skipped" with a misleading reason.

**FIXED**: renamed `expectedPrBot` to `expectedPrOpener`, source value from a new `vars.EXPECTED_SYNC_PR_OPENER` repository variable (plaintext is fine: the login is already public surface). Added EXPECTED_SYNC_PR_OPENER to the step's env block. Added a JS-side empty guard that fails closed via postSkip if the variable is unset. Preserved the `pr.user?.login` optional chaining and added a comment so a future maintainer doesn't "fix" it to non-optional access (deleted-account responses can produce undefined; the comparison fails closed against that).

### Trust-model regression with mitigation chain

The PR-opener gate's expected value moves from a GitHub-Actions runtime identity (`github-actions[bot]`, essentially unimpersonable from outside a workflow execution context) to a human GitHub login (PAT-exfiltrable). The new attack surface and the mitigations:

1. **Attack:** PAT exfiltration enables hand-opening a `shopify-sync → main` PR with a stale-but-signed `shopify[bot]` HEAD (replay an old `shopify[bot]` commit as a fresh deploy).
2. **Block 1, commit-identity gate (unchanged):** the HEAD commit must be `author=shopify[bot]` AND `verification.verified`. An attacker can only PR commits `shopify[bot]` genuinely authored at some point in history; no novel content injection is possible.
3. **Block 2, defence-in-depth merge-base assertion (NEW, this PR):** `repos.compareCommits(base: main, head: pr.head.sha).behind_by === 0`. A stale `shopify[bot]` commit that predates a subsequent main-tip advance is missing main commits, and the gate skips. Catches the replay attack.
4. **Residual surface:** "hand-open a PR with a current-base `shopify[bot]` commit." Damage is bounded to "auto-deploy ships content `shopify[bot]` genuinely authored, in the same tree-state `shopify[bot]` would naturally produce." Much smaller than "ship arbitrary content."

The all-bets-are-off threshold around `contents: write` collaborator-bypass is unchanged from the existing trust model: a collaborator who can land any PR could already exfiltrate any secret via a malicious workflow change, so the new PAT does not extend that surface.

### Bug B: latent main-has-advanced bug (discovered during this work, hardened in same PR)

After PR #17 squash-merged at 2026-05-11 21:08:42Z, shopify-sync entered phantom-orphan state (1 commit ahead, DIFF_LOC=0). PR #18 (CLAUDE.md consolidation) then landed on main on 2026-05-11. shopify-sync became 1 ahead, 2 behind, DIFF_LOC=375, no longer pure phantom-orphan. sync.yml's existing "Determine sync status" step only short-circuits on the DIFF_LOC=0 case, so the next sync run (cron, admin push, or manual dispatch) would create a reconcile PR whose diff proposes to **revert PR #18's docs changes** (CLAUDE.md and `docs/accessibility-patterns.md`). With the GITHUB_TOKEN status quo, validate.yml wouldn't fire on that PR (harm contained, humans review). With the PAT fix landing, validate.yml DOES fire, the PR could flow through the workflow_run auto-deploy arm, and both the PR-opener gate (PAT-opened) and the commit-identity gate (HEAD commit is real `shopify[bot]`) would pass. The auto-deploy could ship the reverse-application to live.

The PAT fix unmasked this latent bug. Two layers of defence land in this same PR:

**FIXED** (sync.yml prevention guard): added a merge-base check at the top of the "Open or refresh reconcile PR" step's `run:` block, before the PR-create or PR-edit action. The check asserts `git merge-base origin/main HEAD == origin/main`. If not, the workflow fails red with an `::error::` annotation that includes the manual-recovery snippet (force-push main onto shopify-sync). Placement is inside the step, NOT before the LOC fork in "Determine sync status"; this avoids false-firing on the legitimate phantom-orphan post-deploy state (where `AHEAD > 0` AND `DIFF_LOC == 0` AND main has advanced past shopify-sync's merge-base via the squash). The step's existing `if:` condition (`loc != '0'`) already excludes that state from this step.

**FIXED** (deploy.yml defence-in-depth): added a `repos.compareCommits(base: main.commit.sha, head: trustedSha)` call to the shopify-sync gate, after the existing base-staleness check. Asserts `behind_by === 0`. The existing base-staleness check (`main.commit.sha !== pr.base.sha`) only catches "main advanced after the PR was created"; it does NOT catch "PR head was missing main commits at PR creation time." The new assertion catches that case AND the PAT-exfil hand-opened-stale-PR attack from the trust-delta chain above. Defence in depth: even if sync.yml's prevention guard is bypassed (hand-opened PR via PAT exfil), the deploy-side gate still skips.

### Doc-drift fix folded in (zizmor.yml mitigation comment)

`.github/zizmor.yml`'s `dangerous-triggers` ignore-list comment listed "auto-reconcile label present, manual-review label absent" as shopify-sync mitigations. Both labels were replaced by the draft-PR escape hatch in an earlier PR; the comment had drifted. Refreshed the shopify-sync mitigation bullet list to reflect the actual current gates (draft-PR check, no-protected-paths-in-diff, <1000 LOC, base-staleness, new merge-base assertion) and the renamed PR-opener gate sourcing from `vars.EXPECTED_SYNC_PR_OPENER`.

### Operator action (post-merge)

Run a one-time force-push to bring shopify-sync to byte-for-byte parity with main, absorbing PR #18 and discarding the orphan `9b003ae`:

```bash
git fetch origin
MAIN_SHA=$(git rev-parse origin/main)
LEASE_SHA=$(git rev-parse origin/shopify-sync)
if [ "$LEASE_SHA" = "$MAIN_SHA" ]; then
  echo "Already in sync; nothing to do."
  exit 0
fi
git push --force-with-lease=shopify-sync:"$LEASE_SHA" origin "$MAIN_SHA":shopify-sync
git fetch origin shopify-sync
[ "$(git rev-parse origin/shopify-sync)" = "$MAIN_SHA" ] || { echo "MISMATCH"; exit 1; }
```

If `--force-with-lease` aborts (a `shopify[bot]` commit landed between fetch and push), re-run from `git fetch`. After the push, `gh api /repos/Perts-Foundry/sapphire-shadow-studio-theme/compare/shopify-sync...main` returns `identical / 0 / 0` and GitHub's branch view shows shopify-sync at parity with main. The new sync.yml and deploy.yml guards protect the recovered state.

### Comment-deploy escape hatch unaffected

The `Auto-deploy gates - shopify-sync` step that hosts the renamed PR-opener gate only runs on the `workflow_run` trigger path. The `issue_comment` (manual `deploy` comment) trigger uses a separate collaborator-permission check on `comment.user.login` and never asserts `pr.user.login`. A `deploy` comment on an auto-reconcile PR (now opened by the PAT-owner identity instead of `github-actions[bot]`) ships normally.

### Dependabot path: PR-opener identity unchanged, parallel merge-base assertion added

The dependabot/** arm of deploy.yml's gate continues to expect `pr.user.login === dependabot[bot]`. Dependabot opens PRs under its own bot identity via GitHub's native Dependabot service, not via a PAT, so the GITHUB_TOKEN-suppression rule does not apply (Dependabot's pushes already fire workflow events). No PAT is needed for that path; no PR-opener identity change.

The defence-in-depth `repos.compareCommits(base: main, head: trustedSha).behind_by === 0` assertion is also added to the dependabot gate, mirroring the shopify-sync addition. In Dependabot's normal flow this is a no-op: Dependabot rebases its own PRs on every push and updates `pr.base.sha`, so the existing base-staleness check is sufficient and the new assertion always passes. The assertion lands as belt-and-braces against a hypothetical future Dependabot behaviour change where a PR could carry a current `pr.base` but a head SHA missing main commits (e.g. partial-rebase race). Symmetric trust model across both auto-deploy arms.

## CI/CD deploy chain: Dependabot auto-deploy gate fixes (unreleased)

PR #2 (Dependabot `actions/github-script` v8 → v9, open since 2026-05-03) was the first auto-deploy attempt against the post-PR-13 chain. It exposed two bugs in the Dependabot auto-deploy path that the earlier audit missed, plus one latent issue that was masked by the first bug.

### Bug A: `dependabot/fetch-metadata@v3.1.0` does not support `workflow_run` triggers

PR #13 integrated `dependabot/fetch-metadata@v3.1.0` as a new gate step to read the per-dep `update-type` from Dependabot's structured commit trailers. The action's README mentioned `workflow_run` as a viable parent trigger; in practice the action requires the `pull_request` event payload to live in its own job's context, which a `workflow_run`-triggered job does not have. Every Dependabot auto-deploy attempt now hard-failed with:

```
::warning::Event payload missing `pull_request` key. Make sure you're triggering this action on the `pull_request` or `pull_request_target` events.
::error::PR is not from Dependabot, nothing to do.
```

The whole Dependabot auto-deploy path was blocked before reaching the bot-identity gate, the major-version gate, or any deploy step.

**FIXED**: removed the `Fetch Dependabot metadata` step entirely. Replaced with inline commit-trailer parsing inside the existing `Auto-deploy gates - dependabot` github-script step: iterate `pulls.listCommits`, parse each commit message for `update-type: version-update:semver-{major,minor,patch,prerelease}` trailers (Dependabot's documented structured-commit format), classify the bump severity from the parsed values. Same logical behaviour as `fetch-metadata`, no action dependency, no event-payload requirement. The prose-regex secondary parse and the fail-closed "no parseable signal" branch are preserved.

### Bug B: bot-identity gate rejected legitimate `web-flow` committer

Both auto-deploy bot-identity gates (shopify-sync and dependabot arms) asserted `commit.committer.login === expectedBot` with strict equality. When a bot-authored commit is rebased through GitHub's web-flow (which happens on every `@dependabot rebase`, `@dependabot recreate`, and GitHub's automatic "update branch" rebase), the resulting commit has `author.login === bot` but `committer.login === 'web-flow'`. PR #2's head commit was exactly this state: `author=dependabot[bot]`, `committer=web-flow`, `verified=true`.

Pre-PR-13 stickies on PR #2 (2026-05-10 22:39 and 2026-05-11 00:18) had already reported the false positive: "Bot-identity gate failed (verified=true, author=dependabot[bot], committer=web-flow, pr.user=dependabot[bot]; expected dependabot[bot])." After PR #13, the failure was masked by Bug A (the fetch-metadata step crashed first); without this fix it would resurface on the next deploy attempt.

**FIXED**: both gates now allow `committer.login` to be either the expected bot OR `web-flow`. `web-flow` is a GitHub-system identity controlled by GitHub itself; no external actor can impersonate it. The author and PR-opener integrity assertions are unchanged.

### Trust-model impact

The signed-commit gate's integrity property is unchanged: the assertion is still that a verified bot AUTHORED every commit. The committer field was already documented as defence-in-depth (the README explicitly stated "Git commit headers are not consulted; those are forgeable"). Relaxing the committer to {expectedBot, web-flow} accepts a GitHub-controlled identity in addition to the bot, preserving the no-external-impersonation property.

CLAUDE.md "Deploy gate trust delta" section and "Admin-side edits" section both updated to reflect the relaxed committer-identity rule.

### Operator action

None. PR #2 can now be re-auto-deployed by triggering a new Validate cycle on its HEAD (any commit push, or `@dependabot recreate`); the chain will now run the bot-identity gate (passes with `committer=web-flow`), then the major-version gate (detects the major bump via the inline trailer parse and postSkips with "Major-version bump(s) detected"). After review, comment `deploy` to ship.

## CI/CD deploy chain: sync auth + audit-driven hardening (unreleased)

PR #11's test deploy was the first to actually exercise the consolidated `deploy.yml`'s `Sync main -> shopify-sync` post-merge step under realistic conditions. It surfaced three immediate bugs (sync push could never have worked; failure annotation misattributed the cause; deploy report rendered the success icon next to failure text) and prompted a full-chain audit that turned up another fourteen findings ranging from latent gate-bypass risks to documentation drift. All seventeen are folded into this one PR.

### The three bugs that started the audit

- **FIXED** `Sync main -> shopify-sync` push auth. Both push commands (the fast-forward and the `--force-with-lease` phantom-orphan reset) switched from `AUTHORIZATION: bearer $GH_TOKEN` to HTTP Basic auth with `x-access-token` as the username (`AUTHORIZATION: basic <base64('x-access-token:'+token)>`). GitHub's git-over-HTTPS smart server silently ignores the Bearer scheme on git endpoints; git then falls back to credential prompting and exits with `fatal: could not read Username for 'https://github.com': No such device or address`. The Bearer form was inherited from the prior `sync-reconcile.yml` fast-forward arm and never executed in production there because GITHUB_TOKEN-driven pushes do not retrigger workflows, so the bug was latent until the consolidated `deploy.yml` ran the push synchronously inside the deploy job. The `AUTH_HEADER` value is computed once at the top of the step so the two push call-sites stay in lockstep.
- **FIXED** the `::warning::` annotation message in both failed-push branches. The prior text was `Fast-forward push failed (likely raced an admin commit): <err>`, which pre-classified every push failure as a race condition. Auth failures, network blips, and rate-limit hits all surface the same way; the operator needs the raw `$PUSH_ERR` to triage. The annotation is now `Fast-forward push failed: <err>` (and `Phantom cleanup push failed: <err>` for the other arm). The `sync-status` marker was also renamed from `race;` to `push failed;` so the report-comment body reflects the underlying state without prejudging the cause.
- **FIXED** the deploy-report sync-line icon. The `Post deploy report` step previously chose between the success and warning icons based on `steps.sync.outcome === 'success'`, which is always `'success'` because the Sync step's bash explicitly handles errors with `if PUSH_ERR=...; then ... else ... fi` and exits 0 in every branch. The report now inspects the `sync-status` output content: `push failed` or `deferred` prefixes route to the warning icon and wording, anything else routes to success. `syncOutcome === 'success'` is also still consulted as a defence-in-depth signal in case the bash exits non-zero before any status is written. PR #11's report rendered the success icon paired with failure text; the new logic produces `:warning: **shopify-sync sync warning:** push failed; ...`.

### Latent-bug fixes folded in from the audit

- **HARDENED** Dependabot major-version detection (C3). The gate's only safety net against an auto-deployed major bump was a regex over the PR title and body. Grouped-update PRs use non-parseable titles ("bump the github-actions group with N updates") and the regex's-only signal is the per-dep "Updates `X` from A to B" lines in the body; any future change to that template would silently let a major bump auto-deploy. The gate now (1) runs `dependabot/fetch-metadata@v3.1.0` as a step before the dependabot gate and reads its `update-type` output as the primary signal, (2) keeps the regex as belt-and-braces in case the action returns no metadata, and (3) fails closed when BOTH signals come up empty on a Dependabot PR (the bot-identity gate already confirmed Dependabot authorship, so an unparseable PR is an unknown-severity bump that gets routed to manual review).
- **PAGINATED** the deploy chain's sticky-comment finders (C1). Five upsert helpers (gate's `upsertSticky`, both auto-deploy-gate `upsertSticky` closures, `Post deploy report`, and `Report failure`) used a bare `listComments({ per_page: 100 })` lookup with no pagination. On a PR with >100 comments (an auto-reconcile PR accumulating daily-cron stale notices, a long-lived discussion thread) the existing sticky lives past page 1, the finder returns empty, and the upsert posts a duplicate. The duplicate-sweeper at the end of each helper only sees the truncated page so the legacy sticky persists. All five helpers now use `github.paginate(github.rest.issues.listComments, ...)`.
- **MASKED** the base64-wrapped Shopify auth header (C2). `AUTH_B64=$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w 0)` produces a literal Actions has not been told to mask. The bare `$GH_TOKEN` is auto-masked, the base64 form is not. A future `set -x`, debug `echo`, or git error message containing the assembled `http.extraheader` would print the token in base64-plaintext-equivalent form. Added `echo "::add-mask::$AUTH_B64"` immediately after the assignment.
- **FIXED** the `compareCommits` documentation in both `deploy.yml` and `CLAUDE.md` (C4 + N2). The inline comment and the CLAUDE.md "Deploy gate trust delta" section both described `compareCommits.status === 'identical'` as tree-equivalence ("catches force-pushes to the same tree as benign and different trees as suspicious"). GitHub's `compareCommits` actually compares commit objects, not trees: a same-tree amend / cherry-pick / different-tree force-push all return `diverged`, not `identical`. So `compareCommits.status === 'identical'` is functionally redundant with the `pr.head.sha === trustedSha` equality check above it. The actual security posture is *stronger* than the description claimed; the docs now describe what the check actually does (defence in depth on top of SHA equality) so a future refactor doesn't "simplify" away a load-bearing check on a wrong premise.
- **AUTHED** the `git fetch` in the Sync step (S1). The fetch was anonymous because the repo is public; if the repo is ever flipped to private, the unauthed fetch fails with the same `could not read Username` error the Bearer push used to produce. Threading `$AUTH_HEADER` into the fetch costs nothing on the public-repo path and immunises against repo-visibility changes.
- **TIGHTENED** the comment-deploy Validate lookup (S2). `listWorkflowRuns({ workflow_id: 'validate.yml', head_sha })` would accept a Validate run from any triggering event. `validate.yml` is `pull_request`-only today, but adding an `event: 'pull_request'` filter blocks a future push / workflow_dispatch trigger on validate.yml from masquerading as proof for a comment-deploy.
- **SKIPPED** preview cleanup and preview-sticky updates for Dependabot auto-deploys (S4). `preview.yml::deploy-preview` is conditionally skipped for Dependabot PRs (no Shopify token in the Dependabot secrets scope), so there is never a `pr-N-preview` theme to delete and never a `<!-- preview -->` sticky to update. Both downstream steps now check `needs.gate.outputs.trigger_path != 'dependabot'`, removing the misleading `:broom: Preview cleanup: no preview theme found.` line from every Dependabot deploy report.
- **DEFENSIVE** explicit-destination refspec on the Sync step's fetch (S5). `git fetch --prune --no-tags origin "$DEPLOYED_SHA" shopify-sync` could miss force-push updates to `origin/shopify-sync` in the local clone. Switched to `+refs/heads/shopify-sync:refs/remotes/origin/shopify-sync` so the lease-SHA used by `--force-with-lease` reflects the true current tip.
- **TIGHTENED** Dependabot `pulls.list` page size (S6). `per_page: 5` to `per_page: 1`. GitHub guarantees (state, head) uniqueness for open PRs; the explicit `1` makes the assumption visible.
- **ASSERTED** non-empty `deployedSha` after `pulls.merge` (S7). The squash-merge API response is documented to return the new merge-commit SHA in the `sha` field, but a future response-shape change could silently produce an empty refspec for the Sync step (`git push origin :shopify-sync` would DELETE the branch). A defensive `if (!deployedSha)` check now sets `merged = false` with an explicit error message.
- **STRENGTHENED** the HEAD-drifted-post-deploy report copy (S8). When `merged === false` and `mergeError` matches `HEAD drifted post-deploy`, the deploy report now renders a louder `:rotating_light:` notice explicitly warning the operator not to reflexively click Merge in the GitHub UI; the live theme is on the deployed SHA, but the PR head has moved since deploy, so a manual merge would land different commits than what's on the storefront.
- **ADDED** `actions: read` to the deploy job permissions (S9). Forward-compat; any future deploy step that calls `listWorkflowRuns` / `getWorkflowRun` (e.g. to surface the Validate run id in the report) needs the grant. Harmless when unused.
- **SWITCHED** the sync-success icon from `:arrows_clockwise:` to `:white_check_mark:` (N3). Cosmetic: matches the report header's vocabulary and removes the "in-progress" ambiguity.
- **UPSERTED** the stale-reconcile-PR sticky in `sync.yml` (N4). The prior `gh pr comment` form appended a fresh comment on every cron firing; a PR open for a week accumulated seven identical "stale" notices. Tagged with `<!-- stale-reconcile -->` and now upserted via the GitHub API.

### Operator action

None. `shopify-sync` is currently 6 commits behind `main` (PRs #6, #7, #8, #9, #10, #11, #12 all merged after the last successful sync). The next admin commit on the unpublished sync theme will reopen the auto-reconcile PR; Validate will pass on its branch; and the auto-deploy arm will now successfully fast-forward `shopify-sync` to the deployed SHA in its post-merge step. Manual recovery remains available but is not necessary: a local `git push --force-with-lease=shopify-sync:<expected-sha> origin main:shopify-sync` from a workstation with push access would close the drift immediately.

### Deploy chain reorder: merge is the final user-visible action

PR #11's deploy report demonstrated that the prior step order ran the squash-merge BEFORE the deploy-report sticky, preview-deletion sticky update, and rocket reaction. The PR closed first; comments and emojis landed afterward on a closed PR. This entry inverts that order so the squash-merge is the last user-visible event of the chain.

New step order in the `deploy` job:

1. Live theme push
2. Delete preview theme (gated on push success, not merge success)
3. Update preview comment ("Preview theme deleted; live theme is serving this commit; squash-merge to follow")
4. React with rocket
5. Post deploy report (push + smoke + cleanup status; no merge or sync status, since neither has run yet)
6. **Squash merge** (the final user-visible event; PR closes here)
7. Sync main -> shopify-sync (post-merge; not surfaced in PR timeline; warnings via `::warning::` workflow annotations only)
8. React with -1 (failure)
9. Report failure (failure; overwrites pre-merge sticky with merge-specific error copy, including a `:rotating_light:` warning for the HEAD-drifted-post-deploy case)

Key behaviour changes:

- **Deploy report posts once, before merge, without merge or sync status.** The PR's GitHub-rendered "Merged" badge becomes the merge confirmation when the merge step closes the PR. Sync status is observable only via the workflow log; `sync.yml`'s daily cron + admin-push retrigger are the self-heal.
- **Merge failure now calls `core.setFailed`.** Previously the merge step swallowed errors and the job stayed green even on a failed merge, leaving the deploy-report sticky claiming "Deployed successfully" next to an unmerged PR. Now a merge failure trips the job's failure mode, the `Report failure` step fires, and it overwrites the pre-merge sticky with merge-specific error copy.
- **Preview cleanup gated on live push success, not merge success.** Live serving the new code makes the preview obsolete regardless of whether the merge has happened yet. Accepted trade-off: a runner crash between cleanup and merge leaves "live deployed + PR open + preview gone"; live is already serving the new code so the preview's verification value is moot at that point.

### Audit findings deferred or accepted as-is

- **S3** (`deferred` sync status routing): kept routed to the warning path per the original-instruction routing. `deferred` means `shopify-sync` was NOT advanced by this deploy because an admin commit landed mid-flight; the operator should see a visible signal even though `sync.yml` will reconcile on the next admin push. Now surfaces as a `::warning::` workflow annotation rather than a deploy-report comment line (the report is posted before sync runs in the new order, so it no longer carries sync status).
- **N1** (`core.warning` + silent skip in the unexpected-head_branch branch of `gate.resolve`): kept as-is per CLAUDE.md's documented "workflow filter is the real gate; this is belt-and-braces" intent.
- **N5** (release-notes content review for sensitive content per CLAUDE.md "Sensitive Content" rules): self-reviewed; no personal email, machine paths, sub-state location detail, or tokens.

## CI/CD deploy chain consolidation (unreleased)

Three near-identical deploy workflows (`deploy.yml`, `shopify-sync-auto-deploy.yml`, `dependabot-auto-deploy.yml`) collapse into a single `deploy.yml` with three trigger paths. `sync-reconcile.yml` becomes `sync.yml`, single-direction only. `setup-labels.yml` deleted; the deploy chain no longer gates on labels. Net: 4 workflow files (was 8), ~700 lines of YAML deleted, all three automation paths preserved.

Root cause for the consolidation: the three deploy workflows shared one live-push + smoke-test + squash-merge + delete-preview ladder; they differed only in their gate logic (collaborator-permission vs signed-commit + diff-sanity + label gates). Maintaining three copies of the ladder triples the change-failure surface, and the bidirectional dance in `sync-reconcile.yml` (a `push: main` fast-forward arm plus a `push: shopify-sync` reconcile-PR arm) existed only because the cross-workflow chain after a deploy-driven squash-merge does not fire (GitHub Actions suppresses `push` events triggered by `GITHUB_TOKEN` to prevent infinite loops). PR #7's `push: main` fast-forward arm was dead on arrival for the same reason; the cron was the only mechanism keeping `shopify-sync` in sync, and it failed for six days when an orphan bot commit met a moving `main`.

What changed:

- **MOVED** all three deploy paths into `deploy.yml`. Single workflow file, two-job structure:
  - `gate` runs without `SHOPIFY_CLI_THEME_TOKEN` in scope, with `permissions: { contents: read, pull-requests: write, actions: read, checks: read }`. Resolves trigger context (`comment` | `shopify-sync` | `dependabot`), looks up the PR, re-verifies Validate on the trusted HEAD SHA, then runs trigger-conditional gates (collaborator-permission for `comment`; signed-commit + diff-sanity + label gates for the two `workflow_run` paths). Posts a sticky pre-deploy rejection comment under the unified `<!-- deploy-result -->` marker if any gate fails.
  - `deploy` runs `needs: gate`, with `permissions: { contents: write, pull-requests: write }` and `concurrency: deploy-production`. Pushes to live, squash-merges, deletes the preview theme, runs the new `Sync main -> shopify-sync` post-merge step, and posts the deploy report. The `SHOPIFY_CLI_THEME_TOKEN` enters scope only here; a bug in any gate `if:` cannot leak it because the gate job structurally does not have the secret.
- **NEW** `Sync main -> shopify-sync` post-merge step in `deploy.yml`. Replaces the dead `push: main` fast-forward arm. Anchored on the deployed SHA returned by the squash-merge response (not `origin/main` re-resolved later) so the inline sync is tied to what just went live. Three branches:
  - Fast-forward push when `shopify-sync` is reachable from the deployed SHA.
  - `--force-with-lease=shopify-sync:<expected-sha>` reset when `shopify-sync` is ahead but trees are identical (post-auto-deploy phantom-orphan state). Lease catches admin commits racing the push; on rejection, `sync.yml`'s next firing on the admin push refreshes the reconcile PR.
  - Defer to `sync.yml` when `shopify-sync` has real divergence (admin commit landed mid-deploy).
- **RENAMED** `sync-reconcile.yml` to `sync.yml` and shrunk from ~180 lines to ~50. Single direction: on admin commits to `shopify-sync`, open or refresh the auto-reconcile PR. Phantom-orphan detection (DIFF_LOC=0) skips PR creation; deploy.yml handles cleanup. Stale-PR alarm preserved.
- **DELETED** `.github/workflows/shopify-sync-auto-deploy.yml`, `.github/workflows/dependabot-auto-deploy.yml`, and `.github/workflows/setup-labels.yml`. The two auto-deploy files' logic is now `deploy.yml`'s trigger-conditional gate steps. The setup-labels file is gone because the deploy chain no longer uses any labels (see "Label-free deploy gating" below).
- **WORKFLOW-LEVEL `if:`** rejects two failure classes before any runner starts: (a) `issue_comment` events that are not on a PR (the `deploy` body alone on a plain issue would otherwise dispatch a runner) and (b) `workflow_run` events from `validate.yml`'s `push:` triggers (would otherwise spawn an empty deploy attempt on every admin push).
- **DYNAMIC `run-name`** distinguishes the three trigger paths in the Actions tab so the operator can triage at a glance without opening the run.
- **UNIFIED STICKY MARKER** `<!-- deploy-result -->` replaces the per-workflow markers (`<!-- shopify-sync-auto-deploy -->`, `<!-- dependabot-auto-deploy -->`). One sticky comment per PR carries deploy / failure reports across all three trigger paths.
- **UPDATED** `.github/zizmor.yml`: `dangerous-triggers.ignore` now lists `deploy.yml` with an inline rationale block; the two deleted workflows are gone.
- **UPDATED** `CLAUDE.md` "Deploy gate trust delta", "Admin-side edits", "Live theme", "Token rotation call-site catalog", and "Pre-PR review" sections; `README.md` workflows table.

Trust-model implications: all three computed gates (collaborator-permission, validate-on-HEAD-SHA, signed-commit) survive intact; their housing changes from three workflow files to one. The no-token-sandbox property documented as trust-delta item 1 is preserved by the two-job structure (`gate` lacks `contents: write` and the Shopify secret). For `workflow_run` paths Validate is explicitly treated as advisory: a malicious PR head could rewrite `validate.yml` to pass falsely, but `getWorkflowRun().head_sha` + `compareCommits.status === 'identical'` + the signed-commit assertion (which reads commit metadata from the API, not from the PR's files) form the actual integrity boundary. Token rotation call-site catalog drops from four workflow files to two (`preview.yml` and `deploy.yml`).

Operator action: none post-merge. The unified `deploy.yml` becomes active on main after this PR squash-merges; subsequent admin commits and Dependabot PRs auto-deploy through the new path. Recovery procedure for any future stuck-state incident (one local command with admin bypass): `git push --force-with-lease=shopify-sync:<expected-sha> origin <main-sha>:shopify-sync`.

Label-free deploy gating: this PR also removes all label-based gates from the deploy chain. The previous mechanisms used three labels (`auto-reconcile` to allow shopify-sync auto-deploy, `manual-review` as escape hatch on both auto-deploy paths, `auto-deploy-major` to opt in to Dependabot major-version auto-deploys). Each is replaced by a native GitHub mechanism that does not require operator label hygiene:

- `auto-reconcile` requirement -> PR-opener-identity check (`pr.user.login === 'github-actions[bot]'`, proving `sync.yml` opened the PR) plus the existing signed-commit assertion on the underlying shopify[bot] commits. A hand-opened shopify-sync -> main PR is rejected by auto-deploy and must be shipped via manual `deploy` comment.
- `manual-review` escape hatch -> draft-PR check (`pr.draft === true`). Operator marks the auto-reconcile PR or Dependabot PR as a draft (via `gh pr ready --undo <n>` or the GitHub UI) to halt auto-deploy; convert to ready-for-review to resume. Halt is bidirectional: applies to both shopify-sync and dependabot auto-deploy arms.
- `auto-deploy-major` opt-in -> major-version bumps default-skip auto-deploy (safer default). Operator comments `deploy` after review to ship a major bump.

`setup-labels.yml` is deleted; `.github/dependabot.yml`'s `labels:` block is removed. Existing labels in the repo are unused by the deploy chain after this PR; they can be left in place or pruned manually with `gh label delete`.

Additional reviewer-flagged fixes folded into this PR:

- `gate` and `deploy` jobs now declare `issues: write` for `createForIssueComment` reaction calls (the PR-comment reactions endpoint routes through the issues API even for PR comments; the prior `pull-requests: write`-only grant was undocumentedly permissive).
- `sync.yml`'s stale-PR alarm no longer exits 1, which previously turned every cron firing red whenever an auto-reconcile PR was open >3 days. Stale-PR notice is now a `::warning::` annotation plus the per-PR comment.
- The "Sync main -> shopify-sync" step's race-recovery messaging in the deploy report now correctly states "retry on next admin push or 13:00 UTC cron" rather than implying immediate retry.
- The resolve step's "Unexpected head_branch" case is now a `::warning::` (was silent `::info::`); an unexpected event_name now `setFailed`s (was unreachable but now defensive).
- `sync.yml`'s `Determine sync status` step now writes `ahead=0, loc=0` defaults upfront for clarity even when AHEAD=0 (no functional change).
- CLAUDE.md "Code changes" section documents the local-actionlint invocation that matches CI's `SHELLCHECK_OPTS` for SC2016 / SC2317 suppressions.
- CLAUDE.md "Token rotation call-site catalog" now enumerates the composite action (`shopify-theme-push/action.yml`) as the canonical consumption point in addition to the two workflow passthrough sites.

## CI/CD preview cleanup + install consolidation (unreleased)

Synchronous preview-theme cleanup on auto-merge, plus consolidation of the Shopify CLI install pattern. Closes the leak where `pr-N-preview` themes survived after a token-driven squash-merge.

Root cause: GitHub Actions does not fire downstream workflows for events triggered by the default `GITHUB_TOKEN`. The three deploy paths (`deploy.yml`, `shopify-sync-auto-deploy.yml`, `dependabot-auto-deploy.yml`) all close PRs by calling `pulls.merge` with `GITHUB_TOKEN`, so `preview.yml::cleanup` (gated on `pull_request: closed`) silently never fires after a token-driven merge.

What changed:

- **NEW** composite action `.github/actions/setup-shopify-cli/`: single source for `actions/setup-node` + `npm ci --ignore-scripts`. Used by `shopify-theme-push` and `validate.yml`. The CLI version pin (`@shopify/cli@3.94.3`) lives only in `package.json`.
- **EXTENDED** `.github/actions/shopify-theme-push/` with `mode: delete-preview`. Lists themes named `pr-${PR_NUMBER}-preview` and deletes them. Exits 0 on no-match (informational); non-zero on real Shopify API/auth failure so a token rotation surfaces loudly. New `cleanup-status` output threads into the deploy report comment.
- **REFACTORED** the three deploy workflows: split the prior `Merge PR and report success` mega-step into a four-step ladder (`Live theme push` -> `Squash merge` -> `Delete preview theme` (continue-on-error, gated on merge success) -> `Post (auto-)deploy report`). Cleanup ordering is post-merge intentionally; a runner crash or non-transient cleanup failure cannot leave the system in `live deployed + PR open + preview gone`.
- **UPDATED** `preview.yml::cleanup` to call `shopify-theme-push` with `mode: delete-preview`. Replaces inline `npm install -g @shopify/cli@3.94.3` + bash with the composite action call (after a `ref: main` checkout because the PR head ref may already be deleted).
- **UPDATED** `validate.yml` to use `setup-shopify-cli` (drops a duplicate setup-node + npm-ci block).
- **DELETED** `.github/workflows/drift-watch.yml`. Loss of weekly orphan-preview sweep is accepted; the synchronous cleanup is the primary mechanism, with manual `npx shopify theme list | grep pr-` plus `shopify theme delete --theme <id> --force` as the documented recovery path.
- **UPDATED** `sync-reconcile.yml` to remove issue creation (issues are disabled on this repo). Diff-sanity alarm now relies on workflow-failure notifications; stale-PR alarm posts a `gh pr comment` per stale PR. `issues: write` permission dropped.
- **UPDATED** `setup-labels.yml` to drop the `deploy-attention` label (no remaining callers) and `issues: write` permission.

Trust-model implications: token-rotation call-site catalog drops from 7 sites to 4, and all four now route through `shopify-theme-push`. There is no longer an automated detector for unauthorised admin-side edits to the live theme; the "live = main" invariant is operator discipline, not CI-enforced. Acceptable for a single-developer private repo.

Operator action: after this PR merges, manually delete the leaked `pr-3-preview` theme: `npx shopify theme delete --theme 183494148396 --force`.

## CI/CD GitHub Environment removed (unreleased)

The `shopify-deploy` GitHub Environment is gone. All six jobs that previously bound to it (`preview.yml::deploy-preview`, `preview.yml::cleanup`, `deploy.yml::deploy`, `drift-watch.yml::drift-watch`, `shopify-sync-auto-deploy.yml::auto-deploy`, `dependabot-auto-deploy.yml::auto-deploy`) now read the Shopify CLI token from a repo-level secret directly, with no environment binding.

`SHOPIFY_FLAG_STORE` was demoted from secret to a repo-level variable. The myshopify handle is observable from any storefront response (it appears in `Set-Cookie` and on every checkout redirect) and is not credential material; treating it as a variable is correct, surfaces the value in workflow logs without redaction, and slightly improves debuggability.

`SMOKE_BASE_URL` was retired and replaced by a new `SHOPIFY_DOMAIN` repo-level variable holding just the canonical host (e.g. `sapphireshadowstudio.com`). The deploy workflows prefix `https://` and pass that as the `smoke-base-url` input to the composite action; the smoke action's contract is unchanged.

Trust-model implication: the three computed deploy gates (collaborator-permission check, validate-on-HEAD-SHA, signed-commit) are unchanged and remain the access control. With no env binding, the Shopify token is now readable by any workflow run that the actor can dispatch with the right `permissions:` grant, instead of only by jobs explicitly bound to the env. This is an accepted reduction in defence-in-depth; the env's required-reviewer gate had already been removed earlier (it was self-approval anyway), so the env was no longer a meaningful boundary.

Operator action that accompanied this change (already done): three repo-level entries created (`SHOPIFY_CLI_THEME_TOKEN` secret, `SHOPIFY_DOMAIN` variable, `SHOPIFY_FLAG_STORE` variable). After this change ships, delete the `shopify-deploy` environment in `Settings -> Environments` and clear out the orphaned env-scoped `SMOKE_BASE_URL` secret.

## CI/CD comment-driven deploy (unreleased)

Switched the deploy chain from "merge-then-deploy" to "deploy-then-merge". A write+ collaborator comments `deploy` on a PR; `deploy.yml` validates that the latest validate run on the PR HEAD SHA was green, pushes the theme to live, smoke-tests `/`, `/cart`, and `/collections/all`, then squash-merges the PR and deletes the branch. Failures post a sticky comment and the PR stays open so the developer can push a fix and re-comment.

The `shopify-sync` reconcile PR is now shipped automatically by a new `shopify-sync-auto-deploy.yml` workflow after Validate succeeds (mirroring the dependabot-auto-deploy pattern), with bot-identity, signed-commit, base-staleness, and diff-sanity gates. Dependabot PRs auto-deploy too via a new `dependabot-auto-deploy.yml` with PFW-style safety gates: signed by `dependabot[bot]`, refusal if `.github/{workflows,actions,scripts}` modified, major-version bumps require an `auto-deploy-major` label, `manual-review` label as escape hatch.

The `shopify-write` GitHub Environment was renamed to `shopify-deploy` and now holds `SHOPIFY_CLI_THEME_TOKEN` and `SHOPIFY_FLAG_STORE` as environment-scoped secrets. Required reviewers removed; the deploy gate is now the comment-trigger plus validate-on-HEAD-SHA verification plus the signed-commit gates on auto-deploy paths. The `[hotfix]` push-to-main bypass is gone; CLI break-glass (`npx shopify theme push --live --allow-live`) remains documented for true CI outages.

`pr-checks.yml` was replaced by `validate.yml` (one sequential job with five steps: `theme-check`, `reconcile`, `actionlint`, `zizmor`, `gitleaks`; plus a sticky-comment aggregator). A new composite action `.github/actions/shopify-theme-push/` factors out the live and preview push paths and adds smoke-test, per-attempt timeout, and token-redaction.

## CI/CD cutover (2026-05-03)

Switched from Shopify's bidirectional GitHub Integration on `main` to a PR-based deploy model.

### What changed

- Live theme `#181702754604` is no longer GitHub-connected. Production deploys are owned by `.github/workflows/deploy.yml`, which runs on every push to `main`.
- Admin theme-customizer and code-editor edits now flow through a separate unpublished theme `EDIT HERE - Admin Sync`, which is connected to the new `shopify-sync` branch. A daily `sync-reconcile` workflow opens an auto-merge PR from `shopify-sync` to `main` so admin edits reach production through the same gated path as code.
- Every PR runs `theme-check`, deploys a per-PR preview theme `pr-<n>-preview`, and is blocked from merging if `shopify-sync` has unmerged commits (`pr-reconcile-check`).
- Branch protection on `main`: PR required, branches must be up to date, theme-check + pr-reconcile-check required, force-push blocked, branch deletion blocked. Admin bypass enabled for hotfix flow.
- Repo settings: "Allow auto-merge" enabled. GitHub Environment `shopify-write` requires self-approval before the Shopify Theme Access token hydrates in any job.
- New cutover tag: `v1-ci-cutover`.

### Why

The old model auto-deployed every push to `main` without CI, mixing developer commits and admin-side `shopify[bot]` commits on the same branch with no review. Bad commits hit live instantly. The new model adds Theme Check gates, a per-PR preview, and isolates admin edits onto their own branch so they reconcile through PRs.

### Files added

- `.github/workflows/{pr-checks,preview,sync-reconcile,deploy,drift-watch}.yml` (five workflows; `pr-checks.yml` runs three parallel jobs: `theme-check`, `pr-reconcile-check`, `lint-workflows`).
- `.github/dependabot.yml`.
- `package.json`, `package-lock.json` (Shopify CLI pinned to 3.94.3).
- `blocks/CLAUDE.md`, `assets/CLAUDE.md` (per-directory rules for block authoring and CSS/JS coding standards).

### Files removed

- `.cursor/` (45 Cursor-specific rule files). Unique authoring guidance was migrated into the root `CLAUDE.md` and the new per-directory `CLAUDE.md` files; the Cursor regex-DSL files were not (theme-check + review agents cover that role).

### Files modified

- `CLAUDE.md`: rewrote "Before Making Changes" for the new branch-from-main / reconcile-check model; trimmed inline Shopify-doc duplication; added Pre-PR review notes; relocated component-specific rules to per-directory `CLAUDE.md` files.
- `README.md`: replaced Horizon upstream boilerplate with project-specific CI/CD docs.
- `.theme-check.yml`: disabled `JSONMissingBlock` to suppress 3 known false-positives from Judge.me Reviews app blocks.
- `THEME_CHECK_NON_ACTIONABLE.md`: noted the `JSONMissingBlock` items are now suppressed in config.

---

# Release Notes - Version 3.2.1

This release delivers extensive performance optimizations across many components and resolves issues in the menu drawer, cart, and sticky add-to-cart behavior.

## What's Changed

### Fixes and improvements

- [Performance] Improved Liquid rendering performance by reducing snippet use
- [Performance] Improved overall CSS performance
- [Performance] Improved animation performance
- [Performance] Improved header, email signup, quick-add, meta color, predictive search, hero banner, fly-to-cart, jumbo text, and slideshow performance
- [Performance] Improved page load speed when page transitions are turned off
- [Performance] Disabled all view transitions for low-powered devices
- [Performance] Improved interaction performance for various components
- [Menu drawer] Fixed menu drawer not closing on Firefox
- [Footer] Fixed footer copyright text wrapping
- [Quick add] Fixed quick add modal variant selector appearance issues after opening multiple modals
- [Collection cards] Collection cards in lists and grids match height of tallest card
- [Slideshow] Fixed slideshow controls visibility on transparent product images
- [Marquee] Fixed marquee jump on mobile scroll
- [Sticky add to cart] Polished sticky add to cart behaviors
- [Cart drawer] Entire cart drawer becomes scrollable when its footer is too tall
- [Cart drawer] Addressed UI inconsistencies in the cart drawer
- [Gift cards] Fixed "copy gift card code" button
- [Cart] Fixed discount field sizing for narrow viewports
- [Blog] Removed section title uppercase styling
- [Editor] Added recommended blocks to Slideshow and Layered slideshow
- [Editor] Improved the clarity of a number of labels in the editor
