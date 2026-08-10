// HEIC decoding and the pure ingest planner. The iPhone originals are tiled HEICs that sharp
// 0.35.3's libvips cannot decode ("bad seek"; verified against all 46 launch photos), so decoding
// goes through heic-decode (WASM libheif) into raw RGBA, which sharp then consumes cleanly.
// heic-decode returns bare RGBA with the Display P3 profile dropped; the sample gate is the
// acceptance check for colour fidelity, and a P3 -> sRGB matrix here is the documented fallback
// if fabric colours look off (any such change must bump chart.styleVersion).
//
// The decoder version is part of every ingest-manifest key: a heic-decode bump re-decodes every
// photo (its output pixels are not guaranteed stable across versions), which changes hero hashes,
// which changes spec hashes, which republishes charts. Deliberate and documented in the README.

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
 * FONTCONFIG_FILE first (compose.mjs) control initialisation order.
 * @param {{width: number, height: number, data: Buffer}} raw
 * @returns {Promise<import('sharp').Sharp>}
 */
export async function sharpFromRaw({ data, width, height }) {
  const { default: sharp } = await import('sharp');
  return sharp(data, { raw: { width, height, channels: 4 } });
}

/**
 * Decide what ingest must do, without touching the filesystem. A photo re-decodes when it is new,
 * its source content hash changed (a re-shoot under the same basename), the decoder version moved,
 * or force is set; otherwise it skips. A registry source missing from the source dir is an error
 * naming the pattern: rendering would silently use a stale cell otherwise.
 * @param {object} input
 * @param {Array<{basename: string, sha256: string}>} input.sources - photos present in the source dir
 * @param {Record<string, {sha256: string, decoderVersion: string}>} input.previous - prior
 *   ingest-manifest entries, keyed by basename
 * @param {string} input.decoderVersion - current DECODER_VERSION
 * @param {Array<{id: string, sources: string[]}>} input.patterns - registry patterns
 * @param {boolean} [input.force]
 * @returns {{decode: string[], skip: string[], unassigned: string[]}}
 */
export function planIngest({ sources, previous = {}, decoderVersion, patterns = [], force = false }) {
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
    if (!force && prev && prev.sha256 === s.sha256 && prev.decoderVersion === decoderVersion) {
      skip.push(s.basename);
    } else {
      decode.push(s.basename);
    }
  }
  const assigned = new Set(patterns.flatMap((p) => p.sources));
  const unassigned = sources.map((s) => s.basename).filter((b) => !assigned.has(b));
  return { decode, skip, unassigned };
}
