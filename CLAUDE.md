# CLAUDE.md

Guidance for Claude Code working in this repo.

## Screenshots

When the user references screenshots, or when troubleshooting any issue, proactively check for the latest screenshot without waiting to be asked. The user's screenshots directory is configured in their private global `~/.claude/CLAUDE.md`; ask for the path the first time it is referenced in a session if you do not already have it from prior context. Do not commit literal local-machine paths to this repo (see "Sensitive Content" below).

## Project overview

Custom Shopify theme based on **Horizon**, Shopify's flagship theme. Latest Liquid Storefronts features including theme blocks. Server-rendered, progressive enhancement, native web platform features.

This is a private, single-merchant theme. **Not a Shopify Theme Store submission.** Theme-Store gating criteria (Lighthouse thresholds, 10-color-role ecosystem requirement, etc.) do not apply unless explicitly called out below.

The repo is **standalone, not a GitHub fork** of `Shopify/horizon`. Attribution lives in `LICENSE.md` (Shopify MIT, preserved verbatim) and the README's "Staying current with Horizon" section. Pull upstream updates via `git remote add upstream https://github.com/Shopify/horizon.git` + `git fetch upstream` + `git merge upstream/main`. The first commit on `main` is an imported Horizon baseline tree, so merges from upstream do not need `--allow-unrelated-histories`.

## Sensitive Content

This repository is **public**. Real personal contact metadata, internal strategy / legal advisory content, and dev-machine identifiers must never appear in the repo, git history, PRs, issues, comments, or release artifacts. Brand-personality copy that is also displayed on the storefront (founder narrative, About / FAQ pages, photography filenames that don't expose personal identifiers) is intentional and fine to commit.

The scope is broad on purpose: git history rewrites on a public repo are expensive and incomplete (forks, cached diffs, search index), so the only durable defense is to never let it land in the first place. The repo was deleted-and-recreated once already to scrub embedded metadata; do not reintroduce it. The `secret-scan` job in `.github/workflows/validate.yml` (Gitleaks) catches token-shaped strings on every PR, but it does not catch personal emails, addresses, or merchant-keyed prose - those are the author's responsibility per the Pre-push checklist below.

### What is sensitive (do not commit)

- **Personal contact metadata**: personal email addresses (Gmail, iCloud, etc.), personal phone numbers, full home / fulfilment addresses, personal social handles. The brand identifies itself via the public storefront; individual operators do not need to.
- **Commit-author email**: the local `git config user.email` for this repo must be a non-personal address (`seth@pertsfoundry.com` or the GitHub no-reply form). Personal Gmail in `Author:` lines is a commit-metadata leak that no diff will ever show.
- **Dev-machine identifiers**: absolute filesystem paths that include a username (`/Users/Seth/...`, `/c/Users/Seth/...`, `/mnt/c/Users/Seth/...`, `~/repos/...`). Use placeholders in docs (`<screenshots-dir>`, `<repo-root>`) and let the user's private global `~/.claude/CLAUDE.md` hold the real path.
- **Internal advisory / strategy docs**: legal-exposure analyses, ADA-risk playbooks, insurance posture notes, settlement-range guidance, demand-letter response checklists, tax / accounting research. These belong in a private notes location (1Password, private gist, `~/notes/`), never in `docs/` of a public theme repo.
- **Operating location below state level**: city, county, ZIP, or any detail that could pinpoint a home-based operation. Brand-level state-or-larger framing in storefront copy is fine; legal-exposure framing tied to a specific jurisdiction is not.
- **Tokens of any kind**: `SHOPIFY_CLI_THEME_TOKEN`, GitHub PATs, Shopify Admin API tokens, third-party app keys (Judge.me, Klaviyo, etc.), Anthropic / OpenAI keys. CI references `${{ secrets.* }}` only.
- **Real customer / order / financial data**, even truncated. Use synthetic fixtures (`Test Customer`, `order-id-12345`, `Acme Corp`).
- **Pre-publish drafts** that name real third parties (vendors, suppliers, partners) outside what's already on the storefront.

### What is NOT sensitive (and is fine to commit)

- **Founder narrative and brand voice**: the operators' first names, husband-and-wife framing, prior-career mentions, pet references - anything that already appears on the storefront's About or FAQ page is part of the brand and intentional. Image filenames that encode pet names (`Kitkat-Rory.jpg`) are fine when the same names appear in the visible copy.
- The brand name "Sapphire Shadow Studio" and the public store handle `sapphire-shadow-studio`. The repo identifies itself.
- Live theme numeric ID (`#181702754604`). Public on every storefront page render; not authentication material.
- The `*.myshopify.com` storefront domain and any custom storefront domain.
- App-embed install UUIDs that the Shopify admin assigns to installed apps (Shopify Inbox, Judge.me) - observable in any browser DOM inspection.
- Public Shopify policies content (shipping, returns, refund) that is also served under `/policies/...` on the storefront.
- State-level location framing in storefront copy (not in legal / strategy context).
- Synthetic test fixtures.

### Pre-push checklist

Before every `git push`, every `gh pr create`, every `gh pr comment`, and every `gh issue create`:

1. **Scan the full branch diff** (`git diff origin/main..HEAD`) and **every commit message** (`git log origin/main..HEAD --format=%B`) for: personal email addresses, personal phone, machine paths, tokens, merchant-keyed strategy framing, sub-state location detail.
2. **Scan the rendered PR / issue / comment body** for the same categories. Content typed into `gh pr create --body` does not pass through the diff scan and is not covered by Gitleaks.
3. **Verify the `secret-scan` CI check is green** on the latest PR run. Red means stop and triage, not "rebase past it."
4. **Verify `git config --local user.email`** is `seth@pertsfoundry.com` or the no-reply form before any commit. Personal Gmail in author metadata doesn't show up in diffs and slips through every other check.
5. If anything sensitive is found:
   - **Pre-push (history not yet on remote)**: rewrite locally with `git rebase -i` or `git commit --amend`. Replace with neutral descriptors. Re-run all checks before pushing.
   - **Already on remote**: stop. Surface to the user before any further action - force-pushing rewritten history to a public repo is a visible event that warrants explicit consent. For a confirmed token, treat as compromised and rotate in addition to (not instead of) history rewrite.
6. Default to redacted-by-default in commit messages and doc entries: describe the *change* (what was edited in the template / block / workflow), not the *real-world entity* that prompted it.

### Memory notes

Memory files under `~/.claude/projects/.../memory/` may contain real operator and merchant context **for the assistant's use only**. Never paste memory content into the repo, PR bodies, or commit messages; treat memory as a private context store, not a documentation source.

## Before making changes

This repo uses a **PR-based deploy model**. Direct edits to `main` and to the live theme are not part of the workflow.

### Code changes

1. Branch from `main`: `git switch -c <feature-branch> origin/main`.
2. Develop locally: `npm ci && npx shopify theme dev`. The dev server runs against an unpublished development theme created on the fly; storefront edits to the dev theme do not touch the live theme or `shopify-sync`.
3. Open a PR. CI runs one sequential `validate` job in `validate.yml` with five steps plus an aggregator that posts a sticky CI Report comment:
   - `theme-check` (linter, `--fail-level error`).
   - `reconcile` (fails if `shopify-sync` has commits not in the branch; posts the resolution snippet as a sticky PR comment).
   - `actionlint` (workflow + composite-action lint).
   - `zizmor --pedantic` (workflow security audit).
   - `gitleaks` (full git history secret scan).
   The single required check on `main` is `validate / validate` (one context). To re-run validation, push a new commit to the PR branch (there is no `validate` comment trigger; `issue_comment`-dispatched runs would not be associated with the PR HEAD SHA). To run `actionlint` locally against the same shellcheck exclusions CI uses, set `SHELLCHECK_OPTS="-e SC2016 -e SC2317" actionlint` (the suppressions are documented at `validate.yml` lines 113-119).
4. `preview.yml` deploys the branch to a per-PR unpublished theme `pr-<n>-preview` and posts a sticky PR comment with editor + preview URLs. Updated on every push, deleted on PR close.
5. If the `reconcile` step fails, run the snippet it posts: `git fetch origin && git merge origin/shopify-sync && git push`.
6. On comment `deploy`, `deploy.yml` verifies Validate passed for the PR HEAD SHA, pushes the theme to live, smoke-tests the storefront, deletes the preview theme, updates the `<!-- preview -->` sticky, reacts on the `deploy` comment, posts the deploy report, **then** squash-merges the PR and (post-merge) fast-forwards `shopify-sync` to the deployed SHA. The squash-merge is the final user-visible event; the sync step that follows is not surfaced in the PR timeline (failures land as `::warning::` annotations on the workflow run and self-heal via `sync.yml`'s next admin-push trigger or 13:00 UTC daily cron). On any step failure, a sticky failure report overwrites the pre-merge deploy report and the PR stays open. Direct push to `main` no longer triggers a deploy.

### Admin-side edits

All theme-customizer / code-editor edits **must** be made on the unpublished `EDIT HERE - Admin Sync` theme (connected to `shopify-sync` via the Shopify GitHub Integration), NOT on the live theme. Edits there are auto-committed to `shopify-sync` by `shopify[bot]`. The `sync.yml` workflow opens or refreshes the reconcile PR (the one open PR with `head: shopify-sync, base: main`) on every push to `shopify-sync`; a 13:00 UTC daily cron is the safety-net trigger. The reverse direction (catching `shopify-sync` up with `main`) is handled synchronously inside `deploy.yml`'s `Sync main -> shopify-sync` post-merge step rather than in a separate workflow: after every successful deploy, the deploy job fast-forwards `shopify-sync` to the deployed SHA when reachable, or force-resets with `--force-with-lease` when the only diff is a tree-identical orphan bot commit (the post-auto-deploy state). After Validate succeeds on the auto-reconcile PR, the unified `deploy.yml`'s `workflow_run` arm fires, deploys to live, and squash-merges automatically; failures leave the PR open with a sticky failure report.

The auto-deploy enforces additional gates beyond Validate; admin edits that trip any of these will halt with a sticky skip-comment naming the reason: signed-commit identity (every commit's `author.login` must be `shopify[bot]` with `verification.verified: true`; `committer.login` may be `shopify[bot]` or `web-flow`), PR-opener identity (`pr.user.login` must be `github-actions[bot]`, proving `sync.yml` opened the PR; a hand-opened shopify-sync PR is rejected and must be deployed via manual `deploy` comment), HEAD-drift (`pr.head.sha` must equal the SHA Validate ran against, asserted via `compareCommits.status === 'identical'`), base-staleness (`main` must not have advanced since the PR opened), the diff must not touch `.github/` or `layout/theme.liquid` and must be under 1000 LOC. The operator escape hatch is to **mark the auto-reconcile PR as a draft** (`gh pr ready --undo <n>` or via the GitHub UI); draft PRs skip auto-deploy entirely and a human can still comment `deploy` manually. Convert to ready-for-review to resume auto-deploy. The shopify-sync branch itself is never deleted on merge (it is the long-lived integration target).

To inspect what is currently live without altering the working tree: `npx shopify theme pull -s sapphire-shadow-studio --live --path /tmp/live --nodelete`. **Never** pull live into the working tree (the working tree is the source of truth, not the storefront).

### Live theme

Live theme is `#181702754604`. **Disconnected** from GitHub. Only the unified `deploy.yml` writes to it (via three trigger paths: `issue_comment` for dev PRs, `workflow_run` on validate for `shopify-sync`, `workflow_run` on validate for `dependabot/**`); all three paths require Validate green on the PR HEAD SHA before they push. Do not click "Customize" or "Edit code" on the live theme card in admin; use the sync theme instead. There is no automated drift detection - the "live = main" invariant is operator discipline, not enforced by CI.

### Preview-theme cleanup (orphan recovery)

`pr-N-preview` themes are deleted synchronously by the deploy workflows after a successful merge (via `shopify-theme-push`'s `mode: delete-preview`), and by `preview.yml::cleanup` on user-driven PR closes. There is no longer a scheduled sweep (the prior `drift-watch.yml` weekly job is gone). Accepted trade-off: if the synchronous cleanup ever silently fails (`continue-on-error: true` masks non-zero exits in the deploy chain), or if `preview.yml::cleanup` skips for any reason (concurrency cancellation, runner outage), the orphaned `pr-N-preview` theme persists indefinitely until manually swept.

Manual recovery (run locally with `SHOPIFY_CLI_THEME_TOKEN` set):

```bash
# List orphans
npx shopify theme list -s sapphire-shadow-studio --json \
  | jq -r '.[] | select(.name | test("^pr-[0-9]+-preview$")) | "\(.id)\t\(.name)"'

# Delete a specific orphan
npx shopify theme delete --theme <id> --force
```

The deploy report comment surfaces a `cleanup_status` line on every auto-merge; a `:warning: **Preview cleanup warning**` line in that comment is the signal that manual recovery is needed.

For full architecture details, see `.github/workflows/` and the README CI/CD section.

### Deploy gate trust delta

The deploy chain has **no GitHub Environment binding at all**. The Shopify token is read from a repo-level secret, the store handle and canonical domain from repo-level variables. The previous `shopify-deploy` env was retired because its required-reviewer gate was self-approval (zero security, only friction); the three computed gates below were already the actual access controls. All three paths live in the unified `deploy.yml` with a two-job (`gate` no-token / `deploy` token-bearing) structure; `SHOPIFY_CLI_THEME_TOKEN` enters scope only after `gate` has set its outputs, so a bug in any gate `if:` clause cannot leak the token. Three computed gates govern access:

1. **Collaborator-permission check** on the comment author of `deploy.yml`'s `issue_comment` trigger. The `gate` job runs in a no-token sandbox and uses `getCollaboratorPermissionLevel` to gate access; only `admin` or `write` collaborators proceed. The workflow-level `if` also pre-filters by `author_association` and asserts `github.event.issue.pull_request` (so a `deploy` comment on a plain issue cannot dispatch a runner) so non-collaborator comments do not even start a runner.
2. **Validate-on-HEAD-SHA verification.** The `gate` job re-asserts Validate green on the exact SHA being deployed. The comment path uses `listWorkflowRuns` filtered by `validate.yml`, `head_sha`, and `event: 'pull_request'` (the event filter blocks a future push / workflow_dispatch trigger on validate.yml from masquerading as proof), takes the latest completed run, and rejects on stale/in-progress/failure. The two `workflow_run` paths are stronger: they re-fetch the *triggering* Validate run by `workflow_run.id` via `getWorkflowRun`, assert `conclusion: success`, and thread the `head_sha` returned by that lookup as `trustedSha` through every downstream API call (checkout, merge `sha:`, getCommit, etc.). HEAD-drift is first asserted via `pr.head.sha === trustedSha`; `compareCommits.status === 'identical'` is checked as defence in depth and would reject any path where the two SHAs end up non-identical (same-tree amends, cherry-picks, force-pushes to a different tree all return `diverged`, not `identical`, since `compareCommits` compares commit objects rather than trees). For `workflow_run` paths Validate is treated as **advisory**: a malicious PR head could rewrite `validate.yml` to pass falsely, but the signed-commit gate (below) uses `getWorkflowRun().head_sha` and `compareCommits` from the API and cannot be bypassed that way. The signed-commit gate is the actual integrity boundary for auto-deploys.
3. **Signed-commit gate on auto-deploy paths.** Both `workflow_run` arms of `deploy.yml` assert `verification.verified === true`, `commit.author.login` equal to the expected bot (`shopify[bot]` for shopify-sync; `dependabot[bot]` for dependabot), and `pull_request.user.login` equal to the expected PR opener (`github-actions[bot]` for shopify-sync, since `sync.yml` opens that PR; `dependabot[bot]` for dependabot). `commit.committer.login` is allowed to be either the expected bot OR `web-flow` (GitHub's commit identity for rebases applied via the web UI, `@dependabot rebase`, or `@dependabot recreate`; `web-flow` is a GitHub-system identity that cannot be impersonated by an external actor). The earlier strict `committer === expectedBot` form produced false positives on every rebased PR. Git-commit-header fields are not consulted (those are forgeable).

All three gates depend on the workflow files themselves being correct. A compromised collaborator account that can land any PR (or force-push `shopify-sync` or open a `dependabot/`-named PR with a forged signature) bypasses all three with one fewer audit-log entry than the required-reviewer model produced.

Compensations available but not implemented today: introduce a separate preview-only Shopify token (passed to `preview.yml` and `cleanup` via a different repo-level secret) so a leaked preview token cannot push to live; add a long-lived `auto-deploy-audit` GitHub issue that records every auto-deploy with SHA, bot, PR, and merge-as for forensic durability beyond the 90-day workflow-log retention. Both are deferred enhancements.

### Secrets vs variables policy

GitHub Actions auto-redacts `secrets.*` values in workflow logs (`***`); `vars.*` values are logged in plaintext. Classification rule for this repo:

- **Secret**: anything that grants write access to live infrastructure or to a third-party API. Today: `SHOPIFY_CLI_THEME_TOKEN` only.
- **Variable**: anything that is observable on any unauthenticated storefront request or in the GitHub repo's public surface. Today: `SHOPIFY_DOMAIN` (canonical host, printed on every page), `SHOPIFY_FLAG_STORE` (myshopify handle, appears in `Server` headers and theme-editor URLs).

Before adding a new `vars.*` entry, ask: would I be comfortable seeing this value in a workflow log, in a smoke-test PR comment, or quoted by a reviewer? If not, classify as a secret.

### Token rotation call-site catalog

`SHOPIFY_CLI_THEME_TOKEN` is consumed at the following call sites (down from seven pre-consolidation). A rename or storage-location change requires updating every entry. All workflow references thread the secret into the `shopify-theme-push` composite action; the composite action is the single consumption point.

- `.github/workflows/preview.yml` (deploy-preview job: `mode: preview`; cleanup job: `mode: delete-preview`) — two passthrough sites.
- `.github/workflows/deploy.yml` (Live theme push step: `mode: live`; Delete preview theme step: `mode: delete-preview`) — two passthrough sites; one workflow file, three trigger paths share the same steps.
- `.github/actions/shopify-theme-push/action.yml` — the composite action that actually reads `inputs.shopify-cli-theme-token` and invokes the Shopify CLI. Single canonical consumption point; renaming the env-var contract requires updating this file too.

### Why scheduled-deploy.yml is not ported from PFW

The Perts Foundry website (Hugo + Cloudflare Workers) runs a scheduled redeploy on the 1st and 15th of each month so that posts with future `publishDate` fields render on time. Shopify Liquid is server-rendered on every request, so time-gated logic (`{% if 'now' | date: '%s' < ... %}`) evaluates dynamically without a redeploy. A scheduled rebuild is unnecessary for a Shopify theme.

## Pre-PR review

Standard agent set (`code-reviewer`, `doc-sync-checker`, `architecture-reviewer`, `security-auditor`) applies. Project-specific notes:

- **infra-reviewer**: run on any change touching `.github/workflows/` or `.github/actions/`. The unified `deploy.yml` handles all three trigger paths (`issue_comment`, `workflow_run` on `shopify-sync`, `workflow_run` on `dependabot/**`) and serialises them with `concurrency: deploy-production`; the `workflow_run` paths depend on the literal name `validate` for `workflow_run.workflows: ["validate"]` and on the `dependabot/**` glob for the Dependabot branch pattern. `sync.yml` (replaces `sync-reconcile.yml`) is single-direction (admin commits to `shopify-sync` only); the reverse direction is inlined in `deploy.yml`'s `Sync main -> shopify-sync` post-merge step. `preview` and `validate` use their own concurrency groups (or none); none of the workflows bind a GitHub Environment, and Shopify credentials/handles come from repo-level secrets and variables.
- **test-engineer**: skip. There is no JavaScript test framework configured.
- **prompt-reviewer**: run only when this `CLAUDE.md`, agent definitions, or `.claude/` content change.
- **security-auditor focus areas** for theme work: Liquid output filters (`| escape`, `| json`, `| script_tag`), metafield exposure, form CSRF tokens, untrusted user input rendered into HTML attributes.

Before proposing fixes for theme-check warnings, check `THEME_CHECK_NON_ACTIONABLE.md` first; the project may have already triaged the finding as a known false positive.

## Development commands

```bash
# Local dev
npm ci
npx shopify theme dev                                                       # local dev server

# Linting
npx shopify theme check

# Inspect the live theme read-only into a scratch dir
npx shopify theme pull -s sapphire-shadow-studio --live --path /tmp/live --nodelete
```

**Do NOT run** `shopify theme push` or `shopify theme pull` against the working tree. Pushes to the live theme happen exclusively via the unified `deploy.yml` (three trigger paths: `issue_comment` for a `deploy` comment on a PR; `workflow_run` after Validate succeeds on a `shopify-sync` reconcile PR; `workflow_run` after Validate succeeds on a `dependabot/**` PR with safety gates met). Admin-side edits flow through the sync theme into `shopify-sync`.

## Shopify best practices

Follow https://shopify.dev/docs/storefronts/themes/best-practices when relevant. When a task depends on a specific best-practice page, fetch it on demand with `WebFetch` rather than relying on memorized summaries; the `shopify.dev` Liquid reference is authoritative.

## Architecture

### Directory structure

- **layout/** - Base templates (`theme.liquid`, `password.liquid`).
- **templates/** - JSON templates defining page structure with section/block composition. Alternate templates use the dot-suffix form (e.g. `product.alternate.json`). The template root must include an `order` array defining the section sequence and a `sections` map keyed by those names.
- **sections/** - Page sections with `{% schema %}` blocks for merchant configuration.
- **blocks/** - Reusable theme blocks that can be nested.
- **snippets/** - Reusable Liquid partials rendered with `{% render %}`.
- **assets/** - CSS, JavaScript, static files. **Flat directory** (no subdirectories allowed). **No build step**: files ship as-is via `deploy.yml`. Reference assets from Liquid via `{{ 'filename' | asset_url }}` or `{{ 'filename' | asset_url | image_tag }}`. Inline icons / small SVGs can be loaded with `{{ 'icon-name.svg' | inline_asset_content }}`.
- **locales/** - Translation files. `en.default.json` is the canonical source; non-English locales should be kept in sync but English is the source of truth.
- **config/** - `settings_schema.json` and `settings_data.json`.

### Component framework

JavaScript uses a custom web-component framework in `assets/component.js`:

```javascript
import { Component } from '@theme/component';

class MyComponent extends Component {
  refs = {};                    // Auto-populated from ref="name" attributes

  handleClick(event) { }        // Bound via on:click="/methodName"
}
```

Key patterns:

- Element refs: declare via `ref="elementName"` (or `ref="items[]"` for arrays) in HTML; access through `this.refs`.
- Event binding: `on:event="/methodName"` in HTML, never `addEventListener` for DOM events the framework can wire. Supported events: click, change, select, focus, blur, submit, input, keydown, keyup, toggle.
- Validate required refs in `connectedCallback` and throw a descriptive error if missing.
- Private methods use `#` prefix; public API stays explicit.
- Parent-to-child: invoke public methods on the child component directly. Child-to-parent: emit a `CustomEvent` with a typed `detail` payload.
- Cancel in-flight `fetch` with `AbortController` before issuing a new request; cancel in `disconnectedCallback` to prevent leaks.
- Optimistic UI updates must revert on error; dispatch a custom event on success for cross-component sync.
- Build URLs with `URL` and `URLSearchParams`; never concatenate query strings by hand.

JSDoc patterns for the component framework:

- Declare a `@typedef` for the refs object and pass it as the `Component<Refs>` generic.
- Mark optional refs with `[name]`.
- Document custom events emitted by the component, including the shape of `detail`.

### Theme editor integration

Sections / blocks update without full page reload in the theme editor; associated JavaScript will not auto-execute. Listen for these events on `document`:

- `shopify:section:load` - re-execute initialisation for the loaded section.
- `shopify:section:unload` - clean up listeners and timers.
- `shopify:section:select` / `shopify:section:deselect` - selection state.
- `shopify:block:select` / `shopify:block:deselect` - block selection state.
- `shopify:inspector:activate` / `shopify:inspector:deactivate` - preview inspector toggling.

Detect editor mode in JavaScript via `Shopify.designMode` (`true` in editor, `undefined` otherwise). In Liquid, use `request.design_mode`.

When the preview inspector is active, deactivate fixed-position elements (sticky headers) so they do not obscure inspection outlines. Use `margin` / `gap` for spacing between blocks, not `padding` (padding misaligns the inspector outline).

### Theme blocks vs snippets vs sections

- **Blocks** (`blocks/`): have `{% schema %}` definitions, appear in theme editor, support nesting via `{% content_for 'blocks' %}`. Only ONE `{% content_for 'blocks' %}` per file (capture if you need it in multiple places).
- **Snippets** (`snippets/`): pure Liquid partials with `{% doc %}` documentation, no schema.
- **Sections** (`sections/`): page-scope containers that hold blocks. Conventional class name: `'section-' | append: section.type`. Scope per-section CSS variables to the wrapper (e.g. `--section-padding-block`) and apply via inline `style`. Use `block_order` only when a preset declares blocks as an object (not an array).

## Block development

### Block file structure

```liquid
{% doc %}
  Description of the block.

  @param {string} [optional_param] - Optional inputs in brackets.

  @example
  {% content_for 'block', type: 'block-name', id: 'unique-id' %}
{% enddoc %}

<div {{ block.shopify_attributes }} class="block-name">
  {{ block.settings.text }}
  {% content_for 'blocks' %}        {# only if nesting blocks #}
</div>

{% stylesheet %}
  .block-name { }
{% endstylesheet %}

{% schema %}
{
  "name": "t:names.block_name",
  "settings": []
}
{% endschema %}
```

### Static vs dynamic block invocations

Static (locked into the schema, cannot be removed / reordered in the editor):

```liquid
{% content_for 'block', type: 'text', id: 'unique-id' %}
```

Dynamic (merchant adds via the editor):

```liquid
{% content_for 'blocks' %}
```

**Critical**: only ONE `{% content_for 'blocks' %}` per file. If you need to render the same dynamic-block region in multiple places, capture it once into a variable and emit the variable.

### Schema targeting and rendering

- Restrict which block types may nest inside a section / block via `"blocks": [...]` in schema. Use `{ "type": "@theme" }` to allow any theme block, `{ "type": "@app" }` for app blocks, or specific names for restricted lists.
- A block invoked with a static ID (`{% content_for 'block', type: 'text', id: 'unique-id' %}`) is locked in the editor and may pre-set defaults via `settings: { ... }` on the call site.
- `{% schema %} ... "tag": null` removes the auto-wrapping element. When you do this, you are responsible for emitting `{{ block.shopify_attributes }}` on your own root element.
- **NEVER edit `{% schema %}` blocks directly** when schemas are generated from source files; modify the source schema and regenerate.

## Coding standards

### Liquid

- Use `{% liquid %}` for multiline logic blocks.
- Inline variables in HTML attributes rather than declaring many variables upfront.
- All snippets require `{% doc %}` documentation with `@param` and `@example`.
- Use translation keys: `{{ 'namespace.key' | t }}`.
- **NEVER edit `{% schema %}` blocks directly** - schemas may be generated from source.
- Use `{% assign %}` only when needed: filter parameters that need a complex string, the same calculation reused more than once, or extreme logical complexity. Otherwise inline. Use `{% capture %}` only for multi-line content that won't fit inline.
- Never invent custom Liquid filters, tags, or objects; only use documented Shopify Liquid.
- `{% doc %}` parameter conventions: type in braces (`{string}`, `{object}`, `{array}`), optional parameters in brackets (`[name]`), nested properties as `object.property`.

### CSS

- **BEM naming**: `.block__element--modifier`.
- **Single class selectors** (specificity `0 1 0`) where possible.
- **CSS variables**: namespace to component (e.g. `--product-card-padding`).
- **No IDs as selectors**; avoid `!important`.
- **Logical properties**: `padding-inline`, `margin-block`, `inset` for RTL support.
- **Container queries** for responsive components; declare with `container-type: inline-size` on the wrapper.
- **Mobile-first** media queries (`min-width`).
- Use `{% stylesheet %}` tags inside sections / blocks for scoped CSS. Standalone CSS files in `assets/` are for shared / global styles.
- `:has()` performance: anchor selectors as close to the matched child as possible; prefer `>` or `+` combinators inside `:has()`. For dynamic state, prefer server-rendered classes over client-side `:has()` checks.
- Never animate layout properties (`width`, `height`, `margin`, `padding`); animate `transform` and `opacity` instead.
- Use `contain` on grid / list containers for rendering performance.
- Property-order convention inside a rule: layout, box model, typography, visual, animation / transform.
- Defensive CSS: `min-width: 0` on flex children to prevent overflow; `aspect-ratio` to reserve space and prevent layout shift; clamp long content rather than letting it spill.
- Use `dvh` (dynamic viewport height) instead of `vh` for mobile layouts to account for the on-screen keyboard.
- Apply per-section / per-block setting values via inline `style="--var: value"`; do not generate per-instance class names.
- Use `@layer` to organise theme CSS (resets, base, components, utilities) and prevent specificity wars.

### HTML

- Use native elements: `<details>`, `<dialog>`, `popover` attribute.
- IDs use CamelCase with section / block ID suffix: `id="ProductModal-{{ section.id }}"`.
- Semantic HTML with proper ARIA attributes.
- `tabindex="0"` for custom interactive elements; never positive values.
- Use `<search>` for search forms, `<output>` for calculated form results.
- Prefer typed inputs (`type="search|tel|url|date|time|datetime-local|month|week|color"`) for native validation and mobile keyboards.
- Use `pattern=` for regex validation; `formnovalidate` / `formaction` on submit buttons when a button needs to bypass validation or post elsewhere.
- Pair `@supports` feature queries with `@media` for progressive enhancement.
- Provide `@media print` styles for receipts / order pages.
- View transitions: declare `@view-transition` and per-element `view-transition-name` for smooth navigation.
- Avoid `position: fixed` near the bottom of the viewport on mobile; the on-screen keyboard will overlap it.

### JavaScript

- Zero external dependencies; use native browser APIs.
- `const` over `let`; `for...of` over `.forEach()`.
- `async / await` over `.then()` chaining.
- Early returns over nested conditionals.
- JSDoc type annotations for parameters and return types.
- Component-framework conventions and JSDoc patterns are covered under "Architecture > Component framework" above; consult that section before extending or adding components.

### Accessibility (always applied)

These are global rules. Component-specific patterns (accordion, modal, tabs, slider, etc.) are documented under "Component-specific accessibility patterns" below.

- Skip link required at page top; the element referenced by `href="#main"` must have `tabindex="-1"` so it can receive focus. Hide the skip link with sr-only / clip-path techniques, never `display: none`.
- `lang` attribute on `<html>`.
- Viewport must allow zoom (no `maximum-scale=1.0` or `user-scalable=no`).
- Respect `prefers-reduced-motion`.
- WCAG AA contrast: 4.5:1 for normal text, 3:1 for large text and UI elements (icons, input borders).
- Focus indicators on all interactive elements (`:focus-visible`).
- Animation / motion: never exceed 3 Hz flashing (avoid sub-0.33s strobes); parallax / scroll-jacking effects need a user-controllable off switch; auto-running content longer than 5 s needs a pause control.
- High-contrast mode: provide `@media (prefers-contrast: more)` overrides for help text, borders, and focus indicators.
- Landmark hygiene: cap landmarks at ~10; multiple `<nav>` / `<aside>` / `<section>` regions each need an `aria-label` or `aria-labelledby`.
- Form error / success summaries: heading gets `tabindex="-1"`; on submission, use `requestAnimationFrame` to ensure the heading is visible before calling `.focus()` and `.scrollIntoView()`.
- Auto-updating regions (chat, live counters): `aria-live="polite"` (or `role="log"` for chronological message history); pair with a visible pause control. Notifications combine sound + visual badge + title-bar change + `aria-live`.
- Time limits: warn 20 s before expiry and offer to extend / disable; minimum interaction window is 20 hours for non-critical flows.
- `title` attribute: only on `<iframe>`; never on other elements (creates redundant tooltips and inconsistent screen-reader output).
- Touch targets: at least 44x44 CSS pixels.
- All `<img>` elements need `alt`; use empty `alt=""` for decorative images.

### Component-specific accessibility patterns

Match the role / attribute set exactly when implementing one of these widgets. Anything not covered here is governed by the global rules above plus WCAG.

- **Accordion** - Trigger is `<button aria-expanded="true|false" aria-controls="<panelId>">`; panel has `id` and optional `role="region" aria-labelledby="<headerId>"`. Esc closes the panel and returns focus to the trigger.
- **Breadcrumb** - `<nav aria-label="Breadcrumb"><ol><li><a></a></li>...</ol></nav>`; current page link uses `aria-current="page"`.
- **Cart drawer** - Activator: `aria-haspopup="dialog"`. Drawer: `role="dialog" aria-modal="true" aria-label="Shopping Cart"`. Close button is first in DOM, focus is trapped, Esc closes and restores activator focus. Quantity inputs announce with `aria-live="polite"`. After removing an item, move focus to the close button.
- **Chat window** - Message history is `role="log"` (preserves DOM-order chronology, not column reading). Live chat surface is `role="region"` (or `role="dialog"` if modal). Each message includes the author (visible or sr-only). Auto-refresh has a pause control. Notifications: badge + `aria-live` + tab-title update; timeout warning fires 20 s before expiry.
- **Color swatch** - Wrap radios in `<fieldset><legend>` (or `role="group" aria-labelledby`). Hide native radios with `appearance: none`, never `display: none`. Provide a `data-label` / tooltip for the colour name; colour alone is insufficient. Arrow keys navigate.
- **Combobox** - Input: `role="combobox" aria-expanded aria-haspopup="listbox" aria-controls="<listboxId>" aria-autocomplete="list|both|inline|none"`. When expanded, `aria-activedescendant` points to the active option's `id`. Listbox is `role="listbox"`; options are `role="option" aria-selected`. A status region announces filtered counts. Down / Up navigate without closing; Home / End jump to ends.
- **Carousel** - Wrapper: `role="region" aria-roledescription="carousel" aria-label`. Slides: `role="group" aria-roledescription="slide" aria-label`. Rotation toggle has a dynamic `aria-label` ("Start slide rotation" / "Stop slide rotation"). Next / Previous always enabled (wrap, never disabled). Auto-rotation interval >= 5 s; pause on focus / hover and resume on blur. `aria-live="off"` while rotating, `"polite"` when paused. Inactive slides hidden with `visibility: hidden`.
- **Disclosure** - `<button aria-expanded="true|false">` toggles a sibling element. Enter / Space activate. Distinct from accordion in that there is no panel role.
- **Dropdown navigation** - `<nav aria-label="Main navigation"><ul><li><a></a></li>...</ul></nav>`. Active link: `aria-current="page"`. Submenu launchers: `<button aria-expanded aria-controls="<menuId>">`. Mobile drawer is `role="dialog" aria-modal="true"` with launcher carrying `aria-haspopup="dialog"`. Do not use `role="menu"` for site navigation.
- **Flip card** - `<button type="button" aria-pressed="true|false">` controls front / back state; sides toggle with `visibility: hidden|visible`. Button label is descriptive.
- **Form** - All inputs need `<label for>` or `aria-label` / `aria-labelledby`. Required fields combine `required` and `aria-required="true"`. Radio / checkbox groups wrap in `<fieldset><legend>` (or `role="group" aria-labelledby`). Errors: `aria-describedby` (or `aria-errormessage`) on the input plus `role="alert"` on the message. Help text in `<small>`. Critical forms (legal / financial) need confirmation / review / reversibility.
- **Modal** - `role="dialog" aria-modal="true" aria-labelledby="<titleId>"` (or `aria-label`). Launcher: `aria-haspopup="dialog"`. Close button first in DOM; focus trapped; Esc closes and restores launcher focus.
- **Product card** - `<article>` wrapper with `aria-labelledby="<headingId>"`; heading has the matching `id`. Title and link as `<h2><a href>`. Images carry descriptive `alt`. If price has no visible label, give it `aria-label`.
- **Slider** (range input) - `role="slider" aria-valuenow aria-valuemin aria-valuemax aria-valuetext aria-label`. Right / Up arrow: increase. Left / Down: decrease. Home / End: bounds. PageUp / PageDown: larger steps.
- **Switch** - `<input type="checkbox">` (or `role="switch" aria-checked`). Label describes the function ("Wi-Fi"), not the state ("On"). Provide redundant On / Off visual indicators.
- **Tab** - Tablist: `role="tablist" aria-label`. Tabs: `role="tab" aria-selected aria-controls="<panelId>"`. Panels: `role="tabpanel" aria-labelledby="<tabId>"`. Left / Right (or Up / Down for vertical) move; Space / Enter activates; Home / End jump to ends.
- **Tooltip** - Trigger: `<button aria-expanded aria-controls="<tooltipId>">`. Tooltip: `role="tooltip"` with matching `id`. Enter / Space shows; Esc hides. Hover and tap also toggle. Tooltip content is non-interactive and a sibling, not a descendant of the trigger.

## Translations

- Keys live in `locales/en.default.json` (storefront) and `locales/en.default.schema.json` (schema).
- Maximum nesting depth: 3.
- snake_case key names.
- Schema-side reference: `t:names.<key>`. Storefront-side reference: `'namespace.key' | t`.
- Add the key to the appropriate locale file **before** referencing it; theme-check fails on dangling keys.
- When adding storefront-visible strings, mirror the key into non-English locale files (`locales/it.json`, `locales/ro.json`, etc.) with `TODO` placeholders if real translations are not yet available.

## Theme settings

Global CSS variables: `snippets/theme-styles-variables.liquid`. Color schemes: `color_scheme_group` in `config/settings_schema.json`, rendered via `snippets/color-schemes.liquid`.

### Settings authoring

- `config/settings_schema.json` opens with a `theme_info` object (`theme_name`, `theme_version`, `theme_author`, support / docs URLs). Group later entries by category (Typography, Layout, Performance, etc.).
- Setting `label` text: under 30 characters, title case, no redundant type qualifier ("Columns", not "Number of columns").
- Translation keys for setting labels: `t:names.<key>`. Add the key to `locales/en.default.schema.json` first; theme-check will flag dangling keys.
- Within a settings group, order: resource pickers (collection / product / blog / page) first, then visual-impact order (layout -> typography -> color), with `header` entries to introduce groups.
- Presets that use nested blocks must declare a `block_order` array.
