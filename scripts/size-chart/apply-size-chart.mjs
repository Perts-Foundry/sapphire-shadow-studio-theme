#!/usr/bin/env node
// Insert/update the on-page "Size Chart" accordion row in one or more product templates from a
// profile, on the current feature branch. Byte-stable and idempotent (see lib/template-writer.mjs).
//
// Guards against the two-writer sync hazard: the Shopify Admin customizer also writes these
// templates (auto-commits to shopify-sync). Before touching a file, this refuses if shopify-sync
// carries an in-flight edit to it that has not been reconciled to main, so a hand-off edit is not
// silently clobbered. It never commits, pushes, or opens a PR; that stays the operator's step.

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertSizeChart } from './lib/template-writer.mjs';
import { classifyInFlight } from './lib/sync-guard.mjs';
import { loadProfile } from './lib/profile-io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

function parseArgs(argv) {
  const opts = { profile: null, handles: [], guard: true };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith('--')) continue;
    a = a.slice(2);
    let val;
    const eq = a.indexOf('=');
    if (eq !== -1) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    if (a === 'no-guard') { opts.guard = false; continue; }
    if (a === 'profile') { opts.profile = val ?? argv[++i]; continue; }
    if (a === 'handle') { opts.handles.push(val ?? argv[++i]); continue; }
    throw new Error(`Unknown option --${a}`);
  }
  if (!opts.profile) throw new Error('Missing --profile <blank_id | path-to-profile.json>');
  return opts;
}

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function refExists(ref) {
  try { git(['rev-parse', '--verify', '--quiet', ref]); return true; } catch { return false; }
}

// Refuse if shopify-sync has diverged from main for this file (an in-flight Admin edit not yet
// reconciled). Returns true if safe to proceed. Decision logic lives in lib/sync-guard.mjs.
function guardInFlight(relPath) {
  try { git(['fetch', 'origin', '--quiet']); } catch (e) { console.warn(`WARN: git fetch failed (${e.message}); proceeding without a fresh in-flight check.`); }
  const refsPresent = refExists('origin/shopify-sync') && refExists('origin/main');
  const divergedPaths = refsPresent
    ? git(['diff', '--name-only', 'origin/main', 'origin/shopify-sync', '--', relPath])
    : '';
  const decision = classifyInFlight({ refsPresent, divergedPaths });
  if (decision.reason === 'refs-missing') {
    console.warn('WARN: origin/shopify-sync or origin/main not found; skipping in-flight-edit guard.');
  }
  if (decision.action === 'block') {
    console.error(`BLOCKED: ${relPath} has an in-flight edit on shopify-sync not yet reconciled to main.`);
    console.error('  Reconcile first, then re-run:  git fetch origin && git merge origin/shopify-sync');
    return false;
  }
  return true;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const profile = await loadProfile(opts.profile);

  const handles = opts.handles.length ? opts.handles : (profile.handles || []);
  if (handles.length === 0) {
    // Near-unreachable post-materialise: loadProfile derives `handles` from the products on the
    // profile's `body`, and a body with no product refuses earlier. A committed "handles" array is
    // itself refused, so never advise adding one.
    throw new Error(
      'No handles to apply to. Pass --handle <h>, or check that catalogue.json declares products ' +
        'on this profile\'s "body" (the template list is derived from them).'
    );
  }

  let anyChanged = false;
  let blocked = false;
  for (const handle of handles) {
    const rel = path.join('templates', `product.${handle}.json`);
    const abs = path.join(REPO_ROOT, rel);
    if (!existsSync(abs)) { console.error(`SKIP ${handle}: ${rel} does not exist`); continue; }

    if (opts.guard && !guardInFlight(rel)) { blocked = true; continue; }

    const { changed } = await upsertSizeChart({ templatePath: abs, profile });
    anyChanged = anyChanged || changed;
    console.log(`${changed ? 'updated' : 'unchanged'}  ${rel}`);
  }

  if (anyChanged) {
    console.log('\nDiff summary:');
    console.log(git(['diff', '--stat', '--', 'templates']));
    console.log('\nReview the diff, run "npx shopify theme check", then open a PR and comment "deploy".');
  } else {
    console.log('\nNo changes; templates already up to date.');
  }
  if (blocked) process.exitCode = 1;
}

main().catch((e) => { console.error(`Fatal: ${e.message}`); process.exitCode = 1; });
