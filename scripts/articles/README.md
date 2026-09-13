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
verbatim. So the safety rules are an **allowlist over a strict reader** (`lib/body-markup.mjs`), not
a list of bad names:

- **The reader refuses anything a browser would have to recover from** (`safety/malformed-markup`,
  with the offset): comments, doctypes, CDATA, `<?`, a bare `<` in text, unquoted attribute values,
  a `<` inside a quoted value, and any stray character inside a tag. The version this replaced walked
  bodies with a lenient parser, and payloads such as `<!--><img src=x onerror=...>-->` read as a
  harmless comment to it and as a live image to a browser. With one strict reading, the checker and
  the browser cannot disagree about where an element is. Every element-based rule (headings, links,
  images) reads that same result, and reports nothing for a body the reader refused.
- **Elements outside the allowlist are refused** (`safety/forbidden-element`). `pre` and a table
  nested in another table are refused too, until a spike proves how Shopify's normaliser treats them;
  the first spike only covered a flat table.
- **Attributes outside the element's allowlist are refused** (`safety/forbidden-attribute`), any
  `on*` name as `safety/event-handler`, and a name given twice on one element as
  `safety/duplicate-attribute` (every value of it is still checked).
- **`a href` and `img src` must start with `https://`, a single `/`, or (links only) `mailto:` or
  `#`**, and may contain no whitespace, control character, backslash, or character reference other
  than `&amp;` (`safety/dangerous-url`). That one rule refuses `javascript:` in every entity or
  whitespace spelling, `data:`, `vbscript:`, `//host`, `/\host`, `tel:` and a relative `products/x`.
  An `http://` URL is refused as `link/external-not-https`. Accepted URLs reach the link and image
  rules with `&amp;` decoded, and a `/products/` link with an empty handle is refused whether or not
  a catalogue is present.

The recorded image URLs in `images.json` are parsed, and must be `https:` with a hostname of exactly
`cdn.shopify.com`; a URL that merely contains that name is refused.

**This repository is public.** Blog prose is long, written in a hurry, and the one place an operator
naturally types an address or a phone number. The email, phone and machine-path rules are blunt on
purpose: a false positive costs one rewording, a false negative is published. They run over the raw
body, every authored string in `article.json`, and every `alt` in `images.json`. The phone rule does
require phone-style separators, so dates, year ranges, prices, SKUs, `?v=` cache busters and CDN
paths do not trip it.

**Metadata is type-checked before it is read.** Invalid JSON in `article.json` or `images.json` is
`structure/json-invalid`; a field of the wrong type (a string where an array belongs, a numeric
`seo.title`) is `structure/field-type`, and no metadata rule runs on that article until it is fixed.
An empty or missing title is `meta/title-empty`.

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

Both commands build each entry with the same function, `manifestEntryFor` in `lib/articles.mjs`, so
the checker compares all four fields (including `images`, `structure/images-mismatch`) against
exactly what the reindexer would write.

`articles:check` already refuses a manifest that disagrees with the tree, which is why
`reindex --check` is deliberately not a second CI step.

**Image byte hashes are not verified.** `images.json` records a sha256 per image, and nothing
compares it with the local processed file, whether or not `article-images/` is present. The checker
says so in a note on every run.

## Tests

`npm run articles:test`. The shape worth knowing:

- One committed golden article (`test/fixtures/clean/`) passes every rule.
- Each rule case copies that baseline into a temp directory, applies **one** mutation, and asserts
  it trips **exactly** that rule and no other. The exactness is the point: asserting only that the
  expected id appears would pass for a checker that refused everything.
- A meta-test refuses any rule id that no case exercises, and any expectation naming an id that is
  not a real rule.
- `body-markup.test.mjs` runs a table of known reader-disagreement and URL-spelling payloads, each
  asserting the exact safety rules it must produce, plus positive controls (a query string with
  `&amp;`, a policy link, a fragment, a mailto, a CDN image, nested lists, a flat table).
- `cli.test.mjs` runs both commands as a caller would: the success marker exactly once on a clean
  tree and never on a refusal, and a usage message rather than a stack trace for `--root` with no
  value.
- A separate guard walks `.github/workflows/`, `.github/actions/`, `scripts/`, the `.claude/`
  skills, hooks, commands, rules and agents trees, the `.claude/` settings files and `package.json`,
  every regular non-binary file in them, and refuses any automated invocation of the live-write
  command: by its npm name, by its module path, or by a relative import that resolves to the module.
  The only permitted occurrence in the repository is its declaration in `package.json`, whose value
  is pinned. A command name assembled at runtime from pieces is not caught by a static scan, and is
  a known, tracked gap. A consequence: documentation under those trees cannot spell that command
  either, which is why this file describes it rather than naming it.

## The publish boundary

Nothing here publishes. The tooling writes hidden articles only, and making a post visible is a hand
action the operator takes in Admin.
