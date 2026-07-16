# Product media alt text

Read this before authoring alt text for product photos, or before changing the colour filter in
`snippets/product-media-gallery-content.liquid`.

Alt text on this store does two jobs at once. It is the accessible description of the photo, and
it is the only thing that tells the theme which colour the photo shows. Both jobs are real, they
pull against each other, and this page is where that tension is resolved.

## What reads it

`snippets/product-media-gallery-content.liquid` filters the product media gallery. For each
media it compares the alt text against the values of the product option named by the global
`settings.color_option_name` theme setting (Online Store > Themes > Customize > Theme settings >
Variant pickers > Color option). The setting ships as `Color`.

Both gallery surfaces share that snippet, so the rule applies to the product page and to the
featured-product section alike.

Leaving `color_option_name` blank is the kill switch: no filtering anywhere, every photo shows
on every variant.

## Why alt text and not the variant image

Shopify caps a variant at **one** attached media. That is a platform limit, not a theme choice:
`variant.featured_media` is "the first media object attached to the variant", and the Admin API
rejects a second with `PRODUCT_VARIANT_ALREADY_HAS_MEDIA`. So attaching images to variants can
express one hero image per colour and can never express "every black photo". Alt text is the
only channel that can.

Attaching one hero per colour is still worth doing. It drives cart line-item thumbnails and
collection cards, which the gallery filter never touches.

## The match rule

- Matching is against **that product's own Color option values**, not against colours in general,
  not against a store-wide list, and not against filenames. The filter reads each product's
  `options_with_values`, so a word is reserved only on products whose Color option actually lists
  it. On the crewnecks the values are `Black`, `Gray`, `Navy`. "Blue" is a colour; it is not a
  value there, so it matches nothing.
- Matching is **case-insensitive** and on **whole words**. `Black` matches "black crewneck" and
  "BLACK CREW"; it does not match "blackout".
- The separator list is **exhaustive**: `-` `_` `,` `.` `/` `(` `)` `:` `;` and the apostrophe.
  Any other punctuation touching the value breaks the binding, so "Navy | front view" names no
  value and goes shared. Stick to plain words and commas.
- A photo that names **exactly one value** is bound to that colour and shows only there.
- A photo that names **no value at all** is shared and shows on every colour.
- A **multi-word value shadows its own substring**. With `Blue` selected, a photo tagged "light
  blue" is excluded rather than shown under both, because `Light Blue` is a value that contains
  `Blue`. Latent on today's values; it matters the day a "Heather Gray" ships.

## Binding a photo to a colour

Name the value, spelled the way Admin spells it.

**The filenames lie, and this is the trap.** The navy photos are named `blue-crew-1.jpg`,
`blue-zip-2.jpg`, and so on, because that is what the colour looks like. On the crewnecks the
option value is `Navy`. Alt text follows Admin, never the filename. A photo whose alt says "Blue
crewneck" names no value, becomes shared, and shows under Black and Gray as well.

**Check the value in Admin before trusting that.** Because the vocabulary is per product, the
trap runs in reverse on any product whose Color option really does list `Blue`: there, "Navy
quarter-zip" is the string that names no value and goes shared. The quarter-zip and the vest do
not exist in Admin yet, so their values are still undecided. Keep every product on `Black` /
`Gray` / `Navy` so one vocabulary covers the catalogue, and if one ever has to diverge, record it
here.

## Sharing a photo across every colour

Name no value at all. Group shots are the easy case ("Three crewnecks side by side").

The hard case is the design shot, because the correct alt text is the counterintuitive one. The
garment in `nurse-crew-1.jpg` is a specific colour, and describing it accurately would bind the
photo to that colour and hide it from the other two. To keep a design shot on every variant,
describe the design and leave the colour out:

> Nurse design embroidered on the chest

not "Nurse design on a black crewneck".

The merchandising trade-off is deliberate and worth knowing: a shopper on Navy will see that
design shot even though the garment in it is black. If that ever stops being acceptable, shoot
the design per colour rather than weakening the rule.

## Reserved vocabulary

**The option's values are reserved words in alt text. Name at most one, ever.**

This is the rule that is easiest to break by writing *good* alt text, because accurate
description reaches for exactly these words. All three values are ordinary photo vocabulary:

| Tempting alt text | What goes wrong |
|---|---|
| "Black embroidery on navy fleece" | Names Black and Navy. Shows under both. |
| "Navy crewneck on a gray background" | Names Navy and Gray. Shows under both. |
| "Black zipper on the gray quarter-zip" | Names Black and Gray. Shows under both. |

Use a synonym for any colour that is not the garment's own: "dark zipper", "pale background",
"charcoal stitching". Describe the garment's colour with the value; describe everything else
some other way.

**The vocabulary can grow under you.** Adding a value to a product's Color option reserves that
word retroactively, across alt text written before the value existed. That is pointed here: the
brand is Sapphire Shadow Studio, so "Sapphire" and "Shadow" are both plausible colourway names
and both are words that already belong in alt text describing the logo. Before creating a value,
grep the manifest's `alt` column for the word.

## Worked examples

| File | Alt text | Result |
|---|---|---|
| `black-crew-1.jpg` | Black crewneck, front view | Bound to Black |
| `blue-crew-1.jpg` | Navy crewneck, front view | Bound to Navy (**not** "Blue") |
| `gray-crew-2.jpg` | Gray crewneck, back view | Bound to Gray |
| `nurse-crew-1.jpg` | Nurse design embroidered on the chest | Shared (colour omitted on purpose) |
| `crew-caffeine-trauma-gray-1.jpg` | Gray crewneck with the Caffeine and Trauma design | Bound to Gray |
| `blue-crew-caffeine-trauma-1.jpg` | Navy crewneck with the Caffeine and Trauma design | Bound to Navy |
| `crew-group-1.jpg` | Three crewnecks side by side | Shared |

These are illustrative recipes, not a record of what is in Admin. The manifest's real strings are
longer and more descriptive ("Black crewneck laid flat with the CNA design and a custom name
embroidered on the chest"); they bind identically, because only the value word matters.

Note the last three: `crew-caffeine-trauma-gray-*` and `blue-crew-caffeine-trauma-*` are design
shots that **do** name a value, while `nurse-crew-*` is a design shot that **must not**. Same
visual bucket, opposite rule. The difference is whether the photo exists per colour.

## Where alt text is authored

`product-images/processed/manifest.csv` has an `alt` column. Author there first, then paste into
Admin, so that a re-upload does not silently lose the text.

Be clear about what that does and does not buy you. `product-images/` is deliberately gitignored,
binaries and manifest alike, because the CDN is these files' home. The CSV is a local authoring
convenience, not a reviewable record: it will never appear in a pull request. **Nothing in the
repo, in CI, or in a review can tell you a photo's alt text is wrong.** Admin holds the only live
copy, and this page is the only statement of the rule. Treat both accordingly.

## Failure modes, all silent

Nothing warns you. The gallery just renders differently.

| Mistake | Symptom |
|---|---|
| Alt left blank | Photo names no value, becomes shared, shows under every colour |
| Alt uses the filename's colour ("Blue") | Same: names no value, shows under every colour |
| Alt names a second value | Photo shows under two colours |
| Punctuation outside the separator list touches the value ("Navy \| front") | Names no value, goes shared |
| Color option renamed in Admin ("Colour", a stray space, or a per-product name like "Shade") | Filtering switches off **for that product only**. Every photo shows on every variant, exactly like the kill switch, with nothing in the theme editor to hint at it. More likely than any other row here |
| A value added to the option later | That word becomes reserved retroactively, across alt text written before it existed |
| Alt names a colour inside another word ("Grayscale backdrop") | Nothing. Whole-word matching handles it |

**Do not put a colour value in a product title.** Shopify falls back to the resource title when an
image has no alt text of its own: `image_tag` documents the alt attribute as "the media alt text,
or the resource title" for product images. No current product title contains a value, so this is
inert today, but a product titled "Black Friday Crewneck" could bind its untagged photos to
Black.

## Fallback ordering

Two behaviours that look like bugs and are not:

1. **A colour with no photos of its own shows the whole gallery.** The filter falls back to every
   photo rather than rendering an empty carousel. This is evaluated on the alt-matched set,
   before any variant-attached image is force-included, so attaching heroes does not disable it.
2. **The first shared photo ends that fallback.** Once any photo is shared, a colour with no
   photos of its own shows the shared photos instead of everything. So upload a colour's own
   photos before adding a group shot, or that colour drops from the full gallery to the group
   shot alone.

**Rule 1 is already inert on every product with a size chart.** `scripts/size-chart/` generates a
size-guide PNG whose alt text ("... size guide: chest, body length, and sleeve in inches and
centimeters ...") names no colour value, so it is a shared photo, so the filtered set is never
empty on that product. Rule 2 is the operative one there, and a colour with no photos of its own
gets the size chart by itself. Treat rule 1 as a backstop that mostly will not fire, not as a
safety net, and upload each colour's own photos.

The **selected** variant's attached image always survives the filter, whatever its alt text says:
an explicit binding in Admin outranks an inferred one. Only that one image, and only on its own
colour. Every other colour's hero is filtered by alt like any other photo, and with
`hide_variants: true` (set on all five product templates) the non-selected ones are hidden at
render anyway. So heroes still need correct alt text.

**Do not attach a shared photo as a hero.** If a group shot is any variant's attached image,
`hide_variants` skips it on every other colour, so it stops being shared in practice. Attach a
colour's own photo, never the group shot.
