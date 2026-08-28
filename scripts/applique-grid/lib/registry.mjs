// The committed pattern registry (scripts/applique-grid/patterns.json): schema validation,
// byte-stable serialization, numbering, and the derived dropdown text. Pure fs + naming.mjs.
//
// The registry is the single source of truth for the Huddle Crewneck's applique patterns: the
// numbered chart images, the product-page dropdown, and the audit all derive from it. Numbering
// derives from active-pattern position order on every regeneration; past orders keep their
// verbatim property strings, so renumbering is safe for history and chatty for charts (most spec
// hashes change), which is correct and documented in the README.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ID_RE,
  loadCatalogue,
  productByHandle,
  colorValuesFor,
  CATALOGUE_PATH,
} from '../../lib/catalogue-manifest.mjs';
import { atomicWrite } from './atomic-write.mjs';
import { charsetProblem, nameColorProblem } from './naming.mjs';
import { nameCharCeiling } from './layout.mjs';
import { MAX_OPTION_LINE } from './options-writer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..', '..', '..');

/** The committed registry path. */
export const REGISTRY_PATH = path.join(HERE, '..', 'patterns.json');

export const STATUSES = ['active', 'discontinued'];

// ID_RE and PRODUCT_GID_RE used to be declared here and were COPIED into the schema module when it
// was written, with a test asserting the two copies stayed byte-identical. The copies are gone:
// PRODUCT_GID_RE has no caller left here (the GID comes from the manifest, which already checked
// its shape), and ID_RE, which still guards pattern ids, is imported from the one definition.
export const MEDIA_GID_RE = /^gid:\/\/shopify\/MediaImage\/\d+$/;
const SPEC_HASH_RE = /^[0-9a-f]{64}$/;
// Manifests and the registry hold photo BASENAMES only; a path separator means someone recorded a
// dev-machine path, which must never enter this public repo.
const BASENAME_RE = /^[^/\\]+\.(heic|heif)$/i;

// Every key this schema knows, per container. Anything else is REJECTED BY NAME rather than
// ignored: a misspelled `pin_after_chart` that silently does nothing would let the next publish
// move the operator's pinned media and undo an Admin fix, with the registry looking correct.
const KNOWN_KEYS = {
  // `product` is the DERIVED block `materialise` attaches, never a committed key: a committed one
  // is refused there by name before validation ever runs.
  '': ['version', 'handle', 'product', 'threads', 'chart', 'gallery', 'patterns', 'published'],
  chart: ['columns', 'rows', 'cell_aspect', 'cell_fit', 'title', 'width_units', 'scale', 'styleVersion'],
  gallery: ['pin_after_charts'],
  pattern: ['id', 'name', 'thread', 'status', 'sources', 'hero', 'crop', 'position'],
  crop: ['left', 'top', 'width', 'height'],
  published: ['page', 'filename', 'mediaGid', 'alt', 'specHash'],
};

function pushUnknownKeys(obj, kind, label, push) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  const allowed = new Set(KNOWN_KEYS[kind]);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) push(`${label}: unknown key ${JSON.stringify(k)} (allowed: ${KNOWN_KEYS[kind].join(', ')})`);
  }
}

/**
 * The media GIDs pinned AFTER the chart block, in declared order. Absent `gallery` and an empty
 * list return the same value, so a truthiness bug on an empty array cannot flip gallery ordering.
 * @param {object} reg
 * @returns {string[]}
 */
export function pinnedMedia(reg) {
  const list = reg?.gallery?.pin_after_charts;
  return Array.isArray(list) ? list.slice() : [];
}

/** The kebab-case id a pattern name derives to; uniqueness is enforced on this too. Apostrophes
 * are stripped (not hyphenated) so a possessive reads naturally: "Willow's Path" -> willows-path. */
export function deriveId(name) {
  return String(name).toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * The empty bootstrap registry this module ships with. The first skill run populates threads and
 * patterns; until then the cohesion test recognises exactly this serialization as "not yet run".
 * @returns {object}
 */
export function emptyRegistry() {
  return {
    version: 1,
    handle: 'huddle-crewneck',
    threads: [],
    chart: {
      columns: 3,
      rows: 3,
      cell_aspect: 0.75,
      cell_fit: 'cover',
      title: 'Applique Patterns',
      width_units: 1600,
      scale: 2,
      // 2: cells are colour-managed to real sRGB at ingest (was: the decoder's bare RGBA, which
      // read Display P3 numbers as sRGB and rendered the fabric dull). See lib/heic.mjs.
      // 3: the cell label is two lines, with the thread on its own line as "Thread: x" (was: a
      // bare "(x)" parenthetical, which reads as the fabric's colour next to a fabric photo).
      styleVersion: 3,
    },
    patterns: [],
    published: [],
  };
}

/**
 * Byte-stable serialization: the same shape template writes use, plus the trailing newline.
 *
 * `product` is DROPPED. It is materialised onto a loaded registry from catalogue.json (see
 * `materialise`), so writing it back would put the GID and the colour list into the committed file
 * again, which is exactly the duplication this removed. Dropping it here rather than at each call
 * site means a caller cannot forget: every write goes through this function.
 */
export function serialize(reg) {
  const { product, ...rest } = reg;
  return `${JSON.stringify(rest, null, 2)}\n`;
}

/** The exact bytes of the shipped bootstrap sentinel. */
export const EMPTY_SENTINEL = serialize(emptyRegistry());

/** @param {string} raw @returns {boolean} byte-equality, not structural emptiness */
export function isEmptySentinel(raw) {
  return raw === EMPTY_SENTINEL;
}

/**
 * Every schema problem in the registry, as human-readable strings. Empty array = valid.
 * @param {object} reg
 * @returns {string[]}
 */
export function validate(reg) {
  const problems = [];
  const push = (msg) => problems.push(msg);

  if (!reg || typeof reg !== 'object') return ['registry is not an object'];
  if (reg.version !== 1) push(`version must be 1, got ${JSON.stringify(reg.version)}`);
  pushUnknownKeys(reg, '', 'registry', push);

  // The product this registry charts. A scalar handle in the committed file; the GID and the Color
  // option values are catalogue.json's to state, and `materialise` attaches them. Shape checks on
  // the handle string are gone with them: `productByHandle` refuses an undeclared handle by name,
  // which is a stronger statement than "looks kebab-case" and cannot pass on a plausible typo.
  if (typeof reg.handle !== 'string' || !reg.handle) push('handle is missing');
  const colorValues = Array.isArray(reg.product?.colorValues) ? reg.product.colorValues : [];
  // Derived from the chart geometry these patterns will actually render at, so a denser grid
  // tightens it. Only computable when the chart params themselves are sane.
  const ceiling = Number.isInteger(reg.chart?.columns) && reg.chart.columns > 0
    && Number.isFinite(reg.chart?.width_units) && reg.chart.width_units >= 800
    ? nameCharCeiling(reg.chart, MAX_OPTION_LINE)
    : null;

  // threads
  if (!Array.isArray(reg.threads)) {
    push('threads must be an array');
  } else {
    reg.threads.forEach((t, i) => {
      const p = charsetProblem(t, `threads[${i}]`);
      if (p) push(p);
    });
    const dupThreads = reg.threads.filter((t, i) => reg.threads.indexOf(t) !== i);
    if (dupThreads.length) push(`duplicate thread(s): ${[...new Set(dupThreads)].join(', ')}`);
  }
  const threads = Array.isArray(reg.threads) ? reg.threads : [];

  // chart
  const chart = reg.chart;
  if (!chart || typeof chart !== 'object') {
    push('chart is missing');
  } else {
    pushUnknownKeys(chart, 'chart', 'chart', push);
    const posInt = (v) => Number.isInteger(v) && v > 0;
    if (!posInt(chart.columns)) push('chart.columns must be a positive integer');
    if (!posInt(chart.rows)) push('chart.rows must be a positive integer');
    if (!(Number.isFinite(chart.cell_aspect) && chart.cell_aspect > 0)) push('chart.cell_aspect must be a positive number');
    if (chart.cell_fit !== 'cover') push(`chart.cell_fit must be "cover" (the only supported fit), got ${JSON.stringify(chart.cell_fit)}`);
    const titleProblem = charsetProblem(chart.title, 'chart.title');
    if (titleProblem) push(titleProblem);
    if (!(Number.isFinite(chart.width_units) && chart.width_units >= 800)) push('chart.width_units must be a number >= 800');
    if (!(Number.isFinite(chart.scale) && chart.scale >= 1)) push('chart.scale must be a number >= 1');
    if (!posInt(chart.styleVersion)) push('chart.styleVersion must be a positive integer');
  }

  // gallery (optional). Media pinned AFTER the chart block, in declared order: the operator's logo
  // sits last in the live gallery, and without this the charts are hard-coded as the contiguous
  // tail, so every publish would move them past the logo and silently undo the Admin fix.
  if (reg.gallery !== undefined) {
    if (!reg.gallery || typeof reg.gallery !== 'object' || Array.isArray(reg.gallery)) {
      push('gallery must be an object');
    } else {
      pushUnknownKeys(reg.gallery, 'gallery', 'gallery', push);
      const pins = reg.gallery.pin_after_charts;
      if (pins !== undefined) {
        if (!Array.isArray(pins)) {
          push('gallery.pin_after_charts must be an array of MediaImage GIDs');
        } else {
          // Shape only. It proves the value LOOKS like a media GID; it proves nothing about
          // existence, and buildMediaPlan re-checks against live media and the chart set.
          pins.forEach((g, i) => {
            if (!MEDIA_GID_RE.test(g ?? '')) push(`gallery.pin_after_charts[${i}]: ${JSON.stringify(g)} must look like gid://shopify/MediaImage/<id>`);
          });
          const dups = pins.filter((g, i) => pins.indexOf(g) !== i);
          if (dups.length) push(`gallery.pin_after_charts has duplicate GID(s): ${[...new Set(dups)].join(', ')}`);
          const chartGids = new Set((Array.isArray(reg.published) ? reg.published : []).map((e) => e?.mediaGid));
          for (const g of pins) {
            if (chartGids.has(g)) push(`gallery.pin_after_charts: ${g} is a published chart; a chart cannot also be pinned after the charts`);
          }
        }
      }
    }
  }

  // patterns
  if (!Array.isArray(reg.patterns)) {
    push('patterns must be an array');
    return problems;
  }
  const ids = new Set();
  const derivedIds = new Map(); // deriveId(name) -> pattern id that claimed it
  const positions = new Map();
  const sourceOwner = new Map(); // basename -> pattern id
  reg.patterns.forEach((p, i) => {
    const label = `patterns[${i}]${p?.id ? ` (${p.id})` : ''}`;
    if (!p || typeof p !== 'object') { push(`${label} is not an object`); return; }
    pushUnknownKeys(p, 'pattern', label, push);
    pushUnknownKeys(p.crop, 'crop', `${label}: crop`, push);

    if (!ID_RE.test(p.id ?? '')) push(`${label}: id must be kebab-case`);
    else if (ids.has(p.id)) push(`${label}: duplicate id "${p.id}"`);
    else ids.add(p.id);

    const nameProblem = charsetProblem(p.name, `${label}: name`);
    if (nameProblem) push(nameProblem);
    else {
      const derived = deriveId(p.name);
      if (derivedIds.has(derived)) push(`${label}: name "${p.name}" derives the same id as pattern "${derivedIds.get(derived)}"`);
      else derivedIds.set(derived, p.id ?? `#${i}`);
      const colorProblem = nameColorProblem(p.name, colorValues);
      if (colorProblem) push(`${label}: ${colorProblem}`);
      if (ceiling !== null && String(p.name).length > ceiling) {
        push(`${label}: name "${p.name}" is ${String(p.name).length} characters; the ${reg.chart.columns}-column chart carries at most ${ceiling}`);
      }
    }

    const threadProblem = charsetProblem(p.thread, `${label}: thread`);
    if (threadProblem) push(threadProblem);
    else if (!threads.includes(p.thread)) push(`${label}: thread "${p.thread}" is not in the recorded thread palette [${threads.join(', ')}]`);

    if (!STATUSES.includes(p.status)) push(`${label}: status must be one of ${STATUSES.join('|')}, got ${JSON.stringify(p.status)}`);

    if (!Array.isArray(p.sources) || !p.sources.length) {
      push(`${label}: sources must be a non-empty array of HEIC basenames`);
    } else {
      p.sources.forEach((s) => {
        if (!BASENAME_RE.test(s ?? '')) push(`${label}: source ${JSON.stringify(s)} must be a bare .heic basename (no paths)`);
        else if (sourceOwner.has(s)) push(`${label}: source "${s}" already belongs to pattern "${sourceOwner.get(s)}"`);
        else sourceOwner.set(s, p.id ?? `#${i}`);
      });
      if (!p.sources.includes(p.hero)) push(`${label}: hero ${JSON.stringify(p.hero)} is not one of its sources`);
    }

    const c = p.crop;
    if (!c || typeof c !== 'object'
      || !Number.isFinite(c.left) || !Number.isFinite(c.top) || !Number.isFinite(c.width) || !Number.isFinite(c.height)
      || c.left < 0 || c.top < 0 || c.width <= 0 || c.height <= 0
      || c.left + c.width > 1 || c.top + c.height > 1) {
      push(`${label}: crop must satisfy 0 <= left/top, width/height > 0, left+width <= 1, top+height <= 1`);
    }

    if (!Number.isInteger(p.position) || p.position <= 0) push(`${label}: position must be a positive integer`);
    else if (positions.has(p.position)) push(`${label}: duplicate position ${p.position} (also on "${positions.get(p.position)}")`);
    else positions.set(p.position, p.id ?? `#${i}`);
  });

  // published
  if (!Array.isArray(reg.published)) {
    push('published must be an array');
  } else {
    reg.published.forEach((e, i) => {
      const label = `published[${i}]`;
      if (!e || typeof e !== 'object') { push(`${label} is not an object`); return; }
      pushUnknownKeys(e, 'published', label, push);
      if (!Number.isInteger(e.page) || e.page <= 0) push(`${label}: page must be a positive integer`);
      if (typeof e.filename !== 'string' || !e.filename || /[/\\]/.test(e.filename)) push(`${label}: filename must be a bare basename`);
      if (!MEDIA_GID_RE.test(e.mediaGid ?? '')) push(`${label}: mediaGid must look like gid://shopify/MediaImage/<id>`);
      if (typeof e.alt !== 'string' || !e.alt) push(`${label}: alt must be a non-empty string`);
      if (!SPEC_HASH_RE.test(e.specHash ?? '')) push(`${label}: specHash must be 64 hex chars`);
    });
  }

  return problems;
}

/** Throw a single error listing every problem; no-op when valid. */
export function assertValid(reg) {
  const problems = validate(reg);
  if (problems.length) {
    throw new Error(`registry is invalid:\n  - ${problems.join('\n  - ')}`);
  }
  return reg;
}

/**
 * Read, parse, and validate the registry. Throws on a missing file, parse error, or any schema
 * problem; there is no partial load.
 * @param {string} [registryPath]
 * @returns {Promise<object>}
 */
export async function load(registryPath = REGISTRY_PATH, { manifest = null } = {}) {
  const raw = await readFile(registryPath, 'utf8');
  const resolved = manifest ?? (await loadCatalogue({ read: (f) => readFile(path.join(REPO_ROOT, f), 'utf8') }));
  return assertValid(materialise(JSON.parse(raw), resolved));
}

/**
 * Attach the product facts catalogue.json owns, from the registry's scalar `handle`.
 *
 * Pure: the manifest is passed in, so every derivation test drives a hand-authored one. The shape
 * it produces is the shape the whole tool already reads (`registry.product.handle` / `.gid` /
 * `.colorValues`), so publish, audit, draft and apply-options are untouched by this.
 *
 * A registry still carrying its own `product` block is REFUSED rather than overwritten: the block
 * held a GID and a colour snapshot that the audit compares against the live store, and silently
 * replacing a stale copy would hide the very drift that comparison exists to find.
 *
 * @param {object} raw
 * @param {object} manifest
 * @returns {object}
 */
export function materialise(raw, manifest) {
  if (raw && raw.product !== undefined) {
    throw new Error(
      `patterns.json carries a "product" block. Its handle, GID and Color option values come from ` +
        `${CATALOGUE_PATH} now: keep the top-level "handle" and delete the block.`
    );
  }
  const product = productByHandle(manifest, raw.handle);
  if (product.body === null) {
    throw new Error(
      `patterns.json charts "${raw.handle}", which ${CATALOGUE_PATH} declares with "body": null. ` +
        `Applique patterns are printed on a garment body.`
    );
  }
  return {
    ...raw,
    product: {
      handle: product.handle,
      gid: product.gid,
      colorValues: colorValuesFor(manifest, product.handle),
    },
  };
}

/**
 * Validate, then write byte-stably and ATOMICALLY. publish.mjs calls this immediately after the
 * live media writes, to record the new chart GIDs, so it is the highest-stakes write in the
 * module: a truncated patterns.json there loses the mapping from published charts to live media
 * and the next publish would re-create them with nothing to reconcile against.
 * @param {string} registryPath
 * @param {object} reg
 * @param {object} [io] - injectable fs calls, for testing the mid-write failure
 */
export async function save(registryPath, reg, io = {}) {
  assertValid(reg);
  await atomicWrite(registryPath, serialize(reg), io);
}

/**
 * Active patterns in display order with their 1-based numbers. Numbering skips discontinued
 * patterns and follows position order.
 * @param {object} reg
 * @returns {Array<object>} copies with a `number` field added
 */
export function activePatterns(reg) {
  return reg.patterns
    .filter((p) => p.status === 'active')
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((p, i) => ({ ...p, number: i + 1 }));
}

/**
 * The dropdown lines, one per active pattern: "7. Sunset Bloom (white thread)". The word "thread"
 * is part of the line, not decoration: the customer picks from this list with no photo beside it,
 * and a bare "(white)" next to a product whose Color option is also a colour word reads as the
 * garment or the fabric. The charts spell it out the same way (lib/chart-svg.mjs).
 */
export function dropdownLines(reg) {
  return activePatterns(reg).map((p) => `${p.number}. ${p.name} (${p.thread} thread)`);
}

/**
 * The exact pattern_options text for the product-page block. LF-joined; an empty registry yields
 * the defined empty string (still a byte-stable write target).
 * @param {object} reg
 * @returns {string}
 */
export function dropdownText(reg) {
  return dropdownLines(reg).join('\n');
}
