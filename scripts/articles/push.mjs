#!/usr/bin/env node
// Write one repo article to the live blog as a HIDDEN article. The only write path in this subsystem.
//
// This file does not spell its own npm script name or its module path, in any comment, message or
// usage line: every file under scripts/ is scanned by the no-invocation guard
// (test/no-invocation.test.mjs), and a printed command line is exactly what gets pasted into a
// script. scripts/articles/README.md describes how an operator runs it.
//
//   --handle <handle>                              dry run: resolve, compare, print, write nothing
//   --handle <handle> --confirm=<handle> \
//        --expect-live-sha=<sha>                   update, with the live sha the dry run printed
//   --handle <handle> --confirm=<handle> \
//        --expect-absent                           create, re-checked absent at push time
//
// THE TOOLING ONLY EVER CREATES OR UPDATES HIDDEN ARTICLES. Making a post visible is a hand action
// the operator takes in Admin. The mutation sends `isPublished: false` explicitly, the re-read fails
// loud if Admin reports the article visible, and this command refuses to write over an article that
// is already visible, because an update sends it hidden and would take a live post down.
//
// NOT CARRIED OVER FROM THE POLICIES PUSH, deliberately: the TTY and `--operator-approved` ceremony
// (this writes a hidden, reversible object, and legal-grade ceremony on a draft teaches that ceremony
// is noise), `--force-overwrite-live`, `--accept-normalisation`, `--allow-unreviewed`, and a gated
// `--restore`. ADDING ANY PUBLISH PATH REQUIRES RE-ADDING THE FULL AUTHORIZATION GATE.
//
// `CI` present is an unconditional refusal, dry run included, checked from `ctx.env`. It is the
// runtime half of the no-invocation guard: a command name assembled at runtime from pieces evades a
// static scan, and does not evade this. The push also runs in the session holding the operator's
// request, and is never delegated to a subagent, a background job, a `claude -p` child, a hook or a
// scheduled run.
//
// THE GATES, in order; `GATES` below is the list the suite proves one test per id against:
//    0 ci-refusal               CI present refuses, before anything else
//    1 confirm-matches-handle   --confirm, when given, equals --handle exactly
//    2 check-clean              articles:check finds nothing
//    3 reviewed-tree            fetch origin/main; this article, its previous handles and the
//                               manifest clean; HEAD an ancestor of origin/main
//    4 scopes                   write_online_store_pages and read_content granted
//    5 blog-resolution          exactly one blog with BLOG_HANDLE
//    6 live-read-freshness      a fresh live read; an existing live article with no observation for
//                               it refuses; a live article that moved since its observation refuses
//    7 gid-keyed-observation    the target resolves through previousHandles and its observation is
//                               read by GID, so renaming a directory cannot reset gate 6
//    8 no-op                    every written field already matches: record the observation, exit 0
//    9 dry-run-coupling         without --confirm, print and stop; with it, --expect-live-sha must
//                               equal the live sha now, or --expect-absent must still hold
//   10 backup                   before an update, a backup outside the checkout, read back and verified
//   11 intent-record            written before the mutation; one left by an earlier run refuses
//   12 hidden-explicit          the input carries isPublished false; a visible live article refuses
//   13 fail-closed              userErrors or a null article is a failure
//   14 reread-verify            re-read by GID; every written field and the hidden state compared
//   15 record-observation       recorded on every path after the mutation, including a failed re-read
//
// `run(argv, ctx)` takes everything from `ctx`, which has NO default client and NO default git:
// the real client and the real git runner are constructed in `main` only.

import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { assertScopes, backoffDelayMs, createAdminClient } from '../blank-inventory/lib/admin.mjs';
import { IMAGE_ROOT_DIR, REPO_ROOT, plan } from './check.mjs';
import { readRepoArticle, repoHandles } from './repo.mjs';
import { ARTICLES_DIR, BLOG_HANDLE, sha256 } from './lib/articles.mjs';
import { DIR_MODE, FILE_MODE, backupFileName, backupRecord, displayPath, resolveBackupDir } from './lib/backups.mjs';
import { ArticleError, assertNotCI, createContext, parseFlags, requireClient, requireGit, toExitCode } from './lib/context.mjs';
import { listBlogArticles, readArticle, resolveBlog, resolveTarget } from './lib/live.mjs';
import { ARTICLE_CREATE, ARTICLE_UPDATE, buildArticleInput } from './lib/mutations.mjs';
import { fieldDifferences, liveProjection, projectionSha } from './lib/projection.mjs';
import {
  CHECK_COMMAND,
  SEED_COMMAND,
  emptyState,
  intentFor,
  makeObservation,
  observationFor,
  readState,
  resolveStateDir,
  stateFilePath,
  withIntent,
  withObservation,
  withoutIntent,
  writeState,
} from './lib/state.mjs';

export const COMMAND = 'the article push';

/** Both are asserted by name: the write needs the first, and every gate here verifies with a read. */
export const PUSH_SCOPES = Object.freeze(['write_online_store_pages', 'read_content']);

export const SUCCESS_MARKER = 'article push wrote';

/** How many times gate 14 re-reads before calling a mismatch real. */
export const VERIFY_ATTEMPTS = 3;

export const FLAG_SPEC = Object.freeze({
  '--handle': 'string',
  '--confirm': 'string',
  '--expect-live-sha': 'string',
  '--expect-absent': 'boolean',
});

/** The gates, in order. The suite has one `[gate:<id>]` test per id, and a meta-test proves it. */
export const GATES = Object.freeze([
  'ci-refusal',
  'confirm-matches-handle',
  'check-clean',
  'reviewed-tree',
  'scopes',
  'blog-resolution',
  'live-read-freshness',
  'gid-keyed-observation',
  'no-op',
  'dry-run-coupling',
  'backup',
  'intent-record',
  'hidden-explicit',
  'fail-closed',
  'reread-verify',
  'record-observation',
]);

// ------------------------------------------------------------------------------------------
// Gate 3: the reviewed tree
// ------------------------------------------------------------------------------------------

/** The production git runner. `stdio` is piped so git's own messages land in the error, not the terminal. */
export function realGit(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * The bytes about to be sent are bytes a reviewer saw.
 *
 * FETCH FIRST. A local `origin/main` that is days stale would let an unmerged commit pass the ancestor
 * check (or refuse a merged one), so the gate fetches `origin main` and refuses when it cannot, naming
 * the command. Then the article's own directory, every previous handle's directory and the manifest
 * must be clean, untracked files and staged changes included (`--untracked-files=all`, and
 * `--no-renames` so a staged `git mv` of the directory shows as a delete plus an add under the
 * pathspec rather than as one rename entry the pathspec might not match). A dirty file in ANOTHER
 * article does not refuse: the pathspec is scoped on purpose. Last, HEAD must be an ancestor of
 * origin/main, which is true on main after the PR merges and false on the feature branch that made
 * the change. That makes a feature-branch push impossible by design.
 *
 * @param {string} root
 * @param {string[]} handles  this article's handle, then its previous handles
 * @param {{git?: Function}} [options]
 */
export function assertReviewedTree(root, handles, { git = realGit } = {}) {
  try {
    git(root, ['fetch', '--quiet', 'origin', 'main']);
  } catch (err) {
    throw new ArticleError(
      'origin/main',
      `could not be fetched (${String(err && err.message ? err.message : err).trim().split('\n')[0]}). ` +
        'The reviewed-tree gate compares against a fresh origin/main, never a cached one. Run git fetch origin main, then retry.',
    );
  }
  const pathspecs = [...handles.map((h) => `${ARTICLES_DIR}/${h}`), `${ARTICLES_DIR}/manifest.json`];
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=all', '--no-renames', '--', ...pathspecs]);
  if (dirty !== '') {
    throw new ArticleError(
      `${ARTICLES_DIR}/${handles[0]}`,
      `has uncommitted changes (or the manifest does); the push sends committed, reviewed bytes only:\n${dirty}`,
    );
  }
  let head;
  let base;
  try {
    head = git(root, ['rev-parse', 'HEAD']);
    base = git(root, ['rev-parse', 'origin/main']);
  } catch (err) {
    throw new ArticleError('git', `could not resolve HEAD and origin/main (${String(err && err.message ? err.message : err).trim().split('\n')[0]})`);
  }
  try {
    git(root, ['merge-base', '--is-ancestor', head, base]);
  } catch {
    throw new ArticleError(
      'HEAD',
      'is not an ancestor of origin/main, so these bytes have not been reviewed and merged. Merge the PR, ' +
        'switch to main and pull, then run the dry run from there. Do not commit to main to satisfy this gate; ' +
        'that removes the review it exists to require.',
    );
  }
}

// ------------------------------------------------------------------------------------------
// Gate 10: the backup
// ------------------------------------------------------------------------------------------

/** A path with every symlink in its existing prefix resolved. */
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

/** Refuse a backup directory inside the checkout, compared on real paths. */
export function assertBackupDirOutsideRepo(dir, root) {
  const d = realResolve(dir);
  const r = realResolve(root);
  if (d === r || d.startsWith(r + path.sep)) {
    throw new ArticleError(
      'backup directory',
      `resolves to ${displayPath(d)}, inside the checkout at ${displayPath(r)}. A backup holds a full article and ` +
        'this repository is public; it must live outside the tree.',
    );
  }
}

/**
 * Write the pre-update backup, fsync it, read it back, and verify it BEFORE any mutation.
 *
 * An existing file is a refusal, never an overwrite. The read-back is not ceremony: the backup is
 * the only record of what Admin held at the moment of the write, and a backup nobody has read is a
 * backup nobody knows exists. `readBack` is injectable so the suite proves the verification runs.
 *
 * @returns {string} the backup file's absolute path
 */
export function writeBackup({ dir, root, handle, now, record, readBack = (file) => readFileSync(file, 'utf8') }) {
  if (typeof dir !== 'string' || dir === '') throw new ArticleError('backup directory', 'none was configured; refusing to update without a backup');
  assertBackupDirOutsideRepo(dir, root);
  try {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    if (process.platform !== 'win32') chmodSync(dir, DIR_MODE);
  } catch (err) {
    throw new ArticleError('backup directory', `could not be created at ${displayPath(dir)} (${err.message}); refusing to update without a backup`);
  }
  const file = path.join(dir, backupFileName(handle, now));
  if (existsSync(file)) throw new ArticleError(displayPath(file), 'a backup with this name already exists; refusing to overwrite it');
  const text = `${JSON.stringify(record, null, 2)}\n`;
  const fd = openSync(file, 'wx', FILE_MODE);
  try {
    writeSync(fd, text, 0, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (process.platform !== 'win32') chmodSync(file, FILE_MODE);
  let parsed;
  try {
    parsed = JSON.parse(readBack(file));
  } catch (err) {
    throw new ArticleError(displayPath(file), `the backup could not be read back (${err.message}); refusing to mutate`);
  }
  if (parsed?.gid !== record.gid || projectionSha(liveProjection(parsed?.live)) !== record.liveSha256) {
    throw new ArticleError(displayPath(file), 'the backup read back with different content from what was fetched; refusing to mutate');
  }
  return file;
}

// ------------------------------------------------------------------------------------------
// The run
// ------------------------------------------------------------------------------------------

/**
 * Record one observation, re-reading the state first so an intent written earlier in this run is
 * kept or cleared on purpose, never lost. Any other observation still carrying the same handle is
 * dropped: a handle names one article at a time.
 */
function recordObservation(ctx, gid, observation, { clearIntentFor = null } = {}) {
  let state = readState({ dir: ctx.stateDir, root: ctx.repoRoot }) ?? emptyState();
  for (const [otherGid, entry] of Object.entries(state.articles)) {
    if (otherGid !== gid && entry?.handle === observation.handle) {
      const articles = { ...state.articles };
      delete articles[otherGid];
      state = { ...state, articles };
    }
  }
  state = withObservation(state, gid, observation);
  if (clearIntentFor !== null) state = withoutIntent(state, clearIntentFor);
  writeState({ dir: ctx.stateDir, root: ctx.repoRoot, state });
}

function updateRecovery(handle, backupFile) {
  return [
    `backup: ${displayPath(backupFile)}`,
    'To put the previous version back (copy, then push):',
    `  1. copy restore["body.html"] from the backup into ${ARTICLES_DIR}/${handle}/body.html, and restore["article.json"] into its article.json`,
    '  2. run npm run articles:reindex, then npm run articles:check',
    `  3. commit on a branch, merge the PR, then run the article push for ${handle} again from main`,
  ].join('\n');
}

function createRecovery(handle, gid) {
  return gid
    ? `This created a NEW hidden article (${gid}). To undo it, delete that article in Admin.`
    : `If the create landed, a hidden article now exists at "${handle}"; to undo it, delete that article in Admin.`;
}

/**
 * @param {string[]} argv  arguments only
 * @param {object} ctx     from createContext
 * @returns {Promise<{code: 0, reason: string}>}  refusals throw ArticleError
 */
export async function run(argv, ctx) {
  // Gate 0.
  assertNotCI(ctx.env, COMMAND);
  const flags = parseFlags(argv, FLAG_SPEC, COMMAND);
  const handle = flags['--handle'];
  if (handle === null) throw new ArticleError(COMMAND, 'needs --handle <handle>');

  // Gate 1.
  const confirm = flags['--confirm'];
  if (confirm !== null && confirm !== handle) {
    throw new ArticleError('--confirm', `must be exactly "${handle}", the --handle value; got ${JSON.stringify(confirm)}`);
  }
  if (flags['--expect-live-sha'] !== null && flags['--expect-absent']) {
    throw new ArticleError(COMMAND, '--expect-live-sha is for an update and --expect-absent for a create; not both');
  }
  const client = requireClient(ctx, COMMAND);
  const git = requireGit(ctx, COMMAND);
  const root = ctx.repoRoot;

  // Gate 2.
  let findings;
  try {
    ({ findings } = plan(root));
  } catch (err) {
    throw new ArticleError('articles:check', `could not read the tree (${err.message}); refusing to push`);
  }
  if (findings.length) {
    throw new ArticleError(
      'articles:check',
      `is not clean; refusing to push.\n${findings.map((f) => `  [${f.rule}] ${f.handle ? `${f.handle}: ` : ''}${f.detail}`).join('\n')}`,
    );
  }
  const repo = readRepoArticle(root, handle);
  const previousHandles = repo.article.previousHandles ?? [];

  // Gate 3.
  assertReviewedTree(root, [handle, ...previousHandles], { git });

  // Gate 4.
  try {
    await assertScopes(client, [...PUSH_SCOPES]);
  } catch (err) {
    throw new ArticleError('scopes', err.message);
  }

  // Gate 5.
  const blog = await resolveBlog(client);

  // Gate 6, first half: the live read happens now, never from a cache.
  const liveNodes = await listBlogArticles(client, blog.id);
  const state = readState({ dir: ctx.stateDir, root });

  // Gate 11, the reconcile half: an earlier run that never learned its outcome stops everything.
  const pending = intentFor(state, handle);
  if (pending) {
    throw new ArticleError(
      handle,
      `an earlier push (${pending.op}, started ${pending.at}) sent a write and never learned whether it landed. ` +
        `Until that is reconciled this article cannot be pushed: run ${CHECK_COMMAND} to see what Admin holds, ` +
        `then ${SEED_COMMAND} to record it and clear the record, then run the dry run again.`,
    );
  }

  // Gate 7: resolve by handle and previous handles; read the observation by GID.
  const target = resolveTarget(liveNodes, repo.article);
  const repoP = repo.projection;
  let liveP = null;
  let liveSha = null;
  if (target.kind === 'update') {
    liveP = liveProjection(target.node);
    liveSha = projectionSha(liveP);
    const observation = state === null ? undefined : observationFor(state, target.node.id);
    // Gate 6, second half. ABSENT STATE PLUS A LIVE ARTICLE IS A HARD REFUSAL: "no state file" is a
    // pass for a create only.
    if (!observation) {
      const why = state === null
        ? `there is no observation state at ${displayPath(stateFilePath(ctx.stateDir))}`
        : 'the observation state records nothing for it';
      throw new ArticleError(
        handle,
        `Admin already holds this article (${target.node.id}${target.renamed ? `, at its previous handle "${target.node.handle}"` : ''}) and ${why}. ` +
          `Without a baseline the freshness gate cannot tell your edit from an Admin edit. Run ${CHECK_COMMAND} ` +
          `to read both sides, then ${SEED_COMMAND}, then run the dry run again.`,
      );
    }
    if (observation.liveSha256 !== liveSha) {
      throw new ArticleError(
        handle,
        `Admin holds a version this machine has not seen (live ${liveSha}, last observed ${observation.liveSha256}). ` +
          `Someone edited or published it in Admin. Run ${CHECK_COMMAND}, bring the repo up to date with whichever ` +
          `version should win, then ${SEED_COMMAND} and run the dry run again.`,
      );
    }
  } else {
    // A create. Refuse one that is really a rename nobody recorded: a live article this machine has
    // observed, which no repo directory claims, is what a renamed directory without previousHandles
    // leaves behind, and creating here would put a second copy of the post in the blog.
    const handles = new Set(repoHandles(root));
    for (const node of liveNodes) {
      if (state !== null && observationFor(state, node.id) && !handles.has(node.handle)) {
        throw new ArticleError(
          handle,
          `would be CREATED, but Admin holds "${node.handle}" (${node.id}), which this machine has observed and which ` +
            `no repo directory claims. If this directory was renamed from "${node.handle}", add it to previousHandles ` +
            'so the push updates that article instead of creating a second one.',
        );
      }
    }
  }

  // Gate 8: every written field, not only the body.
  if (target.kind === 'update' && fieldDifferences(repoP, liveP).length === 0) {
    recordObservation(ctx, target.node.id, makeObservation({
      node: target.node,
      liveSha256: liveSha,
      bodySha256: sha256(liveP.body),
      matchedRepoSha256: repo.sha,
      now: ctx.now(),
    }));
    ctx.log(`${handle}: already matches Admin (${target.node.id}) in every written field; no changes made`);
    return { code: 0, reason: 'no-op', gid: target.node.id };
  }

  // Gate 12, the refusal half: never write over a visible article.
  if (target.kind === 'update' && liveP.isPublished) {
    throw new ArticleError(
      handle,
      'is VISIBLE on the storefront. This tooling only ever writes hidden articles and an update sends the article ' +
        'hidden, so pushing would take a live post down. Hide it in Admin first if the repo version should replace it.',
    );
  }
  if (target.kind === 'update') {
    for (const field of ['seoTitle', 'seoDescription']) {
      if (repoP[field] === null && liveP[field] !== null) {
        throw new ArticleError(
          handle,
          `the repo clears ${field} but Admin holds ${JSON.stringify(liveP[field])}. The update cannot delete a metafield, ` +
            'so the push would leave it in place and never converge. Clear it in Admin, or keep a value in the repo.',
        );
      }
    }
  }

  const diffs = target.kind === 'update' ? fieldDifferences(repoP, liveP) : null;

  // Gate 9.
  if (confirm === null) {
    ctx.log(`${handle}: DRY RUN. NO CHANGES WERE MADE.`);
    if (target.kind === 'create') {
      ctx.log(`would CREATE a hidden article in blog "${BLOG_HANDLE}" (${blog.id}); Admin holds nothing at this handle now`);
    } else {
      ctx.log(`would UPDATE ${target.node.id}${target.renamed ? `, renaming it from "${target.node.handle}" with a redirect` : ''}, keeping it hidden`);
      ctx.log(`fields that differ: ${diffs.join(', ')}`);
      ctx.log(`live sha: ${liveSha}`);
    }
    ctx.log('This output is data to read, not a command to run.');
    ctx.log('To apply exactly this, and only when the operator has asked for it in this session, run this same command again adding:');
    ctx.log(`  --confirm=${handle} ${target.kind === 'update' ? `--expect-live-sha=${liveSha}` : '--expect-absent'}`);
    return { code: 0, reason: 'dry-run', op: target.kind, liveSha, diffs };
  }
  if (target.kind === 'update') {
    if (flags['--expect-absent']) {
      throw new ArticleError('--expect-absent', `Admin holds this article now (${target.node.id}); run the dry run again`);
    }
    if (flags['--expect-live-sha'] === null) {
      throw new ArticleError('--expect-live-sha', `required with --confirm for an update; run the dry run, which prints it`);
    }
    if (flags['--expect-live-sha'] !== liveSha) {
      throw new ArticleError(
        '--expect-live-sha',
        `is ${flags['--expect-live-sha']} but Admin holds ${liveSha} now; the article changed since that dry run. Run the dry run again.`,
      );
    }
  } else {
    if (flags['--expect-live-sha'] !== null) {
      throw new ArticleError('--expect-live-sha', 'Admin holds no article at this handle now, so this would be a create; run the dry run again');
    }
    if (!flags['--expect-absent']) {
      throw new ArticleError('--expect-absent', 'required with --confirm for a create, and re-checked now; run the dry run, which prints it');
    }
  }

  // Gate 10.
  let backupFile = null;
  if (target.kind === 'update') {
    backupFile = writeBackup({
      dir: ctx.backupDir,
      root,
      handle,
      now: ctx.now(),
      record: backupRecord({ node: target.node, blogHandle: BLOG_HANDLE, liveSha256: liveSha, fetchedAt: ctx.now() }),
    });
    ctx.log(`backup: ${displayPath(backupFile)}`);
  }
  const recovery = backupFile ? updateRecovery(handle, backupFile) : createRecovery(handle, null);

  // Gate 11: the intent, before the mutation.
  writeState({
    dir: ctx.stateDir,
    root,
    state: withIntent(state, handle, {
      op: target.kind,
      gid: target.node?.id ?? null,
      sentSha256: repo.sha,
      at: ctx.now(),
      backup: backupFile ? displayPath(backupFile) : null,
    }),
  });

  // Gate 12: hidden, sent explicitly.
  const input = buildArticleInput({ op: target.kind, repo: repoP, blogId: blog.id, renamed: target.renamed });
  const [document, variables, rootField] = target.kind === 'update'
    ? [ARTICLE_UPDATE, { id: target.node.id, article: input }, 'articleUpdate']
    : [ARTICLE_CREATE, { article: input }, 'articleCreate'];

  // Gate 13.
  let response;
  try {
    response = await client.gql(document, variables);
  } catch (err) {
    throw new ArticleError(
      handle,
      `the write's outcome is UNKNOWN (${err && err.message ? err.message : String(err)}): it may or may not have landed. ` +
        `The interrupted-push record is kept and the next push refuses until it is reconciled: run ${CHECK_COMMAND}, ` +
        `then ${SEED_COMMAND}. Do not simply re-run.\n${recovery}`,
    );
  }
  const payload = response?.[rootField];
  const userErrors = Array.isArray(payload?.userErrors) ? payload.userErrors : [];
  if (userErrors.length > 0) {
    // A userErrors response is a KNOWN outcome: Shopify refused, nothing was written.
    writeState({ dir: ctx.stateDir, root, state: withoutIntent(readState({ dir: ctx.stateDir, root }), handle) });
    const detail = userErrors
      .map((e) => `  ${Array.isArray(e?.field) ? e.field.join('.') : (e?.field ?? '(no field)')}: ${e?.message}${e?.code ? ` [${e.code}]` : ''}`)
      .join('\n');
    throw new ArticleError(rootField, `returned userErrors; nothing was written.\n${detail}`);
  }
  const gid = payload?.article?.id;
  if (typeof gid !== 'string' || gid === '') {
    throw new ArticleError(
      rootField,
      `returned no article and no userErrors, so the outcome is unknown. The interrupted-push record is kept: run ` +
        `${CHECK_COMMAND}, then ${SEED_COMMAND}.\n${recovery}`,
    );
  }
  const finalRecovery = backupFile ? recovery : createRecovery(handle, gid);

  // Gate 14. A thrown read retries: this is a read after a write that landed, so retrying is safe
  // and giving up early is not.
  let stored = null;
  let lastReadError = null;
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
    if (attempt > 0) await ctx.sleep(backoffDelayMs(attempt - 1));
    try {
      stored = await readArticle(client, gid);
      lastReadError = null;
    } catch (err) {
      stored = null;
      lastReadError = err;
      continue;
    }
    if (stored !== null && fieldDifferences(repoP, liveProjection(stored)).length === 0) break;
  }

  // Gate 15, on every path from here.
  if (stored === null) {
    recordObservation(ctx, gid, makeObservation({
      node: { handle, blog: { id: blog.id }, isPublished: false },
      liveSha256: projectionSha(repoP),
      bodySha256: sha256(repoP.body),
      matchedRepoSha256: null,
      now: ctx.now(),
      unverified: true,
    }));
    throw new ArticleError(
      handle,
      `the write was accepted (${gid}) but could not be read back after ${VERIFY_ATTEMPTS} attempts ` +
        `(${lastReadError ? String(lastReadError.message ?? lastReadError) : 'Admin returned no article'}). The observation is ` +
        `recorded as unverified and the interrupted-push record is kept. Do NOT re-run: run ${CHECK_COMMAND}, then ${SEED_COMMAND}.\n${finalRecovery}`,
    );
  }
  const storedP = liveProjection(stored);
  const storedDiffs = fieldDifferences(repoP, storedP);
  recordObservation(ctx, gid, makeObservation({
    node: stored,
    liveSha256: projectionSha(storedP),
    bodySha256: sha256(storedP.body),
    matchedRepoSha256: storedDiffs.length === 0 ? repo.sha : null,
    now: ctx.now(),
  }), { clearIntentFor: handle });
  if (storedP.isPublished) {
    throw new ArticleError(
      handle,
      `ADMIN REPORTS THIS ARTICLE AS VISIBLE (${gid}) after a write that sent it hidden. Hide it in Admin now, then find out why.\n${finalRecovery}`,
    );
  }
  if (storedDiffs.length > 0) {
    throw new ArticleError(
      handle,
      `Admin stored something different from what was sent, in: ${storedDiffs.join(', ')}. The observation records what ` +
        `Admin holds. Run ${CHECK_COMMAND} to see it.\n${finalRecovery}`,
    );
  }
  ctx.log(`${SUCCESS_MARKER} ${handle} (${gid}): hidden, every written field verified by re-read`);
  ctx.log(finalRecovery);
  return { code: 0, reason: target.kind, gid, backupFile };
}

/**
 * The CLI. The CI refusal and the argument parse happen before any client exists; the real client
 * and the real git runner are constructed here and nowhere else.
 */
export async function main(argv) {
  const args = argv.slice(2);
  try {
    assertNotCI(process.env, COMMAND);
    parseFlags(args, FLAG_SPEC, COMMAND);
  } catch (err) {
    console.error(`error: ${err.message}`);
    console.error(`${COMMAND} refused; nothing was written`);
    return 1;
  }
  let client;
  try {
    client = createAdminClient();
  } catch (err) {
    console.error(`error: ${err && err.message ? err.message : String(err)}`);
    console.error(`${COMMAND} failed; nothing was written`);
    return 1;
  }
  const ctx = createContext({
    repoRoot: REPO_ROOT,
    imageRoot: path.join(REPO_ROOT, IMAGE_ROOT_DIR),
    env: process.env,
    git: realGit,
    client,
    now: () => new Date().toISOString(),
    stateDir: resolveStateDir(process.env),
    backupDir: resolveBackupDir(process.env),
  });
  return toExitCode(run, args, ctx, COMMAND);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`error: ${err && err.message ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
