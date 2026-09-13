import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run, parseArgs } from '../review.mjs';
import { FIXTURES, REPO_ROOT, SC_ROOT, SITEMAP_URLS, sink } from './harness.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'search-console-cli-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;

/** A fresh HOME and state dir, and a fetch that counts and refuses every call. */
function world() {
  const home = path.join(tmp, `home-${n++}`);
  const state = path.join(home, '.local', 'state', 'search-console');
  fs.mkdirSync(home, { recursive: true });
  const calls = [];
  const refusingFetch = async (url) => {
    calls.push(url);
    throw new Error('network access in a test');
  };
  return { home, state, env: { HOME: home, SEARCH_CONSOLE_STATE_DIR: state }, calls, refusingFetch };
}

async function cli(argv, w, extra = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await run(argv, { env: w.env, stdout, stderr, fetchImpl: w.refusingFetch, acceptedRisks: [], ...extra });
  return { code, out: stdout.text, err: stderr.text };
}

const fixture = (name) => path.join(FIXTURES, name);

// Belt and braces: nothing in this file may reach the network through the global either.
const realFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('global fetch in a test');
};
after(() => {
  globalThis.fetch = realFetch;
});

test('--offline makes no network call, even with a secondary domain to probe', async () => {
  const w = world();
  const capture = JSON.parse(fs.readFileSync(fixture('capture-healthy.json'), 'utf8'));
  capture.reports.settings.secondary_domains = ['brand-alias.example'];
  const file = path.join(w.home, 'capture.json');
  fs.writeFileSync(file, JSON.stringify(capture));
  const r = await cli([file, '--offline', '--now', '2026-12-01T15:00:00Z'], w);
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(w.calls, []);
  assert.match(r.out, /capture: ~\/capture\.json/);
});

test('--sitemap-count replaces the sitemap fetch', async () => {
  const w = world();
  const r = await cli([fixture('capture-healthy.json'), '--sitemap-count', '17', '--now', '2026-12-01T15:00:00Z'], w);
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(w.calls, []);
});

test('without --offline the live sitemap is fetched from the property host', async () => {
  const w = world();
  const index = `<sitemapindex><sitemap><loc>https://sapphireshadowstudio.com/sitemap_pages_1.xml</loc></sitemap></sitemapindex>`;
  const child = `<urlset>${SITEMAP_URLS.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;
  const bodies = {
    'https://sapphireshadowstudio.com/sitemap.xml': index,
    'https://sapphireshadowstudio.com/sitemap_pages_1.xml': child,
  };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { status: bodies[url] ? 200 : 404, url, headers: new Headers(), text: async () => bodies[url] ?? '' };
  };
  const r = await cli([fixture('capture-healthy.json'), '--json', '--now', '2026-12-01T15:00:00Z'], w, { fetchImpl });
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(calls.sort(), Object.keys(bodies).sort());
  assert.deepEqual(JSON.parse(r.out).fresh, []);
});

test('--print-state-dir prints the resolved dir with HOME collapsed and exits 0', async () => {
  const w = world();
  const r = await cli(['--print-state-dir'], w);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), '~/.local/state/search-console');
  assert.equal(fs.existsSync(w.state), false, 'printing creates nothing');
});

test('an unknown flag, a missing file, and two captures are usage errors (2)', async () => {
  const w = world();
  assert.equal((await cli([fixture('capture-healthy.json'), '--frobnicate'], w)).code, 2);
  assert.equal((await cli([path.join(w.home, 'absent.json')], w)).code, 2);
  assert.equal((await cli([fixture('capture-healthy.json'), fixture('capture-preindex.json')], w)).code, 2);
  assert.equal((await cli([], w)).code, 2);
  assert.equal((await cli(['x.json', '--sitemap-count', 'many'], w)).code, 2);
  assert.equal((await cli(['x.json', '--now', 'yesterday'], w)).code, 2);
  const missing = await cli([path.join(w.home, 'absent.json')], w);
  assert.ok(!missing.err.includes(w.home), 'the unreadable path is printed with HOME collapsed');
});

test('a state dir inside the repository is refused (2) and nothing is written', async () => {
  const w = world();
  const inside = path.join(SC_ROOT, 'test', 'fixtures', 'state-should-not-exist');
  const r = await cli([fixture('capture-healthy.json'), '--offline'], { ...w, env: { ...w.env, SEARCH_CONSOLE_STATE_DIR: inside } });
  assert.equal(r.code, 2);
  assert.match(r.err, /inside the repository/);
  assert.equal(fs.existsSync(inside), false);
  const printed = await cli(['--print-state-dir'], { ...w, env: { ...w.env, SEARCH_CONSOLE_STATE_DIR: REPO_ROOT } });
  assert.equal(printed.code, 2);
});

test('a schema-invalid capture exits 1 with parseable --json, and saves nothing', async () => {
  const w = world();
  const r = await cli([fixture('capture-invalid.json'), '--json', '--offline'], w);
  assert.equal(r.code, 1);
  const out = JSON.parse(r.out);
  assert.equal(out.exitCode, 1);
  assert.ok(out.fresh.length >= 6);
  assert.ok(out.fresh.every((f) => f.check === 'capture-invalid' && f.severity === 'ERROR'));
  assert.equal(fs.existsSync(w.state), false);
});

test('a file that is not JSON exits 1', async () => {
  const w = world();
  const file = path.join(w.home, 'nope.json');
  fs.writeFileSync(file, 'not json at all');
  const r = await cli([file, '--offline'], w);
  assert.equal(r.code, 1);
  assert.match(r.out, /capture invalid, 1 error/);
});

test('an abbreviated number in the transcription is refused as invalid', async () => {
  const w = world();
  const capture = JSON.parse(fs.readFileSync(fixture('capture-healthy.json'), 'utf8'));
  capture.reports.performance.totals.impressions = '2K';
  const file = path.join(w.home, 'abbrev.json');
  fs.writeFileSync(file, JSON.stringify(capture));
  const r = await cli([file, '--offline', '--json'], w);
  assert.equal(r.code, 1);
  assert.ok(JSON.parse(r.out).fresh.some((f) => /abbreviated/.test(f.detail)));
});

test('a raw insights transcription normalises, evaluates, and saves a run', async () => {
  const w = world();
  const r = await cli([fixture('capture-insights.json'), '--offline', '--now', '2026-12-01T15:00:00Z'], w);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /search-console insights/);
  const runs = fs.readdirSync(w.state).filter((f) => f.startsWith('insights-'));
  assert.equal(runs.length, 1);
});

test('a fresh ERROR exits 1', async () => {
  const w = world();
  const r = await cli([fixture('capture-problems.json'), '--offline', '--now', '2026-12-01T15:00:00Z'], w);
  assert.equal(r.code, 1);
});

test('parseArgs defaults', () => {
  assert.deepEqual(parseArgs(['c.json']), {
    capture: 'c.json', full: false, noSave: false, json: false, offline: false, sitemapCount: null, now: null, printStateDir: false,
  });
});

test('spawn smoke: the CLI runs as a process with no shell', () => {
  const w = world();
  const res = spawnSync(process.execPath, [path.join(SC_ROOT, 'review.mjs'), '--print-state-dir'], {
    cwd: REPO_ROOT, env: { ...w.env, PATH: process.env.PATH }, timeout: 30_000, encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), '~/.local/state/search-console');

  const bad = spawnSync(process.execPath, [path.join(SC_ROOT, 'review.mjs'), '--nope'], {
    cwd: REPO_ROOT, env: { ...w.env, PATH: process.env.PATH }, timeout: 30_000, encoding: 'utf8',
  });
  assert.equal(bad.status, 2);
});
