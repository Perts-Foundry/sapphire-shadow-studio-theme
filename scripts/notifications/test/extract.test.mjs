// scripts/notifications/record-stock.mjs reassembles a stock template from the console dump the
// extraction init script prints, verifies it, and records it into the manifest. The snapshot it
// writes is what every later check trusts, so this suite is mostly about what it refuses.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fnv1a, verifyText, parseDump, reassembleDump } from '../dump.mjs';
import { parseEnvelope, record } from '../record-stock.mjs';
import * as recordStock from '../record-stock.mjs';
import * as dump_ from '../dump.mjs';
import { paths, sha256 } from '../brand.mjs';

// Independent reference: FNV-1a 32-bit over UTF-16 code units, done in BigInt so it shares no
// arithmetic trick (Math.imul, >>> 0) with the implementation under test.
function referenceFnv1a(text) {
  let h = 0x811c9dc5n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x01000193n) & 0xffffffffn;
  }
  return h.toString(16).padStart(8, '0');
}

// Builds the console dump the init script would have printed. `lines` is an array of
// [tag, payload] pairs, emitted in the order given, so tests control ordering and duplicates.
function dump(lines) {
  return lines.map(([tag, payload], i) => `msgid=${i + 1} [log] ${tag} ${payload} (1 args)\n`).join('');
}

function dumpFor(text, { chunkSize = 4, subject, revert, length = text.length, hash = fnv1a(text) } = {}) {
  const lines = [['SSSLEN', String(length)], ['SSSHASH', hash]];
  if (subject !== undefined) lines.push(['SSSSUBJ', subject]);
  if (revert !== undefined) lines.push(['SSSREVERT', String(revert)]);
  for (let i = 0, k = 0; i < text.length; i += chunkSize, k++) lines.push([`SSSCHUNK${k}`, text.slice(i, i + chunkSize)]);
  return dump(lines);
}

// --- fnv1a -------------------------------------------------------------------------------------

test('fnv1a matches the published 32-bit FNV-1a vectors', () => {
  assert.equal(fnv1a(''), '811c9dc5');
  assert.equal(fnv1a('a'), 'e40c292c');
  assert.equal(fnv1a('foobar'), 'bf9cf968');
});

test('fnv1a agrees with an independent BigInt implementation, including non-ASCII and astral text', () => {
  for (const sample of ['', 'a', 'hello world', '{{ shop.name }}\n', 'café ’ \u00A0 \u{1F9F5}', 'x'.repeat(5000)]) {
    assert.equal(fnv1a(sample), referenceFnv1a(sample), JSON.stringify(sample.slice(0, 20)));
  }
});

test('fnv1a always yields eight lowercase hex digits, zero-padded', () => {
  // 'GKmtdU' hashes to 0x0006C8A3 under FNV-1a 32; without padding it would print 7 digits.
  let found = null;
  for (let n = 0; n < 200000 && found === null; n++) {
    const s = `probe${n}`;
    if (referenceFnv1a(s).startsWith('0')) found = s;
  }
  assert.ok(found, 'no zero-leading probe found');
  assert.match(fnv1a(found), /^0[0-9a-f]{7}$/);
});

// --- verifyText --------------------------------------------------------------------------------

test('verifyText accepts clean text and enforces the expected length and hash when given', () => {
  assert.doesNotThrow(() => verifyText('hello'));
  assert.doesNotThrow(() => verifyText('hello', { length: 5, hash: fnv1a('hello') }));
  assert.throws(() => verifyText('hello', { length: 6 }), /length mismatch: reassembled 5, dump said 6/);
  assert.throws(() => verifyText('hello', { hash: '00000000' }), /hash mismatch: reassembled [0-9a-f]{8}, dump said 00000000/);
});

const verifyRefusals = [
  ['U+FFFD replacement character', 'ab\uFFFDcd', /U\+FFFD/],
  ['a lone high surrogate', 'ab\uD83Ccd', /lone surrogate/],
  ['a lone low surrogate', 'ab\uDF35cd', /lone surrogate/],
  ['a trailing high surrogate', 'ab\uD83C', /lone surrogate/],
  ['a carriage return', 'ab\r\ncd', /carriage return/],
  ['a leading BOM', '\uFEFFabcd', /BOM/],
  ['empty text', '', /empty/],
];

for (const [name, text, re] of verifyRefusals) {
  test(`verifyText refuses ${name}`, () => {
    assert.throws(() => verifyText(text), re);
  });
}

test('verifyText accepts a well-formed surrogate pair and a BOM that is not at the start', () => {
  assert.doesNotThrow(() => verifyText('ab\u{1F9F5}cd'));
  assert.doesNotThrow(() => verifyText('ab\uFEFFcd'));
});

// --- parseDump ---------------------------------------------------------------------------------

test('parseDump reassembles an in-order dump and returns the metadata', () => {
  const text = '<p>{{ shop.name }}</p>\n';
  const r = parseDump(dumpFor(text, { subject: 'Order {{name}} confirmed', revert: true }));
  assert.deepEqual(r, { text, subject: 'Order {{name}} confirmed', revertDisabled: true, length: text.length, hash: fnv1a(text) });
  assert.equal(reassembleDump(dumpFor(text)), text);
});

test('parseDump reassembles out-of-order chunks by index, not by appearance', () => {
  const text = 'ABCDEFGHIJ';
  const lines = [
    ['SSSCHUNK2', 'IJ'],
    ['SSSLEN', '10'],
    ['SSSCHUNK0', 'ABCD'],
    ['SSSHASH', fnv1a(text)],
    ['SSSCHUNK1', 'EFGH'],
  ];
  assert.equal(parseDump(dump(lines)).text, text);
});

test('parseDump refuses a missing chunk, naming the first gap', () => {
  const text = 'ABCDEFGHIJ';
  const lines = [['SSSLEN', '10'], ['SSSHASH', fnv1a(text)], ['SSSCHUNK0', 'ABCD'], ['SSSCHUNK2', 'IJ']];
  assert.throws(() => parseDump(dump(lines)), /missing chunk 1/);
  const noZero = [['SSSLEN', '10'], ['SSSHASH', fnv1a(text)], ['SSSCHUNK1', 'EFGH']];
  assert.throws(() => parseDump(dump(noZero)), /missing chunk 0/);
});

test('parseDump refuses a duplicate chunk index even when the payloads are identical', () => {
  const lines = [['SSSLEN', '4'], ['SSSHASH', fnv1a('ABCD')], ['SSSCHUNK0', 'ABCD'], ['SSSCHUNK0', 'ABCD']];
  assert.throws(() => parseDump(dump(lines)), /duplicate chunk 0/);
});

test('parseDump refuses a dump with no chunks, no SSSLEN, or no SSSHASH', () => {
  assert.throws(() => parseDump(dump([['SSSLEN', '4'], ['SSSHASH', fnv1a('ABCD')]])), /no SSSCHUNK lines/);
  assert.throws(() => parseDump(dump([['SSSHASH', fnv1a('ABCD')], ['SSSCHUNK0', 'ABCD']])), /no SSSLEN line/);
  assert.throws(() => parseDump(dump([['SSSLEN', '4'], ['SSSCHUNK0', 'ABCD']])), /no SSSHASH line/);
  assert.throws(() => parseDump(''), /no SSSLEN line/);
});

test('parseDump keeps a literal " (1 args)" that occurs mid-chunk', () => {
  const text = 'before (1 args) after';
  assert.equal(parseDump(dumpFor(text, { chunkSize: 100 })).text, text);
  // and one that ends the chunk text itself, followed by the real terminator
  const tricky = 'ends with (1 args)';
  assert.equal(parseDump(dumpFor(tricky, { chunkSize: 100 })).text, tricky);
});

test('parseDump keeps a literal "SSSCHUNK" that occurs mid-chunk', () => {
  const text = 'see SSSCHUNK1 in the docs SSSLEN 5';
  assert.equal(parseDump(dumpFor(text, { chunkSize: 100 })).text, text);
});

test('parseDump keeps newlines inside a chunk, including a chunk that ends in a newline', () => {
  const text = 'line one\nline two\n\n  indented\n';
  assert.equal(parseDump(dumpFor(text, { chunkSize: 7 })).text, text);
  assert.equal(parseDump(dumpFor(text, { chunkSize: 1000 })).text, text);
});

test('parseDump refuses a length mismatch and a hash mismatch', () => {
  const text = 'ABCDEFGHIJ';
  assert.throws(() => parseDump(dumpFor(text, { length: 11 })), /length mismatch: reassembled 10, dump said 11/);
  assert.throws(() => parseDump(dumpFor(text, { hash: 'deadbeef' })), /hash mismatch: reassembled [0-9a-f]{8}, dump said deadbeef/);
});

test('parseDump refuses reassembled text that fails verifyText even when length and hash agree', () => {
  const text = 'ok\uFFFDok';
  assert.throws(() => parseDump(dumpFor(text)), /U\+FFFD/);
  const cr = 'a\r\nb';
  assert.throws(() => parseDump(dumpFor(cr)), /carriage return/);
});

test('parseDump accepts the JSON-array-of-{text} form the MCP client sometimes persists', () => {
  const text = '<p>Hi {{ customer.name }}</p>\n';
  const plain = dumpFor(text, { chunkSize: 9, subject: 'Hi there', revert: false });
  const lines = plain.split('\n').filter(Boolean).map((l) => l + '\n');
  // Part boundaries fall right after the SSSSUBJ line and after a chunk line, each part keeping
  // its own trailing newline: the shape that used to leave " (1 args)" on the subject.
  const parts = [{ text: lines.slice(0, 3).join('') }, { type: 'text', text: lines.slice(3, 6).join('') }, { text: lines.slice(6).join('') }, { notText: 1 }];
  const r = parseDump(JSON.stringify(parts));
  assert.equal(r.text, text);
  assert.equal(r.subject, 'Hi there');
  assert.equal(r.revertDisabled, false);
  // and the same parts without their trailing newlines, which is what a plain '\n' join expects
  const trimmed = parts.map((p) => (typeof p.text === 'string' ? { text: p.text.replace(/\n$/, '') } : p));
  assert.equal(parseDump(JSON.stringify(trimmed)).text, text);
});

test('parseDump treats text that starts with "[" but is not JSON as plain text', () => {
  const text = 'ABCD';
  const raw = '[not json\n' + dumpFor(text);
  assert.equal(parseDump(raw).text, text);
});

test('parseDump reads the subject, including Liquid braces, and leaves it undefined when absent', () => {
  const text = 'ABCD';
  assert.equal(parseDump(dumpFor(text, { subject: 'Order {{name}} confirmed' })).subject, 'Order {{name}} confirmed');
  assert.equal(parseDump(dumpFor(text, { subject: '[{{ shop.name }}] Your gift card' })).subject, '[{{ shop.name }}] Your gift card');
  assert.equal(parseDump(dumpFor(text)).subject, undefined);
});

test('parseDump parses SSSREVERT true/false and leaves it undefined when absent', () => {
  const text = 'ABCD';
  assert.equal(parseDump(dumpFor(text, { revert: true })).revertDisabled, true);
  assert.equal(parseDump(dumpFor(text, { revert: false })).revertDisabled, false);
  assert.equal(parseDump(dumpFor(text)).revertDisabled, undefined);
});

test('parseDump ignores unrelated [log] lines before, between and after the SSS lines', () => {
  const text = 'ABCDEFGH';
  const body = dumpFor(text, { chunkSize: 4 }).replace('msgid=3 [log] SSSCHUNK0', 'msgid=3 [log] page ready (1 args)\nmsgid=3 [log] SSSCHUNK0');
  const raw = 'msgid=1 [log] booting (1 args)\n' + body + 'msgid=9 [log] done (1 args)\n';
  assert.equal(parseDump(raw).text, text);
});

test('parseDump treats only "msgid=N [log] " as a message boundary; a [warn] line after a chunk is absorbed and the hash check refuses it', () => {
  const text = 'ABCDEFGH';
  const raw = dumpFor(text, { chunkSize: 4 }) + 'msgid=9 [warn] something else entirely (2 args)\n';
  assert.throws(() => parseDump(raw), /length mismatch/);
});

test('parseDump tolerates blank lines between messages without leaking the terminator into a chunk or the subject', () => {
  const text = 'ABCDEFGH';
  const raw = dumpFor(text, { chunkSize: 4, subject: 'Order {{name}} confirmed' }).replace(/\n/g, '\n\n');
  const r = parseDump(raw);
  assert.equal(r.text, text);
  assert.equal(r.subject, 'Order {{name}} confirmed');
});

// --- parseEnvelope -------------------------------------------------------------------------------

function envelope(text, extra = {}) {
  return JSON.stringify({ id: 'order_confirmation', length: text.length, hash: fnv1a(text), subject: 'Order {{name}} confirmed', revertDisabled: true, text, ...extra });
}

test('parseEnvelope returns the same shape as parseDump from the downloaded JSON envelope', () => {
  const text = '<p>{{ shop.name }} \u{1F9F5}</p>\n';
  assert.deepEqual(parseEnvelope(envelope(text)), {
    id: 'order_confirmation',
    text,
    subject: 'Order {{name}} confirmed',
    revertDisabled: true,
    length: text.length,
    hash: fnv1a(text),
  });
});

test('parseEnvelope enforces the recorded length and hash and refuses unverifiable text', () => {
  const text = 'ABCD';
  assert.throws(() => parseEnvelope(envelope(text, { length: 5 })), /length mismatch: reassembled 4, dump said 5/);
  assert.throws(() => parseEnvelope(envelope(text, { hash: 'deadbeef' })), /hash mismatch/);
  assert.throws(() => parseEnvelope(envelope('a\rb')), /carriage return/);
  assert.throws(() => parseEnvelope(envelope('')), /empty/);
});

test('parseEnvelope tolerates a missing length or hash but not a missing id or text', () => {
  const text = 'ABCD';
  const r = parseEnvelope(JSON.stringify({ id: 'x', text }));
  assert.equal(r.length, 4);
  assert.equal(r.hash, fnv1a(text));
  assert.equal(r.subject, undefined);
  assert.equal(r.revertDisabled, undefined);
  assert.throws(() => parseEnvelope(JSON.stringify({ text })), /lacks id or text/);
  assert.throws(() => parseEnvelope(JSON.stringify({ id: 'x' })), /lacks id or text/);
  assert.throws(() => parseEnvelope(JSON.stringify({ id: 7, text })), /lacks id or text/);
  assert.throws(() => parseEnvelope('null'), /lacks id or text/);
  assert.throws(() => parseEnvelope('not json'), SyntaxError);
});

test('parseEnvelope drops a subject or revertDisabled of the wrong type rather than recording it', () => {
  const text = 'ABCD';
  const r = parseEnvelope(envelope(text, { subject: null, revertDisabled: 'true' }));
  assert.equal(r.subject, undefined);
  assert.equal(r.revertDisabled, undefined);
});

// --- record -------------------------------------------------------------------------------------

function tempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'ssb-record-'));
  mkdirSync(paths(root).stockDir, { recursive: true });
  return root;
}

test('record writes the stock file and a sorted manifest entry with sha256, length and subject', () => {
  const root = tempRoot();
  const p = paths(root);
  const text = '<p>{{ shop.name }} © 2026</p>\n';
  const entry = record({ root, id: 'zeta', subject: 'Z', text });
  assert.deepEqual(entry, { stockSha256: sha256(text), stockLength: text.length, subject: 'Z' });
  assert.equal(readFileSync(p.stock('zeta'), 'utf8'), text);
  record({ root, id: 'alpha', text: 'A\n' });
  const manifest = JSON.parse(readFileSync(p.manifest, 'utf8'));
  assert.deepEqual(Object.keys(manifest.templates), ['alpha', 'zeta']);
  assert.equal(manifest.templates.alpha.subject, undefined);
  assert.ok(readFileSync(p.manifest, 'utf8').endsWith('}\n'));
});

test('record keeps override, skip and the old subject when the stock content is unchanged', () => {
  const root = tempRoot();
  const p = paths(root);
  record({ root, id: 'alpha', subject: 'first', text: 'A\n' });
  const manifest = JSON.parse(readFileSync(p.manifest, 'utf8'));
  manifest.templates.alpha.override = { styleAnchor: '<x>' };
  manifest.templates.alpha.skip = 'left stock on purpose';
  writeFileSync(p.manifest, JSON.stringify(manifest), 'utf8');
  const entry = record({ root, id: 'alpha', text: 'A\n' });
  assert.deepEqual(entry, {
    stockSha256: sha256('A\n'),
    stockLength: 2,
    subject: 'first',
    override: { styleAnchor: '<x>' },
    skip: 'left stock on purpose',
  });
});

test('record drops override and skip when the stock content changes, keeping the subject', () => {
  const root = tempRoot();
  const p = paths(root);
  record({ root, id: 'alpha', subject: 'first', text: 'A\n' });
  const manifest = JSON.parse(readFileSync(p.manifest, 'utf8'));
  manifest.templates.alpha.override = { styleAnchor: '<x>' };
  manifest.templates.alpha.skip = 'left stock on purpose';
  writeFileSync(p.manifest, JSON.stringify(manifest), 'utf8');
  const entry = record({ root, id: 'alpha', text: 'AB\n' });
  assert.deepEqual(entry, { stockSha256: sha256('AB\n'), stockLength: 3, subject: 'first' });
  const written = JSON.parse(readFileSync(p.manifest, 'utf8'));
  assert.deepEqual(written.templates.alpha, entry);
});

test('record refuses a bad id or unverifiable text and writes nothing', () => {
  const root = tempRoot();
  const p = paths(root);
  assert.throws(() => record({ root, id: 'Bad-Id', text: 'x' }), /bad id: Bad-Id/);
  assert.throws(() => record({ root, id: 'ok', text: '' }), /empty/);
  assert.throws(() => record({ root, id: 'ok', text: 'a\rb' }), /carriage return/);
  assert.ok(!existsSync(p.manifest));
  assert.ok(!existsSync(p.stock('ok')));
});

// --- dump.mjs is the one path -------------------------------------------------------------------

test('record-stock.mjs re-exports the very same dump.mjs functions (shim identity)', () => {
  for (const name of ['fnv1a', 'verifyText', 'parseDump', 'reassembleDump', 'LEN_PREFIX', 'HASH_PREFIX', 'CHUNK_PREFIX']) {
    assert.strictEqual(recordStock[name], dump_[name], name);
  }
  assert.equal(dump_.LEN_PREFIX, 'SSSLEN');
  assert.equal(dump_.HASH_PREFIX, 'SSSHASH');
  assert.equal(dump_.CHUNK_PREFIX, 'SSSCHUNK');
});

test('parseDump refuses a duplicate SSSLEN or SSSHASH line, even when the values agree', () => {
  const text = 'ABCD';
  const twoLen = [['SSSLEN', '4'], ['SSSHASH', fnv1a(text)], ['SSSLEN', '4'], ['SSSCHUNK0', text]];
  assert.throws(() => parseDump(dump(twoLen)), /duplicate SSSLEN/);
  const twoHash = [['SSSLEN', '4'], ['SSSHASH', fnv1a(text)], ['SSSHASH', fnv1a(text)], ['SSSCHUNK0', text]];
  assert.throws(() => parseDump(dump(twoHash)), /duplicate SSSHASH/);
  // A chunk whose text merely contains the literal is not a second line: the line must start with it.
  const inChunk = 'see SSSLEN 4 and SSSHASH deadbeef inside';
  assert.equal(parseDump(dumpFor(inChunk, { chunkSize: 100 })).text, inChunk);
});

test('parsePoll returns the last SSSPOLL line of a console listing, or null', () => {
  const { parsePoll } = dump_;
  assert.equal(parsePoll(''), null);
  assert.equal(parsePoll('msgid=1 [log] SSSPOLL nope (1 args)'), null);
  const listing = 'msgid=1 [log] SSSPOLL 10 0123abcd textarea (1 args)\nmsgid=2 [log] SSSSTAMP none (1 args)\nmsgid=3 [log] SSSPOLL 12 89abcdef cm6 (1 args)\n';
  assert.deepEqual(parsePoll(listing), { length: 12, hash: '89abcdef', source: 'cm6' });
  assert.deepEqual(parsePoll(JSON.stringify([{ text: listing }])), { length: 12, hash: '89abcdef', source: 'cm6' });
});

test('dump.mjs CLI reassembles to stdout or --out and exits 2 without a file', () => {
  const root = tempRoot();
  const text = '<p>{{ shop.name }} ©</p>\n';
  const file = path.join(root, 'd.txt');
  writeFileSync(file, dumpFor(text, { chunkSize: 5, subject: 'S', revert: true }), 'utf8');
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dump.mjs');
  const toStdout = spawnSync(process.execPath, [script, file], { encoding: 'utf8', cwd: root });
  assert.equal(toStdout.status, 0, toStdout.stderr);
  assert.equal(toStdout.stdout, text);
  const out = path.join(root, 'out.liquid');
  const toFile = spawnSync(process.execPath, [script, file, '--out', out], { encoding: 'utf8', cwd: root });
  assert.equal(toFile.status, 0, toFile.stderr);
  assert.equal(readFileSync(out, 'utf8'), text);
  assert.match(toFile.stderr, /reassembled \d+ chars, fnv [0-9a-f]{8}, subject "S", revert disabled/);
  assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8', cwd: root }).status, 2);
  writeFileSync(file, dumpFor(text, { hash: 'deadbeef' }), 'utf8');
  const bad = spawnSync(process.execPath, [script, file], { encoding: 'utf8', cwd: root });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /hash mismatch/);
});

test('record carries version and brandedSha256 across a re-record on purpose, changed content or not', () => {
  const root = tempRoot();
  const p = paths(root);
  record({ root, id: 'alpha', subject: 'first', text: 'A\n' });
  const manifest = JSON.parse(readFileSync(p.manifest, 'utf8'));
  manifest.templates.alpha.version = 3;
  manifest.templates.alpha.brandedSha256 = 'c'.repeat(64);
  manifest.templates.alpha.override = { styleAnchor: '<x>' };
  writeFileSync(p.manifest, JSON.stringify(manifest), 'utf8');
  const same = record({ root, id: 'alpha', text: 'A\n' });
  assert.equal(same.version, 3);
  assert.equal(same.brandedSha256, 'c'.repeat(64));
  const changed = record({ root, id: 'alpha', text: 'AB\n' });
  assert.equal(changed.version, 3, 'the version survives so the next generate bumps it');
  assert.equal(changed.brandedSha256, 'c'.repeat(64), 'the stale hash survives so the next generate sees the change');
  assert.equal(changed.override, undefined, 'the override is dropped as before');
});

test('dump.mjs --hash prints the LF-normalised length and FNV a probe must report for that file', () => {
  const root = tempRoot();
  const file = path.join(root, 'x.liquid');
  writeFileSync(file, 'ab\r\ncd ©\n', 'utf8');
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dump.mjs');
  const r = spawnSync(process.execPath, [script, '--hash', file], { encoding: 'utf8', cwd: root });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${'ab\ncd ©\n'.length} ${fnv1a('ab\ncd ©\n')}\n`);
  assert.deepEqual(dump_.hashFile(file), { length: 'ab\ncd ©\n'.length, hash: fnv1a('ab\ncd ©\n') });
  assert.equal(spawnSync(process.execPath, [script, '--hash'], { encoding: 'utf8', cwd: root }).status, 2);
});
