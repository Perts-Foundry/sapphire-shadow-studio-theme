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

// The execution order publish.mjs walks. Part of the contract (creates strictly before deletes,
// barrier between them), pinned by media-plan.test.mjs.
export const PHASE_ORDER = ['creates', 'barrier', 'deletes', 'reorder'];

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
 * @returns {{
 *   creates: Array<{page: number, pages: number, filename: string, alt: string, specHash: string}>,
 *   keeps: Array<{id: string, page: number, filename: string, alt: string, specHash: string}>,
 *   deletes: Array<{id: string, filename: string, alt: string, reason: string}>,
 *   suspects: Array<{id: string, filename: string, alt: string, reasons: string[]}>,
 *   stalePublished: Array<object>,
 *   finalOrder: Array<{kind: 'live', id: string} | {kind: 'create', filename: string}>,
 *   reorderRequired: boolean,
 *   converged: boolean,
 * }}
 */
export function buildMediaPlan({ desired, live, published, variantAttachedIds, handle }) {
  const recordedByGid = new Map(published.map((e) => [e.mediaGid, e]));
  const liveIds = new Set(live.map((m) => m.id));
  const stalePublished = published.filter((e) => !liveIds.has(e.mediaGid));

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

  // Final gallery order: every untouched media in its current relative order, then the charts as
  // a contiguous tail in page order. Suspects are untouched media and keep their positions.
  const deletedIds = new Set(deletes.map((d) => d.id));
  const finalOrder = [
    ...live.filter((m) => !keptIds.has(m.id) && !deletedIds.has(m.id)).map((m) => ({ kind: 'live', id: m.id })),
    ...[...keeps.map((k) => ({ page: k.page, entry: { kind: 'live', id: k.id } })),
      ...creates.map((c) => ({ page: c.page, entry: { kind: 'create', filename: c.filename } }))]
      .sort((a, b) => a.page - b.page)
      .map((x) => x.entry),
  ];

  // Would the gallery already sit in final order once deletes are gone and creates are appended
  // (Shopify appends new media at the end, and creates execute in page order)?
  const simulated = [
    ...live.filter((m) => !deletedIds.has(m.id)).map((m) => ({ kind: 'live', id: m.id })),
    ...creates.map((c) => ({ kind: 'create', filename: c.filename })),
  ];
  const key = (e) => (e.kind === 'live' ? `live:${e.id}` : `create:${e.filename}`);
  const reorderRequired = simulated.length !== finalOrder.length
    || simulated.some((e, i) => key(e) !== key(finalOrder[i]));

  return {
    creates,
    keeps,
    deletes,
    suspects,
    stalePublished,
    finalOrder,
    reorderRequired,
    converged: creates.length === 0 && deletes.length === 0 && !reorderRequired,
  };
}
