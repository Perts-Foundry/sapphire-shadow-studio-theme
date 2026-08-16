#!/usr/bin/env node
// Turn `pa11y-ci --json` output into a bounded, sanitised PR-comment body.
//
// Three jobs, all of them safety rather than presentation:
//
//   FAIL CLOSED ON ZERO. pa11y-ci exits 0 when it audited nothing. A config
//   that lost its URLs, a run that died before starting, an empty results
//   object: all of them look like "no accessibility errors". Auditing zero
//   pages is a failure here, never a pass. This is why the URL count is read
//   out of the JSON rather than grepped from pa11y's prose output.
//
//   SANITISE. Every issue message, selector and context snippet is page-derived
//   text, and on a config error pa11y can echo the config itself, which holds a
//   session cookie. None of it may reach a PR comment as markup, as a fence
//   break, or verbatim.
//
//   BOUND. GitHub rejects a comment over 65536 characters. An audit finding
//   hundreds of issues would produce a body that fails to post, and a failed
//   upsert would mask the very result it was reporting. The output is capped
//   well under the limit with an explicit truncation notice.
//
// Usage: node scripts/a11y/summarize-pa11y.mjs <pa11y-json-file> [--exit-code N]
// Exit 0 when the audit ran clean, 1 otherwise.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Comfortably under GitHub's 65536 hard limit, leaving room for the header,
// the table and the closing notes that wrap this body.
export const MAX_BODY = 50000;
const MAX_ISSUES_PER_URL = 10;

/**
 * Strip anything that could break out of a fenced code block or inject markup,
 * and clamp the length of a single field.
 * @param {unknown} text
 * @param {number} [max]
 * @returns {string}
 * @example
 *   sanitize('```rm -rf```') // '``rm -rf``'
 */
export function sanitize(text, max = 300) {
  let s = String(text ?? '')
    .replace(/`{3,}/g, '``')          // cannot close the wrapping fence
    .replace(/<\/?details>/gi, '')     // cannot close the wrapping <details>
    // Control characters, the ANSI escape introducer included: page-derived
    // text must not be able to drive a log renderer or a terminal.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r?\n/g, ' ')
    .trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

/**
 * @typedef {object} Summary
 * @property {boolean} ok
 * @property {number} total   URLs audited
 * @property {number} passes
 * @property {number} errors
 * @property {string} reason
 * @property {string} body    markdown, already bounded and sanitised
 */

/**
 * @param {unknown} raw parsed `pa11y-ci --json` output
 * @param {{exitCode?: number|null}} [opts] pa11y-ci's own exit code, when known
 * @returns {Summary}
 * @example
 *   summarize({ total: 1, passes: 1, errors: 0, results: { 'https://x': [] } })
 */
export function summarize(raw, { exitCode = null } = {}) {
  if (!raw || typeof raw !== 'object') {
    return fail('pa11y-ci produced no parseable JSON (it probably failed to start)');
  }

  const results = raw.results && typeof raw.results === 'object' ? raw.results : null;
  if (!results) return fail('pa11y-ci JSON has no `results` object');

  const urls = Object.keys(results);
  // THE fail-closed floor. Nothing below this point can turn zero URLs green.
  if (urls.length === 0) {
    return fail('pa11y-ci audited 0 URLs. The config lost its URL list, or the run died before the first page.');
  }

  const total = typeof raw.total === 'number' ? raw.total : urls.length;
  if (total === 0) return fail('pa11y-ci reported total=0 URLs audited');

  // Count errors from the results themselves rather than trusting the summary
  // fields, so a malformed count cannot under-report.
  const perUrl = urls.map((url) => {
    const issues = Array.isArray(results[url]) ? results[url] : [];
    return { url, issues: issues.filter((i) => i && i.type === 'error'), all: issues };
  });
  const errors = perUrl.reduce((n, u) => n + u.issues.length, 0);
  const passes = perUrl.filter((u) => u.issues.length === 0).length;

  const lines = [];
  lines.push(`**${total} URL(s) audited** against WCAG 2.1 AA (axe runner, plus \`target-size\`).`);
  lines.push('');
  lines.push('| Page | Errors |');
  lines.push('|:--|--:|');
  for (const u of perUrl) {
    lines.push(`| \`${sanitize(pathOf(u.url), 120)}\` | ${u.issues.length === 0 ? '0 ✅' : `${u.issues.length} ❌`} |`);
  }
  lines.push('');

  for (const u of perUrl.filter((x) => x.issues.length)) {
    lines.push(`<details><summary><strong>${sanitize(pathOf(u.url), 120)}</strong> (${u.issues.length})</summary>`);
    lines.push('');
    lines.push('```');
    for (const issue of u.issues.slice(0, MAX_ISSUES_PER_URL)) {
      lines.push(`- [${sanitize(issue.code, 80)}] ${sanitize(issue.message, 300)}`);
      if (issue.selector) lines.push(`    selector: ${sanitize(issue.selector, 160)}`);
    }
    if (u.issues.length > MAX_ISSUES_PER_URL) {
      lines.push(`  ... and ${u.issues.length - MAX_ISSUES_PER_URL} more; see the job log for the full list.`);
    }
    lines.push('```');
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  let body = lines.join('\n');
  if (body.length > MAX_BODY) {
    body = `${body.slice(0, MAX_BODY)}\n\n_Output truncated; see the job log for the full report._`;
  }

  // A non-zero pa11y-ci exit with no errors parsed out means it failed for some
  // other reason (a page that would not load, a Chrome crash). Do not green it.
  if (errors === 0 && exitCode !== null && exitCode !== 0) {
    return {
      ok: false, total, passes, errors, body,
      reason: `pa11y-ci exited ${exitCode} but reported no accessibility errors; the run itself failed`,
    };
  }

  return {
    ok: errors === 0,
    total,
    passes,
    errors,
    body,
    reason: errors === 0 ? `${total} URL(s) clean` : `${errors} accessibility error(s) across ${total - passes} URL(s)`,
  };
}

function fail(reason) {
  return { ok: false, total: 0, passes: 0, errors: 0, reason, body: `❌ ${sanitize(reason, 500)}` };
}

/** Path + query of a URL, with the preview_theme_id pin dropped for legibility. */
function pathOf(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('preview_theme_id');
    return `${u.pathname}${u.search}`;
  } catch {
    return String(url);
  }
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const exitFlag = args.indexOf('--exit-code');
  const exitCode = exitFlag >= 0 ? Number(args[exitFlag + 1]) : null;

  let raw = null;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    raw = null;
    process.stderr.write(`summarize-pa11y: could not read ${file}: ${err.message}\n`);
  }

  const summary = summarize(raw, { exitCode: Number.isFinite(exitCode) ? exitCode : null });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = summary.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
