#!/usr/bin/env node
// Sync the product-page dropdown to the registry: derive the numbered pattern lines and upsert
// them into the applique block's pattern_options, byte-stably and idempotently, on the current
// feature branch. Same two-writer guard as apply-size-chart.mjs: the Admin customizer also writes
// this template (auto-commits to shopify-sync), so an unreconciled in-flight edit blocks the
// write unless --no-guard.
//
// It never commits, pushes, or opens a PR; that stays the operator's step. The PR that carries
// this diff must also carry patterns.json (the cohesion test enforces it), so committed dropdown
// and committed registry converge at merge.

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyInFlight } from '../size-chart/lib/sync-guard.mjs';
import { load as loadRegistry, activePatterns, dropdownText, REGISTRY_PATH } from './lib/registry.mjs';
import { upsertPatternOptions } from './lib/options-writer.mjs';
import { buildChartAlt } from './lib/naming.mjs';
import { balancedPages } from './lib/layout.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

function parseArgs(argv) {
  const opts = { dryRun: false, guard: true };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith('--')) continue;
    a = a.slice(2);
    if (a === 'dry-run') { opts.dryRun = true; continue; }
    if (a === 'no-guard') { opts.guard = false; continue; }
    throw new Error(`Unknown option --${a}`);
  }
  return opts;
}

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function refExists(ref) {
  try { git(['rev-parse', '--verify', '--quiet', ref]); return true; } catch { return false; }
}

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

// The registry-derived alt strings need no image artifacts (names + numbering only), so this
// staleness warning works on a fresh clone with no product-images/ output at all.
function publishStalenessWarning(registry) {
  const actives = activePatterns(registry);
  const cap = registry.chart.columns * registry.chart.rows;
  const sizes = balancedPages(actives.length, cap);
  const expectedAlts = [];
  let cursor = 0;
  sizes.forEach((size, i) => {
    const slice = actives.slice(cursor, cursor + size);
    cursor += size;
    expectedAlts.push(buildChartAlt({
      page: i + 1,
      pages: sizes.length,
      first: slice[0].number,
      last: slice[slice.length - 1].number,
      names: slice.map((p) => p.name),
    }));
  });
  const publishedAlts = registry.published.slice().sort((a, b) => a.page - b.page).map((e) => e.alt);
  if (!publishedAlts.length && actives.length) {
    return 'no published charts are recorded for this registry; publish before (additions) or after (discontinuations) deploying, per the run-type ordering';
  }
  if (expectedAlts.join('\n') !== publishedAlts.join('\n')) {
    return 'the recorded published charts do not match this registry state; the dropdown and the live chart images will disagree until publish.mjs runs';
  }
  return null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const registry = await loadRegistry(REGISTRY_PATH);
  const text = dropdownText(registry); // empty registry -> defined empty string, still byte-stable

  const rel = path.join('templates', `product.${registry.product.handle}.json`);
  const abs = path.join(REPO_ROOT, rel);
  if (!existsSync(abs)) throw new Error(`${rel} does not exist`);

  console.log(`Derived pattern_options (${text.length} chars):`);
  console.log(text.length ? text.split('\n').map((l) => `  ${l}`).join('\n') : '  (empty: no active patterns)');

  const warning = publishStalenessWarning(registry);
  if (warning) console.warn(`\nWARN: ${warning}`);

  if (opts.guard && !guardInFlight(rel)) { process.exitCode = 1; return; }

  const raw = await readFile(abs, 'utf8');
  const { next, changed } = upsertPatternOptions(raw, text);

  if (!changed) {
    console.log(`\nunchanged  ${rel} (already carries exactly this text)`);
    return;
  }
  if (opts.dryRun) {
    console.log(`\nDRY RUN: would update ${rel}; no write performed.`);
    return;
  }
  await writeFile(abs, next);
  console.log(`\nupdated  ${rel}`);
  console.log('\nDiff summary:');
  console.log(git(['diff', '--stat', '--', 'templates']));
  console.log('\nNext: review the diff, run "npx shopify theme check" and validate_theme_codeblocks, then commit patterns.json together with this template change in the same PR.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`Fatal: ${e.message}`); process.exitCode = 1; });
}
