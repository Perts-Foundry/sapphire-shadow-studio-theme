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
| `ingest.mjs` | Copy + decode the operator's HEICs into working cells and previews, keyed by content hash + decoder version. |
| `render.mjs` | Composite the brand-styled chart pages (`--sample` for the density gate). |
| `publish.mjs` | Create / delete / reorder chart media on the live product (dry-run gated). |
| `apply-options.mjs` | Byte-stable upsert of the registry-derived dropdown into the product template. |
| `audit.mjs` | Registry vs template vs charts vs live store; `--local` for the offline subset. |
| `lib/` | Pure logic (registry, layout, crop, naming, chart-svg, options-writer, media-plan) plus the sharp (`compose`, `heic`) and network (`media`) executors. |
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
bump `chart.styleVersion`** so existing charts republish. A `heic-decode` version bump has the
same effect deliberately: decoded pixels are not guaranteed stable across versions, so the ingest
manifest keys on basename + source sha256 + decoder version, a bump re-decodes everything, hero
hashes move, and every chart republishes.

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
`node --env-file=<gitignored secrets file> scripts/applique-grid/publish.mjs`. Secret-shaped argv
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
failing) about legacy Huddle photo alts that still say Gray / Navy; that predates this module
(`scripts/lib/photo-naming.mjs` and the alt-text doc still carry the old vocabulary) and its fix
is a separate PR.

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

The decoder returns bare RGBA: the iPhone's Display P3 profile is dropped, slightly shifting
saturation. The sample gate is the acceptance check; the documented fallback is a P3-to-sRGB
matrix in `lib/heic.mjs`, which is a visual change and therefore a `styleVersion` bump.

## Tests

`npm run applique-grid:test`: node:test, no network, temp dirs only, **operator-run locally and
deliberately not wired into CI** (operator decision; CI on PRs stays as-is). The cohesion test
pins the shipped template's `pattern_options` byte-equal to the shipped registry's derived text,
except when the registry byte-equals the bootstrap sentinel; an accidentally-emptied registry
fails. Goldens (page-1 SVG, dropdown text) regen via `npm run applique-grid:golden:update`.
