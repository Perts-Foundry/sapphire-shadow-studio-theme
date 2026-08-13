#!/usr/bin/env node
// Render labeled contact sheets (thumbnail grids) from a folder of photos, so a photo-review
// round reads ONE composite image per couple dozen frames instead of every frame full-size.
// Read-only over the inputs; writes only the sheet JPEGs, and only under a product-images/ path
// (the same containment guard the processor applies, so nothing unignored lands in the repo).
//
// Same rendering technique as the size-chart / applique renderers: sharp composite over a flat
// background, with SVG <text> labels. Labels are the file BASENAMES only, middle-truncated to
// fit; text visible inside the photos is never transcribed anywhere by this tool.
//
// Usage:
//   node scripts/contact-sheet.mjs --input-dir 'product-images/originals'
//   node scripts/contact-sheet.mjs --input-dir '<dir>' --out 'product-images/contact-sheets' \
//     --columns 4 --cell 480

import sharp from 'sharp';
import { readdir, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { underProductImages } from './process-product-images.mjs';
import { decodeToSrgb, sharpFromDecoded } from './lib/heic.mjs';

// .heic is included because selection runs on the ORIGINALS, and an iPhone batch is all HEIC.
// A sheet that could not read the very inputs the pipeline ingests natively would send the review
// round back to reading every frame full-size, which is what this tool exists to avoid.
const INPUT_EXTS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.heic']);
const PER_SHEET = 24; // frames per sheet; keeps a 4-column sheet at 6 rows, readable in one view
const LABEL_HEIGHT = 40;
const LABEL_MAX_CHARS = 44;

// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { in: 'product-images/originals', out: 'product-images/contact-sheets', columns: 4, cell: 480 };
  const alias = { 'input-dir': 'in' };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith('--')) continue;
    a = a.slice(2);
    let val;
    const eq = a.indexOf('=');
    if (eq !== -1) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    const key = alias[a] || a;
    if (key === 'columns' || key === 'cell') {
      const raw = val ?? argv[++i];
      if (raw === undefined) throw new Error(`Missing value for --${a}`);
      opts[key] = Number(raw);
    } else if (key in opts) {
      const raw = val ?? argv[++i];
      if (raw === undefined) throw new Error(`Missing value for --${a}`);
      opts[key] = raw;
    } else {
      throw new Error(`Unknown option --${a}`);
    }
  }
  if (!Number.isInteger(opts.columns) || opts.columns < 1) throw new Error('--columns must be a positive integer');
  if (!Number.isInteger(opts.cell) || opts.cell < 64) throw new Error('--cell must be an integer >= 64');
  return opts;
}

// ---------------------------------------------------------------------------
// Pure planning: split the file list into sheets and give each its grid geometry. Exported for
// unit tests. An empty list yields an empty plan (the CLI turns that into an error).
// ---------------------------------------------------------------------------
export function planSheet(files, columns = 4, perSheet = PER_SHEET) {
  if (!Number.isInteger(columns) || columns < 1) throw new Error('columns must be a positive integer');
  if (!Number.isInteger(perSheet) || perSheet < 1) throw new Error('perSheet must be a positive integer');
  if (!Array.isArray(files) || files.length === 0) return [];
  const sheets = [];
  for (let i = 0; i < files.length; i += perSheet) {
    const chunk = files.slice(i, i + perSheet);
    sheets.push({
      index: sheets.length,
      files: chunk,
      columns: Math.min(columns, chunk.length),
      rows: Math.ceil(chunk.length / columns),
    });
  }
  return sheets;
}

// Middle-truncate a label so a long filename stays identifiable at both ends. Exported for tests.
export function labelFor(name, maxChars = LABEL_MAX_CHARS) {
  const s = String(name ?? '');
  if (s.length <= maxChars) return s;
  const keep = maxChars - 3;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${s.slice(0, head)}...${s.slice(s.length - tail)}`;
}

const escapeXml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// ---------------------------------------------------------------------------
// Render one sheet: thumbnails laid out row-major on white, each with its basename underneath.
// filePaths are absolute (or cwd-relative) paths; layout columns come from the plan.
// ---------------------------------------------------------------------------
// A sharp instance for one input frame. sharp/libvips cannot decode iPhone tiled HEICs (the same
// "bad seek" the shared decoder documents), so those route through the WASM bridge, which drops
// the container's ICC profile. These thumbnails exist for the operator to judge frames BY EYE, so
// they go through the same decodeToSrgb the processor uses rather than showing Display P3 numbers
// read as sRGB: the sheet a photo is picked from should not be duller than the photo. It costs one
// full-size profile conversion per frame, which is seconds on a proofing run that already decodes
// every original. Raw pixels carry no EXIF, so .rotate() is a no-op on that path and the decoder's
// own orientation handling stands.
async function frameSharp(filePath) {
  if (path.extname(filePath).toLowerCase() !== '.heic') return sharp(filePath).rotate();
  return sharpFromDecoded(await decodeToSrgb(await readFile(filePath)));
}

export async function renderSheet(filePaths, outPath, { columns = 4, cell = 480 } = {}) {
  if (!filePaths.length) throw new Error('renderSheet needs at least one file');
  const gridCols = Math.min(columns, filePaths.length);
  const gridRows = Math.ceil(filePaths.length / columns);
  const width = gridCols * cell;
  const height = gridRows * (cell + LABEL_HEIGHT);
  const composites = [];
  for (let i = 0; i < filePaths.length; i++) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const thumb = await (await frameSharp(filePaths[i]))
      .resize(cell, cell, { fit: 'inside', withoutEnlargement: false })
      .jpeg()
      .toBuffer({ resolveWithObject: true });
    composites.push({
      input: thumb.data,
      left: col * cell + Math.round((cell - thumb.info.width) / 2),
      top: row * (cell + LABEL_HEIGHT) + Math.round((cell - thumb.info.height) / 2),
    });
    const text = escapeXml(labelFor(path.basename(filePaths[i])));
    const svg = `<svg width="${cell}" height="${LABEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
      `<text x="${cell / 2}" y="${LABEL_HEIGHT / 2 + 5}" text-anchor="middle" ` +
      `font-family="DejaVu Sans, Arial, sans-serif" font-size="15" fill="#222222">${text}</text></svg>`;
    composites.push({ input: Buffer.from(svg), left: col * cell, top: row * (cell + LABEL_HEIGHT) + cell });
  }
  await sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .composite(composites)
    .jpeg({ quality: 80, mozjpeg: true })
    .toFile(outPath);
  return { width, height, count: filePaths.length };
}

// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const inDir = path.resolve(opts.in);
  const outDir = path.resolve(opts.out);
  if (!underProductImages(outDir)) {
    throw new Error(`--out must be under a 'product-images/' directory (got ${outDir}); refusing to write elsewhere.`);
  }

  let entries;
  try {
    entries = await readdir(inDir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`Cannot read --input-dir '${inDir}': ${e.message}`);
  }
  const files = entries
    .filter((e) => e.isFile() && !e.name.includes(':') && INPUT_EXTS.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort();

  const sheets = planSheet(files, opts.columns);
  if (!sheets.length) throw new Error(`No supported images (${[...INPUT_EXTS].join(', ')}) in ${inDir}`);

  await mkdir(outDir, { recursive: true });
  for (const s of sheets) {
    const outPath = path.join(outDir, `contact-sheet-${s.index + 1}.jpg`);
    const { width, height, count } = await renderSheet(
      s.files.map((f) => path.join(inDir, f)),
      outPath,
      { columns: opts.columns, cell: opts.cell },
    );
    console.log(`wrote ${outPath}  (${count} thumbnails, ${width}x${height})`);
  }
  console.log(`${sheets.length} sheet(s) from ${files.length} image(s).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`Fatal: ${e.message}`); process.exitCode = 1; });
}
