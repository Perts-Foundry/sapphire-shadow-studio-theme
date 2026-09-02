// Baseline state for site-check runs, keyed by (mode, lockState). Lifted from
// scripts/seo-review/lib/{baseline,checks,report}.mjs rather than imported: that module's finding
// shape is {check,url,detail}, its state dir comes from process.env, and its differ has no notion
// of SKIPPED. This one is pure over an injected `io` and `now`, so tests run it over a temp dir
// with a fixed clock and the lib rule (no fs, no env, no fetch) holds.
//
// Diff rule that differs from seo-review: a previous finding absent from the current run because
// its check was SKIPPED this run is reported as SKIPPED, never RESOLVED.

import { ERROR, SKIPPED, GATE, tierOf as registryTierOf, checksForSurface } from './registry.mjs';

export const LOCK_STATES = ['LOCKED', 'PUBLIC'];

/** Filename for a run: <mode>-<lock>-<stamp>.json (stamp from the injected clock). */
export function runFileName(mode, lockState, now) {
  if (!LOCK_STATES.includes(lockState)) throw new Error(`lockState must be LOCKED or PUBLIC, got ${lockState}`);
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  return `${mode}-${lockState}-${stamp}.json`;
}

/** The newest matching run filename among directory entries, or null. */
export function latestRunName(entries, mode, lockState) {
  const prefix = `${mode}-${lockState}-`;
  const runs = (entries || []).filter((e) => e.startsWith(prefix) && e.endsWith('.json')).sort();
  return runs.length ? runs[runs.length - 1] : null;
}

/**
 * Split findings into { fresh, accepted } against accepted-risks entries. An entry matches on
 * `check` and, when it names one, `subject`. Entries carry a note and a date; never order
 * numbers, emails or addresses (README says so; the contract test greps for them).
 */
export function partitionAccepted(findings, accepted) {
  const fresh = [];
  const acceptedOut = [];
  for (const f of findings) {
    const hit = (accepted || []).find((a) => a.check === f.check && (!a.subject || a.subject === f.subject));
    if (hit) acceptedOut.push({ ...f, note: hit.note, accepted_on: hit.accepted_on });
    else fresh.push(f);
  }
  return { fresh, accepted: acceptedOut };
}

/**
 * Diff by finding id. Previous findings missing from `current` are RESOLVED unless the current
 * run skipped their check (a SKIPPED finding whose `check` equals theirs, or whose subject is
 * `tier:<their tier>` or `surface:<their surface>`), in which case they are SKIPPED.
 * @returns {{added:Array, resolved:Array, unchanged:Array, skipped:Array}}
 */
export function diffFindings(previous, current, tierOf = registryTierOf) {
  const prev = previous || [];
  const curIds = new Set(current.map((f) => f.id));
  const prevIds = new Set(prev.map((f) => f.id));
  const skippedChecks = new Set();
  const skippedTiers = new Set();
  for (const f of current) {
    if (f.severity !== SKIPPED) continue;
    skippedChecks.add(f.check);
    const m = /^tier:([A-Z0-9]+)$/.exec(f.subject);
    if (m) skippedTiers.add(m[1]);
    const sm = /^surface:([a-z0-9-]+)$/.exec(f.subject);
    if (sm) for (const c of checksForSurface(sm[1])) skippedChecks.add(c.id);
  }
  const wasSkipped = (f) => skippedChecks.has(f.check) || skippedTiers.has(tierOf(f.check));
  const missing = prev.filter((f) => !curIds.has(f.id));
  return {
    added: current.filter((f) => !prevIds.has(f.id) && f.severity !== SKIPPED),
    resolved: missing.filter((f) => !wasSkipped(f)),
    unchanged: current.filter((f) => prevIds.has(f.id) && f.severity !== SKIPPED),
    skipped: missing.filter(wasSkipped),
  };
}

/**
 * Exit code policy. Default: non-zero on new ERRORs (first run: any ERROR). --strict: non-zero
 * on any unaccepted ERROR. GATE never blocks (inconclusive), SKIPPED never blocks.
 */
export function exitCodeFor({ fresh, added, hasBaseline, strict = false }) {
  const pool = strict ? fresh : (hasBaseline ? added : fresh);
  return pool.some((f) => f.severity === ERROR) ? 1 : 0;
}

export function isInconclusive(f) { return f.severity === GATE || f.severity === SKIPPED; }

/**
 * A store over an injected io: { readdir(dir), readFile(path), writeFile(path, text), mkdir(dir) }.
 * All async, all throwing on failure; `loadLatest` swallows a missing dir or a corrupt file.
 */
export function createStore({ io, dir, now = () => Date.now() }) {
  if (!io || !dir) throw new Error('createStore needs io and dir');
  return {
    dir,
    async loadLatest(mode, lockState) {
      let entries;
      try { entries = await io.readdir(dir); } catch { return null; }
      const name = latestRunName(entries, mode, lockState);
      if (!name) return null;
      try {
        const data = JSON.parse(await io.readFile(`${dir}/${name}`));
        return { path: `${dir}/${name}`, findings: data.findings || [], generated: data.generated, meta: data.meta || {} };
      } catch { return null; }
    },
    async save(mode, lockState, findings, meta = {}) {
      await io.mkdir(dir);
      const name = runFileName(mode, lockState, now);
      const path = `${dir}/${name}`;
      const generated = new Date(now()).toISOString();
      await io.writeFile(path, JSON.stringify({ mode, lockState, generated, meta, findings }, null, 2));
      return path;
    },
  };
}
