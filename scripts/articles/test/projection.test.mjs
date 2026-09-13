// lib/projection.mjs: the one shape every comparison reads, and the structural body comparator.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import {
  WRITTEN_FIELDS,
  bodiesEquivalent,
  differsOnlyByTableWhitespace,
  fieldDifferences,
  imageDiffers,
  liveProjection,
  projectionSha,
  repoProjection,
  tableSegments,
} from '../lib/projection.mjs';
import { readRepoArticle } from '../repo.mjs';
import { HANDLE, cleanRoot, cleanup } from './helpers.mjs';
import { VISIBLE, nodeFromRepo } from './network-helpers.mjs';

after(() => cleanup());

const TABLE = '<table><tr><th>Size</th><th>Chest</th></tr><tr><td>M</td><td>40 in</td></tr></table>';
const STORED = '<table>\n<tr>\n<th>Size</th>\n<th>Chest</th>\n</tr>\n<tr>\n<td>M</td>\n<td>40 in</td>\n</tr>\n</table>';

test('differsOnlyByTableWhitespace: byte-identical outside tables, whitespace-insensitive inside them', () => {
  assert.equal(differsOnlyByTableWhitespace(`<p>a</p>\n${TABLE}\n<p>b</p>`, `<p>a</p>\n${STORED}\n<p>b</p>`), true);
  assert.equal(bodiesEquivalent(`<p>a</p>\n${TABLE}`, `<p>a</p>\n${STORED}`), true);
  // Identical is not "differs".
  assert.equal(differsOnlyByTableWhitespace(TABLE, TABLE), false);
  assert.equal(bodiesEquivalent(TABLE, TABLE), true);
  // Whitespace OUTSIDE a table is a real difference.
  assert.equal(differsOnlyByTableWhitespace(`<p>a</p>${TABLE}`, `<p>a</p>\n${TABLE}`), false);
  assert.equal(differsOnlyByTableWhitespace('<p>a b</p>', '<p>a  b</p>'), false);
  // Text inside a cell is content, and the space between two words is part of it.
  assert.equal(differsOnlyByTableWhitespace(TABLE, TABLE.replace('40 in', '42 in')), false);
  assert.equal(differsOnlyByTableWhitespace(TABLE, TABLE.replace('40 in', '40in')), false);
});

test('the comparator fails closed on input it was not designed for: nested, unclosed or stray tables', () => {
  const nested = '<table><tr><td><table><tr><td>x</td></tr></table></td></tr></table>';
  assert.equal(tableSegments(nested), null);
  assert.equal(differsOnlyByTableWhitespace(nested, nested.replace(/<tr>/g, '\n<tr>')), false);
  assert.equal(tableSegments('<table><tr><td>x</td></tr>'), null);
  assert.equal(tableSegments('<p>x</p></table>'), null);
  assert.deepEqual(tableSegments(`<p>a</p>${TABLE}<p>b</p>`), [
    { table: false, text: '<p>a</p>' },
    { table: true, text: TABLE },
    { table: false, text: '<p>b</p>' },
  ]);
});

test('the repo projection and the live projection of the same article agree, field for field and by hash', () => {
  const root = cleanRoot();
  const repo = readRepoArticle(root, HANDLE).projection;
  const live = liveProjection(nodeFromRepo(root));
  assert.deepEqual(Object.keys(repo), [...WRITTEN_FIELDS]);
  assert.deepEqual(Object.keys(live), [...WRITTEN_FIELDS]);
  assert.deepEqual(live, repo);
  assert.equal(projectionSha(live), projectionSha(repo));
  assert.deepEqual(fieldDifferences(repo, live), []);
  assert.equal(repo.isPublished, false, 'the repo means a hidden article, always');
});

test('empty and absent project as null, and the image version query is stripped', () => {
  const p = repoProjection({ article: { handle: 'x', title: '', summary: '', seo: null, templateSuffix: '', image: null, tags: [] }, body: '<p>x</p>', images: { images: [] } });
  for (const field of ['title', 'summary', 'seoTitle', 'seoDescription', 'templateSuffix', 'imageUrl', 'imageAlt']) assert.equal(p[field], null, field);
  const live = liveProjection({ handle: 'x', image: { url: 'https://cdn.shopify.com/a.jpg?v=123', altText: '' }, titleTag: { value: '' } });
  assert.equal(live.imageUrl, 'https://cdn.shopify.com/a.jpg');
  assert.equal(live.imageAlt, null);
  assert.equal(live.seoTitle, null);
});

test('every written field moves the hash, and tag ORDER does not', () => {
  const root = cleanRoot();
  const base = readRepoArticle(root, HANDLE).projection;
  const changed = {
    handle: 'other', title: 'Other', author: 'Other', summary: 'Other', tags: ['other'], templateSuffix: 'photo-story',
    seoTitle: 'Other', seoDescription: 'Other', imageUrl: 'https://cdn.shopify.com/other.jpg', imageAlt: 'Other', body: '<p>Other</p>', isPublished: VISIBLE,
  };
  for (const field of WRITTEN_FIELDS) {
    assert.ok(field in changed, `no change for ${field}`);
    const next = { ...base, [field]: changed[field] };
    assert.notEqual(projectionSha(next), projectionSha(base), field);
    assert.deepEqual(fieldDifferences(base, next), [field]);
  }
  const reordered = { ...base, tags: [...base.tags].reverse() };
  assert.equal(projectionSha(reordered), projectionSha(base));
  assert.deepEqual(fieldDifferences(base, reordered), []);
  assert.deepEqual(fieldDifferences(base, { ...base, isPublished: VISIBLE }, { ignore: ['isPublished'] }), []);
});

test('the featured image compares by presence and recorded source, because Shopify re-hosts it', () => {
  const SRC = 'https://cdn.shopify.com/s/files/1/0000/0001/files/bench-overview.jpg';
  const COPY = 'https://cdn.shopify.com/s/files/1/0000/0001/articles/bench-overview.jpg';
  const repo = { imageUrl: SRC };
  const cases = [
    // [live imageUrl, imageSource, differs, why]
    [COPY, SRC, false, 'a re-hosted copy of the recorded source is the same image'],
    [COPY, 'https://cdn.shopify.com/s/files/1/0000/0001/files/older.jpg', true, 'the repo image changed since the copy was made'],
    [COPY, null, true, 'an unknown source never reads as the same'],
    [COPY, undefined, true, 'an omitted source is unknown too'],
    [SRC, null, false, 'Admin holding the very URL needs no record'],
    [null, SRC, true, 'the repo has an image and Admin has none'],
  ];
  for (const [liveUrl, imageSource, differs, why] of cases) {
    assert.equal(imageDiffers(repo, { imageUrl: liveUrl }, imageSource), differs, why);
    assert.deepEqual(fieldDifferences({ ...repo, tags: [] }, { imageUrl: liveUrl, tags: [] }, { ignore: WRITTEN_FIELDS.filter((f) => f !== 'imageUrl'), imageSource }), differs ? ['imageUrl'] : [], why);
  }
  assert.equal(imageDiffers({ imageUrl: null }, { imageUrl: COPY }, null), true, 'Admin has an image the repo does not');
  assert.equal(imageDiffers({ imageUrl: null }, { imageUrl: null }, null), false);
});
