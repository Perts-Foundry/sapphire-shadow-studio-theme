// scripts/policies/lib/diff.mjs: the unified diff the push dry run shows the operator, and the
// entity/whitespace predicate that decides whether a write-back may ever be accepted.

import test from 'node:test';
import assert from 'node:assert/strict';

import { diffLines, differsOnlyByEntitiesAndWhitespace, unifiedDiff } from '../lib/diff.mjs';
import { decodeEntities } from '../lib/policies.mjs';

test('identical texts produce an empty diff', () => {
  assert.equal(unifiedDiff('a\nb\nc', 'a\nb\nc'), '');
});

test('diffLines marks kept, removed and added lines in output order', () => {
  const edits = diffLines(['a', 'b', 'c'], ['a', 'x', 'c']);
  assert.deepEqual(edits.map((e) => `${e.op}${e.line}`), [' a', '-b', '+x', ' c']);
});

test('a one-line change appears with context and a hunk header', () => {
  const a = ['1', '2', '3', 'old', '5', '6', '7'].join('\n');
  const b = ['1', '2', '3', 'new', '5', '6', '7'].join('\n');
  const out = unifiedDiff(a, b, { aLabel: 'live', bLabel: 'repo' });
  assert.ok(out.startsWith('--- live\n+++ repo\n@@ '));
  assert.ok(out.includes('-old'));
  assert.ok(out.includes('+new'));
  assert.ok(out.includes(' 3'));
  assert.equal(out.includes('1\n'), true);
  assert.equal(out.endsWith('\n'), true);
});

test('two distant changes produce two hunks, not one giant one', () => {
  const a = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const b = [...a];
  b[2] = 'changed early';
  b[35] = 'changed late';
  const out = unifiedDiff(a.join('\n'), b.join('\n'));
  assert.equal(out.split('\n').filter((l) => l.startsWith('@@')).length, 2);
});

test('a pure insertion and a pure deletion both render', () => {
  assert.ok(unifiedDiff('a\nc', 'a\nb\nc').includes('+b'));
  assert.ok(unifiedDiff('a\nb\nc', 'a\nc').includes('-b'));
});

test('the diff survives an empty side', () => {
  assert.ok(unifiedDiff('', 'a').includes('+a'));
  assert.ok(unifiedDiff('a', '').includes('-a'));
});

test('the entity/whitespace predicate accepts an entity respelling and reflowed whitespace', () => {
  assert.equal(
    differsOnlyByEntitiesAndWhitespace('<p>A &amp; B</p>', '<p>A &#38; B</p>', decodeEntities),
    true,
  );
  assert.equal(
    differsOnlyByEntitiesAndWhitespace('<p>a</p>\n<p>b</p>', '<p>a</p><p>b</p>', decodeEntities),
    true,
  );
});

test('the entity/whitespace predicate rejects any content change', () => {
  assert.equal(differsOnlyByEntitiesAndWhitespace('<p>a</p>', '<p>a</p><p>b</p>', decodeEntities), false);
  assert.equal(differsOnlyByEntitiesAndWhitespace('<p>3-5 days</p>', '<p>3-6 days</p>', decodeEntities), false);
  // A changed tag is a content change, not spelling.
  assert.equal(differsOnlyByEntitiesAndWhitespace('<h2>T</h2>', '<h3>T</h3>', decodeEntities), false);
});

test('the predicate is false for identical texts, so it never explains away a non-difference', () => {
  assert.equal(differsOnlyByEntitiesAndWhitespace('<p>a</p>', '<p>a</p>', decodeEntities), false);
});

test('a large realistic body diffs in reasonable time', () => {
  const a = Array.from({ length: 800 }, (_, i) => `<p>Paragraph ${i} of the policy.</p>`).join('\n');
  const b = a.replace('Paragraph 400', 'Paragraph four hundred');
  const started = Date.now();
  const out = unifiedDiff(a, b);
  assert.ok(out.includes('four hundred'));
  assert.ok(Date.now() - started < 5000, 'the LCS table is too slow for a real policy body');
});
