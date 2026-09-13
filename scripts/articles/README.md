# scripts/articles

Tooling for the store's blog, **Shift Notes** (`/blogs/shift-notes`). The on-disk format and the
authoring rules are documented in `marketing/articles/README.md`; this file covers the commands.

## What exists today

| Command | Network | Does |
|---|---|---|
| `npm run articles:check` | no | consistency and safety check over `marketing/articles/`. What CI runs. |
| `npm run articles:reindex` | no | rebuild `manifest.json` from the tree. |
| `npm run articles:reindex -- --check` | no | report a stale manifest, write nothing. Exit 2 on drift. |
| `npm run articles:test` | no | the suite. |

Both commands accept `--root <dir>` so the suite can run them against fixture trees.

Four further script names are declared in `package.json` and **do not resolve to a module yet**:
the status, pull, verify and live-write commands. They are declared up front so that the change
adding them touches no shared file, which keeps that diff reviewable. Running one today fails with a
module-not-found error, which is the correct outcome: nothing in this repo invokes them.

## Exit codes

| Code | Means |
|---|---|
| 0 | clean |
| 1 | refusals found, or the tree could not be read |
| 2 | `reindex --check` only: the manifest is stale |

The 2 is load-bearing. A caller that collapsed it into "non-zero" could not tell a stale manifest
from a broken checkout, and would send an operator to a command that cannot help.

## Why the rules are what they are

**Article bodies render raw.** Whatever bytes are stored are emitted into the storefront page. This
is verified, not assumed: a live spike confirmed a `<script>` tag in an article body is stored
verbatim. So `script`, `iframe`, `object`, `embed`, `form`, `style` and inline `svg` are refused as
elements and as attribute names, along with any `on*` attribute in any case and any `javascript:`,
`data:`, `vbscript:` or protocol-relative URL. These are parsed rather than pattern-matched, because
the parser lowercases every name and a novel spelling should not be a bypass.

**This repository is public.** Blog prose is long, written in a hurry, and the one place an operator
naturally types an address or a phone number. The email, phone and machine-path rules are blunt on
purpose: a false positive costs one rewording, a false negative is published.

**Shopify does not validate `templateSuffix`.** An unknown suffix is accepted and the article
silently falls back to the default layout. The repo is the only place that mistake is visible, so
the suffix is resolved against `templates/` here.

## The manifest is derived

`marketing/articles/manifest.json` holds `bodySha256`, `bodyLength`, `metaSha256` and the recorded
image URLs per handle. Nothing in it is a judgement, so hand-editing it can only make it wrong.

`metaSha256` covers exactly the fields named in `META_FIELDS` in `lib/articles.mjs`. **A field
absent from that list is invisible** to both the reindexer and the checker's hashes-agree rule, so
adding a field to `article.json` means adding it there in the same change. A test edits every field
in the list and fails if any one of them does not move the hash.

`articles:check` already refuses a manifest that disagrees with the tree, which is why
`reindex --check` is deliberately not a second CI step.

## Tests

`npm run articles:test`. The shape worth knowing:

- One committed golden article (`test/fixtures/clean/`) passes every rule.
- Each rule case copies that baseline into a temp directory, applies **one** mutation, and asserts
  it trips **exactly** that rule and no other. The exactness is the point: asserting only that the
  expected id appears would pass for a checker that refused everything.
- A meta-test refuses any rule id that no case exercises, and any expectation naming an id that is
  not a real rule.
- A separate guard walks `.github/workflows/`, `.github/actions/`, `.claude/skills/`, `scripts/` and
  `package.json` and refuses any automated invocation of the live-write command, by either its npm
  name or its module path. The only permitted occurrence in the repository is its declaration in
  `package.json`. A consequence: documentation under those trees cannot spell that command either,
  which is why this file describes it rather than naming it.

## The publish boundary

Nothing here publishes. The tooling writes hidden articles only, and making a post visible is a hand
action the operator takes in Admin.
