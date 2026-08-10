// Rasterise a chart SVG and composite the photo cells over it, then encode the final JPEG. This
// module owns the sharp calls and nothing else: every coordinate it uses arrives precomputed
// (compositePlan from layout.mjs, coverCrop from crop.mjs) and is walked literally.
//
// Fontconfig MUST be configured before sharp is first imported (librsvg resolves the bundled
// Inter via fontconfig on first text layout and ignores @font-face), so sharp is loaded lazily
// behind setupFontconfig(), the same rig the size-chart renderer uses.

import { setupFontconfig } from '../../size-chart/lib/fontconfig.mjs';

let sharpPromise = null;
async function loadSharp() {
  if (!sharpPromise) {
    if (!process.env.FONTCONFIG_FILE) process.env.FONTCONFIG_FILE = setupFontconfig();
    sharpPromise = import('sharp').then((m) => m.default);
  }
  return sharpPromise;
}

/**
 * Crop and resize one working cell to its exact composite dimensions. Lossless PNG out, so the
 * only lossy encode in the pipeline is the final chart JPEG.
 * @param {object} input
 * @param {string | Buffer} input.source - working-cell JPEG path or buffer
 * @param {{left: number, top: number, width: number, height: number}} input.extract
 * @param {{width: number, height: number}} input.resize
 * @returns {Promise<Buffer>} PNG bytes sized exactly resize.width x resize.height
 */
export async function prepareCell({ source, extract, resize }) {
  const sharp = await loadSharp();
  return sharp(source)
    .extract(extract)
    .resize(resize.width, resize.height, { fit: 'fill' })
    .png()
    .toBuffer();
}

/**
 * Rasterise the SVG at 72 * scale density, composite the prepared cells at their planned pixel
 * offsets, and encode the chart JPEG (q85, mozjpeg, 4:4:4 chroma to keep fabric-texture edges).
 * @param {object} input
 * @param {string} input.svg - the chart SVG document
 * @param {number} input.scale - raster scale (chart.scale)
 * @param {Array<{data: Buffer, left: number, top: number}>} input.cells - prepared cell buffers
 *   with their compositePlan offsets
 * @param {number} [input.quality]
 * @returns {Promise<{data: Buffer, width: number, height: number}>}
 */
export async function renderChart({ svg, scale, cells, quality = 85 }) {
  const sharp = await loadSharp();
  const { data, info } = await sharp(Buffer.from(svg), { density: 72 * scale })
    .composite(cells.map((c) => ({ input: c.data, left: c.left, top: c.top })))
    .jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:4:4' })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * A downscaled proof of a rendered chart (the sample gate's ~400px mobile check).
 * @param {Buffer} data - chart JPEG bytes
 * @param {number} [width]
 * @returns {Promise<Buffer>} JPEG bytes
 */
export async function resizeProof(data, width = 400) {
  const sharp = await loadSharp();
  return sharp(data).resize(width).jpeg({ quality: 80 }).toBuffer();
}
