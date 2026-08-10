// The network executor for chart media: fetch live product state, create (staged upload + alt at
// create), poll readiness, delete, and reorder. Walks the phase list media-plan.mjs produced; no
// planning logic of its own. Uses the shared Admin client (scripts/blank-inventory/lib/admin.mjs),
// whose gql() deliberately does NOT throw on userErrors; every mutation result here is checked
// explicitly so a soft failure cannot read as success.
//
// GraphQL documents validated with the shopify-dev MCP's validate_graphql_codeblocks against
// Admin API 2026-07. productCreateMedia accepts alt in CreateMediaInput (proven in
// scripts/upload-product-media.mjs), so alt is set at create and there is no separate fileUpdate
// step, closing the crash window that produces half-labeled media. productCreateMedia and
// productDeleteMedia are soft-deprecated (Shopify suggests productSet / fileUpdate); they are
// kept for the same reason upload-product-media.mjs keeps them: additive/targeted operations
// that cannot clobber unrelated product state, on a pinned API version.

import { readFile } from 'node:fs/promises';
import { basenameFromUrl } from './naming.mjs';

/** Scopes this tool cannot operate without. Verified at runtime via missingScopes(). */
export const REQUIRED_SCOPES = ['write_products', 'write_files'];

export const Q_PRODUCT_STATE = `query AppliqueProductState($identifier: ProductIdentifierInput!) {
  productByIdentifier(identifier: $identifier) {
    id
    title
    options { name optionValues { name } }
    media(first: 250) { nodes { id alt mediaContentType status ... on MediaImage { image { url } } } }
    variants(first: 250) { nodes { id media(first: 10) { nodes { id } } } }
  }
}`;

export const Q_MEDIA = `query AppliqueProductMedia($id: ID!) {
  product(id: $id) {
    media(first: 250) { nodes { id alt mediaContentType status ... on MediaImage { image { url } } } }
  }
}`;

export const M_STAGED = `mutation AppliqueStagedUploads($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}`;

export const M_CREATE = `mutation AppliqueCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
  productCreateMedia(productId: $productId, media: $media) {
    media { id alt mediaContentType status }
    mediaUserErrors { field message }
  }
}`;

export const M_DELETE = `mutation AppliqueDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
  productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
    deletedMediaIds
    mediaUserErrors { field message }
  }
}`;

export const M_REORDER = `mutation AppliqueReorderMedia($id: ID!, $moves: [MoveInput!]!) {
  productReorderMedia(id: $id, moves: $moves) {
    job { id done }
    mediaUserErrors { field message }
  }
}`;

// The shared client returns userErrors instead of throwing; surface them here, uniformly.
function assertNoUserErrors(payloadName, payload) {
  const errs = payload?.userErrors || payload?.mediaUserErrors;
  if (Array.isArray(errs) && errs.length) {
    throw new Error(`${payloadName} userErrors: ${JSON.stringify(errs)}`);
  }
}

const mediaNode = (n) => ({
  id: n.id,
  alt: n.alt ?? '',
  status: n.status ?? null,
  contentType: n.mediaContentType,
  filename: n.image ? basenameFromUrl(n.image.url) : '',
});

/**
 * Resolve the product by handle and normalise everything publish/audit need.
 * @param {import('../../blank-inventory/lib/admin.mjs').AdminClient} client
 * @param {string} handle
 * @returns {Promise<{id: string, title: string, liveColorValues: string[],
 *   media: Array<{id: string, alt: string, status: string | null, contentType: string, filename: string}>,
 *   variantAttachedIds: Set<string>}>}
 */
export async function fetchProductState(client, handle) {
  const data = await client.gql(Q_PRODUCT_STATE, { identifier: { handle } });
  const product = data.productByIdentifier;
  if (!product) throw new Error(`no product resolves for handle "${handle}"`);
  const colorOption = product.options.find((o) => o.name.toLowerCase() === 'color');
  const variantAttachedIds = new Set(
    product.variants.nodes.flatMap((v) => v.media.nodes.map((m) => m.id)),
  );
  return {
    id: product.id,
    title: product.title,
    liveColorValues: colorOption ? colorOption.optionValues.map((v) => v.name) : [],
    media: product.media.nodes.map(mediaNode),
    variantAttachedIds,
  };
}

/** Re-query just the media list (order, status, alts). */
export async function fetchMedia(client, productId) {
  const data = await client.gql(Q_MEDIA, { id: productId });
  return data.product.media.nodes.map(mediaNode);
}

/**
 * Stage-upload one chart file and create it as product media with its alt set at create.
 * @param {object} input
 * @param {string} input.productId
 * @param {string} input.filePath - local chart JPEG
 * @param {string} input.filename - upload filename (the convention name)
 * @param {string} input.alt
 * @returns {Promise<string>} the new media id (not yet READY)
 */
export async function createChart(client, { productId, filePath, filename, alt }) {
  const bytes = await readFile(filePath);
  const staged = await client.gql(M_STAGED, {
    input: [{
      filename,
      mimeType: 'image/jpeg',
      resource: 'PRODUCT_IMAGE',
      httpMethod: 'POST',
      fileSize: String(bytes.length),
    }],
  });
  assertNoUserErrors('stagedUploadsCreate', staged.stagedUploadsCreate);
  const target = staged.stagedUploadsCreate.stagedTargets[0];
  const form = new FormData();
  for (const { name, value } of target.parameters) form.append(name, value);
  form.append('file', new Blob([bytes], { type: 'image/jpeg' }), filename);
  const res = await fetch(target.url, { method: 'POST', body: form });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(client.redact(`staged upload POST failed (${res.status}): ${t.slice(0, 300)}`));
  }
  const created = await client.gql(M_CREATE, {
    productId,
    media: [{ originalSource: target.resourceUrl, alt, mediaContentType: 'IMAGE' }],
  });
  assertNoUserErrors('productCreateMedia', created.productCreateMedia);
  return created.productCreateMedia.media[0].id;
}

/**
 * Poll one media id until READY (returning its verified alt + live filename), FAILED (throws), or
 * the bounded timeout elapses (throws). The barrier in publish.mjs calls this per created media.
 * @param {object} input
 * @param {string} input.productId
 * @param {string} input.mediaId
 * @param {(ms: number) => Promise<void>} [input.sleep]
 * @param {number} [input.timeoutMs]
 * @returns {Promise<{id: string, alt: string, filename: string}>}
 */
export async function pollMediaReady(client, { productId, mediaId, sleep, timeoutMs = 120000 }) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  let delay = 1000;
  while (Date.now() < deadline) {
    await wait(delay);
    const media = await fetchMedia(client, productId);
    const node = media.find((m) => m.id === mediaId);
    if (!node) throw new Error(`media ${mediaId} disappeared while polling`);
    if (node.status === 'READY') return { id: node.id, alt: node.alt, filename: node.filename };
    if (node.status === 'FAILED') throw new Error(`media ${mediaId} processing FAILED`);
    delay = Math.min(delay * 1.5, 8000);
  }
  throw new Error(`media ${mediaId} did not reach READY within ${Math.round(timeoutMs / 1000)}s`);
}

/** Delete media ids in one call; throws on any mediaUserError. */
export async function deleteMedia(client, { productId, mediaIds }) {
  if (!mediaIds.length) return [];
  const data = await client.gql(M_DELETE, { productId, mediaIds });
  assertNoUserErrors('productDeleteMedia', data.productDeleteMedia);
  return data.productDeleteMedia.deletedMediaIds ?? [];
}

/**
 * Reorder the gallery to targetIds, then re-query with bounded retries until the live order
 * matches (the mutation is job-async). Exhaustion throws; publish.mjs turns that into a non-zero
 * exit, not just an audit note.
 * @param {object} input
 * @param {string} input.productId
 * @param {string[]} input.targetIds - full desired media id order
 * @param {(ms: number) => Promise<void>} [input.sleep]
 * @param {number} [input.attempts]
 */
export async function reorderMedia(client, { productId, targetIds, sleep, attempts = 10 }) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const current = await fetchMedia(client, productId);
  const currentIds = current.map((m) => m.id);
  if (currentIds.join('\n') === targetIds.join('\n')) return; // already converged
  const moves = targetIds
    .map((id, index) => ({ id, newPosition: String(index) }))
    .filter(({ id, newPosition }) => currentIds[Number(newPosition)] !== id);
  const data = await client.gql(M_REORDER, { id: productId, moves });
  assertNoUserErrors('productReorderMedia', data.productReorderMedia);
  for (let i = 0; i < attempts; i++) {
    await wait(2000);
    const now = (await fetchMedia(client, productId)).map((m) => m.id);
    if (now.join('\n') === targetIds.join('\n')) return;
  }
  throw new Error(`gallery order did not converge after ${attempts} re-queries; re-run publish or fix the order in Admin`);
}
