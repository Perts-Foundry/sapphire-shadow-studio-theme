// The read commands as a caller runs them: exit code and output, through the real scripts.
//
// NO CREDENTIAL REACHES THESE PROCESSES. Every Shopify variable is removed from the child's
// environment, so the only paths exercised are the offline ones and the refusals that happen before a
// client could be built. The live write is not run here in any form.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { OK_LINE } from '../verify.mjs';
import { TEST_DIR, cleanRoot, cleanup, madeRoots } from './helpers.mjs';
import { cleanupDirs, madeDirs, tempDir } from './network-helpers.mjs';

after(() => {
  for (const dir of [...madeRoots(), ...madeDirs()]) assert.ok(dir.startsWith(tmpdir()), `${dir} is not under the temp root`);
  cleanupDirs();
  cleanup();
});

function childEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(?:MYSHOPIFY_|SHOPIFY_)/.test(key)) continue;
    env[key] = value;
  }
  env.ARTICLES_STATE_DIR = tempDir('articles-cli-state-');
  env.ARTICLES_BACKUP_DIR = tempDir('articles-cli-backup-');
  return env;
}

function runScript(name, args) {
  const result = spawnSync(process.execPath, [join(TEST_DIR, '..', name), ...args], { encoding: 'utf8', env: childEnv() });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const noStack = (out) => assert.equal(/TypeError|\n\s+at .*\.mjs:\d+/.test(out.stderr), false, `a stack trace escaped:\n${out.stderr}`);

test('status offline runs on the real tree with no credential and no client', () => {
  const out = runScript('status.mjs', []);
  assert.notEqual(out.status, 1, out.stderr);
  assert.match(out.stdout, /^state: {2}.*observed\.json/m);
  assert.match(out.stdout, /live: {3}NOT READ/);
  noStack(out);
});

test('status and verify refuse an unknown flag with exit 1 and a message, not a stack trace', () => {
  for (const name of ['status.mjs', 'verify.mjs']) {
    const out = runScript(name, ['--nope']);
    assert.equal(out.status, 1, `${name}: ${out.stderr}`);
    assert.match(out.stderr, /unknown flag --nope/);
    noStack(out);
  }
});

test('verify --root on a clean tree exits 0 and prints its success line', () => {
  const out = runScript('verify.mjs', ['--root', cleanRoot()]);
  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.stdout.includes(OK_LINE), out.stdout);
});

test('pull with no mode exits 1 before any credential is needed', () => {
  const out = runScript('pull.mjs', []);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /exactly one of --check/);
  assert.equal(/MYSHOPIFY_DOMAIN/.test(out.stderr), false, 'the refusal must come before a client is built');
  noStack(out);
});

test('the live read commands without credentials exit 1 naming the missing variable', () => {
  for (const [name, args] of [['status.mjs', ['--live']], ['pull.mjs', ['--check']], ['verify.mjs', ['--live']]]) {
    const out = runScript(name, args);
    assert.equal(out.status, 1, `${name}: ${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /Missing required env MYSHOPIFY_DOMAIN/);
    noStack(out);
  }
});
