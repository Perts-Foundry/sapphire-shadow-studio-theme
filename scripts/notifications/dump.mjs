#!/usr/bin/env node
// The console-dump contract shared by the browser probes under scripts/notifications/browser/,
// record-stock.mjs, verify-render.mjs and the notification-templates skill. A probe prints the
// text it read (an editor document or a preview document) as console lines:
//
//   SSSLEN <length>       String.length of the text: UTF-16 code units, LF line endings
//   SSSHASH <fnv>         32-bit FNV-1a over those code units, eight lowercase hex digits
//   SSSCHUNK<n> <text>    the text in order, chunk n of the sequence 0..k
//
// and this module puts it back together and refuses anything that does not verify. The hash
// contract, stated once: both sides hash the UTF-16 code units of the LF-normalised text with
// 32-bit FNV-1a (h = 0x811c9dc5; h ^= unit; h *= 0x01000193 mod 2^32), and the length is the
// LF-normalised String.length. The probes embed the same function; test/browser-probes.test.mjs
// runs each probe's copy under node:vm and asserts it agrees with fnv1a() here on non-ASCII and
// CRLF input. Optional lines the editor dump also carries: SSSSUBJ <subject>, SSSREVERT true|false.
//
//   node scripts/notifications/dump.mjs <dump...> [--out <file>]   reassemble and verify;
//                                                                  print (or write) the text
//   node scripts/notifications/dump.mjs --hash <file>               print "<length> <fnv>" of a
//                                                                  file, the numbers a probe's
//                                                                  SSSPOLL line must match
//
// A persisted MCP console result is accepted in both of its shapes: plain text, and a JSON array
// of { text } parts.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEN_PREFIX = 'SSSLEN';
export const HASH_PREFIX = 'SSSHASH';
export const CHUNK_PREFIX = 'SSSCHUNK';
export const CHUNK_SIZE = 8000;

// FNV-1a, 32-bit, over UTF-16 code units. Mirrors the copy embedded in every browser probe.
export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function verifyText(text, expected = {}) {
  if (expected.length !== undefined && text.length !== expected.length) {
    throw new Error(`length mismatch: reassembled ${text.length}, dump said ${expected.length}`);
  }
  if (expected.hash !== undefined && fnv1a(text) !== expected.hash) {
    throw new Error(`hash mismatch: reassembled ${fnv1a(text)}, dump said ${expected.hash}`);
  }
  if (text.includes('�')) throw new Error('text contains U+FFFD (replacement character)');
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) {
    throw new Error('text contains a lone surrogate');
  }
  if (text.includes('\r')) throw new Error('text contains a carriage return');
  if (text.charCodeAt(0) === 0xfeff) throw new Error('text starts with a BOM');
  if (text.length === 0) throw new Error('text is empty');
}

// A dump is the console output of a probe: one `msgid=N [log] ...` message per line group. The
// MCP client sometimes persists it as a JSON array of { text } parts instead of plain text; both
// forms are accepted. Returns { text, subject, revertDisabled, length, hash }. A second SSSLEN or
// SSSHASH line is a refusal: two probes' output pasted together, or a template body that carries
// the literal, must not silently pick one.
export function parseDump(dumpText) {
  let raw = dumpText;
  if (/^\s*\[/.test(raw)) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) raw = parsed.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('\n');
    } catch {
      // not JSON after all; treat as plain text
    }
  }
  const segments = raw.split(/^msgid=\d+ \[log\] /m).slice(1);
  let length;
  let hash;
  let subject;
  let revertDisabled;
  const chunks = new Map();
  for (const seg of segments) {
    // \n* not \n?: the JSON-array form joins parts with '\n', so a part that already ends in a
    // newline leaves two after the terminator, and an unstripped SSSSUBJ is recorded silently.
    const body = seg.replace(/ \(1 args\)\n*$/, '');
    let m;
    if ((m = /^SSSLEN (\d+)\s*$/.exec(body))) {
      if (length !== undefined) throw new Error('duplicate SSSLEN line in dump');
      length = Number(m[1]);
    } else if ((m = /^SSSHASH ([0-9a-f]{8})\s*$/.exec(body))) {
      if (hash !== undefined) throw new Error('duplicate SSSHASH line in dump');
      hash = m[1];
    } else if ((m = /^SSSSUBJ (.*)$/s.exec(body))) subject = m[1].replace(/\n$/, '');
    else if ((m = /^SSSREVERT (true|false)\s*$/.exec(body))) revertDisabled = m[1] === 'true';
    else if ((m = /^SSSCHUNK(\d+) /.exec(body))) {
      const k = Number(m[1]);
      if (chunks.has(k)) throw new Error(`duplicate chunk ${k}`);
      chunks.set(k, body.slice(m[0].length));
    }
  }
  if (length === undefined) throw new Error('no SSSLEN line in dump');
  if (hash === undefined) throw new Error('no SSSHASH line in dump');
  const keys = [...chunks.keys()].sort((a, b) => a - b);
  if (keys.length === 0) throw new Error('no SSSCHUNK lines in dump');
  for (let i = 0; i < keys.length; i++) if (keys[i] !== i) throw new Error(`missing chunk ${i}`);
  const text = keys.map((k) => chunks.get(k)).join('');
  verifyText(text, { length, hash });
  return { text, subject, revertDisabled, length, hash };
}

export function reassembleDump(dumpText) {
  return parseDump(dumpText).text;
}

// The SSSPOLL line editor-probe.js prints: `SSSPOLL <length> <fnv> <source>`; the last one in a
// console listing is the editor's current document. Returns { length, hash, source } or null.
export function parsePoll(consoleText) {
  const re = /SSSPOLL (\d+) ([0-9a-f]{8}) ([a-z0-9-]+)/g;
  let last = null;
  let m;
  while ((m = re.exec(consoleText)) !== null) last = { length: Number(m[1]), hash: m[2], source: m[3] };
  return last;
}

// The SSSSTORED line editor-probe.js prints on a cold navigation: `SSSSTORED <length> <fnv>`,
// taken from the EmailTemplate response rather than from the widget, so it is not exposed to the
// editor's load race (Admin renders the stock body first and swaps the saved override in). Returns
// { length, hash } for a reading, `unavailable` when a matching response carried no usable body,
// or null when the probe saw no such response at all.
export function parseStored(consoleText) {
  if (/SSSSTORED unavailable/.test(consoleText) && !/SSSSTORED \d/.test(consoleText)) return 'unavailable';
  const re = /SSSSTORED (\d+) ([0-9a-f]{8})/g;
  let last = null;
  let m;
  while ((m = re.exec(consoleText)) !== null) last = { length: Number(m[1]), hash: m[2] };
  return last;
}

// The SSSSETTLED line: the editor document stopped changing. A positive signal that the widget has
// finished loading, so no step in the skill ever has to guess a settle interval.
export function parseSettled(consoleText) {
  const re = /SSSSETTLED (\d+) ([0-9a-f]{8})/g;
  let last = null;
  let m;
  while ((m = re.exec(consoleText)) !== null) last = { length: Number(m[1]), hash: m[2] };
  return last;
}

// The numbers an editor holding exactly this file would report: LF-normalised length and FNV.
export function hashFile(file) {
  const text = readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
  return { length: text.length, hash: fnv1a(text) };
}

function main(argv) {
  const args = argv.slice(2);
  const hashAt = args.indexOf('--hash');
  if (hashAt !== -1) {
    const file = args[hashAt + 1];
    if (!file) {
      console.error('usage: dump.mjs --hash <file>');
      return 2;
    }
    const { length, hash } = hashFile(file);
    console.log(`${length} ${hash}`);
    return 0;
  }
  const outAt = args.indexOf('--out');
  const out = outAt === -1 ? null : args[outAt + 1];
  const files = args.filter((a, i) => !a.startsWith('--') && (outAt === -1 || i !== outAt + 1));
  if (files.length === 0) {
    console.error('usage: dump.mjs <dump...> [--out <file>]');
    return 2;
  }
  const { text, length, hash, subject, revertDisabled } = parseDump(files.map((f) => readFileSync(f, 'utf8')).join('\n'));
  if (out) {
    writeFileSync(out, text, 'utf8');
    const extra = [subject !== undefined ? `subject ${JSON.stringify(subject)}` : null, revertDisabled !== undefined ? `revert ${revertDisabled ? 'disabled' : 'enabled'}` : null].filter(Boolean);
    console.error(`reassembled ${length} chars, fnv ${hash}${extra.length ? ', ' + extra.join(', ') : ''} -> ${out}`);
  } else {
    process.stdout.write(text);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
