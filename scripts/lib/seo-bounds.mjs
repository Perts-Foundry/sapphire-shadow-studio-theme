// The length bounds for a stored SEO title and description.
//
// WHY IT IS A LEAF. These are search-engine display limits, not a property of any one subsystem.
// `scripts/seo-review/` checks them against what the live storefront renders and against the values
// stored in Admin; `scripts/articles/` checks them against the values an article declares in the
// repo, before they are ever sent. Two subsystems asking the same question of the same field have
// to agree, or an article passes its own checker and is then reported by the SEO review as too
// long, which is a contradiction a reviewer has to resolve by hand every time.
//
// They lived in scripts/seo-review/lib/checks.mjs, which is a module of storefront crawl rules.
// Importing them from there would make the offline articles checker depend on the crawler.
//
// This file imports nothing at all, and must stay that way.
//
// The numbers are the conventional display limits, not Shopify's field maxima: Shopify accepts far
// longer values and simply lets search engines truncate them. Changing one is a judgement about
// what a result looks like in a SERP, so it is made once, here.

/** Longer than this and the title is truncated in a search result. */
export const TITLE_MAX = 60;

/** Shorter than this and the description is too thin to be useful. */
export const DESC_MIN = 50;

/** Longer than this and the description is truncated in a search result. */
export const DESC_MAX = 160;
