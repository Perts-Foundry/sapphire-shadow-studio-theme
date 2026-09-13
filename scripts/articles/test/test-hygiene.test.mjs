// A meta-test: rules about the OTHER test files in this directory.
//
// The rules are SHARED with scripts/policies/test/, not copied: they live in
// scripts/lib/test-hygiene.mjs with every planted control, and both suites register them. The only
// thing configured here is the parameter name the article push takes its git runner under, `git` on
// its context (and on `assertReviewedTree`'s options). Whatever reaches that parameter in a test must
// be built by the strict fake in scripts/lib/git-fake.mjs.

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
  names: ['git'],
});
