# search-console

The deterministic half of the `search-console` skill (`.claude/skills/search-console/SKILL.md`).
There is no Search Console API here: the operator declined a Google Cloud project, so the skill
reads Search Console in the operator's logged-in browser and Claude transcribes what it reads into a
capture JSON. `review.mjs` normalises and validates that capture, cross-checks it against the live
storefront sitemap, runs every check, diffs each report against its latest comparable run, saves the
run, and prints the record the skill's prose layers build on.

Read-only. It never opens a browser, never writes a capture, and never writes inside the checkout.

## Usage

```
node scripts/search-console/review.mjs <capture.json> [--full] [--no-save] [--json] [--offline] [--sitemap-count N] [--now <iso>]
node scripts/search-console/review.mjs --print-state-dir
npm run search-console:test
```

| Flag | Effect |
|---|---|
| `--full` | also print unchanged findings and accepted risks |
| `--no-save` | do not write a run file |
| `--json` | one JSON object: `{ fresh, accepted, added, resolved, unchanged, notCompared, metrics, exitCode }` |
| `--offline` | no network at all: no sitemap fetch, no redirect probe |
| `--sitemap-count N` | use N as the live sitemap count instead of fetching it (per-URL checks skip) |
| `--now <iso>` | evaluate as of that time (tests, reproducing an old run) |
| `--print-state-dir` | print the resolved state dir (`~` for home) and exit |

Exit: `0` when there is no fresh ERROR (WARN, INFO and accepted ERRORs do not block); `1` for a
fresh ERROR, or a capture that is not JSON or fails the schema (nothing evaluated or saved, and
`--json` output still parses); `2` for a usage error, an unreadable file, a malformed
`accepted-risks.json`, or a state dir inside the repository.

Order: read, parse, `normaliseCapture` (converts "3.2%", "1,234", "<0.1%", reason labels, "Yes",
"URL is on Google"; refuses "1.2K"), `validateCapture`, live sitemap fetch, redirect probes,
`evaluateCapture`, `finishRun`.

## Files

| File | Role |
|---|---|
| `review.mjs` | CLI; `run(argv, io)` is exported for tests |
| `lib/schema.mjs` | the capture contract and validator; report ids, periods, reason slugs, enhancement types |
| `lib/normalise.mjs` | page text to schema values; idempotent; runs before validation |
| `lib/checks.mjs` | every check id, its severity, subject kind and report, every threshold constant, `evaluateCapture` |
| `lib/known-surfaces.mjs` | `KNOWN_SURFACES`, the Search Console vocabulary already met |
| `lib/sitemap.mjs` | anonymous node fetch of the live sitemap; the unfollowed redirect probe |
| `lib/baseline.mjs` | state dir, the inside-the-repo refusal, run files, comparable-run lookup |
| `lib/report.mjs` | accepted risks, per-report diffs, metric deltas, printing, exit code |
| `accepted-risks.json` | known, deliberate findings |

Reused from elsewhere: `scripts/seo-review/lib/checks.mjs` (severities, `partitionAccepted`,
`diffFindings`, `findingKey`, `exitCodeFor`), `scripts/seo-review/lib/http.mjs` (node fetch, never
curl: Cloudflare blocks curl's fingerprint), `scripts/seo-review/lib/extract.mjs` (sitemap parsers),
`scripts/lib/display-path.mjs`, and `scripts/lib/seo-bounds.mjs` (through the seo-review modules). The contract test holds the import closure to that list and keeps
`node:child_process` out of it.

## Capture schema

Envelope: `schema` (1), `mode` (`audit` or `insights`), `property`, `property_added` (YYYY-MM-DD),
`captured_at` (ISO 8601 with an offset), `nonce` (8 to 16 lowercase letters and digits), `reports`.
Each report carries `captured_at`, `report` (its own id) and `status` (`ok`, `not-ready`,
`not-present`); only an `ok` report carries data fields.

`audit` requires `settings`, `insights` requires `performance`; a missing expected report is a
finding, not a rejection, so a run the Login STOP cut short still saves.

| Report | Fields when `ok` |
|---|---|
| `settings` | `property_type` (`domain` or `url-prefix`), `verified`, `method`, `owners`, `users`, `unused_tokens`, `ownership_events`, `change_of_address_set`, `bulk_export_configured`, `ai_control` (`include` or `exclude`), `email_notifications`, optional `secondary_domains` (hosts) |
| `associations` | `services` (`analytics`, `merchant-center`, `youtube`, `ads`, or `other:<text>`), `pending` |
| `crawl-stats` | `robots_state` (`not-seen`, `fetched`, `error`), `host_status` (`ok`, `issues`, `no-data`), `requests`, `share_5xx`, `share_4xx` (each nullable) |
| `removals` | `temporary_active`, `outdated_active`, `safesearch_active`, optional `temporary_urls` |
| `messages` | `unread`, `total`, `subjects` (each at most 120 characters) |
| `sitemaps` | `rows[]`: `path`, `type`, `status` (`Success`, `Couldn't fetch`, `Has errors`, `Pending`), `discovered_pages`, `discovered_videos`, `submitted`, `last_read` |
| `indexing-pages` | `indexed`, `not_indexed`, `reasons[]`: `reason` (slug), optional `label`, `source`, `count`, `examples` (at most 5 URLs) |
| `inspections` | `items[]` (at most 8): `url`, `verdict` (`on-google`, `not-on-google`), `indexed`, `user_canonical`, `google_canonical`, `last_crawl`, `crawled_as`, `crawl_allowed`, `page_fetch`, `indexing_allowed`, `discovery`, `videos`, `sections`, `rich_results` |
| `cwv` | `mobile`, `desktop`: each `{ good, needs_improvement, poor }` or `"no-data"` |
| `https` | `https_urls`, `non_https_urls` |
| `enhancements` | `items[]`: `type`, `valid`, `invalid`, `warning` |
| `security-manual` | `manual_actions`, `security_issues` (`none` or `present`), `text` |
| `links` | `top_linking_sites`, `top_linked_pages[]` and `internal_top[]` of `{ url, links }` |
| `performance` | `period` (`24h` to `16mo`), `data_freshness`, `search_type`, `totals`, `queries`, `pages`, `countries` (each `{ rows[], truncated }`), `devices` (`desktop`, `mobile`, `tablet`), optional `search_appearance` and `days` |
| `discovery` | `nav[]` of `{ label, path }`, `settings_rows`, `user_settings_rows`, `performance_tabs`, `performance_controls`, `removals_tabs`, `inspection_sections`, `enhancement_types`, `reason_labels`, `unknown[]` of `{ kind, label, path, note }` |

Rules: unknown keys are rejected at every depth; integers are non-negative; rates are 0 to 1;
positions are 1 to 100, or 0 only with zero impressions; clicks never exceed impressions; a ctr
agrees with clicks over impressions within 0.005; reason counts sum to `not_indexed`; device and
country impressions never exceed the total; `owners` never exceeds `users`. Every page URL is on the
property host with no query string or fragment, never on a `checkouts`, `account`, `orders` or
`cart/c` route (whole segments, anywhere in the path, any case), and never with a token-shaped
segment: 20 or more unbroken letters, digits or underscores including a digit or a capital, or a
UUID. Hyphens break the run, so product handles pass; so do long all-lowercase words and Shopify's
`sitemap_<type>_<n>.xml` child names. A `discovery` view path obeys the same token rule. No
email-shaped string anywhere.
Errors name a JSON pointer and never echo the value.

## Checks

A finding is `{ check, severity, url, detail }`. `url` is the subject, whose kind is fixed per check
(`SUBJECT_KIND`): `page` (a storefront URL), `report`, `device`, `service`, `host`,
`enhancement-type`, `label` (a Search Console label), `pointer` (a JSON pointer), `singleton` (the
check id itself), or the two mixed kinds `page-or-reason` and `page-or-singleton`. Performance
findings are keyed by page, never by query.

| Check | Severity | Subject | Why |
|---|---|---|---|
| `capture-invalid` | ERROR | pointer | the capture is not JSON or fails the schema |
| `capture-missing-report` | INFO | report | a report the mode expects is absent |
| `capture-stale` | INFO | singleton | captured more than `STALE_CAPTURE_DAYS` (7) days ago |
| `gsc-not-ready` | INFO | report | Search Console has no data for the report yet |
| `gsc-property-mismatch` | ERROR | singleton | the capture is not for `PROPERTY` |
| `property-url-prefix` | WARN | singleton | a URL-prefix property splits data with the Domain property |
| `verification-lost` | ERROR | singleton | ownership is no longer verified |
| `verification-method-fragile` | INFO | singleton | verified by a tag or file a deploy can remove |
| `owner-single` | INFO | singleton | one owner; losing that account loses the property |
| `users-unexpected` | WARN | singleton | more users than owners plus one |
| `ownership-tokens-unused` | INFO | singleton | leftover ownership tokens |
| `change-of-address-set` | ERROR | singleton | Google is being told the site moved |
| `bulk-export-configured` | INFO | singleton | needs a Cloud project the operator declined |
| `ai-control-exclude` | WARN | singleton | removes the store from AI Overviews and AI Mode |
| `email-notifications-off` | WARN | singleton | critical issues would arrive unseen |
| `secondary-domain-redirect` | WARN, INFO when a permanent redirect to the canonical host | host | a second brand domain must redirect, not serve |
| `robots-not-seen` | WARN, INFO within `ROBOTS_GRACE_DAYS` (7) days | singleton | Search Console has not fetched robots.txt |
| `robots-fetch-error` | WARN | singleton | robots.txt fetch failed |
| `crawl-host-issues` | WARN | singleton | Crawl stats host status reports issues |
| `crawl-5xx-share` | WARN | singleton | 5xx share above `CRAWL_5XX_SHARE` (0.01) |
| `crawl-4xx-share` | WARN | singleton | other-4xx share, where 429s land, above `CRAWL_4XX_SHARE` (0.05) |
| `association-missing` | INFO | service | no Analytics or Merchant Center association |
| `association-pending` | INFO | singleton | a pending association request |
| `removal-active` | ERROR for a live sitemap URL, else WARN | page-or-singleton | a temporary removal hides a page from Google |
| `removal-other-active` | INFO | singleton | outdated-content or SafeSearch requests |
| `messages-unread` | INFO | singleton | unread Search Console messages |
| `sitemap-missing` | ERROR | singleton | `/sitemap.xml` is not submitted |
| `sitemap-error` | ERROR | page | a submitted sitemap cannot be fetched or has errors |
| `sitemap-pending` | INFO | page | submitted, not yet read |
| `sitemap-child-submitted` | WARN | page | a child sitemap submitted on its own |
| `sitemap-discovered-mismatch` | WARN | page | discovered pages differ from live by more than `SITEMAP_TOLERANCE` (1) |
| `sitemap-stale-read` | INFO | page | last read more than `SITEMAP_STALE_READ_DAYS` (14) days ago |
| `sitemap-live-unreachable` | INFO | singleton | the live sitemap failed; live counts skipped (a partial read still proves the URLs it listed) |
| `index-count-below-sitemap` | WARN, INFO while there are no impressions or with only `--sitemap-count` | singleton | fewer indexed than indexable sitemap URLs |
| `index-reason-crawled-not-indexed` | WARN | page-or-reason | crawled, not indexed |
| `index-reason-discovered-not-indexed` | INFO | page-or-reason | discovered, not yet crawled |
| `index-reason-alternate-canonical` | INFO | page-or-reason | an alternate with a proper canonical, expected |
| `index-reason-duplicate-no-canonical` | WARN | page-or-reason | a duplicate with no declared canonical |
| `index-reason-duplicate-google-chose-different` | WARN | page-or-reason | Google overrode the declared canonical |
| `index-reason-noindex` | ERROR outside `NOINDEX_OK`, WARN for an unverified remainder | page-or-reason | noindex on a page meant to be indexed |
| `index-reason-not-found` | WARN for a live sitemap URL, else INFO | page-or-reason | 404 |
| `index-reason-redirect` | INFO | page-or-reason | a redirecting URL, expected |
| `index-reason-soft-404` | WARN | page-or-reason | a page Google reads as empty |
| `index-reason-blocked-robots` | WARN | page-or-reason | blocked by robots.txt |
| `index-reason-server-error` | ERROR | page-or-reason | 5xx on crawl |
| `index-reason-forbidden` | WARN | page-or-reason | 403 on crawl |
| `index-reason-other-4xx` | WARN | page-or-reason | another 4xx on crawl |
| `index-reason-unknown` | INFO | label | a reason label not yet in `KNOWN_REASONS` |
| `inspect-not-indexed` | WARN | page | a spot-checked URL is not on Google |
| `inspect-canonical-mismatch` | WARN | page | user and Google canonicals differ |
| `inspect-stale-crawl` | INFO | page | last crawl more than `STALE_CRAWL_DAYS` (30) days ago |
| `inspect-crawl-blocked` | ERROR | page | crawl or indexing not allowed on a sitemap URL |
| `inspect-fetch-failed` | WARN | page | page fetch did not succeed |
| `inspect-rich-result-missing` | INFO | page | a rich result `EXPECTED_RICH_RESULTS` expects is absent |
| `inspect-section-unknown` | INFO | label | an inspection section not yet known |
| `cwv-poor` | WARN | device | poor Core Web Vitals URLs |
| `cwv-needs-improvement` | INFO | device | URLs needing improvement |
| `cwv-no-data` | INFO | device | not enough usage data, expected on a small site |
| `https-non-https` | ERROR | singleton | URLs not served over HTTPS |
| `https-no-data` | INFO | singleton | the HTTPS report has no data yet |
| `enhancement-invalid` | ERROR | enhancement-type | invalid rich-result items |
| `enhancement-warning` | WARN | enhancement-type | rich-result items with warnings |
| `enhancement-absent` | INFO | enhancement-type | Product snippets or Breadcrumbs absent while a product is indexed; judged only once the Enhancements report exists |
| `enhancement-product-duplicate-evidence` | INFO | singleton | evidence for the Judge.me Product JSON-LD owner decision |
| `enhancement-type-unknown` | INFO | enhancement-type | an enhancement type not yet known |
| `manual-action` | ERROR | singleton | a manual action is listed |
| `security-issue` | ERROR | singleton | a security issue is listed |
| `perf-zero-impressions` | INFO | singleton | no impressions in the period |
| `perf-brand-only` | WARN, INFO before `BRAND_ONLY_MIN_AGE_DAYS` (60) days | singleton | every captured query is a brand query |
| `perf-page-no-impressions` | WARN, INFO before `PAGE_NO_IMPRESSIONS_MIN_AGE_DAYS` (28) days | page | an indexable sitemap page with no impressions |
| `perf-low-ctr` | WARN | page | at least `CTR_MIN_IMPRESSIONS` (100) impressions, ctr under `CTR_MIN` (0.02), position at or better than `CTR_MAX_POSITION` (10) |
| `perf-position-opportunity` | INFO | page | position inside `OPPORTUNITY_POSITIONS` ([4, 15]) with at least `OPPORTUNITY_MIN_IMPRESSIONS` (20) impressions |
| `perf-country-outside-us` | INFO | singleton | more than `COUNTRY_OUTSIDE_US_SHARE` (0.1) of impressions outside the US |
| `search-type-new` | INFO | label | a search type not yet known |
| `period-mismatch` | INFO | singleton | the previous comparable run used another period; not compared |
| `links-none` | INFO | singleton | no external linking sites |
| `surface-new` | INFO | label | a Search Console item not in `KNOWN_SURFACES` |
| `surface-gone` | INFO | label | a known item is missing; renamed or removed |
| `discovery-review-due` | INFO | singleton | `KNOWN_SURFACES_REVIEWED_ON` older than `DISCOVERY_REVIEW_DAYS` (90) days |

Brand-only and the country share also need at least `NOISE_FLOOR_IMPRESSIONS` (50) impressions.
`NOINDEX_OK` is `/blogs/shift-notes`, `/cart`, `/search`, and everything under `/policies/`,
`/account` and `/checkouts/`.

## State dir and run files

`SEARCH_CONSOLE_STATE_DIR`, else `$XDG_STATE_HOME/search-console`, else
`~/.local/state/search-console`. A state dir that resolves inside the worktree or the primary
checkout (lexically, through a symlink either way, or by its nearest existing ancestor) is refused
with exit 2.

Each valid run writes `<mode>-<ISO stamp>-<NN>.json` holding `generated`, `mode`,
`capture_basename`, `report_status` (per report), `metrics` (clicks, impressions, indexed,
not_indexed, discovered), `period`, `meta` (nonce, captured_at, sitemap state), `findings` (fresh)
and `accepted`. An all-not-ready run is saved too, so the history shows when each report came alive.

Each report is diffed only against the newest run of the same mode in which that report was `ok`;
a report that is not `ok` now is listed as not compared, never as resolved. Performance is compared
only across runs over the same period. An `insights` run never becomes an `audit` baseline.

**Captures never enter the repo.** Claude writes them to the state dir; this script reads them and
writes only run files beside them.

## Accepted risks

`accepted-risks.json` is an array of `{ check, path, note, accepted_on }`. `path` equals the finding
subject exactly (a URL path for a page subject), or `null` for every subject of that check. A
`perf-*` risk is accepted by page path only, never by query. `loadAcceptedRisks` refuses a malformed
file (exit 2). An accepted ERROR does not block.

## Self-discovery

`KNOWN_SURFACES` in `lib/known-surfaces.mjs` holds the navigation, settings rows, tabs, controls
and labels observed on the live property. Every capture's `discovery` inventory is compared with it:
new items are `surface-new` (and the finer `index-reason-unknown`, `enhancement-type-unknown`,
`inspect-section-unknown`, `search-type-new`), missing ones `surface-gone`. All are informational.
A new item lands through a reviewed PR that extends `KNOWN_SURFACES`, adds its `audit.md` entry and
a fixture, and moves `KNOWN_SURFACES_REVIEWED_ON`; `test/contract.test.mjs` refuses one half
without the other. Nothing edits these files during a run.

## Tests

`npm run search-console:test`: offline, with `now`, env and fetch injected. `test/harness.mjs`
holds the healthy capture (zero findings) and `FIXTURE_FOR`, one mutation per check id; every id
must fire on its mutation and not on the healthy capture. `contract.test.mjs` also holds the skill
docs to the code (capture markers, surfaces, check ids, quoted constants, the two byte-identical
blocks).
