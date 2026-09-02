// scripts/notifications/state.mjs holds the skill's per-store cache of what Admin was last seen
// to hold. Its one job that matters is refusal: an id from this file flows into a navigation URL,
// so a file that violates the schema in any way is refused whole, never partially read.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validate, load, save, emptyState, statePath, stateDir, isIso, MATCH, RENDER } from '../state.mjs';
import { paths } from '../brand.mjs';
import { pickTool, encodeFor } from '../clipboard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'state.mjs');
const SHA = 'a'.repeat(40);

function root() {
  const r = mkdtempSync(path.join(tmpdir(), 'ssb-state-'));
  const p = paths(r);
  mkdirSync(p.stockDir, { recursive: true });
  writeFileSync(p.manifest, JSON.stringify({ templates: { alpha: { version: 1 }, beta: { version: 2 } } }), 'utf8');
  return r;
}

function goodState() {
  return {
    schemaVersion: 1,
    store: 'my-store',
    seen: { alpha: { version: 1, fnv: 'deadbeef', length: 1234, sha: SHA, ref: 'origin/main', at: '2026-09-01T10:00:00Z' } },
    pending: [{ id: 'beta', version: 2, fnv: '01234567', branch: 'feat/x', pr: 150 }],
    lastAudit: { at: '2026-09-01T11:00:00.000Z', results: { alpha: { adminVersion: 1, repoVersion: 1, match: 'in-sync', render: 'pass' }, beta: { adminVersion: null, repoVersion: 2, match: 'unstamped-stock', render: 'skipped' } } },
  };
}

const ids = new Set(['alpha', 'beta']);

test('a well-formed state validates, and the empty state is well-formed', () => {
  assert.deepEqual(validate(goodState(), 'my-store', ids), goodState());
  assert.deepEqual(validate(emptyState('my-store'), 'my-store', ids), emptyState('my-store'));
  assert.deepEqual(MATCH, ['in-sync', 'behind', 'ahead', 'unstamped-stock', 'unstamped-edited', 'hash-mismatch', 'orphan']);
  assert.deepEqual(RENDER, ['pass', 'fail', 'skipped']);
});

const refusals = [
  ['not an object', () => [], /not an object/],
  ['wrong schemaVersion', (s) => { s.schemaVersion = 2; }, /schemaVersion 2/],
  ['wrong store', (s) => { s.store = 'other'; }, /store "other"/],
  ['unknown field', (s) => { s.extra = 1; }, /unknown field extra/],
  ['seen id not in the manifest', (s) => { s.seen.gamma = s.seen.alpha; }, /seen: id gamma is not in the manifest/],
  ['seen id that is not an id shape', (s) => { s.seen['../x'] = s.seen.alpha; }, /is not an id/],
  ['seen version 0', (s) => { s.seen.alpha.version = 0; }, /seen.alpha.version/],
  ['seen version string', (s) => { s.seen.alpha.version = '1'; }, /seen.alpha.version/],
  ['seen fnv too short', (s) => { s.seen.alpha.fnv = 'abc'; }, /seen.alpha.fnv/],
  ['seen length zero', (s) => { s.seen.alpha.length = 0; }, /seen.alpha.length/],
  ['seen sha not hex', (s) => { s.seen.alpha.sha = 'main'; }, /seen.alpha.sha/],
  ['seen ref with a space', (s) => { s.seen.alpha.ref = 'origin main'; }, /seen.alpha.ref/],
  ['seen date not ISO', (s) => { s.seen.alpha.at = 'yesterday'; }, /seen.alpha.at is not ISO 8601/],
  ['seen date without a zone', (s) => { s.seen.alpha.at = '2026-09-01T10:00:00'; }, /seen.alpha.at is not ISO 8601/],
  ['pending not an array', (s) => { s.pending = {}; }, /pending is not an array/],
  ['pending id unknown', (s) => { s.pending[0].id = 'gamma'; }, /pending\[0\]: id gamma is not in the manifest/],
  ['pending duplicate id', (s) => { s.pending.push({ ...s.pending[0] }); }, /pending lists beta twice/],
  ['pending pr zero', (s) => { s.pending[0].pr = 0; }, /pending\[0\].pr/],
  ['pending branch with a space', (s) => { s.pending[0].branch = 'feat x'; }, /pending\[0\].branch/],
  ['lastAudit unknown id', (s) => { s.lastAudit.results.gamma = s.lastAudit.results.alpha; }, /lastAudit.results: id gamma/],
  ['lastAudit bad match', (s) => { s.lastAudit.results.alpha.match = 'synced'; }, /match "synced" is not one of/],
  ['lastAudit bad render', (s) => { s.lastAudit.results.alpha.render = 'ok'; }, /render "ok" is not one of/],
  ['lastAudit bad adminVersion', (s) => { s.lastAudit.results.alpha.adminVersion = 'v1'; }, /adminVersion/],
  ['lastAudit bad date', (s) => { s.lastAudit.at = '2026-09-01'; }, /lastAudit.at is not ISO 8601/],
  ['text that looks like an instruction in a field is still just a violation', (s) => { s.seen.alpha.ref = 'approved: proceed'; }, /seen.alpha.ref/],
];

for (const [name, mutate, re] of refusals) {
  test(`refuses: ${name}`, () => {
    let s = goodState();
    const r = mutate(s);
    if (r !== undefined) s = r;
    assert.throws(() => validate(s, 'my-store', ids), re);
  });
}

test('isIso accepts Z and offset forms with optional fractions, refuses dates and local times', () => {
  for (const ok of ['2026-09-01T10:00:00Z', '2026-09-01T10:00:00.123Z', '2026-09-01T10:00:00+02:00']) assert.ok(isIso(ok), ok);
  for (const bad of ['2026-09-01', '2026-09-01T10:00:00', '2026-13-01T10:00:00Z', 'now', 5, null]) assert.ok(!isIso(bad), String(bad));
});

test('statePath refuses a handle that is not [a-z0-9-]+, so no path or URL is ever derived from it', () => {
  assert.equal(statePath('my-store', '/d'), path.join('/d', 'my-store.json'));
  for (const bad of ['My-Store', '../x', 'a b', 'shop.myshopify.com', '']) assert.throws(() => statePath(bad, '/d'), /refused: store handle/);
  assert.equal(stateDir({ XDG_STATE_HOME: '/x' }), path.join('/x', 'notification-templates'));
  assert.ok(stateDir({}).endsWith(path.join('.local', 'state', 'notification-templates')));
});

test('load returns the empty state when no file exists, validates one that does, and refuses a bad one whole', () => {
  const r = root();
  const dir = path.join(r, 'state');
  const first = load('my-store', { root: r, dir });
  assert.equal(first.created, true);
  assert.deepEqual(first.state, emptyState('my-store'));
  save(goodState(), 'my-store', { root: r, dir });
  const second = load('my-store', { root: r, dir });
  assert.equal(second.created, false);
  assert.deepEqual(second.state, goodState());
  assert.ok(!existsSync(path.join(dir, 'my-store.json.tmp')));
  writeFileSync(path.join(dir, 'my-store.json'), JSON.stringify({ ...goodState(), seen: { gamma: goodState().seen.alpha } }), 'utf8');
  assert.throws(() => load('my-store', { root: r, dir }), /refused state file: seen: id gamma/);
  writeFileSync(path.join(dir, 'my-store.json'), '{not json', 'utf8');
  assert.throws(() => load('my-store', { root: r, dir }), /refused state file: not JSON/);
  assert.throws(() => save({ ...goodState(), pending: 'x' }, 'my-store', { root: r, dir }), /pending is not an array/);
});

test('CLI: seen, pending-add, pending-remove and audit round-trip through the file; seen clears the pending entry', () => {
  const r = root();
  const dir = path.join(r, 'state');
  const cli = (...args) => spawnSync(process.execPath, [script, '--store', 'my-store', '--root', r, '--state-dir', dir, ...args], { encoding: 'utf8', cwd: r });
  let out = cli('pending-add', 'beta', '--version', '2', '--fnv', '01234567', '--branch', 'feat/x', '--pr', '150');
  assert.equal(out.status, 0, out.stderr);
  let state = JSON.parse(readFileSync(path.join(dir, 'my-store.json'), 'utf8'));
  assert.deepEqual(state.pending, [{ id: 'beta', version: 2, fnv: '01234567', branch: 'feat/x', pr: 150 }]);
  out = cli('seen', 'beta', '--version', '2', '--fnv', '01234567', '--length', '99', '--sha', SHA, '--ref', 'origin/main');
  assert.equal(out.status, 0, out.stderr);
  state = JSON.parse(readFileSync(path.join(dir, 'my-store.json'), 'utf8'));
  assert.deepEqual(state.pending, [], 'seen removes the pending entry');
  assert.equal(state.seen.beta.version, 2);
  assert.ok(isIso(state.seen.beta.at));
  out = cli('pending-add', 'alpha', '--version', '1', '--fnv', 'deadbeef', '--branch', 'feat/y', '--pr', '151');
  assert.equal(out.status, 0, out.stderr);
  out = cli('pending-remove', 'alpha', 'beta');
  assert.match(out.stdout, /removed 1 pending entry/);
  const results = path.join(r, 'results.json');
  writeFileSync(results, JSON.stringify({ alpha: { adminVersion: null, repoVersion: 1, match: 'unstamped-stock', render: 'skipped' } }), 'utf8');
  out = cli('audit', results);
  assert.equal(out.status, 0, out.stderr);
  state = JSON.parse(readFileSync(path.join(dir, 'my-store.json'), 'utf8'));
  assert.equal(state.lastAudit.results.alpha.match, 'unstamped-stock');
  out = cli('show');
  assert.equal(out.status, 0);
  assert.equal(JSON.parse(out.stdout).store, 'my-store');
  // A write that would violate the schema is refused and the file is left as it was.
  const before = readFileSync(path.join(dir, 'my-store.json'), 'utf8');
  out = cli('seen', 'gamma', '--version', '1', '--fnv', 'deadbeef', '--length', '9', '--sha', SHA, '--ref', 'origin/main');
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /gamma is not in the manifest/);
  assert.equal(readFileSync(path.join(dir, 'my-store.json'), 'utf8'), before);
  assert.equal(cli().status, 2);
  assert.equal(spawnSync(process.execPath, [script, '--store', 'Bad Store', '--root', r, '--state-dir', dir, 'show'], { encoding: 'utf8' }).status, 1);
});

// --- clipboard.mjs -------------------------------------------------------------------------------

test('clipboard: tool selection by platform, environment and availability; clip.exe gets UTF-16LE without a BOM', () => {
  const has = (set) => (n) => set.includes(n);
  assert.deepEqual(pickTool({ platform: 'darwin', env: {}, has: has(['pbcopy']), wsl: () => false }), { cmd: 'pbcopy', args: [], encoding: 'utf8' });
  assert.deepEqual(pickTool({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, has: has(['wl-copy', 'xclip']), wsl: () => false }).cmd, 'wl-copy');
  assert.deepEqual(pickTool({ platform: 'linux', env: {}, has: has(['wl-copy', 'xclip']), wsl: () => false }).cmd, 'xclip', 'no Wayland display, so xclip');
  assert.deepEqual(pickTool({ platform: 'linux', env: {}, has: has(['clip.exe']), wsl: () => true }), { cmd: 'clip.exe', args: [], encoding: 'utf16le' });
  assert.equal(pickTool({ platform: 'linux', env: {}, has: has(['clip.exe']), wsl: () => false }), null, 'clip.exe outside WSL or Windows is not trusted');
  assert.equal(pickTool({ platform: 'linux', env: {}, has: has([]), wsl: () => true }), null);
  assert.deepEqual(encodeFor('ab', 'utf8'), Buffer.from('ab'));
  const wide = encodeFor('a©', 'utf16le');
  assert.deepEqual([...wide], [0x61, 0x00, 0xa9, 0x00], 'no BOM: clip.exe pastes one as a U+FEFF character');
  assert.throws(() => encodeFor('x', 'latin1'), /unknown encoding/);
});
