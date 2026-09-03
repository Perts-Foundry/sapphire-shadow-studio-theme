#!/usr/bin/env node
// Recompute the manifest fields that are derived from the committed bodies, after a deliberate
// local wording edit.
//
// This is the counterpart to `pull`, which answers "what does Admin hold?" and would overwrite a
// local edit with the live body. `restamp` answers "I meant to change this file, make the manifest
// agree", and it touches ONLY the derived fields: sha256, length, headings. It never touches
// `remote` or `pulledAt`, so the manifest keeps saying that Admin has not received this yet, which
// is what `check` reports as an outstanding push and what push's freshness gate reads.
//
//   npm run policies:restamp                 rewrite the derived fields
//   npm run policies:restamp -- --check      report what would change, write nothing
//
// OFFLINE. No network, no credentials.
//
// Exit codes: 0 clean, 1 refused (the bodies themselves are unusable), 2 in --check mode when the
// manifest would change.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT, paths, plan, readManifest } from './check.mjs';
import {
  POLICY_TYPES,
  diffHeadings,
  extractHeadings,
  formatManifest,
  keyForType,
  sha256,
} from './lib/policies.mjs';

/**
 * Pure over the parsed manifest and the bodies on disk. Returns the manifest to write plus the
 * changes, so the caller decides whether to write.
 *
 * @param {object} manifest  the parsed committed manifest, MUTATED in place (entries are updated
 *                           by assignment so key order never churns)
 * @param {Map<string, string>} bodies  type -> canonical body
 */
export function restampManifest(manifest, bodies) {
  const changes = [];
  const anchorChanges = [];
  for (const type of POLICY_TYPES) {
    const key = keyForType(type);
    const entry = manifest.policies[key];
    const body = bodies.get(type);
    if (!entry || body === undefined) continue;

    const headings = extractHeadings(body);
    const headingDiff = diffHeadings(key, entry.headings, headings);
    if (headingDiff.length) anchorChanges.push(...headingDiff);

    const next = { sha256: sha256(body), length: body.length };
    for (const [field, value] of Object.entries(next)) {
      if (entry[field] !== value) changes.push(`${key}: ${field} ${JSON.stringify(entry[field])} -> ${JSON.stringify(value)}`);
      entry[field] = value;
    }
    if (headingDiff.length) {
      entry.headings = headings;
      changes.push(`${key}: headings updated (${headingDiff.length} change(s))`);
    }
  }
  return { manifest, changes, anchorChanges };
}

function main(argv) {
  const args = argv.slice(2);
  const checkOnly = args.includes('--check');
  const rootFlag = args.indexOf('--root');
  const root = rootFlag !== -1 ? resolve(args[rootFlag + 1]) : REPO_ROOT;
  const p = paths(root);

  // Refuse on the input problems (a missing file, a body that is not canonical, hygiene, duplicate
  // anchors) before rewriting anything. Mismatches are the whole point of running this, so they are
  // deliberately not a refusal.
  let problems;
  let bodies;
  try {
    ({ problems, bodies } = plan(root));
  } catch (err) {
    console.error(`error: ${err.message}`);
    console.error('policies:restamp failed: marketing/policies/ could not be read');
    return 1;
  }
  if (problems.length) {
    for (const m of problems) console.error(`error: ${m}`);
    console.error(`policies:restamp refused: ${problems.length} problem(s); nothing written`);
    return 1;
  }

  const manifest = readManifest(root);
  const before = readFileSync(p.manifest, 'utf8');
  const { changes, anchorChanges } = restampManifest(manifest, bodies);
  const after = formatManifest(manifest);

  if (before === after) {
    console.log('policies:restamp: manifest already matches the committed bodies');
    return 0;
  }

  for (const c of changes) console.log(c);
  if (anchorChanges.length) {
    // The loudest thing this tool can say. A reworded h2 changes its runtime id, and every
    // /policies/...#anchor link anyone has already been sent stops resolving. Silently.
    console.log('');
    console.log('ANCHOR CHANGE. Every reworded h2 changes the id assets/policy-nav.js assigns it,');
    console.log('and every shared /policies/... link to the old anchor stops resolving:');
    for (const line of anchorChanges) console.log(`  ${line}`);
    console.log('');
    console.log('Search the repo for the old anchors before committing:');
    console.log("  git grep -n 'policies/' -- templates sections snippets blocks locales marketing");
  }

  if (checkOnly) {
    console.log('policies:restamp --check: the manifest would change; nothing written');
    return 2;
  }

  const tmp = `${p.manifest}.tmp`;
  writeFileSync(tmp, after, 'utf8');
  renameSync(tmp, p.manifest);
  console.log('policies:restamp wrote manifest.json');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
