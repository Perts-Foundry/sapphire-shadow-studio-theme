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

/**
 * Parse the adjustments CSV.
 *
 * Accepted shapes (a header row is optional and detected):
 *   blank,value
 *   color,size,value
 *
 * @param {string} text
 * @param {object} opts
 * @param {string} opts.mode
 * @returns {{rows: Array<object>, headers: string[], mode: string}}
 */
export function parseInput(text, { mode }) {
  if (!MODES.includes(mode)) {
    throw new Error(`--mode must be one of ${MODES.join(' | ')} (no default, no inference).`);
  }

  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  if (!lines.length) throw new Error('Input is empty.');

  const first = parseCsvLine(lines[0]);
  const looksLikeHeader = first.some((c) => /[a-z]/i.test(c) && !/^\d+$/.test(c)) && /blank|colou?r|size|value|qty|quantity|count|delta/i.test(first.join(' '));
  const headers = looksLikeHeader ? first : [];
  const body = looksLikeHeader ? lines.slice(1) : lines;

  if (!body.length) throw new Error('Input has a header but no rows.');

  const rows = [];
  const rawValues = [];
  const seen = new Map();

  body.forEach((line, i) => {
    const cells = parseCsvLine(line);
    const lineNo = (looksLikeHeader ? 2 : 1) + i;
    let key;
    let rawValue;

    if (cells.length === 2) {
      key = { blankId: cells[0] };
      rawValue = cells[1];
    } else if (cells.length === 3) {
      key = { color: cells[0], size: cells[1] };
      rawValue = cells[2];
    } else {
      throw new Error(`Line ${lineNo}: expected "blank,value" or "color,size,value", got ${cells.length} cells.`);
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

    const dedupeKey = key.blankId ? `blank:${key.blankId}` : `cs:${key.color}|${key.size}`;
    if (seen.has(dedupeKey)) {
      throw new Error(
        `Line ${lineNo}: duplicate entry for ${key.blankId ?? `${key.color} / ${key.size}`} ` +
          `(first seen on line ${seen.get(dedupeKey)}). Duplicates are refused rather than summed ` +
          `or last-wins: a double-counted row and a running total look identical here.`
      );
    }
    seen.set(dedupeKey, lineNo);

    rawValues.push(rawValue);
    rows.push({ ...key, rawValue, value: parsed.value, signed: parsed.signed, line: lineNo });
  });

  const check = crossCheckMode({ headers, rawValues, text }, mode);
  if (!check.ok) {
    throw new Error(`Mode cross-check failed:\n  - ${check.problems.join('\n  - ')}`);
  }

  return { rows, headers, mode };
}
