#!/usr/bin/env node
// The `sync` and `audit` plan table: what Admin holds for each id, what the repo holds, and which
// row of the match table that lands on. The enum and its ordering are a contract in sync.md; this
// applies it once, with tests, instead of a run hand-rolling an awk join over 46 readings and
// classifying by eye.
//
//   node scripts/notifications/classify.mjs --root <dir> --observed <file>
//        [--ids <id>...] [--paste-ahead <id>...] [--on-render-fail halt|quarantine]
//        [--json <file>] [--audit-json <file>]
//
// `--root` is the checkout of the `--from` ref, the same one brand.mjs --status and
// dump.mjs --hash are run against. `--observed` is what the browser reported, one id per line:
//
//   <id>\t<length>\t<fnv>[\t<stamp>[\t<gid>]]
//
// stamp is "<id> <version>" or "none" (default none), gid is data.emailTemplate.id or "-" (default
// none). Or the same as JSON: an array of { id, length, fnv, stamp, gid } or an object keyed by
// id. Every field comes from the probe's SSSSTORED and SSSSTOREDSTAMP lines, which are read from
// the EmailTemplate response; taking any of them from SSSPOLL/SSSSTAMP exposes the classification
// to the editor's load race, and the stamp is what behind / ahead / hash-mismatch / orphan turn on.
//
// This module owns the match table. Rows are tested top to bottom and the first match wins:
//
//   bytes equal the repo file                                     in-sync
//   stamped <id>, version below the repo's                        behind
//   stamped <id>, version above the repo's                        ahead
//   stamped <id>, version equal to the repo's, bytes differ       hash-mismatch
//   stamped with another id                                       orphan
//   unstamped, bytes equal stock/<id>.liquid                      unstamped-stock
//   unstamped, any other bytes                                    unstamped-edited

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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
// The id segment of an EmailTemplate gid is the template HANDLE, not a number: Admin returns
// `gid://shopify/EmailTemplate/buy_online`. This was `[0-9]+` until a sync read all 46 editors and
// every one of them was refused, because the numeric shape was assumed rather than observed and
// every test fixture was an invented numeric gid. Keep it anchored and narrow (no slashes, dots or
// uppercase); what actually guards against pairing one template's response with another id is the
// string equality in before-doc.mjs, which this format check only feeds.
export const GID_RE = /^gid:\/\/shopify\/EmailTemplate\/[a-z0-9_]+$/;

export function classifyOne(id, observed, repo, { pasteAhead = [] } = {}) {
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
  // `ahead` means Admin holds a version above the repo's, so it is flagged and left alone unless
  // the operator named that id: overwriting it discards work that exists nowhere else.
  let action = match === 'in-sync' ? 'skip' : PASTE_OVER.includes(match) ? 'paste' : 'flag';
  if (match === 'ahead' && pasteAhead.includes(id)) {
    action = 'paste';
    note = note || "ahead, pasted because the operator named this id: Admin's newer version is overwritten";
  }
  return {
    id,
    match,
    note,
    beforeSource,
    gid: observed.gid || null,
    adminVersion: stamp && stamp.id === id ? stamp.version : null,
    adminStamp: stamp,
    version: repo.version,
    repoVersion: repo.version,
    before: { length: observed.length, fnv: observed.fnv },
    after: { length: repo.branded.length, fnv: repo.branded.hash },
    action,
  };
}

export function repoFacts(root = REPO_ROOT) {
  const manifest = readManifest(root);
  const p = paths(root);
  const facts = new Map();
  for (const id of Object.keys(manifest.templates).sort()) {
    const version = manifest.templates[id].version;
    if (!isValidVersion(version)) throw new ClassifyError(`${id}: manifest has no version; generate before classifying`);
    // A missing file is a refusal with a sentence, like every other refusal here, not a raw ENOENT
    // from three frames down.
    for (const [what, file] of [['branded', p.branded(id)], ['stock', p.stock(id)]]) {
      if (!existsSync(file)) throw new ClassifyError(`${id}: no ${what} file at ${file}`);
    }
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
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new ClassifyError(`observed file is not JSON: ${err.message}`);
    }
    const entries = Array.isArray(parsed) ? parsed : Object.entries(parsed).map(([id, v]) => ({ id, ...v }));
    for (const e of entries) {
      rows.push({
        id: e.id,
        length: Number(e.length),
        fnv: String(e.fnv),
        stampText: e.stamp === undefined || e.stamp === null ? 'none' : String(e.stamp),
        gidText: e.gid === undefined || e.gid === null ? '-' : String(e.gid),
      });
    }
  } else {
    for (const line of trimmed.split('\n')) {
      if (line.trim() === '' || line.trim().startsWith('#')) continue;
      const cols = line.split('\t').map((c) => c.trim());
      if (cols.length < 3) throw new ClassifyError(`observed line needs at least id, length and fnv: ${JSON.stringify(line)}`);
      rows.push({
        id: cols[0],
        length: Number(cols[1]),
        fnv: cols[2],
        stampText: cols[3] === undefined || cols[3] === '' ? 'none' : cols[3],
        gidText: cols[4] === undefined || cols[4] === '' ? '-' : cols[4],
      });
    }
  }
  const seen = new Set();
  return rows.map((r) => {
    if (!ID_RE.test(String(r.id))) throw new ClassifyError(`observed: ${JSON.stringify(r.id)} is not an id`);
    // Two readings for one id is what concatenating two console dumps produces. Taking the last
    // silently would classify from one reading and never mention the other, and the operator would
    // approve a table with the same id in it twice.
    if (seen.has(r.id)) throw new ClassifyError(`observed lists ${r.id} twice; one reading per id`);
    seen.add(r.id);
    if (!Number.isInteger(r.length) || r.length < 1) throw new ClassifyError(`${r.id}: length ${r.length} is not a positive integer`);
    if (!/^[0-9a-f]{8}$/.test(r.fnv)) throw new ClassifyError(`${r.id}: fnv ${JSON.stringify(r.fnv)} is not eight lowercase hex digits`);
    let stamp = null;
    if (r.stampText !== 'none') {
      const m = STAMP_LINE_RE.exec(r.stampText);
      if (!m) throw new ClassifyError(`${r.id}: stamp ${JSON.stringify(r.stampText)} is not "<id> <version>" or "none"`);
      stamp = { id: m[1], version: Number(m[2]) };
    }
    let gid = null;
    if (r.gidText !== '-') {
      if (!GID_RE.test(r.gidText)) throw new ClassifyError(`${r.id}: gid ${JSON.stringify(r.gidText)} is not gid://shopify/EmailTemplate/<n> or "-"`);
      gid = r.gidText;
    }
    return { id: r.id, length: r.length, fnv: r.fnv, stamp, gid };
  });
}

export function classifyAll(observedRows, facts, { ids, pasteAhead = [] } = {}) {
  const scope = ids && ids.length ? ids : observedRows.map((r) => r.id);
  const byId = new Map(observedRows.map((r) => [r.id, r]));
  const unknown = observedRows.filter((r) => !facts.has(r.id)).map((r) => r.id);
  if (unknown.length) throw new ClassifyError(`not manifest ids: ${unknown.join(', ')}`);
  const outOfScope = pasteAhead.filter((id) => !scope.includes(id));
  if (outOfScope.length) throw new ClassifyError(`--paste-ahead names ${outOfScope.join(', ')}, which is not in scope`);
  const missing = scope.filter((id) => !byId.has(id));
  const rows = scope.filter((id) => byId.has(id)).map((id) => classifyOne(id, byId.get(id), facts.get(id), { pasteAhead }));
  const notAhead = pasteAhead.filter((id) => rows.some((r) => r.id === id && r.match !== 'ahead'));
  if (notAhead.length) throw new ClassifyError(`--paste-ahead names ${notAhead.join(', ')}, which is not classified ahead`);
  return { rows, missing };
}

export function formatTable(rows, { onRenderFail = 'halt' } = {}) {
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
  // The write count the operator approves. Under `quarantine` the run does not stop on a failed
  // render, so every pasted id can cost a second, restoring Save: the honest ceiling is 2N, and
  // saying "at most one restoring Save" there would understate what is being approved.
  const saves =
    onRenderFail === 'quarantine'
      ? `${pastes} live save(s) planned, up to ${pastes * 2}: one per pasted id, plus one restoring Save for each id whose render fails, because --on-render-fail quarantine continues instead of stopping.`
      : `${pastes} live save(s) planned, up to ${pastes + 1}: one per pasted id, plus at most one restoring Save, after which --on-render-fail halt stops the run.`;
  const summary = ['', `${rows.length} id(s): ` + [...counts.entries()].map(([k, v]) => `${v} ${k}`).join(', '), saves];
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
  const usage =
    'usage: classify.mjs --observed <file> [--root <dir>] [--ids <id>...] [--paste-ahead <id>...] [--on-render-fail halt|quarantine] [--json <file>] [--audit-json <file>]';
  if (!observedPath) {
    console.error(usage);
    return 2;
  }
  const root = get('--root') ? resolve(get('--root')) : REPO_ROOT;
  // A list flag with no values is a typo, never "everything": read as an empty list it would widen
  // a one-id request into the whole manifest and present that as the answer.
  const list = (flag) => {
    const at = args.indexOf(flag);
    if (at === -1) return [];
    const values = [];
    for (let i = at + 1; i < args.length && !args[i].startsWith('--'); i++) values.push(args[i]);
    if (values.length === 0) throw new ClassifyError(`${flag} needs at least one id`);
    return values;
  };
  const onRenderFail = get('--on-render-fail') || 'halt';
  let result;
  let ids;
  let pasteAhead;
  try {
    if (!['halt', 'quarantine'].includes(onRenderFail)) throw new ClassifyError(`--on-render-fail ${JSON.stringify(onRenderFail)} is not halt or quarantine`);
    ids = list('--ids');
    pasteAhead = list('--paste-ahead');
    result = classifyAll(parseObserved(readFileSync(resolve(observedPath), 'utf8')), repoFacts(root), { ids, pasteAhead });
    // Every refusal happens before a byte is written. A refused run that still left a valid-looking
    // plan.json on disk is a file run-start would happily accept.
    if (result.missing.length) {
      throw new ClassifyError(`no reading for ${result.missing.length} id(s) in scope: ${result.missing.join(', ')}`);
    }
  } catch (err) {
    console.error(`refused: ${err.message}`);
    return 1;
  }
  process.stdout.write(formatTable(result.rows, { onRenderFail }));
  if (get('--json')) writeFileSync(resolve(get('--json')), JSON.stringify(result.rows, null, 2) + '\n', 'utf8');
  if (get('--audit-json')) {
    const audit = {};
    for (const r of result.rows) audit[r.id] = { adminVersion: r.adminVersion, repoVersion: r.repoVersion, match: r.match, render: 'skipped' };
    writeFileSync(resolve(get('--audit-json')), JSON.stringify(audit, null, 2) + '\n', 'utf8');
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
