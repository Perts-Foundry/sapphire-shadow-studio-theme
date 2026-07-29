// report.mjs -- shared finish-line for the three modes: partition findings
// against accepted risks, diff against the baseline, print, persist, and
// compute the exit code. Printing only ever includes finding text; never
// bodies, tokens, passwords, or cookie values.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { partitionAccepted, diffFindings, exitCodeFor } from './checks.mjs';
import { saveRun, loadLatest } from './baseline.mjs';

export function loadAcceptedRisks() {
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'accepted-risks.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * @param {string} mode crawl | surface | admin
 * @param {Array} findings raw findings from the mode
 * @param {object} opts { full: boolean, noSave: boolean, meta: object, log: fn }
 * @returns {number} exit code
 */
export function finishRun(mode, findings, { full = false, noSave = false, meta = {}, log = (l) => process.stdout.write(l + '\n') } = {}) {
  const { fresh, accepted } = partitionAccepted(findings, loadAcceptedRisks());
  const previous = loadLatest(mode);
  const { added, resolved, unchanged } = diffFindings(previous ? previous.findings : null, fresh);

  log('');
  log(`== seo-review ${mode}: ${fresh.length} finding(s), ${accepted.length} accepted risk(s) ==`);
  if (previous) log(`baseline: ${previous.generated} (${added.length} new, ${resolved.length} resolved, ${unchanged.length} unchanged)`);
  else log('baseline: none (first run; all findings are new)');

  const printList = (label, list) => {
    if (list.length === 0) return;
    log(`\n${label}:`);
    for (const f of list) log(`  [${f.severity}] ${f.check} ${f.url}\n      ${f.detail}`);
  };

  printList('NEW since baseline', added);
  printList('RESOLVED since baseline', resolved);
  if (full) {
    printList('UNCHANGED (still present)', unchanged);
    if (accepted.length) {
      log('\nACCEPTED RISKS (known, deliberate):');
      for (const f of accepted) log(`  [${f.severity}] ${f.check} ${f.url}\n      ${f.detail}\n      accepted ${f.accepted_on}: ${f.note}`);
    }
  } else {
    if (unchanged.length) log(`\n(${unchanged.length} unchanged finding(s) suppressed; run with --full to see them)`);
    if (accepted.length) log(`(${accepted.length} accepted risk(s) suppressed; run with --full to see them)`);
  }

  if (!noSave) {
    const path = saveRun(mode, fresh, meta);
    log(`\nsaved run -> ${path}`);
  }

  // First run: every fresh finding is effectively new. Later runs: block only
  // on findings that were not in the baseline.
  const blocking = previous ? added : fresh;
  const exitCode = exitCodeFor(blocking);
  log(`exit ${exitCode} (blocks only on ERROR findings new since the baseline)`);
  return exitCode;
}
