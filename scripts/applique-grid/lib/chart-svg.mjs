// Build the branded chart-page SVG string from a layout + the page's numbered patterns. Pure
// string construction (no fs, no sharp), mirroring the size-chart renderer's brand system: same
// tokens (scripts/size-chart/lib/svg-shared.mjs), same eyebrow/title/divider rhythm.
//
// The photo cells are NOT in the SVG: compose.mjs composites the cropped JPEG cells over this
// raster at the exact frame positions (layout.mjs computes both from the same numbers). The SVG
// draws each cell's frame slightly outside the photo rect so a 2px brand keyline survives the
// composite, plus a panel fill underneath so a missing cell is visible rather than a hole.
//
// Any visual change here (palette, font, geometry, ICC handling downstream) must bump the
// registry's chart.styleVersion so every existing chart's spec hash changes and republishes.

import { BG, PANEL, ACCENT, ACCENT_LT, WHITE, BODY, FONT, esc } from '../../size-chart/lib/svg-shared.mjs';

function text(str, { x, y, size, weight = 400, fill = BODY, anchor = 'start', spacing = 0 }) {
  const ls = spacing ? ` letter-spacing="${spacing}"` : '';
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-weight="${weight}" font-size="${size}" `
    + `fill="${fill}" text-anchor="${anchor}"${ls}>${esc(str)}</text>`;
}

function defs() {
  return '<defs>'
    + '<linearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">'
    + `<stop offset="0" stop-color="${BG}"/><stop offset="1" stop-color="#05162e"/>`
    + '</linearGradient>'
    + '</defs>';
}

/**
 * @param {object} input
 * @param {object} input.chart - registry chart params (title is rendered)
 * @param {object} input.layout - the pageLayout() result the cells are placed by
 * @param {number} input.page - 1-based
 * @param {number} input.pages - total
 * @param {Array<{number: number, name: string, thread: string}>} input.patterns - one per
 *   layout cell, in the same order
 * @returns {string} the SVG document
 */
export function buildChartSvg({ chart, layout, page, pages, patterns }) {
  if (patterns.length !== layout.cells.length) {
    throw new Error(`layout has ${layout.cells.length} cells but ${patterns.length} patterns were given`);
  }
  const { width: W, height: H, header } = layout;
  const parts = [];

  // Header: eyebrow, title, page indicator, divider. Same rhythm as the size chart.
  parts.push(text('SAPPHIRE SHADOW STUDIO', { x: header.marginX, y: header.eyebrowY, size: 30, weight: 700, fill: ACCENT_LT, spacing: 6 }));
  parts.push(text(chart.title, { x: header.marginX, y: header.titleY, size: 92, weight: 800, fill: WHITE }));
  parts.push(text(`Chart ${page} of ${pages}: pick your pattern by number`, { x: header.marginX, y: header.subtitleY, size: 34, weight: 400, fill: BODY }));
  parts.push(`<line x1="${header.marginX}" y1="${header.dividerY}" x2="${W - header.marginX}" y2="${header.dividerY}" stroke="${ACCENT}" stroke-width="3"/>`);

  // Cells: keyline frame (2px, drawn 3px outside the photo rect so the composite cannot cover
  // it), panel fill underneath, and the two-line label. The thread gets its own line, spelled out
  // as "Thread: x" rather than a bare parenthetical, because a colour word beside a fabric photo
  // otherwise reads as the fabric's colour and not the stitching's.
  layout.cells.forEach((cell, i) => {
    const p = patterns[i];
    parts.push(`<rect x="${cell.x - 3}" y="${cell.y - 3}" width="${cell.width + 6}" height="${cell.height + 6}" `
      + `fill="${PANEL}" stroke="${ACCENT}" stroke-opacity="0.65" stroke-width="2" rx="8"/>`);
    parts.push(text(`${p.number}. ${p.name}`, {
      x: cell.labelX, y: cell.labelY, size: 30, weight: 700, fill: WHITE,
    }));
    parts.push(text(`Thread: ${p.thread}`, {
      x: cell.labelX, y: cell.threadLabelY, size: 26, weight: 400, fill: BODY,
    }));
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + defs()
    + `<rect width="${W}" height="${H}" fill="url(#bgGrad)"/>`
    + parts.join('')
    + '</svg>';
}
