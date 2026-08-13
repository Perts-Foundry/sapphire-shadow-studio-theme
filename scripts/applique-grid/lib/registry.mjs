// The committed pattern registry (scripts/applique-grid/patterns.json): schema validation,
// byte-stable serialization, numbering, and the derived dropdown text. Pure fs + naming.mjs.
//
// The registry is the single source of truth for the Huddle Crewneck's applique patterns: the
// numbered chart images, the product-page dropdown, and the audit all derive from it. Numbering
// derives from active-pattern position order on every regeneration; past orders keep their
// verbatim property strings, so renumbering is safe for history and chatty for charts (most spec
// hashes change), which is correct and documented in the README.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { charsetProblem, nameColorProblem } from './naming.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The committed registry path. */
export const REGISTRY_PATH = path.join(HERE, '..', 'patterns.json');

export const STATUSES = ['active', 'discontinued'];

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PRODUCT_GID_RE = /^gid:\/\/shopify\/Product\/\d+$/;
const MEDIA_GID_RE = /^gid:\/\/shopify\/MediaImage\/\d+$/;
const SPEC_HASH_RE = /^[0-9a-f]{64}$/;
// Manifests and the registry hold photo BASENAMES only; a path separator means someone recorded a
// dev-machine path, which must never enter this public repo.
const BASENAME_RE = /^[^/\\]+\.(heic|heif)$/i;

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
    product: {
      handle: 'huddle-crewneck',
      gid: 'gid://shopify/Product/10231493787948',
      colorValues: ['Black', 'Grey Heather', 'Classic Navy'],
    },
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
      styleVersion: 2,
    },
    patterns: [],
    published: [],
  };
}

/** Byte-stable serialization: the same shape template writes use, plus the trailing newline. */
export function serialize(reg) {
  return `${JSON.stringify(reg, null, 2)}\n`;
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

  // product
  const product = reg.product;
  if (!product || typeof product !== 'object') {
    push('product is missing');
  } else {
    if (!ID_RE.test(product.handle ?? '')) push(`product.handle must be kebab-case, got ${JSON.stringify(product.handle)}`);
    if (!PRODUCT_GID_RE.test(product.gid ?? '')) push(`product.gid must look like gid://shopify/Product/<id>, got ${JSON.stringify(product.gid)}`);
    if (!Array.isArray(product.colorValues) || !product.colorValues.length || product.colorValues.some((v) => typeof v !== 'string' || !v.trim())) {
      push('product.colorValues must be a non-empty array of non-blank strings');
    }
  }
  const colorValues = Array.isArray(product?.colorValues) ? product.colorValues : [];

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
export async function load(registryPath = REGISTRY_PATH) {
  const raw = await readFile(registryPath, 'utf8');
  return assertValid(JSON.parse(raw));
}

/** Validate, then write byte-stably. */
export async function save(registryPath, reg) {
  assertValid(reg);
  await writeFile(registryPath, serialize(reg));
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

/** The dropdown lines, one per active pattern: "7. Sunset Bloom (white)". */
export function dropdownLines(reg) {
  return activePatterns(reg).map((p) => `${p.number}. ${p.name} (${p.thread})`);
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
