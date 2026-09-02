// A line-based unified diff, zero dependencies.
//
// It exists so `policies:push` can show the operator exactly what a mutation would change before
// anything is sent. A policy body is a few hundred lines, so a plain LCS table is fast enough and
// is far easier to be sure of than a Myers implementation.
//
// Pure: no fs, no network, no env.

/** The longest common subsequence of two line arrays, as pairs of indices. */
function lcsPairs(a, b) {
  const n = a.length;
  const m = b.length;
  // table[i][j] = LCS length of a[i..] and b[j..]
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** Every edit as `{ op: ' '|'-'|'+', line, aIndex, bIndex }`, in output order. */
export function diffLines(aLines, bLines) {
  const pairs = lcsPairs(aLines, bLines);
  const out = [];
  let i = 0;
  let j = 0;
  const emitGap = (toI, toJ) => {
    while (i < toI) out.push({ op: '-', line: aLines[i], aIndex: i++, bIndex: null });
    while (j < toJ) out.push({ op: '+', line: bLines[j], aIndex: null, bIndex: j++ });
  };
  for (const [ai, bj] of pairs) {
    emitGap(ai, bj);
    out.push({ op: ' ', line: aLines[ai], aIndex: i++, bIndex: j++ });
  }
  emitGap(aLines.length, bLines.length);
  return out;
}

/**
 * A unified diff of two texts.
 *
 * @param {string} aText
 * @param {string} bText
 * @param {object} [o]
 * @param {string} [o.aLabel]
 * @param {string} [o.bLabel]
 * @param {number} [o.context]  context lines around each hunk
 * @returns {string} the diff, or '' when the texts are identical
 */
export function unifiedDiff(aText, bText, { aLabel = 'a', bLabel = 'b', context = 3 } = {}) {
  if (aText === bText) return '';
  const a = String(aText).split('\n');
  const b = String(bText).split('\n');
  const edits = diffLines(a, b);

  // Group changed lines into hunks, each padded by `context` unchanged lines on both sides.
  const changed = edits.map((e, n) => (e.op === ' ' ? -1 : n)).filter((n) => n !== -1);
  if (changed.length === 0) return '';
  const hunks = [];
  let start = changed[0];
  let end = changed[0];
  for (const n of changed.slice(1)) {
    if (n - end <= context * 2) end = n;
    else {
      hunks.push([start, end]);
      start = n;
      end = n;
    }
  }
  hunks.push([start, end]);

  const lines = [`--- ${aLabel}`, `+++ ${bLabel}`];
  for (const [from, to] of hunks) {
    const lo = Math.max(0, from - context);
    const hi = Math.min(edits.length - 1, to + context);
    const slice = edits.slice(lo, hi + 1);
    const aStart = firstIndex(slice, 'aIndex');
    const bStart = firstIndex(slice, 'bIndex');
    const aCount = slice.filter((e) => e.op !== '+').length;
    const bCount = slice.filter((e) => e.op !== '-').length;
    lines.push(`@@ -${aCount === 0 ? aStart : aStart + 1},${aCount} +${bCount === 0 ? bStart : bStart + 1},${bCount} @@`);
    for (const e of slice) lines.push(`${e.op}${e.line}`);
  }
  return `${lines.join('\n')}\n`;
}

function firstIndex(slice, field) {
  for (const e of slice) if (e[field] !== null) return e[field];
  return 0;
}

/**
 * True when two texts differ only in HTML entity spelling and whitespace, which is the shape
 * Shopify's own renormalisation takes. Used to decide whether a post-write mismatch may be
 * accepted with `--accept-normalisation` or must abort.
 *
 * Deliberately conservative: it compares the two texts with every entity reference and every run
 * of whitespace removed. Any surviving difference is a content change, not normalisation.
 */
export function differsOnlyByEntitiesAndWhitespace(aText, bText, decodeEntities) {
  const strip = (s) => decodeEntities(String(s)).replace(/\s+/g, '');
  return aText !== bText && strip(aText) === strip(bText);
}
