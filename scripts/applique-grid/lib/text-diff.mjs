// A minimal unified diff, so `draft.mjs --write` can show EXACTLY what it would change to
// patterns.json before it changes it. Validity is not approval: a valid registry that renames
// three patterns is still three renames the operator has to see.
//
// Plain LCS. The inputs are one JSON file of a few hundred lines, so the quadratic table is
// irrelevant and the absence of a dependency is not.

/**
 * Longest common subsequence of two line arrays, as the list of matched index pairs.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Array<[number, number]>}
 */
function lcsPairs(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = a[i] === b[j]
        ? dp[(i + 1) * (m + 1) + (j + 1)] + 1
        : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + (j + 1)]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + (j + 1)]) i++;
    else j++;
  }
  return pairs;
}

/**
 * A unified diff of two texts. Returns '' when they are identical.
 * @param {string} before
 * @param {string} after
 * @param {{context?: number, fromLabel?: string, toLabel?: string}} [options]
 * @returns {string}
 */
export function unifiedDiff(before, after, { context = 3, fromLabel = 'a', toLabel = 'b' } = {}) {
  if (before === after) return '';
  const a = before.split('\n');
  const b = after.split('\n');
  const matched = lcsPairs(a, b);

  // Walk both sides into a flat op list.
  const ops = [];
  let i = 0;
  let j = 0;
  for (const [ai, bj] of [...matched, [a.length, b.length]]) {
    while (i < ai) { ops.push({ kind: '-', text: a[i] }); i++; }
    while (j < bj) { ops.push({ kind: '+', text: b[j] }); j++; }
    if (ai < a.length) { ops.push({ kind: ' ', text: a[ai] }); i++; j++; }
  }

  // Group changed regions with `context` lines of surrounding agreement.
  const changed = ops.map((o) => o.kind !== ' ');
  const keep = new Array(ops.length).fill(false);
  ops.forEach((_, idx) => {
    if (!changed[idx]) return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep[k] = true;
  });

  const out = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  let aLine = 1;
  let bLine = 1;
  let idx = 0;
  while (idx < ops.length) {
    if (!keep[idx]) {
      if (ops[idx].kind !== '+') aLine++;
      if (ops[idx].kind !== '-') bLine++;
      idx++;
      continue;
    }
    const start = idx;
    const aStart = aLine;
    const bStart = bLine;
    let aCount = 0;
    let bCount = 0;
    const body = [];
    while (idx < ops.length && keep[idx]) {
      const op = ops[idx];
      body.push(`${op.kind}${op.text}`);
      if (op.kind !== '+') { aLine++; aCount++; }
      if (op.kind !== '-') { bLine++; bCount++; }
      idx++;
    }
    if (start === idx) break;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    out.push(...body);
  }
  return `${out.join('\n')}\n`;
}
