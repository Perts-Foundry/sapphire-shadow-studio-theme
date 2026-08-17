// The plan artifact and the apply receipt.
//
// THE ARTIFACT IS THE CONTRACT between the operator's approval and what `apply` writes. `apply`
// consumes only an artifact and never re-derives from live state, because re-deriving would let a
// table edit or a store change between approval and apply widen the write silently. That is not
// hypothetical here: the SKU a variant should have is a pure function of the tables, so an edited
// table would produce a *different but perfectly plausible* set of writes under the same approval.
// The tables hash is embedded for exactly that reason and checked before any write.
//
// This mirrors scripts/blank-inventory/lib/receipt.mjs rather than importing it. That module's
// canonical payload is blank-inventory-shaped (blank ids, quantities, inventory items); bending it
// to carry SKU rows would couple two tools' artifact formats so that a change to one silently
// invalidates approved artifacts of the other.

import { createHash, randomUUID } from 'node:crypto';
import { writeFile, rename, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const ROW_APPLIED = 'applied';
export const ROW_FAILED = 'failed';
export const ROW_SKIPPED = 'skipped';
export const ROW_NOT_ATTEMPTED = 'not-attempted';

export const ARTIFACT_VERSION = 1;

export const MODE_NULLS = 'nulls';
export const MODE_NULLS_AND_MISMATCHES = 'nulls+mismatches';
export const MODES = [MODE_NULLS, MODE_NULLS_AND_MISMATCHES];

/**
 * Fields that define an artifact's identity. Order matters for a stable hash, and rows are sorted
 * so that a re-plan producing the same writes in a different order is recognisably the same plan.
 */
function canonicalPayload(artifact) {
  return JSON.stringify({
    version: artifact.version,
    planId: artifact.planId,
    mode: artifact.mode,
    tablesHash: artifact.tablesHash,
    rows: [...artifact.rows]
      .sort((a, b) => (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0))
      .map((r) => ({
        variantId: r.variantId,
        productId: r.productId,
        baselineSku: r.baselineSku ?? null,
        expectedSku: r.expectedSku,
      })),
  });
}

/**
 * @param {object} artifact
 * @returns {string}
 */
export function hashArtifact(artifact) {
  return createHash('sha256').update(canonicalPayload(artifact)).digest('hex');
}

/**
 * Build an immutable plan artifact.
 * @param {object} params
 * @param {object[]} params.rows
 * @param {object[]} [params.refused]
 * @param {string} params.mode
 * @param {string} params.tablesHash
 * @param {string} [params.planId]
 * @param {string} [params.createdAt]
 * @returns {object}
 */
export function createArtifact({ rows, refused = [], mode, tablesHash, planId = randomUUID(), createdAt = new Date().toISOString() }) {
  if (!MODES.includes(mode)) throw new Error(`Unknown plan mode "${mode}". Expected one of ${MODES.join(', ')}.`);
  if (!tablesHash) throw new Error('A plan artifact must record the tables hash it was derived from.');
  const artifact = {
    version: ARTIFACT_VERSION,
    planId,
    createdAt,
    mode,
    tablesHash,
    rows: rows.map((r) => ({
      variantId: r.variantId,
      productId: r.productId,
      productHandle: r.productHandle,
      variantTitle: r.variantTitle ?? null,
      baselineSku: r.baselineSku ?? null,
      expectedSku: r.expectedSku,
    })),
    refused: refused.map((r) => ({ variantId: r.variantId ?? null, productHandle: r.productHandle ?? null, reason: r.reason })),
  };
  artifact.contentHash = hashArtifact(artifact);
  return artifact;
}

/**
 * Reject an artifact that no longer matches the plan that produced it.
 *
 * Scope, so this is not mistaken for more than it is: the hash is unkeyed and computed from the
 * artifact's own fields, so anyone who can edit the file can recompute it. This catches an
 * ACCIDENTAL edit between approval and apply (a hand-tweaked SKU, a row pasted in). It is not
 * tamper-proofing against someone with write access to the working directory, who could equally
 * author a fresh artifact. The operator STOP is what authorises a plan; this checks the bytes did
 * not drift after it.
 *
 * @param {object} artifact
 * @returns {object} the artifact
 */
export function verifyArtifact(artifact) {
  if (!artifact || artifact.version !== ARTIFACT_VERSION) {
    throw new Error(`Unsupported plan artifact (version ${artifact?.version}). Re-run plan.`);
  }
  if (!Array.isArray(artifact.rows)) throw new Error('Artifact has no "rows" array; it is not a plan artifact.');
  const expected = hashArtifact(artifact);
  if (expected !== artifact.contentHash) {
    throw new Error(
      `Plan artifact hash mismatch: it has been edited since it was approved. Artifacts are never ` +
        `hand-edited; re-run plan and get the new one approved.`
    );
  }
  return artifact;
}

/**
 * Refuse an artifact planned against different tables.
 *
 * A code table edit changes what every downstream SKU should be, so it voids the approval as well
 * as the plan. Catching it here is what makes "restart at audit after a tables change" an enforced
 * rule rather than a line in a document.
 *
 * @param {object} artifact
 * @param {string} tablesHash - the hash of the tables loaded now
 * @returns {object} the artifact
 */
export function assertTablesUnchanged(artifact, tablesHash) {
  if (artifact.tablesHash !== tablesHash) {
    throw new Error(
      `This plan was built from different code tables (plan ${short(artifact.tablesHash)}, current ` +
        `${short(tablesHash)}). A tables change alters what every SKU should be, so it voids this ` +
        `plan and its approval. Re-run audit, then plan.`
    );
  }
  return artifact;
}

const short = (h) => String(h ?? '').slice(0, 12);

/** Non-null in every renderable row. `baselineSku` is legitimately null and is checked for presence. */
export const PLAN_ROW_KEYS = ['variantId', 'productId', 'productHandle', 'expectedSku'];

/**
 * Refuse to render a plan whose rows are missing anything the approval gate needs.
 *
 * A renderer that prints a blank cell for a key it cannot find turns a schema change into a
 * silently emptier gate, which is worse than no gate: it still looks like a review. blank-inventory
 * learned this from a gate that showed `write: undefined` on all 38 rows and was approved anyway.
 *
 * @param {object} artifact
 * @returns {object} the artifact
 */
export function assertRenderablePlan(artifact) {
  if (!artifact || !Array.isArray(artifact.rows)) {
    throw new Error('Artifact has no "rows" array; it is not a plan artifact.');
  }
  artifact.rows.forEach((r, i) => {
    const missing = PLAN_ROW_KEYS.filter((k) => r?.[k] === undefined || r?.[k] === null);
    if (!r || !('baselineSku' in r)) missing.push('baselineSku');
    if (missing.length) {
      throw new Error(
        `Artifact row #${i} (${r?.variantId ?? 'unknown variant'}) is missing ${missing.join(', ')}. ` +
          `Refusing to render: a gate that shows a blank cell where a SKU belongs is worse than no ` +
          `gate. Re-run plan.`
      );
    }
  });
  return artifact;
}

/**
 * A fresh receipt: every row not yet attempted.
 * @param {object} artifact
 * @param {string} [startedAt]
 * @returns {object}
 */
export function createReceipt(artifact, startedAt = new Date().toISOString()) {
  return {
    planId: artifact.planId,
    contentHash: artifact.contentHash,
    tablesHash: artifact.tablesHash,
    mode: artifact.mode,
    startedAt,
    finishedAt: null,
    rows: artifact.rows.map((r) => ({
      variantId: r.variantId,
      productHandle: r.productHandle,
      // The prior value, recorded because recovery is applying these back through the same gates.
      // There is no revert command by design; see docs/sku-scheme.md.
      baselineSku: r.baselineSku ?? null,
      expectedSku: r.expectedSku,
      status: ROW_NOT_ATTEMPTED,
      detail: null,
      at: null,
    })),
  };
}

/**
 * Record a terminal outcome for one row.
 * @param {object} receipt
 * @param {string} variantId
 * @param {string} status
 * @param {string|null} [detail]
 * @param {string} [at]
 * @returns {object} the same receipt, mutated
 */
export function markRow(receipt, variantId, status, detail = null, at = new Date().toISOString()) {
  const row = receipt.rows.find((r) => r.variantId === variantId);
  if (!row) throw new Error(`Receipt has no row for variant "${variantId}".`);
  row.status = status;
  row.detail = detail;
  row.at = at;
  return receipt;
}

/**
 * Tally a receipt by status.
 * @param {object} receipt
 * @returns {Record<string, number>}
 */
export function receiptTally(receipt) {
  const tally = { [ROW_APPLIED]: 0, [ROW_FAILED]: 0, [ROW_SKIPPED]: 0, [ROW_NOT_ATTEMPTED]: 0 };
  for (const r of receipt.rows) tally[r.status] = (tally[r.status] ?? 0) + 1;
  return tally;
}

/** @param {string} dir @param {string} planId @returns {string} */
export function planPath(dir, planId) {
  return path.join(dir, `plan-${planId}.json`);
}

/**
 * A receipt's path, which doubles as the artifact's spend record.
 *
 * An artifact is single-use: a partially applied plan must never be re-run, because the rows that
 * did land are no longer at their recorded baseline and the guard would skip them while the failed
 * ones retry against a store that has since moved. Recovery is a fresh audit-plan cycle, which
 * re-reads reality. The receipt file existing is what makes that enforceable with no extra state.
 *
 * @param {string} dir
 * @param {string} planId
 * @returns {string}
 */
export function receiptPath(dir, planId) {
  return path.join(dir, `receipt-${planId}.json`);
}

/**
 * Write JSON atomically: a crash leaves either the old file or the new one, never a torn one.
 * @param {string} filePath
 * @param {object} data
 */
export async function writeJsonAtomic(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmp, filePath);
}

/**
 * @param {string} filePath
 * @returns {Promise<object>}
 */
export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}
