// Rasterisation smoke test, plus the guard that matters most: the PNGs committed under
// marketing/emails/assets/ are what the current source renders. They are the record of what was
// uploaded to Shopify Files, so a stale commit means the repo describes an image the inbox is not
// showing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';
import { ICON_NAMES } from '../lib/icons.mjs';
import { renderIconPng, fileNameFor } from '../render-email-icons.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const assetDir = path.join(repoRoot, 'marketing/emails/assets');

// Compared as decoded pixels rather than PNG bytes: a different libvips or librsvg build re-encodes
// identical artwork differently, and the failure worth catching is a stale asset, not an encoder
// upgrade. Anti-aliasing moves individual channel values a little, so the bar is the mean.
const MEAN_CHANNEL_TOLERANCE = 4;

test('each icon rasterises to a square RGBA PNG at the 2x display size', async () => {
  for (const name of ICON_NAMES) {
    const meta = await sharp(await renderIconPng(name)).metadata();
    assert.equal(meta.format, 'png');
    assert.equal(meta.width, 56);
    assert.equal(meta.height, 56);
    assert.equal(meta.hasAlpha, true, 'the icons sit on the navy footer, so the ground stays transparent');
  }
});

test('--size renders a different edge without distorting the artboard', async () => {
  const meta = await sharp(await renderIconPng('facebook', { size: 112 })).metadata();
  assert.equal(meta.width, 112);
  assert.equal(meta.height, 112);
});

test('the committed PNGs match what the current source renders', async () => {
  for (const name of ICON_NAMES) {
    const committed = await sharp(path.join(assetDir, fileNameFor(name)))
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const fresh = await sharp(await renderIconPng(name))
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    assert.equal(committed.info.width, fresh.info.width, `${name}: committed PNG is a different size`);
    assert.equal(committed.info.height, fresh.info.height, `${name}: committed PNG is a different size`);
    assert.equal(committed.data.length, fresh.data.length);

    let total = 0;
    for (let i = 0; i < fresh.data.length; i++) total += Math.abs(fresh.data[i] - committed.data[i]);
    const mean = total / fresh.data.length;
    assert.ok(
      mean <= MEAN_CHANNEL_TOLERANCE,
      `${name}: the committed PNG differs from a fresh render (mean channel delta ${mean.toFixed(2)}). `
        + `Re-run scripts/email-icons/render-email-icons.mjs and commit the result.`
    );
  }
});

test('the icons stay small enough to load before the reader scrolls past them', async () => {
  for (const name of ICON_NAMES) {
    const bytes = (await readFile(path.join(assetDir, fileNameFor(name)))).length;
    assert.ok(bytes < 8 * 1024, `${name} is ${bytes} bytes; expected well under 8 KB`);
  }
});
