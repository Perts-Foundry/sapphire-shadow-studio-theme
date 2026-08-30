# CLAUDE.md

Guidance for Claude Code working in this repo. The repo is a custom Shopify theme based on Horizon, deployed via a PR-based comment-deploy model. `README.md` documents the surface (workflow tables, branches, secrets, rollback, upstream-merge mechanics); this file holds Claude-specific policy, gotchas, and theme conventions.

## Sensitive Content

This repository is **public**: personal contact metadata, internal strategy/legal-advisory content, and dev-machine identifiers must never appear in the repo, git history, PRs, issues, comments, or release artifacts. Brand-personality copy already on the storefront (founder narrative, About/FAQ pages, photography filenames without personal identifiers) is fine to commit. The repo was deleted-and-recreated once to scrub embedded metadata; do not reintroduce it.

The `secret-scan` job (Gitleaks) catches token-shaped strings but does not catch personal emails, addresses, or merchant-keyed prose; the author's responsibility per the checklist below.

### What is sensitive (do not commit)

- **Personal contact metadata**: personal emails (Gmail, iCloud, etc.), phone numbers, home/fulfilment addresses, personal social handles; the storefront speaks for the brand, not the operator.
- **Commit-author email**: `git config user.email` must be `seth@pertsfoundry.com` or the GitHub no-reply form; Gmail here is a metadata leak **no diff ever shows**.
- **Dev-machine identifiers**: absolute paths with a username (`/Users/Seth/...`, `/c/Users/Seth/...`, `/mnt/c/Users/Seth/...`, `~/repos/...`); use placeholders (`<screenshots-dir>`, `<repo-root>`) instead.
- **Internal advisory / strategy docs**: legal-exposure analyses, ADA-risk playbooks, insurance notes, settlement guidance, demand-letter checklists, tax/accounting research; private notes location only, never `docs/` here.
- **Operating location below state level**: city, county, ZIP, anything that could pinpoint a home-based operation; state-or-larger brand framing is fine, jurisdiction-tied legal framing is not.
- **Tokens of any kind**: `SHOPIFY_CLI_THEME_TOKEN`, GitHub PATs, Shopify Admin API tokens, third-party app keys, AI keys. CI references `${{ secrets.* }}` only.
- **Real customer / order / financial data**, even truncated. Use synthetic fixtures (`Test Customer`, `order-id-12345`).
- **Pre-publish drafts** naming real third parties outside what's already on the storefront.

### What is NOT sensitive (and is fine to commit)

- Founder narrative and brand voice already on the storefront's About/FAQ page (first names, husband-and-wife framing, prior-career mentions, pet references); pet-name image filenames (`about-kitcat-card.jpg`) are fine when those names appear in visible copy.
- The brand name "Sapphire Shadow Studio", the public store handle, the live theme numeric ID, and the storefront domain: all public on every page render.
- App-embed install UUIDs and public `/policies/...` content: observable to any storefront visitor.
- State-level location framing in storefront copy (not legal/strategy context), and synthetic test fixtures.
- `EXPECTED_SYNC_PR_OPENER`'s value (a GitHub login): already public via every PR the PAT opens and the contributors page.
- `SHOPIFY_SYNC_DEPLOY_KEY`'s public-key fingerprint/title, numeric ID, and matching bypass-actor `actor_id`: admin-observable identifiers, not authentication material.

### Pre-push checklist

Before every `git push`, every `gh pr create`, every `gh pr comment`, and every `gh issue create`:

1. **Scan the full branch diff** (`git diff origin/main..HEAD`) and **every commit message** (`git log origin/main..HEAD --format=%B`) for: personal emails, personal phone, machine paths, tokens, merchant-keyed strategy framing, sub-state location detail.
2. **Scan the rendered PR / issue / comment body** for the same categories; `gh ... --body` text skips both the diff scan and Gitleaks.
3. **Verify the `secret-scan` CI check is green** on the latest PR run. Red means stop and triage, not "rebase past it."
4. **Verify `git config --local user.email`** is `seth@pertsfoundry.com` or the no-reply form; Gmail in author metadata is the leak no diff ever shows (see Commit-author email above).
5. If anything sensitive is found:
   - **Pre-push (history not yet on remote)**: rewrite locally with `git rebase -i` or `git commit --amend`. Replace with neutral descriptors. Re-run all checks before pushing.
   - **Already on remote**: stop. Surface to the user before any further action. Force-pushing rewritten history to a public repo is a visible event that warrants explicit consent. For a confirmed token, treat as compromised and rotate in addition to (not instead of) history rewrite.
6. Default to redacted-by-default in commit messages and doc entries: describe the *change* (what was edited in the template / block / workflow), not the *real-world entity* that prompted it.

### Memory notes

Memory files under `~/.claude/projects/.../memory/` may contain real operator and merchant context **for the assistant's use only**. Never paste memory content into the repo, PR bodies, or commit messages.

## Formatting

**No em dashes (Unicode `U+2014`) anywhere in this repo.** Applies to code, comments, content files, docs, locale strings, workflow files, and CLAUDE.md itself; the global-rules carve-out for Claude config files does not apply here. Restructure with commas, semicolons, parens, colons, or periods. Do not substitute ` - ` (spaced ASCII dash). Quickest replacements: a sentence break (`. Capital...`), a semicolon, or a colon when introducing an explanation. Sweep before commit with `git grep -l $'\xe2\x80\x94'` (which should return nothing).

## Screenshots

When the user references a screenshot, or when troubleshooting any issue, proactively check for the latest screenshot. The user's screenshots directory lives in their private global `~/.claude/CLAUDE.md`; ask for it the first time it's referenced in a session if you don't already have it. **Do not commit literal local-machine paths to this repo** (see Sensitive Content above).

## Browser testing

Browser-driven testing of the storefront or a PR preview theme uses the chrome-devtools MCP. It is opt-in: **do not auto-open preview or storefront URLs.** Drive a browser only when the user asks for visual or behavioural verification, not as a default step after a change.

- **Password-protected storefront.** The storefront (custom domain and `*.myshopify.com`) is password-protected, so anonymous requests (WebFetch, curl, a plain `?preview_theme_id=` link) get a 401 or the password page. To view a PR preview theme, open the store's admin themes page (`https://admin.shopify.com/store/sapphire-shadow-studio/themes`), open the draft theme's "more theme actions" menu, and use its **Preview** link. That link carries a `key=` param that sets the password-bypass cookie for the whole browser session; curl does not pick the bypass up.
- **hCaptcha blocks automated form submits.** Shopify's invisible hCaptcha will not complete for storefront form submissions from the automation-flagged MCP browser, so full contact-form round trips must be verified manually.
- **Shopify admin login loops in the MCP browser.** accounts.shopify.com silently rejects the chrome-devtools MCP's automation-flagged Chrome, looping "Continue with email" forever. Workaround: kill the MCP-launched Chrome, relaunch the same binary manually with the same `--user-data-dir` (`~/.cache/chrome-devtools-mcp/chrome-profile`) but no automation flags, log in there, then close it; the next MCP call relaunches the browser and the session cookies carry over until the profile's login expires.

## Workflow

README documents the workflow surface (`validate` / `preview` / `deploy` / `sync` tables, branches, secrets, "How shipping works"). This section is Claude-specific additions only: steps not in README, and the auto-deploy gate internals.

### Code changes

Follow README's "How shipping works" for the branch/PR/validate/comment-deploy flow. One thing it doesn't cover: before pushing, run `validate_theme_codeblocks` (shopify-dev MCP) on every changed Liquid file, it catches schema/filter/tag errors earlier than CI's `theme-check` step. Exception: `marketing/emails/*.liquid` are Shopify Email templates, not theme code; treat the validator's output there as syntax-only and ignore its undefined-object findings (`marketing/emails/README.md` explains why, and the real check is a test send). The local `actionlint` invocation and the `reconcile`-failure fix snippet are in README's Development section and Troubleshooting table, respectively.

### Backlog hygiene (`TODO.md`)

`TODO.md` is the single repo-wide backlog and holds **only work that still needs doing**. When an item lands, **delete it from `TODO.md`**; never tick it, never leave a checked-off entry, and never add a "Done" section. The file should read as a list of open actions and nothing else.

Reasoning that outlives the task does not get deleted with it: if the work produced a corrected mistake, a cross-layer contract, a non-obvious constraint, or a decision worth knowing the "why" of, write that into `release-notes.md` in the same change, then remove the `TODO.md` entry. A durable rule about how to work in this repo belongs in this file instead. This applies to items resolved as "won't do" as much as to shipped ones.

### Admin-side edits

Admin Customize/Code edits go on the `EDIT HERE - Admin Sync` theme, never live (README's "Branches and themes" covers the shopify-sync mechanics). Claude-specific: auto-deploy on the reconcile PR halts with a sticky skip-comment on signed-commit-identity failure, PR-opener mismatch, HEAD drift, stale base, missing-main-commits, or an out-of-scope diff (touches `.github/` or `layout/theme.liquid`, or exceeds a LOC threshold defined in `deploy.yml`'s `gate` job). A hand-opened shopify-sync PR by anyone other than the configured PAT owner fails the PR-opener check and must be deployed via `deploy` comment.

**Escape hatch**: mark the auto-reconcile PR as a draft (`gh pr ready --undo <n>`); auto-deploy skips drafts. Convert back to ready-for-review to resume.

**A reconcile PR that DELETES a theme file is a halt signal**: none of the gates above look at deletions. Draft the PR and find out what the admin theme did, rather than re-adding the file, which may not be what should come back. This has happened (`release-notes.md`, policy pages).

### Live theme and preview cleanup

Do not click "Customize" or "Edit code" on the live theme card in admin; use the sync theme (README's "Branches and themes" table has the theme ID and disconnected-from-GitHub details). Orphaned `pr-N-preview` themes have no scheduled sweep; the failure signal is `:warning: **Preview cleanup warning**` in the deploy-report comment, and README's Troubleshooting table has the recovery commands.

### Smoke test (node fetch; catalog-wide)

The post-deploy smoke (`.github/actions/shopify-theme-push/smoke.mjs`) probes every published product from the sitemap, not a fixed handle list, so a broken template or missing product HARD-FAILs the deploy. It's node `fetch`, not curl: Cloudflare bot-management blocklists curl's fingerprint, so do not reintroduce a curl probe. Full behavior (HARD-FAIL vs SOFT-WARN semantics, locked-vs-public password handling, pre-flight dry-run): `docs/smoke-test-reference.md`.

### Deploy gate trust delta

`deploy.yml` is a three-job pipeline with no GitHub Environment binding: `gate` (no token; computes the four gates below), `deploy` (Shopify token + storefront password, no deploy key; live push + smoke + squash-merge), `sync` (deploy key, no Shopify token; reconciles `shopify-sync`). Each secret is isolated to one job.

Four gates govern auto-deploy; do not weaken these in a refactor:

1. **Collaborator permission** (comment path): only `admin`/`write` collaborators may trigger a deploy comment.
2. **Validate-on-HEAD-SHA** (all paths): Validate must be green on the exact trusted SHA. On `workflow_run` paths this means the **`validate` JOB**, read via `listJobsForWorkflowRun`, not `workflow_run.conclusion`: `validate.yml`'s other job (`deploy-preview`) pushes a preview theme and runs for shopify-sync PRs too, so a Shopify hiccup there fails the run with all validation green and would block auto-deploy. Do not revert that to the run conclusion, and do not rename the `validate` job (the name is hardcoded, like the workflow name in `on.workflow_run.workflows`). Do not drop the `compareCommits.status === 'identical'` check as "redundant" with SHA equality: it is commit-object equality, not tree equality, so it independently catches same-tree amends/cherry-picks and different-tree force-pushes that SHA equality alone would miss.
3. **Signed-commit gate** (workflow_run paths): author identity + signature verification + PR-opener identity. Do not add strict equality on `commit.committer.login`: a legitimate `web-flow` committer (web-UI edits, Update-branch/Rebase, `@dependabot rebase`) is not a security signal, and that check was a prior false-positive regression.
4. **Defence-in-depth merge-base assertion** (workflow_run paths): PR head must not be behind `main` at merge time.

**Deploy-key bypass-row scope**: `SHOPIFY_SYNC_DEPLOY_KEY` has full repo push capability; the `Deploy keys` bypass-actor row on `shopify-sync-protection` scopes it to that one branch. Do NOT add it as a bypass actor on any ruleset protecting `main`.

Full mechanics (per-gate API calls, integrity-boundary reasoning, known compensations): `docs/deploy-gate-reference.md`. Design rationale, alternatives considered, and incident history: `release-notes.md`.

### Secrets vs variables policy

GitHub Actions auto-redacts `secrets.*` in logs (`***`); `vars.*` is plaintext. Classify as secret if the value grants write access to live infrastructure or a third-party API; classify as variable if it's already observable on any unauthenticated storefront request or in the repo's public surface. Per-secret call sites and rotation procedures are tracked outside this file (operator-managed). Before adding a new `vars.*` entry, ask: would I be comfortable seeing this value in a workflow log, smoke-test PR comment, or quoted by a reviewer? If not, classify as a secret.

## Pre-PR review

Standard agent set (`code-reviewer`, `doc-sync-checker`, `architecture-reviewer`, `security-auditor`) applies. Project-specific triggers:

- **infra-reviewer**: any change touching `.github/workflows/` or `.github/actions/`. `deploy.yml` is a three-job pipeline (gate / deploy / sync) with secret isolation; `workflow_run` paths depend on the literal name `validate` and the `dependabot/**` glob; no workflow binds a GitHub Environment.
- **test-engineer**: theme Liquid has no test framework, so skip for theme changes. `scripts/size-chart/`, `scripts/blank-inventory/`, `scripts/applique-grid/`, `scripts/email-icons/`, `scripts/catalogue/`, `scripts/lib/`, and the top-level `scripts/*.test.mjs` suites do have `node --test` suites; run test-engineer when any changes. `blank-inventory/` writes to live inventory and `upload-product-media.mjs` writes live product media, so those two are the higher-risk.
- **prompt-reviewer**: run when this `CLAUDE.md`, `docs/accessibility-patterns.md`, agent definitions, or `.claude/` content change.

Before proposing fixes for theme-check warnings, check `THEME_CHECK_NON_ACTIONABLE.md` first; the project may have triaged the finding as a known false positive.

## Development commands

```bash
npm ci
npx shopify theme dev                                                                # local dev server
npx shopify theme check                                                              # linter
npx shopify theme pull -s sapphire-shadow-studio --live --path /tmp/live --nodelete  # inspect live read-only
```

**Do NOT run** `shopify theme push` or `shopify theme pull` against the working tree. Live pushes happen exclusively via `deploy.yml`.

## Shopify MCP tools and limits

Two Shopify MCP servers may be registered: `shopify-dev` (docs search + code validation) and `shopify` (Admin data). Admin API scopes change over time; verify a scope before relying on a write capability rather than assuming a fixed set. Full gap list (no media upload, no `templateSuffix`, Flow unreachable, the OAuth token-exchange command for scope-checking and MCP-truncated reads): `docs/shopify-mcp-notes.md`. `validate_theme_codeblocks` (shopify-dev MCP) is the local Liquid validator invoked in the Code-changes workflow above; prefer it over guessing whether a schema / filter / tag is valid.

## Shopify best practices

Follow https://shopify.dev/docs/storefronts/themes/best-practices. Fetch a specific best-practice or Liquid-reference page on demand with `WebFetch`; do not rely on memorised summaries.

## Architecture

### Directory structure

README's Repo layout table covers the top-level directories. One convention not there: JSON template alternates use a dot-suffix (`product.alternate.json`) and follow one of two page-alternate patterns: keep `main` enabled and append sections (Contact pattern), or disable `main` and compose from generic primitives like `hero` / `section` / `faq` (Custom Orders pattern, also used by About and FAQ). Pick the simplest fit. A third pattern, disabling `main` for one monolithic app block, is what About used to be and is not to be reintroduced: that block owned its own palette and type scale, so the page ignored the theme's color schemes and fonts entirely (rationale: `release-notes.md`). Also: root templates must include an `order` array + `sections` map; asset references use `{{ 'filename' | asset_url }}` and `{{ 'icon.svg' | inline_asset_content }}` for inline icons.

Root-level `catalogue.json` is the single source of truth for the offering's shape and vocabulary; its own `comment` field says what it holds and names its two order contracts. **Hand-edited in a reviewed PR only, never by a command or an agent.** Every tool derives from it rather than restating it, and `scripts/lib/catalogue-cohesion.mjs` refuses a PR whose other files disagree, so a new product, colour, size or line is declared there first or the tools refuse. Deliberately NOT derived, each its own vocabulary: `BODY_PHOTO_TOKEN` in `scripts/lib/photo-naming.mjs` (filename tokens are printed on files already on disk), `scripts/size-chart/lib/garments.mjs` (geometry, byte-pinned by the render golden), and prose outside a `catalogue:begin`/`catalogue:end` marker region. **A product's `template` suffix and its handle are different strings**; conflating them has shipped a bug here already, and the a11y label rule, the size-chart template list and the seo-review breadcrumb allowlist all turn on it. Rationale: `release-notes.md`.

### Structured data

All hand-authored JSON-LD routes through one snippet: `snippets/structured-data.liquid`, rendered from `layout/theme.liquid`'s head right after `meta-tags`, and deliberately **not** from `layout/password.liquid`. It dispatches to per-type snippets (`structured-data-organization.liquid`, `structured-data-website.liquid`).

Rules that are easy to break and have no CI check behind them:

- **Entity nodes (Organization, WebSite) are homepage-only.** They are guarded on `request.page_type == 'index'` so the store has exactly one of each. Emitting them per page is the defect this structure replaced.
- **Do not put JSON-LD back in `sections/header.liquid`.** That is where the Organization node used to live, and a comment there says so.
- **Derive `@id` and `url` from `shop.url`, never `request.origin`.** A preview theme and the `*.myshopify.com` host have a different origin, which would mint a second identifier for one entity.
- **Never emit an unguarded trailing comma.** A blank setting inside an array or object silently invalidates the whole node, and browsers surface no parse error. Build optional arrays by collecting non-blank values first, then emitting with `forloop.last`.
- **Do not divide by an image's `aspect_ratio` inside a script tag.** An SVG can report it as zero or nil, and Liquid renders a divide-by-zero as an error string that lands inside the JSON-LD.
- Product / ProductGroup markup is **not** routed here. It comes from Shopify's `{{ product | structured_data }}` filter and is not extensible.
- **`hasMerchantReturnPolicy` is a hardcoded property of the Organization node, not a theme setting.** Do not add a settings dropdown for the category; the categories are not one-field swaps and nothing in CI parses JSON-LD (details in the snippet's doc block). Keep it tracking `/policies/refund-policy`. The node is known to over-state a 14-day window store-wide; that is a recorded accepted risk, not a bug.
- **`ItemList` on collection pages** comes from `snippets/structured-data-collection-list.liquid`, rendered from inside `sections/main-collection.liquid`'s `{% paginate %}` block, not from the shared `snippets/product-grid.liquid` (which search results also render). It is suppressed on filtered views (they canonicalise elsewhere) and re-sorted views (they reorder what the positions assert) but deliberately not on `?page=N`; full rationale in the snippet's doc block.

- **`FAQPage` comes from `sections/faq.liquid`, and its `faq_heading` blocks are excluded by construction.** The loop emits a `Question` only for blocks whose `question` and `answer` are both non-blank, and a heading block carries neither setting, so nothing filters it explicitly. A new block type that happens to define a `question` would start appearing in the markup with no other change. Anchors come from `question | handleize | truncate: 50`, so rewording a question breaks every shared link to it; reordering `block_order` is free.

`snippets/breadcrumbs.liquid` emits its own `BreadcrumbList` and picks a product's parent collection through a four-step cascade whose second step is the `custom.breadcrumb_collection` product metafield. Read `docs/breadcrumb-collection-metafield.md` before setting a value, changing the cascade, or renaming a collection; the metafield definition's Storefronts-read access setting is the setup step whose omission fails silently.

Validate with `validate_theme_codeblocks`, then assert every `application/ld+json` block on the page parses as JSON. Rich Results Test never validated Organization or WebSite, and its URL mode cannot reach a password-gated storefront; use validator.schema.org in code-paste mode.

### Component framework

Custom web-component framework in `assets/component.js`:

```javascript
import { Component } from '@theme/component';

class MyComponent extends Component {
  refs = {};                    // auto-populated from ref="name"
  handleClick(event) { }        // bound via on:click="/methodName"
}
```

- **Element refs**: declare via `ref="elementName"` (or `ref="items[]"` for arrays); access through `this.refs`. Validate required refs in `connectedCallback`; throw on missing.
- **Event binding**: `on:event="/methodName"` in HTML, never `addEventListener` for DOM events the framework can wire. Supported: click, change, select, focus, blur, submit, input, keydown, keyup, toggle.
- **Parent-to-child**: invoke public methods directly. **Child-to-parent**: emit a `CustomEvent` with a typed `detail` payload.
- Build URLs with `URL` and `URLSearchParams`; never concatenate query strings by hand.
- Cancel in-flight `fetch` with `AbortController` before issuing a new request; cancel in `disconnectedCallback`.
- Optimistic UI must revert on error; dispatch a custom event on success for cross-component sync.
- **JSDoc**: `@typedef` the refs object and pass as `Component<Refs>` generic. Optional refs `[name]`; document custom events' `detail` shape.

### Theme editor integration

Sections / blocks update without full reload; JS doesn't auto-execute. Listen on `document`: `shopify:section:load|unload`, `shopify:section:select|deselect`, `shopify:block:select|deselect`, `shopify:inspector:activate|deactivate`. Detect editor mode via `Shopify.designMode` (JS) or `request.design_mode` (Liquid).

When the inspector is active, deactivate fixed-position elements (sticky headers) so they don't obscure inspection outlines. Use `margin` / `gap` for block spacing, not `padding` (padding misaligns the inspector outline).

### Theme blocks vs snippets vs sections

- **Blocks** (`blocks/`): have `{% schema %}`, appear in editor, nest via `{% content_for 'blocks' %}`.
- **Snippets** (`snippets/`): Liquid partials with `{% doc %}`, no schema.
- **Sections** (`sections/`): page-scope. Convention: class `'section-' | append: section.type`; scope per-section CSS vars to the wrapper, apply via inline `style`. `block_order` only when the preset declares blocks as an object (not array).

## Block development

### File structure

```liquid
{% doc %}
  Description.
  @param {string} [optional_param] - Optional inputs in brackets.
{% enddoc %}

<div {{ block.shopify_attributes }} class="block-name">
  {{ block.settings.text }}
  {% content_for 'blocks' %}        {# only if nesting blocks #}
</div>

{% stylesheet %}
  .block-name { }
{% endstylesheet %}

{% schema %}
{ "name": "t:names.block_name", "settings": [] }
{% endschema %}
```

### Block-nesting gotchas

Static vs dynamic `content_for` invocation syntax and schema-targeting (`"blocks": [...]`, `"tag": null`) are standard Shopify theme-block features; look them up via `validate_theme_codeblocks` or the shopify-dev MCP rather than trusting a memorised summary. Two project-specific gotchas that aren't in Shopify's docs:

- **Only ONE `{% content_for 'blocks' %}` per file.** Need the same dynamic-block region in multiple places? **Capture** it once into a variable and emit the variable.
- **A block cannot read another block's settings.** When two blocks must agree on a value, put it in `settings_schema.json` and share a snippet that reads it (see `snippets/size-option-position.liquid`, read by both the variant picker and the acknowledgement block); duplicating the setting on each block gives two sources of truth that drift apart silently.
- **NEVER edit `{% schema %}` directly** when it's generated from source (e.g. by `scripts/size-chart/`); modify the source and regenerate.

## Coding standards

### Liquid

- Use `{% liquid %}` for multiline logic blocks.
- Inline variables in HTML attributes rather than declaring many upfront.
- All snippets require `{% doc %}` with `@param` and `@example`. Type in braces, optional params in brackets, nested as `object.property`.
- Translation keys: `{{ 'namespace.key' | t }}`. Schema-side: `t:names.<key>`.
- **NEVER edit `{% schema %}` blocks directly** (see Block development).
- Use `{% assign %}` only when needed (complex filter params, reused calculations, deep logic). Use `{% capture %}` only for multi-line content that won't fit inline.

### CSS

- **BEM**: `.block__element--modifier`. Single-class selectors where possible. No IDs as selectors. Avoid `!important`.
- **CSS variables**: namespace to component (e.g. `--product-card-padding`). Apply per-section / per-block setting values via inline `style="--var: value"`; do not generate per-instance class names.
- **Logical properties**: `padding-inline`, `margin-block`, `inset` for RTL.
- **Container queries** for responsive components; `container-type: inline-size` on the wrapper.
- Use `{% stylesheet %}` inside sections / blocks for scoped CSS. Standalone CSS in `assets/` is for shared / global styles. `@layer` order: resets → base → components → utilities.

### HTML

- IDs: CamelCase + section/block ID suffix, like `id="ProductModal-{{ section.id }}"`. The suffix is there to keep repeated blocks unique. **Exception: link anchors**, whose job is to be stable and hand-authorable, so they are bare. The only one today is `SizeChart` (`anchor_id` on `_accordion-row`, emitted by `scripts/size-chart/`, targeted by `snippets/size-guide-link.liquid` and by shared `#SizeChart` URLs). Do NOT "fix" it to `SizeChart-{{ block.id }}`; that silently breaks the size-guide link and every bookmarked link. `scripts/size-chart/test/anchor-contract.test.mjs` fails if you do. A second narrow exception: snippets rendered exactly once from `layout/theme.liquid` have no section or block ID to suffix with, so their IDs are bare singletons (today `VacationPopupHeading` in `snippets/vacation-popup.liquid` and `PolicyNavHeading` in `snippets/policy-page.liquid`). A third: `assets/policy-nav.js` slugifies every policy-body `h2` into a bare runtime ID (no Liquid ever sees them) and finishes an incoming `#hash` itself, so `/policies/...#section` links are supported customer-facing URLs. Unlike `SizeChart` they are only as durable as the heading wording: rewording changes the anchor and nothing checks sent links. For one that survives rewording, put an `id` in the Admin body: the component only assigns when a heading has none. That works on operator-authored policies, not the auto-managed privacy policy, whose body Shopify rewrites.
- Typed inputs (`type="search|tel|url|date|time|datetime-local|month|week|color"`) for native validation and mobile keyboards. `pattern=` for regex validation; `formnovalidate` / `formaction` on submit buttons that bypass validation or post elsewhere.
- View transitions: declare `@view-transition` and per-element `view-transition-name` for smooth navigation.
- Avoid `position: fixed` near the bottom of the viewport on mobile (the on-screen keyboard overlaps it).

### JavaScript

- Zero external dependencies; native browser APIs. JSDoc types on params and returns. Component-framework conventions: see Architecture > Component framework.

### Accessibility (global rules)

- **Skip link** at page top; the element at `href="#main"` must have `tabindex="-1"` to receive focus. Hide with sr-only / clip-path, never `display: none`.
- **Form error / success summaries**: heading gets `tabindex="-1"`; on submit, use `requestAnimationFrame` to ensure the heading is visible before `.focus()` and `.scrollIntoView()`.
- **Auto-updating regions**: `aria-live="polite"` (or `role="log"` for chronological history); pair with a visible pause control. Notifications combine sound + visual badge + title-bar change + `aria-live`.
- **Time limits**: warn 20s before expiry and offer extend / disable; minimum interaction window 20 hours for non-critical flows.
- `title` attribute: **only** on `<iframe>` (redundant tooltips and inconsistent SR output elsewhere).
- Touch targets: at least 44×44 CSS pixels.
- All `<img>` need `alt`; `alt=""` for decorative.
- Standard WCAG (contrast, focus-visible, lang on html, viewport zoom, prefers-reduced-motion, flash limits, landmark hygiene) applies; don't restate here.
- **The homepage `<h1>` is the hero lockup**, in `templates/index.json` under section `hero_jVaWmY`, block `headline_lockup`. `sections/header.liquid` deliberately emits no heading; it used to carry an `index`-guarded visually-hidden `<h1>`, which gave the homepage two. Nothing in CI checks heading structure, so verify exactly one `<h1>` per page type by hand after any header or hero change.

### Component-specific accessibility patterns

Load `docs/accessibility-patterns.md` before implementing or modifying any of these widgets: **accordion, breadcrumb, cart drawer, chat window, color swatch, combobox, carousel, disclosure, dropdown navigation, flip card, form, jump nav, modal, product card, slider, switch, tab, tooltip**. Anything that maps to one of these primitives (`<dialog>` ≈ modal; toasts ≈ `aria-live` region; bare "dropdown" ≈ combobox / disclosure / dropdown navigation depending on behaviour); load the same file and use the nearest match. Anything else: global rules above + WCAG.

## Translations

- Keys live in `locales/en.default.json` (storefront) and `locales/en.default.schema.json` (schema).
- **Add the key to the locale file before referencing it**; theme-check fails red on dangling keys.
- When adding storefront-visible strings, mirror into `locales/it.json` and `locales/ro.json` with `TODO: ` placeholders. Those two only, not the other 30: the store publishes exactly one locale, so nothing else is served, and these are the two anyone has kept current (the rest carry the same 8 upstream-era `TODO:` keys and nothing since). Nothing in CI checks either direction (`MatchingTranslations` is off; pa11y audits the default locale), and the premise is an Admin setting, so confirm it rather than assuming: `{ shopLocales { locale primary published } }` through the client in the shipping-copy snippet below. More than one published locale means backfill the rest first.

## Theme settings

Global CSS variables in `snippets/theme-styles-variables.liquid`; color schemes via `color_scheme_group` in `config/settings_schema.json` rendered through `snippets/color-schemes.liquid`. `settings_schema.json` opens with a `theme_info` object. Presets that use nested blocks must declare a `block_order` array. Setting `label` text: under 30 characters, title case, no redundant type qualifier ("Columns", not "Number of columns").

**Social links have one source of truth: `settings.social_*_link` (5 platforms), rendered only by `snippets/social-links.liquid`** (via `blocks/follow-us.liquid` in the footer's follow column, the homepage closing section, the About page's closing section, and the password page below its email signup, one placement per page region; directly in the mobile drawer and desktop header, both behind `header.show_social_icons`). It strips the query and fragment, then derives `@handle` from the last path segment; a `profile.php?id=`-style URL yields none and falls back to the platform name, so store vanity-slug URLs, claiming the slug on the platform rather than inventing one. A URL with no path past the host is skipped on the storefront *and* in `sameAs`, showing only as a disabled item in the editor. Adding a platform means editing two hardcoded lists, `social_platforms` here and `social_keys` in `snippets/structured-data-organization.liquid`, plus a glyph and locale keys. `blocks/social-links.liquid`, `blocks/_social-link.liquid`, and `blocks/_footer-social-icons.liquid` are dead upstream leftovers: never edit them; `social-links` is off the footer schemas but its own preset still offers it on generic `section` blocks, and placing one puts a rival URL set back into template JSON. Rationale: release-notes.md.

**The main menu's collections dropdown is generated, not authored.** A top-level link with no children whose type is `catalog_link` or `collections_link`, on a store with at least one published collection, gets a submenu built from the global `collections` drop: desktop (`blocks/_header-menu.liquid` computes the trigger, `snippets/mega-menu-list.liquid` renders it, the "More" overflow reuses the same markup) and the mobile drawer (`snippets/header-drawer.liquid` recomputes it, in both the accordion and the flat branch, since `drawer_accordion` is `false` and flat is the live path). An authored submenu always wins, so giving that link one child in Admin silently turns the generated list off; a second catalog link silently gets a second dropdown. The list is plain text even under `collection_images` (no static children to read images from), is capped at 50 (Liquid's per-loop ceiling), and is ordered by the `collections` drop, which the operator cannot reorder. Every published collection's title is therefore storefront nav copy. Nothing in CI checks any of this: the menu lives in Admin, not the repo. Rationale: release-notes.md.

**There is deliberately no `social_twitter_link` setting.** `snippets/meta-tags.liquid` has a comment explaining why: re-adding the setting alone reactivates a broken `twitter:site` handle parse that does not handle `x.com` URLs.

**Vacation mode is one toggle, four surfaces, and four sync traps.** `settings.vacation_mode_enabled` drives the announcement slide, the once-per-session popup, the product-page delay checkbox, and the shipping-line note. (1) Four independently dated settings (popup body, checkbox terms, shipping note, `vacation_processing_date`) must be updated together before each enable; nothing reconciles them. `vacation_processing_date` is embedded in each order's acknowledgment property value ("Yes - processing begins after ..."), so it is the record of what the customer agreed to; keep it matching the message text. (2) `settings.vacation_property_label` is the line-item property key on orders; renaming it mid-vacation splits the acknowledgment across orders. (3) The vacation checkbox adds a second fail-closed `:has()` gate on `[ref='acceleratedCheckoutButtonContainer']`, composing with the return-policy gate (both documented in `blocks/accelerated-checkout.liquid`); express checkout shows only when neither is pending. (4) The announcement slide, popup-body default, and checkbox-terms default all deep-link to `/pages/faq#away-from-studio`, which resolves only while `faq_item_vacation` in `templates/page.faq.json` keeps `custom_anchor: "away-from-studio"`; nothing checks the link, so removing or re-anchoring that FAQ entry silently 404s-to-top every vacation surface. The Vacation Mode settings group deliberately uses literal English labels, matching the Shipping Information precedent. Full rationale: release-notes.md.

**Shipping copy has four sources of truth and only one is greppable.** (1) Theme settings `flat_rate_shipping` and `free_shipping_threshold`, read by `snippets/shipping-info.liquid`. (2) Inline HTML in template JSON with no locale keys: the "Shipping & Turnaround" accordion in five product templates plus three answers in `templates/page.faq.json`. (3) The announcement slides in `sections/header-group.json`. (4) Two things outside the repo entirely: the Admin shipping-rate names (Settings > Shipping and delivery) and the Shopify shop policy at `/policies/shipping-policy`. A shipping-copy audit that only runs `git grep` misses the last two, which is how "Expedited" in the theme and "Express" at checkout coexisted. Read the out-of-repo half with:

```bash
node --env-file=.env --input-type=module -e '
import { createAdminClient } from "./scripts/blank-inventory/lib/admin.mjs";
const c = createAdminClient();
console.log(JSON.stringify(await c.gql(`{ shop { shopPolicies { type title body } } }`)));'
```

A campaign email would be a fifth source, and the only one that cannot be corrected after it is sent, so `marketing/emails/` templates deliberately link to the policy and FAQ pages instead of restating a rate, a threshold, or a turnaround.

`write_shipping` is not granted, so rate names are read-only from here and renaming is an operator task in Admin. Also note `blocks/price.liquid`'s `show_shipping_info` setting hardcodes "$8 flat rate shipping and free shipping over $75 threshold" in an editor `info` string, so it goes stale if either theme setting changes.

**Product media alt text drives the gallery.** `snippets/product-media-gallery-content.liquid` filters media by matching alt text against the values of that product's option named by `settings.color_option_name`, so those values are reserved words in alt text. The data lives in Admin, no test reaches it, and every failure is silent. Read `docs/product-media-alt-text.md` before authoring alt text or changing the filter.

**`data-fieldset-index` counts rendered fieldsets, not options.** `assets/variant-picker.js` indexes `refs.fieldsets` with it, so `snippets/variant-main-picker.liquid` must keep the numbering dense: an option collapsed by `settings.variant_dropdown_threshold` emits no fieldset. Numbering by `forloop.index0` instead silently no-ops or, when the collapsed option is not last, mutates the wrong fieldset. Nothing in CI checks it; rationale: release-notes.md.
