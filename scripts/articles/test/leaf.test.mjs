// The dependency floor under the offline checker, asserted rather than promised in a header.
//
// Two promises are made in comments and nothing enforced either:
//
//   - scripts/lib/prose.mjs and scripts/lib/seo-bounds.mjs say "this file imports nothing at all,
//     and must stay that way". They are leaves so that three subsystems can share them without the
//     dependency arrow pointing into any one subsystem's internals.
//   - scripts/articles/lib/ says "no fs, no fetch". That is what keeps `articles:check` an offline
//     command that CI and a Dependabot PR can run with no credential, and what stops the checker
//     quietly becoming a reader of machine-local state.
//
// A header comment is not a guard: the next edit that needs a file read adds the import and leaves
// the comment standing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { exportFromsOf, importsOf } from '../../lib/import-closure.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Every specifier a file loads: static imports, `export ... from`, and dynamic import calls. */
function specifiersOf(source) {
  const dynamic = [...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  return [...importsOf(source), ...exportFromsOf(source), ...dynamic];
}

for (const leaf of ['scripts/lib/prose.mjs', 'scripts/lib/seo-bounds.mjs']) {
  test(`${leaf} imports nothing`, () => {
    const source = readFileSync(join(REPO_ROOT, leaf), 'utf8');
    assert.deepEqual(specifiersOf(source), []);
    assert.equal(/\bimport\s*\(/.test(source), false, 'a dynamic import in any form breaks the leaf');
  });
}

const FORBIDDEN_IN_LIB = ['node:fs', 'node:fs/promises', 'node:child_process', 'node:http', 'node:https', 'node:net'];

const LIB_DIR = join(REPO_ROOT, 'scripts', 'articles', 'lib');
const LIB_FILES = readdirSync(LIB_DIR).filter((f) => f.endsWith('.mjs'));

test('the articles lib directory has files to check', () => {
  assert.ok(LIB_FILES.includes('articles.mjs') && LIB_FILES.includes('body-markup.mjs'), LIB_FILES.join(', '));
});

for (const file of LIB_FILES) {
  test(`scripts/articles/lib/${file} reaches no filesystem, process or network module`, () => {
    const source = readFileSync(join(LIB_DIR, file), 'utf8');
    const hits = specifiersOf(source).filter((s) => FORBIDDEN_IN_LIB.includes(s) || /^(fs|child_process|https?|net)$/.test(s));
    assert.deepEqual(hits, []);
    assert.equal(/\bfetch\s*\(/.test(source), false, `${file} calls fetch`);
  });
}

test('the guard would catch each forbidden form', () => {
  // Positive controls through the same function, so a regex that matched nothing would fail here.
  assert.deepEqual(specifiersOf("import { readFileSync } from 'node:fs';"), ['node:fs']);
  assert.deepEqual(specifiersOf("import {\n  spawn,\n} from 'node:child_process';"), ['node:child_process']);
  assert.deepEqual(specifiersOf("export { x } from './x.mjs';"), ['./x.mjs']);
  assert.deepEqual(specifiersOf("const m = await import('node:https');"), ['node:https']);
});
