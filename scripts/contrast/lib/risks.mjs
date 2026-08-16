// risks.mjs -- apply accepted-risks.json to a set of results.
//
// The baseline exists so a deliberate exception can be recorded and reviewed
// rather than worked around by weakening a threshold. It follows the pattern of
// scripts/seo-review/accepted-risks.json: a flat array, one object per accepted
// finding, each carrying a mandatory human note and the date it was accepted.
//
// Two rules keep the file from rotting into a rubber stamp:
//
//   RATCHET. Each entry records the ratio measured when it was accepted. If the
//   pair later scores BELOW that, the exception no longer describes reality and
//   the lint fails. Accepting "this border is at 2.1:1" must not also accept a
//   later change taking it to 1.2:1.
//
//   SELF-CLEARING. When a baselined pair reaches its threshold, the entry is
//   reported as stale so it gets deleted. Without this the file only ever grows
//   and eventually hides a regression behind an entry nobody remembers.

/**
 * @typedef {object} AcceptedRisk
 * @property {string} source  matches Result.source
 * @property {string} scheme  matches Result.scheme
 * @property {string} pair    matches Result.pair
 * @property {number} ratio   the ratio measured when the risk was accepted
 * @property {string} note    why this is acceptable; mandatory
 * @property {string} accepted_on  ISO date
 */

const KEY_FIELDS = ['source', 'scheme', 'pair'];
const keyOf = (o) => KEY_FIELDS.map((f) => o[f]).join(' :: ');

/**
 * Validate the shape of the baseline file. Malformed entries are a hard error:
 * a typo'd scheme name would otherwise mean an entry that matches nothing,
 * looking like a granted exception while silently doing nothing.
 * @param {unknown} raw parsed accepted-risks.json
 * @returns {string[]} problem descriptions; empty when valid
 * @example
 *   validateRisks([{ source: 'current', scheme: 's', pair: 'p', ratio: 2, note: 'x', accepted_on: '2026-01-01' }]) // []
 */
export function validateRisks(raw) {
  const problems = [];
  if (!Array.isArray(raw)) return ['accepted-risks.json must contain a JSON array'];

  const seen = new Set();
  raw.forEach((entry, i) => {
    const at = `entry ${i}`;
    if (!entry || typeof entry !== 'object') { problems.push(`${at}: not an object`); return; }
    for (const field of KEY_FIELDS) {
      if (typeof entry[field] !== 'string' || !entry[field]) problems.push(`${at}: '${field}' must be a non-empty string`);
    }
    if (typeof entry.ratio !== 'number' || !Number.isFinite(entry.ratio)) problems.push(`${at}: 'ratio' must be a number`);
    if (typeof entry.note !== 'string' || entry.note.trim().length < 10) {
      problems.push(`${at}: 'note' must explain why the exception is acceptable`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.accepted_on || '')) problems.push(`${at}: 'accepted_on' must be YYYY-MM-DD`);
    const key = keyOf(entry);
    if (seen.has(key)) problems.push(`${at}: duplicate entry for ${key}`);
    seen.add(key);
  });
  return problems;
}

/**
 * @typedef {object} Adjudication
 * @property {import('./evaluate.mjs').Result[]} failures  unaccepted failures
 * @property {Array<{risk: AcceptedRisk, result: object, reason: string}>} baselineProblems
 *   accepted entries whose ratio has drifted below what was recorded, plus
 *   entries that match no pair at all. Both fail the lint.
 * @property {Array<{risk: AcceptedRisk, ratio: number}>} stale
 *   accepted entries that now meet their threshold. Warning only.
 * @property {number} accepted  count of failures suppressed by the baseline
 */

/**
 * Split results into real failures, baseline problems and stale entries.
 * @param {import('./evaluate.mjs').Result[]} results
 * @param {AcceptedRisk[]} risks
 * @returns {Adjudication}
 * @example
 *   adjudicate(evaluateAll(schemes), risks)
 */
export function adjudicate(results, risks) {
  const byKey = new Map(results.map((r) => [keyOf(r), r]));
  const riskByKey = new Map(risks.map((r) => [keyOf(r), r]));

  const failures = [];
  const baselineProblems = [];
  const stale = [];
  let accepted = 0;

  for (const risk of risks) {
    if (!byKey.has(keyOf(risk))) {
      baselineProblems.push({
        risk,
        result: null,
        reason: 'matches no checked pair (renamed scheme, or a typo in source/scheme/pair)',
      });
    }
  }

  for (const result of results) {
    // Overlay schemes are neither pass nor fail (see isOverlayScheme); they are
    // out of this layer's reach entirely, so they can be neither baselined nor
    // reported stale.
    if (result.indeterminate) continue;
    const risk = riskByKey.get(keyOf(result));
    if (result.pass) {
      if (risk) stale.push({ risk, ratio: result.ratio });
      continue;
    }
    if (!risk) { failures.push(result); continue; }
    if (result.ratio < risk.ratio) {
      baselineProblems.push({
        risk,
        result,
        reason: `ratio regressed to ${result.ratio}:1, below the accepted ${risk.ratio}:1`,
      });
      continue;
    }
    accepted += 1;
  }

  return { failures, baselineProblems, stale, accepted };
}
