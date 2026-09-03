# scripts/

Operational tooling for the theme. These scripts are **not** part of the Shopify theme; the
Shopify CLI only pushes recognized theme directories, so nothing here reaches the live theme.

- `process-product-images.mjs` (below): normalise names and batch-process raw product photos into
  upload-ready JPEGs plus a `manifest.csv`.
- `upload-product-media.mjs` (below): upload the processed photos to Shopify and set their alt text
  via the Admin API (the live-write step; gated, one product at a time).
- `contact-sheet.mjs` (below): render labeled thumbnail grids from a folder of photos, so a review
  round reads one composite per couple dozen frames instead of every frame full-size.
- `lib/photo-naming.mjs`: the machine-readable naming convention plus the product / colour lookups,
  read by the pipeline scripts and by the applique-grid naming guard. The vocabulary itself (lines,
  colour tokens, and the product census with every title, GID and colour list) is DERIVED from
  `catalogue.json` via `createNaming(manifest)`; the one table still hand-authored here is
  `BODY_PHOTO_TOKEN`, the body-id to filename-token map, because filename tokens are already printed
  on files on disk and cannot follow a manifest rename.
- `lib/catalogue-manifest.mjs`: the schema, the validators and the derived accessors for the root
  `catalogue.json`. It lives here rather than under `blank-inventory/lib/` because seven areas read
  it, and leaving it there gave all of them a load-time dependency on the blank-inventory planner,
  one module from `lib/mutations.mjs`. It imports exactly two zero-import leaves,
  `lib/vocab.mjs` (`normaliseAxis`, the one normalisation rule every option axis shares) and
  `lib/json-keys.mjs` (`findDuplicateKeys`, over raw JSON text). `blank-inventory/lib/groups.mjs`
  and `blank-inventory/lib/reorder.mjs` re-export those two names permanently, so their own callers
  are unaffected.
- `lib/catalogue-cohesion.mjs`: the checks that compare `catalogue.json` against every other
  repo-side surface restating any of its vocabulary. Run by the catalogue lint; offline, read-only.
- `lib/import-closure.mjs`: test support. Walks a module's transitive relative-import graph, so the
  "this module can never reach a mutation" guards assert the whole closure rather than one direct
  edge. Fails loudly on any specifier form a static walk cannot follow.
- `lib/heic.mjs`: the shared iPhone-HEIC decoder (`decodeToRaw`, `sharpFromRaw`, `DECODER_VERSION`,
  `extractIcc`) **and** the one colour transform all three pipelines use: `decodeToSrgb`, on top of
  `embedIccProfile` (a hand-written PNG `iCCP` chunk, the tagging step sharp does not offer) and
  `profileDescription`. Read by `process-product-images.mjs` and `contact-sheet.mjs`, and
  re-exported by `applique-grid/lib/heic.mjs`. It lives here because the alternative is two
  hand-rolled CRC-32s drifting apart; what still differs per pipeline is downstream (the product
  pipeline keeps an sRGB profile on its output JPEG, applique-grid bakes and strips). Change the
  transform's output pixels and you must bump `applique-grid`'s `COLOR_TRANSFORM_VERSION` with it.
- `lib/heic.fixtures.mjs`: test-only Display P3 fixtures shared by `lib/heic.test.mjs` and
  `process-product-images.test.mjs`, so both discriminate a real conversion from a no-op the same
  way. Not collected by `node --test` and not imported by any production module.
- `size-chart/`: generate the branded size-chart PNG and insert the on-page Size Chart block from
  a per-blank profile. See [`size-chart/README.md`](size-chart/README.md).
- `blank-inventory/`: update shared-blank stock and the `custom.inventory_blank_sku` variant
  metafield, cooperating with the inventory-sync Flow. Writes to the **live store**, through gated
  plan artifacts. See [`blank-inventory/README.md`](blank-inventory/README.md).
- `sku/`: derive, audit and apply variant SKUs from committed code tables. Writes to the **live
  store** through gated, hashed plan artifacts. Driven by the `sku` Claude skill. See
  [`sku/README.md`](sku/README.md) and [`../docs/sku-scheme.md`](../docs/sku-scheme.md). Orthogonal
  to `blank-inventory/`: a SKU identifies the finished piece, `custom.inventory_blank_sku` the
  shared blank garment.
- `catalogue/`: the offline lint for the root `catalogue.json`, the committed manifest declaring the
  option axis names, the colour and size vocabulary with each value's Admin spelling, which garment
  bodies exist and what each is made in, and the complete product census. Read-only, no credentials;
  it reuses `lib/catalogue-manifest.mjs` so one schema serves both the lint and the reorder review,
  and it runs `lib/catalogue-cohesion.mjs` so a private copy of that vocabulary cannot drift back
  into another tool. The manifest is hand-edited by the operator in a reviewed PR; no command and no
  agent creates or edits it. `npm run catalogue:lint` and `npm run catalogue:test`.
- `site-check/`: the operator-run whole-site sanity test (storefront probe with a cleared session
  cart, read-only Admin config reads, repo cross-checks, a clean-env runner for the existing
  tools, the Tier C run file), driven by the `site-check` skill. See
  [`site-check/README.md`](site-check/README.md).
- `seo-review/`: read-only SEO regression checks (storefront crawl, anonymous public-surface
  check, Admin stored-field audit) with baseline diffing. Driven by the `seo-review` Claude
  skill. See [`seo-review/README.md`](seo-review/README.md).
- `applique-grid/`: turn applique fabric photos into the Huddle Crewneck's numbered pattern
  chart gallery images and keep the pattern dropdown, the live media, and the committed registry
  (`applique-grid/patterns.json`) in agreement. Writes to the **live store** through gated
  dry-run plans. Driven by the `applique-grid` Claude skill. See
  [`applique-grid/README.md`](applique-grid/README.md).
- `policies/`: status, check, pull, restamp, verify and push the five shop policies tracked at
  `marketing/policies/`. **`status.mjs` is the entry point**: offline, it says which state each
  policy is in and names the one command that leaves it. `check.mjs` is **offline and CI-safe** and
  proves only that the repo agrees with itself, which is green in the merged-but-not-pushed state;
  `restamp.mjs` is offline too and recomputes the derived manifest fields plus each stamped body's
  version stamp after a deliberate local wording edit; `pull.mjs` reads through the read-only Admin
  client and refuses to overwrite a dirty or repo-ahead body; `verify.mjs` asserts what the live
  bodies say, against sentence sets that are refused when stale; `push.mjs` writes a legal policy on
  the **live store** behind nine gates (writable type, not CI, TTY or an explicit operator
  attestation, clean check, clean tree, HEAD merged, freshness against the machine-local observation
  state, the monotonic version floor, a dry run, a verified out-of-tree backup) and fails closed on
  `userErrors`, which `shopPolicyUpdate` returns with HTTP 200. Every comparison runs on the CORE
  body with the version stamp stripped from both sides. See
  [`../marketing/policies/README.md`](../marketing/policies/README.md).
- `email-icons/`: render the social icons the Shopify Email templates use, and upload them to
  Shopify Files. Email clients cannot render SVG, so the theme's own inline icons are copied as
  path data, rasterised to committed PNGs under `marketing/emails/assets/`, and hosted on the CDN.
  The uploader writes to the **live store** (Files only, one file per explicit `--upload` flag, and
  never an overwrite). Rationale and the resulting CDN URLs:
  [`../marketing/emails/README.md`](../marketing/emails/README.md).

The `product-images` Claude skill (`.claude/skills/product-images/`) drives the whole pipeline end to
end (normalise, process, draft alt text, upload) with human-approval gates; these scripts are what it
runs.

## Credentials

Every script here that reaches the Admin API reads its credentials from the environment, and the
standard place to keep them is a **`.env` file at the repo root**, passed explicitly:

```bash
node --env-file=.env scripts/<tool>.mjs
```

```
MYSHOPIFY_DOMAIN=<store>.myshopify.com
SHOPIFY_CLIENT_ID=<custom app client id>
SHOPIFY_CLIENT_SECRET=<custom app client secret>
STOREFRONT_PASSWORD=<storefront password, while the store is locked>
```

`scripts/policies/pull.mjs` and `push.mjs` need the three Shopify variables above and nothing else;
the app must grant `read_legal_policies`, and `push.mjs` also `write_legal_policies` (both asserted
at runtime, never assumed). `policies:check` needs no credentials at all, and a test asserts it runs
clean with all three deleted from the environment. Optional, policies only: `POLICIES_BACKUP_DIR`
(pre-push backups, default `~/.local/state/shop-policies`) and `POLICIES_STATE_DIR` (the
observation state, default `~/.local/state/shop-policies/state`). Two separate overrides on
purpose: sharing one would let a "delete old backups" action take the freshness baseline with it.

`STOREFRONT_PASSWORD` is read only by the storefront-facing tools (`site-check/probe.mjs`,
`site-check/tools.mjs`, `seo-review/crawl.mjs`, the a11y cookie helper); they also accept
`STORE_PW`, which wins when both are set. Delete it at public launch. Optional, site-check only:
`SITE_CHECK_STATE_DIR` (baseline dir, default `~/.local/state/site-check`), `LIVE_THEME_ID` and
`BASE_URL` (a preview run).

`.env.example` records those names with no values. Rules that go with it:

- **`.env` is gitignored** (`.env`, `.env.*`, except `.env.example`). This repo is public; a
  committed credential is a rotation event, not a cleanup.
- **Never on argv.** The Admin token is minted at runtime by exchanging the client id/secret, is
  redacted from logs and errors, and is never written to a manifest, plan artifact, or commit.
  `applique-grid/publish.mjs` refuses secret-shaped flags outright.
- `--env-file` is deliberately explicit rather than auto-loaded, so a live-write tool cannot pick
  up credentials by accident.

## process-product-images.mjs

Batch-processes raw product photos into Shopify-upload-ready JPEGs plus a `manifest.csv`, so they
clear Shopify's upload limits and render well in this theme. It **reads** your originals and writes
copies; originals are only modified under the explicit opt-in `--rename-originals` (below).

Upload is a separate step: either `upload-product-media.mjs` (below) or the Admin UI. `manifest.csv`
is the mapping aid and the place you author alt text; a reprocess **preserves** the `alt` and
`upload_status` columns you have filled in.

**Shared assets (one file, several products).** A product-agnostic photo (a logo tag close-up,
packaging, a studio scene) sits outside the naming convention under a plain descriptive kebab name;
the processor emits its manifest row with an empty `product`. To publish it on several products,
duplicate that row by hand, one copy per target product handle, keeping `admin_color` empty and the
alt colour-free (the `product-images` skill drives this). A reprocess preserves the duplicated rows
per (name, product), each keeping its own `alt` and `upload_status`, and the uploader treats each
row as one create on that row's product. Deleting or renaming the source file drops its rows on the
next reprocess; re-add them with the file.

### The naming convention

Source filenames follow this shape (underscore-separated fields, multi-word values hyphenated
internally, the shot carrying a `-<index>`):

```
<line>_<garment>_<colorway>[_<design>]_<shot>-<index>.jpg
group shot:  <line>_<garment>_group_<shot>-<index>.jpg
```

| Field | Values (the closed sets are derived from `catalogue.json`; extend it, not this table) |
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
`black` -> `Black`, `classic-navy` -> `Classic Navy`, `grey-heather` -> `Grey Heather`, `group` ->
shared (no value). Note the women's vest is `Black`-only, a deliberate divergence encoded in the
module.

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
  is dropped. A source with no profile is assumed to be sRGB. A file sharp can open (JPEG / PNG /
  TIFF) is converted during the encode, from the profile libvips imports with the file; a HEIC
  arrives from the WASM decoder as bare untagged pixels, so it is converted up front by the shared
  `decodeToSrgb` and reaches the encode already in sRGB.
- **Strips EXIF/GPS** (smaller files; removes any camera geolocation before the copy leaves your
  machine), after baking in EXIF orientation.
- Names each output by the convention above, fixes the `caffine` -> `caffeine` misspelling and the
  `quarterzip` -> `quarter-zip` typo, and de-duplicates any name collisions with a numeric suffix
  (recorded in the manifest).
- Does **not** convert to WebP/AVIF, Shopify's CDN does that on delivery.

Outputs land in `product-images/processed/` (or a timestamped `product-images/processed/<timestamp>/`
subfolder with `--new-batch`). All of `product-images/` is gitignored, so no image binaries or the
manifest enter this public repo.

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

# 5b. For originals the parser cannot confidently name, apply an operator-approved from,to map
#     (each target is re-validated as a clean convention name). Preview, then apply:
node scripts/process-product-images.mjs --rename-map approved-names.csv --rename-only --dry-run
node scripts/process-product-images.mjs --rename-map approved-names.csv --rename-only          # apply
```

### Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--input-dir <dir>` | `product-images/originals` | Source folder (can be an absolute path). `--in` is a back-compat alias. |
| `--out <dir>` | `product-images/processed` | Output folder. Must be under a `product-images/` path (guards against writing unignored binaries into the repo). |
| `--new-batch` | off | Write this run into a fresh timestamped `product-images/processed/<timestamp>/` folder (images + `manifest.csv`) and print the paths, so re-running later never clobbers an earlier batch. Cannot be combined with `--out` / `--manifest`; pass the printed `--out` / `--manifest` to the run's later steps. |
| `--manifest <path>` | `<out>/manifest.csv` | Manifest file to read (for preserved `alt` / `upload_status`) and write. Point it elsewhere to keep more than one manifest. |
| `--max <px>` | `4000` | Max long-edge in pixels. |
| `--quality <n>` | `85` | JPEG quality (1-100). 88-90 is reasonable for archival masters. |
| `--clean` | off | Delete the output folder before writing (avoids stale orphans). Still preserves `alt` / `upload_status` from the prior manifest. |
| `--dry-run` | off | Print the plan (names, resolution, warnings, guard), write nothing. |
| `--verify` | off | Validate an existing output folder and manifest; non-zero exit on any failure. |
| `--rename-originals` | off | Opt-in: rename source files to their canonical **underscore** names in place. Skips any file that did not parse with confidence, writes a reversible `rename-log.csv`, no-op for already-canonical names. |
| `--rename-only` | off | With `--rename-originals`, do only the rename and skip processing. |
| `--rename-map <csv>` | none | Apply operator-approved names to originals the parser could not confidently name. A CSV with `from,to` columns; each `to` is normalised and must resolve to a clean convention name (an unknown token, a missing field, or a missing index is refused, never renamed). Implies `--rename-originals`; the map wins over the auto name for a listed file. The verified guess is composed and approved by the operator upstream (the `product-images` skill); the script only applies the explicit map and never guesses. |

Accepted inputs: `.jpg .jpeg .png .tif .tiff .heic`. An iPhone `.heic` is decoded through the
heic-decode WASM bridge (`lib/heic.mjs`; sharp's libvips cannot read the tiled iPhone HEICs), which
drops the container's profile, so `decodeToSrgb` re-attaches the file's **own** extracted profile
and converts to sRGB before the encode sees a pixel; the manifest note names the profile it came
from (`Display P3 -> sRGB`). When no profile exists the notes record an assuming-sRGB warning
instead (distinguishing "nclx colour info present, ICC absent" from no colour info at all), and the
pixels are left exactly as decoded rather than guessed at. `.heif` is **not** accepted (unverified). Anything else is skipped with a
warning and logged in the manifest. NTFS alternate-data-stream sidecars (a `name:Zone.Identifier`
entry beside a file downloaded on Windows, visible on WSL) are ignored silently: no warning, no
manifest row.

Convention note: any new top-level `scripts/*.test.mjs` file automatically joins the `images:test`
suite (its npm script globs one level of `scripts/`), so a new script's tests need no CI wiring,
and every script it imports must guard its CLI entrypoint with the `pathToFileURL` check the
existing scripts use, or importing it from a test would run it.

`--verify` also warns when a row's `upload_status` column holds prose rather than a short status
token; that usually means an unquoted comma in a hand-edited `alt` overflowed into the next column
and truncated the alt. It is a warning, not a failure: re-quote the alt and reprocess.

## contact-sheet.mjs

Renders labeled thumbnail grids (24 frames per sheet, 4 columns by default) from a folder of
photos. Read-only over the inputs; writes only the sheet JPEGs, and only under a `product-images/`
path (the same containment guard as the processor, so nothing unignored lands in the repo). Labels
are file basenames, middle-truncated to fit.

```bash
node scripts/contact-sheet.mjs --input-dir 'product-images/originals'
node scripts/contact-sheet.mjs --input-dir '<dir>' --out 'product-images/contact-sheets' --columns 4 --cell 480
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--input-dir <dir>` | `product-images/originals` | Source folder. |
| `--out <dir>` | `product-images/contact-sheets` | Output folder. Must be under a `product-images/` path. |
| `--columns <n>` | `4` | Thumbnails per row. Positive integer. |
| `--cell <px>` | `480` | Thumbnail box in pixels. Integer >= 64. |

Accepted inputs: `.jpg .jpeg .png .tif .tiff .heic`, matching the processor, so an untouched iPhone
batch can be reviewed before anything is processed. HEIC frames go through the same `decodeToSrgb`
the processor uses, so a sheet the operator picks photos from is not duller than the photos
themselves. 24 frames per sheet is a fixed constant, not a flag; more frames roll onto
`contact-sheet-2.jpg` and so on. There is no `--dry-run`.

## upload-product-media.mjs

Uploads the processed photos to Shopify and sets their alt text, from `manifest.csv`, via the Admin
GraphQL API. This is the only tool here that writes to the **live** store, so it is deliberately
cautious.

- **Scopes.** Needs `write_products` **and** `write_files`. It mints a token at runtime from
  `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` (never printed, never committed) and checks both
  scopes before doing anything; if either is missing it stops and you upload manually in Admin.
- **Scope is explicit.** You must pass `--all` (every product in the manifest) or `--product <handle>`
  (one product); `--limit <n>` caps the count. There is no implicit "upload everything". The skill's
  default flow reviews an `--all --dry-run` for the whole batch and then writes `--all`; a single
  `--product` write is a safe subset of that reviewed plan if you want to go one product at a time.
- **`--manifest <path>`** overrides the default `product-images/processed/manifest.csv`; the processed
  images are read from the manifest's own directory, so a relocated manifest and its images stay
  together.
- **Preflight without a manifest.** `--check-products` is a standalone read-only mode: it resolves
  every garment product `catalogue.json` declares against the live store and reports per-product
  `ok` (with the live Color values) or the GID / Color-option drift that would hard-fail an upload,
  labelling an auth/scope failure (`AUTH`) distinctly from drift (`DRIFT`). It refuses to combine
  with `--product`, `--all`, `--dry-run`, or `--manifest`, and exits non-zero on any product error.
  Run it before naming or processing a batch, so an upload blocker surfaces in minute two rather
  than at the end of the pipeline.
- **Dry-run first.** `--dry-run` resolves IDs, verifies the recorded product GID and Color option
  values still match the live store (it fails loudly on drift), runs the alt-colour guard, prints the
  per-image plan, and writes nothing.
- **Duplication-proof.** Before creating media it queries the product's existing media and skips any
  whose alt or source filename already matches, so a re-run (or a regenerated manifest) does not
  create duplicates. A re-run only updates alt text where it changed.
- **Bounded.** It creates product media, sets/updates alt text, and (only with `--attach-heroes`)
  appends a per-colour variant hero. It never deletes media and never edits other product fields.

```bash
# Preflight (read-only, no manifest needed): confirm every recorded product still matches the
# live store before spending any effort on a batch:
node scripts/upload-product-media.mjs --check-products

# Review the whole batch's per-image plan against the live store (read-only), pointing at the
# batch manifest that --new-batch produced:
node scripts/upload-product-media.mjs --all --dry-run --manifest 'product-images/processed/<timestamp>/manifest.csv'

# On approval, write the whole batch, then check the storefront colour filter:
node scripts/upload-product-media.mjs --all --manifest 'product-images/processed/<timestamp>/manifest.csv'

# Or, to write one product at a time (a safe subset of the reviewed --all plan):
node scripts/upload-product-media.mjs --product lead-ii-crewneck --manifest 'product-images/processed/<timestamp>/manifest.csv'
```

After an upload, open the storefront and confirm that selecting each colour shows the right photos.
That colour binding is the alt-text filter, and nothing in the repo or CI can verify it for you.

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
   option value (`Classic Navy`), not the filename; a bare "Navy" names no value at all.
4. Optionally attach one hero image per colour to that colour's variants. This does **not** drive
   the gallery: Shopify caps a variant at one attached media, so attachment can express one hero
   per colour and never "all three black photos", which is why the gallery reads alt text
   instead. It is still worth doing, because `variant.image` drives cart line-item thumbnails and
   collection cards, which the gallery filter never touches. Do not attach a shared photo (a
   group shot) as a hero: `hide_variants` then hides it from every other colour.
