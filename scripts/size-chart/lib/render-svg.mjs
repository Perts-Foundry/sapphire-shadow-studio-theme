// Build the branded size-chart SVG string from a profile + PNG legend copy. Pure string
// construction (no fs, no sharp), so it is cheap to unit-test and inspect. render-size-chart.mjs
// rasterises the result to PNG via sharp.
//
// Brand tokens are the resolved values of the storefront's signature "Sapphire Shadow" scheme
// (deep navy background, sapphire accent, Inter type). See snippets/theme-styles-variables.liquid.

import { deriveRows } from './normalize.mjs';

// ---- brand tokens ---------------------------------------------------------
const BG = '#071e3f';        // deep navy background
const PANEL = '#0c2c56';     // slightly lighter navy for the header band shadow / stripes
const STRIPE = '#0a2748';    // striped data row
const ACCENT = '#007dd5';    // sapphire
const ACCENT_LT = '#3aa0e6'; // lighter sapphire (wordmark, badges)
const WHITE = '#ffffff';
const BODY = '#c9d8ea';      // muted light-blue body text
const FONT = 'Inter';

// ---- canvas ---------------------------------------------------------------
const W = 1600;
const H = 2180;
const M = 110;

// ---- helpers --------------------------------------------------------------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function text(str, { x, y, size, weight = 400, fill = BODY, anchor = 'start', spacing = 0 }) {
  const ls = spacing ? ` letter-spacing="${spacing}"` : '';
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-weight="${weight}" font-size="${size}" `
    + `fill="${fill}" text-anchor="${anchor}"${ls}>${esc(str)}</text>`;
}

// Greedy word wrap using an estimated average glyph advance for Inter.
function wrapText(str, maxWidth, size, factor = 0.52) {
  const words = String(str).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  const fits = (s) => s.length * size * factor <= maxWidth;
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (fits(next) || !line) line = next;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

function paragraph(str, { x, y, size, weight = 400, fill = BODY, maxWidth, lineHeight, factor }) {
  const lines = wrapText(str, maxWidth, size, factor);
  return {
    height: lines.length * lineHeight,
    svg: lines.map((ln, i) => text(ln, { x, y: y + i * lineHeight, size, weight, fill })).join(''),
  };
}

function badge(cx, cy, letter, r = 19) {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${ACCENT}"/>`
    + `<text x="${cx}" y="${cy + r * 0.34}" font-family="${FONT}" font-weight="700" font-size="${r * 1.1}" `
    + `fill="${WHITE}" text-anchor="middle">${esc(letter)}</text>`;
}

// ---- gradients ------------------------------------------------------------
// Reusable paint servers: a subtle background vignette and a top-lit garment fill that gives the
// flat-lay a sense of volume. librsvg renders linearGradient reliably (unlike @font-face / filters).
function defs() {
  return '<defs>'
    + '<linearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">'
    + `<stop offset="0" stop-color="${BG}"/><stop offset="1" stop-color="#05162e"/>`
    + '</linearGradient>'
    + '<linearGradient id="garmentGrad" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#17427e"/><stop offset="0.55" stop-color="#0f3462"/>'
    + '<stop offset="1" stop-color="#0a2748"/>'
    + '</linearGradient>'
    + '</defs>';
}

// ---- garment diagram ------------------------------------------------------
// Flat-lay crewneck sweatshirt (front), drawn in a local ~560x600 box then translated. A top-lit
// gradient fill gives soft volume; a ribbed crew collar, ribbed hem, and cuff seams read as a
// sweatshirt. Dashed A/B/C guides key to the legend and table columns:
//   A chest (laid flat), B body length (from HPS), C sleeve length (from centre back).
function garment(tx, ty, s = 1) {
  const guide = (x1, y1, x2, y2) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${ACCENT_LT}" stroke-width="2.5" `
    + `stroke-dasharray="1 7" stroke-linecap="round"/>`;
  const dot = (x, y) => `<circle cx="${x}" cy="${y}" r="5.5" fill="${ACCENT_LT}"/>`;
  const dbadge = (cx, cy, letter) =>
    `<circle cx="${cx}" cy="${cy}" r="21" fill="${ACCENT}" stroke="${WHITE}" stroke-opacity="0.9" stroke-width="2"/>`
    + `<text x="${cx}" y="${cy + 7.5}" font-family="${FONT}" font-weight="700" font-size="23" `
    + `fill="${WHITE}" text-anchor="middle">${esc(letter)}</text>`;

  // outer silhouette: crewneck sweatshirt, front flat lay. Set-in tubular sleeves hang down-and-out
  // to ribbed cuffs; boxy body; ribbed crew collar and waistband. Symmetric about x=280.
  const body = 'M238,152 Q280,192 322,152 Q356,150 384,158 Q472,250 512,384 Q516,398 470,430 '
    + 'Q424,344 384,256 L384,486 Q384,500 370,500 L190,500 Q176,500 176,486 L176,256 '
    + 'Q136,344 90,430 Q44,398 48,384 Q88,250 176,158 Q204,150 238,152 Z';

  // ribbed waistband: vertical ticks inside a lighter band
  let hemRibs = '';
  for (let x = 190; x <= 370; x += 11) {
    hemRibs += `<line x1="${x}" y1="474" x2="${x}" y2="494" stroke="#0a2a52" stroke-width="2" opacity="0.55"/>`;
  }
  // cuff / seam band: a line with two short perpendicular rib ticks
  const cuff = (ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    const nx = (-dy / len) * 8, ny = (dx / len) * 8; // short perpendicular rib
    const rib = (t) => {
      const px = ax + dx * t, py = ay + dy * t;
      return `<line x1="${(px - nx).toFixed(1)}" y1="${(py - ny).toFixed(1)}" x2="${(px + nx).toFixed(1)}" y2="${(py + ny).toFixed(1)}" stroke="#0b2c56" stroke-width="2" opacity="0.6"/>`;
    };
    return `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="#3d6ea6" stroke-opacity="0.55" stroke-width="2.5"/>`
      + rib(0.34) + rib(0.66);
  };

  return `<g transform="translate(${tx},${ty}) scale(${s})">`
    // grounding shadow
    + `<ellipse cx="280" cy="516" rx="150" ry="16" fill="#030b1a" opacity="0.45"/>`
    // body
    + `<path d="${body}" fill="url(#garmentGrad)" stroke="#3f6fa8" stroke-opacity="0.55" stroke-width="2.5" stroke-linejoin="round"/>`
    // soft center sheen for volume (diffuse, so it reads as light, not a stripe)
    + `<ellipse cx="280" cy="320" rx="70" ry="140" fill="${WHITE}" opacity="0.025"/>`
    // set-in sleeve seams (armscye), so the sleeves read as set in, not batwing
    + `<path d="M384,158 Q408,206 384,256" fill="none" stroke="#2a5a99" stroke-opacity="0.5" stroke-width="2.5"/>`
    + `<path d="M176,158 Q152,206 176,256" fill="none" stroke="#2a5a99" stroke-opacity="0.5" stroke-width="2.5"/>`
    // ribbed waistband
    + `<path d="M176,470 L384,470" stroke="#3d6ea6" stroke-opacity="0.45" stroke-width="2"/>`
    + `<rect x="180" y="470" width="204" height="24" fill="#10345f" opacity="0.42"/>`
    + hemRibs
    // ribbed cuffs (a seam just up-sleeve of each wrist opening)
    + cuff(500, 382, 460, 424)
    + cuff(60, 382, 100, 424)
    // ribbed crew collar (band + inner shadow)
    + `<path d="M232,150 Q280,202 328,150" fill="none" stroke="#2f5f9e" stroke-width="13" stroke-linecap="round"/>`
    + `<path d="M242,152 Q280,188 318,152" fill="none" stroke="#0c2a52" stroke-width="4" stroke-linecap="round"/>`
    // A: chest width laid flat (across the body, about an inch below the armhole)
    + guide(176, 292, 384, 292) + dot(176, 292) + dot(384, 292) + dbadge(280, 292, 'A')
    // B: body length (from the high point of the shoulder straight down to the hem edge; the
    // endpoints sit exactly on the shoulder and the hem, not beyond either)
    + guide(214, 152, 214, 494) + dot(214, 152) + dot(214, 494) + dbadge(214, 322, 'B')
    // C: sleeve length (from the centre back neck, across the shoulder, down to the cuff)
    + guide(280, 152, 492, 408) + dot(280, 152) + dot(492, 408) + dbadge(424, 328, 'C')
    + `</g>`;
}

// ---- legend ---------------------------------------------------------------
function legend(x, y, width, callouts) {
  let cursor = y;
  const parts = [];
  for (const c of callouts) {
    parts.push(badge(x + 19, cursor - 6, c.key));
    parts.push(text(c.label, { x: x + 54, y: cursor, size: 30, weight: 700, fill: WHITE }));
    const p = paragraph(c.how, {
      x: x + 54, y: cursor + 34, size: 25, fill: BODY, maxWidth: width - 54, lineHeight: 34,
    });
    parts.push(p.svg);
    cursor += 34 + p.height + 30;
  }
  return { height: cursor - y, svg: parts.join('') };
}

// ---- table ----------------------------------------------------------------
const HEADINGS = ['Size', 'Chest (laid flat)', 'Chest (circumference)', 'Body Length', 'Sleeve Length'];
const HEAD_BADGE = [null, 'A', null, 'B', 'C']; // callout letter per column
const COL_KEYS = ['size', 'chest_laid_flat', 'chest_circumference', 'body_length', 'sleeve_length'];

function table(x0, y0, rows) {
  const widths = [180, 300, 300, 300, 300];
  const totalW = widths.reduce((a, b) => a + b, 0);
  const xs = [];
  let xacc = x0;
  for (const w of widths) { xs.push(xacc); xacc += w; }
  const headH = 112;
  const rowH = 78;
  const pad = 22;

  const parts = [];
  // header band
  parts.push(`<rect x="${x0}" y="${y0}" width="${totalW}" height="${headH}" fill="${ACCENT}" rx="6"/>`);
  // header labels (wrapped up to 2 lines), each column
  HEADINGS.forEach((h, c) => {
    const letter = HEAD_BADGE[c];
    const r = 17;
    const badgeSpace = letter ? r * 2 + 14 : 0; // room for a front badge + gap
    const textX = xs[c] + pad + badgeSpace;
    const lines = wrapText(h, widths[c] - pad * 2 - badgeSpace, 25, 0.56);
    const startY = y0 + headH / 2 - (lines.length - 1) * 15 + 8;
    // front-of-column badge: a navy chip with a white letter so it stays legible on the accent
    // header band (an accent-on-accent circle would vanish) and maps 1:1 to the diagram badges.
    if (letter) {
      const bcx = xs[c] + pad + r, bcy = y0 + headH / 2;
      parts.push(`<circle cx="${bcx}" cy="${bcy}" r="${r}" fill="${BG}" stroke="${WHITE}" stroke-opacity="0.85" stroke-width="1.5"/>`);
      parts.push(`<text x="${bcx}" y="${bcy + 6}" font-family="${FONT}" font-weight="800" font-size="20" fill="${WHITE}" text-anchor="middle">${esc(letter)}</text>`);
    }
    lines.forEach((ln, i) => {
      parts.push(text(ln, { x: textX, y: startY + i * 30, size: 25, weight: 700, fill: WHITE }));
    });
  });

  // data rows
  rows.forEach((row, r) => {
    const ry = y0 + headH + r * rowH;
    if (r % 2 === 1) parts.push(`<rect x="${x0}" y="${ry}" width="${totalW}" height="${rowH}" fill="${STRIPE}"/>`);
    const ty = ry + rowH / 2 + 10;
    COL_KEYS.forEach((key, c) => {
      const isSize = c === 0;
      parts.push(text(row[key], {
        x: xs[c] + pad,
        y: ty,
        size: isSize ? 30 : 27,
        weight: isSize ? 700 : 400,
        fill: isSize ? ACCENT_LT : BODY,
      }));
    });
  });

  // outer + row rules
  const tableH = headH + rows.length * rowH;
  parts.push(`<rect x="${x0}" y="${y0}" width="${totalW}" height="${tableH}" fill="none" stroke="${WHITE}" stroke-opacity="0.18" stroke-width="2" rx="6"/>`);
  for (let r = 1; r < rows.length; r++) {
    const ry = y0 + headH + r * rowH;
    parts.push(`<line x1="${x0}" y1="${ry}" x2="${x0 + totalW}" y2="${ry}" stroke="${WHITE}" stroke-opacity="0.10" stroke-width="1"/>`);
  }
  return { height: tableH, svg: parts.join('') };
}

// ---- how-to panel ---------------------------------------------------------
// The prominent "Start here" section: a bordered panel with an eyebrow, heading, the garment-vs-body
// note, and numbered steps joined by chevrons, so a shopper sees the reading order before the table.
function howTo(x0, y0, width, data) {
  if (!data) return { height: 0, svg: '' };
  const pad = 46;
  const inner = x0 + pad;
  const steps = data.steps || [];
  const stepsTop = y0 + 196;
  const colW = (width - 2 * pad) / (steps.length || 1);
  const badgeR = 22;

  const stepSvg = [];
  let maxBottom = stepsTop;
  steps.forEach((s, i) => {
    const cx = inner + i * colW;
    const bcx = cx + badgeR, bcy = stepsTop + badgeR;
    stepSvg.push(`<circle cx="${bcx}" cy="${bcy}" r="${badgeR}" fill="${ACCENT}"/>`);
    stepSvg.push(`<text x="${bcx}" y="${bcy + 9}" font-family="${FONT}" font-weight="800" font-size="26" `
      + `fill="${WHITE}" text-anchor="middle">${i + 1}</text>`);
    const tw = colW - 30;
    const titleLines = wrapText(s.title, tw, 26, 0.55);
    titleLines.forEach((ln, j) => {
      stepSvg.push(text(ln, { x: cx, y: stepsTop + 84 + j * 32, size: 26, weight: 700, fill: WHITE }));
    });
    const dY = stepsTop + 84 + titleLines.length * 32 + 6;
    const dp = paragraph(s.detail, { x: cx, y: dY, size: 23, fill: BODY, maxWidth: tw, lineHeight: 30 });
    stepSvg.push(dp.svg);
    maxBottom = Math.max(maxBottom, dY + dp.height);
  });

  const panelH = (maxBottom + pad - 6) - y0;
  const parts = [];
  parts.push(`<rect x="${x0}" y="${y0}" width="${width}" height="${panelH}" rx="18" fill="${PANEL}" fill-opacity="0.4" stroke="${ACCENT}" stroke-opacity="0.5" stroke-width="2"/>`);
  parts.push(`<rect x="${x0}" y="${y0 + 14}" width="6" height="${panelH - 28}" rx="3" fill="${ACCENT}"/>`);
  parts.push(text((data.eyebrow || 'Start here').toUpperCase(), { x: inner, y: y0 + 52, size: 25, weight: 700, fill: ACCENT_LT, spacing: 5 }));
  parts.push(text(data.heading || '', { x: inner, y: y0 + 106, size: 44, weight: 800, fill: WHITE }));
  if (data.note) parts.push(text(data.note, { x: inner, y: y0 + 148, size: 25, fill: BODY }));
  parts.push(stepSvg.join(''));
  return { height: panelH, svg: parts.join('') };
}

// ---- top-level ------------------------------------------------------------
export function buildSvg(profile, pngLegend) {
  const rows = deriveRows(profile);
  const parts = [];

  parts.push(defs());
  parts.push(`<rect width="${W}" height="${H}" fill="url(#bgGrad)"/>`);

  // header
  parts.push(text('SAPPHIRE SHADOW STUDIO', { x: M, y: 150, size: 30, weight: 700, fill: ACCENT_LT, spacing: 6 }));
  parts.push(text('Size Guide', { x: M, y: 250, size: 92, weight: 800, fill: WHITE }));
  parts.push(text(profile.display_name, { x: M, y: 312, size: 34, weight: 400, fill: BODY }));
  parts.push(`<line x1="${M}" y1="356" x2="${W - M}" y2="356" stroke="${ACCENT}" stroke-width="3"/>`);

  // how-to panel: the prominent "start here" section
  const ht = howTo(M, 408, W - 2 * M, pngLegend.how_to);
  parts.push(ht.svg);

  // diagram (left) + legend (right), tucked close under the panel
  const blockTop = 408 + ht.height + 40;
  const legendX = M + 700;
  const gScale = 1.25;
  // garment local silhouette spans y ~[144..500] (collar to hem) plus a shadow to ~532, centred on
  // x280. Scale it up, centre it in the left column, and tuck the collar just under the panel.
  const gTx = (M + legendX) / 2 - 280 * gScale;
  const gTy = blockTop - 144 * gScale;
  parts.push(garment(gTx, gTy, gScale));

  // legend, vertically centred against the diagram silhouette so it does not favour the top now
  // that there are only three callouts. Measure it, then place its optical centre at the silhouette
  // middle (the first badge sits ~25px above the given y, hence the +27 correction).
  const legendW = W - M - legendX;
  const gMid = gTy + 336 * gScale; // vertical middle of the silhouette + its shadow (collar 144 -> ~532)
  const lgH = legend(legendX, 0, legendW, pngLegend.callouts).height;
  const lgY = gMid - lgH / 2 + 27;
  const lg = legend(legendX, lgY, legendW, pngLegend.callouts);
  parts.push(lg.svg);

  // table below whichever of the diagram / legend reaches lower
  const gBottom = gTy + 532 * gScale;
  const tableY = Math.max(gBottom + 60, lgY + lg.height + 60);
  const tbl = table(M, tableY, rows);
  parts.push(tbl.svg);

  // footer
  const footY = tableY + tbl.height + 56;
  parts.push(text('Measurements are of the garment laid flat. A manufacturing tolerance of ±1 inch applies to all measurements.', { x: M, y: footY, size: 24, fill: BODY }));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + parts.join('') + `</svg>`;
}

export const CANVAS = { W, H };
