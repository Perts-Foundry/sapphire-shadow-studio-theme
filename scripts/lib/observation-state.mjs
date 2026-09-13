// The machine-local record of what a live Admin object was last seen holding, as a mechanism.
//
// WHY IT IS NOT IN THE REPO. This was written for shop policies, where `remote` and `pulledAt` used
// to be manifest fields: a successful push dirtied the working tree with its own side effect, and
// the dirty-tree gate then blocked the NEXT push until that side effect had been committed and
// merged. A PR per push, forever, for a change that cannot affect what is sent. Moving the fields
// out of the tree deletes all of that machinery. The PR history is the record of what CHANGED; the
// manifest is the identity; this file is the freshness baseline, and it is per-machine because that
// is what an observation is.
//
// WHY IT IS SHARED. The articles subsystem needs the same freshness baseline against the same
// Admin API, with the same "never inside the checkout" rule and the same modes. What differs
// between the two is CONFIGURATION, not mechanism: the directory basename, the environment variable
// that overrides it, the key the entries live under, the command a refusal names, the schema
// version, and the error class the calling subsystem already throws. Everything else is identical,
// and a second copy of it is a second place for the containment rule to be got wrong.
//
//   $XDG_STATE_HOME/<dirBasename>/observed.json      (default)
//   $<envVar>/observed.json                          (override)
//
// A SIBLING of a subsystem's backup directory, never a child of it. `shop-policies/state/` was the
// obvious first spelling and it defeats the whole rationale: `rm -rf ~/.local/state/shop-policies`,
// a "reclaim some space, delete old backups" action, would take the freshness baseline with it.
// Separate overrides are not enough when the defaults nest, so a caller passes a basename that is
// not its backup directory's.
//
// WHAT THIS MODULE DOES NOT KNOW. What an observation CONTAINS is the caller's business: policies
// record a core hash and a monotonic version floor, articles record something else entirely. This
// module owns where the file lives, that it is outside the tree, that it lands at 0600 in a 0700
// directory, and that an unusable file is a refusal rather than a guess.

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { displayPath } from './display-path.mjs';

/** The filename inside the state directory, the same for every subsystem. */
export const STATE_FILE_BASENAME = 'observed.json';

/** 0700 on the directory, 0600 on the file. It records what a live object said. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** The default refusal type, for a caller with no error class of its own. */
export class ObservationStateError extends Error {
  constructor(subject, detail) {
    super(`${subject}: ${detail}`);
    this.name = 'ObservationStateError';
    this.subject = subject;
    this.detail = detail;
  }
}

/** Case-insensitive comparison is the right one where the filesystem is. */
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';

/**
 * A path with every symlink in its EXISTING prefix resolved.
 *
 * `path.resolve` normalises `.` and `..` but knows nothing about symlinks, so an override pointing
 * at a link into the checkout would pass a lexical containment check and then be written straight
 * through the link. The state directory does not necessarily exist yet, so resolve the deepest
 * ancestor that does and re-attach the rest.
 *
 * @param {string} p
 * @returns {string}
 */
function realResolve(p) {
  let current = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** A configuration value that must be a non-empty string, or the factory refuses to build. */
function requireString(config, name) {
  const value = config?.[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`createObservationState: ${name} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * An observation-state accessor configured for one subsystem.
 *
 * @param {object} config
 * @param {string} config.dirBasename   directory name under $XDG_STATE_HOME, e.g. `shop-policies-state`
 * @param {string} config.envVar        the environment variable that overrides the directory
 * @param {string} config.entriesKey    the object entries live under, e.g. `policies`
 * @param {string} config.seedCommand   the one command every refusal names
 * @param {number} config.schemaVersion bumped only when the shape changes incompatibly
 * @param {Function} [config.ErrorClass] constructed as `new ErrorClass(subject, detail)`
 */
export function createObservationState(config) {
  const dirBasename = requireString(config, 'dirBasename');
  const envVar = requireString(config, 'envVar');
  const entriesKey = requireString(config, 'entriesKey');
  const seedCommand = requireString(config, 'seedCommand');
  const { schemaVersion, ErrorClass = ObservationStateError } = config ?? {};
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new TypeError(`createObservationState: schemaVersion must be an integer >= 1, got ${JSON.stringify(schemaVersion)}`);
  }

  const refuse = (subject, detail) => new ErrorClass(subject, detail);

  /** The default state directory: an XDG state path outside any checkout. */
  function defaultDir(env = process.env) {
    const stateHome = env.XDG_STATE_HOME?.trim();
    const base = stateHome && path.isAbsolute(stateHome) ? stateHome : path.join(os.homedir(), '.local', 'state');
    return path.join(base, dirBasename);
  }

  /** The state directory for this run. The configured override wins, resolved absolutely. */
  function resolveDir(env = process.env) {
    const override = env[envVar]?.trim();
    return override ? path.resolve(override) : defaultDir(env);
  }

  function filePath(dir) {
    return path.join(dir, STATE_FILE_BASENAME);
  }

  /**
   * Refuse a state directory inside the checkout.
   *
   * This is the whole point: bookkeeping that lives in the tree gets committed, and a committed
   * observation is what made every push dirty its own working tree. An override pointing back into
   * the repo would reintroduce it one `git add -A` later, in a public repo.
   *
   * Compared on the REAL paths, and case-insensitively where the filesystem is: a lexical
   * `startsWith` misses both a symlink into the tree and, on macOS or Windows, a differently-cased
   * spelling of the same directory. Both are ways to pass a check and still write into the checkout.
   */
  function assertOutsideRepo(dir, root) {
    const d = realResolve(dir);
    const r = realResolve(root);
    const [a, b] = CASE_INSENSITIVE ? [d.toLowerCase(), r.toLowerCase()] : [d, r];
    if (a === b || a.startsWith(b + path.sep)) {
      throw refuse(
        envVar,
        `resolves to ${displayPath(d)}, which is inside the checkout at ${displayPath(r)}. The ` +
          'observation state must live outside the tree, or it gets committed, and a committed ' +
          'observation is what this file exists to remove.',
      );
    }
  }

  /** An empty state, the shape a fresh machine starts from. */
  function emptyState() {
    return { schemaVersion, [entriesKey]: {} };
  }

  /**
   * Read the state file, or `null` when there is none.
   *
   * ABSENT IS NOT AN ERROR HERE; it is a fact the caller decides about. A push treats it as a
   * refusal (naming the seed command), a pull ignores it, a status report degrades and says so.
   * Corrupt, wrong-shape, zero-byte and unknown-schema are refusals in every caller, because those
   * mean the file exists and cannot be trusted, which is not the same fact at all.
   */
  function read({ dir, root }) {
    if (root !== undefined) assertOutsideRepo(dir, root);
    const file = filePath(dir);
    if (!existsSync(file)) return null;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      throw refuse(displayPath(file), `could not be read (${String(err.message).trim()}); delete it and run ${seedCommand}`);
    }
    if (text.trim() === '') {
      throw refuse(displayPath(file), `is empty; delete it and run ${seedCommand}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw refuse(displayPath(file), `is not valid JSON (${String(err.message).trim()}); delete it and run ${seedCommand}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw refuse(displayPath(file), `is not a state object; delete it and run ${seedCommand}`);
    }
    if (parsed.schemaVersion !== schemaVersion) {
      throw refuse(
        displayPath(file),
        `has schemaVersion ${JSON.stringify(parsed.schemaVersion)}, but this tool understands ` +
          `${schemaVersion}. Delete it and run ${seedCommand} to reseed.`,
      );
    }
    const entries = parsed[entriesKey];
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      throw refuse(displayPath(file), `has no "${entriesKey}" object; delete it and run ${seedCommand}`);
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
  function write({ dir, root, state }) {
    if (root !== undefined) assertOutsideRepo(dir, root);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    const file = filePath(dir);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    if (process.platform !== 'win32') {
      chmodSync(tmp, FILE_MODE);
      chmodSync(dir, DIR_MODE);
    }
    renameSync(tmp, file);
    return file;
  }

  /** One entry, or `undefined`. */
  function entry(state, key) {
    return state?.[entriesKey]?.[key];
  }

  /**
   * For a report: the file, whether it exists, and its mode. Never throws.
   *
   * `display` is the form to PRINT. A state path contains the operator's username, which CLAUDE.md
   * bars from the repo, from PRs and from issues, and a status report is exactly the thing an
   * operator pastes into one.
   */
  function describe(dir) {
    const file = filePath(dir);
    let mode = null;
    try {
      mode = statSync(file).mode & 0o777;
    } catch {
      mode = null;
    }
    return { dir, file, display: displayPath(file), exists: existsSync(file), mode };
  }

  return {
    DIR_BASENAME: dirBasename,
    ENV_VAR: envVar,
    ENTRIES_KEY: entriesKey,
    SEED_COMMAND: seedCommand,
    SCHEMA_VERSION: schemaVersion,
    STATE_FILE_BASENAME,
    DIR_MODE,
    FILE_MODE,
    defaultDir,
    resolveDir,
    filePath,
    assertOutsideRepo,
    emptyState,
    read,
    write,
    entry,
    describe,
  };
}
