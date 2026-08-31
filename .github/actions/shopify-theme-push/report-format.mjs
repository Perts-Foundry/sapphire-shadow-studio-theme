// Pure formatting helpers for the deploy.yml sticky PR comment (the "Post
// deploy report" and "Report failure" steps). Deliberately separate from
// smoke.mjs: that file's job is probing the storefront, this file's job is
// turning already-produced text/data into PR-comment markdown. No I/O here.

const VERDICT_BADGE = {
  PASS: ':white_check_mark:',
  'SOFT-WARN': ':warning:',
  'HARD-FAIL': ':x:',
};

// Matches the per-path line shape emitted by smoke.mjs's record() (and the
// two early-exit branches that share the shape): `path VERDICT status
// host=HOST theme=ID (reason)`. Any of the three verdicts can appear here,
// including SOFT-WARN from a throttled probe or the LOCKED-fallback branch,
// not just PASS/HARD-FAIL.
const ROW_RE = /^(\S+) (PASS|SOFT-WARN|HARD-FAIL) (\S+) host=(\S+) theme=(\S+) \((.+)\)$/;

// smoke.mjs also emits AGGREGATE verdict lines that belong to no single path, so they carry no
// status/host/theme and cannot match ROW_RE: `sitemap SOFT-WARN: ...`, `products HARD-FAIL: ...`.
// They render as notes rather than table rows, which is right, but they must still COUNT.
//
// This is not cosmetic. Until the smoke gained its zero-product-coverage HARD-FAIL, every
// aggregate line was a SOFT-WARN, so leaving them out of the tally happened to be accurate. Now a
// run can exit 1 on an aggregate line alone, and the summary would read `N passed, 0 warned,
// 0 failed` directly above a failed deploy.
//
// The optional middle token and the `-` alternative cover the auth branch's two shapes
// (`/password AUTH SOFT-WARN: ...` and `/password HARD-FAIL - AUTH: ...`), which have the same
// problem: the second is a HARD-FAIL that exits 1. Anchoring on a delimiter after the verdict is
// what keeps this from counting a note that merely mentions a verdict in prose. ROW_RE is tried
// first and wins, so a real per-path row can never reach here.
const AGG_RE = /^\S+(?: \S+)? (PASS|SOFT-WARN|HARD-FAIL)(?::| -|$)/;

/**
 * Escape `|` and backtick so a value sourced from outside this repo (a
 * storefront response header, an Admin-edited theme name, a PR-title-derived
 * commit message) can't corrupt a markdown table row or break out of a
 * backtick code span. Applied to every interpolated value in this file, not
 * just the smoke table: formatLiveThemeRow/formatLastDeployRow feed the same
 * table-row context in the deploy.yml comment body.
 */
function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/`/g, '\\`');
}

/**
 * Render smoke.mjs's plain-text `smoke_output` (the newline-joined
 * GITHUB_OUTPUT string, e.g. from `steps.push.outputs.smoke-output`) as a
 * markdown table plus a summary line, for the deploy-report sticky comment.
 * Tolerant of undefined/null/empty input: never throws, since the failure
 * report may call this when smoke produced no output at all.
 * @param {string|null|undefined} smokeOutput
 * @returns {{summaryLine: string, markdown: string}}
 */
export function renderSmokeMarkdownTable(smokeOutput) {
  const lines = (smokeOutput || '').split(/\r?\n/).filter((l) => l.trim());
  const rows = [];
  const notes = [];
  const aggregateVerdicts = [];
  for (const line of lines) {
    const m = line.match(ROW_RE);
    if (m) {
      const [, path, verdict, status, host, themeId, reason] = m;
      rows.push({ path, verdict, status, host, themeId, reason });
      continue;
    }
    const agg = line.match(AGG_RE);
    if (agg) aggregateVerdicts.push(agg[1]);
    notes.push(line);
  }

  const counts = { PASS: 0, 'SOFT-WARN': 0, 'HARD-FAIL': 0 };
  for (const r of rows) counts[r.verdict] += 1;
  for (const v of aggregateVerdicts) counts[v] += 1;
  const summaryLine = `${counts.PASS} passed, ${counts['SOFT-WARN']} warned, ${counts['HARD-FAIL']} failed`;

  const parts = [];
  if (rows.length) {
    parts.push(
      '| | Path | Status | Theme ID | Note |',
      '|:--|:--|:--|:--|:--|',
      ...rows.map((r) => `| ${VERDICT_BADGE[r.verdict] || r.verdict} | \`${escapeCell(r.path)}\` | ${escapeCell(r.status)} | ${escapeCell(r.themeId)} | ${escapeCell(r.reason)} |`),
    );
  } else {
    parts.push('_No per-path results parsed._');
  }
  if (notes.length) {
    if (rows.length) parts.push('');
    parts.push(...notes.map((n) => `> ${n}`));
  }

  return { summaryLine, markdown: parts.join('\n') };
}

/**
 * Render the "Live theme (unchanged)" row for the docs-only deploy report.
 * No updated_at field: `shopify theme list --json` returns only
 * {id, name, processing, createdAtRuntime, role} (verified against the
 * installed @shopify/cli's own theme-object formatter); createdAtRuntime is
 * a boolean session flag, not a timestamp, so there is no real "last
 * updated" data this pipeline can honestly show here.
 * @param {{liveThemeName?: string, liveThemeId: string}} o
 * @returns {string}
 */
export function formatLiveThemeRow({ liveThemeName, liveThemeId }) {
  const name = liveThemeName ? `\`${escapeCell(liveThemeName)}\`` : 'unknown';
  return `${name} (ID \`${escapeCell(liveThemeId)}\`)`;
}

/**
 * Render the "Last live deploy (this pipeline)" row for the docs-only deploy
 * report, sourced from the refs/deploy-markers/live marker.
 * @param {{lastDeploySha?: string, lastDeployMsg?: string, lastDeployDate?: string}} o
 * @returns {string}
 */
export function formatLastDeployRow({ lastDeploySha, lastDeployMsg, lastDeployDate }) {
  if (!lastDeploySha) return '_no marker found_';
  const msg = lastDeployMsg ? escapeCell(lastDeployMsg) : 'no commit message';
  const date = lastDeployDate ? escapeCell(lastDeployDate) : 'unknown date';
  return `\`${escapeCell(lastDeploySha)}\`: ${msg} (${date})`;
}
