#!/usr/bin/env node
//
// tools.mjs -- Tier A4: run the existing tools and turn each exit into one finding.
//
// Runs seo-review surface + crawl (--no-save), the smoke dry-run (local, never the post-deploy
// path: the spawned env is an allow-list, so no GITHUB_* or INPUT_* variable crosses over),
// contrast:lint, and shopify theme check (from the primary checkout when this is a worktree).
// Each non-zero exit is one ERROR named after the tool with its output tail as evidence; a tool
// that cannot run is SKIPPED with the reason.
//
// SECURITY (public repo): the storefront password is passed to the two tools that need it by
// name from this process's env and never printed; every log line goes through the redactor.
//
// USAGE: node --env-file=.env scripts/site-check/tools.mjs [--no-save] [--strict] [--json]
//        [--public] [--primary-root <path>] [--skip <check-id>]...

import { spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { planTools, classifyToolResult, cleanEnv, DEFAULT_LIVE_THEME_ID, DEFAULT_BASE_URL } from './lib/tools.mjs';
import { createRedactor } from './lib/redact.mjs';
import { createStore, diffFindings, partitionAccepted, exitCodeFor } from './lib/state.mjs';
import { sortFindings } from './lib/finding.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

function arg(flag) { return process.argv.includes(flag); }
function argValue(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
function argValues(flag) {
  const out = [];
  process.argv.forEach((a, i) => { if (a === flag && process.argv[i + 1]) out.push(process.argv[i + 1]); });
  return out;
}

if (arg('--help')) {
  process.stdout.write('usage: node --env-file=.env scripts/site-check/tools.mjs [--no-save] [--strict] [--json] [--public] [--primary-root <path>] [--skip <check-id>]...\n');
  process.exit(0);
}

const password = process.env.STORE_PW || process.env.STOREFRONT_PASSWORD || '';
const redact = createRedactor([password]);
const log = (l) => process.stdout.write(redact(l) + '\n');

const lockState = arg('--public') ? 'PUBLIC' : 'LOCKED';
const isWorktree = /[\\/]\.claude[\\/]worktrees[\\/]/.test(REPO_ROOT);
const primaryRoot = argValue('--primary-root', null);
const skips = new Set(argValues('--skip'));

const plan = planTools({
  hasStorePw: Boolean(password),
  isWorktree,
  primaryRoot: primaryRoot ? resolve(primaryRoot) : null,
  liveThemeId: process.env.LIVE_THEME_ID || DEFAULT_LIVE_THEME_ID,
  baseUrl: (process.env.BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
  lockedStore: lockState === 'LOCKED',
});

const findings = [];
for (const step of plan) {
  if (skips.has(step.check)) {
    findings.push(classifyToolResult({ ...step, skip: 'skipped by --skip' }));
    log(`- ${step.label}: skipped (--skip)`);
    continue;
  }
  if (step.skip) {
    findings.push(classifyToolResult(step));
    log(`- ${step.label}: skipped (${step.skip})`);
    continue;
  }
  // Fill the password placeholders from THIS process's env, by name; never from argv.
  const extras = {};
  for (const [k, v] of Object.entries(step.env || {})) extras[k] = v === '<from env>' ? password : v;
  const env = cleanEnv(process.env, extras);
  log(`- ${step.label} ...`);
  const res = spawnSync(step.argv[0], step.argv.slice(1), {
    cwd: step.cwd || REPO_ROOT, env, encoding: 'utf8', timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
  });
  const exitCode = res.status;
  findings.push(classifyToolResult({ ...step, exitCode, stdout: res.stdout, stderr: res.stderr }));
  log(`  exit ${exitCode === null ? 'null' : exitCode}`);
  if (exitCode !== 0) {
    const out = redact((res.stdout || '') + (res.stderr || ''));
    log(out.split('\n').slice(-30).map((l) => `    ${l}`).join('\n'));
  }
}

const accepted = (() => {
  try { return JSON.parse(readFileSync(join(HERE, 'accepted-risks.json'), 'utf8')); } catch { return []; }
})();
const { fresh, accepted: acceptedOut } = partitionAccepted(findings, accepted);
const io = {
  readdir: (d) => readdir(d),
  readFile: (p) => readFile(p, 'utf8'),
  writeFile: (p, t) => writeFile(p, t),
  mkdir: (d) => mkdir(d, { recursive: true }),
};
const store = createStore({ io, dir: process.env.SITE_CHECK_STATE_DIR || join(homedir(), '.local', 'state', 'site-check') });
const previous = await store.loadLatest('tools', lockState);
const { added, resolved, unchanged, skipped } = diffFindings(previous ? previous.findings : null, fresh);

log('');
log(`== site-check tools (${lockState}): ${fresh.length} finding(s), ${acceptedOut.length} accepted risk(s) ==`);
if (previous) log(`baseline: ${previous.generated} (${added.length} new, ${resolved.length} resolved, ${skipped.length} skipped, ${unchanged.length} unchanged)`);
else log('baseline: none (first run; all findings are new)');
const printList = (label, list) => {
  if (!list.length) return;
  log(`\n${label}:`);
  for (const f of sortFindings(list)) log(`  [${f.severity}] ${f.id}\n      ${f.message}${f.evidence ? `\n      evidence: ${f.evidence}` : ''}`);
};
printList('NEW since baseline', added);
printList('RESOLVED since baseline', resolved);
printList('SKIPPED this run (not resolved)', skipped);
printList('UNCHANGED', unchanged);
if (!arg('--no-save')) log(`\nsaved run -> ${await store.save('tools', lockState, fresh, { lockState, plan: plan.map((p) => p.check) })}`);
const code = exitCodeFor({ fresh, added, hasBaseline: Boolean(previous), strict: arg('--strict') });
log(`exit ${code}`);
if (arg('--json')) process.stdout.write(redact(JSON.stringify(sortFindings(findings), null, 2)) + '\n');
process.exit(code);
