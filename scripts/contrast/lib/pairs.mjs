// pairs.mjs -- which colour roles are checked against which, and at what ratio.
//
// The map below is HARDCODED, deliberately. The alternative considered was
// deriving pairs from the `label` translation keys in settings_schema.json
// (`t:settings.text` sits under a `t:names.primary_button` header, so "text
// belongs to the primary button" is inferable). That is brittle: it depends on
// header ordering the theme editor is free to change, and it silently produces
// the WRONG pairing rather than no pairing when it breaks. A hardcoded map plus
// the completeness assertion below fails LOUDLY on an unrecognised role, which
// is the behaviour a merge gate needs.
//
// ---------------------------------------------------------------------------
// The thresholds
// ---------------------------------------------------------------------------
//
// TEXT, 4.5:1 (WCAG 2.1 SC 1.4.3, AA normal text). Every text role against the
// surface it actually sits on. Hover text is paired with hover background, not
// resting background: they change together, so pairing across states would
// invent a combination the user never sees.
//
// LARGE TEXT, 3:1 (SC 1.4.3, AA large text). `foreground_heading` only. This is
// a JUDGMENT CALL and it is the one threshold in this file that is arguably too
// loose: the role is used for headings, and this theme's h1-h3 are 32px and up
// (config/settings_schema.json type sizes), which clears the 24px / 18.66px-bold
// large-text bar comfortably. h5 and h6 are 14px and 12px, which do NOT. The
// role is a single colour shared by all six levels, so a strict reading would
// demand 4.5:1. Tightening is a one-line change here; it was left at 3:1 so the
// gate lands without an immediate baseline of existing schemes. Revisit if a
// small heading ever ends up as the only carrier of information.
//
// NON-TEXT, 3:1 (SC 1.4.11). A bordered component must be distinguishable from
// the page it sits on. NOTE the shape of this check, which differs from the
// naive "border vs its own fill": a solid button whose border colour equals its
// background (the common case in every scheme here) would score 1:1 on that
// reading and fail, even though the control is perfectly visible. What actually
// has to be perceivable is the boundary between the control and the page, so
// the check passes when EITHER the border OR the component's own background
// reaches 3:1 against the scheme `background`. For the page-level `border` role
// the component background IS the scheme background, so it reduces to the plain
// border-vs-page check, which is the meaningful one.
//
// EXEMPT. `shadow` only: it is a drop-shadow tint, never a boundary or a text
// surface, and SC 1.4.11 does not apply to purely decorative shading.

/** Text pairs at 4.5:1: [textRole, backgroundRole]. */
const TEXT_PAIRS = [
  ['foreground', 'background'],
  ['primary', 'background'],
  ['primary_hover', 'background'],
  ['primary_button_text', 'primary_button_background'],
  ['primary_button_hover_text', 'primary_button_hover_background'],
  ['secondary_button_text', 'secondary_button_background'],
  ['secondary_button_hover_text', 'secondary_button_hover_background'],
  ['input_text_color', 'input_background'],
  // Inputs have no hover-specific text role, so the resting text colour is what
  // sits on the hover fill. Checked explicitly rather than assumed equivalent.
  ['input_text_color', 'input_hover_background'],
  ['variant_text_color', 'variant_background_color'],
  ['variant_hover_text_color', 'variant_hover_background_color'],
  ['selected_variant_text_color', 'selected_variant_background_color'],
  ['selected_variant_hover_text_color', 'selected_variant_hover_background_color'],
];

/** Large-text pairs at 3:1. See the threshold note above. */
const LARGE_TEXT_PAIRS = [['foreground_heading', 'background']];

/** Non-text pairs at 3:1: [borderRole, componentBackgroundRole]. */
const BORDER_PAIRS = [
  ['border', 'background'],
  ['primary_button_border', 'primary_button_background'],
  ['primary_button_hover_border', 'primary_button_hover_background'],
  ['secondary_button_border', 'secondary_button_background'],
  ['secondary_button_hover_border', 'secondary_button_hover_background'],
  ['input_border_color', 'input_background'],
  ['variant_border_color', 'variant_background_color'],
  ['variant_hover_border_color', 'variant_hover_background_color'],
  ['selected_variant_border_color', 'selected_variant_background_color'],
  ['selected_variant_hover_border_color', 'selected_variant_hover_background_color'],
];

/** Roles that carry no contrast obligation. */
const EXEMPT = ['shadow'];

/** The page-level surface every other surface is ultimately composited onto. */
export const PAGE_BACKGROUND = 'background';

export const THRESHOLD_TEXT = 4.5;
export const THRESHOLD_LARGE_TEXT = 3;
export const THRESHOLD_NON_TEXT = 3;

/**
 * @typedef {object} Pair
 * @property {string} id            stable identifier, used as the accepted-risks key
 * @property {'text'|'large-text'|'non-text'} kind
 * @property {string} fg            the role being judged (text or border)
 * @property {string} bg            the surface it sits on / is bounded by
 * @property {number} threshold     minimum acceptable ratio
 */

/** Every pair this lint checks, in a stable order. @type {Pair[]} */
export const PAIRS = [
  ...TEXT_PAIRS.map(([fg, bg]) => ({ id: `${fg} on ${bg}`, kind: 'text', fg, bg, threshold: THRESHOLD_TEXT })),
  ...LARGE_TEXT_PAIRS.map(([fg, bg]) => ({ id: `${fg} on ${bg}`, kind: 'large-text', fg, bg, threshold: THRESHOLD_LARGE_TEXT })),
  ...BORDER_PAIRS.map(([fg, bg]) => ({ id: `${fg} around ${bg}`, kind: 'non-text', fg, bg, threshold: THRESHOLD_NON_TEXT })),
];

/**
 * Which bucket each role falls in. Used only by the completeness assertion.
 * @type {Record<string, 'fg'|'bg'|'border'|'exempt'>}
 */
export const ROLE_KINDS = (() => {
  const kinds = {};
  const set = (role, kind) => {
    if (kinds[role] && kinds[role] !== kind) {
      throw new Error(`role ${role} is classified as both ${kinds[role]} and ${kind}`);
    }
    kinds[role] = kind;
  };
  for (const [fg, bg] of [...TEXT_PAIRS, ...LARGE_TEXT_PAIRS]) { set(fg, 'fg'); set(bg, 'bg'); }
  for (const [fg, bg] of BORDER_PAIRS) { set(fg, 'border'); set(bg, 'bg'); }
  for (const role of EXEMPT) set(role, 'exempt');
  return kinds;
})();

/**
 * Assert the map covers exactly `roles` -- nothing unclassified, nothing
 * classified that no longer exists. A Horizon upstream merge that adds a colour
 * role must fail here rather than leave the new colour silently unchecked.
 * @param {string[]} roles every role id seen in the data (or declared in schema)
 * @returns {{missing: string[], unknown: string[]}} empty arrays when complete
 * @example
 *   checkCompleteness(['background', 'foreground']) // { missing: [...], unknown: [] }
 */
export function checkCompleteness(roles) {
  const seen = new Set(roles);
  const classified = new Set(Object.keys(ROLE_KINDS));
  return {
    // In the data/schema but not in the map: unchecked colour, hard failure.
    missing: [...seen].filter((r) => !classified.has(r)).sort(),
    // In the map but gone from the data/schema: a stale pair that will never
    // resolve, so the map is lying about its coverage.
    unknown: [...classified].filter((r) => !seen.has(r)).sort(),
  };
}
