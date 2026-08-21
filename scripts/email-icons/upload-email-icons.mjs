#!/usr/bin/env node
// Upload the rendered social icons to Shopify Files and print their CDN URLs, for pasting into
// `marketing/emails/*.liquid`.
//
// This writes to the LIVE store, so the rails are the same shape as the rest of the repo's write
// tooling, scaled to a job that creates at most three small files:
//
//   - A bare run is a DRY RUN. It resolves the shop, checks scopes, reports which icons already
//     exist in Files, and uploads nothing.
//   - A live run needs one `--upload <name>` per icon, naming each file explicitly. There is no
//     `--all`: three flags is a cheap price for making "which files am I about to create?"
//     unambiguous.
//   - Duplicate-proof: Files has no content dedup and `fileCreate` will happily make a second
//     `email-icon-instagram.png` with a different URL, silently orphaning whatever the templates
//     point at. Every name is checked against a filename query first and skipped if it exists.
//     One limit worth knowing: a just-uploaded file takes a few seconds to appear in the `files`
//     query, so a dry run fired immediately after a live one reports "not in Files" for something
//     that exists. Wait a moment and re-run rather than uploading again.
//   - Bounded authority: it creates files. It never updates or deletes one, and touches nothing
//     else in the store.
//   - The token is minted at runtime from SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET by the shared
//     client, never printed. Only `write_files` is required; this tool does not touch products.
//
// Run `render-email-icons.mjs` first: this uploads the committed PNGs, it does not render them.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAdminClient, assertScopes } from '../blank-inventory/lib/admin.mjs';
import { ICON_NAMES, ICON_LABELS } from './lib/icons.mjs';
import { fileNameFor } from './render-email-icons.mjs';

const REQUIRED_SCOPES = ['write_files'];
const ASSET_DIR = 'marketing/emails/assets';
const MIME = 'image/png';

const Q_FILE_BY_NAME = `query FileByName($query: String!) {
  files(first: 10, query: $query) {
    nodes { id alt createdAt ... on MediaImage { image { url } } }
  }
}`;

const M_STAGED = `mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}`;

const M_FILE_CREATE = `mutation FileCreate($files: [FileCreateInput!]!) {
  fileCreate(files: $files) {
    files { id alt fileStatus ... on MediaImage { image { url } } }
    userErrors { field message }
  }
}`;

/** Alt text for the Files entry. The email's own `alt` attribute is set in the template. */
export const altFor = (name) => `${ICON_LABELS[name]} icon for email footers`;

export function parseArgs(argv) {
  const opts = { upload: [] };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument ${a}`);
    a = a.slice(2);
    let val;
    const eq = a.indexOf('=');
    if (eq !== -1) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    if (a !== 'upload') throw new Error(`Unknown option --${a}`);
    const name = val ?? argv[++i];
    if (!ICON_NAMES.includes(name)) {
      throw new Error(`--upload ${name}: not an icon. Known: ${ICON_NAMES.join(', ')}`);
    }
    if (!opts.upload.includes(name)) opts.upload.push(name);
  }
  return opts;
}

function throwUserErrors(label, errors) {
  if (errors?.length) throw new Error(`${label}: ${errors.map((e) => e.message).join('; ')}`);
}

/**
 * Whether a CDN URL is the file we are about to create. Shopify keeps the uploaded filename in the
 * URL path but adds a `?v=` cache buster, and on a name collision it appends `_1`, `_2` and so on,
 * so the comparison is on the URL's basename stem and has to tolerate that suffix.
 * Pure, so the duplicate guard is testable without a store.
 * @param {string | undefined} url
 * @param {string} filename
 * @returns {boolean}
 */
export function matchesFilename(url, filename) {
  if (!url) return false;
  let stem;
  try {
    stem = path.parse(path.basename(new URL(url).pathname)).name;
  } catch {
    return false;
  }
  const wanted = path.parse(filename).name;
  return stem === wanted || new RegExp(`^${wanted}_\\d+$`).test(stem);
}

/**
 * Find an already-uploaded icon by filename.
 * @returns {Promise<{id: string, url: string} | null>}
 */
async function existingFile(client, filename) {
  const data = await client.gql(Q_FILE_BY_NAME, { query: `filename:${filename}` });
  const hit = (data.files?.nodes ?? []).find((n) => matchesFilename(n.image?.url, filename));
  return hit ? { id: hit.id, url: hit.image.url } : null;
}

async function uploadOne(client, name) {
  const filename = fileNameFor(name);
  const bytes = await readFile(path.join(ASSET_DIR, filename));

  const staged = await client.gql(M_STAGED, {
    input: [{ filename, mimeType: MIME, resource: 'FILE', httpMethod: 'POST', fileSize: String(bytes.length) }],
  });
  throwUserErrors('stagedUploadsCreate', staged.stagedUploadsCreate?.userErrors);
  const target = staged.stagedUploadsCreate.stagedTargets[0];

  const form = new FormData();
  for (const { name: k, value } of target.parameters) form.append(k, value);
  form.append('file', new Blob([bytes], { type: MIME }), filename);
  const res = await fetch(target.url, { method: 'POST', body: form });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(client.redact(`staged upload POST failed (${res.status}): ${body.slice(0, 300)}`));
  }

  const created = await client.gql(M_FILE_CREATE, {
    files: [{ originalSource: target.resourceUrl, contentType: 'IMAGE', alt: altFor(name), filename }],
  });
  throwUserErrors('fileCreate', created.fileCreate?.userErrors);
  return created.fileCreate.files[0];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const client = createAdminClient();
  await assertScopes(client, REQUIRED_SCOPES);

  const live = opts.upload.length > 0;
  const names = live ? opts.upload : ICON_NAMES;

  const known = new Map();
  for (const name of names) {
    const filename = fileNameFor(name);
    const found = await existingFile(client, filename);
    known.set(name, found);
    console.log(`${filename.padEnd(28)} ${found ? `already in Files: ${found.url}` : 'not in Files'}`);
  }

  if (!live) {
    console.log('\nDry run: nothing was uploaded. To upload, name each file explicitly, for example:');
    console.log(`  node --env-file=.env scripts/email-icons/upload-email-icons.mjs ${ICON_NAMES.map((n) => `--upload ${n}`).join(' ')}`);
    return;
  }

  for (const name of names) {
    if (known.get(name)) {
      console.log(`\nSkipping ${name}: a file with that name already exists. Delete it in Admin first if you meant to replace it.`);
      continue;
    }
    const file = await uploadOne(client, name);
    console.log(`\nUploaded ${fileNameFor(name)}`);
    console.log(`  status: ${file.fileStatus}`);
    console.log(`  url:    ${file.image?.url ?? '(still processing; re-run a dry run in a moment for the URL)'}`);
  }

  console.log('\nPaste the URLs into marketing/emails/welcome.liquid and campaign-shell.liquid, and');
  console.log('record them in marketing/emails/README.md. Strip the ?v= query string: it is a cache');
  console.log('buster, not part of the identity of the file.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
