// Housekeeping over the two directories this module accumulates files in: rendered charts, and
// live-media snapshots. Pure decisions only; the callers own fs.
//
// Both are report-first by design. Every chart filename embeds a spec hash, so an old render is
// harmless clutter, while a wrong deletion costs a re-render or, for a snapshot, the only record
// of what the gallery looked like before a live write.

/**
 * Which rendered chart files are stale, and whether pruning them is safe at all.
 *
 * The trap this exists to avoid: `render.mjs --page N` deliberately does NOT rewrite the manifest,
 * so a prune keyed on the manifest immediately after a partial render would delete every other
 * page's chart. The mtime rule catches exactly that, by refusing whenever any chart file is newer
 * than the manifest that is supposed to describe it.
 *
 * @param {object} input
 * @param {Array<{name: string, mtimeMs: number}>} input.files - chart files on disk
 * @param {string[]} input.manifestFilenames - charts the current manifest names
 * @param {string[]} input.publishedFilenames - charts the registry records as live
 * @param {number | null} input.manifestMtimeMs - null when there is no manifest
 * @returns {{stale: string[], keep: string[], prunable: boolean, reason: string | null}}
 */
export function classifyChartFiles({ files, manifestFilenames, publishedFilenames, manifestMtimeMs }) {
  const referenced = new Set([...manifestFilenames, ...publishedFilenames]);
  const stale = files.filter((f) => !referenced.has(f.name)).map((f) => f.name).sort();
  const keep = files.filter((f) => referenced.has(f.name)).map((f) => f.name).sort();

  if (manifestMtimeMs === null) {
    return { stale, keep, prunable: false, reason: 'no charts manifest on disk; nothing establishes which charts are current' };
  }
  const newer = files.filter((f) => f.mtimeMs > manifestMtimeMs).map((f) => f.name).sort();
  if (newer.length) {
    return {
      stale,
      keep,
      prunable: false,
      reason: `chart file(s) are newer than the manifest (${newer.join(', ')}); a partial "--page N" render skips the manifest write, so pruning now would delete the other pages`,
    };
  }
  return { stale, keep, prunable: true, reason: null };
}

// Snapshot filenames are `live-media-<iso with : and . replaced by ->-<label>.json`.
const SNAPSHOT_RE = /^live-media-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(.+)\.json$/;

/**
 * The instant a snapshot filename encodes, or null when it is not one of ours.
 * @param {string} name
 * @returns {number | null} epoch ms
 */
export function snapshotTime(name) {
  const m = SNAPSHOT_RE.exec(name);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Which snapshots may be deleted. Not a bare cap: these are the ONLY rollback record for a live
 * media write, so three rules compose and every one of them can only ever keep MORE.
 *
 *   - keep the newest `keep` snapshots, whatever their age;
 *   - never prune the newest, even if `keep` is 0;
 *   - never prune anything newer than the last converged audit, because everything after that
 *     point is the un-verified window a rollback would have to walk back through.
 *
 * With no converged audit on record, NOTHING is pruned: every snapshot is then inside the
 * un-verified window. Unrecognised filenames are never pruned either; this function does not own
 * files it cannot date.
 * @param {object} input
 * @param {string[]} input.names
 * @param {number} [input.keep]
 * @param {number | null} [input.lastConvergedAtMs] - null when no audit has ever gone green
 * @returns {{prune: string[], keep: string[], undated: string[]}}
 */
export function selectSnapshotsToPrune({ names, keep = 10, lastConvergedAtMs = null }) {
  const dated = names
    .map((name) => ({ name, at: snapshotTime(name) }))
    .filter((s) => s.at !== null)
    .sort((a, b) => b.at - a.at);

  const prune = dated
    .slice(Math.max(1, keep))
    .filter((s) => lastConvergedAtMs !== null && s.at < lastConvergedAtMs)
    .map((s) => s.name);
  const pruneSet = new Set(prune);
  return {
    prune: prune.sort(),
    keep: [...names].filter((n) => !pruneSet.has(n)).sort(),
    undated: names.filter((n) => snapshotTime(n) === null).sort(),
  };
}
