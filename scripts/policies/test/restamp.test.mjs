// scripts/policies/restamp.mjs: the counterpart to pull, for a deliberate LOCAL wording edit.
//
// The property that matters most is what it does NOT touch. `remote` and `pulledAt` must survive,
// because they are what says Admin has not received the edit yet: `check` reads them to report an
// outstanding push, and push's freshness gate reads `remote.sha256` to refuse a clobber.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { check } from '../check.mjs';
import { restampManifest } from '../restamp.mjs';
import { extractHeadings, fileNameForType, fileTextFor, formatManifest, sha256 } from '../lib/policies.mjs';
import { BODIES, cleanup, makeRoot, readManifestRaw, writeRaw } from './helpers.mjs';

function manifestOf(root) {
  return JSON.parse(readManifestRaw(root));
}

function bodiesFrom(overrides = {}) {
  return new Map(Object.entries({ ...BODIES, ...overrides }));
}

test('restamp updates sha256 and length and leaves remote and pulledAt alone', () => {
  const root = makeRoot();
  try {
    const edited = `${BODIES.SHIPPING_POLICY}\n<p>Most orders ship within 3–5 business days.</p>`;
    writeRaw(root, fileNameForType('SHIPPING_POLICY'), fileTextFor(edited));
    const before = manifestOf(root);

    const { manifest, changes, anchorChanges } = restampManifest(manifestOf(root), bodiesFrom({ SHIPPING_POLICY: edited }));
    const entry = manifest.policies.shipping_policy;

    assert.equal(entry.sha256, sha256(edited));
    assert.equal(entry.length, edited.length);
    assert.deepEqual(entry.remote, before.policies.shipping_policy.remote, 'remote moved');
    assert.equal(entry.pulledAt, before.policies.shipping_policy.pulledAt, 'pulledAt moved');
    assert.equal(changes.length, 2);
    assert.deepEqual(anchorChanges, [], 'a body edit with no heading change reported an anchor change');
  } finally {
    cleanup(root);
  }
});

test('restamp leaves the manifest byte-identical when nothing moved', () => {
  const root = makeRoot();
  try {
    const before = readManifestRaw(root);
    const { changes } = restampManifest(manifestOf(root), bodiesFrom());
    assert.deepEqual(changes, []);
    assert.equal(readManifestRaw(root), before, 'restampManifest wrote to disk; it must be pure');
  } finally {
    cleanup(root);
  }
});

test('a heading change is reported as an anchor change and the headings are rewritten', () => {
  const root = makeRoot();
  try {
    const reworded = BODIES.REFUND_POLICY.replace('<h2>Returns</h2>', '<h2>Returns and Exchanges</h2>');
    const { manifest, anchorChanges } = restampManifest(manifestOf(root), bodiesFrom({ REFUND_POLICY: reworded }));
    assert.equal(anchorChanges.length, 1);
    assert.ok(anchorChanges[0].includes('anchor'));
    assert.deepEqual(manifest.policies.refund_policy.headings, extractHeadings(reworded));
    assert.equal(manifest.policies.refund_policy.headings[0].id, 'returns-and-exchanges');
  } finally {
    cleanup(root);
  }
});

test('restamp then check is clean, and check reports the outstanding push', () => {
  const root = makeRoot();
  try {
    const edited = `${BODIES.SHIPPING_POLICY}\n<p>edited locally</p>`;
    writeRaw(root, fileNameForType('SHIPPING_POLICY'), fileTextFor(edited));
    assert.ok(check(root).mismatches.length > 0, 'the edit should be a mismatch before restamping');

    const { manifest } = restampManifest(manifestOf(root), bodiesFrom({ SHIPPING_POLICY: edited }));
    writeRaw(root, 'manifest.json', formatManifest(manifest));

    const { problems, mismatches, notes } = check(root);
    assert.deepEqual(problems, []);
    assert.deepEqual(mismatches, []);
    assert.ok(
      notes.some((n) => n.includes('a push is outstanding') && n.includes('--type shipping_policy')),
      'restamping must leave check saying a push is outstanding',
    );
  } finally {
    cleanup(root);
  }
});

test('restamp updates entries by assignment, so manifest key order never churns', () => {
  const root = makeRoot();
  try {
    const before = Object.keys(manifestOf(root).policies.shipping_policy);
    const edited = `${BODIES.SHIPPING_POLICY}\n<p>x</p>`;
    const { manifest } = restampManifest(manifestOf(root), bodiesFrom({ SHIPPING_POLICY: edited }));
    assert.deepEqual(Object.keys(manifest.policies.shipping_policy), before);
  } finally {
    cleanup(root);
  }
});

test('restamp.mjs is offline: it imports nothing that can reach the network', () => {
  const source = readFileSync(new URL('../restamp.mjs', import.meta.url), 'utf8');
  assert.equal(/from '(node:https?|.*blank-inventory.*|.*site-check.*)'/.test(source), false);
  assert.equal(/\bfetch\s*\(/.test(source), false);
});

test('no workflow wires policies:restamp either', () => {
  // It writes to the tree. CI checks, it does not fix.
  const dir = new URL('../../../.github/workflows/', import.meta.url);
  for (const name of readdirSync(dir)) {
    const text = readFileSync(new URL(name, dir), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    assert.equal(text.includes('policies:restamp'), false, `${name} invokes policies:restamp`);
  }
});
