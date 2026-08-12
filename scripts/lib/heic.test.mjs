import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DECODER_VERSION, decodeToRaw, sharpFromRaw, extractIcc } from './heic.mjs';

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

test('extractIcc ignores pathological enclosing box sizes (0, 1, <8) without looping', () => {
  const real = fakeProfile();
  // size==0 (extends-to-EOF, legal BMFF), size==1 (64-bit largesize follows), size==5 (<8).
  for (const pathological of [0, 1, 5]) {
    const buf = Buffer.concat([colrBox('prof', real, pathological), junk(8)]);
    assert.deepEqual(extractIcc(buf), real, `box size ${pathological}`);
  }
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
