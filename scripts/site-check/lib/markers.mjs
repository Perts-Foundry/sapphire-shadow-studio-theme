// Stable body markers per probed path, for the storefront render pass (Tier A1).
//
// A marker is a short literal that the theme emits from committed code on a 200 render and that
// no Admin edit can remove: an element id, an input name derived from a committed setting, a
// custom element tag. Never body prose (Admin-authored, locale-dependent) and never a CSS class a
// refactor may rename without anyone noticing the probe went blind. Findings carry the marker NAME
// only, never body text (render.mjs enforces that; this table just declares the names).
//
// Keyed three ways, resolved in this order by markerRuleFor:
//   1. by scripts/a11y/paths.json `template` (the unit a theme change alters),
//   2. by path prefix, for the template:null policy paths Shopify renders itself,
//   3. by server-timing pageType, for sitemap products outside paths.json (--full).
// An entry with no stable marker says so explicitly ({ noMarker: true, why }) so the completeness
// test can tell "nothing to assert" from "someone forgot"; a path that resolves to nothing at all
// is a test failure, not a silent skip.
//
// Pure: no fetch, no fs, no env.

/** Every garment template renders the size-chart accordion row and the final-sale checkbox. */
const SIZE_CHART_ANCHOR = 'id="SizeChart"';
// The return-policy block's property label is a per-block setting whose default is the schema
// locale string; the input name is `properties[<label>]` verbatim (the checkbox snippet does not
// escape the name), so the `&` in the garment label is the one unstable byte and the marker stops
// short of it. The gift card template overrides the label.
const GARMENT_ACK_INPUT = 'name="properties[Customer confirm size guide';
const GIFT_CARD_ACK_INPUT = 'name="properties[Customer confirm final sale]"';
const APPLIQUE_INPUT = 'name="properties[Applique Pattern]"';

const GARMENT_MARKERS = [SIZE_CHART_ANCHOR, GARMENT_ACK_INPUT];

export const MARKER_TABLE = Object.freeze({
  byTemplate: {
    // The homepage h1 is the hero lockup (CLAUDE.md, Accessibility); the class is authored in
    // templates/index.json, so it is committed markup, not theme-editor prose.
    'templates/index.json': { markers: ['hero-lockup'] },
    'templates/list-collections.json': { noMarker: true, why: 'generic listing; nothing committed beyond the section shell' },
    'templates/collection.json': { noMarker: true, why: 'product grid content is Admin data; the h1 rule covers the page' },
    'templates/product.huddle-crewneck.json': { markers: [...GARMENT_MARKERS, APPLIQUE_INPUT] },
    'templates/product.lead-ii-crewneck.json': { markers: GARMENT_MARKERS },
    'templates/product.lead-ii-quarter-zip.json': { markers: GARMENT_MARKERS },
    'templates/product.lead-ii-vest-womens.json': { markers: GARMENT_MARKERS },
    // Shift Fuel carries no return-policy block (documented in lib/repo-checks.mjs's rule table),
    // so only the size-chart row is a stable marker there.
    'templates/product.shift-fuel-crewneck.json': { markers: [SIZE_CHART_ANCHOR] },
    'templates/product.gift-card.json': { markers: [GIFT_CARD_ACK_INPUT] },
    // The render pass sees an EMPTY cart, and sections/main-cart.liquid renders the summary
    // (and with it snippets/shipping-info.liquid) only inside `unless cart.empty?`. The page
    // shell class is what an empty render always carries; the shipping sentence is asserted by
    // the cart flow (lib/cart.mjs), which renders /cart with lines in it.
    'templates/cart.json': { markers: ['cart-page'] },
    'templates/search.json': { noMarker: true, why: 'results are Admin data; the h1 rule covers the page' },
    'templates/page.about.json': { noMarker: true, why: 'composed from generic primitives; body copy is editor prose' },
    // The vacation deep link target (CLAUDE.md, Theme settings): the FAQ item keeps
    // custom_anchor "away-from-studio" or every announcement / popup link breaks.
    'templates/page.faq.json': { markers: ['away-from-studio'] },
    'templates/page.contact.json': { noMarker: true, why: 'contact form markup is Shopify-owned and behind hCaptcha' },
    'templates/page.custom-orders.json': { noMarker: true, why: 'composed from generic primitives; body copy is editor prose' },
    'templates/page.json': { noMarker: true, why: 'generic page template; content is Admin prose' },
    'templates/blog.json': { noMarker: true, why: 'listing of Admin articles; the h1 rule covers the page' },
    'templates/article.json': { noMarker: true, why: 'article body is Admin prose; the h1 rule covers the page' },
    // templates/404.json authors the heading text itself, so it is committed markup here.
    'templates/404.json': { markers: ['Page not found'], expectedStatus: 404 },
  },
  byPathPrefix: {
    // Shopify renders /policies/* itself; the theme's only contribution is the jump-nav custom
    // element snippets/policy-page.liquid emits (same marker the deploy smoke asserts).
    '/policies/': { markers: ['policy-nav-component'] },
  },
  byPageType: {
    product: { noMarker: true, why: 'a product outside paths.json has no declared template; the h1 rule still applies' },
    collection: { noMarker: true, why: 'collection grids are Admin data' },
    article: { noMarker: true, why: 'article bodies are Admin prose' },
  },
});

/**
 * The marker rule for a probed entry.
 * @param {object} entry  { path, template?, pageType? } (a resolvedPaths() entry, or a sitemap
 *   product with its server-timing pageType)
 * @returns {{markers?: string[], expectedStatus?: number, noMarker?: boolean, why?: string}|null}
 *   null when no key matches (the completeness test treats that as a gap)
 */
export function markerRuleFor(entry) {
  if (!entry) return null;
  const { template, path, pageType } = entry;
  if (template && MARKER_TABLE.byTemplate[template]) return MARKER_TABLE.byTemplate[template];
  if (typeof path === 'string') {
    for (const [prefix, rule] of Object.entries(MARKER_TABLE.byPathPrefix)) {
      if (path.toLowerCase().startsWith(prefix)) return rule;
    }
  }
  if (pageType && MARKER_TABLE.byPageType[pageType]) return MARKER_TABLE.byPageType[pageType];
  return null;
}

/** The marker literals to require on a body, or [] when the rule declares none. */
export function requiredMarkers(rule) {
  return rule && Array.isArray(rule.markers) ? rule.markers : [];
}

/** The status a path is expected to end on (404 for the deliberate 404 entry, else 200). */
export function expectedStatusFor(rule) {
  return rule && Number.isInteger(rule.expectedStatus) ? rule.expectedStatus : 200;
}
