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
// EVERY COMPARISON HERE RUNS ON THE CORE BODY, with the version stamp stripped from both sides.
// `coreSha256` is the wording; the manifest's `sha256` is the committed bytes and is never
// compared against anything live. Comparing a stamped repo body against an unstamped live one is
// how the stamp self-trips its own gate, so each site below names its hash.
//
// Gate sequence, in order, any failure aborting with a non-zero exit and no mutation:
//   1. a known, writable --type; not CI (absolute); a TTY on stdin OR --operator-approved
//   2. policies:check clean; ALL of marketing/policies/ clean in git; HEAD an ancestor of
//      origin/main, so the pushed bytes are the reviewed bytes
//   3. fetch live; identical CORE means exit 0 with no mutation
//   4. freshness: the live CORE hash must equal the one the machine-local state file records.
//      NO STATE FILE IS A REFUSAL naming `npm run policies:pull`; there is no auto-seed.
//   5. without --confirm this is the dry run, which prints the SAME hash the gate checks
//   6. the monotonic version floor, then a backup: write, fsync, read back, assert its core hash
//      equals the live body just fetched
//   7. mutate; fail closed on userErrors or a null shopPolicy
//   8. re-read and verify on the CORE; a heading change is never accepted as normalisation
//   9. record the observation in state, and print the exact --restore and commit commands
//
// A SUCCESSFUL PUSH LEAVES THE WORKING TREE CLEAN. That is why gate 2 can require all of
// marketing/policies/ to be clean again: the observation it records goes to the machine-local
// state file, not to the manifest. The version bookkeeping that used to make every push dirty its
// own tree, and therefore block the next push until a PR merged, is gone.
//
// ONE REFINEMENT TO "no mutation on a failure": that holds absolutely for every gate BEFORE the
// mutation, and those refusals leave the tree byte-identical. AFTER the mutation has landed, a
// refusal still leaves the repo untouched, but it does record the observation in state, because
// state means "what Admin was last seen holding" and Admin has demonstrably moved. Leaving it
// stale is not neutrality, it is a false record, and it is what made the documented
// `--accept-normalisation` recovery unreachable: the re-run tripped the freshness gate at step 4
// and was pointed at `--force-overwrite-live` to fix a whitespace difference.
//
// `run({ client, root, ... })` takes NO defaults for `client` or `root`: real-client construction
// and root defaulting live in `main` only, so a test that forgets to inject the fake cannot reach
// the live store.

import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { assertScopes, backoffDelayMs, createAdminClient } from '../blank-inventory/lib/admin.mjs';
import { paths, plan, readManifest, REPO_ROOT } from './check.mjs';
import {
  SEED_COMMAND,
  emptyState,
  floorFor,
  readState,
  recordObservation,
  resolveStateDir,
  stateEntry,
  stateFilePath,
  writeState,
} from './lib/state.mjs';
import { POLICIES_QUERY, indexPolicies } from './pull.mjs';
import { backupFileName, displayPath, resolveBackupDir, DIR_MODE, FILE_MODE } from './lib/backups.mjs';
import { differsOnlyByEntitiesAndWhitespace, unifiedDiff } from './lib/diff.mjs';
import {
  POLICY_TYPES,
  WRITABLE,
  PolicyError,
  assertVersionFloor,
  bodyFromFileText,
  canonicalise,
  coreOf,
  coreSha256,
  decodeEntities,
  diffHeadings,
  extractHeadings,
  fileNameForType,
  fileTextFor,
  formatManifest,
  isStamped,
  keyForType,
  parseVersionStamp,
  sha256,
  stampVersion,
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
 * ALL of marketing/policies/ must be clean, and HEAD must be an ancestor of origin/main, so the
 * bytes about to reach customers are bytes a reviewer saw. `--allow-unreviewed` is the deliberate
 * escape hatch for the ancestor half (a canary before the PR merges, say); it never waives the
 * dirty check.
 *
 * THIS USED TO BE MORE COMPLICATED, AND THE COMPLICATION IS GONE ON PURPOSE. A successful push
 * used to write `remote` and `pulledAt` into the manifest, which meant the gate blocked the next
 * push on its own side effect: a PR per push, forever. PR #154 answered that by teaching the gate
 * to ignore exactly those two fields, which cost a HEAD read, a JSON reshape and a field
 * allowlist. Moving the observation to the machine-local state file removes the cause instead, so
 * the gate goes back to one question with one answer. Do not reintroduce a per-field exemption:
 * if a push ever needs to write to the manifest again, that is the thing to fix.
 *
 * Not applied to `--restore`, whose bytes come from a backup file rather than the tree.
 */
export function assertReviewedTree(root, { allowUnreviewed = false, run = git } = {}) {
  const dirty = run(root, ['status', '--porcelain', '--', 'marketing/policies']);
  if (dirty !== '') {
    throw new PolicyError(
      'marketing/policies',
      `has uncommitted changes; commit or stash them first:\n${dirty}`,
    );
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
      'is not an ancestor of origin/main, so these bytes have not been reviewed and merged.\n' +
        '  Merge the PR, then: git switch main && git pull\n' +
        '  Then re-run the dry run from main and push from there.\n' +
        'WHY: being on main here is a consequence of the bytes being reviewed, never a licence to ' +
        'commit to main. Do not commit the wording change directly to main to satisfy this gate; ' +
        'that removes the review this gate exists to require.\n' +
        '`--allow-unreviewed` is for a deliberate pre-merge canary and nothing else.',
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
  // `mkdirSync`'s mode argument applies only to a directory it CREATES, and is masked by umask
  // besides. An existing 0755 state directory would silently keep its mode, and the file below
  // holds a full policy body. Set it explicitly. POSIX only: chmod is close to a no-op on Windows.
  if (process.platform !== 'win32') chmodSync(dir, DIR_MODE);
  const file = join(dir, backupFileName(type, now));
  if (existsSync(file)) throw new PolicyError(file, 'a backup with this name already exists; refusing to overwrite it');
  const record = {
    id: live.id ?? null,
    type,
    title: live.title,
    body: live.body,
    sha256: sha256(canonicalise(live.body)),
    coreSha256: coreSha256(live.body),
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
  // Same reasoning as the directory: `openSync`'s mode is masked by umask, and umask can only
  // remove bits from 0600, but saying it explicitly is what the test can assert.
  if (process.platform !== 'win32') chmodSync(file, FILE_MODE);
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
 * @param {string} o.stateDir        where observed.json lives; a refusal when it holds nothing
 * @param {string} o.domain
 * @param {(s: string) => void} [o.log]
 * @param {(ms: number) => Promise<void>} [o.sleep]
 */
export async function run({ client, root, now, options, backupDir, stateDir, domain, log = console.log, sleep = defaultSleep }) {
  if (!client || typeof client.gql !== 'function') throw new Error('policies:push needs an Admin client');
  if (typeof root !== 'string' || root === '') throw new Error('policies:push needs a root');
  if (typeof now !== 'string' || now === '') throw new Error('policies:push needs an ISO timestamp');
  if (typeof stateDir !== 'string' || stateDir === '') throw new Error('policies:push needs a state directory');

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
  // The stamp travels WITH the body (it is what makes the live page identify its own version), but
  // it is stripped from both sides of every comparison below.
  const sendCore = coreSha256(sendBody);

  // Step 3. Fetch live, and stop before anything else if there is nothing to do. On the CORE:
  // until the first stamped push lands, live carries no stamp and the repo does, and that is
  // "in sync", not a difference to push.
  const live = await fetchLive(client, type);
  const liveCore = coreSha256(live.body);
  if (liveCore === sendCore) {
    log(`${key}: already in sync (core sha ${liveCore}); no changes made`);
    if (!restoring) log('The live body may still be missing the version stamp; that is expected until the next real wording change.');
    return { mutated: false, reason: 'in-sync', liveCore, sendCore };
  }

  // Step 4. Freshness, against the machine-local observation state.
  //
  // A live body that is not the one this machine last observed means someone edited the policy in
  // Admin since the last pull, and pushing would silently clobber that edit. A restore is the
  // deliberate exception: it exists precisely to overwrite what is live now.
  //
  // NO STATE FILE IS A REFUSAL, not a warning and not an auto-seed. Seeding it here would mean
  // minting the baseline from the very read the gate is supposed to check against, which is not a
  // check at all. This is the migration window: between PR A merging and the operator running one
  // `policies:pull`, push does not work, on purpose.
  const state = readState({ dir: stateDir, root });
  const manifest = readManifest(root);
  const entry = manifest.policies[key];
  if (!restoring) {
    if (state === null) {
      throw new PolicyError(
        key,
        `there is no observation state at ${stateFilePath(stateDir)}, so the freshness gate has nothing ` +
          `to compare against and cannot tell your edit from someone else's Admin edit. Run ` +
          `${SEED_COMMAND} once to seed it, then re-run the dry run.`,
      );
    }
    const observed = stateEntry(state, key);
    if (!observed || typeof observed.coreSha256 !== 'string') {
      throw new PolicyError(
        key,
        `the observation state at ${stateFilePath(stateDir)} records nothing for this policy. ` +
          `Run ${SEED_COMMAND} once to seed it, then re-run the dry run.`,
      );
    }
    if (liveCore !== observed.coreSha256) {
      if (!options.forceOverwriteLive) {
        throw new PolicyError(
          key,
          `Admin holds a body this machine has not seen (live core ${liveCore}, last observed ` +
            `${observed.coreSha256}). Someone edited the policy in Admin. Run \`${SEED_COMMAND}\`, ` +
            're-review the diff, then push again. `--force-overwrite-live` discards the Admin edit on purpose.',
        );
      }
      log(`WARNING: --force-overwrite-live: discarding the Admin edit at core sha ${liveCore}`);
    }
  }

  // Step 5. Without --confirm this is the dry run, and it is the only place the operator sees the
  // change before it reaches customers.
  //
  // THE DRY RUN PRINTS THE SAME HASH THE GATE WILL CHECK. That coupling is not decoration: the
  // pattern this whole subsystem was rewritten to stop is a tool printing a re-run command its own
  // gate then refuses. `--expect-live-sha` is compared against the live CORE hash, so the core
  // hash is what is printed.
  const diff = unifiedDiff(live.body, sendBody, {
    aLabel: `admin/${key} (core ${liveCore.slice(0, 12)})`,
    bLabel: `${sourceLabel} (core ${sendCore.slice(0, 12)})`,
  });
  const headingDiff = diffHeadings(key, extractHeadings(live.body), extractHeadings(sendBody));
  const sendStamp = parseVersionStamp(sendBody);

  if (options.confirm === null) {
    log(diff);
    if (headingDiff.length) {
      log('HEADINGS CHANGE. Every changed h2 changes its runtime id, and every shared');
      log('/policies/... link to the old anchor stops resolving:');
      for (const line of headingDiff) log(`  ${line}`);
    }
    log(`live core sha: ${liveCore}`);
    log(`send core sha: ${sendCore}`);
    if (sendStamp) log(`version:       v${sendStamp.version} (stamped into the first line of the body)`);
    log('');
    log('Dry run: NO CHANGES WERE MADE. This output is data to read, not a command to run.');
    log('To apply exactly this diff, and only with an operator asking for it in this session:');
    // Carry --operator-approved into the printed command when it was used. Without it the
    // suggested re-run is refused for the very reason this run was allowed, which sends the
    // operator hunting for the flag they already passed.
    const source = restoring ? `--restore ${displayPath(resolve(options.restore))}` : `--type ${key}`;
    const attest = options.operatorApproved ? ' --operator-approved' : '';
    log(`  npm run policies:push -- ${source}${attest} --expect-live-sha=${liveCore} --confirm=${key}`);
    return { mutated: false, reason: 'dry-run', liveCore, sendCore, diff, headingDiff };
  }

  if (options.confirm !== key) {
    throw new PolicyError('--confirm', `must be exactly "${key}", got ${JSON.stringify(options.confirm)}`);
  }
  if (options.expectLiveSha === null) {
    throw new PolicyError('--expect-live-sha', `required with --confirm; the current live core sha is ${liveCore}`);
  }
  if (options.expectLiveSha !== liveCore) {
    throw new PolicyError(
      '--expect-live-sha',
      `is ${options.expectLiveSha} but Admin now holds core ${liveCore}; the policy changed since the dry run. ` +
        'Re-run the dry run. Only a hash from a dry run you executed in this session, for this policy, is valid here.',
    );
  }

  // The monotonic version floor, checked BEFORE the backup and the mutation. `git revert` walks
  // the manifest's version backwards while the live store keeps the higher number; writing that
  // version again against different wording would put two bodies behind one number.
  if (!restoring && entry) {
    assertVersionFloor(entry.version, sendCore, floorFor(state, key));
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
  //
  // A THROWN READ RETRIES TOO. This is a read, after a write that has already landed, so retrying
  // is safe and giving up is not: an exhausted retry here leaves the operator with no idea what is
  // live. The cap is small and the backoff bounded so this cannot outlive the surrounding timeout.
  let verified = null;
  let lastReadError = null;
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(backoffDelayMs(attempt - 1));
    try {
      verified = await fetchLive(client, type);
      lastReadError = null;
    } catch (err) {
      lastReadError = err;
      continue;
    }
    if (coreSha256(verified.body) === sendCore) break;
  }
  if (verified === null) {
    // The write landed and we cannot see what it landed as. Say exactly that, and hand over the
    // one command that puts the pre-push body back. Do NOT re-run the push: an unknown outcome is
    // not a retry.
    recordState(stateDir, root, key, { body: sendBody, now, pushedVersion: sendStamp?.version ?? null, pushedStamped: sendStamp !== null });
    throw new PolicyError(
      key,
      `the write was accepted but the live body could NOT be read back after ${VERIFY_ATTEMPTS} attempts ` +
        `(${String(lastReadError?.message ?? lastReadError).trim()}). The store has been changed and this ` +
        'tool cannot say to what.\n' +
        '  Do NOT re-run the push. Run `npm run policies:verify` first and read what live actually says.\n' +
        `  To put the previous body back: ${restoreCommand}`,
    );
  }
  const verifiedCore = coreSha256(verified.body);
  const verifiedStamp = parseVersionStamp(verified.body);

  if (verifiedCore === sendCore) {
    recordState(stateDir, root, key, {
      body: verified.body,
      now,
      pushedVersion: sendStamp?.version ?? null,
      pushedStamped: sendStamp !== null,
    });
    log(`${SUCCESS_MARKER} ${key} (core sha ${verifiedCore}${sendStamp ? `, v${sendStamp.version}` : ''})`);
    if (sendStamp && verifiedStamp === null) {
      // The first stamped push is also the experiment that answers this, and the answer changes
      // what `policies:verify` can assert. Say it out loud rather than leaving it to be inferred.
      log('NOTE: Shopify stored the body without the version stamp comment, so it strips HTML comments.');
      log('      Every comparison here runs on the core, so nothing is broken; but the live page');
      log('      cannot self-identify, and policies:verify falls back to the core hash.');
    }
    if (restoring) log('The repo copy still holds its own version; run `npm run policies:pull` to reconcile.');
    log(`to undo: ${restoreCommand}`);
    if (!restoring) logCommitHint(log);
    return { mutated: true, liveCore, sendCore, verifiedCore, backupFile, normalised: false };
  }

  // The write landed but Shopify stored something else. A heading change is NEVER normalisation:
  // it is an anchor break, so leave the repo file alone and let the operator look.
  const verifiedHeadings = diffHeadings(key, extractHeadings(sendBody), extractHeadings(verified.body));
  if (verifiedHeadings.length) {
    // Same reasoning as the write-back path below: the write landed, so state records what Admin
    // holds. The repo BODY is deliberately left alone, because this is an anchor break.
    recordState(stateDir, root, key, { body: verified.body, now });
    throw new PolicyError(
      key,
      'Admin stored a body whose HEADINGS differ from what was sent. That is an anchor break, not ' +
        `renormalisation; the repo file is untouched.\n${verifiedHeadings.map((m) => `  ${m}`).join('\n')}\n` +
        `Restore with: ${restoreCommand}`,
    );
  }

  const writeBackDiff = unifiedDiff(sendBody, verified.body, {
    aLabel: `sent (core ${sendCore.slice(0, 12)})`,
    bLabel: `stored by Shopify (core ${verifiedCore.slice(0, 12)})`,
  });
  log(writeBackDiff);

  // Record what Admin now holds BEFORE refusing. The write landed; the state file is the record of
  // the last observed Admin body, and it would be a lie to leave it pointing at the pre-push value.
  //
  // It is also what makes the `--accept-normalisation` instruction below reachable. Without this,
  // the re-run trips the freshness gate at step 4 (live has moved, the observation has not), and
  // its message sends the operator to `--force-overwrite-live`: two documented instructions in
  // sequence landing on the most dangerous flag in the set, to fix a whitespace difference.
  recordState(stateDir, root, key, { body: verified.body, now });

  // Only an entity- or whitespace-level difference may ever be taken back into the repo. Anything
  // else is Shopify storing different CONTENT, which no flag here accepts.
  if (!differsOnlyByEntitiesAndWhitespace(coreOf(sendBody), coreOf(verified.body), decodeEntities)) {
    throw new PolicyError(
      key,
      `Admin stored a body that differs from what was sent by more than entity and whitespace spelling ` +
        `(sent core ${sendCore}, stored core ${verifiedCore}). The repo file is untouched and ` +
        `--accept-normalisation does not cover this. Look at the diff above.\nRestore with: ${restoreCommand}`,
    );
  }
  if (restoring) {
    throw new PolicyError(
      key,
      `Admin renormalised the RESTORED body it stored (sent core ${sendCore}, stored core ${verifiedCore}). ` +
        'A restore never writes to the repo, so there is no write-back to accept: the previous body is ' +
        'back on the store in Shopify\'s spelling. Run `npm run policies:pull` to reconcile the repo.',
    );
  }
  if (!options.acceptNormalisation) {
    throw new PolicyError(
      key,
      `Admin renormalised the body it stored (sent core ${sendCore}, stored core ${verifiedCore}); the ` +
        'difference is entity and whitespace spelling only. The repo file is untouched, and the ' +
        'observation state now records what Admin holds, so the re-run below passes the freshness gate. ' +
        "Re-run with --accept-normalisation to take Shopify's version into the repo:\n" +
        `  npm run policies:push -- --type ${key} --expect-live-sha=${verifiedCore} --confirm=${key} --accept-normalisation`,
    );
  }

  // The observation was already recorded above, before the two refusals; only the repo body and
  // the manifest's derived fields move here. The VERSION does not: this is the same version, as
  // Shopify chose to spell it, so re-deriving would invent a v+1 that was never pushed.
  acceptWriteBack(root, type, entry?.version ?? null, isStamped(entry), verified.body);
  recordState(stateDir, root, key, {
    body: verified.body,
    now,
    pushedVersion: entry?.version ?? null,
    pushedStamped: verifiedStamp !== null,
  });
  log(`${SUCCESS_MARKER} ${key} (core sha ${verifiedCore}, write-back accepted)`);
  log('Commit the write-back on its own branch; it is a change to marketing/policies/ like any other.');
  log(`to undo: ${restoreCommand}`);
  logCommitHint(log);
  return { mutated: true, liveCore, sendCore, verifiedCore, backupFile, normalised: true, writeBackDiff };
}

/**
 * The commit command to run next, printed after a successful push.
 *
 * DELIBERATELY BODY-ONLY, with no trailer of any kind: no `Claude-Session:`, no `claude.ai/code`
 * URL, no `Co-Authored-By`. A template printed by a tool becomes the shape of every future policy
 * commit, so an attribution line here would be permanent. A test asserts this string carries
 * neither.
 *
 * On the clean path there is usually nothing to commit at all, which is the point of moving the
 * observation out of the repo. This prints only when something in the tree did move.
 */
export const COMMIT_HINT = [
  'If the working tree moved (a write-back), commit it on its own branch:',
  '  git switch -c policies/<what-changed>',
  '  git add marketing/policies',
  '  git commit -m "<what changed, in one line>"',
];

function logCommitHint(log) {
  log('');
  for (const line of COMMIT_HINT) log(line);
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function writeAtomic(target, text) {
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, target);
}

/**
 * Take Shopify's renormalised body back into the repo, at the SAME version.
 *
 * The version does not move: this is the version that was just pushed, as Shopify chose to spell
 * it. Re-deriving would invent a v+1 that was never pushed anywhere, and the stamp would then name
 * a version the live store has never seen.
 */
function acceptWriteBack(root, type, version, stamped, storedBody) {
  const key = keyForType(type);
  const core = coreOf(storedBody);
  const written = stamped && Number.isInteger(version) ? stampVersion(core, key, version) : core;
  writeAtomic(paths(root).file(type), fileTextFor(written));

  const p = paths(root);
  const manifest = readManifest(root);
  const entry = manifest.policies[key];
  if (!entry) throw new PolicyError(key, 'has no manifest entry to update');
  entry.coreSha256 = sha256(core);
  entry.sha256 = sha256(written);
  entry.length = written.length;
  entry.headings = extractHeadings(core);
  writeAtomic(p.manifest, formatManifest(manifest));
}

/**
 * Record what Admin was just seen holding, in the machine-local state file.
 *
 * Never in the repo. That is the whole change: a push used to dirty its own working tree with this
 * observation, which meant the dirty-tree gate blocked the next push until a PR had merged.
 */
function recordState(stateDir, root, key, { body, now, pushedVersion = null, pushedStamped = null }) {
  const current = readStateOrEmpty(stateDir, root);
  current.policies[key] = recordObservation(current.policies[key], { body, now, pushedVersion, pushedStamped });
  writeState({ dir: stateDir, root, state: current });
}

function readStateOrEmpty(stateDir, root) {
  const state = readState({ dir: stateDir, root });
  return state ?? emptyState();
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

/**
 * The CLI. Exported for the end-to-end tests: the gates in `run` are unit-tested, but the ORDER
 * in which `main` applies the argument, operator and repo gates is its own contract, and every
 * one of those refusals must happen before an Admin client is ever constructed.
 */
export async function main(argv) {
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

  // Constructing the client is inside a try of its own: `createAdminClient()` reads
  // MYSHOPIFY_DOMAIN eagerly and throws synchronously on an unset one, and a `main` that can throw
  // instead of returning an exit code is a `main` whose refusals cannot be tested. No token has
  // been minted at this point, so the message carries no secret and is printed raw.
  let client;
  try {
    client = createAdminClient();
  } catch (err) {
    console.error(`error: ${err && err.message ? err.message : String(err)}`);
    console.error('policies:push failed');
    return 1;
  }

  try {
    if (options.restoreRecord === null) assertReviewedTree(root, { allowUnreviewed: options.allowUnreviewed });
    await assertScopes(client, PUSH_SCOPES);
    await run({
      client,
      root,
      now: new Date().toISOString(),
      options,
      backupDir: resolveBackupDir(process.env),
      stateDir: resolveStateDir(process.env),
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
  // The .catch is a backstop, not the primary handler: `main` now returns an exit code for the
  // eager-env case too (see the client construction above). It stays because an unhandled promise
  // rejection from anywhere else would otherwise print a stack trace instead of this tool's
  // ordinary `error:` + exit 1.
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
