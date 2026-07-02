#!/usr/bin/env node
// Batch-process raw product photos into Shopify-upload-ready JPEGs.
//
// Reads every image in --in, downscales to a web-friendly size, colour-manages to true
// sRGB, re-encodes, gives each file a clean kebab-case name, and writes the results plus a
// manifest.csv to --out. Originals are never touched; the script only reads them.
//
// It does NOT upload to Shopify (the Shopify MCP has no media-upload capability, and the
// Admin token in this repo is themes-only). Upload + per-variant assignment is manual in
// Shopify Admin; manifest.csv is the operator's mapping aid.
//
// Why these choices (see scripts/README.md for the full rationale):
//   - long edge <= 4000px: the theme's PDP gallery requests up to width:3840, and 4000px
//     keeps every result under Shopify's 20-megapixel upload cap (4000x4000 = 16MP).
//   - mozjpeg quality ~85, chroma 4:4:4: the product is fine coloured embroidery text on
//     fabric; the default 4:2:0 subsampling smears coloured text edges.
//   - colour-managed to sRGB: sources are frequently Display P3 / Adobe RGB (libvips reports
//     8-bit JPEGs as space:'srgb' regardless, so the tag is not trustworthy). We honour the
//     EMBEDDED profile and gamut-map to real sRGB via toColourspace('srgb')+withIccProfile,
//     baking correct colour into sRGB pixels. That survives Shopify's CDN re-encode even if it
//     drops the profile; a naive toColourspace alone would relabel P3 as sRGB and desaturate.
//   - strip EXIF: withIccProfile keeps only the sRGB profile, so camera EXIF/GPS (home
//     geolocation) is removed.
//   - no WebP/AVIF here: Shopify's CDN does that on delivery.
//
// Pure Node fs only. Never shells out, so paths with spaces / parens / unicode are safe.

import sharp from 'sharp';
import { readdir, stat, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Shopify hard limits (help.shopify.com). Outputs must clear both.
const MAX_MEGAPIXELS = 20;
const MAX_BYTES = 20 * 1024 * 1024;
const INPUT_EXTS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff']);

// ---------------------------------------------------------------------------
// Arg parsing (no dependency; supports "--k v" and "--k=v" and boolean flags).
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    in: 'product-images/raw',
    out: 'product-images/processed',
    max: 4000,
    quality: 85,
    clean: false,
    dryRun: false,
    verify: false,
  };
  const alias = { 'dry-run': 'dryRun' };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith('--')) continue;
    a = a.slice(2);
    let val;
    const eq = a.indexOf('=');
    if (eq !== -1) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    const key = alias[a] || a;
    if (key === 'clean' || key === 'dryRun' || key === 'verify') {
      opts[key] = val === undefined ? true : val !== 'false';
    } else if (key === 'max' || key === 'quality') {
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
  if (!Number.isFinite(opts.max) || opts.max < 1) throw new Error('--max must be a positive number');
  if (!Number.isFinite(opts.quality) || opts.quality < 1 || opts.quality > 100) {
    throw new Error('--quality must be 1-100');
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Filename normalisation: lowercase kebab-case, collapse whitespace, fix the known
// "caffine" -> "caffeine" misspelling, always emit .jpg.
// ---------------------------------------------------------------------------
function cleanName(original) {
  const base = path.basename(original, path.extname(original));
  let name = base
    .toLowerCase()
    .replace(/caffine/g, 'caffeine')
    .replace(/[^a-z0-9]+/g, '-') // any run of non-alphanumerics -> single hyphen
    .replace(/^-+|-+$/g, '');
  if (!name) name = 'image';
  return `${name}.jpg`;
}

// Build old->new map up front and resolve collisions deterministically so we never
// silently last-write-wins over a distinct source photo.
function buildNameMap(files) {
  const used = new Set();
  const map = new Map(); // original filename -> { name, collided }
  for (const f of [...files].sort()) { // stable order so suffixes are deterministic
    let name = cleanName(f);
    let collided = false;
    if (used.has(name)) {
      collided = true;
      const stem = name.replace(/\.jpg$/, '');
      let n = 2;
      while (used.has(`${stem}-${n}.jpg`)) n++;
      name = `${stem}-${n}.jpg`;
    }
    used.add(name);
    map.set(f, { name, collided });
  }
  return map;
}

const kb = (bytes) => Math.round(bytes / 1024);
const mp = (w, h) => +(w * h / 1e6).toFixed(1);
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Shared cap predicate so processing and --verify enforce the exact same invariants.
function capProblems(w, h, bytes, maxEdge) {
  const problems = [];
  if (Math.max(w, h) > maxEdge) problems.push(`long edge ${Math.max(w, h)} > ${maxEdge}`);
  if (w * h / 1e6 > MAX_MEGAPIXELS) problems.push(`${mp(w, h)}MP > ${MAX_MEGAPIXELS}`);
  if (bytes > MAX_BYTES) problems.push(`${kb(bytes)}KB > 20MB`);
  return problems;
}

// Best-effort human name for the source's embedded colour profile (manifest audit only).
function profileName(iccBuf) {
  if (!iccBuf) return 'no-profile';
  const s = iccBuf.toString('latin1');
  for (const k of ['Display P3', 'Adobe RGB', 'ProPhoto', 'Rec709', 'Rec. 709', 'sRGB', 'Apple', 'Generic RGB']) {
    if (s.includes(k)) return k;
  }
  return 'other-profile';
}

// ---------------------------------------------------------------------------
// Process one file. Returns a manifest row. Throws on a real failure (recorded by caller).
// ---------------------------------------------------------------------------
async function processOne(srcPath, outPath, { max, quality }) {
  const { size: srcBytes } = await stat(srcPath);
  const notes = [];

  // Read metadata from an EXIF-oriented view so before-dims match what a human sees.
  const meta = await sharp(srcPath).rotate().metadata();
  const srcProfile = profileName(meta.icc);
  if (srcProfile !== 'sRGB' && srcProfile !== 'no-profile') notes.push(`${srcProfile}->sRGB`);
  if (meta.hasAlpha) notes.push('flattened-alpha');

  // One encode attempt at a given quality/edge. Always colour-manages to true sRGB:
  // toColourspace('srgb') + withIccProfile('srgb') imports the embedded profile and gamut-maps
  // (verified: a plain toColourspace alone does NOT convert P3). withIccProfile also drops EXIF.
  const encode = async (q, edge) => {
    let p = sharp(srcPath).rotate();
    if (meta.hasAlpha) p = p.flatten({ background: '#ffffff' });
    p = p
      .resize(edge, edge, { fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb')
      .withIccProfile('srgb')
      .jpeg({ quality: q, mozjpeg: true, chromaSubsampling: '4:4:4' });
    return p.toBuffer({ resolveWithObject: true });
  };

  let q = quality;
  let edge = max;
  let out;
  // Encode, then (pathological case) step down quality/size until under both caps.
  for (let attempt = 0; attempt < 6; attempt++) {
    out = await encode(q, edge);
    if (capProblems(out.info.width, out.info.height, out.data.length, max).length === 0) break;
    notes.push(`over-cap retry (q${q}/${edge}px)`);
    if (out.data.length > MAX_BYTES && q > 55) q -= 8; else edge = Math.round(edge * 0.85);
  }
  const finalProblems = capProblems(out.info.width, out.info.height, out.data.length, max);
  if (finalProblems.length) {
    throw new Error(`still over cap after retries: ${finalProblems.join(', ')}`);
  }

  await writeFile(outPath, out.data);

  return {
    original: path.basename(srcPath),
    new_name: path.basename(outPath),
    w_before: meta.width,
    h_before: meta.height,
    mp_before: mp(meta.width, meta.height),
    kb_before: kb(srcBytes),
    w_after: out.info.width,
    h_after: out.info.height,
    kb_after: kb(out.data.length),
    alt: '',
    notes: notes.join('; '),
  };
}

// ---------------------------------------------------------------------------
// Verify an already-produced output dir against all the caps and invariants.
// ---------------------------------------------------------------------------
async function verify(outDir, maxEdge, expectedCount) {
  const files = (await readdir(outDir)).filter((f) => f.toLowerCase().endsWith('.jpg'));
  const problems = [];
  for (const f of files) {
    const p = path.join(outDir, f);
    const { size } = await stat(p);
    const m = await sharp(p).metadata();
    for (const c of capProblems(m.width, m.height, size, maxEdge)) problems.push(`${f}: ${c}`);
    if (m.format !== 'jpeg') problems.push(`${f}: format ${m.format} != jpeg`);
    // Expect sRGB; a non-sRGB output is only acceptable if it carries an embedded ICC profile.
    if (m.space !== 'srgb' && !m.icc) problems.push(`${f}: space ${m.space} with no ICC profile`);
    if (m.hasAlpha) problems.push(`${f}: unexpected alpha channel`);
    if (m.exif) problems.push(`${f}: residual EXIF metadata`);
  }
  if (expectedCount != null && files.length !== expectedCount) {
    problems.push(`output count ${files.length} != expected ${expectedCount} (collision/overwrite data loss?)`);
  }
  return { count: files.length, problems };
}

// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const inDir = path.resolve(opts.in);
  const outDir = path.resolve(opts.out);

  // Refuse to write anywhere but a product-images/ path, so overriding --out can't
  // scatter unignored binaries into the repo (the .gitignore only covers product-images/).
  if (!opts.dryRun && !/(^|[\\/])product-images([\\/]|$)/.test(outDir)) {
    throw new Error(`--out must be under a 'product-images/' directory (got ${outDir}); refusing to write elsewhere.`);
  }

  let entries;
  try {
    entries = await readdir(inDir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`Cannot read --in '${inDir}': ${e.message}`);
  }

  const recognized = [];
  const skipped = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (INPUT_EXTS.has(ext)) recognized.push(e.name);
    else skipped.push(e.name);
  }
  recognized.sort();

  if (recognized.length === 0) throw new Error(`No supported images (${[...INPUT_EXTS].join(', ')}) in ${inDir}`);
  for (const s of skipped) console.warn(`WARN: skipping unsupported file: ${s}`);

  const nameMap = buildNameMap(recognized);

  if (opts.verify) {
    const { count, problems } = await verify(outDir, opts.max, recognized.length);
    console.log(`Verified ${count} file(s) in ${outDir}`);
    if (problems.length) { problems.forEach((p) => console.error(`FAIL: ${p}`)); process.exitCode = 1; }
    else console.log('All checks passed.');
    return;
  }

  if (opts.dryRun) {
    console.log(`DRY RUN: ${recognized.length} image(s), ${skipped.length} skipped\n`);
    console.log(['original', 'new_name', 'notes'].join('\t'));
    for (const f of recognized) {
      const { name, collided } = nameMap.get(f);
      console.log([f, name, collided ? 'collision -> suffixed' : ''].join('\t'));
    }
    console.log('\nNo files written. Re-run without --dry-run to process.');
    return;
  }

  if (opts.clean) {
    await rm(outDir, { recursive: true, force: true });
  }
  await mkdir(outDir, { recursive: true });

  const rows = [];
  for (const f of recognized) {
    const { name, collided } = nameMap.get(f);
    const src = path.join(inDir, f);
    const dst = path.join(outDir, name);
    try {
      const row = await processOne(src, dst, opts);
      if (collided) row.notes = [row.notes, 'renamed to avoid collision'].filter(Boolean).join('; ');
      rows.push(row);
      console.log(`ok  ${f}  ->  ${name}  (${row.mp_before}MP/${row.kb_before}KB -> ${row.kb_after}KB)`);
    } catch (e) {
      rows.push({
        original: f, new_name: '', w_before: '', h_before: '', mp_before: '', kb_before: '',
        w_after: '', h_after: '', kb_after: '', alt: '', notes: `SKIPPED: ${e.message}`,
      });
      console.error(`ERR ${f}: ${e.message}`);
    }
  }
  for (const s of skipped) {
    rows.push({
      original: s, new_name: '', w_before: '', h_before: '', mp_before: '', kb_before: '',
      w_after: '', h_after: '', kb_after: '', alt: '', notes: 'SKIPPED: unsupported extension',
    });
  }

  // Warn about orphans: outputs from a prior run whose source is gone (only when not --clean).
  if (!opts.clean) {
    const expected = new Set([...nameMap.values()].map((v) => v.name));
    const present = (await readdir(outDir)).filter((f) => f.toLowerCase().endsWith('.jpg'));
    for (const f of present) {
      if (!expected.has(f)) console.warn(`WARN: orphan output not from this run: ${f} (use --clean to remove)`);
    }
  }

  const cols = ['original', 'new_name', 'w_before', 'h_before', 'mp_before', 'kb_before',
    'w_after', 'h_after', 'kb_after', 'alt', 'notes'];
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
  await writeFile(path.join(outDir, 'manifest.csv'), csv);

  const ok = rows.filter((r) => r.new_name).length;
  console.log(`\nWrote ${ok}/${recognized.length} image(s) + manifest.csv to ${outDir}`);
  if (ok !== recognized.length) { console.error('Some files were skipped; see manifest notes.'); process.exitCode = 1; }
}

main().catch((e) => { console.error(`Fatal: ${e.message}`); process.exitCode = 1; });
