#!/usr/bin/env node
// Run every `*:test` npm script, one after another, and report one line per suite.
//
// This exists because running "the tests" by hand kept going wrong in the same two ways. A `for`
// loop over the suite names is refused by the worktree command verifier, and piping each suite
// through `tail -n` clips node's summary block, so a run reads as silent and gets repeated. Both
// are avoided by having ONE command that knows the suite list.
//
// The suite list is DISCOVERED from package.json rather than written down here. A hand-maintained
// list is a list that goes stale on the next `<area>:test` someone adds, and the failure mode is
// the bad one: the roll-up stays green while a whole area goes unrun. Discovery means adding a
// script to package.json is the only thing anyone has to remember.
//
// Suites run SEQUENTIALLY and that is deliberate. Several of them render golden images or write
// under a temp state directory, and CI runs them one at a time; a parallel local run that passes
// where CI fails is worse than a slow one.

import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');

/**
 * npm script keys that look like a suite but are not one.
 *
 * `test:all` is this runner. `*:coverage` re-runs a suite under the coverage reporter, so including
 * it would double that suite's wall clock to report the same pass/fail twice.
 */
export const NOT_A_SUITE = new Set(['test:all']);

/**
 * Every suite script, in package.json order.
 *
 * Order is the file's order on purpose: it is roughly cheapest-first as the file has grown, and a
 * stable order makes two runs comparable line by line.
 *
 * @param {Record<string, string>} scripts - the `scripts` object from package.json
 * @returns {string[]} npm script keys
 */
export function discoverSuites(scripts) {
  return Object.keys(scripts ?? {}).filter((k) => k.endsWith(':test') && !NOT_A_SUITE.has(k));
}

/**
 * Pull the counts out of a node:test summary block.
 *
 * Node emits the spec reporter to a TTY and TAP otherwise, so the same field is prefixed `ℹ` or
 * `#` depending on how the process was launched. This runner always captures through a pipe, which
 * means TAP, but matching both costs one alternation and stops a future reporter default from
 * silently turning every suite into `counts: null`.
 *
 * Returns null when no summary block is present at all (a suite that crashed before running a
 * test, or a script that is not node:test); callers fall back to the exit code, which is the
 * authority either way.
 *
 * @param {string} text
 * @returns {{tests: number, pass: number, fail: number, skipped: number, todo: number}|null}
 */
export function parseNodeTestOutput(text) {
  const field = (name) => {
    // Last match wins: a suite that prints a nested summary (a subprocess under test) would
    // otherwise have its inner counts read as the run's.
    const re = new RegExp(`^(?:#|\\u2139)\\s*${name}\\s+(\\d+)\\s*$`, 'gm');
    let last = null;
    for (const m of String(text ?? '').matchAll(re)) last = Number(m[1]);
    return last;
  };
  const pass = field('pass');
  const fail = field('fail');
  if (pass === null && fail === null) return null;
  return {
    tests: field('tests') ?? 0,
    pass: pass ?? 0,
    fail: fail ?? 0,
    skipped: field('skipped') ?? 0,
    todo: field('todo') ?? 0,
  };
}

/**
 * One rendered result line.
 *
 * The verdict comes from the EXIT CODE, never from the parsed counts. A suite can exit non-zero
 * with `fail 0` (an uncaught exception after the last test, a module that throws on import), and
 * reporting that as a pass because the counts looked clean is exactly the failure this runner was
 * written to stop.
 *
 * @param {{name: string, code: number|null, counts: object|null, ms: number}} r
 * @returns {string}
 */
export function formatLine(r) {
  const ok = r.code === 0;
  const verdict = ok ? 'PASS' : 'FAIL';
  const counts = r.counts
    ? `${r.counts.pass} passed, ${r.counts.fail} failed` +
      (r.counts.skipped ? `, ${r.counts.skipped} skipped` : '') +
      (r.counts.todo ? `, ${r.counts.todo} todo` : '')
    : `exit ${r.code === null ? 'signal' : r.code}, no summary block`;
  return `  ${verdict}  ${r.name.padEnd(24)}  ${counts}  (${(r.ms / 1000).toFixed(1)}s)`;
}

/**
 * @param {Array<{name: string, code: number|null}>} results
 * @returns {{failed: string[], ok: boolean}}
 */
export function rollUp(results) {
  const failed = results.filter((r) => r.code !== 0).map((r) => r.name);
  return { failed, ok: failed.length === 0 };
}

/**
 * Run one npm script, capturing its combined output.
 *
 * @param {string} name
 * @param {object} [opts]
 * @param {(cmd: string, args: string[], o: object) => any} [opts.spawnImpl]
 * @param {string} [opts.cwd]
 * @returns {Promise<{name: string, code: number|null, output: string, counts: object|null, ms: number}>}
 */
export function runSuite(name, { spawnImpl = spawn, cwd = REPO_ROOT } = {}) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawnImpl(npm, ['run', '--silent', name], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ name, code, output, counts: parseNodeTestOutput(output), ms: Date.now() - startedAt });
    });
  });
}

const USAGE = `
run-all-tests: run every \`*:test\` npm script and roll the results up.

  npm run test:all              run every suite
  npm run test:all -- --list    print the discovered suite list and exit
  npm run test:all -- --only a,b   run only the named suites

The suite list is discovered from package.json, so a new \`<area>:test\` script is picked up with
no change here. Suites run one at a time. Exit status is non-zero if any suite failed.
`;

export function parseArgs(argv) {
  const out = { list: false, only: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const [flag, inline] = eq === -1 ? [arg, null] : [arg.slice(0, eq), arg.slice(eq + 1)];
    const value = () => {
      if (inline !== null) return inline;
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} expects a value`);
      return next;
    };
    switch (flag) {
      case '--list': out.list = true; break;
      case '--only': out.only = value().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--help': case '-h': out.help = true; break;
      default: throw new Error(`unknown flag ${flag}`);
    }
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const all = discoverSuites(pkg.scripts);

  let suites = all;
  if (opts.only) {
    const unknown = opts.only.filter((n) => !all.includes(n));
    if (unknown.length) {
      console.error(`\nERROR: not a discovered suite: ${unknown.join(', ')}\nKnown: ${all.join(', ')}\n`);
      return 1;
    }
    suites = all.filter((n) => opts.only.includes(n));
  }

  if (opts.list) {
    for (const s of suites) console.log(s);
    return 0;
  }

  console.log(`\nRunning ${suites.length} suite(s), one at a time.\n`);
  const results = [];
  for (const name of suites) {
    const r = await runSuite(name);
    results.push(r);
    console.log(formatLine(r));
  }

  const { failed, ok } = rollUp(results);
  for (const r of results.filter((x) => x.code !== 0)) {
    console.log(`\n${'='.repeat(72)}\n${r.name}\n${'='.repeat(72)}\n${r.output.trimEnd()}`);
  }
  console.log(
    ok
      ? `\n${suites.length} suite(s) passed.\n`
      : `\n${failed.length} of ${suites.length} suite(s) FAILED: ${failed.join(', ')}\n`
  );
  return ok ? 0 : 1;
}

// Importable by the unit test; argv[1] is percent-encoded through import.meta.url, so compare
// against pathToFileURL rather than a hand-built file:// string.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`\nERROR: ${err.message}\n`);
      process.exit(1);
    }
  );
}
