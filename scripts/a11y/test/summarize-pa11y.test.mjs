import test from 'node:test';
import assert from 'node:assert/strict';

import {
  summarize, sanitize, normaliseBaseline, loadBaseline, MAX_BODY,
} from '../summarize-pa11y.mjs';

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

test('a non-zero pa11y exit with nothing parsed out still fails', () => {
  // Chrome crashed, or a page would not load: the run failed even though no
  // accessibility issue was recorded.
  const out = summarize(report({ 'https://s.example/a': [] }), { exitCode: 2 });
  assert.equal(out.ok, false);
  assert.match(out.reason, /exited 2 but reported no accessibility findings/);
});

test('a zero pa11y exit is not required for a clean verdict', () => {
  assert.equal(summarize(report({ 'https://s.example/a': [] }), { exitCode: 0 }).ok, true);
  assert.equal(summarize(report({ 'https://s.example/a': [] }), { exitCode: null }).ok, true);
});

test('a run with only baselined findings is clean despite pa11y exiting non-zero', () => {
  // pa11y is no longer told about the baseline, so it exits 2 on every run that
  // has any known-debt finding. That must not be read as a crash.
  const out = summarize(
    report({ 'https://s.example/a': [issue(), issue()] }),
    { exitCode: 2, baseline: ['color-contrast'] }
  );
  assert.equal(out.ok, true);
  assert.equal(out.errors, 0);
  assert.equal(out.suppressed, 2);
});

// ── Baseline disclosure ────────────────────────────────────────────

test('baselined rules are suppressed from the gate but disclosed in the body', () => {
  const out = summarize(
    report({ 'https://s.example/a': [issue(), issue({ code: 'link-name' })] }),
    { baseline: ['color-contrast'] }
  );
  assert.equal(out.ok, false, 'the un-baselined finding still gates');
  assert.equal(out.errors, 1);
  assert.equal(out.suppressed, 1);
  assert.match(out.body, /Baseline active: 1 rule\(s\) suppressed audit-wide, hiding 1 finding\(s\)/);
  assert.match(out.body, /\| `color-contrast` \| 1 \|/, 'the per-rule count must be in the body');
  assert.match(out.reason, /1 baselined finding\(s\) suppressed/);
});

test('a baselined rule that hid nothing is reported as clearable', () => {
  // The count is the signal for deleting an entry; a rule at 0 is already
  // clear, and leaving it in hides the next regression behind it.
  const out = summarize(report({ 'https://s.example/a': [] }), { baseline: ['frame-title'] });
  assert.equal(out.ok, true);
  assert.match(out.body, /\| `frame-title` \| 0 \(clear it\) \|/);
});

test('no baseline means no disclosure block and no over-claim', () => {
  const out = summarize(report({ 'https://s.example/a': [] }));
  assert.ok(!out.body.includes('Baseline active'));
  assert.match(out.body, /axe runner, plus `target-size`/);
});

test('the target-size claim is qualified while target-size is baselined', () => {
  // The over-claim this disclosure exists to stop: advertising the 44x44
  // project rule as gating while it sits in the baseline.
  const out = summarize(report({ 'https://s.example/a': [] }), { baseline: ['target-size'] });
  assert.ok(!out.body.includes('plus `target-size`'));
  assert.match(out.body, /`target-size` is enabled but baselined/);
});

test('baseline matching is case-insensitive, like pa11y\'s own ignore was', () => {
  const out = summarize(
    report({ 'https://s.example/a': [issue({ code: 'Color-Contrast' })] }),
    { baseline: ['COLOR-CONTRAST'] }
  );
  assert.equal(out.errors, 0);
  assert.equal(out.suppressed, 1);
});

test('the per-URL table carries a suppressed column', () => {
  const out = summarize(
    report({ 'https://s.example/a': [issue(), issue({ code: 'link-name' })] }),
    { baseline: ['color-contrast'] }
  );
  assert.match(out.body, /\| Page \| Errors \| Suppressed \|/);
  assert.match(out.body, /\| `\/a` \| 1 ❌ \| 1 \|/);
});

test('the committed baseline parses and normalises', () => {
  const committed = loadBaseline();
  assert.ok(Array.isArray(committed) && committed.length > 0);
  assert.ok(committed.every((c) => typeof c === 'string' && c === c.toLowerCase()));
});

test('a malformed baseline is a hard error, never a silent no-op', () => {
  // One that ignored nothing would fail every run loudly; one that silently
  // ignored EVERYTHING would hide every regression.
  assert.throws(() => normaliseBaseline({}), /baseline/);
  assert.throws(() => normaliseBaseline({ ignore: 'color-contrast' }), /baseline/);
  assert.throws(() => normaliseBaseline({ ignore: ['ok', ''] }), /baseline/);
  assert.deepEqual(normaliseBaseline({ ignore: ['Color-Contrast'] }), ['color-contrast']);
});

// ── Untestable URLs ────────────────────────────────────────────────

test('a URL pa11y-ci could not test at all fails, and is not counted as a pass', () => {
  // pa11y-ci stores a caught exception as that URL's whole result array, and
  // an Error serialises to `{}`. A `type === 'error'` filter saw zero issues
  // and greened the page; with the baseline moved out of pa11y, the exit code
  // no longer catches it either.
  const out = summarize(report({ 'https://s.example/a': [{}], 'https://s.example/b': [] }), { exitCode: 2 });
  assert.equal(out.ok, false);
  assert.equal(out.malformed, 1);
  assert.equal(out.passes, 1, 'only /b passed');
  assert.match(out.reason, /could not be tested/);
  assert.match(out.body, /could not be tested at all/);
  assert.match(out.body, /⚠️ untested/);
});

// ── Sanitisation and bounds ────────────────────────────────────────

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

test('a page-derived rule id cannot forge a row in the suppressed table', () => {
  // The baseline table prints codes that came off the page, so they go through
  // the same sanitiser as every other page-derived field.
  const out = summarize(
    report({ 'https://s.example/a': [issue({ code: 'x|</details>```' })] }),
    { baseline: ['x|</details>```'] }
  );
  assert.ok(!out.body.includes('</details>```'));
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

test('suppressed findings do not consume the per-URL display budget', () => {
  // The whole point of the move: the per-URL cap used to be spent on baselined
  // noise, which is how three baselined rules stayed hidden for a whole PR.
  const out = summarize(
    report({ 'https://s.example/a': [...Array.from({ length: 40 }, () => issue()), issue({ code: 'link-name' })] }),
    { baseline: ['color-contrast'] }
  );
  assert.equal(out.errors, 1);
  assert.match(out.body, /link-name/);
  assert.ok(!out.body.includes('and 30 more'));
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

test('a non-array results entry is untested, not empty', () => {
  // It used to fall back to [] and score as a clean pass. That was survivable
  // only while pa11y-ci's exit code caught it independently; it no longer does.
  const out = summarize(report({ 'https://s.example/a': null, 'https://s.example/b': [issue()] }));
  assert.equal(out.ok, false);
  assert.equal(out.malformed, 1);
  assert.equal(out.errors, 1);
  assert.equal(out.total, 2);
  assert.match(out.reason, /could not be tested/);
});
