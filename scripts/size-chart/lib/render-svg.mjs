// Build the branded size-chart SVG string from a profile. Pure string construction (no fs, no
// sharp), so it is cheap to unit-test and inspect. render-size-chart.mjs rasterises the result to
// PNG via sharp. The garment silhouettes live in ./garments.mjs; brand tokens in ./svg-shared.mjs.
//
// The layout is column-driven: the table columns, header badges, legend callouts, and garment
// diagram all come from `profile.columns`, so any garment (crewneck, vest, quarter-zip, ...) renders
// from the same code. The canonical SS3000 crewneck output is pinned byte-for-byte by the render
// golden; the layout math below must not change its output.

import { deriveRows } from './normalize.mjs';
import { drawGarment, ROLE_ANCHOR } from './garments.mjs';
import { BG, PANEL, STRIPE, ACCENT, ACCENT_LT, WHITE, BODY, FONT, esc } from './svg-shared.mjs';

// ---- canvas ---------------------------------------------------------------
const W = 1600;
const DEFAULT_H = 2180;
const M = 110;

// ---- helpers --------------------------------------------------------------
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
// Columns, headings, badges, and cell values all come from the profile (via `columns` + deriveRows).
// Column widths: the size column is fixed at 180; the remaining measurement columns split the rest
// evenly (which yields exactly 300 each for the crewneck's 5 columns, and 240 for a 6-column chart).
function table(x0, y0, rows, columns) {
  const n = columns.length;
  const sizeW = 180;
  const measW = (W - 2 * M - sizeW) / (n - 1);
  const widths = [sizeW, ...Array(n - 1).fill(measW)];
  const headings = columns.map((c) => c.heading);
  const headBadge = columns.map((c) => c.badge ?? null);
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
  headings.forEach((h, c) => {
    const letter = headBadge[c];
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
    row.forEach((val, c) => {
      const isSize = c === 0;
      parts.push(text(val, {
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

// Legend callouts + the garment anchor->letter map, both derived from the profile's columns.
function calloutsFrom(columns) {
  return columns
    .filter((c) => c.badge)
    .map((c) => ({ key: c.badge, label: c.callout_label ?? c.heading, how: c.how }));
}
function anchorMapFrom(columns) {
  const map = {};
  for (const c of columns) {
    if (!c.badge) continue;
    const anchor = ROLE_ANCHOR[c.role];
    if (anchor) map[anchor] = c.badge;
  }
  return map;
}

// ---- top-level ------------------------------------------------------------
export function buildSvg(profile) {
  const H = profile.canvas_height ?? DEFAULT_H;
  const rows = deriveRows(profile);
  const columns = profile.columns;
  const parts = [];

  parts.push(defs());
  parts.push(`<rect width="${W}" height="${H}" fill="url(#bgGrad)"/>`);

  // header
  parts.push(text('SAPPHIRE SHADOW STUDIO', { x: M, y: 150, size: 30, weight: 700, fill: ACCENT_LT, spacing: 6 }));
  parts.push(text('Size Guide', { x: M, y: 250, size: 92, weight: 800, fill: WHITE }));
  parts.push(text(profile.display_name, { x: M, y: 312, size: 34, weight: 400, fill: BODY }));
  parts.push(`<line x1="${M}" y1="356" x2="${W - M}" y2="356" stroke="${ACCENT}" stroke-width="3"/>`);

  // how-to panel: the prominent "start here" section
  const ht = howTo(M, 408, W - 2 * M, profile.how_to);
  parts.push(ht.svg);

  // diagram (left) + legend (right), tucked close under the panel
  const blockTop = 408 + ht.height + 40;
  const legendX = M + 700;
  const gScale = 1.25;
  // garment local silhouette spans y ~[144..500] (collar to hem) plus a shadow to ~532, centred on
  // x280. Scale it up, centre it in the left column, and tuck the collar just under the panel.
  const gTx = (M + legendX) / 2 - 280 * gScale;
  const gTy = blockTop - 144 * gScale;
  parts.push(drawGarment(profile.garment, gTx, gTy, gScale, anchorMapFrom(columns)));

  // legend, vertically centred against the diagram silhouette so it does not favour the top now
  // that there are only three callouts. Measure it, then place its optical centre at the silhouette
  // middle (the first badge sits ~25px above the given y, hence the +27 correction).
  const callouts = calloutsFrom(columns);
  const legendW = W - M - legendX;
  const gMid = gTy + 336 * gScale; // vertical middle of the silhouette + its shadow (collar 144 -> ~532)
  const lgH = legend(legendX, 0, legendW, callouts).height;
  const lgY = gMid - lgH / 2 + 27;
  const lg = legend(legendX, lgY, legendW, callouts);
  parts.push(lg.svg);

  // table below whichever of the diagram / legend reaches lower
  const gBottom = gTy + 532 * gScale;
  const tableY = Math.max(gBottom + 60, lgY + lg.height + 60);
  const tbl = table(M, tableY, rows, columns);
  parts.push(tbl.svg);

  // footer (wrapped so a longer per-garment note does not run past the right edge)
  const footY = tableY + tbl.height + 56;
  const foot = paragraph(profile.footer || '', {
    x: M, y: footY, size: 24, fill: BODY, maxWidth: W - 2 * M, lineHeight: 32,
  });
  if (footY + foot.height + 8 > H) {
    throw new Error(
      `size-chart content overflows the ${H}px canvas (footer bottom ${Math.round(footY + foot.height)}); `
      + `raise canvas_height in the profile.`,
    );
  }
  parts.push(foot.svg);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + parts.join('') + `</svg>`;
}

export const CANVAS = { W, H: DEFAULT_H };
