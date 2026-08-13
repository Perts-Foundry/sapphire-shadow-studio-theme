import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DECODER_VERSION, crc32, decodeToRaw, decodeToSrgb, embedIccProfile, extractIcc,
  profileDescription, sharpFromDecoded, sharpFromRaw,
} from './heic.mjs';
import { asRgba, fakeHeic, maxDelta, p3Fixture } from './heic.fixtures.mjs';

// A 2x2 RGBA buffer: red, green, blue, white.
const syntheticRaw = () => Buffer.from([
  255, 0, 0, 255, 0, 255, 0, 255,
  0, 0, 255, 255, 255, 255, 255, 255,
]);

// --- decode helpers (mirrors scripts/applique-grid/test/heic.test.mjs, which now exercises the
// --- same implementation through its re-exports) -------------------------------------------
test('heic-decode import smoke: module loads and exposes a decode function', async () => {
  const mod = await import('heic-decode');
  assert.equal(typeof mod.default, 'function');
  assert.match(DECODER_VERSION, /^\d+\.\d+\.\d+/);
});

test('decodeToRaw returns a Buffer with verified dimensions (injected decoder)', async () => {
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

// --- extractIcc ----------------------------------------------------------------------------
// Builders for synthetic colr boxes. Box layout: [size:4][type:'colr'][colourType:4][payload].
// The box size field is deliberately settable to pathological values: extractIcc ignores it (the
// scan is byte-oriented, not a box walk), and these tests pin that it neither loops nor reads out
// of bounds whatever the field says.
function colrBox(colourType, payload, boxSize) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(boxSize ?? 8 + 4 + payload.length, 0);
  head.write('colr', 4);
  return Buffer.concat([head, Buffer.from(colourType, 'ascii'), payload]);
}

// A fake-but-well-formed ICC payload: its own size in the first 4 bytes, 'acsp' at offset 36.
function fakeProfile(len = 128) {
  const p = Buffer.alloc(len);
  p.writeUInt32BE(len, 0);
  p.write('acsp', 36);
  return p;
}

const junk = (n) => Buffer.alloc(n, 0xab);

test('extractIcc returns the profile from a valid prof colr box', () => {
  const profile = fakeProfile();
  const buf = Buffer.concat([junk(16), colrBox('prof', profile), junk(16)]);
  const got = extractIcc(buf);
  assert.ok(Buffer.isBuffer(got));
  assert.equal(got.length, profile.length);
  assert.deepEqual(got, profile);
});

test('extractIcc reports nclx-only colour signalling distinguishably', () => {
  const buf = Buffer.concat([junk(8), colrBox('nclx', junk(7)), junk(8)]);
  assert.equal(extractIcc(buf), 'nclx');
});

test('extractIcc returns null when no colour info exists', () => {
  assert.equal(extractIcc(junk(64)), null);
  assert.equal(extractIcc(Buffer.alloc(0)), null);
});

test('extractIcc survives a truncated buffer without throwing', () => {
  const whole = Buffer.concat([junk(8), colrBox('prof', fakeProfile())]);
  // Cut mid-profile: the size field now overruns the buffer; candidate rejected, null returned.
  assert.equal(extractIcc(whole.subarray(0, whole.length - 40)), null);
  // Cut right after 'colr': not even the colour type is readable.
  const headOnly = Buffer.concat([junk(8), Buffer.from('colr')]);
  assert.equal(extractIcc(headOnly), null);
});

test('extractIcc skips a decoy colr without an acsp signature (mdat noise)', () => {
  const decoyPayload = junk(128); // no acsp at 36
  decoyPayload.writeUInt32BE(128, 0);
  const real = fakeProfile();
  const buf = Buffer.concat([colrBox('prof', decoyPayload), colrBox('prof', real)]);
  assert.deepEqual(extractIcc(buf), real);
});

test('extractIcc is unaffected by the enclosing box size field, because the scan never reads it', () => {
  const real = fakeProfile();
  // The scan locates 'colr' by byte search and validates the payload, so a declared size of 0
  // (extends-to-EOF), 1 (largesize marker), or 5 (< header) changes nothing. This pins that the
  // sizes cannot loop or misdirect the scan; it is NOT a claim that largesize boxes are parsed.
  for (const pathological of [0, 1, 5]) {
    const buf = Buffer.concat([colrBox('prof', real, pathological), junk(8)]);
    assert.deepEqual(extractIcc(buf), real, `box size ${pathological}`);
  }
});

test('extractIcc returns null for a genuine 64-bit largesize box (known byte-scan limitation)', () => {
  // A real largesize box puts an 8-byte size between 'colr' and the colour type, so the scan reads
  // the top half of that field where it expects 'prof' and skips the candidate. Honest pin of the
  // limitation: iPhone HEICs do not use largesize for colr, and a structural BMFF walk is the fix
  // if one ever does.
  const real = fakeProfile();
  const head = Buffer.alloc(16);
  head.writeUInt32BE(1, 0);              // size == 1 -> largesize follows
  head.write('colr', 4, 'ascii');
  head.writeBigUInt64BE(BigInt(16 + real.length), 8); // the 64-bit size
  assert.equal(extractIcc(Buffer.concat([head, Buffer.from('prof', 'ascii'), real])), null);
});

test('extractIcc scans past nclx to a later prof, and takes the first of several profs', () => {
  const real = fakeProfile();
  const nclxFirst = Buffer.concat([colrBox('nclx', junk(7)), colrBox('prof', real)]);
  assert.deepEqual(extractIcc(nclxFirst), real);

  const second = fakeProfile(160);
  const profFirst = Buffer.concat([colrBox('prof', real), colrBox('nclx', junk(7)), colrBox('prof', second)]);
  assert.deepEqual(extractIcc(profFirst), real); // first valid profile wins
});

test('extractIcc rejects short and zero-length profiles without out-of-bounds reads', () => {
  // Profile claiming < 40 bytes: the acsp read would be out of bounds; rejected.
  const short = Buffer.alloc(39);
  short.writeUInt32BE(39, 0);
  assert.equal(extractIcc(colrBox('prof', short)), null);
  // Zero-length profile.
  const zero = Buffer.alloc(4);
  zero.writeUInt32BE(0, 0);
  assert.equal(extractIcc(colrBox('prof', zero)), null);
});

// ---------------------------------------------------------------------------
// Colour: the transform that lands decoded photos in real sRGB. Both pipelines depend on these.
// ---------------------------------------------------------------------------

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
