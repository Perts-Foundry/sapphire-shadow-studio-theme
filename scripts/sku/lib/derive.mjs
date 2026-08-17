// Derive a variant's SKU from its own option values.
//
// Pure, total, and the only place a SKU string is ever built. It returns a typed miss instead of
// throwing or guessing, because every miss is an operator decision (add a code, add a product) and
// a guess would put a wrong identifier onto an order line where nothing would ever question it.
//
// A miss is never "close enough": there is no fuzzy matching against the tables on purpose. Option
// strings are copied out of Admin verbatim, so a near miss means the value genuinely changed.

import { productEntry } from './tables.mjs';

export const MISS_UNKNOWN_PRODUCT = 'unknown-product';
export const MISS_UNMAPPED_VALUE = 'unmapped-value';
export const MISS_MISSING_OPTION = 'missing-option';
export const MISS_INVALID_VALUE = 'invalid-value';

/** Sizes pass through rather than living in a table; they are already short uppercase tokens. */
const PASSTHROUGH_RE = /^[A-Z0-9]+$/;

/**
 * @typedef {object} DeriveHit
 * @property {true} ok
 * @property {string} sku
 * @property {string[]} segments
 *
 * @typedef {object} DeriveMiss
 * @property {false} ok
 * @property {string} kind - one of the MISS_* constants
 * @property {string} option - the option name involved, or '' for unknown-product
 * @property {string|null} value - the offending value, verbatim
 * @property {string} message - operator-facing, names what to add and where
 */

/**
 * Look a value up in the table for one segment kind.
 * @param {object} tables
 * @param {object} entry
 * @param {{kind: string, option: string}} seg
 * @param {string} value
 * @returns {{code: string}|{miss: string, message: string}}
 */
function lookupSegment(tables, entry, seg, value) {
  switch (seg.kind) {
    case 'color': {
      const code = tables.colors?.[value];
      return code ? { code } : { miss: MISS_UNMAPPED_VALUE, message: `colors: add "${value}"` };
    }
    case 'design': {
      const ns = entry.designNamespace;
      const code = tables.designs?.[ns]?.[value];
      return code ? { code } : { miss: MISS_UNMAPPED_VALUE, message: `designs.${ns}: add "${value}"` };
    }
    case 'denomination': {
      const code = tables.denominations?.[value];
      return code ? { code } : { miss: MISS_UNMAPPED_VALUE, message: `denominations: add "${value}"` };
    }
    case 'size': {
      const code = value.trim().toUpperCase();
      if (!PASSTHROUGH_RE.test(code)) {
        return {
          miss: MISS_INVALID_VALUE,
          message: `size "${value}" is not letters and digits, so it cannot pass through into a SKU`,
        };
      }
      return { code };
    }
    default:
      // Unreachable through validated tables; kept so a future kind fails loudly rather than
      // silently dropping a segment out of every SKU it touches.
      return { miss: MISS_INVALID_VALUE, message: `unknown segment kind "${seg.kind}"` };
  }
}

/**
 * Derive the expected SKU for one variant.
 *
 * @param {object} tables
 * @param {object} variant - {productHandle, options: {[name]: value}}
 * @returns {DeriveHit|DeriveMiss}
 */
export function deriveSku(tables, variant) {
  const entry = productEntry(tables, variant.productHandle);
  if (!entry) {
    return {
      ok: false,
      kind: MISS_UNKNOWN_PRODUCT,
      option: '',
      value: variant.productHandle ?? null,
      message:
        `product "${variant.productHandle}" is not in tables.json. Add it with a code and a ` +
        `segments array before any SKU can be derived for it.`,
    };
  }

  const segments = [entry.code];
  for (const seg of entry.segments) {
    const value = variant.options?.[seg.option];
    if (value === undefined || value === null || String(value).trim() === '') {
      return {
        ok: false,
        kind: MISS_MISSING_OPTION,
        option: seg.option,
        value: null,
        message:
          `variant has no "${seg.option}" option, but ${variant.productHandle} declares one. The ` +
          `product's options changed; update its segments in tables.json.`,
      };
    }
    const got = lookupSegment(tables, entry, seg, String(value));
    if (got.miss) {
      return {
        ok: false,
        kind: got.miss,
        option: seg.option,
        value: String(value),
        message: `${variant.productHandle} ${seg.option} "${value}": ${got.message}`,
      };
    }
    segments.push(got.code);
  }

  return { ok: true, sku: segments.join('-'), segments };
}

/**
 * Reject a SKU that breaks a scheme rule the tables cannot enforce on their own.
 *
 * The leading-zero rule is about the assembled string, not about any one code: a segment may start
 * with 0 (gift denominations do), the whole SKU may not. See docs/sku-scheme.md.
 *
 * @param {string} sku
 * @returns {string|null} the problem, or null
 */
export function skuProblem(sku) {
  if (typeof sku !== 'string' || !sku) return 'empty SKU';
  if (sku.startsWith('0')) return `"${sku}" starts with 0; spreadsheets and barcode tooling strip it`;
  if (!/^[A-Z0-9-]+$/.test(sku)) return `"${sku}" has characters outside A-Z, 0-9 and hyphen`;
  if (sku.includes('--') || sku.endsWith('-')) return `"${sku}" has an empty segment`;
  return null;
}
