// Diff desired charts against live product media into an ordered phase plan. Pure: publish.mjs
// fetches live state, this builds the plan, lib/media.mjs executes it. Phase order is part of the
// contract: creates run first, then a readiness barrier, then deletes, then the reorder. Creates
// before deletes means a failed run leaves the gallery with extra charts (ugly, recoverable)
// rather than missing ones (a product page with no pattern chart at all).
//
// Identification is two-tier. A recorded `published` GID is the primary signal: that media IS a
// chart, whatever its filename or alt says now. The convention (chart filename AND chart alt) is
// the fallback for unrecorded media, e.g. a fresh clone publishing over an earlier machine's run.
// A media matching only ONE convention signal is a suspect: reported with reasons, never touched.
// A media attached to any variant is refused for deletion regardless of signals; charts are never
// variant heroes, so a variant-attached "chart" means something is wrong enough to stop and look.

import { isChartAlt, isChartFilename } from './naming.mjs';
import { MEDIA_GID_RE } from './registry.mjs';

// The execution order publish.mjs walks. Part of the contract (creates strictly before deletes,
// barrier between them), pinned by media-plan.test.mjs.
export const PHASE_ORDER = ['creates', 'barrier', 'deletes', 'reorder'];

/**
 * Is a live gallery order already what we want? Pure, and split out from buildMediaPlan because
 * publish.mjs must re-evaluate it AFTER the creates land: the old code simulated post-create
 * positions on the assumption that Shopify appends new media at the end, and a real run disproved
 * that (the dry run said `reorder not required`, both creates landed mid-gallery, and the next
 * audit reported STALE).
 * @param {string[]} liveOrder - media ids in current gallery order
 * @param {string[]} desiredOrder - media ids in the order we want
 * @returns {{required: boolean, moves: Array<{id: string, from: number, to: number}>}}
 */
export function evaluateReorder(liveOrder, desiredOrder) {
  const moves = [];
  const positions = new Map(liveOrder.map((id, i) => [id, i]));
  desiredOrder.forEach((id, to) => {
    const from = positions.get(id);
    if (from === undefined || from !== to) moves.push({ id, from: from ?? -1, to });
  });
  const required = moves.length > 0 || liveOrder.length !== desiredOrder.length;
  return { required, moves };
}

/**
 * Why the live gallery tail does not match the recorded charts plus the pinned media, or null when
 * it does. The audit's only on-disk statement about gallery order, so it is unit-tested directly
 * rather than only through a networked run.
 * @param {object} input
 * @param {string[]} input.liveIds - media ids in current gallery order
 * @param {string[]} input.publishedGids - recorded chart GIDs, in page order
 * @param {string[]} input.pinnedGids - gallery.pin_after_charts, in declared order
 * @returns {string | null}
 */
export function galleryTailProblem({ liveIds, publishedGids, pinnedGids }) {
  if (!publishedGids.length) return null; // nothing published yet: order is not this module's claim
  const missing = pinnedGids.filter((g) => !liveIds.includes(g));
  if (missing.length) {
    return `pinned media ${missing.join(', ')} is not in the live gallery; was it deleted in Admin? Update gallery.pin_after_charts`;
  }
  const wanted = [...publishedGids, ...pinnedGids];
  const tail = liveIds.slice(-wanted.length);
  if (tail.join('\n') === wanted.join('\n')) return null;
  return pinnedGids.length
    ? 'charts are not followed by the pinned media at the gallery tail; re-run publish.mjs (reorder)'
    : 'charts are not the contiguous tail in page order; re-run publish.mjs (reorder)';
}

// Shape + self-consistency of the pin list, before it is used to order anything. Existence against
// live media is checked separately, where the live list is in hand.
function assertPinnable(pinned) {
  pinned.forEach((g, i) => {
    if (!MEDIA_GID_RE.test(g ?? '')) {
      throw new Error(`gallery.pin_after_charts[${i}]: ${JSON.stringify(g)} is not a MediaImage GID`);
    }
  });
  const dups = pinned.filter((g, i) => pinned.indexOf(g) !== i);
  if (dups.length) throw new Error(`gallery.pin_after_charts has duplicate GID(s): ${[...new Set(dups)].join(', ')}`);
}

// Does a live basename match a desired chart filename, tolerating the CDN collision suffix
// (desired `x.jpg` may come back as `x_<token>.jpg`)?
function filenameMatchesDesired(liveBasename, desiredFilename) {
  const stem = desiredFilename.replace(/\.jpg$/i, '');
  return liveBasename === desiredFilename
    || new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_[A-Za-z0-9-]+\\.jpe?g$`, 'i').test(liveBasename);
}

/**
 * @param {object} input
 * @param {Array<{page: number, pages: number, filename: string, alt: string, specHash: string}>}
 *   input.desired - the rendered charts (from charts/manifest.json), in page order
 * @param {Array<{id: string, alt: string, filename: string}>} input.live - product media in
 *   current gallery order (filename '' when the media has no image URL)
 * @param {Array<{page: number, filename: string, mediaGid: string, alt: string, specHash: string}>}
 *   input.published - the registry's published block
 * @param {Set<string>} input.variantAttachedIds - media ids attached to any variant
 * @param {string} input.handle - product handle (filename convention input)
 * @param {string[]} [input.pinned] - gallery.pin_after_charts, in declared order
 * @returns {{
 *   creates: Array<{page: number, pages: number, filename: string, alt: string, specHash: string}>,
 *   keeps: Array<{id: string, page: number, filename: string, alt: string, specHash: string}>,
 *   deletes: Array<{id: string, filename: string, alt: string, reason: string}>,
 *   suspects: Array<{id: string, filename: string, alt: string, reasons: string[]}>,
 *   stalePublished: Array<object>,
 *   pinned: string[],
 *   finalOrder: Array<{kind: 'live', id: string} | {kind: 'create', filename: string}>,
 *   reorderVerdict: 'required' | 'not-required' | 'undetermined',
 *   converged: boolean,
 * }}
 */
export function buildMediaPlan({ desired, live, published, variantAttachedIds, handle, pinned = [] }) {
  const recordedByGid = new Map(published.map((e) => [e.mediaGid, e]));
  const liveIds = new Set(live.map((m) => m.id));
  const stalePublished = published.filter((e) => !liveIds.has(e.mediaGid));
  assertPinnable(pinned);
  for (const g of pinned) {
    // Hard fail, before any phase runs. Silently dropping a pinned GID would revert the exact
    // Admin fix this feature exists to protect, on the very next publish.
    if (!liveIds.has(g)) {
      throw new Error(`gallery.pin_after_charts names ${g}, which is not in the live gallery; was it deleted in Admin? Fix the registry before publishing`);
    }
  }

  // Classify every live media once.
  const chartLive = new Map(); // id -> live media identified as a chart
  const suspects = [];
  for (const m of live) {
    const recorded = recordedByGid.get(m.id);
    const fileSig = isChartFilename(m.filename, handle);
    const altSig = isChartAlt(m.alt);
    if (recorded || (fileSig && altSig)) {
      chartLive.set(m.id, m);
    } else if (fileSig || altSig) {
      suspects.push({
        id: m.id,
        filename: m.filename,
        alt: m.alt,
        reasons: [
          fileSig
            ? 'filename matches the chart convention but the alt does not'
            : 'alt matches the chart convention but the filename does not',
          'not in the registry\'s published record; left untouched',
        ],
      });
    }
  }

  // Match each desired chart to a live chart: recorded specHash first, then exact convention
  // (filename modulo CDN suffix AND byte-equal alt, so an alt-only change still republishes).
  const keeps = [];
  const creates = [];
  const keptIds = new Set();
  for (const d of desired) {
    let match = null;
    for (const [id, m] of chartLive) {
      if (keptIds.has(id)) continue;
      const recorded = recordedByGid.get(id);
      if (recorded && recorded.specHash === d.specHash) { match = m; break; }
      if (!recorded && filenameMatchesDesired(m.filename, d.filename) && m.alt === d.alt) { match = m; break; }
    }
    if (match) {
      keptIds.add(match.id);
      keeps.push({ id: match.id, page: d.page, filename: d.filename, alt: d.alt, specHash: d.specHash });
    } else {
      creates.push(d);
    }
  }

  // Everything chart-identified and not kept is stale: delete, unless variant-attached.
  const deletes = [];
  for (const [id, m] of chartLive) {
    if (keptIds.has(id)) continue;
    if (variantAttachedIds.has(id)) {
      suspects.push({
        id,
        filename: m.filename,
        alt: m.alt,
        reasons: ['stale chart, but attached to a variant; deletion refused (charts must never be variant heroes; detach in Admin first)'],
      });
      continue;
    }
    const recorded = recordedByGid.get(id);
    deletes.push({
      id,
      filename: m.filename,
      alt: m.alt,
      reason: recorded
        ? `recorded chart (page ${recorded.page}) no longer matches any desired chart`
        : 'convention-matched chart not in the desired set',
    });
  }

  const deletedIds = new Set(deletes.map((d) => d.id));
  const pinnedSet = new Set(pinned);
  for (const g of pinned) {
    if (chartLive.has(g)) {
      throw new Error(`gallery.pin_after_charts names ${g}, which this run identifies as a chart; a chart cannot be pinned after the charts`);
    }
    if (deletedIds.has(g)) throw new Error(`gallery.pin_after_charts names ${g}, which this run would delete`);
  }

  // Final gallery order: untouched media in its current relative order (minus the pinned), then
  // the charts in page order, then the pinned media in declared order. Suspects are untouched
  // media and keep their positions. With no pins this is byte-identical to the charts-as-tail rule
  // the module shipped with, which media-plan.test.mjs locks.
  const chartsSegment = [
    ...keeps.map((k) => ({ page: k.page, entry: { kind: 'live', id: k.id } })),
    ...creates.map((c) => ({ page: c.page, entry: { kind: 'create', filename: c.filename } })),
  ].sort((a, b) => a.page - b.page).map((x) => x.entry);

  // "After the charts" is vacuous with no charts, so a pin list must not manufacture a reorder on
  // a product that has never carried one.
  const finalOrder = chartsSegment.length
    ? [
      ...live.filter((m) => !keptIds.has(m.id) && !deletedIds.has(m.id) && !pinnedSet.has(m.id))
        .map((m) => ({ kind: 'live', id: m.id })),
      ...chartsSegment,
      ...pinned.map((id) => ({ kind: 'live', id })),
    ]
    : live.filter((m) => !deletedIds.has(m.id)).map((m) => ({ kind: 'live', id: m.id }));

  // With creates pending, the post-create gallery order is NOT predictable: the "Shopify appends
  // new media at the end" assumption was disproved on a real run. So the dry run stops asserting a
  // verdict and presents the target order plus how many items may move; publish.mjs re-evaluates
  // against actual state after the readiness barrier.
  let reorderVerdict = 'undetermined';
  if (!creates.length) {
    const after = live.filter((m) => !deletedIds.has(m.id)).map((m) => m.id);
    reorderVerdict = evaluateReorder(after, finalOrder.map((e) => e.id)).required ? 'required' : 'not-required';
  }

  return {
    creates,
    keeps,
    deletes,
    suspects,
    stalePublished,
    pinned: pinned.slice(),
    finalOrder,
    reorderVerdict,
    converged: creates.length === 0 && deletes.length === 0 && reorderVerdict === 'not-required',
  };
}
