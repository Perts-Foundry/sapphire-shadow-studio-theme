// The health report. Pure: catalogue in, classified report out.
//
// Audit is the entry point to every other command and the exit check after one, so its
// classification is the tool's whole vocabulary. Two rules shape it:
//
//  - A variant is never silently uninteresting. Every variant lands in exactly one status, and the
//    counts add up to the catalogue size. A half-populated SKU field is worse than an empty one,
//    and the way that happens is a class nobody counted.
//  - Actionable and exempt are separated. A product the API will not let this tool write (see
//    `skuWritable` in docs/sku-scheme.md) would otherwise leave the tool in permanent failure, so
//    its nulls are counted apart and the steady-state target is "0 actionable nulls".

import { deriveSku, skuProblem } from './derive.mjs';
import { productEntry, isWritable } from './tables.mjs';

export const OK = 'ok';
export const NULL_ACTIONABLE = 'null-actionable';
export const NULL_EXEMPT = 'null-exempt';
export const MISMATCH = 'mismatch';
export const MISS = 'miss';

/**
 * Classify every variant and cross-check the derived SKUs against each other and against live ones.
 *
 * @param {object} tables
 * @param {object[]} variants - normalised catalogue variants
 * @returns {object} the report
 */
export function auditCatalogue(tables, variants) {
  const rows = [];

  for (const v of variants) {
    const entry = productEntry(tables, v.productHandle);
    const writable = isWritable(entry);
    const derived = deriveSku(tables, v);

    if (!derived.ok) {
      rows.push({ ...rowBase(v), status: MISS, expected: null, writable, miss: derived });
      continue;
    }

    const problem = skuProblem(derived.sku);
    if (problem) {
      // The tables validated, but the assembled string still breaks a scheme rule. Reported as a
      // miss so it reaches the operator as a tables decision rather than being written.
      rows.push({
        ...rowBase(v),
        status: MISS,
        expected: derived.sku,
        writable,
        miss: { ok: false, kind: 'invalid-value', option: '', value: derived.sku, message: `derived SKU ${problem}` },
      });
      continue;
    }

    if (v.sku === null) {
      rows.push({ ...rowBase(v), status: writable ? NULL_ACTIONABLE : NULL_EXEMPT, expected: derived.sku, writable });
    } else if (v.sku === derived.sku) {
      rows.push({ ...rowBase(v), status: OK, expected: derived.sku, writable });
    } else {
      rows.push({ ...rowBase(v), status: MISMATCH, expected: derived.sku, writable });
    }
  }

  return {
    total: variants.length,
    rows,
    counts: countBy(rows),
    misses: summariseMisses(rows),
    duplicates: duplicateExpected(rows),
    collisions: crossCollisions(rows),
    ...verdict(rows),
  };
}

function rowBase(v) {
  return {
    variantId: v.id,
    productId: v.productId,
    productHandle: v.productHandle,
    productTitle: v.productTitle,
    variantTitle: v.title,
    sku: v.sku,
    isGiftCard: v.isGiftCard,
  };
}

function countBy(rows) {
  const counts = { [OK]: 0, [NULL_ACTIONABLE]: 0, [NULL_EXEMPT]: 0, [MISMATCH]: 0, [MISS]: 0 };
  for (const r of rows) counts[r.status]++;
  return counts;
}

/**
 * One entry per distinct (product, option, value) that could not be mapped, with a count.
 *
 * Grouped rather than listed per variant because one missing colour code produces 48 identical
 * rows, and a report the operator scrolls past is a report that does not get read.
 *
 * @param {object[]} rows
 * @returns {object[]}
 */
export function summariseMisses(rows) {
  const byKey = new Map();
  for (const r of rows) {
    if (r.status !== MISS) continue;
    const key = `${r.miss.kind} ${r.productHandle} ${r.miss.option} ${r.miss.value}`;
    const hit = byKey.get(key);
    if (hit) {
      hit.variantCount++;
      continue;
    }
    byKey.set(key, {
      kind: r.miss.kind,
      productHandle: r.productHandle,
      productTitle: r.productTitle,
      option: r.miss.option,
      value: r.miss.value,
      message: r.miss.message,
      variantCount: 1,
    });
  }
  return [...byKey.values()].sort((a, b) => b.variantCount - a.variantCount);
}

/**
 * Expected SKUs that two or more variants both derive.
 *
 * This is a tables defect, not a store defect: it means the scheme cannot tell two variants apart.
 * Nothing may be written while one exists, because whichever row is applied second would either
 * fail or produce two variants sharing an identifier.
 *
 * @param {object[]} rows
 * @returns {object[]}
 */
export function duplicateExpected(rows) {
  const byExpected = new Map();
  for (const r of rows) {
    if (!r.expected || r.status === MISS) continue;
    if (!byExpected.has(r.expected)) byExpected.set(r.expected, []);
    byExpected.get(r.expected).push(r);
  }
  return [...byExpected.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([sku, group]) => ({
      sku,
      variantIds: group.map((r) => r.variantId),
      products: [...new Set(group.map((r) => r.productHandle))],
    }));
}

/**
 * An expected SKU that is already live on a *different* variant.
 *
 * Distinct from a duplicate: the tables may be perfectly consistent and a stale hand-typed SKU
 * still sit on the wrong variant. Writing over that would leave two variants claiming one
 * identifier until the other row was applied, which may never happen.
 *
 * @param {object[]} rows
 * @returns {object[]}
 */
export function crossCollisions(rows) {
  const liveOwner = new Map();
  for (const r of rows) {
    if (r.sku) liveOwner.set(r.sku, r);
  }
  const out = [];
  for (const r of rows) {
    if (!r.expected || r.status === OK || r.status === MISS) continue;
    const owner = liveOwner.get(r.expected);
    if (owner && owner.variantId !== r.variantId) {
      out.push({
        sku: r.expected,
        wantedBy: r.variantId,
        wantedByProduct: r.productHandle,
        heldBy: owner.variantId,
        heldByProduct: owner.productHandle,
      });
    }
  }
  return out;
}

/**
 * The pass/fail call and the reasons behind it.
 *
 * Exempt nulls are deliberately not a reason to fail: they are a recorded API limitation, and a
 * tool whose steady state is "exit 1 forever" stops being read.
 *
 * @param {object[]} rows
 * @returns {{ok: boolean, problems: string[]}}
 */
export function verdict(rows) {
  const counts = countBy(rows);
  const problems = [];
  if (counts[NULL_ACTIONABLE]) problems.push(`${counts[NULL_ACTIONABLE]} variant(s) have no SKU and could have one`);
  if (counts[MISMATCH]) problems.push(`${counts[MISMATCH]} variant(s) have a SKU that is not the derived one`);
  if (counts[MISS]) problems.push(`${counts[MISS]} variant(s) have no derivable SKU (see the unmapped section)`);
  const dupes = duplicateExpected(rows);
  if (dupes.length) problems.push(`${dupes.length} expected SKU(s) are derived by more than one variant`);
  const collisions = crossCollisions(rows);
  if (collisions.length) problems.push(`${collisions.length} expected SKU(s) are already live on a different variant`);
  return { ok: problems.length === 0, problems };
}
