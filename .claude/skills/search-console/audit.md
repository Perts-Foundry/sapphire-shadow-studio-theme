# Search Console audit checklist

The surfaces a run visits, in visit order, with what healthy and failing look like, which checks
each feeds, who fixes it, and which capture report it fills. Anchor text is quoted as observed on
the live property on 2026-09-13; a day-one property shows "Processing data" or "No data" almost
everywhere, and that is `not-ready`, not a failure.

Severities are named by their constant in `scripts/search-console/lib/checks.mjs`
(`SEVERITY['<check id>']`, or `REASON_SEVERITY['<slug>']` for the page indexing reasons), never as
a literal: the constant is the record, and a doc that restated a level would drift from it. Where a
check's level depends on property age or on the live sitemap, the entry says so and the constant is
the ceiling.

View paths are relative to `https://search.google.com/search-console/`, and every view URL carries
`?resource_id=` with the property id URL-encoded.

| Surface | Capture report |
|---|---|
| 1 Property inventory | settings |
| 2 Second brand domain | settings |
| 3 Ownership verification | settings |
| 4 Users and permissions | settings |
| 5 Associations | associations |
| 6 Change of address | settings |
| 7 Bulk data export | settings |
| 8 Search generative AI | settings |
| 9 robots.txt report | crawl-stats |
| 10 Crawl stats | crawl-stats |
| 11 Removals | removals |
| 12 Email preferences | settings |
| 13 Messages | messages |
| 14 Sitemaps | sitemaps |
| 15 Page indexing | indexing-pages |
| 16 URL inspection spot-checks | inspections |
| 17 Core Web Vitals | cwv |
| 18 HTTPS | https |
| 19 Enhancements | enhancements |
| 20 Security issues and Manual actions | security-manual |
| 21 Links | links |
| 22 Performance | performance |
| 23 Insights page and Achievements | none |
| 24 Discovery inventory | discovery |

## Run-level checks

These are about the capture itself rather than a surface:

- `capture-invalid` (`SEVERITY['capture-invalid']`): the capture is not JSON or fails the schema.
  One finding per JSON pointer; nothing is evaluated or saved. Fix the transcription.
- `capture-missing-report` (`SEVERITY['capture-missing-report']`): a report the mode expects is
  absent, usually because the Login STOP cut the run short.
- `capture-stale` (`SEVERITY['capture-stale']`): the capture is more than `STALE_CAPTURE_DAYS` (7)
  days old when reviewed.
- `gsc-not-ready` (`SEVERITY['gsc-not-ready']`): one per report Search Console has no data for yet.
- `gsc-property-mismatch` (`SEVERITY['gsc-property-mismatch']`): the capture is for another
  property. Also a browser STOP.

### 1. Property inventory

- **Where**: the property picker in the header; the About row on `settings` reads
  `Property added to account` with a date, which fills `property_added`.
- **Healthy**: the picker shows the Domain property `sc-domain:sapphireshadowstudio.com`. The
  picker's listbox rendered empty in the accessibility tree, so record the value only; never try
  to enumerate other properties.
- **Failure**: a URL-prefix property is selected, which splits data with the Domain property.
- **Checks**: `property-url-prefix` (`SEVERITY['property-url-prefix']`).
- **Fix owner**: operator decision (use the Domain property; a URL-prefix property is redundant).
- **Marker**: capture: settings

### 2. Second brand domain

- **Where**: URL inspection of the homepage (the header combobox) lists a referring page on a
  second brand domain, a `.us` host; `review.mjs` probes that host with one unfollowed node request.
- **Healthy**: the probe answers 301 or 308 to the canonical host, so no separate property is
  needed. Record the host in `settings.secondary_domains`.
- **Failure**: the host answers 200 (a duplicate site) or redirects somewhere else.
- **Checks**: `secondary-domain-redirect` (`SEVERITY['secondary-domain-redirect']`; informational
  when the redirect is permanent and to the canonical host; skipped with `--offline`).
- **Fix owner**: DNS and the domain settings in Shopify Admin.
- **Marker**: capture: settings

### 3. Ownership verification

- **Where**: `Settings` > `Ownership verification`, view `ownership`.
- **Healthy**: "You are a verified owner"; "Verification methods used" names "Domain name provider".
- **Failure**: not verified; or verified only by an HTML tag or file, which a theme deploy can
  remove.
- **Checks**: `verification-lost` (`SEVERITY['verification-lost']`),
  `verification-method-fragile` (`SEVERITY['verification-method-fragile']`).
- **Fix owner**: DNS (re-verify by domain name provider).
- **Marker**: capture: settings

### 4. Users and permissions

- **Where**: `Settings` > `Users and permissions`, view `users`; the `users/permission-history`
  link (ownership history) and the `users/leftover-tokens` link (unused ownership tokens).
- **Healthy**: "Users (N)" matches the people the operator expects; every owner verified; "Unused
  ownership tokens (0)". Counts and roles only: never record a name or an email address.
- **Failure**: more users than owners plus one; unused ownership tokens left behind.
- **Checks**: `owner-single` (`SEVERITY['owner-single']`), `users-unexpected`
  (`SEVERITY['users-unexpected']`), `ownership-tokens-unused` (`SEVERITY['ownership-tokens-unused']`).
- **Fix owner**: GSC UI (operator removes users or tokens by hand).
- **Marker**: capture: settings

### 5. Associations

- **Where**: `Settings` > `Associations`, view `settings/associations`.
- **Healthy**: "Associated services" lists Google Analytics and Merchant Center; "Pending requests"
  is empty. Absent services are informational: the GA4 and Merchant Center items in `TODO.md`
  own that work.
- **Failure**: a pending request nobody started.
- **Checks**: `association-missing` (`SEVERITY['association-missing']`), `association-pending`
  (`SEVERITY['association-pending']`).
- **Fix owner**: operator decision, then GSC UI.
- **Marker**: capture: associations

### 6. Change of address

- **Where**: `Settings` > `Change of address`, view `settings/change-address`.
- **Healthy**: the picker reads "Select new site" and `VALIDATE & UPDATE` is disabled.
- **Failure**: a new site is selected; Google is being told the store moved.
- **Checks**: `change-of-address-set` (`SEVERITY['change-of-address-set']`).
- **Fix owner**: GSC UI (operator cancels the move).
- **Marker**: capture: settings

### 7. Bulk data export

- **Where**: `Settings` > `Bulk data export`, view `settings/bulk-data-export`.
- **Healthy**: unconfigured; it needs a Cloud project, which the operator declined.
- **Failure**: configured, which means a Cloud project exists that nobody recorded.
- **Checks**: `bulk-export-configured` (`SEVERITY['bulk-export-configured']`).
- **Fix owner**: operator decision.
- **Marker**: capture: settings

### 8. Search generative AI

- **Where**: `Settings` > `Search generative AI` (the AI controls section), view
  `settings/search-gen-ai`.
- **Healthy**: "Include", the default.
- **Failure**: "Exclude", which removes the store from AI Overviews and AI Mode traffic.
- **Checks**: `ai-control-exclude` (`SEVERITY['ai-control-exclude']`).
- **Fix owner**: operator decision, then GSC UI.
- **Marker**: capture: settings

### 9. robots.txt report

- **Where**: the Crawling section of `settings`, row `robots.txt`.
- **Healthy**: the report lists the file Search Console last fetched, with a fetched status.
- **Failure**: "No robots.txt file" once the property is older than `ROBOTS_GRACE_DAYS` (7) days
  (informational before that; day one showed it with OPEN REPORT disabled); a fetch error.
- **Checks**: `robots-not-seen` (`SEVERITY['robots-not-seen']`, age-gated), `robots-fetch-error`
  (`SEVERITY['robots-fetch-error']`).
- **Fix owner**: Shopify Admin (robots.txt is platform-served; `templates/robots.txt.liquid` in the
  repo when customised).
- **Marker**: capture: crawl-stats

### 10. Crawl stats

- **Where**: the Crawling section of `settings`, row `Crawl stats`.
- **Healthy**: host status with no issues; 5xx share at or under `CRAWL_5XX_SHARE` (0.01); the
  "Other client error (4xx)" bucket, where 429s land because Search Console does not break them
  out, at or under `CRAWL_4XX_SHARE` (0.05). "No data available yet" is host status no-data inside an
  ok report, so the robots.txt state from surface 9 is kept.
- **Failure**: host issues; a 5xx or 4xx share over its threshold (a bot-management block shows up
  here as 4xx).
- **Checks**: `crawl-host-issues` (`SEVERITY['crawl-host-issues']`), `crawl-5xx-share`
  (`SEVERITY['crawl-5xx-share']`), `crawl-4xx-share` (`SEVERITY['crawl-4xx-share']`).
- **Fix owner**: Shopify Admin or support (platform hosting); the operator for bot-management
  settings.
- **Marker**: capture: crawl-stats

### 11. Removals

- **Where**: `Removals`, view `removals`; tabs `TEMPORARY REMOVALS`, `OUTDATED CONTENT`,
  `SAFESEARCH FILTERING`.
- **Healthy**: "No requests submitted in the last 6 months" on every tab.
- **Failure**: an active temporary removal, worst for a URL still in the live sitemap; any
  outdated-content or SafeSearch entry.
- **Checks**: `removal-active` (`SEVERITY['removal-active']`; lower when the URL is not in the
  live sitemap or was not captured), `removal-other-active` (`SEVERITY['removal-other-active']`).
- **Fix owner**: GSC UI (operator cancels the request).
- **Marker**: capture: removals

### 12. Email preferences

- **Where**: `User settings` in the header, view `user-settings`, rows `Email preferences` and
  `Search Console in Search results`; the sub-pages `user-settings/email-preferences` and
  `user-settings/performance-on-search` (the second is not judged; it was first seen on 2026-09-13).
- **Healthy**: "All emails are enabled"; the "Enable notification by email" checkbox is on.
- **Failure**: notifications off, so a manual action or a coverage drop would arrive unseen.
- **Checks**: `email-notifications-off` (`SEVERITY['email-notifications-off']`).
- **Fix owner**: GSC UI.
- **Marker**: capture: settings

### 13. Messages

- **Where**: the Messages bell in the header ("Unread messages: N").
- **Healthy**: nothing unread. Record the unread count, the total and each subject (120 characters
  each); open no message.
- **Failure**: unread messages, which may be a manual action or a coverage alert.
- **Checks**: `messages-unread` (`SEVERITY['messages-unread']`).
- **Fix owner**: operator reads them.
- **Marker**: capture: messages

### 14. Sitemaps

- **Where**: `Sitemaps`, view `sitemaps`.
- **Healthy**: "Submitted sitemaps" lists `https://sapphireshadowstudio.com/sitemap.xml` once, Type
  "Sitemap index", Status "Success", Discovered pages within `SITEMAP_TOLERANCE` (1) of the live
  sitemap count, Last read within `SITEMAP_STALE_READ_DAYS` (14) days.
- **Failure**: no index row; "Couldn't fetch" or "Has errors"; a child `sitemap_*_N.xml`
  submitted on its own (noise: the index already lists it); a discovered count far from live.
- **Checks**: `sitemap-missing` (`SEVERITY['sitemap-missing']`), `sitemap-error`
  (`SEVERITY['sitemap-error']`), `sitemap-pending` (`SEVERITY['sitemap-pending']`),
  `sitemap-child-submitted` (`SEVERITY['sitemap-child-submitted']`), `sitemap-discovered-mismatch`
  (`SEVERITY['sitemap-discovered-mismatch']`), `sitemap-stale-read` (`SEVERITY['sitemap-stale-read']`),
  `sitemap-live-unreachable` (`SEVERITY['sitemap-live-unreachable']`).
- **Fix owner**: GSC UI for submissions; Shopify generates the sitemap itself.
- **Marker**: capture: sitemaps

### 15. Page indexing

- **Where**: `Indexing` > `Pages`, view `index`.
- **Healthy**: indexed count at or above the live sitemap count less its `NOINDEX_OK` paths; every
  "Why pages aren't indexed" row is expected (the noindexed blog listing, redirects). Record each
  reason with its count, its Source column (Website or Google systems) and up to five example URLs,
  query strings and fragments stripped, token-shaped and customer URLs dropped.
- **Failure**: indexed well below the sitemap; any noindex outside `NOINDEX_OK`; server errors;
  a Google-chosen canonical that overrides the declared one; a reason label never seen before.
- **Checks**: `index-count-below-sitemap` (`SEVERITY['index-count-below-sitemap']`; lower while
  performance has no impressions), `index-reason-crawled-not-indexed`
  (`REASON_SEVERITY['crawled-not-indexed']`), `index-reason-discovered-not-indexed`
  (`REASON_SEVERITY['discovered-not-indexed']`), `index-reason-alternate-canonical`
  (`REASON_SEVERITY['alternate-canonical']`), `index-reason-duplicate-no-canonical`
  (`REASON_SEVERITY['duplicate-no-canonical']`), `index-reason-duplicate-google-chose-different`
  (`REASON_SEVERITY['duplicate-google-chose-different']`), `index-reason-noindex`
  (`REASON_SEVERITY['noindex']`; lower for an unverified remainder when every example is in
  `NOINDEX_OK`), `index-reason-not-found` (`REASON_SEVERITY['not-found']`; lower when the URL is not
  in the live sitemap), `index-reason-redirect` (`REASON_SEVERITY['redirect']`),
  `index-reason-soft-404` (`REASON_SEVERITY['soft-404']`), `index-reason-blocked-robots`
  (`REASON_SEVERITY['blocked-robots']`), `index-reason-server-error`
  (`REASON_SEVERITY['server-error']`), `index-reason-forbidden` (`REASON_SEVERITY['forbidden']`),
  `index-reason-other-4xx` (`REASON_SEVERITY['other-4xx']`), `index-reason-unknown`
  (`SEVERITY['index-reason-unknown']`).
- **Fix owner**: repo (`snippets/meta-tags.liquid` for robots and canonicals; the collection
  runbook for clustering); Shopify Admin for redirects and unpublished products.
- **Marker**: capture: indexing-pages

### 16. URL inspection spot-checks

- **Where**: the header combobox "Inspect any URL in ..." (`URL inspection` in the left navigation
  only focuses it). There is no stable direct URL for a result.
- **Healthy**: the homepage, `/products/lead-ii-vest-womens`, one collection and `/blogs/shift-notes`,
  at most eight URLs per run. "URL is on Google"; user-declared and Google-selected canonicals
  match; last crawl within `STALE_CRAWL_DAYS` (30) days; crawl and indexing allowed; page fetch
  successful; discovered via Sitemaps; the "Enhancements & Experience" rows list the rich results
  `EXPECTED_RICH_RESULTS` expects for the path (products: Product snippets or Merchant listings, and
  Breadcrumbs; collections: Breadcrumbs; homepage and blog: none).
- **Failure**: not on Google (the noindexed blog listing excepted); a canonical mismatch; crawl or
  indexing blocked on a sitemap URL; a failed fetch; an expected rich result missing; a panel
  section never seen before.
- **Checks**: `inspect-not-indexed` (`SEVERITY['inspect-not-indexed']`), `inspect-canonical-mismatch`
  (`SEVERITY['inspect-canonical-mismatch']`), `inspect-stale-crawl` (`SEVERITY['inspect-stale-crawl']`),
  `inspect-crawl-blocked` (`SEVERITY['inspect-crawl-blocked']`), `inspect-fetch-failed`
  (`SEVERITY['inspect-fetch-failed']`), `inspect-rich-result-missing`
  (`SEVERITY['inspect-rich-result-missing']`), `inspect-section-unknown`
  (`SEVERITY['inspect-section-unknown']`).
- **Fix owner**: repo (`snippets/meta-tags.liquid`, `snippets/structured-data*.liquid`); Shopify
  Admin for product and collection state.
- **Marker**: capture: inspections

### 17. Core Web Vitals

- **Where**: `Experience` > `Core Web Vitals`, view `core-web-vitals`.
- **Healthy**: per device (Mobile, Desktop), every URL good. "Not enough usage data in the last 90
  days for this device type." is expected for months on a small site; record it as that device's
  no-data value inside an ok report, not as a not-ready report.
- **Failure**: poor URLs (mobile first: most traffic is phones); URLs needing improvement.
- **Checks**: `cwv-poor` (`SEVERITY['cwv-poor']`), `cwv-needs-improvement`
  (`SEVERITY['cwv-needs-improvement']`), `cwv-no-data` (`SEVERITY['cwv-no-data']`).
- **Fix owner**: repo (theme assets and sections); the "Try PageSpeed Insights" links leave Search
  Console and are never followed.
- **Marker**: capture: cwv

### 18. HTTPS

- **Where**: `Experience` > `HTTPS`, present in the left navigation only once data exists (absent
  on 2026-09-13; its view path is not yet observed).
- **Healthy**: every URL served over HTTPS. Absent is `not-present`.
- **Failure**: any non-HTTPS URL.
- **Checks**: `https-non-https` (`SEVERITY['https-non-https']`), `https-no-data`
  (`SEVERITY['https-no-data']`).
- **Fix owner**: Shopify Admin (domains and SSL).
- **Marker**: capture: https

### 19. Enhancements

- **Where**: the `Enhancements` section of the left navigation, present only once a rich-result
  type is detected (absent on 2026-09-13).
- **Healthy**: per type (Product snippets, Merchant listings, Breadcrumbs, and any other), zero
  invalid and zero warning items. This is the evidence source for the Judge.me Product JSON-LD
  owner decision in `TODO.md`: when both Product snippets and Merchant listings report items,
  record which Product node each reads.
- **Failure**: invalid or warning items; once the section exists, Product snippets or Breadcrumbs
  absent while a product URL inspects as indexed; a type never seen before. While the section is
  absent the report is `not-present` and nothing is judged: an inspection lists rich results days
  before the section appears.
- **Checks**: `enhancement-invalid` (`SEVERITY['enhancement-invalid']`), `enhancement-warning`
  (`SEVERITY['enhancement-warning']`), `enhancement-absent` (`SEVERITY['enhancement-absent']`),
  `enhancement-product-duplicate-evidence` (`SEVERITY['enhancement-product-duplicate-evidence']`),
  `enhancement-type-unknown` (`SEVERITY['enhancement-type-unknown']`).
- **Fix owner**: repo (`snippets/structured-data*.liquid`, read `docs/structured-data.md` first);
  operator decision for the Judge.me owner question.
- **Marker**: capture: enhancements

### 20. Security issues and Manual actions

- **Where**: `Security & Manual Actions` (collapsed by default) > `Manual actions`, view
  `manual-actions`, and `Security issues`, view `security-issues`.
- **Healthy**: "No issues detected" on both.
- **Failure**: anything else.
- **Checks**: `manual-action` (`SEVERITY['manual-action']`), `security-issue`
  (`SEVERITY['security-issue']`).
- **Fix owner**: operator decision, immediately.
- **Marker**: capture: security-manual

### 21. Links

- **Where**: `Links`, view `links`.
- **Healthy**: top linking sites, top linked pages and top internally linked pages are populated.
  "Processing data" is `not-ready`.
- **Failure**: no external linking sites once processed.
- **Checks**: `links-none` (`SEVERITY['links-none']`).
- **Fix owner**: operator decision (outreach, blog distribution; see `insights.md`).
- **Marker**: capture: links

### 22. Performance

- **Where**: `Performance`, view `performance/search-analytics` opened with `num_of_days=28`.
- **Healthy**: per `insights.md`: impressions growing, non-brand queries present, indexable
  sitemap pages appearing in the PAGES tab, click-through normal for position.
- **Failure**: zero impressions on an established property; brand-only queries after
  `BRAND_ONLY_MIN_AGE_DAYS` (60) days; low click-through at a good position; indexable pages with no
  impressions; a search type never seen before.
- **Checks**: `perf-zero-impressions` (`SEVERITY['perf-zero-impressions']`), `perf-brand-only`
  (`SEVERITY['perf-brand-only']`, age-gated), `perf-page-no-impressions`
  (`SEVERITY['perf-page-no-impressions']`, age-gated), `perf-low-ctr` (`SEVERITY['perf-low-ctr']`),
  `perf-position-opportunity` (`SEVERITY['perf-position-opportunity']`), `perf-country-outside-us`
  (`SEVERITY['perf-country-outside-us']`), `search-type-new` (`SEVERITY['search-type-new']`),
  `period-mismatch` (`SEVERITY['period-mismatch']`).
- **Fix owner**: Shopify Admin (titles and descriptions); repo (`snippets/meta-tags.liquid`
  fallbacks, `marketing/articles/`).
- **Marker**: capture: performance

### 23. Insights page and Achievements

- **Where**: `Insights`, view `performance/insights`, and `Achievements`, view `achievements`.
- **Healthy**: read for context only. Day one: "No clicks for this time period" and "It takes
  about a month to process your initial data."
- **Failure**: none judged here; the Performance report is the record.
- **Checks**: none of their own; both are covered by the discovery inventory.
- **Fix owner**: none.
- **Marker**: capture: none

### 24. Discovery inventory

- **Where**: every page visited, before leaving it; the left navigation starts at `Overview`.
- **Healthy**: every navigation label and view path, `Settings` row, user settings row, Performance
  tab and control, Removals tab, inspection section, enhancement type and reason label is already
  in `KNOWN_SURFACES`.
- **Failure**: none; an unknown item is information, routed per `SKILL.md` > Self-discovery.
- **Checks**: `surface-new` (`SEVERITY['surface-new']`), `surface-gone` (`SEVERITY['surface-gone']`),
  `discovery-review-due` (`SEVERITY['discovery-review-due']`, once `KNOWN_SURFACES_REVIEWED_ON` is
  more than `DISCOVERY_REVIEW_DAYS` (90) days old).
- **Fix owner**: repo (a reviewed PR extending `KNOWN_SURFACES`, this file and a fixture).
- **Marker**: capture: discovery
