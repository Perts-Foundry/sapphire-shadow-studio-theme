#!/usr/bin/env node
// Turn `pa11y-ci --json` output into a bounded, sanitised PR-comment body.
//
// Four jobs, all of them safety rather than presentation:
//
//   FAIL CLOSED ON ZERO. pa11y-ci exits 0 when it audited nothing. A config
//   that lost its URLs, a run that died before starting, an empty results
//   object: all of them look like "no accessibility errors". Auditing zero
//   pages is a failure here, never a pass. This is why the URL count is read
//   out of the JSON rather than grepped from pa11y's prose output.
//
//   APPLY THE BASELINE HERE, NOT IN THE RUNNER. scripts/a11y/baseline.json
//   silences known-debt axe rules audit-wide. The suppression used to be
//   handed to pa11y as `defaults.ignore`, which dropped those findings inside
//   the browser: the report could not say what it had hidden, and the comment
//   claimed a full WCAG 2.1 AA pass over rules it never gated. pa11y now
//   reports everything and the filter runs here, so the body can disclose the
//   ignored-rule list AND the exact number of findings each rule hid on this
//   run. Deleting a rule from the baseline is the only way to start gating it;
//   the per-rule count is what tells you when a rule is safe to delete.
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
// CROSS-FILE COUPLING: every fence this file emits must stay a BARE ```, never
// an info-string fence (```text). validate.yml's comment step re-caps this body
// at 30k and, when it cannot cut at a block boundary, counts bare ``` lines for
// parity to decide what to close. An info-string fence would flip that count
// and make the fallback append a closer that opens a block instead.
//
// Usage: node scripts/a11y/summarize-pa11y.mjs <pa11y-json-file> [--exit-code N]
// Exit 0 when the audit ran clean, 1 otherwise.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BASELINE_FILE = join(HERE, 'baseline.json');

// Comfortably under GitHub's 65536 hard limit, leaving room for the header,
// the table and the closing notes that wrap this body.
export const MAX_BODY = 50000;
const MAX_ISSUES_PER_URL = 10;

/**
 * Validate and normalise a parsed baseline.json into a lower-cased rule list.
 * A malformed file is a hard error, never a silent no-op: a baseline that
 * ignored nothing would fail every run loudly, but one that silently ignored
 * EVERYTHING would hide every regression, so the shape is validated rather
 * than defaulted.
 * @param {unknown} baseline parsed baseline.json
 * @returns {string[]} lower-cased axe rule ids
 * @example
 *   normaliseBaseline({ ignore: ['Color-Contrast'] }) // ['color-contrast']
 */
export function normaliseBaseline(baseline) {
  const ignore = baseline?.ignore;
  if (!Array.isArray(ignore) || !ignore.every((c) => typeof c === 'string' && c.length > 0)) {
    throw new Error('baseline.json must have an `ignore` array of non-empty strings');
  }
  return ignore.map((c) => c.toLowerCase());
}

/**
 * Read and validate the committed baseline.
 * @param {string} [file]
 * @returns {string[]} lower-cased axe rule ids
 * @example
 *   loadBaseline() // ['aria-prohibited-attr', ...]
 */
export function loadBaseline(file = BASELINE_FILE) {
  return normaliseBaseline(JSON.parse(readFileSync(file, 'utf8')));
}

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
 * @property {number} total       URLs audited
 * @property {number} passes
 * @property {number} errors      gating errors, baselined rules excluded
 * @property {number} suppressed  findings hidden by the baseline on this run
 * @property {number} warnings    non-gating needs-review findings (axe could
 *                                not measure, e.g. text over an image); counted
 *                                and disclosed so they can be tracked over time
 * @property {number} malformed   result entries pa11y-ci recorded for a URL it
 *                                could not test at all (a load failure or a
 *                                Chrome crash serialises as a bare `{}`)
 * @property {string} reason
 * @property {string} body        markdown, already bounded and sanitised
 */

/**
 * @param {unknown} raw parsed `pa11y-ci --json` output
 * @param {object} [opts]
 * @param {number|null} [opts.exitCode] pa11y-ci's own exit code, when known
 * @param {string[]} [opts.baseline] axe rule ids to suppress; defaults to none,
 *   so a caller that forgets to pass one over-reports rather than under-reports
 * @returns {Summary}
 * @example
 *   summarize({ total: 1, passes: 1, errors: 0, results: { 'https://x': [] } })
 */
export function summarize(raw, { exitCode = null, baseline = [] } = {}) {
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

  const baselined = new Set(baseline.map((c) => String(c).toLowerCase()));

  // Count errors from the results themselves rather than trusting the summary
  // fields, so a malformed count cannot under-report.
  const perUrl = urls.map((url) => {
    // A result that is not an array at all is untested too, not empty. The old
    // `: []` fallback scored such a URL as a clean pass, which was survivable
    // only while pa11y-ci's exit code independently caught it; with the
    // baseline applied here that exit code is non-zero on nearly every run and
    // no longer discriminates. Fail closed instead.
    const raw = results[url];
    const entries = Array.isArray(raw) ? raw : [{ __untested: raw === undefined ? 'missing' : typeof raw }];
    // pa11y-ci stores a caught exception as the URL's whole result array, and
    // an Error serialises to `{}`. Such an entry has no `type`, so the old
    // `type === 'error'` filter counted that URL as a clean pass. It is now a
    // hard failure: a page that never loaded is not a page that passed.
    const malformed = entries.filter((e) => !e || typeof e !== 'object' || typeof e.type !== 'string');
    const errorsAll = entries.filter((e) => e && typeof e === 'object' && e.type === 'error');
    // Needs-review findings: axe's `incomplete` results, capped to warning by
    // build-pa11yci.mjs (levelCapWhenNeedsReview) and kept in the JSON by
    // includeWarnings. Not gated, but counted and disclosed per rule so the
    // trend is visible run over run.
    const warningsAll = entries.filter((e) => e && typeof e === 'object' && e.type === 'warning');
    const isBaselined = (e) => baselined.has(String(e.code ?? '').toLowerCase());
    return {
      url,
      issues: errorsAll.filter((e) => !isBaselined(e)),
      suppressed: errorsAll.filter(isBaselined),
      warnings: warningsAll,
      malformed,
    };
  });
  const errors = perUrl.reduce((n, u) => n + u.issues.length, 0);
  const suppressed = perUrl.reduce((n, u) => n + u.suppressed.length, 0);
  const warnings = perUrl.reduce((n, u) => n + u.warnings.length, 0);
  const malformed = perUrl.reduce((n, u) => n + u.malformed.length, 0);
  const passes = perUrl.filter((u) => u.issues.length === 0 && u.malformed.length === 0).length;

  // Per-rule tally, seeded with every baselined rule so a rule that hid
  // nothing on this run shows as 0 and can be deleted from baseline.json.
  const hidden = new Map(baseline.map((c) => [String(c).toLowerCase(), 0]));
  for (const u of perUrl) {
    for (const e of u.suppressed) {
      const code = String(e.code ?? '').toLowerCase();
      hidden.set(code, (hidden.get(code) ?? 0) + 1);
    }
  }

  const lines = [];
  // The audited-standard claim is qualified by what the baseline actually
  // gates. `target-size` is requested explicitly (CLAUDE.md's 44x44 project
  // rule), so saying "plus target-size" while it sits in the baseline was the
  // exact over-claim this disclosure exists to stop.
  const targetSizeBaselined = baselined.has('target-size');
  lines.push(targetSizeBaselined
    ? `**${total} URL(s) audited** against WCAG 2.1 AA (axe runner). \`target-size\` is enabled but baselined, so 44x44 touch targets are measured and listed below, not gated.`
    : `**${total} URL(s) audited** against WCAG 2.1 AA (axe runner, plus \`target-size\`).`);
  lines.push('');

  if (baseline.length > 0) {
    lines.push(`> ⚠️ **Baseline active: ${baseline.length} rule(s) suppressed audit-wide, hiding ${suppressed} finding(s) on this run.**`);
    lines.push('> A pass here means no findings OUTSIDE that rule set. It is not a clean bill of health, and a NEW instance of a baselined rule is invisible until the rule is deleted from `scripts/a11y/baseline.json`.');
    lines.push('');
    lines.push(`<details><summary><strong>Suppressed rules</strong> (${baseline.length})</summary>`);
    lines.push('');
    lines.push('| Rule | Findings hidden |');
    lines.push('|:--|--:|');
    for (const [code, count] of hidden) {
      lines.push(`| \`${sanitize(code, 80)}\` | ${count === 0 ? '0 (clear it)' : count} |`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  if (malformed > 0) {
    lines.push(`❌ **${malformed} URL result(s) could not be tested at all** (page load failure or a Chrome crash); see the job log. These are counted as failures, not passes.`);
    lines.push('');
  }

  lines.push('| Page | Errors | Suppressed | Needs review |');
  lines.push('|:--|--:|--:|--:|');
  for (const u of perUrl) {
    const cell = u.malformed.length > 0
      ? '⚠️ untested'
      : (u.issues.length === 0 ? '0 ✅' : `${u.issues.length} ❌`);
    lines.push(`| \`${sanitize(pathOf(u.url), 120)}\` | ${cell} | ${u.suppressed.length} | ${u.warnings.length} |`);
  }
  lines.push('');

  if (warnings > 0) {
    // Needs-review disclosure. These do not gate: axe could not measure them
    // (text over an image, a gradient, an overlapping element), so a red check
    // would be noise. The per-rule tally is the tracking signal; a jump between
    // runs means new unmeasurable text landed and deserves a manual look.
    const byRule = new Map();
    for (const u of perUrl) {
      for (const w of u.warnings) {
        const code = String(w.code ?? 'unknown').toLowerCase();
        byRule.set(code, (byRule.get(code) ?? 0) + 1);
      }
    }
    lines.push(`<details><summary><strong>Needs review</strong> (${warnings} finding(s) axe could not measure; not gated)</summary>`);
    lines.push('');
    lines.push('| Rule | Findings |');
    lines.push('|:--|--:|');
    for (const [code, count] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`| \`${sanitize(code, 80)}\` | ${count} |`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

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

  if (malformed > 0) {
    return {
      ok: false, total, passes, errors, suppressed, warnings, malformed, body,
      reason: `${malformed} URL(s) could not be tested (load failure or crash)`,
    };
  }

  // A non-zero pa11y-ci exit with nothing parsed out means it failed for some
  // other reason (a page that would not load, a Chrome crash). Do not green it.
  // This net only fires when the report is otherwise empty: pa11y-ci counts
  // EVERY issue it reports toward a URL's pass/fail, so with the baseline
  // applied HERE rather than in the runner it legitimately exits non-zero on
  // any baselined finding, and with includeWarnings it does the same on any
  // needs-review warning. The per-URL `malformed` check above is the primary
  // crash detector now.
  if (errors === 0 && suppressed === 0 && warnings === 0 && exitCode !== null && exitCode !== 0) {
    return {
      ok: false, total, passes, errors, suppressed, warnings, malformed, body,
      reason: `pa11y-ci exited ${exitCode} but reported no accessibility findings at all; the run itself failed`,
    };
  }

  const suffix = suppressed > 0 ? `, ${suppressed} baselined finding(s) suppressed` : '';
  return {
    ok: errors === 0,
    total,
    passes,
    errors,
    suppressed,
    warnings,
    malformed,
    body,
    reason: errors === 0
      ? `${total} URL(s) clean${suffix}`
      : `${errors} accessibility error(s) across ${total - passes} URL(s)${suffix}`,
  };
}

function fail(reason) {
  return {
    ok: false, total: 0, passes: 0, errors: 0, suppressed: 0, warnings: 0, malformed: 0,
    reason, body: `❌ ${sanitize(reason, 500)}`,
  };
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

  // Deliberately outside the try below: a malformed baseline must abort loudly
  // rather than degrade into an unbaselined run whose every known-debt finding
  // reads as a fresh regression.
  const baseline = loadBaseline();

  let raw = null;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    raw = null;
    process.stderr.write(`summarize-pa11y: could not read ${file}: ${err.message}\n`);
  }

  const summary = summarize(raw, { exitCode: Number.isFinite(exitCode) ? exitCode : null, baseline });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = summary.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
