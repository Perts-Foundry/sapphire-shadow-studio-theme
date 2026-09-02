#!/usr/bin/env node
// Records a stock notification template into marketing/notifications/stock/<id>.liquid
// and its manifest entry (subject, sha256, length in UTF-16 code units as String.length reports
// it, not bytes). Input forms:
//
//   --file <path>      a file saved from the Admin editor (select all, copy, paste into a file)
//   --dump <path...>   one or more console dumps produced by browser/editor-dump.js
//                      (SSSLEN / SSSHASH / SSSCHUNK<n> lines), reassembled and verified by dump.mjs
//
//   node scripts/notifications/record-stock.mjs --id order_confirmation \
//     --subject "Order {{name}} confirmed" --file /path/to/saved.liquid
//
// Refuses on a length or hash mismatch, a missing or duplicate chunk, a replacement
// character, a lone surrogate, a carriage return or a BOM, because the snapshot is what
// every other check trusts.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, readManifest, sha256, REPO_ROOT } from './brand.mjs';
import { fnv1a, verifyText, parseDump } from './dump.mjs';

// The dump contract (fnv1a, verifyText, parseDump, reassembleDump and the line prefixes) lives in
// dump.mjs, the one path for it; these re-exports keep older imports working.
export { fnv1a, verifyText, parseDump, reassembleDump, LEN_PREFIX, HASH_PREFIX, CHUNK_PREFIX } from './dump.mjs';

// An envelope is the JSON file the extraction init script downloads from the Admin editor:
// { id, length, hash, subject, revertDisabled, text }. Returns the same shape as parseDump.
export function parseEnvelope(jsonText) {
  const env = JSON.parse(jsonText);
  if (!env || typeof env.text !== 'string' || typeof env.id !== 'string') {
    throw new Error('envelope lacks id or text');
  }
  verifyText(env.text, { length: env.length, hash: env.hash });
  return {
    id: env.id,
    text: env.text,
    subject: typeof env.subject === 'string' ? env.subject : undefined,
    revertDisabled: typeof env.revertDisabled === 'boolean' ? env.revertDisabled : undefined,
    length: env.text.length,
    hash: fnv1a(env.text),
  };
}

export function record({ root = REPO_ROOT, id, subject, text }) {
  if (!/^[a-z0-9_]+$/.test(id)) throw new Error(`bad id: ${id}`);
  verifyText(text);
  const p = paths(root);
  const manifest = existsSync(p.manifest) ? readManifest(root) : { templates: {} };
  const prev = manifest.templates[id] || {};
  const entry = { ...prev, stockSha256: sha256(text), stockLength: text.length };
  if (subject !== undefined) entry.subject = subject;
  // An override or skip was written against the previous snapshot. When the stock content changes
  // it is stale: a kept override could resolve to the wrong anchor without any error, and a kept
  // skip would keep --check green while the template silently never gets rebranded. Drop both so
  // the next generate refuses (or brands from the stock anchors) and the operator re-decides.
  if (prev.stockSha256 !== undefined && prev.stockSha256 !== entry.stockSha256) {
    for (const field of ['override', 'skip']) {
      if (field in entry) {
        delete entry[field];
        console.error(`${id}: stock content changed; dropped the manifest ${field} recorded against the old snapshot`);
      }
    }
  }
  manifest.templates[id] = entry;
  manifest.templates = Object.fromEntries(
    Object.keys(manifest.templates).sort().map((k) => [k, manifest.templates[k]]),
  );
  writeFileSync(p.stock(id), text, 'utf8');
  writeFileSync(p.manifest, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return entry;
}

function main(argv) {
  const args = argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const envelope = get('--envelope');
  const id = get('--id') || (envelope ? parseEnvelope(readFileSync(envelope, 'utf8')).id : undefined);
  const subject = get('--subject');
  const file = get('--file');
  const dumpAt = args.indexOf('--dump');
  const rootFlag = get('--root');
  const root = rootFlag ? resolve(rootFlag) : REPO_ROOT;
  if (!id || (!file && !envelope && dumpAt === -1)) {
    console.error('usage: record-stock.mjs --id <id> [--subject <text>] (--file <path> | --envelope <path> | --dump <path...>)');
    return 2;
  }
  let text;
  let dumpSubject;
  let revertDisabled;
  if (file) {
    text = readFileSync(file, 'utf8');
  } else if (envelope) {
    const parsed = parseEnvelope(readFileSync(envelope, 'utf8'));
    if (parsed.id !== id) throw new Error(`envelope is for ${parsed.id}, not ${id}`);
    text = parsed.text;
    dumpSubject = parsed.subject;
    revertDisabled = parsed.revertDisabled;
  } else {
    // Everything after --dump up to the next flag; a later flag's value (`--root <dir>`) is not a dump.
    const rest = args.slice(dumpAt + 1);
    const nextFlag = rest.findIndex((a) => a.startsWith('--'));
    const dumps = nextFlag === -1 ? rest : rest.slice(0, nextFlag);
    if (dumps.length === 0) {
      console.error('usage: --dump needs at least one path');
      return 2;
    }
    const parsed = parseDump(dumps.map((d) => readFileSync(d, 'utf8')).join('\n'));
    text = parsed.text;
    dumpSubject = parsed.subject;
    revertDisabled = parsed.revertDisabled;
  }
  const entry = record({ root, id, subject: subject !== undefined ? subject : dumpSubject, text });
  const revertNote = revertDisabled === undefined ? '' : revertDisabled ? ', editor showed stock (revert disabled)' : ', editor had UNSAVED or CUSTOM content (revert enabled)';
  console.log(`${id}: recorded ${entry.stockLength} chars, sha256 ${entry.stockSha256.slice(0, 12)}..., subject ${JSON.stringify(entry.subject)}${revertNote}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
