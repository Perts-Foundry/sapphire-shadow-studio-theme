#!/usr/bin/env node
// Offline, CI-safe consistency check over marketing/policies/.
//
// WHAT A GREEN CHECK PROVES: the repo is self-consistent. Every tracked policy has a file, every
// file has a manifest entry, each file is in canonical form, its sha256 and length match, its
// heading list (the anchor contract) matches, and the hygiene rules hold.
//
// WHAT IT DOES NOT PROVE: that Admin holds these bytes. Nothing here touches the network, by
// design; only `npm run policies:pull -- --check` answers that question. The CI report row says
// "repo consistency" for exactly this reason, so a green required check is never read as
// "policies are in sync".
//
//   node scripts/policies/check.mjs              check and report
//   node scripts/policies/check.mjs --root <dir> operate on another checkout (tests)
//
// marketing/policies/README.md documents the surface.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  POLICY_TYPES,
  WRITABLE,
  STOREFRONT_HANDLES,
  NON_POLICY_FILES,
  NOT_WRITABLE_REASON,
  bodyFromFileText,
  diffEntry,
  duplicateHeadingIds,
  extractHeadings,
  fileNameForType,
  hygieneProblems,
  keyForType,
  sha256,
  typeForFileName,
} from './lib/policies.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const OK_MARKER = 'policies:check ok';

export function paths(root) {
  const dir = join(root, 'marketing', 'policies');
  return {
    dir,
    manifest: join(dir, 'manifest.json'),
    file: (type) => join(dir, fileNameForType(type)),
  };
}

export function readManifest(root) {
  const p = paths(root);
  const manifest = JSON.parse(readFileSync(p.manifest, 'utf8'));
  if (!manifest.policies || typeof manifest.policies !== 'object') {
    throw new Error('manifest.json: missing "policies" object');
  }
  return manifest;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Side-effect-free. Reads the manifest and the files under marketing/policies/, touches nothing,
 * and never reaches the network. Shared by check and by pull (which uses `bodies` to decide what
 * moved).
 *
 * Returns:
 *   bodies      Map<type, string>   the canonical body each file holds
 *   computed    Map<type, object>   the entry fields recomputed from the file
 *   problems    string[]            refusals of the inputs (a missing file, a bad manifest)
 *   mismatches  string[]            a file and its manifest entry disagreeing
 *   notes       string[]            advisory, never a failure
 *   manifest    object              the parsed committed manifest, unmodified
 */
export function plan(root = REPO_ROOT) {
  const p = paths(root);
  const problems = [];
  const mismatches = [];
  const notes = [];
  const bodies = new Map();
  const computed = new Map();
  const manifest = readManifest(root);

  // The two lists that must agree with each other before anything else is worth checking.
  for (const type of POLICY_TYPES) {
    if (!(type in WRITABLE)) problems.push(`${type}: has no WRITABLE entry in lib/policies.mjs`);
    if (!(type in STOREFRONT_HANDLES)) problems.push(`${type}: has no STOREFRONT_HANDLES entry in lib/policies.mjs`);
  }

  const keys = Object.keys(manifest.policies).sort();
  const expectedKeys = POLICY_TYPES.map(keyForType).sort();
  for (const key of expectedKeys) {
    if (!keys.includes(key)) problems.push(`${key}: tracked in POLICY_TYPES but has no manifest entry`);
  }
  for (const key of keys) {
    if (!expectedKeys.includes(key)) problems.push(`${key}: manifest entry names no tracked ShopPolicyType`);
  }

  // Every .html file present must be a tracked policy, and every tracked policy must have a file.
  // README.md and manifest.json are excluded by name: without that, adding a second doc file here
  // would turn CI red for no reason.
  const present = existsSync(p.dir) ? readdirSync(p.dir).sort() : [];
  for (const name of present) {
    if (NON_POLICY_FILES.includes(name)) continue;
    if (typeForFileName(name) === null) {
      problems.push(`${name}: unexpected file under marketing/policies/ (not a tracked policy, README.md or manifest.json)`);
    }
  }

  for (const type of POLICY_TYPES) {
    const key = keyForType(type);
    const file = p.file(type);
    if (!existsSync(file)) {
      problems.push(`${key}: ${fileNameForType(type)} is missing; run npm run policies:pull`);
      continue;
    }
    const text = readFileSync(file, 'utf8');
    const body = bodyFromFileText(text);
    bodies.set(type, body);

    // The file must already be in canonical form. Comparing the round trip rather than testing
    // for CR/BOM separately keeps one definition of "canonical" and catches trailing whitespace
    // and a missing final newline in the same breath.
    if (text !== `${body}\n`) {
      problems.push(
        `${key}: ${fileNameForType(type)} is not in canonical form (BOM, CRLF, trailing whitespace, ` +
          'or a missing final newline); re-run npm run policies:pull',
      );
    }

    const hygiene = hygieneProblems(body);
    if (hygiene.length) {
      // Refusals are scoped to writable entries. If Shopify rewrites the auto-managed privacy body
      // to contain an em dash, CI must warn rather than go permanently red on something unfixable.
      const target = WRITABLE[type] ? problems : notes;
      for (const h of hygiene) target.push(`${key}: ${fileNameForType(type)} ${h}`);
    }

    const headings = extractHeadings(body);
    const dupes = duplicateHeadingIds(headings);
    if (dupes.length) {
      problems.push(
        `${key}: two h2 headings slugify to the same id (${dupes.join(', ')}); assets/policy-nav.js would ` +
          'silently suffix one with "-2", and which one depends on document order. Reword one heading.',
      );
    }

    computed.set(type, {
      handle: STOREFRONT_HANDLES[type],
      writable: WRITABLE[type],
      sha256: sha256(body),
      length: body.length,
      headings,
    });
  }

  for (const type of POLICY_TYPES) {
    const key = keyForType(type);
    const entry = manifest.policies[key];
    if (!entry || !computed.has(type)) continue;

    // `title` comes from Admin and this check is offline, so it cannot be recomputed. Assert only
    // that it is a non-empty string; pull is what keeps it current.
    if (typeof entry.title !== 'string' || entry.title.trim() === '') {
      mismatches.push(`${key}: title must be a non-empty string from Admin`);
    }
    mismatches.push(...diffEntry(key, entry, computed.get(type)));

    if (entry.writable === false) {
      if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
        mismatches.push(`${key}: writable is false but no "reason" says why; expected ${JSON.stringify(NOT_WRITABLE_REASON)}`);
      }
    } else if ('reason' in entry) {
      mismatches.push(`${key}: "reason" belongs only on an entry with writable: false`);
    }

    const remote = entry.remote;
    if (!remote || typeof remote !== 'object') {
      mismatches.push(`${key}: no "remote" token; run npm run policies:pull`);
    } else {
      if (typeof remote.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(remote.sha256)) {
        mismatches.push(`${key}: remote.sha256 is not a sha256 digest`);
      }
      if (!Number.isInteger(remote.length) || remote.length < 0) {
        mismatches.push(`${key}: remote.length is not a non-negative integer`);
      }
      if (typeof remote.observedAt !== 'string' || !ISO_RE.test(remote.observedAt)) {
        mismatches.push(`${key}: remote.observedAt is not an ISO-8601 UTC timestamp`);
      }
    }
    if (typeof entry.pulledAt !== 'string' || !ISO_RE.test(entry.pulledAt)) {
      mismatches.push(`${key}: pulledAt is not an ISO-8601 UTC timestamp`);
    }

    // Not a mismatch: the repo legitimately holds an edit Admin has not received yet. Say so once,
    // so a reviewer knows a push is outstanding rather than reading silence as "in sync".
    if (remote && typeof remote.sha256 === 'string' && remote.sha256 !== entry.sha256) {
      notes.push(
        `${key}: the repo body differs from the last observed Admin body; a push is outstanding ` +
          `(npm run policies:push -- --type ${key})`,
      );
    }
  }

  return { bodies, computed, problems, mismatches, notes, manifest };
}

export function check(root = REPO_ROOT) {
  const { problems, mismatches, notes } = plan(root);
  return { problems, mismatches, notes };
}

function main(argv) {
  const args = argv.slice(2);
  const rootFlag = args.indexOf('--root');
  const root = rootFlag !== -1 ? resolve(args[rootFlag + 1]) : REPO_ROOT;
  let result;
  try {
    result = check(root);
  } catch (err) {
    console.error(`error: ${err.message}`);
    console.error('policies:check failed: marketing/policies/ could not be read');
    return 1;
  }
  const { problems, mismatches, notes } = result;
  for (const n of notes) console.log(`note: ${n}`);
  // Problem summaries print last on the failure path: CI keeps the tail of the output, and a long
  // heading diff at the top would be scrolled off by npm's own epilogue.
  for (const m of problems) console.error(`error: ${m}`);
  for (const m of mismatches) console.error(`error: ${m}`);
  if (problems.length || mismatches.length) {
    console.error(
      `policies:check failed: ${problems.length} problem(s), ${mismatches.length} mismatch(es). ` +
        'Fix: re-run npm run policies:pull, or correct the manifest by hand if the body is the intended change.',
    );
    return 1;
  }
  console.log(OK_MARKER);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
