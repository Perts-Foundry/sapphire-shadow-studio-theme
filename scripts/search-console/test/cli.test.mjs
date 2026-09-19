import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run, parseArgs } from '../review.mjs';
import { SECONDARY_DOMAINS } from '../lib/checks.mjs';
import { validateCapture } from '../lib/schema.mjs';
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

test('--sitemap-count replaces the sitemap fetch; only the SECONDARY_DOMAINS probe goes out', async () => {
  const w = world();
  const r = await cli([fixture('capture-healthy.json'), '--sitemap-count', '17', '--now', '2026-12-01T15:00:00Z'], w);
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(w.calls, SECONDARY_DOMAINS.map((h) => `https://${h}/`));
});

test('without --offline the live sitemap is fetched from the property host', async () => {
  const w = world();
  const index = `<sitemapindex><sitemap><loc>https://sapphireshadowstudio.com/sitemap_pages_1.xml</loc></sitemap></sitemapindex>`;
  const child = `<urlset>${SITEMAP_URLS.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;
  const bodies = {
    'https://sapphireshadowstudio.com/sitemap.xml': index,
    'https://sapphireshadowstudio.com/sitemap_pages_1.xml': child,
  };
  const fetchImpl = liveFetch(bodies, aliasRedirects());
  const r = await cli([fixture('capture-healthy.json'), '--json', '--now', '2026-12-01T15:00:00Z'], w, { fetchImpl });
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual([...fetchImpl.calls].sort(), [...Object.keys(bodies), ...SECONDARY_DOMAINS.map((h) => `https://${h}/`)].sort());
  const fresh = JSON.parse(r.out).fresh;
  assert.deepEqual(fresh.map((f) => [f.check, f.url, f.severity]), SECONDARY_DOMAINS.map((h) => ['secondary-domain-redirect', h, 'INFO']));
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
    template: null,
  });
});

test('--template prints a parseable skeleton per mode and touches no state dir', async () => {
  for (const mode of ['audit', 'insights']) {
    const w = world();
    const r = await cli(['--template', mode], w);
    assert.equal(r.code, 0, r.err);
    const t = JSON.parse(r.out);
    assert.equal(t.mode, mode);
    assert.equal(fs.existsSync(w.state), false, 'the template creates nothing');
    assert.deepEqual(w.calls, []);
  }
});

test('--template runs before the state-dir check, which it neither needs nor weakens', async () => {
  const w = world();
  const inside = path.join(SC_ROOT, 'test', 'fixtures', 'state-should-not-exist');
  const r = await cli(['--template', 'audit'], { ...w, env: { ...w.env, SEARCH_CONSOLE_STATE_DIR: inside } });
  assert.equal(r.code, 0, r.err);
  assert.equal(fs.existsSync(inside), false);
  const refused = await cli([fixture('capture-healthy.json'), '--offline'], { ...w, env: { ...w.env, SEARCH_CONSOLE_STATE_DIR: inside } });
  assert.equal(refused.code, 2, 'a capture run is still refused a state dir inside the repo');
});

test('--template misuse is a usage error (2)', async () => {
  const w = world();
  const bogus = await cli(['--template', 'bogus'], w);
  assert.equal(bogus.code, 2);
  assert.match(bogus.err, /audit, insights/);
  for (const argv of [['--template', 'audit', 'c.json'], ['--template', '--print-state-dir'], ['--template'], ['--template', '--no-save'],
    ['--template', 'audit', '--print-state-dir'], ['--template', 'audit', '--json'], ['--template', 'audit', '--offline'],
    ['--template', 'audit', '--now', '2026-12-01T00:00:00Z'], ['--template', 'audit', '--full'], ['--template', 'audit', '--no-save'],
    ['--template', 'audit', '--sitemap-count', '3'], ['--template', 'audit', '--template', 'insights']]) {
    const r = await cli(argv, w);
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.err, /usage:/);
  }
});

test('a saved --template skeleton fails review as capture-invalid naming placeholders', async () => {
  const w = world();
  const t = await cli(['--template', 'audit'], w);
  const file = path.join(w.home, 'skeleton.json');
  fs.writeFileSync(file, t.out);
  const r = await cli([file, '--offline', '--json'], w);
  assert.equal(r.code, 1);
  const fresh = JSON.parse(r.out).fresh;
  assert.ok(fresh.every((f) => f.check === 'capture-invalid'));
  assert.ok(fresh.some((f) => /placeholder left unfilled/.test(f.detail)));
  assert.ok(fresh.some((f) => /\? suffix|`\?` suffix/.test(f.detail)), 'an optional key left with its ? suffix is named');
  assert.ok(validateCapture(JSON.parse(t.out)).errors.length > 0);
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

const HOST = 'https://sapphireshadowstudio.com';
const urlset = (urls) => `<urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;

/** A fetch stub: 200 for a body in `bodies`, a handler from `handlers`, else 404. */
function liveFetch(bodies, handlers = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (handlers[url]) return handlers[url](url);
    return { status: bodies[url] ? 200 : 404, url, headers: new Headers(), text: async () => bodies[url] ?? '' };
  };
  impl.calls = calls;
  return impl;
}
/** Handlers answering a permanent redirect to the property for each secondary host. */
const aliasRedirects = (extra = []) => Object.fromEntries([...SECONDARY_DOMAINS, ...extra].map((h) => [
  `https://${h}/`, (url) => ({ status: 301, url, headers: new Headers({ location: `${HOST}/` }), text: async () => '' }),
]));
const healthySitemap = () => ({
  [`${HOST}/sitemap.xml`]: `<sitemapindex><sitemap><loc>${HOST}/sitemap_pages_1.xml</loc></sitemap></sitemapindex>`,
  [`${HOST}/sitemap_pages_1.xml`]: urlset(SITEMAP_URLS),
});
const writeCapture = (w, name, mutate) => {
  const capture = JSON.parse(fs.readFileSync(fixture('capture-healthy.json'), 'utf8'));
  mutate(capture);
  const file = path.join(w.home, name);
  fs.writeFileSync(file, JSON.stringify(capture));
  return file;
};

test('a second run over a different period does not compare performance', async () => {
  const w = world();
  const first = await cli([fixture('capture-healthy.json'), '--offline', '--now', '2026-12-01T15:00:00Z'], w);
  assert.equal(first.code, 0, first.out + first.err);
  const file = writeCapture(w, 'capture-3mo.json', (c) => { c.reports.performance.period = '3mo'; });
  const second = await cli([file, '--offline', '--json', '--now', '2026-12-01T16:00:00Z'], w);
  const out = JSON.parse(second.out);
  assert.ok(out.notCompared.some((x) => x.report === 'performance' && x.reason === 'period-mismatch'), second.out);
});

test('a failed child sitemap is reported as partial', async () => {
  const w = world();
  const bodies = healthySitemap();
  bodies[`${HOST}/sitemap.xml`] = `<sitemapindex><sitemap><loc>${HOST}/sitemap_pages_1.xml</loc></sitemap><sitemap><loc>${HOST}/sitemap_products_1.xml</loc></sitemap></sitemapindex>`;
  const fetchImpl = liveFetch(bodies);
  const r = await cli([fixture('capture-healthy.json'), '--json', '--now', '2026-12-01T15:00:00Z'], w, { fetchImpl });
  assert.equal(r.code, 0, r.out + r.err);
  const fresh = JSON.parse(r.out).fresh;
  assert.ok(fresh.some((f) => f.check === 'sitemap-live-unreachable' && /child sitemap failed/.test(f.detail)), r.out);
  assert.ok(!fresh.some((f) => f.check === 'sitemap-discovered-mismatch'), 'no count comparison from a partial read');
});

test('an index that answers 500 is reported as unreachable', async () => {
  const w = world();
  const fetchImpl = async (url) => ({ status: 500, url, headers: new Headers(), text: async () => '' });
  const r = await cli([fixture('capture-healthy.json'), '--json', '--now', '2026-12-01T15:00:00Z'], w, { fetchImpl });
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(JSON.parse(r.out).fresh.some((f) => f.check === 'sitemap-live-unreachable' && /index could not be fetched/.test(f.detail)), r.out);
});

test('a secondary domain is probed unfollowed, and a permanent redirect to the property is INFO', async () => {
  const w = world();
  const file = writeCapture(w, 'capture-alias.json', (c) => { c.reports.settings.secondary_domains = ['brand-alias.example']; });
  const fetchImpl = liveFetch(healthySitemap(), aliasRedirects(['brand-alias.example']));
  const r = await cli([file, '--json', '--now', '2026-12-01T15:00:00Z'], w, { fetchImpl });
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(fetchImpl.calls.includes('https://brand-alias.example/'));
  const probe = JSON.parse(r.out).fresh.filter((f) => f.check === 'secondary-domain-redirect');
  assert.deepEqual(probe.map((f) => [f.url, f.severity]).sort(), [...SECONDARY_DOMAINS, 'brand-alias.example'].map((h) => [h, 'INFO']).sort());
});

test('a capture listing a SECONDARY_DOMAINS host probes it once', async () => {
  const w = world();
  const file = writeCapture(w, 'capture-dup.json', (c) => { c.reports.settings.secondary_domains = [...SECONDARY_DOMAINS]; });
  const fetchImpl = liveFetch(healthySitemap(), aliasRedirects());
  const r = await cli([file, '--json', '--now', '2026-12-01T15:00:00Z'], w, { fetchImpl });
  assert.equal(r.code, 0, r.out + r.err);
  for (const h of SECONDARY_DOMAINS) assert.equal(fetchImpl.calls.filter((u) => u === `https://${h}/`).length, 1);
});

test('a malformed or unparseable accepted-risks file exits 2', async () => {
  const w = world();
  const bad = path.join(w.home, 'accepted-risks.json');
  fs.writeFileSync(bad, JSON.stringify([{ check: 'no-such-check', path: null, note: 'x', accepted_on: '2026-12-01' }]));
  const malformed = await cli([fixture('capture-healthy.json'), '--offline'], w, { acceptedRisks: null, acceptedRisksFile: bad });
  assert.equal(malformed.code, 2);
  assert.match(malformed.err, /accepted-risks\.json is malformed/);
  fs.writeFileSync(bad, 'not json');
  assert.equal((await cli([fixture('capture-healthy.json'), '--offline'], w, { acceptedRisks: null, acceptedRisksFile: bad })).code, 2);
});
