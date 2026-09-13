# Blog articles

The source of truth for every post on the store's blog, **Shift Notes** (`/blogs/shift-notes`).

**Everything in this directory is public.** It is committed to a public repository, and the bytes
here are pushed verbatim to a storefront page. The pre-push checklist in `CLAUDE.md` applies to every
file: no personal emails, no phone numbers, no home or fulfilment addresses, no machine paths, no
tokens, no merchant-keyed strategy prose, no location detail below state level. `npm run
articles:check` refuses the mechanical forms of those, but a checker cannot recognise an anecdote
that identifies someone. That part is the author's job.

## Layout

```
marketing/articles/
  README.md         this file
  manifest.json     derived, written by articles:reindex, never by hand
  <handle>/
    body.html       the exact bytes sent to Shopify, in canonical form
    article.json    authored metadata
    images.json     CDN URL, alt text, dimensions and local sha256; never image bytes
```

`<handle>` is the directory name, the article's storefront handle, and the `handle` field in
`article.json`. All three must agree.

### body.html

Canonical form: no BOM, LF line endings, no trailing whitespace at the end of the document, exactly
one final newline. `articles:check` refuses anything else, because the committed bytes are compared
against what the store returns and a stray carriage return would read as a difference forever.

**The body renders raw.** Whatever is here is emitted into the page. This is verified behaviour, not
a precaution: a spike confirmed a `<script>` tag in an article body is stored verbatim. So the
checker reads a body under a deliberately small grammar and accepts only an allowlist:

- **Write plain, well-formed markup.** No comments (`<!-- -->`), no doctype, no bare `<` in text
  (write `&lt;`), and every attribute value quoted. Anything a browser would have to guess at is
  refused as malformed, with the offset where it happened, because a checker that guesses differently
  from the browser is how unsafe markup gets approved.
- **Elements:** `p`, `h2` to `h6`, `a`, `img`, `ul`, `ol`, `li`, `strong`, `em`, `b`, `i`, `u`, `s`,
  `small`, `sub`, `sup`, `blockquote`, `cite`, `q`, `br`, `hr`, `figure`, `figcaption`, `span`,
  `div`, `code`, and `table` with `thead`, `tbody`, `tfoot`, `tr`, `th`, `td`, `caption`. Anything
  else is refused.
- **Not yet:** `pre`, and a table inside another table. The spike exercised a flat table only, and
  the one rewriting Shopify did was to insert newlines between table rows and cells; how it treats
  whitespace-significant `pre` content or a nested table is unproven, and the repo compares its bytes
  against what the store returns. Both stay refused until a second spike proves them.
- **Attributes:** `class`, `id`, `title`, `lang` and `dir` anywhere; `href`, `rel`, `target` on `a`;
  `src`, `alt`, `width`, `height`, `loading` on `img`; `colspan`, `rowspan`, `scope` on `th` and
  `td`. No `style`, no `srcset`, no `on*` handler, and no attribute given twice on one element.
- **URLs:** an `href` starts with `https://`, `/` (a storefront path such as `/products/<handle>` or
  `/policies/<handle>`), `mailto:` or `#`; an image `src` with `https://` or `/`. No spaces, no
  backslashes, and no `&` except as `&amp;` in a query string. An `http://` link is refused; use
  https.

Headings start at `h2` and never skip a level. There is no `<h1>` in the body; the template emits the
title as the page's only `h1`.

### article.json

| Field | Meaning |
|---|---|
| `handle` | equals the directory name |
| `title` | the post title; required |
| `author` | free text; Shopify accepts any string, though the Admin editor offers staff names only |
| `summary` | the excerpt; required |
| `tags` | array, no duplicates |
| `templateSuffix` | `null`, or a suffix resolving to `templates/article.<suffix>.json` |
| `seo.title` | optional; the `global.title_tag` metafield |
| `seo.description` | optional; the `global.description_tag` metafield |
| `image` | the featured image URL, which must also appear in `images.json` |
| `previousHandles` | handles this post used to live at, for redirects |

Every field present must have the type shown: strings are strings, `tags` and `previousHandles` are
arrays of strings, `seo` is an object or `null`, `templateSuffix` and `image` are a string or `null`.
A wrong type, or a file that is not valid JSON, is refused before any other rule reads the article.
A `previousHandles` entry may not be another article's current handle, or be claimed by two articles.

`templateSuffix` is **not validated by the Shopify API**: an unknown suffix is accepted and silently
falls back to the default layout. That is why the checker resolves it against `templates/` here,
where the mistake is visible.

### images.json

Records what was uploaded, never the bytes. Photos live in a gitignored top-level `article-images/`
and their processed bytes never enter the repo; Shopify's CDN is their home. Each entry carries the
CDN URL, the alt text, the pixel dimensions and the sha256 of the local processed file. Each URL must
be `https:` on the host `cdn.shopify.com` exactly, and each alt is checked for em dashes and
sensitive content like any other authored string. **The recorded sha256 is not yet compared with
anything**, whether or not `article-images/` is present, and the checker says so in a note on every
run rather than implying otherwise.

An uploaded file is public at its CDN URL the moment the upload succeeds, independent of whether the
article is visible. Uploading is therefore its own gate, not a step inside publishing.

## Commands

| Command | Does |
|---|---|
| `npm run articles:check` | offline consistency and safety check; what CI runs |
| `npm run articles:reindex` | rebuild `manifest.json` from the tree |
| `npm run articles:reindex -- --check` | report a stale manifest, write nothing (exit 2 on drift) |

`articles:check` already refuses a manifest that disagrees with the tree, so `reindex --check` is
deliberately not a second CI step.

The network commands (`articles:status`, `articles:pull -- --check` and `-- --seed`,
`articles:verify -- --live`, and the hidden-only live write) are documented in
`scripts/articles/README.md`, with their gates, exit codes, machine-local state and recovery.

## What is not here

Publishing. Making a post visible is a hand action the operator takes in Admin. No command in this
repo publishes, and the tooling writes hidden articles only.
