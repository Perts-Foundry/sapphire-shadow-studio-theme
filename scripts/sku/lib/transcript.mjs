// Tee gated command output to a transcript file.
//
// The apply gate's contract is "present verbatim", but the presentation layer (a shell pipe, a
// harness that truncates large outputs) can silently drop lines before the operator sees them.
// The first live run piped apply through `tail`, which would have hidden failed-row lines on a
// larger catalogue. The transcript makes verbatim recoverable regardless of what the shell did:
// every line apply prints is also appended, synchronously, to a file next to the receipt.
//
// Append-per-line rather than buffer-and-write-at-end, for the same reason apply persists the
// receipt per progress event: a crash mid-apply must leave a record of everything up to the crash.

import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import util from 'node:util';

/**
 * The transcript's path, alongside the plan and receipt artifacts. Dry-run and live apply get
 * distinct files: a dry-run can legitimately re-run, and its transcript must never overwrite the
 * live run's record (or vice versa).
 *
 * @param {string} dir
 * @param {string} planId
 * @param {boolean} dryRun
 * @returns {string}
 */
export function transcriptPath(dir, planId, dryRun) {
  return path.join(dir, `transcript-${planId}${dryRun ? '-dry-run' : ''}.log`);
}

/**
 * Run `fn` with console.log/console.error teed to `filePath`, restoring them afterwards.
 *
 * Any existing file is truncated first, so a re-run (the dry-run path) never presents a stale
 * mixed transcript. Lines are formatted with util.format, matching what console printed.
 *
 * @template T
 * @param {string} filePath
 * @param {() => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
export async function withTranscript(filePath, fn) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, '', 'utf8');
  const originalLog = console.log;
  const originalError = console.error;
  const tee = (original) => (...args) => {
    original(...args);
    appendFileSync(filePath, `${util.format(...args)}\n`, 'utf8');
  };
  console.log = tee(originalLog);
  console.error = tee(originalError);
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}
