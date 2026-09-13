#!/usr/bin/env node
// Where every blog article stands, and the one step that moves each one forward.
//
//   npm run articles:status             offline: the repo against this machine's last observation
//   npm run articles:status -- --live   plus a read of the live blog, so "Admin moved" is reportable
//
// OFFLINE BY DEFAULT. Without `--live` no Admin client is constructed at all.
//
// IT DEGRADES, IT DOES NOT REFUSE, on state: no state file and a corrupt state file are both REPORTED,
// because a status command that refuses to say where you are has failed at its only job. A repo tree
// that cannot be read, or a live read that fails, is a failure (exit 1).
//
// Exit codes: 0 every article in sync, 2 anything actionable, 1 could not run.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertScopes, createAdminClient } from '../blank-inventory/lib/admin.mjs';
import { createReadOnlyClient } from '../site-check/lib/admin-readonly.mjs';
import { REPO_ROOT } from './check.mjs';
import { readRepoArticle, repoHandles } from './repo.mjs';
import { STATES, classifyLive, classifyOffline, nextStep } from './lib/classify.mjs';
import { ArticleError, createContext, parseFlags, requireClient, toExitCode } from './lib/context.mjs';
import { listBlogArticles, resolveBlog, resolveTarget } from './lib/live.mjs';
import { READ_SCOPES } from './lib/queries.mjs';
import { describeState, readState, resolveStateDir } from './lib/state.mjs';

export const COMMAND = 'articles:status';
export const FLAG_SPEC = Object.freeze({ '--live': 'boolean' });

/**
 * The report, as lines. Pinned by the suite.
 *
 * `state.display` collapses $HOME: this output is exactly what gets pasted into a PR on a public repo.
 */
export function format({ rows, notes, state, live }) {
  const lines = [];
  lines.push(`state:  ${state.display}${state.exists ? '' : ' (ABSENT)'}`);
  lines.push(
    live
      ? 'live:   read from Admin'
      : 'live:   NOT READ. This compares against the last observation; pass --live to report an Admin edit.',
  );
  lines.push('');
  if (rows.length === 0) lines.push('no articles in marketing/articles/');
  for (const row of rows) {
    lines.push(row.handle);
    lines.push(`  ${row.status}${row.published ? ' (VISIBLE on the storefront)' : ''}`);
    lines.push(`  next: ${nextStep(row.status, row.handle)}`);
  }
  if (notes.length) {
    lines.push('');
    for (const n of notes) lines.push(`note: ${n}`);
  }
  return lines;
}

export async function run(argv, ctx) {
  const flags = parseFlags(argv, FLAG_SPEC, COMMAND);
  const root = ctx.repoRoot;
  const notes = [];

  let state = null;
  let stateReadable = true;
  try {
    state = readState({ dir: ctx.stateDir, root });
  } catch (err) {
    stateReadable = false;
    notes.push(`the observation state could not be read, so every article is reported without it: ${err.message}`);
  }

  const repos = new Map(repoHandles(root).map((h) => [h, readRepoArticle(root, h)]));
  const rows = [];

  if (flags['--live']) {
    const client = createReadOnlyClient(requireClient(ctx, COMMAND));
    try {
      await assertScopes(client, [...READ_SCOPES]);
    } catch (err) {
      throw new ArticleError('scopes', err.message);
    }
    const blog = await resolveBlog(client);
    const nodes = await listBlogArticles(client, blog.id);
    const claimed = new Set();
    for (const [handle, repo] of repos) {
      const { node } = resolveTarget(nodes, repo.article);
      if (node) claimed.add(node.id);
      rows.push({ handle, status: classifyLive({ repo, node, state }), published: node?.isPublished === true });
    }
    for (const node of nodes) {
      if (claimed.has(node.id)) continue;
      rows.push({ handle: node.handle, status: classifyLive({ repo: null, node, state }), published: node.isPublished === true });
    }
  } else {
    for (const [handle, repo] of repos) {
      rows.push({ handle, status: classifyOffline({ handle, repoSha: repo.sha, state }), published: false });
    }
  }

  for (const line of format({ rows, notes, state: describeState(ctx.stateDir), live: flags['--live'] })) ctx.log(line);
  const actionable = !stateReadable || rows.some((r) => r.status !== STATES.IN_SYNC);
  return { code: actionable ? 2 : 0, rows, notes };
}

export async function main(argv) {
  const args = argv.slice(2);
  let flags;
  try {
    flags = parseFlags(args, FLAG_SPEC, COMMAND);
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 1;
  }
  let client = null;
  if (flags['--live']) {
    try {
      client = createAdminClient();
    } catch (err) {
      console.error(`error: ${err && err.message ? err.message : String(err)}`);
      return 1;
    }
  }
  const ctx = createContext({
    repoRoot: REPO_ROOT,
    env: process.env,
    client,
    now: () => new Date().toISOString(),
    stateDir: resolveStateDir(process.env),
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
