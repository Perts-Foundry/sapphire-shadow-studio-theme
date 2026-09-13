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
// THE SECOND VERSION HAD THREE BLIND SPOTS, found in review, and each is now a planted control:
//   - OBJECT SHORTHAND. `someGate({ root, git })` injects `git` with no colon, and the site regex
//     only knew `git:`. A shorthand now resolves like any named value: through its declaration, one
//     factory call at a time, to `makeGitFake`; or to a destructured parameter of the enclosing
//     function, which passes on whatever the caller injected (and the caller's site is checked).
//   - HELPER MODULES. Only `*.test.mjs` was read, so a fake built in a helper the tests import was
//     never looked at. Every `.mjs` in the directory is read now; the exhaustion rule stays on test
//     files, because a helper registers no after() hook of its own.
//   - VACUITY. A directory with no test files, or a configured parameter name with no site anywhere,
//     passed every rule by checking nothing. Both are failures now: a renamed parameter must be
//     renamed here too, or this says so.
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

const IDENT = /^[A-Za-z_$][\w$]*$/;
const OPEN = '({[';
const CLOSE = ')}]';

/** The index of the bracket closing the one at `open`, or -1. Any bracket kind nests. */
function matchingClose(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (OPEN.includes(source[i])) depth++;
    else if (CLOSE.includes(source[i]) && --depth === 0) return i;
  }
  return -1;
}

/** The index of the unmatched `(` enclosing `pos`, or -1. */
function enclosingParen(source, pos) {
  let depth = 0;
  for (let i = pos - 1; i >= 0; i--) {
    if (CLOSE.includes(source[i])) depth++;
    else if (OPEN.includes(source[i])) {
      if (depth === 0) return source[i] === '(' ? i : -1;
      depth--;
    }
  }
  return -1;
}

/** The comma-separated entries at depth 0 between `open` and `close`, with their offsets. */
function topLevelEntries(source, open, close) {
  const out = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i <= close; i++) {
    const c = source[i];
    if (i === close || (c === ',' && depth === 0)) {
      const raw = source.slice(start, i);
      out.push({ text: raw.trim(), offset: start + (raw.length - raw.trimStart().length) });
      start = i + 1;
    } else if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
  }
  return out;
}

const lineOf = (source, offset) => source.slice(0, offset).split('\n').length;

/**
 * Every `{ ... }` group in the source, classified.
 *
 * `literal`: an object literal in expression position, whose bare identifiers are shorthand
 * injection sites. `parameter`: a destructuring pattern in a function's parameter list, whose names
 * are pass-throughs. Import and export clauses, `const { x } = ...` patterns and template
 * substitutions are neither.
 */
function braceGroups(source) {
  const out = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '{' || source[i - 1] === '$') continue;
    const close = matchingClose(source, i);
    if (close === -1) continue;
    const before = source.slice(0, i).trimEnd();
    const after = source.slice(close + 1).trimStart();
    if (/\b(?:import|export)$/.test(before) || /^from\b/.test(after) || /^(?:of|in)\b/.test(after)) continue;
    const paren = enclosingParen(source, i);
    const inParams = paren !== -1 && /[(,]$/.test(before) && (() => {
      const end = matchingClose(source, paren);
      return end !== -1 && /^(?:=>|\{)/.test(source.slice(end + 1).trimStart());
    })();
    if (inParams) {
      out.push({ kind: 'parameter', open: i, close });
    } else if (/^=(?![=>])/.test(after)) {
      continue;
    } else {
      out.push({ kind: 'literal', open: i, close });
    }
  }
  return out;
}

/**
 * Every value handed to a git-runner parameter, with the line it is on: `name: value` sites and
 * `{ name }` shorthand sites (whose value is the identifier itself, flagged `shorthand`).
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
    out.push({ value: m[1].trim(), line: lineOf(source, m.index), shorthand: false });
  }
  for (const group of braceGroups(source)) {
    if (group.kind !== 'literal') continue;
    for (const entry of topLevelEntries(source, group.open, group.close)) {
      if (IDENT.test(entry.text) && names.includes(entry.text)) {
        out.push({ value: entry.text, line: lineOf(source, entry.offset), shorthand: true });
      }
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/** Every name destructured in some function's parameter list in the file. */
export function parameterNames(text) {
  const source = withoutComments(text);
  const out = new Set();
  for (const group of braceGroups(source)) {
    if (group.kind !== 'parameter') continue;
    for (const entry of topLevelEntries(source, group.open, group.close)) {
      const m = /^([A-Za-z_$][\w$]*)\s*(?:=[\s\S]*)?$/.exec(entry.text);
      if (m) out.add(m[1]);
    }
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
  const re = new RegExp(`(?:const|let|var|function)\\s+${name.replace(/\$/g, '\\$')}\\b`);
  const m = re.exec(text);
  if (m === null) return null;
  const rest = text.slice(m.index);
  const next = /\n(?:const|let|var|function|test|export)\s/.exec(rest.slice(1));
  return next === null ? rest : rest.slice(0, next.index + 1);
}

/**
 * What a named injected value resolves to: `'fake'` (built by makeGitFake, directly or through a
 * chain of factory calls such as `const git = cleanGit()` then `function cleanGit() { return
 * makeGitFake(...) }`), `'parameter'` (a destructured parameter passing on the caller's value),
 * `'undefined'` (declared nowhere in the file), or `'other'`.
 */
export function resolveInjected(text, id, seen = new Set()) {
  if (id === 'makeGitFake') return 'fake';
  if (seen.has(id) || seen.size > 5) return 'other';
  seen.add(id);
  const source = bindingSource(text, id);
  if (source === null) return parameterNames(text).has(id) ? 'parameter' : 'undefined';
  if (source.includes('makeGitFake(')) return 'fake';
  const call = new RegExp(`(?:const|let|var)\\s+${id.replace(/\$/g, '\\$')}\\s*=\\s*(?:await\\s+)?([A-Za-z_$][\\w$]*)\\s*\\(`).exec(source);
  if (call) return resolveInjected(text, call[1], seen);
  return parameterNames(text).has(id) ? 'parameter' : 'other';
}

/**
 * Every injection site in a set of files that is not the shared strict fake, as strings.
 *
 * @param {{files: Array<{name: string, text: string}>, names: string[]}} o
 */
export function injectionOffenders({ files, names }) {
  const offenders = [];
  for (const { name, text } of files) {
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
      const resolved = resolveInjected(text, id);
      if (resolved === 'fake' || resolved === 'parameter') continue;
      offenders.push(
        resolved === 'undefined'
          ? `${name}:${line}: \`${id}\` is injected but not defined in this file`
          : `${name}:${line}: \`${id}\` is injected but is not built by makeGitFake`,
      );
    }
  }
  return offenders;
}

/**
 * Why a scan would prove nothing: no files read, or a configured name with no site anywhere.
 *
 * @param {{files: Array<{name: string, text: string}>, names: string[]}} o
 */
export function coverageProblems({ files, names }) {
  const out = [];
  if (!Array.isArray(files) || files.filter((f) => f.name.endsWith('.test.mjs')).length === 0) {
    out.push('no test files were read, so every rule passed by checking nothing');
  }
  for (const n of names) {
    if (!(files ?? []).some(({ text }) => injectionSites(text, [n]).length > 0)) {
      out.push(`the parameter name \`${n}\` has no injection site in any file read; it is misconfigured, or production renamed it`);
    }
  }
  return out;
}

/**
 * Register the hygiene tests for one test directory.
 *
 * @param {object} o
 * @param {Function} o.test          node:test's `test`
 * @param {object} o.assert          node:assert/strict
 * @param {string} o.testDir         absolute path of the directory whose .mjs files are checked
 * @param {string} o.self            the calling file's basename, which quotes the banned patterns
 * @param {string[]} o.names         the parameter names a git runner is injected under
 */
export function registerHygieneTests({ test, assert, testDir, self, names }) {
  function allFiles() {
    return readdirSync(testDir)
      .filter((n) => n.endsWith('.mjs') && n !== self)
      .sort()
      .map((name) => ({ name, text: readFileSync(join(testDir, name), 'utf8') }));
  }
  const testFiles = () => allFiles().filter((f) => f.name.endsWith('.test.mjs'));

  test('the hygiene scan reads test files, and every configured parameter name has a site', () => {
    assert.deepEqual(coverageProblems({ files: allFiles(), names }), []);
  });

  test('the coverage floor fires on an empty directory and on a name with no site', () => {
    assert.ok(coverageProblems({ files: [], names }).some((p) => p.startsWith('no test files were read')));
    assert.ok(coverageProblems({ files: [{ name: 'helpers.mjs', text: '' }], names }).some((p) => p.startsWith('no test files were read')), 'a helper alone is not a test file');
    const quiet = coverageProblems({ files: [{ name: 'x.test.mjs', text: 'test(1);' }], names });
    for (const n of names) assert.ok(quiet.some((p) => p.includes(`\`${n}\``)), `a missing site for ${n} was not reported`);
  });

  test('nothing but the shared strict fake is ever injected into a git-runner parameter', () => {
    // It does not care what a fake is named; it cares what reaches the parameter. A function literal
    // is banned outright, and a named value must resolve to something built by `makeGitFake`.
    const offenders = injectionOffenders({ files: allFiles(), names });
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
      assert.equal(injectionOffenders({ files: [{ name: 'x.test.mjs', text: namedBypass }], names }).length, 1, 'the bypass would be accepted');

      // OBJECT SHORTHAND: the same bypass with no colon, and through a factory that is not the fake.
      const shorthand = `const ${param} = (root, args) => '';\ntest('x', () => { someGate('/x', { root, ${param} }); });`;
      assert.deepEqual(injectionSites(shorthand, names).map((s) => [s.value, s.shorthand]), [[param, true]], `shorthand not seen: ${shorthand}`);
      assert.equal(injectionOffenders({ files: [{ name: 'x.test.mjs', text: shorthand }], names }).length, 1, 'a shorthand bypass would be accepted');
      const viaFactory = `function loose() { return () => ''; }\ntest('x', () => { const ${param} = loose();\n  someGate({ ${param} }); });`;
      assert.equal(injectionOffenders({ files: [{ name: 'x.test.mjs', text: viaFactory }], names }).length, 1, 'a shorthand through a non-fake factory would be accepted');

      // The sanctioned shorthand forms: a fake through a factory, and a parameter passed through.
      const sanctioned = [
        `function strict() { return makeGitFake([]); }\ntest('x', () => { const ${param} = strict();\n  someGate({ root, ${param} }); });`,
        `function setup({ root, ${param}, other = {} } = {}) {\n  return build({ root, ${param} });\n}`,
        `const setup = async ({ ${param} }) => build({ ${param} });`,
      ];
      for (const text of sanctioned) {
        assert.deepEqual(injectionOffenders({ files: [{ name: 'x.test.mjs', text }], names }), [], `sanctioned form flagged: ${text}`);
      }
      // Clauses that only look like shorthand are not sites at all.
      for (const text of [`import { ${param} } from '../x.mjs';`, `import {\n  a,\n  ${param},\n} from '../x.mjs';`, `const { ${param} } = thing;`, `export { ${param} };`, `const s = \`\${${param}}\`;`]) {
        assert.deepEqual(injectionSites(text, names), [], `not a site: ${text}`);
      }
    }

    // The sanctioned forms must NOT be flagged, or the rule is just noise.
    for (const value of ['makeGitFake([])', 'cleanGit(...ALL_FILES)', 'noGit()', 'mergedGit()', 'gitRun']) {
      assert.equal(isFunctionLiteral(value), false, `sanctioned form flagged as a literal: ${value}`);
    }
  });

  test('every file that injects a git runner of its own imports the shared fake', () => {
    // A file whose only sites pass a caller's value through (a context builder in a helper) builds
    // no runner, so it need not import the fake; the caller's own site is what gets checked.
    const offenders = [];
    for (const { name, text } of allFiles()) {
      const own = injectionSites(text, names).filter((s) => resolveInjected(text, leadingIdentifier(s.value) ?? '') !== 'parameter');
      if (own.length === 0) continue;
      if (!/\bmakeGitFake\b/.test(text)) offenders.push(name);
    }
    assert.deepEqual(offenders, [], `these files inject a git runner but never import makeGitFake:\n${offenders.join('\n')}`);
  });

  test('every test file that builds git fakes asserts, at runtime, that all of them were exhausted', () => {
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
