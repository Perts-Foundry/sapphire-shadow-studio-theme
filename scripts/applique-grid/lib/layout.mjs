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
const LABEL_BASELINE = 46;   // cell bottom -> label baseline
const ROW_ADVANCE = 110;     // cell bottom -> next row top (label strip + breathing room)
const BOTTOM_MARGIN = 64;    // below the last label baseline

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
 *                 labelX: number, labelY: number}>
 * }}
 */
export function pageLayout({ chart, count }) {
  if (!Number.isInteger(count) || count <= 0) throw new Error(`cell count must be a positive integer, got ${count}`);
  const { columns, rows, width_units: W, cell_aspect: aspect } = chart;
  const cap = columns * rows;
  if (count > cap) throw new Error(`page has ${count} cells but the ${columns}x${rows} grid holds ${cap}`);

  const cellW = Math.floor((W - 2 * M - (columns - 1) * CELL_GAP) / columns);
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
    });
  }

  const lastRowBottom = gridTop + (rowsUsed - 1) * (cellH + ROW_ADVANCE) + cellH;
  const height = lastRowBottom + LABEL_BASELINE + BOTTOM_MARGIN;

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
