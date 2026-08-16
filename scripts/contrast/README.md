# scripts/contrast/

Static WCAG contrast lint over the theme's colour schemes. Dependency-free, no network, no
browser. It runs inside the required `validate / validate` check on every PR, so it is the layer
that can actually block a merge.

This is one half of a two-layer accessibility check. The other half is `scripts/a11y/`, which runs
pa11y-ci against the deployed preview theme from `preview.yml`. Neither subsumes the other: this
one cannot see a rendered page, and that one cannot be a required check.

## Run it

```bash
npm run contrast:lint     # the gate; exit 1 on any failure
npm run contrast:test     # unit suite
node scripts/contrast/check-contrast.mjs --json   # machine-readable results
```

## What it checks

`config/settings_data.json` holds every colour scheme, in two places: `current.color_schemes` (what
the live theme renders) and `presets.Default.color_schemes` (what a fresh install starts from). The
theme editor only ever writes `current`, so the presets drift silently and a merchant resetting to
the preset would land on colours nothing has ever checked. Both are scanned.

Each scheme's 35 colour roles are paired by a hardcoded map in `lib/pairs.mjs` and measured at:

| Kind | Ratio | What |
| --- | --- | --- |
| Text | 4.5:1 | Every text role against the surface it sits on; hover text against hover fill |
| Large text | 3:1 | `foreground_heading` only. A judgment call, documented in `lib/pairs.mjs` |
| Non-text | 3:1 | Bordered controls, distinguishable from the page. See below |
| Exempt | n/a | `shadow` |

**Non-text contrast is measured against the page, not the control's own fill.** The naive reading
(border vs its own background) scores a solid black button on white at 1:1 and fails it, which is
nonsense. SC 1.4.11 requires that the control be tellable apart from the page, so the check passes
when either the border or the component's fill reaches 3:1 against the scheme background.

**Overlay schemes are reported indeterminate.** A scheme whose `background` is fully transparent
paints nothing and composites over section media (a hero image, a video). Assuming a surface
underneath would fabricate the number, so those pairs are excluded from the tally, reported by
name, and left to the pa11y layer, which renders the real page.

## The completeness assertion

Every role the theme can write must be classified by the pairing map, as text, border or exempt.
A Horizon upstream merge that adds a colour role fails the lint loudly rather than leaving the new
colour silently unchecked. The role list is the union of what `config/settings_schema.json`
declares and what `settings_data.json` actually contains.

This is why the map is hardcoded rather than derived from the schema's label translation keys.
Derivation is brittle (it depends on header ordering the theme editor is free to change) and it
produces the WRONG pairing rather than no pairing when it breaks.

## accepted-risks.json

Deliberate exceptions, one object per finding, keyed `{source, scheme, pair}`. Follows the pattern
of `scripts/seo-review/accepted-risks.json`.

**Never widen a threshold in `lib/pairs.mjs` to get a PR through.** That removes the check for
every scheme forever. A baseline entry is scoped, dated, noted and reversible; it is the documented
unblock path for a false positive in a required check.

Two rules keep the file from rotting into a rubber stamp:

- **Ratchet.** Each entry records the ratio measured when it was accepted. Score below that later
  and the lint fails. Accepting "this border is at 2.1:1" must not also accept a later 1.2:1.
- **Self-clearing.** When a baselined pair reaches its threshold, the entry is reported STALE so it
  gets deleted. Without this the file only grows and eventually hides a regression.

A malformed entry is a hard error, not a silent no-op: a typo'd scheme name would otherwise look
like a granted exception while suppressing nothing.

**The file currently holds 56 entries, all seeded on 2026-08-16 from the first real run.** They are
pre-existing failures recorded rather than fixed, so the gate could land without restyling the live
storefront. That was a deliberate decision; the consequence is that the gate catches regressions
from day one but asserts nothing about the current palette's absolute quality. Triage is tracked in
`TODO.md`.

## Layout

| File | Role |
| --- | --- |
| `check-contrast.mjs` | Entrypoint, reporting, fail-closed floors |
| `lib/color.mjs` | Colour parsing, alpha compositing, WCAG luminance and ratio |
| `lib/settings.mjs` | JSONC banner strip, scheme extraction, schema role ids |
| `lib/pairs.mjs` | The pairing map, thresholds, completeness assertion |
| `lib/evaluate.mjs` | Runs the map over a scheme; overlay detection |
| `lib/risks.mjs` | Baseline validation, ratchet, stale detection |
| `accepted-risks.json` | Recorded exceptions |
| `test/` | `node --test` suites, plus a synthetic fixture |
