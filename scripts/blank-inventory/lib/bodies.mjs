// The garment body axis.
//
// WHY THIS EXISTS. A blank is a physical garment. Two products printed on the same body share stock;
// two products on different bodies do not. The original model keyed a blank on Color+Size alone,
// which silently assumed one body per colour+size. On a catalogue with a crewneck, a quarter-zip and
// a vest, that assumption put every product into one pool: a count sheet with three tables had
// exactly one group to write to, and stock had already been mirrored across garments that share no
// blank. Body is the missing dimension.
//
// WHY IT IS PROPOSED, NOT DECLARED. No Shopify field carries the body. productType is empty, tags are
// marketing labels, vendor is the brand, and no product metafield exists. Rather than maintain a
// side-channel field or a hardcoded map that needs a PR per new product, the tool INFERS a body per
// product, the operator APPROVES the proposal at a gate, and the approved artifact becomes
// authoritative.
//
// THE SAFETY PROPERTY, and the reason this does not contradict resolveBlank's refuse-rather-than-
// invent posture: inference happens at PROPOSAL time with an operator gate in between, never at
// write time. Guessing silently into a write is the original bug. Guessing into a table the operator
// approves is the same shape as every other gate here.
//
// DETERMINISM. The approved artifact is authoritative and is never silently re-inferred. Body
// assignment must not vary between runs over the same catalogue; a fresh guess each run would be
// worse than a hardcoded map, because it would be worse AND invisible.
//
// Existing blank ids are deliberately NOT an inference signal. They currently all name one family,
// which is precisely the state being corrected.

import { createHash, randomUUID } from 'node:crypto';

export const BODIES_VERSION = 1;

/** Confidence in an inferred body. Only `high` is safe to approve without reading closely. */
export const HIGH = 'high';
export const LOW = 'low';
export const NONE = 'none';

/**
 * Garment keywords, longest-first so "quarter-zip" wins over a bare "zip" and "crewneck" is not
 * shadowed by "crew". Each maps to a body id used as a grouping key and as an id segment.
 *
 * This list is a starting vocabulary, not a closed world: an unmatched product is surfaced at the
 * gate for the operator to name, never silently bucketed.
 */
export const GARMENT_KEYWORDS = [
  ['quarter-zip', 'quarter-zip'],
  ['quarter zip', 'quarter-zip'],
  ['qtr-zip', 'quarter-zip'],
  ['half-zip', 'half-zip'],
  ['crewneck', 'crewneck'],
  ['crew-neck', 'crewneck'],
  ['sweatshirt', 'sweatshirt'],
  ['pullover', 'pullover'],
  ['hoodie', 'hoodie'],
  ['long-sleeve', 'long-sleeve'],
  ['t-shirt', 'tee'],
  ['tshirt', 'tee'],
  ['tank', 'tank'],
  ['jacket', 'jacket'],
  ['vest', 'vest'],
  ['tee', 'tee'],
];

/** Fit qualifiers. A women's cut is a different physical blank from the unisex one. */
const FIT_KEYWORDS = [
  ['womens', 'womens'],
  ['women', 'womens'],
  ['ladies', 'womens'],
  ['mens', 'mens'],
];

const normalise = (s) => String(s ?? '').toLowerCase().replace(/[_\s]+/g, '-');

/**
 * Infer a body for one product from its handle, falling back to its title.
 *
 * Pure: no network, no artifact, no catalogue. The handle is the primary signal because it is
 * stable; the title is secondary because it is merchandising copy and changes freely.
 *
 * @param {{handle: string, title?: string}} product
 * @returns {{bodyId: string|null, signal: string, confidence: string}}
 */
export function inferBody(product) {
  const handle = normalise(product?.handle);
  const title = normalise(product?.title);

  for (const [source, text] of [
    ['handle', handle],
    ['title', title],
  ]) {
    const matches = GARMENT_KEYWORDS.filter(([kw]) => text.includes(kw));
    if (!matches.length) continue;

    // Longest keyword wins: "quarter-zip" must beat a substring match, and a product whose handle
    // legitimately names two garments is ambiguous rather than silently resolved to the first.
    const bodies = [...new Set(matches.map(([, body]) => body))];
    const [kw, body] = matches.reduce((a, b) => (b[0].length > a[0].length ? b : a));
    const fit = FIT_KEYWORDS.find(([f]) => text.includes(f));
    const bodyId = fit ? `${body}-${fit[1]}` : body;

    if (bodies.length > 1) {
      return {
        bodyId: null,
        signal: `${source} matches ${bodies.length} garments (${bodies.join(', ')})`,
        confidence: NONE,
      };
    }
    return {
      bodyId,
      signal: `${source} contains "${kw}"${fit ? ` and "${fit[0]}"` : ''}`,
      confidence: source === 'handle' ? HIGH : LOW,
    };
  }

  return { bodyId: null, signal: 'no garment keyword in handle or title', confidence: NONE };
}

/**
 * Build a body proposal over the catalogue.
 *
 * Products with no tracked variants (gift cards and similar) are excluded rather than assigned a
 * body: they are not garments and never join a blank group.
 *
 * @param {object} params
 * @param {Array<{handle: string, title?: string}>} params.products
 * @param {object[]} params.variants - normalised variants, used only to find tracked products
 * @returns {{rows: object[], excluded: object[]}}
 */
export function proposeBodies({ products, variants }) {
  const tracked = new Set(variants.filter((v) => v.tracked !== false).map((v) => v.productHandle));

  const rows = [];
  const excluded = [];
  for (const p of products) {
    if (!tracked.has(p.handle)) {
      excluded.push({ productHandle: p.handle, reason: 'no tracked variants' });
      continue;
    }
    const { bodyId, signal, confidence } = inferBody(p);
    rows.push({ productHandle: p.handle, title: p.title ?? null, bodyId, signal, confidence });
  }
  rows.sort((a, b) => a.productHandle.localeCompare(b.productHandle));
  excluded.sort((a, b) => a.productHandle.localeCompare(b.productHandle));
  return { rows, excluded };
}

/** Fields that define a proposal's identity. Order matters for a stable hash. */
function canonicalPayload(artifact) {
  return JSON.stringify({
    version: artifact.version,
    proposalId: artifact.proposalId,
    bodies: [...artifact.bodies]
      .sort((a, b) => a.productHandle.localeCompare(b.productHandle))
      .map((b) => ({ productHandle: b.productHandle, bodyId: b.bodyId })),
  });
}

/**
 * @param {object} artifact
 * @returns {string}
 */
export function hashBodies(artifact) {
  return createHash('sha256').update(canonicalPayload(artifact)).digest('hex');
}

/**
 * Build an immutable body artifact from approved rows.
 *
 * @param {object} params
 * @param {object[]} params.rows
 * @param {object[]} [params.excluded]
 * @param {string} [params.proposalId]
 * @param {string} [params.createdAt]
 * @returns {object}
 */
export function createBodiesArtifact({ rows, excluded = [], proposalId = randomUUID(), createdAt = new Date().toISOString() }) {
  const unnamed = rows.filter((r) => !r.bodyId);
  if (unnamed.length) {
    throw new Error(
      `Cannot approve a body proposal with ${unnamed.length} unnamed product(s): ` +
        `${unnamed.map((r) => r.productHandle).join(', ')}. Name each one explicitly; a product with ` +
        `no body cannot be tagged, and defaulting it would put a garment in the wrong stock pool.`
    );
  }
  const artifact = {
    version: BODIES_VERSION,
    proposalId,
    createdAt,
    bodies: rows.map((r) => ({
      productHandle: r.productHandle,
      bodyId: r.bodyId,
      signal: r.signal ?? null,
      confidence: r.confidence ?? null,
    })),
    excluded,
  };
  artifact.contentHash = hashBodies(artifact);
  return artifact;
}

/**
 * Load and validate an approved artifact. Refuses a hand-edited one, like the plan artifact does.
 * @param {object} artifact
 * @returns {object}
 */
export function verifyBodiesArtifact(artifact) {
  if (!artifact || artifact.version !== BODIES_VERSION) {
    throw new Error(`Unsupported body artifact (version ${artifact?.version}). Re-run "bodies --stage propose".`);
  }
  if (hashBodies(artifact) !== artifact.contentHash) {
    throw new Error(
      `Body artifact hash mismatch: it has been edited since it was approved. Artifacts are never ` +
        `hand-edited; re-run "bodies --stage propose" and approve the new one.`
    );
  }
  return artifact;
}

/**
 * Index an approved artifact for lookup.
 * @param {object} artifact
 * @returns {Map<string, string>} productHandle -> bodyId
 */
export function bodyIndex(artifact) {
  return new Map(artifact.bodies.map((b) => [b.productHandle, b.bodyId]));
}

/**
 * Resolve a variant's body, or refuse.
 *
 * A product absent from the approved artifact is NEVER guessed here. Read commands surface it as a
 * warning and continue; write paths call this and stop. That is what makes a newly added product
 * loud instead of silently absorbed into whichever pool its colour and size happen to match.
 *
 * @param {Map<string, string>} index
 * @param {{productHandle: string}} variant
 * @returns {string}
 */
export function bodyOf(index, variant) {
  const body = index.get(variant?.productHandle);
  if (!body) {
    throw new Error(
      `No approved body for product "${variant?.productHandle}". Run "bodies --stage propose", ` +
        `approve the proposal, and re-run. This tool never infers a body at write time.`
    );
  }
  return body;
}

/**
 * Products in the catalogue that the approved artifact does not cover.
 * @param {Map<string, string>} index
 * @param {object[]} variants
 * @returns {string[]} product handles
 */
export function unmappedHandles(index, variants) {
  const seen = new Set();
  for (const v of variants) {
    if (v.tracked === false) continue;
    if (!index.has(v.productHandle)) seen.add(v.productHandle);
  }
  return [...seen].sort();
}
