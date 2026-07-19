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
  for (const line of lines) {
    const m = line.match(ROW_RE);
    if (m) {
      const [, path, verdict, status, host, themeId, reason] = m;
      rows.push({ path, verdict, status, host, themeId, reason });
    } else {
      notes.push(line);
    }
  }

  const counts = { PASS: 0, 'SOFT-WARN': 0, 'HARD-FAIL': 0 };
  for (const r of rows) counts[r.verdict] += 1;
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
 * @param {{liveThemeName?: string, liveThemeId: string, liveThemeUpdatedAt?: string}} o
 * @returns {string}
 */
export function formatLiveThemeRow({ liveThemeName, liveThemeId, liveThemeUpdatedAt }) {
  const name = liveThemeName ? `\`${escapeCell(liveThemeName)}\`` : 'unknown';
  const updated = liveThemeUpdatedAt ? escapeCell(liveThemeUpdatedAt) : 'unknown';
  return `${name} (ID \`${escapeCell(liveThemeId)}\`), last updated \`${updated}\``;
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
