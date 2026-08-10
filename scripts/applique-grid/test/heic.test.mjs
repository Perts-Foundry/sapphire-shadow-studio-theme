import test from 'node:test';
import assert from 'node:assert/strict';
import { DECODER_VERSION, decodeToRaw, sharpFromRaw, planIngest } from '../lib/heic.mjs';

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
const PREV = {
  'IMG_0001.heic': { sha256: 'aa', decoderVersion: DECODER_VERSION },
  'IMG_0002.heic': { sha256: 'STALE', decoderVersion: DECODER_VERSION },
};
const PATTERNS = [{ id: 'sunset-bloom', sources: ['IMG_0001.heic'] }];

test('unchanged photo skips; changed content under the same basename re-decodes; new decodes', () => {
  const plan = planIngest({ sources: SOURCES, previous: PREV, decoderVersion: DECODER_VERSION, patterns: PATTERNS });
  assert.deepEqual(plan.skip, ['IMG_0001.heic']);
  assert.deepEqual(plan.decode, ['IMG_0002.heic', 'IMG_0003.heic']);
});

test('a decoder version bump forces re-decode of everything', () => {
  const plan = planIngest({ sources: SOURCES, previous: PREV, decoderVersion: '999.0.0', patterns: PATTERNS });
  assert.deepEqual(plan.skip, []);
  assert.equal(plan.decode.length, 3);
});

test('force re-decodes even unchanged photos', () => {
  const plan = planIngest({ sources: SOURCES, previous: PREV, decoderVersion: DECODER_VERSION, patterns: PATTERNS, force: true });
  assert.deepEqual(plan.skip, []);
  assert.equal(plan.decode.length, 3);
});

test('a registry source missing from the source dir is an error naming the pattern', () => {
  assert.throws(
    () => planIngest({
      sources: SOURCES,
      previous: {},
      decoderVersion: DECODER_VERSION,
      patterns: [{ id: 'night-garden', sources: ['IMG_0009.heic'] }],
    }),
    /pattern "night-garden" needs source photo IMG_0009\.heic/,
  );
});

test('unassigned photos are listed', () => {
  const plan = planIngest({ sources: SOURCES, previous: {}, decoderVersion: DECODER_VERSION, patterns: PATTERNS });
  assert.deepEqual(plan.unassigned, ['IMG_0002.heic', 'IMG_0003.heic']);
});

test('the planner never mutates its inputs (the source side is read-only)', () => {
  const sources = SOURCES.map((s) => Object.freeze({ ...s }));
  Object.freeze(sources);
  const previous = Object.freeze({ 'IMG_0001.heic': Object.freeze({ sha256: 'aa', decoderVersion: DECODER_VERSION }) });
  const patterns = Object.freeze([Object.freeze({ id: 'p', sources: Object.freeze(['IMG_0001.heic']) })]);
  assert.doesNotThrow(() => planIngest({ sources, previous, decoderVersion: DECODER_VERSION, patterns }));
});
