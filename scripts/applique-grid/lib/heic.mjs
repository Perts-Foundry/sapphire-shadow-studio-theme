// The pure ingest planner, plus this pipeline's colour POLICY on top of the shared HEIC helpers in
// scripts/lib/heic.mjs. The mechanism itself (decodeToSrgb, the iCCP chunk writer that tags raw
// pixels with a profile, the profile-description reader) lives there, because the product-images
// pipeline needs exactly the same conversion; that module's header is the reference for how and
// why it works. Ingest calls decodeToSrgb and bakes the resulting sRGB pixels into working cells;
// what differs between the two pipelines is downstream of this file.
//
// TWO VERSION KEYS, and neither one is optional. The ingest-manifest key carries both the decoder
// version and COLOR_TRANSFORM_VERSION, for the same reason: a heic-decode bump and a change to the
// shared transform each alter the cell pixels without altering the source photos the manifest
// otherwise keys on, so without them every already-decoded cell silently keeps its old colour.
// Re-decoding is only half the job though. The chart spec hash covers the SOURCE photo's sha256,
// not the cell's, so neither key moves a spec hash and neither one republishes anything on its
// own: a colour change must ALSO bump chart.styleVersion in the registry, or the fresh cells sit
// on disk behind charts that publish.mjs believes are current.

export {
  DECODER_VERSION, crc32, decodeToRaw, decodeToSrgb, embedIccProfile, extractIcc,
  profileDescription, sharpFromDecoded, sharpFromRaw,
} from '../../lib/heic.mjs';

/**
 * The revision of the shared colour transform as this pipeline's cells depend on it, part of every
 * ingest-manifest key so a change there re-decodes every photo instead of silently leaving
 * already-decoded cells at the old colour. Bump on ANY change to decodeToSrgb's output pixels
 * (it is shared now, so a change made for the other pipeline still counts), and bump
 * chart.styleVersion with it.
 */
export const COLOR_TRANSFORM_VERSION = '1';

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
