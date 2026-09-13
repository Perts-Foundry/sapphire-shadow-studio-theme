#!/usr/bin/env node
// Prepare and upload one article's photos to Shopify Files. The only supported way an article image
// reaches the store.
//
//   --handle <handle> --prepare
//        offline: process article-images/<handle>/originals/* into upload-ready JPEGs beside them
//   --handle <handle>
//        dry run: list exactly what would upload and what is already in Files; upload nothing
//   --handle <handle> --confirm=<handle> --expect-plan=<sha>
//        upload exactly the plan that dry run printed
//
// No package.json key: it is run by module path, with credentials passed explicitly the way every
// other Admin tool here is (scripts/README.md, Credentials). Nothing here loads `.env` by itself.
// The full command lines are in .claude/skills/articles/images.md and nowhere else under the trees
// the no-invocation guard scans, including this header: the guard refuses this module's path
// everywhere but that doc, because an upload is a live write that makes files public at once.
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
//     is then sent: EXIF, XMP, IPTC, any text chunk sharp reports, and JPEG COM segments (which sharp
//     does not report, so they are found by walking the segment headers here). Not only after
//     processing, because the bytes on disk can change between the two, and camera EXIF carries GPS.
//   - ONLY JPEG BYTES UPLOAD. A file dropped into the directory by hand with a `.jpg` name is refused
//     unless its bytes are a JPEG, so a PNG or a document cannot ride along under an allowed name.
//   - A FILE IS REPORTED AS UPLOADED ONLY ONCE ITS OUTCOME IS KNOWN: created with an id, no
//     userErrors, and not reported FAILED by the processing poll. A refusal names every file that
//     reached that point, and never the file it is refusing.
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
import { matchesFilename } from '../lib/shopify-files.mjs';
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

/** True when the bytes open with a JPEG start-of-image marker. Decided on the bytes, never the name. */
export function isJpegBytes(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

/**
 * How many COM (comment) segments a JPEG's header carries, or null when the segment structure cannot
 * be walked. sharp's `metadata()` does not report COM, and a COM segment is free text that can carry
 * anything a camera, an editor or a person put there, so the headers are walked here up to the
 * start of scan.
 *
 * @param {Buffer} buffer
 * @returns {number|null}
 */
export function jpegCommentCount(buffer) {
  if (!isJpegBytes(buffer)) return null;
  let count = 0;
  let i = 2;
  while (i < buffer.length) {
    if (buffer[i] !== 0xff) return null;
    while (i < buffer.length && buffer[i] === 0xff) i++;
    if (i >= buffer.length) return null;
    const marker = buffer[i++];
    if (marker === 0xd9 || marker === 0xda) return count;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (i + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(i);
    if (length < 2) return null;
    if (marker === 0xfe) count++;
    i += length;
  }
  return null;
}

/**
 * Which identifying metadata a file carries, from a sharp `metadata()` result and, when given, the
 * bytes themselves (for the COM segments sharp does not report). Empty means clean.
 *
 * @param {{exif?: unknown, xmp?: unknown, iptc?: unknown, comments?: unknown[]}} meta
 * @param {Buffer|null} [buffer]
 * @returns {string[]}
 */
export function metadataRefusals(meta, buffer = null) {
  const out = [];
  if (meta?.exif) out.push('EXIF');
  if (meta?.xmp) out.push('XMP');
  if (meta?.iptc) out.push('IPTC');
  if (Array.isArray(meta?.comments) && meta.comments.length) out.push('text chunk');
  if (isJpegBytes(buffer)) {
    const com = jpegCommentCount(buffer);
    if (com === null) out.push('unreadable JPEG segment');
    else if (com > 0) out.push('JPEG COM');
  }
  return out;
}

/**
 * Every reason a file may not upload, as sentence fragments: not a JPEG, or carrying metadata.
 * Empty means it may.
 */
export function imageProblems(meta, buffer) {
  const out = [];
  if (!isJpegBytes(buffer) || (meta?.format !== undefined && meta.format !== 'jpeg')) out.push('is not a JPEG');
  const refusals = metadataRefusals(meta, buffer);
  if (refusals.length) out.push(`carries ${refusals.join(', ')} metadata`);
  return out;
}

/**
 * The client a run sends through: the read-only wrapper for a dry run, which throws on any mutation
 * document before the network, and the real client only for a confirmed run.
 */
export function uploadClient(real, confirmed) {
  return confirmed ? real : createReadOnlyClient(real);
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
  // Every output is processed and checked before any is written, so a refusal on the last source
  // really does mean nothing was written, not "nothing after the files already written".
  const ready = [];
  for (const [name, source] of names) {
    const out = path.join(dir, name);
    if (existsSync(out)) {
      ctx.log(`${name}: exists, left as it is (delete it to process ${source} again)`);
      continue;
    }
    const { data, width, height } = await deps.process(readFileSync(path.join(originals, source)));
    const problems = imageProblems(await deps.metadata(data), data);
    if (problems.length) throw new ArticleError(name, `the processed output ${problems.join('; ')}; nothing was written`);
    ready.push({ name, source, out, data, width, height });
  }
  mkdirSync(dir, { recursive: true });
  for (const { name, source, out, data, width, height } of ready) {
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
    const found = imageProblems(meta, buffer);
    if (found.length) problems.push(`${name}: ${found.join('; ')}`);
    out.push({ name, bytes: buffer.length, sha256: sha256Bytes(buffer), width: meta?.width ?? null, height: meta?.height ?? null });
  }
  if (problems.length) {
    throw new ArticleError(dir, `refusing: every file must be a JPEG with no identifying metadata before anything uploads.\n  ${problems.join('\n  ')}\nRun --prepare on the originals instead.`);
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
  const client = uploadClient(real, confirm !== null);
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
    const problems = imageProblems(await d.metadata(buffer), buffer);
    if (problems.length) {
      throw new ArticleError(image.name, `${problems.join('; ')}; refusing before stagedUploadsCreate.${uploadedSoFar()}`);
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

    // Not recorded as uploaded yet: until the poll ends without FAILED this file's outcome is not
    // known, and a refusal from here must never list the file it is refusing as public.
    let url = file.image?.url ?? null;
    for (let attempt = 0; url === null && attempt < POLL_ATTEMPTS; attempt++) {
      await ctx.sleep(backoffDelayMs(Math.min(attempt, 3)));
      let node;
      try {
        node = (await client.gql(ARTICLE_IMAGE_FILE_READ, { id: file.id }))?.node;
      } catch (err) {
        throw new ArticleError(image.name, `was created as ${file.id}, but reading its processing state failed (${redact(err && err.message ? err.message : String(err))}), so it may be public. Run the dry run again, which looks it up.${uploadedSoFar()}`);
      }
      if (node?.fileStatus === 'FAILED') {
        throw new ArticleError(image.name, `Shopify reports processing FAILED for ${file.id}; delete it in Admin (Content, then Files) before retrying.${uploadedSoFar()}`);
      }
      if (node?.fileStatus === 'READY' && node.image?.url) url = node.image.url;
    }
    uploaded.push({ name: image.name, id: file.id });
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
