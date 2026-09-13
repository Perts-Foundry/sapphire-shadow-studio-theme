// The one object every articles network command runs against, and the refusals every one of them
// shares. Pure: no fs, no fetch, no process.env, no process.argv.
//
// WHY A CONTEXT AT ALL. The policies commands grew their inputs one parameter at a time (`client`,
// `root`, `now`, `stateDir`, `gitRun`...), and each new gate that wanted to read the environment
// reached for `process.env` directly, which is how a CI refusal ends up testable only by mutating the
// test process's own environment. Here every command exports `run(argv, ctx)`, and everything a gate
// could want from the outside world arrives on `ctx`: the environment, the git runner, the Admin
// client, the clock, the state and backup directories. A test injects every one of them; nothing in
// `run` reads ambient state.
//
// NO DEFAULT CLIENT, NO DEFAULT GIT, NO DEFAULT ENVIRONMENT. `createContext` refuses to invent any
// of them. The real ones are constructed in each command's `main` and nowhere else, so a test that
// forgets to inject a fake gets a refusal, never the live store.

/** The refusal type for the whole articles subsystem. `subject: detail`, like PolicyError. */
export class ArticleError extends Error {
  constructor(subject, detail) {
    super(`${subject}: ${detail}`);
    this.name = 'ArticleError';
    this.subject = subject;
    this.detail = detail;
  }
}

const isFn = (v) => typeof v === 'function';
const isNonEmptyString = (v) => typeof v === 'string' && v !== '';

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build a frozen context.
 *
 * Required: `repoRoot`, `env` (an object; pass `{}` for none), `now` (a function returning an ISO
 * timestamp), `stateDir`. Optional, and null when absent: `imageRoot`, `backupDir`, `git` (a
 * `(root, args) => stdout` runner), `client` (an Admin client with `gql` and `scopes`), `fetch`
 * (for the CDN HEAD checks). `log`, `error` and `sleep` default to console and a timer, which cannot
 * reach the store.
 *
 * @param {object} input
 */
export function createContext(input) {
  const o = input ?? {};
  if (!isNonEmptyString(o.repoRoot)) throw new TypeError('createContext: repoRoot must be a non-empty string');
  if (!o.env || typeof o.env !== 'object' || Array.isArray(o.env)) {
    throw new TypeError('createContext: env must be an object; pass {} for an empty environment, never omit it');
  }
  if (!isFn(o.now)) throw new TypeError('createContext: now must be a function returning an ISO timestamp');
  if (!isNonEmptyString(o.stateDir)) throw new TypeError('createContext: stateDir must be a non-empty string');
  for (const key of ['imageRoot', 'backupDir']) {
    if (o[key] !== undefined && o[key] !== null && !isNonEmptyString(o[key])) {
      throw new TypeError(`createContext: ${key} must be a non-empty string or null`);
    }
  }
  if (o.git !== undefined && o.git !== null && !isFn(o.git)) throw new TypeError('createContext: git must be a function or null');
  if (o.fetch !== undefined && o.fetch !== null && !isFn(o.fetch)) throw new TypeError('createContext: fetch must be a function or null');
  if (o.client !== undefined && o.client !== null && (typeof o.client !== 'object' || !isFn(o.client.gql))) {
    throw new TypeError('createContext: client must be an Admin client with a gql function, or null');
  }
  return Object.freeze({
    repoRoot: o.repoRoot,
    imageRoot: o.imageRoot ?? null,
    env: Object.freeze({ ...o.env }),
    git: o.git ?? null,
    client: o.client ?? null,
    fetch: o.fetch ?? null,
    now: o.now,
    stateDir: o.stateDir,
    backupDir: o.backupDir ?? null,
    log: isFn(o.log) ? o.log : (s) => console.log(s),
    error: isFn(o.error) ? o.error : (s) => console.error(s),
    sleep: isFn(o.sleep) ? o.sleep : defaultSleep,
  });
}

/**
 * `CI` present in the environment is an unconditional refusal.
 *
 * PRESENCE, NOT TRUTHINESS. `CI=` (empty) and `CI=false` refuse too. The standing rule is that CI is
 * never unset, emptied, shadowed or overridden to get past this, and a truthiness check would make
 * emptying it work, which is the one thing the rule says must not. A developer shell that exports
 * `CI=false` for some other tool gets a refusal naming the variable, which is a cheap price.
 *
 * Checked from `ctx.env`, never from `process.env`, so a test proves it by injection.
 */
export function assertNotCI(env, command) {
  if (env && Object.prototype.hasOwnProperty.call(env, 'CI')) {
    throw new ArticleError(
      command,
      `refuses to run with CI set (CI=${JSON.stringify(env.CI)}). No workflow may run this, and no flag ` +
        'overrides it. Do not unset, empty or override CI to get past this refusal.',
    );
  }
}

export function requireClient(ctx, command) {
  if (!ctx.client) throw new ArticleError(command, 'needs an Admin client and the context holds none');
  return ctx.client;
}

export function requireGit(ctx, command) {
  if (!ctx.git) throw new ArticleError(command, 'needs a git runner and the context holds none');
  return ctx.git;
}

/**
 * Parse flags against a closed spec. Pure.
 *
 * `spec` maps each flag to `'boolean'` or `'string'`. An unknown flag, a positional argument, a
 * repeated flag, a string flag with no value, and a value on a boolean flag are all refusals: a
 * command that writes to the store must not guess which of two `--handle` values was meant.
 *
 * @param {string[]} argv  arguments only (no node, no script path)
 * @param {Record<string, 'boolean'|'string'>} spec
 * @param {string} command  for the refusal subject
 * @returns {Record<string, boolean|string|null>} every flag in `spec`, false or null when absent
 */
export function parseFlags(argv, spec, command) {
  const out = {};
  for (const [flag, kind] of Object.entries(spec)) out[flag] = kind === 'boolean' ? false : null;
  const seen = new Set();
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (!arg.startsWith('--')) throw new ArticleError(command, `unexpected argument ${JSON.stringify(arg)}`);
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const kind = spec[flag];
    if (kind === undefined) throw new ArticleError(command, `unknown flag ${flag}`);
    if (seen.has(flag)) throw new ArticleError(command, `${flag} was given more than once`);
    seen.add(flag);
    if (kind === 'boolean') {
      if (inline !== null) throw new ArticleError(command, `${flag} takes no value`);
      out[flag] = true;
      continue;
    }
    let value = inline;
    if (value === null) {
      const next = args[i + 1];
      if (next === undefined || String(next).startsWith('--')) throw new ArticleError(command, `${flag} expects a value`);
      value = String(next);
      i++;
    }
    if (value === '') throw new ArticleError(command, `${flag} expects a non-empty value`);
    out[flag] = value;
  }
  return out;
}

/**
 * Run a command and map its outcome to the published exit code.
 *
 * `run` resolves with `{ code }` (0 success or no-op, 2 drift from a read) or throws a refusal,
 * which is 1. Every `main` goes through this, and so do the exit-code tests, so the table in
 * scripts/articles/README.md is proved against the same mapping the CLI uses.
 */
export async function toExitCode(run, argv, ctx, command) {
  try {
    const result = await run(argv, ctx);
    const code = result?.code;
    if (code !== 0 && code !== 2) throw new ArticleError(command, `returned an unexpected exit code ${JSON.stringify(code)}`);
    return code;
  } catch (err) {
    const redact = ctx?.client && isFn(ctx.client.redact) ? ctx.client.redact : (s) => String(s);
    const error = ctx && isFn(ctx.error) ? ctx.error : (s) => console.error(s);
    error(`error: ${redact(err && err.message ? err.message : String(err))}`);
    error(`${command} refused or failed`);
    return 1;
  }
}
