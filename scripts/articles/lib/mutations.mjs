// THE ONLY MUTATION DOCUMENTS IN scripts/articles/, and the one function that builds what they send.
// Pure: no fs, no fetch, no process.env.
//
// A source scan in the suite refuses a mutation document in any other file under scripts/articles/,
// and refuses the literals that would make an article visible, in any file. So "can this subsystem
// publish?" is answered by reading this file, and the answer is no.
//
// HIDDEN IS SENT, NEVER DEFAULTED. `isPublished: false` is part of every input this file builds.
// Whether `articleCreate` defaults to hidden, and whether `articleUpdate` leaves visibility alone
// when the field is absent, are server behaviours this repo has no business depending on: a default
// can change in an API version bump, and the failure would be a post appearing on the storefront.
//
// Validated against the Admin GraphQL schema (2026-07). Both mutations accept either
// `write_content` or `write_online_store_pages`; this app holds the latter.
//
// ADDING A PUBLISH PATH IS NOT AN EDIT TO THIS FILE. It requires re-adding the full operator
// authorization gate that shop policies carry, and scripts/articles/README.md says so.

/** Create one hidden article. */
export const ARTICLE_CREATE = `mutation ArticleCreate($article: ArticleCreateInput!) {
  articleCreate(article: $article) {
    article { id handle isPublished }
    userErrors { code field message }
  }
}`;

/** Update one article, keeping it hidden. */
export const ARTICLE_UPDATE = `mutation ArticleUpdate($id: ID!, $article: ArticleUpdateInput!) {
  articleUpdate(id: $id, article: $article) {
    article { id handle isPublished }
    userErrors { code field message }
  }
}`;

/** Every ARTICLE mutation operation name, and the root field each one calls. The push sends only these. */
export const MUTATION_ROOT_FIELDS = Object.freeze({ ArticleCreate: 'articleCreate', ArticleUpdate: 'articleUpdate' });

// THE IMAGE UPLOADER'S TWO DOCUMENTS (upload-images.mjs). Kept in this file so "what can this
// subsystem write?" is still answered by reading one file, and kept in their own map so the push's
// allowlist does not grow: an article write and a file create are different acts with different
// gates. CREATES ONLY: no file update and no file delete exists anywhere in this subsystem. An
// uploaded file is public at its CDN URL the moment the create succeeds, whatever the article's state.
//
// Validated against the Admin GraphQL schema (2026-07); both need `write_files`.

/** Reserve a staged upload target for one file. */
export const FILE_STAGED_UPLOADS = `mutation ArticleImageStage($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}`;

/** Create one Files entry from a staged upload. */
export const FILE_CREATE = `mutation ArticleImageCreate($files: [FileCreateInput!]!) {
  fileCreate(files: $files) {
    files { id fileStatus ... on MediaImage { image { url width height } } }
    userErrors { field message }
  }
}`;

/** The uploader's mutation operation names, and the root field each one calls. */
export const UPLOAD_MUTATION_ROOT_FIELDS = Object.freeze({ ArticleImageStage: 'stagedUploadsCreate', ArticleImageCreate: 'fileCreate' });

/** The SEO fields are these two metafields (verified on the 2026-09-12 spike and in the SEO docs). */
export const SEO_METAFIELDS = Object.freeze({
  seoTitle: Object.freeze({ namespace: 'global', key: 'title_tag', type: 'single_line_text_field' }),
  seoDescription: Object.freeze({ namespace: 'global', key: 'description_tag', type: 'single_line_text_field' }),
});

/**
 * The exact `article` input for one write, from a repo projection.
 *
 * THE KEY SET IS FIXED PER OPERATION and pinned by whole-object equality in the suite: a create
 * carries `blogId` and no `redirectNewHandle`; an update carries `redirectNewHandle` (true only when
 * the live article is being renamed from a previous handle) and no `blogId`. Nothing is omitted when
 * empty except metafield entries, because a `single_line_text_field` cannot hold an empty value and
 * `articleUpdate` has no way to delete one; the push refuses a repo that clears an SEO field Admin
 * still holds, rather than silently leaving it.
 *
 * `image` is null when the repo has no featured image. Whether `articleUpdate` removes an existing
 * image on null is unproven by the spike; the re-read verification is what would catch it.
 *
 * @param {object} o
 * @param {'create'|'update'} o.op
 * @param {object} o.repo      a repo projection
 * @param {string} [o.blogId]  required for a create
 * @param {boolean} [o.renamed]
 */
export function buildArticleInput({ op, repo, blogId = null, renamed = false }) {
  const metafields = [];
  for (const [field, spec] of Object.entries(SEO_METAFIELDS)) {
    if (repo[field] !== null) metafields.push({ ...spec, value: repo[field] });
  }
  const common = {
    handle: repo.handle,
    title: repo.title,
    author: { name: repo.author },
    summary: repo.summary,
    body: repo.body,
    tags: [...repo.tags],
    templateSuffix: repo.templateSuffix,
    image: repo.imageUrl === null ? null : { url: repo.imageUrl, altText: repo.imageAlt },
    isPublished: false,
    metafields,
  };
  if (op === 'create') {
    if (typeof blogId !== 'string' || blogId === '') throw new TypeError('buildArticleInput: a create needs a blogId');
    return { blogId, ...common };
  }
  if (op === 'update') return { ...common, redirectNewHandle: renamed === true };
  throw new TypeError(`buildArticleInput: unknown op ${JSON.stringify(op)}`);
}
