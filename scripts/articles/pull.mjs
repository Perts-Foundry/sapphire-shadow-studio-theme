#!/usr/bin/env node
// Read the live blog: report drift, or record what Admin holds as this machine's baseline.
//
//   npm run articles:pull -- --check   report drift against the repo and the last observation; write nothing
//   npm run articles:pull -- --seed    record every live article in the observation state; touch no repo file
//
// THERE IS NO THIRD MODE, and that is the design. The policies pull has a bare form that overwrites
// committed wording with Admin's, and CLAUDE.md has to carry a rule about it. This command has no
// body-overwriting path at all: exactly one of `--check` or `--seed` is required, any other argument
// is a refusal, and nothing in this file writes under marketing/articles/. When Admin's version of an
// article should win, a person copies it into the repo in a reviewed change.
//
// READ-ONLY AGAINST THE STORE: every read goes through the read-only client, which refuses a mutation
// document before it reaches the network.
//
// `--seed` REPLACES the observation state with what is live now. An observation for an article that
// is no longer live is dropped, and every interrupted-push record is cleared, each one named in the
// output. That is what reconciling means: the operator has read `--check`, and says "what Admin holds
// now is the baseline".
//
// Exit codes: 0 in sync (`--check`) or seeded (`--seed`), 2 drift found by `--check`, 1 refused or
// could not run.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertScopes, createAdminClient } from '../blank-inventory/lib/admin.mjs';
import { createReadOnlyClient } from '../site-check/lib/admin-readonly.mjs';
import { REPO_ROOT } from './check.mjs';
import { readRepoArticle, repoHandles } from './repo.mjs';
import { sha256 } from './lib/articles.mjs';
import { STATES, classifyLive, nextStep } from './lib/classify.mjs';
import { ArticleError, createContext, parseFlags, requireClient, toExitCode } from './lib/context.mjs';
import { listBlogArticles, resolveBlog, resolveTarget } from './lib/live.mjs';
import { fieldDifferences, liveProjection, projectionSha } from './lib/projection.mjs';
import { READ_SCOPES } from './lib/queries.mjs';
import { displayPath } from './lib/backups.mjs';
import {
  emptyState,
  makeObservation,
  readState,
  recordedImageSource,
  resolveStateDir,
  stateFilePath,
  withObservation,
  writeState,
} from './lib/state.mjs';

export const COMMAND = 'articles:pull';
export const FLAG_SPEC = Object.freeze({ '--check': 'boolean', '--seed': 'boolean' });

/**
 * The mode, or a refusal. Exactly one of the two flags; there is no third mode to fall back to.
 * @returns {'check'|'seed'}
 */
export function modeFrom(argv) {
  const flags = parseFlags(argv, FLAG_SPEC, COMMAND);
  if (flags['--check'] === flags['--seed']) {
    throw new ArticleError(
      COMMAND,
      'takes exactly one of --check (report drift) or --seed (record what Admin holds). There is no mode ' +
        'that writes repo files: when Admin\'s version should win, copy it into the repo in a reviewed change.',
    );
  }
  return flags['--seed'] ? 'seed' : 'check';
}

export async function run(argv, ctx) {
  const mode = modeFrom(argv);
  const root = ctx.repoRoot;
  const client = createReadOnlyClient(requireClient(ctx, COMMAND));
  try {
    await assertScopes(client, [...READ_SCOPES]);
  } catch (err) {
    throw new ArticleError('scopes', err.message);
  }
  const blog = await resolveBlog(client);
  const nodes = await listBlogArticles(client, blog.id);
  const state = readState({ dir: ctx.stateDir, root });

  const repos = new Map(repoHandles(root).map((h) => [h, readRepoArticle(root, h)]));
  const repoByNode = new Map();
  for (const repo of repos.values()) {
    const { node } = resolveTarget(nodes, repo.article);
    if (node) repoByNode.set(node.id, repo);
  }

  if (mode === 'seed') {
    const now = ctx.now();
    let next = emptyState();
    for (const node of nodes) {
      const repo = repoByNode.get(node.id) ?? null;
      const live = liveProjection(node);
      // A seed cannot learn where Admin's re-hosted image came from; it can only carry forward what
      // an earlier observation knew, while Admin still holds that same copy. Unknown stays unknown,
      // so the article reads as not matching and the next push sends the image again.
      const imageSource = recordedImageSource(state?.articles?.[node.id], live.imageUrl);
      const matched = repo !== null && fieldDifferences(repo.projection, live, { ignore: ['isPublished'], imageSource }).length === 0;
      next = withObservation(next, node.id, makeObservation({
        node,
        liveSha256: projectionSha(live),
        bodySha256: sha256(live.body),
        matchedRepoSha256: matched ? repo.sha : null,
        imageSourceUrl: matched ? repo.projection.imageUrl : imageSource,
        now,
      }));
    }
    const cleared = Object.keys(state?.intents ?? {}).sort();
    const dropped = Object.keys(state?.articles ?? {}).filter((gid) => !nodes.some((n) => n.id === gid)).sort();
    const file = writeState({ dir: ctx.stateDir, root, state: next });
    ctx.log(`wrote ${displayPath(file)}`);
    ctx.log(`${COMMAND} --seed recorded ${nodes.length} live article(s) in blog "${blog.handle}".`);
    for (const handle of cleared) ctx.log(`cleared the interrupted-push record for ${handle}`);
    for (const gid of dropped) ctx.log(`dropped the observation for ${gid}, which is no longer live`);
    ctx.log('NOTHING under marketing/articles/ was touched.');
    return { code: 0, seeded: true, cleared, dropped, stateFile: stateFilePath(ctx.stateDir) };
  }

  const rows = [];
  for (const [handle, repo] of repos) {
    const node = [...repoByNode.entries()].find(([, r]) => r === repo)?.[0];
    const liveNode = node === undefined ? null : nodes.find((n) => n.id === node);
    rows.push({ handle, status: classifyLive({ repo, node: liveNode, state }) });
  }
  for (const node of nodes) {
    if (repoByNode.has(node.id)) continue;
    rows.push({ handle: node.handle, status: classifyLive({ repo: null, node, state }) });
  }
  for (const row of rows) {
    ctx.log(`${row.handle}: ${row.status}`);
    if (row.status !== STATES.IN_SYNC) ctx.log(`  next: ${nextStep(row.status, row.handle)}`);
  }
  const drift = rows.filter((r) => r.status !== STATES.IN_SYNC);
  ctx.log(
    drift.length === 0
      ? `${COMMAND} --check: marketing/articles/ matches Admin`
      : `${COMMAND} --check found drift in ${drift.length} article(s). Nothing was written.`,
  );
  return { code: drift.length === 0 ? 0 : 2, rows };
}

export async function main(argv) {
  const args = argv.slice(2);
  try {
    modeFrom(args);
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 1;
  }
  let client;
  try {
    client = createAdminClient();
  } catch (err) {
    console.error(`error: ${err && err.message ? err.message : String(err)}`);
    return 1;
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
