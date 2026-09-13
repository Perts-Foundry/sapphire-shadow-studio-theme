// Shopify Files helpers shared by the repo's upload tools. Pure: no fs, no fetch, no process.env.
//
// ONE DEFINITION ON PURPOSE. The email-icon uploader and the article image uploader each carried
// their own copy of the duplicate matcher, and the two had already diverged: one built a RegExp from
// the filename without escaping it, the other compared the suffix by hand. A duplicate guard that
// behaves differently per tool is a guard nobody can reason about, so both import this one.

import path from 'node:path';

/**
 * Whether a CDN URL is the file named `filename`. Shopify keeps the uploaded filename in the URL
 * path, adds a `?v=` cache buster, and on a name collision appends `_1`, `_2` and so on, so the
 * comparison is on the URL's basename stem and tolerates exactly that suffix. Files search is not an
 * exact match (a query for `x-a.jpg` also returns `x-a-old.jpg`), which is why every caller filters
 * the search results through this rather than trusting them.
 *
 * @param {string | undefined | null} url
 * @param {string} filename
 * @returns {boolean}
 */
export function matchesFilename(url, filename) {
  if (typeof url !== 'string' || url === '') return false;
  let stem;
  try {
    stem = path.parse(path.basename(new URL(url).pathname)).name;
  } catch {
    return false;
  }
  const wanted = path.parse(filename).name;
  if (stem === wanted) return true;
  const suffix = stem.startsWith(`${wanted}_`) ? stem.slice(wanted.length + 1) : '';
  return /^\d+$/.test(suffix);
}
