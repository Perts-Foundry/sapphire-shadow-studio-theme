// The pure ingest planner, plus this pipeline's colour handling on top of the shared HEIC decode
// helpers (which live in scripts/lib/heic.mjs so process-product-images.mjs can ingest HEICs too).
//
// COLOUR. heic-decode returns bare RGBA with the container's embedded profile dropped, so the
// decoded numbers are Display P3 values that every downstream tool reads as sRGB. That renders the
// fabric duller than it is: the orange dot print comes out brown, and the operator described that
// fabric as "more orange in person". decodeToSrgb below re-attaches the file's OWN profile and
// converts to real sRGB, so cells and previews carry the photo's own colour baked into sRGB pixels.
//
// Why the file's own profile rather than a hardcoded Display P3 matrix. Both were measured against
// the 46 launch photos and they agree to within 1/255 per channel, because all 46 carry Apple's
// Display P3 profile, which is a matrix-shaper on the sRGB transfer curve; the matrix IS its
// conversion. So the choice is not about today's pixels, it is about what happens when a source
// is not P3: a re-shoot on other hardware, an edited export in Adobe RGB, a phone setting change.
// A hardcoded matrix would mis-convert those silently and invisibly, while reading the profile the
// file actually carries stays correct, handles profile types no 3x3 matrix can express, and is the
// truer reading of "preserve the original photo's colouring". A missing profile is NOT guessed
// (see decodeToSrgb): the pixels pass through as sRGB and the run reports it, because assuming P3
// on an actually-sRGB source over-saturates just as visibly as the bug being fixed here.
//
// Why a PNG carrier. sharp has no way to say "these raw bytes are already in this space".
// withIccProfile(path) on untagged raw input CONVERTS from an assumed sRGB into the profile given,
// which is the exact opposite (verified by inflating the output PNG's IDAT directly, with no sharp
// read-back in the way: an sRGB 255,0,0 comes out as 234,51,35, the P3 encoding of that colour).
// The only way to tag is to hand the profile to a container that carries it, so the decoded pixels
// go into a store-only PNG whose iCCP chunk this module writes itself, and sharp imports that
// profile when it reads the carrier back. The round-trip test in test/heic.test.mjs pins the whole
// mechanism: if a sharp bump changes these semantics the test goes red instead of the colour
// silently reverting to the old dull rendering.
//
// TWO VERSION KEYS, and neither one is optional. The ingest-manifest key carries both the decoder
// version and COLOR_TRANSFORM_VERSION, for the same reason: a heic-decode bump and a change to the
// transform below each alter the cell pixels without altering the source photos the manifest
// otherwise keys on, so without them every already-decoded cell silently keeps its old colour.
// Re-decoding is only half the job though. The chart spec hash covers the SOURCE photo's sha256,
// not the cell's, so neither key moves a spec hash and neither one republishes anything on its
// own: a colour change must ALSO bump chart.styleVersion in the registry, or the fresh cells sit
// on disk behind charts that publish.mjs believes are current.

import { deflateSync } from 'node:zlib';
import { decodeToRaw, extractIcc, sharpFromRaw } from '../../lib/heic.mjs';

export { DECODER_VERSION, decodeToRaw, sharpFromRaw } from '../../lib/heic.mjs';

/**
 * The revision of the colour transform below, part of every ingest-manifest key so a change here
 * re-decodes every photo instead of silently leaving already-decoded cells at the old colour.
 * Bump on ANY change to decodeToSrgb's output pixels, and bump chart.styleVersion with it.
 */
export const COLOR_TRANSFORM_VERSION = '1';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// CRC-32 (the PNG/zlib polynomial), hand-rolled rather than taken from node:zlib's crc32, which
// only exists from Node 22.2. package.json asks for >=22.12 but CI pins no Node version at all, so
// this module does not get to assume one. Pinned by test against the well-known IEND chunk CRC.
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

/**
 * CRC-32 of a buffer, as PNG chunks carry it.
 * @param {Buffer} buffer
 * @returns {number} unsigned 32-bit
 */
export function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Insert an iCCP chunk carrying `profile` into a PNG, immediately before its first IDAT. This is
 * the tagging step sharp cannot do (see the header): it declares what space the pixels are already
 * in, and changes no pixel.
 * @param {Buffer} png - a PNG that carries no profile of its own
 * @param {Buffer} profile - raw ICC profile bytes
 * @returns {Buffer} the same PNG with an iCCP chunk added
 */
export function embedIccProfile(png, profile) {
  if (!Buffer.isBuffer(png) || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('ICC carrier is not a PNG');
  }
  if (!Buffer.isBuffer(profile) || profile.length === 0) throw new Error('ICC profile is empty');

  // Walk the chunk list rather than searching for the bytes "IDAT", which also occur inside pixel
  // data often enough to matter on a store-only carrier.
  let offset = 8;
  let idatStart = -1;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'iCCP') throw new Error('ICC carrier already carries a profile');
    if (type === 'IDAT') { idatStart = offset; break; }
    const next = offset + 12 + length;
    if (next <= offset || next > png.length) break; // truncated or absurd chunk length
    offset = next;
  }
  if (idatStart === -1) throw new Error('ICC carrier has no IDAT chunk');

  // iCCP payload: profile name, NUL terminator, compression method 0 (zlib), deflated profile.
  const payload = Buffer.concat([
    Buffer.from('icc', 'latin1'),
    Buffer.from([0, 0]),
    deflateSync(profile),
  ]);
  const type = Buffer.from('iCCP', 'ascii');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, payload])));
  return Buffer.concat([
    png.subarray(0, idatStart), header, type, payload, checksum, png.subarray(idatStart),
  ]);
}

// A profile description is a string read out of a file and echoed to a console the operator may
// paste anywhere, and a calibrated-display profile can carry a machine or account name in it. This
// repo is public, so the label is clamped to a conservative charset and length rather than trusted
// verbatim; it is a note, never a control input, so mangling an exotic name costs nothing.
function sanitizeLabel(text) {
  const clean = text.replace(/[^\w .()/-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64);
  return clean || null;
}

/**
 * The human-readable name in an ICC profile's 'desc' tag, for the operator-facing colour note.
 * Reads the tag table properly (the shared module's cosmetic keyword scan cannot tell "Display P3"
 * from a profile that merely mentions it), and returns null on anything it does not recognise.
 * @param {Buffer} profile
 * @returns {string | null}
 */
export function profileDescription(profile) {
  if (!Buffer.isBuffer(profile) || profile.length < 132) return null;
  const tagCount = profile.readUInt32BE(128);
  if (tagCount > 1000) return null;
  for (let i = 0; i < tagCount; i++) {
    const entry = 132 + i * 12;
    if (entry + 12 > profile.length) return null;
    if (profile.toString('ascii', entry, entry + 4) !== 'desc') continue;
    const start = profile.readUInt32BE(entry + 4);
    const size = profile.readUInt32BE(entry + 8);
    if (start + size > profile.length || size < 12) return null;
    const tag = profile.subarray(start, start + size);
    const kind = tag.toString('ascii', 0, 4);
    if (kind === 'desc') {
      // ICC v2 textDescription: ASCII byte count (including the terminator) then ASCII.
      const length = tag.readUInt32BE(8);
      if (length < 2 || 12 + length > tag.length) return null;
      return sanitizeLabel(tag.toString('latin1', 12, 12 + length - 1));
    }
    if (kind === 'mluc') {
      // ICC v4 multiLocalizedUnicode: take the first record, which is UTF-16BE. Copy before
      // swapping byte order: swap16 works in place and would otherwise corrupt the caller's
      // profile, which is the same buffer that gets embedded in the carrier.
      if (tag.length < 28) return null;
      const length = tag.readUInt32BE(20);
      const offset = tag.readUInt32BE(24);
      if (length < 2 || length % 2 !== 0 || offset + length > tag.length) return null;
      const utf16 = Buffer.from(tag.subarray(offset, offset + length));
      return sanitizeLabel(utf16.swap16().toString('utf16le').replace(/\0+$/, ''));
    }
    return null;
  }
  return null;
}

/**
 * Decode a HEIC and land it in real sRGB, honouring the file's own embedded profile. The result is
 * alpha-free (the pipeline writes opaque JPEGs, and heic-decode's alpha is fully opaque anyway) and
 * has the decoded photo's exact dimensions, which is the invariant the registry's normalized crops
 * rest on: cells and previews are straight downscales of THIS buffer.
 *
 * A file with no ICC profile is passed through unconverted and reported rather than guessed at, so
 * a source that is genuinely sRGB is never over-saturated into looking like the bug this replaced.
 *
 * @param {Buffer} buffer
 * @param {object} [opts]
 * @param {Function} [opts.decode] - injectable decoder, forwarded to decodeToRaw for tests
 * @returns {Promise<{width: number, height: number, data: Buffer, channels: 3,
 *   converted: boolean, colorNote: string}>}
 */
export async function decodeToSrgb(buffer, opts = {}) {
  const icc = extractIcc(buffer);
  const raw = await decodeToRaw(buffer, opts);
  const opaque = (await sharpFromRaw(raw)).removeAlpha();

  let out;
  let converted;
  let colorNote;
  if (Buffer.isBuffer(icc)) {
    // compressionLevel 0 keeps the carrier a store-only wrapper: it exists for one call, in
    // memory, purely to hold the profile, and deflating ~100 MB of photo to throw it away
    // straight afterwards costs seconds per photo for nothing.
    const carrier = embedIccProfile(await opaque.png({ compressionLevel: 0 }).toBuffer(), icc);
    const { default: sharp } = await import('sharp');
    // sharp imports an embedded profile on its own when the pipeline lands in sRGB; toColourspace
    // states that target rather than leaving it to the source profile's colour space.
    out = await sharp(carrier).toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
    converted = true;
    colorNote = `${profileDescription(icc) ?? 'embedded ICC profile'} -> sRGB`;
  } else {
    out = await opaque.raw().toBuffer({ resolveWithObject: true });
    converted = false;
    colorNote = icc === 'nclx'
      ? 'nclx colour info present, ICC absent; pixels assumed sRGB and left unconverted'
      : 'no colour info in the HEIC; pixels assumed sRGB and left unconverted';
  }

  // Geometry is the registry's normalized crops' whole foundation, so it is asserted rather than
  // assumed on both paths.
  const { data, info } = out;
  if (info.width !== raw.width || info.height !== raw.height) {
    throw new Error(`colour handling changed dimensions ${raw.width}x${raw.height} -> ${info.width}x${info.height}`);
  }
  if (info.channels !== 3) {
    throw new Error(`colour handling returned ${info.channels} channels, expected 3`);
  }
  return { width: info.width, height: info.height, data, channels: info.channels, converted, colorNote };
}

/**
 * A sharp instance over a decodeToSrgb result. The shared sharpFromRaw hardcodes 4 channels for
 * heic-decode's RGBA; this one carries the channel count the conversion actually produced.
 * @param {{data: Buffer, width: number, height: number, channels: number}} decoded
 * @returns {Promise<import('sharp').Sharp>}
 */
export async function sharpFromDecoded({ data, width, height, channels }) {
  const { default: sharp } = await import('sharp');
  return sharp(data, { raw: { width, height, channels } });
}

/**
 * Decide what ingest must do, without touching the filesystem. A photo re-decodes when it is new,
 * its source content hash changed (a re-shoot under the same basename), the decoder version moved,
 * the colour transform moved, or force is set; otherwise it skips. A registry source missing from
 * the source dir is an error naming the pattern: rendering would silently use a stale cell
 * otherwise.
 * @param {object} input
 * @param {Array<{basename: string, sha256: string}>} input.sources - photos present in the source dir
 * @param {Record<string, {sha256: string, decoderVersion: string, colorTransformVersion: string}>}
 *   [input.previous] - prior ingest-manifest entries, keyed by basename
 * @param {string} input.decoderVersion - current DECODER_VERSION
 * @param {string} input.colorTransformVersion - current COLOR_TRANSFORM_VERSION
 * @param {Array<{id: string, sources: string[]}>} [input.patterns] - registry patterns
 * @param {boolean} [input.force]
 * @returns {{decode: string[], skip: string[], unassigned: string[]}}
 */
export function planIngest({ sources, previous = {}, decoderVersion, colorTransformVersion, patterns = [], force = false }) {
  // Both version keys are required, never defaulted: an undefined on both sides of the skip
  // comparison below compares equal, so a caller that forgot one would silently skip every photo
  // and keep serving cells decoded under the old rules. That is the exact failure this key exists
  // to prevent, so it is an error rather than a fallback.
  if (typeof decoderVersion !== 'string' || !decoderVersion) {
    throw new Error('planIngest needs a non-empty decoderVersion');
  }
  if (typeof colorTransformVersion !== 'string' || !colorTransformVersion) {
    throw new Error('planIngest needs a non-empty colorTransformVersion');
  }
  const present = new Set(sources.map((s) => s.basename));
  for (const p of patterns) {
    for (const b of p.sources) {
      if (!present.has(b)) {
        throw new Error(`pattern "${p.id}" needs source photo ${b}, which is not in the source directory`);
      }
    }
  }
  const decode = [];
  const skip = [];
  for (const s of sources) {
    const prev = previous[s.basename];
    const current = prev
      && prev.sha256 === s.sha256
      && prev.decoderVersion === decoderVersion
      && prev.colorTransformVersion === colorTransformVersion;
    if (!force && current) {
      skip.push(s.basename);
    } else {
      decode.push(s.basename);
    }
  }
  const assigned = new Set(patterns.flatMap((p) => p.sources));
  const unassigned = sources.map((s) => s.basename).filter((b) => !assigned.has(b));
  return { decode, skip, unassigned };
}
