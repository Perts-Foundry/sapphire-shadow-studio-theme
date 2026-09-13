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
// defence: a command assembled at runtime from pieces contains neither literal, and no static scan
// can see it. The push module itself refuses to run with CI present, checked from its injected
// environment, so this scan is the second line and not the only one. The third spelling is resolved
// rather than matched, because `import('../push.mjs')` from the test directory contains no occurrence
// of the full module path at all.
//
// The only permitted TEXT occurrence in the entire repository is the script key in package.json, and
// its value is pinned exactly, so the declaration cannot quietly grow a second command after `&&`.
//
// THE ONE PERMITTED IMPORT: the push's own tests. Its gates are the product, and a gate nobody has
// proved is a gate nobody knows exists, so the gate suite and the real-git integration test must
// import the module. They are exempt from the import rule ONLY, by EXACT repo-relative path, listed in
// EXEMPT_IMPORTERS with a reason each. The exemption cannot widen: it is an equality test against a
// frozen list, a test pins the list's exact contents and length, and a planted control proves that
// any other file in the same directory importing the push is still an offender. A new test file is
// never exempt by where it lives or what it is called.
//
// AN EXEMPT FILE IS HELD TO MORE, NOT LESS. It may import the gate functions and `run`, and nothing
// that reaches a real store: it must not import or call `main`, import the module as a namespace or
// dynamically, name `createAdminClient`, read `process.env`, or call `createContext` without an
// explicit `client:`. And the text spellings still apply to it: an exempt file spelling the npm name
// or the module path is an offender like any other.
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
import { existsSync, mkdtempSync, openSync, readFileSync, readSync, closeSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { exportFromsOf, importClosure, importsOf } from '../../lib/import-closure.mjs';

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

/**
 * The only files that may import the push module, by EXACT path. Frozen, and pinned by a test.
 */
export const EXEMPT_IMPORTERS = Object.freeze([
  Object.freeze({
    path: 'scripts/articles/test/push.test.mjs',
    why: 'the gate suite: every gate is proved against a recording fake client and the strict git fake',
  }),
  Object.freeze({
    path: 'scripts/articles/test/git-integration.test.mjs',
    why: 'the reviewed-tree gate against real git, whose pathspecs no fake can prove',
  }),
]);

const EXEMPT_PATHS = Object.freeze(EXEMPT_IMPORTERS.map((e) => e.path));

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
  const dynamic = [...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  return [...importsOf(source), ...exportFromsOf(source), ...dynamic];
}

/** Does a relative specifier, named from `path`, resolve to the push module? */
function resolvesToPush(path, spec) {
  return spec.startsWith('.') && posix.normalize(posix.join(posix.dirname(path), spec)) === MODULE_PATH;
}

const PUSH_FILE = MODULE_PATH.split('/').pop();
const ARTICLES_SEGMENT = MODULE_PATH.split('/')[1];
const ARTICLES_DIR_PATH = posix.dirname(MODULE_PATH);

/**
 * Every single-line string literal in module code, with its line, import and `export ... from`
 * clauses removed first (the import rule owns those, and an exempt file's own import is allowed).
 * Template literals count when they hold no substitution.
 */
function stringLiterals(code) {
  const lines = code.split('\n');
  const out = [];
  let inImport = false;
  for (const [i, line] of lines.entries()) {
    // A multi-line import clause runs until the line naming its specifier.
    if (/^\s*(?:import|export)\b/.test(line) && !/\bfrom\s*['"]/.test(line) && /[{,]\s*$/.test(line)) inImport = true;
    if (inImport || /^\s*import\b/.test(line) || /^\s*export\b[^\n]*\bfrom\s*['"]/.test(line)) {
      if (/\bfrom\s*['"][^'"]+['"]/.test(line) || /^\s*import\s*['"]/.test(line)) inImport = false;
      continue;
    }
    for (const m of line.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`([^`$\\]*)`/g)) {
      out.push({ value: m[1] ?? m[2] ?? m[3], line: i + 1, text: line });
    }
  }
  return out;
}

/**
 * Places a module under scripts/ BUILDS A PATH to the push rather than importing it: the shapes a
 * spawn, an exec or a `new URL` would use, which contain neither the npm name nor the full module path.
 *
 *   a relative literal ending in the filename that resolves to the push   new URL('../push.mjs', import.meta.url)
 *   a literal ending in `articles/push.mjs`                               'scripts/articles/push.mjs' in pieces
 *   the bare filename beside an `articles` literal, in one call or line   join(ROOT, 'scripts', 'articles', 'push.mjs')
 *   the bare filename beside a `..` literal, from under scripts/articles/  join(TEST_DIR, '..', 'push.mjs')
 *   the bare filename in a module directly in scripts/articles/            join(HERE, 'push.mjs')
 *
 * Files elsewhere naming their OWN push.mjs (scripts/policies/) are not caught: the bare name is only
 * an offence with evidence that it is this directory's.
 *
 * @param {{path: string, text: string}} file
 */
export function pathLiteralOffenders({ path, text }) {
  if (!path.startsWith('scripts/') || !MODULE_EXTENSIONS.some((ext) => path.endsWith(ext))) return [];
  const code = stripComments(text);
  const literals = stringLiterals(code);
  const out = [];
  const inArticles = path.startsWith(`${ARTICLES_DIR_PATH}/`);
  const directlyInArticles = posix.dirname(path) === ARTICLES_DIR_PATH;
  const groups = [
    ...[...literals.reduce((m, l) => m.set(l.line, [...(m.get(l.line) ?? []), l.value]), new Map()).entries()].map(([line, values]) => ({ where: `line ${line}`, values })),
    ...['join', 'resolve', 'URL'].flatMap((name) => callArguments(code, name).map((args) => ({ where: `${name}(...)`, values: stringLiterals(args).map((l) => l.value) }))),
  ];
  for (const { value, line } of literals) {
    if (!value.endsWith(PUSH_FILE)) continue;
    if (value !== PUSH_FILE) {
      if (resolvesToPush(path, value) || value.endsWith(`${ARTICLES_SEGMENT}/${PUSH_FILE}`)) {
        out.push(`${path}:${line}: builds a path to the article push module from ${JSON.stringify(value)}`);
      }
    } else if (directlyInArticles) {
      out.push(`${path}:${line}: names the article push module's file beside it`);
    }
  }
  for (const { where, values } of groups) {
    if (!values.includes(PUSH_FILE)) continue;
    if (values.includes(ARTICLES_SEGMENT)) out.push(`${path}: ${where} joins "${ARTICLES_SEGMENT}" with "${PUSH_FILE}"`);
    else if (inArticles && values.includes('..')) out.push(`${path}: ${where} reaches "${PUSH_FILE}" through ".." from ${ARTICLES_DIR_PATH}/`);
  }
  return [...new Set(out)];
}

/**
 * What an exempt importer's HELPERS must not do. The exempt file itself is held to
 * `exemptFileViolations`; every other module its import closure loads, except the push module and
 * the push's own closure (which is production and legitimately builds the real client in `main`),
 * must not name `createAdminClient` or read `process.env`. Without this, an exempt test could keep
 * its own text clean and reach the store through a helper it imports.
 *
 * @param {{entry: string, skip: string[]}} o  absolute paths
 * @returns {Promise<string[]>}
 */
export async function closureViolations({ entry, skip }) {
  const { files } = await importClosure(entry);
  const skipped = new Set(skip);
  const out = [];
  for (const file of files) {
    if (file === entry || skipped.has(file)) continue;
    const code = stripComments(readFileSync(file, 'utf8'));
    const where = relative(REPO_ROOT, file).split(sep).join('/');
    if (/\bcreateAdminClient\b/.test(code)) out.push(`${where}: names createAdminClient`);
    if (/\bprocess\s*(?:\.\s*env\b|\[)/.test(code)) out.push(`${where}: reads process.env`);
  }
  return out;
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
    // A built path is not an import: exempt files are held to this rule like every other module.
    offenders.push(...pathLiteralOffenders({ path, text }));
    if (MODULE_EXTENSIONS.some((ext) => path.endsWith(ext))) {
      // EXACT equality against the frozen list, and for the import rule only.
      if (EXEMPT_PATHS.includes(path)) continue;
      for (const spec of specifiersOf(text)) {
        if (resolvesToPush(path, spec)) {
          offenders.push(`${path}: imports ${spec}, which resolves to the article push module`);
        }
      }
    }
  }
  return offenders;
}

/** Comments removed, strings kept: import specifiers live in strings, and names in code. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/** The argument text of every `name(` call, parentheses balanced. */
function callArguments(code, name) {
  const out = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  for (const m of code.matchAll(re)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') depth--;
    }
    out.push(code.slice(start, i - 1));
  }
  return out;
}

/**
 * What an exempt importer must not do, as violation strings. Empty means it holds to the rules.
 *
 * @param {{path: string, text: string}} file
 */
export function exemptFileViolations({ path, text }) {
  const out = [];
  const code = stripComments(text);
  for (const m of code.matchAll(/^import\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"];?\s*$/gm)) {
    if (!resolvesToPush(path, m[2])) continue;
    const clause = m[1].trim();
    if (!clause.startsWith('{') || !clause.endsWith('}')) {
      out.push(`${path}: imports the push module as a namespace or default (${clause}); name each gate function instead`);
      continue;
    }
    const names = clause.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.split(/\s+as\s+/)[0]);
    if (names.includes('main')) out.push(`${path}: imports main from the push module`);
  }
  for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (resolvesToPush(path, m[1])) out.push(`${path}: imports the push module dynamically`);
  }
  if (/\bmain\s*\(/.test(code)) out.push(`${path}: calls main(`);
  if (/\bcreateAdminClient\b/.test(code)) out.push(`${path}: names createAdminClient`);
  if (/\bprocess\s*(?:\.\s*env\b|\[)/.test(code)) out.push(`${path}: reads process.env`);
  for (const args of callArguments(code, 'createContext')) {
    if (!/\bclient\s*:/.test(args)) out.push(`${path}: calls createContext without an explicit client`);
  }
  return out;
}

test('the guard actually scans something, in every tree it claims to cover that exists', () => {
  // A guard that silently walked nothing would pass forever. Assert coverage before asserting
  // absence, which is the same fail-closed floor the CI guards use.
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
  for (const path of EXEMPT_PATHS) assert.ok(files.includes(path), `the exempt importer ${path} was not walked`);
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
  const lines = readFileSync(join(REPO_ROOT, 'package.json'), 'utf8').split('\n').filter((l) => l.includes(NPM_NAME));
  assert.equal(lines.length, 1, 'expected exactly one package.json line naming the push');
  assert.equal(isDeclarationLine('package.json', lines[0]), true, `the declaration is not exactly the pinned value: ${lines[0].trim()}`);
});

test('the declaration exemption is exactly one line, and does not generalise', () => {
  assert.equal(isDeclarationLine('package.json', `    "${NPM_NAME}": "node ${MODULE_PATH}",`), true);
  assert.equal(isDeclarationLine('package.json', `    "${NPM_NAME}": "node ${MODULE_PATH}"`), true);
  assert.equal(isDeclarationLine('package.json', `    "${NPM_NAME}": "node ${MODULE_PATH} && curl x",`), false);
  assert.equal(isDeclarationLine('package.json', `  run: npm run ${NPM_NAME}`), false);
  assert.equal(isDeclarationLine('.github/workflows/deploy.yml', `    "${NPM_NAME}": "node ${MODULE_PATH}",`), false);
  assert.equal(isDeclarationLine('package.json', `# see "${NPM_NAME}" below`), false);
});

test('the import exemption is exactly two pinned paths, each with a reason', () => {
  // The exemption is the one hole in the import rule, so its contents are pinned, not just its size.
  assert.deepEqual(EXEMPT_PATHS, ['scripts/articles/test/push.test.mjs', 'scripts/articles/test/git-integration.test.mjs']);
  assert.equal(EXEMPT_IMPORTERS.length, 2);
  assert.ok(Object.isFrozen(EXEMPT_IMPORTERS));
  for (const entry of EXEMPT_IMPORTERS) {
    assert.ok(Object.isFrozen(entry));
    assert.ok(typeof entry.why === 'string' && entry.why.length > 20, `${entry.path} carries no reason`);
    assert.ok(existsSync(join(REPO_ROOT, entry.path)), `${entry.path} is exempt but does not exist`);
  }
});

test('every exempt importer holds to the rules an exempt file is held to', () => {
  const byPath = new Map(scannedFiles().map((f) => [f.path, f]));
  const violations = EXEMPT_PATHS.flatMap((path) => exemptFileViolations(byPath.get(path)));
  assert.deepEqual(violations, [], violations.join('\n'));
  // And each one really does import the module, or it should not be on the list.
  for (const path of EXEMPT_PATHS) {
    assert.ok(specifiersOf(byPath.get(path).text).some((s) => resolvesToPush(path, s)), `${path} is exempt but imports nothing from the push`);
  }
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
    // The sibling commands never import the push; shared code belongs in lib/.
    { path: 'scripts/articles/verify.mjs', text: `import { GATES } from './push.mjs';\n` },
    { path: 'scripts/articles/status.mjs', text: `import { run } from './push.mjs';\n` },
    { path: 'scripts/articles/pull.mjs', text: `import { assertReviewedTree } from './push.mjs';\n` },
    // Neighbours of an exempt path are not exempt: the list is by equality, never by pattern.
    { path: 'scripts/articles/test/push.test.mjs.bak.mjs', text: `import { run } from './${up}/push.mjs';\n` },
    { path: 'scripts/articles/test/sub/push.test.mjs', text: `import { run } from '${up}/${up}/push.mjs';\n` },
    { path: 'scripts/articles/test/pushy.test.mjs', text: `import { run } from '${up}/push.mjs';\n` },
    // An exempt file is exempt from the import rule only: spelling the command is still an offence.
    { path: EXEMPT_PATHS[0], text: `// run it with: npm run ${NPM_NAME}\n` },
    { path: EXEMPT_PATHS[1], text: `spawn('node', ['${MODULE_PATH}']);\n` },
  ];
  for (const file of planted) {
    assert.equal(findOffenders([file]).length > 0, true, `not caught: ${file.path}: ${file.text}`);
  }
  // The exempt importers' ordinary import is not an offence.
  assert.deepEqual(findOffenders([{ path: EXEMPT_PATHS[0], text: `import { run } from '${up}/push.mjs';\n` }]), []);
  // A relative import that resolves ELSEWHERE is not an offender, or every sibling import would be.
  assert.deepEqual(findOffenders([{ path: 'scripts/foo/x.mjs', text: `import { x } from './push.mjs';\n` }]), []);
  // And the declaration itself is NOT caught, or package.json could never declare the script.
  assert.deepEqual(findOffenders([{ path: 'package.json', text: `    "${NPM_NAME}": "node ${MODULE_PATH}",\n` }]), []);
  // The self-exemption is by exact path, not by content.
  assert.deepEqual(findOffenders([{ path: SELF, text: `npm run ${NPM_NAME}` }]), []);
  assert.equal(findOffenders([{ path: `${SELF}.copy`, text: `npm run ${NPM_NAME}` }]).length, 1);
});

test('a path BUILT to the push under scripts/ is caught, in each shape, and another subsystem\'s push.mjs is not', () => {
  const up = '..';
  const file = PUSH_FILE;
  const planted = [
    // The two shapes the review named, as planted positive controls.
    { path: 'scripts/articles/test/x.test.mjs', text: `spawn('node', [join(TEST_DIR, '${up}', '${file}'), '--handle', 'x']);\n` },
    { path: 'scripts/articles/test/x.test.mjs', text: `const url = new URL('${up}/${file}', import.meta.url);\n` },
    { path: 'scripts/foo/x.mjs', text: `execFileSync('node', [join(ROOT, 'scripts', '${ARTICLES_SEGMENT}', '${file}')]);\n` },
    { path: 'scripts/foo/x.mjs', text: `const target = path.join(\n  root,\n  '${ARTICLES_SEGMENT}',\n  '${file}',\n);\n` },
    { path: 'scripts/foo/x.mjs', text: `const target = \`${ARTICLES_SEGMENT}/${file}\`;\n` },
    { path: 'scripts/articles/x.mjs', text: `const target = join(HERE, '${file}');\n` },
    { path: 'scripts/articles/lib/x.mjs', text: `const target = new URL('${up}/${file}', import.meta.url);\n` },
    // An exempt importer is not exempt from this rule.
    { path: EXEMPT_PATHS[0], text: `spawn(process.execPath, [join(TEST_DIR, '${up}', '${file}')]);\n` },
  ];
  for (const f of planted) assert.ok(findOffenders([f]).length > 0, `not caught: ${f.path}: ${f.text}`);

  // Not offences: the policies push naming its own file, a bare name with no evidence, an exempt import.
  const clean = [
    { path: 'scripts/policies/test/push.test.mjs', text: `const code = await main(['node', '${file}', ...args]);\n` },
    { path: 'scripts/policies/test/x.test.mjs', text: `const url = new URL('${up}/${file}', import.meta.url);\n` },
    { path: 'scripts/policies/test/x.test.mjs', text: `join(TEST_DIR, '${up}', '${file}');\n` },
    { path: EXEMPT_PATHS[0], text: `import {\n  GATES,\n  run,\n} from '${up}/${file}';\n` },
    { path: 'scripts/articles/test/x.test.mjs', text: `// join(TEST_DIR, '${up}', '${file}') in a comment builds nothing\n` },
  ];
  for (const f of clean) assert.deepEqual(pathLiteralOffenders(f), [], `flagged: ${f.path}: ${f.text}`);
});

test('every exempt importer\'s helpers, outside the push\'s own closure, name no Admin client and read no environment', async () => {
  const push = join(REPO_ROOT, ...MODULE_PATH.split('/'));
  const skip = (await importClosure(push)).files;
  for (const path of EXEMPT_PATHS) {
    const entry = join(REPO_ROOT, ...path.split('/'));
    const { files } = await importClosure(entry);
    assert.ok(files.length > 3, `${path}: the closure walk reached almost nothing (${files.length}), so it proves nothing`);
    assert.deepEqual(await closureViolations({ entry, skip }), [], path);
  }

  // Positive controls at depth one and two, through the same function.
  const dir = mkdtempSync(join(tmpdir(), 'articles-exempt-closure-'));
  try {
    writeFileSync(join(dir, 'exempt.test.mjs'), "import { a } from './helper.mjs';\nexport const x = a;\n", 'utf8');
    writeFileSync(join(dir, 'helper.mjs'), "import { b } from './deeper.mjs';\nexport const a = createAdminClient;\n", 'utf8');
    writeFileSync(join(dir, 'deeper.mjs'), 'export const b = process.env.MYSHOPIFY_DOMAIN;\n', 'utf8');
    const entry = join(dir, 'exempt.test.mjs');
    const found = await closureViolations({ entry, skip: [] });
    assert.ok(found.some((v) => v.endsWith('helper.mjs: names createAdminClient')), found.join('\n'));
    assert.ok(found.some((v) => v.endsWith('deeper.mjs: reads process.env')), found.join('\n'));
    // The skip list is what exempts the push's own closure, and it is by exact path.
    assert.deepEqual(await closureViolations({ entry, skip: [join(dir, 'helper.mjs'), join(dir, 'deeper.mjs')] }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an exempt file that reaches for a real store is caught, in each shape', () => {
  const up = '..';
  const path = EXEMPT_PATHS[0];
  const planted = [
    `import { main } from '${up}/push.mjs';\n`,
    `import { run, main as m } from '${up}/push.mjs';\n`,
    `import * as push from '${up}/push.mjs';\n`,
    `import push from '${up}/push.mjs';\n`,
    `const push = await import('${up}/push.mjs');\n`,
    `await push.main(['node', 'x']);\n`,
    `import { createAdminClient } from '${up}/${up}/blank-inventory/lib/admin.mjs';\n`,
    `const domain = process.env.MYSHOPIFY_DOMAIN;\n`,
    `const domain = process['env'].MYSHOPIFY_DOMAIN;\n`,
    `const ctx = createContext({ repoRoot: root, env: {}, now, stateDir });\n`,
  ];
  for (const text of planted) {
    assert.ok(exemptFileViolations({ path, text }).length > 0, `not caught: ${text}`);
  }
  // The sanctioned shapes pass.
  assert.deepEqual(exemptFileViolations({ path, text: `import {\n  GATES,\n  run,\n} from '${up}/push.mjs';\n` }), []);
  assert.deepEqual(exemptFileViolations({ path, text: `const ctx = createContext({ repoRoot: root, client: fake, env: {}, now, stateDir });\n` }), []);
  assert.deepEqual(exemptFileViolations({ path, text: `// main( in a comment is not a call\nconst ref = 'origin/main';\n` }), []);
});
