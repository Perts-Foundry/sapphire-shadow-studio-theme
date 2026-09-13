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

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OK_MARKER, IMAGE_ROOT_DIR } from '../check.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'validate.yml');

function workflowText() {
  return readFileSync(WORKFLOW, 'utf8');
}

test('the workflow greps for the exact success marker the check script prints', () => {
  // Asserted against the CONSTANT, not against a copy of the string, so renaming the marker in
  // check.mjs fails here rather than silently desynchronising the two files.
  const text = workflowText();
  assert.ok(
    text.includes(`grep -cxF '${OK_MARKER}'`),
    `validate.yml does not grep for the marker verbatim. The check script prints ${JSON.stringify(OK_MARKER)}.`,
  );
});

test('the marker assertion demands EXACTLY one occurrence, not at least one', () => {
  // An at-least-once match passes for a script that printed the marker in a loop, and for a tree
  // whose article bodies happen to contain the string, neither of which proves the comparison ran.
  const text = workflowText();
  assert.match(text, /MARKER_COUNT.*-ne 1/s);
});

test('the articles suite has a zero-test floor, since its script key predates its test files', () => {
  // `node --test <glob>` exits 0 when the glob matches nothing. The key was added before the tests
  // existed, so an empty glob here is a state this repo genuinely passed through.
  const text = workflowText();
  assert.match(text, /articles suite reported .* tests/);
});

test('both articles steps are wired into the final status gate, not only into the comment', () => {
  // The comment table and the gate are separate lists. A step present in the table but absent from
  // the gate renders a red row above a green job, which is the fail-open shape this file exists to
  // prevent.
  const text = workflowText();
  for (const name of ['articles-check', 'articles-tests']) {
    assert.ok(text.includes(`check_exit "${name}"`), `${name} is missing from the final status gate`);
  }
  for (const varName of ['ARTICLES_CHECK_EXIT', 'ARTICLES_TESTS_EXIT']) {
    assert.ok(text.includes(`"$${varName}"`), `${varName} is not classified in the results loop`);
  }
});

test('the tracked-media pathspec is identical in all three places it appears', () => {
  const text = workflowText();
  const occurrences = [...text.matchAll(/git ls-files -- ([^\n]*?)(?:\\?`|"|\)),?/g)].map((m) => m[1].trim());
  assert.ok(occurrences.length >= 3, `expected the pathspec in at least three places, saw ${occurrences.length}`);
  const normalised = new Set(occurrences.map((o) => o.replace(/\s+/g, ' ')));
  assert.equal(
    normalised.size,
    1,
    `the guard, the summary row and the details block must name the same command, saw:\n${[...normalised].join('\n')}`,
  );
});

test('the guard covers the article image directory', () => {
  const text = workflowText();
  assert.ok(text.includes(`'${IMAGE_ROOT_DIR}/'`), `the tracked-media pathspec does not cover ${IMAGE_ROOT_DIR}/`);
});

test('the ignore file and the guard pathspec express the same intent, in their two spellings', () => {
  // They cannot be compared as strings and should not be. A gitignore pattern is matched at every
  // level unless anchored, so it carries a leading slash; a git pathspec is already rooted at the
  // repo top, so it does not. Both must name the same top-level directory.
  const ignoreText = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');
  const workflow = workflowText();
  for (const dir of ['product-images', IMAGE_ROOT_DIR]) {
    assert.ok(
      ignoreText.split('\n').includes(`/${dir}/`),
      `the ignore file must anchor ${dir}/ at the repo root, so it cannot match a like-named nested directory`,
    );
    assert.ok(
      workflow.includes(`'${dir}/'`),
      `the guard pathspec must name ${dir}/ unanchored, since git pathspecs are already rooted at the repo top`,
    );
  }
});

test('the articles check step is offline, taking no credential from the environment', () => {
  // The whole point of the offline check is that it runs on every PR, including Dependabot PRs,
  // which get a separate secrets scope. A step that needed a Shopify credential would fail
  // unfixably on all of them.
  const text = workflowText();
  const step = text.slice(text.indexOf('id: articles-check'), text.indexOf('id: articles-tests'));
  for (const secret of ['SHOPIFY', 'secrets.']) {
    assert.equal(step.includes(secret), false, `the articles check step references ${secret}`);
  }
});
