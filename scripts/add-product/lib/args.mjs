// Flag parsing and handle resolution, shared by every command in this directory.
//
// One parser and one handle rule for all five commands. The handle names the state file and seeds
// every Admin read, so it is validated here and NEVER sanitised: a handle that needs cleaning up is
// a handle someone mistyped, and quietly correcting it reads (or writes) a different product than
// the one that was named.
//
// An unknown flag is an error for the same reason it is in scripts/policies/push.mjs. These flags
// decide what is read and, for add-option-value, what is written; a mistyped --expect-new-variants
// silently parsing as "no expectation" is exactly the failure the expectation exists to prevent.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The one handle shape. Anything else is refused, never trimmed or lowercased into shape. */
export const HANDLE_RE = /^[a-z0-9-]+$/;

/** Usage and refusal errors. `subject` is the flag, handle or step the message is about. */
export class AddProductError extends Error {
  constructor(subject, detail) {
    super(`${subject} ${detail}`);
    this.name = 'AddProductError';
    this.subject = subject;
  }
}

/**
 * Parse argv into positionals and flags.
 *
 * Both `--flag value` and `--flag=value` are accepted because both spellings appear in the README
 * and in the skill prose, and a parser that takes only one of them turns a documented example into
 * a confusing "unknown flag".
 *
 * @param {string[]} argv
 * @param {{booleans?: string[], values?: string[], repeatables?: string[]}} spec
 * @returns {{positionals: string[], flags: Record<string, any>}}
 */
export function parseArgs(argv, spec = {}) {
  const booleans = new Set(spec.booleans ?? []);
  const values = new Set(spec.values ?? []);
  const repeatables = new Set(spec.repeatables ?? []);

  const flags = {};
  for (const b of booleans) flags[camel(b)] = false;
  for (const v of values) flags[camel(v)] = null;
  for (const r of repeatables) flags[camel(r)] = [];

  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const [flag, inline] = eq === -1 ? [arg, null] : [arg.slice(0, eq), arg.slice(eq + 1)];
    const take = () => {
      if (inline !== null) return inline;
      const next = argv[++i];
      if (next === undefined) throw new AddProductError(flag, 'expects a value');
      return next;
    };
    if (booleans.has(flag)) {
      if (inline !== null) throw new AddProductError(flag, 'takes no value');
      flags[camel(flag)] = true;
    } else if (values.has(flag)) {
      flags[camel(flag)] = take();
    } else if (repeatables.has(flag)) {
      flags[camel(flag)].push(take());
    } else {
      throw new AddProductError(flag, 'is not a flag this command takes');
    }
  }
  return { positionals, flags };
}

function camel(flag) {
  return flag.replace(/^--/, '').replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/** Where scripts/sku/tables.json lives, resolved from this module rather than from cwd. */
export function tablesPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'sku', 'tables.json');
}

/** @returns {object} the parsed SKU code tables */
export function loadTables(file = tablesPath()) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Validate one handle. Returns it unchanged, so a caller cannot end up using a "fixed" one.
 * @param {string} handle
 * @returns {string}
 */
export function assertHandle(handle) {
  if (typeof handle !== 'string' || !HANDLE_RE.test(handle)) {
    throw new AddProductError(JSON.stringify(handle), `is not a valid handle (must match ${HANDLE_RE.source})`);
  }
  return handle;
}

/**
 * Resolve the handles a command runs over.
 *
 * `--all --namespace <ns>` derives them from scripts/sku/tables.json in FILE ORDER, which is the
 * order the option-value tooling reports and applies in. Sorting them here would let a dry run and
 * the live run it authorises disagree about which product is first, for no gain.
 *
 * @param {{all?: boolean, namespace?: string|null, handle?: string|null}} flags
 * @param {{tables?: object}} [deps]
 * @returns {string[]}
 */
export function resolveHandles(flags, deps = {}) {
  const { all = false, namespace = null, handle = null } = flags;
  if (all && handle !== null) throw new AddProductError('--all', 'and --handle are mutually exclusive; pass one');
  if (all) {
    if (!namespace) throw new AddProductError('--all', 'requires --namespace <ns>');
    const tables = deps.tables ?? loadTables();
    const products = tables.products ?? {};
    const hits = Object.keys(products).filter((h) => products[h]?.designNamespace === namespace);
    if (hits.length === 0) {
      throw new AddProductError('--namespace', `"${namespace}" matches no product in scripts/sku/tables.json`);
    }
    return hits.map(assertHandle);
  }
  if (handle === null) throw new AddProductError('--handle', 'is required (or --all --namespace <ns>)');
  const parts = handle.split(',').map((h) => h.trim());
  if (parts.some((h) => h === '')) throw new AddProductError('--handle', 'has an empty entry; the form is a,b,c');
  const seen = new Set();
  for (const h of parts) {
    assertHandle(h);
    if (seen.has(h)) throw new AddProductError(h, 'is named twice in --handle');
    seen.add(h);
  }
  return parts;
}

/** Shared flags for the handle-selecting commands, so every command spells them identically. */
export const HANDLE_FLAGS = { booleans: ['--all'], values: ['--namespace', '--handle'] };
