# scripts/

Operational tooling for the theme. These scripts are **not** part of the Shopify theme; the
Shopify CLI only pushes recognized theme directories, so nothing here reaches the live theme.

- `process-product-images.mjs` (below): batch-process raw product photos for manual upload.
- `size-chart/`: generate the branded size-chart PNG and insert the on-page Size Chart block from
  a per-blank profile. See [`size-chart/README.md`](size-chart/README.md).

## process-product-images.mjs

Batch-processes raw product photos into Shopify-upload-ready JPEGs plus a `manifest.csv`, so
they clear Shopify's upload limits and render well in this theme. It **reads** your originals
and writes copies; originals are never modified.

It does **not** upload to Shopify. The Shopify MCP has no media-upload capability and the Admin
token in this repo is themes-only, so upload and per-variant image assignment are done manually
in Shopify Admin. `manifest.csv` is your mapping aid.

### What it does per image

- Downscales to **<= 4000 px on the long edge** (preserving aspect ratio, never enlarging). The
  theme's product gallery requests images up to `width: 3840`, and 4000 px keeps every result
  under Shopify's **20-megapixel** upload cap.
- Re-encodes to **JPEG, mozjpeg, quality 85, chroma subsampling 4:4:4**. 4:4:4 (not the default
  4:2:0) preserves the edges of fine coloured embroidery text.
- **Colour-managed to true sRGB:** honours each source's **embedded** colour profile and
  gamut-maps to sRGB (many phone/camera exports are Display P3 or Adobe RGB; an 8-bit JPEG's
  reported colourspace is not a reliable signal, so the embedded profile is used). The correct
  colour is baked into sRGB pixels, so it survives Shopify's CDN re-encode even if the profile
  is dropped. A source with no profile is assumed to be sRGB.
- **Strips EXIF/GPS** (smaller files; removes any camera geolocation before the copy leaves your
  machine), after baking in EXIF orientation.
- Renames to **lowercase kebab-case** (`Black Crew 1.jpg` -> `black-crew-1.jpg`), fixes the
  `caffine` -> `caffeine` misspelling, and de-duplicates any name collisions with a numeric
  suffix (recorded in the manifest).
- Does **not** convert to WebP/AVIF, Shopify's CDN does that on delivery.

Outputs land in `product-images/processed/` (both `product-images/raw/` and
`product-images/processed/` are gitignored, so no image binaries enter this public repo).

### Usage

```bash
# 0. Install dependencies (sharp) once:
npm ci

# 1. Put the raw photos in product-images/raw/ (or point --in at your source folder).
#    Paths with spaces are fine.

# 2. Preview the planned renames / collisions without writing anything:
node scripts/process-product-images.mjs --dry-run

# 3. Process (--clean wipes stale outputs from a previous run first):
node scripts/process-product-images.mjs --clean

# 4. Re-check the output against every Shopify cap and invariant:
node scripts/process-product-images.mjs --verify
```

### Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--in <dir>` | `product-images/raw` | Source folder (can be an absolute path, e.g. `<downloads-dir>`). |
| `--out <dir>` | `product-images/processed` | Output folder. Must be under a `product-images/` path (guards against writing unignored binaries into the repo). |
| `--max <px>` | `4000` | Max long-edge in pixels. |
| `--quality <n>` | `85` | JPEG quality (1-100). 88-90 is reasonable for archival masters. |
| `--clean` | off | Delete the output folder before writing (avoids stale orphans). |
| `--dry-run` | off | Print the plan, write nothing. |
| `--verify` | off | Validate an existing output folder; non-zero exit on any failure. |

Accepted inputs: `.jpg .jpeg .png .tif .tiff`. Anything else (e.g. HEIC) is skipped with a
warning and logged in the manifest.

### After processing: upload in Shopify Admin

1. Drag-drop the files from `product-images/processed/` onto each product.
2. Set the strongest shot as the **featured image** (it shows on collection cards and the
   homepage product list). Put size charts last (the size-chart PNG is produced by
   `size-chart/render-size-chart.mjs`).
3. Fill **alt text** on every image, drafting in the manifest's `alt` column first. On this theme
   alt text is not only accessibility text: it is what swaps the gallery on colour selection. A
   photo whose alt names the selected Color option value shows for that colour; a photo naming no
   value is shared across every colour. **Read `docs/product-media-alt-text.md` before writing
   any of it.** The rules are not guessable, both failure directions are silent, and nothing in
   the repo or CI can catch a mistake. The trap in one line: the navy photos are named
   `blue-*.jpg`, and alt text must follow the Admin option value, not the filename.
4. Optionally attach one hero image per colour to that colour's variants. This does **not** drive
   the gallery: Shopify caps a variant at one attached media, so attachment can express one hero
   per colour and never "all three black photos", which is why the gallery reads alt text
   instead. It is still worth doing, because `variant.image` drives cart line-item thumbnails and
   collection cards, which the gallery filter never touches. Do not attach a shared photo (a
   group shot) as a hero: `hide_variants` then hides it from every other colour.
