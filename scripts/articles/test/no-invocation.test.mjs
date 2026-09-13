// THE CREDENTIAL BOUNDARY: nothing automated may invoke the article push or the article image uploader.
//
// Both write to the live store. The push is authorised by an operator in a session, run by hand, and
// never by CI, a hook, a skill step, a scheduled job or another script. That rule is only worth
// anything if something enforces it, because the failure mode is silent: a workflow step added
// months from now would run with the repository's credentials and nobody would notice until a post
// appeared.
//
// WHY THE UPLOADER IS GUARDED TOO. It was first left out because it has no npm script, and a guard
// keyed on an npm name had nothing to key on. That is backwards: an upload is the more exposed of the
// two writes. A pushed article is hidden and reversible; an uploaded file is PUBLIC at its CDN URL the
// moment it is created, whatever the article's state, and no later step hides it. So the uploader gets
// the same rule by module path, with its own exemption lists, and neither target's exemption covers
// the other: the push's test may not import the uploader, and the uploader's doc may not spell the push.
//
// SCOPE IS THE WHOLE POINT. An earlier draft of this idea scanned only validate.yml, which would
// have left deploy.yml, the one workflow that actually holds live credentials, entirely uncovered
// by the mechanism built to cover it. So this walks every regular file under .github/workflows/,
// .github/actions/, scripts/, and every .claude/ tree an automated caller could live in (skills,
// hooks, commands, rules, agents, and the two settings files), plus package.json. EVERY file, not a
// list of text extensions: a hook script with no extension runs just as well as one with `.sh`.
// Only a file with a NUL byte in its first 8KB is skipped, as binary. A SYMLINKED DIRECTORY anywhere
// in those trees fails the suite outright: the walk does not follow one (a link cycle would hang it),
// so a tree reached through a link would be silently unscanned.
//
// THREE SPELLINGS, because any of them runs it: the npm script name (the push only), the module path,
// and a relative import that resolves to the module. The first two are text matches. They are NOT a
// complete defence: a command assembled at runtime from pieces contains neither literal, and no
// static scan can see it. Nor can one see a hook that extracts the fenced command block from the
// exempt push doc and runs it: the doc is allowed to hold that text, and reading a file is not a
// spelling. Both modules refuse to run with CI present, checked from their injected environment, so
// this scan is the second line and not the only one. The third spelling is resolved rather than
// matched, because `import('../push.mjs')` from the test directory contains no occurrence of the
// full module path at all.
//
// The only permitted TEXT occurrence of the push's npm name outside its exempt doc is the script key
// in package.json, and its value is pinned exactly, so the declaration cannot quietly grow a second
// command after `&&`. The uploader has no declaration: its module path is refused in every scanned
// file but its exempt doc.
//
// THE PERMITTED IMPORTS: each module's own tests. Their gates are the product, and a gate nobody has
// proved is a gate nobody knows exists, so the push's gate suite and real-git integration test, and
// the uploader's suite, must import their module. Each is exempt from the import rule ONLY, for its
// OWN module ONLY, by EXACT repo-relative path, listed with a reason. The exemption cannot widen: it
// is an equality test against a frozen list, a test pins each list's exact contents and length, and
// planted controls prove that any other file in the same directory importing either module is still
// an offender. A new test file is never exempt by where it lives or what it is called.
//
// AN EXEMPT FILE IS HELD TO MORE, NOT LESS. It may import the gate functions and `run`, and nothing
// that reaches a real store: it must not import or call `main`, import either module as a namespace
// or dynamically, name `createAdminClient`, read `process.env`, or call `createContext` without an
// explicit `client:`. And the text and built-path rules still apply to it: an exempt file spelling
// the npm name or the module path, or building a path to the module for a spawn, is an offender like
// any other.
//
// A CONSEQUENCE WORTH KNOWING: documentation under these trees cannot spell either command.
// That is deliberate. A README line is copy-pasteable, and this guard cannot tell a person reading
// docs from a script reading the same bytes.
//
// WITH ONE DOCUMENTED TEXT EXCEPTION PER MODULE, each the skill doc that owns that procedure. A doc
// that cannot state the command it documents is useless, and an agent reading it guesses a spelling;
// a "prose, not an invocation" heuristic is exactly what a new spelling slips past. So each exemption
// is an exact path, frozen and pinned like the import lists:
//   - `.claude/skills/articles/push.md` may name the push by its NPM NAME ONLY, and must not contain
//     the module path in any form (full, relative, the bare filename, in any letter case), so the one
//     documented route is the one package.json declares and the push's own CI refusal covers.
//   - `.claude/skills/articles/images.md` may spell the uploader's MODULE PATH, because the uploader
//     has no npm script and a module path is the only spelling that exists.
// Every other file, including the other docs in the same skill, stays refused and links through
// SKILL.md instead. The runtime CI refusal inside each module remains the first line.
//
// AND IT IS A MERGE GATE, NOT LEAK PREVENTION. On a public repository anything pushed to any branch
// is already exposed. This stops such a change reaching main; the pre-push checklist is the first
// line, and this is the second.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, closeSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
 * The ways to name each module. Built from pieces so that this file, which must contain them to test
 * for them, does not itself contain any literal: otherwise the guard would have to exempt its own
 * text by a substring match, and any file could evade it by claiming the same exemption.
 */
const NPM_NAME = ['articles', 'push'].join(':');
const MODULE_PATH = ['scripts', 'articles', 'push.mjs'].join('/');
const UPLOADER_PATH = ['scripts', 'articles', ['upload', 'images.mjs'].join('-')].join('/');

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

/**
 * The only file that may carry the push's npm name in its text, by EXACT path. Frozen, and pinned by
 * a test. It is a separate list from EXEMPT_IMPORTERS on purpose: an importer is exempt from the
 * import rule and never from the text rule, and this doc is exempt from the npm-name half of the text
 * rule only.
 */
export const EXEMPT_DOCS = Object.freeze([
  Object.freeze({
    path: '.claude/skills/articles/push.md',
    why: 'the skill doc that owns the push procedure must state the command, by the npm name package.json declares, so no agent guesses a spelling',
  }),
]);

const EXEMPT_DOC_PATHS = Object.freeze(EXEMPT_DOCS.map((e) => e.path));

/** The only file that may import the uploader, by EXACT path. Frozen, and pinned by a test. */
export const UPLOADER_EXEMPT_IMPORTERS = Object.freeze([
  Object.freeze({
    path: 'scripts/articles/test/upload-images.test.mjs',
    why: 'the uploader suite: every rail is proved against a recording fake client and a fake staged-upload endpoint',
  }),
]);

/** The only file that may spell the uploader's module path, by EXACT path. Frozen, and pinned by a test. */
export const UPLOADER_EXEMPT_DOCS = Object.freeze([
  Object.freeze({
    path: '.claude/skills/articles/images.md',
    why: 'the skill doc that owns the upload procedure must state the command, and the uploader has no npm script, so its module path is the only spelling',
  }),
]);

/**
 * The guarded modules. `docMay` is what the exempt doc may carry: the push's doc its npm name only,
 * the uploader's doc its module path.
 */
const PUSH = Object.freeze({
  label: 'the article push module',
  npmName: NPM_NAME,
  modulePath: MODULE_PATH,
  importers: EXEMPT_PATHS,
  docs: EXEMPT_DOC_PATHS,
  docMay: 'npm-name',
});
const UPLOADER = Object.freeze({
  label: 'the article image uploader module',
  npmName: null,
  modulePath: UPLOADER_PATH,
  importers: Object.freeze(UPLOADER_EXEMPT_IMPORTERS.map((e) => e.path)),
  docs: Object.freeze(UPLOADER_EXEMPT_DOCS.map((e) => e.path)),
  docMay: 'module-path',
});
const TARGETS = Object.freeze([PUSH, UPLOADER]);

const fileOf = (target) => target.modulePath.split('/').pop();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Any spelling of a module's file, IN ANY LETTER CASE: the full path, a relative path, a backslash
 * path, the bare filename. Case-insensitive because a doc spelling `Scripts/Articles/Push.mjs` is
 * still a copy-pasteable command on a case-insensitive filesystem, and a respelling is exactly what an
 * exact-case match misses.
 */
function spellsModule(target, line) {
  const lower = line.toLowerCase();
  const stem = fileOf(target).replace(/\.mjs$/, '');
  return lower.includes(target.modulePath.toLowerCase()) || lower.includes(fileOf(target).toLowerCase()) || new RegExp(`articles[\\\\/]+${escapeRe(stem)}\\b`, 'i').test(line);
}

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

/**
 * Every regular file under `dir`, and every symlinked directory found on the way. A symlink is
 * followed to a file but never to a directory, so a link cycle cannot hang the walk; the caller fails
 * on any symlinked directory, because what sits behind one is unscanned.
 *
 * @param {string} dir  absolute
 * @returns {{files: string[], symlinkedDirs: string[]}}
 */
export function walkTree(dir, out = { files: [], symlinkedDirs: [] }) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      let stat = null;
      try {
        stat = statSync(full);
      } catch {
        continue; // a dangling link points at nothing to scan
      }
      if (stat.isDirectory()) out.symlinkedDirs.push(full);
      else if (stat.isFile()) out.files.push(full);
    } else if (entry.isDirectory()) {
      walkTree(full, out);
    } else if (entry.isFile()) {
      out.files.push(full);
    }
  }
  return out;
}

const toRel = (full) => relative(REPO_ROOT, full).split(sep).join('/');

/** Every scanned file as `{ path, text }`, path repo-relative with forward slashes, sorted. */
function scannedFiles() {
  const out = { files: [], symlinkedDirs: [] };
  for (const d of SCANNED_DIRS) walkTree(join(REPO_ROOT, d), out);
  for (const f of SCANNED_FILES) {
    const full = join(REPO_ROOT, f);
    if (existsSync(full)) out.files.push(full);
  }
  return out.files
    .filter((full) => !looksBinary(full))
    .map((full) => ({ path: toRel(full), text: readFileSync(full, 'utf8') }))
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

/** Does a relative specifier, named from `path`, resolve to the target module? */
function resolvesTo(target, path, spec) {
  return spec.startsWith('.') && posix.normalize(posix.join(posix.dirname(path), spec)) === target.modulePath;
}

const resolvesToAnyTarget = (path, spec) => TARGETS.some((t) => resolvesTo(t, path, spec));

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
 * Places a module under scripts/ BUILDS A PATH to a guarded module rather than importing it: the
 * shapes a spawn, an exec or a `new URL` would use, which contain neither the npm name nor the full
 * module path.
 *
 *   a relative literal ending in the filename that resolves to the module   new URL('../push.mjs', import.meta.url)
 *   a literal ending in `articles/<file>`                                   'scripts/articles/push.mjs' in pieces
 *   the bare filename beside an `articles` literal, in one call or line     join(ROOT, 'scripts', 'articles', 'push.mjs')
 *   the bare filename beside a `..` literal, from under scripts/articles/   join(TEST_DIR, '..', 'push.mjs')
 *   the bare filename in a module directly in scripts/articles/             join(HERE, 'push.mjs')
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
  const groups = [
    ...[...literals.reduce((m, l) => m.set(l.line, [...(m.get(l.line) ?? []), l.value]), new Map()).entries()].map(([line, values]) => ({ where: `line ${line}`, values })),
    ...['join', 'resolve', 'URL'].flatMap((name) => callArguments(code, name).map((args) => ({ where: `${name}(...)`, values: stringLiterals(args).map((l) => l.value) }))),
  ];
  const out = [];
  for (const target of TARGETS) {
    const file = fileOf(target);
    const segment = target.modulePath.split('/')[1];
    const dirPath = posix.dirname(target.modulePath);
    const inDir = path.startsWith(`${dirPath}/`);
    const directlyInDir = posix.dirname(path) === dirPath;
    for (const { value, line } of literals) {
      if (!value.endsWith(file)) continue;
      if (value !== file) {
        if (resolvesTo(target, path, value) || value.endsWith(`${segment}/${file}`)) {
          out.push(`${path}:${line}: builds a path to ${target.label} from ${JSON.stringify(value)}`);
        }
      } else if (directlyInDir) {
        out.push(`${path}:${line}: names ${target.label}'s file beside it`);
      }
    }
    for (const { where, values } of groups) {
      if (!values.includes(file)) continue;
      if (values.includes(segment)) out.push(`${path}: ${where} joins "${segment}" with "${file}"`);
      else if (inDir && values.includes('..')) out.push(`${path}: ${where} reaches "${file}" through ".." from ${dirPath}/`);
    }
  }
  return [...new Set(out)];
}

/**
 * What an exempt importer's HELPERS must not do. The exempt file itself is held to
 * `exemptFileViolations`; every other module its import closure loads, except the guarded module and
 * that module's own closure (which is production and legitimately builds the real client in `main`),
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
    const where = toRel(file);
    if (/\bcreateAdminClient\b/.test(code)) out.push(`${where}: names createAdminClient`);
    if (/\bprocess\s*(?:\.\s*env\b|\[)/.test(code)) out.push(`${where}: reads process.env`);
  }
  return out;
}

/**
 * The text rule for one target over one file, as offender strings.
 *
 * @param {object} target
 * @param {{path: string, text: string}} file
 */
function textOffenders(target, { path, text }) {
  const exemptDoc = target.docs.includes(path);
  // The uploader's exempt doc may spell its module path, and there is no npm name to refuse.
  if (exemptDoc && target.docMay === 'module-path') return [];
  const spelledNpm = (line) => target.npmName !== null && line.includes(target.npmName);
  if (!exemptDoc && !text.includes(target.modulePath) && !(target.npmName !== null && text.includes(target.npmName))) return [];
  const out = [];
  for (const [i, line] of text.split('\n').entries()) {
    const spelled = line.includes(target.modulePath) || (exemptDoc && spellsModule(target, line));
    if (!spelledNpm(line) && !spelled) continue;
    if (target === PUSH && isDeclarationLine(path, line)) continue;
    // The push's exempt doc may use the npm name; spelling the module, in any form, is still refused.
    if (exemptDoc && !spelled) continue;
    out.push(`${path}:${i + 1}: ${exemptDoc ? '(the exempt doc may use the npm name only) ' : ''}${line.trim().slice(0, 120)}`);
  }
  return out;
}

/**
 * Every place a set of files invokes a guarded module, as `path:line: text` strings.
 *
 * PURE, and the ONLY implementation. The real scan and every planted control go through this same
 * function, so a control cannot pass against a private re-implementation while the scan itself has
 * stopped matching.
 *
 * @param {Array<{path: string, text: string}>} files - repo-relative forward-slash paths
 */
export function findOffenders(files) {
  const offenders = [];
  for (const file of files) {
    const { path, text } = file;
    if (path === SELF) continue;
    for (const target of TARGETS) offenders.push(...textOffenders(target, file));
    // A built path is not an import: exempt files are held to this rule like every other module.
    offenders.push(...pathLiteralOffenders(file));
    if (!MODULE_EXTENSIONS.some((ext) => path.endsWith(ext))) continue;
    const specs = specifiersOf(text);
    for (const target of TARGETS) {
      // EXACT equality against the frozen list, for the import rule only, and for this target only.
      if (target.importers.includes(path)) continue;
      for (const spec of specs) {
        if (resolvesTo(target, path, spec)) offenders.push(`${path}: imports ${spec}, which resolves to ${target.label}`);
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
 * What an exempt importer must not do, as violation strings. Empty means it holds to the rules. The
 * import shapes are refused for EITHER guarded module, whichever one the file is exempt for.
 *
 * @param {{path: string, text: string}} file
 */
export function exemptFileViolations({ path, text }) {
  const out = [];
  const code = stripComments(text);
  for (const m of code.matchAll(/^import\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"];?\s*$/gm)) {
    if (!resolvesToAnyTarget(path, m[2])) continue;
    const clause = m[1].trim();
    if (!clause.startsWith('{') || !clause.endsWith('}')) {
      out.push(`${path}: imports a guarded module as a namespace or default (${clause}); name each function instead`);
      continue;
    }
    const names = clause.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.split(/\s+as\s+/)[0]);
    if (names.includes('main')) out.push(`${path}: imports main from a guarded module`);
  }
  for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (resolvesToAnyTarget(path, m[1])) out.push(`${path}: imports a guarded module dynamically`);
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
  for (const target of TARGETS) {
    for (const path of [...target.importers, ...target.docs]) assert.ok(files.includes(path), `the exempt file ${path} was not walked`);
  }
});

test('no scanned tree contains a symlinked directory, which the walk would silently skip', () => {
  const found = { files: [], symlinkedDirs: [] };
  for (const d of SCANNED_DIRS) walkTree(join(REPO_ROOT, d), found);
  assert.deepEqual(found.symlinkedDirs.map(toRel), [], 'a symlinked directory in a scanned tree is unscanned; replace it with a real directory');

  // Planted control through the same walker: a linked directory is reported, a linked file is walked.
  const dir = mkdtempSync(join(tmpdir(), 'articles-guard-walk-'));
  try {
    mkdirSync(join(dir, 'real'));
    writeFileSync(join(dir, 'real', 'hook.sh'), 'echo hi\n');
    mkdirSync(join(dir, 'tree'));
    symlinkSync(join(dir, 'real'), join(dir, 'tree', 'linked-dir'), 'dir');
    symlinkSync(join(dir, 'real', 'hook.sh'), join(dir, 'tree', 'linked-file'));
    const walked = walkTree(join(dir, 'tree'));
    assert.deepEqual(walked.symlinkedDirs, [join(dir, 'tree', 'linked-dir')]);
    assert.deepEqual(walked.files, [join(dir, 'tree', 'linked-file')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nothing under the scanned trees invokes the article push or the image uploader, by any spelling', () => {
  const offenders = findOffenders(scannedFiles());
  assert.deepEqual(
    offenders,
    [],
    'the article push and the image uploader write to the live store and are invoked by an operator ' +
      'in a session, never by a workflow, a skill step, a hook or another script. The only permitted ' +
      `occurrences are the push's key in package.json and each module's exempt doc.\n${offenders.join('\n')}`,
  );
});

test('package.json declares the push with exactly the pinned value, and never declares the uploader', () => {
  const text = readFileSync(join(REPO_ROOT, 'package.json'), 'utf8');
  const lines = text.split('\n').filter((l) => l.includes(NPM_NAME));
  assert.equal(lines.length, 1, 'expected exactly one package.json line naming the push');
  assert.equal(isDeclarationLine('package.json', lines[0]), true, `the declaration is not exactly the pinned value: ${lines[0].trim()}`);
  assert.equal(text.includes(UPLOADER_PATH), false, 'package.json names the uploader, which has no pinned declaration to be exempt as');
});

test('the declaration exemption is exactly one line, and does not generalise', () => {
  assert.equal(isDeclarationLine('package.json', `    "${NPM_NAME}": "node ${MODULE_PATH}",`), true);
  assert.equal(isDeclarationLine('package.json', `    "${NPM_NAME}": "node ${MODULE_PATH}"`), true);
  assert.equal(isDeclarationLine('package.json', `    "${NPM_NAME}": "node ${MODULE_PATH} && curl x",`), false);
  assert.equal(isDeclarationLine('package.json', `  run: npm run ${NPM_NAME}`), false);
  assert.equal(isDeclarationLine('.github/workflows/deploy.yml', `    "${NPM_NAME}": "node ${MODULE_PATH}",`), false);
  assert.equal(isDeclarationLine('package.json', `# see "${NPM_NAME}" below`), false);
  assert.ok(findOffenders([{ path: 'package.json', text: `    "articles:upload": "node ${UPLOADER_PATH}",\n` }]).length > 0, 'an uploader declaration is not exempt');
});

test('the import exemptions are exactly the pinned paths, each with a reason', () => {
  // Each exemption is the one hole in its module's import rule, so its contents are pinned, not just its size.
  assert.deepEqual(EXEMPT_PATHS, ['scripts/articles/test/push.test.mjs', 'scripts/articles/test/git-integration.test.mjs']);
  assert.equal(EXEMPT_IMPORTERS.length, 2);
  assert.deepEqual(UPLOADER.importers, ['scripts/articles/test/upload-images.test.mjs']);
  assert.equal(UPLOADER_EXEMPT_IMPORTERS.length, 1);
  for (const list of [EXEMPT_IMPORTERS, UPLOADER_EXEMPT_IMPORTERS]) {
    assert.ok(Object.isFrozen(list));
    for (const entry of list) {
      assert.ok(Object.isFrozen(entry));
      assert.ok(typeof entry.why === 'string' && entry.why.length > 20, `${entry.path} carries no reason`);
      assert.ok(existsSync(join(REPO_ROOT, entry.path)), `${entry.path} is exempt but does not exist`);
    }
  }
});

test('the text exemptions are exactly one pinned doc path per module, with a reason, and each doc really uses it', () => {
  assert.deepEqual(EXEMPT_DOC_PATHS, ['.claude/skills/articles/push.md']);
  assert.equal(EXEMPT_DOCS.length, 1);
  assert.deepEqual(UPLOADER.docs, ['.claude/skills/articles/images.md']);
  assert.equal(UPLOADER_EXEMPT_DOCS.length, 1);
  const byPath = new Map(scannedFiles().map((f) => [f.path, f]));
  for (const [list, spelling] of [[EXEMPT_DOCS, NPM_NAME], [UPLOADER_EXEMPT_DOCS, UPLOADER_PATH]]) {
    assert.ok(Object.isFrozen(list));
    for (const entry of list) {
      assert.ok(Object.isFrozen(entry));
      assert.ok(typeof entry.why === 'string' && entry.why.length > 20, `${entry.path} carries no reason`);
      assert.ok(byPath.has(entry.path), `${entry.path} is exempt but was not walked (or does not exist)`);
      // An exemption nobody uses is a hole waiting for a file.
      assert.ok(byPath.get(entry.path).text.includes(spelling), `${entry.path} is exempt but never uses its exemption`);
    }
  }
});

test('the push doc exemption is by exact path, covers the npm name only in any letter case, and does not generalise', () => {
  const doc = EXEMPT_DOC_PATHS[0];
  const allowed = `The dry run:\n\n\`\`\`bash\nnpm run ${NPM_NAME} -- --handle <handle>\n\`\`\`\n\nRun \`${NPM_NAME}\` only after the ask.\n`;
  assert.deepEqual(findOffenders([{ path: doc, text: allowed }]), []);

  // The exempt doc spelling the module, in any form and any letter case, is an offender, with or
  // without the npm name.
  for (const line of [
    `node ${MODULE_PATH} --handle x`,
    `see ${MODULE_PATH}`,
    `node ./${posix.dirname(MODULE_PATH)}/${fileOf(PUSH)}`,
    `the ${fileOf(PUSH)} module exports GATES`,
    `npm run ${NPM_NAME} (that is node ${MODULE_PATH})`,
    'scripts\\articles\\push --handle x',
    `node ${MODULE_PATH.toUpperCase()} --handle x`,
    `node Scripts/Articles/${fileOf(PUSH).replace(/^p/, 'P')} --handle x`,
    `the ${fileOf(PUSH).toUpperCase()} module`,
    'SCRIPTS\\ARTICLES\\PUSH --handle x',
  ]) {
    assert.equal(findOffenders([{ path: doc, text: `${allowed}${line}\n` }]).length, 1, `not caught in the exempt doc: ${line}`);
  }

  // Siblings in the same skill, and every near-miss path, are not exempt.
  for (const path of [
    '.claude/skills/articles/SKILL.md',
    '.claude/skills/articles/write.md',
    '.claude/skills/articles/images.md',
    '.claude/skills/articles/verify.md',
    '.claude/skills/articles/push.md.bak',
    '.claude/skills/articles/Push.md',
    '.claude/skills/articles/sub/push.md',
    '.claude/skills/articles-old/push.md',
    '.claude/skills/Articles/push.md',
    '.claude/skills/shop-policies/push.md',
    './.claude/skills/articles/push.md',
    'scripts/articles/push.md',
    '.claude/commands/articles/push.md',
  ]) {
    assert.ok(findOffenders([{ path, text: allowed }]).length > 0, `a near-miss path is exempt: ${path}`);
  }
});

test('the uploader doc exemption is by exact path, covers the uploader only, and does not generalise', () => {
  const doc = UPLOADER.docs[0];
  const allowed = `\`\`\`bash\nnode ${UPLOADER_PATH} --handle <handle> --prepare\n\`\`\`\n`;
  assert.deepEqual(findOffenders([{ path: doc, text: allowed }]), []);

  // The uploader's doc is not exempt for the push, in either spelling.
  assert.ok(findOffenders([{ path: doc, text: `${allowed}npm run ${NPM_NAME} -- --handle x\n` }]).length > 0);
  assert.ok(findOffenders([{ path: doc, text: `${allowed}node ${MODULE_PATH} --handle x\n` }]).length > 0);

  // Every other doc spelling the uploader is an offender, the push's exempt doc included.
  for (const path of [
    '.claude/skills/articles/SKILL.md',
    '.claude/skills/articles/push.md',
    '.claude/skills/articles/write.md',
    '.claude/skills/articles/images.md.bak',
    '.claude/skills/articles/Images.md',
    '.claude/skills/articles/sub/images.md',
    '.claude/skills/articles-old/images.md',
    './.claude/skills/articles/images.md',
    'scripts/articles/README.md',
    'scripts/README.md',
    '.claude/commands/upload-article-images.md',
  ]) {
    assert.ok(findOffenders([{ path, text: allowed }]).length > 0, `a near-miss path is exempt for the uploader: ${path}`);
  }
});

test('every exempt importer holds to the rules an exempt file is held to, and really imports its own module', () => {
  const byPath = new Map(scannedFiles().map((f) => [f.path, f]));
  for (const target of TARGETS) {
    const violations = target.importers.flatMap((path) => exemptFileViolations(byPath.get(path)));
    assert.deepEqual(violations, [], violations.join('\n'));
    for (const path of target.importers) {
      assert.ok(specifiersOf(byPath.get(path).text).some((s) => resolvesTo(target, path, s)), `${path} is exempt but imports nothing from ${target.label}`);
    }
  }
});

test('the guard catches a planted invocation in each shape it is meant to stop', () => {
  // A rule with no positive control is a rule nobody has proved fires. Every control goes through
  // findOffenders itself, at a realistic path, so the real function is what is proved.
  const up = '..';
  const uploaderFile = fileOf(UPLOADER);
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

    // The uploader, by module path, in every scanned tree.
    { path: '.github/workflows/validate.yml', text: `      - run: node ${UPLOADER_PATH} --handle x --confirm=x --expect-plan=y` },
    { path: '.claude/hooks/after-merge', text: `node --env-file=.env ${UPLOADER_PATH} --handle "$H"` },
    { path: '.claude/skills/articles/SKILL.md', text: `Run \`node ${UPLOADER_PATH} --handle <h>\`.` },
    { path: 'scripts/articles/README.md', text: `| \`node ${UPLOADER_PATH} --handle <h>\` | read | the dry run |` },
    // The uploader, by import, from anywhere but its own suite.
    { path: 'scripts/articles/test/x.test.mjs', text: `import { run } from '${up}/${uploaderFile}';\n` },
    { path: 'scripts/articles/lib/x.mjs', text: `import { planSha } from '${up}/${uploaderFile}';\n` },
    { path: 'scripts/articles/push.mjs', text: `import { run } from './${uploaderFile}';\n` },
    { path: 'scripts/foo/x.mjs', text: `const m = await import('${up}/articles/${uploaderFile}');\n` },
    { path: 'scripts/articles/test/upload-images.test.mjs.bak.mjs', text: `import { run } from '${up}/${uploaderFile}';\n` },
    // Neither exemption covers the other module.
    { path: EXEMPT_PATHS[0], text: `import { run } from '${up}/${uploaderFile}';\n` },
    { path: UPLOADER.importers[0], text: `import { run } from '${up}/push.mjs';\n` },
    // The uploader's own suite spelling or building its path is still an offence.
    { path: UPLOADER.importers[0], text: `// node ${UPLOADER_PATH} --handle x\n` },
  ];
  for (const file of planted) {
    assert.equal(findOffenders([file]).length > 0, true, `not caught: ${file.path}: ${file.text}`);
  }
  // Each exempt importer's ordinary import of its OWN module is not an offence.
  assert.deepEqual(findOffenders([{ path: EXEMPT_PATHS[0], text: `import { run } from '${up}/push.mjs';\n` }]), []);
  assert.deepEqual(findOffenders([{ path: UPLOADER.importers[0], text: `import {\n  planSha,\n  run,\n} from '${up}/${uploaderFile}';\n` }]), []);
  // A relative import that resolves ELSEWHERE is not an offender, or every sibling import would be.
  assert.deepEqual(findOffenders([{ path: 'scripts/foo/x.mjs', text: `import { x } from './push.mjs';\n` }]), []);
  assert.deepEqual(findOffenders([{ path: 'scripts/foo/x.mjs', text: `import { x } from './${uploaderFile}';\n` }]), []);
  // And the declaration itself is NOT caught, or package.json could never declare the script.
  assert.deepEqual(findOffenders([{ path: 'package.json', text: `    "${NPM_NAME}": "node ${MODULE_PATH}",\n` }]), []);
  // The self-exemption is by exact path, not by content.
  assert.deepEqual(findOffenders([{ path: SELF, text: `npm run ${NPM_NAME}\nnode ${UPLOADER_PATH}` }]), []);
  assert.equal(findOffenders([{ path: `${SELF}.copy`, text: `npm run ${NPM_NAME}` }]).length, 1);
  assert.equal(findOffenders([{ path: `${SELF}.copy`, text: `node ${UPLOADER_PATH}` }]).length, 1);
});

test('a path BUILT to either module under scripts/ is caught, in each shape, and another subsystem\'s push.mjs is not', () => {
  const up = '..';
  const planted = [];
  for (const file of [fileOf(PUSH), fileOf(UPLOADER)]) {
    planted.push(
      // The two shapes the review named, as planted positive controls.
      { path: 'scripts/articles/test/x.test.mjs', text: `spawn('node', [join(TEST_DIR, '${up}', '${file}'), '--handle', 'x']);\n` },
      { path: 'scripts/articles/test/x.test.mjs', text: `const url = new URL('${up}/${file}', import.meta.url);\n` },
      { path: 'scripts/foo/x.mjs', text: `execFileSync('node', [join(ROOT, 'scripts', 'articles', '${file}')]);\n` },
      { path: 'scripts/foo/x.mjs', text: `const target = path.join(\n  root,\n  'articles',\n  '${file}',\n);\n` },
      { path: 'scripts/foo/x.mjs', text: `const target = \`articles/${file}\`;\n` },
      { path: 'scripts/articles/x.mjs', text: `const target = join(HERE, '${file}');\n` },
      { path: 'scripts/articles/lib/x.mjs', text: `const target = new URL('${up}/${file}', import.meta.url);\n` },
      // An exempt importer is not exempt from this rule, for its own module or the other.
      { path: EXEMPT_PATHS[0], text: `spawn(process.execPath, [join(TEST_DIR, '${up}', '${file}')]);\n` },
      { path: UPLOADER.importers[0], text: `spawnSync(process.execPath, [join(TEST_DIR, '${up}', '${file}'), '--handle', HANDLE]);\n` },
    );
  }
  for (const f of planted) assert.ok(findOffenders([f]).length > 0, `not caught: ${f.path}: ${f.text}`);

  // Not offences: the policies push naming its own file, a bare name with no evidence, an exempt
  // import, a comment, and a directory read that names no file.
  const file = fileOf(PUSH);
  const clean = [
    { path: 'scripts/policies/test/push.test.mjs', text: `const code = await main(['node', '${file}', ...args]);\n` },
    { path: 'scripts/policies/test/x.test.mjs', text: `const url = new URL('${up}/${file}', import.meta.url);\n` },
    { path: 'scripts/policies/test/x.test.mjs', text: `join(TEST_DIR, '${up}', '${file}');\n` },
    { path: EXEMPT_PATHS[0], text: `import {\n  GATES,\n  run,\n} from '${up}/${file}';\n` },
    { path: 'scripts/articles/test/x.test.mjs', text: `// join(TEST_DIR, '${up}', '${file}') in a comment builds nothing\n` },
    { path: UPLOADER.importers[0], text: `const dir = join(TEST_DIR, '${up}');\nreaddirSync(dir).filter((n) => n.endsWith('.mjs'));\n` },
  ];
  for (const f of clean) assert.deepEqual(pathLiteralOffenders(f), [], `flagged: ${f.path}: ${f.text}`);
});

test('every exempt importer\'s helpers, outside its module\'s own closure, name no Admin client and read no environment', async () => {
  for (const target of TARGETS) {
    const module = join(REPO_ROOT, ...target.modulePath.split('/'));
    const skip = (await importClosure(module)).files;
    for (const path of target.importers) {
      const entry = join(REPO_ROOT, ...path.split('/'));
      const { files } = await importClosure(entry);
      assert.ok(files.length > 3, `${path}: the closure walk reached almost nothing (${files.length}), so it proves nothing`);
      assert.deepEqual(await closureViolations({ entry, skip }), [], path);
    }
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
    // The skip list is what exempts the module's own closure, and it is by exact path.
    assert.deepEqual(await closureViolations({ entry, skip: [join(dir, 'helper.mjs'), join(dir, 'deeper.mjs')] }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an exempt file that reaches for a real store is caught, in each shape, for either module', () => {
  const up = '..';
  const cases = [
    [EXEMPT_PATHS[0], 'push.mjs'],
    [UPLOADER.importers[0], fileOf(UPLOADER)],
  ];
  for (const [path, file] of cases) {
    const planted = [
      `import { main } from '${up}/${file}';\n`,
      `import { run, main as m } from '${up}/${file}';\n`,
      `import * as mod from '${up}/${file}';\n`,
      `import mod from '${up}/${file}';\n`,
      `const mod = await import('${up}/${file}');\n`,
      `await mod.main(['node', 'x']);\n`,
      `import { createAdminClient } from '${up}/${up}/blank-inventory/lib/admin.mjs';\n`,
      `const domain = process.env.MYSHOPIFY_DOMAIN;\n`,
      `const domain = process['env'].MYSHOPIFY_DOMAIN;\n`,
      `const ctx = createContext({ repoRoot: root, env: {}, now, stateDir });\n`,
    ];
    for (const text of planted) {
      assert.ok(exemptFileViolations({ path, text }).length > 0, `not caught in ${path}: ${text}`);
    }
    // The sanctioned shapes pass.
    assert.deepEqual(exemptFileViolations({ path, text: `import {\n  GATES,\n  run,\n} from '${up}/${file}';\n` }), []);
    assert.deepEqual(exemptFileViolations({ path, text: `const ctx = createContext({ repoRoot: root, client: fake, env: {}, now, stateDir });\n` }), []);
    assert.deepEqual(exemptFileViolations({ path, text: `// main( in a comment is not a call\nconst ref = 'origin/main';\n` }), []);
  }
});
