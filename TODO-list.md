# TODO List

Open items only. Delete an item when it is done; never check it off or annotate it. A partly finished item is deleted and its remainder written as a new item.

This is the single backlog for the whole repo; there are no per-directory to-do files. It holds only work that still needs doing. When an item lands, delete it completely: no tick, no "done" note, no Done section, no checked-off history. If the work left reasoning worth keeping (a corrected mistake, a cross-layer contract, a decision and why it went that way), write that into `release-notes.md` in the same change, then delete the item.

`/pre-pr` appends deferred review findings under `## Deferred review findings`, which stays the last section of this file.

## Tooling

- **Settle whether one large blank group can time the Flow out on its own.** `apply` now paces
  itself to one group per batch, which stops *different* groups' fan-outs from overlapping. It does
  nothing about a single group's own storm: a 13-member crewneck group is 12 writes and 12 full
  catalogue scans by itself, and neither the 2026-07-27 nor the 2026-09-03 incident isolated
  single-group size as a variable. Read the maximum group size off the live store before relying on
  the pacing (`audit --json`, largest member count; 13 for crewnecks as of 2026-09-03). If a single
  group's fan-out alone can time out, the **product-level roll-up metafield** described in
  `docs/blank-inventory-sync-flow.md` > Assumptions and limitations stops being a deferred option and
  becomes required work: batching cannot fix it. Do not touch the Flow itself, including
  `max_root_records`, to work around this; raising the cap makes the timing-out scan bigger.

- **Exercise the read-only Flow run-list probe against Admin at least once, and record what it
  saw.** `.claude/skills/blank-inventory/browser.md` plus
  `scripts/blank-inventory/browser/flow-runs-probe.js`. Admin's Flow surface is unversioned and the
  probe's GraphQL operation match and field names are the plausible shape, not an observed one, so
  the first run may legitimately log `SSSFLOWNONE`. What to record, in the browser doc and not
  anywhere else: the operation name the run list actually fetches, and the status tokens it returns
  (which feed `IN_PROGRESS_STATUSES` in `scripts/blank-inventory/lib/flow-runs.mjs`, currently a
  documented guess, so an unrecognised token is reported as `unclassified` rather than miscounted).
  **Record the vocabulary only.** No counts, run ids or timestamps from the live store go into any
  file, including as an illustration.

- **Move the `search-console` skill onto the Search Console API if a Cloud project is ever
  approved.** Every run is attended today because the operator declined a Google Cloud project. The
  upgrade is a project with a service account granted `webmasters.readonly` on the property, the
  CrUX API for Core Web Vitals, and scheduled unattended runs. The audit checklist in
  `.claude/skills/search-console/audit.md` and the capture schema in
  `scripts/search-console/lib/schema.mjs` carry over; only the browser pass is replaced, by API reads
  that fill the same capture.

- **Raise or paginate the variant query cap in `scripts/seo-review/admin.mjs`.**
  `admin-read-truncated` fired for both Lead II products on 2026-09-13, so the stored-field audit is
  not reading every variant of the two largest products.

- **Add a blog-discoverability check to `seo-review`.** Once articles are visible, flag a blog
  that no main-menu or footer link reaches; a blog found only through the sitemap earns little crawl
  attention and no visitor path.

## Product and storefront

- **Fix the low stock alert flow to handle gift cards. Gift card should be excluded.**

- **Update the huddle crew next and state that the appliqué fabrics are available in the image gallery toward the end for viewing. We want people to understand where to go to lay eyes on that.**

- **Update the inventory.**

- **Deploy the Checkly infrastructure PR so there are checks against the store.**

- **Install the Google & YouTube sales channel and turn on Merchant Center free listings.**
  Products then appear in Google's free shopping surfaces, and Search Console gains a Merchant Center
  association to audit.

- **Link GA4 through the Google & YouTube channel, then associate it in Search Console.** The
  association lives at Settings > Associations; the `search-console` skill reports it missing until
  then.

- **Import the property into Bing Webmaster Tools from Search Console.** The import reuses the
  existing Search Console verification, so it needs no new DNS record.

- **Give standard orders a visible notice of the Use of Finished Work licence.** Custom orders
  see it in the quote email, but checkout orders only meet it inside the Terms of Service linked at
  checkout. Add a one-line notice linking `/policies/terms-of-service#use-of-finished-work` on
  personalized product pages and in the order confirmation notification (`marketing/notifications/`),
  and decide whether a checkout acknowledgement is worth adding.

- **Install the Pinterest for Shopify sales channel.** The business account exists, the domain is
  claimed and the profile is in the Organization `sameAs`; what remains is the channel install in
  Admin, and a decision on whether the Verified Merchant Program is worth applying for.

- **Turn on the Meta and TikTok channel pixels.** Install each through its Shopify sales channel
  rather than a theme snippet, so the theme carries no third-party script of its own.

- **Align the homepage title and meta description with the nurse, medic and EMS niche.** Admin
  > Online Store > Preferences holds them; `snippets/meta-tags.liquid` holds the fallbacks.
  `perf-brand-only` in a `search-console` run is the signal that this is overdue.

- **Link the blog from the main menu or the footer.** Read `docs/theme-settings-contracts.md`
  before editing a menu in Admin.

- **Revisit the About page H1 alongside the homepage positioning.** It was listed as a content gap
  during the Search Console setup walk on 2026-09-13; check what it says against the niche wording
  before changing it.

- **Write meta descriptions for the five policy pages and the blog listing.** Find where each
  description is set before writing (an Admin SEO field, or the fallbacks in
  `snippets/meta-tags.liquid`); the policy bodies themselves belong to the `shop-policies` skill.

- **When the first Judge.me review is published and visible on a product page, decide which
  Product JSON-LD node owns the page.** Run `seo-review` and Google's Rich Results test on that
  page; the two candidate owners are the theme's `structured_data` output and the app's rich
  snippets. Present the evidence and let the operator choose. Do not edit or suppress the app block,
  and do not silence `jsonld-product-duplicate`; a theme-side change happens only if the operator
  picks the theme as owner. Reasoning in the Judge.me readiness entry in `release-notes.md`. The
  duplicate Product node is live on `/products/lead-ii-vest-womens` as of 2026-09-13, and the
  `search-console` skill's Enhancements capture (`enhancement-product-duplicate-evidence`) is the
  evidence source for which node Google reads.

- **When the first ratings exist, add a `review` block to the static product-card children in
  `templates/collection.json` and `templates/index.json`** (inside the `_product-card` block's
  children, beside the product-title and price blocks). It renders nothing until the app writes the
  `reviews.rating` metafields, which is why it waits.

- **Thank-you card or packing-slip artwork carrying the Judge.me review QR.** The link and QR
  are generated in the app's admin (Settings > Request reviews > Links, QR codes > Manage); the
  artwork lives outside the repo.

- **Correct the sync theme's name in `README.md` and `CLAUDE.md`.** Both call it
  `EDIT HERE - Admin Sync`; Admin's theme library lists it as `EDIT HERE - shopify-sync`. The theme ID
  in README's "Branches and themes" table is the stable identifier; check it matches before editing.

- **Once the first post is visible, finish the blog's audit and navigation wiring.** Add real
  article paths to `scripts/a11y/paths.json`; re-check the empty-blog accepted-risk rows in
  `scripts/seo-review/accepted-risks.json`, which exist only because the blog is empty; confirm
  whether the default article template emits `Article` JSON-LD (nothing in the theme adds a
  `BlogPosting` node, deliberately, so do not assume one exists); run a post-publish `seo-review`;
  and consider adding the blog to the footer or main menu in Admin, reading
  `docs/theme-settings-contracts.md` first.

- **Settle the article push's unexercised Admin behaviours on the first real post's edit
  cycle.** The only live push so far was a create of a table-and-tags test article. Still unproven:
  what `articleUpdate` does to an existing article at all, whether an update with a null image removes
  the featured image (on the spike, deleting the Files entry left the copied image serving, so removal
  is not the same as deleting the source), and how the body normaliser treats anything beyond a flat
  table (`pre` and nested tables stay refused by the checker until proven). The first real post's
  first edit answers the update question; record what it showed in `scripts/articles/README.md`
  ("What the tests do not prove") and `release-notes.md`.

- **Exercise the article image upload path live, on the first real post with a photo.** The
  operator decided this plan's end-to-end checks upload nothing, so the uploader has only run against
  a fake client and a fake staged-upload endpoint. Follow `.claude/skills/articles/images.md`'s gate
  end to end, dry run first, on one photo, and read the result before trusting the rest. An uploaded
  file is public at its CDN URL at once, so this is a live write in its own right.

- **Decide whether the article push should stop re-sending an unchanged featured image.** Every
  update input carries the image URL whenever the repo has one, and Shopify copies an image set by URL
  to its own CDN path, so each push likely leaves a fresh CDN copy behind. Omitting an unchanged image
  from the update would change the pinned mutation input shape (asserted by whole-object equality in
  the push suite) and the image comparison through the observation, so it needs its own reviewed
  change, and the null-image question above should be settled first.

- **Re-record `customer_email_address_changed_confirmation`'s stock snapshot without the
  injected colour block.** Two steps, in order. First, in Admin, turn the colour customisation off
  under Settings > Notifications > *Customize email templates*: while it is on, the shop-injected
  `<style>` block after `</head>` is written into this store's copy and comes back on every
  re-record. Then run `/notification-templates record
  customer_email_address_changed_confirmation`, which re-snapshots the stock and lets the
  `override.replace` that currently drops the block be removed. **The `record` run reverts that
  template to stock in Admin**, so it sends unbranded from then until the next `sync` of that id;
  budget for both runs in one sitting. `marketing/notifications/README.md` explains what the block
  is and why the override exists.

- **Remove the launch countdown at public launch.** Delete `blocks/launch-countdown.liquid` and
  `assets/launch-countdown.js`, the password-template script block in `snippets/scripts.liquid`, the
  `launch_countdown` entry in `templates/password.json`, and the countdown deviation entry in
  `docs/accessibility-patterns.md`. Also decide on the pre-launch social links added alongside it:
  the `follow_heading` and `follow_links` entries in `templates/password.json` and the
  `.password-follow__*` rules in `sections/password.liquid`. Unlike the countdown these may be worth
  keeping once the gate is off, since the block is just a wrapper around the shared
  `snippets/social-links.liquid`; the decision is whether the password page still earns them when the
  footer and homepage are reachable. Decide separately whether the dark password-page treatment stays
  (the `sss-dark-scheme` defaults in `layout/password.liquid`, `sections/password.liquid` and
  `sections/password-footer.liquid`); it only renders while the gate is on. No locale files are
  involved, so there is nothing to unwind there.

- **Scheduled live-drift detection for the shop policies.** `npm run policies:check` is offline
  and proves only that the repo agrees with itself; nothing automated notices when someone edits a
  policy in Admin. The push-time freshness gate catches it at the one moment it can do damage
  (`scripts/policies/push.mjs` step 4), and the manual cadence is in
  `marketing/policies/README.md`. A scheduled `policies:pull --check` opening a sticky issue is the
  fuller answer, and it was deliberately left out of `validate.yml`: it needs
  `read_legal_policies` credentials, and putting them in a workflow widens the blast radius of the
  whole subsystem to anyone who can trigger one, on a workflow that also runs for Dependabot. If
  this is ever built, it belongs in a separate scheduled workflow with its own minimal secret, not
  in `validate`.

- **Reconcile the two delay-refund windows.** The shipping policy's "Order Delays and
  Communication" promises a refund "within 7 business days" when a customer cancels a delayed
  order; the refund policy states 10. Pre-existing, not introduced by the 3-5 day change, and
  flagged rather than fixed because picking the right number is an operator decision. Both are now
  in the repo (`marketing/policies/shipping_policy.html`,
  `marketing/policies/refund_policy.html`), so whichever way it goes is one `policies:push` per
  policy.

- **Read the refund policy's misspellings disclaimer against the new personalisation-pause
  copy.** The refund policy says the studio is "not responsible for misspellings" in
  customer-provided details. The shipping policy now also promises to reach out when a
  personalisation detail is unclear (an ambiguous spelling, a character count that will not fit, a
  thread colour) and to pause production until the customer replies. Those are not contradictory:
  one is about details the customer got wrong, the other about details the studio could not read.
  Worth a read for tone, since they sit one click apart.

- **Teach `push.mjs` to persist the `shopPolicyUpdate` response, THEN capture one as a fixture.**
  The whole suite runs against a hand-shaped fake client. Three live writes have now been spent
  without a capture, and the reason is not forgetfulness: nothing in `push.mjs` writes the response
  anywhere, and no flag or environment variable dumps it, so "capture it on the next push" is not a
  thing anyone can actually do. Waiting for a fourth push changes nothing. Add the persistence first
  (the backup file it already writes is the obvious home), in its own reviewed PR, since it touches
  the only write path in the repo; then the next push captures itself and `test/helpers.mjs` can be
  reshaped against real bytes. Until then, "the mutation's actual input shape against the live
  schema" stays unproven, though the v3 terms push proves the shape is at least ACCEPTED by the live
  schema.

- **`real-bodies.test.mjs`'s `parseWindow` silently mis-parses "3 to 5 business days" as
  `[5,5]`,** and its regex should be shared with the one in `templates-cohesion.test.mjs`. The
  offline-by-contract source regexes are also single-quote-only, static-only and non-transitive.

- **Converge the remaining 14 `GHEOF` heredocs in `validate.yml`.** The four notification and
  policy steps now use the `/dev/urandom` delimiter plus the `sed` neutraliser from the actionlint
  step. Fourteen others still close on the literal `GHEOF`, and several echo repo-file content
  (`theme-check`, `blank-id-guard`), so a file containing a line that is exactly `GHEOF` closes the
  block early; because `exit_code=` is written first, an injected `exit_code=0` would win on a
  last-write-wins parse. Same sweep should decide `if: ${{ !cancelled() }}` job-wide rather than on
  the four-step island it is on now: as it stands, a step timeout skips every later check including
  Gitleaks, which fails closed but is very hard to triage.

- **Reconcile the anchor contract with `docs/theme-conventions.md`.** That doc recommends
  putting an `id` on an Admin policy heading so the anchor survives rewording, and
  `assets/policy-nav.js` does honour an existing id. But `extractHeadings` never reads attributes,
  so such a heading would be pinned in `marketing/policies/manifest.json` under an id the runtime
  never assigns, and nothing detects it. Either model the attribute or drop the recommendation for
  tracked policies. Related: `uniqueId` collides against the whole document while
  `duplicateHeadingIds` only compares h2s to each other.

- **Tell `add-product` about the two new template rules.**
  `.claude/skills/add-product/phase-1-repo-pr.md` says to clone an existing
  `templates/product.<suffix>.json`. A seventh product now has to carry the `accordion_row_st001`
  row byte-identically (or be added to `NO_SHIPPING_ROW` with a reason) and must state no
  business-day duration, both enforced by `scripts/policies/test/templates-cohesion.test.mjs`. The
  skill already names the size-chart and Product Details anchor rules for the same reason.

- **Three `add-product` run findings the process pass did not reach.** The deliberate pass over
  the skill has landed (`release-notes.md`, and the `scripts/add-product/` helpers), and it covered
  the discovery cost, the hero-attach ordering, the state file, the in-session continue, the deploy
  and CI signals, and which checkout to run from. These three came out of the same review and are
  still open, each because the defect belongs to a sub-skill or a surface this pass did not touch:
  - **Preflight the scopes phase 2 needs, at its start.** `publishablePublish` needs
    `write_publications`, which the app does not grant, and that surfaced only as a mid-run
    ACCESS_DENIED. The `admin-manual, policy` vs `admin-manual, api-blocked` tags now record which
    steps the API cannot do, but nothing checks the granted scopes up front the way
    `product-images` already does. That one step turns every such surprise into a phase-start fact.
  - **No retry around live Admin writes.** `upload-product-media.mjs` has none, and one run hit
    three transient WSL2 IPv6/IPv4 connect failures. It survived because a re-run reported
    `skip(dupe)`, so the write path is idempotent; that property is load-bearing and currently
    untested and undocumented. (The read-only convergence poll in `blank-inventory` had the same
    shape of problem and now retries; see `release-notes.md`. This one is the write path, where
    re-driving is not safe on its own, so the idempotency property has to come first.)
  - **Approved artefacts were overwritten with no backup.** An approved final image was replaced
    between sessions and recovered only because the operator had shared it elsewhere. Consider a
    rule that anything past an approval gate is copied aside before being rewritten.
  Deliverable for each: proposed edits to the owning skill or script, presented for review, not
  applied blind.

- **Give `site-check` a publication check, so "ACTIVE but invisible" is caught by a machine.**
  `scripts/site-check/lib/admin-checks.mjs`'s `product-status` check is the one that read green on a
  product published to zero sales channels: it tests `status === 'ACTIVE'` and stops there.
  `scripts/site-check/lib/admin-queries.mjs` already selects per-product fields on an authenticated
  query, so adding `resourcePublicationsV2(first: 25) { nodes { isPublished publication { name } } }`
  and a `product-unpublished` ERROR needs no new query and no new scope; the read works today, only
  the write scope is missing. That covers every product forever, including ones added outside
  `add-product` and channels changed months later, which is what the skill's prose cannot do.
  **Do not use `onlineStoreUrl` for this**, the obvious-looking field. Its old disqualification was
  that it read null on every product, published or not, because the storefront was
  password-protected (verified 2026-09-03 against both `shift-fuel-tote` and the long-live
  `shift-fuel-crewneck`); the store went public before 2026-09-08 and it is non-null on published
  products now. The reason it is still the wrong field is the one that does not expire:
  `resourcePublicationsV2` names the channels, so it distinguishes "published to the Online Store
  only" from "published everywhere its siblings are", and it is the check that catches an empty
  set outright. A URL tells you one channel answered.

## Deferred review findings

- **add-product-run-review-1** (test-engineer, 2026-09-08): the bulk-update-fails-after-option-update path has no test, so the exit code, the repair message and the deliberate non-break are unpinned -> add a fake client whose variant setup returns userErrors.
- **add-product-run-review-2** (test-engineer, 2026-09-08): the count-mismatch warning path has no test, so disabling the branch survives the suite -> re-read fixture returning fewer new variants than planned, asserting the warning and that setup still runs.
- **add-product-run-review-3** (test-engineer, 2026-09-08): receipt behaviour is under-asserted, with three surviving mutants -> assert the file is 0600 under a 0700 directory, that a receipt is written even when the run failed partway, and that a dry run writes none.
- **add-product-run-review-4** (test-engineer, 2026-09-08): the dry-run early return is untested on the repair and hero-attach paths, so nothing proves the recovery command writes nothing -> one test per path asserting no client calls and the exact copy line.
- **add-product-run-review-5** (test-engineer, 2026-09-08): the value-already-exists pre-flight only proves it looked at the first product -> fixture where only the second product carries the value.
- **add-product-run-review-6** (test-engineer, 2026-09-08): the repair path never asserts what it sends, so a hardcoded price or one weight applied to every product both survive -> assert the per-product weight and price, plus the two missing-flag refusals and the zero-target skip.
- **add-product-run-review-7** (test-engineer, 2026-09-08): price validation is entirely untested on both the add and repair paths -> cover the missing and non-numeric refusals.
- **add-product-run-review-8** (test-engineer, 2026-09-08): the shared Admin read module has no test file at 65 percent lines, and every completion verdict turns on the fields it normalises -> cover the missing inventory-item case, two-page pagination and the page-cap refusal.
- **add-product-run-review-9** (test-engineer, 2026-09-08): the option-value command derives its scope as "all handles unless one was named", so passing both a namespace and a handle list silently ignores the namespace and the mutual-exclusion refusal is unreachable there -> make it refuse, or test the precedence deliberately.
- **add-product-run-review-10** (test-engineer, 2026-09-08): three assertions pass for the wrong reason, the loosest being a case-insensitive alternation that matches almost any rewording -> pin the specific phrases.
- **add-product-run-review-11** (test-engineer, 2026-09-08): an empty-string CI value passes the gate by truthiness, matching the policy-push precedent, while the standing rule says emptying it is as forbidden as unsetting it -> decide between presence-checking in both places and recording the truthiness choice with a test.
- **add-product-run-review-12** (test-engineer, 2026-09-08): nothing asserts that no workflow invokes the gated option-value command, which is the stated justification for its unconditional CI refusal; the policy-push suite has that guard -> add the equivalent static check.
- **add-product-run-review-13** (code-review, 2026-09-08): the state directory has no guard against being a symlink or resolving outside the expected root -> validate the resolved path before writing.
- **add-product-run-review-14** (code-review, 2026-09-08): a stale temporary file can trip a permission edge case that the policy tooling already fixed once -> port that fix.
- **add-product-run-review-15** (code-review, 2026-09-08): a re-export in the helper libraries is dead -> remove it.
- **add-product-run-review-16** (code-review, 2026-09-08): the CI and terminal gate logic is duplicated between the option-value helper and the policy push -> consider one shared module, weighing that against keeping the two blast radii independent.
- **add-product-run-review-17** (code-review, 2026-09-08): three read-only fetch helpers await sequentially where the reads are independent -> parallelise if the Admin throttle allows.
- **blank-inventory-backfill-dry-run-1** (test-engineer, 2026-09-10): the dry-run backstop reads only a document's first operation keyword, so a fragment-first or multi-operation mutation document would pass it -> add a source scan confining mutation documents to lib/mutations.mjs, and a test pinning the fragment-first behaviour.
- **add-product-run-review-18** (security-review, 2026-09-08): the run renderer sanitises evidence but prints product titles, ids and channel names from the store raw, so terminal-escape forgery is possible in principle -> sanitise the rendered live-store strings for consistency. Not exploitable today: no untrusted party can write those fields on a single-operator store.
- **shared-observation-state-1** (test-engineer, 2026-09-12): the shared observation-state module exports a default error class that nothing imports and nothing pins, so the contract the next subsystem inherits by omitting the option is unverified -> assert its name, subject, detail and message shape in the shared module's own suite.
- **shared-observation-state-2** (test-engineer, 2026-09-12): the unreadable-state-file branch has no test, and after the extraction it also sits outside every coverage floor, so the hole stopped being visible -> add a POSIX-only, non-root-only case that makes the file unreadable and asserts the refusal names the seeding command.
- **shared-observation-state-3** (test-engineer, 2026-09-12): the case-insensitive half of the containment rule is skipped on linux and CI is linux, so that branch is exercised by no gate anywhere -> inject the platform flag instead of reading it at module scope, so both halves are testable on either platform.
- **shared-observation-state-4** (test-engineer, 2026-09-12): the shared lib directory has no branch-coverage floor, so the extracted mechanism lost the one it had while it lived under the policies glob, and the drop was only 0.4 points on the overall gate -> add a lib coverage script at the same 80 percent floor and wire it beside the existing suite step.
- **blog-shift-notes-repair-1** (security-review, 2026-09-12): the empty-blog accepted-risk row matches with a null path, which the matcher treats as a wildcard, so it suppresses that check for every blog in the shop rather than the one it was written for -> give the row an explicit key, or make the matcher require one for that check.
- **agent-af8da37f263b91dad-2** (test-engineer, 2026-09-13): images.json records a sha256 per image but nothing compares it with the local processed file, even when the gitignored image directory is present -> implement the comparison when the directory exists, which needs the format to record the local filename.
- **agent-af8da37f263b91dad-3** (test-engineer, 2026-09-13): the clean fixture holds a single article, so manifest key ordering across entries and cross-article rules run only against synthetic mutations -> add a second article to the committed fixture.
- **search-console-skill-1** (test-engineer, 2026-09-13): the search-console contract test compares only check-id sets and backticked constant values, so README severities, subject kinds, schema field lists, the NOINDEX_OK list, the required-report sentence and the browser.md capture example can drift unnoticed -> parse those README tables and sentences against the exported registries, and validate the browser.md example capture.
- **search-console-skill-2** (test-engineer, 2026-09-13): a required report (settings for audit, performance for insights) that is present but not-ready passes validation, so an insights run on a brand-new property succeeds on no performance data -> decide whether that is intended, then pin the choice with a test either way.
- **search-console-skill-3** (test-engineer, 2026-09-13): adding a previously open finding to accepted-risks.json makes the next run list it as resolved, because runs save only unaccepted findings -> decide whether acceptance should read as resolved or as its own transition, then pin it with a test.
- **search-console-skill-4** (test-engineer, 2026-09-13): the evaluateCapture de-duplication keeps the most severe finding per key, but no natural capture produces one key at two severities, so the rule is untested -> export the de-duplication step or find a fixture that reaches it, and assert the kept severity.
- **notification-social-five-1** (test-engineer, 2026-09-15): the two miniature footer fixtures under the notifications test dir still carry the pre-branch shape, one cell per network with nowrap, so they no longer read as miniatures of the partial they stand in for -> rebuild them as one cell of adjacent inline-block anchors. Nothing breaks today; the generator is a pure text inserter and ignores the shape.
