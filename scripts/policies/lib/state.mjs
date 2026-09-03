// The machine-local record of what Admin was last seen holding.
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
//   $XDG_STATE_HOME/shop-policies/state/observed.json      (default)
//   $POLICIES_STATE_DIR/observed.json                      (override)
//
// `check` NEVER reads this file: it stays offline and CI-safe, and a machine-local file is not
// something CI can have an opinion about. `pull` writes it and never requires it (it is the
// seeder, so a mutual dependency would deadlock the migration). `push` requires it, because the
// freshness gate is the one thing standing between a push and an Admin edit nobody has seen.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PolicyError, canonicalise, coreSha256, sha256 } from './policies.mjs';

/** Bumped only when the shape changes incompatibly. An unknown value is a refusal, never a guess. */
export const STATE_SCHEMA_VERSION = 1;

export const STATE_DIR_SEGMENTS = Object.freeze(['shop-policies', 'state']);
export const STATE_FILE_BASENAME = 'observed.json';

/** 0700 on the directory, 0600 on the file. It records what a legal policy said. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** The command every state refusal names. One string, so the tests can assert it verbatim. */
export const SEED_COMMAND = 'npm run policies:pull';

/** The default state directory: an XDG state path outside any checkout. */
export function defaultStateDir(env = process.env) {
  const stateHome = env.XDG_STATE_HOME?.trim();
  const base = stateHome && path.isAbsolute(stateHome) ? stateHome : path.join(os.homedir(), '.local', 'state');
  return path.join(base, ...STATE_DIR_SEGMENTS);
}

/** The state directory for this run. `POLICIES_STATE_DIR` overrides, resolved absolutely. */
export function resolveStateDir(env = process.env) {
  const override = env.POLICIES_STATE_DIR?.trim();
  return override ? path.resolve(override) : defaultStateDir(env);
}

export function stateFilePath(dir) {
  return path.join(dir, STATE_FILE_BASENAME);
}

/**
 * Refuse a state directory inside the checkout.
 *
 * This is the whole point of the change: bookkeeping that lives in the tree gets committed, and a
 * committed observation is what made every push dirty its own working tree. An override pointing
 * back into the repo would reintroduce it one `git add -A` later, in a public repo.
 */
export function assertStateDirOutsideRepo(dir, root) {
  const d = path.resolve(dir);
  const r = path.resolve(root);
  if (d === r || d.startsWith(r + path.sep)) {
    throw new PolicyError(
      'POLICIES_STATE_DIR',
      `resolves to ${d}, which is inside the checkout at ${r}. The observation state must live outside ` +
        'the tree, or it gets committed, and a committed observation is what this file exists to remove.',
    );
  }
}

/** An empty state, the shape a fresh machine starts from. */
export function emptyState() {
  return { schemaVersion: STATE_SCHEMA_VERSION, policies: {} };
}

/**
 * Read the state file, or `null` when there is none.
 *
 * ABSENT IS NOT AN ERROR HERE; it is a fact the caller decides about. `push` treats it as a
 * refusal (naming `SEED_COMMAND`), `pull` ignores it, `status` degrades and reports. Corrupt,
 * wrong-shape, zero-byte and unknown-schema are refusals in every caller, because those mean the
 * file exists and cannot be trusted, which is not the same fact at all.
 */
export function readState({ dir, root }) {
  if (root !== undefined) assertStateDirOutsideRepo(dir, root);
  const file = stateFilePath(dir);
  if (!existsSync(file)) return null;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new PolicyError(file, `could not be read (${String(err.message).trim()}); delete it and run ${SEED_COMMAND}`);
  }
  if (text.trim() === '') {
    throw new PolicyError(file, `is empty; delete it and run ${SEED_COMMAND}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new PolicyError(file, `is not valid JSON (${String(err.message).trim()}); delete it and run ${SEED_COMMAND}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PolicyError(file, `is not a state object; delete it and run ${SEED_COMMAND}`);
  }
  if (parsed.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new PolicyError(
      file,
      `has schemaVersion ${JSON.stringify(parsed.schemaVersion)}, but this tool understands ` +
        `${STATE_SCHEMA_VERSION}. Delete it and run ${SEED_COMMAND} to reseed.`,
    );
  }
  if (!parsed.policies || typeof parsed.policies !== 'object' || Array.isArray(parsed.policies)) {
    throw new PolicyError(file, `has no "policies" object; delete it and run ${SEED_COMMAND}`);
  }
  return parsed;
}

/**
 * Write the state file atomically, at 0600, in a 0700 directory.
 *
 * The modes are set with an explicit `chmod` AFTER the write, not by `writeFileSync`'s mode
 * argument: that argument is masked by umask and does nothing at all to a file that already
 * exists, and this file is rewritten on every pull and every push.
 */
export function writeState({ dir, root, state }) {
  if (root !== undefined) assertStateDirOutsideRepo(dir, root);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const file = stateFilePath(dir);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  if (process.platform !== 'win32') {
    chmodSync(tmp, FILE_MODE);
    chmodSync(dir, DIR_MODE);
  }
  renameSync(tmp, file);
  return file;
}

/** One policy's entry, or `undefined`. */
export function stateEntry(state, key) {
  return state?.policies?.[key];
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

/** For a report: the file, whether it exists, and its mode. Never throws. */
export function describeState(dir) {
  const file = stateFilePath(dir);
  let mode = null;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    mode = null;
  }
  return { dir, file, exists: existsSync(file), mode };
}
