// The machine-local record of what Admin was last seen holding, for shop policies.
//
// THE MECHANISM LIVES IN scripts/lib/observation-state.mjs and is shared. This file is the
// POLICIES CONFIGURATION of it, plus the two things that are genuinely policy-specific:
// `recordObservation` (what one observation contains) and `floorFor` (the monotonic version floor).
// Everything else here is a named wrapper so that every existing call site, and every message an
// operator has learned to read, is unchanged.
//
// WHY IT IS NOT IN THE REPO. `remote` and `pulledAt` used to be manifest fields, which made a
// successful push dirty the working tree with its own side effect. The dirty-tree gate then
// blocked the NEXT push until that side effect had been committed and merged: a PR per push,
// forever, for a change that cannot affect what is sent. PR #154 answered that by teaching the
// gate to ignore exactly those two fields, which is a real amount of machinery (a HEAD read, a
// JSON reshape, a field allowlist) guarding a distinction the manifest should not have carried.
// Moving the fields out deletes all of it. The PR history is the record of what CHANGED; `version`
// in the manifest is the identity; this file is the freshness baseline, and it is per-machine
// because that is what an observation is.
//
// ITS OWN PATH AND ITS OWN OVERRIDE, not the backup directory's. Sharing `POLICIES_BACKUP_DIR`
// would mean a "reclaim some space, delete old backups" action silently deletes the freshness
// baseline as well, and would let one environment variable relocate both.
//
//   $XDG_STATE_HOME/shop-policies-state/observed.json      (default)
//   $POLICIES_STATE_DIR/observed.json                      (override)
//
// A SIBLING of the backup directory, not a child of it. `shop-policies/state/` was the obvious
// first spelling and it defeats the whole rationale: `rm -rf ~/.local/state/shop-policies`, the
// literal action the paragraph above names, would still take the baseline with it. Separate
// overrides are not enough when the defaults nest.
//
// `check` NEVER reads this file: it stays offline and CI-safe, and a machine-local file is not
// something CI can have an opinion about. `pull` writes it and never requires it (it is the
// seeder, so a mutual dependency would deadlock the migration). `push` requires it, because the
// freshness gate is the one thing standing between a push and an Admin edit nobody has seen.

import {
  DIR_MODE as SHARED_DIR_MODE,
  FILE_MODE as SHARED_FILE_MODE,
  STATE_FILE_BASENAME as SHARED_STATE_FILE_BASENAME,
  createObservationState,
} from '../../lib/observation-state.mjs';
import { PolicyError, canonicalise, coreSha256, sha256 } from './policies.mjs';

/** Bumped only when the shape changes incompatibly. An unknown value is a refusal, never a guess. */
export const STATE_SCHEMA_VERSION = 1;

export const STATE_DIR_BASENAME = 'shop-policies-state';
export const STATE_FILE_BASENAME = SHARED_STATE_FILE_BASENAME;

/** 0700 on the directory, 0600 on the file. It records what a legal policy said. */
export const DIR_MODE = SHARED_DIR_MODE;
export const FILE_MODE = SHARED_FILE_MODE;

/** The command every state refusal names. One string, so the tests can assert it verbatim. */
export const SEED_COMMAND = 'npm run policies:pull';

/**
 * The shared mechanism, configured for policies.
 *
 * `ErrorClass` is `PolicyError` so that every refusal from the state file is the same type as every
 * other refusal in this subsystem: callers catch one thing, and `policies:status` prints one shape.
 */
const store = createObservationState({
  dirBasename: STATE_DIR_BASENAME,
  envVar: 'POLICIES_STATE_DIR',
  entriesKey: 'policies',
  seedCommand: SEED_COMMAND,
  schemaVersion: STATE_SCHEMA_VERSION,
  ErrorClass: PolicyError,
});

/** The default state directory: an XDG state path outside any checkout. */
export function defaultStateDir(env = process.env) {
  return store.defaultDir(env);
}

/** The state directory for this run. `POLICIES_STATE_DIR` overrides, resolved absolutely. */
export function resolveStateDir(env = process.env) {
  return store.resolveDir(env);
}

export function stateFilePath(dir) {
  return store.filePath(dir);
}

/** Refuse a state directory inside the checkout. See the shared module for why it resolves links. */
export function assertStateDirOutsideRepo(dir, root) {
  return store.assertOutsideRepo(dir, root);
}

/** An empty state, the shape a fresh machine starts from. */
export function emptyState() {
  return store.emptyState();
}

/** Read the state file, or `null` when there is none. Unusable is a refusal, absent is a fact. */
export function readState({ dir, root }) {
  return store.read({ dir, root });
}

/** Write the state file atomically, at 0600, in a 0700 directory. */
export function writeState({ dir, root, state }) {
  return store.write({ dir, root, state });
}

/** One policy's entry, or `undefined`. */
export function stateEntry(state, key) {
  return store.entry(state, key);
}

/** For a report: the file, whether it exists, and its mode. Never throws. */
export function describeState(dir) {
  return store.describe(dir);
}

/**
 * The observation a pull or a push records for one policy.
 *
 * `coreSha256` is the freshness baseline and the ONLY hash any gate compares. `sha256` and
 * `length` are there so a human reading the file can tell a stamped live body from an unstamped
 * one at a glance; nothing decides on them.
 *
 * `highestPushed` / `highestPushedCoreSha256` are the monotonic floor (see `deriveVersion`), and
 * they only ever move UP: a pull that observes a lower live version does not lower the floor,
 * because the floor records what this machine has actually written to the store.
 *
 * `lastPushStamped` is what lets `policies:verify` tell "no stamped write has happened yet" from
 * "we wrote v3 and live carries no stamp, so Shopify strips comments". Those need different
 * actions and look identical on the wire.
 */
export function recordObservation(previous, { body, now, pushedVersion = null, pushedStamped = null }) {
  const canonical = canonicalise(body);
  const prev = previous ?? {};
  const next = {
    ...prev,
    coreSha256: coreSha256(canonical),
    sha256: sha256(canonical),
    length: canonical.length,
    observedAt: now,
  };
  if (pushedVersion !== null) {
    const floor = Number.isInteger(prev.highestPushed) ? prev.highestPushed : 0;
    if (pushedVersion >= floor) {
      next.highestPushed = pushedVersion;
      next.highestPushedCoreSha256 = coreSha256(canonical);
    }
    next.lastPushStamped = pushedStamped === true;
    next.lastPushedAt = now;
  }
  return next;
}

/** The floor argument `deriveVersion` takes, or null when this machine has pushed nothing. */
export function floorFor(state, key) {
  const entry = stateEntry(state, key);
  if (!entry || !Number.isInteger(entry.highestPushed)) return null;
  return { highestPushed: entry.highestPushed, coreSha256: entry.highestPushedCoreSha256 ?? null };
}
