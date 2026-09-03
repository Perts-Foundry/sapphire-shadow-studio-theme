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
//   node scripts/notifications/state.mjs --store <handle> run-start <plan.json> --ref <ref> --sha <sha>
//        [--on-render-fail halt|quarantine] [--batch <n>] [--force]
//   node scripts/notifications/state.mjs --store <handle> run-quarantine <id> <verifier.txt>
//   node scripts/notifications/state.mjs --store <handle> run-show
//   node scripts/notifications/state.mjs --store <handle> run-end
//     [--root <dir>]   the checkout whose manifest defines the valid ids (tests)
//     [--state-dir <dir>]   override the state directory (tests)
//
// Schema (schemaVersion 1):
//   { schemaVersion: 1, store, seen: { <id>: { version, fnv, length, sha, ref, at } },
//     pending: [ { id, version, fnv, branch, pr } ],
//     lastAudit: { at, results: { <id>: { adminVersion, repoVersion, match, render } } } | null,
//     run: { startedAt, ref, sha, onRenderFail, batch,
//            ids: [ { id, match, beforeSource, before: {length,fnv}, after: {length,fnv} }... ],
//            done: [<id>...], quarantine: [ { id, at, verifier } ] } | null }
// `match` is one of MATCH; `render` one of RENDER; every `at` is ISO 8601; every id is in the
// manifest; `store` matches the handle rule.
//
// `run` is the approved plan of a sync in flight, so a run survives a compaction, a crash or a
// new session: `sync --resume` reads it instead of a hand-written handoff document. `ids` holds
// the approved table itself, one entry per id in the order it was approved, because the numbers a
// resumed run gates each paste on are exactly the numbers the operator approved; an id whose
// Admin document no longer matches its `before` is not pasted. `seen` advances the run, so the
// per-id loop costs no extra call. The next id is the first of `ids` in neither `done` nor
// `quarantine`; an empty remainder means the run is finished.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readManifest, isValidVersion, REPO_ROOT } from './brand.mjs';
import { hashFile } from './dump.mjs';

export const MATCH = ['in-sync', 'behind', 'ahead', 'unstamped-stock', 'unstamped-edited', 'hash-mismatch', 'orphan'];
export const RENDER = ['pass', 'fail', 'skipped'];
export const ON_RENDER_FAIL = ['halt', 'quarantine'];
export const STORE_RE = /^[a-z0-9-]+$/;
export const ID_RE = /^[a-z0-9_]+$/;
const FNV_RE = /^[0-9a-f]{8}$/;
const SHA_RE = /^[0-9a-f]{7,64}$/;

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
  return { schemaVersion: 1, store, seen: {}, pending: [], lastAudit: null, run: null };
}

// Throws on the first violation, naming it. `ids` is the set of manifest ids.
export function validate(state, store, ids) {
  const fail = (m) => {
    throw new Error(`refused state file: ${m}`);
  };
  if (!state || typeof state !== 'object' || Array.isArray(state)) fail('not an object');
  if (state.schemaVersion !== 1) fail(`schemaVersion ${JSON.stringify(state.schemaVersion)} is not 1`);
  if (state.store !== store) fail(`store ${JSON.stringify(state.store)} is not ${store}`);
  const known = new Set(['schemaVersion', 'store', 'seen', 'pending', 'lastAudit', 'run']);
  for (const k of Object.keys(state)) if (!known.has(k)) fail(`unknown field ${k}`);
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
  if (state.lastAudit !== null) {
    const a = state.lastAudit;
    if (!a || typeof a !== 'object') fail('lastAudit is not an object or null');
    if (!isIso(a.at)) fail('lastAudit.at is not ISO 8601');
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
      for (const k of Object.keys(e)) if (!['id', 'match', 'beforeSource', 'before', 'after'].includes(k)) fail(`unknown field run.ids[${i}].${k}`);
      checkId(e.id, `run.ids[${i}]`);
      if (inRun.has(e.id)) fail(`run.ids lists ${e.id} twice`);
      inRun.add(e.id);
      if (!MATCH.includes(e.match)) fail(`run.ids[${i}].match ${JSON.stringify(e.match)} is not one of ${MATCH.join(', ')}`);
      if (!['stock', 'network'].includes(e.beforeSource)) fail(`run.ids[${i}].beforeSource ${JSON.stringify(e.beforeSource)} is not stock or network`);
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
    }
  }
  if (state.run === undefined) state.run = null;
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

export function load(store, { root = REPO_ROOT, dir = stateDir() } = {}) {
  const ids = new Set(Object.keys(readManifest(root).templates));
  const file = statePath(store, dir);
  if (!existsSync(file)) return { state: emptyState(store), ids, file, created: true };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`refused state file: not JSON (${err.message})`);
  }
  return { state: validate(parsed, store, ids), ids, file, created: false };
}

export function save(state, store, { root = REPO_ROOT, dir = stateDir() } = {}) {
  const ids = new Set(Object.keys(readManifest(root).templates));
  validate(state, store, ids);
  const file = statePath(store, dir);
  mkdirSync(dir, { recursive: true });
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
  const flagsWithValue = new Set(['--store', '--root', '--state-dir', '--version', '--fnv', '--length', '--sha', '--ref', '--branch', '--pr', '--from-file', '--on-render-fail', '--batch']);
  const positional = args.filter((a, i) => !a.startsWith('--') && !flagsWithValue.has(args[i - 1]));
  const [command, ...rest] = positional;
  if (!store || !command) {
    console.error('usage: state.mjs --store <handle> (show | seen <id> ... | pending-add <id> ... | pending-remove <id...> | audit <results.json> | run-start <plan.json> ... | run-quarantine <id> <verifier.txt> | run-show | run-end)');
    return 2;
  }
  const opts = { root, dir };
  const { state, file } = load(store, opts);
  const now = new Date().toISOString();
  if (command === 'show') {
    console.log(JSON.stringify({ file, ...state }, null, 2));
    return 0;
  }
  if (command === 'seen') {
    const [id] = rest;
    // --from-file derives version, length and fnv from the file that was pasted, so the per-id
    // loop retypes none of them; --sha and --ref fall back to the run in flight for the same
    // reason. Every one of these was a hand-typed flag, and a slip writes a wrong hint.
    let version = get('--version') === undefined ? undefined : Number(get('--version'));
    let fnv = get('--fnv');
    let length = get('--length') === undefined ? undefined : Number(get('--length'));
    const fromFile = get('--from-file');
    if (fromFile) {
      const entry = readManifest(root).templates[id];
      if (!entry) {
        console.error(`refused: ${id} is not in the manifest`);
        return 1;
      }
      const h = hashFile(resolve(fromFile));
      version = entry.version;
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
    if (state.run && state.run.ids.some((e) => e.id === id) && !state.run.done.includes(id) && !state.run.quarantine.some((q) => q.id === id)) {
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
    const results = JSON.parse(readFileSync(rest[0], 'utf8'));
    state.lastAudit = { at: now, results };
    save(state, store, opts);
    console.log(`audit of ${Object.keys(results).length} id(s) recorded at ${now} -> ${file}`);
    return 0;
  }
  if (command === 'run-start') {
    if (state.run && !args.includes('--force')) {
      console.error(`refused: a run started ${state.run.startedAt} is still in flight (${state.run.done.length}/${state.run.ids.length} done). Finish it, or pass --force to replace it.`);
      return 1;
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
    const ids = list
      .filter((e) => e && (e.action === undefined || e.action === 'paste'))
      .map((e) => ({ id: e.id, match: e.match, beforeSource: e.beforeSource, before: { length: e.before.length, fnv: e.before.fnv }, after: { length: e.after.length, fnv: e.after.fnv } }));
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
    if (!state.run) {
      console.log('no run in flight');
      return 0;
    }
    const { done, quarantine, ids } = state.run;
    state.run = null;
    save(state, store, opts);
    console.log(`run ended: ${done.length} done, ${quarantine.length} quarantined, ${ids.length - done.length - quarantine.length} not attempted -> ${file}`);
    return 0;
  }
  console.error(`unknown command ${command}`);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
