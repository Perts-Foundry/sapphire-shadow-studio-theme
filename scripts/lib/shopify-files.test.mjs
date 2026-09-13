import test from 'node:test';
import assert from 'node:assert/strict';

import { matchesFilename } from './shopify-files.mjs';

const url = (stem, ext = 'jpg') => `https://cdn.shopify.com/s/files/1/0000/0001/files/${stem}.${ext}?v=9`;

test('the duplicate matcher sees past the cache buster and the collision suffix', () => {
  assert.equal(matchesFilename(url('a-test-post-cover'), 'a-test-post-cover.jpg'), true);
  assert.equal(matchesFilename(url('a-test-post-cover_2'), 'a-test-post-cover.jpg'), true);
  assert.equal(matchesFilename(url('a-test-post-cover_12'), 'a-test-post-cover.jpg'), true);
});

test('the duplicate matcher refuses near misses, a non-numeric suffix, and anything that is not a URL', () => {
  assert.equal(matchesFilename(url('a-test-post-cover-2'), 'a-test-post-cover.jpg'), false);
  assert.equal(matchesFilename(url('a-test-post-cover-old'), 'a-test-post-cover.jpg'), false);
  assert.equal(matchesFilename(url('a-test-post-cover_x'), 'a-test-post-cover.jpg'), false);
  assert.equal(matchesFilename(url('a-test-post-cover_'), 'a-test-post-cover.jpg'), false);
  assert.equal(matchesFilename(url('lead2_crew'), 'a-test-post-cover.jpg'), false);
  assert.equal(matchesFilename('not a url', 'a-test-post-cover.jpg'), false);
  assert.equal(matchesFilename(undefined, 'a-test-post-cover.jpg'), false);
  assert.equal(matchesFilename(null, 'a-test-post-cover.jpg'), false);
  assert.equal(matchesFilename('', 'a-test-post-cover.jpg'), false);
});

test('a filename carrying RegExp metacharacters is compared literally', () => {
  // The email-icon copy of this function built a RegExp from the name unescaped, so `a.b` matched `aXb_1`.
  assert.equal(matchesFilename(url('aXb_1', 'png'), 'a.b.png'), false);
  assert.equal(matchesFilename(url('a+b_1', 'png'), 'a+b.png'), true);
});
