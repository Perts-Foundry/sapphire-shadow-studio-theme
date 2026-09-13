// The sensitive-content patterns, at their edges.
//
// BOTH DIRECTIONS, ON PURPOSE. The phone rule used to match any run of eight digits with optional
// punctuation, which fired on dates, year ranges, cache-busting queries and CDN paths. A rule that
// fires on every image URL is a rule authors learn to route around, so the negative controls here
// are as load-bearing as the positive ones: each is a string a real article body carries.

import test from 'node:test';
import assert from 'node:assert/strict';

import { RULES, sensitiveFindings } from '../lib/articles.mjs';

function rulesFor(text) {
  return [...new Set(sensitiveFindings(text, 'h', 'the body').map((f) => f.rule))].sort();
}

const NOT_SENSITIVE = [
  'Published 2026-09-13.',
  'Made here from 2019-2026.',
  'A tote for $24.99.',
  'SKU LEAD2-RN-NAVY-M is back.',
  '<img src="https://cdn.shopify.com/a.jpg?v=1726012345" alt="a">',
  '<img src="https://cdn.shopify.com/s/files/1/0123/4567/8901/files/a.jpg" alt="a">',
  '<a href="/pages/home/about">home</a>',
];

for (const text of NOT_SENSITIVE) {
  test(`not sensitive: ${JSON.stringify(text)}`, () => {
    assert.deepEqual(rulesFor(text), []);
  });
}

const PHONES = ['(555) 867-5309', '555-867-5309', '555.867.5309', '+1 555 867 5309', '555 867 5309', '+1 (555) 867-5309'];

for (const phone of PHONES) {
  test(`phone-shaped: ${phone}`, () => {
    assert.deepEqual(rulesFor(`Call ${phone} today.`), [RULES.PHONE_SHAPED]);
  });
}

test('a longer digit run is not read as a phone by its middle ten digits', () => {
  assert.deepEqual(rulesFor('Order 1555-867-53099'), []);
});

const PATHS = ['/c/Users/x/', 'C:\\Users\\x', 'c:\\Users\\x', '/home/someone/', '/mnt/c/Users/x/', '/Users/x/', '~/repos/x'];

for (const path of PATHS) {
  test(`machine path: ${path}`, () => {
    assert.deepEqual(rulesFor(`The file is at ${path} somewhere.`), [RULES.MACHINE_PATH]);
  });
}
