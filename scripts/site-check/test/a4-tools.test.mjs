import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFetchGuard } from './harness.mjs';
installFetchGuard();

import { planTools, classifyToolResult, cleanEnv, tail } from '../lib/tools.mjs';

test('cleanEnv passes only the allow-list plus named extras and never GITHUB_* / INPUT_*', () => {
  const env = cleanEnv(
    { PATH: '/bin', HOME: '/h', GITHUB_ACTIONS: 'true', INPUT_FOO: 'x', SHOPIFY_CLIENT_SECRET: 's', RANDOM: '1' },
    { STOREFRONT_PASSWORD: 'pw', GITHUB_TOKEN: 'nope', EMPTY: '' },
  );
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', STOREFRONT_PASSWORD: 'pw' });
});

test('planTools skips the password-dependent tools while LOCKED without a password', () => {
  const plan = planTools({ hasStorePw: false, isWorktree: false, lockedStore: true });
  const byCheck = Object.fromEntries(plan.map((p) => [p.check, p]));
  assert.ok(byCheck['tool-seo-crawl'].skip);
  assert.ok(byCheck['tool-smoke-dry-run'].skip);
  assert.ok(!byCheck['tool-seo-surface'].skip);
  assert.ok(!byCheck['tool-theme-check'].skip);
  assert.deepEqual(byCheck['tool-seo-surface'].argv, ['node', 'scripts/seo-review/surface.mjs', '--no-save']);
});

test('planTools runs everything when PUBLIC, and the smoke dry-run never carries GITHUB_* env', () => {
  const plan = planTools({ hasStorePw: false, isWorktree: false, lockedStore: false, liveThemeId: '123', baseUrl: 'https://example.test' });
  const smoke = plan.find((p) => p.check === 'tool-smoke-dry-run');
  assert.ok(!smoke.skip);
  assert.ok(smoke.argv.includes('--dry-run'));
  assert.equal(smoke.env.SMOKE_BASE_URL, 'https://example.test');
  assert.equal(smoke.env.LIVE_THEME_ID, '123');
  assert.ok(!Object.keys(smoke.env).some((k) => /^(GITHUB_|INPUT_)/.test(k)));
});

test('planTools skips theme check from a worktree unless a primary root is given', () => {
  assert.ok(planTools({ hasStorePw: true, isWorktree: true }).find((p) => p.check === 'tool-theme-check').skip);
  const withRoot = planTools({ hasStorePw: true, isWorktree: true, primaryRoot: '/repo' }).find((p) => p.check === 'tool-theme-check');
  assert.equal(withRoot.skip, undefined);
  assert.equal(withRoot.cwd, '/repo');
});

test('classifyToolResult: skip -> SKIPPED, 0 -> INFO, non-zero -> ERROR with output tail, null -> ERROR', () => {
  const base = { check: 'tool-contrast-lint', subject: 'contrast-lint', label: 'contrast' };
  assert.equal(classifyToolResult({ ...base, skip: 'why' }).severity, 'SKIPPED');
  assert.equal(classifyToolResult({ ...base, exitCode: 0, stdout: 'ok' }).severity, 'INFO');
  const bad = classifyToolResult({ ...base, exitCode: 1, stdout: `${'x'.repeat(500)}FAIL summary` });
  assert.equal(bad.severity, 'ERROR');
  assert.ok(bad.evidence.endsWith('FAIL summary'));
  assert.ok(bad.evidence.length <= 200);
  assert.equal(classifyToolResult({ ...base, exitCode: null }).severity, 'ERROR');
  assert.equal(tail('abcdef', 3), 'def');
});

test('classifyToolResult: a throttled or password-gated tool run is GATE, not ERROR', () => {
  const base = { check: 'tool-seo-crawl', subject: 'seo-review-crawl', label: 'crawl' };
  assert.equal(classifyToolResult({ ...base, exitCode: 2, stdout: 'storefront password auth failed; cannot crawl content.' }).severity, 'GATE');
  assert.equal(classifyToolResult({ ...base, exitCode: 1, stderr: 'GET /x returned 429 after 3 attempts' }).severity, 'GATE');
  assert.equal(classifyToolResult({ ...base, exitCode: 1, stdout: '3 ERROR findings' }).severity, 'ERROR');
});
