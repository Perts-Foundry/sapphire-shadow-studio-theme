import test from 'node:test';
import assert from 'node:assert/strict';

import { summarize, sanitize, MAX_BODY } from '../summarize-pa11y.mjs';

const issue = (over = {}) => ({
  type: 'error',
  code: 'color-contrast',
  message: 'Element has insufficient colour contrast',
  selector: 'body > p',
  ...over,
});

const report = (results, extra = {}) => ({ total: Object.keys(results).length, results, ...extra });

test('a clean run is ok', () => {
  const out = summarize(report({ 'https://s.example/?preview_theme_id=1': [] }));
  assert.equal(out.ok, true);
  assert.equal(out.total, 1);
  assert.equal(out.errors, 0);
  assert.match(out.body, /1 URL\(s\) audited/);
});

test('FAIL CLOSED: zero URLs is a failure, never a pass', () => {
  // pa11y-ci exits 0 having audited nothing; that must not read as green.
  for (const raw of [report({}), { total: 0, results: {} }, {}, null, 'nope', { results: null }]) {
    const out = summarize(raw);
    assert.equal(out.ok, false, `expected failure for ${JSON.stringify(raw)}`);
  }
  assert.match(summarize(report({})).reason, /audited 0 URLs/);
});

test('errors are counted from the results, not from a summary field', () => {
  // A malformed count must not under-report the real findings.
  const out = summarize(report(
    { 'https://s.example/a': [issue(), issue()], 'https://s.example/b': [] },
    { errors: 0, passes: 99 }
  ));
  assert.equal(out.ok, false);
  assert.equal(out.errors, 2);
  assert.equal(out.passes, 1);
  assert.match(out.reason, /2 accessibility error\(s\) across 1 URL\(s\)/);
});

test('warnings and notices are not counted as errors', () => {
  const out = summarize(report({ 'https://s.example/a': [issue({ type: 'warning' }), issue({ type: 'notice' })] }));
  assert.equal(out.ok, true);
  assert.equal(out.errors, 0);
});

test('a non-zero pa11y exit with no parsed errors still fails', () => {
  // Chrome crashed, or a page would not load: the run failed even though no
  // accessibility issue was recorded.
  const out = summarize(report({ 'https://s.example/a': [] }), { exitCode: 2 });
  assert.equal(out.ok, false);
  assert.match(out.reason, /exited 2 but reported no accessibility errors/);
});

test('a zero pa11y exit is not required for a clean verdict', () => {
  assert.equal(summarize(report({ 'https://s.example/a': [] }), { exitCode: 0 }).ok, true);
  assert.equal(summarize(report({ 'https://s.example/a': [] }), { exitCode: null }).ok, true);
});

test('sanitize cannot break out of a fence or a details block', () => {
  assert.equal(sanitize('```\nrm -rf\n```'), '`` rm -rf ``');
  assert.equal(sanitize('a</details>b'), 'ab');
  assert.equal(sanitize('a<DETAILS>b'), 'ab');
  assert.equal(sanitize('a\u001b[31mred\u001b[0m'), 'a[31mred[0m', 'ANSI introducer stripped');
  assert.equal(sanitize('a\u0000b'), 'ab');
  assert.equal(sanitize('line\nbreak'), 'line break');
});

test('sanitize keeps ordinary text intact', () => {
  // Over-stripping would make findings unreadable, which is its own failure.
  assert.equal(sanitize('Element has insufficient colour contrast (4.2:1)'),
    'Element has insufficient colour contrast (4.2:1)');
  assert.equal(sanitize('body > p:nth-child(2)'), 'body > p:nth-child(2)');
});

test('sanitize clamps a single field', () => {
  const out = sanitize('x'.repeat(500), 50);
  assert.equal(out.length, 50);
  assert.ok(out.endsWith('…'));
});

test('page-derived text in a finding is sanitised into the body', () => {
  const out = summarize(report({
    'https://s.example/a': [issue({ message: 'evil ```\n</details>', selector: '<img>' })],
  }));
  assert.ok(!out.body.includes('```\n</details>'));
  assert.ok(!/<\/details>\s*$/.test(out.body.split('\n').find((l) => l.includes('evil')) || ''));
});

test('the body stays bounded well under GitHub comment limit', () => {
  const many = {};
  for (let i = 0; i < 200; i += 1) {
    many[`https://s.example/page-${i}`] = Array.from({ length: 50 }, () => issue({ message: 'y'.repeat(400) }));
  }
  const out = summarize(report(many));
  assert.ok(out.body.length <= MAX_BODY + 200, `body was ${out.body.length}`);
  assert.ok(out.body.includes('truncated'));
  assert.equal(out.errors, 200 * 50, 'truncating the BODY must not truncate the COUNT');
});

test('per-URL issue lists are capped with an explicit notice', () => {
  const out = summarize(report({ 'https://s.example/a': Array.from({ length: 25 }, () => issue()) }));
  assert.match(out.body, /and 15 more/);
  assert.equal(out.errors, 25);
});

test('the preview theme pin is dropped from displayed URLs', () => {
  const out = summarize(report({ 'https://s.example/cart?preview_theme_id=123': [issue()] }));
  assert.ok(!out.body.includes('preview_theme_id'), 'the pin is noise in every row');
  assert.ok(out.body.includes('/cart'));
});

test('a non-array results entry is treated as zero issues, not a crash', () => {
  const out = summarize(report({ 'https://s.example/a': null, 'https://s.example/b': [issue()] }));
  assert.equal(out.errors, 1);
  assert.equal(out.total, 2);
});
