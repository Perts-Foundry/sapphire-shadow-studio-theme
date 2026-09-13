// Every READ document the articles commands send. Pure constants.
//
// Mutations live in mutations.mjs and nowhere else in scripts/articles/, and a source scan in the
// suite refuses a mutation document anywhere else: a write path is then something a reviewer finds
// by opening one file, not by reading every command.
//
// Validated against the Admin GraphQL schema (2026-07) with the shopify-dev MCP's GraphQL validator.
// The article reads need `read_content` or `read_online_store_pages`; the collection lookup needs
// `read_products`; the redirect lookup needs `read_online_store_navigation`. The last two are only
// used by `articles:verify --live`, which reports a missing scope as a skip rather than guessing.

/** The fields every article read selects. The projection in projection.mjs reads exactly these. */
export const ARTICLE_SELECTION = `id
    handle
    title
    body
    summary
    tags
    templateSuffix
    isPublished
    author { name }
    image { url altText }
    titleTag: metafield(namespace: "global", key: "title_tag") { value }
    descriptionTag: metafield(namespace: "global", key: "description_tag") { value }
    blog { id }`;

/** Blogs, to resolve BLOG_HANDLE by exact match. Filtering happens client-side, never by search. */
export const ARTICLES_BLOGS = `query ArticlesBlogs {
  blogs(first: 50) {
    nodes { id handle title }
    pageInfo { hasNextPage }
  }
}`;

/** One page of one blog's articles. */
export const ARTICLES_LIST = `query ArticlesList($blogId: ID!, $after: String) {
  blog(id: $blogId) {
    id
    handle
    articles(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ${ARTICLE_SELECTION}
      }
    }
  }
}`;

/** One article by GID, for the re-read after a write. */
export const ARTICLE_READ = `query ArticleRead($id: ID!) {
  article(id: $id) {
    ${ARTICLE_SELECTION}
  }
}`;

/** A collection by handle, for `articles:verify --live`'s link resolution. */
export const ARTICLES_COLLECTION = `query ArticlesCollection($handle: String!) {
  collectionByIdentifier(identifier: { handle: $handle }) { id handle }
}`;

/** URL redirects by path, for `articles:verify --live`'s previousHandles report. */
export const ARTICLES_REDIRECTS = `query ArticlesRedirects($query: String!) {
  urlRedirects(first: 10, query: $query) {
    nodes { id path target }
  }
}`;

/**
 * Files entries by filename, for the uploader's no-op path. Shopify's search is not an exact match,
 * so the caller compares each returned URL's basename itself. A file created seconds ago may not be
 * indexed yet, which is why the uploader's dry run says so rather than promising absence.
 */
export const ARTICLE_IMAGE_FILES = `query ArticleImageFiles($query: String!) {
  files(first: 10, query: $query) {
    nodes { id fileStatus ... on MediaImage { image { url width height } } }
  }
}`;

/** One Files entry by GID, for polling a new upload until Shopify has processed it. */
export const ARTICLE_IMAGE_FILE_READ = `query ArticleImageFileRead($id: ID!) {
  node(id: $id) { id ... on MediaImage { fileStatus image { url width height } } }
}`;

/** The uploader's read names. Separate from QUERY_NAMES so the push's fake allowlist does not grow. */
export const UPLOAD_QUERY_NAMES = Object.freeze(['ArticleImageFiles', 'ArticleImageFileRead']);

/** The scope the uploader asserts. `write_files` covers the Files reads it makes too. */
export const UPLOAD_SCOPES = Object.freeze(['write_files']);

/** Every read operation name, for the recording fake's allowlist. */
export const QUERY_NAMES = Object.freeze(['ArticlesBlogs', 'ArticlesList', 'ArticleRead', 'ArticlesCollection', 'ArticlesRedirects']);

/** The scopes the article reads need. `write_online_store_pages` implies nothing about reads here. */
export const READ_SCOPES = Object.freeze(['read_content']);
