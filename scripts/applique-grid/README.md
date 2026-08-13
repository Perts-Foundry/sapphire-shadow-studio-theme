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
| `patterns.json` | Committed registry: product snapshot, thread palette, chart params, optional gallery pins, patterns, published record. Ships as the empty bootstrap sentinel; the first skill run populates it. |
| `ingest.mjs` | Copy + decode the operator's HEICs into colour-managed working cells and previews, keyed by content hash + decoder version + colour-transform version. |
| `crops.mjs` | The crop workbench: propose a fabric-region box per photo, preview one exactly as the chart will render it, sheet all the proposals for one-glance review, overlay a coordinate grid, screen confirmed crops for backdrop contamination, emit test fixtures. |
| `draft.mjs` | The naming gate's working draft, and the only tool that writes the pattern block of `patterns.json`. |
| `render.mjs` | Composite the brand-styled chart pages (`--sample` for the density gate). |
| `publish.mjs` | Create / delete / reorder chart media on the live product (dry-run gated). |
| `apply-options.mjs` | Byte-stable upsert of the registry-derived dropdown into the product template. |
| `audit.mjs` | Registry vs template vs charts vs live store; `--local` for the offline subset. |
| `lib/` | Pure logic (registry, layout, crop, autocrop, naming, chart-svg, options-writer, media-plan, draft, artifacts, text-diff, review-dir, out-dir, atomic-write) plus the sharp (`compose`, `heic`) and network (`media`) executors. `lib/heic.mjs` wraps the shared `scripts/lib/heic.mjs`: it keeps `planIngest` and owns this pipeline's colour handling (see Colour below). |

Two cross-module dependencies, so a signature change in either is a break here: `lib/heic.mjs`
wraps `scripts/lib/heic.mjs`, and `crops.mjs --sheet` calls `planSheet` / `renderSheet` from
`scripts/contact-sheet.mjs`. Those two exports are a shared API, not private helpers.
| `test/` | `npm run applique-grid:test`; goldens regen via `npm run applique-grid:golden:update`. |

**Flags are authoritative in `--help`.** All seven entry points answer it, and `test/help.test.mjs`
fails if a flag the parser accepts is missing from that text (which is how `--force` came to be
documented nowhere). This file explains behaviour; `--help` enumerates options.

Image output and manifests are guarded to gitignored `product-images/` paths; binaries never
enter git, and manifests store **basenames only** (a dev-machine path is sensitive content in
this public repo; the originals dir is a runtime `--source` flag and nothing else). The working
files the naming gate produces (`draft.json`, `grouping-ledger.md`, `gate-table.md`,
`contact-sheets/`, `crop-*/`, `last-converged-audit.json`) live there too and are covered by the
root-anchored `/product-images/` ignore.

## Working files and precedence

Three things describe pipeline state, and they can disagree:

| File | Role | Authority |
| --- | --- | --- |
| `product-images/applique/draft.json` | the decisions | **authoritative** |
| `product-images/applique/grouping-ledger.md` | per-photo notes, rationale, observed fabric text | human-readable only |
| `audit.mjs --local` output | which step you are on | step pointer only |

On disagreement the draft wins and the ledger is corrected. The `.md` extension diverges from the
sibling skill's `selection-ledger.txt` deliberately: this ledger is a table.

`APPLIQUE_REVIEW_DIR`, when set, receives a copy of every REVIEW image the crop tooling writes
(`--preview`, `--grid`, `--sheet`; `--emit-fixture` writes to the repo's own test fixtures and is
deliberately not copied). It is the only write in this module that lands outside a
`product-images/` path, so it has its own guard: it must be absolute, an existing directory, with
no `..` segment, and must resolve outside the repo working tree **after symlink resolution**. That
last clause is load-bearing: the shape check is lexical, so a link whose own path is outside the
tree but which points into it used to pass, and review images landed in the public working tree.
Unset is a silent no-op. Only the count copied is printed; the resolved value is a dev-machine path
and never reaches stdout, `gate-table.md`, the ledger, a commit, or a PR.

```bash
export APPLIQUE_REVIEW_DIR=<your-review-dir>
```

## The crop workbench

`crops.mjs --propose` detects the fabric region and returns a normalized square box per photo. The
algorithm (`lib/autocrop.mjs`, pure) is: greyscale local standard deviation via summed-area tables
plus a saturation channel, each cue normalized by its own **floored** 95th percentile, box-mean
smoothing at radius 8 so sparse motifs fill their neighbourhood before thresholding, plain Otsu,
erosion, largest inscribed square on a 200x200 work grid (a square there is a 3:4 box on the
1200x1600 cell), then a 5 percent inset.

Three of those are load-bearing rather than incidental, and each is pinned by a differential test
that runs the case twice, once with the constant neutralized:

- **The percentile floors.** On an achromatic print the saturation p95 is chroma noise; dividing by
  it makes noise the dominant cue and the proposal stops tracking the fabric. The floors also power
  the absolute-signal guard that returns the null sentinel on a frame with nothing in it.
- **No Otsu cap.** `Math.min(otsu, 0.18)` was tried and reverted: it lowers the threshold under a
  cream print's slightly-off-cream tabletop, and the box classifies the entire frame as fabric.
  `otsuCap` exists only as an injectable parameter defaulting to null so the test can drive the
  known-bad value. Do not set it.
- **The smoothing radius.** At radius 1 the mask thresholds to confetti holding almost no square;
  at radius 4 the square is still materially smaller. A single-run assertion cannot tell 8 from 4,
  which is why the test runs both.

An unresolvable image returns **null**, which the gate table renders as "manual crop required". A
plausible-looking wrong box is worse than an admitted failure.

`--preview` renders one crop through `lib/compose.mjs`'s `prepareCellForBox`, the same function
`render.mjs` composites with, and a test asserts the bytes match. That is the only thing standing
between the gate and a false approval, so do not inline `coverCrop` + `prepareCell` at either call
site again.

`--sheet` renders every proposed crop into contact sheets (via `planSheet` / `renderSheet` from
`scripts/contact-sheet.mjs`), so the crop review round reads `ceil(N / 24)` images rather than N.
Use it first, then `--preview` the individual boxes that the sheet leaves in doubt.

`--grid <hero>` overlays a 0.05-step coordinate grid on one photo, which is what makes a hand-nudged
box a reading rather than a guess. Note the collision: `render.mjs --grid` takes a `CxR` density and
is a different thing entirely.

`--scan` screens a confirmed crop for backdrop contamination: 10x10 tiles of luminance standard
deviation, flagged when the minimum tile falls below 10. It splits into `tileStats` (needs pixels)
and `classifyTiles` (pure), so the gate can run it before any registry exists and CI can run it
against committed matrices with no photos on disk. `render.mjs` runs the same exported function as
a non-fatal pre-flight. It is a **screen, never an oracle**: calibrated against the 18 launch
crops it reproduced both operator reports exactly and false-positived once on a genuinely flat
cream stripe.

`--emit-fixture` regenerates the committed test fixtures from the local photo tree: four archetype
cells reduced to the work grid by the same box-average the algorithm applies (so a fixture
reproduces the full-resolution proposal rather than approximating it), the real 18 crops' tile
matrices, and known-bad corner crops. Each records a source basename and content hash, never a
path.

## The draft

`draft.json` is the naming gate's record and the resume point across a session boundary, and
`draft.mjs` is the only tool that writes the pattern block of `patterns.json`.

- `--init-from-registry` imports the committed registry into a draft. It is also the resume path
  for a run interrupted after the registry write.
- `--validate` assembles a candidate registry, runs the real `validate()`, prints problems, writes
  nothing. It also prints the distinct thread list with usage counts and singletons marked, which
  is how near-duplicate threads are found: mechanically, from a list, not by eye. Consolidating a
  thread on an existing pattern changes its spec hash and republishes that chart.
- `--table` prints the narrow `Key | A | B | C | D | E | F` choice table and writes the wide
  `gate-table.md` verification table, both stamped with a digest of exactly the subset rendered.
  Rows are keyed by hero filename stem, never an ordinal, because a merge or re-sort silently
  repoints an ordinal.
- `--write` MERGES the draft's `threads` and `patterns` into `patterns.json`. `published`, `chart`,
  and `product` are publish-owned or gate-owned and pass through untouched; the merge asserts that
  rather than assuming it. It refuses on the default branch, over a dirty `patterns.json`, on a
  digest mismatch (naming the changed rows), on any validation problem, and on a pattern-set change
  without `--allow-pattern-set-change`. It prints a unified diff and refuses without `--confirm`,
  because validity is not approval. The write itself is atomic.

Revert path: `git checkout scripts/applique-grid/patterns.json`, valid until a publish has run on
top of it.

## Name length

`lib/layout.mjs`'s `nameCharCeiling(chart)` derives the longest pattern name the chart can carry,
from the cell width at that grid density and from the dropdown's per-line bound. The
per-character advance constant (0.55 em) is measured, not guessed: rendering all 18 committed
labels in Inter Bold at size 30 and trimming to the ink extent gives 0.404 to 0.523 em per
character.

At the shipped 3x3 / 1600-unit config the ceiling is **21 characters**, against a longest committed
name of **18** ("Terracotta Blossom"). A denser grid tightens it (14 at 4 columns), which is the
point: those names genuinely would not fit, and the operator should learn that at the naming gate.
It is a calibrated policy ceiling on realistic mixed-case names, not a rendering guarantee; an
unusual all-caps name is wider per character than any of these and can still overflow, which is
what the sample gate's eyes are for.

**It is a `validate()` failure, not gate advice.** `lib/registry.mjs` enforces it, so an over-length
name FAILs `audit.mjs --local` and is refused by `draft.mjs --write`. The ceiling is derived from
the registry's own `chart` params, which means a chart-density change alone can invalidate names
that were legal when they were written: dropping to 4 columns makes the committed 18-character
"Terracotta Blossom" fail. That is why step 3's density choice re-opens the naming gate rather than
silently shortening anything.

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
- `gallery.pin_after_charts` (optional) lists media that must stay AFTER the chart block, in
  declared order. Without it the charts are hard-coded as the contiguous gallery tail, which moves
  the operator's logo off the end on every publish. Regex validation proves shape only; existence,
  non-overlap with the chart set, and non-overlap with the delete set are re-checked at plan time,
  and each failure is a hard stop naming the GID rather than a silent drop. An empty list and an
  absent key are exactly equivalent.
- **Unknown keys are rejected by name in every container.** A misspelled `pin_after_chart` would
  otherwise validate clean, do nothing, and let the next publish undo an Admin fix while the
  registry looked correct. The same rule keeps a free-text field out of `draft.json`, which the
  model reads.

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

`render.mjs --page N` renders one page and **deliberately does not write the charts manifest**, so
`publish.mjs` refuses until a full render has run. That is also why chart-file pruning refuses
whenever any chart file is newer than the manifest: a manifest-keyed prune straight after a partial
render would delete every other page's chart. Unreferenced chart files are reported by the audit
and on every full render, and deleted only under `render.mjs --prune-charts`; a file the registry
records in `published` is never a candidate.

## Publishing model

`publish.mjs --dry-run` computes the full plan (creates with verbatim alts and filenames, deletes
with reasons, suspects, target gallery order), snapshots the live media list to the gitignored
output dir, and stores the plan stamped with version, time, shop, product, a hash of the live media
state, and the approved reorder verdict. The live run requires that stored plan, refuses anything
that does not match (including a plan older than 24 hours against otherwise identical live state:
an approval is a decision about a moment), and consumes it either way; a retry always starts from a
fresh dry-run and a fresh operator gate. A dry run deletes any existing plan before it starts, so a
plan left behind by a crashed earlier dry run can never be what a later live run reads.

**The stored plan proves freshness, never consent**, so it is not by itself enough to run. The dry
run also prints an **approval token**, a 12-hex-character digest of exactly the plan it printed, and
the live run requires it back as `--approved <token>`. That is the one part of the gate that cannot
be satisfied by a process talking to itself: the token has to travel out to the operator and back
through the command line. Without it the live run refuses before reading or consuming anything, so
a mistyped invocation costs nothing. A token that does not match the stored plan consumes the plan
and refuses, because an approval for a different plan is not an approval for this one. Whitespace
and case are tolerated (a human types it); nothing else is.

Execution order is a contract: creates (alt set at create) -> readiness barrier (every create
READY with verified alt) -> deletes -> reorder. A failed barrier skips deletes and reorder, prints
the surviving plan, and exits non-zero; the extra-charts state is ugly but recoverable, a chartless
product page is not. Media attached to any variant is refused for deletion regardless of signals
(charts must never be variant heroes: `hide_variants` would un-share them; see
`docs/product-media-alt-text.md`). Non-chart media relative order is never disturbed.

**The reorder verdict is three-valued, because it used to be confidently wrong.** The planner
simulated post-create positions assuming Shopify appends new media at the end; a real first publish
printed `reorder not required`, both creates landed mid-gallery, and the next audit reported STALE.
With creates pending there is no honest verdict before they land, so the dry run reports
`undetermined until post-create` and prints the TARGET final order: the operator approves the
destination and the possibility, not a false negative.

After the barrier, `publish.mjs` re-reads the gallery and re-evaluates. It does not simply reorder:
that would buy correctness by executing a live mutation the operator never approved. It reconciles
first, scoped so our own creates and deletes are expected while a concurrent Admin edit to any
untouched media aborts the phase with no reorder attempted; checks the approved target is still
achievable, as a **multiset** comparison rather than set membership (a length check plus
`every(includes)` cannot see a duplicate, and would have issued a reorder that silently dropped an
untouched media out of the gallery); snapshots the pre-reorder order; and only then moves anything.

`publish-snapshots/` is the only rollback record for a live media write, so retention only ever
keeps more: the newest 10 stay whatever their age, the newest always stays, and nothing newer than
the last converged audit is touched. A green FULL audit writes that watermark; with no watermark on
record nothing is pruned at all.

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

`audit.mjs --local` (registry schema, template vs derived text, charts manifest vs spec hashes,
unreferenced chart files) tolerates mid-pipeline staleness: STALE lines exit 0, structural FAILs
exit non-zero. It is the **step pointer** a resuming session reads, never the record of decisions.
The full `audit.mjs` treats STALE as drift and exits non-zero: green means registry, template,
rendered charts, published record, live media, alts, and gallery order (charts followed by any
pinned media) all agree, and it records the convergence watermark snapshot retention refuses to
prune past. It also WARNs (without
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

`npm run applique-grid:test`: node:test, no network, no HEIC decode, temp dirs only, and **gated in
CI on every PR** (a step in `validate.yml`, with the same zero-tests guard as the other tooling
suites). The cohesion test pins the shipped template's `pattern_options` byte-equal to the shipped
registry's derived text, except when the registry byte-equals the bootstrap sentinel; an
accidentally-emptied registry fails. That is a cross-file invariant between two committed
artifacts, so CI is what makes it real: a PR that edits the template or the registry alone goes
red.

**Between the registry write and `apply-options.mjs`, exactly one test fails: that cohesion check.**
That is the expected mid-pipeline state, not a regression, and it clears when the template sync
runs. Diagnosing it from scratch has cost three separate sessions.

Goldens (page-1 SVG, dropdown text, the gate-table format) regen via
`npm run applique-grid:golden:update`. A golden diff is a defect signal first: explain it before
regenerating, and if it legitimately must change, regenerate in its own commit with the visual
reason in the PR body.

The autocrop fixtures under `test/fixtures/autocrop/` and `test/fixtures/scan-tiles.json` come from
`crops.mjs --emit-fixture` and need the local photo tree; the tests that consume them do not.
