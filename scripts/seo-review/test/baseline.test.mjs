import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the state dir at a temp dir BEFORE importing the module under test,
// so no test run ever touches ~/.local/state/seo-review.
const dir = mkdtempSync(join(tmpdir(), 'seo-review-test-'));
process.env.SEO_REVIEW_STATE_DIR = dir;
const { stateDir, saveRun, loadLatest } = await import('../lib/baseline.mjs');

test('stateDir honours the env override', () => {
  assert.equal(stateDir(), dir);
});

test('saveRun then loadLatest round-trips findings', async () => {
  const findings = [{ check: 'h1-count', severity: 'ERROR', url: 'https://example.com/', detail: '0 h1' }];
  const path = saveRun('crawl', findings, { probed: 1 });
  assert.ok(path.startsWith(dir));
  const latest = loadLatest('crawl');
  assert.ok(latest);
  assert.deepEqual(latest.findings, findings);
});

test('loadLatest returns the newest run and isolates modes', async () => {
  // Timestamps are second-resolution in the filename; force distinct names.
  await new Promise((r) => setTimeout(r, 5));
  saveRun('crawl', [{ check: 'newer', severity: 'WARN', url: 'u', detail: 'd' }], {});
  assert.equal(loadLatest('crawl').findings[0].check, 'newer');
  assert.equal(loadLatest('surface'), null);
});

test('cleanup', () => {
  rmSync(dir, { recursive: true, force: true });
});
