// Housekeeping decisions over the two directories this module accumulates files in. Both are
// report-first, and both have a "safe" direction that keeps more, so the tests assert the refusals
// rather than the deletions.

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyChartFiles, selectSnapshotsToPrune, snapshotTime } from '../lib/artifacts.mjs';

const chart = (page, hash) => `huddle-crewneck-applique-pattern-chart-${page}-of-2-${hash}.jpg`;
const file = (name, mtimeMs) => ({ name, mtimeMs });

// ---------------------------------------------------------------------------
// Rendered chart files
// ---------------------------------------------------------------------------

test('a file the manifest names is kept; one nothing references is stale', () => {
  const r = classifyChartFiles({
    files: [file(chart(1, 'aaaaaaaa'), 100), file(chart(2, 'bbbbbbbb'), 100), file(chart(1, 'old00000'), 50)],
    manifestFilenames: [chart(1, 'aaaaaaaa'), chart(2, 'bbbbbbbb')],
    publishedFilenames: [],
    manifestMtimeMs: 200,
  });
  assert.deepEqual(r.stale, [chart(1, 'old00000')]);
  assert.deepEqual(r.keep, [chart(1, 'aaaaaaaa'), chart(2, 'bbbbbbbb')]);
  assert.equal(r.prunable, true);
  assert.equal(r.reason, null);
});

test('a file the registry records as PUBLISHED is never stale, whatever the manifest says', () => {
  const r = classifyChartFiles({
    files: [file(chart(1, 'live0000'), 100)],
    manifestFilenames: [],
    publishedFilenames: [chart(1, 'live0000')],
    manifestMtimeMs: 200,
  });
  assert.deepEqual(r.stale, []);
});

test('pruning is REFUSED when a chart file is newer than the manifest', () => {
  // The trap: `render.mjs --page N` deliberately skips the manifest write, so a manifest-keyed
  // prune straight after it would delete every other page's chart.
  const r = classifyChartFiles({
    files: [file(chart(1, 'aaaaaaaa'), 100), file(chart(2, 'freshpg2'), 500)],
    manifestFilenames: [chart(1, 'aaaaaaaa')],
    publishedFilenames: [],
    manifestMtimeMs: 200,
  });
  assert.deepEqual(r.stale, [chart(2, 'freshpg2')]);
  assert.equal(r.prunable, false);
  assert.match(r.reason, /newer than the manifest.*partial "--page N" render/s);
});

test('pruning is REFUSED with no manifest at all', () => {
  const r = classifyChartFiles({
    files: [file(chart(1, 'aaaaaaaa'), 100)],
    manifestFilenames: [],
    publishedFilenames: [],
    manifestMtimeMs: null,
  });
  assert.equal(r.prunable, false);
  assert.match(r.reason, /no charts manifest/);
});

// ---------------------------------------------------------------------------
// Live-media snapshots: the only rollback record for a live write.
// ---------------------------------------------------------------------------

const snap = (iso, label = 'live') => `live-media-${iso.replace(/[:.]/g, '-')}-${label}.json`;
const day = (n) => `2026-08-${String(n).padStart(2, '0')}T12:00:00.000Z`;

test('snapshotTime reads our filenames and refuses anything else', () => {
  assert.equal(snapshotTime(snap(day(1))), Date.parse(day(1)));
  assert.equal(snapshotTime(snap(day(2), 'pre-reorder')), Date.parse(day(2)));
  assert.equal(snapshotTime('notes.txt'), null);
  assert.equal(snapshotTime('live-media-whenever-live.json'), null);
});

test('with no converged audit on record, nothing is pruned', () => {
  const names = Array.from({ length: 30 }, (_, i) => snap(day(i + 1)));
  assert.deepEqual(selectSnapshotsToPrune({ names, keep: 10, lastConvergedAtMs: null }).prune, []);
});

test('the newest 10 survive regardless of the watermark', () => {
  const names = Array.from({ length: 30 }, (_, i) => snap(day(i + 1)));
  const { prune, keep } = selectSnapshotsToPrune({
    names, keep: 10, lastConvergedAtMs: Date.parse(day(31)),
  });
  assert.equal(prune.length, 20);
  assert.equal(keep.length, 10);
  for (let i = 21; i <= 30; i++) assert.ok(keep.includes(snap(day(i))), `day ${i} is in the newest 10`);
});

test('nothing newer than the last converged audit is ever pruned', () => {
  const names = Array.from({ length: 30 }, (_, i) => snap(day(i + 1)));
  const { prune } = selectSnapshotsToPrune({ names, keep: 10, lastConvergedAtMs: Date.parse(day(5)) });
  // Only days 1 to 4 are both outside the newest 10 AND older than the watermark.
  assert.deepEqual(prune, [1, 2, 3, 4].map((d) => snap(day(d))).sort());
});

test('the newest snapshot survives even at keep 0', () => {
  const names = [snap(day(1)), snap(day(2)), snap(day(3))];
  const { prune, keep } = selectSnapshotsToPrune({ names, keep: 0, lastConvergedAtMs: Date.parse(day(9)) });
  assert.ok(!prune.includes(snap(day(3))));
  assert.ok(keep.includes(snap(day(3))));
  assert.deepEqual(prune, [snap(day(1)), snap(day(2))].sort());
});

test('files this module cannot date are never pruned', () => {
  const names = [snap(day(1)), snap(day(2)), 'operator-notes.md', 'live-media-garbage.json'];
  const r = selectSnapshotsToPrune({ names, keep: 1, lastConvergedAtMs: Date.parse(day(9)) });
  assert.deepEqual(r.prune, [snap(day(1))]);
  assert.deepEqual(r.undated, ['live-media-garbage.json', 'operator-notes.md']);
});
