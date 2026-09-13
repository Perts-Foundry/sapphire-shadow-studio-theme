// Source scans over scripts/articles/: no path to a visible article, mutations in one file, and a lib
// whose whole import closure reaches no network.
//
// THE FORBIDDEN STRINGS ARE BUILT FROM PIECES, so this file does not contain what it refuses and is
// scanned like every other file rather than exempted by name.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { exportFromsOf, importClosure, importsOf } from '../../lib/import-closure.mjs';
import { MUTATION_ROOT_FIELDS } from '../lib/mutations.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ARTICLES = join(REPO_ROOT, 'scripts', 'articles');
const LIB = join(ARTICLES, 'lib');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const rel = (full) => relative(REPO_ROOT, full).split(sep).join('/');

/** The ways an article becomes visible. None may appear anywhere under scripts/articles/. */
const VISIBILITY = Object.freeze([
  { label: ['publishable', 'Publish'].join(''), re: new RegExp(['publishable', 'Publish'].join(''), 'i') },
  { label: ['isPublished', 'true'].join(': '), re: new RegExp(['isPublished', '\\s*:\\s*', 'true'].join('')) },
  { label: ['publish', 'Date'].join(''), re: new RegExp(['publish', 'Date'].join('')) },
  { label: ['published', 'At'].join(''), re: new RegExp(['published', 'At'].join('')) },
]);

/** @param {Array<{path: string, text: string}>} files */
export function visibilityOffenders(files) {
  const out = [];
  for (const { path, text } of files) {
    for (const { label, re } of VISIBILITY) if (re.test(text)) out.push(`${path}: ${label}`);
  }
  return out;
}

/** A GraphQL mutation document: a string or template literal opening with the keyword. */
const MUTATION_DOC = new RegExp(`['"\`]\\s*${'mutation'}\\b\\s*(?:[A-Za-z_]\\w*)?\\s*[({]`, 'g');

/** @param {Array<{path: string, text: string}>} files  non-test modules */
export function mutationOffenders(files) {
  return files
    .filter(({ path }) => path !== 'scripts/articles/lib/mutations.mjs')
    .filter(({ text }) => (text.match(MUTATION_DOC) ?? []).length > 0)
    .map(({ path }) => path);
}

const NETWORK_BUILTINS = Object.freeze(['node:http', 'node:https', 'node:http2', 'node:net', 'node:tls', 'node:dgram', 'node:child_process']);
const COMMAND_MODULES = Object.freeze(['push.mjs', 'pull.mjs', 'status.mjs', 'verify.mjs'].map((f) => join(ARTICLES, f)));
const ADMIN_MODULES = Object.freeze([
  join(REPO_ROOT, 'scripts', 'blank-inventory', 'lib', 'admin.mjs'),
  join(REPO_ROOT, 'scripts', 'site-check', 'lib', 'admin-readonly.mjs'),
]);

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Everything in an entry's import closure that could reach the network or a store. */
export async function networkReach(entry) {
  const { files, bare } = await importClosure(entry);
  const out = bare.map((b) => `${rel(b.from)}: bare specifier ${b.spec}`);
  for (const file of files) {
    if ([...COMMAND_MODULES, ...ADMIN_MODULES].includes(file)) out.push(`reaches ${rel(file)}`);
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const spec of [...importsOf(code), ...exportFromsOf(code)]) {
      if (NETWORK_BUILTINS.includes(spec) || /^(https?|net|tls|child_process)$/.test(spec)) out.push(`${rel(file)} imports ${spec}`);
    }
    if (/\bfetch\s*\(/.test(code)) out.push(`${rel(file)} calls fetch`);
  }
  return out;
}

test('nothing under scripts/articles/ names a way to make an article visible', () => {
  const files = walk(ARTICLES).map((full) => ({ path: rel(full), text: readFileSync(full, 'utf8') }));
  assert.ok(files.length > 20, `expected a real tree, saw ${files.length}`);
  assert.deepEqual(visibilityOffenders(files), []);
  // Positive controls, through the same function.
  for (const { label } of VISIBILITY) {
    assert.equal(visibilityOffenders([{ path: 'scripts/articles/x.mjs', text: `const input = { ${label} };` }]).length, 1, label);
  }
  assert.equal(visibilityOffenders([{ path: 'x', text: ['isPublished', 'true'].join(':') }]).length, 1);
});

test('mutation documents live in lib/mutations.mjs and nowhere else, and name only the two reviewed operations', () => {
  const modules = walk(ARTICLES)
    .filter((full) => full.endsWith('.mjs') && !rel(full).startsWith('scripts/articles/test/'))
    .map((full) => ({ path: rel(full), text: readFileSync(full, 'utf8') }));
  assert.deepEqual(mutationOffenders(modules), []);
  const own = modules.find((m) => m.path === 'scripts/articles/lib/mutations.mjs');
  assert.equal((own.text.match(MUTATION_DOC) ?? []).length, 2, 'the scan no longer sees the two real documents, so it proves nothing');
  assert.deepEqual(MUTATION_ROOT_FIELDS, { ArticleCreate: 'articleCreate', ArticleUpdate: 'articleUpdate' });
  // Positive controls: a document in a command, in either quote style.
  const q = '`';
  assert.deepEqual(mutationOffenders([{ path: 'scripts/articles/status.mjs', text: `const D = ${q}mutation X($id: ID!) { y }${q};` }]), ['scripts/articles/status.mjs']);
  assert.deepEqual(mutationOffenders([{ path: 'scripts/articles/pull.mjs', text: "const D = 'mutation { y }';" }]), ['scripts/articles/pull.mjs']);
});

test('the import closure of every lib module reaches no network, no Admin client and no command', async () => {
  const libFiles = readdirSync(LIB).filter((f) => f.endsWith('.mjs'));
  assert.ok(libFiles.length >= 9, libFiles.join(', '));
  for (const file of libFiles) {
    assert.deepEqual(await networkReach(join(LIB, file)), [], file);
  }
});

test('the closure guard fires at depth two', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'articles-closure-'));
  try {
    writeFileSync(join(dir, 'a.mjs'), "import { b } from './b.mjs';\nexport const a = b;\n", 'utf8');
    writeFileSync(join(dir, 'b.mjs'), "import https from 'node:https';\nexport const b = https;\n", 'utf8');
    writeFileSync(join(dir, 'c.mjs'), "import { a } from './a.mjs';\nexport const c = () => fetch('https://x');\n", 'utf8');
    const reach = await networkReach(join(dir, 'c.mjs'));
    assert.ok(reach.some((r) => r.endsWith('imports node:https')), reach.join('\n'));
    assert.ok(reach.some((r) => r.endsWith('calls fetch')), reach.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(existsSync(LIB) && statSync(LIB).isDirectory());
});
