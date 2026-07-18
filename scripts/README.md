# scripts/

Operational tooling for the theme. These scripts are **not** part of the Shopify theme; the
Shopify CLI only pushes recognized theme directories, so nothing here reaches the live theme.

- `process-product-images.mjs` (below): normalise names and batch-process raw product photos into
  upload-ready JPEGs plus a `manifest.csv`.
- `upload-product-media.mjs` (below): upload the processed photos to Shopify and set their alt text
  via the Admin API (the live-write step; gated, one product at a time).
- `lib/photo-naming.mjs`: the machine-readable naming convention plus the product / colour maps, read
  by both scripts. One source of truth.
- `size-chart/`: generate the branded size-chart PNG and insert the on-page Size Chart block from
  a per-blank profile. See [`size-chart/README.md`](size-chart/README.md).

The `product-images` Claude skill (`.claude/skills/product-images/`) drives the whole pipeline end to
end (normalise, process, draft alt text, upload) with human-approval gates; these scripts are what it
runs.

## process-product-images.mjs

Batch-processes raw product photos into Shopify-upload-ready JPEGs plus a `manifest.csv`, so they
clear Shopify's upload limits and render well in this theme. It **reads** your originals and writes
copies; originals are only modified under the explicit opt-in `--rename-originals` (below).

Upload is a separate step: either `upload-product-media.mjs` (below) or the Admin UI. `manifest.csv`
is the mapping aid and the place you author alt text; a reprocess **preserves** the `alt` and
`upload_status` columns you have filled in.

### The naming convention

Source filenames follow this shape (underscore-separated fields, multi-word values hyphenated
internally, the shot carrying a `-<index>`):

```
<line>_<garment>_<colorway>[_<design>]_<shot>-<index>.jpg
group shot:  <line>_<garment>_group_<shot>-<index>.jpg
```

| Field | Values (closed sets are extensible in `lib/photo-naming.mjs`) |
| --- | --- |
| line | `huddle`, `lead2`, `shift-fuel` |
| garment | `crew-sweater`, `quarter-zip`, `vest` |
| colorway | `black`, `classic-navy`, `grey-heather`, `group` (group-shot marker) |
| design | open profession token (`rn`, `cna`, `emt`, `medic`, `vet-tech`, ...); optional |
| shot | `angled`, `closeup`, `flat`, `styled` |

The processor parses these fields, warns (never blocks) on anything that does not match, and emits the
canonical **output** name in the same underscore-separated form as the source (one scheme end to end,
including the uploaded Shopify filename): `lead2_quarter-zip_black_emt_flat-1.jpg` stays
`lead2_quarter-zip_black_emt_flat-1.jpg`, and an all-hyphen source like
`lead2-quarter-zip-black-emt-flat-1.jpg` is recovered to it. It also resolves each file to its product handle and its
Admin **Color** value and records them in the manifest, because alt text on this store binds a photo
to a colour (see `docs/product-media-alt-text.md`). The colorway token maps to the Admin value:
`black` -> `Black`, `classic-navy` -> `Navy`, `grey-heather` -> `Gray`, `group` -> shared (no value).
Note the women's vest is `Black`-only, a deliberate divergence encoded in the module.

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
- Names each output by the convention above, fixes the `caffine` -> `caffeine` misspelling and the
  `quarterzip` -> `quarter-zip` typo, and de-duplicates any name collisions with a numeric suffix
  (recorded in the manifest).
- Does **not** convert to WebP/AVIF, Shopify's CDN does that on delivery.

Outputs land in `product-images/processed/`. All of `product-images/` is gitignored, so no image
binaries or the manifest enter this public repo.

### The alt-colour guard

Because alt text drives the gallery colour filter, the processor validates the manifest's `alt`
column against the reserved-colour rule (`docs/product-media-alt-text.md`): every non-group photo's
alt must name **exactly one** recognized Color value for its product, and it must be that photo's own
colour; a group/shared photo must name none. Violations are printed by `--dry-run`, `--verify`, and a
normal run, and block the uploader. The guard only checks rows whose `alt` you have authored.

### Usage

```bash
# 0. Install dependencies (sharp) once:
npm ci

# 1. Put the finished photos in product-images/originals/ (or point --input-dir at your source
#    folder). Paths with spaces are fine.

# 2. Preview the canonical names, resolved product/colour, warnings, and guard problems:
node scripts/process-product-images.mjs --dry-run

# 3. Process (--clean wipes stale outputs from a previous run first; alt/upload_status are preserved):
node scripts/process-product-images.mjs --clean

# 4. Re-check the output against every Shopify cap, invariant, and the alt-colour guard:
node scripts/process-product-images.mjs --verify

# 5. (Optional, opt-in) rename the *originals* to their canonical underscore names. Preview first:
node scripts/process-product-images.mjs --rename-originals --rename-only --dry-run
node scripts/process-product-images.mjs --rename-originals --rename-only        # apply
```

### Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--input-dir <dir>` | `product-images/originals` | Source folder (can be an absolute path). `--in` is a back-compat alias. |
| `--out <dir>` | `product-images/processed` | Output folder. Must be under a `product-images/` path (guards against writing unignored binaries into the repo). |
| `--max <px>` | `4000` | Max long-edge in pixels. |
| `--quality <n>` | `85` | JPEG quality (1-100). 88-90 is reasonable for archival masters. |
| `--clean` | off | Delete the output folder before writing (avoids stale orphans). Still preserves `alt` / `upload_status` from the prior manifest. |
| `--dry-run` | off | Print the plan (names, resolution, warnings, guard), write nothing. |
| `--verify` | off | Validate an existing output folder and manifest; non-zero exit on any failure. |
| `--rename-originals` | off | Opt-in: rename source files to their canonical **underscore** names in place. Skips any file that did not parse with confidence, writes a reversible `rename-log.csv`, no-op for already-canonical names. |
| `--rename-only` | off | With `--rename-originals`, do only the rename and skip processing. |

Accepted inputs: `.jpg .jpeg .png .tif .tiff`. Anything else (e.g. HEIC) is skipped with a
warning and logged in the manifest.

## upload-product-media.mjs

Uploads the processed photos to Shopify and sets their alt text, from `manifest.csv`, via the Admin
GraphQL API. This is the only tool here that writes to the **live** store, so it is deliberately
cautious.

- **Scopes.** Needs `write_products` **and** `write_files`. It mints a token at runtime from
  `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` (never printed, never committed) and checks both
  scopes before doing anything; if either is missing it stops and you upload manually in Admin.
- **One product first.** You must pass `--product <handle>` (or `--all` to opt into every product);
  `--limit <n>` caps the count. There is no implicit "upload everything".
- **Dry-run first.** `--dry-run` resolves IDs, verifies the recorded product GID and Color option
  values still match the live store (it fails loudly on drift), runs the alt-colour guard, prints the
  per-image plan, and writes nothing.
- **Duplication-proof.** Before creating media it queries the product's existing media and skips any
  whose alt or source filename already matches, so a re-run (or a regenerated manifest) does not
  create duplicates. A re-run only updates alt text where it changed.
- **Bounded.** It creates product media, sets/updates alt text, and (only with `--attach-heroes`)
  appends a per-colour variant hero. It never deletes media and never edits other product fields.

```bash
# Verify the plan for one product (read-only):
node scripts/upload-product-media.mjs --product lead-ii-crewneck --dry-run

# Apply to that one product, then check the storefront colour filter before doing more:
node scripts/upload-product-media.mjs --product lead-ii-crewneck

# Later, once one product is confirmed correct, a bulk run:
node scripts/upload-product-media.mjs --all
```

After a single-product upload, open the storefront and confirm that selecting each colour shows the
right photos. That colour binding is the alt-text filter, and nothing in the repo or CI can verify it
for you.

### Manual alternative: upload in Shopify Admin

If you prefer the Admin UI (or the scopes are not granted):

1. Drag-drop the files from `product-images/processed/` onto each product.
2. Set the strongest shot as the **featured image** (it shows on collection cards and the
   homepage product list). Put size charts last (the size-chart PNG is produced by
   `size-chart/render-size-chart.mjs`).
3. Fill **alt text** on every image, using the manifest's `alt` column. On this theme alt text is not
   only accessibility text: it is what swaps the gallery on colour selection. A photo whose alt names
   the selected Color option value shows for that colour; a photo naming no value is shared across
   every colour. **Read `docs/product-media-alt-text.md` before writing any of it.** The trap in one
   line: the navy photos are named `blue-*.jpg` / `classic-navy`, and alt text must follow the Admin
   option value (`Navy`), not the filename.
4. Optionally attach one hero image per colour to that colour's variants. This does **not** drive
   the gallery: Shopify caps a variant at one attached media, so attachment can express one hero
   per colour and never "all three black photos", which is why the gallery reads alt text
   instead. It is still worth doing, because `variant.image` drives cart line-item thumbnails and
   collection cards, which the gallery filter never touches. Do not attach a shared photo (a
   group shot) as a hero: `hide_variants` then hides it from every other colour.
