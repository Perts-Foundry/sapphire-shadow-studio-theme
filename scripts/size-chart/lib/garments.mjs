// Garment silhouette library for the size-chart PNG. Each garment is a flat-lay drawn in a local
// ~560x600 box (symmetric about x=280), then translated + scaled by render-svg. A garment exposes a
// base silhouette plus named anchor points (chest, body, sleeve, zipper) where the dashed measurement
// guides + lettered badges attach; render-svg binds each measured column's badge to its anchor, and
// profile-schema rejects a badge whose anchor the chosen garment does not expose. Pure string
// construction (no fs, no sharp), so it is cheap to unit-test and inspect.
//
// The anchor vocabulary (ROLE_ANCHOR, ANCHOR_ORDER, and each garment's exposed anchors) lives here as
// the single source of truth; render-svg and profile-schema both import it.
//
// The `crewneck` drawing is the canonical SS3000 flat-lay and is pinned byte-for-byte by the render
// golden; do not alter its base or anchor geometry. `vest` and `quarter-zip` are new silhouettes.

import { ACCENT, ACCENT_LT, WHITE, FONT, esc } from './svg-shared.mjs';

// ---- callout primitives (shared) ------------------------------------------
const guide = (x1, y1, x2, y2) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${ACCENT_LT}" stroke-width="2.5" `
  + `stroke-dasharray="1 7" stroke-linecap="round"/>`;
const dot = (x, y) => `<circle cx="${x}" cy="${y}" r="5.5" fill="${ACCENT_LT}"/>`;
const dbadge = (cx, cy, letter) =>
  `<circle cx="${cx}" cy="${cy}" r="21" fill="${ACCENT}" stroke="${WHITE}" stroke-opacity="0.9" stroke-width="2"/>`
  + `<text x="${cx}" y="${cy + 7.5}" font-family="${FONT}" font-weight="700" font-size="23" `
  + `fill="${WHITE}" text-anchor="middle">${esc(letter)}</text>`;

// Fixed emit order so the output is deterministic regardless of a profile's column order.
export const ANCHOR_ORDER = ['chest', 'body', 'sleeve', 'zipper'];

// Map a measured column's semantic role to the garment anchor its badge attaches to. A badged role
// absent from this map has nowhere to point on the diagram (the schema rejects that).
export const ROLE_ANCHOR = {
  chest_laid_flat: 'chest',
  chest_circumference: 'chest',
  bust: 'chest',
  body_length_hps: 'body',
  body_length_back: 'body',
  sleeve_cb: 'sleeve',
  front_zipper: 'zipper',
};

// Draw the active callouts (guide + endpoint dots + lettered badge) for a garment's anchors.
// `callouts` maps an anchor name to the badge letter to draw there.
function emitCallouts(anchors, callouts) {
  let out = '';
  for (const name of ANCHOR_ORDER) {
    const letter = callouts[name];
    const a = anchors[name];
    if (!letter || !a) continue;
    out += guide(a.guide[0], a.guide[1], a.guide[2], a.guide[3]);
    for (const [dx, dy] of a.dots) out += dot(dx, dy);
    out += dbadge(a.badge[0], a.badge[1], letter);
  }
  return out;
}

// ---- shared silhouette pieces ---------------------------------------------
// Crewneck / quarter-zip share the boxy body with set-in tubular sleeves and a ribbed waistband.
const TORSO_BODY = 'M238,152 Q280,192 322,152 Q356,150 384,158 Q472,250 512,384 Q516,398 470,430 '
  + 'Q424,344 384,256 L384,486 Q384,500 370,500 L190,500 Q176,500 176,486 L176,256 '
  + 'Q136,344 90,430 Q44,398 48,384 Q88,250 176,158 Q204,150 238,152 Z';

// ribbed waistband: vertical ticks inside a lighter band
function hemRibs() {
  let s = '';
  for (let x = 190; x <= 370; x += 11) {
    s += `<line x1="${x}" y1="474" x2="${x}" y2="494" stroke="#0a2a52" stroke-width="2" opacity="0.55"/>`;
  }
  return s;
}

// cuff / seam band: a line with two short perpendicular rib ticks
function cuff(ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
  const nx = (-dy / len) * 8, ny = (dx / len) * 8; // short perpendicular rib
  const rib = (t) => {
    const px = ax + dx * t, py = ay + dy * t;
    return `<line x1="${(px - nx).toFixed(1)}" y1="${(py - ny).toFixed(1)}" x2="${(px + nx).toFixed(1)}" y2="${(py + ny).toFixed(1)}" stroke="#0b2c56" stroke-width="2" opacity="0.6"/>`;
  };
  return `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="#3d6ea6" stroke-opacity="0.55" stroke-width="2.5"/>`
    + rib(0.34) + rib(0.66);
}

// Common torso body: silhouette + volume sheen + set-in sleeve seams + ribbed waistband + cuffs.
// Excludes the collar (crew vs stand) so crewneck and quarter-zip can each add their own.
function torsoBase() {
  return `<ellipse cx="280" cy="516" rx="150" ry="16" fill="#030b1a" opacity="0.45"/>`
    + `<path d="${TORSO_BODY}" fill="url(#garmentGrad)" stroke="#3f6fa8" stroke-opacity="0.55" stroke-width="2.5" stroke-linejoin="round"/>`
    + `<ellipse cx="280" cy="320" rx="70" ry="140" fill="${WHITE}" opacity="0.025"/>`
    + `<path d="M384,158 Q408,206 384,256" fill="none" stroke="#2a5a99" stroke-opacity="0.5" stroke-width="2.5"/>`
    + `<path d="M176,158 Q152,206 176,256" fill="none" stroke="#2a5a99" stroke-opacity="0.5" stroke-width="2.5"/>`
    + `<path d="M176,470 L384,470" stroke="#3d6ea6" stroke-opacity="0.45" stroke-width="2"/>`
    + `<rect x="180" y="470" width="204" height="24" fill="#10345f" opacity="0.42"/>`
    + hemRibs()
    + cuff(500, 382, 460, 424)
    + cuff(60, 382, 100, 424);
}

// Shared torso anchors (chest across the body ~1in below the armhole; body length HPS to hem;
// sleeve from centre back to cuff). Identical geometry for crewneck and quarter-zip.
const TORSO_ANCHORS = {
  chest: { guide: [176, 292, 384, 292], dots: [[176, 292], [384, 292]], badge: [280, 292] },
  body: { guide: [214, 152, 214, 494], dots: [[214, 152], [214, 494]], badge: [214, 322] },
  sleeve: { guide: [280, 152, 492, 408], dots: [[280, 152], [492, 408]], badge: [424, 328] },
};

// ---- garments -------------------------------------------------------------
// Crewneck sweatshirt (canonical SS3000). Base + ribbed crew collar. Pinned by the render golden.
function crewneck() {
  const base = torsoBase()
    + `<path d="M232,150 Q280,202 328,150" fill="none" stroke="#2f5f9e" stroke-width="13" stroke-linecap="round"/>`
    + `<path d="M242,152 Q280,188 318,152" fill="none" stroke="#0c2a52" stroke-width="4" stroke-linecap="round"/>`;
  return { base, anchors: TORSO_ANCHORS };
}

// Quarter-zip: the crewneck torso with a ribbed stand collar and a short centre zip placket. Adds a
// zipper anchor (the front-zipper length runs down the placket from the collar base).
function quarterZip() {
  const collar = `<path d="M244,150 Q280,138 316,150 L322,120 Q280,108 238,120 Z" fill="#123a6c" stroke="#2f5f9e" stroke-width="3" stroke-linejoin="round"/>`
    + `<path d="M244,150 Q280,140 316,150" fill="none" stroke="#0c2a52" stroke-width="3" stroke-linecap="round"/>`;
  // centre placket + zipper teeth from the collar base down to ~a third of the body
  const placket = `<line x1="280" y1="150" x2="280" y2="300" stroke="#0c2a52" stroke-width="7"/>`
    + `<line x1="280" y1="150" x2="280" y2="300" stroke="#3d6ea6" stroke-opacity="0.5" stroke-width="1.5" stroke-dasharray="3 3"/>`
    + `<circle cx="280" cy="300" r="7" fill="#4f83bc"/><rect x="277" y="300" width="6" height="16" rx="2" fill="#4f83bc"/>`;
  const base = torsoBase() + collar + placket;
  const anchors = {
    ...TORSO_ANCHORS,
    zipper: { guide: [312, 152, 312, 298], dots: [[312, 152], [312, 298]], badge: [340, 226] },
  };
  return { base, anchors };
}

// Vest: sleeveless torso with a ribbed stand collar and a full-length centre zip. Anchors: chest and
// body only (no sleeve).
function vest() {
  // sleeveless silhouette: shoulders, armscye scoops to the underarm, straight-ish sides to the hem
  const body = 'M214,158 Q280,148 346,158 Q372,161 380,196 '
    + 'Q356,232 344,272 Q340,286 352,296 L366,470 Q366,494 342,494 '
    + 'L218,494 Q194,494 194,470 L208,296 Q220,286 216,272 '
    + 'Q204,232 180,196 Q188,161 214,158 Z';
  const collar = `<path d="M244,156 Q280,144 316,156 L322,124 Q280,112 238,124 Z" fill="#123a6c" stroke="#2f5f9e" stroke-width="3" stroke-linejoin="round"/>`
    + `<path d="M244,156 Q280,146 316,156" fill="none" stroke="#0c2a52" stroke-width="3" stroke-linecap="round"/>`;
  const zip = `<line x1="280" y1="156" x2="280" y2="486" stroke="#0c2a52" stroke-width="7"/>`
    + `<line x1="280" y1="156" x2="280" y2="486" stroke="#3d6ea6" stroke-opacity="0.5" stroke-width="1.5" stroke-dasharray="3 3"/>`
    + `<circle cx="280" cy="176" r="7" fill="#4f83bc"/>`;
  // armscye seam accents
  const seams = `<path d="M214,158 Q212,232 216,272" fill="none" stroke="#2a5a99" stroke-opacity="0.5" stroke-width="2.5"/>`
    + `<path d="M346,158 Q348,232 344,272" fill="none" stroke="#2a5a99" stroke-opacity="0.5" stroke-width="2.5"/>`;
  const base = `<ellipse cx="280" cy="512" rx="130" ry="15" fill="#030b1a" opacity="0.45"/>`
    + `<path d="${body}" fill="url(#garmentGrad)" stroke="#3f6fa8" stroke-opacity="0.55" stroke-width="2.5" stroke-linejoin="round"/>`
    + `<ellipse cx="280" cy="330" rx="66" ry="140" fill="${WHITE}" opacity="0.025"/>`
    + `<path d="M208,470 L352,470" stroke="#3d6ea6" stroke-opacity="0.45" stroke-width="2"/>`
    + seams + collar + zip;
  const anchors = {
    chest: { guide: [200, 300, 360, 300], dots: [[200, 300], [360, 300]], badge: [280, 300] },
    body: { guide: [232, 156, 232, 494], dots: [[232, 156], [232, 494]], badge: [232, 330] },
  };
  return { base, anchors };
}

const GARMENTS = { crewneck, 'quarter-zip': quarterZip, vest };

// Build the full translated garment group for `id`, with `callouts` mapping anchor -> badge letter.
// `id` null/undefined renders nothing (the no-diagram fallback; render-svg lays out without it).
export function drawGarment(id, tx, ty, s, callouts = {}) {
  if (id == null) return '';
  const fn = GARMENTS[id];
  if (!fn) throw new Error(`Unknown garment '${id}' (known: ${Object.keys(GARMENTS).join(', ')})`);
  const { base, anchors } = fn();
  return `<g transform="translate(${tx},${ty}) scale(${s})">` + base + emitCallouts(anchors, callouts) + `</g>`;
}

export const KNOWN_GARMENTS = Object.keys(GARMENTS);

// Local y of each garment's topmost drawn pixel (the collar crown), so render-svg can seat every
// silhouette the same distance below the "Start here" panel regardless of collar height. The crewneck
// crew neckline tops out at its shoulder line (~150); the quarter-zip and vest stand collars rise
// higher (crowns at 114 / 118, the t=0.5 point of the `Q...Z` collar caps in quarterZip() / vest()).
// Without this, the taller stand collars were seated by the shared anchor reference (144) and pushed
// up into the panel. 144 is the safe fall-back for the null / unknown (no-diagram) garment.
const GARMENT_TOP = { crewneck: 150, 'quarter-zip': 114, vest: 118 };
export function garmentTop(id) {
  return GARMENT_TOP[id] ?? 144;
}

// The anchor names a garment exposes (chest / body / sleeve / zipper), derived from its own drawing.
// Returns [] for the null / unknown garment. The schema uses this to reject a badge whose anchor the
// chosen garment does not draw.
export function garmentAnchors(id) {
  const fn = GARMENTS[id];
  return fn ? Object.keys(fn().anchors) : [];
}
