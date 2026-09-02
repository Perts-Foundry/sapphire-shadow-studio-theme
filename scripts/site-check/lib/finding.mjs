// The finding contract. Every finding any tier emits goes through makeFinding so the shape,
// the id rule and the evidence hygiene hold everywhere:
//
//   { id, check, severity, subject, message, evidence }
//
// `id` = `<check>:<subject>`. The subject is a STABLE identifier (handle, template path, variant
// id, URL path, scope name), never a token, line-item key, timestamp, count or price, so two runs
// over the same state produce identical ids and the baseline differ can match them.
// `evidence` is an extracted field, truncated to 200 chars with control characters stripped;
// never a raw body or header.

import { checkById, SEVERITIES, TIERS, isSurfaceId } from './registry.mjs';

export const EVIDENCE_MAX = 200;

/** Strip control characters (keeps printable ASCII and everything above 0x7f) and truncate. */
export function cleanEvidence(value) {
  if (value === undefined || value === null) return '';
  // eslint-disable-next-line no-control-regex
  const cleaned = String(value).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > EVIDENCE_MAX ? `${cleaned.slice(0, EVIDENCE_MAX - 3)}...` : cleaned;
}

/** Subject rule: no whitespace, bounded, never a timestamp. Throws on a subject that looks volatile. */
export function assertSubject(subject) {
  const s = String(subject);
  if (!s || s.length > 200) throw new Error(`finding subject must be 1..200 chars, got ${s.length}`);
  if (/\s/.test(s)) throw new Error(`finding subject must not contain whitespace: ${JSON.stringify(s)}`);
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) throw new Error(`finding subject must not be a timestamp: ${s}`);
  return s;
}

/**
 * @param {object} o
 * @param {string} o.check      registered check id
 * @param {string} o.subject    stable subject (see header)
 * @param {string} o.message    human sentence, no secrets
 * @param {string} [o.evidence] extracted field; cleaned and truncated here
 * @param {string} [o.severity] override of the registry default (e.g. INFO for a coverage count)
 * @returns {{id:string, check:string, severity:string, subject:string, message:string, evidence:string}}
 */
export function makeFinding({ check, subject, message, evidence = '', severity }) {
  const reg = checkById(check);
  if (!reg) throw new Error(`unregistered check id ${JSON.stringify(check)}; add it to lib/registry/<tier>.mjs`);
  const sev = severity ?? reg.severity;
  if (!SEVERITIES.includes(sev)) throw new Error(`unknown severity ${sev} on ${check}`);
  const subj = assertSubject(subject);
  return {
    id: `${check}:${subj}`,
    check,
    severity: sev,
    subject: subj,
    message: cleanEvidence(message),
    evidence: cleanEvidence(evidence),
  };
}

/**
 * Skip subjects the differ understands. A plain subject skips that check id for every subject;
 * `tier:<id>` skips every check in the tier; `surface:<id>` skips every check on the surface.
 * Built here rather than typed by hand so an entry script cannot spell one the differ misses.
 */
export function tierSkipSubject(tier) {
  if (!TIERS.some((t) => t.id === tier)) throw new Error(`unknown tier ${JSON.stringify(tier)}`);
  return `tier:${tier}`;
}
export function surfaceSkipSubject(surface) {
  if (!isSurfaceId(surface)) throw new Error(`unknown surface ${JSON.stringify(surface)}`);
  return `surface:${surface}`;
}

/** A SKIPPED finding for a check (or a whole tier or surface via the helpers above), with the reason. */
export function skipFinding(check, subject, reason) {
  return makeFinding({ check, subject, message: reason, severity: 'SKIPPED' });
}

/** Sort key: severity order then id, so output is deterministic. */
const SEV_RANK = { ERROR: 0, GATE: 1, WARN: 2, INFO: 3, SKIPPED: 4 };
export function sortFindings(findings) {
  return [...findings].sort((a, b) =>
    (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
