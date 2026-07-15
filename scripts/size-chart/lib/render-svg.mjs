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
const H = 2000;
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

// ---- garment diagram ------------------------------------------------------
// Stylised flat-lay crewneck sweatshirt with A/B/C/D measurement callouts. Drawn in a local
// coordinate box then translated. Callout letters key to the legend and the table columns:
//   A chest (laid flat), B body length, C shoulder width, D sleeve length.
function garment(tx, ty) {
  const line = (x1, y1, x2, y2) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${ACCENT_LT}" stroke-width="3" stroke-linecap="round"/>`;
  const dot = (x, y) => `<circle cx="${x}" cy="${y}" r="5" fill="${ACCENT_LT}"/>`;

  const path = 'M224,64 Q280,112 336,64 L392,92 L516,168 L470,300 L372,232 '
    + 'L372,520 L188,520 L188,232 L90,300 L44,168 L168,92 Z';

  return `<g transform="translate(${tx},${ty})">`
    // garment body
    + `<path d="${path}" fill="${PANEL}" stroke="${WHITE}" stroke-opacity="0.35" stroke-width="3" stroke-linejoin="round"/>`
    // neckline inner detail
    + `<path d="M232,70 Q280,104 328,70" fill="none" stroke="${WHITE}" stroke-opacity="0.25" stroke-width="3"/>`
    // hem + cuff ribbing hints
    + `<line x1="188" y1="496" x2="372" y2="496" stroke="${WHITE}" stroke-opacity="0.18" stroke-width="2"/>`
    // C: shoulder width (top)
    + line(168, 84, 392, 84) + dot(168, 84) + dot(392, 84) + badge(280, 50, 'C')
    // A: chest laid flat (across body)
    + line(188, 290, 372, 290) + dot(188, 290) + dot(372, 290) + badge(280, 290, 'A')
    // B: body length (right side)
    + line(404, 232, 404, 520) + dot(404, 232) + dot(404, 520) + badge(404, 376, 'B')
    // D: sleeve length (along right sleeve)
    + line(398, 108, 500, 238) + dot(398, 108) + dot(500, 238) + badge(452, 173, 'D')
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
const HEADINGS = ['Size', 'Chest (circumference)', 'Chest (laid flat)', 'Body Length', 'Shoulder Width', 'Sleeve Length'];
const HEAD_BADGE = [null, null, 'A', 'B', 'C', 'D']; // callout letter per column
const COL_KEYS = ['size', 'chest_circumference', 'chest_laid_flat', 'body_length', 'shoulder_width', 'sleeve_length'];

function table(x0, y0, rows) {
  const widths = [150, 246, 246, 246, 246, 246];
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
    const cx = xs[c] + pad;
    const lines = wrapText(h, widths[c] - pad * 2 - (HEAD_BADGE[c] ? 30 : 0), 25, 0.56);
    const startY = y0 + headH / 2 - (lines.length - 1) * 15 + 8;
    lines.forEach((ln, i) => {
      parts.push(text(ln, { x: cx, y: startY + i * 30, size: 25, weight: 700, fill: WHITE }));
    });
    if (HEAD_BADGE[c]) parts.push(badge(xs[c] + widths[c] - 26, y0 + 30, HEAD_BADGE[c], 16));
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

// ---- top-level ------------------------------------------------------------
export function buildSvg(profile, pngLegend) {
  const rows = deriveRows(profile);
  const parts = [];

  parts.push(`<rect width="${W}" height="${H}" fill="${BG}"/>`);

  // header
  parts.push(text('SAPPHIRE SHADOW STUDIO', { x: M, y: 150, size: 30, weight: 700, fill: ACCENT_LT, spacing: 6 }));
  parts.push(text('Size Guide', { x: M, y: 250, size: 92, weight: 800, fill: WHITE }));
  parts.push(text(profile.display_name, { x: M, y: 312, size: 34, weight: 400, fill: BODY }));
  parts.push(`<line x1="${M}" y1="356" x2="${W - M}" y2="356" stroke="${ACCENT}" stroke-width="3"/>`);

  // intro
  const intro = paragraph(pngLegend.intro, { x: M, y: 416, size: 30, fill: BODY, maxWidth: W - 2 * M, lineHeight: 44 });
  parts.push(intro.svg);

  // diagram + legend
  const midY = 456 + intro.height + 40;
  parts.push(garment(M + 10, midY));
  const lg = legend(M + 700, midY + 60, W - M - (M + 700), pngLegend.callouts);
  parts.push(lg.svg);

  // table
  const tableY = Math.max(midY + 600, midY + lg.height + 80);
  const tbl = table(M, tableY, rows);
  parts.push(tbl.svg);

  // footer
  const footY = tableY + tbl.height + 56;
  parts.push(text('Measurements are of the garment laid flat, in inches and centimeters. Every piece is made to order.', { x: M, y: footY, size: 24, fill: BODY }));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + parts.join('') + `</svg>`;
}

export const CANVAS = { W, H };
