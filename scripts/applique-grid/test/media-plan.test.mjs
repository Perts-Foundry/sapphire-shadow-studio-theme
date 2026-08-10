import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMediaPlan, PHASE_ORDER } from '../lib/media-plan.mjs';

const HANDLE = 'huddle-crewneck';
const gid = (n) => `gid://shopify/MediaImage/${n}`;
const hash = (c) => c.repeat(64);

const desiredChart = (page, pages, c) => ({
  page,
  pages,
  filename: `${HANDLE}-applique-pattern-chart-${page}-of-${pages}-${c.repeat(8)}.jpg`,
  alt: `Applique pattern chart ${page} of ${pages}: patterns 1-9, X`,
  specHash: hash(c),
});
const liveChart = (n, page, pages, c) => ({
  id: gid(n),
  filename: `${HANDLE}-applique-pattern-chart-${page}-of-${pages}-${c.repeat(8)}.jpg`,
  alt: `Applique pattern chart ${page} of ${pages}: patterns 1-9, X`,
});
const publishedEntry = (n, page, pages, c) => ({
  page,
  filename: `${HANDLE}-applique-pattern-chart-${page}-of-${pages}-${c.repeat(8)}.jpg`,
  mediaGid: gid(n),
  alt: `Applique pattern chart ${page} of ${pages}: patterns 1-9, X`,
  specHash: hash(c),
});
const photo = (n, name) => ({ id: gid(n), filename: name, alt: `${name} description` });

const plan = (over = {}) => buildMediaPlan({
  desired: [], live: [], published: [], variantAttachedIds: new Set(), handle: HANDLE, ...over,
});

test('phase order contract: creates strictly before deletes, barrier between, reorder last', () => {
  assert.deepEqual(PHASE_ORDER, ['creates', 'barrier', 'deletes', 'reorder']);
});

test('converged state yields an empty plan', () => {
  const p = plan({
    desired: [desiredChart(1, 2, 'a'), desiredChart(2, 2, 'b')],
    live: [photo(1, 'flat-1.jpg'), liveChart(2, 1, 2, 'a'), liveChart(3, 2, 2, 'b')],
    published: [publishedEntry(2, 1, 2, 'a'), publishedEntry(3, 2, 2, 'b')],
  });
  assert.deepEqual(p.creates, []);
  assert.deepEqual(p.deletes, []);
  assert.deepEqual(p.suspects, []);
  assert.equal(p.reorderRequired, false);
  assert.equal(p.converged, true);
  assert.equal(p.keeps.length, 2);
});

test('first publish: all creates, no deletes', () => {
  const p = plan({
    desired: [desiredChart(1, 2, 'a'), desiredChart(2, 2, 'b')],
    live: [photo(1, 'flat-1.jpg')],
  });
  assert.equal(p.creates.length, 2);
  assert.deepEqual(p.deletes, []);
  assert.equal(p.reorderRequired, false); // appended creates already form the tail
});

test('a spec change replaces: create the new, delete the recorded old', () => {
  const p = plan({
    desired: [desiredChart(1, 1, 'n')],
    live: [liveChart(5, 1, 1, 'o')],
    published: [publishedEntry(5, 1, 1, 'o')],
  });
  assert.equal(p.creates.length, 1);
  assert.equal(p.deletes.length, 1);
  assert.equal(p.deletes[0].id, gid(5));
  assert.match(p.deletes[0].reason, /recorded chart \(page 1\) no longer matches/);
});

test('page-count transition 3 -> 2 deletes page 3 and replaces pages 1-2', () => {
  const p = plan({
    desired: [desiredChart(1, 2, 'd'), desiredChart(2, 2, 'e')],
    live: [liveChart(1, 1, 3, 'a'), liveChart(2, 2, 3, 'b'), liveChart(3, 3, 3, 'c')],
    published: [publishedEntry(1, 1, 3, 'a'), publishedEntry(2, 2, 3, 'b'), publishedEntry(3, 3, 3, 'c')],
  });
  assert.equal(p.creates.length, 2);
  assert.equal(p.deletes.length, 3);
});

test('page-count transition 2 -> 3 creates the new page(s)', () => {
  const p = plan({
    desired: [desiredChart(1, 3, 'a'), desiredChart(2, 3, 'b'), desiredChart(3, 3, 'c')],
    live: [liveChart(1, 1, 2, 'x'), liveChart(2, 2, 2, 'y')],
    published: [publishedEntry(1, 1, 2, 'x'), publishedEntry(2, 2, 2, 'y')],
  });
  assert.equal(p.creates.length, 3);
  assert.deepEqual(p.creates.map((c) => c.page), [1, 2, 3]);
  assert.equal(p.deletes.length, 2);
});

test('unrecorded media matching BOTH conventions is adopted via filename + alt equality', () => {
  const d = desiredChart(1, 1, 'a');
  const p = plan({
    desired: [d],
    live: [{ id: gid(9), filename: d.filename, alt: d.alt }],
    published: [],
  });
  assert.deepEqual(p.creates, []);
  assert.equal(p.keeps[0].id, gid(9));
});

test('CDN collision suffix still matches the desired filename', () => {
  const d = desiredChart(1, 1, 'a');
  const p = plan({
    desired: [d],
    live: [{ id: gid(9), filename: d.filename.replace('.jpg', '_x1y2.jpg'), alt: d.alt }],
  });
  assert.deepEqual(p.creates, []);
  assert.equal(p.keeps.length, 1);
});

test('an alt-only difference on an unrecorded chart is a replace, not a keep', () => {
  const d = desiredChart(1, 1, 'a');
  const p = plan({
    desired: [d],
    live: [{ id: gid(9), filename: d.filename, alt: 'Applique pattern chart 1 of 1: patterns 1-9, OLD' }],
  });
  assert.equal(p.creates.length, 1);
  assert.equal(p.deletes.length, 1);
});

test('one-signal matches are suspects with reasons, never touched', () => {
  const p = plan({
    desired: [desiredChart(1, 1, 'a')],
    live: [
      { id: gid(7), filename: `${HANDLE}-applique-pattern-chart-9-of-9-aaaaaaaa.jpg`, alt: 'A lovely photo' },
      { id: gid(8), filename: 'random-shot.jpg', alt: 'Applique pattern chart 3 of 3: patterns 1-2, X' },
    ],
  });
  assert.equal(p.deletes.length, 0);
  assert.equal(p.suspects.length, 2);
  assert.match(p.suspects[0].reasons[0], /filename matches the chart convention but the alt does not/);
  assert.match(p.suspects[1].reasons[0], /alt matches the chart convention but the filename does not/);
  for (const s of p.suspects) assert.ok(s.reasons.every((r) => typeof r === 'string' && r.length));
});

test('variant-attached media is refused for deletion regardless of signals', () => {
  const p = plan({
    desired: [desiredChart(1, 1, 'n')],
    live: [liveChart(5, 1, 1, 'o')],
    published: [publishedEntry(5, 1, 1, 'o')],
    variantAttachedIds: new Set([gid(5)]),
  });
  assert.deepEqual(p.deletes, []);
  assert.equal(p.suspects.length, 1);
  assert.match(p.suspects[0].reasons[0], /attached to a variant; deletion refused/);
});

test('non-chart media keeps its relative order; charts form the tail in page order', () => {
  const d1 = desiredChart(1, 2, 'a');
  const d2 = desiredChart(2, 2, 'b');
  const p = plan({
    desired: [d1, d2],
    live: [
      photo(1, 'flat-1.jpg'),
      liveChart(2, 2, 2, 'b'), // page 2 chart currently sits mid-gallery, before page 1's
      photo(3, 'styled-1.jpg'),
      liveChart(4, 1, 2, 'a'),
    ],
    published: [publishedEntry(4, 1, 2, 'a'), publishedEntry(2, 2, 2, 'b')],
  });
  assert.equal(p.creates.length, 0);
  assert.equal(p.reorderRequired, true);
  assert.deepEqual(p.finalOrder, [
    { kind: 'live', id: gid(1) },
    { kind: 'live', id: gid(3) },
    { kind: 'live', id: gid(4) }, // page 1
    { kind: 'live', id: gid(2) }, // page 2
  ]);
});

test('suspects keep their gallery positions in the final order', () => {
  const d = desiredChart(1, 1, 'a');
  const suspect = { id: gid(7), filename: `${HANDLE}-applique-pattern-chart-9-of-9-ffffffff.jpg`, alt: 'not a chart alt' };
  const p = plan({
    desired: [d],
    live: [photo(1, 'flat-1.jpg'), suspect, photo(3, 'styled-1.jpg')],
  });
  assert.deepEqual(p.finalOrder, [
    { kind: 'live', id: gid(1) },
    { kind: 'live', id: gid(7) },
    { kind: 'live', id: gid(3) },
    { kind: 'create', filename: d.filename },
  ]);
});

test('stale published records (media gone from live) are surfaced for pruning', () => {
  const p = plan({
    desired: [],
    live: [photo(1, 'flat-1.jpg')],
    published: [publishedEntry(99, 1, 1, 'z')],
  });
  assert.equal(p.stalePublished.length, 1);
  assert.equal(p.stalePublished[0].mediaGid, gid(99));
});
