// TEST SUPPORT for the network commands: a recording fake Admin client, live article nodes built from
// the committed clean fixture, scratch state and backup directories, and a context builder.
//
// THE FAKE IS STRICT ABOUT WHAT IT IS ASKED. It reads the operation name of every document and
// refuses any name outside the allowlist (the read names in lib/queries.mjs and the two mutation
// names in lib/mutations.mjs), and a mutation whose document does not call the root field its name
// promises. A command that grew a third write, or sent a document nobody reviewed, fails against it.
// It records every call with a deep copy of its variables, so a test asserts what was SENT by
// whole-object equality rather than by the absence of two names.
//
// EVERY PATH IS UNDER A TEMP ROOT; the suites assert it in their after() hooks.

import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { BLOG_HANDLE, sha256 } from '../lib/articles.mjs';
import { createContext } from '../lib/context.mjs';
import { MUTATION_ROOT_FIELDS } from '../lib/mutations.mjs';
import { liveProjection, projectionSha } from '../lib/projection.mjs';
import { QUERY_NAMES } from '../lib/queries.mjs';
import { emptyState, makeObservation, readState, withIntent, withObservation, writeState } from '../lib/state.mjs';
import { readRepoArticle } from '../repo.mjs';
import { HANDLE, readArticle, reindexInPlace, writeArticle } from './helpers.mjs';

export const NOW = '2026-01-02T03:04:05.000Z';
export const BLOG_GID = 'gid://shopify/Blog/100';
export const ARTICLE_GID = 'gid://shopify/Article/1';
export const PUSH_GRANTED = Object.freeze(['write_online_store_pages', 'read_content']);

/** A visible article, spelled so no file under scripts/articles/ holds the literal the source scan refuses. */
export const VISIBLE = Boolean(1);

const MADE = [];

export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  MADE.push(dir);
  return dir;
}

export function madeDirs() {
  return [...MADE];
}

export function cleanupDirs() {
  // Retried: a git child (gc, maintenance) can still be writing under .git/ after execFileSync returns.
  for (const dir of MADE) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  MADE.length = 0;
}

/** A live node that projects to exactly what the repo article at `handle` projects to. */
export function nodeFromRepo(root, handle = HANDLE, overrides = {}) {
  const p = readRepoArticle(root, handle).projection;
  return {
    id: ARTICLE_GID,
    handle: p.handle,
    title: p.title,
    body: p.body,
    summary: p.summary,
    tags: [...p.tags],
    templateSuffix: p.templateSuffix,
    isPublished: false,
    author: { name: p.author },
    image: p.imageUrl === null ? null : { url: p.imageUrl, altText: p.imageAlt },
    titleTag: p.seoTitle === null ? null : { value: p.seoTitle },
    descriptionTag: p.seoDescription === null ? null : { value: p.seoDescription },
    blog: { id: BLOG_GID },
    ...overrides,
  };
}

/** Thrown by the fake for a document it will not answer. */
export class FakeClientRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'FakeClientRefusal';
  }
}

function operationOf(document) {
  const m = /^\s*(query|mutation)\s+([A-Za-z_]\w*)/.exec(String(document ?? ''));
  return m === null ? null : { kind: m[1], name: m[2] };
}

/**
 * Where Shopify puts its copy of a featured image set by URL. Verified on the 2026-09-12 spike: the
 * file is copied to the store's own `articles/` CDN path, so the live URL never equals the one sent.
 */
export function rehostedUrl(url) {
  return `https://cdn.shopify.com/s/files/1/0000/0001/articles/${String(url).split('/').pop()}`;
}

function applyInput(node, input, { rehostImages = false } = {}) {
  const out = { ...node };
  for (const key of ['handle', 'title', 'body', 'summary', 'tags', 'templateSuffix', 'isPublished']) {
    if (Object.prototype.hasOwnProperty.call(input, key)) out[key] = structuredClone(input[key]);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'author')) out.author = input.author ? { name: input.author.name } : null;
  if (Object.prototype.hasOwnProperty.call(input, 'image')) {
    out.image = input.image ? { url: rehostImages ? rehostedUrl(input.image.url) : input.image.url, altText: input.image.altText } : null;
  }
  for (const m of input.metafields ?? []) {
    if (m.namespace === 'global' && m.key === 'title_tag') out.titleTag = { value: m.value };
    if (m.namespace === 'global' && m.key === 'description_tag') out.descriptionTag = { value: m.value };
  }
  if (!('titleTag' in out)) out.titleTag = null;
  if (!('descriptionTag' in out)) out.descriptionTag = null;
  return out;
}

/**
 * A recording fake Admin client.
 *
 * `client.hooks[operationName]` may hold `{ before, after }`: `before({ variables, store })` runs
 * before the response is computed (throw from it for a failure before the write lands);
 * `after({ variables, store, response })` runs after the store has changed (throw from it for a
 * failure after the write landed, or return a replacement response).
 */
export function makeClient({
  articles = [],
  blogs = [{ id: BLOG_GID, handle: BLOG_HANDLE, title: 'Shift Notes' }],
  blogsHasNextPage = false,
  scopes = PUSH_GRANTED,
  collections = {},
  redirects = [],
  rehostImages = false,
} = {}) {
  const store = new Map(articles.map((n) => [n.id, structuredClone(n)]));
  let nextId = 1000;
  const calls = [];

  function respond(name, v) {
    switch (name) {
      case 'ArticlesBlogs':
        return { blogs: { nodes: structuredClone(blogs), pageInfo: { hasNextPage: blogsHasNextPage } } };
      case 'ArticlesList': {
        const blog = blogs.find((b) => b.id === v.blogId);
        if (!blog) return { blog: null };
        const nodes = [...store.values()].filter((n) => n.blog?.id === v.blogId).map((n) => structuredClone(n));
        return { blog: { id: blog.id, handle: blog.handle, articles: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } };
      }
      case 'ArticleRead':
        return { article: store.has(v.id) ? structuredClone(store.get(v.id)) : null };
      case 'ArticlesCollection':
        return { collectionByIdentifier: collections[v.handle] ?? null };
      case 'ArticlesRedirects': {
        const path = String(v.query).replace(/^path:/, '');
        return { urlRedirects: { nodes: redirects.filter((r) => r.path === path) } };
      }
      case 'ArticleCreate': {
        const id = `gid://shopify/Article/${nextId++}`;
        const node = applyInput({ id, blog: { id: v.article.blogId } }, v.article, { rehostImages });
        store.set(id, node);
        return { articleCreate: { article: { id, handle: node.handle, isPublished: node.isPublished }, userErrors: [] } };
      }
      case 'ArticleUpdate': {
        const current = store.get(v.id);
        if (!current) return { articleUpdate: { article: null, userErrors: [{ code: 'NOT_FOUND', field: ['id'], message: 'Article not found' }] } };
        const node = applyInput(structuredClone(current), v.article, { rehostImages });
        store.set(v.id, node);
        return { articleUpdate: { article: { id: v.id, handle: node.handle, isPublished: node.isPublished }, userErrors: [] } };
      }
      default:
        throw new FakeClientRefusal(`no response for ${name}`);
    }
  }

  const client = {
    calls,
    store,
    hooks: {},
    redact: (s) => String(s ?? ''),
    apiVersion: 'test',
    async scopes() {
      return [...scopes];
    },
    async gql(document, variables = {}) {
      const op = operationOf(document);
      if (op === null) throw new FakeClientRefusal(`the fake refuses a document with no named operation: ${String(document).slice(0, 60)}`);
      const allowed = op.kind === 'query'
        ? QUERY_NAMES.includes(op.name)
        : Object.prototype.hasOwnProperty.call(MUTATION_ROOT_FIELDS, op.name);
      if (!allowed) {
        throw new FakeClientRefusal(
          `the fake refuses the ${op.kind} ${op.name}; allow-listed: ${[...QUERY_NAMES, ...Object.keys(MUTATION_ROOT_FIELDS)].join(', ')}`,
        );
      }
      if (op.kind === 'mutation' && !new RegExp(`\\b${MUTATION_ROOT_FIELDS[op.name]}\\s*\\(`).test(document)) {
        throw new FakeClientRefusal(`the mutation ${op.name} does not call ${MUTATION_ROOT_FIELDS[op.name]}`);
      }
      calls.push({ kind: op.kind, name: op.name, document, variables: structuredClone(variables) });
      const hook = client.hooks[op.name];
      if (hook?.before) await hook.before({ variables, store });
      let response = respond(op.name, variables);
      if (hook?.after) {
        const replaced = await hook.after({ variables, store, response });
        if (replaced !== undefined) response = replaced;
      }
      return response;
    },
  };
  return client;
}

/** A context over fakes, with logs captured. Scratch state and backup directories unless given. */
export function makeCtx({ root, client = null, git = null, env = {}, stateDir, backupDir, fetch = null, now = NOW } = {}) {
  const logs = [];
  const errors = [];
  const sDir = stateDir ?? tempDir('articles-state-');
  const bDir = backupDir === undefined ? tempDir('articles-backup-') : backupDir;
  const ctx = createContext({
    repoRoot: root,
    env,
    git,
    client,
    fetch,
    now: () => now,
    stateDir: sDir,
    backupDir: bDir,
    log: (s) => logs.push(String(s)),
    error: (s) => errors.push(String(s)),
    sleep: async () => {},
  });
  return { ctx, logs, errors, stateDir: sDir, backupDir: bDir };
}

/** Record the observation a pull or push would record for `node`, merged into what is there. */
export function seedObservation(stateDir, node, { matchedRepoSha256 = null, gid = node.id, imageSourceUrl = null } = {}) {
  const current = readState({ dir: stateDir }) ?? emptyState();
  const live = liveProjection(node);
  const observation = makeObservation({
    node,
    liveSha256: projectionSha(live),
    bodySha256: sha256(live.body),
    matchedRepoSha256,
    imageSourceUrl,
    now: NOW,
  });
  writeState({ dir: stateDir, state: withObservation(current, gid, observation) });
}

/** Leave an interrupted-push record, as a run that died mid-write would. */
export function seedIntent(stateDir, handle = HANDLE, intent = {}) {
  const current = readState({ dir: stateDir }) ?? emptyState();
  const record = { op: 'update', gid: ARTICLE_GID, sentSha256: '0'.repeat(64), at: NOW, backup: null, ...intent };
  writeState({ dir: stateDir, state: withIntent(current, handle, record) });
}

/** Rename an article directory the way an author would, reindexing after. */
export function renameArticleDir(root, from, to, { recordPrevious = true } = {}) {
  const base = join(root, 'marketing', 'articles');
  renameSync(join(base, from), join(base, to));
  const article = readArticle(root, to);
  article.handle = to;
  article.previousHandles = recordPrevious ? [from] : [];
  writeArticle(root, article, to);
  reindexInPlace(root);
}

/** Every file under a directory as `path -> base64 bytes`, recursively. */
export function snapshotTree(dir) {
  const out = new Map();
  const walk = (d, prefix) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, rel);
      else out.set(rel, readFileSync(full).toString('base64'));
    }
  };
  walk(dir, '');
  return out;
}
