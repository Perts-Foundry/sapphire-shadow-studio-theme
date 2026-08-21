// The upload script's network-free halves: the argument gate that makes a live run explicit, and
// the duplicate guard that keeps a second `email-icon-instagram.png` from orphaning the URL the
// templates point at.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, matchesFilename, altFor } from '../upload-email-icons.mjs';

test('a bare run stages nothing, which is what makes it a dry run', () => {
  assert.deepEqual(parseArgs([]).upload, []);
});

test('each file to upload has to be named, and the order is the order given', () => {
  assert.deepEqual(parseArgs(['--upload', 'tiktok', '--upload=instagram']).upload, ['tiktok', 'instagram']);
});

test('a repeated name is not a second upload', () => {
  assert.deepEqual(parseArgs(['--upload', 'facebook', '--upload', 'facebook']).upload, ['facebook']);
});

test('an unknown icon is refused before any token is minted', () => {
  assert.throws(() => parseArgs(['--upload', 'threads']), /not an icon/);
});

test('there is no --all, and a typo does not become one', () => {
  assert.throws(() => parseArgs(['--all']), /Unknown option --all/);
  assert.throws(() => parseArgs(['tiktok']), /Unexpected argument tiktok/);
});

test('the duplicate guard sees past the cache buster', () => {
  assert.equal(
    matchesFilename('https://cdn.shopify.com/s/files/1/0958/0874/9868/files/email-icon-tiktok.png?v=1784386024', 'email-icon-tiktok.png'),
    true
  );
});

test('the duplicate guard catches the _1 suffix Shopify adds on a name collision', () => {
  assert.equal(
    matchesFilename('https://cdn.shopify.com/s/files/1/x/files/email-icon-tiktok_1.png', 'email-icon-tiktok.png'),
    true
  );
});

test('the duplicate guard does not match a different file, or a missing one', () => {
  assert.equal(matchesFilename('https://cdn.shopify.com/s/files/1/x/files/email-icon-tiktok-old.png', 'email-icon-tiktok.png'), false);
  assert.equal(matchesFilename('https://cdn.shopify.com/s/files/1/x/files/lead2_crew.jpg', 'email-icon-tiktok.png'), false);
  assert.equal(matchesFilename(undefined, 'email-icon-tiktok.png'), false);
  assert.equal(matchesFilename('not a url', 'email-icon-tiktok.png'), false);
});

test('Files alt text uses each network\'s own capitalisation', () => {
  assert.equal(altFor('tiktok'), 'TikTok icon for email footers');
  assert.equal(altFor('instagram'), 'Instagram icon for email footers');
});
