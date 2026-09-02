#!/usr/bin/env node
//
// runfile.mjs -- write or read the Tier C operator run file.
//
// The skill never composes ad hoc code for this: `--write` renders the checklist from the registry
// into the state dir (never inside the checkout) and prints its path and item count; `--read`
// prints, as JSON, only the checkbox state and evidence text per check id, which is all the skill
// is allowed to see of the file. Everything else in the file is data the operator wrote for
// themselves.
//
// USAGE:
//   node scripts/site-check/runfile.mjs --write [--from-a2 <config --json output>] [--extra <check-id>]...
//                                              [--lock LOCKED|PUBLIC|unknown] [--out-dir <dir>]
//   node scripts/site-check/runfile.mjs --read <path>

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { renderRunFile, parseRunFile } from './lib/runfile.mjs';
import { checkById } from './lib/registry.mjs';
import { parseShopifyJson, effectiveSettings } from './lib/repo-checks.mjs';
import { createRedactor } from './lib/redact.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const USAGE = `usage:
  node scripts/site-check/runfile.mjs --write [--from-a2 <config.mjs --json output file>] [--extra <check-id>]... [--lock LOCKED|PUBLIC|unknown] [--out-dir <dir>]
  node scripts/site-check/runfile.mjs --read <path>
`;

function parseArgs(argv) {
  const o = { write: false, read: null, fromA2: null, extras: [], lock: 'unknown', outDir: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => { i += 1; if (i >= argv.length) throw new Error(`${a} needs a value`); return argv[i]; };
    if (a === '--write') o.write = true;
    else if (a === '--read') o.read = val();
    else if (a === '--from-a2') o.fromA2 = val();
    else if (a === '--extra') o.extras.push(val());
    else if (a === '--lock') o.lock = val();
    else if (a === '--out-dir') o.outDir = val();
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.help && o.write === Boolean(o.read)) throw new Error('pass exactly one of --write or --read');
  if (!['LOCKED', 'PUBLIC', 'unknown'].includes(o.lock)) throw new Error('--lock must be LOCKED, PUBLIC or unknown');
  for (const id of o.extras) if (!checkById(id)) throw new Error(`--extra ${id} is not a registered check id`);
  return o;
}

function git(args) {
  const r = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}

let opts;
try { opts = parseArgs(process.argv.slice(2)); } catch (e) {
  process.stderr.write(`${e.message}\n${USAGE}`);
  process.exit(2);
}
if (opts.help) { process.stdout.write(USAGE); process.exit(0); }

const redact = createRedactor([]);

if (opts.read) {
  const map = parseRunFile(readFileSync(opts.read, 'utf8'));
  const out = {};
  for (const [id, v] of map) out[id] = v;
  process.stdout.write(`${redact(JSON.stringify(out, null, 2))}\n`);
  process.exit(0);
}

// Vacation mode from the effective theme settings (schema defaults under settings_data current).
let vacationEnabled = false;
try {
  const schema = parseShopifyJson(readFileSync(join(REPO_ROOT, 'config', 'settings_schema.json'), 'utf8'));
  const data = parseShopifyJson(readFileSync(join(REPO_ROOT, 'config', 'settings_data.json'), 'utf8'));
  vacationEnabled = Boolean(effectiveSettings(schema, data).vacation_mode_enabled);
} catch { vacationEnabled = false; }

// Skipped A2 reads come only from a config.mjs --json file: one item per admin-scope-missing finding.
const skippedReads = [];
if (opts.fromA2) {
  const a2 = JSON.parse(readFileSync(opts.fromA2, 'utf8'));
  const findings = Array.isArray(a2) ? a2 : (a2.findings || []);
  for (const f of findings) {
    if (f.check === 'admin-scope-missing' && f.severity === 'SKIPPED') skippedReads.push({ check: f.check, scope: f.subject });
  }
}

const extras = opts.extras.map((id) => ({ id, description: checkById(id).description }));
const generated = new Date().toISOString();
const md = renderRunFile({
  vacationEnabled,
  skippedReads,
  extras,
  meta: { branch: git(['branch', '--show-current']) || 'detached', sha: git(['rev-parse', '--short', 'HEAD']), lockState: opts.lock, generated },
});
const dir = opts.outDir ? resolve(opts.outDir) : (process.env.SITE_CHECK_STATE_DIR || join(homedir(), '.local', 'state', 'site-check'));
if (dir.startsWith(REPO_ROOT + '/') || dir === REPO_ROOT) {
  process.stderr.write('refusing to write the run file inside the checkout; use a state dir outside the repo\n');
  process.exit(2);
}
mkdirSync(dir, { recursive: true });
const path = join(dir, `runfile-${generated.replace(/[:.]/g, '-')}.md`);
writeFileSync(path, redact(md));
process.stdout.write(`run file -> ${path}\nitems: ${parseRunFile(md).size} (vacation ${vacationEnabled ? 'on' : 'off'}, skipped reads ${skippedReads.length}, extras ${extras.length})\n`);
