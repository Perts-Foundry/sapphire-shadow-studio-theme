# CLAUDE.md

Guidance for Claude Code working in this repo. The repo is a custom Shopify theme based on Horizon, deployed via a PR-based comment-deploy model. `README.md` documents the surface (workflow tables, branches, secrets, rollback, upstream-merge mechanics); this file holds Claude-specific policy, gotchas, and theme conventions.

## Sensitive Content

This repository is **public**. Real personal contact metadata, internal strategy / legal advisory content, and dev-machine identifiers must never appear in the repo, git history, PRs, issues, comments, or release artifacts. Brand-personality copy that already appears on the storefront (founder narrative, About / FAQ pages, photography filenames that don't expose personal identifiers) is intentional and fine to commit. The repo was deleted-and-recreated once already to scrub embedded metadata; do not reintroduce it.

The `secret-scan` job (Gitleaks) catches token-shaped strings but does not catch personal emails, addresses, or merchant-keyed prose; the author's responsibility per the checklist below.

### What is sensitive (do not commit)

- **Personal contact metadata**: personal email addresses (Gmail, iCloud, etc.), personal phone numbers, full home / fulfilment addresses, personal social handles. The brand identifies itself via the public storefront; individual operators do not need to.
- **Commit-author email**: local `git config user.email` must be `seth@pertsfoundry.com` or the GitHub no-reply form. Personal Gmail in `Author:` lines is a commit-metadata leak that **no diff will ever show**, so it slips through every other check.
- **Dev-machine identifiers**: absolute filesystem paths with a username (`/Users/Seth/...`, `/c/Users/Seth/...`, `/mnt/c/Users/Seth/...`, `~/repos/...`). Use placeholders in docs (`<screenshots-dir>`, `<repo-root>`); the user's private global `~/.claude/CLAUDE.md` holds the real path.
- **Internal advisory / strategy docs**: legal-exposure analyses, ADA-risk playbooks, insurance posture notes, settlement-range guidance, demand-letter response checklists, tax / accounting research. These belong in a private notes location (1Password, private gist, `~/notes/`), never in `docs/` of a public theme repo.
- **Operating location below state level**: city, county, ZIP, or any detail that could pinpoint a home-based operation. Brand-level state-or-larger framing in storefront copy is fine; legal-exposure framing tied to a specific jurisdiction is not.
- **Tokens of any kind**: `SHOPIFY_CLI_THEME_TOKEN`, GitHub PATs, Shopify Admin API tokens, third-party app keys (Judge.me, Klaviyo, etc.), AI keys. CI references `${{ secrets.* }}` only.
- **Real customer / order / financial data**, even truncated. Use synthetic fixtures (`Test Customer`, `order-id-12345`, `Acme Corp`).
- **Pre-publish drafts** that name real third parties (vendors, suppliers, partners) outside what's already on the storefront.

### What is NOT sensitive (and is fine to commit)

- Founder narrative and brand voice: anything already on the storefront's About / FAQ page (first names, husband-and-wife framing, prior-career mentions, pet references). Image filenames encoding pet names (`Kitkat-Rory.jpg`) are fine when the same names appear in visible copy.
- The brand name "Sapphire Shadow Studio" and the public store handle `sapphire-shadow-studio`.
- The live theme numeric ID and `*.myshopify.com` / custom storefront domain; public on every storefront page render.
- App-embed install UUIDs (Shopify Inbox, Judge.me, etc.); observable in any browser DOM inspection.
- Public Shopify policies content under `/policies/...`.
- State-level location framing in storefront copy (not in legal / strategy context).
- Synthetic test fixtures.
- The `EXPECTED_SYNC_PR_OPENER` repo variable's value (a GitHub login). The opener identity is necessarily public surface (visible on every PR the PAT opens, the contributors page); storing it as a secret would not protect it.
- The `SHOPIFY_SYNC_DEPLOY_KEY` deploy key's public-key fingerprint / title (admin-only `/settings/keys` page), its numeric ID, and the matching bypass-actor `actor_id` on `shopify-sync-protection`. Admin-observable identifiers, not authentication material.

### Pre-push checklist

Before every `git push`, every `gh pr create`, every `gh pr comment`, and every `gh issue create`:

1. **Scan the full branch diff** (`git diff origin/main..HEAD`) and **every commit message** (`git log origin/main..HEAD --format=%B`) for: personal emails, personal phone, machine paths, tokens, merchant-keyed strategy framing, sub-state location detail.
2. **Scan the rendered PR / issue / comment body** for the same categories. Content typed into `gh pr create --body` does not pass through the diff scan and is not covered by Gitleaks.
3. **Verify the `secret-scan` CI check is green** on the latest PR run. Red means stop and triage, not "rebase past it."
4. **Verify `git config --local user.email`** is `seth@pertsfoundry.com` or the no-reply form. Gmail in author metadata is the "no diff will ever show" leak from the bullet list above and slips through every other check.
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
- **Shopify admin login loops in the MCP browser.** accounts.shopify.com silently rejects the chrome-devtools MCP's automation-flagged Chrome (POST `/lookup` goes out with `origin: null`, the server 302s back to the form with a fresh `verify=` param, and "Continue with email" loops forever). Workaround: kill the MCP-launched Chrome, relaunch the same binary manually with the same `--user-data-dir` (`~/.cache/chrome-devtools-mcp/chrome-profile`) but no automation flags, log in there, then close it; the next MCP call relaunches the browser and the session cookies carry over. The profile is persistent, so login survives MCP restarts until the session expires.

## Project overview

Custom Shopify theme based on **Horizon** (Shopify's flagship); server-rendered Liquid + theme blocks + progressive enhancement. Private, single-merchant theme, not a Shopify Theme Store submission. The repo is **standalone, not a GitHub fork** of `Shopify/horizon`; attribution and upstream-merge mechanics in `LICENSE.md` and `README.md`.

## Workflow

PR-based deploy model. Direct edits to `main` and to the live theme are not part of the workflow. `README.md` documents the workflow tables (`validate` / `preview` / `deploy` / `sync`, branches, secrets); this section holds Claude-specific do/don't, the auto-deploy gates, and the deploy-gate trust delta.

### Code changes

1. `git switch -c <feature-branch> origin/main`.
2. Local dev: `npm ci && npx shopify theme dev`. The dev server uses an unpublished on-the-fly theme; storefront edits don't touch live or `shopify-sync`.
3. Before pushing, run `validate_theme_codeblocks` (shopify-dev MCP) on every Liquid file you changed. It catches schema / filter / tag errors locally and earlier than the CI `theme-check` step; it complements that job, it does not replace it.
4. Open a PR. Validate runs `theme-check`, `reconcile`, `size-chart` (`npm run size-chart:test`), `actionlint`, `zizmor --pedantic`, `gitleaks` as one sequential job. Single required check on `main`: `validate / validate`. To re-run, push a new commit (no comment trigger).
5. Local actionlint with the same shellcheck excludes CI uses: `SHELLCHECK_OPTS="-e SC2016 -e SC2317" actionlint` (see the `env:` block on `validate.yml`'s `actionlint` step, which documents why each code is a false positive here).
6. If `reconcile` fails, run the snippet it posts: `git fetch origin && git merge origin/shopify-sync && git push`.
7. Comment `deploy` on the PR. `deploy.yml` handles live push, smoke, preview cleanup, squash-merge, and `shopify-sync` fast-forward. On step failure a sticky failure report overwrites the deploy report and the PR stays open.

### Admin-side edits

All theme-customizer / code-editor edits **must** be made on the unpublished `EDIT HERE - Admin Sync` theme (connected to `shopify-sync` via the Shopify GitHub Integration), NEVER on live. Admin edits auto-commit to `shopify-sync` via `shopify[bot]`. `sync.yml` opens or refreshes the single reconcile PR (`head: shopify-sync, base: main`) on each push, plus a 13:00 UTC daily safety-net cron. After Validate succeeds, `deploy.yml`'s `workflow_run` arm auto-deploys.

Auto-deploy halts with a sticky skip-comment on: signed-commit-identity failure, PR-opener mismatch, HEAD drift, stale base, missing-main-commits, or out-of-scope diff (touches `.github/` or `layout/theme.liquid`, or exceeds 1000 LOC). A hand-opened shopify-sync PR by anyone other than the configured PAT owner fails the PR-opener check and must be deployed via `deploy` comment.

**Escape hatch**: mark the auto-reconcile PR as a draft (`gh pr ready --undo <n>`); auto-deploy skips drafts. Convert back to ready-for-review to resume. The `shopify-sync` branch is never deleted on merge.

To inspect what is currently live without altering the working tree: `npx shopify theme pull -s sapphire-shadow-studio --live --path /tmp/live --nodelete`. **Never** pull live into the working tree.

### Live theme

Live theme is `#181702754604`. **Disconnected** from GitHub; only `deploy.yml` writes to it. Do not click "Customize" or "Edit code" on the live theme card in admin; use the sync theme. There is no automated drift detection; "live = main" is operator discipline.

### Preview-theme cleanup

`pr-N-preview` themes are deleted inline by the deploy workflows on merge and by `preview.yml::cleanup` on PR close. No scheduled sweep. If cleanup silently fails (deploy chain has `continue-on-error: true`) or skips (concurrency / runner outage), the orphan persists. The signal: `:warning: **Preview cleanup warning**` line in the deploy-report comment's `cleanup_status` row. Manual recovery (with `SHOPIFY_CLI_THEME_TOKEN` set):

```bash
# List orphans
npx shopify theme list -s sapphire-shadow-studio --json \
  | jq -r '.[] | select(.name | test("^pr-[0-9]+-preview$")) | "\(.id)\t\(.name)"'

# Delete a specific orphan
npx shopify theme delete --theme <id> --force
```

### Smoke test fixtures

None defined. `shopify-theme-push/action.yml`'s `smoke-paths` default covers `/`, `/cart`, `/collections/all`. Commit a stable product handle to this section once one exists, then extend the action default at `action.yml:39`.

### Deploy gate trust delta

The deploy chain has **no GitHub Environment binding**. `SHOPIFY_CLI_THEME_TOKEN` is a repo-level secret; `SHOPIFY_DOMAIN` / `SHOPIFY_FLAG_STORE` / `EXPECTED_SYNC_PR_OPENER` are repo-level variables. `deploy.yml` is a three-job pipeline: `gate` (no token; computes the gates below), `deploy` (Shopify token, no deploy key; `needs: gate`; live push + smoke + squash-merge), and `sync` (deploy key, no Shopify token; `needs: deploy`; reconciles `shopify-sync`). Each secret is isolated to one job's bash.

Four computed gates govern auto-deploy. Full attack/mitigation chains, alternatives considered, and historical bugs are in `release-notes.md`; the load-bearing rules that must survive future refactors are inlined here.

1. **Collaborator permission** (comment path). `gate` calls `getCollaboratorPermissionLevel` on the comment author and proceeds only for `admin` / `write`. Workflow-level `if` pre-filters by `author_association` and asserts `github.event.issue.pull_request`.

2. **Validate-on-HEAD-SHA** (all paths). Comment path: `listWorkflowRuns` filtered by `validate.yml`, `head_sha`, **and** `event: 'pull_request'` (the event filter blocks a future `push` / `workflow_dispatch` trigger on validate.yml from masquerading as proof). Workflow_run paths: re-fetch the triggering Validate run via `getWorkflowRun`, assert `conclusion: success`, thread the returned `head_sha` as `trustedSha` through every downstream API call. HEAD-drift is first asserted via `pr.head.sha === trustedSha`; `compareCommits.status === 'identical'` is **defence in depth** on top of that.
   - **Do not "simplify" the `compareCommits` check away** as redundant with the SHA equality. The comparison is commit-object equality, **not** tree equality; same-tree amends, cherry-picks, and different-tree force-pushes all return `diverged`, not `identical`. The check was added explicitly so a future refactor wouldn't remove a load-bearing guardrail on a wrong premise; `release-notes.md` documents this.
   - For workflow_run paths, Validate is **advisory** (a malicious PR head could rewrite `validate.yml` to pass falsely). The actual integrity boundary for auto-deploys is the signed-commit gate below.

3. **Signed-commit gate** (workflow_run paths). Assert `verification.verified === true`, `commit.author.login === expectedBot` (`shopify[bot]` for shopify-sync; `dependabot[bot]` for dependabot), and `pull_request.user.login === expectedPrOpener` (shopify-sync: `vars.EXPECTED_SYNC_PR_OPENER` at runtime, the PAT owner; dependabot: the `dependabot[bot]` constant).
   - **`commit.committer.login` may be `expectedBot` OR `web-flow` and is informational, not a security signal.** Anyone with `contents: write` can produce a `web-flow` committer via web-UI edits, the Update-branch / Rebase buttons, `PUT /contents/{path}`, or `@dependabot rebase` / `@dependabot recreate`. Strict equality on committer was the source of a prior false-positive regression (see `release-notes.md`); do not re-introduce it.
   - Integrity boundary: author identity + signature verification + PR-opener identity. Git-commit-header fields are forgeable and not consulted. Trust delta for the post-PAT PR-opener (now a PAT-exfiltrable login): bounded by signed-commit-identity above and by gate 4 below; full chain in `release-notes.md`.

4. **Defence-in-depth merge-base assertion** (workflow_run paths). `repos.compareCommits(base: main_tip, head: trustedSha).behind_by === 0`. Catches "PR head was missing main commits at PR creation time"; independent of the base-staleness check in gate 2. For shopify-sync, blocks the misleading-revert PR scenario and the PAT-exfil stale-PR replay (independently of `sync.yml`'s own merge-base prevention guard at the create-PR call site). For dependabot, no-op in the normal flow; belt-and-braces.

All four gates assume workflow files are correct. A compromised `contents: write` collaborator who can land any PR bypasses all of them and could already exfiltrate any secret via a malicious workflow change; the PAT and deploy key do not enlarge this surface.

**Deploy-key bypass-row scope.** `SHOPIFY_SYNC_DEPLOY_KEY` has full repo push capability across all refs (deploy keys are repo-scoped by GitHub design). The `Deploy keys` bypass-actor row on ruleset `shopify-sync-protection` is what scopes its bypass authority to that one branch. **Do NOT add the deploy key as a bypass actor on any ruleset protecting `main`.** Bypass authority is decoupled from human role membership.

**Known compensations** (deferred): a preview-only Shopify token; a long-lived `auto-deploy-audit` issue for forensics beyond 90-day log retention.

### Secrets vs variables policy

GitHub Actions auto-redacts `secrets.*` in logs (`***`); `vars.*` is plaintext. Classify as secret if the value grants write access to live infrastructure or a third-party API; classify as variable if it's already observable on any unauthenticated storefront request or in the repo's public surface. Per-secret call sites and rotation procedures are tracked outside this file (operator-managed). Before adding a new `vars.*` entry, ask: would I be comfortable seeing this value in a workflow log, smoke-test PR comment, or quoted by a reviewer? If not, classify as a secret.

## Pre-PR review

Standard agent set (`code-reviewer`, `doc-sync-checker`, `architecture-reviewer`, `security-auditor`) applies. Project-specific triggers:

- **infra-reviewer**: any change touching `.github/workflows/` or `.github/actions/`. `deploy.yml` is a three-job pipeline (gate / deploy / sync) with secret isolation; `workflow_run` paths depend on the literal name `validate` and the `dependabot/**` glob; no workflow binds a GitHub Environment.
- **test-engineer**: theme Liquid has no test framework, so skip for theme changes. The `scripts/size-chart/` tooling does have a `node --test` suite (`npm run size-chart:test`); run test-engineer when that tooling changes.
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

Two Shopify MCP servers may be registered: `shopify-dev` (docs search + code validation) and `shopify` (Admin data). Known gaps, so a task isn't misrouted through the MCP:

- **Admin data is read-only; every write fails.** The `shopify` Admin MCP registers write tools (`create-product`, `manage-product-variants`, `update-product`) and they are callable, but the app behind it holds only `read_inventory,read_products,read_content,read_themes`, so a write returns `ACCESS_DENIED: Required access: 'write_products' access scope`. Exchanging `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` for an Admin API token (`POST https://${MYSHOPIFY_DOMAIN}/admin/oauth/access_token`, `grant_type=client_credentials`) is **not** a way around this: it grants the same four scopes. Confirm with `GET /admin/oauth/access_scopes.json`. Reads go through either path (use the token when the MCP truncates, e.g. `get-product-by-id` caps variants at 20 and cannot enumerate a full option set). **Writes go through the Admin UI**, unless the operator grants `write_products` and reinstalls the app. Never commit the token or the exchange script.
- **No media / image upload.** Neither the MCP nor the token can upload an image or file. Theme imagery ships through the `assets/` directory; product / media imagery goes through the Admin UI or the Files API.
- **No `templateSuffix`.** It is on neither `create-product` nor `update-product`, and the MCP does not return it on reads. Assigning a product's theme template is an Admin UI step, and a product whose suffix does not resolve has nothing behind it: this theme ships no default `templates/product.json`.
- **Shopify Flow is unreachable.** No MCP tool reads or writes Flow. A `.flow-export` file cannot be round-tripped through the MCP; Flow automations are inspected and edited only in the Admin Flow app. Do not attempt to reconstruct or diff Flow state from the MCP.
- **`validate_theme_codeblocks`** (shopify-dev MCP) is the local Liquid validator invoked in the Code-changes workflow above; prefer it over guessing whether a schema / filter / tag is valid.

## Shopify best practices

Follow https://shopify.dev/docs/storefronts/themes/best-practices. Fetch a specific best-practice or Liquid-reference page on demand with `WebFetch`; do not rely on memorised summaries.

## Architecture

### Directory structure

- **layout/**: base templates (`theme.liquid`, `password.liquid`).
- **templates/**: JSON templates; root must include `order` array + `sections` map. Alternates use dot-suffix (`product.alternate.json`). Page alternates use one of three patterns: keep `main` enabled and append sections (Contact pattern), disable `main` and use a single monolithic block (About pattern), or disable `main` and compose from generic primitives like `hero` / `media-with-content` / `section` / `faq` (Custom Orders pattern). Pick the simplest fit.
- **sections/**: page sections with `{% schema %}`.
- **blocks/**: reusable theme blocks; nestable.
- **snippets/**: Liquid partials rendered with `{% render %}`.
- **assets/**: CSS, JS, static files. **Flat directory** (no subdirs). **No build step**: files ship as-is. Reference via `{{ 'filename' | asset_url }}`; inline icons via `{{ 'icon.svg' | inline_asset_content }}`.
- **locales/**: `en.default.json` is canonical.
- **config/**: `settings_schema.json`, `settings_data.json`.

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

### Static vs dynamic invocations

- **Static** (locked into schema): `{% content_for 'block', type: 'text', id: 'unique-id' %}`. May pre-set defaults via `settings: { ... }` on the call site.
- **Dynamic** (merchant adds via editor): `{% content_for 'blocks' %}`.

**Critical**: only ONE `{% content_for 'blocks' %}` per file. If you need the same dynamic-block region in multiple places, **capture** it once into a variable and emit the variable.

**A block cannot read another block's settings.** When two blocks must agree on a value, put it in `settings_schema.json` and share a snippet that reads it (see `snippets/size-option-position.liquid`, read by both the variant picker and the acknowledgement block). Duplicating the setting on each block gives two sources of truth that drift apart silently.

### Schema targeting

- Restrict nesting via `"blocks": [...]`. Use `{ "type": "@theme" }` for any theme block, `{ "type": "@app" }` for app blocks, or specific names.
- `"tag": null` removes the auto-wrapping element; emit `{{ block.shopify_attributes }}` on your own root.
- **NEVER edit `{% schema %}` directly** when schemas are generated from source; modify the source and regenerate.

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

- IDs: CamelCase + section/block ID suffix, like `id="ProductModal-{{ section.id }}"`. The suffix is there to keep repeated blocks unique. **Exception: link anchors**, whose job is to be stable and hand-authorable, so they are bare. The only one today is `SizeChart` (`anchor_id` on `_accordion-row`, emitted by `scripts/size-chart/`, targeted by `snippets/size-guide-link.liquid` and by shared `#SizeChart` URLs). Do NOT "fix" it to `SizeChart-{{ block.id }}`; that silently breaks the size-guide link and every bookmarked link. `scripts/size-chart/test/anchor-contract.test.mjs` fails if you do.
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

### Component-specific accessibility patterns

Load `docs/accessibility-patterns.md` before implementing or modifying any of these widgets: **accordion, breadcrumb, cart drawer, chat window, color swatch, combobox, carousel, disclosure, dropdown navigation, flip card, form, modal, product card, slider, switch, tab, tooltip**. Anything that maps to one of these primitives (`<dialog>` ≈ modal; toasts ≈ `aria-live` region; bare "dropdown" ≈ combobox / disclosure / dropdown navigation depending on behaviour); load the same file and use the nearest match. Anything else: global rules above + WCAG.

## Translations

- Keys live in `locales/en.default.json` (storefront) and `locales/en.default.schema.json` (schema).
- **Add the key to the locale file before referencing it**; theme-check fails red on dangling keys.
- When adding storefront-visible strings, mirror into non-English locale files (`locales/it.json`, `locales/ro.json`, etc.) with `TODO` placeholders if real translations aren't available.

## Theme settings

Global CSS variables in `snippets/theme-styles-variables.liquid`; color schemes via `color_scheme_group` in `config/settings_schema.json` rendered through `snippets/color-schemes.liquid`. `settings_schema.json` opens with a `theme_info` object. Presets that use nested blocks must declare a `block_order` array. Setting `label` text: under 30 characters, title case, no redundant type qualifier ("Columns", not "Number of columns").

**Product media alt text drives the gallery.** `snippets/product-media-gallery-content.liquid` filters product media by matching each media's alt text against the values of the option named by `settings.color_option_name`. Alt naming exactly one value binds that photo to that colour; alt naming none is shared across every colour, so the values are a reserved vocabulary in alt text. The data lives in Admin, no test reaches it, and both failure directions are silent. Read `docs/product-media-alt-text.md` before authoring alt text or changing the filter.
