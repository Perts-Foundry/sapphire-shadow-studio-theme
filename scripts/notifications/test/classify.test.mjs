// scripts/notifications/classify.mjs applies the match table sync.md states, which decides which
// live templates get overwritten. The table is ordered and the first row that matches wins, so
// most of this suite is about the order and about what the classifier refuses to guess at.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fnv1a } from '../dump.mjs';
import { paths } from '../brand.mjs';
import { MATCH } from '../state.mjs';
import { classifyOne, classifyAll, parseObserved, repoFacts, formatTable, ClassifyError, PASTE_OVER } from '../classify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'classify.mjs');

const BRANDED = { alpha: 'branded alpha v2\n', beta: 'branded beta v1\n' };
const STOCK = { alpha: 'stock alpha\n', beta: 'stock beta\n' };
const VERSION = { alpha: 2, beta: 1 };
// The shape Admin actually returns: the id segment is the template handle. The numeric one below
// was the only shape any fixture used, which is how a numeric-only GID_RE shipped and refused all
// 46 ids on the first sync that read them.
const GID = 'gid://shopify/EmailTemplate/beta';
const NUMERIC_GID = 'gid://shopify/EmailTemplate/1234567890';

function root() {
  const r = mkdtempSync(path.join(tmpdir(), 'ssb-classify-'));
  const p = paths(r);
  mkdirSync(p.stockDir, { recursive: true });
  const templates = {};
  for (const id of Object.keys(BRANDED)) {
    templates[id] = { version: VERSION[id] };
    writeFileSync(p.branded(id), BRANDED[id], 'utf8');
    writeFileSync(p.stock(id), STOCK[id], 'utf8');
  }
  writeFileSync(p.manifest, JSON.stringify({ templates }), 'utf8');
  return r;
}

const of = (text) => ({ length: text.length, fnv: fnv1a(text) });
const observed = (text, stamp = null) => ({ ...of(text), stamp });
const facts = () => repoFacts(root());
const alpha = () => facts().get('alpha');

test('every row of the match table, in the order sync.md states them', () => {
  const cases = [
    ['in-sync', observed(BRANDED.alpha, { id: 'alpha', version: 2 })],
    ['behind', observed('older branded\n', { id: 'alpha', version: 1 })],
    ['ahead', observed('newer branded\n', { id: 'alpha', version: 3 })],
    ['hash-mismatch', observed('claims v2 but is not\n', { id: 'alpha', version: 2 })],
    ['orphan', observed('someone else document\n', { id: 'beta', version: 1 })],
    ['unstamped-stock', observed(STOCK.alpha)],
    ['unstamped-edited', observed('hand edited in Admin\n')],
  ];
  for (const [expected, o] of cases) assert.equal(classifyOne('alpha', o, alpha()).match, expected, expected);
  // The cases above are in sync.md's table order, which is the order the rows are tested in; MATCH
  // declares the same seven values in its own order. Every one is covered.
  assert.deepEqual([...cases.map(([m]) => m)].sort(), [...MATCH].sort(), 'the suite covers the whole enum');
});

test('the repo file wins over the stamp: bytes are the criterion, the version is informational', () => {
  // A git revert moves a version backwards by design, so a stamp reading below the manifest on a
  // document that IS the repo file must still be in-sync, never behind.
  const o = observed(BRANDED.alpha, { id: 'alpha', version: 1 });
  assert.equal(classifyOne('alpha', o, alpha()).match, 'in-sync');
  // And an unstamped document whose bytes are the repo file is in-sync too.
  assert.equal(classifyOne('alpha', observed(BRANDED.alpha), alpha()).match, 'in-sync');
});

test('the action follows the match, and only in-sync and ahead are left alone', () => {
  assert.equal(classifyOne('alpha', observed(BRANDED.alpha), alpha()).action, 'skip');
  assert.equal(classifyOne('alpha', observed('newer\n', { id: 'alpha', version: 9 }), alpha()).action, 'flag');
  for (const [text, stamp] of [[STOCK.alpha, null], ['edited\n', null], ['old\n', { id: 'alpha', version: 1 }]]) {
    const row = classifyOne('alpha', observed(text, stamp), alpha());
    assert.equal(row.action, 'paste', row.match);
    assert.ok(PASTE_OVER.includes(row.match));
  }
});

test('beforeSource says where the restore document comes from, and a stamped stock body is noted', () => {
  assert.equal(classifyOne('alpha', observed(STOCK.alpha), alpha()).beforeSource, 'stock');
  assert.equal(classifyOne('alpha', observed('edited\n'), alpha()).beforeSource, 'network');
  assert.equal(classifyOne('alpha', observed(BRANDED.alpha), alpha()).beforeSource, null, 'an in-sync id is never pasted, so it needs no restore source');
  // A foreign stamp on bytes that are this id's stock snapshot is a contradiction worth saying out
  // loud rather than classifying silently.
  const odd = classifyOne('alpha', observed(STOCK.alpha, { id: 'beta', version: 1 }), alpha());
  assert.equal(odd.match, 'orphan');
  assert.match(odd.note, /stamped beta v1 but the bytes are this id's stock snapshot/);
});

test('parseObserved accepts the TSV and both JSON shapes, and refuses anything it would have to guess at', () => {
  const tsv = `# a comment\nalpha\t${STOCK.alpha.length}\t${fnv1a(STOCK.alpha)}\tnone\nbeta\t5\t00000001\tbeta 3\t${GID}\n`;
  const rows = parseObserved(tsv);
  assert.deepEqual(rows[0], { id: 'alpha', length: STOCK.alpha.length, fnv: fnv1a(STOCK.alpha), stamp: null, gid: null });
  assert.deepEqual(rows[1].stamp, { id: 'beta', version: 3 });
  assert.equal(rows[1].gid, GID, 'the gid column is carried through');
  assert.deepEqual(parseObserved(`alpha\t9\tdeadbeef`)[0].stamp, null, 'a missing stamp column is none');
  assert.equal(parseObserved(`alpha\t9\tdeadbeef\tnone\t-`)[0].gid, null, 'a dash is no gid');
  assert.deepEqual(parseObserved(JSON.stringify([{ id: 'alpha', length: 9, fnv: 'deadbeef' }]))[0].id, 'alpha');
  assert.deepEqual(parseObserved(JSON.stringify({ alpha: { length: 9, fnv: 'deadbeef', stamp: 'alpha 2' } }))[0].stamp, { id: 'alpha', version: 2 });
  assert.equal(parseObserved(JSON.stringify([{ id: 'alpha', length: 9, fnv: 'deadbeef', gid: GID }]))[0].gid, GID);
  assert.equal(
    parseObserved(`alpha\t9\tdeadbeef\tnone\t${NUMERIC_GID}`)[0].gid,
    NUMERIC_GID,
    'a numeric id segment is still accepted',
  );
  const refusals = [
    ['alpha\t9', /needs at least id, length and fnv/],
    ['Alpha\t9\tdeadbeef', /is not an id/],
    ['alpha\t0\tdeadbeef', /length 0 is not a positive integer/],
    ['alpha\t9\tDEADBEEF', /is not eight lowercase hex digits/],
    ['alpha\t9\tdeadbee', /is not eight lowercase hex digits/],
    ['alpha\t9\tdeadbeef\talpha v2', /is not "<id> <version>" or "none"/],
    ['alpha\t9\tdeadbeef\talpha 0', /is not "<id> <version>" or "none"/],
    ['alpha\t9\tdeadbeef\tnone\tgid://shopify/Product/1', /is not gid:\/\/shopify\/EmailTemplate/],
    ['alpha\t9\tdeadbeef\tnone\t1234', /is not gid:\/\/shopify\/EmailTemplate/],
    // Concatenating two console dumps for one id is a documented workflow ("read once more"), and
    // last-write-wins would classify from one reading and never mention the other.
    [`alpha\t9\tdeadbeef\nalpha\t10\tdeadbeef`, /observed lists alpha twice; one reading per id/],
    ['[{"id": bad}]', /observed file is not JSON/],
  ];
  for (const [line, re] of refusals) assert.throws(() => parseObserved(line), re, line);
  for (const [line] of refusals) assert.throws(() => parseObserved(line), ClassifyError, line);
});

test('--paste-ahead promotes only the ids the operator named, and only when they are ahead', () => {
  const f = facts();
  const ahead = { id: 'alpha', ...of('newer than the repo\n'), stamp: { id: 'alpha', version: 9 } };
  const plain = classifyAll([ahead], f);
  assert.equal(plain.rows[0].action, 'flag', 'ahead is left alone by default');
  const promoted = classifyAll([ahead], f, { pasteAhead: ['alpha'] });
  assert.equal(promoted.rows[0].action, 'paste');
  assert.equal(promoted.rows[0].match, 'ahead', 'the classification does not change, only what is done about it');
  assert.match(promoted.rows[0].note, /operator named this id/);
  // Naming an id that is not ahead, or not in scope, is a mistake worth refusing rather than
  // quietly ignoring: the operator believes they authorised an overwrite.
  const inSync = [{ id: 'alpha', ...of(BRANDED.alpha), stamp: null }];
  assert.throws(() => classifyAll(inSync, f, { pasteAhead: ['alpha'] }), /--paste-ahead names alpha, which is not classified ahead/);
  assert.throws(() => classifyAll([ahead], f, { pasteAhead: ['beta'] }), /--paste-ahead names beta, which is not in scope/);
});

test('the live-save ceiling in the table follows the render-failure policy', () => {
  const f = facts();
  const { rows } = classifyAll([{ id: 'alpha', ...of(STOCK.alpha), stamp: null }, { id: 'beta', ...of(STOCK.beta), stamp: null }], f);
  assert.match(formatTable(rows), /2 live save\(s\) planned, up to 3: .*at most one restoring Save, after which --on-render-fail halt stops the run/);
  // Under quarantine the run does not stop, so every pasted id can cost a restoring Save too.
  assert.match(formatTable(rows, { onRenderFail: 'quarantine' }), /2 live save\(s\) planned, up to 4: .*one restoring Save for each id whose render fails/);
});

test('classifyAll refuses an id outside the manifest and reports one in scope with no reading', () => {
  const f = facts();
  assert.throws(() => classifyAll([{ id: 'gamma', length: 1, fnv: 'deadbeef', stamp: null }], f), ClassifyError);
  assert.throws(() => classifyAll([{ id: 'gamma', length: 1, fnv: 'deadbeef', stamp: null }], f), /not manifest ids: gamma/);
  const r = classifyAll([{ id: 'alpha', ...of(STOCK.alpha), stamp: null }], f, { ids: ['alpha', 'beta'] });
  assert.deepEqual(r.missing, ['beta'], 'an id in scope with no reading is never classified from the repo alone');
  assert.equal(r.rows.length, 1);
});

test('the table carries the numbers the STOP has to show, and counts the live saves', () => {
  const f = facts();
  const { rows } = classifyAll(
    [
      { id: 'alpha', ...of(STOCK.alpha), stamp: null },
      { id: 'beta', ...of(BRANDED.beta), stamp: { id: 'beta', version: 1 } },
    ],
    f,
  );
  const table = formatTable(rows);
  assert.match(table, /\| `alpha` \| unstamped-stock \| 12 [0-9a-f]{8} \| unstamped \| 17 [0-9a-f]{8} \| 2 \| stock \| paste \|/);
  assert.match(table, /\| `beta` \| in-sync \|.*\| 1 \| - \| skip \|/, 'an in-sync id needs no restore source');
  assert.match(table, /2 id\(s\): 1 unstamped-stock, 1 in-sync/);
  assert.match(table, /1 live save\(s\) planned/, 'the in-sync id is not a save');
});

test('CLI: the plan and the audit JSON come out of one classification', () => {
  const r = root();
  const p = paths(r);
  const obs = path.join(r, 'observed.tsv');
  writeFileSync(obs, `alpha\t${STOCK.alpha.length}\t${fnv1a(STOCK.alpha)}\nbeta\t${BRANDED.beta.length}\t${fnv1a(BRANDED.beta)}\tbeta 1\n`, 'utf8');
  const planPath = path.join(r, 'plan.json');
  const auditPath = path.join(r, 'audit.json');
  const out = spawnSync(process.execPath, [script, '--root', r, '--observed', obs, '--json', planPath, '--audit-json', auditPath], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  assert.deepEqual(plan.map((x) => [x.id, x.match, x.action]), [['alpha', 'unstamped-stock', 'paste'], ['beta', 'in-sync', 'skip']]);
  const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
  assert.deepEqual(audit.alpha, { adminVersion: null, repoVersion: 2, match: 'unstamped-stock', render: 'skipped' });
  assert.deepEqual(audit.beta, { adminVersion: 1, repoVersion: 1, match: 'in-sync', render: 'skipped' });
  assert.ok(readFileSync(p.manifest, 'utf8').length > 0, 'the classifier writes nothing into the checkout');

  // An id in scope with no reading fails the run rather than producing a table with a hole in it,
  // and it writes nothing: a plan.json left behind by a refused run is a file run-start accepts.
  const orphanPlan = path.join(r, 'orphan-plan.json');
  const orphanAudit = path.join(r, 'orphan-audit.json');
  const short = spawnSync(
    process.execPath,
    [script, '--root', r, '--observed', obs, '--ids', 'alpha', 'beta', 'gamma', '--json', orphanPlan, '--audit-json', orphanAudit],
    { encoding: 'utf8' },
  );
  assert.notEqual(short.status, 0);
  assert.match(short.stderr, /refused: no reading for 1 id\(s\) in scope: gamma/);
  assert.equal(existsSync(orphanPlan), false, 'a refused classification leaves no plan behind');
  assert.equal(existsSync(orphanAudit), false);

  // A list flag with no values is a typo. Read as "everything", a one-id request would come back
  // as the whole manifest and be approved as the answer to the question that was asked.
  for (const argv of [['--ids'], ['--ids', '--json', planPath], ['--paste-ahead']]) {
    const bare = spawnSync(process.execPath, [script, '--root', r, '--observed', obs, ...argv], { encoding: 'utf8' });
    assert.notEqual(bare.status, 0, argv.join(' '));
    assert.match(bare.stderr, /needs at least one id/);
  }
  const badPolicy = spawnSync(process.execPath, [script, '--root', r, '--observed', obs, '--on-render-fail', 'ignore'], { encoding: 'utf8' });
  assert.notEqual(badPolicy.status, 0);
  assert.match(badPolicy.stderr, /is not halt or quarantine/);
});

// The seam. classify's row shape is a contract with run-start and with before-doc, and it is the
// kind of contract that breaks silently: a renamed field reaches run-start as `undefined` and is
// caught only by validate() at the point of a live run, never by CI.
test('the plan classify writes is the plan run-start accepts, and before-doc agrees with its numbers', () => {
  const r = root();
  const stateDir = path.join(r, 'state');
  const obs = path.join(r, 'observed.tsv');
  writeFileSync(obs, `alpha\t${STOCK.alpha.length}\t${fnv1a(STOCK.alpha)}\nbeta\t${BRANDED.beta.length}\t${fnv1a(BRANDED.beta)}\tbeta 1\n`, 'utf8');
  const planPath = path.join(r, 'plan.json');
  const classified = spawnSync(process.execPath, [script, '--root', r, '--observed', obs, '--json', planPath], { encoding: 'utf8' });
  assert.equal(classified.status, 0, classified.stderr);

  const stateScript = path.join(here, '..', 'state.mjs');
  const started = spawnSync(
    process.execPath,
    [stateScript, '--store', 'my-store', '--root', r, '--state-dir', stateDir, 'run-start', planPath, '--ref', 'origin/main', '--sha', 'a'.repeat(40)],
    { encoding: 'utf8' },
  );
  assert.equal(started.status, 0, started.stderr);
  const run = JSON.parse(readFileSync(path.join(stateDir, 'my-store.json'), 'utf8')).run;
  assert.deepEqual(run.ids.map((e) => e.id), ['alpha'], 'the in-sync id is not a write, so it is not in the run');

  const planRow = JSON.parse(readFileSync(planPath, 'utf8')).find((x) => x.id === 'alpha');
  assert.deepEqual(run.ids[0].before, planRow.before, 'the approved numbers travel unchanged');
  assert.deepEqual(run.ids[0].after, planRow.after);
  assert.equal(run.ids[0].version, planRow.version);
  assert.equal(run.ids[0].beforeSource, planRow.beforeSource);

  // And the guarantee the beforeSource column is making: a `stock` row's approved before-numbers
  // are exactly what before-doc will find on disk, so step 3.2 cannot refuse on a healthy run.
  const beforeScript = path.join(here, '..', 'before-doc.mjs');
  const out = path.join(r, 'before-alpha.liquid');
  const doc = spawnSync(
    process.execPath,
    [beforeScript, '--root', r, '--from-stock', 'alpha', '--expect-length', String(run.ids[0].before.length), '--expect-fnv', run.ids[0].before.fnv, '--out', out],
    { encoding: 'utf8' },
  );
  assert.equal(doc.status, 0, doc.stderr);
  assert.equal(readFileSync(out, 'utf8'), STOCK.alpha);
});
