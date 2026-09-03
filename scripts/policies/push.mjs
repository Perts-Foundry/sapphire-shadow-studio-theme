#!/usr/bin/env node
// Push one repo policy body to Admin with `shopPolicyUpdate`. THE ONLY WRITE PATH IN THIS
// SUBSYSTEM, and the only tool here that can change what a customer reads.
//
//   npm run policies:push -- --type shipping_policy            dry run: print the diff, write nothing
//   npm run policies:push -- --type shipping_policy \
//        --expect-live-sha=<sha> --confirm=shipping_policy     the real write
//   npm run policies:push -- --restore <backup-file> --confirm=<type>
//
// THE SINGLE MOST LIKELY SILENT FAILURE: `shopPolicyUpdate` returns HTTP 200 on a REJECTED write.
// Transport success proves nothing. Step 7 fails closed on a non-empty `userErrors` or a null
// `shopPolicy`, and step 8 re-reads the live body rather than trusting the response echo.
//
// Gate sequence, in order, any failure aborting with a non-zero exit and no mutation:
//   1. a known, writable --type; not CI (absolute); a TTY on stdin OR --operator-approved
//   2. policies:check clean; clean working tree under marketing/policies/; HEAD an ancestor of
//      origin/main, so the pushed bytes are the reviewed bytes
//   3. fetch live; identical to the repo body means exit 0 with no mutation
//   4. freshness: live sha must equal the manifest's remote.sha256
//   5. without --confirm this is the dry run
//   6. backup: write, fsync, read back, assert its sha equals the live body just fetched
//   7. mutate; fail closed on userErrors or a null shopPolicy
//   8. re-read and verify; a heading change is never accepted as normalisation
//   9. print the exact --restore command
//
// ONE REFINEMENT TO "no mutation on a failure": that holds absolutely for every gate BEFORE the
// mutation, and those refusals leave the tree byte-identical. AFTER the mutation has landed, a
// refusal still leaves the repo BODY untouched, but it does record the manifest's `remote` token,
// because `remote` means "what Admin was last seen holding" and Admin has demonstrably moved.
// Leaving it stale is not neutrality, it is a false record, and it is what made the documented
// `--accept-normalisation` recovery unreachable: the re-run tripped the freshness gate at step 4
// and was pointed at `--force-overwrite-live` to fix a whitespace difference.
//
// `run({ client, root, ... })` takes NO defaults for `client` or `root`: real-client construction
// and root defaulting live in `main` only, so a test that forgets to inject the fake cannot reach
// the live store.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { assertScopes, backoffDelayMs, createAdminClient } from '../blank-inventory/lib/admin.mjs';
import { paths, plan, readManifest, REPO_ROOT } from './check.mjs';
import { POLICIES_QUERY, indexPolicies } from './pull.mjs';
import { backupFileName, displayPath, resolveBackupDir, DIR_MODE, FILE_MODE } from './lib/backups.mjs';
import { differsOnlyByEntitiesAndWhitespace, unifiedDiff } from './lib/diff.mjs';
import {
  POLICY_TYPES,
  WRITABLE,
  PolicyError,
  bodyFromFileText,
  canonicalise,
  decodeEntities,
  diffHeadings,
  extractHeadings,
  fileNameForType,
  fileTextFor,
  formatManifest,
  keyForType,
  remoteToken,
  sha256,
  typeForKey,
} from './lib/policies.mjs';

/** Writing a legal policy needs both: the read is how every gate here verifies its own work. */
export const PUSH_SCOPES = ['read_legal_policies', 'write_legal_policies'];

export const PUSH_MUTATION = `mutation PoliciesPush($shopPolicy: ShopPolicyInput!) {
  shopPolicyUpdate(shopPolicy: $shopPolicy) {
    shopPolicy { id type title body }
    userErrors { code field message }
  }
}`;

export const SUCCESS_MARKER = 'policies:push wrote';

/** How many times step 8 re-reads before calling a mismatch real. */
export const VERIFY_ATTEMPTS = 3;

// ------------------------------------------------------------------------------------------
// Argument parsing (step 1)
// ------------------------------------------------------------------------------------------

/**
 * Parse the CLI arguments. Pure, so every refusal in step 1 is testable without a client.
 *
 * `--confirm` must EQUAL the `--type` value. A bare boolean `--confirm` is copy-pasteable out of
 * shell history and is exactly the shape an agent reproduces from a README example; requiring the
 * policy name means one run's confirmation cannot be reused for a different policy by accident.
 */
export function parseArgs(args) {
  const out = {
    type: null,
    confirm: null,
    expectLiveSha: null,
    restore: null,
    restoreRecord: null,
    root: null,
    acceptNormalisation: false,
    forceOverwriteLive: false,
    allowUnreviewed: false,
    operatorApproved: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf('=');
    const [flag, inlineValue] = eq === -1 ? [arg, null] : [arg.slice(0, eq), arg.slice(eq + 1)];
    const value = () => {
      if (inlineValue !== null) return inlineValue;
      const next = args[++i];
      if (next === undefined) throw new PolicyError(flag, 'expects a value');
      return next;
    };
    switch (flag) {
      case '--type': out.type = value(); break;
      case '--confirm': out.confirm = value(); break;
      case '--expect-live-sha': out.expectLiveSha = value(); break;
      case '--restore': out.restore = value(); break;
      case '--root': out.root = value(); break;
      case '--accept-normalisation': out.acceptNormalisation = true; break;
      case '--force-overwrite-live': out.forceOverwriteLive = true; break;
      case '--allow-unreviewed': out.allowUnreviewed = true; break;
      case '--operator-approved': out.operatorApproved = true; break;
      default: throw new PolicyError(flag, 'unknown flag');
    }
  }
  return out;
}

/**
 * Resolve `--type` (or a restore file's recorded type) to a ShopPolicyType, refusing an unknown
 * one and refusing a non-writable one HERE rather than discovering the refusal at the API.
 */
export function resolveType(raw) {
  if (raw === null || raw === undefined || raw === '') {
    throw new PolicyError('--type', `required; one of ${POLICY_TYPES.filter((t) => WRITABLE[t]).map(keyForType).join(', ')}`);
  }
  const type = typeForKey(raw) ?? (POLICY_TYPES.includes(String(raw)) ? String(raw) : null);
  if (type === null) throw new PolicyError(String(raw), 'not a tracked policy');
  if (!WRITABLE[type]) {
    throw new PolicyError(keyForType(type), 'is not writable: Shopify auto-manages it and shopPolicyUpdate is refused on it');
  }
  return type;
}

/**
 * The operator gate. A write to a legal policy is an operator action, never a CI one.
 *
 * Two ways to satisfy it, and one that is absolute:
 *
 * - `CI` set is an UNCONDITIONAL refusal. No workflow in this repo wires `policies:push`, a test
 *   asserts that, and no flag here can override it. That is the blast-radius boundary: CI never
 *   holds a credential that can rewrite a legal policy.
 * - A TTY on stdin means a person is running it by hand. The ordinary case.
 * - `--operator-approved` is the explicit attestation for the case where the operator has asked an
 *   agent to run the push in that session. It exists because the alternative people actually reach
 *   for is wrapping the command in a pty to fake a TTY, which defeats the check silently and
 *   teaches that the gate is routable. An honest flag that shows up in the shell history and in
 *   this tool's own output is strictly better than a faked terminal.
 *
 * This flag does NOT authorize a particular write. It only attests that a human asked. Everything
 * that decides WHAT gets written is unchanged and still required: `--confirm=<type>` matching
 * `--type`, `--expect-live-sha` from the tool's own dry run, the freshness gate against
 * `remote.sha256`, a clean `policies:check`, a clean tree merged into main, and a verified backup
 * before the mutation.
 *
 * @returns {{ via: 'tty' | 'operator-approval' }} how the gate was satisfied, for the log line
 */
export function assertInteractive({ env, isTTY, operatorApproved = false }) {
  if (env.CI) {
    throw new PolicyError('policies:push', 'refuses to run with CI set; no workflow may write a legal policy, and no flag overrides this');
  }
  if (isTTY) return { via: 'tty' };
  if (operatorApproved) return { via: 'operator-approval' };
  throw new PolicyError(
    'policies:push',
    'refuses to run without a TTY on stdin. This is an operator-only command. If an operator has ' +
      'asked for this write in this session, pass --operator-approved to say so explicitly. Do NOT ' +
      'wrap the command in a pty to fake a TTY: that defeats the check silently, and the flag is ' +
      'the supported way to do the same thing honestly.',
  );
}

// ------------------------------------------------------------------------------------------
// Repo gates (step 2)
// ------------------------------------------------------------------------------------------

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

/**
 * The working tree under marketing/policies/ must be clean and HEAD must be an ancestor of
 * origin/main, so the bytes about to reach customers are bytes a reviewer saw. `--allow-unreviewed`
 * is the deliberate escape hatch (a canary before the PR merges, say); it is reported loudly.
 *
 * Not applied to `--restore`, whose bytes come from a backup file rather than the tree.
 */
export function assertReviewedTree(root, { allowUnreviewed = false, run = git } = {}) {
  const dirty = run(root, ['status', '--porcelain', '--', 'marketing/policies']);
  if (dirty !== '') {
    throw new PolicyError('marketing/policies', `has uncommitted changes; commit or stash them first:\n${dirty}`);
  }
  if (allowUnreviewed) return { unreviewed: true };
  let head;
  let base;
  try {
    head = run(root, ['rev-parse', 'HEAD']);
    base = run(root, ['rev-parse', 'origin/main']);
  } catch (err) {
    throw new PolicyError('git', `could not resolve HEAD and origin/main (${String(err.message).trim()}); fetch first, or pass --allow-unreviewed`);
  }
  try {
    run(root, ['merge-base', '--is-ancestor', head, base]);
  } catch {
    throw new PolicyError(
      'HEAD',
      'is not an ancestor of origin/main, so these bytes have not been reviewed and merged. ' +
        'Merge the PR first, or pass --allow-unreviewed for a deliberate pre-merge canary.',
    );
  }
  return { unreviewed: false };
}

// ------------------------------------------------------------------------------------------
// The backup (step 6)
// ------------------------------------------------------------------------------------------

/**
 * Write the pre-mutation backup, fsync it, read it back, and assert its recorded body hashes to
 * the live body just fetched. Any failure aborts BEFORE the mutation: a write with no verified
 * backup is a write with no way back.
 *
 * The backup is the full object (id, type, title, body, store domain, fetch time), not just the
 * body, so a restore needs nothing but the file. An existing file is a refusal rather than an
 * overwrite: the one thing a backup must never do is destroy an older backup.
 */
export function writeBackup({ dir, type, live, now, domain }) {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const file = join(dir, backupFileName(type, now));
  if (existsSync(file)) throw new PolicyError(file, 'a backup with this name already exists; refusing to overwrite it');
  const record = {
    id: live.id ?? null,
    type,
    title: live.title,
    body: live.body,
    sha256: sha256(canonicalise(live.body)),
    fetchedAt: now,
    storeDomain: domain,
  };
  const text = `${JSON.stringify(record, null, 2)}\n`;
  const fd = openSync(file, 'wx', FILE_MODE);
  try {
    writeSync(fd, text, 0, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const readBack = JSON.parse(readFileSync(file, 'utf8'));
  if (readBack.type !== type) throw new PolicyError(file, 'backup read back with the wrong type; refusing to mutate');
  if (sha256(canonicalise(readBack.body)) !== record.sha256) {
    throw new PolicyError(file, 'backup read back with a different body; refusing to mutate');
  }
  return { file, record };
}

// ------------------------------------------------------------------------------------------
// The run
// ------------------------------------------------------------------------------------------

async function fetchLive(client, type) {
  const data = await client.gql(POLICIES_QUERY);
  const rows = data?.shop?.shopPolicies;
  indexPolicies(rows); // the same refusals pull applies: no missing type, no empty body
  const row = rows.find((r) => r.type === type);
  return { id: row.id, title: row.title, body: canonicalise(row.body) };
}

/**
 * @param {object} o
 * @param {{gql: Function}} o.client
 * @param {string} o.root
 * @param {string} o.now             ISO-8601 timestamp for this run
 * @param {object} o.options         parseArgs output, with `type` already resolved
 * @param {string} o.backupDir
 * @param {string} o.domain
 * @param {(s: string) => void} [o.log]
 * @param {(ms: number) => Promise<void>} [o.sleep]
 */
export async function run({ client, root, now, options, backupDir, domain, log = console.log, sleep = defaultSleep }) {
  if (!client || typeof client.gql !== 'function') throw new Error('policies:push needs an Admin client');
  if (typeof root !== 'string' || root === '') throw new Error('policies:push needs a root');
  if (typeof now !== 'string' || now === '') throw new Error('policies:push needs an ISO timestamp');

  const { type } = options;
  const key = keyForType(type);
  const restoring = options.restoreRecord !== null && options.restoreRecord !== undefined;
  const p = paths(root);

  // Step 2. The repo must be self-consistent before a single byte of it is sent anywhere. Skipped
  // when restoring, whose bytes come from a backup file rather than from the tree.
  if (!restoring) {
    const { problems, mismatches } = plan(root);
    if (problems.length || mismatches.length) {
      throw new PolicyError(
        'policies:check',
        `is not clean; refusing to push.\n${[...problems, ...mismatches].map((m) => `  ${m}`).join('\n')}`,
      );
    }
  }

  const sourceLabel = restoring ? `backup/${key}` : `repo/${fileNameForType(type)}`;
  const sendBody = restoring
    ? canonicalise(options.restoreRecord.body)
    : bodyFromFileText(readFileSync(p.file(type), 'utf8'));
  const sendSha = sha256(sendBody);

  // Step 3. Fetch live, and stop before anything else if there is nothing to do.
  const live = await fetchLive(client, type);
  const liveSha = sha256(live.body);
  if (liveSha === sendSha) {
    log(`${key}: already in sync (sha ${liveSha}); no changes made`);
    return { mutated: false, reason: 'in-sync', liveSha, sendSha };
  }

  // Step 4. Freshness. A live body that is not the one the manifest last observed means someone
  // edited the policy in Admin since the last pull, and pushing would silently clobber that edit.
  // A restore is the deliberate exception: it exists precisely to overwrite what is live now.
  const manifest = readManifest(root);
  const recorded = manifest.policies[key]?.remote?.sha256 ?? null;
  if (!restoring && liveSha !== recorded) {
    if (!options.forceOverwriteLive) {
      throw new PolicyError(
        key,
        `Admin holds a body this repo has not seen (live ${liveSha}, manifest remote ${recorded}). ` +
          'Someone edited the policy in Admin. Run `npm run policies:pull`, re-review the diff, then push again. ' +
          '`--force-overwrite-live` discards the Admin edit on purpose.',
      );
    }
    log(`WARNING: --force-overwrite-live: discarding the Admin edit at sha ${liveSha}`);
  }

  // Step 5. Without --confirm this is the dry run, and it is the only place the operator sees the
  // change before it reaches customers.
  const diff = unifiedDiff(live.body, sendBody, {
    aLabel: `admin/${key} (${liveSha.slice(0, 12)})`,
    bLabel: `${sourceLabel} (${sendSha.slice(0, 12)})`,
  });
  const headingDiff = diffHeadings(key, extractHeadings(live.body), extractHeadings(sendBody));

  if (options.confirm === null) {
    log(diff);
    if (headingDiff.length) {
      log('HEADINGS CHANGE. Every changed h2 changes its runtime id, and every shared');
      log('/policies/... link to the old anchor stops resolving:');
      for (const line of headingDiff) log(`  ${line}`);
    }
    log(`live sha: ${liveSha}`);
    log(`send sha: ${sendSha}`);
    log('');
    log('Dry run: NO CHANGES WERE MADE. To apply exactly this diff, re-run:');
    const source = restoring ? `--restore ${options.restore}` : `--type ${key}`;
    log(`  npm run policies:push -- ${source} --expect-live-sha=${liveSha} --confirm=${key}`);
    return { mutated: false, reason: 'dry-run', liveSha, sendSha, diff, headingDiff };
  }

  if (options.confirm !== key) {
    throw new PolicyError('--confirm', `must be exactly "${key}", got ${JSON.stringify(options.confirm)}`);
  }
  if (options.expectLiveSha === null) {
    throw new PolicyError('--expect-live-sha', `required with --confirm; the current live sha is ${liveSha}`);
  }
  if (options.expectLiveSha !== liveSha) {
    throw new PolicyError(
      '--expect-live-sha',
      `is ${options.expectLiveSha} but Admin now holds ${liveSha}; the policy changed since the dry run. Re-run the dry run.`,
    );
  }

  // Step 6. Backup, verified, before any mutation.
  const { file: backupFile } = writeBackup({ dir: backupDir, type, live, now, domain });
  const restoreCommand = `npm run policies:push -- --restore ${displayPath(backupFile)} --confirm=${key}`;
  log(`backup: ${displayPath(backupFile)}`);

  // Step 7. Mutate. HTTP 200 proves nothing; the response is what has to be read.
  const result = await client.gql(PUSH_MUTATION, { shopPolicy: { type, body: sendBody } });
  const payload = result?.shopPolicyUpdate;
  const userErrors = payload?.userErrors ?? [];
  if (userErrors.length > 0) {
    const detail = userErrors
      .map((e) => `  ${Array.isArray(e.field) ? e.field.join('.') : (e.field ?? '(no field)')}: ${e.message}${e.code ? ` [${e.code}]` : ''}`)
      .join('\n');
    throw new PolicyError('shopPolicyUpdate', `returned userErrors; NOTHING WAS WRITTEN LOCALLY.\n${detail}`);
  }
  if (!payload || !payload.shopPolicy) {
    throw new PolicyError('shopPolicyUpdate', 'returned no shopPolicy and no userErrors; treating as a failed write');
  }

  // Step 8. Verify by re-reading, not by trusting the mutation's echo. A stale replica read is
  // indistinguishable from renormalisation at the comparison point, so retry before believing it.
  let verified = null;
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(backoffDelayMs(attempt - 1));
    verified = await fetchLive(client, type);
    if (sha256(verified.body) === sendSha) break;
  }
  const verifiedSha = sha256(verified.body);

  if (verifiedSha === sendSha) {
    updateManifest(root, key, { remoteBody: verified.body, now });
    log(`${SUCCESS_MARKER} ${key} (sha ${verifiedSha})`);
    if (restoring) log('The repo copy still holds its own version; run `npm run policies:pull` to reconcile.');
    log(`to undo: ${restoreCommand}`);
    return { mutated: true, liveSha, sendSha, verifiedSha, backupFile, normalised: false };
  }

  // The write landed but Shopify stored something else. A heading change is NEVER normalisation:
  // it is an anchor break, so leave the repo file alone and let the operator look.
  const verifiedHeadings = diffHeadings(key, extractHeadings(sendBody), extractHeadings(verified.body));
  if (verifiedHeadings.length) {
    // Same reasoning as the write-back path below: the write landed, so `remote` records what
    // Admin holds. The repo BODY is deliberately left alone, because this is an anchor break.
    updateManifest(root, key, { remoteBody: verified.body, now });
    throw new PolicyError(
      key,
      'Admin stored a body whose HEADINGS differ from what was sent. That is an anchor break, not ' +
        `renormalisation; the repo file is untouched.\n${verifiedHeadings.map((m) => `  ${m}`).join('\n')}\n` +
        `Restore with: ${restoreCommand}`,
    );
  }

  const writeBackDiff = unifiedDiff(sendBody, verified.body, {
    aLabel: `sent (${sendSha.slice(0, 12)})`,
    bLabel: `stored by Shopify (${verifiedSha.slice(0, 12)})`,
  });
  log(writeBackDiff);

  // Record what Admin now holds BEFORE refusing. The write landed; `remote` is the record of the
  // last observed Admin body, and it would be a lie to leave it pointing at the pre-push value.
  //
  // It is also what makes the `--accept-normalisation` instruction below reachable. Without this,
  // the re-run trips the freshness gate at step 4 (live has moved, `remote` has not), and its
  // message sends the operator to `--force-overwrite-live`: two documented instructions in
  // sequence landing on the most dangerous flag in the set, to fix a whitespace difference.
  updateManifest(root, key, { remoteBody: verified.body, now });

  // Only an entity- or whitespace-level difference may ever be taken back into the repo. Anything
  // else is Shopify storing different CONTENT, which no flag here accepts.
  if (!differsOnlyByEntitiesAndWhitespace(sendBody, verified.body, decodeEntities)) {
    throw new PolicyError(
      key,
      `Admin stored a body that differs from what was sent by more than entity and whitespace spelling ` +
        `(sent ${sendSha}, stored ${verifiedSha}). The repo file is untouched and --accept-normalisation ` +
        `does not cover this. Look at the diff above.\nRestore with: ${restoreCommand}\n` +
        'The manifest\'s remote token now records what Admin holds, so commit that before anything else.',
    );
  }
  if (!options.acceptNormalisation) {
    throw new PolicyError(
      key,
      `Admin renormalised the body it stored (sent ${sendSha}, stored ${verifiedSha}); the difference is ` +
        'entity and whitespace spelling only. The repo file is untouched, and the manifest\'s remote token ' +
        'now records what Admin holds, so the re-run below passes the freshness gate. Re-run with ' +
        `--accept-normalisation to take Shopify's version into the repo:\n` +
        `  npm run policies:push -- --type ${key} --expect-live-sha=${verifiedSha} --confirm=${key} --accept-normalisation`,
    );
  }

  // `remote` was already recorded above, before the two refusals; only the body fields move here.
  writePolicyFile(root, type, verified.body);
  updateManifest(root, key, { storedBody: verified.body, now });
  log(`${SUCCESS_MARKER} ${key} (sha ${verifiedSha}, write-back accepted)`);
  log('Commit the write-back on its own branch; it is a change to marketing/policies/ like any other.');
  log(`to undo: ${restoreCommand}`);
  return { mutated: true, liveSha, sendSha, verifiedSha, backupFile, normalised: true, writeBackDiff };
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function writeAtomic(target, text) {
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, target);
}

function writePolicyFile(root, type, body) {
  writeAtomic(paths(root).file(type), fileTextFor(body));
}

/**
 * Record what Admin now holds.
 *
 * On the clean path only `remote` moves: `pulledAt` stays put, because the repo file was not
 * refreshed from Admin, it WAS the source of the write. On the write-back path the body moved too,
 * so sha256, length and headings are rebuilt alongside it.
 */
function updateManifest(root, key, { remoteBody, storedBody, now }) {
  const p = paths(root);
  const manifest = readManifest(root);
  const entry = manifest.policies[key];
  if (!entry) throw new PolicyError(key, 'has no manifest entry to update');
  if (remoteBody !== undefined) entry.remote = remoteToken(remoteBody, now);
  if (storedBody !== undefined) {
    const canonical = canonicalise(storedBody);
    entry.sha256 = sha256(canonical);
    entry.length = canonical.length;
    entry.headings = extractHeadings(canonical);
  }
  writeAtomic(p.manifest, formatManifest(manifest));
}

// ------------------------------------------------------------------------------------------
// CLI
// ------------------------------------------------------------------------------------------

export function loadRestore(file) {
  if (!existsSync(file)) throw new PolicyError(file, 'no such backup file');
  const record = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof record.body !== 'string' || record.body === '') throw new PolicyError(file, 'backup holds no body');
  if (sha256(canonicalise(record.body)) !== record.sha256) {
    throw new PolicyError(file, 'backup body does not match its recorded sha256');
  }
  return record;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv.slice(2));
    const gate = assertInteractive({
      env: process.env,
      isTTY: Boolean(process.stdin.isTTY),
      operatorApproved: options.operatorApproved,
    });
    // Never let the non-TTY path be silent. If this line is in a transcript, an operator asked.
    if (gate.via === 'operator-approval') {
      console.log('policies:push: running without a TTY under --operator-approved (an operator asked for this write).');
    }
    if (options.restore !== null) {
      options.restoreRecord = loadRestore(resolve(options.restore));
      options.type = resolveType(options.restoreRecord.type);
    } else {
      options.type = resolveType(options.type);
    }
  } catch (err) {
    console.error(`error: ${err.message}`);
    console.error('policies:push refused; nothing was written');
    return 1;
  }

  const root = options.root !== null ? resolve(options.root) : REPO_ROOT;
  const domain = process.env.MYSHOPIFY_DOMAIN ?? '(unset)';
  const client = createAdminClient();

  try {
    if (options.restoreRecord === null) assertReviewedTree(root, { allowUnreviewed: options.allowUnreviewed });
    await assertScopes(client, PUSH_SCOPES);
    await run({
      client,
      root,
      now: new Date().toISOString(),
      options,
      backupDir: resolveBackupDir(process.env),
      domain,
    });
    return 0;
  } catch (err) {
    const redact = typeof client.redact === 'function' ? client.redact : (s) => String(s);
    console.error(`error: ${redact(err && err.message ? err.message : String(err))}`);
    console.error('policies:push failed');
    return 1;
  }
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
      console.error('policies:push failed');
      process.exitCode = 1;
    });
}
