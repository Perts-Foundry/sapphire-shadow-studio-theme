import test from 'node:test';
import assert from 'node:assert/strict';
import { coverCrop } from '../lib/crop.mjs';

test('exact-aspect box passes through untrimmed', () => {
  const { extract, resize } = coverCrop({
    srcWidth: 1000, srcHeight: 800,
    box: { left: 0.1, top: 0.1, width: 0.5, height: 0.5 }, // 500x400, aspect 1.25
    targetWidth: 250, targetHeight: 200, // aspect 1.25
  });
  assert.deepEqual(extract, { left: 100, top: 80, width: 500, height: 400 });
  assert.deepEqual(resize, { width: 250, height: 200 });
});

test('box wider than target aspect trims width, centred', () => {
  const { extract } = coverCrop({
    srcWidth: 1000, srcHeight: 1000,
    box: { left: 0, top: 0, width: 1, height: 0.5 }, // 1000x500, aspect 2
    targetWidth: 100, targetHeight: 100, // aspect 1 -> need 500x500
  });
  assert.deepEqual(extract, { left: 250, top: 0, width: 500, height: 500 });
});

test('box taller than target aspect trims height, centred', () => {
  const { extract } = coverCrop({
    srcWidth: 1000, srcHeight: 1000,
    box: { left: 0, top: 0, width: 0.5, height: 1 }, // 500x1000
    targetWidth: 100, targetHeight: 100, // -> need 500x500
  });
  assert.deepEqual(extract, { left: 0, top: 250, width: 500, height: 500 });
});

test('off-centre box keeps its own centre when trimmed', () => {
  const { extract } = coverCrop({
    srcWidth: 2000, srcHeight: 1000,
    box: { left: 0.5, top: 0, width: 0.5, height: 0.5 }, // 1000x500 at (1000, 0)
    targetWidth: 100, targetHeight: 100, // -> 500x500, centred in the box
  });
  assert.deepEqual(extract, { left: 1250, top: 0, width: 500, height: 500 });
});

test('edge-touching box never overflows the source', () => {
  const { extract } = coverCrop({
    srcWidth: 999, srcHeight: 777,
    box: { left: 0.5, top: 0.5, width: 0.5, height: 0.5 }, // touches right and bottom edges
    targetWidth: 300, targetHeight: 400,
  });
  assert.ok(extract.left >= 0 && extract.top >= 0);
  assert.ok(extract.left + extract.width <= 999);
  assert.ok(extract.top + extract.height <= 777);
});

test('rounding sweep stays within source bounds (sharp extract throws on overflow)', () => {
  const dims = [[4284, 5712], [1200, 1601], [1013, 767], [601, 599]];
  const boxes = [
    { left: 0.33, top: 0.33, width: 0.34, height: 0.34 },
    { left: 0, top: 0, width: 1, height: 1 },
    { left: 0.001, top: 0.997 - 0.5, width: 0.998, height: 0.5 },
    { left: 0.66, top: 0.66, width: 0.34, height: 0.34 },
  ];
  const targets = [[443, 590], [100, 100], [301, 401]];
  for (const [srcWidth, srcHeight] of dims) {
    for (const box of boxes) {
      for (const [targetWidth, targetHeight] of targets) {
        const { extract, resize } = coverCrop({ srcWidth, srcHeight, box, targetWidth, targetHeight });
        assert.ok(extract.left >= 0 && extract.top >= 0, `${srcWidth}x${srcHeight} ${JSON.stringify(box)}`);
        assert.ok(extract.left + extract.width <= srcWidth, `right edge ${srcWidth}x${srcHeight} ${JSON.stringify(box)} -> ${JSON.stringify(extract)}`);
        assert.ok(extract.top + extract.height <= srcHeight, `bottom edge ${srcWidth}x${srcHeight} ${JSON.stringify(box)} -> ${JSON.stringify(extract)}`);
        assert.ok(extract.width >= 1 && extract.height >= 1);
        assert.deepEqual(resize, { width: targetWidth, height: targetHeight });
      }
    }
  }
});

test('degenerate boxes error', () => {
  assert.throws(() => coverCrop({
    srcWidth: 10, srcHeight: 10,
    box: { left: 0.5, top: 0.5, width: 0.001, height: 0.001 },
    targetWidth: 100, targetHeight: 100,
  }), /degenerates/);
  assert.throws(() => coverCrop({
    srcWidth: 100, srcHeight: 100,
    box: { left: 0.9, top: 0, width: 0.2, height: 1 },
    targetWidth: 10, targetHeight: 10,
  }), /out of bounds/);
  assert.throws(() => coverCrop({
    srcWidth: 100, srcHeight: 100,
    box: { left: 0, top: 0, width: -0.5, height: 0.5 },
    targetWidth: 10, targetHeight: 10,
  }), /out of bounds/);
  assert.throws(() => coverCrop({
    srcWidth: 0, srcHeight: 100,
    box: { left: 0, top: 0, width: 1, height: 1 },
    targetWidth: 10, targetHeight: 10,
  }), /srcWidth/);
});
