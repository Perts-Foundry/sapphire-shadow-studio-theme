# Size chart copy

Single source of truth for size-chart wording, shared by the on-page accordion block and the
rendered PNG. Seeded verbatim from the canonical product templates; authoritative from here on.
Edit the wording between the markers only. No em dashes (U+2014) anywhere in this file.

## On-page accordion HTML (verbatim)

The exact rich-text HTML written into the `text_sc001` block. `lib/table-block.mjs` reads the
single line between the markers verbatim, so it must stay byte-for-byte identical to the live
block or the cohesion golden test will fail.

<!-- accordion-html:start -->
<p>All measurements below are of the actual garment laid flat on a hard surface, not body measurements. The best way to use this chart is to grab a sweatshirt you already own and love the fit of, lay it flat, and compare its measurements to the ones below.</p><p><strong>Choosing your size.</strong> Chest is the measurement that decides your size; body length, shoulder, and sleeve are there to confirm the fit. Between two sizes? Size up for a roomier fit or down for a closer one. No sweatshirt to compare against? Measure your chest just under your arms, then pick the size whose laid-flat chest gives you the room you like across the front. Still unsure? Contact us before you order and we'll help you choose.</p><p><strong>Chest (circumference)</strong> is the full around-the-body measurement taken just below the armpit, at the same point where the sleeve seams end and the body begins. To measure yourself, wrap a soft measuring tape around your body at that point, just under your armpit, keeping it parallel to the floor and snug but not tight. The circumference column gives you the maximum chest size the garment comfortably fits.</p><p><strong>Chest (laid flat)</strong> is the garment's chest width measured across the front only, from one side seam to the other, just below the armpit. To replicate on a sweatshirt you own, lay it flat and measure straight across at that point. This is exactly half the circumference figure.</p><p><strong>Body length</strong> is measured from the seam where the shoulder meets the sleeve, on the top of the garment, straight down to the bottom hem. To replicate, lay the garment flat, locate that junction point where the shoulder and sleeve seams meet, and measure vertically down to the hem edge.</p><p><strong>Shoulder width</strong> is measured from shoulder seam to shoulder seam straight across the back of the garment. To replicate, lay the garment flat with the back facing up and measure between the two points where the sleeve meets the body. This measurement helps if you carry your weight in your shoulders or have found that other sweatshirts pull or bunch at the arms.</p><p><strong>Sleeve length</strong> is measured from the top of the shoulder seam, the same point where shoulder width ends, down along the outside of the sleeve to the end of the cuff. To replicate, lay the sleeve flat and measure from that seam junction to the cuff edge. This tells you how far the sleeve will extend down your arm.</p><p> </p>
<!-- accordion-html:end -->

## PNG legend (JSON)

Condensed measurement definitions drawn onto the size-chart PNG. The `key` letters (A-D) label
the garment-diagram callouts and the matching table columns. `render-size-chart.mjs` reads the
JSON between the markers.

<!-- png-legend:start -->
{
  "intro": "All measurements are of the garment laid flat, not your body. Grab a sweatshirt you already love the fit of, lay it flat, and compare it to the numbers below. Chest decides your size; between two sizes, size up for room or down for a closer fit.",
  "callouts": [
    {
      "key": "A",
      "label": "Chest (laid flat)",
      "how": "Across the front, seam to seam, just below the armpit. The circumference column is double this figure."
    },
    {
      "key": "B",
      "label": "Body length",
      "how": "From the shoulder-sleeve seam straight down to the bottom hem."
    },
    {
      "key": "C",
      "label": "Shoulder width",
      "how": "Shoulder seam to shoulder seam, straight across the back."
    },
    {
      "key": "D",
      "label": "Sleeve length",
      "how": "From the shoulder seam down the outside of the sleeve to the cuff edge."
    }
  ]
}
<!-- png-legend:end -->
