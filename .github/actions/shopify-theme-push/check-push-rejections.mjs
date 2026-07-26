#!/usr/bin/env node
//
// check-push-rejections.mjs -- audit a `shopify theme push --json` report for
// assets Shopify refused to store.
//
// WHY THIS EXISTS: `shopify theme push` exits 0 even when the server rejected
// individual files. Shopify validates JSON template settings against the
// section schema already stored on the theme and refuses the whole asset when
// a value is out of range, e.g.
//
//   Asset upload failed for templates/index.json:
//     Setting 'autoplay_speed' can't be less than 3
//
// The CLI records that as a per-file failure, prints the sentence only on the
// debug/analytics path, and still returns normally. Three consecutive CI runs
// reported a green deploy while the template on the theme stayed frozen on its
// last valid version, and the post-deploy smoke test stayed green because
// every probed page still rendered (just from stale content).
//
// THE SIGNAL: the CLI's own `--json` payload already carries the failure in
// structured form. @shopify/cli 4.5.2 builds it in the theme-push service:
// when any upload result has success === false it sets
//
//   theme.warning = "The theme '<name>' was pushed with errors"
//   theme.errors  = { "<filename>": ["<reason>", ...], ... }
//
// on the object it serialises to stdout. That is what this script asserts on,
// rather than grepping human-readable stderr or requiring --verbose: it is a
// machine-readable contract, and it names both the file and the reason.
//
// EXIT CODES (the action's push step branches on these):
//   0  clean push, nothing rejected. Prints nothing; a good deploy stays quiet.
//   1  one or more assets rejected. Prints ::error:: annotations + a summary.
//   2  the report could not be read or parsed. The caller's require_json()
//      owns that diagnosis, so this stays a distinct code and does not retry.
//
// USAGE:
//   node check-push-rejections.mjs push.json

import { readFileSync } from 'node:fs';

// Cap what a mass rejection can dump into the log and into the step's
// push_output (which the deploy report embeds in a PR comment).
const MAX_FILES = 20;
const MAX_MESSAGE_CHARS = 300;

/**
 * Strip control characters and redact token-shaped strings from a value that
 * originated server-side. Mirrors the redaction action.yml applies to captured
 * push output: a Shopify message is not expected to carry a token, but this
 * text is echoed into a PR comment on a public repo, so it is scrubbed on the
 * way out rather than trusted.
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeMessage(value) {
  const text = String(value ?? '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/(shpat|shpca|shpss|shppa|shpua|shptka)_[A-Za-z0-9]{16,}/g, '[REDACTED]')
    .trim();
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}...` : text;
}

/**
 * Read the `theme.errors` / `theme.warning` pair out of a parsed push report.
 *
 * Tolerant by design: `warning` is set whenever any file failed, while
 * `errors` is only populated for failures that carried a per-asset message.
 * A push that reports the warning with no error detail still counts as
 * rejected, so a future CLI that drops one of the two fields degrades to a
 * loud failure rather than a silent pass.
 *
 * @param {unknown} report parsed `shopify theme push --json` payload
 * @returns {{rejected: boolean, warning: string|null, files: Array<{file: string, messages: string[]}>, truncated: number}}
 */
export function findRejections(report) {
  const theme = report && typeof report === 'object' ? report.theme : null;
  if (!theme || typeof theme !== 'object') {
    return { rejected: false, warning: null, files: [], truncated: 0 };
  }

  const warning = typeof theme.warning === 'string' && theme.warning.trim()
    ? sanitizeMessage(theme.warning)
    : null;

  const errors = theme.errors && typeof theme.errors === 'object' && !Array.isArray(theme.errors)
    ? theme.errors
    : {};

  const allFiles = Object.keys(errors).map((file) => {
    const raw = errors[file];
    const messages = (Array.isArray(raw) ? raw : [raw])
      .map(sanitizeMessage)
      .filter(Boolean);
    return { file: sanitizeMessage(file), messages: messages.length ? messages : ['(no reason given)'] };
  });

  const files = allFiles.slice(0, MAX_FILES);
  return {
    rejected: Boolean(warning) || allFiles.length > 0,
    warning,
    files,
    truncated: allFiles.length - files.length,
  };
}

/**
 * Escape a string for use inside a GitHub Actions workflow command.
 * @param {string} value
 * @returns {string}
 */
function escapeAnnotation(value) {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/**
 * Render the log block for a rejected push: one ::error:: annotation per
 * rejected file (anchored to the file so it surfaces in the PR's Files tab),
 * then a plain-text summary that survives the action's `tail -30` capture into
 * push_output.
 * @param {ReturnType<typeof findRejections>} result
 * @returns {string[]} lines
 */
export function formatRejectionReport(result) {
  const lines = [];
  const count = result.files.length + result.truncated;
  const noun = count === 1 ? 'asset' : 'assets';

  lines.push(
    `::error::Shopify rejected ${count || 'one or more'} ${noun} during theme push. ` +
    'The push command exited 0, but these files were NOT written to the theme.',
  );

  for (const { file, messages } of result.files) {
    for (const message of messages) {
      lines.push(`::error file=${escapeAnnotation(file)}::${escapeAnnotation(message)}`);
    }
  }

  lines.push('Rejected assets (theme push exited 0; Shopify refused these files):');
  for (const { file, messages } of result.files) {
    for (const message of messages) {
      lines.push(`  ${file}: ${message}`);
    }
  }
  if (result.truncated > 0) {
    lines.push(`  ...and ${result.truncated} more rejected file(s); see the raw push JSON above.`);
  }
  if (result.files.length === 0 && result.warning) {
    lines.push(`  ${result.warning}`);
  }
  lines.push(
    'A JSON template is validated against the section schema already stored on ' +
    'the theme, so a setting value outside its schema range, or a template ' +
    'pushed ahead of the schema change it depends on, is refused wholesale.',
  );

  return lines;
}

/**
 * @param {string} path push.json
 * @param {(line: string) => void} log
 * @returns {number} process exit code
 */
export function checkFile(path, log) {
  let report;
  try {
    report = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    log(`::warning::Could not parse ${path} as JSON; cannot audit for rejected assets.`);
    return 2;
  }
  const result = findRejections(report);
  if (!result.rejected) return 0;
  for (const line of formatRejectionReport(result)) log(line);
  return 1;
}

// Only run the CLI when executed directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) {
    process.stdout.write('::warning::check-push-rejections.mjs: no push report path given\n');
    process.exit(2);
  }
  process.exit(checkFile(path, (line) => process.stdout.write(`${line}\n`)));
}
