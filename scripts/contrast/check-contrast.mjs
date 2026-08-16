#!/usr/bin/env node
// Static WCAG contrast lint over the theme's colour schemes.
//
// WHY this exists: validate.yml had no accessibility check of any kind, so a
// colour scheme with failing contrast shipped silently. One did: the
// sss-dark-scheme accent sat at 3.86:1 against its background until a hand-run
// Lighthouse audit happened to catch it. A hand-run audit is not a gate.
//
// This is the STATIC half of the two-layer check. It reads config/settings_data.json
// directly, so it needs no network, no rendered page and no storefront password,
// and it runs inside the required `validate / validate` context on every PR. The
// dynamic half (pa11y-ci against the deployed preview theme, scripts/a11y/)
// catches what a colour-only check cannot: real DOM, real font sizes, real
// focus order.
//
// Deliberate exceptions go in accepted-risks.json with a note. Never weaken a
// threshold in lib/pairs.mjs to get a PR through; that removes the check for
// every scheme forever, where a baseline entry is scoped, dated and reviewable.
//
// Usage: node scripts/contrast/check-contrast.mjs
//   --json   emit machine-readable results instead of the report
// Exit 0 when clean, 1 on any failure.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadSchemes, schemaRoleIds } from './lib/settings.mjs';
import { checkCompleteness, PAIRS } from './lib/pairs.mjs';
import { evaluateAll } from './lib/evaluate.mjs';
import { adjudicate, validateRisks } from './lib/risks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

export const PATHS = {
  settingsData: join(REPO_ROOT, 'config', 'settings_data.json'),
  settingsSchema: join(REPO_ROOT, 'config', 'settings_schema.json'),
  acceptedRisks: join(HERE, 'accepted-risks.json'),
};

/**
 * Run the lint.
 * @param {{settingsData?: string, settingsSchema?: string, acceptedRisks?: string}} [paths]
 * @returns {{exitCode: number, lines: string[], results: object[]}}
 * @example
 *   run() // { exitCode: 0, lines: [...], results: [...] }
 */
export function run(paths = {}) {
  const p = { ...PATHS, ...paths };
  const lines = [];
  const say = (s) => lines.push(s);
  let failed = false;

  const schemes = loadSchemes(p.settingsData);

  // 1. Completeness. Every role the theme can write must be classified by the
  //    pairing map, or an unchecked colour ships. Union of what the schema
  //    declares and what the data actually contains: the schema is the source
  //    of truth for what the editor writes, but data can carry a role a schema
  //    edit has since dropped, and neither may go unclassified.
  const roles = new Set(schemaRoleIds(p.settingsSchema));
  for (const s of schemes) for (const role of Object.keys(s.settings)) roles.add(role);
  const { missing, unknown } = checkCompleteness([...roles]);
  if (missing.length) {
    failed = true;
    say(`FAIL: ${missing.length} colour role(s) are not covered by the pairing map:`);
    for (const role of missing) say(`  - ${role}`);
    say('  Add each to scripts/contrast/lib/pairs.mjs (as text, border or exempt).');
  }
  if (unknown.length) {
    failed = true;
    say(`FAIL: the pairing map references ${unknown.length} role(s) that no longer exist:`);
    for (const role of unknown) say(`  - ${role}`);
    say('  Remove each from scripts/contrast/lib/pairs.mjs; the map is overstating its coverage.');
  }

  // 2. Baseline shape. A malformed entry must not read as a granted exception.
  let risks = [];
  try {
    risks = JSON.parse(readFileSync(p.acceptedRisks, 'utf8'));
  } catch (err) {
    failed = true;
    say(`FAIL: could not read accepted-risks.json: ${err.message}`);
  }
  const riskProblems = validateRisks(risks);
  if (riskProblems.length) {
    failed = true;
    say(`FAIL: accepted-risks.json is malformed:`);
    for (const problem of riskProblems) say(`  - ${problem}`);
    risks = [];
  }

  // 3. Evaluate.
  const results = evaluateAll(schemes);
  const { failures, baselineProblems, stale, accepted } = adjudicate(results, risks);

  // 4. Fail-closed floor. If the scheme extraction ever returned nothing (a
  //    Shopify format change, a moved file, a refactor of loadSchemes), the run
  //    above would produce zero failures and exit green having checked nothing.
  //    A gate that passes on an empty input set is worse than no gate.
  if (schemes.length === 0 || results.length === 0) {
    failed = true;
    say('FAIL: scanned 0 scheme(s), 0 pair(s). settings_data.json parsed but yielded no colour schemes.');
  }

  if (failures.length) {
    failed = true;
    say(`FAIL: ${failures.length} contrast failure(s):`);
    for (const f of failures) {
      const detail = f.error ? f.error : `${f.ratio}:1, needs ${f.threshold}:1 (${f.kind})`;
      say(`  - ${f.source} / ${f.scheme} / ${f.pair}: ${detail}`);
    }
    say('  Fix the colour in config/settings_data.json, or record a deliberate');
    say('  exception in scripts/contrast/accepted-risks.json with a note.');
  }

  if (baselineProblems.length) {
    failed = true;
    say(`FAIL: ${baselineProblems.length} problem(s) in accepted-risks.json:`);
    for (const b of baselineProblems) {
      say(`  - ${b.risk.source} / ${b.risk.scheme} / ${b.risk.pair}: ${b.reason}`);
    }
  }

  for (const s of stale) {
    say(`WARN: stale exception, ${s.risk.source} / ${s.risk.scheme} / ${s.risk.pair} now passes at ${s.ratio}:1. Delete the entry from accepted-risks.json.`);
  }

  // Overlay schemes are reported, not hidden. Static colour maths cannot reach
  // them (see isOverlayScheme); pa11y-ci against the preview theme does.
  const overlays = [...new Set(results.filter((r) => r.indeterminate).map((r) => `${r.source} / ${r.scheme}`))];
  const indeterminate = results.filter((r) => r.indeterminate).length;
  for (const overlay of overlays) {
    say(`INFO: ${overlay} has a fully transparent background (overlay scheme); its pairs are indeterminate here and are covered by the pa11y-ci layer instead.`);
  }

  say(
    `contrast lint: scanned ${schemes.length} scheme(s), ${results.length} pair(s) ` +
      `(${PAIRS.length} per scheme); ${failures.length} failure(s), ${accepted} accepted, ` +
      `${stale.length} stale, ${indeterminate} indeterminate.`
  );

  return { exitCode: failed ? 1 : 0, lines, results };
}

function main() {
  const json = process.argv.includes('--json');
  const { exitCode, lines, results } = run();
  if (json) {
    process.stdout.write(`${JSON.stringify({ exitCode, results }, null, 2)}\n`);
  } else {
    for (const line of lines) process.stdout.write(`${line}\n`);
  }
  // `process.exitCode`, never `process.exit()`. The latter tears the process
  // down before a piped stdout has flushed, which truncated `--json` output at
  // 64KB (one pipe buffer) and produced unparseable JSON for any consumer.
  process.exitCode = exitCode;
}

// pathToFileURL rather than a `file://` template: import.meta.url percent-encodes
// spaces and non-ASCII characters, so a hand-built string fails to match on such
// a checkout path and main() would never run. Guard the argv[1] dereference so
// the module stays importable from the test suite.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
