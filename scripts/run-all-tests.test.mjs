import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT,
  NOT_A_SUITE,
  discoverSuites,
  parseNodeTestOutput,
  formatLine,
  rollUp,
  parseArgs,
  runSuite,
} from './run-all-tests.mjs';

const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

test('every :test script in package.json is covered by the roll-up', () => {
  // The point of the whole runner. If a suite can exist in package.json and not appear here, the
  // roll-up reports green over an area nobody ran.
  const declared = Object.keys(pkg.scripts).filter((k) => k.endsWith(':test'));
  const discovered = discoverSuites(pkg.scripts);
  const missed = declared.filter((k) => !discovered.includes(k) && !NOT_A_SUITE.has(k));
  assert.deepEqual(missed, [], `these :test scripts would never run: ${missed.join(', ')}`);
  assert.ok(discovered.length >= 10, `only ${discovered.length} suites discovered; the list looks truncated`);
});

test('test:all is wired to this runner', () => {
  // A `test:all` that shells out to something else would make the coverage assertion above a lie.
  assert.match(pkg.scripts['test:all'] ?? '', /run-all-tests\.mjs/);
});

test('the runner never tries to run itself', () => {
  assert.equal(discoverSuites({ 'test:all': 'x', 'a:test': 'y' }).includes('test:all'), false);
});

test('a coverage script is not mistaken for a suite', () => {
  assert.deepEqual(discoverSuites({ 'policies:test': 'a', 'policies:coverage': 'b' }), ['policies:test']);
});

test('discovery keeps package.json order', () => {
  assert.deepEqual(discoverSuites({ 'z:test': '', 'a:test': '', 'm:test': '' }), ['z:test', 'a:test', 'm:test']);
});

test('the TAP summary block parses', () => {
  const counts = parseNodeTestOutput(['# tests 12', '# pass 10', '# fail 1', '# skipped 1', '# todo 0'].join('\n'));
  assert.deepEqual(counts, { tests: 12, pass: 10, fail: 1, skipped: 1, todo: 0 });
});

test('the spec-reporter summary block parses too', () => {
  const counts = parseNodeTestOutput(['ℹ tests 3', 'ℹ pass 3', 'ℹ fail 0'].join('\n'));
  assert.deepEqual(counts, { tests: 3, pass: 3, fail: 0, skipped: 0, todo: 0 });
});

test('a run with no summary block parses as null rather than as zero failures', () => {
  // A suite that dies on import prints a stack and no summary. Reading that as `fail 0` is how a
  // crashed area reports clean.
  assert.equal(parseNodeTestOutput('Error: Cannot find module ./nope.mjs'), null);
});

test('the last summary block wins', () => {
  // A suite that spawns a child under test prints the child's summary first.
  const text = ['# pass 1', '# fail 0', 'some middle output', '# pass 40', '# fail 2'].join('\n');
  assert.deepEqual(parseNodeTestOutput(text).pass, 40);
  assert.deepEqual(parseNodeTestOutput(text).fail, 2);
});

test('the verdict comes from the exit code, not from the counts', () => {
  // The case this guards: an uncaught exception after the last test. Counts read clean, exit is 1.
  const line = formatLine({ name: 'a:test', code: 1, counts: { pass: 9, fail: 0, skipped: 0, todo: 0 }, ms: 1000 });
  assert.match(line, /^\s*FAIL\s+a:test/);
  const green = formatLine({ name: 'b:test', code: 0, counts: { pass: 9, fail: 0, skipped: 0, todo: 0 }, ms: 1000 });
  assert.match(green, /^\s*PASS\s+b:test/);
});

test('a missing summary block is named in the line rather than rendered as zeroes', () => {
  const line = formatLine({ name: 'c:test', code: 1, counts: null, ms: 10 });
  assert.match(line, /no summary block/);
});

test('a skipped count is surfaced', () => {
  // The policies suite carries one pre-existing skip; a runner that hides it invites a second.
  const line = formatLine({ name: 'policies:test', code: 0, counts: { pass: 5, fail: 0, skipped: 1, todo: 0 }, ms: 10 });
  assert.match(line, /1 skipped/);
});

test('the roll-up names every failing suite', () => {
  const { failed, ok } = rollUp([{ name: 'a:test', code: 0 }, { name: 'b:test', code: 1 }, { name: 'c:test', code: null }]);
  assert.equal(ok, false);
  assert.deepEqual(failed, ['b:test', 'c:test']);
});

test('a clean run rolls up ok', () => {
  assert.deepEqual(rollUp([{ name: 'a:test', code: 0 }]), { failed: [], ok: true });
});

test('an unknown flag is an error', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown flag --nope/);
});

test('--only takes a comma list in either form', () => {
  assert.deepEqual(parseArgs(['--only', 'a:test, b:test']).only, ['a:test', 'b:test']);
  assert.deepEqual(parseArgs(['--only=a:test']).only, ['a:test']);
});

test('--only with no value is an error rather than a silent empty filter', () => {
  assert.throws(() => parseArgs(['--only']), /expects a value/);
});

test('a suite is run through npm with --silent and its output captured', async () => {
  const calls = [];
  const fakeSpawn = (cmd, args, o) => {
    calls.push({ cmd, args, o });
    const handlers = {};
    const stream = (key) => ({ on: (ev, fn) => { if (ev === 'data') handlers[key] = fn; } });
    const child = {
      stdout: stream('out'),
      stderr: stream('err'),
      on: (ev, fn) => {
        if (ev === 'close') {
          queueMicrotask(() => {
            handlers.out?.('# pass 2\n# fail 0\n');
            handlers.err?.('a warning\n');
            fn(0);
          });
        }
      },
    };
    return child;
  };
  const r = await runSuite('a:test', { spawnImpl: fakeSpawn, cwd: '/nowhere' });
  assert.deepEqual(calls[0].args, ['run', '--silent', 'a:test']);
  assert.equal(calls[0].o.cwd, '/nowhere');
  assert.equal(r.code, 0);
  assert.equal(r.counts.pass, 2);
  assert.match(r.output, /a warning/, 'stderr must be captured too, or a failing suite reports nothing');
});
