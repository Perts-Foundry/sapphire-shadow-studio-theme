import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { validateRisks, adjudicate } from '../lib/risks.mjs';
import { PATHS } from '../check-contrast.mjs';

const risk = (over = {}) => ({
  source: 'current',
  scheme: 'scheme-1',
  pair: 'foreground on background',
  ratio: 2.5,
  note: 'a sufficiently long explanation of why this is acceptable',
  accepted_on: '2026-08-16',
  ...over,
});

const result = (over = {}) => ({
  source: 'current',
  scheme: 'scheme-1',
  pair: 'foreground on background',
  kind: 'text',
  ratio: 2.5,
  threshold: 4.5,
  pass: false,
  ...over,
});

test('the committed accepted-risks.json is valid', () => {
  const raw = JSON.parse(readFileSync(PATHS.acceptedRisks, 'utf8'));
  assert.deepEqual(validateRisks(raw), []);
});

test('validateRisks demands a real note on every entry', () => {
  // A baseline whose entries carry no reason is a rubber stamp, not a record.
  assert.ok(validateRisks([risk({ note: 'nope' })]).some((p) => p.includes('note')));
  assert.ok(validateRisks([risk({ note: '' })]).some((p) => p.includes('note')));
  assert.ok(validateRisks([risk({ note: undefined })]).some((p) => p.includes('note')));
});

test('validateRisks rejects malformed keys, ratios and dates', () => {
  assert.ok(validateRisks([risk({ scheme: '' })]).some((p) => p.includes('scheme')));
  assert.ok(validateRisks([risk({ ratio: 'two' })]).some((p) => p.includes('ratio')));
  assert.ok(validateRisks([risk({ ratio: NaN })]).some((p) => p.includes('ratio')));
  assert.ok(validateRisks([risk({ accepted_on: '16-08-2026' })]).some((p) => p.includes('accepted_on')));
  assert.ok(validateRisks(['not an object']).length > 0);
  assert.ok(validateRisks({}).length > 0, 'must be an array');
});

test('validateRisks catches duplicate entries', () => {
  assert.ok(validateRisks([risk(), risk()]).some((p) => p.includes('duplicate')));
  assert.deepEqual(validateRisks([risk(), risk({ scheme: 'scheme-2' })]), []);
});

test('a matching risk suppresses the failure', () => {
  const out = adjudicate([result()], [risk()]);
  assert.deepEqual(out.failures, []);
  assert.equal(out.accepted, 1);
  assert.deepEqual(out.baselineProblems, []);
});

test('an unbaselined failure survives', () => {
  const out = adjudicate([result()], []);
  assert.equal(out.failures.length, 1);
  assert.equal(out.accepted, 0);
});

test('RATCHET: a baselined pair getting worse fails', () => {
  // Accepting "2.5:1 today" must not also accept 1.2:1 tomorrow.
  const out = adjudicate([result({ ratio: 1.2 })], [risk({ ratio: 2.5 })]);
  assert.equal(out.baselineProblems.length, 1);
  assert.match(out.baselineProblems[0].reason, /regressed to 1\.2:1, below the accepted 2\.5:1/);
  assert.equal(out.accepted, 0);
});

test('RATCHET: an equal or improved-but-still-failing ratio stays accepted', () => {
  assert.equal(adjudicate([result({ ratio: 2.5 })], [risk({ ratio: 2.5 })]).accepted, 1);
  assert.equal(adjudicate([result({ ratio: 3.9 })], [risk({ ratio: 2.5 })]).accepted, 1);
});

test('SELF-CLEARING: a baselined pair that now passes is reported stale', () => {
  const out = adjudicate([result({ ratio: 7, pass: true })], [risk()]);
  assert.equal(out.stale.length, 1);
  assert.equal(out.stale[0].ratio, 7);
  assert.deepEqual(out.failures, []);
});

test('a risk matching no checked pair is a hard problem, not a silent no-op', () => {
  // A typo'd scheme name would otherwise look like a granted exception while
  // suppressing nothing at all.
  const out = adjudicate([result()], [risk({ scheme: 'scheme-typo' })]);
  assert.equal(out.baselineProblems.length, 1);
  assert.match(out.baselineProblems[0].reason, /matches no checked pair/);
});

test('indeterminate results are neither accepted, failed nor reported stale', () => {
  const out = adjudicate([result({ indeterminate: true, pass: true })], []);
  assert.deepEqual(out.failures, []);
  assert.deepEqual(out.stale, []);
  assert.equal(out.accepted, 0);
});

test('a passing pair with no risk is entirely quiet', () => {
  const out = adjudicate([result({ ratio: 9, pass: true })], []);
  assert.deepEqual(out, { failures: [], baselineProblems: [], stale: [], accepted: 0 });
});
