// Reading the live blog. Takes an injected client; imports no network module of its own.
//
// Lib rules: no fs, no fetch, no process.env. The client is whatever the caller built, and every
// read a command makes about the live store goes through these three functions, so the refusals
// below (zero or two blogs, a duplicate live handle, a runaway page count) hold for status, pull,
// push and verify alike.

import { BLOG_HANDLE } from './articles.mjs';
import { ArticleError } from './context.mjs';
import { bodiesEquivalent, liveProjection } from './projection.mjs';
import { ARTICLES_BLOGS, ARTICLES_LIST, ARTICLE_READ } from './queries.mjs';

/** 20 pages of 100 is 2000 articles. A blog past that is a surprise worth stopping on. */
export const MAX_ARTICLE_PAGES = 20;

/**
 * The one blog whose handle is exactly BLOG_HANDLE.
 *
 * Zero is a refusal (the blog was deleted or renamed in Admin), more than one is a refusal (never
 * pick), and a truncated blog list is a refusal too, because "exactly one in the first page" does
 * not prove "exactly one".
 */
export async function resolveBlog(client) {
  const data = await client.gql(ARTICLES_BLOGS);
  const nodes = Array.isArray(data?.blogs?.nodes) ? data.blogs.nodes : null;
  if (nodes === null) throw new ArticleError('blog', 'Admin returned no blog list');
  if (data.blogs.pageInfo?.hasNextPage === true) {
    throw new ArticleError('blog', 'Admin has more blogs than one page holds, so the handle cannot be proved unique; refusing');
  }
  const matches = nodes.filter((n) => n?.handle === BLOG_HANDLE);
  if (matches.length !== 1) {
    throw new ArticleError(
      'blog',
      `expected exactly one blog with the handle "${BLOG_HANDLE}", found ${matches.length}. Nothing ` +
        'memorises a blog GID; the handle is the identity, so zero or several is a refusal.',
    );
  }
  return matches[0];
}

/**
 * Every article in one blog, all pages.
 *
 * A duplicate handle in the result is a refusal: Shopify keeps handles unique within a blog, so a
 * duplicate means the read is not what it seems, and every decision downstream picks by handle.
 */
export async function listBlogArticles(client, blogId) {
  const nodes = [];
  let after = null;
  for (let page = 0; ; page++) {
    if (page >= MAX_ARTICLE_PAGES) {
      throw new ArticleError('blog', `holds more than ${MAX_ARTICLE_PAGES} pages of articles; refusing rather than reading a partial list`);
    }
    const data = await client.gql(ARTICLES_LIST, { blogId, after });
    const connection = data?.blog?.articles;
    if (!connection || !Array.isArray(connection.nodes)) {
      throw new ArticleError('blog', `Admin returned no article list for ${blogId}`);
    }
    nodes.push(...connection.nodes);
    if (connection.pageInfo?.hasNextPage !== true) break;
    after = connection.pageInfo.endCursor;
    if (typeof after !== 'string' || after === '') throw new ArticleError('blog', 'Admin reported another page with no cursor');
  }
  const seen = new Set();
  for (const node of nodes) {
    if (seen.has(node.handle)) throw new ArticleError(node.handle, 'Admin returned two live articles with this handle; refusing to pick');
    seen.add(node.handle);
  }
  return nodes;
}

/** One article by GID, or null when Admin returns none. */
export async function readArticle(client, id) {
  const data = await client.gql(ARTICLE_READ, { id });
  return data?.article ?? null;
}

/**
 * Which live article a repo article writes to.
 *
 *   live at the current handle only          update it
 *   live at exactly one previous handle only update it, renaming, with a redirect
 *   live at the current AND a previous one   refuse; never pick
 *   live at two previous handles             refuse; never pick
 *   live at neither                          create
 *
 * @param {object[]} liveNodes
 * @param {{handle: string, previousHandles?: string[]}} article
 * @returns {{kind: 'update'|'create', node: object|null, renamed: boolean}}
 */
export function resolveTarget(liveNodes, article) {
  const previousHandles = Array.isArray(article.previousHandles) ? article.previousHandles : [];
  const current = liveNodes.filter((n) => n.handle === article.handle);
  const previous = liveNodes.filter((n) => previousHandles.includes(n.handle));
  if (current.length > 0 && previous.length > 0) {
    throw new ArticleError(
      article.handle,
      `is live at this handle AND at the previous handle(s) ${previous.map((n) => `"${n.handle}"`).join(', ')}. ` +
        'Two live articles claim this repo directory; refusing to pick one. Resolve it in Admin.',
    );
  }
  if (previous.length > 1) {
    throw new ArticleError(
      article.handle,
      `more than one previous handle is live (${previous.map((n) => `"${n.handle}"`).join(', ')}); refusing to pick one`,
    );
  }
  if (current.length === 1) return { kind: 'update', node: current[0], renamed: false };
  if (previous.length === 1) return { kind: 'update', node: previous[0], renamed: true };
  return { kind: 'create', node: null, renamed: false };
}

/**
 * The live article a create would duplicate, or null.
 *
 * A directory renamed without recording `previousHandles` resolves to a create, and the post it was
 * renamed from is still live. What identifies that post is CONTENT, not the fact that it is unclaimed:
 * a live article no repo directory claims, whose title equals this article's or whose body is
 * equivalent to it. An unclaimed live article with a different title and body is some other post and
 * is not this function's business.
 *
 * @param {object[]} liveNodes
 * @param {object} repoProjection  the article about to be created
 * @param {Set<string>} claimed    every handle a repo directory claims, previous handles included
 * @returns {{handle: string, id: string, matched: 'title'|'body'}|null}
 */
export function unrecordedRenameOf(liveNodes, repoProjection, claimed) {
  for (const node of liveNodes) {
    if (claimed.has(node.handle)) continue;
    const live = liveProjection(node);
    if (live.title !== null && live.title === repoProjection.title) return { handle: node.handle, id: node.id, matched: 'title' };
    if (repoProjection.body !== '' && bodiesEquivalent(live.body, repoProjection.body)) return { handle: node.handle, id: node.id, matched: 'body' };
  }
  return null;
}
