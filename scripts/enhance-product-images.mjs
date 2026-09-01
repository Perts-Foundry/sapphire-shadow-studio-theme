// Studio enhance pass: raw white-backdrop phone shots -> site-standard product images.
//
// Target and assertions come from docs/product-photo-style.md (the machine spec). The live
// catalogue's professional media is 4000x4000, background knocked out to pure 255 white with the
// soft contact shadow retained, garment centered with ~8-14% margins; this script reproduces that
// deterministically: white-balance and exposure from the measured backdrop, a border-seeded
// background mask, shadow retention confined to a band around the garment, centered square crop.
//
// It sits BEFORE scripts/process-product-images.mjs in the pipeline: raw shots come out of
// product-images/originals-raw/ (or --input-dir) and enhanced JPEGs land in a timestamped batch
// under product-images/enhanced/, from where the operator (after the review gate in the
// product-images skill) moves keepers into product-images/originals/ for the normal
// process -> alt -> upload flow. Everything under /product-images/ is gitignored and a CI guard
// (tracked-media guard in validate.yml) fails the build if any of it, or any .heic anywhere, is
// ever tracked: raw phone shots can carry EXIF/GPS and this is a public repo.
//
// Metadata: the output carries NO EXIF (sharp strips everything unless asked to keep it, and the
// HEIC decode path never had it: heic-decode returns bare pixels). Asserted per file, not assumed.
//
// Determinism: every parameter that shaped an output (measured backdrop, gains, mask tolerance,
// shadow floor, crop box) is persisted to enhance-params.json next to the outputs. A re-run over
// the same batch dir reuses the stored parameters verbatim, so it reproduces the same bytes
// instead of re-deriving from the source; delete a file's entry to re-derive it.
//
// Per-image failure never aborts the batch: an image that cannot meet the REQUIRED spec rows is
// reported as FLAGGED (with the failing check) and no output is written for it; the fix is a
// reshoot or hand retouch, per the style doc's disqualifier list.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';
import { decodeToSrgb } from './lib/heic.mjs';

export const ENHANCE_VERSION = 1;

export const SPEC = {
  canvas: 4000,
  jpegQuality: 90,
  // Bounding-box inset per side, as a fraction of the canvas. marginTarget is what the crop is
  // built to; the min/max pair is what the acceptance check allows.
  marginTarget: 0.11,
  marginMin: 0.08,
  marginMax: 0.14,
  centerTolerance: 0.02,
  // A background pixel at or above this luminance (after exposure lift) becomes pure white; below
  // it, inside the shadow band, it is kept as contact shadow.
  shadowFloor: 247,
  // Shadow-exempt band around the garment silhouette, fraction of canvas width.
  shadowBand: 0.03,
  // Backdrop-similarity tolerance for the flood fill, per channel around the measured backdrop.
  maskTolerance: 34,
  // Analysis (mask) resolution cap. Masks are computed downscaled and upscaled with smooth
  // interpolation, which is also what feathers the composite edge.
  analysisMax: 1200,
  cornerPatch: 100,
};

const INPUT_EXTS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.heic']);

/** Load any accepted source as opaque sRGB raw pixels. HEIC goes through the shared decoder
 * (sharp's libvips cannot read the iPhone tiled HEICs; see scripts/lib/heic.mjs). */
export async function loadSrgbRaw(srcPath, opts = {}) {
  if (path.extname(srcPath).toLowerCase() === '.heic') {
    const decoded = await decodeToSrgb(fs.readFileSync(srcPath), opts);
    return { data: decoded.data, width: decoded.width, height: decoded.height, colorNote: decoded.colorNote };
  }
  const { data, info } = await sharp(srcPath)
    .rotate() // bake EXIF orientation into pixels before EXIF is dropped
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, colorNote: 'sharp-imported profile -> sRGB' };
}

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Median RGB of the border ring (outer 5% per side). The backdrop estimate that white balance,
 * exposure and the mask tolerance all key off. */
export function estimateBackdrop({ data, width, height }) {
  const ring = Math.max(2, Math.round(Math.min(width, height) * 0.05));
  const ch = [[], [], []];
  const push = (x, y) => {
    const i = (y * width + x) * 3;
    ch[0].push(data[i]); ch[1].push(data[i + 1]); ch[2].push(data[i + 2]);
  };
  for (let y = 0; y < height; y++) {
    const edgeRow = y < ring || y >= height - ring;
    for (let x = 0; x < width; x++) {
      if (edgeRow || x < ring || x >= width - ring) push(x, y);
    }
  }
  const median = (a) => { a.sort((p, q) => p - q); return a[Math.floor(a.length / 2)]; };
  return [median(ch[0]), median(ch[1]), median(ch[2])];
}

/** Per-channel gains that move the measured backdrop to pure white; this is white balance and
 * exposure lift in one step. Clamped: a gain this large means the shot is underexposed beyond
 * rescue and the caller flags it instead. */
export function backdropGains(backdrop) {
  return backdrop.map((v) => Math.min(255 / Math.max(v, 1), 1.8));
}

/**
 * Border-seeded background mask on the (gained) analysis image. BFS from every border pixel over
 * backdrop-similar pixels; anything unreached is garment. Returns Uint8Array 1=background.
 * Seeded from the border rather than thresholded globally so a white or light-grey garment region
 * (thread, tags) that is not connected to the border stays garment.
 */
export function backgroundMask({ data, width, height }, tolerance) {
  const mask = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const isBg = (i) => {
    const p = i * 3;
    // Backdrop-similar after gains means near-white OR a plausible neutral shadow on the backdrop
    // (dark but unsaturated). Saturated or truly dark pixels are garment.
    const r = data[p]; const g = data[p + 1]; const b = data[p + 2];
    const mx = Math.max(r, g, b); const mn = Math.min(r, g, b);
    const nearWhite = mn >= 255 - tolerance;
    const neutralShadow = mx - mn <= 24 && mn >= 90;
    return nearWhite || neutralShadow;
  };
  const seed = (i) => {
    if (!mask[i] && isBg(i)) { mask[i] = 1; queue[tail++] = i; }
  };
  for (let x = 0; x < width; x++) { seed(x); seed((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { seed(y * width); seed(y * width + width - 1); }
  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    const y = (i / width) | 0;
    if (x > 0) seed(i - 1);
    if (x < width - 1) seed(i + 1);
    if (y > 0) seed(i - width);
    if (y < height - 1) seed(i + width);
  }
  return mask;
}

/** Bounding box of garment pixels (mask 0) in analysis coordinates, or null if none. */
export function garmentBBox(mask, width, height) {
  let minX = width; let minY = height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

/** Chebyshev-distance dilation of the garment (mask 0) by `radius` px, iterative 4-neighbour
 * passes; cheap and adequate at analysis scale. Returns Uint8Array 1=within band of garment. */
export function dilateGarment(mask, width, height, radius) {
  let cur = Uint8Array.from(mask, (v) => (v ? 0 : 1));
  for (let r = 0; r < radius; r++) {
    const next = Uint8Array.from(cur);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (cur[i]) continue;
        if ((x > 0 && cur[i - 1]) || (x < width - 1 && cur[i + 1]) ||
            (y > 0 && cur[i - width]) || (y < height - 1 && cur[i + width])) next[i] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

/**
 * Alpha plan at analysis scale: 255 = keep source pixel, 0 = pure white. Garment keeps fully;
 * background inside the shadow band keeps proportionally to how far below the shadow floor it
 * sits (that is the contact shadow); background outside the band, and background at or above the
 * floor, goes to white.
 */
export function alphaPlan(gained, mask, band, spec) {
  const { width, height, data } = gained;
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    if (!mask[i]) { alpha[i] = 255; continue; }
    if (!band[i]) continue;
    const p = i * 3;
    const l = lum(data[p], data[p + 1], data[p + 2]);
    if (l >= spec.shadowFloor) continue;
    alpha[i] = Math.min(255, Math.round((spec.shadowFloor - l) * 4));
  }
  return alpha;
}

/** Centered square crop box (in full-res source coordinates, may extend beyond the source; the
 * overhang is padded white) sized so the garment bbox lands at marginTarget per side. */
export function cropBox(bboxFull, spec, srcW, srcH) {
  const bw = bboxFull.maxX - bboxFull.minX + 1;
  const bh = bboxFull.maxY - bboxFull.minY + 1;
  const side = Math.round(Math.max(bw, bh) / (1 - 2 * spec.marginTarget));
  const cx = (bboxFull.minX + bboxFull.maxX) / 2;
  const cy = (bboxFull.minY + bboxFull.maxY) / 2;
  return { left: Math.round(cx - side / 2), top: Math.round(cy - side / 2), side, srcW, srcH };
}

/** Composite gained pixels over white through the alpha, crop/pad to the square box, resize to
 * canvas, encode. Returns the JPEG buffer. */
async function renderOutput(gained, alphaFull, box, spec) {
  const { width, height, data } = gained;
  const out = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const a = alphaFull[i] / 255;
    const p = i * 3;
    out[p] = Math.round(data[p] * a + 255 * (1 - a));
    out[p + 1] = Math.round(data[p + 1] * a + 255 * (1 - a));
    out[p + 2] = Math.round(data[p + 2] * a + 255 * (1 - a));
  }
  // Intersect the crop box with the source; pad the overhang with white via extend.
  const left = Math.max(box.left, 0);
  const top = Math.max(box.top, 0);
  const right = Math.min(box.left + box.side, width);
  const bottom = Math.min(box.top + box.side, height);
  return sharp(out, { raw: { width, height, channels: 3 } })
    .extract({ left, top, width: right - left, height: bottom - top })
    .extend({
      left: left - box.left,
      top: top - box.top,
      right: box.left + box.side - right,
      bottom: box.top + box.side - bottom,
      background: { r: 255, g: 255, b: 255 },
    })
    .resize(spec.canvas, spec.canvas, { fit: 'fill' })
    .jpeg({ quality: spec.jpegQuality, progressive: true })
    .toBuffer();
}

/** REQUIRED-row acceptance checks from the style doc, measured on the encoded output. Returns a
 * list of failure strings, empty on pass. */
export async function acceptanceFailures(jpeg, spec) {
  const failures = [];
  const meta = await sharp(jpeg).metadata();
  if (meta.width !== spec.canvas || meta.height !== spec.canvas) {
    failures.push(`canvas ${meta.width}x${meta.height}, expected ${spec.canvas}x${spec.canvas}`);
  }
  if (meta.exif) failures.push('EXIF present in output');
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const patch = spec.cornerPatch;
  const corners = [[0, 0], [w - patch, 0], [0, info.height - patch], [w - patch, info.height - patch]];
  for (const [cx, cy] of corners) {
    let bad = 0;
    for (let y = cy; y < cy + patch; y++) {
      for (let x = cx; x < cx + patch; x++) {
        const p = (y * w + x) * 3;
        // JPEG ringing allowance: the spec is 255, the codec is lossy. 254+ on every channel of
        // every corner pixel still reads as pure white and survives Shopify's re-encode.
        if (data[p] < 254 || data[p + 1] < 254 || data[p + 2] < 254) bad++;
      }
    }
    if (bad > 0) failures.push(`corner patch at ${cx},${cy}: ${bad} non-white px`);
  }
  // Margin + centering, measured: bbox of clearly-garment pixels (dark enough to be neither
  // background nor retained shadow).
  let minX = w; let minY = info.height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 3;
      if (lum(data[p], data[p + 1], data[p + 2]) < 200) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) {
    failures.push('no garment pixels found in output');
    return failures;
  }
  const insets = [minX / w, minY / info.height, (w - 1 - maxX) / w, (info.height - 1 - maxY) / info.height];
  // The crop is built to marginTarget on the long axis; the short axis sits deeper by geometry,
  // so only the tightest inset is spec-bounded and the rest must merely not crowd the edge.
  const tightest = Math.min(...insets);
  if (tightest < spec.marginMin - 0.005 || tightest > spec.marginMax + 0.005) {
    failures.push(`tightest margin ${(tightest * 100).toFixed(1)}%, spec ${spec.marginMin * 100}-${spec.marginMax * 100}%`);
  }
  const ccx = (minX + maxX) / 2 / w - 0.5;
  const ccy = (minY + maxY) / 2 / info.height - 0.5;
  if (Math.abs(ccx) > spec.centerTolerance || Math.abs(ccy) > spec.centerTolerance) {
    failures.push(`centering off by ${(ccx * 100).toFixed(1)}%,${(ccy * 100).toFixed(1)}%`);
  }
  return failures;
}

/**
 * Enhance one source file. Returns {status: 'ok'|'flagged', params, failures?, outPath?}.
 * `storedParams` (from the sidecar) short-circuits derivation for deterministic re-runs.
 */
export async function enhanceFile(srcPath, outDir, { spec = SPEC, storedParams = null, decode } = {}) {
  const src = await loadSrgbRaw(srcPath, decode ? { decode } : {});
  const scale = Math.min(1, spec.analysisMax / Math.max(src.width, src.height));
  const aw = Math.max(1, Math.round(src.width * scale));
  const ah = Math.max(1, Math.round(src.height * scale));

  const params = storedParams ?? {};
  if (!storedParams) {
    const analysisRaw = await sharp(src.data, { raw: { width: src.width, height: src.height, channels: 3 } })
      .resize(aw, ah, { fit: 'fill' }).raw().toBuffer();
    params.backdrop = estimateBackdrop({ data: analysisRaw, width: aw, height: ah });
    params.gains = backdropGains(params.backdrop);
    params.maskTolerance = spec.maskTolerance;
    params.shadowFloor = spec.shadowFloor;
    params.marginTarget = spec.marginTarget;
    params.version = ENHANCE_VERSION;
    params.colorNote = src.colorNote;
  }
  const runSpec = { ...spec, shadowFloor: params.shadowFloor, marginTarget: params.marginTarget };

  if (Math.max(...params.gains) >= 1.8) {
    return { status: 'flagged', params, failures: ['backdrop too dark for exposure lift (gain clamp hit); reshoot with more light'] };
  }

  // Gain applied once at full resolution; the analysis copy is a downscale of the SAME gained
  // pixels so the mask thresholds see what the composite sees.
  const gainedFull = await sharp(src.data, { raw: { width: src.width, height: src.height, channels: 3 } })
    .linear(params.gains, [0, 0, 0]).raw().toBuffer();
  const gained = { data: gainedFull, width: src.width, height: src.height };
  const gainedAnalysis = {
    data: await sharp(gainedFull, { raw: { width: src.width, height: src.height, channels: 3 } })
      .resize(aw, ah, { fit: 'fill' }).raw().toBuffer(),
    width: aw,
    height: ah,
  };

  const mask = backgroundMask(gainedAnalysis, params.maskTolerance);
  const bbox = garmentBBox(mask, aw, ah);
  if (!bbox) return { status: 'flagged', params, failures: ['no garment found (whole frame reads as backdrop)'] };
  const touches = bbox.minX === 0 || bbox.minY === 0 || bbox.maxX === aw - 1 || bbox.maxY === ah - 1;
  if (touches) return { status: 'flagged', params, failures: ['garment touches the frame edge; reshoot with more room'] };

  const bandRadius = Math.max(1, Math.round(runSpec.shadowBand * aw));
  const band = dilateGarment(mask, aw, ah, bandRadius);
  const alphaA = alphaPlan(gainedAnalysis, mask, band, runSpec);
  // Upscaling the alpha with smooth interpolation IS the edge feather; a small blur on top keeps
  // fleece edges from aliasing.
  // extractChannel pins the output to one channel: sharp promotes 1-channel raw to 3 on
  // resize, which would silently break the alpha indexing in the composite.
  const alphaFull = await sharp(Buffer.from(alphaA), { raw: { width: aw, height: ah, channels: 1 } })
    .resize(src.width, src.height, { fit: 'fill' }).blur(1.2).extractChannel(0).raw().toBuffer();

  const toFull = (v, axis) => Math.round(v / scale);
  const bboxFull = {
    minX: toFull(bbox.minX), minY: toFull(bbox.minY),
    maxX: Math.min(src.width - 1, toFull(bbox.maxX + 1)), maxY: Math.min(src.height - 1, toFull(bbox.maxY + 1)),
  };
  params.cropBox = storedParams?.cropBox ?? cropBox(bboxFull, runSpec, src.width, src.height);

  const jpeg = await renderOutput(gained, alphaFull, params.cropBox, runSpec);
  const failures = await acceptanceFailures(jpeg, runSpec);
  if (failures.length > 0) return { status: 'flagged', params, failures };

  const outPath = path.join(outDir, `${path.basename(srcPath, path.extname(srcPath))}.jpg`);
  fs.writeFileSync(outPath, jpeg);
  return { status: 'ok', params, outPath };
}

const guardOutDir = (dir) => {
  const rel = path.relative(process.cwd(), path.resolve(dir));
  if (!(rel === 'product-images' || rel.startsWith(`product-images${path.sep}`))) {
    throw new Error(`refusing to write outside product-images/: ${dir}`);
  }
};

export function readSidecar(outDir) {
  const p = path.join(outDir, 'enhance-params.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { version: ENHANCE_VERSION, images: {} };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (args.includes('--help')) {
    console.log(`Usage: node scripts/enhance-product-images.mjs [--input-dir <dir>] [--out <dir> | --new-batch]
Raw white-backdrop shots -> site-standard 4000x4000 pure-white JPEGs (docs/product-photo-style.md).
  --input-dir  source folder (default product-images/originals-raw)
  --new-batch  write into a fresh product-images/enhanced/<timestamp>/ (prints the path)
  --out        write into an existing batch dir; reuses its enhance-params.json for determinism`);
    return;
  }
  const inputDir = flag('--input-dir') ?? path.join('product-images', 'originals-raw');
  let outDir = flag('--out');
  if (!outDir || args.includes('--new-batch')) {
    outDir = path.join('product-images', 'enhanced', new Date().toISOString().replace(/[:.]/g, '-'));
  }
  guardOutDir(outDir);
  fs.mkdirSync(outDir, { recursive: true });

  const files = fs.readdirSync(inputDir).filter((f) => INPUT_EXTS.has(path.extname(f).toLowerCase())).sort();
  if (files.length === 0) {
    console.error(`No input images in ${inputDir}`);
    process.exitCode = 1;
    return;
  }
  const sidecar = readSidecar(outDir);
  let flagged = 0;
  for (const f of files) {
    const stored = sidecar.images[f] ?? null;
    let result;
    try {
      result = await enhanceFile(path.join(inputDir, f), outDir, { storedParams: stored });
    } catch (err) {
      result = { status: 'flagged', params: stored ?? {}, failures: [`error: ${err.message}`] };
    }
    sidecar.images[f] = result.params;
    if (result.status === 'ok') {
      console.log(`ok      ${f} -> ${result.outPath}`);
    } else {
      flagged++;
      console.log(`FLAGGED ${f}: ${result.failures.join('; ')}`);
    }
  }
  fs.writeFileSync(path.join(outDir, 'enhance-params.json'), `${JSON.stringify(sidecar, null, 2)}\n`);
  console.log(`batch ${outDir}: ${files.length - flagged} ok, ${flagged} flagged`);
  if (flagged > 0) process.exitCode = 2;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (invokedDirectly) await main();
