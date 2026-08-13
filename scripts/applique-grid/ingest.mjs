#!/usr/bin/env node
// Ingest the operator's HEIC pattern photos: copy them out of the source folder (never writing to
// it), decode into real sRGB (the decode drops the container's embedded profile, so the shared
// decodeToSrgb re-attaches it and converts; see scripts/lib/heic.mjs's header, and lib/heic.mjs
// here for what this pipeline layers on top), and produce working cells (long
// edge 1600, q90) + small previews (~600px, sized for reading during the grouping gate) + an ingest
// manifest keyed on basename + source content sha256 + decoder version + colour-transform version,
// so a re-shoot under the same basename, a heic-decode bump, or a change to the colour transform
// forces a re-decode and an unchanged photo skips.
//
// The source directory is a runtime flag only: a dev-machine path is sensitive content in this
// public repo, so the manifest stores BASENAMES only and the path never lands in any artifact.
// Crops recorded in the registry are normalized on the decoded photo; cells and previews are
// straight downscales, so the same normalized coordinates apply to all of them 1:1.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { COLOR_TRANSFORM_VERSION, DECODER_VERSION, decodeToSrgb, planIngest, sharpFromDecoded } from './lib/heic.mjs';
import { load as loadRegistry, REGISTRY_PATH } from './lib/registry.mjs';

const DEFAULT_OUT_DIR = 'product-images/applique';
const CELL_LONG_EDGE = 1600;
const PREVIEW_LONG_EDGE = 600;
const OUT_DIR_RE = /(^|[\\/])product-images([\\/]|$)/;

export const HELP = `Usage: node scripts/applique-grid/ingest.mjs --source '<dir>' [options]

Copies the operator's HEIC pattern photos out of the source folder (never writing to it), decodes
them into real sRGB, and produces working cells, small previews, and the ingest manifest.

Options:
  --source <dir>   The originals folder. Required, and a runtime flag only: a dev-machine path is
                   sensitive content in this public repo, so it never lands in any artifact.
  --out-dir <dir>  Working directory (default ${DEFAULT_OUT_DIR}; must be under product-images/).
  --force          Re-decode every photo even when its manifest key is unchanged. Needed after a
                   change that alters decoded pixels without changing the source hash, decoder
                   version, or colour-transform version.
  --help           This text.
`;

export function parseArgs(argv) {
  const opts = { source: null, outDir: DEFAULT_OUT_DIR, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith('--')) continue;
    a = a.slice(2);
    let val;
    const eq = a.indexOf('=');
    if (eq !== -1) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    if (a === 'help') { opts.help = true; continue; }
    if (a === 'force') { opts.force = true; continue; }
    if (a === 'source') { opts.source = val ?? argv[++i]; continue; }
    if (a === 'out-dir') { opts.outDir = val ?? argv[++i]; continue; }
    throw new Error(`Unknown option --${a}`);
  }
  if (opts.help) return opts;
  if (!opts.source) throw new Error("Missing --source '<dir>' (the operator's HEIC folder; quoted if it has spaces)");
  return opts;
}

async function readManifest(manifestPath) {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { version: 1, entries: {} };
    throw new Error(`ingest manifest is unreadable (${e.message}); fix or delete ${manifestPath}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }
  const outDir = path.resolve(opts.outDir);
  if (!OUT_DIR_RE.test(outDir)) {
    throw new Error(`--out-dir must be under a 'product-images/' directory (got ${outDir}); refusing to write elsewhere.`);
  }
  const sourceDir = path.resolve(opts.source);

  const registry = await loadRegistry(REGISTRY_PATH);

  // Enumerate source HEICs. NTFS Zone.Identifier sidecars (WSL) are skipped silently.
  const names = (await readdir(sourceDir))
    .filter((n) => !/:Zone\.Identifier$/i.test(n))
    .filter((n) => /\.(heic|heif)$/i.test(n))
    .sort();
  if (!names.length) throw new Error(`no .heic files found in ${sourceDir}`);

  // Hash sources up front (also the copy read; the source is never opened for writing).
  const sources = [];
  const bytesByName = new Map();
  for (const basename of names) {
    const buf = await readFile(path.join(sourceDir, basename));
    bytesByName.set(basename, buf);
    sources.push({ basename, sha256: createHash('sha256').update(buf).digest('hex') });
  }

  const manifestPath = path.join(outDir, 'ingest-manifest.json');
  const manifest = await readManifest(manifestPath);
  const plan = planIngest({
    sources,
    previous: manifest.entries,
    decoderVersion: DECODER_VERSION,
    colorTransformVersion: COLOR_TRANSFORM_VERSION,
    patterns: registry.patterns,
    force: opts.force,
  });

  await mkdir(path.join(outDir, 'originals'), { recursive: true });
  await mkdir(path.join(outDir, 'cells'), { recursive: true });
  await mkdir(path.join(outDir, 'previews'), { recursive: true });

  const failures = [];
  const warnings = [];
  const colorSources = new Map(); // colour note -> count, summarised instead of printed 46 times
  let decoded = 0;
  for (const basename of plan.decode) {
    const buf = bytesByName.get(basename);
    const src = sources.find((s) => s.basename === basename);

    // Copy the original out of the source folder, byte-size verified against the source.
    const copyPath = path.join(outDir, 'originals', basename);
    await writeFile(copyPath, buf);
    const [srcStat, dstStat] = [buf.length, (await stat(copyPath)).size];
    if (srcStat !== dstStat) throw new Error(`copy of ${basename} is ${dstStat} bytes, source is ${srcStat}; aborting`);

    let photo;
    try {
      photo = await decodeToSrgb(buf);
    } catch (e) {
      failures.push(`${basename}: ${e.message}`);
      delete manifest.entries[basename]; // a stale cell must not survive a now-undecodable source
      continue;
    }
    if (photo.width > photo.height) warnings.push(`${basename}: landscape orientation (${photo.width}x${photo.height}); pattern photos are expected portrait`);
    colorSources.set(photo.colorNote, (colorSources.get(photo.colorNote) ?? 0) + 1);
    // An unconverted photo is not a failure, but it is the one case where the cell colour is a
    // guess, so it goes in front of the operator rather than only into the manifest.
    if (!photo.converted) warnings.push(`${basename}: ${photo.colorNote}`);

    const cellPath = path.join(outDir, 'cells', `${basename}.jpg`);
    const cellInfo = await (await sharpFromDecoded(photo))
      .resize(CELL_LONG_EDGE, CELL_LONG_EDGE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: '4:4:4' })
      .toFile(cellPath);
    await (await sharpFromDecoded(photo))
      .resize(PREVIEW_LONG_EDGE, PREVIEW_LONG_EDGE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toFile(path.join(outDir, 'previews', `${basename}.jpg`));

    manifest.entries[basename] = {
      sha256: src.sha256,
      decoderVersion: DECODER_VERSION,
      colorTransformVersion: COLOR_TRANSFORM_VERSION,
      colorNote: photo.colorNote,
      width: photo.width,
      height: photo.height,
      cellWidth: cellInfo.width,
      cellHeight: cellInfo.height,
    };
    decoded++;
  }

  manifest.version = 1;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`Ingested ${names.length} photo(s): ${decoded} decoded, ${plan.skip.length} unchanged (skipped), ${failures.length} failed.`);
  if (colorSources.size) {
    console.log(`\nColour (transform ${COLOR_TRANSFORM_VERSION}):`);
    for (const [note, count] of [...colorSources].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${count} x ${note}`);
    }
  }
  if (warnings.length) {
    console.log('\nWarnings:');
    warnings.forEach((w) => console.log(`  ${w}`));
  }
  if (failures.length) {
    console.error('\nDecode failures (excluded from the manifest; content is never guessed from filenames):');
    failures.forEach((f) => console.error(`  ${f}`));
    process.exitCode = 1;
  }
  if (plan.unassigned.length) {
    console.log(`\nUnassigned photos (in no registry pattern yet): ${plan.unassigned.length}`);
    plan.unassigned.forEach((b) => console.log(`  ${b}`));
  }
  console.log(`\nManifest: ${manifestPath}`);
  console.log(`Previews for the grouping gate: ${path.join(outDir, 'previews')}`);
  console.log('Next: group the unassigned previews into patterns at the naming gate, then run render.mjs.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`Fatal: ${e.message}`); process.exitCode = 1; });
}
