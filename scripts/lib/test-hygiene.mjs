// TEST SUPPORT. Rules about the OTHER test files in a directory, shared by every subsystem whose
// gates shell out to git.
//
// WHY THIS EXISTS. PR #154 shipped two tests that passed vacuously. Their local git fake matched
// with `args.some((a) => a.endsWith('*.html'))` and returned `''` for everything else, so it
// answered "clean" to any invocation it did not recognise. The gate under test could have emitted
// a pathspec real git rejects, or made no invocation at all, and both tests would still be green.
//
// THE FIRST VERSION OF THESE RULES WAS ITSELF BYPASSABLE, which is the whole lesson repeating one
// level up. It keyed on the DECLARATION (`const <something with git in the name> = (`) and on the
// literal property `run:`. So this passed every rule:
//
//     const runner = (root, args) => (args.some((a) => a.endsWith('.html')) ? ' M x' : '');
//     someGate('/x', { gitRun: runner });
//
// Twice over: the identifier avoided the name pattern, and `gitRun:` contains no `run:` with a
// word boundary before it, which is how 31 injection sites in the policies suite were invisible.
//
// So the rules key on the INJECTION SITE, not on the declaration. What a fake is called does not
// matter; what reaches a git-runner parameter does. And exhaustion is enforced at RUNTIME by the fake
// itself (scripts/lib/git-fake.mjs) rather than by counting text, because a textual rule cannot
// follow a file-level factory into the tests that call it.
//
// WHY IT IS SHARED RATHER THAN COPIED. These rules first lived in
// scripts/policies/test/test-hygiene.test.mjs. The article push injects a git runner too, under a
// different parameter name (`git:` on its context). A copy would drift the first time either side
// learned something, and the learning here has always come from a bypass. The parameter names are
// the only thing a caller configures; every rule and every planted control is this module's.
//
// Scope is deliberately narrow. This checks the SHAPE of test files by reading their source. It is
// not a lint pass and must not grow into one.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The source with comments blanked, line numbering preserved.
 *
 * Prose is full of the thing being matched, in comments AND in test names: "for a dry run: the
 * boundary is...", "// First run: refuses...". Scanning raw text produced four false positives on
 * the first attempt, and a rule that cries wolf gets weakened rather than obeyed.
 */
export function withoutComments(text) {
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
 * @param {string} text
 * @param {string[]} names  the parameter names a git runner is injected under, e.g. `['gitRun', 'run']`
 */
export function injectionSites(text, names) {
  if (!Array.isArray(names) || names.length === 0) throw new TypeError('injectionSites needs at least one parameter name');
  const source = withoutComments(text);
  const out = [];
  const re = new RegExp(`\\b(?:${names.join('|')})\\s*:\\s*([^,}\\n]+)`, 'g');
  for (const m of source.matchAll(re)) {
    out.push({
      value: m[1].trim(),
      line: source.slice(0, m.index).split('\n').length,
    });
  }
  return out;
}

/** A function literal: an arrow, a `function`, or an `async` one. The #154 shape exactly. */
export function isFunctionLiteral(value) {
  // Strip a leading `async` FIRST, or the call-expression exclusion below reads `async (` as a
  // call and lets `async (root, args) => ...` through, which is the same fake with one keyword on.
  const v = value.replace(/^async\s+/, '');
  if (/^function\b/.test(v)) return true;
  if (/^[A-Za-z_$][\w$]*\s*=>/.test(v)) return true;
  if (/^\(/.test(v)) return true;
  return false;
}

/** The leading identifier of a value, e.g. `cleanGit` from `cleanGit(...)` or `foo` from `foo`. */
export function leadingIdentifier(value) {
  const m = /^([A-Za-z_$][\w$]*)/.exec(value);
  return m === null ? null : m[1];
}

/**
 * The source of a local binding, so a rule can ask what a named fake is actually made of.
 * Deliberately crude: from the declaration to the next top-level declaration is enough, because the
 * only question asked of it is whether `makeGitFake` appears in it.
 */
export function bindingSource(text, name) {
  const re = new RegExp(`(?:const|let|var|function)\\s+${name}\\b`);
  const m = re.exec(text);
  if (m === null) return null;
  const rest = text.slice(m.index);
  const next = /\n(?:const|let|var|function|test|export)\s/.exec(rest.slice(1));
  return next === null ? rest : rest.slice(0, next.index + 1);
}

/**
 * Register the hygiene tests for one test directory.
 *
 * @param {object} o
 * @param {Function} o.test          node:test's `test`
 * @param {object} o.assert          node:assert/strict
 * @param {string} o.testDir         absolute path of the directory whose *.test.mjs files are checked
 * @param {string} o.self            the calling file's basename, which quotes the banned patterns
 * @param {string[]} o.names         the parameter names a git runner is injected under
 */
export function registerHygieneTests({ test, assert, testDir, self, names }) {
  function testFiles() {
    return readdirSync(testDir)
      .filter((n) => n.endsWith('.test.mjs') && n !== self)
      .sort()
      .map((name) => ({ name, text: readFileSync(join(testDir, name), 'utf8') }));
  }

  test('nothing but the shared strict fake is ever injected into a git-runner parameter', () => {
    // It does not care what a fake is named; it cares what reaches the parameter. A function literal
    // is banned outright, and a named value must resolve to something built by `makeGitFake`.
    const offenders = [];
    for (const { name, text } of testFiles()) {
      for (const { value, line } of injectionSites(text, names)) {
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
        `makeGitFake from scripts/lib/git-fake.mjs, which matches on deep argv equality and throws otherwise.\n${offenders.join('\n')}`,
    );
  });

  test('the injection-site rule sees every configured spelling, and would catch the shape that defeated its first version', () => {
    // A test of the rule, because a rule with a blind spot is worse than no rule.
    for (const param of names) {
      const planted = [
        `someGate('/x', { ${param}: (root, args) => (args.some((a) => a.endsWith('.html')) ? ' M x' : '') });`,
        `someGate('/x', { ${param}: async (root, args) => '' });`,
        `someGate('/x', { ${param}: function (root, args) { return ''; } });`,
        `someGate('/x', { ${param}: root => '' });`,
      ];
      for (const line of planted) {
        const sites = injectionSites(line, names);
        assert.equal(sites.length, 1, `not seen at all: ${line}`);
        assert.equal(isFunctionLiteral(sites[0].value), true, `not recognised as a literal: ${line}`);
      }
      // And the named-binding form, which is the bypass a reviewer demonstrated.
      const namedBypass = `const runner = (root, args) => '';\ntest('x', () => { someGate('/x', { ${param}: runner }); });`;
      const site = injectionSites(namedBypass, names).at(-1);
      assert.equal(site.value, 'runner');
      assert.equal(bindingSource(namedBypass, 'runner').includes('makeGitFake('), false, 'the bypass would be accepted');
    }

    // The sanctioned forms must NOT be flagged, or the rule is just noise.
    for (const value of ['makeGitFake([])', 'cleanGit(...ALL_FILES)', 'noGit()', 'mergedGit()', 'gitRun']) {
      assert.equal(isFunctionLiteral(value), false, `sanctioned form flagged as a literal: ${value}`);
    }
  });

  test('every test file that injects a git runner imports the shared fake', () => {
    const offenders = [];
    for (const { name, text } of testFiles()) {
      if (injectionSites(text, names).length === 0) continue;
      if (!/\bmakeGitFake\b/.test(text)) offenders.push(name);
    }
    assert.deepEqual(offenders, [], `these files inject a git runner but never import makeGitFake:\n${offenders.join('\n')}`);
  });

  test('every file that builds git fakes asserts, at runtime, that all of them were exhausted', () => {
    // A strict fake catches an argv nobody expected; it cannot catch an expectation nobody used,
    // which is what a silently removed gate looks like.
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
}
