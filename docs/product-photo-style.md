# Product photo style

The visual contract for product media. Two audiences, two sections: the **machine spec** is what
`scripts/enhance-product-images.mjs` targets and asserts, and what any reviewer measures a candidate
image against; the **shooting checklist** is what the person holding the phone follows so raw shots
are enhanceable at all. The spec was measured from the live catalogue's professional media
(e.g. `lead2_crew-sweater_black_cna_flat-1.jpg` on the store CDN); when this file and a live image
disagree, re-measure the live image and fix this file in a reviewed PR. No sample photos are
committed here: reference images are the live CDN URLs on the product pages themselves.

## Machine spec

Numeric targets. The enhance script asserts the REQUIRED rows on every output and refuses to write
an image that misses one; the SHOULD rows are review guidance, not assertions.

| Property | Value | Level |
|---|---|---|
| Canvas | exactly 4000x4000 px, square | REQUIRED |
| Format | JPEG, sRGB, quality 90, progressive | REQUIRED |
| Metadata | none: no EXIF, no GPS, no thumbnail; ICC tag sRGB only | REQUIRED |
| Background | pure white 255,255,255 outside the shadow zone | REQUIRED (sampled: all four 100x100 corner patches must be uniformly 255) |
| Subject margins | garment bounding box inset 8-14% of canvas per side | REQUIRED (measured on the mask the script computed) |
| Centering | bounding-box centre within 2% of canvas centre, both axes | REQUIRED |
| Contact shadow | soft, retained, confined to the shadow-exempt zone | SHOULD |
| Shadow-exempt zone | pixels within 3% of canvas width of the garment mask edge; only there may background pixels be non-255 | REQUIRED (outside it, background is 255) |
| Exposure | backdrop lifted to white without clipping garment detail; black fleece retains visible texture (garment luminance p5 above 8/255) | SHOULD |
| Edges | no halo: no ring of grey or colour fringing along the garment silhouette at 100% zoom | SHOULD (human/model review at full zoom) |

Orientation: flat-lay, garment upright (collar up), front facing. One garment per product-bound
shot; group shots follow the same canvas and background rules.

## Shooting checklist (phone, white backdrop)

Follow this at capture time; a shot that fails a DISQUALIFIER cannot be rescued by the enhance
pass and should be reshot on the spot.

- White backdrop only, garment fully inside it: no floor, table edge, or backdrop seam in frame.
- Even, diffuse light (indirect daylight or two soft sources). Avoid a single hard light from one
  side; a soft natural shadow around the garment is good, a hard directional one is not.
- Shoot square-on from directly above the flat-lay, phone parallel to the surface.
- Leave generous room around the garment (rough thirds: garment fills the middle); the crop is
  computed later, tight framing cannot be undone.
- Main camera, no zoom, no flash, no filters, no Portrait mode.
- Smooth the garment before shooting; the pipeline does not remove wrinkles.

DISQUALIFIERS (reshoot; the enhance pass will flag, not fix):

- Blown highlights on the garment or deep clipped blacks with no texture.
- A strong colour cast the backdrop white-balance cannot neutralise (mixed light sources).
- Any part of the garment touching or leaving the frame edge.
- Motion blur or missed focus.
- Objects, hands, feet, or pets in frame (unless the shot is deliberately a styled shot, which
  follows its own art direction and is out of scope for the enhance pass).
