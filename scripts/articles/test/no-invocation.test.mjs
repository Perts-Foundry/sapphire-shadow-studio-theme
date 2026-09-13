// THE CREDENTIAL BOUNDARY: nothing automated may invoke the article push.
//
// The push writes to the live store. It is authorised by an operator in a session, run by hand, and
// never by CI, a hook, a skill step, a scheduled job or another script. That rule is only worth
// anything if something enforces it, because the failure mode is silent: a workflow step added
// months from now would run with the repository's credentials and nobody would notice until a post
// appeared.
//
// SCOPE IS THE WHOLE POINT. An earlier draft of this idea scanned only validate.yml, which would
// have left deploy.yml, the one workflow that actually holds live credentials, entirely uncovered
// by the mechanism built to cover it. So this walks every file under .github/workflows/,
// .github/actions/, .claude/skills/, scripts/, plus package.json.
//
// BOTH SPELLINGS, because either one runs it: the npm script name and the module path. A command
// assembled from pieces is caught by the module path, which cannot be split without ceasing to be a
// path. The only permitted occurrence in the entire repository is the script key in package.json,
// which is the declaration rather than a call.
//
// A CONSEQUENCE WORTH KNOWING: documentation under these trees cannot spell the command either.
// That is deliberate. A README line is copy-pasteable, and this guard cannot tell a person reading
// docs from a script reading the same bytes.
//
// AND IT IS A MERGE GATE, NOT LEAK PREVENTION. On a public repository anything pushed to any branch
// is already exposed. This stops such a change reaching main; the pre-push checklist is the first
// line, and this is the second.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** This file quotes the forbidden strings, so it is the one file exempt from them. */
const SELF = relative(REPO_ROOT, fileURLToPath(import.meta.url));

/** The trees an automated caller could live in. */
const SCANNED_DIRS = ['.github/workflows', '.github/actions', '.claude/skills', 'scripts'];
const SCANNED_FILES = ['package.json'];

/**
 * The two ways to run the push. Built from pieces so that this file, which must contain them to
 * test for them, does not itself contain either literal: otherwise the guard would have to exempt
 * its own text by a substring match, and any file could evade it by claiming the same exemption.
 */
const NPM_NAME = ['articles', 'push'].join(':');
const MODULE_PATH = ['scripts', 'articles', 'push.mjs'].join('/');

/** Anything that is plausibly text. A binary under these trees is not a caller. */
const TEXT_EXT = new Set(['.yml', '.yaml', '.mjs', '.cjs', '.js', '.json', '.md', '.sh', '.txt', '.html']);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    const dot = name.lastIndexOf('.');
    if (dot !== -1 && TEXT_EXT.has(name.slice(dot))) out.push(full);
  }
  return out;
}

function scannedFiles() {
  const out = [];
  for (const d of SCANNED_DIRS) walk(join(REPO_ROOT, d), out);
  for (const f of SCANNED_FILES) {
    const full = join(REPO_ROOT, f);
    if (existsSync(full)) out.push(full);
  }
  return out.map((f) => relative(REPO_ROOT, f)).sort();
}

/** The one line allowed to carry the npm name: its declaration in package.json. */
function isDeclarationLine(file, line) {
  return file === 'package.json' && line.trim().startsWith(`"${NPM_NAME}"`);
}

test('the guard actually scans something, in every tree it claims to cover', () => {
  // A guard that silently walked nothing would pass forever. Assert coverage before asserting
  // absence, which is the same fail-closed floor the CI guards use.
  const files = scannedFiles();
  assert.ok(files.length > 50, `expected to scan a substantial tree, saw ${files.length} file(s)`);
  for (const dir of SCANNED_DIRS) {
    assert.ok(
      files.some((f) => f.startsWith(`${dir}/`)),
      `${dir}/ contributed no files to the scan; the walk is not reaching it`,
    );
  }
  assert.ok(files.includes('package.json'), 'package.json was not scanned');
});

test('nothing under the scanned trees invokes the article push, by either spelling', () => {
  const offenders = [];
  for (const file of scannedFiles()) {
    if (file === SELF) continue;
    const text = readFileSync(join(REPO_ROOT, file), 'utf8');
    if (!text.includes(NPM_NAME) && !text.includes(MODULE_PATH)) continue;
    for (const [i, line] of text.split('\n').entries()) {
      if (!line.includes(NPM_NAME) && !line.includes(MODULE_PATH)) continue;
      if (isDeclarationLine(file, line)) continue;
      offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'the article push writes to the live store and is invoked by an operator in a session, never ' +
      'by a workflow, a skill step, a hook or another script. The only permitted occurrence is its ' +
      `key in package.json.\n${offenders.join('\n')}`,
  );
});

test('the declaration exemption is exactly one line, and does not generalise', () => {
  // The exemption is the one hole in the guard, so it is pinned: it applies to package.json alone,
  // to a line that STARTS with the quoted key, and to nothing else. A workflow line that merely
  // mentioned the key in passing must not inherit it.
  assert.equal(isDeclarationLine('package.json', `    "${NPM_NAME}": "node ${MODULE_PATH}",`), true);
  assert.equal(isDeclarationLine('package.json', `  run: npm run ${NPM_NAME}`), false);
  assert.equal(isDeclarationLine('.github/workflows/deploy.yml', `    "${NPM_NAME}": "x"`), false);
  assert.equal(isDeclarationLine('package.json', `# see "${NPM_NAME}" below`), false);
});

test('the guard would catch a planted invocation in each shape it is meant to stop', () => {
  // A rule with no positive control is a rule nobody has proved fires. These are the shapes a real
  // caller takes: a direct npm run, a node call on the module, and a command assembled from a
  // variable, which is why the module path is checked as well as the script name.
  const planted = [
    `      - run: npm run ${NPM_NAME}`,
    `      - run: node ${MODULE_PATH} --handle x`,
    `        CMD="npm run ${NPM_NAME}"; $CMD`,
    `  script: |\n    await exec("node ${MODULE_PATH}");`,
  ];
  for (const text of planted) {
    const hit = text.split('\n').some((line) => line.includes(NPM_NAME) || line.includes(MODULE_PATH));
    assert.equal(hit, true, `not caught: ${text}`);
  }
  // And the declaration itself is NOT caught, or package.json could never declare the script.
  assert.equal(isDeclarationLine('package.json', `    "${NPM_NAME}": "node ${MODULE_PATH}",`), true);
});
