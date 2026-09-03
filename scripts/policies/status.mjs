#!/usr/bin/env node
// Where every shop policy stands, and the ONE command that moves each one forward.
//
// This is the entry point the whole subsystem was missing. `check` proves the repo agrees with
// ITSELF and is green in the merged-but-not-pushed state, which is exactly how a wording change
// gets declared done while customers still read the old text. `pull --check` answers a different
// question and needs credentials. Neither says "you are here, do this next".
//
//   npm run policies:status              offline; repo vs manifest vs the last observation
//   npm run policies:status -- --live    plus an Admin read, so the live column is current
//
// OFFLINE BY DEFAULT. Without `--live` no Admin client is constructed at all; a test asserts zero
// client constructions.
//
// IT DEGRADES, IT NEVER REFUSES. No state file, no `origin/main`, a policy in state but not the
// manifest: every one of those is a state to REPORT, because a status command that refuses to say
// where you are is the tool failing at its only job.
//
// Exit codes: 0 everything is in sync and nothing is outstanding, 2 actionable drift, 1 the tool
// itself failed. Three codes, because "there is a push outstanding" is a normal state and must be
// distinguishable from "status could not run".

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT, plan } from './check.mjs';
import { POLICIES_QUERY } from './pull.mjs';
import { describeState, readState, resolveStateDir, stateEntry } from './lib/state.mjs';
import { POLICY_TYPES, coreSha256, isStamped, keyForType, parseVersionStamp, sha256 } from './lib/policies.mjs';

/**
 * Every state this subsystem can be in, as a label plus the one command that leaves it.
 *
 * ONE DESTINATION PER STATE. A state that maps to "it depends" is a state nobody can act on, and
 * the reason the last five PRs each discovered their situation rather than looking it up.
 */
export const STATES = Object.freeze({
  IN_SYNC: 'in sync',
  REPO_AHEAD: 'repo ahead: a push is outstanding',
  REPO_DIRTY: 'repo edited: restamp, then commit',
  ADMIN_MOVED: 'Admin moved: pull and review',
  CONFLICT: 'CONFLICT: edited locally AND Admin moved',
  NO_STATE: 'unknown: no observation state on this machine',
  NOT_TRACKED: 'in the observation state but not the manifest',
  TOOL_ERROR: 'status could not classify this policy',
});

/**
 * Classify one policy from the input triple plus state presence. PURE, so the whole table is
 * testable without a filesystem or a client.
 *
 * PRECEDENCE, documented because the conflict cells are where a wrong answer costs the most:
 *
 *   1. no observation at all            -> NO_STATE. Nothing else can be said honestly.
 *   2. repo core != manifest core       -> the repo has an uncommitted or unrestamped edit.
 *      AND live core != observed core      Combined with Admin having moved, this is CONFLICT,
 *                                          which is reported and never auto-resolved.
 *   3. repo core != manifest core       -> REPO_DIRTY. Restamp first; nothing else is knowable
 *                                          until the manifest describes the body.
 *   4. live core != observed core       -> ADMIN_MOVED. Someone edited in Admin.
 *   5. repo core != observed core       -> REPO_AHEAD. A push is outstanding.
 *   6. otherwise                        -> IN_SYNC.
 *
 * Rule 3 before rule 5 matters: a repo whose manifest does not describe its own body cannot be
 * pushed at all (`check` refuses), so telling the operator to push would be a dead end.
 *
 * @param {object} o
 * @param {string} o.repoCore      sha256 of the core body on disk
 * @param {string} o.manifestCore  the manifest's coreSha256
 * @param {string|null} o.observedCore  the last observed live core, or null
 * @param {string|null} [o.liveCore]    the live core right now, when --live was passed
 */
export function classify({ repoCore, manifestCore, observedCore, liveCore = null }) {
  if (typeof repoCore !== 'string' || typeof manifestCore !== 'string') return STATES.TOOL_ERROR;
  if (observedCore === null) return STATES.NO_STATE;
  const repoEdited = repoCore !== manifestCore;
  // Without --live, the last observation IS the best available answer for what Admin holds, so
  // "Admin moved" is unknowable and the comparison is skipped rather than guessed at.
  const adminMoved = liveCore !== null && liveCore !== observedCore;
  if (repoEdited && adminMoved) return STATES.CONFLICT;
  if (repoEdited) return STATES.REPO_DIRTY;
  if (adminMoved) return STATES.ADMIN_MOVED;
  if (repoCore !== observedCore) return STATES.REPO_AHEAD;
  return STATES.IN_SYNC;
}

/** The one next command for a state. Never a list, never "it depends". */
export function nextCommand(state, key) {
  switch (state) {
    case STATES.IN_SYNC:
      return 'nothing to do';
    case STATES.REPO_AHEAD:
      return `npm run policies:push -- --type ${key}        (dry run first; the write needs an operator)`;
    case STATES.REPO_DIRTY:
      return 'npm run policies:restamp                      (then commit and open a PR)';
    case STATES.ADMIN_MOVED:
      return 'npm run policies:pull                         (review the diff before committing)';
    case STATES.CONFLICT:
      return 'npm run policies:pull -- --check              (read both sides; do NOT pull blind)';
    case STATES.NO_STATE:
      // `--seed` and not a bare pull: a bare pull takes Admin's body into the repo on the way,
      // which reverts a committed unpushed wording change without asking. `--seed` records the
      // baseline and writes no repo file, so it is the right answer whether or not one is pending.
      return 'npm run policies:pull -- --seed              (records the baseline; writes no repo file)';
    case STATES.NOT_TRACKED:
      return 'nothing: it is a leftover in the state file and is ignored';
    default:
      return 'stop and look: status could not classify this policy';
  }
}

/** States that mean there is something for a human to do. */
const ACTIONABLE = new Set([STATES.REPO_AHEAD, STATES.REPO_DIRTY, STATES.ADMIN_MOVED, STATES.CONFLICT, STATES.NO_STATE, STATES.TOOL_ERROR]);

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/**
 * The branch context, or a reason it is unknown. A fresh clone with no `origin/main`, or a
 * directory that is not a git worktree at all, REPORTS rather than crashing: a status command that
 * dies because it could not resolve a ref has told you nothing about your policies.
 */
export function describeBranch(root, { run = git } = {}) {
  try {
    const branch = run(root, ['branch', '--show-current']);
    let merged = null;
    try {
      const head = run(root, ['rev-parse', 'HEAD']);
      const base = run(root, ['rev-parse', 'origin/main']);
      run(root, ['merge-base', '--is-ancestor', head, base]);
      merged = true;
      void base;
    } catch {
      merged = false;
    }
    return { branch: branch || '(detached)', merged, note: null };
  } catch {
    return { branch: null, merged: null, note: 'not a git worktree, or git is unavailable' };
  }
}

/**
 * @param {object} o
 * @param {string} o.root
 * @param {string} o.stateDir
 * @param {{gql: Function}|null} [o.client]  only when --live was asked for
 * @param {Function} [o.gitRun]
 */
export async function run({ root, stateDir, client = null, gitRun = git }) {
  const rows = [];
  const notes = [];

  const state = (() => {
    try {
      return { value: readState({ dir: stateDir, root }), error: null };
    } catch (err) {
      // A corrupt state file is reported, not thrown: knowing the file is unusable IS the status.
      return { value: null, error: err.message };
    }
  })();
  if (state.error) notes.push(`the observation state could not be read: ${state.error}`);

  let liveByType = null;
  if (client) {
    const data = await client.gql(POLICIES_QUERY);
    liveByType = new Map(
      (data?.shop?.shopPolicies ?? []).filter((r) => r && POLICY_TYPES.includes(r.type)).map((r) => [r.type, r.body]),
    );
  }

  const { cores, manifest, problems } = plan(root);
  for (const m of problems) notes.push(m);

  for (const type of POLICY_TYPES) {
    const key = keyForType(type);
    const entry = manifest.policies?.[key];
    const core = cores.get(type);
    const observed = stateEntry(state.value, key);
    const liveBody = liveByType?.get(type);
    const liveCore = liveBody === undefined ? null : coreSha256(liveBody);
    const status =
      core === undefined || !entry
        ? STATES.TOOL_ERROR
        : classify({
            repoCore: sha256(core),
            manifestCore: entry.coreSha256,
            observedCore: observed?.coreSha256 ?? null,
            liveCore,
          });
    rows.push({
      key,
      status,
      version: entry?.version ?? null,
      stamped: isStamped(entry),
      liveVersion: liveBody === undefined ? null : (parseVersionStamp(liveBody)?.version ?? null),
      observedAt: observed?.observedAt ?? null,
      highestPushed: observed?.highestPushed ?? null,
      next: nextCommand(status, key),
    });
  }

  // A policy the state file knows about but the manifest does not. Harmless, and worth saying:
  // it is usually a renamed key or a half-finished migration.
  for (const key of Object.keys(state.value?.policies ?? {})) {
    if (!manifest.policies?.[key]) {
      rows.push({ key, status: STATES.NOT_TRACKED, version: null, stamped: false, liveVersion: null, observedAt: null, highestPushed: null, next: nextCommand(STATES.NOT_TRACKED, key) });
    }
  }

  return { rows, notes, branch: describeBranch(root, { run: gitRun }), state: describeState(stateDir), live: liveByType !== null };
}

export function format(result) {
  const lines = [];
  const { branch, state } = result;
  lines.push(`branch: ${branch.branch ?? 'unknown'}${branch.note ? ` (${branch.note})` : ''}${branch.merged === false ? ' [not merged into origin/main]' : ''}`);
  // `display` collapses $HOME: this output is exactly what an operator pastes into a PR or an
  // issue on a PUBLIC repo, and an absolute state path carries their username.
  lines.push(`state:  ${state.display}${state.exists ? '' : ' (ABSENT)'}`);
  lines.push(
    result.live
      ? 'live:   read from Admin'
      : 'live:   NOT READ. Without --live this compares against the last observation, which may be ' +
        'stale, and "Admin moved" is not a state this run can report.',
  );
  lines.push('');
  for (const row of result.rows) {
    const version = row.version === null ? '' : ` v${row.version}${row.stamped ? '' : ' (unstamped)'}`;
    const liveVersion = row.liveVersion === null ? '' : ` live v${row.liveVersion}`;
    lines.push(`${row.key}${version}${liveVersion}`);
    lines.push(`  ${row.status}`);
    lines.push(`  next: ${row.next}`);
  }
  if (result.notes.length) {
    lines.push('');
    for (const n of result.notes) lines.push(`note: ${n}`);
  }
  return lines.join('\n');
}

async function main(argv) {
  const args = argv.slice(2);
  const wantLive = args.includes('--live');
  const rootFlag = args.indexOf('--root');
  const root = rootFlag !== -1 ? resolve(args[rootFlag + 1]) : REPO_ROOT;

  let client = null;
  try {
    if (wantLive) {
      // Imported lazily so the offline path constructs nothing that can reach the network, and so
      // an unset MYSHOPIFY_DOMAIN cannot make the offline command fail.
      const [{ createAdminClient }, { createReadOnlyClient }] = await Promise.all([
        import('../blank-inventory/lib/admin.mjs'),
        import('../site-check/lib/admin-readonly.mjs'),
      ]);
      client = createReadOnlyClient(createAdminClient());
    }
    const result = await run({ root, stateDir: resolveStateDir(process.env), client });
    console.log(format(result));
    return result.rows.some((r) => ACTIONABLE.has(r.status)) ? 2 : 0;
  } catch (err) {
    console.error(`error: ${err && err.message ? err.message : String(err)}`);
    console.error('policies:status failed');
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
      console.error('policies:status failed');
      process.exitCode = 1;
    });
}
