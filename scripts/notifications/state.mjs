#!/usr/bin/env node
// The notification-templates skill's per-store state file: a cache of what Admin was last seen
// to hold, kept outside the checkout (it is a live-store fact and belongs in no PR). A hint,
// never an authority: sync and audit always read Admin. Every read validates the whole file and
// refuses it on any violation, because an id from this file flows into a navigation URL.
//
//   ${XDG_STATE_HOME:-~/.local/state}/notification-templates/<store>.json
//
//   node scripts/notifications/state.mjs --store <handle> show
//   node scripts/notifications/state.mjs --store <handle> seen <id> --version <n> --fnv <hex> --length <n> --sha <sha> --ref <ref>
//   node scripts/notifications/state.mjs --store <handle> pending-add <id> --version <n> --fnv <hex> --branch <name> --pr <n>
//   node scripts/notifications/state.mjs --store <handle> pending-remove <id...>
//   node scripts/notifications/state.mjs --store <handle> audit <results.json>
//     [--root <dir>]   the checkout whose manifest defines the valid ids (tests)
//     [--state-dir <dir>]   override the state directory (tests)
//
// Schema (schemaVersion 1):
//   { schemaVersion: 1, store, seen: { <id>: { version, fnv, length, sha, ref, at } },
//     pending: [ { id, version, fnv, branch, pr } ],
//     lastAudit: { at, results: { <id>: { adminVersion, repoVersion, match, render } } } | null }
// `match` is one of MATCH; `render` one of RENDER; every `at` is ISO 8601; every id is in the
// manifest; `store` matches the handle rule.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readManifest, isValidVersion, REPO_ROOT } from './brand.mjs';

export const MATCH = ['in-sync', 'behind', 'ahead', 'unstamped-stock', 'unstamped-edited', 'hash-mismatch', 'orphan'];
export const RENDER = ['pass', 'fail', 'skipped'];
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
  return { schemaVersion: 1, store, seen: {}, pending: [], lastAudit: null };
}

// Throws on the first violation, naming it. `ids` is the set of manifest ids.
export function validate(state, store, ids) {
  const fail = (m) => {
    throw new Error(`refused state file: ${m}`);
  };
  if (!state || typeof state !== 'object' || Array.isArray(state)) fail('not an object');
  if (state.schemaVersion !== 1) fail(`schemaVersion ${JSON.stringify(state.schemaVersion)} is not 1`);
  if (state.store !== store) fail(`store ${JSON.stringify(state.store)} is not ${store}`);
  const known = new Set(['schemaVersion', 'store', 'seen', 'pending', 'lastAudit']);
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
  return state;
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
  const flagsWithValue = new Set(['--store', '--root', '--state-dir', '--version', '--fnv', '--length', '--sha', '--ref', '--branch', '--pr']);
  const positional = args.filter((a, i) => !a.startsWith('--') && !flagsWithValue.has(args[i - 1]));
  const [command, ...rest] = positional;
  if (!store || !command) {
    console.error('usage: state.mjs --store <handle> (show | seen <id> ... | pending-add <id> ... | pending-remove <id...> | audit <results.json>)');
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
    state.seen[id] = { version: Number(get('--version')), fnv: get('--fnv'), length: Number(get('--length')), sha: get('--sha'), ref: get('--ref'), at: now };
    state.pending = state.pending.filter((p) => p.id !== id);
    save(state, store, opts);
    console.log(`${id}: seen v${state.seen[id].version} fnv ${state.seen[id].fnv} at ${now} -> ${file}`);
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
  console.error(`unknown command ${command}`);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
