#!/usr/bin/env node
// Prepare and upload one article's photos to Shopify Files. The only supported way an article image
// reaches the store.
//
//   node scripts/articles/upload-images.mjs --handle <handle> --prepare
//        offline: process article-images/<handle>/originals/* into upload-ready JPEGs beside them
//   node --env-file=.env scripts/articles/upload-images.mjs --handle <handle>
//        dry run: list exactly what would upload and what is already in Files; upload nothing
//   node --env-file=.env scripts/articles/upload-images.mjs --handle <handle> --confirm=<handle> --expect-plan=<sha>
//        upload exactly the plan that dry run printed
//
// No package.json key: it is run by module path, with credentials passed explicitly the way every
// other Admin tool here is (scripts/README.md, Credentials). Nothing here loads `.env` by itself.
//
// AN UPLOADED FILE IS PUBLIC AT ONCE. Its CDN URL serves the moment `fileCreate` succeeds, whatever
// the article's state: a hidden article does not hide its images (verified on the 2026-09-12 spike).
// So this is its own gate, with its own dry run and its own operator ask, and it is not a step
// inside the article push.
//
// THE RAILS, each tested in test/upload-images.test.mjs against a fake client:
//   - `CI` present refuses, every mode, `--prepare` included, before any client exists.
//   - A bare run is a dry run. It resolves nothing it would write, and goes through the read-only client.
//   - `--confirm` must equal `--handle`, and `--expect-plan` must equal the plan sha the dry run printed.
//     The plan sha covers every file name and the sha256 of its bytes, so a file added, removed or
//     re-processed after the dry run refuses rather than uploading something nobody saw listed.
//   - NO-OP FOR WHAT IS ALREADY THERE. Every name is looked up in Files first (the pattern of
//     scripts/email-icons/upload-email-icons.mjs) and skipped when present. Files has no content dedup,
//     so a second create would make a second public copy under a suffixed name. The lookup has an
//     indexing lag of a few seconds: a dry run straight after an upload can miss what it just made.
//   - METADATA IS ASSERTED ABSENT IMMEDIATELY BEFORE `stagedUploadsCreate`, on the exact buffer that
//     is then sent: EXIF, XMP and IPTC. Not only after processing, because the bytes on disk can
//     change between the two, and camera EXIF carries GPS.
//   - CREATES ONLY. It never updates or deletes a file, and touches nothing else in the store.
//   - Every name starts with `<handle>-`, so one article's uploads are findable by that prefix in
//     Admin (Content, then Files) when a draft is abandoned and they need removing by hand.
//
// It writes no repo file. It prints the `images.json` entries for the author to record, alt text added
// by hand. The live path (a real staged upload and fileCreate) is unexercised: this plan's end-to-end
// checks deliberately ran no image upload.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import { assertScopes, backoffDelayMs, createAdminClient } from '../blank-inventory/lib/admin.mjs';
import { createReadOnlyClient } from '../site-check/lib/admin-readonly.mjs';
import { IMAGE_ROOT_DIR, REPO_ROOT } from './check.mjs';
import { isHandle, sha256 as sha256Text, stripVersionQuery } from './lib/articles.mjs';
import { ArticleError, assertNotCI, createContext, parseFlags, requireClient, toExitCode } from './lib/context.mjs';
import { FILE_CREATE, FILE_STAGED_UPLOADS } from './lib/mutations.mjs';
import { ARTICLE_IMAGE_FILES, ARTICLE_IMAGE_FILE_READ, UPLOAD_SCOPES } from './lib/queries.mjs';
import { resolveStateDir } from './lib/state.mjs';
import { createHash } from 'node:crypto';

export const COMMAND = 'articles:upload-images';

export const FLAG_SPEC = Object.freeze({
  '--handle': 'string',
  '--prepare': 'boolean',
  '--confirm': 'string',
  '--expect-plan': 'string',
});

/** Where the operator's untouched photos go, under `article-images/<handle>/`. */
export const ORIGINALS_DIR = 'originals';

/** The long edge of a processed image. 2048 avoids fabric moire at typical display sizes. */
export const MAX_EDGE = 2048;
export const JPEG_QUALITY = 82;
export const MIME = 'image/jpeg';

/** Source extensions `--prepare` reads. HEIC is not among them: export it as JPEG first. */
export const SOURCE_EXTENSIONS = Object.freeze(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff']);

/** How many times a new file is polled for its processed URL before reporting it as still processing. */
export const POLL_ATTEMPTS = 8;

export const UPLOAD_MARKER = 'article images uploaded';

function sha256Bytes(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** The one name shape an upload may have: `<handle>-<kebab words>.jpg`. */
export function uploadNameRe(handle) {
  return new RegExp(`^${handle}-[a-z0-9]+(?:-[a-z0-9]+)*\\.jpg$`);
}

/** A source file stem as kebab words, prefixed with the handle unless it already carries it. */
export function uploadNameFor(handle, sourceName) {
  const stem = path.parse(sourceName).name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (stem === '') throw new ArticleError(sourceName, 'has no usable characters in its name; rename it');
  return stem.startsWith(`${handle}-`) ? `${stem}.jpg` : `${handle}-${stem}.jpg`;
}

/**
 * Which identifying metadata blocks a sharp `metadata()` result carries. Empty means clean.
 *
 * @param {{exif?: unknown, xmp?: unknown, iptc?: unknown}} meta
 * @returns {string[]}
 */
export function metadataRefusals(meta) {
  const out = [];
  if (meta?.exif) out.push('EXIF');
  if (meta?.xmp) out.push('XMP');
  if (meta?.iptc) out.push('IPTC');
  return out;
}

/**
 * Whether a CDN URL is the file named `filename`. Shopify keeps the filename in the URL path, adds a
 * `?v=` cache buster, and appends `_1`, `_2` on a name collision, so the comparison is on the stem
 * and tolerates that suffix (the same rule as scripts/email-icons/upload-email-icons.mjs).
 */
export function matchesFilename(url, filename) {
  if (typeof url !== 'string' || url === '') return false;
  let stem;
  try {
    stem = path.parse(path.basename(new URL(url).pathname)).name;
  } catch {
    return false;
  }
  const wanted = path.parse(filename).name;
  return stem === wanted || (stem.startsWith(`${wanted}_`) && /^\d+$/.test(stem.slice(wanted.length + 1)));
}

/** The plan hash: every file that would upload, by name and byte hash, order-independent. */
export function planSha(entries) {
  const pairs = entries.map((e) => [e.name, e.sha256]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256Text(JSON.stringify(pairs));
}

/** The production metadata reader. */
export function sharpMetadata(buffer) {
  return sharp(buffer).metadata();
}

/**
 * The production processor: upright, sRGB, long edge at most MAX_EDGE, JPEG. `withIccProfile` keeps
 * only an sRGB profile, and sharp writes no other metadata unless told to, so EXIF, XMP and IPTC do
 * not survive (the same pipeline shape as scripts/process-product-images.mjs). The suite proves it on
 * a source carrying EXIF and XMP.
 */
export async function sharpProcess(buffer) {
  const { data, info } = await sharp(buffer)
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    .toColourspace('srgb')
    .withIccProfile('srgb')
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true, chromaSubsampling: '4:4:4' })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function requireImageRoot(ctx) {
  if (!ctx.imageRoot) throw new ArticleError(COMMAND, 'needs an image root and the context holds none');
  return ctx.imageRoot;
}

async function prepare(handle, ctx, deps) {
  const dir = path.join(requireImageRoot(ctx), handle);
  const originals = path.join(dir, ORIGINALS_DIR);
  if (!existsSync(originals)) {
    throw new ArticleError(originals, `does not exist. Put the photos for "${handle}" there, then run --prepare again.`);
  }
  const sources = readdirSync(originals).filter((n) => statSync(path.join(originals, n)).isFile()).sort();
  const unreadable = sources.filter((n) => !SOURCE_EXTENSIONS.includes(path.extname(n).toLowerCase()));
  if (unreadable.length) {
    throw new ArticleError(originals, `holds files --prepare does not read: ${unreadable.join(', ')}. Export them as JPEG or PNG first.`);
  }
  if (sources.length === 0) throw new ArticleError(originals, 'is empty; nothing to prepare');
  const names = new Map();
  for (const source of sources) {
    const name = uploadNameFor(handle, source);
    if (names.has(name)) throw new ArticleError(source, `and ${names.get(name)} would both become ${name}; rename one`);
    names.set(name, source);
  }
  mkdirSync(dir, { recursive: true });
  for (const [name, source] of names) {
    const out = path.join(dir, name);
    if (existsSync(out)) {
      ctx.log(`${name}: exists, left as it is (delete it to process ${source} again)`);
      continue;
    }
    const { data, width, height } = await deps.process(readFileSync(path.join(originals, source)));
    const refusals = metadataRefusals(await deps.metadata(data));
    if (refusals.length) throw new ArticleError(name, `processing left ${refusals.join(', ')} metadata in the output; nothing was written`);
    writeFileSync(out, data);
    ctx.log(`${name}: ${width}x${height}, ${data.length} bytes, from ${source}`);
  }
  ctx.log('Offline. Nothing was uploaded. Run the dry run next.');
  return { code: 0, reason: 'prepared', names: [...names.keys()] };
}

/** Every upload-ready file for one article, read and checked. Refuses on any stray name or metadata. */
async function localImages(handle, ctx, deps) {
  const dir = path.join(requireImageRoot(ctx), handle);
  if (!existsSync(dir)) {
    throw new ArticleError(dir, `does not exist; put the photos in ${ORIGINALS_DIR}/ under it and run --prepare first`);
  }
  const re = uploadNameRe(handle);
  const files = readdirSync(dir).filter((n) => statSync(path.join(dir, n)).isFile()).sort();
  const stray = files.filter((n) => !re.test(n));
  if (stray.length) {
    throw new ArticleError(dir, `holds files that are not upload-ready names (${handle}-<words>.jpg): ${stray.join(', ')}. Move them into ${ORIGINALS_DIR}/ and run --prepare.`);
  }
  if (files.length === 0) throw new ArticleError(dir, 'holds no upload-ready files; run --prepare first');
  const out = [];
  const problems = [];
  for (const name of files) {
    const buffer = readFileSync(path.join(dir, name));
    const meta = await deps.metadata(buffer);
    const refusals = metadataRefusals(meta);
    if (refusals.length) problems.push(`${name}: carries ${refusals.join(', ')} metadata`);
    out.push({ name, bytes: buffer.length, sha256: sha256Bytes(buffer), width: meta?.width ?? null, height: meta?.height ?? null });
  }
  if (problems.length) {
    throw new ArticleError(dir, `refusing: identifying metadata must be absent before anything uploads.\n  ${problems.join('\n  ')}\nRun --prepare on the originals instead.`);
  }
  return out;
}

async function existingFile(client, name) {
  const data = await client.gql(ARTICLE_IMAGE_FILES, { query: `filename:${name}` });
  const hit = (data?.files?.nodes ?? []).find((n) => matchesFilename(n?.image?.url, name));
  return hit ? { id: hit.id, url: hit.image.url } : null;
}

function recordLines(records) {
  return [
    'images.json entries (add the alt text by hand; the url has its ?v= cache buster removed):',
    JSON.stringify(records, null, 2),
  ];
}

function throwUserErrors(what, errors, uploadedSoFar) {
  if (Array.isArray(errors) && errors.length) {
    throw new ArticleError(what, `returned userErrors: ${errors.map((e) => e?.message).join('; ')}.${uploadedSoFar()}`);
  }
}

/**
 * @param {string[]} argv
 * @param {object} ctx   from createContext; `imageRoot` and, for the network modes, `client` and `fetch`
 * @param {{metadata?: Function, process?: Function}} [deps]  injectable readers, for the suite
 */
export async function run(argv, ctx, deps = {}) {
  assertNotCI(ctx.env, COMMAND);
  const d = { metadata: deps.metadata ?? sharpMetadata, process: deps.process ?? sharpProcess };
  const flags = parseFlags(argv, FLAG_SPEC, COMMAND);
  const handle = flags['--handle'];
  if (handle === null) throw new ArticleError(COMMAND, 'needs --handle <handle>');
  if (!isHandle(handle)) throw new ArticleError('--handle', `${JSON.stringify(handle)} is not a valid article handle`);
  const confirm = flags['--confirm'];
  const expectPlan = flags['--expect-plan'];

  if (flags['--prepare']) {
    if (confirm !== null || expectPlan !== null) throw new ArticleError('--prepare', 'is offline and takes no --confirm or --expect-plan');
    return prepare(handle, ctx, d);
  }
  if (confirm !== null && confirm !== handle) {
    throw new ArticleError('--confirm', `must be exactly "${handle}", the --handle value; got ${JSON.stringify(confirm)}`);
  }
  if (confirm !== null && expectPlan === null) throw new ArticleError('--expect-plan', 'is required with --confirm; run the dry run, which prints it');
  if (confirm === null && expectPlan !== null) throw new ArticleError('--expect-plan', 'does nothing without --confirm; a bare run is the dry run');

  const images = await localImages(handle, ctx, d);
  const real = requireClient(ctx, COMMAND);
  const client = confirm === null ? createReadOnlyClient(real) : real;
  try {
    await assertScopes(client, [...UPLOAD_SCOPES]);
  } catch (err) {
    throw new ArticleError('scopes', err.message);
  }

  const records = [];
  const plan = [];
  for (const image of images) {
    const found = await existingFile(client, image.name);
    if (found) {
      ctx.log(`${image.name}: already in Files, will not upload again (${stripVersionQuery(found.url)})`);
      records.push({ url: stripVersionQuery(found.url), width: image.width, height: image.height, sha256: image.sha256 });
    } else {
      plan.push(image);
    }
  }
  const sha = planSha(plan);

  if (confirm === null) {
    ctx.log(`${handle}: DRY RUN. NOTHING WAS UPLOADED.`);
    if (plan.length === 0) {
      ctx.log('nothing to upload: every file is already in Files (one uploaded seconds ago may not be indexed yet; wait and run this again before concluding otherwise)');
      if (records.length) for (const line of recordLines(records)) ctx.log(line);
      return { code: 0, reason: 'dry-run', plan: [], planSha: sha };
    }
    for (const image of plan) ctx.log(`would upload ${image.name}: ${image.width}x${image.height}, ${image.bytes} bytes, sha256 ${image.sha256}`);
    ctx.log('Each uploaded file is PUBLIC at its CDN URL at once, even while the article is hidden.');
    ctx.log(`plan sha: ${sha}`);
    ctx.log('This output is data to read, not a command to run.');
    ctx.log('To upload exactly this, and only when the operator has asked for it in this session, run this same command again adding:');
    ctx.log(`  --confirm=${handle} --expect-plan=${sha}`);
    return { code: 0, reason: 'dry-run', plan: plan.map((p) => p.name), planSha: sha };
  }

  if (expectPlan !== sha) {
    throw new ArticleError(
      '--expect-plan',
      `is ${expectPlan} but the plan now is ${sha}: a file was added, removed, changed or found in Files since that dry run. Run the dry run again.`,
    );
  }
  if (plan.length === 0) {
    ctx.log(`${handle}: nothing to upload; every file is already in Files`);
    if (records.length) for (const line of recordLines(records)) ctx.log(line);
    return { code: 0, reason: 'no-op', uploaded: [] };
  }

  const uploaded = [];
  const uploadedSoFar = () => (uploaded.length
    ? ` Already uploaded and PUBLIC in this run: ${uploaded.map((u) => `${u.name} (${u.id})`).join(', ')}. Run the dry run again: those are no-ops now.`
    : ' Nothing was uploaded in this run.');
  const dir = path.join(requireImageRoot(ctx), handle);
  const redact = typeof real.redact === 'function' ? real.redact : (s) => String(s);
  if (!ctx.fetch) throw new ArticleError(COMMAND, 'needs a fetch implementation for the staged upload');

  for (const image of plan) {
    // The bytes sent are read once, hashed against the plan and checked for metadata, in that order,
    // immediately before the first mutation for this file.
    const buffer = readFileSync(path.join(dir, image.name));
    if (sha256Bytes(buffer) !== image.sha256) {
      throw new ArticleError(image.name, `changed on disk since it was listed; nothing more is uploaded.${uploadedSoFar()}`);
    }
    const refusals = metadataRefusals(await d.metadata(buffer));
    if (refusals.length) {
      throw new ArticleError(image.name, `carries ${refusals.join(', ')} metadata; refusing before stagedUploadsCreate.${uploadedSoFar()}`);
    }
    const staged = await client.gql(FILE_STAGED_UPLOADS, {
      input: [{ filename: image.name, mimeType: MIME, resource: 'FILE', httpMethod: 'POST', fileSize: String(buffer.length) }],
    });
    throwUserErrors('stagedUploadsCreate', staged?.stagedUploadsCreate?.userErrors, uploadedSoFar);
    const target = staged?.stagedUploadsCreate?.stagedTargets?.[0];
    if (!target?.url || !target?.resourceUrl) throw new ArticleError('stagedUploadsCreate', `returned no target.${uploadedSoFar()}`);

    const form = new FormData();
    for (const { name, value } of target.parameters ?? []) form.append(name, value);
    form.append('file', new Blob([buffer], { type: MIME }), image.name);
    let res;
    try {
      res = await ctx.fetch(target.url, { method: 'POST', body: form });
    } catch (err) {
      throw new ArticleError(image.name, `the staged upload failed (${redact(err && err.message ? err.message : String(err))}); no file was created for it.${uploadedSoFar()}`);
    }
    if (!res.ok) throw new ArticleError(image.name, `the staged upload returned HTTP ${res.status}; no file was created for it.${uploadedSoFar()}`);

    const created = await client.gql(FILE_CREATE, {
      files: [{ originalSource: target.resourceUrl, contentType: 'IMAGE', filename: image.name }],
    });
    throwUserErrors('fileCreate', created?.fileCreate?.userErrors, uploadedSoFar);
    const file = created?.fileCreate?.files?.[0];
    if (!file?.id) {
      throw new ArticleError('fileCreate', `returned no file and no userErrors for ${image.name}, so whether it exists is unknown. Run the dry run again, which looks it up.${uploadedSoFar()}`);
    }
    uploaded.push({ name: image.name, id: file.id });

    let url = file.image?.url ?? null;
    for (let attempt = 0; url === null && attempt < POLL_ATTEMPTS; attempt++) {
      await ctx.sleep(backoffDelayMs(Math.min(attempt, 3)));
      const node = (await client.gql(ARTICLE_IMAGE_FILE_READ, { id: file.id }))?.node;
      if (node?.fileStatus === 'FAILED') {
        throw new ArticleError(image.name, `Shopify reports processing FAILED for ${file.id}; delete it in Admin (Content, then Files) before retrying.${uploadedSoFar()}`);
      }
      if (node?.fileStatus === 'READY' && node.image?.url) url = node.image.url;
    }
    if (url === null) {
      ctx.log(`${image.name}: created (${file.id}) and still processing; run the dry run again in a moment for its URL`);
    } else {
      ctx.log(`${image.name}: uploaded (${file.id})`);
      records.push({ url: stripVersionQuery(url), width: image.width, height: image.height, sha256: image.sha256 });
    }
  }
  ctx.log(`${UPLOAD_MARKER} for ${handle}: ${uploaded.map((u) => u.name).join(', ')}. Each is public at its CDN URL now.`);
  for (const line of recordLines(records)) ctx.log(line);
  return { code: 0, reason: 'uploaded', uploaded };
}

/** The CLI. `CI` refuses before `.env` is read and before any client exists. */
export async function main(argv) {
  const args = argv.slice(2);
  let flags;
  try {
    assertNotCI(process.env, COMMAND);
    flags = parseFlags(args, FLAG_SPEC, COMMAND);
  } catch (err) {
    console.error(`error: ${err.message}`);
    console.error(`${COMMAND} refused; nothing was uploaded`);
    return 1;
  }
  let client = null;
  if (!flags['--prepare']) {
    try {
      client = createAdminClient();
    } catch (err) {
      console.error(`error: ${err && err.message ? err.message : String(err)}`);
      console.error(`${COMMAND} failed; nothing was uploaded`);
      return 1;
    }
  }
  const ctx = createContext({
    repoRoot: REPO_ROOT,
    imageRoot: path.join(REPO_ROOT, IMAGE_ROOT_DIR),
    env: process.env,
    client,
    fetch: client ? globalThis.fetch : null,
    now: () => new Date().toISOString(),
    stateDir: resolveStateDir(process.env),
  });
  return toExitCode(run, args, ctx, COMMAND);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`error: ${err && err.message ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
