#!/usr/bin/env node
// Offline, CI-safe consistency check over marketing/policies/.
//
// WHAT A GREEN CHECK PROVES: the repo is self-consistent. Every tracked policy has a file, every
// file has a manifest entry, each file is in canonical form, its sha256, coreSha256 and length
// match, its version stamp agrees with its manifest version, its heading list (the anchor
// contract) matches, and the hygiene rules hold.
//
// WHAT IT DOES NOT PROVE: that Admin holds these bytes. Nothing here touches the network, by
// design; only `npm run policies:pull -- --check` answers that question. The CI report row says
// "repo consistency" for exactly this reason, so a green required check is never read as
// "policies are in sync".
//
// AND IT NEVER READS THE STATE FILE. `lib/state.mjs` is machine-local, so CI has no opinion about
// it and could not have one. A test proves this by pointing POLICIES_STATE_DIR at a hostile file
// and asserting a clean run. `policies:status` is the command that reads both sides.
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
  coreOf,
  diffEntry,
  duplicateHeadingIds,
  extractHeadings,
  fileNameForType,
  hygieneProblems,
  isStamped,
  isVersionNumber,
  keyForType,
  parseVersionStamp,
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

/**
 * Side-effect-free. Reads the manifest and the files under marketing/policies/, touches nothing,
 * and never reaches the network. Shared by check and by pull (which uses `bodies` to decide what
 * moved).
 *
 * Returns:
 *   bodies      Map<type, string>   the canonical body each file holds, stamp included
 *   cores       Map<type, string>   the same body with the version stamp stripped
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
  const cores = new Map();
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

    // Hygiene runs on the RAW file text, not the canonical body. Run against the body, the CR and
    // BOM rules are structurally unreachable, because `canonicalise` has already stripped both:
    // they would be dead code dressed as a contract. The canonical-form check above still fires
    // too, and two messages for one cause is the right trade: one names the rule, one names the fix.
    const hygiene = hygieneProblems(text);
    if (hygiene.length) {
      // Refusals are scoped to writable entries. If Shopify rewrites the auto-managed privacy body
      // to contain an em dash, CI must warn rather than go permanently red on something unfixable.
      const target = WRITABLE[type] ? problems : notes;
      for (const h of hygiene) target.push(`${key}: ${fileNameForType(type)} ${h}`);
    }

    const core = coreOf(body);
    const headings = extractHeadings(core);
    const dupes = duplicateHeadingIds(headings);
    if (dupes.length) {
      problems.push(
        `${key}: two h2 headings slugify to the same id (${dupes.join(', ')}); assets/policy-nav.js would ` +
          'silently suffix one with "-2", and which one depends on document order. Reword one heading.',
      );
    }

    cores.set(type, core);
    computed.set(type, {
      handle: STOREFRONT_HANDLES[type],
      writable: WRITABLE[type],
      // `stamped` is a decision, not a derivation: it is compared against the manifest's own value
      // below so the entry stays self-describing, and the stamp rules key off the manifest.
      stamped: manifest.policies?.[key]?.stamped === true,
      sha256: sha256(body),
      coreSha256: sha256(core),
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

    // -------------------------------------------------------------------------------------
    // The version contract.
    //
    // `version` is DERIVED, never hand-typed, so the only thing to check here is that it is a
    // usable integer and that the body agrees with it. `coreSha256` is what every comparison in
    // the subsystem runs on; `sha256` stays the committed bytes, an integrity hash only. That the
    // two differ for a stamped policy is the whole point, and is asserted in the test suite.
    // -------------------------------------------------------------------------------------
    if (!isVersionNumber(entry.version)) {
      mismatches.push(
        `${key}: version is ${JSON.stringify(entry.version)}, expected an integer >= 1. It is derived; ` +
          'run npm run policies:restamp rather than editing it.',
      );
    }
    if (typeof entry.stamped !== 'boolean') {
      mismatches.push(`${key}: stamped must be true or false`);
    } else if (entry.stamped && entry.writable === false) {
      mismatches.push(
        `${key}: stamped is true but writable is false. A stamp that can never be pushed is a permanent ` +
          'check failure; Shopify auto-manages this policy.',
      );
    }

    const body = bodies.get(type);
    const stamp = parseVersionStamp(body);
    if (isStamped(entry)) {
      if (stamp === null) {
        mismatches.push(
          `${key}: ${fileNameForType(type)} carries no version stamp, but the manifest says stamped: true. ` +
            'Run npm run policies:restamp.',
        );
      } else {
        if (stamp.key !== key) {
          mismatches.push(`${key}: the version stamp names "${stamp.key}", not this policy. Run npm run policies:restamp.`);
        }
        if (stamp.version !== entry.version) {
          mismatches.push(
            `${key}: the version stamp says v${stamp.version} but the manifest says version ${JSON.stringify(entry.version)}. ` +
              'Run npm run policies:restamp.',
          );
        }
      }
    } else if (stamp !== null) {
      // A stamp on a policy that opted out. Refuse for a writable one, where it is our mistake;
      // note it for the auto-managed privacy policy, where Shopify owns the bytes and CI must not
      // go permanently red on something nobody here can fix.
      const target = WRITABLE[type] ? mismatches : notes;
      target.push(
        `${key}: ${fileNameForType(type)} carries a version stamp but the manifest says stamped: false`,
      );
    }
  }

  return { bodies, cores, computed, problems, mismatches, notes, manifest };
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
