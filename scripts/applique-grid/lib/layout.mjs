// Chart page geometry: balanced pagination, cell rectangles, label positions, and the literal
// composite plan compose.mjs walks. Pure math, no I/O, no sharp; every number that decides where
// a pixel lands is computed here so it can be unit-tested.
//
// All positions are in SVG user units on a chart.width_units-wide canvas. The raster is rendered
// at density 72 * scale, which multiplies every user unit by `scale`; compositePlan() applies the
// same factor with one rounding rule so the composited photo cells land exactly on the frames the
// SVG drew.

// Vertical rhythm, carried over from the size-chart renderer so the two gallery images read as
// one brand system (same eyebrow baseline, same header spacing, same margins).
const M = 110;               // left / right margin
const TOP = 112;             // eyebrow baseline
const DY_TITLE = 100;        // title baseline below the eyebrow
const DY_SUBTITLE = 162;     // "Chart n of m" baseline
const DY_DIVIDER = 206;      // rule under the header
const DY_GRID = 268;         // divider -> first cell row top
const CELL_GAP = 36;         // horizontal gap between cells
const LABEL_BASELINE = 46;   // cell bottom -> name-line baseline
const LABEL2_BASELINE = 84;  // cell bottom -> thread-line baseline (the "Thread: x" second line)
const ROW_ADVANCE = 148;     // cell bottom -> next row top (two label lines + breathing room)
const BOTTOM_MARGIN = 64;    // below the last thread-line baseline

// The name-line type, mirrored from chart-svg.mjs. Kept here because the ceiling below is derived
// from geometry, and geometry lives in this file.
export const LABEL_FONT_SIZE = 30;

// Measured, not guessed. Rendering all 18 committed labels in Inter Bold at size 30 and trimming
// to the ink extent gives 0.404 to 0.523 em per character; 0.55 carries roughly 5 percent over the
// widest real name. This is a CALIBRATED POLICY CEILING on realistic mixed-case names, not a
// rendering guarantee: an unusual all-caps name is wider per character than any of these and can
// still overflow, which is what the sample gate's eyes are for.
export const LABEL_EM_PER_CHAR = 0.55;

// Reserved for the "999. " number prefix, so the ceiling below bounds the NAME.
export const LABEL_PREFIX_RESERVE = 5;

/**
 * Split n items into ceil(n / cap) pages that differ in size by at most one, larger pages first.
 * 18 at cap 9 -> [9, 9]; 20 at cap 9 -> [7, 7, 6]; 10 at cap 9 -> [5, 5].
 * @param {number} n - item count (0 yields [])
 * @param {number} cap - page capacity (columns * rows)
 * @returns {number[]}
 */
export function balancedPages(n, cap) {
  if (!Number.isInteger(cap) || cap <= 0) throw new Error(`page capacity must be a positive integer, got ${cap}`);
  if (!Number.isInteger(n) || n < 0) throw new Error(`item count must be a non-negative integer, got ${n}`);
  if (n === 0) return [];
  const count = Math.ceil(n / cap);
  const base = Math.floor(n / count);
  const rem = n % count;
  return Array.from({ length: count }, (_, i) => (i < rem ? base + 1 : base));
}

/**
 * The pixel width of one cell at these chart params. Exported because the label ceiling derives
 * from it, and a second copy of this arithmetic would drift from the one that places the cells.
 * @param {{columns: number, width_units: number}} chart
 * @returns {number}
 */
export function cellWidth({ columns, width_units: W }) {
  return Math.floor((W - 2 * M - (columns - 1) * CELL_GAP) / columns);
}

/**
 * The longest pattern NAME these chart params can carry, in characters. Derived from two real
 * bounds rather than picked: the cell width at this grid density, and the per-line ceiling on the
 * dropdown, whose lines become cart line-item property values.
 *
 * At the shipped 3x3 / 1600-unit config this computes to 21, against a longest committed name of
 * 18 ("Terracotta Blossom"). A denser grid tightens it, which is the point: at 4 columns those
 * names genuinely would not fit, and the operator should learn that at the naming gate rather than
 * from a rendered chart.
 * @param {{columns: number, width_units: number}} chart
 * @param {number} [maxOptionLine] - the dropdown's per-line ceiling
 * @returns {number}
 */
export function nameCharCeiling(chart, maxOptionLine = 255) {
  const fromChart = Math.floor(cellWidth(chart) / (LABEL_FONT_SIZE * LABEL_EM_PER_CHAR)) - LABEL_PREFIX_RESERVE;
  // "18. <name> (Light Purple thread)": the prefix reserve plus the longest plausible thread suffix.
  const fromDropdown = maxOptionLine - LABEL_PREFIX_RESERVE - ' (Light Purple thread)'.length;
  return Math.max(1, Math.min(fromChart, fromDropdown));
}

/**
 * The geometry of one chart page. Cells are laid out row-major, left-aligned; a final partial row
 * simply has fewer cells (no centring), which is what the pinned golden exercises. Height derives
 * from the rows this page actually uses, so a shorter last page renders a shorter canvas.
 * @param {object} input
 * @param {object} input.chart - registry chart params (columns, cell_aspect, width_units)
 * @param {number} input.count - patterns on THIS page (may be under columns * rows)
 * @returns {{
 *   width: number, height: number,
 *   header: {eyebrowY: number, titleY: number, subtitleY: number, dividerY: number, marginX: number},
 *   cells: Array<{index: number, x: number, y: number, width: number, height: number,
 *                 labelX: number, labelY: number, threadLabelY: number}>
 * }}
 */
export function pageLayout({ chart, count }) {
  if (!Number.isInteger(count) || count <= 0) throw new Error(`cell count must be a positive integer, got ${count}`);
  const { columns, rows, width_units: W, cell_aspect: aspect } = chart;
  const cap = columns * rows;
  if (count > cap) throw new Error(`page has ${count} cells but the ${columns}x${rows} grid holds ${cap}`);

  const cellW = cellWidth({ columns, width_units: W });
  const cellH = Math.round(cellW / aspect);
  const gridTop = TOP + DY_GRID;
  const rowsUsed = Math.ceil(count / columns);

  const cells = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / columns);
    const col = i % columns;
    const x = M + col * (cellW + CELL_GAP);
    const y = gridTop + row * (cellH + ROW_ADVANCE);
    cells.push({
      index: i,
      x,
      y,
      width: cellW,
      height: cellH,
      labelX: x,
      labelY: y + cellH + LABEL_BASELINE,
      threadLabelY: y + cellH + LABEL2_BASELINE,
    });
  }

  const lastRowBottom = gridTop + (rowsUsed - 1) * (cellH + ROW_ADVANCE) + cellH;
  const height = lastRowBottom + LABEL2_BASELINE + BOTTOM_MARGIN;

  return {
    width: W,
    height,
    header: {
      eyebrowY: TOP,
      titleY: TOP + DY_TITLE,
      subtitleY: TOP + DY_SUBTITLE,
      dividerY: TOP + DY_DIVIDER,
      marginX: M,
    },
    cells,
  };
}

/**
 * The integer pixel rectangles the photo cells are composited at, one per layout cell, in order.
 * compose.mjs walks this literally: the cell buffer for index i must be resized to exactly
 * plan[i].width x plan[i].height and placed at (left, top).
 * @param {ReturnType<typeof pageLayout>} layout
 * @param {number} scale - the raster scale (chart.scale)
 * @returns {Array<{left: number, top: number, width: number, height: number}>}
 */
export function compositePlan(layout, scale) {
  if (!(Number.isFinite(scale) && scale >= 1)) throw new Error(`scale must be a number >= 1, got ${scale}`);
  return layout.cells.map((c) => ({
    left: Math.round(c.x * scale),
    top: Math.round(c.y * scale),
    width: Math.round(c.width * scale),
    height: Math.round(c.height * scale),
  }));
}
