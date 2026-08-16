// evaluate.mjs -- run the pairing map over a set of schemes and produce results.

import { parseColor, composite, contrastRatio, round2 } from './color.mjs';
import { PAIRS, PAGE_BACKGROUND } from './pairs.mjs';

// The surface beneath the scheme background. A colour scheme's `background` is
// allowed to be translucent, and something has to be underneath it for the
// luminance maths to mean anything. That something is the browser canvas, which
// is white unless a theme paints over it, and this theme does not.
const CANVAS = { r: 255, g: 255, b: 255, a: 1 };

/**
 * @typedef {object} Result
 * @property {string} source     'current' or 'presets.<name>'
 * @property {string} scheme     scheme id
 * @property {string} pair       Pair.id
 * @property {string} kind       'text' | 'large-text' | 'non-text'
 * @property {number} ratio      the achieved contrast ratio, 2dp
 * @property {number} threshold  the required ratio
 * @property {boolean} pass      ratio >= threshold
 * @property {boolean} [indeterminate] scheme background is fully transparent
 * @property {string} [error]    set when the pair could not be evaluated at all
 */

/**
 * A scheme whose `background` is fully transparent paints nothing of its own:
 * it is an OVERLAY scheme, composited over whatever section media sits beneath
 * (a hero image, a video). Two of this theme's schemes are exactly that, and
 * what a static reader would have to assume about the surface underneath is
 * pure invention. Reporting `#f2f2f2` text as 1:1 "against white" would be a
 * fabricated number, and forcing 44 baseline entries to silence it would be a
 * fabricated exception.
 *
 * So these are reported as INDETERMINATE and excluded from the pass/fail
 * tally. That is not the check giving up: overlay schemes are precisely what
 * the second layer covers. pa11y-ci (scripts/a11y/) renders the real page with
 * the real image behind the real text and measures what a visitor actually
 * sees. Static colour maths cannot, and pretending otherwise is the failure
 * mode worth avoiding here.
 * @param {Record<string, string>} settings
 * @returns {boolean}
 */
export function isOverlayScheme(settings) {
  try {
    return parseColor(settings?.background).a === 0;
  } catch {
    return false;
  }
}

/**
 * Evaluate every pair against one scheme.
 * @param {{source: string, scheme: string, settings: Record<string, string>}} scheme
 * @returns {Result[]}
 * @example
 *   evaluateScheme({ source: 'current', scheme: 'scheme-1', settings: {...} })
 */
export function evaluateScheme({ source, scheme, settings }) {
  const results = [];
  const overlay = isOverlayScheme(settings);

  // Memoised "what this surface actually looks like on the page": the role's
  // own colour composited down onto the (opaque) page background.
  const surfaceCache = new Map();
  const pageBackground = () => {
    if (!surfaceCache.has(PAGE_BACKGROUND)) {
      surfaceCache.set(PAGE_BACKGROUND, composite(parseColor(settings[PAGE_BACKGROUND]), CANVAS));
    }
    return surfaceCache.get(PAGE_BACKGROUND);
  };
  const surface = (role) => {
    if (role === PAGE_BACKGROUND) return pageBackground();
    if (!surfaceCache.has(role)) {
      surfaceCache.set(role, composite(parseColor(settings[role]), pageBackground()));
    }
    return surfaceCache.get(role);
  };

  for (const pair of PAIRS) {
    const base = { source, scheme, pair: pair.id, kind: pair.kind, threshold: pair.threshold };
    if (overlay) {
      results.push({ ...base, ratio: 0, pass: true, indeterminate: true });
      continue;
    }

    // A pair whose roles are absent from this scheme is an ERROR, not a skip. A
    // scheme missing a colour the schema declares is malformed, and skipping it
    // would mean a truncated scheme merges green having been checked for
    // nothing. Missing roles that the schema itself dropped are caught earlier,
    // by the completeness assertion in pairs.mjs.
    const missing = [pair.fg, pair.bg, PAGE_BACKGROUND].filter((r) => settings[r] === undefined);
    if (missing.length) {
      results.push({ ...base, ratio: 0, pass: false, error: `missing role(s): ${missing.join(', ')}` });
      continue;
    }

    try {
      let ratio;
      if (pair.kind === 'non-text') {
        // The control has to be tellable apart from the page. Either edge does
        // it: the border line itself, or the control's own fill. See pairs.mjs.
        const page = pageBackground();
        const borderOverPage = composite(parseColor(settings[pair.fg]), page);
        ratio = Math.max(contrastRatio(borderOverPage, page), contrastRatio(surface(pair.bg), page));
      } else {
        const bg = surface(pair.bg);
        ratio = contrastRatio(composite(parseColor(settings[pair.fg]), bg), bg);
      }
      results.push({ ...base, ratio: round2(ratio), pass: round2(ratio) >= pair.threshold });
    } catch (err) {
      results.push({ ...base, ratio: 0, pass: false, error: err.message });
    }
  }

  return results;
}

/**
 * Evaluate every scheme.
 * @param {Array<{source: string, scheme: string, settings: object}>} schemes
 * @returns {Result[]}
 * @example
 *   evaluateAll(loadSchemes('config/settings_data.json'))
 */
export function evaluateAll(schemes) {
  return schemes.flatMap(evaluateScheme);
}
