// The CI wiring, asserted from the repository rather than trusted.
//
// WHY THESE ARE TESTS AND NOT REVIEW NOTES. Each of them protects a property whose failure is
// SILENT: the workflow keeps running, the PR comment keeps rendering, and the thing that stopped
// being checked stops being checked without a red mark anywhere.
//
//   - The success marker is a string in two files. Change it in the script and the workflow's
//     grep matches nothing, so `articles:check` passes while the step reports a failure; change it
//     in the workflow and a passing check reads as broken. Either way the signal is wrong.
//   - The tracked-media pathspec appears THREE times: the guard that runs it, the summary row that
//     names it, and the details block that names it again. Extending only the guard leaves the PR
//     comment claiming a command that is not the one that ran, which is a lie a reviewer would
//     reasonably believe.
//   - The gitignore entry and the pathspec are deliberately spelled differently, so they cannot be
//     compared as strings. What must hold is the INTENT: the same top-level directory is both
//     ignored and refused if tracked.
//
// SCOPED TO THE STEP. Every assertion about a step reads that step's own slice of the file, from its
// `- name:` line to the next one. The first version matched against the whole workflow, where
// `MARKER_COUNT.*-ne 1` with a dot-all flag would match a MARKER_COUNT in one step and a `-ne 1` in
// any other, and the policy steps above carry both. There is no YAML parser in this repo's
// dependencies and this suite does not add one, so the slice is taken by the fixed indentation the
// workflow already uses for every step.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OK_MARKER, IMAGE_ROOT_DIR } from '../check.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'validate.yml');

const STEP_PREFIX = '      - name: ';

function workflowText() {
  return readFileSync(WORKFLOW, 'utf8');
}

/** One step's text, from its `- name:` line up to (not including) the next step's. */
function stepSlice(text, name) {
  const start = text.indexOf(`\n${STEP_PREFIX}${name}\n`);
  assert.notEqual(start, -1, `validate.yml has no step named "${name}"`);
  const next = text.indexOf(`\n${STEP_PREFIX}`, start + 1);
  const slice = text.slice(start + 1, next === -1 ? text.length : next + 1);
  assert.ok(slice.trim().length > STEP_PREFIX.length + name.length, `the "${name}" step slice is empty`);
  return slice;
}

test('the articles steps exist in the expected order', () => {
  const text = workflowText();
  const order = ['Blog article check', 'Blog article tests', 'Tracked media guard', 'Collect results', 'Check for failures'].map((name) => {
    stepSlice(text, name);
    return text.indexOf(`\n${STEP_PREFIX}${name}\n`);
  });
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'the steps are out of order');
  assert.match(stepSlice(text, 'Blog article check'), /^\s+id: articles-check$/m);
  assert.match(stepSlice(text, 'Blog article tests'), /^\s+id: articles-tests$/m);
});

test('the check step greps for the exact success marker the check script prints', () => {
  // Asserted against the CONSTANT, not against a copy of the string, so renaming the marker in
  // check.mjs fails here rather than silently desynchronising the two files.
  const step = stepSlice(workflowText(), 'Blog article check');
  assert.ok(
    step.includes(`grep -cxF '${OK_MARKER}'`),
    `the articles check step does not grep for the marker verbatim. The check script prints ${JSON.stringify(OK_MARKER)}.`,
  );
});

test('the marker assertion demands EXACTLY one occurrence, on one line of the check step', () => {
  // An at-least-once match passes for a script that printed the marker in a loop, and for a tree
  // whose article bodies happen to contain the string, neither of which proves the comparison ran.
  const step = stepSlice(workflowText(), 'Blog article check');
  const lines = step.split('\n').filter((l) => l.includes('MARKER_COUNT') && /-ne 1\b/.test(l));
  assert.equal(lines.length, 1, 'no single line compares MARKER_COUNT with -ne 1');
});

test('the articles suite has a zero-test floor, since its script key predates its test files', () => {
  // `node --test <glob>` exits 0 when the glob matches nothing. The key was added before the tests
  // existed, so an empty glob here is a state this repo genuinely passed through.
  const step = stepSlice(workflowText(), 'Blog article tests');
  const floor = step.match(/TESTS_RUN:-0\}" -lt (\d+)/);
  assert.ok(floor, 'the tests step has no -lt floor on TESTS_RUN');
  assert.ok(Number(floor[1]) >= 1, `the floor is ${floor[1]}, which lets an empty suite pass`);
});

test('every steps.<id>.outputs reference to an articles step names an id that exists', () => {
  // A misspelt id reads as an empty string in Actions, which the results loop classifies as a skip
  // rather than a failure: the fail-open shape this suite exists to catch.
  const text = workflowText();
  const refs = [...new Set([...text.matchAll(/steps\.(articles-[a-z-]+)\.outputs/g)].map((m) => m[1]))];
  assert.ok(refs.length >= 2, `expected references to both articles steps, saw ${refs.join(', ')}`);
  for (const id of refs) {
    assert.match(text, new RegExp(`^\\s+id: ${id}$`, 'm'), `steps.${id}.outputs names no step id`);
  }
});

test('both articles steps are wired into the final status gate, not only into the comment', () => {
  // The comment table and the gate are separate lists. A step present in the table but absent from
  // the gate renders a red row above a green job, which is the fail-open shape this file exists to
  // prevent.
  const text = workflowText();
  const gate = stepSlice(text, 'Check for failures');
  for (const name of ['articles-check', 'articles-tests']) {
    assert.ok(gate.includes(`check_exit "${name}"`), `${name} is missing from the final status gate`);
  }
  const collect = stepSlice(text, 'Collect results');
  for (const varName of ['ARTICLES_CHECK_EXIT', 'ARTICLES_TESTS_EXIT']) {
    assert.ok(collect.includes(`"$${varName}"`), `${varName} is not classified in the results loop`);
  }
});

test('the tracked-media pathspec is identical in all three places it appears', () => {
  // Captured through the closing `*.heic'`, so a pathspec extended past it in one place only is a
  // difference rather than a shared prefix.
  const text = workflowText();
  const occurrences = [...text.matchAll(/git ls-files -- ('[^\n]*?\*\.heic')/g)].map((m) => m[1]);
  assert.equal(occurrences.length, 3, `expected the pathspec in exactly three places, saw ${occurrences.length}`);
  for (const o of occurrences) assert.ok(o.endsWith("*.heic'"), o);
  assert.equal(
    new Set(occurrences).size,
    1,
    `the guard, the summary row and the details block must name the same command, saw:\n${occurrences.join('\n')}`,
  );
});

test('the tracked-media guard step itself covers the article image directory', () => {
  const step = stepSlice(workflowText(), 'Tracked media guard');
  assert.ok(step.includes(`'${IMAGE_ROOT_DIR}/'`), `the tracked-media guard does not cover ${IMAGE_ROOT_DIR}/`);
});

test('the ignore file and the guard pathspec express the same intent, in their two spellings', () => {
  // They cannot be compared as strings and should not be. A gitignore pattern is matched at every
  // level unless anchored, so it carries a leading slash; a git pathspec is already rooted at the
  // repo top, so it does not. Both must name the same top-level directory.
  const ignoreText = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');
  const guard = stepSlice(workflowText(), 'Tracked media guard');
  for (const dir of ['product-images', IMAGE_ROOT_DIR]) {
    assert.ok(
      ignoreText.split('\n').includes(`/${dir}/`),
      `the ignore file must anchor ${dir}/ at the repo root, so it cannot match a like-named nested directory`,
    );
    assert.ok(
      guard.includes(`'${dir}/'`),
      `the guard pathspec must name ${dir}/ unanchored, since git pathspecs are already rooted at the repo top`,
    );
  }
});

test('the articles check step is offline, taking no credential from the environment', () => {
  // The whole point of the offline check is that it runs on every PR, including Dependabot PRs,
  // which get a separate secrets scope. A step that needed a Shopify credential would fail
  // unfixably on all of them.
  const step = stepSlice(workflowText(), 'Blog article check');
  for (const secret of ['SHOPIFY', 'secrets.']) {
    assert.equal(step.includes(secret), false, `the articles check step references ${secret}`);
  }
});
