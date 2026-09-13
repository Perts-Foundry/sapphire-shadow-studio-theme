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

**The body renders raw.** Whatever is here is emitted into the page, so `<script>`, `<iframe>`,
`<object>`, `<embed>`, `<form>`, `<style>` and inline `<svg>` are refused outright, as is any `on*`
attribute and any `javascript:`, `data:` or protocol-relative URL. This is verified behaviour, not a
precaution: a spike confirmed a `<script>` tag in an article body is stored verbatim.

Headings start at `h2` and never skip a level. There is no `<h1>` in the body; the template emits the
title as the page's only `h1`.

### article.json

| Field | Meaning |
|---|---|
| `handle` | equals the directory name |
| `title` | the post title |
| `author` | free text; Shopify accepts any string, though the Admin editor offers staff names only |
| `summary` | the excerpt; required |
| `tags` | array, no duplicates |
| `templateSuffix` | `null`, or a suffix resolving to `templates/article.<suffix>.json` |
| `seo.title` | optional; the `global.title_tag` metafield |
| `seo.description` | optional; the `global.description_tag` metafield |
| `image` | the featured image URL, which must also appear in `images.json` |
| `previousHandles` | handles this post used to live at, for redirects |

`templateSuffix` is **not validated by the Shopify API**: an unknown suffix is accepted and silently
falls back to the default layout. That is why the checker resolves it against `templates/` here,
where the mistake is visible.

### images.json

Records what was uploaded, never the bytes. Photos live in a gitignored top-level `article-images/`
and their processed bytes never enter the repo; Shopify's CDN is their home. Each entry carries the
CDN URL, the alt text, the pixel dimensions and the sha256 of the local processed file. When
`article-images/` is absent (a fresh clone, or CI) the byte-hash comparison cannot run, and the
checker says so in a note rather than passing silently.

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

## What is not here

Publishing. Making a post visible is a hand action the operator takes in Admin. No command in this
repo publishes, and the tooling writes hidden articles only.
