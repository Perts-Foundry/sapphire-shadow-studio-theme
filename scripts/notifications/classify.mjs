#!/usr/bin/env node
// The `sync` and `audit` plan table: what Admin holds for each id, what the repo holds, and which
// row of the match table that lands on. The enum and its ordering are a contract in sync.md; this
// applies it once, with tests, instead of a run hand-rolling an awk join over 46 readings and
// classifying by eye.
//
//   node scripts/notifications/classify.mjs --root <dir> --observed <file>
//        [--ids <id>...] [--json <file>] [--audit-json <file>]
//
// `--root` is the checkout of the `--from` ref, the same one brand.mjs --status and
// dump.mjs --hash are run against. `--observed` is what the browser reported, one id per line:
//
//   <id>\t<length>\t<fnv>[\t<stamp>]        stamp is "<id> <version>" or "none" (default none)
//
// or the same as JSON: an array of { id, length, fnv, stamp } or an object keyed by id. The
// numbers come from the probe's SSSSTORED line where there is one, else its SSSPOLL line.
//
// Rows are tested top to bottom and the first match wins, exactly as sync.md states them:
//
//   bytes equal the repo file                                     in-sync
//   stamped <id>, version below the repo's                        behind
//   stamped <id>, version above the repo's                        ahead
//   stamped <id>, version equal to the repo's, bytes differ       hash-mismatch
//   stamped with another id                                       orphan
//   unstamped, bytes equal stock/<id>.liquid                      unstamped-stock
//   unstamped, any other bytes                                    unstamped-edited

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile } from './dump.mjs';
import { paths, readManifest, isValidVersion, REPO_ROOT } from './brand.mjs';
import { MATCH, ID_RE } from './state.mjs';

// sync.md pastes over everything except in-sync (nothing to do) and ahead (Admin is newer; the
// operator has to name the id explicitly to overwrite it).
export const PASTE_OVER = ['behind', 'unstamped-stock', 'unstamped-edited', 'hash-mismatch', 'orphan'];

export class ClassifyError extends Error {}

// One id. `observed` is { length, fnv, stamp }, `stamp` null or { id, version }. `repo` is
// { version, branded: {length, hash}, stock: {length, hash} }.
export function classifyOne(id, observed, repo) {
  const bytesEqual = (o) => o && observed.length === o.length && observed.fnv === o.hash;
  const stamp = observed.stamp || null;
  let match;
  let note = null;
  if (bytesEqual(repo.branded)) {
    match = 'in-sync';
  } else if (stamp && stamp.id === id) {
    if (stamp.version < repo.version) match = 'behind';
    else if (stamp.version > repo.version) match = 'ahead';
    else match = 'hash-mismatch';
  } else if (stamp) {
    match = 'orphan';
    if (bytesEqual(repo.stock)) note = `stamped ${stamp.id} v${stamp.version} but the bytes are this id's stock snapshot`;
  } else if (bytesEqual(repo.stock)) {
    match = 'unstamped-stock';
  } else {
    match = 'unstamped-edited';
  }
  if (!MATCH.includes(match)) throw new ClassifyError(`${id}: computed ${match}, which is not in the match enum`);
  // Where sync.md's step 3.1 takes the restore source from. A stock-class id already has a
  // byte-identical copy on disk; anything else has to come from the EmailTemplate response. An
  // in-sync id is never pasted, so it needs no restore source at all.
  const beforeSource = match === 'in-sync' ? null : bytesEqual(repo.stock) ? 'stock' : 'network';
  return {
    id,
    match,
    note,
    beforeSource,
    adminVersion: stamp && stamp.id === id ? stamp.version : null,
    adminStamp: stamp,
    repoVersion: repo.version,
    before: { length: observed.length, fnv: observed.fnv },
    after: { length: repo.branded.length, fnv: repo.branded.hash },
    action: match === 'in-sync' ? 'skip' : PASTE_OVER.includes(match) ? 'paste' : 'flag',
  };
}

export function repoFacts(root = REPO_ROOT) {
  const manifest = readManifest(root);
  const p = paths(root);
  const facts = new Map();
  for (const id of Object.keys(manifest.templates).sort()) {
    const version = manifest.templates[id].version;
    if (!isValidVersion(version)) throw new ClassifyError(`${id}: manifest has no version; generate before classifying`);
    facts.set(id, { version, branded: hashFile(p.branded(id)), stock: hashFile(p.stock(id)) });
  }
  return facts;
}

const STAMP_LINE_RE = /^([a-z0-9_]+) ([1-9][0-9]*)$/;

// Accepts the TSV and the two JSON shapes. Refuses anything it cannot read rather than guessing.
export function parseObserved(text) {
  const rows = [];
  const trimmed = text.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    const entries = Array.isArray(parsed) ? parsed : Object.entries(parsed).map(([id, v]) => ({ id, ...v }));
    for (const e of entries) rows.push({ id: e.id, length: Number(e.length), fnv: String(e.fnv), stampText: e.stamp === undefined || e.stamp === null ? 'none' : String(e.stamp) });
  } else {
    for (const line of trimmed.split('\n')) {
      if (line.trim() === '' || line.trim().startsWith('#')) continue;
      const cols = line.split('\t').map((c) => c.trim());
      if (cols.length < 3) throw new ClassifyError(`observed line needs at least id, length and fnv: ${JSON.stringify(line)}`);
      rows.push({ id: cols[0], length: Number(cols[1]), fnv: cols[2], stampText: cols[3] === undefined || cols[3] === '' ? 'none' : cols[3] });
    }
  }
  return rows.map((r) => {
    if (!ID_RE.test(String(r.id))) throw new ClassifyError(`observed: ${JSON.stringify(r.id)} is not an id`);
    if (!Number.isInteger(r.length) || r.length < 1) throw new ClassifyError(`${r.id}: length ${r.length} is not a positive integer`);
    if (!/^[0-9a-f]{8}$/.test(r.fnv)) throw new ClassifyError(`${r.id}: fnv ${JSON.stringify(r.fnv)} is not eight lowercase hex digits`);
    let stamp = null;
    if (r.stampText !== 'none') {
      const m = STAMP_LINE_RE.exec(r.stampText);
      if (!m) throw new ClassifyError(`${r.id}: stamp ${JSON.stringify(r.stampText)} is not "<id> <version>" or "none"`);
      stamp = { id: m[1], version: Number(m[2]) };
    }
    return { id: r.id, length: r.length, fnv: r.fnv, stamp };
  });
}

export function classifyAll(observedRows, facts, { ids } = {}) {
  const scope = ids && ids.length ? ids : observedRows.map((r) => r.id);
  const byId = new Map(observedRows.map((r) => [r.id, r]));
  const unknown = observedRows.filter((r) => !facts.has(r.id)).map((r) => r.id);
  if (unknown.length) throw new ClassifyError(`not manifest ids: ${unknown.join(', ')}`);
  const missing = scope.filter((id) => !byId.has(id));
  const rows = scope.filter((id) => byId.has(id)).map((id) => classifyOne(id, byId.get(id), facts.get(id)));
  return { rows, missing };
}

export function formatTable(rows) {
  const head = '| id | match | before (len fnv) | Admin v | after (len fnv) | repo v | before source | action |';
  const rule = '|---|---|---|---|---|---|---|---|';
  const body = rows.map(
    (r) =>
      `| \`${r.id}\` | ${r.match} | ${r.before.length} ${r.before.fnv} | ${r.adminVersion === null ? (r.adminStamp ? `${r.adminStamp.id} v${r.adminStamp.version}` : 'unstamped') : r.adminVersion} | ` +
      `${r.after.length} ${r.after.fnv} | ${r.repoVersion} | ${r.beforeSource || '-'} | ${r.action} |`,
  );
  const counts = new Map();
  for (const r of rows) counts.set(r.match, (counts.get(r.match) || 0) + 1);
  const pastes = rows.filter((r) => r.action === 'paste').length;
  const summary = [
    '',
    `${rows.length} id(s): ` + [...counts.entries()].map(([k, v]) => `${v} ${k}`).join(', '),
    `${pastes} live save(s) planned (one per pasted id, plus at most one restoring Save on a failed render).`,
  ];
  const notes = rows.filter((r) => r.note).map((r) => `note: ${r.id}: ${r.note}`);
  return [head, rule, ...body, ...summary, ...notes].join('\n') + '\n';
}

function main(argv) {
  const args = argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const observedPath = get('--observed');
  if (!observedPath) {
    console.error('usage: classify.mjs --observed <file> [--root <dir>] [--ids <id>...] [--json <file>] [--audit-json <file>]');
    return 2;
  }
  const root = get('--root') ? resolve(get('--root')) : REPO_ROOT;
  const idsAt = args.indexOf('--ids');
  let ids = [];
  if (idsAt !== -1) {
    for (let i = idsAt + 1; i < args.length && !args[i].startsWith('--'); i++) ids.push(args[i]);
  }
  let result;
  try {
    result = classifyAll(parseObserved(readFileSync(resolve(observedPath), 'utf8')), repoFacts(root), { ids });
  } catch (err) {
    console.error(err instanceof ClassifyError ? `refused: ${err.message}` : `refused: ${err.message}`);
    return 1;
  }
  process.stdout.write(formatTable(result.rows));
  if (get('--json')) writeFileSync(resolve(get('--json')), JSON.stringify(result.rows, null, 2) + '\n', 'utf8');
  if (get('--audit-json')) {
    const audit = {};
    for (const r of result.rows) audit[r.id] = { adminVersion: r.adminVersion, repoVersion: r.repoVersion, match: r.match, render: 'skipped' };
    writeFileSync(resolve(get('--audit-json')), JSON.stringify(audit, null, 2) + '\n', 'utf8');
  }
  if (result.missing.length) {
    console.error(`refused: no reading for ${result.missing.length} id(s) in scope: ${result.missing.join(', ')}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
