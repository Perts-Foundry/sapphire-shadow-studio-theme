import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { planSheet, labelFor, renderSheet } from './contact-sheet.mjs';

// --- planSheet -----------------------------------------------------------------------------
test('planSheet returns an empty plan for an empty list', () => {
  assert.deepEqual(planSheet([], 4, 24), []);
});

test('planSheet with fewer files than columns shrinks the grid to the file count', () => {
  const [sheet] = planSheet(['a.jpg', 'b.jpg'], 4, 24);
  assert.equal(sheet.columns, 2);
  assert.equal(sheet.rows, 1);
  assert.deepEqual(sheet.files, ['a.jpg', 'b.jpg']);
});

test('planSheet with an exact multiple of columns fills whole rows', () => {
  const [sheet] = planSheet(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 4, 24);
  assert.equal(sheet.columns, 4);
  assert.equal(sheet.rows, 2);
});

test('planSheet overflows perSheet into a second sheet, preserving order', () => {
  const files = Array.from({ length: 30 }, (_, i) => `f${String(i).padStart(2, '0')}.jpg`);
  const sheets = planSheet(files, 4, 24);
  assert.equal(sheets.length, 2);
  assert.equal(sheets[0].files.length, 24);
  assert.equal(sheets[1].files.length, 6);
  assert.equal(sheets[0].index, 0);
  assert.equal(sheets[1].index, 1);
  assert.deepEqual([...sheets[0].files, ...sheets[1].files], files);
  assert.equal(sheets[1].rows, 2); // 6 files over 4 columns
});

test('planSheet rejects non-positive geometry', () => {
  assert.throws(() => planSheet(['a'], 0, 24), /columns/);
  assert.throws(() => planSheet(['a'], 4, 0), /perSheet/);
});

// --- labelFor ------------------------------------------------------------------------------
test('labelFor passes short names through and middle-truncates long ones', () => {
  assert.equal(labelFor('short.jpg', 20), 'short.jpg');
  const long = 'a-very-long-filename-that-cannot-possibly-fit-in-a-label.jpg';
  const out = labelFor(long, 20);
  assert.equal(out.length, 20);
  assert.ok(out.includes('...'));
  assert.ok(out.startsWith(long.slice(0, 3)));
  assert.ok(out.endsWith(long.slice(-3)));
});

// --- renderSheet smoke (synthetic images, temp dir) ----------------------------------------
test('renderSheet composes a labeled grid from synthetic images', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'contact-sheet-'));
  try {
    const paths = [];
    for (const [name, color] of [['red.jpg', '#cc0000'], ['green.jpg', '#00cc00'], ['blue.jpg', '#0000cc']]) {
      const p = path.join(dir, name);
      await sharp({ create: { width: 40, height: 30, channels: 3, background: color } }).jpeg().toFile(p);
      paths.push(p);
    }
    const outPath = path.join(dir, 'sheet.jpg');
    const info = await renderSheet(paths, outPath, { columns: 2, cell: 100 });
    assert.equal(info.count, 3);
    assert.equal(info.width, 200); // 2 columns x 100
    const meta = await sharp(outPath).metadata();
    assert.equal(meta.width, info.width);
    assert.equal(meta.height, info.height);
    assert.equal(meta.format, 'jpeg');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('renderSheet refuses an empty file list', async () => {
  await assert.rejects(() => renderSheet([], '/tmp/never.jpg'), /at least one file/);
});
