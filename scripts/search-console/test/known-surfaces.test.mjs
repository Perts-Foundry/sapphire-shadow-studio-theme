import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KNOWN_SURFACES, KNOWN_SURFACES_REVIEWED_ON, labelKey } from '../lib/known-surfaces.mjs';
import { evaluateCapture } from '../lib/checks.mjs';
import { KNOWN_REASONS, ENHANCEMENT_TYPES, INSPECTION_SECTIONS } from '../lib/schema.mjs';
import { baseCapture, healthyOpts } from './harness.mjs';

const dupes = (list) => list.filter((x, i) => list.indexOf(x) !== i);

test('every nav entry has a label and a path (a view path, or null for a button or heading)', () => {
  for (const entry of KNOWN_SURFACES.nav) {
    assert.equal(typeof entry.label, 'string');
    assert.ok(entry.label.length > 0);
    assert.ok('path' in entry, entry.label);
    assert.ok(entry.path === null || /^[a-z0-9/-]*$/.test(entry.path), entry.label);
  }
});

test('no duplicates in any list', () => {
  assert.deepEqual(dupes(KNOWN_SURFACES.nav.map((n) => labelKey(n.label))), []);
  assert.deepEqual(dupes(KNOWN_SURFACES.nav.map((n) => n.path).filter((p) => p !== null)), []);
  for (const key of ['subpages', 'settings_rows', 'user_settings_rows', 'performance_tabs', 'performance_controls', 'time_ranges', 'search_types', 'removals_tabs']) {
    assert.deepEqual(dupes(KNOWN_SURFACES[key].map(labelKey)), [], key);
  }
});

test('the finer vocabularies are the schema lists, and the review date is a date', () => {
  assert.equal(KNOWN_SURFACES.reasons, KNOWN_REASONS);
  assert.equal(KNOWN_SURFACES.enhancement_types, ENHANCEMENT_TYPES);
  assert.equal(KNOWN_SURFACES.inspection_sections, INSPECTION_SECTIONS);
  assert.match(KNOWN_SURFACES_REVIEWED_ON, /^\d{4}-\d{2}-\d{2}$/);
});

test('the vocabulary is frozen, so a run cannot extend it', () => {
  assert.ok(Object.isFrozen(KNOWN_SURFACES));
  assert.ok(Object.isFrozen(KNOWN_SURFACES.nav));
  assert.throws(() => { 'use strict'; KNOWN_SURFACES.nav.push({ label: 'x', path: 'x' }); });
});

test('discovery fires surface-new on an unknown nav item and surface-gone on a missing known one', () => {
  const c = baseCapture();
  c.reports.discovery.nav.push({ label: 'Shopping tab', path: 'shopping' });
  c.reports.discovery.nav = c.reports.discovery.nav.filter((n) => n.label !== 'Achievements');
  const findings = evaluateCapture(c, healthyOpts());
  assert.ok(findings.some((f) => f.check === 'surface-new' && f.url === 'nav:Shopping tab'));
  assert.ok(findings.some((f) => f.check === 'surface-gone' && f.url === 'nav:Achievements'));
  assert.ok(findings.every((f) => f.severity === 'INFO'), 'discovery never reds a run');
});

test('labels compare case- and spacing-insensitively', () => {
  const c = baseCapture();
  c.reports.discovery.performance_tabs = c.reports.discovery.performance_tabs.map((t) => t.toLowerCase());
  c.reports.discovery.settings_rows = c.reports.discovery.settings_rows.map((t) => ` ${t}  `.replace(' ', '  '));
  assert.deepEqual(evaluateCapture(c, healthyOpts()), []);
});
