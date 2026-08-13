// Test-only fixtures for the colour path, shared by scripts/lib/heic.test.mjs and
// scripts/process-product-images.test.mjs so both suites discriminate a real conversion the same
// way. No production module imports this, and node --test never collects it (it is not *.test.mjs).
//
// Everything here is built from sharp's own built-in Display P3 profile, so the suites stay
// hermetic: no HEIC and no ICC binary lives in this public repo.

/**
 * A real Display P3 profile plus a matching pair of pixel buffers. `srgb` is the reference colour;
 * `p3` is that same colour encoded in Display P3, which is exactly what heic-decode hands a
 * pipeline once the container's profile has been dropped. A test that starts from `p3` and lands
 * back on `srgb` has proved the conversion happened in the right direction, which an sRGB donor
 * profile cannot do: sRGB to sRGB is the identity, so it passes whether or not anything converted.
 * @returns {Promise<{width: number, height: number, srgb: Buffer, p3: Buffer, profile: Buffer}>}
 */
export async function p3Fixture() {
  const { default: sharp } = await import('sharp');
  const width = 6;
  const height = 1;
  const srgb = Buffer.from([
    255, 0, 0, 0, 255, 0, 230, 120, 40, 128, 128, 128, 12, 34, 56, 250, 250, 250,
  ]);
  const rawOf = (b) => sharp(b, { raw: { width, height, channels: 3 } });
  const p3 = await rawOf(srgb).withIccProfile('p3').raw().toBuffer();
  const profile = (await sharp(await rawOf(srgb).withIccProfile('p3').png().toBuffer()).metadata()).icc;
  return { width, height, srgb, p3, profile };
}

/** The smallest thing extractIcc accepts: a 'colr' box of the given colour type. */
export function fakeHeic(type, profile = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from('colr', 'ascii'), Buffer.from(type, 'ascii'), profile]);
}

/** heic-decode's shape: RGBA, fully opaque, in a standalone ArrayBuffer. */
export function asRgba(rgb, width, height) {
  const out = Buffer.alloc(width * height * 4, 255);
  for (let p = 0; p < width * height; p++) {
    out[p * 4] = rgb[p * 3];
    out[p * 4 + 1] = rgb[p * 3 + 1];
    out[p * 4 + 2] = rgb[p * 3 + 2];
  }
  return new Uint8Array(out).buffer;
}

/** Largest per-byte difference between two equal-length pixel buffers. */
export const maxDelta = (a, b) => {
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
  return max;
};
