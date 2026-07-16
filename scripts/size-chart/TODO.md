# Size-chart backlog

Follow-ups from the customer-needs vs. size-chart gap analysis (2026-07-14). Shared wording lives in
`copy.md`; per-garment data lives in `profiles/<blank>.json`; the on-page accordion block and the PNG
both regenerate from those. See `README.md` for the tooling. Importance (imp) is 1 (nice-to-have) to
5 (decisive for choosing a size / avoiding a wrong-size order).

## Done (branch `size-chart/tooling`)

- **"Choosing your size" guidance** in both the accordion (`copy.md` accordion-html) and the PNG
  intro: chest is the deciding measurement; between-sizes tie-breaker (size up for room, down for a
  closer fit); a no-reference-garment path (measure your chest, pick the laid-flat width you like);
  and a "contact us before you order" help line. Garment independent, so it lives once in `copy.md`
  and applies to every blank. Templates regenerated via `apply-size-chart.mjs`; cohesion golden
  tests stay green.

- **Column-driven generalisation.** Profiles now declare their own ordered `columns` (role + kind +
  authored heading/how + optional `derive`), pick a `garment` silhouette (crewneck / quarter-zip /
  vest, with a no-diagram fallback). The on-page accordion golden stays byte-identical. The
  quarter-zip and both microfleece vests are onboarded (PNG only; on-page insertion waits until those
  products exist in Shopify).

- **Vertical-rhythm pass on the PNG.** Tightened the top whitespace (the wordmark sat too low), and
  the canvas height is now derived from content + a fixed bottom margin so every garment gets matching
  top/bottom whitespace (`canvas_height` becomes an optional override). Each garment declares its own
  collar-crown extent (`garmentTop` in `garments.mjs`), and the diagram + legend are co-centred with
  the taller of the two seated a fixed gap below the "Start here" panel. So the garment always reads
  as centred within the diagram/legend band: the tall quarter-zip / vest stand collars no longer
  overlap the panel, and the 4-callout quarter-zip diagram drops to stay centred in its taller legend
  (instead of the legend clamping upward, which left the diagram sitting too high). The SVG render
  golden was regenerated for the new spacing; the on-page cohesion golden is unaffected.

## High priority

- [ ] **Per-garment fit descriptor (imp 5).** Do NOT hardcode in `copy.md`; fit differs per blank.
  Make it a dynamic question the skill asks per garment at onboarding, stored in a new profile `fit`
  object (e.g. `{ "cut": "true-to-size" | "relaxed" | "oversized", "note": "..." }`), rendered at the
  top of the accordion and in the PNG intro band. This also carries the **unisex-to-women's
  size-down direction (imp 5)**, since which way to size depends on the cut. Steps: (1) extend
  `lib/profile-schema.mjs` with an optional `fit` object; (2) render it in `lib/table-block.mjs`
  (accordion) and `lib/render-svg.mjs` (PNG); (3) add a "gather fit character" step to
  `.claude/skills/size-chart/SKILL.md` with the true-to-size / relaxed / oversized prompt; (4) fill
  `fit` in `profiles/crewneck-fleece.json` once the operator confirms how the fleece wears.

- [ ] **Size-guide link at the size selector (imp 4).** The chart is only reachable via the Size
  Chart accordion below the buy buttons; nothing sits next to the variant/size picker where the size
  decision happens. Add a small "Size guide" link/anchor beside the variant-picker that opens or
  scrolls to the accordion. Theme-level change (variant-picker / product-details), outside the
  current tooling; could optionally be emitted by `apply-size-chart.mjs`.

- [ ] **Fabric & care block (imp 4/3).** Add an optional `fabric` object to the profile schema
  (`pre_shrunk` bool + `care` string + weight / composition / stretch) and render a compact
  "Fabric & care" line beneath the table in both outputs. Pre-shrunk status is the one fabric fact
  with a direct sizing consequence on a non-returnable garment (buy-measured vs. size-up). The
  current blank is confirmed "premium 8 oz. heavyweight fleece" (live product descriptions); tie any
  shrink figure to the real fiber content, not a cotton default. Consider whether weight/composition
  belong on the product description instead.

- [ ] **Body-chest to size lookup (imp 4).** For shoppers without a reference garment: an optional
  per-size recommended body-chest range in the profile, rendered as a companion column or a small
  "which size fits your chest" lookup. The no-reference prose added above is the cheap interim; this
  is the fuller version. Keep ease tied to the confirmed fit descriptor.

## Medium / polish

- [ ] **Table accessibility (imp 3).** In `blocks/table.liquid`, make each data row's first cell a
  `<th scope="row">` (currently a `<td>`) and add a `<caption>` / `<figcaption>` naming the chart.
  Already a semantic table with `<th scope="col">` headers; this closes the remaining gap.

- [ ] **Torso-drop descriptor (imp 3).** Plain-language note on where the (long) body length lands,
  framed for shorter and women wearers. Rides the fit-descriptor copy; no new field.

- [ ] **Body-length start-point note (imp 2).** The shipped crewneck copy measures body length from
  the high point of the shoulder (HPS); the vests measure "at back" (`body_length_back`) with their
  own definition. If a future blank's manufacturer measures from the shoulder-sleeve seam instead,
  spell that out in that column's `how` text so a shopper comparing charts is not thrown by a shorter
  number.

## Intentionally excluded (operator decision, 2026-07-14)

- **Returns / exchange line in the chart:** handled by the return-policy-acknowledgment block near
  the buy buttons. Do not duplicate in the size chart.
- **Made-by-hand measurement-tolerance line:** skipped.
- **Model / on-body fit reference photo (imp 4):** photography / merchandising task, out of tooling
  scope. Add a "model is X tall, wears M" gallery caption when on-body shots exist.
- **Aggregate runs-small / true / large review subscore (imp 3):** cold-start; revisit once review
  volume exists.
- **No-tape string-and-ruler fallback (imp 3):** redundant with the "measure a top you already own"
  method that is already the primary instruction.
- **Pre-purchase / add-to-cart size nudge (imp 2):** covered by the existing
  return-policy-acknowledgment block; avoid extra checkout friction.
