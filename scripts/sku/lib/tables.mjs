// Load and validate the committed code tables.
//
// The tables are the source of truth for every SKU this tool derives, so a malformed table is not a
// cosmetic problem: a lowercase colour code or a duplicated design code produces SKUs that are
// wrong in a way nothing downstream can detect, on a field that is then frozen onto order lines.
// Validation therefore happens at load, on every command, and the same checks back `sku:tables` in
// CI. Nothing here touches the network or the filesystem except `loadTables`.
//
// See docs/sku-scheme.md for what the codes mean and what "append-only" obliges.

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TABLES_VERSION = 1;

/** The committed tables, resolved from this module rather than from cwd. */
export const TABLES_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tables.json');

/** A segment code: uppercase letters and digits, no hyphen (the hyphen is the separator). */
export const CODE_RE = /^[A-Z0-9]+$/;

/** Ambiguous against 0 and 1 when read off a label or transcribed by hand. */
export const AMBIGUOUS_CHARS = ['O', 'I'];

const SEGMENT_KINDS = new Set(['design', 'color', 'size', 'denomination']);

/**
 * Every code in the tables, with the scope that has to keep it unique.
 * Exported so the lint can report a count and refuse a vacuous pass on an empty file.
 * @param {object} tables
 * @returns {Array<{scope: string, key: string, code: string}>}
 */
export function allCodes(tables) {
  const out = [];
  for (const [handle, entry] of Object.entries(tables.products ?? {})) {
    out.push({ scope: 'product', key: handle, code: entry?.code });
  }
  for (const [value, code] of Object.entries(tables.colors ?? {})) {
    out.push({ scope: 'color', key: value, code });
  }
  for (const [ns, map] of Object.entries(tables.designs ?? {})) {
    for (const [value, code] of Object.entries(map ?? {})) {
      out.push({ scope: `design:${ns}`, key: value, code });
    }
  }
  for (const [value, code] of Object.entries(tables.denominations ?? {})) {
    out.push({ scope: 'denomination', key: value, code });
  }
  return out;
}

/**
 * Validate the tables, collecting every problem rather than throwing on the first.
 *
 * Collecting matters for the lint: an operator adding three codes at once should see all three
 * mistakes in one run, not one per round trip.
 *
 * @param {object} tables
 * @returns {string[]} problems, empty when the tables are valid
 */
export function validateTables(tables) {
  const problems = [];
  if (!tables || typeof tables !== 'object') return ['tables.json is not an object.'];
  if (tables.version !== TABLES_VERSION) {
    problems.push(`tables.json version is ${JSON.stringify(tables.version)}, expected ${TABLES_VERSION}.`);
  }

  const exempt = new Set(tables.ambiguityExemptions ?? []);
  const codes = allCodes(tables);
  if (!codes.length) problems.push('tables.json defines no codes at all.');

  for (const { scope, key, code } of codes) {
    const where = `${scope} "${key}"`;
    if (typeof code !== 'string' || !code) {
      problems.push(`${where} has no code.`);
      continue;
    }
    if (!CODE_RE.test(code)) {
      problems.push(`${where} code "${code}" is not uppercase letters and digits only.`);
    }
    if (!exempt.has(code)) {
      const bad = AMBIGUOUS_CHARS.filter((c) => code.includes(c));
      if (bad.length) {
        problems.push(
          `${where} code "${code}" contains ${bad.join(' and ')}, which is ambiguous against 0/1. ` +
            `Pick another code, or add it to ambiguityExemptions with a reason in docs/sku-scheme.md.`
        );
      }
    }
  }

  // Uniqueness, per scope. Colliding codes make two different things indistinguishable in every
  // export and order line that carries them.
  const byScope = new Map();
  for (const { scope, key, code } of codes) {
    if (typeof code !== 'string') continue;
    if (!byScope.has(scope)) byScope.set(scope, new Map());
    const seen = byScope.get(scope);
    if (seen.has(code)) problems.push(`${scope} code "${code}" is used by both "${seen.get(code)}" and "${key}".`);
    else seen.set(code, key);
  }

  for (const [handle, entry] of Object.entries(tables.products ?? {})) {
    const where = `product "${handle}"`;
    if (!entry || typeof entry !== 'object') {
      problems.push(`${where} is not an object.`);
      continue;
    }
    // The full SKU starts with the product code, and a SKU starting with 0 is silently rewritten by
    // spreadsheets and some barcode tooling. Segment codes may start with 0 (gift denominations do).
    if (typeof entry.code === 'string' && entry.code.startsWith('0')) {
      problems.push(`${where} code "${entry.code}" starts with 0; a SKU must never start with 0.`);
    }
    if (!Array.isArray(entry.segments) || !entry.segments.length) {
      problems.push(`${where} has no segments array.`);
      continue;
    }
    const options = new Set();
    for (const [i, seg] of entry.segments.entries()) {
      if (!seg || !SEGMENT_KINDS.has(seg.kind)) {
        problems.push(`${where} segment #${i} has unknown kind ${JSON.stringify(seg?.kind)}.`);
      }
      if (typeof seg?.option !== 'string' || !seg.option) {
        problems.push(`${where} segment #${i} has no option name.`);
      } else if (options.has(seg.option)) {
        problems.push(`${where} reads option "${seg.option}" twice.`);
      } else options.add(seg.option);
      if (seg?.kind === 'design' && !entry.designNamespace) {
        problems.push(`${where} has a design segment but no designNamespace.`);
      }
    }
    if (entry.designNamespace && !tables.designs?.[entry.designNamespace]) {
      problems.push(`${where} names design namespace "${entry.designNamespace}", which does not exist.`);
    }
    if (entry.skuWritable !== undefined && typeof entry.skuWritable !== 'boolean') {
      problems.push(`${where} skuWritable must be a boolean when present.`);
    }
  }

  return problems;
}

/**
 * A stable digest of the tables' meaning.
 *
 * Plan artifacts embed this and `apply` refuses when it no longer matches, because a table edit
 * changes what a previously approved plan would write. It hashes the parsed structure with sorted
 * keys, so reformatting the file does not void an approval but changing a code does.
 *
 * @param {object} tables
 * @returns {string}
 */
export function hashTables(tables) {
  const canonical = (v) => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .filter((k) => k !== 'readme')
          .map((k) => [k, canonical(v[k])])
      );
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(canonical(tables))).digest('hex');
}

/**
 * Parse and validate tables from raw JSON text.
 * @param {string} text
 * @param {string} [source] - for error messages
 * @returns {object}
 */
export function parseTables(text, source = 'tables.json') {
  let tables;
  try {
    tables = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${err.message}`);
  }
  const problems = validateTables(tables);
  if (problems.length) {
    throw new Error(`${source} is invalid:\n  - ${problems.join('\n  - ')}`);
  }
  return tables;
}

/**
 * Load the committed tables.
 * @param {string} [filePath]
 * @returns {Promise<object>}
 */
export async function loadTables(filePath = TABLES_PATH) {
  return parseTables(await readFile(filePath, 'utf8'), filePath);
}

/**
 * The product entry for a handle, or null when the product is not in the tables.
 * @param {object} tables
 * @param {string} handle
 * @returns {object|null}
 */
export function productEntry(tables, handle) {
  return tables.products?.[handle] ?? null;
}

/**
 * Whether this tool may write SKUs on a product. Defaults to true; the flag exists so a product the
 * API refuses (the gift card, if it comes to that) becomes an exempt class rather than a permanent
 * failure. See docs/sku-scheme.md.
 * @param {object|null} entry
 * @returns {boolean}
 */
export function isWritable(entry) {
  return entry?.skuWritable !== false;
}
