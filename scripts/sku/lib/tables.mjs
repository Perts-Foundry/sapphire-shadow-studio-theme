// Load and validate the committed code tables, merged with the catalogue manifest.
//
// The tables are the source of truth for every SKU CODE this tool derives, so a malformed table is
// not a cosmetic problem: a lowercase colour code or a duplicated design code produces SKUs that are
// wrong in a way nothing downstream can detect, on a field that is then frozen onto order lines.
// Validation therefore happens at load, on every command, and the same checks back `sku:tables` in
// CI. Nothing here touches the network or the filesystem except `loadTables`.
//
// WHAT THIS FILE NO LONGER HOLDS. It used to restate three things that catalogue.json now owns: the
// product census with every product's title, the colour vocabulary in its Admin display spelling,
// and each segment's Admin option NAME. All three are read from the manifest and merged in by
// `effectiveTables`, so downstream modules keep receiving one object with the shape they always had.
// The tables hold codes; the manifest holds the vocabulary those codes map.
//
// THE PRODUCT CENSUS IS CHECKED IN BOTH DIRECTIONS. A manifest product with no code cannot have a
// SKU derived; a table entry for a product the manifest does not declare maps codes onto nothing.
// Both refuse, so the two files cannot drift apart the way tables.json and photo-naming.mjs did.
//
// See docs/sku-scheme.md for what the codes mean and what "append-only" obliges.

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normaliseAxis } from '../../lib/vocab.mjs';
import { optionName, sizeValuesFor, loadCommittedCatalogue } from '../../lib/catalogue-manifest.mjs';

export const TABLES_VERSION = 2;

/** The committed tables, resolved from this module rather than from cwd. */
export const TABLES_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tables.json');

/** A segment code: uppercase letters and digits, no hyphen (the hyphen is the separator). */
export const CODE_RE = /^[A-Z0-9]+$/;

/** Ambiguous against 0 and 1 when read off a label or transcribed by hand. */
export const AMBIGUOUS_CHARS = ['O', 'I'];

/**
 * The segment kinds a product may declare.
 *
 * DERIVED FROM THE MANIFEST'S OPTION AXES, not restated. It was a hardcoded
 * `['design','color','size','denomination']` here, which is the same four axis ids the manifest
 * declares, and a fifth axis would have needed both edited in step with nothing checking.
 *
 * @param {object} manifest
 * @returns {Set<string>}
 */
export function segmentKinds(manifest) {
  return new Set(manifest.options.keys());
}

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
 * Validate the tables against the manifest, collecting every problem rather than throwing on the
 * first.
 *
 * Collecting matters for the lint: an operator adding three codes at once should see all three
 * mistakes in one run, not one per round trip.
 *
 * @param {object} tables - the RAW committed tables, before merging
 * @param {object} manifest
 * @returns {string[]} problems, empty when the tables are valid
 */
export function validateTables(tables, manifest) {
  const problems = [];
  if (!tables || typeof tables !== 'object') return ['tables.json is not an object.'];
  if (!manifest || !manifest.products) return ['validateTables needs the catalogue manifest.'];
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

  // The colour vocabulary, both directions, against the manifest. Keys are manifest colour IDS, not
  // Admin display spellings: the display spelling is the manifest's to state, and keying on it here
  // was the third casing of the same value.
  for (const key of Object.keys(tables.colors ?? {})) {
    if (!manifest.colors.has(key)) {
      const normalised = normaliseAxis(key, 'Color');
      problems.push(
        `colors "${key}" is not a colour declared in catalogue.json.` +
          `${manifest.colors.has(normalised) ? ` Keys here are colour IDS: use "${normalised}".` : ''}`
      );
    }
  }
  for (const id of manifest.colors.keys()) {
    if (!(id in (tables.colors ?? {}))) {
      problems.push(`colour "${id}" is declared in catalogue.json but has no code here.`);
    }
  }

  // The product census, both directions.
  for (const handle of Object.keys(tables.products ?? {})) {
    if (!manifest.products.has(handle)) {
      problems.push(
        `product "${handle}" is not declared in catalogue.json. A table entry for a product the ` +
          `manifest has never heard of maps codes onto nothing.`
      );
    }
  }
  for (const handle of manifest.products.keys()) {
    if (!(handle in (tables.products ?? {}))) {
      problems.push(
        `product "${handle}" is declared in catalogue.json but has no entry here, so no SKU can be ` +
          `derived for any of its variants.`
      );
    }
  }

  const kinds = segmentKinds(manifest);
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
    if ('title' in entry) {
      problems.push(
        `${where} carries a "title". Titles come from catalogue.json now; a second copy here is the ` +
          `duplication this migration removed.`
      );
    }
    if ('sizes' in entry) {
      problems.push(
        `${where} carries a "sizes" list. Size ranges come from catalogue.json now; a second copy ` +
          `here is the duplication this migration removed, and effectiveTables would silently ` +
          `overwrite it anyway.`
      );
    }
    if ('body' in entry) {
      problems.push(
        `${where} carries a "body". Garment bodies come from catalogue.json now; a second copy here ` +
          `is the duplication this migration removed.`
      );
    }
    if (!Array.isArray(entry.segments) || !entry.segments.length) {
      problems.push(`${where} has no segments array.`);
      continue;
    }
    const seen = new Set();
    for (const [i, seg] of entry.segments.entries()) {
      if (!seg || !kinds.has(seg.kind)) {
        problems.push(
          `${where} segment #${i} has unknown kind ${JSON.stringify(seg?.kind)}; catalogue.json ` +
            `declares the axes ${[...kinds].join(', ')}.`
        );
        continue;
      }
      if ('option' in seg) {
        problems.push(
          `${where} segment #${i} carries an "option" name. Option names come from catalogue.json's ` +
            `"options" now, keyed by the segment's own kind.`
        );
      }
      if (seen.has(seg.kind)) problems.push(`${where} reads the "${seg.kind}" axis twice.`);
      else seen.add(seg.kind);
      if (seg.kind === 'design' && !entry.designNamespace) {
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
 * Merge the committed codes with the manifest's vocabulary into the object every other module reads.
 *
 * The merged shape is deliberately the SHAPE THE TABLES USED TO HAVE, so `derive.mjs`, `audit.mjs`
 * and the planner keep their signatures: a product entry carries `title` and each segment carries
 * `option`, they are just no longer restated in the committed file. One thing is new and only used
 * downstream: `sizes`, the product's declared Admin size values, which is what lets `derive.mjs`
 * refuse a size the product does not sell rather than passing any uppercase token through (`null`
 * on a non-garment is also how a caller tells a garment from a gift card).
 *
 * Called only on tables `validateTables` has passed (see `parseTables`), so every handle here is
 * declared in the manifest; there is deliberately no fallback for a missing `declared`.
 *
 * @param {object} tables - the RAW committed tables
 * @param {object} manifest
 * @returns {object} the effective tables
 */
export function effectiveTables(tables, manifest) {
  const products = {};
  for (const [handle, entry] of Object.entries(tables.products ?? {})) {
    const declared = manifest.products.get(handle);
    products[handle] = {
      ...entry,
      title: declared.title,
      // A non-garment has no body and therefore no declared size range. `null` and not `[]`: an
      // empty list would read as "sells no sizes", and `derive.mjs` has to tell that apart from
      // "this axis does not apply here".
      sizes: declared.body !== null ? sizeValuesFor(manifest, handle) : null,
      segments: (entry.segments ?? []).map((seg) => ({
        ...seg,
        option: manifest.options.has(seg.kind) ? optionName(manifest, seg.kind) : undefined,
      })),
    };
  }
  return { ...tables, products };
}

/**
 * A stable digest of the tables' meaning, MERGED CONTRIBUTION INCLUDED.
 *
 * Plan artifacts embed this and `apply` refuses when it no longer matches, because a table edit
 * changes what a previously approved plan would write. Since half the derivation inputs now come
 * from the manifest, hashing only the committed file would let a manifest edit silently change every
 * derived SKU while `assertTablesUnchanged` went on passing an old approved plan. SKUs freeze onto
 * order lines, so that is the highest-consequence failure in this tool.
 *
 * WHAT IS DELIBERATELY EXCLUDED, and why the exclusion is load-bearing: anything that does not feed
 * derivation. A product `title` is merchandising copy and changes nothing about a SKU; a manifest
 * product with no entry in the tables contributes nothing. Hashing the merged whole indiscriminately
 * would invalidate every approved plan store-wide on a title typo fix, and nothing would notice that
 * it had. The projection below is exactly the derivation inputs, and both directions are pinned by
 * tests: a positive control (a manifest colour rename changes the hash) and a negative control (a
 * title fix, and a manifest product absent from the tables, do not).
 *
 * It hashes a canonical structure with sorted keys, so reformatting a file does not void an approval
 * but changing a code does.
 *
 * @param {object} tables - the EFFECTIVE tables
 * @returns {string}
 */
export function hashTables(tables) {
  const canonical = (v) => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, canonical(v[k])])
      );
    }
    return v;
  };

  const payload = {
    version: tables.version,
    ambiguityExemptions: [...(tables.ambiguityExemptions ?? [])].sort(),
    colors: tables.colors ?? {},
    designs: tables.designs ?? {},
    denominations: tables.denominations ?? {},
    products: Object.fromEntries(
      Object.entries(tables.products ?? {}).map(([handle, entry]) => [
        handle,
        {
          code: entry.code,
          designNamespace: entry.designNamespace ?? null,
          skuWritable: entry.skuWritable ?? null,
          // The option NAME is a derivation input: it is the key the variant's own options are read
          // by, so renaming an axis in Admin changes which value each segment sees.
          segments: (entry.segments ?? []).map((s) => ({ kind: s.kind, option: s.option ?? null })),
          // The declared size range is a derivation input too: it is what a size is validated
          // against before it passes through into the SKU.
          sizes: entry.sizes ?? null,
        },
      ])
    ),
  };
  return createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
}

/**
 * Parse and validate tables from raw JSON text, returning the effective merged tables.
 *
 * @param {string} text
 * @param {object} params
 * @param {object} params.manifest
 * @param {string} [params.source] - for error messages
 * @returns {object}
 */
export function parseTables(text, { manifest, source = 'tables.json' }) {
  let tables;
  try {
    tables = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${err.message}`);
  }
  const problems = validateTables(tables, manifest);
  if (problems.length) {
    throw new Error(`${source} is invalid:\n  - ${problems.join('\n  - ')}`);
  }
  return effectiveTables(tables, manifest);
}

/**
 * Load the committed tables and merge them with the committed manifest.
 *
 * @param {object} [params]
 * @param {string} [params.filePath]
 * @param {object} [params.manifest] - loaded from catalogue.json when absent
 * @returns {Promise<object>} the effective tables
 */
export async function loadTables({ filePath = TABLES_PATH, manifest = null } = {}) {
  // `loadCommittedCatalogue` is a static import: `scripts/lib/import-closure.mjs` refuses any
  // specifier a static walk cannot follow inside a guarded closure, and there is no reason for this
  // one to be the exception.
  const resolved = manifest ?? (await loadCommittedCatalogue());
  return parseTables(await readFile(filePath, 'utf8'), { manifest: resolved, source: filePath });
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
