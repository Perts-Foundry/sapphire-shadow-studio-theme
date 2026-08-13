// --help across every entry point, and a DRIFT test over it.
//
// The last clause is the one that does the work: "exit 0 with some output" passes forever while
// the flag list goes stale, which is exactly how `--force` ended up documented in neither SKILL.md
// nor the README. So the accepted flags are read out of each parser's own source and every one of
// them must appear in that tool's help text.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = path.join(HERE, '..');

export const ENTRY_POINTS = [
  'ingest.mjs',
  'crops.mjs',
  'draft.mjs',
  'render.mjs',
  'publish.mjs',
  'apply-options.mjs',
  'audit.mjs',
];

// Flags a hand-rolled parseArgs accepts all look like `a === 'name'`. Deliberately source-scanned
// rather than declared: a declared list is one more thing that can drift from the parser.
const ACCEPTED_FLAG_RE = /\ba === '([a-z0-9][a-z0-9-]*)'/g;

async function acceptedFlags(entry) {
  const src = await readFile(path.join(MODULE_DIR, entry), 'utf8');
  return [...new Set([...src.matchAll(ACCEPTED_FLAG_RE)].map((m) => m[1]))].sort();
}

test('the entry-point list is the seven tools this module ships', async () => {
  for (const entry of ENTRY_POINTS) {
    const src = await readFile(path.join(MODULE_DIR, entry), 'utf8');
    assert.match(src, /^#!\/usr\/bin\/env node/, `${entry} is an executable entry point`);
  }
  assert.equal(ENTRY_POINTS.length, 7);
});

for (const entry of ENTRY_POINTS) {
  test(`${entry} --help exits 0 with output, and documents every flag it accepts`, async () => {
    const { stdout, stderr } = await run(process.execPath, [path.join(MODULE_DIR, entry), '--help'], {
      cwd: MODULE_DIR,
      env: { ...process.env, MYSHOPIFY_DOMAIN: '', SHOPIFY_CLIENT_ID: '', SHOPIFY_CLIENT_SECRET: '' },
    });
    assert.ok(stdout.trim().length > 0, `${entry} --help printed nothing`);
    assert.match(stdout, /Usage: node/, `${entry} --help should open with a usage line`);
    assert.equal(stderr.trim(), '', `${entry} --help should not warn`);

    const flags = await acceptedFlags(entry);
    assert.ok(flags.includes('help'), `${entry}'s parser must accept --help`);
    for (const flag of flags) {
      assert.ok(stdout.includes(`--${flag}`), `${entry} --help does not mention --${flag}`);
    }
  });
}

test('the drift test would catch an undocumented flag', async () => {
  // A guard on the guard: if ACCEPTED_FLAG_RE ever stops matching, every case above passes
  // vacuously. --force is the flag that was actually undocumented, so it is named here.
  const ingest = await acceptedFlags('ingest.mjs');
  assert.deepEqual(ingest, ['force', 'help', 'out-dir', 'source']);
  const crops = await acceptedFlags('crops.mjs');
  for (const f of ['propose', 'preview', 'grid', 'scan', 'sheet', 'emit-fixture']) assert.ok(crops.includes(f));
});
