// The check registry: every check id the site-check skill can report, with its tier, surface,
// default severity and one-line description. This is the contract every lane builds against:
// a finding whose `check` is not registered is refused by makeFinding, surfaces.md is generated
// from it, and the operator run file renders its Tier C entries.
//
// Per-tier files under ./registry/ keep lanes on disjoint files. Add a check to the tier's file;
// never to this aggregator.

import { A1_CHECKS } from './registry/a1.mjs';
import { A2_CHECKS } from './registry/a2.mjs';
import { A3_CHECKS } from './registry/a3.mjs';
import { A4_CHECKS } from './registry/a4.mjs';
import { B_CHECKS } from './registry/b.mjs';
import { C_CHECKS } from './registry/c.mjs';

export const ERROR = 'ERROR';
export const WARN = 'WARN';
export const INFO = 'INFO';
export const SKIPPED = 'SKIPPED';
export const GATE = 'GATE';
export const SEVERITIES = [ERROR, WARN, INFO, SKIPPED, GATE];

/** Tiers in report order, with the side effects SKILL.md's mode table repeats. */
export const TIERS = [
  { id: 'A3', label: 'Repo consistency', script: 'consistency.mjs', sideEffects: 'none' },
  { id: 'A4', label: 'Existing tools', script: '(seo-review, smoke dry-run, contrast, theme check)', sideEffects: 'none on the store; seo-review runs with --no-save' },
  { id: 'A1', label: 'Storefront probe', script: 'probe.mjs', sideEffects: 'session-scoped cart writes only, cleared in finally; no orders, no Admin writes' },
  { id: 'A2', label: 'Admin config reads', script: 'config.mjs', sideEffects: 'none (read-only client guard)' },
  { id: 'B', label: 'Browser', script: '(chrome-devtools MCP, opt-in)', sideEffects: 'browser session; checkout-reach creates an abandoned checkout in Admin and may send recovery mail' },
  { id: 'C', label: 'Operator checklist', script: '(run file)', sideEffects: 'real (test-mode) orders, inventory movement, notifications' },
];

/** Surface ids: the argument grammar's `<surface-id>` token must be one of these. */
export const SURFACES = [
  { id: 'storefront-render', label: 'Storefront render' },
  { id: 'json-endpoints', label: 'Storefront JSON endpoints' },
  { id: 'cart', label: 'Cart (Ajax and page)' },
  { id: 'shipping', label: 'Shipping rates and copy' },
  { id: 'product-page', label: 'Product page widgets' },
  { id: 'header', label: 'Header and announcement bar' },
  { id: 'navigation', label: 'Navigation menus' },
  { id: 'search', label: 'Search' },
  { id: 'checkout', label: 'Checkout' },
  { id: 'policies', label: 'Shop policies' },
  { id: 'faq', label: 'FAQ page' },
  { id: 'vacation', label: 'Vacation mode' },
  { id: 'catalogue', label: 'Catalogue and templates' },
  { id: 'templates', label: 'Template settings' },
  { id: 'locales', label: 'Locales' },
  { id: 'social', label: 'Social links' },
  { id: 'tooling', label: 'Existing tooling' },
  { id: 'admin-config', label: 'Admin configuration (readable)' },
  { id: 'products-admin', label: 'Products as stored in Admin' },
  { id: 'orders', label: 'Test orders' },
  { id: 'lifecycle', label: 'Post-order lifecycle' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'forms', label: 'Forms behind hCaptcha' },
  { id: 'accounts', label: 'Customer accounts' },
  { id: 'flow', label: 'Flow automations' },
  { id: 'admin-settings', label: 'Admin-only settings' },
  { id: 'devices', label: 'Physical devices' },
  { id: 'launch', label: 'Launch verification' },
];

export const CHECKS = Object.freeze([
  ...A1_CHECKS, ...A2_CHECKS, ...A3_CHECKS, ...A4_CHECKS, ...B_CHECKS, ...C_CHECKS,
]);

const byId = new Map(CHECKS.map((c) => [c.id, c]));
const tierIds = new Set(TIERS.map((t) => t.id));
const surfaceIds = new Set(SURFACES.map((s) => s.id));

export const ID_RE = /^[a-z0-9-]+$/;

/** @param {string} id @returns {object|undefined} */
export function checkById(id) { return byId.get(id); }

/** @param {string} id */
export function isSurfaceId(id) { return surfaceIds.has(id); }

/** @param {string} tier @returns {object[]} */
export function checksForTier(tier) { return CHECKS.filter((c) => c.tier === tier); }

/** @param {string} surface @returns {object[]} */
export function checksForSurface(surface) { return CHECKS.filter((c) => c.surface === surface); }

/** Tier of a check id, or null when unregistered (the differ uses it for tier-wide skips). */
export function tierOf(id) { const c = byId.get(id); return c ? c.tier : null; }

/**
 * Structural validation of the registry itself; the contract test calls it and fails on the
 * first problem. Returns the list of problems so the test names them all.
 * @returns {string[]}
 */
export function registryProblems() {
  const problems = [];
  const seen = new Set();
  for (const c of CHECKS) {
    if (!ID_RE.test(c.id)) problems.push(`id ${JSON.stringify(c.id)} is not kebab-case`);
    if (seen.has(c.id)) problems.push(`duplicate id ${c.id}`);
    seen.add(c.id);
    if (!tierIds.has(c.tier)) problems.push(`${c.id}: unknown tier ${c.tier}`);
    if (!surfaceIds.has(c.surface)) problems.push(`${c.id}: unknown surface ${c.surface}`);
    if (!SEVERITIES.includes(c.severity)) problems.push(`${c.id}: unknown severity ${c.severity}`);
    if (!c.description || /\u2014/.test(c.description)) problems.push(`${c.id}: missing description or em dash`);
    if (c.tier === 'C' && !c.group) problems.push(`${c.id}: Tier C check without a group`);
  }
  for (const s of SURFACES) {
    if (!CHECKS.some((c) => c.surface === s.id)) problems.push(`surface ${s.id} has no checks`);
  }
  return problems;
}
