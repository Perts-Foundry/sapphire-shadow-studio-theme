// Turn an audit report into the rows `apply` will write.
//
// The planner REFUSES rather than reports. Everything it refuses on is a condition where writing
// part of the catalogue leaves it in a state that reads as complete and is not: an unmapped value
// means some variants of a product get SKUs and its siblings never do, and a collision means two
// variants would claim one identifier. A half-populated SKU field is worse than an empty one,
// because a SKU filter then silently returns an incomplete set, so the refusal is the feature.
//
// Nulls only by default. Repairing a mismatch overwrites a value that may already be printed on a
// packing slip or frozen onto an order line, so it takes an explicit opt-in.

import { OK, MISS, MISMATCH, NULL_ACTIONABLE, NULL_EXEMPT } from './audit.mjs';
import { MODE_NULLS, MODE_NULLS_AND_MISMATCHES } from './artifact.mjs';

export class PlanRefused extends Error {
  /** @param {string[]} reasons */
  constructor(reasons) {
    super(`Refusing to plan:\n  - ${reasons.join('\n  - ')}`);
    this.name = 'PlanRefused';
    this.reasons = reasons;
  }
}

/**
 * Build the write rows for a plan.
 *
 * @param {object} report - from auditCatalogue
 * @param {object} [opts]
 * @param {boolean} [opts.includeMismatches]
 * @returns {{rows: object[], refused: object[], mode: string}}
 * @throws {PlanRefused}
 */
export function buildPlan(report, opts = {}) {
  const { includeMismatches = false } = opts;
  const mode = includeMismatches ? MODE_NULLS_AND_MISMATCHES : MODE_NULLS;
  const reasons = [];

  if (report.misses.length) {
    reasons.push(
      `${report.misses.length} unmapped value(s) or unknown product(s) remain. Writing now would ` +
        `leave those variants without SKUs while their siblings have them. Add the codes to ` +
        `tables.json first (see docs/sku-scheme.md), then re-run audit.`
    );
    for (const m of report.misses) reasons.push(`  ${m.kind}: ${m.message} (${m.variantCount} variant(s))`);
  }
  for (const d of report.duplicates) {
    reasons.push(`expected SKU ${d.sku} is derived by ${d.variantIds.length} variants (${d.products.join(', ')}); the tables cannot tell them apart`);
  }
  for (const c of report.collisions) {
    reasons.push(`expected SKU ${c.sku} is already live on a different variant (${c.heldBy}, ${c.heldByProduct})`);
  }
  if (reasons.length) throw new PlanRefused(reasons);

  const rows = [];
  const refused = [];
  for (const r of report.rows) {
    if (r.status === NULL_EXEMPT) {
      refused.push({
        variantId: r.variantId,
        productHandle: r.productHandle,
        reason: `product is marked skuWritable: false in tables.json; its nulls are an exempt class`,
      });
      continue;
    }
    if (r.status === OK || r.status === MISS) continue;
    if (r.status === MISMATCH && !includeMismatches) {
      refused.push({
        variantId: r.variantId,
        productHandle: r.productHandle,
        reason: `has SKU "${r.sku}" but derives "${r.expected}"; drift repair needs --include-mismatches`,
      });
      continue;
    }
    if (r.status !== NULL_ACTIONABLE && r.status !== MISMATCH) continue;
    rows.push({
      variantId: r.variantId,
      productId: r.productId,
      productHandle: r.productHandle,
      variantTitle: r.variantTitle,
      baselineSku: r.sku,
      expectedSku: r.expected,
    });
  }

  if (!rows.length) {
    throw new PlanRefused(['nothing to write: every variant either has its derived SKU already or is exempt']);
  }

  // Belt and braces. The audit-level checks above cover the catalogue; these cover the plan itself,
  // so a future caller that assembles rows another way cannot bypass them.
  const seen = new Map();
  for (const row of rows) {
    if (seen.has(row.expectedSku)) {
      throw new PlanRefused([`plan would write ${row.expectedSku} to both ${seen.get(row.expectedSku)} and ${row.variantId}`]);
    }
    seen.set(row.expectedSku, row.variantId);
  }

  return { rows, refused, mode };
}
