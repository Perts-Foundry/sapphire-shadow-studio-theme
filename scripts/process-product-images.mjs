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
//     8-bit JPEGs as space:'srgb' regardless, so the tag is not trustworthy). Correct colour is
//     BAKED INTO sRGB pixels, so it survives Shopify's CDN re-encode even if the profile is
//     dropped, and the output still carries an sRGB profile for anything that reads one. The two
//     input kinds reach that point differently, and the difference is load-bearing:
//       * a JPEG/PNG/TIFF goes into sharp as a path, so libvips imports the file's own embedded
//         profile and toColourspace('srgb') gamut-maps from it.
//       * a HEIC comes out of the WASM decoder as bare RGBA with the profile stripped, so nothing
//         downstream can know what space it is in. prepareInput converts it via the shared
//         decodeToSrgb (scripts/lib/heic.mjs) and hands the encode pixels that ALREADY are sRGB.
//         Do not "simplify" that back into withIccProfile(sourceProfilePath): on untagged input
//         that CONVERTS INTO the profile given rather than tagging with it, so the pipeline
//         round-tripped sRGB -> P3 -> sRGB and shipped P3 pixels relabelled sRGB, visibly
//         desaturated. That shipped, and this is the fix.
//   - strip EXIF: withIccProfile keeps only the sRGB profile, so camera EXIF/GPS (home
//     geolocation) is removed. The HEIC path never has EXIF to begin with (raw pixels carry none).
//   - no WebP/AVIF here: Shopify's CDN does that on delivery.
//
// Pure Node fs only. Never shells out, so paths with spaces / parens / unicode are safe.

import sharp from 'sharp';
import { readdir, stat, mkdir, rm, writeFile, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  normalizeName, productForLineGarment, productForHandle, colorwayToAdminValue, altColorProblem,
} from './lib/photo-naming.mjs';
import { DECODER_VERSION, decodeToSrgb } from './lib/heic.mjs';

// Shopify hard limits (help.shopify.com). Outputs must clear both.
const MAX_MEGAPIXELS = 20;
const MAX_BYTES = 20 * 1024 * 1024;
// .heic goes through the heic-decode WASM bridge in prepareInput (sharp's libvips cannot decode
// the iPhone tiled HEICs); .heif is NOT accepted (unverified) and gets the standard skip-warning.
const INPUT_EXTS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.heic']);
const DEFAULT_OUT = 'product-images/processed';

// ---------------------------------------------------------------------------
// Arg parsing (no dependency; supports "--k v" and "--k=v" and boolean flags).
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    in: 'product-images/originals',
    out: DEFAULT_OUT,
    manifest: null, // defaults to <out>/manifest.csv; the generic string-option branch parses it.
    newBatch: false, // route this run into a fresh timestamped <out>/<stamp>/ so runs never clobber.
    max: 4000,
    quality: 85,
    clean: false,
    dryRun: false,
    verify: false,
    renameOriginals: false,
    renameOnly: false,
    renameMap: null, // path to a from,to CSV of operator-approved names for non-matching originals.
  };
  const alias = {
    'dry-run': 'dryRun',
    'input-dir': 'in',
    'new-batch': 'newBatch',
    'rename-originals': 'renameOriginals',
    'rename-only': 'renameOnly',
    'rename-map': 'renameMap',
  };
  const bools = new Set(['clean', 'dryRun', 'verify', 'newBatch', 'renameOriginals', 'renameOnly']);
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
  if (opts.renameMap) opts.renameOriginals = true;  // a rename map is applied by the rename step
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

// Read an existing manifest to preserve authored columns, keyed by output name. Each name maps
// to an ARRAY of rows, in file order, because a shared asset (see planManifestRows below) is one
// output file fanned out across several per-product manifest rows, each carrying its own alt and
// upload_status. Collapsing to one row per name (the old shape) silently destroyed the fan-out.
async function readExistingManifest(manifestPath) {
  const preserved = new Map(); // new_name -> [{ alt, upload_status, product, line, garment }]
  let text;
  try { text = await readFile(manifestPath, 'utf8'); } catch { return preserved; }
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  if (lines.length < 2) return preserved;
  const header = parseCsvLine(lines[0]);
  const iName = header.indexOf('new_name');
  const idx = (k) => header.indexOf(k);
  if (iName === -1) return preserved;
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const name = cells[iName];
    if (!name) continue;
    const get = (k) => (idx(k) >= 0 ? (cells[idx(k)] || '') : '');
    if (!preserved.has(name)) preserved.set(name, []);
    preserved.get(name).push({
      alt: get('alt'),
      upload_status: get('upload_status'),
      product: get('product'),
      line: get('line'),
      garment: get('garment'),
    });
  }
  return preserved;
}

// Plan the manifest row seed(s) for one output name from its derived columns and the rows
// preserved from the previous manifest. Pure; exported for tests.
//   - Shared-asset fan-out: the name resolves to NO product, but preserved per-product rows
//     exist (hand-authored, one per target product). Emit one seed per preserved row, in
//     preserved order, each keeping its own alt and upload_status; admin_color stays blank
//     (shared rows are colour-free by contract; docs/product-media-alt-text.md).
//   - Otherwise: the normal single row. Several preserved rows for a resolving name keep the
//     first row's alt/upload_status, with a warning.
// Rows whose source file was removed or renamed still vanish on a reprocess (emission is driven
// by the current input files); that is deliberate and pinned by test.
function planManifestRows(d, preservedRows) {
  const warnings = [];
  if (!d.product && preservedRows.some((p) => p.product)) {
    return {
      fanOut: true,
      seeds: preservedRows.map((p) => ({
        ...d,
        line: d.line || p.line || '',
        garment: d.garment || p.garment || '',
        product: p.product || '',
        alt: p.alt || '',
        upload_status: p.upload_status || '',
      })),
      warnings,
    };
  }
  if (preservedRows.length > 1) {
    // Deterministic first-wins, and loud about it: an earlier revision of this tool kept the LAST
    // duplicate, so a manifest carrying duplicate rows for one output name changes which alt
    // survives a reprocess. Name the discarded alts, because the surviving one is what the
    // uploader will push over the live media.
    const dropped = preservedRows.slice(1).map((p) => `"${p.alt || ''}"`).join(', ');
    warnings.push(`${preservedRows.length} preserved manifest rows for one name; keeping the first row's alt/upload_status and discarding ${dropped}. De-duplicate the manifest if that is not what you want.`);
  }
  const keep = preservedRows[0] || { alt: '', upload_status: '' };
  return {
    fanOut: false,
    seeds: [{ ...d, alt: keep.alt || '', upload_status: keep.upload_status || '' }],
    warnings,
  };
}

// Resolved product / colour columns from a parsed source name.
function derivedColumns(parsed) {
  const empty = { line: '', garment: '', colorway: '', admin_color: '', product: '', shot: '' };
  if (!parsed || !parsed.ok) return empty;
  // The non-garment form carries the handle itself: no line, garment or colour, and admin_color
  // stays empty so the alt guard enforces a colour-free alt against that product's empty vocab.
  if (parsed.product) return { ...empty, product: parsed.product, shot: parsed.shot || '' };
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

// Containment guard for every write target: only paths under a product-images/ directory are
// acceptable, because .gitignore covers exactly that tree and nothing else keeps image binaries
// (or the manifest) out of this public repo. Shared with contact-sheet.mjs.
const underProductImages = (p) => /(^|[\\/])product-images([\\/]|$)/.test(p);

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
  // Apple's profiles (Display P3 among them) carry their description in a UTF-16BE 'mluc' tag,
  // which latin1 decoding renders with interleaved NULs ('D\0i\0s\0p...'), so the plain haystack
  // misses it. Scan a NUL-stripped copy as a second haystack. Stripping can in principle
  // concatenate unrelated byte runs into a keyword (an accepted false positive: this label is a
  // cosmetic audit note, and the actual colour conversion never reads it); pinned by test so a
  // future "fix" here is deliberate.
  const stripped = s.replace(/\u0000/g, '');
  for (const k of ['Display P3', 'Adobe RGB', 'ProPhoto', 'Rec709', 'Rec. 709', 'sRGB', 'Apple', 'Generic RGB']) {
    if (s.includes(k) || stripped.includes(k)) return k;
  }
  return 'other-profile';
}

// Guard the alt column against the reserved-colour-vocabulary rule (docs/product-media-alt-text.md).
// Only rows with a resolved product and a non-empty alt are checked. Returns `${name}: ${problem}`.
// A shared-asset fan-out row has a product handle but empty line/garment; resolve its key via
// productForHandle so those rows are guarded too (expected=null enforces a colour-free alt against
// that product's vocabulary). An unknown handle is a guard problem, never a throw.
function altGuardProblems(rows) {
  const out = [];
  for (const r of rows) {
    if (!r.new_name || !r.product || !r.alt) continue;
    let key = `${r.line}/${r.garment}`;
    if (!r.line || !r.garment) {
      const known = productForHandle(r.product);
      if (!known) {
        out.push(`${r.new_name}: product "${r.product}" is not a recorded product; cannot colour-guard this row`);
        continue;
      }
      key = known.key;
    }
    const expected = r.admin_color ? r.admin_color : null;
    const problem = altColorProblem(r.alt, expected, key);
    if (problem) out.push(`${r.new_name}: ${problem}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prepare one source for the sharp pipeline, returning what sharp() needs to read it: the `input`
// plus the `inputOptions` that describe it (null for anything sharp can read on its own).
//
// Non-HEIC inputs pass through as their path, and sharp imports their embedded profile itself. A
// HEIC is decoded via the heic-decode WASM bridge (sharp's libvips fails on the iPhone tiled HEICs
// with "bad seek"), which drops the container's ICC profile, so the shared decodeToSrgb re-attaches
// the file's OWN profile and converts. What comes back is raw sRGB pixels, handed straight to the
// encode: no PNG round trip, no profile for the encode to interpret, and (this is the point) the
// conversion happens exactly once even though the encode may run up to six times in the over-cap
// retry loop, so no attempt can differ in colour from another.
//
// heic-decode bakes the container's orientation transforms into the decoded pixels (observed on a
// 10-file iPhone batch: every primary item was stored landscape, 4032x3024 and 5712x4284, each
// carrying an `irot` angle of 270, and decodeToRaw returned the upright portrait buffer, 3024x4032
// and 4284x5712, matching the hand-built reference intermediates exactly). So no post-decode
// rotate belongs here; adding one would transpose every portrait frame. Raw pixels carry no
// orientation tag either, so processOne's `.rotate()` stays a no-op on this path. A decode throw
// (corrupt HEIC) propagates to the caller, which records it as a per-file manifest error, never a
// batch abort. Exported for tests (opts.decode injects a decoder so no HEIC binary lives in git).
// ---------------------------------------------------------------------------
async function prepareInput(srcPath, opts = {}) {
  if (path.extname(srcPath).toLowerCase() !== '.heic') {
    return { input: srcPath, inputOptions: null, notes: [] };
  }
  const buf = await readFile(srcPath);
  const { data, width, height, channels, colorNote } = await decodeToSrgb(buf, opts);
  return {
    input: data,
    inputOptions: { raw: { width, height, channels } },
    notes: [`heic-decoded (heic-decode ${DECODER_VERSION})`, colorNote],
  };
}

// ---------------------------------------------------------------------------
// Process one file. Returns the encode-derived manifest fields. Throws on a real failure.
// Kept sequential with the caller's per-file loop on purpose: a 48MP HEIC decodes to ~190MB of
// raw RGBA, so decoding files concurrently would multiply peak memory by the batch size.
// ---------------------------------------------------------------------------
async function processOne(srcPath, outPath, { max, quality }) {
  const { size: srcBytes } = await stat(srcPath);
  const { input, inputOptions, notes: prepNotes } = await prepareInput(srcPath);
  const notes = [...prepNotes];
  const open = () => sharp(input, inputOptions ?? {});

  // Read metadata from an EXIF-oriented view so before-dims match what a human sees.
  const meta = await open().rotate().metadata();
  // Only the file-path inputs reach here carrying a profile; a HEIC arrives already converted and
  // reports its own source profile through prepNotes, so this stays 'no-profile' there.
  const srcProfile = profileName(meta.icc);
  if (srcProfile !== 'sRGB' && srcProfile !== 'no-profile') notes.push(`${srcProfile}->sRGB`);
  if (meta.hasAlpha) notes.push('flattened-alpha');

  // One encode attempt at a given quality/edge. Always lands in true sRGB: for a file-path input
  // toColourspace('srgb') + withIccProfile('srgb') imports the embedded profile and gamut-maps
  // (verified: a plain toColourspace alone does NOT convert P3), and for the HEIC path the pixels
  // are already sRGB, so both calls are the identity and only the sRGB tag is added.
  // withIccProfile also drops EXIF, which is how camera GPS never reaches the store.
  const encode = async (q, edge) => {
    let p = open().rotate();
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
// Load an operator-approved rename map: a CSV with `from,to` columns naming, for each original the
// parser could not confidently name, the canonical name the operator VERIFIED at the naming gate.
// The guess happens upstream in the skill and is verified by the operator; this loader and the
// planner below never guess. They only apply an explicit, verified map, and the planner still
// re-validates every target is a clean convention name (below) so a fabricated or half-formed
// target is refused rather than silently renamed. Returns Map(fromBasename -> approvedRawName).
// ---------------------------------------------------------------------------
async function loadRenameMap(mapPath) {
  const text = await readFile(mapPath, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  if (!lines.length) return new Map();
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const iFrom = header.indexOf('from');
  const iTo = header.indexOf('to');
  if (iFrom === -1 || iTo === -1) {
    throw new Error(`--rename-map '${mapPath}' needs a header row with 'from' and 'to' columns`);
  }
  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    const from = (c[iFrom] || '').trim();
    const to = (c[iTo] || '').trim();
    if (!from && !to) continue;
    if (!from || !to) throw new Error(`--rename-map row ${i + 1}: both 'from' and 'to' are required`);
    if (map.has(from)) throw new Error(`--rename-map lists '${from}' more than once`);
    map.set(from, to);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Plan the in-place rename of source originals. Two sources feed the plan:
//   - auto: a file that parses with confidence (ok && !uncertain) is renamed to its canonical
//     UNDERSCORE name. Uncertain names are skipped, never guessed.
//   - approved: an entry in `overrides` (from loadRenameMap) renames a specific original to the
//     operator-verified name, EVEN when the parser was uncertain about the source. The approved
//     target is itself normalised and must resolve to a clean, unambiguous convention name; a
//     target that does not (unknown token, missing field, no index) is refused here, so the verify
//     gate cannot push a malformed name through. An override wins over the auto name for a file.
// Collisions and pre-existing targets are skipped with a warning rather than suffixed, because a
// same-target collision on an original is a real duplicate the operator should look at.
// ---------------------------------------------------------------------------
function planRenames(files, existing, overrides = new Map()) {
  const plan = [];
  const skips = [];
  const targets = new Set();
  const fileSet = new Set(files);
  // An override naming a file not in this input set is almost always a stale or mistyped `from`;
  // surface it rather than silently ignore it.
  for (const from of overrides.keys()) {
    if (!fileSet.has(from)) skips.push(`${from}: listed in --rename-map but not among the input images; ignored`);
  }
  for (const f of [...files].sort()) {
    let to;
    let source;
    let warnings = [];
    const approved = overrides.get(f);
    if (approved !== undefined) {
      const norm = normalizeName(approved);
      if (norm.uncertain) {
        skips.push(`${f} -> ${approved}: approved name is not a clean convention name (${norm.warnings.join('; ')}); not renamed`);
        continue;
      }
      to = norm.canonical;
      source = 'approved';
    } else {
      const norm = normalizeName(f);
      if (!norm.parsed.ok || norm.uncertain) {
        skips.push(`${f}: uncertain (${norm.warnings.join('; ')})`);
        continue;
      }
      to = norm.canonical;
      source = 'auto';
      warnings = norm.warnings;
    }
    if (to === f) continue; // already canonical
    if (targets.has(to) || (existing.has(to) && to !== f)) {
      skips.push(`${f} -> ${to}: target already exists or is claimed; skipped`);
      continue;
    }
    targets.add(to);
    plan.push({ from: f, to, source, warnings });
  }
  return { plan, skips };
}

// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // --new-batch routes this run into its own timestamped directory so re-running the pipeline at a
  // later date never overwrites an earlier batch's images or manifest. It owns the output location,
  // so it cannot be combined with an explicit --out / --manifest. Thread the printed paths through
  // the remaining pipeline steps to keep every step on the same batch.
  if (opts.newBatch) {
    if (opts.out !== DEFAULT_OUT) throw new Error('--new-batch manages the output directory; do not also pass --out');
    if (opts.manifest) throw new Error('--new-batch manages the manifest path; do not also pass --manifest');
    const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z'); // e.g. 2026-07-18T15-30-42Z, colon-free
    opts.out = path.join(DEFAULT_OUT, stamp);
  }

  const inDir = path.resolve(opts.in);
  const outDir = path.resolve(opts.out);
  const manifestPath = opts.manifest ? path.resolve(opts.manifest) : path.join(outDir, 'manifest.csv');

  if (opts.newBatch) {
    console.log(`New batch directory: ${outDir}`);
    console.log(`Batch manifest:      ${manifestPath}`);
    console.log(`Keep every later step on this batch: pass  --out '${opts.out}'  to the processor and  --manifest '${manifestPath}'  to the uploader.\n`);
  }

  // Refuse to write anywhere but a product-images/ path, so overriding --out or --manifest can't
  // scatter unignored files into the repo (the .gitignore only covers product-images/). The manifest
  // is text, but the repo rule is that it never enters a PR, so it gets the same containment as the
  // image binaries. (underProductImages lives at module scope; contact-sheet.mjs reuses it.)
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
  // Confident names go to their canonical form automatically; an operator-approved --rename-map
  // additionally renames non-matching originals to the names verified at the naming gate.
  if (opts.renameOriginals) {
    const overrides = opts.renameMap ? await loadRenameMap(path.resolve(opts.renameMap)) : new Map();
    const existing = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    const { plan, skips } = planRenames(recognized, existing, overrides);
    const approvedCount = plan.filter((p) => p.source === 'approved').length;
    console.log(`\nRename originals: ${plan.length} to rename (${approvedCount} operator-approved), ${skips.length} skipped, in ${inDir}`);
    for (const s of skips) console.warn(`  skip  ${s}`);
    for (const { from, to, source, warnings } of plan) {
      const tag = source === 'approved'
        ? '   [operator-approved]'
        : (warnings.length ? '   (' + warnings.join('; ') + ')' : '');
      console.log(`  ${from}  ->  ${to}${tag}`);
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
      const { fanOut, seeds, warnings: planWarnings } = planManifestRows(d, preserved.get(name) || []);
      for (const seed of seeds) {
        previewRows.push({ new_name: name, line: seed.line, garment: seed.garment, admin_color: seed.admin_color, product: seed.product, alt: seed.alt });
      }
      const notes = [...norm.warnings, ...planWarnings];
      if (collided) notes.push('collision -> suffixed');
      if (fanOut) notes.push(`shared asset: ${seeds.length} preserved product row(s)`);
      const productCell = fanOut ? `(shared: ${seeds.length} products)` : (d.product || '(unresolved)');
      // A non-garment product has no Color option at all, which is not the same fact as a shared or
      // group photo (a colour-free photo on a product that does have colours).
      const colorCell = d.admin_color || (norm.parsed?.product ? '(no colour option)' : '(shared)');
      console.log([f, name, productCell, colorCell, notes.join('; ')].join('\t'));
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
    const preservedRows = preserved.get(name) || [];
    const { fanOut, seeds, warnings: planWarnings } = planManifestRows(d, preservedRows);
    const src = path.join(inDir, f);
    const dst = path.join(outDir, name);
    try {
      const enc = await processOne(src, dst, opts);
      const notes = [...norm.warnings, ...planWarnings];
      if (enc.notes) notes.push(enc.notes);
      if (collided) notes.push('renamed to avoid collision');
      if (fanOut) notes.push(`shared asset: fanned out to ${seeds.length} product row(s)`);
      for (const seed of seeds) {
        rows.push({ original: f, new_name: name, ...seed, ...enc, notes: notes.join('; ') });
      }
      planWarnings.forEach((w) => console.warn(`WARN: ${f}: ${w}`));
      console.log(`ok  ${f}  ->  ${name}  (${enc.mp_before}MP/${enc.kb_before}KB -> ${enc.kb_after}KB)${fanOut ? `  [shared: ${seeds.length} rows]` : ''}`);
    } catch (e) {
      // A failed file still emits one row per planned seed, so a shared asset's hand-authored
      // per-product rows do not collapse to one on a failed reprocess (that discarded the other
      // products' alt text permanently). The row carries the INTENDED canonical name rather than
      // an empty one so the next run's manifest reader can key it and restore the alt; the
      // uploader is unaffected because it only uploads rows whose file is actually on disk.
      for (const seed of seeds) {
        rows.push({
          original: f, new_name: name, ...seed, w_before: '', h_before: '', mp_before: '', kb_before: '',
          w_after: '', h_after: '', kb_after: '',
          notes: `SKIPPED: ${e.message}`,
        });
      }
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

  // Distinct output names, not manifest rows: a shared asset fans out to several rows for ONE file.
  const ok = new Set(rows.filter((r) => r.new_name).map((r) => r.new_name)).size;
  console.log(`\nWrote ${ok}/${recognized.length} image(s) to ${outDir}; manifest at ${manifestPath}`);
  if (ok !== recognized.length) { console.error('Some files were skipped; see manifest notes.'); process.exitCode = 1; }
}

// Exported for unit testing (and underProductImages for contact-sheet.mjs); the CLI entrypoint
// below runs only when invoked directly.
export {
  planRenames, loadRenameMap, planManifestRows, readExistingManifest, altGuardProblems,
  profileName, underProductImages, prepareInput,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`Fatal: ${e.message}`); process.exitCode = 1; });
}
