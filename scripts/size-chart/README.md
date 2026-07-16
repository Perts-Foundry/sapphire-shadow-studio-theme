# scripts/size-chart/

Deterministic tooling that turns one blank-garment profile into two cohesive size-chart outputs: a
branded PNG for the product gallery, and the on-page Size Chart accordion row in a product template.
Like the rest of `scripts/`, this is **not** part of the Shopify theme; the Shopify CLI only pushes
recognized theme directories, so nothing here reaches the live theme. The `size-chart` Claude skill
(`.claude/skills/size-chart/`) drives this tooling; you can also run it by hand.

## Source of truth

`profiles/<blank_id>.json` describes one blank. It is **column-driven**: the profile declares its own
ordered `columns`, so any garment (crewneck, quarter-zip, vest, ...) renders from the same engine. All
stored measurements are in **inches**.

```jsonc
{
  "blank_id": "quarter-zip-midweight",     // kebab-case; neutral, never a supplier SKU
  "display_name": "Midweight Quarter Zip", // brand-facing; renders on the public PNG + alt text
  "unit": "in",
  "garment": "quarter-zip",                // crewneck | quarter-zip | vest | null (no diagram)
  "garment_noun": "quarter-zip",           // how a shopper says it; substituted into copy.md's prose
  "sizes": ["XS", "S", "M", "L", "XL", "2XL"],   // up to 6
  "columns": [                             // up to 6, in table order
    { "role": "size", "heading": "Size", "kind": "label" },
    { "role": "chest_laid_flat", "heading": "Chest (laid flat)", "kind": "measure",
      "values": [19.5, 20, 22, 23.5, 25.5, 26.5],
      "badge": "A", "callout_label": "Chest (laid flat)",
      "how": "Across the front, ...",      // one terse line for the PNG legend
      "explain": "is the garment's chest width measured across ...", // 2-3 sentences for the accordion
      "decides_size": true },              // exactly one column, store-wide
    { "role": "chest_circumference", "heading": "Chest (circumference)", "kind": "measure",
      "derive": { "from": "chest_laid_flat", "factor": 2 },
      "explain": "is the full around-the-body measurement ..." },
    { "role": "front_zipper", "heading": "Front Zipper", "kind": "measure",
      "values": [8, 8, 8, 8, 8, 8.5], "badge": "D", "how": "The length of the front zip ...",
      "explain": "is the length of the front zip placket ..." }
  ],
  "how_to": { "eyebrow": "Start here", "heading": "...", "note": "...", "steps": [ ... ] },
  "footer": "Measurements are of the garment laid flat. ...",
  "canvas_height": 2280,                   // optional override; omit to auto-size (height derived from
                                           // content + a fixed margin). If pinned, buildSvg throws on overflow.
  "handles": ["huddle-crewneck"]           // alternate-template suffixes, NOT Shopify product handles:
                                           // each one is interpolated into templates/product.<suffix>.json.
                                           // Empty until that template exists. A suffix with no matching
                                           // template is skipped, and the run still exits 0.
}
```

- **Column `kind`**: `label` (the size column; renders `sizes`), `measure` (a number, shown dual-unit
  `<inch>" / <cm> cm`), `range` (a `[lo, hi]` pair, shown `lo-hi"`, e.g. a body-chest fit range), and
  `string` (an arbitrary label like a numeric size `4/6`).
- **`derive`** computes a measure column from another by role: `{ from, factor }`. The crewneck stores
  circumference and derives laid-flat (factor `0.5`); the quarter-zip stores laid-flat and derives
  circumference (factor `2`).
- **`role`** is the engine tag: it drives the schema's per-role sane-range + monotonicity check
  (`lib/profile-schema.mjs`) and binds a badge to a garment-diagram anchor (chest / body / sleeve /
  zipper) in `lib/render-svg.mjs`. Known roles: `size`, `size_numeric`, `chest_circumference`,
  `chest_laid_flat`, `bust`, `body_length_hps`, `body_length_back`, `sleeve_cb`, `front_zipper`,
  `body_chest_range`.
- Centimetres are derived from each inch value independently and rounded to 0.1 cm (ties up, trailing
  `.0` stripped) to match the storefront's existing formatting.
- **`how` vs `explain`** are two registers of the same fact, and both are authored per column. `how`
  is one terse line for the PNG legend; `explain` is 2-3 sentences for the on-page accordion. Write
  both; do not reuse one for the other. A test asserts `how` never leaks into the accordion.
- **`decides_size`** marks the single column that decides a shopper's size, and is what
  `{{deciding_label}}` resolves to in `copy.md`. Exactly one column per profile. It is a
  merchandising claim rather than a measurement fact, so the skill gates it on operator confirmation.
- The garment silhouettes live in `lib/garments.mjs`.

### On-page prose is composed, not stored

`copy.md` holds only the **garment-independent** framing. Per-measurement prose lives on each
column's `explain`. `lib/table-block.mjs` assembles:

    intro + choosing + one <p> per column that declares `explain` + trailer

so a measurement is explained if and only if the blank has that column. The vests get no sleeve
paragraph and the quarter-zip gets a zipper one, with no conditionals. Two tokens (`{{garment_noun}}`
and `{{deciding_label}}`) are substituted into the `copy.md` regions only, never into `explain`; an
unresolved `{{...}}` throws rather than reaching the storefront. See `copy.md`'s header for the token
contract.

## Render the PNG

```bash
npm ci   # once, for sharp
node scripts/size-chart/render-size-chart.mjs --profile quarter-zip-midweight
```

Builds the navy/sapphire SVG (`lib/render-svg.mjs` + `lib/garments.mjs`) and rasterises it to
`product-images/processed/size-chart-<blank_id>.png` via sharp. The canvas is `1600` wide; the height
is auto-derived from the content plus a fixed top/bottom margin (so every garment gets matching
whitespace) unless a profile pins `canvas_height`. Rendered at 2x by default, so a chart is `3200`
wide by roughly `4300-4700` tall depending on the legend and table. The bundled
Inter font (`fonts/Inter.ttf`, SIL OFL, license in `fonts/OFL.txt`) is registered through a runtime
fontconfig file, because librsvg resolves fonts through fontconfig and ignores `@font-face` embedding.

Output lands in the gitignored `product-images/processed/` (no image binaries enter this public
repo). The command prints the alt text to set on manual upload. It does **not** upload to Shopify;
the Admin token is themes-only and the MCP has no media upload, so upload is manual in Shopify Admin.

Options: `--out <path>` (must be under `product-images/`), `--out-dir <dir>`, `--scale <n>` (default 2).

## Insert the on-page block

```bash
git switch -c size-chart/<topic> origin/main
node scripts/size-chart/apply-size-chart.mjs --profile crewneck-fleece   # or --handle <h>
npx shopify theme check
```

Upserts `accordion_row_sc001` (a `text` block + the `table` block) into each product template listed
in the profile's `handles`, just after the Product Details row. The table's `column_count`, headings,
and cells all come from the profile's `columns`. The write is **byte-stable** (a full parse +
`JSON.stringify(obj, null, 2)` round-trip reproduces Shopify's exact on-disk format, so the diff is
only the added row) and **idempotent** (re-running changes nothing). Before touching a file it runs
`git fetch` and refuses if `shopify-sync` carries an in-flight Admin edit to that template not yet
reconciled to `main`; reconcile first (`git merge origin/shopify-sync`) then re-run. Pass `--no-guard`
to skip that check.

It never commits, pushes, opens a PR, or comments `deploy`; that stays your step.

## Tests

```bash
npm run size-chart:test   # node --test over the pure-logic + writer + render suites
```

The suite covers unit conversion (tie round-up, trailing-`.0` strip, independent laid-flat cm),
column-driven `deriveRows` (measure / derive / range / string kinds), profile validation (per-role
ranges, transcription swaps, range/string rejection paths), a byte-for-byte cohesion golden of the
on-page row against the live template, an environment-independent **SVG golden** of the crewneck PNG
(so the canonical SS3000 design cannot silently change), the canvas overflow guard, template-writer
idempotency / byte-stability, the sync-guard decision, and a render smoke check. Run it locally before
committing changes to this tooling. It also runs in CI as the `Size chart tests` step of
`validate.yml`, so a red suite blocks the PR. That is deliberate despite this being operator tooling
rather than shipped theme code: the suite owns the on-page size-chart prose, and its cohesion goldens
assert that generated output still matches the shipped product templates. That invariant is only
worth something if something enforces it.

The render smoke check hard-fails in CI when `sharp` cannot be imported, rather than skipping as it
does locally. A skip there would leave the run green with rasterisation coverage silently gone, which
is the failure this gate exists to close.
