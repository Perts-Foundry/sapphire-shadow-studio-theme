// baseline.mjs -- findings history in a state dir OUTSIDE the repo.
//
// WHY outside: run artifacts hold crawled storefront metadata and finding text;
// none of it belongs in a public repo's history, and the blank-inventory tool
// set the precedent (~/.local/state/<tool>/). Override with SEO_REVIEW_STATE_DIR.

import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function stateDir() {
  return process.env.SEO_REVIEW_STATE_DIR || join(homedir(), '.local', 'state', 'seo-review');
}

/**
 * Persist a run's findings. One JSON file per run: <mode>-<timestamp>.json.
 * @param {string} mode  crawl | surface | admin
 * @param {Array} findings
 * @param {object} meta  small run metadata (url counts, host); no secrets ever
 * @returns {string} path written
 */
export function saveRun(mode, findings, meta = {}) {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `${mode}-${stamp}.json`);
  writeFileSync(path, JSON.stringify({ mode, generated: new Date().toISOString(), meta, findings }, null, 2));
  return path;
}

/**
 * Latest saved run for a mode, or null when none exists.
 * @returns {{path: string, findings: Array, generated: string}|null}
 */
export function loadLatest(mode) {
  let entries;
  try { entries = readdirSync(stateDir()); } catch { return null; }
  const runs = entries.filter((e) => e.startsWith(`${mode}-`) && e.endsWith('.json')).sort();
  if (runs.length === 0) return null;
  const path = join(stateDir(), runs[runs.length - 1]);
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return { path, findings: data.findings || [], generated: data.generated };
  } catch {
    return null;
  }
}
