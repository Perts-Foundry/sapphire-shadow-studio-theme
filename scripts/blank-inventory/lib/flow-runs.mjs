// Reading the Flow run list, offline.
//
// SCOPE, STATED FIRST, BECAUSE THE SCOPE IS THE SAFETY PROPERTY. This module turns console lines
// that `browser/flow-runs-probe.js` logged into three counts. It is an OPERATOR DIAGNOSTIC and
// nothing else:
//
//   - No command imports it. `blank-inventory.mjs` stays headless and CI-runnable, and a green run
//     list is never permission to apply. The batch gate reads the STORE, never the Flow.
//   - It never reaches the network, a browser, or the Admin API. It parses a string.
//   - Its output is never committed. Counts, run ids and timestamps from a real store are live
//     operational data; only the synthetic inputs in its own test may go in a file.
//
// It exists so that something in this pipeline is testable. The probe is browser-only and stays out
// of the suite; the parsing rules, which are where a miscount would come from, live here.
//
// WHAT IT DELIBERATELY DOES NOT KNOW. Flow's run-list statuses are Admin internals, unversioned and
// undocumented. Rather than guess a mapping, this classifies only the statuses it has a stated
// reason to recognise and reports everything else as `unclassified`, by name. A parser that folded
// an unknown status into "finished" would under-report exactly the pile-up it exists to see.

/** The line prefix the probe uses. One run per line. */
export const RUN_LINE = 'SSSFLOWRUN';
/** Logged once per matching response, carrying how many run nodes it held. */
export const PAGE_LINE = 'SSSFLOWPAGE';
/** Logged when no response matched, carrying the operation names that were seen instead. */
export const NONE_LINE = 'SSSFLOWNONE';

/**
 * Status tokens treated as "still running".
 *
 * OBSERVED-OR-OBVIOUS ONLY, lowercased and stripped of separators by `normaliseStatus`. Widen this
 * only against a real run list, and record what was seen when you do: every token added here is a
 * claim about Admin's vocabulary, and a wrong one silently moves runs out of the in-progress count,
 * which is the count the whole probe exists to produce.
 */
export const IN_PROGRESS_STATUSES = new Set(['inprogress', 'running', 'pending', 'queued', 'started']);

/** Status tokens treated as terminal. Same rule as above. */
export const TERMINAL_STATUSES = new Set(['success', 'succeeded', 'complete', 'completed', 'failed', 'failure', 'error', 'cancelled', 'canceled', 'skipped']);

/**
 * Fold a status into the one spelling this module compares against.
 * @param {string} raw
 * @returns {string}
 */
export function normaliseStatus(raw) {
  return String(raw ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Turn a console blob into the three signals the diagnostic reports.
 *
 * Deduplicates on run id, last line wins: the run-list page refetches as it paginates and polls, so
 * one run legitimately appears in several responses, and counting each appearance would inflate
 * exactly the number being watched. The LAST reading wins because a run's status moves forwards.
 *
 * @param {string} text - console output, one probe line per line; anything else is ignored
 * @returns {{runs: number, byStatus: Record<string, number>, inProgress: number, inProgressWithRetries: number, oldestInProgressAt: string|null, unclassified: string[], pages: number, malformed: string[], sawNone: boolean}}
 */
export function parseFlowRuns(text) {
  /** @type {Map<string, {status: string, retrying: boolean, startedAt: string}>} */
  const runs = new Map();
  const malformed = [];
  let pages = 0;
  let sawNone = false;

  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith(NONE_LINE)) {
      sawNone = true;
      continue;
    }
    if (trimmed.startsWith(PAGE_LINE)) {
      pages++;
      continue;
    }
    if (!trimmed.startsWith(RUN_LINE)) continue;

    // `<prefix> <runId> <status> <true|false> <iso8601>`. Split on runs of whitespace and require
    // exactly five fields: a short line would otherwise shift every field left and turn a status
    // into a run id with nothing failing.
    const parts = trimmed.split(/\s+/);
    if (parts.length !== 5) {
      malformed.push(trimmed);
      continue;
    }
    const [, runId, status, retrying, startedAt] = parts;
    if (retrying !== 'true' && retrying !== 'false') {
      malformed.push(trimmed);
      continue;
    }
    if (!Number.isFinite(Date.parse(startedAt))) {
      malformed.push(trimmed);
      continue;
    }
    runs.set(runId, { status: normaliseStatus(status), retrying: retrying === 'true', startedAt });
  }

  /** @type {Record<string, number>} */
  const byStatus = {};
  const unclassified = new Set();
  let inProgress = 0;
  let inProgressWithRetries = 0;
  let oldestInProgressAt = null;

  for (const run of runs.values()) {
    byStatus[run.status] = (byStatus[run.status] ?? 0) + 1;
    if (!IN_PROGRESS_STATUSES.has(run.status) && !TERMINAL_STATUSES.has(run.status)) unclassified.add(run.status);
    if (!IN_PROGRESS_STATUSES.has(run.status)) continue;
    inProgress++;
    if (run.retrying) inProgressWithRetries++;
    if (oldestInProgressAt === null || Date.parse(run.startedAt) < Date.parse(oldestInProgressAt)) {
      oldestInProgressAt = run.startedAt;
    }
  }

  return {
    runs: runs.size,
    byStatus,
    inProgress,
    inProgressWithRetries,
    oldestInProgressAt,
    unclassified: [...unclassified].sort(),
    pages,
    malformed,
    sawNone,
  };
}

/**
 * The three-line reading, for the operator.
 *
 * Prose, not a verdict: nothing downstream consumes this, and it deliberately offers no
 * "safe to apply" conclusion. An unclassified status or a malformed line is named rather than
 * rounded away, because a reading built on statuses this module does not understand is worth less
 * than no reading at all and the operator has to be able to tell which they are holding.
 *
 * @param {ReturnType<typeof parseFlowRuns>} reading
 * @param {object} [opts]
 * @param {number} [opts.now] - epoch ms, injected so the age line is testable
 * @returns {string[]}
 */
export function describeFlowRuns(reading, { now = Date.now() } = {}) {
  const lines = [];
  if (reading.sawNone && !reading.runs) {
    return ['No Flow run-list response was seen. The probe matched nothing; report the page URL and stop.'];
  }
  const statuses = Object.entries(reading.byStatus)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([status, count]) => `${status} ${count}`)
    .join(', ');
  lines.push(`${reading.runs} run(s) over ${reading.pages} response(s): ${statuses || 'none'}`);
  lines.push(`${reading.inProgress} in progress, of which ${reading.inProgressWithRetries} retrying`);
  if (reading.oldestInProgressAt) {
    const ageS = Math.round((now - Date.parse(reading.oldestInProgressAt)) / 1000);
    lines.push(`oldest in-progress run started ${reading.oldestInProgressAt} (${ageS}s ago)`);
  } else {
    lines.push('no in-progress run');
  }
  if (reading.unclassified.length) {
    lines.push(`UNCLASSIFIED status(es): ${reading.unclassified.join(', ')}. Those runs are counted in the total but NOT in the in-progress figure.`);
  }
  if (reading.malformed.length) {
    lines.push(`${reading.malformed.length} unparseable probe line(s); the reading is incomplete.`);
  }
  return lines;
}
