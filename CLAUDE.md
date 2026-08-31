# CLAUDE.md

Guidance for Claude Code working in this repo. The repo is a custom Shopify theme based on Horizon, deployed via a PR-based comment-deploy model. `README.md` documents the surface (workflow tables, branches, secrets, rollback, upstream-merge mechanics); this file is the always-loaded policy layer: the rules whose violation fails silently, plus a named `docs/` reference for each deeper surface, cited at the point where you would need it.

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

**No em dashes (Unicode `U+2014`) anywhere in this repo**: code, comments, content files, docs, locale strings, workflow files, and this file itself. The global-rules carve-out for Claude config files does not apply here.

Restructure with commas, semicolons, parens, colons, or periods. Do not substitute ` - ` (spaced ASCII dash). Quickest replacements: a sentence break, a semicolon, or a colon when introducing an explanation.

Sweep before commit with `git grep -l $'\xe2\x80\x94'`, which should return nothing.

## Browser testing

Browser-driven testing of the storefront or a PR preview theme uses the chrome-devtools MCP. It is opt-in: **do not auto-open preview or storefront URLs.** Drive a browser only when the user asks for visual or behavioural verification, not as a default step after a change.

- **Password-protected storefront.** The storefront (custom domain and `*.myshopify.com`) is password-protected, so anonymous requests (WebFetch, curl, a plain `?preview_theme_id=` link) get a 401 or the password page. To view a PR preview theme, open the store's admin themes page (`https://admin.shopify.com/store/sapphire-shadow-studio/themes`), open the draft theme's "more theme actions" menu, and use its **Preview** link. That link carries a `key=` param that sets the password-bypass cookie for the whole browser session; curl does not pick the bypass up.
- **hCaptcha blocks automated form submits.** Shopify's invisible hCaptcha will not complete for storefront form submissions from the automation-flagged MCP browser, so full contact-form round trips must be verified manually.
- **Check for a screenshot before troubleshooting.** When the user references one, and proactively when troubleshooting any issue, look for the newest file in their screenshots directory; ask for that directory the first time it comes up in a session. **Never commit a literal local-machine path** (see Sensitive Content above).
- **Shopify admin login loops in the MCP browser.** accounts.shopify.com silently rejects the chrome-devtools MCP's automation-flagged Chrome, looping "Continue with email" forever. Workaround: kill the MCP-launched Chrome, relaunch the same binary manually with the same `--user-data-dir` (`~/.cache/chrome-devtools-mcp/chrome-profile`) but no automation flags, log in there, then close it; the next MCP call relaunches the browser and the session cookies carry over until the profile's login expires.

## Workflow

README documents the workflow surface (`validate` / `preview` / `deploy` / `sync` tables, branches, secrets, "How shipping works"). This section is Claude-specific additions only: steps not in README, and the auto-deploy gate internals.

### Code changes

Follow README's "How shipping works" for the branch/PR/validate/comment-deploy flow. One thing it does not cover: before pushing, run `validate_theme_codeblocks` (shopify-dev MCP) on every changed Liquid file; it catches schema, filter and tag errors earlier than CI's `theme-check` step. Exception: `marketing/emails/*.liquid` are Shopify Email templates, not theme code, so treat the validator's output there as syntax-only and ignore its undefined-object findings (`marketing/emails/README.md` explains why; the real check is a test send). The local `actionlint` invocation and the `reconcile`-failure fix snippet are in README's Development section and Troubleshooting table.

### Backlog hygiene (`TODO.md`)

`TODO.md` is the single repo-wide backlog and holds **only work that still needs doing**. When an item lands, **delete it from `TODO.md`**; never tick it, never leave a checked-off entry, and never add a "Done" section. The file should read as a list of open actions and nothing else.

Reasoning that outlives the task does not get deleted with it: if the work produced a corrected mistake, a cross-layer contract, a non-obvious constraint, or a decision worth knowing the "why" of, write that into `release-notes.md` in the same change, then remove the `TODO.md` entry. A durable rule about how to work in this repo belongs in this file instead. This applies to "won't do" items as much as to shipped ones.

### Admin-side edits

Admin Customize/Code edits go on the `EDIT HERE - Admin Sync` theme, never live; README's "Branches and themes" covers the shopify-sync mechanics. Auto-deploy on the reconcile PR halts with a sticky skip-comment on signed-commit-identity failure, PR-opener mismatch, HEAD drift, stale base, missing-main-commits, or an out-of-scope diff (touching `.github/` or `layout/theme.liquid`, or over a LOC threshold set in `deploy.yml`'s `gate` job). A hand-opened shopify-sync PR by anyone but the configured PAT owner fails the PR-opener check and must be deployed via a `deploy` comment.

**Escape hatch**: mark the auto-reconcile PR as a draft (`gh pr ready --undo <n>`); auto-deploy skips drafts. Convert back to ready-for-review to resume.

**A reconcile PR that DELETES a theme file is a halt signal**: none of the gates above look at deletions. Draft the PR and find out what the admin theme did, rather than re-adding the file, which may not be what should come back. This has happened (`release-notes.md`, policy pages).

### Live theme and preview cleanup

Do not click "Customize" or "Edit code" on the live theme card in admin; use the sync theme (README's "Branches and themes" table has the theme ID). Orphaned `pr-N-preview` themes have no scheduled sweep: the failure signal is `:warning: **Preview cleanup warning**` in the deploy-report comment, and README's Troubleshooting table has the recovery commands.

### Smoke test (node fetch; catalog-wide)

The post-deploy smoke (`.github/actions/shopify-theme-push/smoke.mjs`) probes every published product from the sitemap, not a fixed handle list, so a broken template or a missing product HARD-FAILs the deploy. It is node `fetch`, not curl: Cloudflare bot-management blocklists curl's fingerprint, so **do not reintroduce a curl probe**. Full behavior: `docs/smoke-test-reference.md`.

### Deploy gate trust delta

`deploy.yml` is a three-job pipeline (`gate` / `deploy` / `sync`) with no GitHub Environment binding and each secret isolated to one job. Four gates govern auto-deploy; do not weaken any of them in a refactor: **collaborator permission** (comment path), **validate-on-HEAD-SHA** (all paths), the **signed-commit gate** (workflow_run paths), and the **defence-in-depth merge-base assertion** (workflow_run paths).

Three refactor hazards, each already the cause of a regression here:

- Gate on the `validate` **job** (`listJobsForWorkflowRun`), never on `workflow_run.conclusion`: the same run's `deploy-preview` job pushes a preview theme, so a Shopify hiccup there fails the run with all validation green. Do not rename that job; the name is hardcoded, as is the workflow name in `on.workflow_run.workflows`.
- Do not drop `compareCommits.status === 'identical'` as "redundant" with SHA equality. It is commit-object, not tree, equality, so it independently catches same-tree amends and different-tree force-pushes.
- Do not add strict equality on `commit.committer.login`. A legitimate `web-flow` committer (web-UI edits, Update-branch/Rebase, `@dependabot rebase`) is not a security signal; that was a prior false-positive regression.

Do NOT add `SHOPIFY_SYNC_DEPLOY_KEY` as a bypass actor on any ruleset protecting `main`. It has full repo push capability, and its `Deploy keys` bypass row is scoped to `shopify-sync-protection` alone.

Full mechanics (per-gate API calls, integrity-boundary reasoning, known compensations): `docs/deploy-gate-reference.md`. Design rationale, alternatives considered, and incident history: `release-notes.md`.

### Secrets vs variables policy

A value is a **secret** if it grants write access to live infrastructure or a third-party API, a **variable** if it is already observable on any unauthenticated storefront request or in the repo's public surface. Actions auto-redacts `secrets.*` in logs (`***`) and leaves `vars.*` in plaintext, so before adding a `vars.*` entry ask whether you would be comfortable seeing that value in a workflow log or a smoke-test PR comment. Per-secret call sites and rotation are operator-managed, outside this file.

## Pre-PR review

The global gate supplies general code review (the headless `/code-review`) and `/security-review`; there is no `code-reviewer`, `architecture-reviewer`, or `security-auditor` agent to invoke. This repo always adds **doc-sync-checker** (diff-scoped), plus these on their own triggers:

- **infra-reviewer**: any change touching `.github/workflows/` or `.github/actions/`. `deploy.yml` is a three-job pipeline (gate / deploy / sync) with secret isolation; `workflow_run` paths depend on the literal name `validate` and the `dependabot/**` glob; no workflow binds a GitHub Environment.
- **test-engineer**: theme Liquid has no test framework, so skip it for theme changes. Run it when the code behind any `node --test` suite changes: `scripts/size-chart/`, `scripts/blank-inventory/`, `scripts/applique-grid/`, `scripts/email-icons/`, `scripts/catalogue/`, `scripts/lib/`, and the top-level `scripts/*.test.mjs`. `blank-inventory/` writes live inventory and `upload-product-media.mjs` writes live product media, so those two are higher-risk.
- **prompt-reviewer**: run when this `CLAUDE.md`, any of the four reference docs it points at (`docs/theme-conventions.md`, `docs/structured-data.md`, `docs/theme-settings-contracts.md`, `docs/accessibility-patterns.md`), agent definitions, or `.claude/` content change.

Before proposing fixes for theme-check warnings, check `THEME_CHECK_NON_ACTIONABLE.md` first; the project may have triaged the finding as a known false positive.

## Development commands

`npm ci`, then `npx shopify theme dev` for the local dev server and `npx shopify theme check` for the linter; README's Development section covers the rest, including `actionlint`.

**Do NOT run** `shopify theme push` or `shopify theme pull` against the working tree. Live pushes happen exclusively via `deploy.yml`. To inspect the live theme, pull it read-only to a scratch path: `npx shopify theme pull -s sapphire-shadow-studio --live --path /tmp/live --nodelete`.

## Shopify MCP tools and limits

Two Shopify MCP servers may be registered: `shopify-dev` (docs search + code validation) and `shopify` (Admin data). Admin API scopes change over time, so verify a scope before relying on a write capability rather than assuming a fixed set; the full gap list is `docs/shopify-mcp-notes.md`. Prefer `validate_theme_codeblocks` over guessing whether a schema, filter, or tag is valid.

## Shopify best practices

Follow https://shopify.dev/docs/storefronts/themes/best-practices. Fetch a specific best-practice or Liquid-reference page on demand with `WebFetch`; do not rely on memorised summaries.

## Architecture

### Directory structure

README's Repo layout table covers the top-level directories. One convention not there: JSON template alternates use a dot-suffix (`product.alternate.json`) and follow one of two page-alternate patterns: keep `main` enabled and append sections (Contact pattern), or disable `main` and compose from generic primitives like `hero` / `section` / `faq` (Custom Orders pattern, also used by About and FAQ). Pick the simplest fit. A third pattern, disabling `main` for one monolithic app block, is what About used to be and is not to be reintroduced: that block owned its own palette and type scale, so the page ignored the theme's color schemes and fonts entirely (rationale: `release-notes.md`). Also: root templates must include an `order` array + `sections` map; asset references use `{{ 'filename' | asset_url }}` and `{{ 'icon.svg' | inline_asset_content }}` for inline icons. **Placing a `_product-card` block in a template copies hand-maintained JSON that nothing in CI compares across templates**; take the values from "The site-standard product card" in `docs/theme-conventions.md` rather than from whatever the editor emits.

Root-level `catalogue.json` is the single source of truth for the offering's shape and vocabulary; its own `comment` field says what it holds and names its two order contracts. **Hand-edited in a reviewed PR only, never by a command or an agent.** Every tool derives from it, and `scripts/lib/catalogue-cohesion.mjs` refuses a PR whose other files disagree, so a new product, colour, size or line is declared there first or the tools refuse. Deliberately NOT derived, each its own vocabulary: `BODY_PHOTO_TOKEN` in `scripts/lib/photo-naming.mjs` (those tokens are printed on files already on disk), `scripts/size-chart/lib/garments.mjs` (geometry, byte-pinned by the render golden), and prose outside a `catalogue:begin`/`catalogue:end` marker region. **A product's `template` suffix and its handle are different strings**; conflating them has shipped a bug here already, and the a11y label rule, the size-chart template list and the seo-review breadcrumb allowlist all turn on it. Rationale: `release-notes.md`.

### Structured data

**Before editing `snippets/structured-data*.liquid`, or adding any `application/ld+json` block, read `docs/structured-data.md`.** All hand-authored JSON-LD routes through one snippet, `snippets/structured-data.liquid`, rendered from `layout/theme.liquid`'s head and deliberately not from `layout/password.liquid`. These five have no automatic check behind them and fail silently:

- **Entity nodes (Organization, WebSite) are homepage-only**, guarded on `request.page_type == 'index'` so the store has exactly one of each. And **do not put JSON-LD back in `sections/header.liquid`**, where the Organization node used to live.
- **Derive `@id` and `url` from `shop.url`, never `request.origin`.** A preview theme and the `*.myshopify.com` host differ in origin, which would mint a second identifier for one entity.
- **Never emit an unguarded trailing comma.** A blank setting inside an array or object silently invalidates the whole node, with no browser parse error. Collect non-blank values first, then emit with `forloop.last`.
- **Do not divide by an image's `aspect_ratio` inside a script tag.** An SVG can report it as zero or nil, and Liquid renders the divide-by-zero as an error string that lands inside the JSON-LD.
- **`hasMerchantReturnPolicy` is hardcoded on the Organization node, not a theme setting.** Do not add a settings dropdown for the category; the categories are not one-field swaps.

`snippets/breadcrumbs.liquid` emits its own `BreadcrumbList` and picks a product's parent collection through a four-step cascade whose second step is the `custom.breadcrumb_collection` product metafield. Read `docs/breadcrumb-collection-metafield.md` before setting a value, changing the cascade, or renaming a collection; the metafield definition's Storefronts-read access setting is the setup step whose omission fails silently.

## Theme conventions

**Before creating or editing a block, section, snippet, or `assets/component.js`, read `docs/theme-conventions.md`.** It holds the component framework (refs, `on:` event binding, parent/child communication), the theme-editor lifecycle event names, the block file structure, and the Liquid / CSS / HTML / JavaScript standards. Inline here, because each of these fails silently or only at CI time, never at authoring time:

- **Zero external JavaScript dependencies**; native browser APIs only. BEM class names, and scope component CSS with `{% stylesheet %}` inside the section or block rather than adding to `assets/`.
- **NEVER edit a `{% schema %}` block that is generated from source** (e.g. by `scripts/size-chart/`); modify the source and regenerate.
- **Only ONE `{% content_for 'blocks' %}` per file.** Need the region in two places? Capture it once into a variable and emit the variable.
- **A block cannot read another block's settings.** When two must agree on a value, put it in `settings_schema.json` and share a snippet that reads it (see `snippets/size-option-position.liquid`); a setting duplicated per block is two sources of truth that drift apart silently.
- **Do not "fix" the bare `#SizeChart` anchor to `SizeChart-{{ block.id }}`.** Link anchors are deliberately unsuffixed so they stay hand-authorable; suffixing it breaks `snippets/size-guide-link.liquid` and every bookmarked link. `scripts/size-chart/test/anchor-contract.test.mjs` catches it, but at CI time, not while you are editing.

### Accessibility

`docs/accessibility-patterns.md` holds both the global rules (skip link, live regions, form-error summaries, touch targets, `title` only on `<iframe>`) and the per-widget role / attribute / keyboard sets. **Load it before implementing or modifying any of these widgets: accordion, breadcrumb, cart drawer, chat window, color swatch, combobox, carousel, disclosure, dropdown navigation, flip card, form, jump nav, modal, product card, slider, switch, tab, tooltip.** Anything that maps to one of these primitives (`<dialog>` is a modal; toasts are an `aria-live` region; a bare "dropdown" is a combobox, disclosure, or dropdown navigation depending on behaviour) uses the nearest match. Anything else: that file's global rules plus WCAG.

One rule that lives outside any widget: **the homepage `<h1>` is the hero lockup**, in `templates/index.json` under section `hero_jVaWmY`, block `headline_lockup`. `sections/header.liquid` deliberately emits no heading; it used to carry an `index`-guarded visually-hidden `<h1>`, which gave the homepage two. Nothing in CI checks heading structure, so verify exactly one `<h1>` per page type by hand after any header or hero change.

## Translations

- Keys live in `locales/en.default.json` (storefront) and `locales/en.default.schema.json` (schema).
- **Add the key to the locale file before referencing it**; theme-check fails red on dangling keys.
- When adding storefront-visible strings, mirror into `locales/it.json` and `locales/ro.json` with `TODO: ` placeholders. Those two only, not the other 30: the store publishes exactly one locale, so nothing else is served, and these are the two anyone has kept current (the rest carry the same 8 upstream-era `TODO:` keys and nothing since). Nothing in CI checks either direction (`MatchingTranslations` is off; pa11y audits the default locale), and the premise is an Admin setting, so confirm it rather than assuming: `{ shopLocales { locale primary published } }` through the Admin client, using the snippet under "Shipping copy" in `docs/theme-settings-contracts.md`. More than one published locale means backfill the rest first.

## Theme settings

**Before changing any social, navigation, vacation-mode or shipping-copy setting, or the fieldset-indexing logic in `snippets/variant-main-picker.liquid` / `assets/variant-picker.js`, read `docs/theme-settings-contracts.md`.** Every item below fails silently, and nothing in CI checks any of them:

1. **Adding a social platform means editing two hardcoded lists**, `social_platforms` in `snippets/social-links.liquid` and `social_keys` in `snippets/structured-data-organization.liquid`, or `sameAs` silently drifts from the storefront links. The one source of truth is `settings.social_*_link`, rendered only by `snippets/social-links.liquid`; `blocks/social-links.liquid`, `blocks/_social-link.liquid` and `blocks/_footer-social-icons.liquid` are dead upstream leftovers, so never edit them or place one.
2. **The main menu's collections dropdown is generated, not authored.** A top-level `catalog_link` / `collections_link` with no children builds its own submenu; giving that link even one child in Admin silently turns the generated list off, and a second catalog link silently gets a second dropdown.
3. **Never add a `settings.social_twitter_link`.** The setting alone reactivates a broken `twitter:site` handle parse that mishandles `x.com` URLs; `snippets/meta-tags.liquid` carries a comment saying so.
4. **Vacation mode is one toggle, four surfaces, four sync traps.** Four independently dated settings (popup body, checkbox terms, shipping note, `vacation_processing_date`) must be updated together before each enable; nothing reconciles them, and `vacation_processing_date` is the record of what each customer agreed to.
5. **Shipping copy has four sources of truth and only one is greppable.** Two sit outside the repo entirely (the Admin shipping-rate names and the `/policies/shipping-policy` shop policy), so an audit that only runs `git grep` misses half of it.
6. **`requires_shipping` is the predicate for all shipping math and gating, never `cart.total_price`.** Checkout excludes digital gift card value from its price-based rate conditions, so a mixed cart over the threshold is still charged the flat rate; summing the order total promises free shipping checkout will not honour. Use `gift_card?` (the question mark is part of the property name) only where the copy is specifically about gift cards, and never `product.gift_card` or `item.product.gift_card`: both are nil, Liquid renders nil as nothing, and `theme-check` passes, so the wrong branch is taken silently and forever.
7. **`data-fieldset-index` counts rendered fieldsets, not options.** An option collapsed by `settings.variant_dropdown_threshold` emits no fieldset, so numbering by `forloop.index0` in `snippets/variant-main-picker.liquid` silently no-ops or mutates the wrong fieldset when the collapsed option is not last.

**The FAQ page is its own silent-failure surface, and the two triggers above do not name it.** Before editing `sections/faq.liquid` or `templates/page.faq.json`, read the `FAQPage` rules in `docs/structured-data.md` (a new block type defining a `question` starts appearing in the markup with no other change, and rewording a question rewrites its `handleize`d anchor, breaking every shared link) and the vacation-mode entry in `docs/theme-settings-contracts.md` (the announcement slide, popup body and checkbox terms all deep-link to `/pages/faq#away-from-studio`, which resolves only while `faq_item_vacation` keeps `custom_anchor: "away-from-studio"`; nothing checks the link).

**Product media alt text drives the gallery.** `snippets/product-media-gallery-content.liquid` filters media by matching alt text against the values of that product's option named by `settings.color_option_name`, so those values are reserved words in alt text. The data lives in Admin, no test reaches it, and every failure is silent. Read `docs/product-media-alt-text.md` before authoring alt text or changing the filter.
