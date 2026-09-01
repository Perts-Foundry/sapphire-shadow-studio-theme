---
name: seo-review
description: >-
  Audit the storefront and theme for SEO regressions: crawl every sitemap URL for titles, meta
  descriptions, canonicals, H1 structure, JSON-LD validity and placement, breadcrumbs, and
  duplicates; read the stored Admin SEO fields the storefront hides behind render-time fallbacks;
  check the public surface (robots.txt, sitemap hosts, surviving noindex) as an anonymous crawler
  sees it; and review the repo's structured-data and meta-tag invariants. Use after adding or
  editing products, pages, collections, or templates, after changes near snippets/meta-tags.liquid
  or snippets/structured-data*.liquid, before and after removing the storefront password, or for a
  periodic check (a full product addition run from add-product ends with this audit). Read-only: it never writes to the store, the repo, or Admin, so it is not for
  applying fixes, keyword strategy, or copywriting.
---

# SEO review

The July 2026 SEO remediation fixed a full audit's worth of silent defects: unparseable JSON-LD,
duplicated meta descriptions, zero- and double-H1 pages, entity markup on every page. None of
those failure modes has a CI check, and every new product, page, or collection can reopen them.
This skill re-runs that audit as regression testing and reports deltas, not lectures.

The heavy lifting is deterministic Node tooling under `scripts/seo-review/` (read its README
first: check ids, thresholds, and the rationale for each check live there). This skill is the
glue: it picks the layers that can run, runs them, layers the repo-invariant review on top, and
turns findings into proposals for the operator. The authorities on intent are `docs/structured-data.md`
(condensed in CLAUDE.md's "Structured data" section) and `docs/shopify-mcp-notes.md`
(Admin read path).

Everything here is read-only. There are no write gates because there are no writes; the one STOP
below exists because browser use is opt-in in this repo, not because anything is at risk.

## Layers, and when each can run

| Layer | Command | Needs | Skip when |
| --- | --- | --- | --- |
| Repo invariants | prose review (below) | nothing | never |
| Live crawl | `node scripts/seo-review/crawl.mjs` | `STORE_PW` while the store is locked | env absent: ask the operator to export it, or skip with a stated reason |
| Admin stored fields | `node scripts/seo-review/admin.mjs` | `MYSHOPIFY_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | envs absent |
| Public surface | `node scripts/seo-review/surface.mjs` | nothing (deliberately anonymous) | never; pre-launch it reports the gate as status |

Default to every layer whose prerequisites are present and name each skipped layer with its
reason in the report. The operator can also ask for one layer by name (`repo`, `crawl`, `admin`,
`surface`).

## Pipeline

1. **Preflight.** Confirm the working tree is the state being reviewed (`git status`). Check which
   env vars are present (never print any of their values). State which layers will run.

2. **Repo invariants.** A judgment pass against documented rules, not a script. Check, at minimum:
   - `snippets/structured-data.liquid` still renders from `layout/theme.liquid`'s head only, not
     from `layout/password.liquid`; Organization and WebSite stay guarded to
     `request.page_type == 'index'`; `@id`/`url` derive from `shop.url`, never `request.origin`.
   - No JSON-LD has crept back into `sections/header.liquid` (the comment there says why).
   - No optional JSON-LD array can emit a trailing comma when a setting is blank (collect
     non-blank values first, emit with `forloop.last`; an `unless forloop.last` comma is the bug).
   - `snippets/meta-tags.liquid`: `og:image` still https; no `social_twitter_link` setting has
     been re-added alone (the file's comment block explains the broken x.com handle parse).
   - `templates/page.json` keeps `main` enabled (the default template once rendered the About
     page over every unassigned page).
   - The breadcrumb allow-list in `snippets/breadcrumbs.liquid` still matches
     `BREADCRUMB_PAGE_TYPES` in `scripts/seo-review/lib/checks.mjs`, and `policy` stays out.
   - Storefront-visible locale keys added since the last review are mirrored across all
     `locales/*.json` (TODO placeholders count as mirrored).
   - Any changed template still yields exactly one H1 per page type (reason it through; nothing
     enforces it).

3. **Run the scripts.** Each mode diffs against its own saved baseline in
   `~/.local/state/seo-review/` and exits non-zero only on ERROR findings new since that baseline.
   Run with no flags first; add `--full` when the operator wants the complete picture rather than
   deltas. Findings matching `scripts/seo-review/accepted-risks.json` are reported as accepted,
   not new; do not re-litigate them unless the operator asks.

4. **Report.** One consolidated summary: per layer, new findings (with severity, URL, and what to
   do about each), resolved findings, skipped layers with reasons, and accepted risks only when
   `--full` was requested or one has changed. Findings are proposals. Repo fixes go through the
   normal PR flow; Admin fixes go through the established gate (capture current value, present a
   table, write only after approval); neither happens inside this skill.

## Preview themes: the browser fallback

The Node crawl authenticates with the password, which works for the live theme. A PR preview
theme needs `?preview_theme_id=` plus the bypass cookie that lives in the operator's browser
session, so preview reviews use the chrome-devtools MCP instead.

**STOP: browser testing is opt-in in this repo. Ask before opening any storefront or preview URL
in the browser, every time.** On a yes, drive the probe with `navigate_page` plus an `initScript`
that same-origin fetches the target URLs, `DOMParser`s each, and `console.log`s per-page results;
read them back with `list_console_messages`. Four guards, each of which has already burned a run
once, so none is optional:

- Gate the script on `window.top === window`, or it executes in a CDN-origin frame and reports
  the Shopify CDN's own page.
- Allow both the production hostname and `*.myshopify.com`; a production-only guard silently
  produces no output on a preview host, indistinguishable from a clean pass.
- Log a start banner with the resolved hostname and URL count, so "no output" is diagnosable.
- Confirm which theme is actually rendering via `Shopify.theme.id` before trusting any result.

## Non-goals

This skill does NOT: write to Admin, the store, or any Shopify resource (no SEO fields, no
metafields, nothing); edit theme code or templates; commit, push, open a PR, or comment `deploy`
(all git actions are the operator's); do keyword research, strategy, or copywriting (that is
judgment work the operator iterates on); touch Google Search Console or Bing Webmaster Tools
(operator accounts); or replace the pre-PR review gate for theme changes.

## Repo rules that must hold

- **No em dashes (U+2014)** anywhere, including report text and proposed copy.
- **The token and the storefront password are never printed, logged, or committed.** The token is
  minted at runtime from `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`; `STORE_PW` stays in the
  environment. Both come from the gitignored repo-root `.env` via `node --env-file=.env ...` (see
  `scripts/README.md` > Credentials). If a command needs a secret, reference the env var name,
  never the value.
- **Public repo.** Findings quote storefront metadata, which is public by definition, but keep
  bodies, cookie values, and any Admin data beyond SEO fields out of reports, commits, and PR
  text. Run artifacts live in the state dir outside the repo; never point `SEO_REVIEW_STATE_DIR`
  inside the checkout and never paste artifact contents into git-facing text.
- **Scopes are verified, not assumed.** If an Admin read fails on authorization, stop and report;
  do not widen scopes or work around it.
- A passing run is capability, not authorization: it never substitutes for the browser STOP or
  for the operator's approval of any follow-up fix.
