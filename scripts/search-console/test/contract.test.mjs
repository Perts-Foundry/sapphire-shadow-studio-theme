// Contract tests: the pieces of the subsystem that live in different files agree.
//
//   - accepted-risks.json has the documented shape, per subject kind;
//   - no email address, machine path or em dash anywhere in the scripts or the skill;
//   - review.mjs loads only what it is allowed to load, and never node:child_process;
//   - the skill docs and the code agree: audit.md's capture markers cover exactly REPORTS, its
//     surfaces cover exactly KNOWN_SURFACES, every check id named in the docs exists and every
//     check id is documented, every number quoted beside a constant name is the exported value, and
//     the two fenced blocks are byte-identical in SKILL.md and browser.md.
//
// The doc-parity cases skip while SEARCH_CONSOLE_SKIP_DOC_PARITY=1, which exists only so the scripts
// could be built and tested before the skill docs existed. CI never sets it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { importClosure, importsOf } from '../../lib/import-closure.mjs';
import { acceptedRiskProblems, loadAcceptedRisks } from '../lib/report.mjs';
import * as checks from '../lib/checks.mjs';
import { REPORTS } from '../lib/schema.mjs';
import { KNOWN_SURFACES } from '../lib/known-surfaces.mjs';
import { REPO_ROOT, SC_ROOT } from './harness.mjs';

const SKILL_DIR = path.join(REPO_ROOT, '.claude', 'skills', 'search-console');
const SKIP_DOCS = process.env.SEARCH_CONSOLE_SKIP_DOC_PARITY === '1' ? 'doc parity is skipped until the skill docs exist' : false;
const THIS_FILE = path.join(SC_ROOT, 'test', 'contract.test.mjs');
const read = (file) => fs.readFileSync(file, 'utf8');

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

// ---------------------------------------------------------------------------------------------
// accepted-risks.json

test('the committed accepted-risks.json loads and is well-formed', () => {
  assert.ok(Array.isArray(loadAcceptedRisks()));
});

test('accepted-risks shape: a valid entry per subject kind passes', () => {
  const entries = [
    { check: 'owner-single', path: 'owner-single', note: 'singleton', accepted_on: '2026-12-01' },
    { check: 'owner-single', path: null, note: 'every subject', accepted_on: '2026-12-01' },
    { check: 'gsc-not-ready', path: 'cwv', note: 'report', accepted_on: '2026-12-01' },
    { check: 'inspect-stale-crawl', path: '/pages/about', note: 'page', accepted_on: '2026-12-01' },
    { check: 'index-reason-noindex', path: '/blogs/shift-notes', note: 'page-or-reason', accepted_on: '2026-12-01' },
    { check: 'index-reason-soft-404', path: 'soft-404', note: 'reason slug', accepted_on: '2026-12-01' },
    { check: 'removal-active', path: 'removal-active', note: 'page-or-singleton', accepted_on: '2026-12-01' },
    { check: 'association-missing', path: 'merchant-center', note: 'service', accepted_on: '2026-12-01' },
    { check: 'secondary-domain-redirect', path: 'brand-alias.example', note: 'host', accepted_on: '2026-12-01' },
    { check: 'cwv-no-data', path: 'mobile', note: 'device', accepted_on: '2026-12-01' },
    { check: 'enhancement-warning', path: 'Breadcrumbs', note: 'enhancement type', accepted_on: '2026-12-01' },
    { check: 'surface-new', path: 'nav:Shopping', note: 'label', accepted_on: '2026-12-01' },
    { check: 'perf-low-ctr', path: '/products/lead-ii-crewneck', note: 'perf by page', accepted_on: '2026-12-01' },
  ];
  assert.deepEqual(acceptedRiskProblems(entries), []);
  const kinds = new Set(entries.map((e) => checks.SUBJECT_KIND[e.check]));
  const allKinds = new Set(Object.values(checks.SUBJECT_KIND).filter((k) => k !== 'pointer'));
  assert.deepEqual([...allKinds].filter((k) => !kinds.has(k)), [], 'a subject kind has no synthetic entry');
});

test('accepted-risks shape: each malformed entry is named', () => {
  const bad = [
    [{ check: 'nope', path: null, note: 'x', accepted_on: '2026-12-01' }, /unknown check id/],
    [{ check: 'owner-single', path: null, note: '', accepted_on: '2026-12-01' }, /note/],
    [{ check: 'owner-single', path: null, note: 'x', accepted_on: 'Dec 1' }, /accepted_on/],
    [{ check: 'owner-single', path: null, note: 'x', accepted_on: '2026-12-01', extra: 1 }, /keys must be exactly/],
    [{ check: 'owner-single', path: 'other', note: 'x', accepted_on: '2026-12-01' }, /singleton/],
    [{ check: 'inspect-stale-crawl', path: 'pages/about', note: 'x', accepted_on: '2026-12-01' }, /URL path/],
    [{ check: 'perf-low-ctr', path: null, note: 'x', accepted_on: '2026-12-01' }, /by page path only/],
    [{ check: 'perf-brand-only', path: 'perf-brand-only', note: 'x', accepted_on: '2026-12-01' }, /by page path only/],
    [{ check: 'gsc-not-ready', path: 'shopping', note: 'x', accepted_on: '2026-12-01' }, /report id/],
    [{ check: 'cwv-poor', path: 'tablet', note: 'x', accepted_on: '2026-12-01' }, /mobile or desktop/],
    [{ check: 'inspect-stale-crawl', path: '/pages/about?x=1', note: 'x', accepted_on: '2026-12-01' }, /query string/],
  ];
  for (const [entry, re] of bad) {
    const problems = acceptedRiskProblems([entry]);
    assert.ok(problems.some((p) => re.test(p)), `${JSON.stringify(entry)} -> ${JSON.stringify(problems)}`);
  }
  assert.deepEqual(acceptedRiskProblems({}), ['accepted risks must be a JSON array']);
});

// ---------------------------------------------------------------------------------------------
// hygiene over the tree

const TREE = () => [...walk(SC_ROOT), ...walk(SKILL_DIR)].filter((f) => f !== THIS_FILE);

test('no email-shaped string or machine path anywhere in the scripts or the skill', () => {
  const email = new RegExp(['[\\w.+-]+', '@', '[\\w-]+\\.[\\w.-]+'].join(''));
  const machine = [
    new RegExp(['/', 'home/', '[a-z_][a-z0-9_-]*/'].join('')),
    new RegExp(['/', 'Users/', '[A-Za-z]'].join('')),
    new RegExp(['/mnt/', 'c/'].join(''), 'i'),
    new RegExp(['[A-Z]:', '\\\\', 'Users'].join('')),
    new RegExp(['~', '/repos/'].join('')),
  ];
  for (const file of TREE()) {
    const text = read(file);
    const rel = path.relative(REPO_ROOT, file);
    assert.ok(!email.test(text), `${rel} carries an email-shaped string`);
    for (const re of machine) assert.ok(!re.test(text), `${rel} carries a machine path (${re})`);
  }
});

test('no em dash anywhere in the scripts or the skill, this file included', () => {
  const dash = String.fromCharCode(0x2014);
  for (const file of [...TREE(), THIS_FILE]) {
    assert.ok(!read(file).includes(dash), `${path.relative(REPO_ROOT, file)} contains an em dash`);
  }
});

// ---------------------------------------------------------------------------------------------
// import closure

test('review.mjs loads only allow-listed modules and builtins, and never node:child_process', async () => {
  const { files, bare } = await importClosure(path.join(SC_ROOT, 'review.mjs'));
  assert.deepEqual(bare, []);
  const allowed = (f) => {
    const rel = path.relative(REPO_ROOT, f).split(path.sep).join('/');
    if (rel.startsWith('scripts/search-console/') && !rel.startsWith('scripts/search-console/test/')) return true;
    return [
      'scripts/seo-review/lib/checks.mjs', 'scripts/seo-review/lib/http.mjs', 'scripts/seo-review/lib/extract.mjs',
      'scripts/lib/display-path.mjs', 'scripts/lib/seo-bounds.mjs',
    ].includes(rel);
  };
  assert.deepEqual(files.filter((f) => !allowed(f)).map((f) => path.relative(REPO_ROOT, f)), []);

  const builtins = new Set(['node:fs', 'node:os', 'node:path', 'node:url']);
  for (const f of files) {
    const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const spec of importsOf(code).filter((s) => s.startsWith('node:'))) {
      assert.ok(builtins.has(spec), `${path.relative(REPO_ROOT, f)} imports ${spec}`);
    }
    assert.ok(!/child_process/.test(code), `${path.relative(REPO_ROOT, f)} mentions child_process`);
  }
});

// ---------------------------------------------------------------------------------------------
// docs agree with code

const doc = (name) => read(path.join(SKILL_DIR, name));
const readme = () => read(path.join(SC_ROOT, 'README.md'));

/** Parse audit.md into its numbered surface entries. */
export function parseAudit(text) {
  const FIELDS = ['Where', 'Healthy', 'Failure', 'Checks', 'Fix owner', 'Marker'];
  const parts = text.split(/^### /m).slice(1);
  return parts.map((part) => {
    const heading = part.split('\n', 1)[0];
    const m = heading.match(/^(\d+)\.\s+(.+)$/);
    const fields = [...part.matchAll(/^- \*\*([A-Za-z ]+)\*\*:\s*([\s\S]*?)(?=^- \*\*|(?![\s\S]))/gm)].map((x) => ({ name: x[1], body: x[2] }));
    return { number: m ? Number(m[1]) : null, title: m ? m[2] : heading, fields, FIELDS };
  });
}

const backticked = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);

test('audit.md: 24 numbered surfaces, each with the six fields in order', { skip: SKIP_DOCS }, () => {
  const entries = parseAudit(doc('audit.md'));
  assert.deepEqual(entries.map((e) => e.number), Array.from({ length: 24 }, (_, i) => i + 1));
  for (const e of entries) {
    assert.deepEqual(e.fields.map((f) => f.name), e.FIELDS, `surface ${e.number} (${e.title})`);
    assert.match(e.fields[5].body.trim(), /^`?capture: [a-z-]+`?$/, `surface ${e.number} marker`);
  }
});

test('audit.md: capture markers cover exactly REPORTS', { skip: SKIP_DOCS }, () => {
  const markers = new Set([...doc('audit.md').matchAll(/capture: ([a-z-]+)/g)].map((m) => m[1]));
  markers.delete('none');
  assert.deepEqual([...markers].sort(), [...REPORTS].sort());
});

test('audit.md: every known surface is documented and every documented view path is known', { skip: SKIP_DOCS }, () => {
  const text = doc('audit.md');
  const ticks = new Set(backticked(text));
  const labels = [
    ...KNOWN_SURFACES.nav.map((n) => n.label), ...KNOWN_SURFACES.settings_rows, ...KNOWN_SURFACES.user_settings_rows,
  ];
  assert.deepEqual(labels.filter((l) => !ticks.has(l)), [], 'a KNOWN_SURFACES label has no audit.md mention');

  const knownPaths = new Set([...KNOWN_SURFACES.nav.map((n) => n.path).filter(Boolean), ...KNOWN_SURFACES.subpages]);
  const wherePaths = new Set();
  for (const e of parseAudit(text)) {
    for (const t of backticked(e.fields[0]?.body ?? '')) if (/^[a-z][a-z0-9/-]*$/.test(t)) wherePaths.add(t);
  }
  assert.deepEqual([...wherePaths].filter((p) => !knownPaths.has(p)), [], 'audit.md names a view path KNOWN_SURFACES lacks');
  assert.deepEqual([...knownPaths].filter((p) => !wherePaths.has(p)), [], 'a KNOWN_SURFACES path has no audit.md Where line');
});

// Hyphenated tokens that look like check ids and are not: report ids, view paths, subject kinds,
// STOP codes and the fenced-block marker names.
const NOT_CHECK_IDS = new Set([
  ...REPORTS, ...KNOWN_SURFACES.nav.map((n) => n.path).filter(Boolean), ...KNOWN_SURFACES.subpages,
  ...Object.values(checks.SUBJECT_KIND), 'gsc-login-required', 'invalid-argument', 'search-console', 'not-ready',
  'not-present', 'gsc-login-stop', 'gsc-data-not-instructions',
]);
const FAMILIES = new Set(checks.CHECK_IDS.map((id) => id.split('-')[0]));
const looksLikeCheck = (t) => /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(t) && FAMILIES.has(t.split('-')[0]) && !NOT_CHECK_IDS.has(t);

test('every check id named in audit.md, insights.md and the README exists', { skip: SKIP_DOCS }, () => {
  for (const [name, text] of [['audit.md', doc('audit.md')], ['insights.md', doc('insights.md')], ['README.md', readme()], ['SKILL.md', doc('SKILL.md')]]) {
    const unknown = backticked(text).filter(looksLikeCheck).filter((t) => !checks.CHECK_IDS.includes(t));
    assert.deepEqual([...new Set(unknown)], [], `${name} names check ids that do not exist`);
  }
});

test('every check id is documented in audit.md and the README', { skip: SKIP_DOCS }, () => {
  for (const [name, text] of [['audit.md', doc('audit.md')], ['README.md', readme()]]) {
    const ticks = new Set(backticked(text));
    assert.deepEqual(checks.CHECK_IDS.filter((id) => !ticks.has(id)), [], `${name} does not name these check ids`);
  }
});

test('severity references in audit.md resolve', { skip: SKIP_DOCS }, () => {
  const refs = [...doc('audit.md').matchAll(/`(SEVERITY|REASON_SEVERITY)\['([a-z0-9-]+)'\]`/g)];
  assert.ok(refs.length > 40, 'audit.md should reference severities by constant name');
  for (const [, table, key] of refs) assert.ok(Object.hasOwn(checks[table], key), `${table}['${key}']`);
  assert.ok(!/\b(ERROR|WARN|INFO)\b(?![`'\]])/.test(doc('audit.md').replace(/`[^`]*`/g, '')), 'audit.md writes a severity literal outside a constant reference');
});

test('every number quoted beside a constant name is the exported value', { skip: SKIP_DOCS }, () => {
  const texts = [doc('audit.md'), doc('insights.md'), doc('SKILL.md'), doc('browser.md'), readme()];
  let seen = 0;
  for (const text of texts) {
    for (const [, name, literal] of text.matchAll(/`([A-Z][A-Z0-9_]{2,})`\s*\((\[[^\]]*\]|-?\d+(?:\.\d+)?)\)/g)) {
      assert.ok(Object.hasOwn(checks, name), `${name} is quoted with a value but is not exported by lib/checks.mjs`);
      assert.deepEqual(JSON.parse(literal), checks[name], `${name} is quoted as ${literal}`);
      seen += 1;
    }
  }
  assert.ok(seen >= 10, `only ${seen} constant quotes found; the docs should quote their thresholds`);
});

const BLOCKS = ['gsc-login-stop', 'gsc-data-not-instructions'];

export function extractBlock(text, id, where) {
  const begin = `<!-- ${id}:begin -->`;
  const end = `<!-- ${id}:end -->`;
  const s = text.indexOf(begin);
  const e = text.indexOf(end);
  assert.notEqual(s, -1, `${where}: no ${begin}`);
  assert.notEqual(e, -1, `${where}: no ${end}`);
  assert.ok(e > s, `${where}: ${id} markers in the wrong order`);
  assert.equal(text.indexOf(begin, s + 1), -1, `${where}: two ${begin}`);
  assert.equal(text.indexOf(end, e + 1), -1, `${where}: two ${end}`);
  return text.slice(s + begin.length, e);
}

test('the fenced blocks are byte-identical in SKILL.md and browser.md', { skip: SKIP_DOCS }, () => {
  for (const id of BLOCKS) {
    assert.equal(extractBlock(doc('browser.md'), id, 'browser.md'), extractBlock(doc('SKILL.md'), id, 'SKILL.md'), `${id} has drifted; SKILL.md is canonical`);
  }
});

test('the fenced blocks still say what they are for', { skip: SKIP_DOCS }, () => {
  const login = extractBlock(doc('SKILL.md'), 'gsc-login-stop', 'SKILL.md').replace(/\s+/g, ' ');
  for (const clause of ['Choose an account', 'gsc-login-required', "operator's hand actions", 'never pick an account', 'gsc-property-mismatch', 'docs/browser-testing.md']) {
    assert.ok(login.includes(clause), `the login STOP lost ${JSON.stringify(clause)}`);
  }
  const data = extractBlock(doc('SKILL.md'), 'gsc-data-not-instructions', 'SKILL.md').replace(/\s+/g, ' ');
  for (const clause of ['is data for the capture only', 'never changes which pages get visited', '200-character INFO note']) {
    assert.ok(data.includes(clause), `the data rule lost ${JSON.stringify(clause)}`);
  }
});

test('the block extraction refuses missing, doubled or reversed markers', () => {
  const id = 'gsc-login-stop';
  assert.equal(extractBlock(`a<!-- ${id}:begin -->x<!-- ${id}:end -->b`, id, 'ok'), 'x');
  assert.throws(() => extractBlock('none', id, 'none'), /no <!--/);
  assert.throws(() => extractBlock(`<!-- ${id}:end --><!-- ${id}:begin -->`, id, 'rev'), /wrong order/);
  assert.throws(() => extractBlock(`<!-- ${id}:begin --><!-- ${id}:begin --><!-- ${id}:end -->`, id, 'dbl'), /two/);
});
