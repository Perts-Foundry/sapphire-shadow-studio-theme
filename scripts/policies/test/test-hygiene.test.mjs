// A meta-test: rules about the OTHER test files in this directory.
//
// The rules, their history (PR #154, and the bypass that defeated their own first version) and every
// planted control live in scripts/lib/test-hygiene.mjs, shared with scripts/articles/test/. This
// file only says which directory and which parameter names: production here injects a git runner
// as `run` (`assertReviewedTree(root, { run })`) and as `gitRun` (`pull.run({ gitRun })`), and
// missing either spelling is exactly how the first version of these rules covered none of
// pull.test.mjs or status.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerHygieneTests } from '../../lib/test-hygiene.mjs';

registerHygieneTests({
  test,
  assert,
  testDir: dirname(fileURLToPath(import.meta.url)),
  self: 'test-hygiene.test.mjs',
  names: ['gitRun', 'run'],
});
