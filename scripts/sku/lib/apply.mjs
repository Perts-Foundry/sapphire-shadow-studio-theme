// Execute an approved plan artifact, and nothing else.
//
// Three guards, in order, and none of them is redundant:
//
//  1. The BASELINE GUARD. Immediately before writing a product's rows, its live SKUs are re-read
//     and every row whose live value has moved off the recorded baseline is skipped, not written.
//     The plan may have been approved minutes or days ago; a SKU set by hand in Admin in between is
//     a decision this tool must not silently overwrite.
//  2. The ALREADY-SET check. A row whose live value already equals the expected SKU is skipped as a
//     no-op rather than written, so a resumed or duplicated run does not churn the field.
//  3. CONTINUE-ON-ERROR, per row. One rejected variant must not abandon the other 430. Every row
//     reaches a terminal status in the receipt, and the receipt is persisted after every batch so a
//     crash leaves a readable record of exactly how far the run got.
//
// The re-read happens per product, inside the loop, on purpose: reading everything once up front
// would not see the store moving during the run, which is the case the guard exists for.

import { batch } from './mutations.mjs';
import { markRow, ROW_APPLIED, ROW_FAILED, ROW_SKIPPED } from './artifact.mjs';

/**
 * @param {object} params
 * @param {object} params.artifact - already verified (hash + tables hash)
 * @param {object} params.receipt - a fresh receipt for that artifact
 * @param {(productId: string) => Promise<Map<string, string|null>>} params.readSkus - live re-read
 * @param {(productId: string, rows: object[]) => Promise<{byVariant: Map<string, object>}>} params.write
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] - classify and report, write nothing
 * @param {(receipt: object) => Promise<void>} [opts.persist] - called after each batch
 * @param {(event: object) => void} [opts.onProgress]
 * @param {number} [opts.batchSize]
 * @returns {Promise<object>} the receipt
 */
export async function applyArtifact({ artifact, receipt, readSkus, write }, opts = {}) {
  const { dryRun = false, persist = async () => {}, onProgress = () => {}, batchSize } = opts;

  const byProduct = new Map();
  for (const row of artifact.rows) {
    if (!byProduct.has(row.productId)) byProduct.set(row.productId, []);
    byProduct.get(row.productId).push(row);
  }

  for (const [productId, rows] of byProduct) {
    let live;
    try {
      live = await readSkus(productId);
    } catch (err) {
      // The whole product is unverifiable, so none of its rows may be written. Failing them is the
      // conservative outcome: a failed row is retried through a fresh plan, which re-reads.
      for (const row of rows) markRow(receipt, row.variantId, ROW_FAILED, `baseline re-read failed: ${err.message}`);
      onProgress({ type: 'product-error', productId, message: err.message, rows: rows.length });
      await persist(receipt);
      continue;
    }

    const writable = [];
    for (const row of rows) {
      if (!live.has(row.variantId)) {
        markRow(receipt, row.variantId, ROW_SKIPPED, 'variant no longer exists on this product');
        continue;
      }
      const current = live.get(row.variantId);
      if (current === row.expectedSku) {
        markRow(receipt, row.variantId, ROW_SKIPPED, 'already holds the expected SKU');
        continue;
      }
      if (current !== (row.baselineSku ?? null)) {
        markRow(
          receipt,
          row.variantId,
          ROW_SKIPPED,
          `baseline moved: planned from ${fmt(row.baselineSku)}, now ${fmt(current)}. Not overwriting a value ` +
            `set since the plan was approved.`
        );
        continue;
      }
      writable.push(row);
    }

    onProgress({ type: 'product', productId, planned: rows.length, writable: writable.length });
    if (dryRun) {
      for (const row of writable) markRow(receipt, row.variantId, ROW_SKIPPED, 'dry run: would write');
      await persist(receipt);
      continue;
    }

    for (const chunk of batch(writable, batchSize)) {
      try {
        const { byVariant } = await write(productId, chunk);
        for (const row of chunk) {
          const outcome = byVariant.get(row.variantId);
          if (outcome?.ok && outcome.sku === row.expectedSku) {
            markRow(receipt, row.variantId, ROW_APPLIED, null);
          } else if (outcome?.ok) {
            // The API accepted the row but the value it reports back is not the one requested.
            // Reporting that as applied would put a wrong SKU in the receipt as the new truth.
            markRow(receipt, row.variantId, ROW_FAILED, `wrote ${fmt(outcome.sku)}, expected ${fmt(row.expectedSku)}`);
          } else {
            markRow(receipt, row.variantId, ROW_FAILED, `${outcome?.code ?? 'unknown'}: ${outcome?.message ?? 'no outcome returned'}`);
          }
        }
      } catch (err) {
        for (const row of chunk) markRow(receipt, row.variantId, ROW_FAILED, `mutation threw: ${err.message}`);
        onProgress({ type: 'batch-error', productId, message: err.message, rows: chunk.length });
      }
      await persist(receipt);
    }
  }

  receipt.finishedAt = new Date().toISOString();
  receipt.dryRun = dryRun;
  await persist(receipt);
  return receipt;
}

const fmt = (v) => (v === null || v === undefined ? '(none)' : `"${v}"`);
