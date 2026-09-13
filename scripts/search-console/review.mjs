#!/usr/bin/env node
//
// review.mjs -- validate a Search Console capture, run the checks, diff, save, report.
//
// WHY: Search Console is verified for the storefront and nothing in the repo read it. There is no
// API (the operator declined a Cloud project), so the search-console skill reads the reports in
// the operator's logged-in browser and Claude transcribes them into a capture JSON. This script is
// the deterministic half: it normalises and validates that capture (the schema is the guard against
// transcription slips), cross-checks it against the live sitemap, evaluates every check, diffs each
// report against its latest comparable run, and prints the record the skill's prose layers build on.
//
// SECURITY (public repo): this script never opens a browser, never writes a capture (Claude is the
// only writer of one), and never writes inside the checkout: a state dir that resolves inside the
// worktree or the primary checkout is refused with exit 2. Output carries counts, subjects and short
// details; paths are printed with $HOME collapsed to ~; validation errors name a JSON pointer and
// never echo the value. The only network traffic is an anonymous node fetch of the storefront
// sitemap and one unfollowed request per secondary domain, both skipped with --offline.
//
// USAGE:
//   node scripts/search-console/review.mjs <capture.json> [--full] [--no-save] [--json]
//        [--offline] [--sitemap-count N] [--now <iso>]
//   node scripts/search-console/review.mjs --print-state-dir
//
// EXIT: 0 no fresh ERROR (WARN, INFO and accepted ERRORs do not block); 1 a fresh ERROR, or a
// capture that is not JSON or fails the schema; 2 usage error, unreadable file, or a state dir
// inside the repo. SEARCH_CONSOLE_STATE_DIR overrides the state dir.

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normaliseCapture } from './lib/normalise.mjs';
import { validateCapture } from './lib/schema.mjs';
import { evaluateCapture, invalidFindings, PROPERTY_HOST } from './lib/checks.mjs';
import { liveSitemapUrls, probeRedirect } from './lib/sitemap.mjs';
import { stateDir, repoRoots, assertOutsideRepo, loadLatestComparable } from './lib/baseline.mjs';
import { finishRun, loadAcceptedRisks } from './lib/report.mjs';
import { displayPath } from '../lib/display-path.mjs';

const USAGE = `usage:
  node scripts/search-console/review.mjs <capture.json> [--full] [--no-save] [--json] [--offline] [--sitemap-count N] [--now <iso>]
  node scripts/search-console/review.mjs --print-state-dir`;

class UsageError extends Error {}

export function parseArgs(argv) {
  const out = { capture: null, full: false, noSave: false, json: false, offline: false, sitemapCount: null, now: null, printStateDir: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} expects a value`);
      return v;
    };
    switch (a) {
      case '--full': out.full = true; break;
      case '--no-save': out.noSave = true; break;
      case '--json': out.json = true; break;
      case '--offline': out.offline = true; break;
      case '--print-state-dir': out.printStateDir = true; break;
      case '--sitemap-count': {
        const v = value();
        if (!/^\d+$/.test(v)) throw new UsageError('--sitemap-count expects a non-negative integer');
        out.sitemapCount = Number(v);
        break;
      }
      case '--now': {
        const v = value();
        if (Number.isNaN(Date.parse(v))) throw new UsageError('--now expects an ISO 8601 timestamp');
        out.now = v;
        break;
      }
      default:
        if (a.startsWith('-')) throw new UsageError(`unknown flag ${a}`);
        if (out.capture !== null) throw new UsageError('exactly one capture file');
        out.capture = a;
    }
  }
  if (!out.printStateDir && out.capture === null) throw new UsageError('a capture file is required');
  return out;
}

/**
 * @param {string[]} argv
 * @param {object} [io]
 * @returns {Promise<number>} exit code
 */
export async function run(argv, {
  fetchImpl = globalThis.fetch, now = () => new Date(), env = process.env, stdout = process.stdout,
  stderr = process.stderr, roots = null, acceptedRisks = null, acceptedRisksFile,
} = {}) {
  const out = (line) => stdout.write(`${line}\n`);
  const err = (line) => stderr.write(`${line}\n`);

  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`search-console: ${e.message}`);
    err(USAGE);
    return 2;
  }

  const home = env.HOME?.trim() || os.homedir();
  const dir = stateDir(env);
  try {
    assertOutsideRepo(dir, roots ?? repoRoots());
  } catch (e) {
    err(`search-console: ${e.message}`);
    return 2;
  }
  if (args.printStateDir) {
    out(displayPath(dir, home));
    return 0;
  }

  const nowDate = args.now ? new Date(args.now) : new Date(now());
  const capturePath = path.resolve(args.capture);
  let text;
  try {
    text = readFileSync(capturePath, 'utf8');
  } catch {
    err(`search-console: cannot read the capture file ${displayPath(capturePath, home)}`);
    return 2;
  }

  const invalid = (errors) => {
    const findings = invalidFindings(errors);
    if (args.json) {
      out(JSON.stringify({ fresh: findings, accepted: [], added: findings, resolved: [], unchanged: [], notCompared: [], metrics: null, exitCode: 1 }));
    } else {
      out(`search-console: capture invalid, ${findings.length} error(s); nothing evaluated, nothing saved`);
      for (const f of findings) out(`  [ERROR] capture-invalid ${f.url}\n      ${f.detail}`);
    }
    return 1;
  };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid([{ path: '', message: 'the capture is not valid JSON' }]);
  }
  const { capture, errors: normaliseErrors } = normaliseCapture(parsed);
  const { errors: schemaErrors } = validateCapture(capture);
  if (normaliseErrors.length || schemaErrors.length) return invalid([...normaliseErrors, ...schemaErrors]);

  let risks = acceptedRisks;
  if (risks === null) {
    try {
      risks = loadAcceptedRisks(acceptedRisksFile);
    } catch (e) {
      err(`search-console: ${e.message}`);
      return 2;
    }
  }

  let sitemapOpts;
  if (args.sitemapCount !== null) {
    sitemapOpts = { sitemapCount: args.sitemapCount, sitemapState: 'ok' };
  } else if (args.offline) {
    sitemapOpts = { sitemapState: 'skipped' };
  } else {
    const live = await liveSitemapUrls(`https://${PROPERTY_HOST}`, { fetchImpl });
    if (live === null) sitemapOpts = { sitemapState: 'unreachable' };
    else if (live.partial) sitemapOpts = { sitemapUrls: live.urls, sitemapState: 'partial' };
    else sitemapOpts = { sitemapUrls: live.urls, sitemapState: 'ok' };
  }

  const redirectProbes = {};
  const settings = capture.reports.settings;
  if (!args.offline && settings?.status === 'ok') {
    for (const host of settings.secondary_domains ?? []) redirectProbes[host] = await probeRedirect(host, { fetchImpl });
  }

  const previousPeriod = loadLatestComparable(dir, capture.mode, 'performance')?.period ?? null;
  const findings = evaluateCapture(capture, { ...sitemapOpts, redirectProbes, previousPeriod, now: nowDate });

  return finishRun(findings, capture, {
    dir, acceptedRisks: risks, full: args.full, noSave: args.noSave, json: args.json, log: out, now: nowDate, home,
    meta: { capture: displayPath(capturePath, home), captureBasename: path.basename(capturePath), sitemapState: sitemapOpts.sitemapState },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      // Never the raw error object: its message or stack can carry a machine path or a value.
      process.stderr.write(`search-console: unexpected failure (${e?.name ?? 'Error'}); re-run with a smaller capture to isolate it\n`);
      process.exitCode = 1;
    },
  );
}
