// The working draft the naming gate builds, and the merge that turns it into the committed
// registry. Pure: no fs, no git, no sharp. draft.mjs owns those.
//
// The draft exists because 18 confirmed operator decisions survived a session boundary only via a
// hand-written ledger and two hand-written handoff prompts, and the registry was hand-authored
// twice. It is the DECISIONS; grouping-ledger.md is human-readable notes with no authority, and
// `audit.mjs --local` is a step pointer, not a record. On disagreement the draft wins.
//
// Two rules here are structural rather than stylistic:
//
//   1. Unknown keys are REJECTED. No free-text field may appear in a file the model reads, because
//      photo content, filenames, ledger notes, and draft values are all data, never instructions.
//   2. Keys are the hero filename stem, never an ordinal. Patterns get merged, split, and re-sorted
//      mid-gate, and after that "13C" designates a different pattern than when the operator typed
//      it, with nothing detecting the shift.

import { createHash } from 'node:crypto';
import { charsetProblem, nameColorProblem } from './naming.mjs';
import { deriveId, validate } from './registry.mjs';

/** The six naming angles the gate offers, as columns A through F. `n/a` is a legal cell. */
export const CANDIDATE_ANGLES = Object.freeze([
  { letter: 'A', key: 'descriptive', label: 'Descriptive', hint: 'what it literally shows (Scattered Paws)' },
  { letter: 'B', key: 'evocative', label: 'Evocative', hint: 'mood (Midnight Rose)' },
  { letter: 'C', key: 'playful', label: 'Playful', hint: 'a joke or a wink (Busy Bees)' },
  { letter: 'D', key: 'trade', label: 'Trade or botanical', hint: 'the technical or species name (Echeveria)' },
  { letter: 'E', key: 'vintage', label: 'Vintage', hint: 'heritage or period register (Cottage Garden)' },
  { letter: 'F', key: 'modern', label: 'Modern', hint: 'one or two words, minimal (Clover Field)' },
]);

export const DRAFT_KEYS = Object.freeze(['version', 'threads', 'patterns', 'tableDigest']);
export const DRAFT_PATTERN_KEYS = Object.freeze([
  'id', 'name', 'thread', 'status', 'sources', 'hero', 'crop', 'position', 'candidates',
]);
const CROP_KEYS = Object.freeze(['left', 'top', 'width', 'height']);
const CANDIDATE_KEYS = Object.freeze(CANDIDATE_ANGLES.map((a) => a.key));

/** @returns {object} an empty draft, valid to write and validate against */
export function emptyDraft() {
  return { version: 1, threads: [], patterns: [] };
}

/** The stable row key for a pattern: its hero photo's filename stem. */
export function keyFor(hero) {
  return String(hero ?? '').replace(/\.[^.]+$/, '');
}

function unknown(obj, allowed, label, push) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) push(`${label}: unknown key ${JSON.stringify(k)} (allowed: ${allowed.join(', ')})`);
  }
}

/**
 * Structural problems with a draft, as human-readable strings. Empty array = structurally usable
 * (which is NOT the same as "assembles into a valid registry"; see candidateRegistry).
 * @param {object} draft
 * @returns {string[]}
 */
export function draftProblems(draft) {
  const problems = [];
  const push = (m) => problems.push(m);
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return ['draft is not an object'];
  unknown(draft, DRAFT_KEYS, 'draft', push);
  if (draft.version !== 1) push(`draft.version must be 1, got ${JSON.stringify(draft.version)}`);
  if (!Array.isArray(draft.threads)) push('draft.threads must be an array');
  if (!Array.isArray(draft.patterns)) {
    push('draft.patterns must be an array');
    return problems;
  }
  const keys = new Set();
  draft.patterns.forEach((p, i) => {
    const label = `patterns[${i}]${p?.hero ? ` (${keyFor(p.hero)})` : ''}`;
    if (!p || typeof p !== 'object') { push(`${label} is not an object`); return; }
    unknown(p, DRAFT_PATTERN_KEYS, label, push);
    unknown(p.crop, CROP_KEYS, `${label}: crop`, push);
    unknown(p.candidates, CANDIDATE_KEYS, `${label}: candidates`, push);
    if (typeof p.hero !== 'string' || !p.hero) { push(`${label}: hero is required (it is the row key)`); return; }
    const key = keyFor(p.hero);
    if (keys.has(key)) push(`${label}: duplicate row key "${key}"; two patterns cannot share a hero`);
    else keys.add(key);
  });
  return problems;
}

/**
 * Assemble the registry this draft WOULD produce, merged onto an existing one. `published`,
 * `chart`, and `product` are publish-owned or gate-owned and are copied through untouched: a
 * whole-file write from a draft with no concept of `published` would drop the chart media GIDs and
 * spec hashes, and the next publish would re-create chart media with nothing to reconcile against.
 * @param {object} draft
 * @param {object} existing - the current committed registry
 * @returns {object}
 */
export function candidateRegistry(draft, existing) {
  return {
    ...existing,
    threads: [...(draft.threads ?? [])],
    patterns: (draft.patterns ?? []).map((p) => ({
      id: p.id ?? deriveId(p.name ?? ''),
      name: p.name ?? '',
      thread: p.thread ?? '',
      status: p.status ?? 'active',
      sources: [...(p.sources ?? [])],
      hero: p.hero,
      crop: { ...(p.crop ?? {}) },
      position: p.position,
    })),
  };
}

/**
 * Every reason this draft would not produce a valid registry: structural draft problems first,
 * then the REAL registry validator's problems against the assembled candidate.
 * @param {object} draft
 * @param {object} existing
 * @returns {string[]}
 */
export function validationProblems(draft, existing) {
  const structural = draftProblems(draft);
  if (structural.length) return structural;
  const missingNames = (draft.patterns ?? [])
    .filter((p) => !p.name)
    .map((p) => `${keyFor(p.hero)}: no name chosen yet (pick a candidate at the gate)`);
  return [...missingNames, ...validate(candidateRegistry(draft, existing))];
}

/**
 * Distinct threads with usage counts, most used first, singletons marked. Near-duplicate detection
 * has to be MECHANICAL: asking the model that produced both "Navy" and "Dark Blue" to notice they
 * collide is not a control. This prints the list; the assistant proposes consolidation from it.
 * @param {object} draft
 * @returns {Array<{thread: string, count: number, singleton: boolean, declared: boolean}>}
 */
export function threadUsage(draft) {
  const counts = new Map();
  for (const t of draft.threads ?? []) counts.set(t, 0);
  for (const p of draft.patterns ?? []) {
    if (!p.thread) continue;
    counts.set(p.thread, (counts.get(p.thread) ?? 0) + 1);
  }
  const declared = new Set(draft.threads ?? []);
  return [...counts.entries()]
    .map(([thread, count]) => ({ thread, count, singleton: count === 1, declared: declared.has(thread) }))
    .sort((a, b) => b.count - a.count || a.thread.localeCompare(b.thread));
}

/**
 * The rows the gate table renders, in draft order.
 * @param {object} draft
 * @returns {Array<object>}
 */
export function tableRows(draft) {
  return (draft.patterns ?? []).map((p) => ({
    key: keyFor(p.hero),
    hero: p.hero,
    name: p.name ?? null,
    thread: p.thread ?? null,
    sources: [...(p.sources ?? [])],
    crop: p.crop ?? null,
    position: p.position ?? null,
    candidates: CANDIDATE_ANGLES.map((a) => p.candidates?.[a.key] || 'n/a'),
  }));
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

/**
 * The content digest of exactly the subset `--table` renders: the row keys, their candidates, and
 * the thread palette. This is what keeps "an approval applies only to the immediately preceding
 * artifact" true once the artifact is a file: `--write` recomputes it and refuses on mismatch.
 *
 * Choosing a name from a candidate does NOT move the digest, because the name is not part of the
 * rendered choice surface. Editing a candidate, adding a row, removing one, or reordering the
 * palette does.
 * @param {object} draft
 * @returns {{digest: string, rows: Record<string, string>}}
 */
export function tableDigest(draft) {
  const rows = {};
  for (const r of tableRows(draft)) {
    rows[r.key] = sha(JSON.stringify([r.key, r.candidates])).slice(0, 16);
  }
  const digest = sha(JSON.stringify([draft.threads ?? [], Object.entries(rows)])).slice(0, 16);
  return { digest, rows };
}

/**
 * Which rows moved since the digest `--table` stamped, as human-readable strings. Empty array
 * means the approval still applies to this draft.
 * @param {object} draft
 * @returns {string[]}
 */
export function digestProblems(draft) {
  const stamped = draft.tableDigest;
  if (!stamped || typeof stamped !== 'object') {
    return ['no gate-table digest on this draft; run draft.mjs --table and re-present the gate before writing'];
  }
  const now = tableDigest(draft);
  if (now.digest === stamped.digest) return [];
  const problems = [];
  const keys = new Set([...Object.keys(stamped.rows ?? {}), ...Object.keys(now.rows)]);
  for (const k of [...keys].sort()) {
    const was = stamped.rows?.[k];
    const is = now.rows[k];
    if (was === is) continue;
    if (!was) problems.push(`row "${k}" was added after the gate table was presented`);
    else if (!is) problems.push(`row "${k}" was removed after the gate table was presented`);
    else problems.push(`row "${k}" changed after the gate table was presented`);
  }
  if (!problems.length) problems.push('the thread palette changed after the gate table was presented');
  return problems.map((p) => `${p}; re-run --table and re-present the gate`);
}

/**
 * Guard problems for one candidate name, or null. Wraps the same rules registry validation
 * applies, INCLUDING the label ceiling, so an approved name cannot fail validation afterwards and
 * re-open the most expensive gate in the pipeline.
 * @param {string} value
 * @param {string[]} colorValues
 * @param {number | null} [ceiling] - max name length at this chart's density
 * @returns {string | null}
 */
export function candidateProblem(value, colorValues, ceiling = null) {
  if (!value || value === 'n/a') return null;
  const basic = charsetProblem(value, 'name') ?? nameColorProblem(value, colorValues);
  if (basic) return basic;
  if (ceiling !== null && value.length > ceiling) {
    return `name "${value}" is ${value.length} characters; this chart density carries at most ${ceiling}`;
  }
  return null;
}

const pad = (s, n) => String(s).padEnd(n);

/**
 * The NARROW inline table: the choice surface and nothing else. The wide table lives in
 * gate-table.md, because a table carrying thread, hero, sources, crop, and clearance truncated in
 * the operator's terminal and cost three round trips at the most expensive gate in the pipeline.
 * @param {Array<object>} rows
 * @returns {string}
 */
/**
 * Make a value safe to sit in a markdown table cell.
 *
 * Filenames reach these tables, and `|` is a legal filename character on macOS and Linux. An
 * unescaped one splits the row and can forge a plausible extra line in the artifact the operator
 * approves from and the model later re-reads, which is an injection surface in the one place this
 * pipeline treats as authoritative. Newlines and tabs get the same treatment for the same reason.
 * @param {unknown} value
 * @returns {string}
 */
export function cell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n\t]+/g, ' ');
}

export function narrowTable(rows) {
  const safe = rows.map((r) => ({ key: cell(r.key), candidates: r.candidates.map(cell) }));
  const widths = [
    Math.max(3, ...safe.map((r) => r.key.length)),
    ...CANDIDATE_ANGLES.map((_, i) => Math.max(1, ...safe.map((r) => r.candidates[i].length))),
  ];
  const line = (cells) => `| ${cells.map((c, i) => pad(c, widths[i])).join(' | ')} |`;
  return [
    line(['Key', ...CANDIDATE_ANGLES.map((a) => a.letter)]),
    `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`,
    ...safe.map((r) => line([r.key, ...r.candidates])),
  ].join('\n');
}

/**
 * The full detail table written to gate-table.md: the VERIFICATION surface. Everything the
 * operator may want to check, none of which is the choice itself.
 * @param {object} input
 * @param {Array<object>} input.rows
 * @param {object} input.draft
 * @param {string[]} input.colorValues
 * @param {Record<string, {minSd: number, tile: number, edge: string, suspect: boolean} | null>}
 *   [input.clearance] - keyed by row key; null or absent renders as n/a
 * @param {string} [input.ledgerName]
 * @param {number | null} [input.nameCeiling]
 * @returns {string}
 */
export function detailTable({
  rows, draft, colorValues, clearance = {}, ledgerName = 'grouping-ledger.md', nameCeiling = null,
}) {
  const digest = tableDigest(draft);
  const out = [];
  out.push('# Applique naming gate: detail');
  out.push('');
  out.push(`Digest: \`${digest.digest}\`. This file is the VERIFICATION surface; the narrow table in`);
  out.push('the message is the choice surface. A letter approves the NAME for that row and nothing');
  out.push('else: thread, hero, crop, and sources are not covered by it.');
  out.push('');
  out.push(`Per-photo notes, rationale, and any third-party text observed on the fabric: \`${ledgerName}\`.`);
  out.push('');
  out.push('| Key | Chosen | Thread | Hero | Sources | Crop (l, t, size) | Edge clearance (min tile sd; <10 = inspect) | Guard |');
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    const c = clearance[r.key];
    const clear = c ? `${c.minSd.toFixed(1)} (tile ${c.tile}, ${c.edge})${c.suspect ? ' SUSPECT' : ''}` : 'n/a';
    const crop = r.crop ? `${r.crop.left}, ${r.crop.top}, ${r.crop.width}` : 'manual crop required';
    const guards = r.candidates
      .map((v, i) => [CANDIDATE_ANGLES[i].letter, candidateProblem(v, colorValues, nameCeiling)])
      .filter(([, p]) => p)
      .map(([letter, p]) => `${letter}: ${p}`);
    out.push(`| ${cell(r.key)} | ${cell(r.name ?? '(not chosen)')} | ${cell(r.thread ?? '(none)')} `
      + `| ${cell(r.hero)} | ${cell(r.sources.join(', '))} | ${cell(crop)} | ${cell(clear)} `
      + `| ${guards.length ? cell(guards.join('; ')) : 'ok'} |`);
  }
  out.push('');
  out.push('## Naming angles');
  out.push('');
  for (const a of CANDIDATE_ANGLES) out.push(`- **${a.letter}. ${a.label}**: ${a.hint}`);
  out.push('');
  out.push('## Threads in use');
  out.push('');
  for (const t of threadUsage(draft)) {
    out.push(`- ${t.thread}: ${t.count}${t.singleton ? ' (singleton)' : ''}${t.declared ? '' : ' (not in the declared palette)'}`);
  }
  out.push('');
  return `${out.join('\n')}\n`;
}
