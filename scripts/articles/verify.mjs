#!/usr/bin/env node
// Assert what the repo's articles say against this machine's observations, and with `--live`,
// against the live store itself.
//
//   npm run articles:verify                  offline: articles:check, then each article against its last observation
//   npm run articles:verify -- --root <dir>  operate on another checkout (tests)
//   npm run articles:verify -- --live        plus the live checks below
//
// `--live` ADDS, per repo article: every written field compared with what Admin holds (the body
// structurally, see lib/projection.mjs); the live `templateSuffix` compared with the repo value, on
// its own line, because the offline rule only proves the template FILE exists and Shopify accepts an
// unknown suffix silently; every `/collections/<handle>` link resolved against Admin; a HEAD request
// to every recorded CDN image URL, with node fetch; and a redirect check for every `previousHandles`
// entry. Then every live article with no repo directory is listed.
//
// A MISSING SCOPE IS A SKIP, NEVER A PASS. The collection lookup needs `read_products` and the
// redirect lookup `read_online_store_navigation`; when the app does not grant one, those lines say
// SKIP and name the scope.
//
// Exit codes: 0 every assertion passed, 2 an assertion failed (the repo and what it was compared with
// disagree), 1 refused or could not run (including an articles:check refusal).

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertScopes, createAdminClient } from '../blank-inventory/lib/admin.mjs';
import { createReadOnlyClient } from '../site-check/lib/admin-readonly.mjs';
import { REPO_ROOT, plan } from './check.mjs';
import { readRepoArticle, repoHandles } from './repo.mjs';
import { BLOG_HANDLE, classifyLink, hrefsOf, stripVersionQuery } from './lib/articles.mjs';
import { ArticleError, createContext, parseFlags, requireClient, toExitCode } from './lib/context.mjs';
import { listBlogArticles, resolveBlog, resolveTarget } from './lib/live.mjs';
import { fieldDifferences, liveProjection } from './lib/projection.mjs';
import { ARTICLES_COLLECTION, ARTICLES_REDIRECTS, READ_SCOPES } from './lib/queries.mjs';
import { observationByHandle, observationFor, readState, recordedImageSource, resolveStateDir } from './lib/state.mjs';

export const COMMAND = 'articles:verify';
export const FLAG_SPEC = Object.freeze({ '--root': 'string', '--live': 'boolean' });
export const COLLECTION_SCOPE = 'read_products';
export const REDIRECT_SCOPE = 'read_online_store_navigation';
export const OK_LINE = 'articles:verify: all assertions passed';

export async function run(argv, ctx) {
  const flags = parseFlags(argv, FLAG_SPEC, COMMAND);
  const root = flags['--root'] === null ? ctx.repoRoot : path.resolve(flags['--root']);

  let findings;
  try {
    ({ findings } = plan(root));
  } catch (err) {
    throw new ArticleError('articles:check', `could not read the tree (${err.message})`);
  }
  if (findings.length) {
    throw new ArticleError(
      'articles:check',
      `is not clean, so there is nothing trustworthy to verify:\n${findings.map((f) => `  [${f.rule}] ${f.handle ? `${f.handle}: ` : ''}${f.detail}`).join('\n')}`,
    );
  }

  const repos = new Map(repoHandles(root).map((h) => [h, readRepoArticle(root, h)]));
  const state = readState({ dir: ctx.stateDir, root });
  let failed = 0;
  const pass = (msg) => ctx.log(`  PASS  ${msg}`);
  const fail = (msg) => {
    failed++;
    ctx.log(`  FAIL  ${msg}`);
  };
  const skip = (msg) => ctx.log(`  SKIP  ${msg}`);

  if (!flags['--live']) {
    if (state === null) ctx.log('note: no observation state on this machine; every article is a SKIP offline');
    for (const [handle, repo] of repos) {
      ctx.log(`\n=== ${handle} ===`);
      const hit = state === null ? null : observationByHandle(state, handle);
      if (hit === null) {
        skip('no observation of this article on this machine (never pushed or seeded from here)');
      } else if (hit[1].matchedRepoSha256 === repo.sha) {
        pass(`the last observation of ${hit[0]} matched this repo version (observed ${hit[1].observedAt})`);
      } else {
        fail(`the last observation of ${hit[0]} does not match this repo version: a push is outstanding, or Admin moved`);
      }
    }
    ctx.log(failed === 0 ? `\n${OK_LINE}` : `\narticles:verify: ${failed} assertion(s) FAILED`);
    return { code: failed === 0 ? 0 : 2, failed };
  }

  if (!ctx.fetch) throw new ArticleError(COMMAND, '--live needs a fetch implementation for the CDN checks');
  const client = createReadOnlyClient(requireClient(ctx, COMMAND));
  let granted;
  try {
    granted = await assertScopes(client, [...READ_SCOPES]);
  } catch (err) {
    throw new ArticleError('scopes', err.message);
  }
  const blog = await resolveBlog(client);
  const nodes = await listBlogArticles(client, blog.id);
  const claimed = new Set();

  for (const [handle, repo] of repos) {
    ctx.log(`\n=== ${handle} ===`);
    const { node, renamed } = resolveTarget(nodes, repo.article);
    if (!node) {
      fail('Admin holds no article at this handle or any previous handle');
    } else {
      claimed.add(node.id);
      const live = liveProjection(node);
      // A rename is ONE failure. The handle is left out of the field comparison when the renamed line
      // has already said it, or the same fact would be counted and printed twice.
      if (renamed) fail(`Admin still holds this article at its previous handle "${node.handle}"`);
      const imageSource = recordedImageSource(state === null ? undefined : observationFor(state, node.id), live.imageUrl);
      const diffs = fieldDifferences(repo.projection, live, {
        ignore: ['isPublished', 'templateSuffix', ...(renamed ? ['handle'] : [])],
        imageSource,
      });
      if (diffs.length === 0) pass(`every written field matches Admin (${node.id})`);
      else fail(`Admin differs from the repo in: ${diffs.join(', ')}`);
      if (live.templateSuffix === repo.projection.templateSuffix) {
        pass(`templateSuffix is ${JSON.stringify(live.templateSuffix)} in both`);
      } else {
        fail(`templateSuffix is ${JSON.stringify(live.templateSuffix)} in Admin and ${JSON.stringify(repo.projection.templateSuffix)} in the repo`);
      }
      if (live.isPublished) ctx.log('  note  this article is VISIBLE on the storefront');
    }

    for (const href of hrefsOf(repo.body)) {
      const link = classifyLink(href);
      if (link.kind !== 'relative' || link.root !== '/collections/') continue;
      const collectionHandle = link.handle.split('/')[0];
      if (!granted.includes(COLLECTION_SCOPE)) {
        skip(`link ${href}: the app does not grant ${COLLECTION_SCOPE}, so the collection was not resolved`);
        continue;
      }
      const data = await client.gql(ARTICLES_COLLECTION, { handle: collectionHandle });
      if (data?.collectionByIdentifier?.id) pass(`link ${href} resolves to a collection`);
      else fail(`link ${href} names no collection in Admin`);
    }

    for (const entry of repo.images.images ?? []) {
      const url = stripVersionQuery(entry.url);
      let status;
      try {
        const res = await ctx.fetch(url, { method: 'HEAD', redirect: 'follow' });
        status = res.status;
      } catch (err) {
        fail(`HEAD ${url} failed: ${err && err.message ? err.message : String(err)}`);
        continue;
      }
      if (status >= 200 && status < 300) pass(`HEAD ${url} returned ${status}`);
      else fail(`HEAD ${url} returned ${status}`);
    }

    for (const old of repo.article.previousHandles ?? []) {
      const redirectPath = `/blogs/${BLOG_HANDLE}/${old}`;
      if (!granted.includes(REDIRECT_SCOPE)) {
        skip(`redirect from ${redirectPath}: the app does not grant ${REDIRECT_SCOPE}`);
        continue;
      }
      const data = await client.gql(ARTICLES_REDIRECTS, { query: `path:${redirectPath}` });
      const hit = (data?.urlRedirects?.nodes ?? []).find((n) => n?.path === redirectPath);
      if (hit) pass(`a redirect from ${redirectPath} exists (to ${hit.target})`);
      else fail(`no redirect from ${redirectPath}, which previousHandles says this article used to live at`);
    }
  }

  const orphans = nodes.filter((n) => !claimed.has(n.id));
  if (orphans.length) {
    ctx.log('\n=== live articles with no repo directory ===');
    for (const node of orphans) ctx.log(`  note  ${node.handle} (${node.id})${node.isPublished ? ', VISIBLE' : ''}`);
  }
  ctx.log(failed === 0 ? `\n${OK_LINE}` : `\narticles:verify: ${failed} assertion(s) FAILED`);
  return { code: failed === 0 ? 0 : 2, failed, orphans: orphans.map((n) => n.handle) };
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
    fetch: flags['--live'] ? globalThis.fetch : null,
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
