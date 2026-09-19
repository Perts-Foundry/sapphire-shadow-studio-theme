// The --template skeleton agrees with REPORT_FIELDS key for key, every combinator can describe
// itself, an unfilled skeleton never validates, and a filled one does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplate, makeNonce } from '../lib/template.mjs';
import { REPORT_FIELDS, EXPECTED_REPORTS_BY_MODE, EMAIL_RE, validateCapture } from '../lib/schema.mjs';
import { evaluateCapture, PROPERTY } from '../lib/checks.mjs';
import { MODES } from '../lib/baseline.mjs';
import { ORIGIN, healthyOpts } from './harness.mjs';

const BASE_KEYS = ['captured_at', 'report', 'status'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Assert the template node has exactly the required keys plain and the optional keys `?`-suffixed. */
function sameKeys(node, required, optional, where) {
  const keys = Object.keys(node);
  assert.deepEqual(keys.filter((k) => !k.endsWith('?')).sort(), Object.keys(required).sort(), `${where}: required keys`);
  assert.deepEqual(keys.filter((k) => k.endsWith('?')).map((k) => k.slice(0, -1)).sort(), Object.keys(optional).sort(), `${where}: optional keys`);
}

/** Walk a template node against its combinator, asserting the shape at every depth. */
function walkShape(node, check, where) {
  if (check.type === 'object') {
    assert.ok(isObj(node), `${where}: expected an object`);
    sameKeys(node, check.shape, check.optional, where);
    for (const [k, c] of Object.entries(check.shape)) walkShape(node[k], c, `${where}/${k}`);
    for (const [k, c] of Object.entries(check.optional)) walkShape(node[`${k}?`], c, `${where}/${k}?`);
  } else if (check.type === 'array') {
    assert.ok(Array.isArray(node) && node.length === 1, `${where}: expected a one-element array`);
    walkShape(node[0], check.inner, `${where}/0`);
  } else {
    assert.equal(typeof node, 'string', `${where}: expected a placeholder`);
    assert.match(node, /^<[^>]+>$/, where);
  }
}

test('the template has every report the mode expects, and each matches REPORT_FIELDS at every depth', () => {
  for (const mode of MODES) {
    const t = buildTemplate(mode);
    assert.deepEqual(Object.keys(t.reports), [...EXPECTED_REPORTS_BY_MODE[mode]], mode);
    for (const [id, rep] of Object.entries(t.reports)) {
      const { required, optional = {} } = REPORT_FIELDS[id];
      assert.equal(rep.report, id);
      const data = Object.fromEntries(Object.entries(rep).filter(([k]) => !BASE_KEYS.includes(k)));
      sameKeys(data, required, optional, `${mode}/${id}`);
      for (const [k, c] of Object.entries(required)) walkShape(data[k], c, `${mode}/${id}/${k}`);
      for (const [k, c] of Object.entries(optional)) walkShape(data[`${k}?`], c, `${mode}/${id}/${k}?`);
    }
  }
});

test('every combinator reachable from REPORT_FIELDS has a non-empty kind with no closing angle bracket', () => {
  let seen = 0;
  const visit = (check, where) => {
    seen += 1;
    assert.equal(typeof check.kind, 'string', where);
    assert.ok(check.kind.length > 0, where);
    assert.ok(!check.kind.includes('>'), `${where}: a kind cannot contain > (it would end the placeholder)`);
    assert.equal(typeof check.type, 'string', where);
    for (const [k, c] of Object.entries(check.shape ?? {})) visit(c, `${where}/${k}`);
    for (const [k, c] of Object.entries(check.optional ?? {})) visit(c, `${where}/${k}?`);
    if (check.inner) visit(check.inner, `${where}/inner`);
  };
  for (const [id, { required, optional = {} }] of Object.entries(REPORT_FIELDS)) {
    for (const [k, c] of Object.entries({ ...required, ...optional })) visit(c, `${id}/${k}`);
  }
  assert.ok(seen > 100, `only ${seen} combinators walked`);
});

test('arrays render as one shape element and nested objects recurse', () => {
  const item = buildTemplate('audit').reports.enhancements.items[0];
  assert.deepEqual(Object.keys(item['issues?'][0]).sort(), ['items', 'label', 'level']);
  assert.equal(item['issues?'][0].level, '<warning | error>');
  assert.equal(item.warning, '<int | null>');
  const subjects = buildTemplate('audit').reports.messages.subjects;
  assert.equal(subjects.length, 1);
  assert.match(subjects[0], /up to 100 items, this one element is a shape example>$/);
});

test('an unfilled template fails validation, and the first error names a placeholder', () => {
  const { errors } = validateCapture(buildTemplate('audit'));
  assert.ok(errors.length > 0);
  assert.match(errors[0].message, /placeholder|suffix/);
});

// ---------------------------------------------------------------------------------------------
// Round trip: fill every placeholder with a value derived from its combinator.

function synth(check) {
  switch (check.type) {
    case 'int': case 'number': case 'rate': return 1;
    case 'bool': return true;
    case 'date': case 'dateOrIso': return '2026-12-01';
    case 'iso': return '2026-12-01T09:00:00-05:00';
    case 'host': return 'brand-alias.example';
    case 'viewPath': return 'links';
    case 'service': return 'analytics';
    case 'pageUrl': case 'anyUrl': return `${ORIGIN}/pages/about`;
    case 'str': return 'x';
    case 'oneOf': return check.values[0];
    case 'nullable': case 'cwvDevice': return synth(check.inner);
    case 'array': return [synth(check.inner)];
    case 'object': return Object.fromEntries(Object.entries({ ...check.shape, ...check.optional }).map(([k, c]) => [k, synth(c)]));
    default: throw new Error(`no synthetic value for combinator type ${check.type}`);
  }
}

/** Fill a template node from its combinator, dropping `?` suffixes. */
function fill(node, check) {
  if (check.type === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      const key = k.endsWith('?') ? k.slice(0, -1) : k;
      out[key] = fill(v, check.shape[key] ?? check.optional[key]);
    }
    return out;
  }
  if (check.type === 'array') return node.map((x) => fill(x, check.inner));
  return synth(check);
}

function filledCapture(mode) {
  const t = buildTemplate(mode);
  t.property_added = '2026-09-13';
  t.captured_at = '2026-12-01T09:00:00-05:00';
  for (const [id, rep] of Object.entries(t.reports)) {
    const { required, optional = {} } = REPORT_FIELDS[id];
    const data = Object.fromEntries(Object.entries(rep).filter(([k]) => !BASE_KEYS.includes(k)));
    const filled = fill(data, { type: 'object', shape: required, optional });
    t.reports[id] = { captured_at: '2026-12-01T09:00:00-05:00', report: id, status: 'ok', ...filled };
  }
  // One invariant ones cannot satisfy: three devices at one impression each exceed a total of one.
  t.reports.performance.totals = { clicks: 3, impressions: 3, ctr: 1, position: 1 };
  return t;
}

test('round trip: a template filled from its own combinators validates and evaluates', () => {
  for (const mode of MODES) {
    const c = filledCapture(mode);
    assert.deepEqual(validateCapture(c).errors, [], mode);
    assert.doesNotThrow(() => evaluateCapture(c, healthyOpts()), mode);
  }
});

test('the envelope carries the property and a fresh, well-formed nonce', () => {
  const a = buildTemplate('audit');
  const b = buildTemplate('audit');
  assert.equal(a.property, PROPERTY);
  assert.match(a.nonce, /^[a-z0-9]{8,16}$/);
  assert.notEqual(a.nonce, b.nonce);
  let i = 0;
  assert.equal(makeNonce(() => [0, 0.999][i++ % 2]), 'a9a9a9a9a9a9');
});

test('the insights template has no videos report; no output carries an em dash or an email', () => {
  assert.ok(!('videos' in buildTemplate('insights').reports));
  for (const mode of MODES) {
    const text = JSON.stringify(buildTemplate(mode));
    assert.ok(!text.includes(String.fromCharCode(0x2014)), mode);
    assert.ok(!EMAIL_RE.test(text), mode);
  }
});
