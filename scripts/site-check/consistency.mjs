#!/usr/bin/env node
// Tier A3 orchestrator: reads the theme files consistency checks need, runs lib/repo-checks.mjs
// over them, diffs against the last saved run and prints the report. Side effects: none on the
// store; one JSON run file under the state dir unless --no-save.
//
//   node scripts/site-check/consistency.mjs [--root <dir>] [--full] [--no-save] [--strict] [--public] [--json]
//
// --root     theme root (default: this repo). With --root the catalogue is read from <root>/catalogue.json.
// --full     also print unchanged findings and accepted risks
// --no-save  do not write a run file
// --strict   exit 1 on any unaccepted ERROR, not only ones new since the baseline
// --public   baseline key PUBLIC (store password removed) instead of LOCKED
// --json     print the findings array as JSON after the report (the skill parses it)

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { readCommittedCatalogue, loadCatalogue } from '../lib/catalogue-manifest.mjs';
import { runRepoChecks, parseShopifyJson, effectiveSettings, schemaDefaults } from './lib/repo-checks.mjs';
import { createStore, diffFindings, partitionAccepted, exitCodeFor } from './lib/state.mjs';
import { createRedactor } from './lib/redact.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const MODE = 'consistency';

function parseArgs(argv) {
  const opts = { root: null, full: false, noSave: false, strict: false, public: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--root') { opts.root = argv[i + 1]; i += 1; }
    else if (a === '--full') opts.full = true;
    else if (a === '--no-save') opts.noSave = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--public') opts.public = true;
    else if (a === '--json') opts.json = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

/** The fixed file set the checks read; a missing file is left out of the Map and the check skips. */
const FIXED_FILES = [
  'sections/header-group.json',
  'config/settings_data.json',
  'config/settings_schema.json',
  'locales/en.default.json',
  'locales/it.json',
  'locales/ro.json',
  'snippets/social-links.liquid',
  'snippets/structured-data-organization.liquid',
  'blocks/_vacation-announcement.liquid',
  'sections/faq.liquid',
];

function readThemeFiles(root) {
  const files = new Map();
  const put = (rel) => {
    try { files.set(rel, readFileSync(join(root, rel), 'utf8')); } catch { /* absent: the check skips */ }
  };
  for (const rel of FIXED_FILES) put(rel);
  let templates = [];
  try { templates = readdirSync(join(root, 'templates')); } catch { /* no templates dir */ }
  for (const name of templates.filter((n) => n.endsWith('.json')).sort()) put(`templates/${name}`);
  return files;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const redact = createRedactor([]);
  const log = (line = '') => process.stdout.write(`${redact(line)}\n`);
  const root = opts.root ? resolve(opts.root) : REPO_ROOT;
  const lockState = opts.public ? 'PUBLIC' : 'LOCKED';

  const catalogue = opts.root
    ? await loadCatalogue({ read: (p) => readFile(join(root, p), 'utf8'), path: 'catalogue.json' })
    : readCommittedCatalogue();
  const files = readThemeFiles(root);
  const schemaJson = files.has('config/settings_schema.json') ? parseShopifyJson(files.get('config/settings_schema.json')) : [];
  const dataJson = files.has('config/settings_data.json') ? parseShopifyJson(files.get('config/settings_data.json')) : {};
  const settings = effectiveSettings(schemaJson, dataJson);

  const findings = runRepoChecks({ files, catalogue, settings, schemaDefaults: schemaDefaults(schemaJson) });

  let acceptedRisks = [];
  try { acceptedRisks = JSON.parse(readFileSync(join(HERE, 'accepted-risks.json'), 'utf8')); } catch { acceptedRisks = []; }
  const { fresh, accepted } = partitionAccepted(findings, acceptedRisks);

  const io = {
    readdir: (d) => readdir(d),
    readFile: (p) => readFile(p, 'utf8'),
    writeFile: (p, text) => writeFile(p, text),
    mkdir: (d) => mkdir(d, { recursive: true }),
  };
  const dir = process.env.SITE_CHECK_STATE_DIR || join(homedir(), '.local', 'state', 'site-check');
  const store = createStore({ io, dir });
  const previous = await store.loadLatest(MODE, lockState);
  const { added, resolved, unchanged, skipped } = diffFindings(previous ? previous.findings : null, fresh);

  log('');
  log(`== site-check ${MODE} (${lockState}): ${fresh.length} finding(s), ${accepted.length} accepted risk(s) ==`);
  log(`root: ${root}; files read: ${files.size}; catalogue products: ${catalogue.products.size}`);
  if (previous) log(`baseline: ${previous.generated} (${added.length} new, ${resolved.length} resolved, ${skipped.length} skipped, ${unchanged.length} unchanged)`);
  else log('baseline: none (first run; all findings are new)');

  const printList = (label, list) => {
    if (!list.length) return;
    log('');
    log(`${label}:`);
    for (const f of list) {
      log(`  [${f.severity}] ${f.check} ${f.subject}`);
      log(`      ${f.message}${f.evidence ? `\n      evidence: ${f.evidence}` : ''}`);
    }
  };
  printList('NEW since baseline', added);
  printList('RESOLVED since baseline', resolved);
  printList('SKIPPED this run (present in baseline, check did not run)', skipped);
  const currentSkips = fresh.filter((f) => f.severity === 'SKIPPED');
  printList('SKIPPED checks', currentSkips);
  if (opts.full) {
    printList('UNCHANGED (still present)', unchanged);
    if (accepted.length) {
      log('');
      log('ACCEPTED RISKS (known, deliberate):');
      for (const f of accepted) log(`  [${f.severity}] ${f.check} ${f.subject}\n      ${f.message}\n      accepted ${f.accepted_on}: ${f.note}`);
    }
  } else {
    if (unchanged.length) log(`\n(${unchanged.length} unchanged finding(s) suppressed; run with --full to see them)`);
    if (accepted.length) log(`(${accepted.length} accepted risk(s) suppressed; run with --full to see them)`);
  }

  if (!opts.noSave) {
    const path = await store.save(MODE, lockState, fresh, { root: opts.root ? 'custom' : 'repo', files: files.size });
    log('');
    log(`saved run -> ${path}`);
  }

  const code = exitCodeFor({ fresh, added, hasBaseline: Boolean(previous), strict: opts.strict });
  log(`exit ${code} (${opts.strict ? 'blocks on any unaccepted ERROR' : 'blocks only on ERROR findings new since the baseline'})`);
  if (opts.json) log(JSON.stringify(fresh, null, 2));
  process.exitCode = code;
}

main().catch((err) => {
  process.stderr.write(`${createRedactor([])(err && err.stack ? err.stack : String(err))}\n`);
  process.exitCode = 2;
});
