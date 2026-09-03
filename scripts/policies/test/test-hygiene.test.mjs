// A meta-test: rules about the OTHER test files in this directory.
//
// WHY THIS EXISTS. PR #154 shipped two tests that passed vacuously. Their local git fake matched
// with `args.some((a) => a.endsWith('*.html'))` and returned `''` for everything else, so it
// answered "clean" to any invocation it did not recognise. The gate under test could have emitted
// a pathspec real git rejects, or no invocation at all, and both tests would still be green: they
// proved the fake's shape, not the gate's.
//
// The fix is structural rather than a review habit. `makeGitFake` in helpers.mjs matches on deep
// equality of the full argv and throws on anything else, and this file makes it the only game in
// town: a locally defined git fake is a test failure, whatever it returns.
//
// Scope is deliberately narrow. This checks the SHAPE of the test files, by reading their source.
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

// Assembled from fragments so this file's own source does not match it. `git` in any case, bound
// to a function by const/let/var, is a locally defined fake by definition: nothing else in a test
// file needs one, because the real thing is `execFileSync`.
const LOCAL_GIT_FAKE = new RegExp(
  ['(?:const|let|var)\\s+', '\\w*[Gg]it\\w*', '\\s*=\\s*', '(?:\\(|async\\s|function\\b)'].join(''),
  'g',
);

/**
 * The one legitimate exception: a helper that shells out to REAL git, in an integration test.
 * It is the opposite of a fake, so it cannot answer a default to an argv it does not recognise.
 * The marker goes on the declaration or within the three lines above it.
 */
const REAL_GIT_MARKER = 'real-git-not-a-fake';

test('no test file defines its own git fake; the strict shared one is the only one', () => {
  const offenders = [];
  for (const { name, text } of testFiles()) {
    const lines = text.split('\n');
    for (const m of text.matchAll(LOCAL_GIT_FAKE)) {
      const lineNo = text.slice(0, m.index).split('\n').length - 1;
      const context = lines.slice(Math.max(0, lineNo - 3), lineNo + 1).join('\n');
      if (context.includes(REAL_GIT_MARKER)) continue;
      offenders.push(`${name}:${lineNo + 1}: ${JSON.stringify(m[0])}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'a locally defined git fake returns a default for every argv it does not recognise, which makes ' +
      'an absent gate indistinguishable from a passing one. Use makeGitFake from ./helpers.mjs, ' +
      'which matches on deep argv equality and throws otherwise. A helper that shells out to REAL ' +
      `git in an integration test is the one exception: mark it \`${REAL_GIT_MARKER}\`.\n` +
      offenders.map((o) => `  ${o}`).join('\n'),
  );
});

test('every test file that injects a git runner imports the shared fake', () => {
  const offenders = [];
  for (const { name, text } of testFiles()) {
    if (!/\brun:\s/.test(text)) continue;
    if (!/\bmakeGitFake\b/.test(text)) offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    `these files inject a \`run:\` but never import makeGitFake:\n${offenders.map((o) => `  ${o}`).join('\n')}`,
  );
});

/** The opt-out, spelled once. A test OF the fake is the only legitimate reason to use it. */
const EXEMPT_MARKER = 'git-fake-not-exhausted';

test('every use of the shared fake asserts its expectations were exhausted', () => {
  // A strict fake catches an argv nobody expected. It cannot catch an expectation nobody used,
  // which is exactly what a silently deleted gate looks like: the test still passes because the
  // refusal it asserts comes from somewhere else, or because nothing was asserted at all.
  const offenders = [];
  for (const { name, text } of testFiles()) {
    const uses = (text.match(/makeGitFake\(/g) ?? []).length;
    if (uses === 0) continue;
    const exhausted = (text.match(/\.assertExhausted\(/g) ?? []).length;
    const exempt = (text.match(new RegExp(EXEMPT_MARKER, 'g')) ?? []).length;
    if (exhausted + exempt < uses) {
      offenders.push(`${name}: ${uses} fake(s), ${exhausted} exhaustion assertion(s), ${exempt} exemption(s)`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'each makeGitFake must be paired with an assertExhausted at the end of its test, or carry the ' +
      `\`${EXEMPT_MARKER}\` comment saying why it is deliberately not exhausted (a test OF the fake ` +
      `is the only legitimate case).\n${offenders.map((o) => `  ${o}`).join('\n')}`,
  );
});
