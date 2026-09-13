// TEST SUPPORT. The strict git fake every git-backed gate in this repo is tested with.
//
// WHY IT IS SHARED. It was written for shop policies (scripts/policies/test/helpers.mjs), after PR
// #154 shipped two tests that passed vacuously against a permissive fake. The article push has the
// same kind of gate (a dirty-tree check and an ancestor check) and needs the same guarantee. A second
// copy would be a second place for the matching rule to be loosened, and the test-hygiene rules in
// scripts/lib/test-hygiene.mjs name this module's function as the only thing a test may inject, so
// both subsystems import it from here. The policies helpers re-export these bindings unchanged.

/**
 * Thrown when a git-backed gate invokes an argv no expectation covers.
 *
 * A distinctive class, not a bare Error: every gate under test refuses by throwing, and a
 * permissive fake's "" return is indistinguishable from "git said the tree is clean". A test that
 * catches this class by accident (`assert.throws(fn, /refusal/)`) still fails, because the message
 * names the argv rather than the refusal.
 */
export class UnexpectedGitInvocation extends Error {
  constructor(argv, known) {
    super(
      `the git fake was invoked with an argv no expectation covers:\n  ${JSON.stringify(argv)}\n` +
        `registered:\n${known.map((a) => `  ${JSON.stringify(a)}`).join('\n') || '  (none)'}`,
    );
    this.name = 'UnexpectedGitInvocation';
    this.argv = argv;
  }
}

/**
 * Every fake built in this process, so exhaustion can be checked at RUNTIME rather than by counting
 * text. A textual rule cannot follow a file-level factory (`cleanGit`, `noGit`) into the tests that
 * call it. `node --test` runs each test file in its own process, so this is per file.
 */
const REGISTERED = [];

function sameArgv(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * A STRICT fake for a git runner `(root, args) => stdout`.
 *
 * Matching is DEEP EQUALITY OF THE FULL ARGV ARRAY, and nothing else. `includes`, `join(' ')` and
 * regex matching are deliberately impossible here: PR #154 shipped two tests that passed
 * vacuously because a fake matched a bare filename (`a.endsWith('*.html')`) against production
 * code that emits a full pathspec, so the tests proved the fake's own shape rather than the
 * gate's. Deep equality means the expectation IS the argv production code has to emit.
 *
 * An unrecognised invocation throws `UnexpectedGitInvocation` rather than returning a default.
 * A default return is what makes an absent gate look like a passing one.
 *
 * `assertExhausted` closes the other half: a strict fake catches an argv nobody expected, but not
 * an expectation nobody used, which is how a gate that was silently removed keeps its test green.
 *
 * @param {Array<{args: string[], result?: string, throws?: Error|string}>} expectations
 *        `result` is what git prints (trimmed by production code); `throws` makes the invocation
 *        fail the way `execFileSync` does on a non-zero exit.
 * @param {object} [options]
 * @param {boolean} [options.exhaustive]  false for a fake deliberately left unused (a test OF the
 *        fake, or a gate the test asserts is never reached). Must carry `why`.
 * @param {string} [options.why]  required with `exhaustive: false`, so an opt-out is a sentence a
 *        reviewer reads rather than a flag someone added to make a failure go away.
 * @param {Function} [options.onCall]  called with a copy of each argv before it is matched; its
 *        return value is ignored.
 */
export function makeGitFake(expectations, { exhaustive = true, why = null, onCall = null } = {}) {
  if (!Array.isArray(expectations)) throw new TypeError('makeGitFake takes an array of expectations');
  if (!exhaustive && (typeof why !== 'string' || why.trim() === '')) {
    throw new TypeError('makeGitFake({ exhaustive: false }) needs a `why` saying which gate is deliberately not reached');
  }
  const table = expectations.map((e, i) => {
    if (!Array.isArray(e.args)) throw new TypeError(`expectation ${i} has no args array`);
    if (e.result !== undefined && typeof e.result !== 'string') {
      throw new TypeError(`expectation ${i}: result must be the string git would print`);
    }
    if (e.result === undefined && e.throws === undefined) {
      throw new TypeError(`expectation ${i}: give it a result or a throws`);
    }
    return { args: e.args, result: e.result, throws: e.throws, used: 0 };
  });

  const calls = [];
  const run = (root, args) => {
    const argv = [...args];
    calls.push({ root, args: argv });
    // Observation only, never a response: a suite that orders git calls against other events (the
    // article push's gate-order test) records them here. It cannot change what the fake answers.
    if (typeof onCall === 'function') onCall([...argv]);
    const hit = table.find((e) => sameArgv(e.args, argv));
    if (!hit) throw new UnexpectedGitInvocation(argv, table.map((e) => e.args));
    hit.used++;
    if (hit.throws !== undefined) {
      throw hit.throws instanceof Error ? hit.throws : new Error(String(hit.throws));
    }
    return hit.result;
  };

  run.calls = calls;
  run.exhaustive = exhaustive;
  run.why = why;
  REGISTERED.push(run);
  /** The expectations nobody invoked. Empty when the gate under test made every call. */
  run.unusedExpectations = () => table.filter((e) => e.used === 0).map((e) => e.args);

  /** Every registered expectation must have been used at least once. Assert this at teardown. */
  run.assertExhausted = (assert, message = 'git expectations') => {
    const unused = run.unusedExpectations();
    assert.deepEqual(
      unused,
      [],
      `${message}: ${unused.length} expectation(s) were never invoked, so the gate that would have ` +
        'invoked them did not run:\n' + unused.map((a) => `  ${JSON.stringify(a)}`).join('\n'),
    );
  };
  return run;
}

/**
 * Assert that every fake this file built had all of its expectations invoked. Call it from an
 * `after()` hook; the shared test-hygiene rules require every file building fakes to do so.
 */
export function assertAllGitFakesExhausted(assert) {
  const unused = [];
  for (const fake of REGISTERED) {
    if (!fake.exhaustive) continue;
    for (const args of fake.unusedExpectations()) unused.push(JSON.stringify(args));
  }
  assert.deepEqual(
    unused,
    [],
    `${unused.length} git expectation(s) were registered and never invoked, so the gate that would ` +
      'have invoked them did not run. If a fake is deliberately never reached, build it with ' +
      `{ exhaustive: false, why: '...' }.\n${unused.map((a) => `  ${a}`).join('\n')}`,
  );
}
