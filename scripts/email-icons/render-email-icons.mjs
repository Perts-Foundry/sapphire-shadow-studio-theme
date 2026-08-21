#!/usr/bin/env node
// Rasterise the three social icons used by the Shopify Email templates into committed PNGs.
//
// Email clients do not render SVG, so the icon row in `marketing/emails/*.liquid` needs hosted
// raster files. The PNGs are committed under `marketing/emails/assets/` so the repo records exactly
// what was uploaded to Shopify Files; `upload-email-icons.mjs` is the (gated) step that puts them
// there. Nothing in the theme reads these files.
//
// They render at 28 CSS px in the email and are emitted at 2x (56 px) for retina, matching the
// `width`/`height` attributes in the templates.
//
// Pipeline mirrors `scripts/size-chart/render-size-chart.mjs`: build the SVG in a pure module, then
// rasterise with sharp. No fontconfig here, since the glyphs are paths and there is no text.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { BODY } from '../size-chart/lib/svg-shared.mjs';
import { ICON_NAMES, buildIconSvg } from './lib/icons.mjs';

const DEFAULT_OUT_DIR = 'marketing/emails/assets';
const DEFAULT_SIZE = 56; // 2x the 28 px display size in the templates
const FILE_PREFIX = 'email-icon-';

export function fileNameFor(name) {
  return `${FILE_PREFIX}${name}.png`;
}

function parseArgs(argv) {
  const opts = { outDir: DEFAULT_OUT_DIR, size: DEFAULT_SIZE, fill: BODY };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith('--')) continue;
    a = a.slice(2);
    let val;
    const eq = a.indexOf('=');
    if (eq !== -1) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    const key = a === 'out-dir' ? 'outDir' : a;
    if (key === 'size') { opts.size = Number(val ?? argv[++i]); continue; }
    if (key === 'outDir' || key === 'fill') { opts[key] = val ?? argv[++i]; continue; }
    throw new Error(`Unknown option --${a}`);
  }
  if (!Number.isFinite(opts.size) || opts.size < 8) throw new Error('--size must be a number >= 8');
  return opts;
}

/**
 * Rasterise one icon to a PNG buffer.
 * @param {string} name
 * @param {object} [opts]
 * @param {number} [opts.size] - output edge in pixels (square)
 * @param {string} [opts.fill] - glyph colour
 * @returns {Promise<Buffer>}
 */
export async function renderIconPng(name, opts = {}) {
  const { size = DEFAULT_SIZE, fill = BODY } = opts;
  const svg = buildIconSvg(name, { fill });
  // density scales librsvg's rasterisation of the 20x20 artboard up to `size` without resampling.
  return sharp(Buffer.from(svg), { density: (72 * size) / 20 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await mkdir(opts.outDir, { recursive: true });
  for (const name of ICON_NAMES) {
    const buf = await renderIconPng(name, { size: opts.size, fill: opts.fill });
    const out = path.join(opts.outDir, fileNameFor(name));
    await writeFile(out, buf);
    console.log(`${out}  ${opts.size}x${opts.size}  ${buf.length} bytes`);
  }
  console.log('\nNext: upload with scripts/email-icons/upload-email-icons.mjs, then paste the');
  console.log('returned CDN URLs into both templates and record them in marketing/emails/README.md.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
