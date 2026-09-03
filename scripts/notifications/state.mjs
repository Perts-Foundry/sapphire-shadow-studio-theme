#!/usr/bin/env node
// The notification-templates skill's per-store state file: a cache of what Admin was last seen
// to hold, kept outside the checkout (it is a live-store fact and belongs in no PR). A hint,
// never an authority: sync and audit always read Admin. Every read validates the whole file and
// refuses it on any violation, because an id from this file flows into a navigation URL.
//
//   ${XDG_STATE_HOME:-~/.local/state}/notification-templates/<store>.json
//
//   node scripts/notifications/state.mjs --store <handle> show
//   node scripts/notifications/state.mjs --store <handle> seen <id> (--version <n> --fnv <hex> --length <n> | --from-file <path>) [--sha <sha>] [--ref <ref>]
//   node scripts/notifications/state.mjs --store <handle> pending-add <id> --version <n> --fnv <hex> --branch <name> --pr <n>
//   node scripts/notifications/state.mjs --store <handle> pending-remove <id...>
//   node scripts/notifications/state.mjs --store <handle> audit <results.json>
//        [--source sync|audit] [--started-at <iso>] [--partial]
//   node scripts/notifications/state.mjs --store <handle> audit-start --ref <ref> --sha <sha>
//        [--quick] [--batch <n>] [--force] [<id>...]
//   node scripts/notifications/state.mjs --store <handle> audit-show
//   node scripts/notifications/state.mjs --store <handle> audit-end <results.json> | --abandon
//   node scripts/notifications/state.mjs --store <handle> run-start <plan.json> --ref <ref> --sha <sha>
//        [--on-render-fail halt|quarantine] [--batch <n>] [--force]
//        (--force names what it replaces before it does, because a replaced run's quarantine list
//         is the only record of which ids failed and why)
//   node scripts/notifications/state.mjs --store <handle> run-quarantine <id> <verifier.txt>
//   node scripts/notifications/state.mjs --store <handle> run-show
//   node scripts/notifications/state.mjs --store <handle> run-end
//     [--root <dir>]   the checkout whose manifest defines the valid ids (tests)
//     [--state-dir <dir>]   override the state directory (tests)
//
// Schema (schemaVersion 2):
//   { schemaVersion: 2, store, seen: { <id>: { version, fnv, length, sha, ref, at } },
//     pending: [ { id, version, fnv, branch, pr } ],
//     lastAudit: { at, source, startedAt,
//                  results: { <id>: { adminVersion, repoVersion, match, render } } } | null,
//     run: { startedAt, ref, sha, onRenderFail, batch,
//            ids: [ { id, match, beforeSource, version, gid, before: {length,fnv},
//                     after: {length,fnv} }... ],
//            done: [<id>...], quarantine: [ { id, at, verifier } ] } | null,
//     auditRun: { startedAt, updatedAt, ref, sha, quick, batch, ids: [<id>...], token,
//                 observedPath } | null }
// `match` is one of MATCH; `render` one of RENDER; `source` one of AUDIT_SOURCE; every `at` is
// ISO 8601; every id is in the manifest; `store` matches the handle rule. `lastAudit.at` is when
// the pass finished and was recorded, `startedAt` when its first reading was taken.
//
// schemaVersion 2 added `auditRun`, and `lastAudit`'s `source` and `startedAt`. The migration is
// ONE-WAY: a v1 file is accepted on read and adopted as-is, and the first MUTATING write bumps it
// to 2 after copying the file to a sibling `.v1.<timestamp>.bak` whose path is printed. No
// read-only subcommand migrates. A checkout that predates this change refuses a v2 file, and the
// recovery is to restore that backup. This diverges from the sibling scripts/policies/lib/state.mjs,
// which refuses a version mismatch and tells the operator to reseed: `seen` here holds one real
// fact per synced template, gathered a browser navigation at a time, and a reseed would destroy
// facts that exist nowhere else.
//
// `run` is the approved plan of a sync in flight, so a run survives a compaction, a crash or a
// new session: `sync --resume` reads it instead of a hand-written handoff document. `ids` holds
// the approved table itself, one entry per id in the order it was approved, because the numbers a
// resumed run gates each paste on are exactly the numbers the operator approved; an id whose
// Admin document no longer matches its `before` is not pasted. `seen` advances the run, so the
// per-id loop costs no extra call, and it refuses a file that is not the approved `after`, so the
// one hand-typed argument left cannot record a template under another one's name. The next id is
// the first of `ids` in neither `done` nor `quarantine`; an empty remainder means the run is
// finished.
//
// A failed render records the id in `quarantine` under BOTH render-failure policies; `halt` then
// ends the run and `quarantine` continues. That is deliberate: were a halted run to leave its
// failed id unsettled, `nextId` would still point at it, and a later `sync --resume` would repaste
// the template that just failed, under the original approval, for as many laps as it is resumed.

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, lstatSync, realpathSync, renameSync } from 'node:fs';
import { join, resolve, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readManifest, isValidVersion, sha256, GID_RE, GID_EXPECTED, REPO_ROOT } from './brand.mjs';
import { hashFile } from './dump.mjs';

export const MATCH = ['in-sync', 'behind', 'ahead', 'unstamped-stock', 'unstamped-edited', 'hash-mismatch', 'orphan'];
export const RENDER = ['pass', 'fail', 'skipped'];
export const ON_RENDER_FAIL = ['halt', 'quarantine'];
// Who recorded a `lastAudit`. A sync-recorded one is a self-attestation: the same agent, in the
// same browser session, re-reading its own writes. Everything that surfaces `lastAudit` prints
// this, because the two are not equally strong evidence that Admin has not drifted.
export const AUDIT_SOURCE = ['sync', 'audit'];
export const STATE_SCHEMA_VERSION = 2;
export const SUPPORTED_SCHEMA_VERSIONS = [1, 2];

// A refusal this file raises on its own, as opposed to one validate() raises about the file.
export class StateError extends Error {}
export const STORE_RE = /^[a-z0-9-]+$/;
export const ID_RE = /^[a-z0-9_]+$/;
const FNV_RE = /^[0-9a-f]{8}$/;
const SHA_RE = /^[0-9a-f]{7,64}$/;
const VERIFIER_MAX = 20000;
// GID_RE and its refusal wording (GID_EXPECTED) are imported from brand.mjs, the only place either
// is written down. This file used to carry its own copy, kept in step with classify.mjs's by a
// comment alone; both were consistently wrong against Admin, which is a failure no parity test
// between two copies can see. The fix is that there is no second copy.
const TOKEN_RE = /^[0-9a-f]{16}$/;
// The observed file is 46 rows of about 80 bytes. These caps are three orders of magnitude above
// that, so anything reaching one is not this file, and the refusal says so rather than reading on.
const OBSERVED_MAX_BYTES = 1 << 20;
const OBSERVED_MAX_ROWS = 1000;
// <id>\t<length>\t<fnv>\t<stamp>\t<gid>\t<readAt>. The first five are classify.mjs's observed
// format unchanged, so one file feeds both; the sixth is this file's per-row read timestamp, which
// classify.mjs ignores (it reads cols 0-4). A row counts only at the full field count.
const OBSERVED_FIELDS = 6;

export function stateDir(env = process.env) {
  const base = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'notification-templates');
}

export function statePath(store, dir = stateDir()) {
  if (!STORE_RE.test(store)) throw new Error(`refused: store handle ${JSON.stringify(store)} does not match ${STORE_RE}`);
  return join(dir, `${store}.json`);
}

export function isIso(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s));
}

export function emptyState(store) {
  return { schemaVersion: STATE_SCHEMA_VERSION, store, seen: {}, pending: [], lastAudit: null, run: null, auditRun: null };
}

// --- the audit run -----------------------------------------------------------------------------
// `auditRun` lets a 46-id `audit` pass survive a compaction, a crash or a new session, which is
// why the pass this record exists for had to be hand-rolled outside the skill the first time.
//
// It is NOT a second `run`, on the axis this skill cares about most: `auditRun` RECORDS NO
// APPROVAL AND MUST NEVER GAIN A FIELD THAT CARRIES ONE. `--resume` is not a general mechanism;
// it exists for `audit` because `audit` performs no write. Any mode that writes to the live store
// requires a fresh operator message in the current session, and a record on disk can never supply
// one. Adding a resume record to a writing mode is a change to the approval gate, not an
// ergonomics change. That is why the field set below is closed: an approval-shaped field cannot be
// added later without a deliberate schema change.
//
// The token binds the observed file to this record and to nothing else. It is derived from the
// record's own `startedAt` and `sha`, so a file left behind by an earlier pass, a file from
// another checkout, or a hand-written one carries the wrong first line and is refused rather than
// becoming a `lastAudit` that claims the store is in sync.
export function auditToken(startedAt, sha) {
  return sha256(`${startedAt} ${sha}`).slice(0, 16);
}

// Beside the state file, not in the session scratchpad: the scratchpad path is keyed by session
// id, so a resumed or forked session would not find the file the resume depends on, which defeats
// the durability the record exists for.
export function observedPathFor(store, token, dir = stateDir()) {
  if (!STORE_RE.test(store)) throw new Error(`refused: store handle ${JSON.stringify(store)} does not match ${STORE_RE}`);
  if (!TOKEN_RE.test(String(token))) throw new Error(`refused: token ${JSON.stringify(token)} does not match ${TOKEN_RE}`);
  return join(dir, `observed-${store}-${token}.tsv`);
}

// The first line. It starts with `#` so classify.mjs skips it: one file is both the resume ledger
// and classify.mjs's --observed input, and a header it had to strip would be a second format.
export function observedHeader(token, startedAt, sha) {
  return `# audit ${token} ${startedAt} ${sha}\n`;
}

// Refuses any path that is not the one file this record owns, inside the state directory. Called
// from validate(), so a stale or hand-edited state file cannot make some later step read
// elsewhere. "Absolute with no .." rejects nothing meaningful on its own, so this also resolves
// symlinks and requires a regular file whenever the path exists.
export function checkObservedPath(value, { store, token, dir, fail }) {
  if (typeof value !== 'string' || value === '') fail('auditRun.observedPath is not a non-empty string');
  if (/[\0\n\r]/.test(value)) fail('auditRun.observedPath contains a NUL or newline');
  if (!isAbsolute(value)) fail(`auditRun.observedPath ${JSON.stringify(value)} is not absolute`);
  const segments = value.split(sep);
  if (segments.includes('..') || segments.includes('.')) fail(`auditRun.observedPath ${JSON.stringify(value)} has a . or .. segment`);
  const expected = observedPathFor(store, token, dir);
  if (value !== expected) fail(`auditRun.observedPath ${JSON.stringify(value)} is not this run's file ${JSON.stringify(expected)}`);
  if (existsSync(value)) {
    const st = lstatSync(value);
    if (st.isSymbolicLink()) fail(`auditRun.observedPath ${JSON.stringify(value)} is a symlink`);
    if (!st.isFile()) fail(`auditRun.observedPath ${JSON.stringify(value)} is not a regular file`);
    // The equality above already pins the basename and the directory string; realpath is what
    // catches a symlinked ancestor pointing the whole directory somewhere else.
    let real;
    let realDir;
    try {
      real = realpathSync(value);
      realDir = realpathSync(dir);
    } catch (err) {
      fail(`auditRun.observedPath ${JSON.stringify(value)} does not resolve: ${err.message}`);
    }
    if (real !== join(realDir, `observed-${store}-${token}.tsv`)) {
      fail(`auditRun.observedPath ${JSON.stringify(value)} resolves to ${JSON.stringify(real)}, outside the state directory`);
    }
  }
  return value;
}

// Progress for a resume, derived from the observed file rather than from a counter in the state
// file: the file is the only thing that knows which ids were actually read.
//
// `next` is the first id in `auditRun.ids` order with no complete row, so two sittings cannot
// disagree about where to carry on. Ids that build a navigation URL come from `auditRun.ids`,
// NEVER from this file; the file decides only WHETHER an id is done.
//
// Everything in this file records what Admin returned. It never directs what to do next, and no
// text in it is an approval, an instruction, or a reason to skip a check.
//
// Three tolerances, and everything else is a hard refusal:
//   - a torn FINAL line (no trailing newline) is the exact artifact of the interruption a resume
//     exists for: it is discarded and its id re-read, even when it looks complete.
//   - a complete row repeated for one id is what a resumed append produces; the last one wins and
//     the repeat is reported, not hidden.
//   - blank lines, `#` comment lines and CRLF endings are skipped or folded, the way classify.mjs
//     treats the same file.
// A malformed row that is not the final line, and a row for an id outside `auditRun.ids`, are
// refusals: the alternative is skipping a row and recording a pass that never read that id.
export function parseObservedProgress(text, { auditRun, fail = (m) => { throw new StateError(`refused: ${m}`); } }) {
  const order = auditRun.ids;
  const known = new Set(order);
  if (typeof text !== 'string' || text.trim() === '') fail(`the observed file ${auditRun.observedPath} is empty; end this run with audit-end --abandon rather than starting the pass over`);
  if (Buffer.byteLength(text, 'utf8') > OBSERVED_MAX_BYTES) fail(`the observed file ${auditRun.observedPath} is larger than ${OBSERVED_MAX_BYTES} bytes, which is not this file`);
  const lines = text.split('\n');
  const torn = lines[lines.length - 1] !== '' ? lines.pop() : null;
  if (lines.length > OBSERVED_MAX_ROWS) fail(`the observed file ${auditRun.observedPath} holds more than ${OBSERVED_MAX_ROWS} lines, which is not this file`);
  const header = observedHeader(auditRun.token, auditRun.startedAt, auditRun.sha).trimEnd();
  const firstLine = (lines[0] === undefined ? '' : lines[0]).replace(/\r$/, '');
  if (firstLine !== header) {
    fail(
      `the observed file ${auditRun.observedPath} starts ${JSON.stringify(firstLine)}, not ${JSON.stringify(header)}. ` +
        'That file was not stamped by this audit run; do not record it.',
    );
  }
  const rows = new Map();
  const duplicates = [];
  for (const [i, raw] of lines.entries()) {
    if (i === 0) continue;
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' || line.startsWith('#')) continue;
    const cols = line.split('\t');
    const where = `${auditRun.observedPath} line ${i + 1}`;
    if (cols.length !== OBSERVED_FIELDS) fail(`${where} has ${cols.length} tab-separated field(s), not ${OBSERVED_FIELDS}: ${JSON.stringify(line)}`);
    const [id, lengthText, fnv, stamp, gid, readAt] = cols;
    if (!ID_RE.test(id)) fail(`${where}: ${JSON.stringify(id)} is not an id`);
    if (!known.has(id)) fail(`${where}: ${id} is not in this run's ids, so this file answers for some other pass`);
    if (!/^[1-9][0-9]*$/.test(lengthText)) fail(`${where}: length ${JSON.stringify(lengthText)} is not a positive integer`);
    if (!FNV_RE.test(fnv)) fail(`${where}: fnv ${JSON.stringify(fnv)} is not eight lowercase hex digits`);
    if (stamp !== 'none' && !/^[a-z0-9_]+ [1-9][0-9]*$/.test(stamp)) fail(`${where}: stamp ${JSON.stringify(stamp)} is not "<id> <version>" or "none"`);
    if (gid !== '-' && !GID_RE.test(gid)) fail(`${where}: gid ${JSON.stringify(gid)} is not usable; ${GID_EXPECTED}, or "-" for a reading that had none`);
    if (!isIso(readAt)) fail(`${where}: read timestamp ${JSON.stringify(readAt)} is not ISO 8601`);
    if (rows.has(id)) duplicates.push(id);
    rows.set(id, { id, length: Number(lengthText), fnv, stamp, gid, readAt });
  }
  const done = order.filter((id) => rows.has(id));
  const remaining = order.filter((id) => !rows.has(id));
  return {
    rows,
    done,
    remaining,
    next: remaining.length ? remaining[0] : null,
    duplicates: [...new Set(duplicates)],
    torn: torn === null || torn.trim() === '' ? null : torn,
  };
}

// Throws on the first violation, naming it. `ids` is the set of manifest ids.
export function validate(state, store, ids, { dir = stateDir() } = {}) {
  const fail = (m) => {
    throw new Error(`refused state file: ${m}`);
  };
  if (!state || typeof state !== 'object' || Array.isArray(state)) fail('not an object');
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(state.schemaVersion)) {
    fail(`schemaVersion ${JSON.stringify(state.schemaVersion)} is not one of ${SUPPORTED_SCHEMA_VERSIONS.join(', ')} (this checkout writes ${STATE_SCHEMA_VERSION})`);
  }
  if (state.store !== store) fail(`store ${JSON.stringify(state.store)} is not ${store}`);
  const known = new Set(['schemaVersion', 'store', 'seen', 'pending', 'lastAudit', 'run', 'auditRun']);
  for (const k of Object.keys(state)) if (!known.has(k)) fail(`unknown field ${k}`);
  // A v1 file carrying a v2-only field is not a v1 file. Adopting it silently would mean reading a
  // record written by a schema this file has not agreed to.
  if (state.schemaVersion === 1 && state.auditRun !== undefined && state.auditRun !== null) fail('schemaVersion 1 carries auditRun, which is a schemaVersion 2 field');
  const checkId = (id, where) => {
    if (!ID_RE.test(id)) fail(`${where}: id ${JSON.stringify(id)} is not an id`);
    if (!ids.has(id)) fail(`${where}: id ${id} is not in the manifest`);
  };
  if (!state.seen || typeof state.seen !== 'object' || Array.isArray(state.seen)) fail('seen is not an object');
  for (const [id, e] of Object.entries(state.seen)) {
    checkId(id, 'seen');
    if (!e || typeof e !== 'object') fail(`seen.${id} is not an object`);
    if (!isValidVersion(e.version)) fail(`seen.${id}.version is not an integer >= 1`);
    if (!FNV_RE.test(String(e.fnv))) fail(`seen.${id}.fnv is not eight hex digits`);
    if (!Number.isInteger(e.length) || e.length < 1) fail(`seen.${id}.length is not a positive integer`);
    if (!SHA_RE.test(String(e.sha))) fail(`seen.${id}.sha is not a git sha`);
    if (typeof e.ref !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(e.ref)) fail(`seen.${id}.ref is not a ref name`);
    if (!isIso(e.at)) fail(`seen.${id}.at is not ISO 8601`);
  }
  if (!Array.isArray(state.pending)) fail('pending is not an array');
  const seenPending = new Set();
  for (const [i, p] of state.pending.entries()) {
    if (!p || typeof p !== 'object') fail(`pending[${i}] is not an object`);
    checkId(p.id, `pending[${i}]`);
    if (seenPending.has(p.id)) fail(`pending lists ${p.id} twice`);
    seenPending.add(p.id);
    if (!isValidVersion(p.version)) fail(`pending[${i}].version is not an integer >= 1`);
    if (!FNV_RE.test(String(p.fnv))) fail(`pending[${i}].fnv is not eight hex digits`);
    if (typeof p.branch !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(p.branch)) fail(`pending[${i}].branch is not a branch name`);
    if (!Number.isInteger(p.pr) || p.pr < 1) fail(`pending[${i}].pr is not a PR number`);
  }
  if (state.lastAudit !== undefined && state.lastAudit !== null) {
    const a = state.lastAudit;
    if (typeof a !== 'object' || Array.isArray(a)) fail('lastAudit is not an object or null');
    const knownAudit = new Set(['at', 'source', 'startedAt', 'results']);
    for (const k of Object.keys(a)) if (!knownAudit.has(k)) fail(`unknown field lastAudit.${k}`);
    if (!isIso(a.at)) fail('lastAudit.at is not ISO 8601');
    // `source` and `startedAt` arrived with schemaVersion 2, and a record written before them is
    // not backfilled: inventing a provenance is worse than reporting that there is none. Readers
    // print "unknown" for an absent source rather than assuming either value.
    if (a.source !== undefined && !AUDIT_SOURCE.includes(a.source)) fail(`lastAudit.source ${JSON.stringify(a.source)} is not one of ${AUDIT_SOURCE.join(', ')}`);
    if (a.startedAt !== undefined && !isIso(a.startedAt)) fail('lastAudit.startedAt is not ISO 8601');
    if (!a.results || typeof a.results !== 'object' || Array.isArray(a.results)) fail('lastAudit.results is not an object');
    for (const [id, r] of Object.entries(a.results)) {
      checkId(id, 'lastAudit.results');
      if (!r || typeof r !== 'object') fail(`lastAudit.results.${id} is not an object`);
      if (r.adminVersion !== null && !isValidVersion(r.adminVersion)) fail(`lastAudit.results.${id}.adminVersion is not null or an integer >= 1`);
      if (!isValidVersion(r.repoVersion)) fail(`lastAudit.results.${id}.repoVersion is not an integer >= 1`);
      if (!MATCH.includes(r.match)) fail(`lastAudit.results.${id}.match ${JSON.stringify(r.match)} is not one of ${MATCH.join(', ')}`);
      if (!RENDER.includes(r.render)) fail(`lastAudit.results.${id}.render ${JSON.stringify(r.render)} is not one of ${RENDER.join(', ')}`);
    }
  }
  // A file written before the run record existed has no `run` at all; that is the same as null.
  if (state.run !== undefined && state.run !== null) {
    const r = state.run;
    if (typeof r !== 'object' || Array.isArray(r)) fail('run is not an object or null');
    const knownRun = new Set(['startedAt', 'ref', 'sha', 'onRenderFail', 'batch', 'ids', 'done', 'quarantine']);
    for (const k of Object.keys(r)) if (!knownRun.has(k)) fail(`unknown field run.${k}`);
    if (!isIso(r.startedAt)) fail('run.startedAt is not ISO 8601');
    if (typeof r.ref !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(r.ref)) fail('run.ref is not a ref name');
    if (!SHA_RE.test(String(r.sha))) fail('run.sha is not a git sha');
    if (!ON_RENDER_FAIL.includes(r.onRenderFail)) fail(`run.onRenderFail ${JSON.stringify(r.onRenderFail)} is not one of ${ON_RENDER_FAIL.join(', ')}`);
    if (r.batch !== null && (!Number.isInteger(r.batch) || r.batch < 1)) fail('run.batch is not null or a positive integer');
    if (!Array.isArray(r.ids) || r.ids.length === 0) fail('run.ids is not a non-empty array');
    const inRun = new Set();
    const numbers = (v, where) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`${where} is not an object`);
      if (!Number.isInteger(v.length) || v.length < 1) fail(`${where}.length is not a positive integer`);
      if (!FNV_RE.test(String(v.fnv))) fail(`${where}.fnv is not eight hex digits`);
      for (const k of Object.keys(v)) if (!['length', 'fnv'].includes(k)) fail(`unknown field ${where}.${k}`);
    };
    for (const [i, e] of r.ids.entries()) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) fail(`run.ids[${i}] is not an object`);
      for (const k of Object.keys(e)) if (!['id', 'match', 'beforeSource', 'version', 'gid', 'before', 'after'].includes(k)) fail(`unknown field run.ids[${i}].${k}`);
      checkId(e.id, `run.ids[${i}]`);
      if (inRun.has(e.id)) fail(`run.ids lists ${e.id} twice`);
      inRun.add(e.id);
      if (!MATCH.includes(e.match)) fail(`run.ids[${i}].match ${JSON.stringify(e.match)} is not one of ${MATCH.join(', ')}`);
      if (!['stock', 'network'].includes(e.beforeSource)) fail(`run.ids[${i}].beforeSource ${JSON.stringify(e.beforeSource)} is not stock or network`);
      if (!isValidVersion(e.version)) fail(`run.ids[${i}].version is not an integer >= 1`);
      if (e.gid !== null && !GID_RE.test(String(e.gid))) fail(`run.ids[${i}].gid ${JSON.stringify(e.gid)} is not usable; ${GID_EXPECTED}, or null for a reading that had none`);
      numbers(e.before, `run.ids[${i}].before`);
      numbers(e.after, `run.ids[${i}].after`);
    }
    const seenDone = new Set();
    if (!Array.isArray(r.done)) fail('run.done is not an array');
    for (const id of r.done) {
      checkId(id, 'run.done');
      if (!inRun.has(id)) fail(`run.done lists ${id}, which is not in run.ids`);
      if (seenDone.has(id)) fail(`run.done lists ${id} twice`);
      seenDone.add(id);
    }
    if (!Array.isArray(r.quarantine)) fail('run.quarantine is not an array');
    const seenQ = new Set();
    for (const [i, q] of r.quarantine.entries()) {
      if (!q || typeof q !== 'object' || Array.isArray(q)) fail(`run.quarantine[${i}] is not an object`);
      for (const k of Object.keys(q)) if (!['id', 'at', 'verifier'].includes(k)) fail(`unknown field run.quarantine[${i}].${k}`);
      checkId(q.id, `run.quarantine[${i}]`);
      if (!inRun.has(q.id)) fail(`run.quarantine[${i}] names ${q.id}, which is not in run.ids`);
      if (seenQ.has(q.id)) fail(`run.quarantine lists ${q.id} twice`);
      if (seenDone.has(q.id)) fail(`${q.id} is both done and quarantined`);
      seenQ.add(q.id);
      if (!isIso(q.at)) fail(`run.quarantine[${i}].at is not ISO 8601`);
      if (typeof q.verifier !== 'string' || q.verifier.trim() === '') fail(`run.quarantine[${i}].verifier is empty`);
      if (q.verifier.length > VERIFIER_MAX) fail(`run.quarantine[${i}].verifier is longer than ${VERIFIER_MAX} characters`);
    }
  }
  // A file written before the audit-run record existed has no `auditRun` at all; that is the same
  // as null. Its field set is CLOSED, deliberately: see the note above auditToken.
  if (state.auditRun !== undefined && state.auditRun !== null) {
    const a = state.auditRun;
    if (typeof a !== 'object' || Array.isArray(a)) fail('auditRun is not an object or null');
    const knownRun = new Set(['startedAt', 'updatedAt', 'ref', 'sha', 'quick', 'batch', 'ids', 'token', 'observedPath']);
    for (const k of Object.keys(a)) if (!knownRun.has(k)) fail(`unknown field auditRun.${k}`);
    for (const k of knownRun) if (!(k in a)) fail(`auditRun has no ${k}`);
    if (!isIso(a.startedAt)) fail('auditRun.startedAt is not ISO 8601');
    if (!isIso(a.updatedAt)) fail('auditRun.updatedAt is not ISO 8601');
    if (typeof a.ref !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(a.ref)) fail('auditRun.ref is not a ref name');
    if (!SHA_RE.test(String(a.sha))) fail('auditRun.sha is not a commit sha');
    if (typeof a.quick !== 'boolean') fail('auditRun.quick is not a boolean');
    if (a.batch !== null && (!Number.isInteger(a.batch) || a.batch < 1)) fail('auditRun.batch is not null or a positive integer');
    if (!Array.isArray(a.ids) || a.ids.length === 0) fail('auditRun.ids is not a non-empty array');
    const inAudit = new Set();
    for (const [i, id] of a.ids.entries()) {
      checkId(id, `auditRun.ids[${i}]`);
      if (inAudit.has(id)) fail(`auditRun.ids lists ${id} twice`);
      inAudit.add(id);
    }
    if (!TOKEN_RE.test(String(a.token))) fail(`auditRun.token ${JSON.stringify(a.token)} does not match ${TOKEN_RE}`);
    // The token is derived from this record's own startedAt and sha, so a token that does not
    // match them is a record that has been edited, and the observed file it vouches for cannot be
    // trusted to be the one this run stamped.
    const derived = auditToken(a.startedAt, a.sha);
    if (a.token !== derived) fail(`auditRun.token ${a.token} is not the token for its own startedAt and sha (${derived})`);
    checkObservedPath(a.observedPath, { store, token: a.token, dir, fail });
  }
  if (state.run === undefined) state.run = null;
  if (state.auditRun === undefined) state.auditRun = null;
  return state;
}

// The first id of the approved order that is neither done nor quarantined, or null when the run
// has no work left. `run` may be null.
export function nextId(run) {
  if (!run) return null;
  const settled = new Set([...run.done, ...run.quarantine.map((q) => q.id)]);
  const entry = run.ids.find((e) => !settled.has(e.id));
  return entry ? entry.id : null;
}

// `migratedFrom` is the on-disk schemaVersion when it is behind this checkout's. The version is
// adopted, not rewritten: nothing here writes, so a read-only subcommand never migrates a file.
// Whether a results object answers for the whole store. `scope` here means the results cover the
// full manifest SET, not that a smaller invocation happened to cover everything it looked at: the
// question a recorded lastAudit answers is "is this store in sync?", and a subset cannot answer it.
// A quarantined id is not a disqualifier, it is a row like any other, with `render: fail`. Were it
// a disqualifier, one permanently quarantined template would mean sync silently never records an
// audit again.
export function auditScope(results, ids) {
  if (!results || typeof results !== 'object' || Array.isArray(results)) throw new StateError('the results file is not an object keyed by id');
  const keys = Object.keys(results);
  const present = new Set(keys);
  const foreign = keys.filter((id) => !ids.has(id));
  const missing = [...ids].filter((id) => !present.has(id)).sort();
  return { covered: keys.filter((id) => ids.has(id)).length, total: ids.size, missing, foreign, complete: missing.length === 0 && foreign.length === 0 };
}

// One sentence about a recorded audit, source included. A record written before schemaVersion 2
// carries no source; that reads as "unknown", never as a guess at which writer made it.
export function auditSummary(lastAudit) {
  if (!lastAudit) return null;
  const n = Object.keys(lastAudit.results).length;
  const source = lastAudit.source === undefined ? 'unknown (recorded before the source was tracked)' : lastAudit.source;
  const note =
    lastAudit.source === 'sync'
      ? ' A sync-recorded audit verifies that run\'s own writes; it does not substitute for a cold audit.'
      : '';
  return `${n} id(s) recorded ${lastAudit.at}${lastAudit.startedAt ? `, pass started ${lastAudit.startedAt}` : ''}, source ${source}.${note}`;
}

// The observed file, refused rather than treated as an empty pass. Starting over on a missing file
// would silently re-drive one browser navigation per id, which is the cost the record exists to
// avoid paying twice.
export function readObserved(auditRun) {
  if (!existsSync(auditRun.observedPath)) {
    throw new StateError(
      `refused: the observed file ${auditRun.observedPath} is missing, so this run's readings cannot be confirmed. ` +
        'Discard the run with audit-end --abandon and start a fresh pass; this never silently starts over.',
    );
  }
  return readFileSync(auditRun.observedPath, 'utf8');
}

// For a message that wants a progress count but must not fail because the file is unreadable.
function auditProgressOrNull(auditRun) {
  try {
    return parseObservedProgress(readObserved(auditRun), { auditRun });
  } catch {
    return null;
  }
}

export function load(store, { root = REPO_ROOT, dir = stateDir() } = {}) {
  const ids = new Set(Object.keys(readManifest(root).templates));
  const file = statePath(store, dir);
  if (!existsSync(file)) return { state: emptyState(store), ids, file, created: true, migratedFrom: null };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`refused state file: not JSON (${err.message})`);
  }
  const state = validate(parsed, store, ids, { dir });
  return { state, ids, file, created: false, migratedFrom: state.schemaVersion === STATE_SCHEMA_VERSION ? null : state.schemaVersion };
}

export function save(state, store, { root = REPO_ROOT, dir = stateDir() } = {}) {
  const ids = new Set(Object.keys(readManifest(root).templates));
  // The migration happens here and only here: on the first mutating write, one way, with the old
  // file kept. The version is bumped BEFORE validation, because the write that triggers a
  // migration is usually the one adding a schemaVersion 2 field, and validating the old version
  // first would refuse it. Nothing is copied until validation passes, so a refused write leaves
  // neither a new file nor a stray backup.
  const from = state.schemaVersion;
  const migrating = from !== STATE_SCHEMA_VERSION;
  if (migrating) state.schemaVersion = STATE_SCHEMA_VERSION;
  validate(state, store, ids, { dir });
  const file = statePath(store, dir);
  mkdirSync(dir, { recursive: true });
  // Announced rather than silent: the file this leaves behind is refused by a checkout that
  // predates this schema, and that backup is the whole recovery.
  if (migrating && existsSync(file)) {
    const stampedAt = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${file}.v${from}.${stampedAt}.bak`;
    if (existsSync(backup)) throw new StateError(`refused: ${backup} already exists; a backup is never clobbered`);
    copyFileSync(file, backup);
    console.error(
      `migrating ${file} from schemaVersion ${from} to schemaVersion ${STATE_SCHEMA_VERSION}. ` +
        `The schemaVersion ${from} file is kept byte for byte at ${backup}; a checkout that predates ` +
        `schemaVersion ${STATE_SCHEMA_VERSION} refuses the new file, and restoring that backup is the way back.`,
    );
  }
  // Atomic: the temp file plus a rename, so an interrupted write never leaves a half-written state
  // file where the next load would refuse it.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
  return file;
}

function main(argv) {
  const args = argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const store = get('--store');
  const root = get('--root') ? resolve(get('--root')) : REPO_ROOT;
  const dir = get('--state-dir') ? resolve(get('--state-dir')) : stateDir();
  const flagsWithValue = new Set(['--store', '--root', '--state-dir', '--version', '--fnv', '--length', '--sha', '--ref', '--branch', '--pr', '--from-file', '--on-render-fail', '--batch', '--reason', '--source', '--started-at']);
  const positional = args.filter((a, i) => !a.startsWith('--') && !flagsWithValue.has(args[i - 1]));
  const [command, ...rest] = positional;
  if (!store || !command) {
    console.error(
      'usage: state.mjs --store <handle> (show | seen <id> ... | pending-add <id> ... | pending-remove <id...> | ' +
        'audit <results.json> [--source sync|audit] [--started-at <iso>] [--partial] | ' +
        'audit-start --ref <ref> --sha <sha> [--quick] [--batch <n>] [--force] [<id>...] | audit-show | ' +
        'audit-end <results.json> | audit-end --abandon | ' +
        'run-start <plan.json> ... | run-quarantine <id> <verifier.txt> | run-show | run-end)',
    );
    return 2;
  }
  const opts = { root, dir };
  const { state, file, ids, migratedFrom } = load(store, opts);
  const now = new Date().toISOString();
  if (command === 'show') {
    // Both derived lines exist so a reader does not have to know the schema to see them: whether
    // the next write migrates this file, and WHO recorded the audit it is reporting. A
    // sync-recorded lastAudit is the same agent re-reading its own writes in the same browser
    // session, which is weaker evidence than a cold audit that Admin has not drifted since.
    console.log(
      JSON.stringify(
        {
          file,
          migratesOnNextWrite: migratedFrom === null ? null : `schemaVersion ${migratedFrom} -> ${STATE_SCHEMA_VERSION}`,
          lastAuditSummary: auditSummary(state.lastAudit),
          ...state,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (command === 'seen') {
    const [id] = rest;
    if (!id) throw new StateError('seen needs an id');
    if (get('--from-file') === undefined && (get('--version') === undefined || get('--fnv') === undefined || get('--length') === undefined)) {
      throw new StateError('seen needs --from-file, or all of --version, --fnv and --length');
    }
    // --from-file derives version, length and fnv from the file that was pasted, so the per-id
    // loop retypes none of them; --sha and --ref fall back to the run in flight for the same
    // reason. Every one of these was a hand-typed flag, and a slip writes a wrong hint.
    let version = get('--version') === undefined ? undefined : Number(get('--version'));
    let fnv = get('--fnv');
    let length = get('--length') === undefined ? undefined : Number(get('--length'));
    const fromFile = get('--from-file');
    const runRow = state.run ? state.run.ids.find((e) => e.id === id) : undefined;
    if (fromFile) {
      const h = hashFile(resolve(fromFile));
      // With a run in flight the approved `after` is the authority, not the manifest under
      // whatever root this happens to run from: it is the number the operator approved pasting,
      // and checking the file against it is what stops one hand-typed path from recording another
      // template's bytes under this id and marking it done.
      if (runRow) {
        if (h.length !== runRow.after.length || h.hash !== runRow.after.fnv) {
          console.error(
            `refused: ${resolve(fromFile)} is ${h.length} ${h.hash}, but the run approved ${runRow.after.length} ${runRow.after.fnv} for ${id}. ` +
              'That is not the file this id was approved to hold; nothing recorded.',
          );
          return 1;
        }
        version = runRow.version;
      } else {
        const entry = readManifest(root).templates[id];
        if (!entry) {
          console.error(`refused: ${id} is not in the manifest`);
          return 1;
        }
        version = entry.version;
      }
      fnv = h.hash;
      length = h.length;
    }
    const sha = get('--sha') || (state.run && state.run.sha);
    const ref = get('--ref') || (state.run && state.run.ref);
    state.seen[id] = { version, fnv, length, sha, ref, at: now };
    state.pending = state.pending.filter((p) => p.id !== id);
    // A `seen` write is what finishes an id, so it advances the run in flight rather than costing
    // the loop a second call.
    let advanced = '';
    if (runRow && !state.run.done.includes(id) && !state.run.quarantine.some((q) => q.id === id)) {
      state.run.done.push(id);
      advanced = `, run ${state.run.done.length}/${state.run.ids.length}`;
    }
    save(state, store, opts);
    console.log(`${id}: seen v${state.seen[id].version} fnv ${state.seen[id].fnv} at ${now}${advanced} -> ${file}`);
    return 0;
  }
  if (command === 'pending-add') {
    const [id] = rest;
    state.pending = state.pending.filter((p) => p.id !== id);
    state.pending.push({ id, version: Number(get('--version')), fnv: get('--fnv'), branch: get('--branch'), pr: Number(get('--pr')) });
    save(state, store, opts);
    console.log(`${id}: pending v${get('--version')} from ${get('--branch')} (PR #${get('--pr')}) -> ${file}`);
    return 0;
  }
  if (command === 'pending-remove') {
    const before = state.pending.length;
    state.pending = state.pending.filter((p) => !rest.includes(p.id));
    save(state, store, opts);
    console.log(`removed ${before - state.pending.length} pending entr${before - state.pending.length === 1 ? 'y' : 'ies'} -> ${file}`);
    return 0;
  }
  if (command === 'audit') {
    // An audit run in flight has its own recorder, audit-end, which applies the same guard plus the
    // observed file's own completeness. Recording through this path as well would leave two records
    // of one pass with no way to tell which is which.
    if (state.auditRun) {
      console.error(
        `refused: an audit run started ${state.auditRun.startedAt} is in flight. Record it with audit-end, ` +
          'or discard it with audit-end --abandon, before recording an audit through this path.',
      );
      return 1;
    }
    if (!rest[0]) throw new StateError('audit needs a results file');
    const results = JSON.parse(readFileSync(resolve(rest[0]), 'utf8'));
    const source = get('--source') || 'audit';
    if (!AUDIT_SOURCE.includes(source)) throw new StateError(`--source ${JSON.stringify(source)} is not one of ${AUDIT_SOURCE.join(', ')}`);
    const startedAt = get('--started-at') || now;
    if (!isIso(startedAt)) throw new StateError(`--started-at ${JSON.stringify(startedAt)} is not ISO 8601`);
    const guard = auditScope(results, ids);
    if (!guard.complete) {
      // The guard is here rather than in a mode file because a rule in prose is an instruction an
      // agent may skip, and because this subcommand can be invoked directly. A partial pass that
      // recorded a lastAudit would answer "is the store in sync?" from readings that never covered
      // the whole store.
      // Emitted verbatim, by the code rather than by a mode file, so the sentence a run reports
      // and the sentence the guard applies cannot drift apart.
      const why =
        `lastAudit not recorded: run covered ${guard.covered} of ${guard.total} manifest ids. Run audit for a full verification.` +
        (guard.missing.length ? ` Missing: ${guard.missing.join(', ')}.` : '') +
        (guard.foreign.length ? ` Not manifest ids: ${guard.foreign.join(', ')}.` : '');
      if (args.includes('--partial')) {
        console.log(why);
        return 0;
      }
      console.error(`refused: ${why} Pass --partial to report that without recording anything.`);
      return 1;
    }
    if (args.includes('--partial')) {
      console.error('refused: --partial records nothing, and these results are complete; drop the flag to record them.');
      return 1;
    }
    state.lastAudit = { at: now, source, startedAt, results };
    save(state, store, opts);
    console.log(`audit of ${Object.keys(results).length} id(s) recorded at ${now}, source ${source}, started ${startedAt} -> ${file}`);
    return 0;
  }

  if (command === 'audit-start') {
    if (state.auditRun && !args.includes('--force')) {
      const progress = auditProgressOrNull(state.auditRun);
      console.error(
        `refused: an audit run started ${state.auditRun.startedAt} is still in flight ` +
          `(${progress ? `${progress.done.length}/${state.auditRun.ids.length} read` : 'its observed file is unreadable'}). ` +
          'Continue it (audit --resume), record it (audit-end), or discard it (audit-end --abandon); --force replaces it.',
      );
      return 1;
    }
    if (state.auditRun) {
      const progress = auditProgressOrNull(state.auditRun);
      console.log(
        `--force replaces the audit run started ${state.auditRun.startedAt}: ` +
          `${progress ? progress.done.length : 0} of ${state.auditRun.ids.length} id(s) read. ` +
          `Those readings stay on disk at ${state.auditRun.observedPath} but no longer resume.`,
      );
    }
    const ref = get('--ref');
    const sha = get('--sha');
    if (!ref || !sha) throw new StateError('audit-start needs --ref and --sha');
    // Sorted, so `next` cannot depend on the order the ids happened to be typed in: two sittings
    // of one pass have to agree about where to carry on.
    const requested = rest.length ? [...new Set(rest)].sort() : [...ids].sort();
    if (rest.length !== new Set(rest).size) throw new StateError(`audit-start was given a duplicate id: ${rest.join(', ')}`);
    const foreign = requested.filter((id) => !ids.has(id));
    if (foreign.length) throw new StateError(`not manifest ids: ${foreign.join(', ')}`);
    if (requested.length === 0) throw new StateError('audit-start has no ids');
    const batchArg = get('--batch');
    const token = auditToken(now, sha);
    const observedPath = observedPathFor(store, token, dir);
    state.auditRun = {
      startedAt: now,
      updatedAt: now,
      ref,
      sha,
      quick: args.includes('--quick'),
      batch: batchArg === undefined ? null : Number(batchArg),
      ids: requested,
      token,
      observedPath,
    };
    mkdirSync(dir, { recursive: true });
    // Stamped before the record is saved: a record whose file has no header is refused by every
    // later read, so the file goes first.
    writeFileSync(observedPath, observedHeader(token, now, sha), 'utf8');
    save(state, store, opts);
    console.log(
      `audit run started: ${requested.length} id(s) from ${ref} ${String(sha).slice(0, 7)}` +
        `${state.auditRun.quick ? ', quick' : ''}, next ${requested[0]}\nappend one row per id to ${observedPath}\n` +
        `row format: <id>\\t<length>\\t<fnv>\\t<stamp>\\t<gid>\\t<readAt>  (stamp "none", gid "-", readAt ISO 8601)\n-> ${file}`,
    );
    return 0;
  }

  if (command === 'audit-show') {
    if (!state.auditRun) {
      console.log('no audit run in flight');
      return 0;
    }
    const progress = parseObservedProgress(readObserved(state.auditRun), { auditRun: state.auditRun });
    const newest = [...progress.rows.values()].map((r) => r.readAt).sort().at(-1) || null;
    console.log(
      JSON.stringify(
        {
          file,
          ...state.auditRun,
          done: progress.done,
          remaining: progress.remaining,
          next: progress.next,
          duplicates: progress.duplicates,
          tornRowDiscarded: progress.torn,
          newestReadAt: newest,
          coversManifest: state.auditRun.ids.length === ids.size,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (command === 'audit-end') {
    if (!state.auditRun) {
      console.log('no audit run in flight');
      return 0;
    }
    const run = state.auditRun;
    if (args.includes('--abandon')) {
      state.auditRun = null;
      save(state, store, opts);
      console.log(
        `audit run started ${run.startedAt} abandoned; lastAudit unchanged. ` +
          `Its readings stay at ${run.observedPath}. -> ${file}`,
      );
      return 0;
    }
    if (!rest[0]) throw new StateError('audit-end needs a results file, or --abandon to discard the run without recording');
    const results = JSON.parse(readFileSync(resolve(rest[0]), 'utf8'));
    const progress = parseObservedProgress(readObserved(run), { auditRun: run });
    const guard = auditScope(results, ids);
    // Two separate completeness questions, and a pass has to answer both: did the browser actually
    // read every id (the observed file), and did the run target the whole store (the manifest set)?
    const shortfalls = [];
    if (progress.remaining.length) shortfalls.push(`${progress.remaining.length} id(s) in this run were never read: ${progress.remaining.join(', ')}`);
    if (run.ids.length !== ids.size) shortfalls.push(`the run covered ${run.ids.length} of ${ids.size} manifest ids`);
    if (!guard.complete) {
      shortfalls.push(
        `the results cover ${guard.covered} of ${guard.total} manifest ids` +
          (guard.missing.length ? ` (missing ${guard.missing.join(', ')})` : '') +
          (guard.foreign.length ? ` (not manifest ids: ${guard.foreign.join(', ')})` : ''),
      );
    }
    if (shortfalls.length) {
      state.auditRun = null;
      save(state, store, opts);
      console.log(
        `partial pass, lastAudit unchanged (${progress.done.length} of ${run.ids.length} ids read): ${shortfalls.join('; ')}. ` +
          `The audit run is cleared; readings stay at ${run.observedPath}. -> ${file}`,
      );
      return 0;
    }
    state.lastAudit = { at: now, source: 'audit', startedAt: run.startedAt, results };
    state.auditRun = null;
    save(state, store, opts);
    const carried = [...progress.rows.values()].filter((r) => r.readAt < run.startedAt).length;
    console.log(
      `audit of ${Object.keys(results).length} id(s) recorded at ${now}, source audit, started ${run.startedAt} -> ${file}` +
        (progress.duplicates.length ? `\nid(s) read more than once, latest row used: ${progress.duplicates.join(', ')}` : '') +
        (carried ? `\n${carried} row(s) predate this run's start; every row's readAt is in ${run.observedPath}` : ''),
    );
    return 0;
  }
  if (command === 'run-start') {
    if (state.run && !args.includes('--force')) {
      console.error(
        `refused: a run started ${state.run.startedAt} is still in flight (${state.run.done.length}/${state.run.ids.length} done, ` +
          `${state.run.quarantine.length} quarantined). End it with run-end, or pass --force to replace it.`,
      );
      return 1;
    }
    if (state.run) {
      // Say what --force is about to destroy. The quarantine list is the only record of which ids
      // failed and why, and it does not survive the replacement.
      const q = state.run.quarantine.map((e) => e.id);
      console.log(
        `--force replaces the run started ${state.run.startedAt}: ${state.run.done.length} done, ` +
          `${q.length} quarantined${q.length ? ` (${q.join(', ')})` : ''}, ` +
          `${state.run.ids.length - state.run.done.length - q.length} not attempted. That record is discarded.`,
      );
    }
    // The plan file is classify.mjs's --json output: the approved table, rows and all. Only the
    // rows it marks `paste` become the run; an in-sync id is not a write and an `ahead` id is not
    // one the operator approved overwriting.
    const parsed = JSON.parse(readFileSync(resolve(rest[0]), 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed.ids;
    if (!Array.isArray(list) || list.length === 0) {
      console.error('refused: the plan file carries no rows');
      return 1;
    }
    // Every row must say what it is for. Accepting an action-less row as a paste meant a run-show
    // dump, whose rows carry no action, could be fed back in and resurrect the done and quarantined
    // ids as fresh pastes.
    for (const [i, e] of list.entries()) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) throw new StateError(`plan row ${i} is not an object`);
      if (!['paste', 'skip', 'flag'].includes(e.action)) {
        throw new StateError(`plan row ${i} (${e.id}) has action ${JSON.stringify(e.action)}; expected paste, skip or flag. Pass classify.mjs --json output.`);
      }
    }
    const ids = list
      .filter((e) => e.action === 'paste')
      .map((e, i) => {
        for (const field of ['id', 'match', 'beforeSource', 'version']) {
          if (e[field] === undefined) throw new StateError(`plan row ${i} (${e.id}) has no ${field}`);
        }
        for (const field of ['before', 'after']) {
          if (!e[field] || typeof e[field] !== 'object') throw new StateError(`plan row ${i} (${e.id}) has no ${field} numbers`);
        }
        return {
          id: e.id,
          match: e.match,
          beforeSource: e.beforeSource,
          version: e.version,
          gid: e.gid === undefined ? null : e.gid,
          before: { length: e.before.length, fnv: e.before.fnv },
          after: { length: e.after.length, fnv: e.after.fnv },
        };
      });
    if (ids.length === 0) {
      console.error('refused: the plan file has no row whose action is paste');
      return 1;
    }
    const batchArg = get('--batch');
    state.run = {
      startedAt: now,
      ref: get('--ref'),
      sha: get('--sha'),
      onRenderFail: get('--on-render-fail') || 'halt',
      batch: batchArg === undefined ? null : Number(batchArg),
      ids,
      done: [],
      quarantine: [],
    };
    save(state, store, opts);
    console.log(`run started: ${ids.length} id(s) from ${state.run.ref} ${String(state.run.sha).slice(0, 7)}, on-render-fail ${state.run.onRenderFail}, next ${nextId(state.run)} -> ${file}`);
    return 0;
  }
  if (command === 'run-quarantine') {
    if (!state.run) {
      console.error('refused: no run is in flight');
      return 1;
    }
    const [id, verifierPath] = rest;
    if (!state.run.ids.some((e) => e.id === id)) {
      console.error(`refused: ${id} is not in the run (${state.run.ids.map((e) => e.id).join(', ')})`);
      return 1;
    }
    if (state.run.done.includes(id)) {
      console.error(`refused: ${id} is already recorded done; a template cannot be both done and quarantined`);
      return 1;
    }
    const verifier = readFileSync(resolve(verifierPath), 'utf8');
    state.run.quarantine = state.run.quarantine.filter((q) => q.id !== id);
    state.run.quarantine.push({ id, at: now, verifier });
    save(state, store, opts);
    console.log(`${id}: quarantined at ${now} (${state.run.quarantine.length} quarantined), next ${nextId(state.run)} -> ${file}`);
    return 0;
  }
  if (command === 'run-show') {
    if (!state.run) {
      console.log('no run in flight');
      return 0;
    }
    const remaining = state.run.ids.filter((e) => !state.run.done.includes(e.id) && !state.run.quarantine.some((q) => q.id === e.id));
    console.log(JSON.stringify({ file, ...state.run, next: nextId(state.run), remaining }, null, 2));
    return 0;
  }
  if (command === 'run-end') {
    const reason = get('--reason') || 'done';
    if (!['done', 'halt'].includes(reason)) throw new StateError(`--reason ${JSON.stringify(reason)} is not done or halt`);
    if (!state.run) {
      console.log('no run in flight');
      return 0;
    }
    const { done, quarantine, ids } = state.run;
    state.run = null;
    save(state, store, opts);
    console.log(
      `run ended (${reason}): ${done.length} done, ${quarantine.length} quarantined, ` +
        `${ids.length - done.length - quarantine.length} not attempted -> ${file}`,
    );
    return 0;
  }
  console.error(
    `unknown command ${command}; expected one of show, seen, pending-add, pending-remove, audit, ` +
      'audit-start, audit-show, audit-end, run-start, run-quarantine, run-show, run-end',
  );
  return 2;
}

// Every refusal in this file, whether it comes from validate() or from a command's own check,
// reaches the operator as one sentence and exit 1. A stack trace here would be the validator's
// carefully worded message buried under five frames, on a tool whose entire job is refusing.
export function run(argv) {
  try {
    return main(argv);
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    console.error(message.startsWith('refused') ? message : `refused: ${message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv);
}
