// Shared HEIC decoding for the operator tooling. Two consumers:
//   - scripts/process-product-images.mjs ingests iPhone .heic product photos directly, honouring
//     the file's own embedded ICC profile (extractIcc below) so the colour pipeline gamut-maps
//     from the true source space instead of assuming sRGB.
//   - scripts/applique-grid/lib/heic.mjs wraps the decode helpers for the applique ingest and does
//     its own colour management on top of them (decodeToSrgb there), because that pipeline bakes
//     sRGB pixels into working cells rather than handing tagged images on. Its header is the
//     reference for how a raw buffer gets tagged with a profile at all.
//
// Why not sharp directly: the iPhone originals are tiled HEICs that sharp 0.35.3's libvips cannot
// decode ("bad seek"; verified against all 46 applique launch photos), so decoding goes through
// heic-decode (WASM libheif) into raw RGBA, which sharp then consumes cleanly. heic-decode
// returns bare RGBA with the embedded profile dropped, which is why extractIcc exists.

import { createRequire } from 'node:module';

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
