// The pure ingest planner, plus re-exports of the shared HEIC decode helpers (which moved to
// scripts/lib/heic.mjs so process-product-images.mjs can ingest HEICs too). This pipeline
// deliberately DROPS the embedded profile: heic-decode returns bare RGBA with the Display P3
// profile gone; the sample gate is the acceptance check for colour fidelity, and a P3 -> sRGB
// matrix here is the documented fallback if fabric colours look off (any such change must bump
// chart.styleVersion). The product-images pipeline makes the opposite choice and re-attaches the
// profile via extractIcc; see the shared module's header.
//
// The decoder version is part of every ingest-manifest key: a heic-decode bump re-decodes every
// photo (its output pixels are not guaranteed stable across versions), which changes hero hashes,
// which changes spec hashes, which republishes charts. Deliberate and documented in the README.

export { DECODER_VERSION, decodeToRaw, sharpFromRaw } from '../../lib/heic.mjs';

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
