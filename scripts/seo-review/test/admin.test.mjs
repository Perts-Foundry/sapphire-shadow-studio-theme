import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEffectivelyEmpty } from '../admin.mjs';

test('isEffectivelyEmpty treats editor artifacts as empty', () => {
  assert.equal(isEffectivelyEmpty(''), true);
  assert.equal(isEffectivelyEmpty(null), true);
  assert.equal(isEffectivelyEmpty('   '), true);
  assert.equal(isEffectivelyEmpty('<p></p>'), true);
  assert.equal(isEffectivelyEmpty('<p>&nbsp;</p>'), true);
  assert.equal(isEffectivelyEmpty('<p><br></p>\n'), true);
});

test('isEffectivelyEmpty keeps real copy', () => {
  assert.equal(isEffectivelyEmpty('<p>Real body copy.</p>'), false);
  assert.equal(isEffectivelyEmpty('plain text'), false);
});
