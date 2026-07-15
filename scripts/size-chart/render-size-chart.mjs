#!/usr/bin/env node
// Render a branded size-chart PNG from a profile, for manual upload to a product's Shopify gallery.
//
// Pipeline: load + validate profile -> build the navy/sapphire SVG (lib/render-svg.mjs) -> rasterise
// to PNG with sharp. The font is the bundled Inter, resolved via a runtime fontconfig file that MUST
// be set before sharp loads (librsvg reads fontconfig on first text layout, and ignores @font-face).
//
// It does NOT upload to Shopify (the Shopify MCP has no media-upload capability; the Admin token is
// themes-only). Upload + alt text are manual in Shopify Admin. Mirrors process-product-images.mjs:
// output is guarded to a product-images/ path so no image binaries land in the public repo.

import { readFile } from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProfile } from './lib/profile-schema.mjs';
import { readCopy } from './lib/copy.mjs';
import { buildSvg, CANVAS } from './lib/render-svg.mjs';
import { setupFontconfig } from './lib/fontconfig.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = path.join(HERE, 'profiles');
const DEFAULT_OUT_DIR = 'product-images/processed';
const SCALE = 2; // render at 2x the 1600x2000 canvas for a crisp gallery image (3200x4000)

function parseArgs(argv) {
  const opts = { profile: null, out: null, outDir: DEFAULT_OUT_DIR, scale: SCALE };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith('--')) continue;
    a = a.slice(2);
    let val;
    const eq = a.indexOf('=');
    if (eq !== -1) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    if (a === 'scale') { opts.scale = Number(val ?? argv[++i]); continue; }
    if (['profile', 'out', 'outDir', 'out-dir'].includes(a)) {
      const key = a === 'out-dir' ? 'outDir' : a;
      opts[key] = val ?? argv[++i];
      continue;
    }
    throw new Error(`Unknown option --${a}`);
  }
  if (!opts.profile) throw new Error('Missing --profile <blank_id | path-to-profile.json>');
  if (!Number.isFinite(opts.scale) || opts.scale < 1) throw new Error('--scale must be a number >= 1');
  return opts;
}

async function loadProfile(ref) {
  const p = ref.endsWith('.json') ? path.resolve(ref) : path.join(PROFILES_DIR, `${ref}.json`);
  let json;
  try {
    json = JSON.parse(await readFile(p, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read profile '${ref}' (${p}): ${e.message}`);
  }
  validateProfile(json);
  return json;
}

export function altText(profile) {
  return `${profile.display_name} size guide: chest circumference and laid-flat width, body length, `
    + `shoulder width, and sleeve length in inches and centimeters for sizes ${profile.sizes.join(', ')}.`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const outDir = path.resolve(opts.outDir);
  if (!/(^|[\\/])product-images([\\/]|$)/.test(outDir)) {
    throw new Error(`--out-dir must be under a 'product-images/' directory (got ${outDir}); refusing to write elsewhere.`);
  }

  const profile = await loadProfile(opts.profile);
  const { pngLegend } = readCopy();
  const svg = buildSvg(profile, pngLegend);

  // Fontconfig must be configured before sharp is imported/initialised.
  process.env.FONTCONFIG_FILE = setupFontconfig();
  const { default: sharp } = await import('sharp');

  const outPath = opts.out
    ? path.resolve(opts.out)
    : path.join(outDir, `size-chart-${profile.blank_id}.png`);
  if (!/(^|[\\/])product-images([\\/]|$)/.test(outPath)) {
    throw new Error(`--out must be under a 'product-images/' directory (got ${outPath}).`);
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  const { data, info } = await sharp(Buffer.from(svg), {
    density: 72 * opts.scale, // scale the SVG's user units for a higher-resolution raster
  })
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true });
  await writeFile(outPath, data);

  console.log(`Wrote ${outPath}  (${info.width}x${info.height}, ${Math.round(data.length / 1024)} KB)`);
  console.log(`Alt text: ${altText(profile)}`);
  console.log('Next: upload this image to the product gallery in Shopify Admin and set the alt text above.');
}

main().catch((e) => { console.error(`Fatal: ${e.message}`); process.exitCode = 1; });
