// Tier A4: the existing tools, run as-is. Pure planning and classification; tools.mjs spawns.
//
// One rule from the plan: each non-zero exit is ONE finding named after the tool with its stdout
// attached as evidence (truncated by makeFinding), never parsed. A tool that cannot run (missing
// env, missing flag, worktree path for theme check) is SKIPPED with the reason, never PASS.

import { makeFinding, skipFinding } from './finding.mjs';

/** The public live theme id (README "Branches and themes"); overridable by LIVE_THEME_ID. */
export const DEFAULT_LIVE_THEME_ID = '181702754604';
export const DEFAULT_BASE_URL = 'https://sapphireshadowstudio.com';

/**
 * Env allow-list for spawned tools. Nothing else from the parent env crosses over, so a
 * GITHUB_* or INPUT_* variable can never make the smoke dry-run think it is the post-deploy path.
 */
export const ENV_PASS_THROUGH = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'NODE_OPTIONS', 'SHELL', 'USER', 'LOGNAME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME'];

/**
 * Build the clean env for a tool from the parent env and the named extras.
 * @param {Record<string,string|undefined>} parentEnv
 * @param {Record<string,string|undefined>} extras
 */
export function cleanEnv(parentEnv, extras = {}) {
  const out = {};
  for (const k of ENV_PASS_THROUGH) if (parentEnv[k] !== undefined) out[k] = parentEnv[k];
  for (const [k, v] of Object.entries(extras)) if (v !== undefined && v !== '') out[k] = v;
  for (const k of Object.keys(out)) if (/^(GITHUB_|INPUT_)/.test(k)) delete out[k];
  return out;
}

/**
 * Plan the A4 tool runs.
 * @param {object} o
 * @param {boolean} o.hasStorePw       STORE_PW / STOREFRONT_PASSWORD present (by name)
 * @param {boolean} o.isWorktree       cwd is under a .claude/worktrees/ path (theme check noise)
 * @param {string}  [o.primaryRoot]    the primary checkout path, when known and different
 * @param {string}  [o.liveThemeId]
 * @param {string}  [o.baseUrl]
 * @param {boolean} [o.lockedStore]    true when the store is LOCKED (dry-run needs the password)
 * @returns {Array<{check:string, subject:string, label:string, argv?:string[], cwd?:string, env?:object, skip?:string}>}
 */
export function planTools({
  hasStorePw, isWorktree, primaryRoot = null, liveThemeId = DEFAULT_LIVE_THEME_ID,
  baseUrl = DEFAULT_BASE_URL, lockedStore = true,
}) {
  const plan = [];
  plan.push({
    check: 'tool-seo-surface', subject: 'seo-review-surface', label: 'seo-review surface (anonymous)',
    argv: ['node', 'scripts/seo-review/surface.mjs', '--no-save'],
  });
  if (lockedStore && !hasStorePw) {
    plan.push({ check: 'tool-seo-crawl', subject: 'seo-review-crawl', label: 'seo-review crawl', skip: 'store is LOCKED and no STORE_PW / STOREFRONT_PASSWORD is set' });
  } else {
    plan.push({
      check: 'tool-seo-crawl', subject: 'seo-review-crawl', label: 'seo-review crawl',
      argv: ['node', 'scripts/seo-review/crawl.mjs', '--no-save'],
      env: { STORE_PW: '<from env>' },
    });
  }
  if (lockedStore && !hasStorePw) {
    plan.push({ check: 'tool-smoke-dry-run', subject: 'smoke-dry-run', label: 'smoke.mjs --dry-run (local, not the post-deploy path)', skip: 'store is LOCKED and no STORE_PW / STOREFRONT_PASSWORD is set' });
  } else {
    plan.push({
      check: 'tool-smoke-dry-run', subject: 'smoke-dry-run', label: 'smoke.mjs --dry-run (local, not the post-deploy path)',
      argv: ['node', '.github/actions/shopify-theme-push/smoke.mjs', '--dry-run'],
      env: { SMOKE_BASE_URL: baseUrl, LIVE_THEME_ID: liveThemeId, STOREFRONT_PASSWORD: '<from env>' },
    });
  }
  plan.push({
    check: 'tool-contrast-lint', subject: 'contrast-lint', label: 'npm run contrast:lint',
    argv: ['npm', 'run', '--silent', 'contrast:lint'],
  });
  if (isWorktree && !primaryRoot) {
    plan.push({ check: 'tool-theme-check', subject: 'theme-check', label: 'shopify theme check', skip: 'running from a worktree, where .theme-check.yml ignores do not apply; pass --primary-root <path>' });
  } else {
    plan.push({
      check: 'tool-theme-check', subject: 'theme-check', label: 'shopify theme check',
      argv: ['npx', 'shopify', 'theme', 'check'],
      cwd: primaryRoot || undefined,
    });
  }
  return plan;
}

/**
 * One finding per tool: SKIPPED with the reason, ERROR on non-zero exit (stdout tail as
 * evidence), INFO on success so the report lists the tool as run.
 */
export function classifyToolResult({ check, subject, label, skip, exitCode, stdout = '', stderr = '' }) {
  if (skip) return skipFinding(check, subject, `${label}: skipped, ${skip}`);
  if (exitCode === 0) {
    return makeFinding({ check, subject, severity: 'INFO', message: `${label}: exit 0`, evidence: tail(stdout) });
  }
  const code = exitCode === null || exitCode === undefined ? 'no exit code (signal or spawn failure)' : `exit ${exitCode}`;
  // A tool that could not get past the edge (throttled, or the password form bounced under a
  // 429) has not judged anything: that is inconclusive, never a defect in the site.
  if (INCONCLUSIVE_RE.test(`${stdout}\n${stderr}`)) {
    return makeFinding({ check, subject, severity: 'GATE', message: `${label}: ${code}, inconclusive (edge throttle or password gate)`, evidence: tail(stdout || stderr) });
  }
  return makeFinding({ check, subject, message: `${label}: ${code}`, evidence: tail(stdout || stderr) });
}

/** Output shapes that mean the tool never reached content: throttling or the password gate. */
export const INCONCLUSIVE_RE = /password auth failed|storefront password (rejected|throttled)|\b429\b|throttled/i;

/** Last ~200 chars of a tool's output, so the evidence shows the summary line, not the banner. */
export function tail(text, n = 200) {
  const s = String(text || '').trim();
  return s.length > n ? s.slice(s.length - n) : s;
}
