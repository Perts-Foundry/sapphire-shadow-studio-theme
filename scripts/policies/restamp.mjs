#!/usr/bin/env node
// Recompute everything derived from the committed bodies, after a deliberate local wording edit.
//
// This is the counterpart to `pull`, which answers "what does Admin hold?" and would overwrite a
// local edit with the live body. `restamp` answers "I meant to change this file, make the rest of
// the repo agree", and it touches only derived things:
//
//   - the manifest's `version`, `coreSha256`, `sha256`, `length` and `headings`
//   - the version stamp on the first line of each stamped body, so it names the new version
//
// It never touches wording, and it never reads or writes the machine-local state file: state
// records what ADMIN was last seen holding, and a local edit tells you nothing about that. A
// wording change that has been restamped and merged leaves the repo and the live store divergent
// until a separately authorized push; `policies:status` is what says so.
//
//   npm run policies:restamp                 rewrite the derived fields and the stamps
//   npm run policies:restamp -- --check      report what would change, write nothing
//
// OFFLINE. No network, no credentials.
//
// Exit codes: 0 clean, 1 refused (the bodies themselves are unusable, or a version cannot be
// derived), 2 in --check mode when something would change.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT, paths, plan, readManifest } from './check.mjs';
import {
  POLICY_TYPES,
  PolicyError,
  coreOf,
  deriveVersion,
  diffHeadings,
  extractHeadings,
  fileTextFor,
  formatManifest,
  isStamped,
  keyForType,
  sha256,
  stampVersion,
} from './lib/policies.mjs';

/**
 * Pure over the parsed manifest and the bodies on disk. Returns the manifest to write, the body
 * rewrites, and the changes, so the caller decides whether to write.
 *
 * A REFUSAL FROM `deriveVersion` MUST LEAVE THE TREE UNTOUCHED, which is why this computes
 * everything before the caller writes anything: the throw escapes before a single file is opened.
 *
 * @param {object} manifest  the parsed committed manifest, MUTATED in place (entries are updated
 *                           by assignment so key order never churns)
 * @param {Map<string, string>} bodies  type -> canonical body, stamp included
 */
export function restampManifest(manifest, bodies) {
  const changes = [];
  const anchorChanges = [];
  const bodyRewrites = new Map();
  for (const type of POLICY_TYPES) {
    const key = keyForType(type);
    const entry = manifest.policies[key];
    const body = bodies.get(type);
    if (!entry || body === undefined) continue;

    const core = coreOf(body);
    const coreHash = sha256(core);
    // No floor here. The floor lives in machine-local state, and `restamp` is offline and runs in
    // CI-shaped environments where that state legitimately does not exist. `push` enforces it at
    // the write, where the state is guaranteed present because the freshness gate already needs it.
    const version = deriveVersion(entry, coreHash);
    const written = isStamped(entry) ? stampVersion(core, key, version) : core;

    const headings = extractHeadings(core);
    const headingDiff = diffHeadings(key, entry.headings, headings);
    if (headingDiff.length) anchorChanges.push(...headingDiff);

    if (written !== body) {
      bodyRewrites.set(type, written);
      changes.push(`${key}: body restamped to v${version}`);
    }

    const next = { version, coreSha256: coreHash, sha256: sha256(written), length: written.length };
    for (const [field, value] of Object.entries(next)) {
      if (entry[field] !== value) changes.push(`${key}: ${field} ${JSON.stringify(entry[field])} -> ${JSON.stringify(value)}`);
      entry[field] = value;
    }
    if (headingDiff.length) {
      entry.headings = headings;
      changes.push(`${key}: headings updated (${headingDiff.length} change(s))`);
    }
  }
  return { manifest, changes, anchorChanges, bodyRewrites };
}

/** The CLI. Exported so the --check contract can be tested in both directions. */
export function main(argv) {
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
  let changes;
  let anchorChanges;
  let bodyRewrites;
  try {
    ({ changes, anchorChanges, bodyRewrites } = restampManifest(manifest, bodies));
  } catch (err) {
    console.error(`error: ${err instanceof PolicyError ? err.message : String(err.message ?? err)}`);
    console.error('policies:restamp refused; nothing written');
    return 1;
  }
  const after = formatManifest(manifest);

  if (before === after && bodyRewrites.size === 0) {
    console.log('policies:restamp: the manifest and the version stamps already match the committed bodies');
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
    console.log('policies:restamp --check: the manifest or a version stamp would change; nothing written');
    return 2;
  }

  for (const [type, body] of bodyRewrites) writeAtomic(p.file(type), fileTextFor(body));
  writeAtomic(p.manifest, after);
  console.log(`policies:restamp wrote manifest.json${bodyRewrites.size ? ` and ${bodyRewrites.size} body file(s)` : ''}`);
  console.log('');
  console.log('The repo now describes itself consistently. It says NOTHING about the live store:');
  console.log('a wording change reaches customers only through a separately authorized');
  console.log('npm run policies:push. Run npm run policies:status to see the difference.');
  return 0;
}

function writeAtomic(target, text) {
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, target);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
