# Size chart copy

The **garment-independent** prose for the on-page size-chart accordion (the `text_sc001` rich-text
block). Only wording that is true of *every* blank belongs here.

Per-measurement prose does **not** live here. It lives on each profile column's `explain`, because
what a measurement means differs per blank: a vest has no sleeve, the women's vest measures bust
rather than chest, and the quarter-zip has a front-zipper column no other blank has.
`lib/table-block.mjs` composes the final HTML as:

    intro + choosing + one <p> per column that declares `explain` + trailer

So a paragraph appears if and only if the blank has that column. There are no conditionals.

No em dashes (U+2014) anywhere in this file.

## Tokens

Regions may use exactly two tokens, substituted per profile:

| Token | Resolves to |
| --- | --- |
| `{{garment_noun}}` | the profile's `garment_noun` (`sweatshirt`, `quarter-zip`, `vest`) |
| `{{deciding_label}}` | the label of the column with `decides_size: true` (`Chest (laid flat)`, `Bust (laid flat)`) |

Tokens are **sentence-medial, lowercase, and singular**. `garment_noun` is schema-constrained to
lowercase and has no plural form, so restructure a sentence rather than capitalising or pluralising
a token. An unknown or misspelled token is never substituted and the composer throws, so a stray
`{{...}}` cannot reach the storefront.

Substitution runs over these regions only, never over a profile's `explain`. A `{{...}}` written
into `explain` is left alone and trips the same throw.

## Do not instruct a body measurement here

The intro states that every figure is the garment laid flat, not a body measurement. Telling a
shopper to measure their own body only makes sense against a column that maps a body measurement to
a size (a derived circumference, or a fits-chest range), and not every blank has one: the women's
microfleece vest has no such column at all. That guidance belongs on the relevant column's
`explain`, not in shared copy.

Never tell a shopper to halve or double a figure. That is what a profile's `derive` column is for.

## Regions

Each region is one line of rich-text HTML, read verbatim.

### Intro

<!-- accordion-intro-html:start -->
<p>All measurements below are of the actual garment laid flat on a hard surface, not body measurements. The best way to use this chart is to grab a {{garment_noun}} you already own and love the fit of, lay it flat, and compare its measurements to the ones below.</p>
<!-- accordion-intro-html:end -->

### Choosing your size

<!-- accordion-choosing-html:start -->
<p><strong>Choosing your size.</strong> {{deciding_label}} is the measurement that decides your size; the other columns are there to confirm the fit. Between two sizes? Size up for a roomier fit or down for a closer one. Still unsure? Contact us before you order and we'll help you choose.</p>
<!-- accordion-choosing-html:end -->

### Trailer

A spacer paragraph the theme's rich-text editor expects after the measurement list. The character
between the tags is a plain space, not a non-breaking space.

<!-- accordion-trailer-html:start -->
<p> </p>
<!-- accordion-trailer-html:end -->
