// The reorder review: on-hand shared-blank stock against a committed table of recommended minimums,
// and the orders-history pass that proposes adjustments to that table.
//
// READ-ONLY BY CONSTRUCTION. Nothing in this module writes to the store, and nothing here may ever
// import lib/mutations.mjs (a unit test asserts that). The only write this feature has anywhere is a
// gated, PR-reviewed edit of thresholds.json, and even that is made by a human, never by a command.
//
// WHY THE COMPUTATION LIVES HERE AND NOT IN THE COMMANDS. Every decision below (which cells refuse,
// which warn, what a shortfall is, how a budget redistributes) is a pure function of data, so it is
// unit-tested without a network and the commands stay presentation. The commands print and exit;
// they never decide.
//
// WHAT IS SAFE TO COMMIT. thresholds.json keys are the normalised vocab form (lowercase
// `body|color|size`), which cannot match the blank-id guard's shape, and its values are unit counts
// the operator chose. No supplier name, vendor SKU, case pack, unit cost, contract minimum, lead
// time or dollar amount belongs in that file, and no order-derived customer data belongs in it
// either: the demand pass is used in aggregate only. See CLAUDE.md and the skill.

import { normaliseAxis, vocabKey, classifyGroup, CONVERGED } from './groups.mjs';

/** The one schema version this tool understands. A future shape means a bump plus a transform. */
export const THRESHOLDS_VERSION = 1;

/** Where the committed file lives, relative to the repo root. */
export const THRESHOLDS_PATH = 'scripts/blank-inventory/thresholds.json';

/** A cell with no blank group at all: nothing on the store carries that body+colour+size. */
export const NO_GROUP = 'no-group';

/**
 * Size order, smallest first. Sorting sizes lexicographically puts "2XL" before "S" and "XL" before
 * "XS", which turns every matrix row into nonsense and silently reorders the reorder table.
 */
export const SIZE_ORDER = ['xs', 's', 'm', 'l', 'xl', '2xl', '3xl', '4xl'];

/**
 * A pair with fewer than this many net units in the window is treated as insufficient data.
 *
 * This is the anti-ratchet: a blank that was out of stock sells nothing, and a proposal that reads
 * zero sales as zero demand would drive its minimum to zero and keep it out of stock forever. One
 * stray unit must not absorb a whole budget either, so the bar is a small count rather than "> 0".
 */
export const MIN_OBSERVED_UNITS = 3;

const sizeRank = (size) => {
  const i = SIZE_ORDER.indexOf(size);
  return i === -1 ? SIZE_ORDER.length : i;
};

/** Compare two normalised size tokens by garment order, unknown sizes last and alphabetical. */
export function compareSizes(a, b) {
  return sizeRank(a) - sizeRank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

const cmpString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The axis space the thresholds file must cover.
 *
 * Bodies come from the APPROVED body map (by way of the catalogue manifest, which reconciles against
 * it exactly), not from what happens to be tagged: a body with nothing tagged yet still needs a
 * minimum, and reading the axis off the tagged population would make the file shrink whenever
 * coverage does.
 *
 * `ranges` IS THE COVERAGE SPACE, AND IT IS PER BODY. It comes from the committed catalogue manifest
 * (lib/catalogue-manifest.mjs), which is passed in as plain data rather than imported here: this
 * module must keep its import list down to './groups.mjs' so the "cannot reach a mutation" test still
 * proves what it says. Without `ranges` the axes fall back to one global cross product, which is what
 * this file used to do unconditionally and which invents cells for combinations a body is not made
 * in. Those cells can never be filled, and once one carries a nonzero minimum it flags as `no-group`
 * in every report forever.
 *
 * `colors` and `sizes` remain the flat union across bodies, for display and for the fallback; nothing
 * builds a cell from them when `ranges` is present.
 *
 * @param {object} params
 * @param {string[]} params.bodies
 * @param {string[]} [params.colors] - the learned store vocabulary; used only when `ranges` is absent
 * @param {string[]} [params.sizes] - as above
 * @param {Map<string, {colors: string[], sizes: string[]}>|Record<string, {colors: string[], sizes: string[]}>} [params.ranges]
 * @param {{body?: Map<string,string>, color?: Map<string,string>, size?: Map<string,string>}} [params.display]
 * @returns {{bodies: string[], colors: string[], sizes: string[], ranges: Map<string, {colors: string[], sizes: string[]}>, display: object}}
 */
export function buildAxes({ bodies, colors, sizes, ranges = null, display = {} }) {
  const norm = (values, axis) => {
    const out = [];
    for (const v of values ?? []) {
      const n = normaliseAxis(v, axis);
      if (n && !out.includes(n)) out.push(n);
    }
    return out;
  };
  const bodyList = norm(bodies, 'Body').sort(cmpString);
  // catalogue order for colours: first spelling seen wins, as learnVocab does.
  const globalColors = norm(colors, 'Color');
  const globalSizes = norm(sizes, 'Size').sort(compareSizes);

  /** @type {Map<string, {colors: string[], sizes: string[]}>} */
  const perBody = new Map();
  for (const body of bodyList) {
    // Own properties only on the object form: `ranges[body]` would find Object.prototype.constructor
    // for a body called "constructor" and treat a function as a declared range.
    const declared =
      ranges instanceof Map
        ? ranges.get(body)
        : ranges && Object.prototype.hasOwnProperty.call(ranges, body)
          ? ranges[body]
          : undefined;
    if (ranges && !declared) {
      throw new Error(
        `No declared colour and size range for garment body "${body}". The catalogue manifest and ` +
          `the approved body map must agree exactly, and reconcileCatalogue refuses before this ` +
          `point, so reaching here means the two were read from different places.`
      );
    }
    perBody.set(body, {
      colors: declared ? norm(declared.colors, 'Color') : globalColors,
      sizes: declared ? norm(declared.sizes, 'Size').sort(compareSizes) : globalSizes,
    });
  }

  const unionColors = ranges ? [] : globalColors;
  const unionSizes = ranges ? [] : globalSizes;
  if (ranges) {
    for (const range of perBody.values()) {
      for (const c of range.colors) if (!unionColors.includes(c)) unionColors.push(c);
      for (const s of range.sizes) if (!unionSizes.includes(s)) unionSizes.push(s);
    }
    unionSizes.sort(compareSizes);
  }

  return { bodies: bodyList, colors: unionColors, sizes: unionSizes, ranges: perBody, display };
}

/**
 * One body's declared colour and size range, or the flat axes when nothing was declared.
 * @param {{colors: string[], sizes: string[], ranges?: Map<string, {colors: string[], sizes: string[]}>}} axes
 * @param {string} body
 * @returns {{colors: string[], sizes: string[]}}
 */
function rangeFor(axes, body) {
  return axes.ranges?.get(body) ?? { colors: axes.colors ?? [], sizes: axes.sizes ?? [] };
}

/** The label to print for a normalised axis value. Falls back to the normalised token itself. */
export function axisLabel(axes, axis, value) {
  return axes.display?.[axis]?.get(value) ?? value;
}

/**
 * Every body+colour+size the thresholds file must carry, in canonical order.
 *
 * NOT a global cross product any more. Each body contributes only the colours and sizes declared for
 * it, so a body made in one colour contributes one colour row and not one per colour on the store.
 * Canonical order is bodies by code point (as buildAxes sorts them), then that body's colours in
 * MANIFEST DECLARATION ORDER, then sizes in garment order. Body order deliberately does not follow
 * the manifest, so reordering bodies in the manifest can never churn the committed thresholds file.
 *
 * @param {{bodies: string[], colors: string[], sizes: string[], ranges?: Map<string, object>}} axes
 * @returns {Array<{key: string, body: string, color: string, size: string}>}
 */
export function cartesianCells(axes) {
  const out = [];
  for (const body of axes.bodies) {
    const { colors, sizes } = rangeFor(axes, body);
    for (const color of colors) {
      for (const size of sizes) {
        out.push({ key: vocabKey({ body, color, size }), body, color, size });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Duplicate object keys anywhere in a JSON document, found in the RAW TEXT.
 *
 * JSON.parse is last-wins and silent, so a bad merge that leaves two `"crewneck|black|m"` entries
 * parses cleanly and quietly takes the wrong minimum. The structure is all this needs, so it walks
 * tokens rather than parsing values.
 *
 * @param {string} text
 * @returns {Array<{path: string, key: string}>}
 */
export function findDuplicateKeys(text) {
  /** @type {Array<{t: string, v?: string}>} */
  const toks = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < text.length) {
        if (text[j] === '\\') {
          s += text[j] + (text[j + 1] ?? '');
          j += 2;
          continue;
        }
        if (text[j] === '"') break;
        s += text[j];
        j++;
      }
      toks.push({ t: 'string', v: s });
      i = j;
    } else if ('{}[]:,'.includes(c)) {
      toks.push({ t: c });
    }
    // Numbers, literals and whitespace carry no structure this check needs.
  }

  const dups = [];
  /** @type {Array<{type: string, keys: Set<string>, path: string[], currentKey: string|null}>} */
  const stack = [];
  let lastStr = null;
  for (const tk of toks) {
    if (tk.t === 'string') {
      lastStr = tk.v;
      continue;
    }
    const top = stack[stack.length - 1];
    if (tk.t === ':') {
      if (top && top.type === 'object' && lastStr !== null) {
        if (top.keys.has(lastStr)) dups.push({ path: [...top.path, lastStr].join('.'), key: lastStr });
        top.keys.add(lastStr);
        top.currentKey = lastStr;
      }
      continue;
    }
    if (tk.t === '{' || tk.t === '[') {
      const path = !top ? [] : top.type === 'object' ? [...top.path, top.currentKey ?? '?'] : [...top.path, '[]'];
      stack.push({ type: tk.t === '{' ? 'object' : 'array', keys: new Set(), path, currentKey: null });
      continue;
    }
    if (tk.t === '}' || tk.t === ']') {
      stack.pop();
      continue;
    }
    if (tk.t === ',') {
      if (top) top.currentKey = null;
      lastStr = null;
    }
  }
  return dups;
}

/** A key is valid only if it is ALREADY normalised. Rejected, never normalised: see parseThresholds. */
function assertNormalisedKey(key, segments, where) {
  const parts = String(key).split('|');
  if (parts.length !== segments) {
    throw new Error(
      `${where} key ${JSON.stringify(key)} must have ${segments} "|"-separated segment(s), not ${parts.length}.`
    );
  }
  for (const p of parts) {
    if (!p) throw new Error(`${where} key ${JSON.stringify(key)} has an empty segment.`);
  }
  const renormalised = parts.map((p, i) => normaliseAxis(p, ['Body', 'Color', 'Size'][i] ?? 'Axis')).join('|');
  if (renormalised !== key) {
    throw new Error(
      `${where} key ${JSON.stringify(key)} is not in normalised form. Expected ${JSON.stringify(renormalised)}. ` +
        `Keys are rejected rather than normalised here: two spellings of one cell would silently ` +
        `become two minimums for one physical blank.`
    );
  }
}

function assertMin(key, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Cell ${JSON.stringify(key)} must be an object like {"min": 6}.`);
  }
  const { min } = value;
  if (typeof min !== 'number' || !Number.isInteger(min) || min < 0) {
    throw new Error(
      `Cell ${JSON.stringify(key)} has min ${JSON.stringify(min)}. A minimum is a non-negative whole ` +
        `number of garments.`
    );
  }
  if (value.note !== undefined && typeof value.note !== 'string') {
    throw new Error(`Cell ${JSON.stringify(key)} has a non-string note.`);
  }
}

/**
 * Parse and validate the thresholds file from its raw text.
 *
 * Raw text in, not an object: the duplicate-key check can only be done on the text, and doing it
 * anywhere else means a caller can skip it.
 *
 * @param {string} text
 * @returns {{version: number, provenance: object, cells: Map<string, {min: number, note?: string}>, budgets: Map<string, number>, raw: object}}
 */
export function parseThresholds(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${THRESHOLDS_PATH} is not valid JSON: ${err.message}. Fix the file by hand (it is committed ` +
        `and reviewed in a PR); no command edits it.`
    );
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${THRESHOLDS_PATH} must contain a JSON object.`);
  }

  const dups = findDuplicateKeys(text);
  if (dups.length) {
    throw new Error(
      `${THRESHOLDS_PATH} has duplicate key(s): ${dups.map((d) => `${d.path}`).join(', ')}. JSON.parse ` +
        `takes the last one silently, so a bad merge would apply a minimum nobody reviewed.`
    );
  }

  if (doc.version !== THRESHOLDS_VERSION) {
    throw new Error(
      `${THRESHOLDS_PATH} declares version ${JSON.stringify(doc.version)}; this tool understands ` +
        `${THRESHOLDS_VERSION} only. A new shape needs a version bump plus a transform committed together.`
    );
  }

  const rawCells = doc.cells;
  if (!rawCells || typeof rawCells !== 'object' || Array.isArray(rawCells)) {
    throw new Error(`${THRESHOLDS_PATH} needs a "cells" object (it may be empty).`);
  }

  const cells = new Map();
  for (const [key, value] of Object.entries(rawCells)) {
    assertNormalisedKey(key, 3, 'Cell');
    assertMin(key, value);
    cells.set(key, value.note === undefined ? { min: value.min } : { min: value.min, note: value.note });
  }

  const provenance = doc.provenance ?? {};
  if (typeof provenance !== 'object' || Array.isArray(provenance)) {
    throw new Error(`${THRESHOLDS_PATH} "provenance" must be an object.`);
  }

  const budgets = new Map();
  const rawBudgets = provenance.budgets ?? {};
  if (typeof rawBudgets !== 'object' || Array.isArray(rawBudgets)) {
    throw new Error(`${THRESHOLDS_PATH} "provenance.budgets" must be an object keyed by garment body.`);
  }
  for (const [key, value] of Object.entries(rawBudgets)) {
    assertNormalisedKey(key, 1, 'Budget');
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error(
        `Budget ${JSON.stringify(key)} is ${JSON.stringify(value)}. A budget is a non-negative whole ` +
          `number of garments; it is a unit count, never a currency amount.`
      );
    }
    budgets.set(key, value);
  }

  const adjustments = provenance.adjustments ?? [];
  if (!Array.isArray(adjustments)) {
    throw new Error(`${THRESHOLDS_PATH} "provenance.adjustments" must be an array (append-only).`);
  }
  adjustments.forEach((entry, i) => {
    const at = `provenance.adjustments[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${at} must be an object.`);
    for (const field of ['date', 'source', 'note']) {
      if (typeof entry[field] !== 'string' || !entry[field].trim()) {
        throw new Error(`${at} needs a non-empty string "${field}".`);
      }
    }
    if (!entry.cells || typeof entry.cells !== 'object' || Array.isArray(entry.cells)) {
      throw new Error(`${at} needs a "cells" object of {key: {from, to}}.`);
    }
    for (const [key, move] of Object.entries(entry.cells)) {
      assertNormalisedKey(key, 3, `${at} cell`);
      if (!move || typeof move !== 'object' || Array.isArray(move)) {
        throw new Error(`${at} cell ${JSON.stringify(key)} must be {"from": n, "to": n}.`);
      }
      for (const field of ['from', 'to']) {
        if (typeof move[field] !== 'number' || !Number.isInteger(move[field]) || move[field] < 0) {
          throw new Error(`${at} cell ${JSON.stringify(key)} has a non-integer "${field}".`);
        }
      }
    }
  });

  return { version: doc.version, provenance, cells, budgets, raw: doc };
}

/**
 * Read and parse the committed thresholds file.
 *
 * The reader is injected so the whole path is testable without a filesystem, and so the refusal
 * messages are asserted rather than assumed. A missing file is a refusal carrying `fileMissing`, not
 * an empty default: silently treating "no thresholds" as "no shortfalls" is the failure this whole
 * loud-refusal contract exists to prevent.
 *
 * @param {object} params
 * @param {(path: string) => Promise<string>} params.read
 * @param {string} [params.path]
 * @returns {Promise<object>}
 */
export async function loadThresholds({ read, path = THRESHOLDS_PATH }) {
  let text;
  try {
    text = await read(path);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const e = new Error(
        `No thresholds file at ${path}. It is generated once, reviewed in a PR, and then hand-edited ` +
          `behind an operator approval; no command creates it. See the "Reorder review" section of ` +
          `.claude/skills/blank-inventory/SKILL.md.`
      );
      e.fileMissing = true;
      throw e;
    }
    throw err;
  }
  return parseThresholds(text);
}

// ---------------------------------------------------------------------------
// Reconciliation against the live vocabulary
// ---------------------------------------------------------------------------

/**
 * Compare the committed table against the declared axis space.
 *
 * Nothing here mutates the table or invents a value. It reports four kinds of divergence and lets
 * assessThresholds decide which are refusals.
 *
 * @param {Map<string, {min: number, note?: string}>} cells
 * @param {Map<string, number>} budgets
 * @param {{bodies: string[], colors: string[], sizes: string[]}} axes
 * @returns {{resolved: Map<string, object>, unthresholded: string[], stale: string[], staleBudgets: string[], missingBudgets: string[]}}
 */
export function reconcileThresholds(cells, budgets, axes) {
  const expected = cartesianCells(axes);
  const expectedKeys = new Set(expected.map((c) => c.key));
  const resolved = new Map();
  const unthresholded = [];

  for (const cell of expected) {
    const entry = cells.get(cell.key);
    if (!entry) {
      unthresholded.push(cell.key);
      continue;
    }
    resolved.set(cell.key, { ...cell, min: entry.min, note: entry.note });
  }

  const stale = [...cells.keys()].filter((k) => !expectedKeys.has(k)).sort(cmpString);

  // The budget axis is the BODY, not the body+colour. The colour split is derived from a popularity
  // curve exactly as the size split is, so a per-colour budget would be a second, unreconciled source
  // of truth for the same number.
  const bodySet = new Set(axes.bodies);
  const staleBudgets = [...budgets.keys()].filter((k) => !bodySet.has(k)).sort(cmpString);
  const missingBudgets = axes.bodies.filter((b) => !budgets.has(b));

  return { resolved, unthresholded, stale, staleBudgets, missingBudgets };
}

/**
 * The loud-failure contract, as data.
 *
 * Mirrors the body map's refusal pattern: a gap in the table is a REFUSAL naming every missing key,
 * because that is how a new body, colour or size surfaces at all. A key the store no longer has is a
 * warning, never a deletion; only the operator removes a row, in a reviewed PR.
 *
 * `missingBudgets` refuses for `demand` (it redistributes a budget, so it cannot run without one)
 * and warns for `reorder` (which only compares on-hand against minimums).
 *
 * @param {object} params
 * @param {string[]} [params.unthresholded]
 * @param {string[]} [params.stale]
 * @param {string[]} [params.staleBudgets]
 * @param {string[]} [params.missingBudgets]
 * @param {boolean} [params.fileMissing]
 * @param {string} [params.mode] - 'reorder' | 'demand'
 * @returns {{exitCode: number, refusals: Array<{code: string, message: string, keys: string[]}>, warnings: Array<{code: string, message: string, keys: string[]}>}}
 */
export function assessThresholds({
  unthresholded = [],
  stale = [],
  staleBudgets = [],
  missingBudgets = [],
  fileMissing = false,
  mode = 'reorder',
} = {}) {
  const refusals = [];
  const warnings = [];

  if (fileMissing) {
    refusals.push({
      code: 'thresholds-missing',
      keys: [],
      message:
        `No thresholds file at ${THRESHOLDS_PATH}. Nothing to compare on-hand stock against, and an ` +
        `empty default would report "no shortfalls" for a store with none of its minimums recorded.`,
    });
  }

  if (unthresholded.length) {
    refusals.push({
      code: 'unthresholded-cells',
      keys: unthresholded,
      message:
        `${unthresholded.length} body+colour+size combination(s) have no entry in ${THRESHOLDS_PATH}: ` +
        `${unthresholded.join(', ')}. This is how a new body, colour or size surfaces. A combination ` +
        `that is not made gets an explicit min of 0 with a note; it never gets left out. Do not add ` +
        `entries to make this pass: take the list to the operator, who decides the numbers in a ` +
        `reviewed PR.`,
    });
  }

  if (stale.length) {
    warnings.push({
      code: 'stale-cells',
      keys: stale,
      message:
        `${stale.length} entry/entries in ${THRESHOLDS_PATH} fall outside the declared catalogue ` +
        `shape: ${stale.join(', ')}. Either the manifest no longer declares that body, colour or ` +
        `size, or the store no longer has it. Suggest removing them to the operator; never delete a ` +
        `row to quieten this.`,
    });
  }

  if (staleBudgets.length) {
    warnings.push({
      code: 'stale-budgets',
      keys: staleBudgets,
      message:
        `${staleBudgets.length} budget key(s) name a garment body the store no longer has: ` +
        `${staleBudgets.join(', ')}.`,
    });
  }

  if (missingBudgets.length) {
    const entry = {
      code: 'missing-budgets',
      keys: missingBudgets,
      message:
        `${missingBudgets.length} garment body/bodies have no budget in provenance.budgets: ` +
        `${missingBudgets.join(', ')}. ` +
        (mode === 'demand'
          ? `demand redistributes a stated budget, so it cannot propose anything for those bodies.`
          : `reorder only compares on-hand against the minimums, so this is a warning.`),
    };
    (mode === 'demand' ? refusals : warnings).push(entry);
  }

  return { exitCode: refusals.length ? 1 : 0, refusals, warnings };
}

// ---------------------------------------------------------------------------
// The pivot
// ---------------------------------------------------------------------------

/**
 * Pivot the tagged catalogue into per-body colour x size cells.
 *
 * A cell reports the group's state, not an average. An unconverged group holds two or more different
 * quantities while the Flow settles (80 to 90 seconds), and averaging them would invent a number
 * that no variant holds; the range is what is true. `onHand` is therefore null unless the group is
 * converged, and every consumer downstream has to handle that rather than quietly reading a 0.
 *
 * The matrix carries only DECLARED rows: each body gets the colours and sizes the catalogue manifest
 * declares for it, so a body made in one colour prints one colour row. Nothing is hidden by that,
 * because a tagged variant outside the declared shape is a refusal (reconcileCatalogue's
 * `undeclaredVariants`) that fires before this function is ever reached.
 *
 * @param {object} params
 * @param {object[]} params.variants - post-attachBodies variants
 * @param {{bodies: string[], colors: string[], sizes: string[], display?: object}} params.axes
 * @param {Set<string>} [params.pendingSeedBlankIds]
 * @returns {{bodies: Array<object>, cells: Map<string, object>}}
 */
export function buildPivot({ variants, axes, pendingSeedBlankIds = new Set() }) {
  /** @type {Map<string, object[]>} */
  const membersByKey = new Map();
  for (const v of variants ?? []) {
    if (!v.blankId || !v.body || !v.color || !v.size) continue;
    const key = vocabKey(v);
    if (!membersByKey.has(key)) membersByKey.set(key, []);
    membersByKey.get(key).push(v);
  }

  const cells = new Map();
  const bodies = [];
  for (const body of axes.bodies) {
    const range = rangeFor(axes, body);
    const colorRows = [];
    for (const color of range.colors) {
      const row = [];
      for (const size of range.sizes) {
        const key = vocabKey({ body, color, size });
        const members = membersByKey.get(key) ?? [];
        const base = {
          key,
          body,
          color,
          size,
          sizeLabel: axisLabel(axes, 'size', size),
          members: members.length,
        };
        let cell;
        if (!members.length) {
          cell = { ...base, state: NO_GROUP, blankId: null, onHand: null, low: null, high: null };
        } else {
          const { state, quantities, blankId } = classifyGroup(members, pendingSeedBlankIds);
          const low = quantities[0];
          const high = quantities[quantities.length - 1];
          cell = {
            ...base,
            state,
            blankId,
            onHand: state === CONVERGED ? low : null,
            low,
            high,
          };
        }
        cells.set(key, cell);
        row.push(cell);
      }
      colorRows.push({ color, colorLabel: axisLabel(axes, 'color', color), cells: row });
    }
    bodies.push({ body, bodyLabel: axisLabel(axes, 'body', body), colors: colorRows });
  }

  return { bodies, cells };
}

/**
 * One cell's display string.
 *
 * The micro-language, in one place so the legend and the tests cannot drift from it:
 *   `M:7/6`      converged, 7 on hand against a minimum of 6
 *   `M:5/6*`     below the minimum
 *   `M:4-11/6?`  not converged: the members range from 4 to 11 (never averaged)
 *   `M:2-4/6*?`  not converged AND even the highest member is below the minimum
 *   `M:--/6!`    a minimum is set but nothing on the store carries that body+colour+size
 *
 * @param {object} cell
 * @param {{min: number}} [threshold]
 * @returns {string}
 */
export function formatCell(cell, threshold) {
  const min = threshold?.min ?? 0;
  const label = cell.sizeLabel ?? cell.size;
  if (cell.state === NO_GROUP) return `${label}:--/${min}${min > 0 ? '!' : ''}`;
  if (cell.onHand !== null) return `${label}:${cell.onHand}/${min}${cell.onHand < min ? '*' : ''}`;
  return `${label}:${cell.low}-${cell.high}/${min}${cell.high < min ? '*' : ''}?`;
}

/**
 * Cells that are short against their minimum.
 *
 * An unconverged group is flagged only when even its HIGHEST member is below the minimum. Flagging
 * on the low end would report a shortfall for every group mid-fan-out, which is most of them right
 * after an apply, and a report that cries wolf during normal operation is one nobody reads.
 *
 * A minimum of 0 never flags: that is how "we do not make this combination" is recorded.
 *
 * @param {{cells: Map<string, object>}} pivot
 * @param {Map<string, {min: number}>} resolved
 * @returns {Array<object>}
 */
export function flagReorders(pivot, resolved) {
  const flags = [];
  for (const [key, cell] of pivot.cells) {
    const threshold = resolved.get(key);
    const min = threshold?.min ?? 0;
    if (min <= 0) continue;

    if (cell.state === NO_GROUP) {
      flags.push({ ...cellFacts(cell), min, shortfall: min, reason: NO_GROUP });
      continue;
    }
    if (cell.onHand !== null) {
      // Unclamped on purpose: Shopify permits a negative quantity (oversell), and clamping would
      // under-report exactly the cell that is furthest behind.
      if (cell.onHand < min) flags.push({ ...cellFacts(cell), min, shortfall: min - cell.onHand, reason: 'below' });
      continue;
    }
    if (cell.high < min) {
      flags.push({ ...cellFacts(cell), min, shortfall: min - cell.high, reason: 'below' });
    }
  }
  return flags;
}

function cellFacts(cell) {
  return {
    key: cell.key,
    body: cell.body,
    color: cell.color,
    size: cell.size,
    sizeLabel: cell.sizeLabel,
    state: cell.state,
    onHand: cell.onHand,
    low: cell.low,
    high: cell.high,
  };
}

/**
 * Order and filter the flagged cells.
 *
 * Sorted by shortfall descending, because the question the report answers is "what do I order
 * first". Ties break on body, then colour, then garment size order, so two runs over the same store
 * print the same table.
 *
 * `belowOnly` does not filter: every flag is already a shortfall. It is carried here so the terse
 * view and the full view are provably the same selection, rendered differently.
 *
 * @param {object} params
 * @param {Array<object>} params.flags
 * @param {string|null} [params.body]
 * @param {boolean} [params.belowOnly]
 * @returns {Array<object>}
 */
export function selectReorders({ flags, body = null, belowOnly = false }) {
  void belowOnly;
  const filtered = body ? flags.filter((f) => f.body === body) : [...flags];
  return filtered.sort(
    (a, b) =>
      b.shortfall - a.shortfall ||
      cmpString(a.body, b.body) ||
      cmpString(a.color, b.color) ||
      compareSizes(a.size, b.size)
  );
}

/** How many cells the terse view would otherwise hide: unsettled groups and absent ones. */
export function pivotCounts(pivot, resolved) {
  let unsettled = 0;
  let noGroup = 0;
  for (const [key, cell] of pivot.cells) {
    if (cell.state === NO_GROUP) {
      if ((resolved.get(key)?.min ?? 0) > 0) noGroup++;
      continue;
    }
    if (cell.onHand === null) unsettled++;
  }
  return { unsettled, noGroup };
}

/**
 * Per-body stock against per-body minimums, plus a grand total.
 *
 * This is the question the matrix cannot answer at a glance: is this body short overall, or does it
 * hold roughly the right number of units in the wrong sizes and colours? A body with a nonzero
 * shortfall AND a nonzero surplus is the second case, and the two answers call for different
 * actions, so both are reported rather than netted into one number.
 *
 * ONLY CONVERGED CELLS ARE SUMMED, on every field including minSum. A cell mid-fan-out has a range
 * and not a reading, and averaging a range invents a number no variant holds (see buildPivot). A
 * cell with no blank group has no stock at all. Both would drag the sums somewhere between two
 * meanings, so both are excluded and COUNTED instead: the counts are printed alongside the sums so
 * an excluded cell can never read as a settled zero.
 *
 * shortfallUnits here is deliberately NOT the sum of the reorder list's shortfalls. That list also
 * carries cells with no group (at their full minimum) and unsettled cells (measured from their
 * highest member), which is right for "where do I look first" and wrong for "how does this body's
 * settled stock compare with its settled minimums". The two numbers answer different questions.
 *
 * Neither shortfall nor surplus is clamped against a negative on-hand, mirroring flagReorders:
 * Shopify permits an oversell, and clamping would under-report the cell furthest behind.
 *
 * The grand total is returned OUTSIDE the bodies array so a consumer iterating bodies cannot sum
 * the total back into itself.
 *
 * @param {{bodies: Array<object>}} pivot
 * @param {Map<string, {min: number}>} resolved
 * @returns {{bodies: Array<object>, total: object}}
 */
export function bodyTotals(pivot, resolved) {
  const blank = () => ({ onHandSum: 0, minSum: 0, shortfallUnits: 0, surplusUnits: 0, converged: 0, unsettled: 0, noGroup: 0 });
  const add = (into, from) => {
    for (const k of Object.keys(from)) into[k] += from[k];
    return into;
  };

  const bodies = [];
  const total = blank();
  for (const bodyRow of pivot.bodies ?? []) {
    const sums = blank();
    for (const colorRow of bodyRow.colors) {
      for (const cell of colorRow.cells) {
        const min = resolved.get(cell.key)?.min ?? 0;
        if (cell.state === NO_GROUP) {
          // Mirrors pivotCounts: a cell nothing carries and nobody set a minimum for is not a gap.
          if (min > 0) sums.noGroup++;
          continue;
        }
        if (cell.onHand === null) {
          sums.unsettled++;
          continue;
        }
        sums.converged++;
        sums.onHandSum += cell.onHand;
        sums.minSum += min;
        sums.shortfallUnits += Math.max(0, min - cell.onHand);
        sums.surplusUnits += Math.max(0, cell.onHand - min);
      }
    }
    bodies.push({ body: bodyRow.body, bodyLabel: bodyRow.bodyLabel, ...sums });
    add(total, sums);
  }
  return { bodies, total };
}

// ---------------------------------------------------------------------------
// The purchase list
// ---------------------------------------------------------------------------

/**
 * The supplier-ordering view: what to buy, grouped by garment body and then colour.
 *
 * DIFFERENT QUESTION FROM THE REORDER LIST. That list is sorted by shortfall and answers "where do I
 * look first", so it mixes bodies, colours and states together and carries cells whose number is a
 * gap rather than a quantity. Standing at a supplier's size run, the operator needs the opposite
 * shape: one body at a time, one colour at a time, only the short sizes, and a count per colour and
 * per body. This builds exactly that, and nothing else.
 *
 * WHAT IS NEVER A BUY LINE, and why each exclusion is not a rounding decision:
 *
 * - `min <= 0` is how "we do not make this combination" is recorded (see flagReorders). Buying into
 *   it would order a garment the catalogue says does not exist.
 * - An UNSETTLED cell has a member range and not a reading. `buy` would have to come from one end of
 *   that range, and both ends are wrong: the low end over-orders by the whole fan-out, the high end
 *   under-orders. A purchase quantity is never derived from a range, so the cell is excluded and
 *   named instead. It is named only when the answer could change the order, though: a range whose
 *   LOWEST member already meets the minimum buys nothing whichever reading turns out to be true.
 * - A NO-GROUP cell has a minimum but nothing on the store carries it, so there is no stock reading
 *   to subtract at all. Its full minimum would look like a buy quantity while actually meaning "this
 *   blank does not exist yet", which is a tagging problem (`audit`), not an order.
 *
 * Both exclusions are gated on `min > 0` for the same reason a `min: 0` cell never becomes a buy
 * line: a combination the catalogue does not make is not something to resolve before ordering, so
 * listing it would fill the excluded section with cells nobody will ever buy. This is narrower than
 * `pivotCounts`, which counts every unsettled cell because its job is to stop a terse matrix from
 * hiding one.
 *
 * `body` narrows the buy lines AND the excluded lists together. An operator who asked about one
 * garment must not be handed warnings about the others, and an excluded list that ignored the filter
 * would be exactly that.
 *
 * Ordering is the same everywhere so two runs over the same store render identically: bodies by code
 * point (as buildAxes sorts them), colours by display label, sizes in garment order.
 *
 * @param {{bodies: Array<object>}} pivot
 * @param {Map<string, {min: number}>} resolved
 * @param {{body?: string|null}} [options]
 * @returns {{bodies: Array<object>, excluded: {unsettled: Array<object>, noGroup: Array<object>}, totalUnits: number}}
 */
export function buildPurchaseList(pivot, resolved, { body = null } = {}) {
  const bodies = [];
  const unsettled = [];
  const noGroup = [];
  let totalUnits = 0;

  for (const bodyRow of pivot.bodies ?? []) {
    if (body && bodyRow.body !== body) continue;
    const colors = [];
    let bodyUnits = 0;

    for (const colorRow of [...bodyRow.colors].sort((a, b) => cmpString(a.colorLabel ?? a.color, b.colorLabel ?? b.color))) {
      const rows = [];
      let colorUnits = 0;

      for (const cell of [...colorRow.cells].sort((a, b) => compareSizes(a.size, b.size))) {
        const min = resolved.get(cell.key)?.min ?? 0;
        if (min <= 0) continue;
        const facts = {
          key: cell.key,
          body: cell.body,
          bodyLabel: bodyRow.bodyLabel ?? bodyRow.body,
          color: cell.color,
          colorLabel: colorRow.colorLabel ?? colorRow.color,
          size: cell.size,
          sizeLabel: cell.sizeLabel ?? cell.size,
          state: cell.state,
          min,
        };
        if (cell.state === NO_GROUP) {
          noGroup.push(facts);
          continue;
        }
        if (cell.onHand === null) {
          // Only ambiguous when a buy line actually turns on the answer. If even the LOWEST member
          // already meets the minimum, every reading in the range yields the same result (buy
          // nothing), so there is nothing to resolve before ordering and naming the cell would send
          // the operator to recount a group that can never need a purchase. This mirrors
          // flagReorders, which flags an unsettled cell only when even its highest member is short:
          // both refuse to cry wolf over a group that is merely mid-fan-out.
          if (cell.low < min) unsettled.push({ ...facts, low: cell.low, high: cell.high });
          continue;
        }
        if (cell.onHand >= min) continue;
        // Unclamped on the on-hand side, as flagReorders is: Shopify permits a negative quantity, and
        // a cell that has oversold needs the oversell bought back as well as the minimum refilled.
        const buy = min - cell.onHand;
        colorUnits += buy;
        rows.push({ size: cell.size, sizeLabel: facts.sizeLabel, buy, onHand: cell.onHand, min });
      }

      if (!rows.length) continue;
      bodyUnits += colorUnits;
      colors.push({ color: colorRow.color, colorLabel: colorRow.colorLabel ?? colorRow.color, units: colorUnits, rows });
    }

    if (!colors.length) continue;
    totalUnits += bodyUnits;
    bodies.push({ body: bodyRow.body, bodyLabel: bodyRow.bodyLabel ?? bodyRow.body, units: bodyUnits, colors });
  }

  const byCell = (a, b) => cmpString(a.body, b.body) || cmpString(a.colorLabel, b.colorLabel) || compareSizes(a.size, b.size);
  return { bodies, excluded: { unsettled: unsettled.sort(byCell), noGroup: noGroup.sort(byCell) }, totalUnits };
}

/**
 * The purchase list as text. Returns a string; the command prints it and decides nothing.
 *
 * THE EXCLUDED SECTION IS ALWAYS PRINTED, before the total, and says "none" when it is empty. A
 * section that appeared only when there was something to say would make its absence ambiguous: an
 * operator cannot tell "nothing was excluded" from "the tool did not check" by looking at a gap.
 * Putting it before the total keeps it above the number the eye stops on.
 *
 * The empty case prints a sentence and not a table. A bare `TOTAL: 0 units` under an empty list
 * reads as a failed run rather than as a store that is fully stocked.
 *
 * The closing footer is a REMINDER, not the enforcement. The rule that this output never becomes a
 * count-sheet entry or a write quantity lives in the skill; a line of text in a terminal cannot
 * enforce anything, and treating it as though it could is how a guardrail quietly becomes decorative.
 *
 * @param {{bodies: Array<object>, excluded: {unsettled: Array<object>, noGroup: Array<object>}, totalUnits: number}} list
 * @returns {string}
 */
export function renderPurchaseList(list) {
  const units = (n) => `${n} unit${n === 1 ? '' : 's'}`;
  const title = 'PURCHASE LIST  (units to reach minimum)';
  const out = [title, '='.repeat(title.length), ''];

  if (!list.bodies.length) {
    out.push('No sizes below minimum.', '');
  } else {
    for (const body of list.bodies) {
      out.push(body.bodyLabel, '='.repeat(body.bodyLabel.length));
      for (const color of body.colors) {
        out.push(`  ${color.colorLabel}   (${units(color.units)})`);
        out.push(`      ${'size'.padEnd(6)}${'buy'.padStart(5)}${'have'.padStart(7)}${'min'.padStart(6)}`);
        for (const row of color.rows) {
          out.push(`      ${String(row.sizeLabel).padEnd(6)}${String(row.buy).padStart(5)}${String(row.onHand).padStart(7)}${String(row.min).padStart(6)}`);
        }
      }
      out.push(`  ${body.bodyLabel} total: ${units(body.units)}`, '');
    }
  }

  const excluded = [...list.excluded.unsettled, ...list.excluded.noGroup];
  if (!excluded.length) {
    out.push('Excluded: none');
  } else {
    out.push(`Excluded: ${excluded.length} cell(s) (not settled / no group); resolve before ordering those`);
    for (const cell of list.excluded.unsettled) {
      out.push(`  ${cell.bodyLabel} / ${cell.colorLabel} / ${cell.sizeLabel}: not settled (${cell.low}-${cell.high} on hand, min ${cell.min})`);
    }
    for (const cell of list.excluded.noGroup) {
      out.push(`  ${cell.bodyLabel} / ${cell.colorLabel} / ${cell.sizeLabel}: no blank group (min ${cell.min}); see "audit"`);
    }
  }

  out.push(`TOTAL: ${units(list.totalUnits)}`);
  out.push('  Each body is a different physical garment; totals never combine across bodies.');
  out.push('  Purchasing aid only. Never enter these numbers into a count sheet or inventory write.');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Demand
// ---------------------------------------------------------------------------

/**
 * Net units for one line item.
 *
 * `quantity` INCLUDES refunded and removed units, so it is the wrong metric: a returned garment is
 * back on the shelf and did not represent demand that has to be restocked. `currentQuantity` is
 * quantity minus refunded and removed units, and `refundableQuantity` excludes refunded units; the
 * first is preferred, the second is the fallback for a shape that lacks it.
 *
 * @param {object} li
 * @returns {number}
 */
export function netUnits(li) {
  for (const field of ['currentQuantity', 'refundableQuantity', 'quantity']) {
    const v = li?.[field];
    if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, v);
  }
  return 0;
}

/**
 * Roll line items up into body+colour+size cells.
 *
 * A line item whose variant is null, deleted, or not in the index is NOT dropped. It lands in
 * `unattributed` carrying its ids, because a silently discarded line is demand that vanishes from
 * the proposal with nothing to show for it. Cancelled lines are excluded outright: they were never
 * sold.
 *
 * @param {Array<object>} lineItems - {id, quantity, currentQuantity, variantId, cancelled?}
 * @param {Map<string, {body: string, color: string, size: string}>} variantIndex
 * @returns {{byCell: Map<string, object>, byBodyColor: Map<string, number>, unattributed: Array<object>}}
 */
export function aggregateDemand(lineItems, variantIndex) {
  const byCell = new Map();
  const byBodyColor = new Map();
  const unattributed = [];

  for (const li of lineItems ?? []) {
    if (li?.cancelled) continue;
    const units = netUnits(li);
    const v = li?.variantId ? variantIndex.get(li.variantId) : undefined;
    if (!v || !v.body || !v.color || !v.size) {
      unattributed.push({ lineItemId: li?.id ?? null, variantId: li?.variantId ?? null, orderId: li?.orderId ?? null, units });
      continue;
    }
    const body = normaliseAxis(v.body, 'Body');
    const color = normaliseAxis(v.color, 'Color');
    const size = normaliseAxis(v.size, 'Size');
    const key = vocabKey({ body, color, size });
    if (!byCell.has(key)) byCell.set(key, { key, body, color, size, units: 0 });
    byCell.get(key).units += units;
    const pair = `${body}|${color}`;
    byBodyColor.set(pair, (byBodyColor.get(pair) ?? 0) + units);
  }

  return { byCell, byBodyColor, unattributed };
}

/**
 * Distribute a whole-number total across weighted items.
 *
 * Largest remainder, so the parts always sum to the total exactly. Ties break on the larger weight
 * and then on the key, so the same inputs always produce the same vector; a rounding rule that
 * depended on iteration order would make a regenerated thresholds.json diff for no reason.
 *
 * ONE implementation, shared by the initial derivation and by the demand proposal. Two copies of
 * this arithmetic would drift, and the drift would show up as a threshold nobody chose.
 *
 * @param {Array<{key: string, weight: number}>} items
 * @param {number} total
 * @returns {Map<string, number>}
 */
export function largestRemainder(items, total) {
  const rows = (items ?? []).map((i) => ({ key: i.key, weight: Number(i.weight) || 0, base: 0, rem: 0 }));
  const sum = rows.reduce((a, r) => a + r.weight, 0);
  if (!rows.length) return new Map();
  if (!(total > 0) || sum <= 0) return new Map(rows.map((r) => [r.key, 0]));

  for (const r of rows) {
    const exact = (r.weight / sum) * total;
    r.base = Math.floor(exact);
    r.rem = exact - r.base;
  }
  let remaining = Math.round(total - rows.reduce((a, r) => a + r.base, 0));
  const order = [...rows].sort((a, b) => b.rem - a.rem || b.weight - a.weight || cmpString(a.key, b.key));
  for (let i = 0; remaining > 0; i++, remaining--) order[i % order.length].base += 1;
  return new Map(rows.map((r) => [r.key, r.base]));
}

/**
 * Propose per-cell minimums from observed demand.
 *
 * THE MODEL, stated so nobody mistakes it for more than it is: the garment body's CURRENT budget is
 * redistributed across its colour x size cells in proportion to recent net units sold. There is no
 * lead-time term, no safety stock, no seasonality, and no growth assumption.
 *
 * The redistribution spans COLOUR AS WELL AS SIZE, because the colour split is derived the same way
 * the size split is: from a popularity curve at derivation time, and from observed demand
 * afterwards. Recalibrating sizes while holding an assumed colour mix fixed would leave half the
 * table permanently on a guess that nothing ever tests.
 *
 * Two holds keep it from ratcheting a blank out of existence:
 *   - a body with fewer than MIN_OBSERVED_UNITS net units in the window is `insufficient-data` as a
 *     whole, and every one of its minimums is held;
 *   - a cell whose on-hand is at or below its own minimum could not have sold what it might have, so
 *     it is held and excluded from the redistribution rather than being told it has no demand. A cell
 *     with no settled on-hand reading (mid-fan-out, or no group at all) is held for the same reason:
 *     nothing observed can be trusted to mean low demand.
 *
 * @param {object} params
 * @param {Map<string, {units: number}>} params.byCell
 * @param {Map<string, number>} params.budgets - keyed by body
 * @param {Map<string, object>} params.resolved
 * @param {{cells: Map<string, object>}} params.pivot
 * @param {number} [params.minObservedUnits]
 * @returns {{rows: Array<object>, bodies: Array<object>}}
 */
export function proposeAdjustments({ byCell, budgets, resolved, pivot, minObservedUnits = MIN_OBSERVED_UNITS }) {
  /** @type {Map<string, object[]>} */
  const byBody = new Map();
  // Insertion order, not a re-sort: `resolved` is built from cartesianCells, so it is already in
  // canonical colour-then-size order, and re-sorting here would be a second ordering rule to drift.
  for (const cell of resolved.values()) {
    if (!byBody.has(cell.body)) byBody.set(cell.body, []);
    byBody.get(cell.body).push(cell);
  }

  const rows = [];
  const bodies = [];

  for (const [body, cells] of [...byBody.entries()].sort((a, b) => cmpString(a[0], b[0]))) {
    if (!budgets.has(body)) {
      throw new Error(
        `No budget for "${body}". demand redistributes a stated budget, so it cannot propose a ` +
          `minimum without one. Add it to provenance.budgets in a reviewed PR, or narrow the run.`
      );
    }
    const budget = budgets.get(body);

    const observed = new Map(cells.map((c) => [c.key, byCell.get(c.key)?.units ?? 0]));
    const bodyUnits = [...observed.values()].reduce((a, n) => a + n, 0);
    const currentSum = cells.reduce((a, c) => a + c.min, 0);
    const budgetDrift = currentSum === budget ? null : { currentSum, budget };

    const held = new Map();
    for (const cell of cells) {
      const pivotCell = pivot?.cells?.get(cell.key);
      if (!pivotCell) {
        throw new Error(
          `The pivot has no cell for "${cell.key}" but the thresholds table does. The two are built ` +
            `from the same axes, so this means they were built from different reads; re-run.`
        );
      }
      if (pivotCell.onHand === null) {
        held.set(cell.key, pivotCell.state === NO_GROUP ? 'no-group' : 'unsettled');
      } else if (pivotCell.onHand <= cell.min) {
        held.set(cell.key, 'stocked-out');
      }
    }

    const bodyInsufficient = bodyUnits < minObservedUnits;
    const free = cells.filter((c) => !held.has(c.key));
    const freeUnits = free.reduce((a, c) => a + observed.get(c.key), 0);
    const redistribute = !bodyInsufficient && free.length > 0 && freeUnits > 0;

    const heldTotal = cells.filter((c) => held.has(c.key)).reduce((a, c) => a + c.min, 0);
    const remaining = Math.max(0, budget - heldTotal);
    const shares = redistribute
      ? largestRemainder(
          free.map((c) => ({ key: c.key, weight: observed.get(c.key) })),
          remaining
        )
      : new Map();

    for (const cell of cells) {
      const units = observed.get(cell.key);
      const status = bodyInsufficient
        ? 'insufficient-data'
        : held.has(cell.key)
          ? `held:${held.get(cell.key)}`
          : redistribute
            ? 'proposed'
            : 'insufficient-data';
      const proposedMin = status === 'proposed' ? shares.get(cell.key) : cell.min;
      rows.push({
        key: cell.key,
        body,
        color: cell.color,
        size: cell.size,
        units,
        observedShare: bodyUnits ? units / bodyUnits : 0,
        thresholdShare: currentSum ? cell.min / currentSum : 0,
        currentMin: cell.min,
        proposedMin,
        delta: proposedMin - cell.min,
        status,
      });
    }

    bodies.push({
      body,
      budget,
      budgetDrift,
      units: bodyUnits,
      status: bodyInsufficient || !redistribute ? 'insufficient-data' : 'proposed',
      heldCells: [...held.keys()],
    });
  }

  return { rows, bodies };
}

// ---------------------------------------------------------------------------
// Derivation and serialisation
// ---------------------------------------------------------------------------

/**
 * Build the initial thresholds document from a colour curve, a size curve, and one budget per body.
 *
 * TWO STAGES, BOTH LARGEST REMAINDER. The body's budget splits across colours by the colour
 * popularity curve, and each colour's share then splits across sizes by the size curve. Colour is
 * derived exactly as size is, and for the same reason: a per-colour budget stated by hand would be a
 * second source of truth for a number the curve already determines, and the two would drift with
 * nothing reconciling them. Because both stages are largest remainder, every body's cells sum to its
 * budget exactly, with no rounding leak between the stages.
 *
 * Both stages walk the body's DECLARED range, so a colour curve entry for a colour the body is not
 * made in simply never gets a cell, and the body's whole budget lands on the colours it does have.
 *
 * The curves and the budgets are recorded as PROVENANCE only. The cells are the source of truth,
 * because the cells are what the PR diff shows: a reviewer can read "crewneck black M: 6" and judge
 * it, where two curves plus a budget plus a rounding rule is four things to re-derive by hand.
 *
 * @param {object} params
 * @param {Record<string, Record<string, number>>} params.sizeCurve - body -> size -> share
 * @param {Record<string, Record<string, number>>} params.colorCurve - body -> colour -> share
 * @param {Map<string, number>|Record<string, number>} params.budgets - body -> unit count
 * @param {{bodies: string[], colors: string[], sizes: string[]}} params.axes
 * @param {object} [params.provenance] - derivedAt, method, research
 * @param {Record<string, string>} [params.notes] - per-cell note, keyed by cell key or by body
 * @returns {object} the document, ready for serializeThresholds
 */
export function deriveThresholds({ sizeCurve, colorCurve, budgets, axes, provenance = {}, notes = {} }) {
  const budgetMap = budgets instanceof Map ? budgets : new Map(Object.entries(budgets ?? {}));
  const cells = {};

  for (const body of axes.bodies) {
    const budget = budgetMap.get(body) ?? 0;
    const range = rangeFor(axes, body);
    const colorBudgets = largestRemainder(
      range.colors.map((color) => ({ key: color, weight: Number(colorCurve?.[body]?.[color] ?? 0) })),
      budget
    );
    for (const color of range.colors) {
      const sizes = range.sizes.map((size) => ({
        key: vocabKey({ body, color, size }),
        weight: Number(sizeCurve?.[body]?.[size] ?? 0),
      }));
      const mins = largestRemainder(sizes, colorBudgets.get(color) ?? 0);
      for (const s of sizes) {
        const note = notes[s.key] ?? notes[`${body}|${color}`] ?? notes[body];
        const min = mins.get(s.key) ?? 0;
        cells[s.key] = note === undefined ? { min } : { min, note };
      }
    }
  }

  return {
    version: THRESHOLDS_VERSION,
    provenance: {
      derivedAt: provenance.derivedAt ?? null,
      method: provenance.method ?? 'research colour curve x research size curve x operator budget per body',
      research: provenance.research ?? '',
      colorCurve: colorCurve ?? {},
      sizeCurve: sizeCurve ?? {},
      budgets: Object.fromEntries([...budgetMap.entries()]),
      adjustments: provenance.adjustments ?? [],
    },
    cells,
  };
}

/**
 * Canonical serialisation: fixed key order, two-space indent, trailing newline.
 *
 * Regenerating the file from the same inputs must produce a byte-identical result, or every
 * regeneration lands a diff of shuffled lines that hides the one number that actually changed.
 *
 * @param {object} doc
 * @param {{bodies: string[], colors: string[], sizes: string[]}} axes
 * @returns {string}
 */
export function serializeThresholds(doc, axes) {
  const cells = {};
  for (const cell of cartesianCells(axes)) {
    if (doc.cells?.[cell.key] !== undefined) cells[cell.key] = doc.cells[cell.key];
  }
  // Anything outside the cartesian product is kept rather than dropped: a stale row is the
  // operator's to remove, and silently deleting it here would make a regeneration destructive.
  for (const [key, value] of Object.entries(doc.cells ?? {})) {
    if (cells[key] === undefined) cells[key] = value;
  }

  const budgets = {};
  const rawBudgets = doc.provenance?.budgets ?? {};
  for (const body of axes.bodies) {
    if (rawBudgets[body] !== undefined) budgets[body] = rawBudgets[body];
  }
  for (const [key, value] of Object.entries(rawBudgets)) {
    if (budgets[key] === undefined) budgets[key] = value;
  }

  const ordered = {
    version: doc.version,
    provenance: {
      derivedAt: doc.provenance?.derivedAt ?? null,
      method: doc.provenance?.method ?? '',
      research: doc.provenance?.research ?? '',
      colorCurve: doc.provenance?.colorCurve ?? {},
      sizeCurve: doc.provenance?.sizeCurve ?? {},
      budgets,
      adjustments: doc.provenance?.adjustments ?? [],
    },
    cells,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * The ISO instant `days` before `now`.
 *
 * The clock is injected so the window boundary is asserted rather than assumed, and so a test is not
 * a different test tomorrow.
 *
 * @param {number} days
 * @param {Date|number} now
 * @returns {string}
 */
export function sinceDate(days, now) {
  if (typeof days !== 'number' || !Number.isInteger(days) || days <= 0) {
    throw new Error(`--days must be a whole number of days above zero, got ${JSON.stringify(days)}.`);
  }
  const base = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(base)) throw new Error('sinceDate needs a concrete clock reading.');
  return new Date(base - days * 24 * 60 * 60 * 1000).toISOString();
}
