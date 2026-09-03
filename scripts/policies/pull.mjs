#!/usr/bin/env node
// Pull the live shop policies from Admin into marketing/policies/.
//
// Reads through the read-only client (scripts/site-check/lib/admin-readonly.mjs), which refuses
// any document containing a mutation before it reaches the network, so this tool cannot write to
// the store even by accident.
//
//   npm run policies:pull                 write the files and the manifest
//   npm run policies:pull -- --check      report drift, write nothing
//
// Exit codes: 0 clean, 1 the tool failed (auth, network, a refusal), 2 drift found in --check
// mode. Two codes because "Admin and the repo disagree" is a normal, actionable state and must be
// distinguishable from "the check never ran".
//
// `run({ client, root, now })` takes NO defaults for `client` or `root`: constructing the real
// client and defaulting the root live in `main` only, so a test that forgets to inject the fake
// cannot reach the live store.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertScopes, createAdminClient } from '../blank-inventory/lib/admin.mjs';
import { createReadOnlyClient } from '../site-check/lib/admin-readonly.mjs';
import { paths, readManifest, REPO_ROOT } from './check.mjs';
import {
  POLICY_TYPES,
  PolicyError,
  buildEntry,
  canonicalise,
  fileTextFor,
  sha256,
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
 * @param {boolean} [o.checkOnly]      report drift, write nothing
 * @returns {Promise<{changed: string[], written: string[], manifestChanged: boolean}>}
 */
export async function run({ client, root, now, checkOnly = false }) {
  if (!client || typeof client.gql !== 'function') throw new Error('policies:pull needs an Admin client');
  if (typeof root !== 'string' || root === '') throw new Error('policies:pull needs a root');
  if (typeof now !== 'string' || now === '') throw new Error('policies:pull needs an ISO timestamp');

  const p = paths(root);
  const data = await client.gql(POLICIES_QUERY);
  const live = indexPolicies(data?.shop?.shopPolicies);

  const manifest = existsSync(p.manifest) ? readManifest(root) : { policies: {} };
  const next = { ...manifest, policies: { ...manifest.policies } };
  const changed = [];
  const files = [];
  const directions = new Map();

  for (const type of POLICY_TYPES) {
    const key = keyForType(type);
    const { title, body } = live.get(type);
    const canonical = canonicalise(body);
    const text = fileTextFor(canonical);
    const file = p.file(type);
    const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (current !== text) {
      changed.push(key);
      files.push({ file, text });
      // WHICH SIDE MOVED. `remote.sha256` is what Admin was last seen holding, so:
      //   live == remote  ->  Admin has not moved; the REPO is ahead and a push is outstanding.
      //   live != remote  ->  Admin was edited since the last pull.
      // The two need opposite actions, and pulling in the first case destroys the committed edit.
      const recorded = manifest.policies?.[key]?.remote?.sha256 ?? null;
      directions.set(key, sha256(canonical) === recorded ? 'repo-ahead' : 'admin-moved');
    }
    next.policies[key] = buildEntry(manifest.policies?.[key], { type, title, body: canonical, now });
  }

  const before = existsSync(p.manifest) ? readFileSync(p.manifest, 'utf8') : null;
  const after = formatManifest(next);
  const manifestChanged = before !== after;

  if (checkOnly) return { changed, written: [], manifestChanged, directions };

  // Manifest first, then the files. FAIL-LOUD, NOT SELF-HEALING: either write order leaves a tree
  // that `policies:check` refuses, and the recovery is re-running this command. Do not "fix" the
  // ordering to make a partial run look clean; that would hide a half-applied pull.
  if (!existsSync(p.dir)) mkdirSync(p.dir, { recursive: true });
  if (manifestChanged) writeAtomic(p.manifest, after);
  for (const { file, text } of files) writeAtomic(file, text);

  return { changed, written: files.map(({ file }) => file), manifestChanged, directions };
}

async function main(argv) {
  const args = argv.slice(2);
  const checkOnly = args.includes('--check');
  const rootFlag = args.indexOf('--root');
  const root = rootFlag !== -1 ? resolve(args[rootFlag + 1]) : REPO_ROOT;
  const client = createReadOnlyClient(createAdminClient());

  let result;
  try {
    await assertScopes(client, READ_SCOPES);
    result = await run({ client, root, now: new Date().toISOString(), checkOnly });
  } catch (err) {
    const redact = typeof client.redact === 'function' ? client.redact : (s) => String(s);
    console.error(`error: ${redact(err && err.message ? err.message : String(err))}`);
    console.error('policies:pull failed');
    return 1;
  }

  const { changed, written, manifestChanged, directions } = result;
  if (checkOnly) {
    if (changed.length === 0 && !manifestChanged) {
      console.log('policies:pull --check: marketing/policies/ matches Admin');
      return 0;
    }
    // Naming the DIRECTION is the whole point. The old message said "run policies:pull" for every
    // drift, which in the repo-ahead case is the destructive action: it overwrites the committed
    // wording change with the body Admin still holds, and there is no dirty-tree check to stop it.
    const adminMoved = changed.filter((k) => directions.get(k) === 'admin-moved');
    const repoAhead = changed.filter((k) => directions.get(k) === 'repo-ahead');
    for (const key of repoAhead) {
      console.error(`drift: ${key}.html - the REPO is ahead; Admin still holds the last body we observed.`);
      console.error(`       A push is outstanding: npm run policies:push -- --type ${key}`);
      console.error('       Do NOT run policies:pull for this one; it would overwrite the committed change.');
    }
    for (const key of adminMoved) {
      console.error(`drift: ${key}.html - ADMIN has moved since the last pull.`);
      console.error('       Run npm run policies:pull and review the diff.');
    }
    if (manifestChanged && changed.length === 0) console.error('drift: manifest.json would change');
    console.error(
      `policies:pull --check found drift: ${repoAhead.length} outstanding push(es), ${adminMoved.length} Admin edit(s).` +
        (repoAhead.length && !adminMoved.length ? ' Nothing to pull.' : ''),
    );
    return 2;
  }

  for (const file of written) console.log(`wrote ${file}`);
  if (manifestChanged) console.log('wrote manifest.json');
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
