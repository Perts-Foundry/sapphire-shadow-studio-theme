// The two commands as a caller sees them: exit code, stdout, stderr.
//
// WHY THROUGH THE REAL SCRIPT. Every rule case calls `check()` directly, which leaves `main()` and
// the success marker unreached, and the marker is what CI's articles step greps for. A main() that
// printed the marker on a refusal, printed it twice, or printed it to stderr would pass every rule
// case and break the workflow's signal. The same goes for the `--root` flag with no value, which
// used to escape as an uncaught TypeError from `path.resolve(undefined)`.
//
// EVERY PATH IS UNDER A TEMP ROOT, asserted in an after() hook.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { OK_MARKER } from '../check.mjs';
import { RULES } from '../lib/articles.mjs';
import { TEST_DIR, cleanRoot, cleanup, madeRoots, readBody, reindexInPlace, writeBody } from './helpers.mjs';

const TEMP_ROOT = statSync(tmpdir()).isDirectory() ? tmpdir() : null;

after(() => {
  assert.ok(TEMP_ROOT, 'no usable temp directory');
  const roots = madeRoots();
  assert.ok(roots.length > 0, 'the temp-root guard ran before anything was created, so it checked nothing');
  for (const root of roots) assert.ok(root.startsWith(TEMP_ROOT), `${root} is not under the temp root`);
  cleanup();
});

function run(script, args) {
  const result = spawnSync(process.execPath, [join(TEST_DIR, '..', script), ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** How many whole lines of `text` are exactly `line`. The workflow's `grep -cxF`, in JS. */
function wholeLineCount(text, line) {
  return text.split('\n').filter((l) => l === line).length;
}

test('a clean root exits 0 and prints the marker exactly once, as a whole line on stdout', () => {
  const root = cleanRoot();
  const out = run('check.mjs', ['--root', root]);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(wholeLineCount(out.stdout, OK_MARKER), 1);
  assert.equal(out.stderr.includes(OK_MARKER), false);
});

test('a refused root exits 1, prints no marker, and names the rule id on stderr', () => {
  const root = cleanRoot();
  writeBody(root, `${readBody(root).trimEnd()}\n<script>alert(1)</script>\n`);
  reindexInPlace(root);
  const out = run('check.mjs', ['--root', root]);
  assert.equal(out.status, 1);
  assert.equal(out.stdout.includes(OK_MARKER), false, 'the marker must never accompany a refusal');
  assert.ok(out.stderr.includes(`[${RULES.FORBIDDEN_ELEMENT}]`), out.stderr);
});

test('an unreadable manifest exits 1 and says the tree could not be read', () => {
  const root = cleanRoot();
  writeFileSync(join(root, 'marketing', 'articles', 'manifest.json'), '{ not json', 'utf8');
  const out = run('check.mjs', ['--root', root]);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /could not be read/);
  assert.equal(out.stdout.includes(OK_MARKER), false);
});

for (const script of ['check.mjs', 'reindex.mjs']) {
  test(`${script} --root with no value exits 1 with a usage message, not a stack trace`, () => {
    for (const args of [['--root'], ['--root', '--check']]) {
      const out = run(script, args);
      assert.equal(out.status, 1, `${args.join(' ')}: ${out.stderr}`);
      assert.match(out.stderr, /--root needs a directory/);
      assert.match(out.stderr, /usage:/);
      assert.equal(/TypeError|at .*\.mjs:\d+/.test(out.stderr), false, `a stack trace escaped:\n${out.stderr}`);
    }
  });
}

test('reindex names the article whose JSON does not parse, and exits 1', () => {
  const root = cleanRoot();
  writeFileSync(join(root, 'marketing', 'articles', 'welcome-to-shift-notes', 'images.json'), 'nope', 'utf8');
  for (const args of [[], ['--check']]) {
    const out = run('reindex.mjs', ['--root', root, ...args]);
    assert.equal(out.status, 1, out.stderr);
    assert.match(out.stderr, /welcome-to-shift-notes\/images\.json is not valid JSON/);
  }
});
