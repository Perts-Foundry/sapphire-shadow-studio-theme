# applique-grid

Deterministic tooling behind the `applique-grid` Claude skill
(`.claude/skills/applique-grid/`): it turns the operator's applique fabric photos into the Huddle
Crewneck's numbered pattern chart gallery images and keeps the product-page dropdown, the live
media, and the committed registry in agreement.

One committed source of truth drives everything: **`patterns.json`** (the registry). The chart
images, the dropdown text, the published-media record, and the audit all derive from it. The
skill is the human-gated glue; these scripts are the machinery, and none of them commits, pushes,
or opens a PR.

## Layout

| Path | What |
| --- | --- |
| `patterns.json` | Committed registry: product snapshot, thread palette, chart params, patterns, published record. Ships as the empty bootstrap sentinel; the first skill run populates it. |
| `ingest.mjs` | Copy + decode the operator's HEICs into colour-managed working cells and previews, keyed by content hash + decoder version + colour-transform version. |
| `render.mjs` | Composite the brand-styled chart pages (`--sample` for the density gate). |
| `publish.mjs` | Create / delete / reorder chart media on the live product (dry-run gated). |
| `apply-options.mjs` | Byte-stable upsert of the registry-derived dropdown into the product template. |
| `audit.mjs` | Registry vs template vs charts vs live store; `--local` for the offline subset. |
| `lib/` | Pure logic (registry, layout, crop, naming, chart-svg, options-writer, media-plan) plus the sharp (`compose`, `heic`) and network (`media`) executors. `lib/heic.mjs` wraps the shared `scripts/lib/heic.mjs`: it keeps `planIngest` and owns this pipeline's colour handling (see Colour below). |
| `test/` | `npm run applique-grid:test`; goldens regen via `npm run applique-grid:golden:update`. |

Image output and manifests are guarded to gitignored `product-images/` paths; binaries never
enter git, and manifests store **basenames only** (a dev-machine path is sensitive content in
this public repo; the originals dir is a runtime `--source` flag and nothing else).

## The registry

- `product` is a committed snapshot (handle, GID, Color option values). Networked runs fetch the
  live values and fail loudly on mismatch. After any snapshot update, the colour guard re-runs
  over ALL active names; a new conflict re-opens the naming gate and is never resolved by editing
  the snapshot back.
- Pattern `name`s must whole-word-match **zero** Color values under the exact storefront
  semantics (`scripts/lib/photo-naming.mjs`'s `matchedColorValues`, the same function the alt
  guard wraps). Thread words never enter alt text, so a `black` thread is legal while a name
  containing `Black` is refused. Charset is word characters plus the guard's separator set; em
  and en dashes are rejected outright (an en dash would carry a colour word past the whole-word
  guard).
- `position` orders active patterns; numbering derives from that order on every regeneration
  (discontinued rows keep their history but no number). Positions are assigned as confirmed-order
  x 10 so later inserts need no renumbering, but any mid-order insert still renumbers everything
  after it, which changes those charts' spec hashes and republishes them. Chatty, correct,
  expected.
- `crop` is normalized on the decoded hero photo. Working cells and previews are straight
  downscales of the decoded photo, so the same normalized box applies to all of them 1:1; that
  invariant is what lets the operator confirm a crop on a preview and have it hold on the
  full-resolution composite.
- `published` is written back by `publish.mjs`: per chart, the filename the API actually
  returned, the media GID, the alt, and the spec hash. Recorded GIDs are the **primary**
  identification for later replace / delete; the filename + alt convention is only the fallback
  for unrecorded media, and anything matching just one signal is a suspect that is reported and
  never touched.

## Spec hashes and filenames

Every chart filename embeds the first 8 hex chars of its spec hash
(`<handle>-applique-pattern-chart-<n>-of-<total>-<hash8>.jpg`). The spec covers the page's
patterns (number, id, name, thread, hero content hash, crop), every grid param, and
`styleVersion`. **Any visual change to the renderer (palette, font, geometry, ICC handling) must
bump `chart.styleVersion`** so existing charts republish.

Two separate mechanisms, and it is worth being precise about which one does what, because they look
interchangeable and are not:

- The **ingest manifest key** (basename + source sha256 + decoder version + colour-transform
  version) decides what gets **re-decoded**. A `heic-decode` bump or a colour-transform change
  re-decodes every photo, because neither one's output pixels are stable across the change.
- The **spec hash** decides what gets **republished**. Its "hero content hash" is the sha256 of the
  SOURCE photo, not of the decoded cell, so a re-decode alone moves nothing: fresh pixels land in
  the cells, the spec hash stays put, and `publish.mjs` sees no work to do. `styleVersion` is the
  only lever that republishes charts whose source photos have not changed, which is why a decoder
  bump and a colour change both need one.

Charts are sized by `width_units x scale` with content-derived height; `render.mjs` hard-fails
above Shopify's 20-megapixel cap and suggests a reduced `--scale`.

## Publishing model

`publish.mjs --dry-run` computes the full plan (creates with verbatim alts and filenames, deletes
with reasons, suspects, final gallery order), snapshots the live media list to the gitignored
output dir, and stores the plan bound to a hash of the live media state. The live run requires
that stored plan, refuses if live state moved, and consumes it either way; a retry always starts
from a fresh dry-run and a fresh operator gate.

Execution order is a contract: creates (alt set at create) -> readiness barrier (every create
READY with verified alt) -> deletes -> reorder to a contiguous gallery tail in page order. A
failed barrier skips deletes and reorder, prints the surviving plan, and exits non-zero; the
extra-charts state is ugly but recoverable, a chartless product page is not. Media attached to
any variant is refused for deletion regardless of signals (charts must never be variant heroes:
`hide_variants` would un-share them; see `docs/product-media-alt-text.md`). Non-chart media
relative order is never disturbed.

Credentials come from the environment; run live steps as
`node --env-file=.env scripts/applique-grid/publish.mjs` (the repo-root `.env` is the standard,
gitignored secrets file; see [`../README.md`](../README.md) > Credentials). Secret-shaped argv
options are refused by name, the shop domain is a compile-time constant asserted at startup, and
the shared Admin client (`scripts/blank-inventory/lib/admin.mjs`) redacts the token from every
error. Required scopes: `write_products` + `write_files`, verified each run; a passing scope
check is capability, not authorization.

## apply-options.mjs warning semantics

The dropdown derives from the registry alone, so `apply-options.mjs` works on a fresh clone with
no image artifacts. It WARNS (never blocks) when the registry's `published` record does not match
the registry-derived chart alts: that means the live chart images and the dropdown will disagree
until `publish.mjs` runs, which is the expected transient state mid-pipeline (the run-type
ordering in SKILL.md chooses which surface moves first). An empty `published` with active
patterns gets the same warning.

## Audit

`audit.mjs --local` (registry schema, template vs derived text, charts manifest vs spec hashes)
tolerates mid-pipeline staleness: STALE lines exit 0, structural FAILs exit non-zero. The full
`audit.mjs` treats STALE as drift and exits non-zero: green means registry, template, rendered
charts, published record, live media, alts, and gallery order all agree. It also WARNs (without
failing) about legacy Huddle photo alts that still say Gray / Navy; that predates this module. The
repo-side vocabulary is now reconciled (`scripts/lib/photo-naming.mjs` and the alt-text doc record
`Black` / `Grey Heather` / `Classic Navy`), so the remaining drift is live media alts in Admin, and
it is fixed there rather than in the repo.

**The audit has no scheduled trigger.** It is an operator-run backstop; a green test suite says
nothing about live state, because nothing in the repo or CI can see the store.

## Dependency notes

`heic-decode` is pinned exactly (with its WASM carrier `libheif-js` resolved through the
lockfile) because sharp 0.35.3's libvips cannot decode the iPhone's tiled HEICs ("bad seek";
verified against all 46 launch photos) while heic-decode decodes 46/46. Both packages were
verified to declare **no install scripts** at the pinned versions; re-verify on any bump
(`npm view <pkg> scripts`), and expect the bump to republish every chart (see above). Licensing:
heic-decode is MIT; libheif-js ships a WASM build of libheif (LGPL-3.0), used here unmodified as
a local dev tool, which is compatible with this repo; nothing from it ships to the storefront.

## Colour

The decoder returns bare RGBA with the container's embedded profile dropped, so the decoded numbers
are Display P3 values that every downstream tool reads as sRGB, which renders the fabric duller than
it is (the operator reported the orange dot print as "more orange in person"). The shared
`decodeToSrgb` re-attaches the file's OWN profile and converts to real sRGB, so cells and previews
carry the photo's original colour baked into sRGB pixels. Ingest prints what it read per run
("46 x Display P3 -> sRGB"), and a photo carrying no ICC profile is passed through unconverted and
WARNED about rather than guessed at.

The per-file profile is used rather than a hardcoded Display P3 matrix. Measured against the 46
launch photos the two agree to within 1/255 per channel, because all 46 carry Apple's Display P3
profile and that matrix is exactly its conversion; the difference only shows up on a source that is
not P3 (other hardware, an Adobe RGB export, a settings change), where a hardcoded matrix would
mis-convert silently. Full reasoning, and why the transform needs a hand-written PNG iCCP chunk
(sharp's `withIccProfile` on raw input converts INTO the profile instead of tagging with it), is in
`scripts/lib/heic.mjs`'s header.

The transform itself lives in that shared module, and `lib/heic.mjs` here re-exports it. It was
this module's own for exactly one commit: the product-images pipeline turned out to carry the same
`withIccProfile`-tags-raw-input bug, and the only alternative to sharing was a second hand-rolled
CRC-32 and iCCP writer drifting away from this one. What is still this module's is the POLICY
around it: what the version keys mean, and that ingest bakes the converted pixels into cells and
strips the profile (product-images keeps an sRGB profile on its output instead). A change to the
shared transform's output pixels is a change to this pipeline's cells, whatever motivated it, so
it must bump `COLOR_TRANSFORM_VERSION` and `chart.styleVersion` here.

Two version keys guard it, and both are load-bearing. `COLOR_TRANSFORM_VERSION` is part of every
ingest-manifest key, so a change to the transform re-decodes every photo instead of skipping cells
that still hold the old colour. Spec hashes cover the SOURCE photo hash, not cell pixels, so a
colour change must ALSO bump `chart.styleVersion` or no chart ever republishes. Change one without
the other and the pipeline goes quiet in exactly the wrong way.

## Tests

`npm run applique-grid:test`: node:test, no network, temp dirs only, and **gated in CI on every
PR** (a step in `validate.yml`, with the same zero-tests guard as the other tooling suites). The
cohesion test pins the shipped template's `pattern_options` byte-equal to the shipped registry's
derived text, except when the registry byte-equals the bootstrap sentinel; an
accidentally-emptied registry fails. That is a cross-file invariant between two committed
artifacts, so CI is what makes it real: a PR that edits the template or the registry alone goes
red. Goldens (page-1 SVG, dropdown text) regen via `npm run applique-grid:golden:update`.
