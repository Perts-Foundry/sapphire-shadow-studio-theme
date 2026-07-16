# Size chart copy

Single source of truth for the on-page size-chart accordion prose (the `text_sc001` rich-text
block). Seeded verbatim from the canonical product templates; authoritative from here on. Edit the
wording between the markers only. No em dashes (U+2014) anywhere in this file. The PNG's how-to
panel and lettered measurement callouts are per-profile now; they live in each profile's `how_to`
and `columns`, not here.

## On-page accordion HTML (verbatim)

The exact rich-text HTML written into the `text_sc001` block. `lib/table-block.mjs` reads the
single line between the markers verbatim, so it must stay byte-for-byte identical to the live
block or the cohesion golden test will fail.

<!-- accordion-html:start -->
<p>All measurements below are of the actual garment laid flat on a hard surface, not body measurements. The best way to use this chart is to grab a sweatshirt you already own and love the fit of, lay it flat, and compare its measurements to the ones below.</p><p><strong>Choosing your size.</strong> Chest is the measurement that decides your size; body length and sleeve are there to confirm the fit. Between two sizes? Size up for a roomier fit or down for a closer one. No sweatshirt to compare against? Measure your chest just under your arms, then pick the size whose laid-flat chest gives you the room you like across the front. Still unsure? Contact us before you order and we'll help you choose.</p><p><strong>Chest (circumference)</strong> is the full around-the-body measurement taken just below the armpit, at the same point where the sleeve seams end and the body begins. To measure yourself, wrap a soft measuring tape around your body at that point, just under your armpit, keeping it parallel to the floor and snug but not tight. The circumference column gives you the maximum chest size the garment comfortably fits.</p><p><strong>Chest (laid flat)</strong> is the garment's chest width measured across the front only, from one side seam to the other, about an inch below the armhole. To replicate on a sweatshirt you own, lay it flat and measure straight across at that point. This is exactly half the circumference figure.</p><p><strong>Body length</strong> is measured from the highest point of the shoulder, right next to the collar, straight down to the bottom hem. To replicate, lay the garment flat, find the highest point of the shoulder next to the neck, and measure vertically down to the hem edge.</p><p><strong>Sleeve length</strong> is measured from the center of the back of the neck, across the shoulder, and down the outside of the sleeve to the end of the cuff, including the cuff ribbing. To replicate, lay the garment flat and measure from the center back neck out to the cuff edge. Measure your own sweatshirt the same way so the numbers line up.</p><p> </p>
<!-- accordion-html:end -->
