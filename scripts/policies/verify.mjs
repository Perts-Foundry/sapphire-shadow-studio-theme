#!/usr/bin/env node
// Assert what the LIVE policies say, after a push.
//
// `policies:pull --check` is a TAUTOLOGY here: a successful push already reconciled the repo with
// Admin, so it comes back clean whether the intended wording landed or not. This asserts the
// sentences instead, against the live body, and prints the exact diff between what the repo holds
// and what Admin stored so a renormalisation is visible rather than inferred.
//
//   npm run policies:verify                  every policy: live core vs repo core, plus versions
//   npm run policies:verify -- --root <dir>  operate on another checkout (tests)
//
// THE ASSERTION OF RECORD IS THE VERSION. A byte-match without a version match is not a
// verification: it says the two bodies agree, not that the body live is carrying is the one this
// repo can name. That is the entire reason the version stamp exists.
//
// STALE ASSERTION SETS FAIL CLOSED. `assertions.json` pins, per policy, the `coreSha256` its
// sentences were written against. A set whose hash no longer matches the repo body is refused
// BEFORE any live comparison, and a set with no hash at all is refused too rather than silently
// falling back to the default mode: a stale positive assertion is worse than no assertion, because
// it reports PASS on wording nobody checked.
//
// Read-only: it goes through the read-only client, which refuses a mutation before the network.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { paths, REPO_ROOT } from './check.mjs';
import { POLICIES_QUERY } from './pull.mjs';
import { unifiedDiff } from './lib/diff.mjs';
import { readState, resolveStateDir, stateEntry } from './lib/state.mjs';
import {
  POLICY_TYPES,
  PolicyError,
  bodyFromFileText,
  coreOf,
  coreSha256,
  isStampedBody,
  keyForType,
  parseVersionStamp,
} from './lib/policies.mjs';

export const ASSERTIONS_FILE = join(dirname(fileURLToPath(import.meta.url)), 'assertions.json');

export function readAssertions(file = ASSERTIONS_FILE) {
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return parsed?.policies ?? {};
}

/**
 * Refuse a set whose `coreSha256` does not match the repo body it was written against.
 *
 * Both failure shapes refuse, and neither falls back: a mismatched hash means the wording moved
 * and nobody rewrote the sentences, an absent hash means the set was hand-added without one. Both
 * produce confident PASS lines about text nobody has read, which is the worst output this tool
 * could produce.
 */
export function assertSetIsCurrent(key, set, repoCore) {
  if (typeof set.coreSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(set.coreSha256)) {
    throw new PolicyError(
      `assertions.json/${key}`,
      'has no coreSha256 saying which body its sentences were written against. Add one (the value ' +
        `for the current body is ${repoCore}) or delete the set; there is no default-mode fallback, ` +
        'because a stale positive assertion reports PASS on wording nobody checked.',
    );
  }
  if (set.coreSha256 !== repoCore) {
    throw new PolicyError(
      `assertions.json/${key}`,
      `was written against core ${set.coreSha256} but the repo body is now ${repoCore}. The wording ` +
        'changed and the sentences did not. Rewrite the set for the new wording and update its ' +
        'coreSha256, or delete the set. Refusing BEFORE reading the live store.',
    );
  }
}

/**
 * @param {object} o
 * @param {{gql: Function}} o.client
 * @param {string} o.root
 * @param {object} o.assertions      the parsed assertions.json `policies` map
 * @param {object|null} o.state      the observation state, for the stamped/unstamped distinction
 * @param {(s: string) => void} [o.log]
 */
export async function run({ client, root, assertions, state = null, log = console.log }) {
  if (!client || typeof client.gql !== 'function') throw new Error('policies:verify needs an Admin client');
  if (typeof root !== 'string' || root === '') throw new Error('policies:verify needs a root');

  const p = paths(root);
  const repoCores = new Map();
  const repoBodies = new Map();
  for (const type of POLICY_TYPES) {
    const file = p.file(type);
    if (!existsSync(file)) continue;
    const body = bodyFromFileText(readFileSync(file, 'utf8'));
    repoBodies.set(type, body);
    repoCores.set(type, coreSha256(body));
  }

  // Refuse every stale set BEFORE the network call, so a stale set cannot cost a live read and
  // cannot be masked by a network failure.
  for (const [key, set] of Object.entries(assertions)) {
    const type = key.toUpperCase();
    if (!POLICY_TYPES.includes(type)) throw new PolicyError(`assertions.json/${key}`, 'names no tracked policy');
    const repoCore = repoCores.get(type);
    if (repoCore === undefined) throw new PolicyError(`assertions.json/${key}`, 'has no body in this checkout');
    assertSetIsCurrent(key, set, repoCore);
  }

  const rows = (await client.gql(POLICIES_QUERY)).shop.shopPolicies;
  let failed = 0;
  const results = [];

  for (const type of POLICY_TYPES) {
    const key = keyForType(type);
    const row = rows.find((r) => r.type === type);
    log(`\n=== ${key} ===`);
    if (!row) {
      failed++;
      log('  FAIL  Admin returned no such policy');
      results.push({ key, ok: false });
      continue;
    }
    const live = coreOf(row.body);
    const liveCore = coreSha256(row.body);
    const repoBody = repoBodies.get(type);
    const repoCore = repoCores.get(type);
    let ok = true;

    const set = assertions[key];
    if (set) {
      for (const sentence of set.must ?? []) {
        const hit = live.includes(sentence);
        if (!hit) { failed++; ok = false; }
        log(`  ${hit ? 'PASS' : 'FAIL'}  live contains ${JSON.stringify(sentence)}`);
      }
      for (const sentence of set.mustNot ?? []) {
        const hit = !live.includes(sentence);
        if (!hit) { failed++; ok = false; }
        log(`  ${hit ? 'PASS' : 'FAIL'}  live does NOT contain ${JSON.stringify(sentence)}`);
      }
    }

    // THE ASSERTION OF RECORD.
    const repoStamp = parseVersionStamp(repoBody ?? '');
    const liveStamp = parseVersionStamp(row.body);
    const observed = stateEntry(state, key);
    if (repoStamp === null) {
      log('  SKIP  this policy is not stamped, so there is no version to assert');
    } else if (liveStamp && liveStamp.version === repoStamp.version && liveStamp.key === key) {
      log(`  PASS  live carries the version stamp this repo names (v${repoStamp.version})`);
    } else if (liveStamp) {
      failed++;
      ok = false;
      log(`  FAIL  live carries v${liveStamp.version} (key "${liveStamp.key}"), the repo names v${repoStamp.version}`);
    } else if (observed?.lastPushStamped === true) {
      // We wrote a stamped body and live carries none: Shopify strips HTML comments. Not a
      // wording failure, but it retires the version assertion permanently, so say which it is.
      failed++;
      ok = false;
      log('  FAIL  a stamped body was pushed from this machine and live carries no stamp:');
      log('        Shopify strips HTML comments, so the live page cannot self-identify.');
      log('        Set "stamped": false in the manifest for this policy and rely on the core hash.');
    } else {
      log('  SKIP  no stamped write has happened from this machine yet, so live carrying no stamp is expected');
    }

    if (liveCore === repoCore) {
      log('  PASS  the live CORE is identical to the repo copy (Shopify stored the wording verbatim)');
    } else {
      failed++;
      ok = false;
      log(`  FAIL  live differs from the repo copy (live core ${liveCore.slice(0, 12)}, repo core ${repoCore?.slice(0, 12)})`);
      log(unifiedDiff(coreOf(repoBody ?? ''), live, { aLabel: 'repo (core)', bLabel: 'live (core)' }));
    }
    if (isStampedBody(row.body) && !isStampedBody(repoBody ?? '')) {
      log('  note  live carries a stamp and the repo copy does not; run npm run policies:pull');
    }
    results.push({ key, ok });
  }

  log(failed === 0 ? '\npolicies:verify: all assertions passed' : `\npolicies:verify: ${failed} assertion(s) FAILED`);
  return { failed, results };
}

async function main(argv) {
  const args = argv.slice(2);
  const rootFlag = args.indexOf('--root');
  const root = rootFlag !== -1 ? resolve(args[rootFlag + 1]) : REPO_ROOT;

  const [{ createAdminClient }, { createReadOnlyClient }] = await Promise.all([
    import('../blank-inventory/lib/admin.mjs'),
    import('../site-check/lib/admin-readonly.mjs'),
  ]);
  const client = createReadOnlyClient(createAdminClient());
  try {
    const state = readState({ dir: resolveStateDir(process.env), root });
    const { failed } = await run({ client, root, assertions: readAssertions(), state });
    return failed === 0 ? 0 : 1;
  } catch (err) {
    const redact = typeof client.redact === 'function' ? client.redact : (s) => String(s);
    console.error(`error: ${redact(err && err.message ? err.message : String(err))}`);
    console.error('policies:verify failed');
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`error: ${err && err.message ? err.message : String(err)}`);
      console.error('policies:verify failed');
      process.exitCode = 1;
    });
}
