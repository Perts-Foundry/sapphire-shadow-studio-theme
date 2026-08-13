// The --out-dir containment rule, and the wiring that actually enforces it.
//
// This file exists because the guard had ZERO coverage in all four tools that carry it: it was a
// module-private regex consumed inside main(), so deleting the check outright left the whole suite
// green. The pure cases below pin the rule; the subprocess cases pin the CALL SITES, which is the
// half a pure test can never reach.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { OUT_DIR_RE, outDirProblem } from '../lib/out-dir.mjs';

const run = promisify(execFile);
const MODULE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('outDirProblem accepts product-images and directories under it', () => {
  assert.equal(outDirProblem('/home/x/product-images'), null);
  assert.equal(outDirProblem('/home/x/product-images/applique'), null);
  assert.equal(outDirProblem('/product-images'), null);
  assert.equal(outDirProblem('/a/b/product-images/c/d'), null);
});

test('outDirProblem refuses anything outside, naming the path', () => {
  for (const bad of ['/home/x/notes', '/tmp', '/home/x/images', '/']) {
    const problem = outDirProblem(bad);
    assert.ok(problem, `${bad} must be refused`);
    assert.match(problem, /product-images/);
    assert.ok(problem.includes(bad), `the refusal must name the path it rejected (${bad})`);
  }
});

test('the boundary is a whole path SEGMENT, not a substring', () => {
  // The case the regex's ([\\/]|$) anchor exists for, and which nothing checked: a sibling
  // directory whose name merely starts with product-images must not pass.
  assert.ok(outDirProblem('/home/x/product-images-backup'));
  assert.ok(outDirProblem('/home/x/product-images-backup/old'));
  assert.ok(outDirProblem('/home/x/my-product-images'));
  assert.ok(outDirProblem('/home/x/product-imagesX'));
  // Guard on the guard: a weakened /product-images/ regex would pass the first of those.
  assert.ok(/product-images/.test('/home/x/product-images-backup'));
  assert.equal(OUT_DIR_RE.test('/home/x/product-images-backup'), false);
});

test('outDirProblem refuses a non-absolute or empty value rather than guessing', () => {
  assert.match(outDirProblem('product-images'), /absolute/);
  assert.match(outDirProblem(''), /empty/);
  assert.match(outDirProblem(null), /empty/);
});

// ---------------------------------------------------------------------------
// The call sites. One subprocess per tool: the guard must fire before any credential, registry, or
// filesystem work, so these pass with no .env and no photo tree.
// ---------------------------------------------------------------------------

const GUARDED = [
  { entry: 'ingest.mjs', extra: ['--source', '/tmp/definitely-not-here'] },
  { entry: 'crops.mjs', extra: ['--propose'] },
  { entry: 'draft.mjs', extra: ['--validate'] },
  { entry: 'render.mjs', extra: [] },
];

for (const { entry, extra } of GUARDED) {
  test(`${entry} refuses an --out-dir outside product-images/`, async () => {
    const bad = path.join('/tmp', 'applique-out-dir-guard-probe');
    await assert.rejects(
      () => run(process.execPath, [path.join(MODULE_DIR, entry), '--out-dir', bad, ...extra], {
        cwd: MODULE_DIR,
        env: { ...process.env, MYSHOPIFY_DOMAIN: '', SHOPIFY_CLIENT_ID: '', SHOPIFY_CLIENT_SECRET: '' },
      }),
      (e) => {
        assert.notEqual(e.code, 0, `${entry} must exit non-zero`);
        assert.match(e.stderr, /product-images/, `${entry} must refuse by name`);
        assert.ok(e.stderr.includes(bad), `${entry} must name the rejected path`);
        return true;
      },
    );
  });
}
