// Fabric-region detection and backdrop-contamination screening for the applique working cells.
// Pure math over raw pixel buffers: no sharp, no fs, no network, so every constant that decides
// where a crop lands is unit-testable. crops.mjs owns the decoding and the CLI.
//
// The proposal algorithm converged over one full operator run and two hard failures; both fixes
// are load-bearing and are pinned by autocrop.test.mjs rather than by a comment:
//
//   1. Each cue is normalized by its OWN 95th percentile, FLOORED. On an achromatic print (black
//      paws on white) the saturation p95 is chroma noise, so dividing by it amplified noise to 1
//      across the whole frame and the proposal became the entire photo. The floors are what stop
//      that; `satFloor: 0` reproduces the failure and the test asserts it.
//   2. Plain Otsu, with NO cap. `Math.min(otsu, 0.18)` was tried and reverted: it lowers the
//      threshold enough that a cream print's slightly-off-cream table crosses it and the box grabs
//      the backdrop. `otsuCap` stays an injectable parameter defaulting to null purely so the test
//      can drive the known-bad value; do not set it in production.
//
// Every constant below is an injectable parameter defaulting to the production value, so the tests
// can run each case twice (neutralized vs default) and assert what the constant actually prevents.

/** Production tuning. Override individual keys to run a differential. */
export const AUTOCROP_DEFAULTS = Object.freeze({
  grid: 200,          // work-grid side; a square here is a 3:4 box on the 1200x1600 cell
  sdRadius: 2,        // local-stddev window radius, in work-grid cells
  sdFloor: 8,         // p95 floor for the greyscale-stddev cue (0-255 scale)
  satFloor: 25,       // p95 floor for the saturation cue (0-255 scale)
  smoothRadius: 8,    // box-mean radius so sparse motifs fill their neighbourhood
  otsuCap: null,      // NEVER set in production; see the header
  erodeRadius: 2,     // erosion before the inscribed square, in work-grid cells
  inset: 0.05,        // fraction trimmed from each side of the square
  minSide: 10,        // squares below this many grid cells are "unresolvable"
  minSignal: 0.5,     // combined-cue p95 below this means there is nothing to find
});

/** Backdrop screening: 10x10 tiles of luminance stddev, flagged below this. */
export const SUSPECT_SD = 10;
export const SCAN_TILES = 10;

const LUMA = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

function assertImage(image, what = 'image') {
  if (!image || typeof image !== 'object') throw new Error(`${what} must be an object`);
  const { data, width, height, channels } = image;
  if (!Number.isInteger(width) || width <= 0) throw new Error(`${what}.width must be a positive integer`);
  if (!Number.isInteger(height) || height <= 0) throw new Error(`${what}.height must be a positive integer`);
  if (!Number.isInteger(channels) || channels < 3) throw new Error(`${what}.channels must be >= 3 (RGB or RGBA)`);
  if (!data || typeof data.length !== 'number') throw new Error(`${what}.data must be a byte buffer`);
  if (data.length < width * height * channels) {
    throw new Error(`${what}.data is ${data.length} bytes, expected at least ${width * height * channels}`);
  }
}

/**
 * Box-average the source into a square work grid, returning one greyscale and one saturation
 * value per grid cell. The grid is square over a portrait photo on purpose: a square in grid
 * space is a normalized square, which is the 3:4 pixel box the chart cells want.
 * @param {{data: ArrayLike<number>, width: number, height: number, channels: number}} image
 * @param {number} [grid]
 * @returns {{grid: number, grey: Float64Array, sat: Float64Array}}
 */
export function toWorkGrid(image, grid = AUTOCROP_DEFAULTS.grid) {
  assertImage(image);
  if (!Number.isInteger(grid) || grid < 4) throw new Error(`grid must be an integer >= 4, got ${grid}`);
  const { data, width, height, channels } = image;
  const grey = new Float64Array(grid * grid);
  const sat = new Float64Array(grid * grid);

  for (let gy = 0; gy < grid; gy++) {
    const y0 = Math.floor((gy * height) / grid);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / grid));
    for (let gx = 0; gx < grid; gx++) {
      const x0 = Math.floor((gx * width) / grid);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / grid));
      let sumL = 0;
      let sumS = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < height; y++) {
        let idx = (y * width + x0) * channels;
        for (let x = x0; x < x1 && x < width; x++, idx += channels) {
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          sumL += LUMA(r, g, b);
          sumS += Math.max(r, g, b) - Math.min(r, g, b);
          n++;
        }
      }
      const i = gy * grid + gx;
      grey[i] = n ? sumL / n : 0;
      sat[i] = n ? sumS / n : 0;
    }
  }
  return { grid, grey, sat };
}

// Summed-area table over a grid-sized field, with a zero-padded top/left border.
function integral(values, grid) {
  const sat = new Float64Array((grid + 1) * (grid + 1));
  for (let y = 0; y < grid; y++) {
    let rowSum = 0;
    for (let x = 0; x < grid; x++) {
      rowSum += values[y * grid + x];
      sat[(y + 1) * (grid + 1) + (x + 1)] = sat[y * (grid + 1) + (x + 1)] + rowSum;
    }
  }
  return sat;
}

function windowSum(sat, grid, x0, y0, x1, y1) {
  const w = grid + 1;
  return sat[(y1 + 1) * w + (x1 + 1)] - sat[y0 * w + (x1 + 1)] - sat[(y1 + 1) * w + x0] + sat[y0 * w + x0];
}

/**
 * Local standard deviation of a grid-shaped field over a (2r+1)^2 window, via summed-area tables
 * of the values and their squares (O(grid^2) regardless of radius).
 * @param {Float64Array} values
 * @param {number} grid
 * @param {number} [radius]
 * @returns {Float64Array}
 */
export function localStdDev(values, grid, radius = AUTOCROP_DEFAULTS.sdRadius) {
  if (!Number.isInteger(radius) || radius < 0) throw new Error(`radius must be a non-negative integer, got ${radius}`);
  const squares = new Float64Array(grid * grid);
  for (let i = 0; i < values.length; i++) squares[i] = values[i] * values[i];
  const sa = integral(values, grid);
  const sq = integral(squares, grid);
  const out = new Float64Array(grid * grid);
  for (let y = 0; y < grid; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(grid - 1, y + radius);
    for (let x = 0; x < grid; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(grid - 1, x + radius);
      const n = (x1 - x0 + 1) * (y1 - y0 + 1);
      const mean = windowSum(sa, grid, x0, y0, x1, y1) / n;
      const meanSq = windowSum(sq, grid, x0, y0, x1, y1) / n;
      out[y * grid + x] = Math.sqrt(Math.max(0, meanSq - mean * mean));
    }
  }
  return out;
}

/**
 * Box-mean smoothing over a (2r+1)^2 window. Radius 8 is what lets a sparse motif (a bee every
 * dozen grid cells) fill its neighbourhood before thresholding, instead of thresholding to
 * confetti that holds no inscribed square.
 * @param {Float64Array} values
 * @param {number} grid
 * @param {number} [radius]
 * @returns {Float64Array}
 */
export function boxMean(values, grid, radius = AUTOCROP_DEFAULTS.smoothRadius) {
  if (!Number.isInteger(radius) || radius < 0) throw new Error(`radius must be a non-negative integer, got ${radius}`);
  if (radius === 0) return Float64Array.from(values);
  const sa = integral(values, grid);
  const out = new Float64Array(grid * grid);
  for (let y = 0; y < grid; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(grid - 1, y + radius);
    for (let x = 0; x < grid; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(grid - 1, x + radius);
      const n = (x1 - x0 + 1) * (y1 - y0 + 1);
      out[y * grid + x] = windowSum(sa, grid, x0, y0, x1, y1) / n;
    }
  }
  return out;
}

/**
 * The p-th percentile of a field, nearest-rank on the sorted values.
 * @param {ArrayLike<number>} values
 * @param {number} p - 0..100
 * @returns {number}
 */
export function percentile(values, p) {
  if (!(Number.isFinite(p) && p >= 0 && p <= 100)) throw new Error(`percentile must be 0..100, got ${p}`);
  const n = values.length;
  if (!n) return 0;
  const sorted = Float64Array.from(values).sort();
  const idx = Math.min(n - 1, Math.max(0, Math.round((p / 100) * (n - 1))));
  return sorted[idx];
}

/**
 * Otsu's threshold over values already normalized to [0, 1], via a 256-bin histogram. A field with
 * no spread returns 0, which the caller's strict `> threshold` turns into "every cell" for a
 * uniformly textured frame and "no cells" for a uniformly flat one.
 * @param {ArrayLike<number>} values
 * @returns {number} threshold in [0, 1]
 */
export function otsuThreshold(values) {
  const bins = 256;
  const hist = new Float64Array(bins);
  for (let i = 0; i < values.length; i++) {
    const v = Math.min(1, Math.max(0, values[i]));
    hist[Math.min(bins - 1, Math.round(v * (bins - 1)))]++;
  }
  const total = values.length;
  if (!total) return 0;
  let sum = 0;
  for (let b = 0; b < bins; b++) sum += b * hist[b];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let b = 0; b < bins; b++) {
    wB += hist[b];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += b * hist[b];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) { bestVar = between; best = b; }
  }
  return best / (bins - 1);
}

/**
 * Chebyshev-radius erosion of a binary mask. Cells whose window leaves the frame erode away, so
 * the survivor set is pulled off the photo border, which is exactly where the fabric edge and the
 * backdrop meet.
 * @param {Uint8Array} mask
 * @param {number} grid
 * @param {number} [radius]
 * @returns {Uint8Array}
 */
export function erode(mask, grid, radius = AUTOCROP_DEFAULTS.erodeRadius) {
  if (!Number.isInteger(radius) || radius < 0) throw new Error(`radius must be a non-negative integer, got ${radius}`);
  if (radius === 0) return Uint8Array.from(mask);
  const ones = new Float64Array(grid * grid);
  for (let i = 0; i < mask.length; i++) ones[i] = mask[i] ? 1 : 0;
  const sa = integral(ones, grid);
  const out = new Uint8Array(grid * grid);
  const n = (2 * radius + 1) * (2 * radius + 1);
  for (let y = radius; y < grid - radius; y++) {
    for (let x = radius; x < grid - radius; x++) {
      out[y * grid + x] = windowSum(sa, grid, x - radius, y - radius, x + radius, y + radius) === n ? 1 : 0;
    }
  }
  return out;
}

/**
 * The largest axis-aligned square of set cells, by the standard DP. Ties resolve to the
 * topmost-then-leftmost square, so the result is deterministic.
 * @param {Uint8Array} mask
 * @param {number} grid
 * @returns {{row: number, col: number, side: number} | null} null when the mask is empty
 */
export function largestInscribedSquare(mask, grid) {
  const dp = new Int32Array(grid * grid);
  let best = 0;
  let bestBottom = -1;
  let bestRight = -1;
  for (let y = 0; y < grid; y++) {
    for (let x = 0; x < grid; x++) {
      const i = y * grid + x;
      if (!mask[i]) { dp[i] = 0; continue; }
      dp[i] = (y === 0 || x === 0) ? 1 : 1 + Math.min(dp[i - grid], dp[i - 1], dp[i - grid - 1]);
      if (dp[i] > best) { best = dp[i]; bestBottom = y; bestRight = x; }
    }
  }
  if (!best) return null;
  return { row: bestBottom - best + 1, col: bestRight - best + 1, side: best };
}

// Four decimals: finer than any crop an operator confirms by eye, and it keeps the registry diff
// readable. Rounding is toward zero on left/top and down on the size, so it can never push
// left+width past 1.
const round4 = (v) => Math.round(v * 1e4) / 1e4;

/**
 * Propose the fabric-region crop for one working cell.
 *
 * @param {{data: ArrayLike<number>, width: number, height: number, channels: number}} image -
 *   raw RGB(A) pixels of the working cell
 * @param {Partial<typeof AUTOCROP_DEFAULTS>} [options]
 * @returns {{left: number, top: number, width: number, height: number, size: number,
 *   diagnostics: {grid: number, side: number, threshold: number, coverage: number,
 *   sdP95: number, satP95: number}} | null}
 *   null is the deliberate sentinel for an unresolvable image (an all-flat cell, or a frame that is
 *   entirely backdrop). The gate table renders it as "manual crop required": a plausible-looking
 *   wrong box is worse than an admitted failure.
 */
export function proposeBox(image, options = {}) {
  const opts = { ...AUTOCROP_DEFAULTS, ...options };
  if (!(Number.isFinite(opts.inset) && opts.inset >= 0 && opts.inset < 0.5)) {
    throw new Error(`inset must be in [0, 0.5), got ${opts.inset}`);
  }
  const { grid, grey, sat } = toWorkGrid(image, opts.grid);

  // Two cues, each normalized by its OWN floored p95. The floor is the fix, not a detail.
  const sd = localStdDev(grey, grid, opts.sdRadius);
  const sdP95 = percentile(sd, 95);
  const satP95 = percentile(sat, 95);
  const sdDenom = Math.max(sdP95, opts.sdFloor, 1e-9);
  const satDenom = Math.max(satP95, opts.satFloor, 1e-9);

  const combined = new Float64Array(grid * grid);
  for (let i = 0; i < combined.length; i++) {
    combined[i] = Math.max(Math.min(1, sd[i] / sdDenom), Math.min(1, sat[i] / satDenom));
  }

  // Absolute-signal guard, and the second thing the floors buy. A frame that is entirely backdrop
  // still has sensor noise, and Otsu will happily split noise into a confident-looking blob. With
  // the floors in place a flat frame's combined cue never approaches 1, so this catches it; with
  // `sdFloor: 0` the same noise normalizes to 1 and a box is invented. Every real fabric photo
  // saturates at least one cue, so this is a wide margin, not a tuning knob.
  if (percentile(combined, 95) < opts.minSignal) return null;

  const smoothed = boxMean(combined, grid, opts.smoothRadius);
  let threshold = otsuThreshold(smoothed);
  if (opts.otsuCap !== null && Number.isFinite(opts.otsuCap)) threshold = Math.min(threshold, opts.otsuCap);

  const mask = new Uint8Array(grid * grid);
  let set = 0;
  for (let i = 0; i < smoothed.length; i++) {
    if (smoothed[i] > threshold) { mask[i] = 1; set++; }
  }

  const square = largestInscribedSquare(erode(mask, grid, opts.erodeRadius), grid);
  if (!square || square.side < opts.minSide) return null;

  const trim = square.side * opts.inset;
  const size = round4((square.side - 2 * trim) / grid);
  const left = round4((square.col + trim) / grid);
  const top = round4((square.row + trim) / grid);

  return {
    left: Math.min(left, 1 - size),
    top: Math.min(top, 1 - size),
    width: size,
    height: size,
    size,
    diagnostics: {
      grid,
      signal: round4(percentile(combined, 95)),
      side: square.side,
      threshold: round4(threshold),
      coverage: round4(set / (grid * grid)),
      sdP95: round4(sdP95),
      satP95: round4(satP95),
    },
  };
}

/**
 * Luminance standard deviation per tile over a normalized box, at FULL resolution. Split from
 * classifyTiles on purpose: this half needs pixels and runs at the gate, the pure half runs in CI
 * against committed matrices with no photos on disk.
 * @param {{data: ArrayLike<number>, width: number, height: number, channels: number}} image
 * @param {{left: number, top: number, width: number, height: number}} box - normalized
 * @param {number} [tiles]
 * @returns {number[]} tiles*tiles luminance stddevs, row-major
 */
export function tileStats(image, box, tiles = SCAN_TILES) {
  assertImage(image);
  if (!Number.isInteger(tiles) || tiles < 2) throw new Error(`tiles must be an integer >= 2, got ${tiles}`);
  if (!box || [box.left, box.top, box.width, box.height].some((v) => !Number.isFinite(v))) {
    throw new Error('box must have finite left/top/width/height');
  }
  const { data, width, height, channels } = image;
  const bx = Math.max(0, Math.floor(box.left * width));
  const by = Math.max(0, Math.floor(box.top * height));
  const bw = Math.max(tiles, Math.floor(box.width * width));
  const bh = Math.max(tiles, Math.floor(box.height * height));
  const out = [];
  for (let ty = 0; ty < tiles; ty++) {
    const y0 = by + Math.floor((ty * bh) / tiles);
    const y1 = Math.min(height, by + Math.floor(((ty + 1) * bh) / tiles));
    for (let tx = 0; tx < tiles; tx++) {
      const x0 = bx + Math.floor((tx * bw) / tiles);
      const x1 = Math.min(width, bx + Math.floor(((tx + 1) * bw) / tiles));
      let sum = 0;
      let sumSq = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        let idx = (y * width + x0) * channels;
        for (let x = x0; x < x1; x++, idx += channels) {
          const l = LUMA(data[idx], data[idx + 1], data[idx + 2]);
          sum += l;
          sumSq += l * l;
          n++;
        }
      }
      const mean = n ? sum / n : 0;
      out.push(n ? Math.sqrt(Math.max(0, sumSq / n - mean * mean)) : 0);
    }
  }
  return out;
}

/**
 * Screen a tile matrix for backdrop contamination. This is a SCREEN, never an oracle: a genuinely
 * flat area of fabric (a cream stripe) reads the same as a flat tabletop, and the calibration run
 * false-positived on exactly one. It tells the operator which tile to look at; the operator looks.
 * @param {ArrayLike<number>} matrix - tiles*tiles luminance stddevs, row-major
 * @param {{threshold?: number, tiles?: number}} [options]
 * @returns {{minSd: number, tile: number, row: number, col: number, edge: string, suspect: boolean}}
 */
export function classifyTiles(matrix, { threshold = SUSPECT_SD, tiles = SCAN_TILES } = {}) {
  if (!Array.isArray(matrix) && !ArrayBuffer.isView(matrix)) throw new Error('matrix must be an array of numbers');
  if (matrix.length !== tiles * tiles) {
    throw new Error(`matrix has ${matrix.length} entries, expected ${tiles * tiles}`);
  }
  let minSd = Infinity;
  let tile = -1;
  for (let i = 0; i < matrix.length; i++) {
    if (!Number.isFinite(matrix[i])) throw new Error(`matrix[${i}] is not a finite number`);
    if (matrix[i] < minSd) { minSd = matrix[i]; tile = i; }
  }
  const row = Math.floor(tile / tiles);
  const col = tile % tiles;
  const vertical = row === 0 ? 'top' : (row === tiles - 1 ? 'bottom' : '');
  const horizontal = col === 0 ? 'left' : (col === tiles - 1 ? 'right' : '');
  const edge = [vertical, horizontal].filter(Boolean).join('-') || 'interior';
  return { minSd, tile, row, col, edge, suspect: minSd < threshold };
}
