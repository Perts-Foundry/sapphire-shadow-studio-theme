// The plan artifact and the apply receipt.
//
// THE ARTIFACT IS THE CONTRACT between the operator's approval and what `apply` executes. Without
// it, "never write wider than the approved plan" is a sentence in a document rather than an
// enforced invariant: write-target selection is state-dependent, so an apply that re-derived from
// live state could legitimately pick a DIFFERENT variant than the one the operator reviewed, and
// compare-and-swap would not catch it (CAS guards the value on a given variant, not the choice of
// variant). So `plan` emits an immutable, hashed artifact and `apply` consumes only that.
//
// The receipt is written incrementally with an atomic write-then-rename, so a crash mid-run leaves
// a parseable, resumable record rather than a truncated file or a silent gap.

import { createHash, randomUUID } from 'node:crypto';
import { writeFile, rename, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const ROW_APPLIED = 'applied';
export const ROW_FAILED = 'failed';
export const ROW_NOT_ATTEMPTED = 'not-attempted';
export const ROW_SKIPPED = 'skipped';

export const ARTIFACT_VERSION = 1;

/** Fields that define an artifact's identity. Order matters for a stable hash. */
function canonicalPayload(artifact) {
  return JSON.stringify({
    version: artifact.version,
    planId: artifact.planId,
    mode: artifact.mode,
    groups: artifact.groups.map((g) => ({
      blankId: g.blankId,
      target: g.target,
      baseline: g.baseline,
      delta: g.delta,
      writeTargetId: g.writeTargetId,
      inventoryItemId: g.inventoryItemId,
      memberIds: [...g.memberIds].sort(),
      idempotencyKey: g.idempotencyKey,
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
 * @param {object[]} params.plans
 * @param {object[]} [params.skipped]
 * @param {string} params.mode
 * @param {string} [params.planId]
 * @param {string} [params.createdAt]
 * @returns {object}
 */
export function createArtifact({ plans, skipped = [], mode, planId = randomUUID(), createdAt = new Date().toISOString() }) {
  const artifact = {
    version: ARTIFACT_VERSION,
    planId,
    createdAt,
    mode,
    groups: plans.map((p) => ({
      blankId: p.blankId,
      target: p.target,
      current: p.current,
      baseline: p.baseline,
      delta: p.delta,
      writeTargetId: p.writeTargetId,
      writeTargetTitle: p.writeTargetTitle,
      inventoryItemId: p.inventoryItemId,
      memberIds: p.memberIds,
      siblingCount: p.siblingCount,
      idempotencyKey: p.idempotencyKey,
    })),
    skipped: skipped.map((s) => ({ blankId: s.blankId, reason: s.reason, current: s.current, target: s.target })),
  };
  artifact.contentHash = hashArtifact(artifact);
  return artifact;
}

/**
 * Reject an artifact that no longer matches the plan that produced it.
 *
 * Scope, so this is not mistaken for more than it is: the hash is unkeyed and computed from the
 * artifact's own fields, so anyone who edits the file can recompute it. This catches an ACCIDENTAL
 * edit (a tweaked quantity, a hand-patched write target) between approval and apply. It is not a
 * tamper-proofing control against someone with write access to the working directory, who could
 * equally just author a fresh artifact. The operator approval STOP is what authorises a plan; this
 * checks the bytes did not drift after it.
 *
 * @param {object} artifact
 * @returns {object} the artifact
 */
export function verifyArtifact(artifact) {
  if (!artifact || artifact.version !== ARTIFACT_VERSION) {
    throw new Error(`Unsupported plan artifact (version ${artifact?.version}). Re-run plan.`);
  }
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
 * Narrow an artifact to a subset of groups, as a NEW plan with a new id.
 *
 * This is the gate-5 rejection path: an operator may strike groups, and what they then approve is a
 * fresh artifact. Reusing the original plan id would also reuse its derived idempotency keys, so a
 * later full re-run could be silently deduped against this narrowed one.
 *
 * @param {object} artifact
 * @param {Iterable<string>} keepBlankIds
 * @param {(parts: object) => string} deriveKey
 * @param {object} [opts]
 * @returns {object}
 */
export function narrowArtifact(artifact, keepBlankIds, deriveKey, opts = {}) {
  const keep = new Set(keepBlankIds);
  const planId = opts.planId ?? randomUUID();
  const kept = artifact.groups.filter((g) => keep.has(g.blankId));
  if (!kept.length) throw new Error('Narrowing removed every group; nothing left to apply.');
  const next = {
    ...artifact,
    planId,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    narrowedFrom: artifact.planId,
    groups: kept.map((g) => ({
      ...g,
      idempotencyKey: deriveKey({ planId, blankId: g.blankId, target: g.target, mode: artifact.mode }),
    })),
  };
  next.contentHash = hashArtifact(next);
  return next;
}

/**
 * A fresh receipt: every group not yet attempted.
 * @param {object} artifact
 * @returns {object}
 */
export function createReceipt(artifact) {
  return {
    planId: artifact.planId,
    contentHash: artifact.contentHash,
    mode: artifact.mode,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    preRunSnapshot: null,
    rows: artifact.groups.map((g) => ({
      blankId: g.blankId,
      writeTargetId: g.writeTargetId,
      target: g.target,
      status: ROW_NOT_ATTEMPTED,
      detail: null,
      at: null,
    })),
  };
}

/**
 * Record a terminal outcome for one group.
 * @param {object} receipt
 * @param {string} blankId
 * @param {string} status
 * @param {string|null} [detail]
 * @returns {object} the same receipt, mutated
 */
export function markRow(receipt, blankId, status, detail = null) {
  const row = receipt.rows.find((r) => r.blankId === blankId);
  if (!row) throw new Error(`Receipt has no row for blank "${blankId}".`);
  row.status = status;
  row.detail = detail;
  row.at = new Date().toISOString();
  return receipt;
}

/**
 * A run is complete only when every row reached a terminal state. A crash leaves rows at
 * not-attempted, which is what makes a resumed run able to tell what is left.
 * @param {object} receipt
 * @returns {boolean}
 */
export function isReceiptComplete(receipt) {
  return receipt.rows.every((r) => r.status !== ROW_NOT_ATTEMPTED);
}

/**
 * Groups still to do on a resumed run. A failed row is retried; CAS plus the derived idempotency
 * key make that safe.
 * @param {object} receipt
 * @returns {string[]}
 */
export function pendingBlankIds(receipt) {
  return receipt.rows.filter((r) => r.status === ROW_NOT_ATTEMPTED || r.status === ROW_FAILED).map((r) => r.blankId);
}

/**
 * Blanks whose seed write is outstanding, for audit's drift-versus-awaiting-seed call.
 * @param {object[]} receipts
 * @returns {Set<string>}
 */
export function pendingSeedBlankIds(receipts) {
  const pending = new Set();
  for (const receipt of receipts) {
    if (!receipt?.seeding) continue;
    for (const row of receipt.rows) {
      if (row.status !== ROW_APPLIED) pending.add(row.blankId);
    }
  }
  return pending;
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
