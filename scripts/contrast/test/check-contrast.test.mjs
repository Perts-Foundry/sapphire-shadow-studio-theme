import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run, PATHS } from '../check-contrast.mjs';
import { evaluateScheme, isOverlayScheme } from '../lib/evaluate.mjs';
import { PAIRS } from '../lib/pairs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'settings_data.json');

/** Write a throwaway accepted-risks.json and return its path. */
function risksFile(entries) {
  const path = join(mkdtempSync(join(tmpdir(), 'contrast-')), 'accepted-risks.json');
  writeFileSync(path, JSON.stringify(entries, null, 2));
  return path;
}

const onFixture = (risks = []) =>
  run({ settingsData: FIXTURE, acceptedRisks: risksFile(risks) });

// --- evaluate ---------------------------------------------------------------

test('isOverlayScheme detects only a fully transparent background', () => {
  assert.equal(isOverlayScheme({ background: 'rgba(0,0,0,0)' }), true);
  assert.equal(isOverlayScheme({ background: '#00000000' }), true);
  assert.equal(isOverlayScheme({ background: '#ffffff' }), false);
  // Nearly-transparent is NOT overlay: it still composites onto the canvas.
  assert.equal(isOverlayScheme({ background: '#00000001' }), false);
  assert.equal(isOverlayScheme({}), false, 'unparseable must not read as overlay');
});

test('evaluateScheme returns one result per pair', () => {
  const settings = Object.fromEntries(
    [...new Set(PAIRS.flatMap((p) => [p.fg, p.bg]))].map((r) => [r, '#000000'])
  );
  settings.background = '#ffffff';
  const results = evaluateScheme({ source: 'current', scheme: 's', settings });
  assert.equal(results.length, PAIRS.length);
});

test('a missing role is an ERROR, never a silent skip', () => {
  // A truncated scheme must not merge green having been checked for nothing.
  const results = evaluateScheme({ source: 'current', scheme: 's', settings: { background: '#ffffff' } });
  const errored = results.filter((r) => r.error);
  assert.ok(errored.length > 0);
  assert.ok(errored.every((r) => r.pass === false));
  assert.match(errored[0].error, /missing role/);
});

test('an unparseable colour is an ERROR, never a silent skip', () => {
  const settings = Object.fromEntries(
    [...new Set(PAIRS.flatMap((p) => [p.fg, p.bg]))].map((r) => [r, '#000000'])
  );
  settings.background = '#ffffff';
  settings.foreground = 'chartreuse';
  const results = evaluateScheme({ source: 'current', scheme: 's', settings });
  const bad = results.find((r) => r.pair === 'foreground on background');
  assert.equal(bad.pass, false);
  assert.match(bad.error, /unsupported colour/);
});

test('a border matching its own fill passes when the fill is visible on the page', () => {
  // The naive "border vs its own background" reading scores a solid black
  // button on white at 1:1 and fails it, which is nonsense: the control is
  // plainly visible. See the threshold notes in lib/pairs.mjs.
  const settings = Object.fromEntries(
    [...new Set(PAIRS.flatMap((p) => [p.fg, p.bg]))].map((r) => [r, '#000000'])
  );
  settings.background = '#ffffff';
  for (const key of Object.keys(settings)) if (key.includes('text')) settings[key] = '#ffffff';
  const results = evaluateScheme({ source: 'current', scheme: 's', settings });
  const button = results.find((r) => r.pair === 'primary_button_border around primary_button_background');
  assert.equal(button.pass, true, 'a black button on white must not fail non-text contrast');
});

test('an invisible control fails non-text contrast', () => {
  const settings = Object.fromEntries(
    [...new Set(PAIRS.flatMap((p) => [p.fg, p.bg]))].map((r) => [r, '#fdfdfd'])
  );
  settings.background = '#ffffff';
  const results = evaluateScheme({ source: 'current', scheme: 's', settings });
  const button = results.find((r) => r.pair === 'primary_button_border around primary_button_background');
  assert.equal(button.pass, false);
});

// --- end to end on the fixture ---------------------------------------------

test('fixture: the passing scheme produces no failures', () => {
  const { results } = onFixture();
  const pass = results.filter((r) => r.scheme === 'fixture-pass');
  assert.equal(pass.length, PAIRS.length);
  assert.deepEqual(pass.filter((r) => !r.pass), []);
});

test('fixture: the failing scheme fails exactly the two intended pairs', () => {
  const { results } = onFixture();
  const failing = results
    .filter((r) => r.scheme === 'fixture-fail' && !r.pass)
    .map((r) => r.pair)
    .sort();
  assert.deepEqual(failing, ['border around background', 'foreground on background']);
});

test('fixture: the overlay scheme is indeterminate, not failed', () => {
  const { results } = onFixture();
  const overlay = results.filter((r) => r.scheme === 'fixture-overlay');
  assert.equal(overlay.length, PAIRS.length);
  assert.ok(overlay.every((r) => r.indeterminate === true));
  assert.ok(overlay.every((r) => r.pass === true), 'indeterminate must not count as a failure');
});

test('fixture: a clean run exits 1 because of the unbaselined failures', () => {
  const { exitCode, lines } = onFixture();
  assert.equal(exitCode, 1);
  assert.ok(lines.some((l) => l.includes('2 contrast failure(s)')));
  assert.ok(lines.some((l) => l.includes('overlay scheme')), 'overlay schemes must be reported, not hidden');
});

test('fixture: baselining both failures turns the run green', () => {
  const { exitCode, lines } = onFixture([
    {
      source: 'current', scheme: 'fixture-fail', pair: 'foreground on background',
      ratio: 1.61, note: 'fixture entry exercising the baseline path', accepted_on: '2026-08-16',
    },
    {
      source: 'current', scheme: 'fixture-fail', pair: 'border around background',
      ratio: 1.02, note: 'fixture entry exercising the baseline path', accepted_on: '2026-08-16',
    },
  ]);
  assert.equal(exitCode, 0);
  assert.ok(lines.some((l) => l.includes('0 failure(s), 2 accepted')));
});

test('fixture: a malformed baseline fails and does NOT suppress anything', () => {
  const { exitCode, lines } = onFixture([
    { source: 'current', scheme: 'fixture-fail', pair: 'foreground on background', ratio: 1.61, note: 'no', accepted_on: 'nope' },
  ]);
  assert.equal(exitCode, 1);
  assert.ok(lines.some((l) => l.includes('malformed')));
  assert.ok(lines.some((l) => l.includes('contrast failure(s)')), 'entries must be discarded, not honoured');
});

// --- end to end on the real theme ------------------------------------------

test('the real theme passes with its committed baseline', () => {
  // This is the assertion the merge gate actually rests on.
  const { exitCode, lines } = run();
  assert.equal(exitCode, 0, `contrast lint failed:\n${lines.join('\n')}`);
});

test('the real run scans a non-trivial number of schemes and pairs', () => {
  // Fail-closed floor: a lint that checked nothing would otherwise report green.
  const { results, lines } = run();
  assert.ok(results.length >= 100, `only ${results.length} pairs checked`);
  const summary = lines.at(-1);
  assert.match(summary, /scanned \d+ scheme\(s\), \d+ pair\(s\)/);
  assert.ok(!summary.startsWith('contrast lint: scanned 0 '));
});

test('an empty settings file trips the fail-closed floor', () => {
  const empty = join(mkdtempSync(join(tmpdir(), 'contrast-')), 'settings_data.json');
  writeFileSync(empty, '{"current":{},"presets":{}}');
  const { exitCode, lines } = run({ settingsData: empty, acceptedRisks: risksFile([]) });
  assert.equal(exitCode, 1);
  assert.ok(lines.some((l) => l.includes('scanned 0 scheme(s)')));
});

test('PATHS point at the real repo files', () => {
  assert.match(PATHS.settingsData, /config\/settings_data\.json$/);
  assert.match(PATHS.settingsSchema, /config\/settings_schema\.json$/);
  assert.match(PATHS.acceptedRisks, /scripts\/contrast\/accepted-risks\.json$/);
});
