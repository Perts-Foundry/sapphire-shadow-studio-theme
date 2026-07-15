# scripts/size-chart/

Deterministic tooling that turns one blank-garment profile into two cohesive size-chart outputs: a
branded PNG for the product gallery, and the on-page Size Chart accordion row in a product template.
Like the rest of `scripts/`, this is **not** part of the Shopify theme; the Shopify CLI only pushes
recognized theme directories, so nothing here reaches the live theme. The `size-chart` Claude skill
(`.claude/skills/size-chart/`) drives this tooling; you can also run it by hand.

## Source of truth

`profiles/<blank_id>.json` holds the canonical measurements for one blank, in **inches**:

```json
{
  "blank_id": "crewneck-fleece",
  "display_name": "Unisex Crewneck Fleece",
  "unit": "in",
  "sizes": ["XS", "S", "M", "L", "XL", "2XL"],
  "measurements": {
    "chest_circumference": [38.5, 43.5, 45.5, 49, 54, 58],
    "body_length":         [24.5, 25, 25.75, 27, 27.75, 28],
    "shoulder_width":      [19.5, 22, 23, 25, 27.5, 29],
    "sleeve_length":       [22, 22.5, 23, 23.5, 24, 24.5]
  },
  "handles": ["product-handle-a", "product-handle-b"]
}
```

Chest **laid-flat** is derived (circumference / 2); centimetres are derived from each inch value
independently and rounded to 0.1 cm (ties up, trailing `.0` stripped) to match the storefront's
existing formatting. `handles` is the blank -> products mapping that drives fan-out. The prose (the
on-page accordion HTML and the PNG legend) lives once in `copy.md`.

## Render the PNG

```bash
npm ci   # once, for sharp
node scripts/size-chart/render-size-chart.mjs --profile crewneck-fleece
```

Builds the navy/sapphire SVG (`lib/render-svg.mjs`) and rasterises it to
`product-images/processed/size-chart-<blank_id>.png` at 3200x4000 via sharp. The bundled Inter font
(`fonts/Inter.ttf`, SIL OFL, license in `fonts/OFL.txt`) is registered through a runtime fontconfig
file, because librsvg resolves fonts through fontconfig and ignores `@font-face` embedding.

Output lands in the gitignored `product-images/processed/` (no image binaries enter this public
repo). The command prints the alt text to set on manual upload. It does **not** upload to Shopify;
the Admin token is themes-only and the MCP has no media upload, so upload is manual in Shopify Admin.

Options: `--out <path>` (must be under `product-images/`), `--out-dir <dir>`, `--scale <n>` (default
2, i.e. 2x the 1600x2000 canvas).

## Insert the on-page block

```bash
git switch -c size-chart/<handle> origin/main
node scripts/size-chart/apply-size-chart.mjs --profile crewneck-fleece   # or --handle <h>
npx shopify theme check
```

Upserts `accordion_row_sc001` (a `text` block + the `table` block) into each product template listed
in the profile's `handles`, just after the Product Details row. The write is **byte-stable** (a full
parse + `JSON.stringify(obj, null, 2)` round-trip reproduces Shopify's exact on-disk format, so the
diff is only the added row plus one `block_order` line) and **idempotent** (re-running changes
nothing). Before touching a file it runs `git fetch` and refuses if `shopify-sync` carries an
in-flight Admin edit to that template not yet reconciled to `main`; reconcile first
(`git merge origin/shopify-sync`) then re-run. Pass `--no-guard` to skip that check.

It never commits, pushes, opens a PR, or comments `deploy`; that stays your step.

## Tests

```bash
npm run size-chart:test   # node --test over the pure-logic + writer + render-smoke suites
```

The suite covers unit conversion against the known seed numbers, profile validation (including
rejection of transcription swaps and out-of-range values), a byte-for-byte cohesion golden against
the live template row, template-writer idempotency and byte-stability, and a render smoke check. CI
runs it via `.github/workflows/size-chart-tests.yml` only when `scripts/size-chart/**` changes; it is
intentionally not a required check, so operator tooling never gates a theme deploy.
