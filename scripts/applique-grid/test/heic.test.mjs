import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLOR_TRANSFORM_VERSION, DECODER_VERSION, crc32, decodeToRaw, decodeToSrgb, embedIccProfile,
  planIngest, profileDescription, sharpFromDecoded, sharpFromRaw,
} from '../lib/heic.mjs';

// A 2x2 RGBA buffer: red, green, blue, white.
const syntheticRaw = () => Buffer.from([
  255, 0, 0, 255, 0, 255, 0, 255,
  0, 0, 255, 255, 255, 255, 255, 255,
]);

test('heic-decode import smoke: module loads and exposes a decode function', async () => {
  // A broken dependency bump (missing WASM carrier, changed export shape) surfaces here instead
  // of at the first real ingest.
  const mod = await import('heic-decode');
  assert.equal(typeof mod.default, 'function');
  assert.match(DECODER_VERSION, /^\d+\.\d+\.\d+/);
});

test('decodeToRaw returns a Buffer with verified dimensions (injected decoder)', async () => {
  // new Uint8Array(...) copies into an exactly-sized ArrayBuffer (Buffer.from(...).buffer would
  // be Node's shared pool, thousands of bytes long).
  const raw = await decodeToRaw(Buffer.alloc(4), {
    decode: async () => ({ width: 2, height: 2, data: new Uint8Array(syntheticRaw()).buffer }),
  });
  assert.equal(raw.width, 2);
  assert.equal(raw.height, 2);
  assert.ok(Buffer.isBuffer(raw.data));
  assert.equal(raw.data.length, 16);
});

test('decodeToRaw rejects implausible decoder output', async () => {
  await assert.rejects(
    () => decodeToRaw(Buffer.alloc(4), { decode: async () => ({ width: 0, height: 2, data: new ArrayBuffer(0) }) }),
    /implausible dimensions/,
  );
  await assert.rejects(
    () => decodeToRaw(Buffer.alloc(4), { decode: async () => ({ width: 2, height: 2, data: new ArrayBuffer(8) }) }),
    /expected 16/,
  );
});

test('raw RGBA feeds sharp cleanly (synthetic buffer, no HEIC binary in git)', async () => {
  const instance = await sharpFromRaw({ data: syntheticRaw(), width: 2, height: 2 });
  const png = await instance.png().toBuffer();
  const { default: sharp } = await import('sharp');
  const meta = await sharp(png).metadata();
  assert.equal(meta.format, 'png');
  assert.equal(meta.width, 2);
  assert.equal(meta.height, 2);
});

// ---------------------------------------------------------------------------
// Ingest planner.
// ---------------------------------------------------------------------------

const SOURCES = [
  { basename: 'IMG_0001.heic', sha256: 'aa' },
  { basename: 'IMG_0002.heic', sha256: 'bb' },
  { basename: 'IMG_0003.heic', sha256: 'cc' },
];
const CURRENT = { decoderVersion: DECODER_VERSION, colorTransformVersion: COLOR_TRANSFORM_VERSION };
const PREV = {
  'IMG_0001.heic': { sha256: 'aa', ...CURRENT },
  'IMG_0002.heic': { sha256: 'STALE', ...CURRENT },
};
const PATTERNS = [{ id: 'sunset-bloom', sources: ['IMG_0001.heic'] }];

test('unchanged photo skips; changed content under the same basename re-decodes; new decodes', () => {
  const plan = planIngest({ sources: SOURCES, previous: PREV, ...CURRENT, patterns: PATTERNS });
  assert.deepEqual(plan.skip, ['IMG_0001.heic']);
  assert.deepEqual(plan.decode, ['IMG_0002.heic', 'IMG_0003.heic']);
});

test('a decoder version bump forces re-decode of everything', () => {
  const plan = planIngest({ sources: SOURCES, previous: PREV, ...CURRENT, decoderVersion: '999.0.0', patterns: PATTERNS });
  assert.deepEqual(plan.skip, []);
  assert.equal(plan.decode.length, 3);
});

test('a colour-transform bump forces re-decode of everything', () => {
  const plan = planIngest({ sources: SOURCES, previous: PREV, ...CURRENT, colorTransformVersion: '999', patterns: PATTERNS });
  assert.deepEqual(plan.skip, []);
  assert.equal(plan.decode.length, 3);
});

test('a manifest entry predating the colour transform re-decodes rather than skipping', () => {
  // The exact state every existing ingest-manifest was in when the colour transform landed: the
  // source and the decoder both match, and only the (absent) colour key differs.
  const previous = { 'IMG_0001.heic': { sha256: 'aa', decoderVersion: DECODER_VERSION } };
  const plan = planIngest({ sources: SOURCES, previous, ...CURRENT, patterns: PATTERNS });
  assert.deepEqual(plan.skip, []);
  assert.ok(plan.decode.includes('IMG_0001.heic'));
});

test('a missing version key is an error, never a defaulted skip', () => {
  // undefined === undefined on both sides of the skip comparison would silently keep every stale
  // cell, which is the failure the key exists to prevent.
  assert.throws(
    () => planIngest({ sources: SOURCES, previous: PREV, colorTransformVersion: COLOR_TRANSFORM_VERSION }),
    /non-empty decoderVersion/,
  );
  assert.throws(
    () => planIngest({ sources: SOURCES, previous: PREV, decoderVersion: DECODER_VERSION }),
    /non-empty colorTransformVersion/,
  );
});

test('force re-decodes even unchanged photos', () => {
  const plan = planIngest({ sources: SOURCES, previous: PREV, ...CURRENT, patterns: PATTERNS, force: true });
  assert.deepEqual(plan.skip, []);
  assert.equal(plan.decode.length, 3);
});

test('a registry source missing from the source dir is an error naming the pattern', () => {
  assert.throws(
    () => planIngest({
      sources: SOURCES,
      previous: {},
      ...CURRENT,
      patterns: [{ id: 'night-garden', sources: ['IMG_0009.heic'] }],
    }),
    /pattern "night-garden" needs source photo IMG_0009\.heic/,
  );
});

test('unassigned photos are listed', () => {
  const plan = planIngest({ sources: SOURCES, previous: {}, ...CURRENT, patterns: PATTERNS });
  assert.deepEqual(plan.unassigned, ['IMG_0002.heic', 'IMG_0003.heic']);
});

test('the planner never mutates its inputs (the source side is read-only)', () => {
  const sources = SOURCES.map((s) => Object.freeze({ ...s }));
  Object.freeze(sources);
  const previous = Object.freeze({ 'IMG_0001.heic': Object.freeze({ sha256: 'aa', ...CURRENT }) });
  const patterns = Object.freeze([Object.freeze({ id: 'p', sources: Object.freeze(['IMG_0001.heic']) })]);
  assert.doesNotThrow(() => planIngest({ sources, previous, ...CURRENT, patterns }));
});

// ---------------------------------------------------------------------------
// Colour: the transform that lands decoded photos in real sRGB.
// ---------------------------------------------------------------------------

/**
 * A real Display P3 profile plus a matching pair of pixel buffers, built from sharp's own built-in
 * profile so the suite stays hermetic and no binary fixture lives in git. `srgb` is the reference
 * colour; `p3` is that same colour encoded in Display P3, which is what heic-decode hands the
 * pipeline once the container's profile has been dropped.
 */
async function p3Fixture() {
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
function fakeHeic(type, profile = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from('colr', 'ascii'), Buffer.from(type, 'ascii'), profile]);
}

/** heic-decode's shape: RGBA, fully opaque, in a standalone ArrayBuffer. */
function asRgba(rgb, width, height) {
  const out = Buffer.alloc(width * height * 4, 255);
  for (let p = 0; p < width * height; p++) {
    out[p * 4] = rgb[p * 3];
    out[p * 4 + 1] = rgb[p * 3 + 1];
    out[p * 4 + 2] = rgb[p * 3 + 2];
  }
  return new Uint8Array(out).buffer;
}

const maxDelta = (a, b) => {
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
  return max;
};

test('crc32 matches the well-known PNG IEND checksum', () => {
  assert.equal(crc32(Buffer.from('IEND', 'ascii')), 0xae426082);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('the P3 fixture really is a different encoding of the same colours', async () => {
  const { srgb, p3, profile } = await p3Fixture();
  assert.ok(Buffer.isBuffer(profile) && profile.length > 100, 'sharp exposes a built-in p3 profile');
  assert.ok(maxDelta(srgb, p3) > 20, 'the P3 encoding of these colours differs materially from sRGB');
});

test('decodeToSrgb converts P3 pixels back to the colour they represent', async () => {
  // The load-bearing test for the whole colour path. It inverts a forward transform sharp itself
  // performed, so it needs no golden numbers, and it goes red if sharp stops importing an embedded
  // profile, if the iCCP write breaks, or if the conversion direction inverts.
  const { width, height, srgb, p3, profile } = await p3Fixture();
  const decoded = await decodeToSrgb(fakeHeic('prof', profile), {
    decode: async () => ({ width, height, data: asRgba(p3, width, height) }),
  });
  assert.equal(decoded.converted, true);
  assert.equal(decoded.channels, 3);
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.match(decoded.colorNote, /P3.*->.*sRGB/);
  assert.ok(
    maxDelta(decoded.data, srgb) <= 3,
    `converted pixels should match the reference sRGB colours (max delta ${maxDelta(decoded.data, srgb)})`,
  );
});

test('decodeToSrgb leaves a profile-less photo alone and says so', async () => {
  const { width, height, srgb } = await p3Fixture();
  for (const [container, pattern] of [
    [fakeHeic('nclx'), /nclx colour info present/],
    [Buffer.from('no colour signalling at all', 'ascii'), /no colour info in the HEIC/],
  ]) {
    const decoded = await decodeToSrgb(container, {
      decode: async () => ({ width, height, data: asRgba(srgb, width, height) }),
    });
    assert.equal(decoded.converted, false);
    assert.equal(decoded.channels, 3);
    assert.match(decoded.colorNote, pattern);
    assert.equal(maxDelta(decoded.data, srgb), 0, 'unconverted pixels pass through untouched');
  }
});

test('embedIccProfile inserts a readable profile before IDAT and changes no pixel', async () => {
  const { default: sharp } = await import('sharp');
  const { width, height, srgb, profile } = await p3Fixture();
  const plain = await sharp(srgb, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  const tagged = embedIccProfile(plain, profile);

  const meta = await sharp(tagged).metadata();
  assert.ok(meta.icc.equals(profile), 'the profile survives the chunk write byte for byte');
  assert.ok(tagged.indexOf(Buffer.from('iCCP', 'ascii')) < tagged.indexOf(Buffer.from('IDAT', 'ascii')));
  assert.equal((await sharp(plain).metadata()).icc, undefined, 'the carrier had no profile to begin with');
});

test('embedIccProfile refuses inputs it cannot safely tag', async () => {
  const { default: sharp } = await import('sharp');
  const { width, height, srgb, profile } = await p3Fixture();
  const plain = await sharp(srgb, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  assert.throws(() => embedIccProfile(Buffer.from('not a png'), profile), /not a PNG/);
  assert.throws(() => embedIccProfile(plain, Buffer.alloc(0)), /profile is empty/);
  assert.throws(() => embedIccProfile(embedIccProfile(plain, profile), profile), /already carries a profile/);
});

test('profileDescription reads the profile name, and returns null rather than guessing', async () => {
  const { profile } = await p3Fixture();
  assert.match(profileDescription(profile), /P3/);
  assert.equal(profileDescription(Buffer.alloc(0)), null);
  assert.equal(profileDescription(Buffer.alloc(200)), null);
  assert.equal(profileDescription('not a buffer'), null);
});

test('sharpFromDecoded carries the converted channel count', async () => {
  const { width, height, srgb } = await p3Fixture();
  const png = await (await sharpFromDecoded({ data: srgb, width, height, channels: 3 })).png().toBuffer();
  const { default: sharp } = await import('sharp');
  const meta = await sharp(png).metadata();
  assert.equal(meta.width, width);
  assert.equal(meta.height, height);
  assert.equal(meta.channels, 3);
});
