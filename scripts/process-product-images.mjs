#!/usr/bin/env node
// Batch-process raw product photos into Shopify-upload-ready JPEGs.
//
// Reads every image in --input-dir, downscales to a web-friendly size, colour-manages to true
// sRGB, re-encodes, gives each file its canonical underscore name (per scripts/lib/photo-naming.mjs),
// and writes the results plus a manifest.csv to --out. Originals are only READ, except under the
// explicit opt-in --rename-originals (see below).
//
// It does NOT upload to Shopify; upload + per-variant assignment is a separate step (Admin UI, or
// the Admin API via scripts/upload-product-media.mjs when the app's granted scopes cover it).
// manifest.csv is the operator's mapping aid: it carries the resolved product / colour columns and
// the operator-authored alt column, and a reprocess PRESERVES both alt and upload_status.
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
import { readdir, stat, mkdir, rm, writeFile, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeName, productForLineGarment, colorwayToAdminValue, altColorProblem,
} from './lib/photo-naming.mjs';

// Shopify hard limits (help.shopify.com). Outputs must clear both.
const MAX_MEGAPIXELS = 20;
const MAX_BYTES = 20 * 1024 * 1024;
const INPUT_EXTS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff']);

// ---------------------------------------------------------------------------
// Arg parsing (no dependency; supports "--k v" and "--k=v" and boolean flags).
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    in: 'product-images/originals',
    out: 'product-images/processed',
    manifest: null, // defaults to <out>/manifest.csv; the generic string-option branch parses it.
    max: 4000,
    quality: 85,
    clean: false,
    dryRun: false,
    verify: false,
    renameOriginals: false,
    renameOnly: false,
  };
  const alias = {
    'dry-run': 'dryRun',
    'input-dir': 'in',
    'rename-originals': 'renameOriginals',
    'rename-only': 'renameOnly',
  };
  const bools = new Set(['clean', 'dryRun', 'verify', 'renameOriginals', 'renameOnly']);
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith('--')) continue;
    a = a.slice(2);
    let val;
    const eq = a.indexOf('=');
    if (eq !== -1) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    const key = alias[a] || a;
    if (bools.has(key)) {
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
  if (opts.renameOnly) opts.renameOriginals = true; // rename-only implies the rename step
  return opts;
}

// ---------------------------------------------------------------------------
// Build old->canonical map up front and resolve output-name collisions deterministically so we
// never silently last-write-wins over a distinct source photo. The canonical OUTPUT name is
// underscore-separated (photo-naming.canonical); the parsed fields ride along for the manifest columns.
// ---------------------------------------------------------------------------
function buildNameMap(files) {
  const used = new Set();
  const map = new Map(); // original filename -> { name, collided, norm }
  for (const f of [...files].sort()) { // stable order so suffixes are deterministic
    const norm = normalizeName(f);
    let name = norm.canonical;
    let collided = false;
    if (used.has(name)) {
      collided = true;
      const stem = name.replace(/\.jpg$/, '');
      let n = 2;
      while (used.has(`${stem}-${n}.jpg`)) n++;
      name = `${stem}-${n}.jpg`;
    }
    used.add(name);
    map.set(f, { name, collided, norm });
  }
  return map;
}

const kb = (bytes) => Math.round(bytes / 1024);
const mp = (w, h) => +(w * h / 1e6).toFixed(1);
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Minimal CSV line parser (handles quoted cells with escaped quotes). Used only to preserve the
// operator-authored alt and upload_status columns across a reprocess.
function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { cells.push(cur); cur = ''; }
    else cur += c;
  }
  cells.push(cur);
  return cells;
}

// Read an existing manifest to preserve authored columns keyed by output name.
async function readExistingManifest(manifestPath) {
  const preserved = new Map(); // new_name -> { alt, upload_status }
  let text;
  try { text = await readFile(manifestPath, 'utf8'); } catch { return preserved; }
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  if (lines.length < 2) return preserved;
  const header = parseCsvLine(lines[0]);
  const iName = header.indexOf('new_name');
  const iAlt = header.indexOf('alt');
  const iStatus = header.indexOf('upload_status');
  if (iName === -1) return preserved;
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const name = cells[iName];
    if (!name) continue;
    preserved.set(name, {
      alt: iAlt >= 0 ? (cells[iAlt] || '') : '',
      upload_status: iStatus >= 0 ? (cells[iStatus] || '') : '',
    });
  }
  return preserved;
}

// Resolved product / colour columns from a parsed source name.
function derivedColumns(parsed) {
  const empty = { line: '', garment: '', colorway: '', admin_color: '', product: '', shot: '' };
  if (!parsed || !parsed.ok) return empty;
  const key = `${parsed.line}/${parsed.garment}`;
  const prod = productForLineGarment(parsed.line, parsed.garment);
  const admin = colorwayToAdminValue(parsed.colorway, key);
  return {
    line: parsed.line || '',
    garment: parsed.garment || '',
    colorway: parsed.colorway || '',
    admin_color: admin || '',
    product: prod ? prod.handle : '',
    shot: parsed.shot || '',
  };
}

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

// Guard the alt column against the reserved-colour-vocabulary rule (docs/product-media-alt-text.md).
// Only rows with a resolved product and a non-empty alt are checked. Returns `${name}: ${problem}`.
function altGuardProblems(rows) {
  const out = [];
  for (const r of rows) {
    if (!r.new_name || !r.product || !r.alt) continue;
    const key = `${r.line}/${r.garment}`;
    const expected = r.admin_color ? r.admin_color : null;
    const problem = altColorProblem(r.alt, expected, key);
    if (problem) out.push(`${r.new_name}: ${problem}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Process one file. Returns the encode-derived manifest fields. Throws on a real failure.
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
    w_before: meta.width,
    h_before: meta.height,
    mp_before: mp(meta.width, meta.height),
    kb_before: kb(srcBytes),
    w_after: out.info.width,
    h_after: out.info.height,
    kb_after: kb(out.data.length),
    notes: notes.join('; '),
  };
}

// ---------------------------------------------------------------------------
// Verify an already-produced output dir against all the caps and invariants, and (if a manifest
// is present) the alt-colour guard.
// ---------------------------------------------------------------------------
async function verify(outDir, maxEdge, expectedCount, manifestPath) {
  const files = (await readdir(outDir)).filter((f) => f.toLowerCase().endsWith('.jpg'));
  const problems = [];
  const warnings = [];
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
  // Alt-colour guard over the manifest, if one exists (reconstruct minimal rows from it).
  let text;
  try { text = await readFile(manifestPath, 'utf8'); } catch { text = null; }
  if (text) {
    const lines = text.split(/\r?\n/).filter((l) => l.length);
    const header = parseCsvLine(lines[0] || '');
    const idx = (k) => header.indexOf(k);
    const rows = lines.slice(1).map((l) => {
      const c = parseCsvLine(l);
      const get = (k) => (idx(k) >= 0 ? (c[idx(k)] || '') : '');
      return { new_name: get('new_name'), line: get('line'), garment: get('garment'), admin_color: get('admin_color'), product: get('product'), alt: get('alt'), upload_status: get('upload_status') };
    });
    for (const g of altGuardProblems(rows)) problems.push(`alt-colour: ${g}`);
    // Nothing this tool writes ever puts prose in upload_status: the uploader records short tokens
    // (created / updated-alt / skipped). A value with whitespace almost always means an unquoted
    // comma in a hand-edited alt spilled the tail of the alt into this column, silently truncating
    // the alt that drives the gallery colour filter. Warn (do not fail) so the operator re-quotes it.
    for (const r of rows) {
      const s = (r.upload_status || '').trim();
      if (s && /\s/.test(s)) {
        warnings.push(`upload_status: ${r.new_name || '(unnamed row)'}: value "${s}" looks like prose, not a status token; a raw comma in the alt likely overflowed into this column and truncated the alt. Re-check and quote the alt.`);
      }
    }
  }
  return { count: files.length, problems, warnings };
}

// ---------------------------------------------------------------------------
// Plan the in-place rename of source originals to their canonical UNDERSCORE names. Only files that
// parse with confidence (ok && !uncertain) are renamed; uncertain names are skipped, never guessed.
// Collisions and pre-existing targets are skipped with a warning rather than suffixed, because a
// same-target collision on an original is a real duplicate the operator should look at.
// ---------------------------------------------------------------------------
function planRenames(files, existing) {
  const plan = [];
  const skips = [];
  const targets = new Set();
  for (const f of [...files].sort()) {
    const norm = normalizeName(f);
    if (!norm.parsed.ok || norm.uncertain) {
      skips.push(`${f}: uncertain (${norm.warnings.join('; ')})`);
      continue;
    }
    const to = norm.canonical;
    if (to === f) continue; // already canonical
    if (targets.has(to) || (existing.has(to) && to !== f)) {
      skips.push(`${f} -> ${to}: target already exists or is claimed; skipped`);
      continue;
    }
    targets.add(to);
    plan.push({ from: f, to, warnings: norm.warnings });
  }
  return { plan, skips };
}

// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const inDir = path.resolve(opts.in);
  const outDir = path.resolve(opts.out);
  const manifestPath = opts.manifest ? path.resolve(opts.manifest) : path.join(outDir, 'manifest.csv');

  // Refuse to write anywhere but a product-images/ path, so overriding --out or --manifest can't
  // scatter unignored files into the repo (the .gitignore only covers product-images/). The manifest
  // is text, but the repo rule is that it never enters a PR, so it gets the same containment as the
  // image binaries.
  const underProductImages = (p) => /(^|[\\/])product-images([\\/]|$)/.test(p);
  if (!opts.dryRun && !opts.renameOnly && !underProductImages(outDir)) {
    throw new Error(`--out must be under a 'product-images/' directory (got ${outDir}); refusing to write elsewhere.`);
  }
  // The manifest is only written on a normal process run (not --verify, which reads it, nor the
  // dry-run / rename-only paths that write no manifest).
  if (!opts.dryRun && !opts.renameOnly && !opts.verify && !underProductImages(manifestPath)) {
    throw new Error(`--manifest must be under a 'product-images/' directory (got ${manifestPath}); refusing to write it into the tracked repo.`);
  }

  let entries;
  try {
    entries = await readdir(inDir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`Cannot read --input-dir '${inDir}': ${e.message}`);
  }

  let recognized = [];
  const skipped = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    // Silently ignore NTFS alternate-data-stream sidecars (e.g. "photo.jpg:Zone.Identifier" from a
    // Windows download, surfaced as their own entries on WSL). They are not files the operator chose;
    // warning on them is pure noise and they must never reach the manifest.
    if (e.name.includes(':')) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (INPUT_EXTS.has(ext)) recognized.push(e.name);
    else skipped.push(e.name);
  }
  recognized.sort();

  if (recognized.length === 0) throw new Error(`No supported images (${[...INPUT_EXTS].join(', ')}) in ${inDir}`);
  for (const s of skipped) console.warn(`WARN: skipping unsupported file: ${s}`);

  // --- Optional opt-in: rename source originals to canonical underscore names ---------------
  if (opts.renameOriginals) {
    const existing = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    const { plan, skips } = planRenames(recognized, existing);
    console.log(`\nRename originals: ${plan.length} to rename, ${skips.length} skipped, in ${inDir}`);
    for (const s of skips) console.warn(`  skip  ${s}`);
    for (const { from, to, warnings } of plan) {
      console.log(`  ${from}  ->  ${to}${warnings.length ? '   (' + warnings.join('; ') + ')' : ''}`);
    }
    if (opts.dryRun) {
      console.log('\nDRY RUN: no files renamed. Re-run without --dry-run to apply.');
      if (opts.renameOnly) return;
    } else if (plan.length) {
      for (const { from, to } of plan) {
        await rename(path.join(inDir, from), path.join(inDir, to));
      }
      const logCols = ['from', 'to'];
      const logCsv = [logCols.join(','), ...plan.map((p) => [csvCell(p.from), csvCell(p.to)].join(','))].join('\n') + '\n';
      const logPath = path.join(inDir, 'rename-log.csv');
      await writeFile(logPath, logCsv);
      console.log(`Renamed ${plan.length} original(s); reversal log at ${logPath}`);
      // Reflect the renames so downstream processing uses the new names.
      const remap = new Map(plan.map((p) => [p.from, p.to]));
      recognized = recognized.map((f) => remap.get(f) || f).sort();
    }
    if (opts.renameOnly) return;
  }

  const nameMap = buildNameMap(recognized);
  const preserved = await readExistingManifest(manifestPath);

  if (opts.verify) {
    const { count, problems, warnings } = await verify(outDir, opts.max, recognized.length, manifestPath);
    console.log(`Verified ${count} file(s) in ${outDir}`);
    warnings.forEach((w) => console.warn(`WARN: ${w}`));
    if (problems.length) { problems.forEach((p) => console.error(`FAIL: ${p}`)); process.exitCode = 1; }
    else console.log('All checks passed.');
    return;
  }

  if (opts.dryRun) {
    console.log(`\nDRY RUN: ${recognized.length} image(s), ${skipped.length} skipped\n`);
    console.log(['original', 'canonical (output)', 'product', 'admin_color', 'warnings'].join('\t'));
    const previewRows = [];
    for (const f of recognized) {
      const { name, collided, norm } = nameMap.get(f);
      const d = derivedColumns(norm.parsed);
      const alt = preserved.get(name)?.alt || '';
      previewRows.push({ new_name: name, line: d.line, garment: d.garment, admin_color: d.admin_color, product: d.product, alt });
      const notes = [...norm.warnings];
      if (collided) notes.push('collision -> suffixed');
      console.log([f, name, d.product || '(unresolved)', d.admin_color || '(shared)', notes.join('; ')].join('\t'));
    }
    const guard = altGuardProblems(previewRows);
    if (guard.length) {
      console.error('\nAlt-colour guard problems:');
      guard.forEach((g) => console.error(`  ${g}`));
      process.exitCode = 1;
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
    const { name, collided, norm } = nameMap.get(f);
    const d = derivedColumns(norm.parsed);
    const keep = preserved.get(name) || { alt: '', upload_status: '' };
    const src = path.join(inDir, f);
    const dst = path.join(outDir, name);
    try {
      const enc = await processOne(src, dst, opts);
      const notes = [...norm.warnings];
      if (enc.notes) notes.push(enc.notes);
      if (collided) notes.push('renamed to avoid collision');
      rows.push({ original: f, new_name: name, ...d, ...enc, alt: keep.alt, upload_status: keep.upload_status, notes: notes.join('; ') });
      console.log(`ok  ${f}  ->  ${name}  (${enc.mp_before}MP/${enc.kb_before}KB -> ${enc.kb_after}KB)`);
    } catch (e) {
      rows.push({
        original: f, new_name: '', ...d, w_before: '', h_before: '', mp_before: '', kb_before: '',
        w_after: '', h_after: '', kb_after: '', alt: keep.alt, upload_status: keep.upload_status,
        notes: `SKIPPED: ${e.message}`,
      });
      console.error(`ERR ${f}: ${e.message}`);
    }
  }
  for (const s of skipped) {
    rows.push({
      original: s, new_name: '', line: '', garment: '', colorway: '', admin_color: '', product: '', shot: '',
      w_before: '', h_before: '', mp_before: '', kb_before: '', w_after: '', h_after: '', kb_after: '',
      alt: '', upload_status: '', notes: 'SKIPPED: unsupported extension',
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

  const cols = ['original', 'new_name', 'line', 'garment', 'colorway', 'admin_color', 'product', 'shot',
    'w_before', 'h_before', 'mp_before', 'kb_before', 'w_after', 'h_after', 'kb_after',
    'alt', 'upload_status', 'notes'];
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
  await writeFile(manifestPath, csv);

  const guard = altGuardProblems(rows);
  if (guard.length) {
    console.warn('\nAlt-colour guard problems (fix before upload):');
    guard.forEach((g) => console.warn(`  ${g}`));
  }

  const ok = rows.filter((r) => r.new_name).length;
  console.log(`\nWrote ${ok}/${recognized.length} image(s) to ${outDir}; manifest at ${manifestPath}`);
  if (ok !== recognized.length) { console.error('Some files were skipped; see manifest notes.'); process.exitCode = 1; }
}

main().catch((e) => { console.error(`Fatal: ${e.message}`); process.exitCode = 1; });
