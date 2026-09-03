// A meta-test: rules about the OTHER test files in this directory.
//
// WHY THIS EXISTS. PR #154 shipped two tests that passed vacuously. Their local git fake matched
// with `args.some((a) => a.endsWith('*.html'))` and returned `''` for everything else, so it
// answered "clean" to any invocation it did not recognise. The gate under test could have emitted
// a pathspec real git rejects, or made no invocation at all, and both tests would still be green.
//
// THE FIRST VERSION OF THIS FILE WAS ITSELF BYPASSABLE, which is the whole lesson repeating one
// level up. It keyed on the DECLARATION (`const <something with git in the name> = (`) and on the
// literal property `run:`. So this passed every rule:
//
//     const runner = (root, args) => (args.some((a) => a.endsWith('.html')) ? ' M x' : '');
//     someGate('/x', { gitRun: runner });
//
// Twice over: the identifier avoided the name pattern, and `gitRun:` contains no `run:` with a
// word boundary before it, which is how 31 of this directory's injection sites were invisible.
//
// So the rules key on the INJECTION SITE now, not on the declaration. What a fake is called does
// not matter; what reaches a `run:` or `gitRun:` parameter does. And exhaustion is enforced at
// RUNTIME by the fake itself rather than by counting text, because a textual rule cannot follow a
// file-level factory into the tests that call it.
//
// Scope is deliberately narrow. This checks the SHAPE of the test files by reading their source.
// It is not a lint pass and must not grow into one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

/** This file quotes the patterns it bans, so it is the one file exempt from them. */
const SELF = 'test-hygiene.test.mjs';

function testFiles() {
  return readdirSync(TEST_DIR)
    .filter((n) => n.endsWith('.test.mjs') && n !== SELF)
    .sort()
    .map((name) => ({ name, text: readFileSync(join(TEST_DIR, name), 'utf8') }));
}

/**
 * The source with comments blanked, line numbering preserved.
 *
 * Prose is full of the thing being matched, in comments AND in test names: "for a dry run: the
 * boundary is...", "// First run: refuses...". Scanning raw text produced four false positives on
 * the first attempt, and a rule that cries wolf gets weakened rather than obeyed.
 */
function withoutComments(text) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, before) => before + blank(m.slice(before.length)))
    // Single-line string literals too: a test NAME is prose ("for a dry run: the boundary is..."),
    // and it sits in code rather than in a comment.
    .replace(/'(?:[^'\\\n]|\\.)*'/g, blank)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, blank);
}

/**
 * Every value handed to a git-runner parameter, with the line it is on.
 *
 * Both spellings, because production uses both: `assertReviewedTree(root, { run })` and
 * `pull.run({ gitRun })`. Missing the second is exactly how the first version of this file covered
 * none of `pull.test.mjs` or `status.test.mjs`, which between them hold 28 of the injection sites.
 */
function injectionSites(text) {
  const source = withoutComments(text);
  const out = [];
  const re = /\b(?:gitRun|run)\s*:\s*([^,}\n]+)/g;
  for (const m of source.matchAll(re)) {
    out.push({
      value: m[1].trim(),
      line: source.slice(0, m.index).split('\n').length,
    });
  }
  return out;
}

/** A function literal: an arrow, a `function`, or an `async` one. The #154 shape exactly. */
function isFunctionLiteral(value) {
  // Strip a leading `async` FIRST, or the call-expression exclusion below reads `async (` as a
  // call and lets `async (root, args) => ...` through, which is the same fake with one keyword on.
  const v = value.replace(/^async\s+/, '');
  if (/^function\b/.test(v)) return true;
  if (/^[A-Za-z_$][\w$]*\s*=>/.test(v)) return true;
  if (/^\(/.test(v)) return true;
  return false;
}

/** The leading identifier of a value, e.g. `cleanGit` from `cleanGit(...)` or `foo` from `foo`. */
function leadingIdentifier(value) {
  const m = /^([A-Za-z_$][\w$]*)/.exec(value);
  return m === null ? null : m[1];
}

/**
 * The source of a local binding, so a rule can ask what a named fake is actually made of.
 * Deliberately crude: from the declaration to the end of the file is enough, because the only
 * question asked of it is whether `makeGitFake` appears before the next declaration.
 */
function bindingSource(text, name) {
  const re = new RegExp(`(?:const|let|var|function)\\s+${name}\\b`);
  const m = re.exec(text);
  if (m === null) return null;
  const rest = text.slice(m.index);
  const next = /\n(?:const|let|var|function|test|export)\s/.exec(rest.slice(1));
  return next === null ? rest : rest.slice(0, next.index + 1);
}

test('nothing but the shared strict fake is ever injected into a git-runner parameter', () => {
  // The rule that closes #154, and the rule that closes this file's own first version. It does not
  // care what a fake is named; it cares what reaches the parameter. A function literal is banned
  // outright, and a named value must resolve to something built by `makeGitFake`.
  const offenders = [];
  for (const { name, text } of testFiles()) {
    for (const { value, line } of injectionSites(text)) {
      if (isFunctionLiteral(value)) {
        offenders.push(`${name}:${line}: a function literal is injected directly: ${JSON.stringify(value.slice(0, 60))}`);
        continue;
      }
      const id = leadingIdentifier(value);
      if (id === null) {
        offenders.push(`${name}:${line}: cannot tell what is injected: ${JSON.stringify(value.slice(0, 60))}`);
        continue;
      }
      if (id === 'makeGitFake') continue;
      const source = bindingSource(text, id);
      if (source === null) {
        offenders.push(`${name}:${line}: \`${id}\` is injected but not defined in this file`);
        continue;
      }
      if (!source.includes('makeGitFake(')) {
        offenders.push(`${name}:${line}: \`${id}\` is injected but is not built by makeGitFake`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'a git runner that is not the shared strict fake answers a default for every argv it does not ' +
      'recognise, which makes an absent gate indistinguishable from a passing one. Build it with ' +
      `makeGitFake from ./helpers.mjs, which matches on deep argv equality and throws otherwise.\n${offenders.join('\n')}`,
  );
});

test('the injection-site rule sees BOTH spellings, and would catch the shape that defeated its first version', () => {
  // A test of the rule, because a rule with a blind spot is worse than no rule: the first version
  // matched `run:` with a word boundary, so `gitRun:` (31 of this directory's injection sites, and
  // every one in pull and status) was invisible to all of it.
  const planted = [
    "someGate('/x', { gitRun: (root, args) => (args.some((a) => a.endsWith('.html')) ? ' M x' : '') });",
    "someGate('/x', { run: (root, args) => '' });",
    "someGate('/x', { gitRun: async (root, args) => '' });",
    "someGate('/x', { gitRun: function (root, args) { return ''; } });",
  ];
  for (const line of planted) {
    const sites = injectionSites(line);
    assert.equal(sites.length, 1, `not seen at all: ${line}`);
    assert.equal(isFunctionLiteral(sites[0].value), true, `not recognised as a literal: ${line}`);
  }

  // And the named-binding form, which is the bypass the reviewer demonstrated.
  const namedBypass = "const runner = (root, args) => '';\ntest('x', () => { someGate('/x', { gitRun: runner }); });";
  const site = injectionSites(namedBypass).at(-1);
  assert.equal(site.value, 'runner');
  assert.equal(bindingSource(namedBypass, 'runner').includes('makeGitFake('), false, 'the bypass would be accepted');

  // The sanctioned forms must NOT be flagged, or the rule is just noise.
  for (const value of ['makeGitFake([])', 'cleanGit(...ALL_FILES)', 'noGit()', 'mergedGit()', 'gitRun']) {
    assert.equal(isFunctionLiteral(value), false, `sanctioned form flagged as a literal: ${value}`);
  }
});

test('every test file that injects a git runner imports the shared fake', () => {
  const offenders = [];
  for (const { name, text } of testFiles()) {
    if (injectionSites(text).length === 0) continue;
    if (!/\bmakeGitFake\b/.test(text)) offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    `these files inject a git runner but never import makeGitFake:\n${offenders.join('\n')}`,
  );
});

test('every file that builds git fakes asserts, at runtime, that all of them were exhausted', () => {
  // Exhaustion is a RUNTIME property now. A strict fake catches an argv nobody expected; it cannot
  // catch an expectation nobody used, which is what a silently removed gate looks like. The
  // previous rule counted `.assertExhausted(` against `makeGitFake(` textually, which could not
  // follow a file-level factory (`cleanGit`, `noGit`, `mergedGit`) into the tests that call it, so
  // roughly three quarters of this directory's fakes were outside it. `makeGitFake` now registers
  // every fake it builds, and `assertAllGitFakesExhausted` in an `after()` hook checks the lot.
  const offenders = [];
  for (const { name, text } of testFiles()) {
    // `makeGitFake(` with the paren: a file that only NAMES the helper in a comment builds none.
    if (!text.includes('makeGitFake(')) continue;
    if (!text.includes('assertAllGitFakesExhausted')) offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    'each file building git fakes must call assertAllGitFakesExhausted(assert) from an after() ' +
      `hook. A fake deliberately left unused opts out at its own call site with { exhaustive: false }.\n${offenders.join('\n')}`,
  );
});
