// known-surfaces.mjs -- the Search Console vocabulary this skill has already met.
//
// WHY THIS IS DATA IN CODE. Search Console changes under the skill: reports appear (Insights,
// Achievements), settings appear (the AI control), enhancement sections exist only once a rich
// result is detected, and reason labels come and go. Every run inventories what it sees and the
// discovery checks compare that inventory to this file, so a new item surfaces as a finding the
// first time it is seen instead of being silently skipped. The skill never edits this file during
// a run; a new item lands through a reviewed PR that also adds its audit.md entry and a fixture,
// and the contract test refuses one without the other.
//
// Seeded from a live walk of the property on 2026-09-13. `conditional: true` marks an item that is
// present only once data exists, so its absence is not reported as `surface-gone`.

import { KNOWN_REASONS, ENHANCEMENT_TYPES, INSPECTION_SECTIONS } from './schema.mjs';

/** The day this vocabulary was last reviewed against the live product (see discovery-review-due). */
export const KNOWN_SURFACES_REVIEWED_ON = '2026-09-13';

export const KNOWN_SURFACES = Object.freeze({
  // Left navigation: links carry their view path; buttons and section headings carry null.
  nav: Object.freeze([
    { label: 'Overview', path: '' },
    { label: 'Insights', path: 'performance/insights' },
    { label: 'Performance', path: 'performance/search-analytics' },
    { label: 'URL inspection', path: null },
    { label: 'Indexing', path: null },
    { label: 'Pages', path: 'index' },
    { label: 'Sitemaps', path: 'sitemaps' },
    { label: 'Removals', path: 'removals' },
    { label: 'Experience', path: null },
    { label: 'Core Web Vitals', path: 'core-web-vitals' },
    { label: 'HTTPS', path: null, conditional: true },
    { label: 'Enhancements', path: null, conditional: true },
    { label: 'Security & Manual Actions', path: null },
    { label: 'Manual actions', path: 'manual-actions' },
    { label: 'Security issues', path: 'security-issues' },
    { label: 'Links', path: 'links' },
    { label: 'Achievements', path: 'achievements' },
    { label: 'Settings', path: 'settings' },
  ].map((entry) => Object.freeze(entry))),

  // Pages reached from Settings or the user menu, not from the left navigation.
  subpages: Object.freeze([
    'ownership', 'users', 'users/permission-history', 'users/leftover-tokens', 'settings/associations',
    'settings/change-address', 'settings/bulk-data-export', 'settings/search-gen-ai', 'user-settings',
    'user-settings/email-preferences',
  ]),

  settings_rows: Object.freeze([
    'Ownership verification', 'Users and permissions', 'Associations', 'Change of address',
    'Bulk data export', 'Search generative AI', 'robots.txt', 'Crawl stats', 'Property added to account',
  ]),
  user_settings_rows: Object.freeze(['Email preferences', 'Search Console in Search results']),
  performance_tabs: Object.freeze(['QUERIES', 'PAGES', 'COUNTRIES', 'DEVICES', 'SEARCH APPEARANCE', 'DAYS']),
  performance_controls: Object.freeze([
    'EXPORT', 'Search type', 'Add filter', 'Customize your Performance report using AI', 'More time ranges',
  ]),
  time_ranges: Object.freeze(['24 hours', '7 days', '28 days', '3 months']),
  search_types: Object.freeze(['Web', 'Image', 'Video', 'News']),
  removals_tabs: Object.freeze(['TEMPORARY REMOVALS', 'OUTDATED CONTENT', 'SAFESEARCH FILTERING']),
  inspection_sections: INSPECTION_SECTIONS,
  enhancement_types: ENHANCEMENT_TYPES,
  reasons: KNOWN_REASONS,
});

/** Case- and spacing-insensitive comparison form of a label. */
export function labelKey(label) {
  return String(label).toLowerCase().replace(/\s+/g, ' ').trim();
}
