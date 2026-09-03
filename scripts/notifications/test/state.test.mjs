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
import { validate, load, save, emptyState, statePath, stateDir, isIso, nextId, MATCH, RENDER } from '../state.mjs';
import { paths } from '../brand.mjs';
import { hashFile, fnv1a } from '../dump.mjs';
import { pickTool, encodeFor, copy, readClipboard, verifyCopy, measure, main as clipboardMain, READERS } from '../clipboard.mjs';

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
    run: null,
  };
}

// Handle-shaped, which is what Admin returns; the numeric one is still accepted. See the note in
// classify.test.mjs: a numeric-only fixture is what let a numeric-only GID_RE ship.
const GID = 'gid://shopify/EmailTemplate/alpha';
const NUMERIC_GID = 'gid://shopify/EmailTemplate/1234567890';
const row = (id, beforeSource = 'stock') => ({ id, match: 'unstamped-stock', beforeSource, version: 1, gid: null, before: { length: 10, fnv: 'deadbeef' }, after: { length: 20, fnv: '01234567' } });

function goodRun() {
  return {
    startedAt: '2026-09-02T12:00:00Z',
    ref: 'origin/main',
    sha: SHA,
    onRenderFail: 'quarantine',
    batch: 10,
    ids: [row('alpha'), row('beta', 'network')],
    done: ['alpha'],
    quarantine: [],
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

// --- the run record ------------------------------------------------------------------------------
// `run` is the approved plan of a sync in flight. It is what lets a run survive a compaction or a
// new session, so it is validated as strictly as the rest of the file: an id from it is pasted
// over on a live store.

test('the run record validates when well-formed, and a file written before it existed still loads', () => {
  const withRun = { ...goodState(), run: goodRun() };
  assert.deepEqual(validate(withRun, 'my-store', ids), withRun);
  const older = goodState();
  delete older.run;
  assert.deepEqual(validate(older, 'my-store', ids).run, null, 'a missing run is the same as no run in flight');
});

const runRefusals = [
  ['run not an object', (r) => 'x', /run is not an object or null/],
  ['run unknown field', (r) => ({ ...r, cursor: 3 }), /unknown field run.cursor/],
  ['run startedAt not ISO', (r) => ({ ...r, startedAt: 'yesterday' }), /run.startedAt is not ISO 8601/],
  ['run ref with a space', (r) => ({ ...r, ref: 'origin main' }), /run.ref is not a ref name/],
  ['run sha not hex', (r) => ({ ...r, sha: 'zzzz' }), /run.sha is not a git sha/],
  ['run onRenderFail unknown', (r) => ({ ...r, onRenderFail: 'ignore' }), /run.onRenderFail "ignore" is not one of halt, quarantine/],
  ['run batch zero', (r) => ({ ...r, batch: 0 }), /run.batch is not null or a positive integer/],
  ['run ids empty', (r) => ({ ...r, ids: [], done: [], quarantine: [] }), /run.ids is not a non-empty array/],
  ['run ids duplicated', (r) => ({ ...r, ids: [row('alpha'), row('alpha')], done: [] }), /run.ids lists alpha twice/],
  ['run ids not in the manifest', (r) => ({ ...r, ids: [row('gamma')], done: [] }), /run.ids\[0\]: id gamma is not in the manifest/],
  ['run ids entry not an object', (r) => ({ ...r, ids: ['alpha'], done: [] }), /run.ids\[0\] is not an object/],
  ['run ids unknown field', (r) => ({ ...r, ids: [{ ...row('alpha'), cursor: 1 }], done: [] }), /unknown field run.ids\[0\].cursor/],
  ['run ids bad match', (r) => ({ ...r, ids: [{ ...row('alpha'), match: 'maybe' }], done: [] }), /run.ids\[0\].match "maybe" is not one of/],
  ['run ids bad beforeSource', (r) => ({ ...r, ids: [{ ...row('alpha'), beforeSource: 'console' }], done: [] }), /run.ids\[0\].beforeSource "console" is not stock or network/],
  ['run ids version zero', (r) => ({ ...r, ids: [{ ...row('alpha'), version: 0 }], done: [] }), /run.ids\[0\].version is not an integer >= 1/],
  ['run ids bad gid', (r) => ({ ...r, ids: [{ ...row('alpha'), gid: 'gid://shopify/Product/1' }], done: [] }), /run.ids\[0\].gid is not null or gid:/],
  ['run ids missing before', (r) => ({ ...r, ids: [{ ...row('alpha'), before: undefined }], done: [] }), /run.ids\[0\].before is not an object/],
  ['run ids unknown numbers field', (r) => ({ ...r, ids: [{ ...row('alpha'), after: { length: 5, fnv: 'deadbeef', source: 'x' } }], done: [] }), /unknown field run.ids\[0\].after.source/],
  ['run done not an array', (r) => ({ ...r, done: 'alpha' }), /run.done is not an array/],
  ['run quarantine not an array', (r) => ({ ...r, quarantine: {} }), /run.quarantine is not an array/],
  ['run quarantine verifier too long', (r) => ({ ...r, quarantine: [{ id: 'beta', at: '2026-09-02T12:00:00Z', verifier: 'x'.repeat(20001) }] }), /run.quarantine\[0\].verifier is longer than 20000 characters/],
  ['run ids before length zero', (r) => ({ ...r, ids: [{ ...row('alpha'), before: { length: 0, fnv: 'deadbeef' } }], done: [] }), /run.ids\[0\].before.length is not a positive integer/],
  ['run ids after fnv short', (r) => ({ ...r, ids: [{ ...row('alpha'), after: { length: 5, fnv: 'dead' } }], done: [] }), /run.ids\[0\].after.fnv is not eight hex digits/],
  ['run done outside ids', (r) => ({ ...r, ids: [row('beta')], done: ['alpha'] }), /run.done lists alpha, which is not in run.ids/],
  ['run done duplicated', (r) => ({ ...r, done: ['alpha', 'alpha'] }), /run.done lists alpha twice/],
  ['run quarantine unknown field', (r) => ({ ...r, quarantine: [{ id: 'beta', at: '2026-09-02T12:00:00Z', verifier: 'FAIL', why: 'x' }] }), /unknown field run.quarantine\[0\].why/],
  ['run quarantine outside ids', (r) => ({ ...r, ids: [row('alpha')], done: ['alpha'], quarantine: [{ id: 'beta', at: '2026-09-02T12:00:00Z', verifier: 'FAIL' }] }), /run.quarantine\[0\] names beta, which is not in run.ids/],
  ['run quarantine duplicated', (r) => ({ ...r, quarantine: [{ id: 'beta', at: '2026-09-02T12:00:00Z', verifier: 'FAIL' }, { id: 'beta', at: '2026-09-02T12:00:00Z', verifier: 'FAIL' }] }), /run.quarantine lists beta twice/],
  ['run id both done and quarantined', (r) => ({ ...r, quarantine: [{ id: 'alpha', at: '2026-09-02T12:00:00Z', verifier: 'FAIL' }] }), /alpha is both done and quarantined/],
  ['run quarantine at not ISO', (r) => ({ ...r, quarantine: [{ id: 'beta', at: 'today', verifier: 'FAIL' }] }), /run.quarantine\[0\].at is not ISO 8601/],
  ['run quarantine verifier empty', (r) => ({ ...r, quarantine: [{ id: 'beta', at: '2026-09-02T12:00:00Z', verifier: '  ' }] }), /run.quarantine\[0\].verifier is empty/],
];

for (const [name, mutate, re] of runRefusals) {
  test(`refuses: ${name}`, () => {
    assert.throws(() => validate({ ...goodState(), run: mutate(goodRun()) }, 'my-store', ids), re);
  });
}

test('a run row may carry a gid, and batch may be null', () => {
  const withGid = { ...goodState(), run: { ...goodRun(), batch: null, ids: [{ ...row('alpha'), gid: GID }, row('beta', 'network')] } };
  assert.deepEqual(validate(withGid, 'my-store', ids), withGid);
  const numeric = { ...goodState(), run: { ...goodRun(), ids: [{ ...row('alpha'), gid: NUMERIC_GID }, row('beta', 'network')] } };
  assert.deepEqual(validate(numeric, 'my-store', ids), numeric, 'a numeric id segment is still accepted');
});

test('nextId is the first id that is neither done nor quarantined', () => {
  assert.equal(nextId(null), null);
  assert.equal(nextId(goodRun()), 'beta', 'alpha is done');
  assert.equal(nextId({ ...goodRun(), done: [], quarantine: [{ id: 'alpha', at: '2026-09-02T12:00:00Z', verifier: 'FAIL' }] }), 'beta');
  assert.equal(nextId({ ...goodRun(), done: ['alpha', 'beta'] }), null, 'nothing left');
});

test('CLI: a run round-trips, seen advances it, and a second run-start is refused without --force', () => {
  const r = root();
  const dir = path.join(r, 'state');
  const cli = (...args) => spawnSync(process.execPath, [script, '--store', 'my-store', '--root', r, '--state-dir', dir, ...args], { encoding: 'utf8', cwd: r });

  // The plan file is classify.mjs --json output: rows carrying an action, so a skip row is not a
  // write and never enters the run.
  const pasted = path.join(r, 'alpha.liquid');
  writeFileSync(pasted, 'branded alpha\n', 'utf8');
  const after = hashFile(pasted);
  const plan = path.join(r, 'plan.json');
  const planRows = [
    { ...row('alpha'), action: 'paste', after: { length: after.length, fnv: after.hash } },
    { ...row('beta', 'network'), action: 'paste' },
    { ...row('gamma'), action: 'skip' },
  ];
  writeFileSync(plan, JSON.stringify(planRows), 'utf8');
  let out = cli('run-start', plan, '--ref', 'origin/main', '--sha', SHA, '--on-render-fail', 'quarantine', '--batch', '10');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /run started: 2 id\(s\).*on-render-fail quarantine, next alpha/, 'the skip row is not part of the run');
  const started = JSON.parse(readFileSync(path.join(dir, 'my-store.json'), 'utf8'));
  assert.deepEqual(started.run.ids.map((e) => e.id), ['alpha', 'beta']);
  assert.deepEqual(started.run.ids[0].before, { length: 10, fnv: 'deadbeef' }, 'the approved before-numbers travel with the run');

  // A `seen` write finishes an id, so it advances the run without a second call, and --from-file
  // derives the version, length and fnv rather than having them retyped.
  out = cli('seen', 'alpha', '--from-file', pasted);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /run 1\/2/);
  let state = JSON.parse(readFileSync(path.join(dir, 'my-store.json'), 'utf8'));
  assert.equal(state.seen.alpha.length, after.length);
  assert.equal(state.seen.alpha.fnv, after.hash);
  assert.equal(state.seen.alpha.version, 1, 'the version comes from the approved row, not from whatever manifest this runs against');
  assert.equal(state.seen.alpha.sha, SHA, 'the sha and ref default to the run in flight');
  assert.equal(state.seen.alpha.ref, 'origin/main');
  assert.deepEqual(state.run.done, ['alpha']);

  const verifier = path.join(r, 'verifier.txt');
  writeFileSync(verifier, 'FAIL page-colour: <body> is #ffffff\n', 'utf8');
  out = cli('run-quarantine', 'beta', verifier);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /beta: quarantined .* next null/);
  out = cli('run-show');
  const shown = JSON.parse(out.stdout);
  assert.equal(shown.next, null);
  assert.deepEqual(shown.remaining, []);
  assert.match(shown.quarantine[0].verifier, /page-colour/, 'the verifier output is kept verbatim for the report');

  out = cli('run-start', plan, '--ref', 'origin/main', '--sha', SHA);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /still in flight \(1\/2 done, 1 quarantined\)/);
  // --force is allowed, but it names the record it is about to destroy: the quarantine list is the
  // only account of which ids failed and why.
  out = cli('run-start', plan, '--ref', 'origin/main', '--sha', SHA, '--force');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /--force replaces the run .*1 done, 1 quarantined \(beta\).*That record is discarded/s);

  assert.match(cli('run-end', '--reason', 'halt').stdout, /run ended \(halt\)/);
  state = JSON.parse(readFileSync(path.join(dir, 'my-store.json'), 'utf8'));
  assert.equal(state.run, null);
  assert.match(cli('run-show').stdout, /no run in flight/);
});

test('CLI: seen --from-file refuses a file that is not what the run approved for that id', () => {
  const r = root();
  const dir = path.join(r, 'state');
  const cli = (...args) => spawnSync(process.execPath, [script, '--store', 'my-store', '--root', r, '--state-dir', dir, ...args], { encoding: 'utf8', cwd: r });
  const alpha = path.join(r, 'alpha.liquid');
  const beta = path.join(r, 'beta.liquid');
  writeFileSync(alpha, 'branded alpha\n', 'utf8');
  writeFileSync(beta, 'a different template entirely\n', 'utf8');
  const after = hashFile(alpha);
  const plan = path.join(r, 'plan.json');
  writeFileSync(plan, JSON.stringify([{ ...row('alpha'), action: 'paste', after: { length: after.length, fnv: after.hash } }]), 'utf8');
  assert.equal(cli('run-start', plan, '--ref', 'origin/main', '--sha', SHA).status, 0);

  // The flag exists to remove hand-typed values, and it leaves exactly one: the path. Unchecked,
  // that path records another template's bytes under this id and marks it done.
  const out = cli('seen', 'alpha', '--from-file', beta);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /but the run approved \d+ [0-9a-f]{8} for alpha/);
  assert.match(out.stderr, /nothing recorded/);
  const state = JSON.parse(readFileSync(path.join(dir, 'my-store.json'), 'utf8'));
  assert.equal(state.seen.alpha, undefined, 'nothing is recorded');
  assert.deepEqual(state.run.done, [], 'and the run is not advanced');

  assert.equal(cli('seen', 'alpha', '--from-file', alpha).status, 0, 'the approved file is accepted');
});

test('CLI: every refusal is one sentence and exit 1, never a stack trace', () => {
  const r = root();
  const dir = path.join(r, 'state');
  const cli = (...args) => spawnSync(process.execPath, [script, '--store', 'my-store', '--root', r, '--state-dir', dir, ...args], { encoding: 'utf8', cwd: r });
  const plan = path.join(r, 'plan.json');
  const verifier = path.join(r, 'v.txt');
  writeFileSync(verifier, 'FAIL something\n', 'utf8');

  const cases = [
    // A plan row that is not classify.mjs output. Feeding run-show's own rows back in used to
    // resurrect the done and quarantined ids as fresh pastes, because they carry no action.
    [[{ id: 'alpha' }], ['run-start', plan, '--ref', 'origin/main', '--sha', SHA], /has action undefined; expected paste, skip or flag/],
    [[{ id: 'alpha', action: 'paste' }], ['run-start', plan, '--ref', 'origin/main', '--sha', SHA], /plan row 0 \(alpha\) has no match/],
    [[{ ...row('alpha'), action: 'paste', before: undefined }], ['run-start', plan, '--ref', 'origin/main', '--sha', SHA], /has no before numbers/],
    [[{ ...row('alpha'), action: 'skip' }], ['run-start', plan, '--ref', 'origin/main', '--sha', SHA], /no row whose action is paste/],
    [[{ ...row('alpha'), action: 'paste' }], ['run-start', plan], /refused state file: run.ref is not a ref name/],
  ];
  for (const [rows, argv, re] of cases) {
    writeFileSync(plan, JSON.stringify(rows), 'utf8');
    const out = cli(...argv);
    assert.equal(out.status, 1, argv.join(' '));
    assert.match(out.stderr, re, argv.join(' '));
    assert.ok(!/\n\s+at /.test(out.stderr), `stack trace leaked for ${argv.join(' ')}: ${out.stderr}`);
  }

  assert.match(cli('seen', 'alpha').stderr, /seen needs --from-file, or all of --version, --fnv and --length/);
  assert.match(cli('run-quarantine', 'alpha', verifier).stderr, /no run is in flight/);
  assert.match(cli('run-end', '--reason', 'maybe').stderr, /--reason "maybe" is not done or halt/);

  // An id that is in the run but already done cannot also be quarantined: validate() refuses that
  // state, and the command says so before it writes rather than after.
  writeFileSync(plan, JSON.stringify([{ ...row('alpha'), action: 'paste' }]), 'utf8');
  assert.equal(cli('run-start', plan, '--ref', 'origin/main', '--sha', SHA).status, 0);
  assert.equal(cli('seen', 'alpha', '--version', '1', '--fnv', 'deadbeef', '--length', '9').status, 0);
  const both = cli('run-quarantine', 'alpha', verifier);
  assert.equal(both.status, 1);
  assert.match(both.stderr, /already recorded done/);
  assert.ok(!/\n\s+at /.test(both.stderr));
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

// The read-back. A copy that does not land used to surface three tool calls later as a byte-gate
// failure in the browser, which halted a sync run with 16 ids unattempted.

const TOOL = { cmd: 'clip.exe', args: [], encoding: 'utf16le' };
// A reader stub. `outs` are the successive results: a string is a successful read, an object is a
// failure, and the shapes below are real spawnSync ones, not convenient approximations. On a spawn
// error node returns status/stdout/signal all null with `error` set; on a signal kill it returns
// status null with `signal`. Both are what the guards in readClipboard are written against.
const SPAWN_ERROR = (message, code = 'ENOENT') => ({ error: Object.assign(new Error(message), { code }), status: null, signal: null, stdout: null, stderr: null });
const SPAWN_KILLED = { status: null, signal: 'SIGKILL', stdout: Buffer.from(''), stderr: Buffer.from('') };
const SPAWN_EXIT = (status, stderr = '') => ({ status, signal: null, stdout: Buffer.from(''), stderr: Buffer.from(stderr) });
const reader = (outs) => {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const next = outs[Math.min(calls.length - 1, outs.length - 1)];
    if (typeof next !== 'string') return next;
    return { status: 0, signal: null, stdout: Buffer.from(next, 'utf8'), stderr: Buffer.from('') };
  };
  return { run, calls };
};

test('every clipboard tool has a read-back reader, and each addresses the same selection it wrote', () => {
  for (const cmd of ['pbcopy', 'wl-copy', 'xclip', 'clip.exe']) {
    assert.ok(READERS[cmd], `no reader for ${cmd}`);
    assert.equal(typeof READERS[cmd].cmd, 'string');
    assert.ok(Array.isArray(READERS[cmd].args));
  }
  assert.deepEqual(READERS['wl-copy'].args, ['-n'], 'wl-paste appends a newline without -n');
  assert.deepEqual(READERS.xclip.args, ['-selection', 'clipboard', '-o'], 'the same selection xclip wrote');
  assert.match(READERS['clip.exe'].args.at(-1), /Get-Clipboard -Raw/, '-Raw, or PowerShell returns an array of lines');
});

test('readClipboard spawns the reader exactly as READERS declares it, with room for a big template', () => {
  const { run, calls } = reader(['x']);
  readClipboard(TOOL, { run, has: () => true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, READERS['clip.exe'].cmd);
  assert.deepEqual(calls[0].args, READERS['clip.exe'].args, 'dropping the args makes PowerShell read nothing and xclip print usage');
  assert.ok(calls[0].opts.maxBuffer >= 1 << 26, 'the largest template is 166 KB and grows; a default maxBuffer would truncate it into a false mismatch');
});

test('readClipboard normalises the line endings Windows hands back, and touches nothing else', () => {
  const { run, calls } = reader(['a\r\nb\r\n']);
  const r = readClipboard(TOOL, { run, has: () => true });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'a\nb\n');
  assert.equal(r.reader, 'powershell.exe');
  assert.equal(calls.length, 1);
  assert.equal(readClipboard(TOOL, { run: reader(['a\rb']).run, has: () => true }).text, 'a\nb', 'a lone CR folds too, exactly as hashFile does');
  // No trimming, no BOM stripping: both would hide the defect this exists to catch.
  assert.equal(readClipboard(TOOL, { run: reader(['﻿x  ']).run, has: () => true }).text, '﻿x  ');
  // A reader that produced nothing at all, which spawnSync can report as a null stdout.
  assert.equal(readClipboard(TOOL, { run: reader([{ status: 0, signal: null, stdout: null, stderr: null }]).run, has: () => true }).text, '');
});

test('readClipboard reports a missing reader, a spawn error, a signal and a non-zero exit differently', () => {
  const missing = readClipboard(TOOL, { run: () => assert.fail('must not run'), has: () => false });
  assert.deepEqual(missing, { available: false, why: 'powershell.exe is not on PATH' });
  const unknown = readClipboard({ cmd: 'nope', args: [], encoding: 'utf8' }, { run: () => assert.fail('must not run'), has: () => true });
  assert.equal(unknown.available, false);
  assert.match(unknown.why, /no read-back reader is defined for nope/);
  const failed = readClipboard(TOOL, { run: reader([SPAWN_EXIT(5, 'boom')]).run, has: () => true });
  assert.deepEqual([failed.available, failed.ok], [true, false]);
  assert.match(failed.why, /powershell\.exe exited 5: boom/);
  // `has` is an existsSync probe, so it passes for a file that is not executable; the spawn error
  // is the only thing that catches that, and it arrives through `error`, never through `status`.
  const spawnErr = readClipboard(TOOL, { run: reader([SPAWN_ERROR('spawn powershell.exe EACCES', 'EACCES')]).run, has: () => true });
  assert.deepEqual([spawnErr.available, spawnErr.ok], [true, false]);
  assert.match(spawnErr.why, /powershell\.exe: spawn powershell\.exe EACCES/);
  const killed = readClipboard(TOOL, { run: reader([SPAWN_KILLED]).run, has: () => true });
  assert.equal(killed.ok, false, 'status null is not status 0');
  assert.match(killed.why, /exited null/);
});

test('copy throws on a spawn error and on a non-zero exit, and never silently succeeds', () => {
  const written = [];
  const ok = (cmd, args, opts) => {
    written.push({ cmd, args, input: opts.input });
    return { status: 0, signal: null, stdout: Buffer.from(''), stderr: Buffer.from('') };
  };
  copy('a©', TOOL, ok);
  assert.deepEqual(written[0], { cmd: 'clip.exe', args: [], input: Buffer.from([0x61, 0x00, 0xa9, 0x00]) });
  assert.throws(() => copy('x', TOOL, reader([SPAWN_ERROR('spawn clip.exe ENOENT')]).run), /spawn clip\.exe ENOENT/);
  assert.throws(() => copy('x', TOOL, reader([SPAWN_EXIT(1, 'clipboard busy')]).run), /clip\.exe exited 1: clipboard busy/);
});

test('measure is dump.mjs\'s definition, so the printed pair is the one --hash and SSSPOLL report', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ssb-measure-'));
  const file = path.join(dir, 'body.liquid');
  const text = 'a body\nwith lines\nand a © in it\n';
  writeFileSync(file, text, 'utf8');
  assert.deepEqual(measure(text), hashFile(file), 'clipboard.mjs and dump.mjs --hash must not drift');
  assert.deepEqual(measure(text), { length: text.length, hash: fnv1a(text) });
});

test('verifyCopy: a match ends it, a single bad read is retried, and a repeat is believed', () => {
  const text = 'line one\nline two\n';
  const expected = { length: text.length, hash: fnv1a(text) };
  assert.deepEqual(measure(text), expected);

  const good = reader([text.replace(/\n/g, '\r\n')]);
  assert.deepEqual(verifyCopy(text, TOOL, { run: good.run, has: () => true }), { status: 'verified', expected, actual: expected, reads: 1 });
  assert.equal(good.calls.length, 1, 'a match is not read twice');

  // One empty read has been seen on a cold WSL interop call; the second read decides.
  const flaky = reader(['', text]);
  assert.equal(verifyCopy(text, TOOL, { run: flaky.run, has: () => true }).status, 'verified');
  assert.equal(flaky.calls.length, 2);

  const stale = reader(['something else entirely']);
  const bad = verifyCopy(text, TOOL, { run: stale.run, has: () => true });
  assert.equal(bad.status, 'mismatch');
  assert.equal(bad.reads, 2, 'a mismatch is taken twice before it is believed');
  assert.deepEqual(bad.actual, measure('something else entirely'));
  assert.deepEqual(bad.expected, expected);

  // The U+FEFF the first sync run pasted: one character too many, and the read-back sees it now.
  const bom = verifyCopy(text, TOOL, { run: reader(['﻿' + text]).run, has: () => true });
  assert.equal(bom.status, 'mismatch');
  assert.equal(bom.actual.length, text.length + 1);

  assert.equal(verifyCopy(text, TOOL, { run: () => assert.fail('must not run'), has: () => false }).status, 'unavailable');
  assert.equal(verifyCopy(text, TOOL, { run: reader([SPAWN_EXIT(1, 'no display')]).run, has: () => true }).status, 'error');
  // The two mixed sequences: whichever the SECOND read was is what gets reported, because that is
  // the read that was believed.
  assert.equal(verifyCopy(text, TOOL, { run: reader(['wrong', SPAWN_EXIT(1, 'gone')]).run, has: () => true }).status, 'error');
  assert.equal(verifyCopy(text, TOOL, { run: reader([SPAWN_EXIT(1, 'gone'), 'wrong']).run, has: () => true }).status, 'mismatch');
  // An unavailable reader stops immediately: there is nothing to retry.
  const never = reader(['whatever']);
  assert.equal(verifyCopy(text, TOOL, { run: never.run, has: () => false }).status, 'unavailable');
  assert.equal(never.calls.length, 0);
});

test('the clipboard CLI reports all four outcomes with the right exit code', () => {
  const text = 'a body\n';
  const { length, hash } = measure(text);
  const cli = (result, extra = {}) => {
    const out = [];
    const errs = [];
    const code = clipboardMain(['node', 'clipboard.mjs', 'body.liquid'], {
      pick: () => TOOL,
      read: () => text,
      write: () => {},
      verify: () => result,
      log: (m) => out.push(m),
      fail: (m) => errs.push(m),
      ...extra,
    });
    return { code, out: out.join('\n'), errs: errs.join('\n') };
  };

  const verified = cli({ status: 'verified', reads: 1, expected: { length, hash }, actual: { length, hash } });
  assert.equal(verified.code, 0);
  assert.equal(verified.out, `copied ${length} chars to the clipboard via clip.exe (${length} ${hash}); read-back verified`);
  assert.equal(verified.errs, '');
  assert.match(cli({ status: 'verified', reads: 2, expected: {}, actual: {} }).out, /read-back verified on read 2$/);

  const unavailable = cli({ status: 'unavailable', why: 'pbpaste is not on PATH' });
  assert.equal(unavailable.code, 0, 'a missing reader leaves the copy unverified, not failed');
  assert.match(unavailable.out, /read-back NOT verified: pbpaste is not on PATH\. The browser byte check is the only gate on this paste\.$/);

  const mismatch = cli({ status: 'mismatch', reads: 2, expected: { length, hash }, actual: { length: 3, hash: 'deadbeef' } });
  assert.equal(mismatch.code, 1);
  assert.equal(mismatch.out, '', 'a failure says nothing on stdout');
  assert.match(mismatch.errs, /read-back mismatch after 2 attempt\(s\): the clipboard holds 3 deadbeef, the file is \d+ [0-9a-f]{8}\. Do not paste; run this command again\./);

  const errored = cli({ status: 'error', reads: 2, why: 'powershell.exe exited 1: nope' });
  assert.equal(errored.code, 1);
  assert.match(errored.errs, /read-back failed after 2 attempt\(s\): powershell\.exe exited 1: nope/);

  // --no-verify short-circuits before the reader is consulted at all.
  const skippedOut = [];
  assert.equal(clipboardMain(['node', 'clipboard.mjs', 'body.liquid', '--no-verify'], {
    pick: () => TOOL, read: () => text, write: () => {}, verify: () => assert.fail('must not verify'), log: (m) => skippedOut.push(m), fail: () => {},
  }), 0);
  assert.match(skippedOut.join(''), /read-back skipped \(--no-verify\)$/);
});

test('the clipboard CLI refuses every bad input in one sentence, never a stack trace', () => {
  const cases = [
    [['node', 'clipboard.mjs'], 2, /^usage: clipboard\.mjs <file> \[--no-verify\]$/, {}],
    [['node', 'clipboard.mjs', 'a', 'b'], 2, /^usage:/, {}],
    [['node', 'clipboard.mjs', 'a', '--nope'], 2, /^usage:/, {}],
    [['node', 'clipboard.mjs', '-x'], 2, /^usage:/, {}],
    [['node', 'clipboard.mjs', 'gone.liquid'], 1, /^cannot read gone\.liquid: no such file$/, { read: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } }],
    [['node', 'clipboard.mjs', 'crlf.liquid'], 1, /carriage return/, { read: () => 'a\r\nb\n' }],
    [['node', 'clipboard.mjs', 'a.liquid'], 1, /^no clipboard tool found:/, { pick: () => null }],
    [['node', 'clipboard.mjs', 'a.liquid'], 1, /^copy failed: clip\.exe exited 1: busy$/, { write: () => { throw new Error('clip.exe exited 1: busy'); } }],
  ];
  for (const [argv, code, pattern, extra] of cases) {
    const errs = [];
    const actual = clipboardMain(argv, {
      pick: () => TOOL, read: () => 'ok\n', write: () => {}, verify: () => ({ status: 'verified', reads: 1 }), log: () => {}, fail: (m) => errs.push(m), ...extra,
    });
    assert.equal(actual, code, `${argv.slice(2).join(' ')}: expected exit ${code}, got ${actual}`);
    assert.match(errs.join('\n'), pattern);
    assert.ok(!/\n\s+at /.test(errs.join('\n')), `${argv.slice(2).join(' ')}: no stack trace`);
  }
});

test('clipboard as a real subprocess: the module wiring holds, not just the injected one', () => {
  const clip = path.join(here, '..', 'clipboard.mjs');
  const cli = (...args) => spawnSync(process.execPath, [clip, ...args], { encoding: 'utf8' });
  assert.equal(cli().status, 2);
  assert.match(cli().stderr, /usage: clipboard\.mjs <file> \[--no-verify\]/);
  const dir = mkdtempSync(path.join(tmpdir(), 'ssb-clip-'));
  const crlf = path.join(dir, 'crlf.liquid');
  writeFileSync(crlf, 'a\r\nb\n', 'utf8');
  const refused = cli(crlf);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /carriage return/);
  assert.ok(!/\n\s+at /.test(refused.stderr));
  // No clipboard tool is available in CI, so this exercises the real pickTool path either way:
  // exit 1 with the install message there, and a real copy plus read-back on a workstation.
  const real = cli(path.join(here, 'fixtures', 'minimal.branded.liquid'));
  assert.ok([0, 1].includes(real.status), real.stderr);
  if (real.status === 1) assert.match(real.stderr, /no clipboard tool found:/);
  else assert.match(real.stdout, /^copied \d+ chars to the clipboard via \S+ \(\d+ [0-9a-f]{8}\); read-back (verified|NOT verified)/);
});
