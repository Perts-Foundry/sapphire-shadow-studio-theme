// report.mjs -- the finish line: accepted risks, per-report diffs, metric deltas, the run file and
// the exit code.
//
// WHY PER REPORT. On a days-old property most reports say "Processing data". A whole-run diff would
// read the day a report starts producing data as a wave of new findings and, worse, a report going
// back to not-ready as everything resolved. So each report is diffed only against the newest run of
// the same mode in which that report was `ok`, a not-ready report is listed as "not compared", and
// performance is compared only across runs over the same period. Every valid run is still saved,
// including an all-not-ready one, so the history shows when each report came alive.
//
// Printing never includes response bodies, cookie values or identities; findings carry counts,
// subjects and short details, and paths go through displayPath.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR, WARN, INFO, partitionAccepted, diffFindings, exitCodeFor } from '../../seo-review/lib/checks.mjs';
import { REPORTS, KNOWN_REASONS, SERVICES } from './schema.mjs';
import { CHECK_IDS, REPORT_OF, SUBJECT_KIND, daysSince } from './checks.mjs';
import { saveRun, loadLatestComparable } from './baseline.mjs';
import { displayPath } from '../../lib/display-path.mjs';

export const ACCEPTED_RISKS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'accepted-risks.json');

/**
 * Shape problems in an accepted-risks array. `path` is the finding subject exactly (a URL path for
 * page subjects), or null to accept every subject of the check. A perf-* risk names a page path:
 * performance is accepted by page, never by query.
 * @returns {string[]}
 */
export function acceptedRiskProblems(entries) {
  if (!Array.isArray(entries)) return ['accepted risks must be a JSON array'];
  const problems = [];
  entries.forEach((e, i) => {
    const where = `entry ${i}`;
    if (e === null || typeof e !== 'object' || Array.isArray(e)) {
      problems.push(`${where}: expected an object`);
      return;
    }
    const keys = Object.keys(e).sort().join(',');
    if (keys !== 'accepted_on,check,note,path') problems.push(`${where}: keys must be exactly check, path, note, accepted_on`);
    if (!CHECK_IDS.includes(e.check)) {
      problems.push(`${where}: unknown check id`);
      return;
    }
    if (typeof e.note !== 'string' || e.note.trim() === '') problems.push(`${where}: note must be a non-empty string`);
    if (typeof e.accepted_on !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.accepted_on)) problems.push(`${where}: accepted_on must be YYYY-MM-DD`);
    const p = e.path;
    if (p !== null && (typeof p !== 'string' || p === '')) {
      problems.push(`${where}: path must be null or a non-empty string`);
      return;
    }
    if (typeof p === 'string' && /[?#]/.test(p)) problems.push(`${where}: path must not carry a query string or fragment`);
    const kind = SUBJECT_KIND[e.check];
    if (e.check.startsWith('perf-') && (p === null || !p.startsWith('/'))) {
      problems.push(`${where}: a perf-* risk is accepted by page path only`);
    } else if (p !== null) {
      if (kind === 'page' && !p.startsWith('/')) problems.push(`${where}: a page subject is a URL path starting with /`);
      if (kind === 'singleton' && p !== e.check) problems.push(`${where}: a singleton subject is the check id itself, or null`);
      if (kind === 'report' && !REPORTS.includes(p)) problems.push(`${where}: a report subject is a report id`);
      if (kind === 'device' && !['mobile', 'desktop'].includes(p)) problems.push(`${where}: a device subject is mobile or desktop`);
      if (kind === 'page-or-reason' && !p.startsWith('/') && !KNOWN_REASONS.includes(p)) problems.push(`${where}: this subject is a URL path starting with /, or a reason slug`);
      if (kind === 'page-or-singleton' && !p.startsWith('/') && p !== e.check) problems.push(`${where}: this subject is a URL path starting with /, or the check id itself`);
      if (kind === 'service' && !SERVICES.includes(p)) problems.push(`${where}: a service subject is one of ${SERVICES.join(', ')}`);
      if (kind === 'host' && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(p)) problems.push(`${where}: a host subject is a bare lowercase host`);
      if (kind === 'pointer' && !p.startsWith('/')) problems.push(`${where}: a pointer subject is a JSON pointer starting with /`);
      if ((kind === 'label' || kind === 'enhancement-type') && p.startsWith('/')) problems.push(`${where}: a label subject is the label text, not a path`);
    }
  });
  return problems;
}

export function loadAcceptedRisks(file = ACCEPTED_RISKS_PATH) {
  const entries = JSON.parse(readFileSync(file, 'utf8'));
  const problems = acceptedRiskProblems(entries);
  if (problems.length) throw new Error(`accepted-risks.json is malformed: ${problems.join('; ')}`);
  return entries;
}

const reportOf = (f) => REPORT_OF[f.check] ?? 'envelope';

function currentMetrics(capture) {
  const r = capture.reports ?? {};
  const ok = (id) => (r[id]?.status === 'ok' ? r[id] : null);
  const perf = ok('performance');
  const idx = ok('indexing-pages');
  const sm = ok('sitemaps');
  const index = sm?.rows.find((row) => {
    try {
      return new URL(row.path).pathname === '/sitemap.xml';
    } catch {
      return false;
    }
  });
  const msg = ok('messages');
  const en = ok('enhancements');
  const vid = ok('videos');
  // A null `warning` is a figure the report did not show. A sum over only the shown figures would
  // compare across runs as a drop whenever one report stopped showing its figure, so the metric is
  // null unless every item shows one.
  const warnings = en ? en.items.map((i) => i.warning) : [];
  return {
    clicks: perf ? perf.totals.clicks : null,
    impressions: perf ? perf.totals.impressions : null,
    indexed: idx ? idx.indexed : null,
    not_indexed: idx ? idx.not_indexed : null,
    discovered: index ? index.discovered_pages : null,
    unread: msg ? msg.unread : null,
    enhancement_warning: warnings.length && warnings.every((w) => w !== null) ? warnings.reduce((s, w) => s + w, 0) : null,
    enhancement_invalid: en ? en.items.reduce((s, i) => s + i.invalid, 0) : null,
    videos_indexed: vid ? vid.indexed : null,
    videos_not_indexed: vid ? vid.not_indexed : null,
  };
}

const METRIC_REPORT = {
  clicks: 'performance', impressions: 'performance', indexed: 'indexing-pages', not_indexed: 'indexing-pages', discovered: 'sitemaps',
  unread: 'messages', enhancement_warning: 'enhancements', enhancement_invalid: 'enhancements', videos_indexed: 'videos',
  videos_not_indexed: 'videos',
};
const SEV_ORDER = { [ERROR]: 0, [WARN]: 1, [INFO]: 2 };
const bySeverity = (a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.check.localeCompare(b.check) || a.url.localeCompare(b.url);

/**
 * @param {Array} findings from evaluateCapture
 * @param {object} capture the normalised, validated capture
 * @param {object} opts
 * @param {string} opts.dir state dir (already checked to be outside the repo)
 * @param {Array} opts.acceptedRisks
 * @param {boolean} [opts.full]
 * @param {boolean} [opts.noSave]
 * @param {boolean} [opts.json]
 * @param {(line: string) => void} [opts.log]
 * @param {Date} [opts.now]
 * @param {string} [opts.home] collapsed to ~ in printed paths
 * @param {object} [opts.meta] small run metadata; `capture` is the capture's display path
 * @returns {number} exit code
 */
export function finishRun(findings, capture, { dir, acceptedRisks = [], full = false, noSave = false, json = false, log = (l) => process.stdout.write(`${l}\n`), now = new Date(), home, meta = {} } = {}) {
  const mode = capture.mode;
  const { fresh, accepted } = partitionAccepted(findings, acceptedRisks);
  const reportStatus = Object.fromEntries(REPORTS.map((id) => [id, capture.reports?.[id]?.status ?? 'absent']));
  const period = reportStatus.performance === 'ok' ? capture.reports.performance.period : null;

  const added = [];
  const resolved = [];
  const unchanged = [];
  const notCompared = [];
  const baselines = {};

  for (const id of ['envelope', ...REPORTS]) {
    const current = fresh.filter((f) => reportOf(f) === id);
    if (id !== 'envelope' && reportStatus[id] !== 'ok') {
      if (reportStatus[id] !== 'absent' || current.length) notCompared.push({ report: id, reason: reportStatus[id], findings: current });
      continue;
    }
    const prev = loadLatestComparable(dir, mode, id);
    baselines[id] = prev ? prev.generated : null;
    if (!prev) {
      added.push(...current);
      continue;
    }
    if (id === 'performance' && prev.period && period && prev.period !== period) {
      notCompared.push({ report: id, reason: 'period-mismatch', findings: current });
      continue;
    }
    const d = diffFindings((prev.findings ?? []).filter((f) => reportOf(f) === id), current);
    added.push(...d.added);
    resolved.push(...d.resolved);
    unchanged.push(...d.unchanged);
  }

  const cur = currentMetrics(capture);
  const metrics = { current: cur, previous: {}, delta: {} };
  for (const [key, report] of Object.entries(METRIC_REPORT)) {
    metrics.previous[key] = null;
    metrics.delta[key] = null;
    if (cur[key] === null) continue;
    const prev = loadLatestComparable(dir, mode, report);
    if (!prev || prev.metrics?.[key] === null || prev.metrics?.[key] === undefined) continue;
    if (report === 'performance' && prev.period !== period) continue;
    metrics.previous[key] = prev.metrics[key];
    metrics.delta[key] = cur[key] - prev.metrics[key];
  }

  let savedTo = null;
  if (!noSave) {
    savedTo = saveRun(dir, {
      mode, now, captureBasename: meta.captureBasename ?? null, reportStatus, metrics: cur, period,
      meta: { nonce: capture.nonce, captured_at: capture.captured_at, sitemap_state: meta.sitemapState ?? null },
      findings: fresh, accepted,
    });
  }

  const exitCode = exitCodeFor(fresh);

  if (json) {
    log(JSON.stringify({ fresh, accepted, added, resolved, unchanged, notCompared, metrics, exitCode }));
    return exitCode;
  }

  const count = (sev) => fresh.filter((f) => f.severity === sev).length;
  const statusCount = (s) => Object.values(reportStatus).filter((v) => v === s).length;
  const age = daysSince(capture.property_added, now);
  log('');
  log(`search-console ${mode} | property ${capture.property} | captured ${capture.captured_at} | nonce ${capture.nonce} | property age ${age ?? 'unknown'} day(s)`);
  if (meta.capture) log(`capture: ${meta.capture}`);
  log(`summary: ${count(ERROR)} ERROR, ${count(WARN)} WARN, ${count(INFO)} INFO, ${accepted.length} accepted | reports: ${statusCount('ok')} ok, ${statusCount('not-ready')} not-ready, ${statusCount('not-present')} not-present, ${statusCount('absent')} absent`);

  const printList = (label, list) => {
    if (list.length === 0) return;
    log(`\n${label}:`);
    for (const f of [...list].sort(bySeverity)) log(`  [${f.severity}] ${f.check} ${f.url}\n      ${f.detail}`);
  };
  printList('NEW', added);
  printList('RESOLVED', resolved);
  if (full) printList('UNCHANGED', unchanged);
  else if (unchanged.length) log(`\n(${unchanged.length} unchanged finding(s) suppressed; run with --full to see them)`);

  if (notCompared.length) {
    log('\nNOT COMPARED:');
    for (const n of notCompared) {
      log(`  ${n.report}: ${n.reason}`);
      for (const f of [...n.findings].sort(bySeverity)) log(`    [${f.severity}] ${f.check} ${f.url}\n        ${f.detail}`);
    }
  }

  if (full && accepted.length) {
    log('\nACCEPTED RISKS:');
    for (const f of accepted) log(`  [${f.severity}] ${f.check} ${f.url}\n      accepted ${f.accepted_on}: ${f.note}`);
  } else if (accepted.length) {
    log(`(${accepted.length} accepted risk(s) suppressed; run with --full to see them)`);
  }

  log('\nMETRICS:');
  for (const key of Object.keys(METRIC_REPORT)) {
    const c = metrics.current[key];
    const d = metrics.delta[key];
    log(`  ${key}: ${c === null ? 'n/a' : c}${d === null ? (c === null ? '' : ' (not compared)') : ` (${d >= 0 ? '+' : ''}${d})`}`);
  }

  if (savedTo) log(`\nsaved run -> ${displayPath(savedTo, home)}`);
  log(`exit ${exitCode} (any fresh ERROR blocks; accepted risks do not)`);
  return exitCode;
}
