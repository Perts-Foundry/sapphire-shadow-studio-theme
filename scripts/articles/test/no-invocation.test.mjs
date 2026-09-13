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
// by the mechanism built to cover it. So this walks every regular file under .github/workflows/,
// .github/actions/, scripts/, and every .claude/ tree an automated caller could live in (skills,
// hooks, commands, rules, agents, and the two settings files), plus package.json. EVERY file, not a
// list of text extensions: a hook script with no extension runs just as well as one with `.sh`.
// Only a file with a NUL byte in its first 8KB is skipped, as binary.
//
// THREE SPELLINGS, because any of them runs it: the npm script name, the module path, and a relative
// import that resolves to the module. The first two are text matches. They are NOT a complete
// defence: a command assembled at runtime from pieces (a variable holding `articles`, another
// holding the action) contains neither literal, and no static scan can see it. That gap is known
// and tracked; the push module refusing non-interactive callers is the answer to it, not a cleverer
// pattern here. The third spelling is resolved rather than matched, because `import('../push.mjs')`
// from the test directory contains no occurrence of the full module path at all.
//
// The only permitted occurrence in the entire repository is the script key in package.json, and its
// value is pinned exactly, so the declaration cannot quietly grow a second command after `&&`.
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
import { existsSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { exportFromsOf, importsOf } from '../../lib/import-closure.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** This file quotes the forbidden strings, so it is the one file exempt from them. */
const SELF = relative(REPO_ROOT, fileURLToPath(import.meta.url)).split(sep).join('/');

/** The trees an automated caller could live in. Existence-tolerant: not every checkout has each. */
const SCANNED_DIRS = [
  '.github/workflows',
  '.github/actions',
  '.claude/skills',
  '.claude/hooks',
  '.claude/commands',
  '.claude/rules',
  '.claude/agents',
  'scripts',
];
const SCANNED_FILES = ['package.json', '.claude/settings.json', '.claude/settings.local.json'];

/**
 * The two ways to name the push. Built from pieces so that this file, which must contain them to
 * test for them, does not itself contain either literal: otherwise the guard would have to exempt
 * its own text by a substring match, and any file could evade it by claiming the same exemption.
 */
const NPM_NAME = ['articles', 'push'].join(':');
const MODULE_PATH = ['scripts', 'articles', 'push.mjs'].join('/');

/** Files whose imports are resolved as well as text-scanned. */
const MODULE_EXTENSIONS = ['.mjs', '.cjs', '.js'];

/** True when the first 8KB of a file hold a NUL byte, which is how git itself decides "binary". */
function looksBinary(full) {
  const fd = openSync(full, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    // A symlink is followed to a file but never to a directory, so a link cycle cannot hang the walk.
    const stat = entry.isSymbolicLink() ? statSync(full) : null;
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() || stat?.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/** Every scanned file as `{ path, text }`, path repo-relative with forward slashes, sorted. */
function scannedFiles() {
  const out = [];
  for (const d of SCANNED_DIRS) walk(join(REPO_ROOT, d), out);
  for (const f of SCANNED_FILES) {
    const full = join(REPO_ROOT, f);
    if (existsSync(full)) out.push(full);
  }
  return out
    .filter((full) => !looksBinary(full))
    .map((full) => ({ path: relative(REPO_ROOT, full).split(sep).join('/'), text: readFileSync(full, 'utf8') }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The one line allowed to carry the npm name: its declaration in package.json, with its value
 * pinned to exactly `node <module path>`.
 */
function isDeclarationLine(file, line) {
  if (file !== 'package.json') return false;
  const declaration = `"${NPM_NAME}": "node ${MODULE_PATH}"`;
  const trimmed = line.trim();
  return trimmed === declaration || trimmed === `${declaration},`;
}

/** Every module specifier a source file names: static, `export ... from`, and dynamic import calls. */
function specifiersOf(source) {
  // importsOf and exportFromsOf cover the static forms. Neither returns the specifier of a dynamic
  // `import('...')` call (the closure walker only detects one, to refuse it), so that form is
  // extracted here.
  const dynamic = [...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  return [...importsOf(source), ...exportFromsOf(source), ...dynamic];
}

/**
 * Every place a set of files invokes the push, as `path:line: text` strings.
 *
 * PURE, and the ONLY implementation. The real scan and every planted control go through this same
 * function, so a control cannot pass against a private re-implementation while the scan itself has
 * stopped matching.
 *
 * @param {Array<{path: string, text: string}>} files - repo-relative forward-slash paths
 */
export function findOffenders(files) {
  const offenders = [];
  for (const { path, text } of files) {
    if (path === SELF) continue;
    if (text.includes(NPM_NAME) || text.includes(MODULE_PATH)) {
      for (const [i, line] of text.split('\n').entries()) {
        if (!line.includes(NPM_NAME) && !line.includes(MODULE_PATH)) continue;
        if (isDeclarationLine(path, line)) continue;
        offenders.push(`${path}:${i + 1}: ${line.trim().slice(0, 120)}`);
      }
    }
    if (MODULE_EXTENSIONS.some((ext) => path.endsWith(ext))) {
      for (const spec of specifiersOf(text)) {
        if (!spec.startsWith('.')) continue;
        if (posix.normalize(posix.join(posix.dirname(path), spec)) === MODULE_PATH) {
          offenders.push(`${path}: imports ${spec}, which resolves to the article push module`);
        }
      }
    }
  }
  return offenders;
}

test('the guard actually scans something, in every tree it claims to cover that exists', () => {
  // A guard that silently walked nothing would pass forever. Assert coverage before asserting
  // absence, which is the same fail-closed floor the CI guards use. A tree that does not exist in
  // this checkout (there is no .claude/hooks/ today) is not required; a tree that exists and
  // contributes nothing is the walk failing.
  const files = scannedFiles().map((f) => f.path);
  assert.ok(files.length > 50, `expected to scan a substantial tree, saw ${files.length} file(s)`);
  for (const dir of SCANNED_DIRS) {
    if (!existsSync(join(REPO_ROOT, dir))) continue;
    assert.ok(
      files.some((f) => f.startsWith(`${dir}/`)),
      `${dir}/ exists but contributed no files to the scan; the walk is not reaching it`,
    );
  }
  for (const file of SCANNED_FILES) {
    if (existsSync(join(REPO_ROOT, file))) assert.ok(files.includes(file), `${file} exists but was not scanned`);
  }
  assert.ok(files.includes('package.json'), 'package.json was not scanned');
  assert.ok(files.includes(SELF), 'this file was not walked, so the self-exemption is untested');
});

test('nothing under the scanned trees invokes the article push, by any spelling', () => {
  const offenders = findOffenders(scannedFiles());
  assert.deepEqual(
    offenders,
    [],
    'the article push writes to the live store and is invoked by an operator in a session, never ' +
      'by a workflow, a skill step, a hook or another script. The only permitted occurrence is its ' +
      `key in package.json.\n${offenders.join('\n')}`,
  );
});

test('package.json declares the push with exactly the pinned value', () => {
  // The exemption is only safe if what it exempts is fixed. A declaration line reading
  // `node <module> && something-else` would otherwise ride through on its key.
  const lines = readFileSync(join(REPO_ROOT, 'package.json'), 'utf8').split('\n').filter((l) => l.includes(NPM_NAME));
  assert.equal(lines.length, 1, 'expected exactly one package.json line naming the push');
  assert.equal(isDeclarationLine('package.json', lines[0]), true, `the declaration is not exactly the pinned value: ${lines[0].trim()}`);
});

test('the declaration exemption is exactly one line, and does not generalise', () => {
  // The exemption is the one hole in the guard, so it is pinned: it applies to package.json alone,
  // to a line that IS the declaration, and to nothing else.
  assert.equal(isDeclarationLine('package.json', `    "${NPM_NAME}": "node ${MODULE_PATH}",`), true);
  assert.equal(isDeclarationLine('package.json', `    "${NPM_NAME}": "node ${MODULE_PATH}"`), true);
  assert.equal(isDeclarationLine('package.json', `    "${NPM_NAME}": "node ${MODULE_PATH} && curl x",`), false);
  assert.equal(isDeclarationLine('package.json', `  run: npm run ${NPM_NAME}`), false);
  assert.equal(isDeclarationLine('.github/workflows/deploy.yml', `    "${NPM_NAME}": "node ${MODULE_PATH}",`), false);
  assert.equal(isDeclarationLine('package.json', `# see "${NPM_NAME}" below`), false);
});

test('the guard catches a planted invocation in each shape it is meant to stop', () => {
  // A rule with no positive control is a rule nobody has proved fires. Every control goes through
  // findOffenders itself, at a realistic path, so the real function is what is proved.
  const up = '..';
  const planted = [
    { path: '.github/workflows/x.yml', text: `      - run: npm run ${NPM_NAME}` },
    { path: '.github/workflows/x.yml', text: `      - run: node ${MODULE_PATH} --handle x` },
    { path: '.claude/hooks/on-stop', text: `        CMD="npm run ${NPM_NAME}"; $CMD` },
    { path: '.github/actions/x/action.yml', text: `  script: |\n    await exec("node ${MODULE_PATH}");` },
    { path: 'scripts/articles/test/x.test.mjs', text: `import { main } from '${up}/push.mjs';\n` },
    { path: 'scripts/foo/x.mjs', text: `const m = await import('${up}/articles/push.mjs');\n` },
    { path: 'scripts/articles/lib/x.mjs', text: `import {\n  main,\n} from '${up}/push.mjs';\n` },
  ];
  for (const file of planted) {
    assert.equal(findOffenders([file]).length > 0, true, `not caught: ${file.path}: ${file.text}`);
  }
  // A relative import that resolves ELSEWHERE is not an offender, or every sibling import would be.
  assert.deepEqual(findOffenders([{ path: 'scripts/foo/x.mjs', text: `import { x } from './push.mjs';\n` }]), []);
  // And the declaration itself is NOT caught, or package.json could never declare the script.
  assert.deepEqual(findOffenders([{ path: 'package.json', text: `    "${NPM_NAME}": "node ${MODULE_PATH}",\n` }]), []);
  // The self-exemption is by exact path, not by content.
  assert.deepEqual(findOffenders([{ path: SELF, text: `npm run ${NPM_NAME}` }]), []);
  assert.equal(findOffenders([{ path: `${SELF}.copy`, text: `npm run ${NPM_NAME}` }]).length, 1);
});
