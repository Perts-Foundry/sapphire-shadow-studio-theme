// Shared HEIC decoding and colour management for the operator tooling. Three consumers:
//   - scripts/process-product-images.mjs ingests iPhone .heic product photos and hands the
//     converted sRGB pixels to its JPEG encode.
//   - scripts/applique-grid/lib/heic.mjs adds that pipeline's own policy (a colour-transform
//     version key, the ingest planner) on top of these helpers and re-exports them.
//   - scripts/contact-sheet.mjs decodes originals for local proofing sheets.
//
// Why not sharp directly: the iPhone originals are tiled HEICs that sharp 0.35.3's libvips cannot
// decode ("bad seek"; verified against all 46 applique launch photos), so decoding goes through
// heic-decode (WASM libheif) into raw RGBA, which sharp then consumes cleanly. heic-decode
// returns bare RGBA with the embedded profile dropped, which is why extractIcc exists.
//
// COLOUR. Those bare RGBA numbers are Display P3 values that every downstream tool reads as sRGB,
// which renders the photo duller than it is: the applique orange dot print came out brown against
// an operator who described that fabric as "more orange in person". decodeToSrgb re-attaches the
// file's OWN profile and converts, so callers get pixels that really are sRGB.
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
// on an actually-sRGB source over-saturates just as visibly as the bug this replaced.
//
// Why a PNG carrier. sharp has no way to say "these raw bytes are already in this space".
// withIccProfile(path) on untagged raw input CONVERTS from an assumed sRGB into the profile given,
// which is the exact opposite (verified by inflating the output PNG's IDAT directly, with no sharp
// read-back in the way: an sRGB 255,0,0 comes out as 234,51,35, the P3 encoding of that colour).
// That is the trap this module exists to close: both pipelines once believed withIccProfile(path)
// tagged, so both round-tripped P3 -> P3 and shipped relabelled, desaturated pixels. The only way
// to tag is to hand the profile to a container that carries it, so the decoded pixels go into a
// store-only PNG whose iCCP chunk this module writes itself, and sharp imports that profile when
// it reads the carrier back. The round-trip test in heic.test.mjs pins the whole mechanism: if a
// sharp bump changes these semantics the test goes red instead of the colour silently reverting.

import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';

const require_ = createRequire(import.meta.url);

/** The pinned heic-decode version, read from the installed package (not hard-coded twice). */
export const DECODER_VERSION = require_('heic-decode/package.json').version;

let decodePromise = null;
async function loadDecoder() {
  if (!decodePromise) decodePromise = import('heic-decode').then((m) => m.default);
  return decodePromise;
}

/**
 * Decode a HEIC buffer to raw RGBA. Throws on undecodable input; callers report and exclude,
 * never guess at content.
 * @param {Buffer} buffer
 * @param {object} [opts]
 * @param {(input: {buffer: Buffer}) => Promise<{width: number, height: number, data: ArrayBufferLike}>}
 *   [opts.decode] - injectable for tests
 * @returns {Promise<{width: number, height: number, data: Buffer, channels: 4}>}
 */
export async function decodeToRaw(buffer, opts = {}) {
  const decode = opts.decode ?? (await loadDecoder());
  const { width, height, data } = await decode({ buffer });
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`decoder returned implausible dimensions ${width}x${height}`);
  }
  const raw = Buffer.from(data);
  if (raw.length !== width * height * 4) {
    throw new Error(`decoder returned ${raw.length} bytes for ${width}x${height} RGBA (expected ${width * height * 4})`);
  }
  return { width, height, data: raw, channels: 4 };
}

/**
 * A sharp instance over decoded raw RGBA. sharp is imported lazily so entry points that must set
 * FONTCONFIG_FILE first (applique-grid's compose.mjs) control initialisation order.
 * @param {{width: number, height: number, data: Buffer}} raw
 * @returns {Promise<import('sharp').Sharp>}
 */
export async function sharpFromRaw({ data, width, height }) {
  const { default: sharp } = await import('sharp');
  return sharp(data, { raw: { width, height, channels: 4 } });
}

/**
 * A sharp instance over a decodeToSrgb result. sharpFromRaw hardcodes 4 channels for heic-decode's
 * RGBA; this one carries the channel count the conversion actually produced.
 * @param {{data: Buffer, width: number, height: number, channels: number}} decoded
 * @returns {Promise<import('sharp').Sharp>}
 */
export async function sharpFromDecoded({ data, width, height, channels }) {
  const { default: sharp } = await import('sharp');
  return sharp(data, { raw: { width, height, channels } });
}

/**
 * Extract the embedded ICC profile from a HEIC buffer, or report what colour signalling it has.
 *
 * Strategy: a linear byte-scan over every 'colr' occurrence, NOT a structural BMFF box walk. Each
 * candidate is validated (colour type 'prof'/'rICC', profile size bounds-checked against the
 * buffer, 'acsp' signature at profile offset 36) and the first valid profile wins; invalid
 * candidates, including 'colr' byte runs inside mdat image data, are skipped. A decoy that passes
 * all three checks would be accepted: that is the known limitation of the byte-scan, accepted
 * because a structural walk needs a full box parser (largesize, containers, meta/iprp nesting) for
 * a file we only ever read one four-byte-keyed box from. Ignoring the enclosing box's size field
 * also makes the size==0 (to-EOF) / size==1 (64-bit largesize) / size<8 pathologies irrelevant
 * here: the scan always advances by at least one byte and cannot loop.
 *
 * The profile size is read from the ICC header itself (its first 4 bytes), matching how the box
 * payload is laid out ('colr' + 'prof' + raw ICC profile).
 *
 * @param {Buffer} buffer
 * @returns {Buffer | 'nclx' | null} the profile bytes; 'nclx' when the only colour signalling is
 *   an nclx (CICP) box, so the caller can warn "colour info present, ICC absent" instead of a
 *   generic assuming-sRGB message; null when no colour information was found at all.
 */
export function extractIcc(buffer) {
  const marker = Buffer.from('colr', 'ascii');
  let sawNclx = false;
  let from = 0;
  while (from < buffer.length) {
    const idx = buffer.indexOf(marker, from);
    if (idx === -1) break;
    from = idx + 1; // always advance, whatever the candidate turns out to be
    const typeStart = idx + 4;
    if (typeStart + 4 > buffer.length) continue;
    const type = buffer.toString('ascii', typeStart, typeStart + 4);
    if (type === 'nclx') { sawNclx = true; continue; }
    if (type !== 'prof' && type !== 'rICC') continue;
    const profStart = typeStart + 4;
    if (profStart + 4 > buffer.length) continue;
    const size = buffer.readUInt32BE(profStart);
    // A real ICC header is 128 bytes; 40 is the floor that makes the 'acsp' read in-bounds, and
    // it rejects zero-length and truncated profiles without out-of-bounds reads.
    if (size < 40 || profStart + size > buffer.length) continue;
    if (buffer.toString('ascii', profStart + 36, profStart + 40) !== 'acsp') continue;
    return buffer.subarray(profStart, profStart + size);
  }
  return sawNclx ? 'nclx' : null;
}

// ---------------------------------------------------------------------------
// Colour: tagging raw pixels with a profile, and converting them into real sRGB.
// ---------------------------------------------------------------------------

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

// A profile description is a string read out of a file and echoed to a console (and, for the
// product-images pipeline, into a manifest the operator may paste anywhere), and a
// calibrated-display profile can carry a machine or account name in it. This repo is public, so
// the label is clamped to a conservative charset and length rather than trusted verbatim; it is a
// note, never a control input, so mangling an exotic name costs nothing.
function sanitizeLabel(text) {
  const clean = text.replace(/[^\w .()/-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64);
  return clean || null;
}

/**
 * The human-readable name in an ICC profile's 'desc' tag, for the operator-facing colour note.
 * Reads the tag table properly (process-product-images.mjs's cosmetic profileName keyword scan
 * cannot tell "Display P3" from a profile that merely mentions it), and returns null on anything
 * it does not recognise.
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
 * alpha-free (both pipelines write opaque output, and heic-decode's alpha is fully opaque anyway)
 * and has the decoded photo's exact dimensions, which the applique registry's normalized crops
 * rest on: its cells and previews are straight downscales of THIS buffer.
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

  // Geometry is the applique registry's normalized crops' whole foundation, and the product-images
  // manifest reports it, so it is asserted rather than assumed on both paths.
  const { data, info } = out;
  if (info.width !== raw.width || info.height !== raw.height) {
    throw new Error(`colour handling changed dimensions ${raw.width}x${raw.height} -> ${info.width}x${info.height}`);
  }
  if (info.channels !== 3) {
    throw new Error(`colour handling returned ${info.channels} channels, expected 3`);
  }
  return { width: info.width, height: info.height, data, channels: info.channels, converted, colorNote };
}
