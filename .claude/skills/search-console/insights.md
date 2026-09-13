# Reading a capture into insights

`review.mjs` findings say what is true of the capture. This file turns them, and the numbers
behind them, into proposals the operator can act on. Every insight is a proposal: fixes go through
the Admin gates or the PR flow, never through this skill.

## The proposal template

Every insight uses these five parts, in this order:

1. **Observation**: the numbers, from the capture, with the period and whether the tab was
   truncated.
2. **Hypothesis**: one hedged sentence ("these pages show this pattern, which may mean ...").
3. **Proposal**: what to change.
4. **Where the fix lives**: Admin path, repo file, or the skill that owns the surface.
5. **Who applies it**: the operator by hand, or a PR.

## Recipes

**Brand vs non-brand.** Split the QUERIES tab with `BRAND_TERMS`. When every captured query is a
brand query on a property older than `BRAND_ONLY_MIN_AGE_DAYS` (60) days, `perf-brand-only` fires
and the likely gap is positioning: Google does not yet associate the store with nurse, medic and
EMS apparel searches. Propose homepage title and description work (Admin > Online Store >
Preferences, and the fallbacks in `snippets/meta-tags.liquid`). Below that age it is expected.

**Low click-through at a good position.** A page with at least `CTR_MIN_IMPRESSIONS` (100)
impressions, click-through under `CTR_MIN` (0.02), and an average position at or better than
`CTR_MAX_POSITION` (10) is `perf-low-ctr`. Propose a title and description rewrite for that page;
read its stored Admin SEO fields first with `seo-review`'s admin mode, because the storefront hides
blanks behind render-time fallbacks.

**Near the top.** A page averaging a position inside `OPPORTUNITY_POSITIONS` ([4, 15]) with at
least `OPPORTUNITY_MIN_IMPRESSIONS` (20) impressions is `perf-position-opportunity`. Propose
on-page copy for the page, or a blog topic that targets the same need (`marketing/articles/`, the
`articles` skill). Describe the class of query the page ranks for; never quote the queries.

**Sitemap pages with no impressions.** `perf-page-no-impressions` lists indexable sitemap URLs
absent from an untruncated PAGES tab; informational before `PAGE_NO_IMPRESSIONS_MIN_AGE_DAYS` (28)
days. Propose internal links, collection membership, or a blog mention for those pages. Check the
Page indexing reasons for the same URL first: a page Google has not indexed cannot earn impressions.

**Devices and countries.** When mobile carries most impressions, Core Web Vitals work is mobile
first (`cwv-poor` on mobile outranks desktop). When more than `COUNTRY_OUTSIDE_US_SHARE` (0.1) of
impressions come from outside the US, `perf-country-outside-us` fires: the storefront says US-only
shipping, so propose checking that the shipping copy is visible early, rather than chasing those
visitors.

**The Judge.me Product JSON-LD decision.** `enhancement-product-duplicate-evidence` means Product
snippets and Merchant listings both report items. Record which Product node Google reads for a
reviewed product (the item details in each Enhancements report, and the inspection's rich-result
rows) and whether the theme's node and the app's node disagree on price, availability or rating.
That is the evidence the `TODO-list.md` decision item waits on; the decision itself is the operator's.

**Links.** Once `links-none` stops firing, propose outreach and blog distribution around the pages
that already earn links. The second brand domain appearing as a referrer is the redirect working,
not a link to chase (`secondary-domain-redirect`).

**Nothing yet.** `perf-zero-impressions` on a young property is expected. Say so and stop.

## Language rules

- Every insight is a hypothesis, never a causal claim. "These pages show this pattern; consider
  this", not "this caused that".
- Name what makes attribution unreliable: a theme deploy in the period, a new blog post, the
  property's age, a Google update window.
- Below `NOISE_FLOOR_IMPRESSIONS` (50) total impressions, write "too little data" and stop. Do not
  compute shares or trends from single digits.
- When a tab was truncated, conclusions are "top N as captured", never absolute.
- Compare periods only when `review.mjs` compared them; `period-mismatch` means the pair is not
  comparable.
- Never quote a search query into a repo file, PR body, commit message, `TODO-list.md` entry or release
  note. Queries are visitor-typed text. Describe the class ("a sizing question about the vest").
- Every insight ends with where the fix lives and who applies it. Nothing here authorizes a change.
