#!/usr/bin/env node
// Pull the live shop policies from Admin into marketing/policies/, and seed the machine-local
// observation state.
//
// Reads through the read-only client (scripts/site-check/lib/admin-readonly.mjs), which refuses
// any document containing a mutation before it reaches the network, so this tool cannot write to
// the store even by accident.
//
//   npm run policies:pull                        write the files, the manifest and the state
//   npm run policies:pull -- --check             report drift, write nothing
//   npm run policies:pull -- --seed              write ONLY the state file; touch no body
//   npm run policies:pull -- --discard-local     overwrite a local edit on purpose
//
// IT OVERWRITES COMMITTED WORDING, so it has three gates it did not used to have:
//
//   1. a body file it would overwrite must be clean in git,
//   2. a policy whose repo core is ahead of live is a refusal, and
//   3. a policy whose WORDING differs from live with NO OBSERVATION STATE is a refusal too,
//      because without a baseline this tool cannot tell which side moved,
//
// with `--discard-local` as the one explicit override for all three. There is deliberately NO
// "not a git worktree, skip the check" branch: a production tool that disables a destructive-write
// guard so a test can pass is the same defect class the strict test fakes exist to remove.
//
// PULL IS THE SEEDER, so it NEVER REQUIRES the state file, and gate 3 cannot deadlock the
// migration: gates 2 and 3 look at the CORE, so a file that differs from live only by its version
// stamp is written with no baseline and no complaint, which is every policy in the migration
// window and after the first stamped push. `--seed` is the escape for the one case that would otherwise be circular: a wording
// change committed BEFORE the state was ever seeded, where an ordinary pull would revert it and
// push refuses for want of a baseline. `--seed` records what Admin holds right now and writes not
// one byte into the repo.
//
// PULL RESTAMPS WHAT IT WRITES. It takes the core from live, derives the version, and writes the
// stamped body, so a freshly pulled tree is always `policies:check`-clean. Without that, `check`
// would either refuse after every pull or be unable to detect a silently dropped stamp.
//
// Exit codes: 0 clean, 1 the tool failed (auth, network, a refusal), 2 drift found in --check
// mode. Two codes because "Admin and the repo disagree" is a normal, actionable state and must be
// distinguishable from "the check never ran".
//
// `run({ client, root, now })` takes NO defaults for `client` or `root`: constructing the real
// client and defaulting the root live in `main` only, so a test that forgets to inject the fake
// cannot reach the live store.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertScopes, createAdminClient } from '../blank-inventory/lib/admin.mjs';
import { createReadOnlyClient } from '../site-check/lib/admin-readonly.mjs';
import { paths, readManifest, REPO_ROOT } from './check.mjs';
import { displayPath } from './lib/backups.mjs';
import { floorFor, readState, recordObservation, resolveStateDir, writeState, emptyState } from './lib/state.mjs';
import {
  POLICY_TYPES,
  PolicyError,
  buildEntry,
  canonicalise,
  coreSha256,
  fileNameForType,
  fileTextFor,
  formatManifest,
  keyForType,
} from './lib/policies.mjs';

/** The scope the read needs. Narrower than push's, which also needs write_legal_policies. */
export const READ_SCOPES = ['read_legal_policies'];

export const POLICIES_QUERY = `query PoliciesPull {
  shop { shopPolicies { id type title body url } }
}`;

/** Atomic write: a `.tmp` sibling, then a rename, so a crash never leaves a half-written policy. */
export function writeAtomic(target, text) {
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, target);
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

/**
 * Refuse to overwrite a policy body that is dirty in git.
 *
 * Bare `policies:pull` used to overwrite all five committed bodies with no check at all, which
 * silently destroyed an uncommitted wording edit. That was the single most dangerous property of
 * the always-safe half of this toolset, and it is the reason CLAUDE.md had to carry a rule about
 * a command rather than the command carrying the rule.
 *
 * `run` is injectable so the tests can drive it, and `test/git-integration.test.mjs` runs it
 * against a real repository so the pathspec is proved rather than assumed.
 *
 * @param {string} root
 * @param {string[]} types  only the policies this pull would actually rewrite
 */
export function assertBodiesClean(root, types, { run = git } = {}) {
  if (types.length === 0) return;
  const pathspecs = types.map((type) => `marketing/policies/${fileNameForType(type)}`);
  const dirty = run(root, ['status', '--porcelain', '--', ...pathspecs]);
  if (dirty !== '') {
    throw new PolicyError(
      'marketing/policies',
      'has uncommitted changes to a body this pull would OVERWRITE, and the overwrite is not ' +
        `recoverable from git:\n${dirty}\n` +
        'Commit or stash the edit first. `--discard-local` throws it away on purpose.',
    );
  }
}

/**
 * Turn the API's policy list into a Map<type, {title, body}>, refusing anything unusable.
 *
 * A type the API omits is a refusal, not a skipped file: silently writing four of five policies
 * would leave the fifth stale with nothing to say so. A null or empty body is a refusal too,
 * rather than a zero-byte write that a later push would send to the store.
 */
export function indexPolicies(list) {
  const rows = Array.isArray(list) ? list : [];
  const byType = new Map();
  for (const row of rows) {
    if (!row || typeof row.type !== 'string') continue;
    if (!POLICY_TYPES.includes(row.type)) continue;
    if (byType.has(row.type)) throw new PolicyError(row.type, 'Admin returned two policies of the same type');
    if (typeof row.body !== 'string' || canonicalise(row.body) === '') {
      throw new PolicyError(row.type, 'Admin returned an empty body; refusing rather than writing a zero-byte policy');
    }
    if (typeof row.title !== 'string' || row.title.trim() === '') {
      throw new PolicyError(row.type, 'Admin returned no title');
    }
    byType.set(row.type, { title: row.title, body: row.body });
  }
  for (const type of POLICY_TYPES) {
    if (!byType.has(type)) {
      throw new PolicyError(type, 'Admin did not return this policy; it is tracked in POLICY_TYPES but absent from the shop');
    }
  }
  return byType;
}

/**
 * @param {object} o
 * @param {{gql: Function}} o.client   a read-only Admin client
 * @param {string} o.root              checkout root
 * @param {string} o.now               ISO-8601 timestamp for this run (injected, so a whole-manifest
 *                                     comparison in a test is stable)
 * @param {string} o.stateDir          where observed.json lives
 * @param {boolean} [o.checkOnly]      report drift, write nothing
 * @param {boolean} [o.seedOnly]       write ONLY the state file; touch no body and no manifest
 * @param {boolean} [o.discardLocal]   overwrite a dirty or repo-ahead body on purpose
 * @param {Function} [o.gitRun]        injectable git runner
 */
export async function run({ client, root, now, stateDir, checkOnly = false, seedOnly = false, discardLocal = false, gitRun = git }) {
  if (!client || typeof client.gql !== 'function') throw new Error('policies:pull needs an Admin client');
  if (typeof root !== 'string' || root === '') throw new Error('policies:pull needs a root');
  if (typeof now !== 'string' || now === '') throw new Error('policies:pull needs an ISO timestamp');
  if (typeof stateDir !== 'string' || stateDir === '') throw new Error('policies:pull needs a state directory');

  const p = paths(root);
  const data = await client.gql(POLICIES_QUERY);
  const live = indexPolicies(data?.shop?.shopPolicies);

  const manifest = existsSync(p.manifest) ? readManifest(root) : { policies: {} };
  // ABSENT STATE IS FINE HERE, and only here. `pull` is what creates it.
  const state = readState({ dir: stateDir, root }) ?? emptyState();
  const next = { ...manifest, policies: { ...manifest.policies } };
  const nextState = { ...state, policies: { ...state.policies } };
  const changed = [];
  const files = [];
  const directions = new Map();

  for (const type of POLICY_TYPES) {
    const key = keyForType(type);
    const { title, body } = live.get(type);
    const prev = manifest.policies?.[key];
    const { entry, body: written } = buildEntry(prev, { type, title, body, floor: floorFor(state, key) });
    const text = fileTextFor(written);
    const file = p.file(type);
    const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (current !== text) {
      changed.push(key);
      files.push({ type, file, text });
      // WHICH SIDE MOVED, decided on the CORE hash so a stamped repo body and an unstamped live
      // body read as "in sync" rather than as a permanent repo-ahead. The recorded observation is
      // what Admin was last seen holding:
      //   live core == observed core  ->  Admin has not moved; the REPO is ahead, a push is due.
      //   live core != observed core  ->  Admin was edited since the last pull.
      // The two need opposite actions, and pulling in the first case destroys the committed edit.
      const observed = state.policies?.[key]?.coreSha256 ?? null;
      const liveCore = coreSha256(body);
      const repoCore = current === null ? null : coreSha256(current);
      if (repoCore === null) {
        // No file on disk at all: a fresh checkout, or a policy the shop has just gained. There
        // is nothing to lose, so no gate applies.
        directions.set(key, 'new');
      } else if (repoCore === liveCore) {
        // The WORDING is identical; the file differs only in the version stamp. This is the
        // migration case and the post-first-stamped-push case, and it is safe to write with no
        // baseline at all: there is no committed wording change to lose.
        directions.set(key, 'stamp-only');
      } else if (observed === null) {
        // No baseline, and the wording differs. "Which side moved?" has no answer, and guessing
        // "Admin" is what silently reverts a committed wording change.
        directions.set(key, 'unknown');
      } else {
        directions.set(key, liveCore === observed ? 'repo-ahead' : 'admin-moved');
      }
    }
    next.policies[key] = entry;
    nextState.policies[key] = recordObservation(state.policies?.[key], { body, now });
  }

  const before = existsSync(p.manifest) ? readFileSync(p.manifest, 'utf8') : null;
  const after = formatManifest(next);
  const manifestChanged = before !== after;

  if (checkOnly) return { changed, written: [], manifestChanged, directions };

  // `--seed` writes the state file and NOTHING else. It is the only non-destructive way out of a
  // repo that is ahead with no baseline, where an ordinary pull would revert the wording change
  // and push refuses for want of the very baseline this writes.
  if (seedOnly) {
    const stateFile = writeState({ dir: stateDir, root, state: nextState });
    return { changed, written: [], manifestChanged: false, directions, stateFile, seeded: true };
  }

  if (!discardLocal) {
    const repoAhead = changed.filter((k) => directions.get(k) === 'repo-ahead');
    if (repoAhead.length) {
      throw new PolicyError(
        repoAhead.join(', '),
        'the REPO is ahead of the live store here: Admin still holds the body this machine last ' +
          'observed, so pulling would overwrite a committed wording change with the old text. ' +
          'A push is outstanding. `--discard-local` throws the repo version away on purpose.',
      );
    }
    const unknown = changed.filter((k) => directions.get(k) === 'unknown');
    if (unknown.length) {
      throw new PolicyError(
        unknown.join(', '),
        'this differs from the live store and there is no observation state on this machine, so ' +
          'there is no way to tell whether YOU changed it or Admin did. Pulling would guess ' +
          '"Admin", which silently reverts a committed wording change.\n' +
          '  To see both sides:            npm run policies:pull -- --check\n' +
          '  To record what Admin holds\n' +
          '  without touching the repo:    npm run policies:pull -- --seed\n' +
          '  To take Admin\'s version:      npm run policies:pull -- --discard-local',
      );
    }
    assertBodiesClean(root, files.map(({ type }) => type), { run: gitRun });
  }

  // Manifest first, then the files, then the state. FAIL-LOUD, NOT SELF-HEALING: either write
  // order leaves a tree that `policies:check` refuses, and the recovery is re-running this
  // command. Do not "fix" the ordering to make a partial run look clean; that would hide a
  // half-applied pull.
  if (!existsSync(p.dir)) mkdirSync(p.dir, { recursive: true });
  if (manifestChanged) writeAtomic(p.manifest, after);
  for (const { file, text } of files) writeAtomic(file, text);
  const stateFile = writeState({ dir: stateDir, root, state: nextState });

  return { changed, written: files.map(({ file }) => file), manifestChanged, directions, stateFile };
}

/**
 * The CLI. Exported, with the client and state directory injectable, so the OPERATOR-FACING TEXT is
 * under test rather than only the `directions` map behind it.
 *
 * The messages are the product here: the regression this direction-naming exists to stop was a
 * message, not a classification. `--check` used to tell the operator to run `policies:pull` for
 * every drift, which in the repo-ahead case is the destructive action.
 *
 * The injection points default to the real thing, so a caller that passes nothing gets the live
 * behaviour and a test that forgets the fake gets a client it cannot use without credentials.
 */
export async function main(argv, { client: injectedClient, stateDir: injectedStateDir } = {}) {
  const args = argv.slice(2);
  const checkOnly = args.includes('--check');
  const seedOnly = args.includes('--seed');
  const discardLocal = args.includes('--discard-local');
  const rootFlag = args.indexOf('--root');
  const root = rootFlag !== -1 ? resolve(args[rootFlag + 1]) : REPO_ROOT;
  const client = injectedClient ?? createReadOnlyClient(createAdminClient());

  let result;
  try {
    if (!injectedClient) await assertScopes(client, READ_SCOPES);
    result = await run({
      client,
      root,
      now: new Date().toISOString(),
      stateDir: injectedStateDir ?? resolveStateDir(process.env),
      checkOnly,
      seedOnly,
      discardLocal,
    });
  } catch (err) {
    const redact = typeof client.redact === 'function' ? client.redact : (s) => String(s);
    console.error(`error: ${redact(err && err.message ? err.message : String(err))}`);
    console.error('policies:pull failed');
    return 1;
  }

  const { changed, written, manifestChanged, directions, stateFile, seeded } = result;
  if (seeded) {
    console.log(`wrote ${displayPath(stateFile)}`);
    console.log('policies:pull --seed recorded what Admin holds. NOTHING in the repo was touched.');
    console.log('Run npm run policies:status to see where each policy stands.');
    return 0;
  }
  if (checkOnly) {
    if (changed.length === 0 && !manifestChanged) {
      console.log('policies:pull --check: marketing/policies/ matches Admin');
      return 0;
    }
    // Naming the DIRECTION is the whole point. The old message said "run policies:pull" for every
    // drift, which in the repo-ahead case is the destructive action: it overwrites the committed
    // wording change with the body Admin still holds.
    const adminMoved = changed.filter((k) => directions.get(k) === 'admin-moved');
    const repoAhead = changed.filter((k) => directions.get(k) === 'repo-ahead');
    for (const key of repoAhead) {
      console.error(`drift: ${key}.html - the REPO is ahead; Admin still holds the last body we observed.`);
      console.error(`       A push is outstanding: npm run policies:push -- --type ${key}`);
      console.error('       policies:pull would refuse this one; it would overwrite the committed change.');
    }
    for (const key of adminMoved) {
      console.error(`drift: ${key}.html - ADMIN has moved since the last pull.`);
      console.error('       Review the diff, then run npm run policies:pull to take Admin\'s version.');
    }
    for (const key of changed.filter((k) => directions.get(k) === 'unknown')) {
      console.error(`drift: ${key}.html - the WORDING differs from Admin, and this machine has NO baseline.`);
      console.error('       Which side moved cannot be determined. policies:pull would refuse.');
      console.error('       npm run policies:pull -- --seed records what Admin holds, touching no file.');
    }
    for (const key of changed.filter((k) => directions.get(k) === 'stamp-only')) {
      console.log(`note: ${key}.html differs from Admin only in its version stamp; the wording matches.`);
      console.log('      npm run policies:pull applies it safely.');
    }
    if (manifestChanged && changed.length === 0) console.error('drift: manifest.json would change');
    const unknown = changed.filter((k) => directions.get(k) === 'unknown');
    const stampOnly = changed.filter((k) => directions.get(k) === 'stamp-only');
    console.error(
      `policies:pull --check found drift: ${repoAhead.length} outstanding push(es), ${adminMoved.length} Admin edit(s), ` +
        `${unknown.length} undetermined, ${stampOnly.length} stamp-only.` +
        (repoAhead.length && !adminMoved.length ? ' Nothing to pull.' : ''),
    );
    return 2;
  }

  for (const file of written) console.log(`wrote ${file}`);
  if (manifestChanged) console.log('wrote manifest.json');
  if (stateFile) console.log(`wrote ${displayPath(stateFile)}`);
  console.log(`policies:pull wrote ${written.length} file(s)${manifestChanged ? ' and the manifest' : ''}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // The .catch is not decoration. `createAdminClient()` reads MYSHOPIFY_DOMAIN eagerly, so an
  // unset variable throws synchronously out of main() and would surface as an unhandled promise
  // rejection instead of this tool's ordinary `error:` + exit 1. The message carries no secret at
  // that point (no token has been minted), so printing it raw is safe.
  main(process.argv)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`error: ${err && err.message ? err.message : String(err)}`);
      console.error('policies:pull failed');
      process.exitCode = 1;
    });
}
