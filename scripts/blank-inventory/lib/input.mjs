// Parse the adjustments input and enforce the mode contract.
//
// Mode is the single most damaging thing to get wrong here: reading "12" as a count when it meant
// "+12" silently destroys stock, and the two are indistinguishable from the numbers alone. So mode
// is declared up front by the operator as a required flag, and this module cross-checks that
// declaration against what the source actually shows. The flag states intent; the source is
// evidence; a disagreement stops the run.
//
// Residual risk, stated here because it cannot be engineered away: when the source is a PHOTO, the
// cross-check is NOT independent of the transcription it backstops. Both come from the same vision
// pass, so a dropped "+" disables the very check meant to catch it. The operator confirmation gate
// is the real control. Do not present this cross-check as a sufficient safeguard on its own.
//
// Pure module: no network, no filesystem.

export const MODE_ABSOLUTE = 'absolute';
export const MODE_DELTA = 'delta';
export const MODES = [MODE_ABSOLUTE, MODE_DELTA];

/** Marker a transcription must use for an illegible cell. Blocks the row; never guessed. */
export const UNREADABLE = 'UNREADABLE';

// Signals that the source describes CHANGES rather than counts.
const DELTA_HEADING = /\b(received|receiving|added|adjust\w*|delta|change[ds]?|restock\w*|inbound|shipment)\b/i;
const DELTA_GLYPH = /[→↑↓⇒]|(^|\s)->/; // arrows, ASCII ->

// Signals that the source describes ABSOLUTE counts.
const ABSOLUTE_HEADING = /\b(count\w*|on[\s-]?hand|in[\s-]?stock|stock|total|qty|quantity|have|inventory)\b/i;

/**
 * Split one CSV line, honouring double-quoted cells.
 * @param {string} line
 * @returns {string[]}
 */
export function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      cells.push(cur);
      cur = '';
    } else cur += c;
  }
  cells.push(cur);
  return cells.map((s) => s.trim());
}

/**
 * Does this token look like a signed number?
 * @param {string} token
 * @returns {boolean}
 */
export function isSigned(token) {
  return /^[+-]\s*\d+$/.test(String(token ?? '').trim());
}

/**
 * Parse a numeric cell into { value, signed }.
 * @param {string} token
 * @returns {{value: number, signed: boolean}}
 */
export function parseValue(token) {
  const raw = String(token ?? '').trim();
  if (raw === '') throw new Error('Empty value cell.');
  if (raw.toUpperCase() === UNREADABLE) {
    throw new Error(
      `Value is marked ${UNREADABLE}. An illegible cell blocks its row; it is never guessed. ` +
        `Re-read that line off the source and supply the number explicitly.`
    );
  }
  const signed = isSigned(raw);
  const normalised = raw.replace(/\s+/g, '');
  if (!/^[+-]?\d+$/.test(normalised)) {
    throw new Error(`Value "${raw}" is not a whole number.`);
  }
  return { value: Number(normalised), signed };
}

/**
 * Cross-check the declared mode against evidence in the source.
 *
 * Biased to stop: any ambiguity (both signal families present) is a stop, not a best guess. A
 * contradiction stops the WHOLE run rather than skipping the offending row, because a mode error is
 * systematic, not per-row: if one row proves the sheet is a receiving slip, every row on it is.
 *
 * @param {{headers?: string[], rawValues?: string[], text?: string}} source
 * @param {string} mode
 * @returns {{ok: boolean, problems: string[]}}
 */
export function crossCheckMode(source, mode) {
  const headers = (source.headers ?? []).join(' ');
  const rawValues = source.rawValues ?? [];
  const text = source.text ?? '';
  const haystack = `${headers} ${text}`;

  const deltaEvidence = [];
  const absoluteEvidence = [];

  if (DELTA_HEADING.test(haystack)) deltaEvidence.push('a "received / added / adjustment" style heading');
  if (DELTA_GLYPH.test(haystack)) deltaEvidence.push('an arrow glyph');
  const signedCount = rawValues.filter(isSigned).length;
  if (signedCount > 0) deltaEvidence.push(`${signedCount} signed value(s) such as "+12" or "-3"`);

  if (ABSOLUTE_HEADING.test(haystack)) absoluteEvidence.push('a "count / on hand / stock" style heading');

  const problems = [];

  if (mode === MODE_ABSOLUTE && deltaEvidence.length) {
    problems.push(
      `--mode absolute was declared, but the source shows ${deltaEvidence.join(' and ')}. ` +
        `That reads like a change list, not a count sheet.`
    );
  }
  if (mode === MODE_DELTA && absoluteEvidence.length && !deltaEvidence.length) {
    problems.push(
      `--mode delta was declared, but the source shows ${absoluteEvidence.join(' and ')} and no ` +
        `sign of being a change list. That reads like a count sheet, not a receiving slip.`
    );
  }
  if (deltaEvidence.length && absoluteEvidence.length) {
    problems.push(
      `The source carries BOTH change-list evidence (${deltaEvidence.join(', ')}) and count-sheet ` +
        `evidence (${absoluteEvidence.join(', ')}). Ambiguous sources stop the run; split the sheet ` +
        `or state which it is.`
    );
  }

  return { ok: problems.length === 0, problems };
}

/** Input layouts. There is no third: a shape is declared, never inferred. */
export const FORMAT_BLANK = 'blank';
export const FORMAT_BCS = 'body-color-size';
export const FORMATS = [FORMAT_BLANK, FORMAT_BCS];

/** Positional columns per format. `raw` is optional and always last. */
const COLUMNS = {
  [FORMAT_BLANK]: ['blank', 'value', 'raw'],
  [FORMAT_BCS]: ['body', 'color', 'size', 'value', 'raw'],
};
const REQUIRED_COLUMNS = {
  [FORMAT_BLANK]: ['blank', 'value'],
  [FORMAT_BCS]: ['body', 'color', 'size', 'value'],
};

/** Header spellings mapped to canonical column names. */
const HEADER_ALIASES = new Map([
  ['blank', 'blank'], ['blankid', 'blank'], ['blank_id', 'blank'], ['sku', 'blank'],
  ['body', 'body'], ['garment', 'body'],
  ['color', 'color'], ['colour', 'color'],
  ['size', 'size'],
  ['value', 'value'], ['qty', 'value'], ['quantity', 'value'], ['count', 'value'], ['delta', 'value'],
  ['raw', 'raw'], ['as_written', 'raw'], ['aswritten', 'raw'],
]);

const canonicalHeader = (cell) => HEADER_ALIASES.get(String(cell).trim().toLowerCase().replace(/[\s-]+/g, '_')) ?? null;

/**
 * Work out the column layout, from a header row or from a declared format.
 *
 * NEVER from the number of cells. Arity inference is why the transcription format could not express
 * the source: a three-column sheet silently became "color,size,value", so there was nowhere to put
 * the body or the token as written, and a mis-shaped row was read as a different valid shape rather
 * than refused.
 *
 * @param {string[]} first - the first parsed line
 * @param {string|undefined} format
 * @returns {{columns: Array<string|null>, format: string, hasHeader: boolean, headers: string[]}}
 */
export function resolveLayout(first, format) {
  const mapped = first.map(canonicalHeader);
  const hasHeader = mapped.every((m) => m !== null);

  if (hasHeader) {
    const named = new Set(mapped);
    const detected = named.has('blank') ? FORMAT_BLANK : FORMAT_BCS;
    if (format && format !== detected) {
      throw new Error(
        `--format ${format} was declared but the header row describes ${detected} ` +
          `(${first.join(', ')}). The file and the flag disagree; fix one rather than letting the ` +
          `tool pick.`
      );
    }
    const missing = REQUIRED_COLUMNS[detected].filter((c) => !named.has(c));
    if (missing.length) {
      throw new Error(
        `Header row is missing required column(s): ${missing.join(', ')}. Expected ` +
          `${COLUMNS[detected].join(',')} (raw optional).`
      );
    }
    return { columns: mapped, format: detected, hasHeader: true, headers: first };
  }

  if (!format) {
    throw new Error(
      `Input has no recognisable header row, so its shape cannot be determined. Add a header ` +
        `(${COLUMNS[FORMAT_BCS].join(',')}) or pass --format ${FORMATS.join('|')}. The shape is ` +
        `never guessed from the column count: two different layouts with the same number of columns ` +
        `mean opposite things.`
    );
  }
  if (!FORMATS.includes(format)) {
    throw new Error(`--format must be one of ${FORMATS.join(' | ')}.`);
  }
  return { columns: COLUMNS[format], format, hasHeader: false, headers: [] };
}

/**
 * Parse the adjustments CSV.
 *
 * Canonical shape, and the one the transcription workflow writes:
 *   body,color,size,value,raw
 * Also accepted, for adjusting groups already identified by their blank id:
 *   blank,value,raw
 *
 * `raw` carries the token exactly as it appears on the source, so the confirmation table shown at
 * the approval gate is generated FROM THE FILE rather than re-rendered from memory. A gate that
 * confirms something other than the planned bytes confirms nothing.
 *
 * @param {string} text
 * @param {object} opts
 * @param {string} opts.mode
 * @param {string} [opts.format]
 * @returns {{rows: Array<object>, headers: string[], mode: string, format: string}}
 */
export function parseInput(text, { mode, format }) {
  if (!MODES.includes(mode)) {
    throw new Error(`--mode must be one of ${MODES.join(' | ')} (no default, no inference).`);
  }

  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  if (!lines.length) throw new Error('Input is empty.');

  const layout = resolveLayout(parseCsvLine(lines[0]), format);
  const { columns } = layout;
  const body = layout.hasHeader ? lines.slice(1) : lines;
  const headers = layout.headers;

  if (!body.length) throw new Error('Input has a header but no rows.');

  const rows = [];
  const rawValues = [];
  const seen = new Map();

  body.forEach((line, i) => {
    const cells = parseCsvLine(line);
    const lineNo = (layout.hasHeader ? 2 : 1) + i;

    const required = REQUIRED_COLUMNS[layout.format];
    if (cells.length < required.length || cells.length > columns.length) {
      throw new Error(
        `Line ${lineNo}: expected ${required.length} to ${columns.length} cells for format ` +
          `${layout.format} (${columns.filter(Boolean).join(',')}), got ${cells.length}.`
      );
    }

    const cell = (name) => {
      const at = columns.indexOf(name);
      return at === -1 ? undefined : cells[at];
    };

    const key =
      layout.format === FORMAT_BLANK
        ? { blankId: cell('blank') }
        : { body: cell('body'), color: cell('color'), size: cell('size') };
    const rawValue = cell('value');
    const asWritten = cell('raw');

    for (const [axis, value] of Object.entries(key)) {
      if (!String(value ?? '').trim()) {
        throw new Error(`Line ${lineNo}: ${axis} is empty. Every axis is required; none is defaulted.`);
      }
    }

    let parsed;
    try {
      parsed = parseValue(rawValue);
    } catch (err) {
      throw new Error(`Line ${lineNo}: ${err.message}`);
    }

    if (mode === MODE_DELTA && !parsed.signed) {
      throw new Error(
        `Line ${lineNo}: value "${rawValue}" is unsigned under --mode delta. An unsigned number is ` +
          `refused rather than assumed positive: "12" meaning "+12" and "12" meaning "set to 12" ` +
          `are the same characters and opposite outcomes. Write "+12" or "-12".`
      );
    }
    if (mode === MODE_ABSOLUTE && parsed.signed) {
      throw new Error(
        `Line ${lineNo}: value "${rawValue}" is signed under --mode absolute. A signed value is a ` +
          `change, not a count.`
      );
    }
    if (mode === MODE_ABSOLUTE && parsed.value < 0) {
      throw new Error(`Line ${lineNo}: absolute quantity cannot be negative.`);
    }

    const label = key.blankId ?? `${key.body} / ${key.color} / ${key.size}`;
    const dedupeKey = key.blankId ? `blank:${key.blankId}` : `bcs:${key.body}|${key.color}|${key.size}`;
    if (seen.has(dedupeKey)) {
      throw new Error(
        `Line ${lineNo}: duplicate entry for ${label} (first seen on line ${seen.get(dedupeKey)}). ` +
          `Duplicates are refused rather than summed or last-wins: a double-counted row and a ` +
          `running total look identical here.`
      );
    }
    seen.set(dedupeKey, lineNo);

    rawValues.push(rawValue);
    rows.push({
      ...key,
      rawValue,
      asWritten: asWritten ?? null,
      value: parsed.value,
      signed: parsed.signed,
      line: lineNo,
    });
  });

  const check = crossCheckMode({ headers, rawValues, text }, mode);
  if (!check.ok) {
    throw new Error(`Mode cross-check failed:\n  - ${check.problems.join('\n  - ')}`);
  }

  return { rows, headers, mode, format: layout.format };
}
