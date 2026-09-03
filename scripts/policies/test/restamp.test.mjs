// scripts/policies/restamp.mjs: the counterpart to pull, for a deliberate LOCAL wording edit.
//
// It owns two derived things: the manifest's version and hashes, and the version stamp on the
// first line of each stamped body. It touches nothing else, and in particular it never reads or
// writes the machine-local observation state: a local edit says nothing about what Admin holds.
//
// The property that matters most is what a green `check` after a restamp does NOT mean. It proves
// the repo agrees with itself and nothing at all about the live store, which is how a merged
// wording change gets declared done while customers still read the old text.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { check } from '../check.mjs';
import { main, restampManifest } from '../restamp.mjs';
import { extractHeadings, fileNameForType, fileTextFor, formatManifest, sha256 } from '../lib/policies.mjs';
import {
  BODIES,
  assertTreeUnchanged,
  cleanup,
  makeRoot,
  policiesDir,
  readManifestRaw,
  readPolicy,
  snapshotTree,
  writeRaw,
  writtenBodyFor,
} from './helpers.mjs';

function manifestOf(root) {
  return JSON.parse(readManifestRaw(root));
}

function bodiesFrom(overrides = {}) {
  return new Map(Object.entries({ ...BODIES, ...overrides }));
}

test('restamp bumps the version, restamps the body, and rewrites both hashes', () => {
  const root = makeRoot();
  try {
    const editedCore = `${BODIES.SHIPPING_POLICY}\n<p>Most orders ship within 3-5 business days.</p>`;
    const onDisk = `<!-- sss-policy shipping_policy v1 -->\n${editedCore}`;
    writeRaw(root, fileNameForType('SHIPPING_POLICY'), fileTextFor(onDisk));

    const { manifest, changes, anchorChanges, bodyRewrites } = restampManifest(
      manifestOf(root),
      bodiesFrom({ SHIPPING_POLICY: onDisk }),
    );
    const entry = manifest.policies.shipping_policy;
    const expected = `<!-- sss-policy shipping_policy v2 -->\n${editedCore}`;

    assert.equal(entry.version, 2, 'a changed core must bump the version by exactly one');
    assert.equal(entry.coreSha256, sha256(editedCore));
    assert.equal(entry.sha256, sha256(expected));
    assert.equal(entry.length, expected.length);
    assert.equal(bodyRewrites.get('SHIPPING_POLICY'), expected, 'the stamp on disk must be rewritten to v2');
    assert.ok(changes.some((c) => c.includes('restamped to v2')));
    assert.deepEqual(anchorChanges, [], 'a body edit with no heading change reported an anchor change');
  } finally {
    cleanup(root);
  }
});

test('restamp does NOT bump when only the stamp differs: that is the same wording', () => {
  // A stamp is presentation. If the version bumped on a restamp of an unchanged core, every run
  // would mint a new version and the number would stop meaning anything.
  const root = makeRoot();
  try {
    const { manifest, changes, bodyRewrites } = restampManifest(manifestOf(root), bodiesFrom({
      SHIPPING_POLICY: `<!-- sss-policy shipping_policy v9 -->\n${BODIES.SHIPPING_POLICY}`,
    }));
    assert.equal(manifest.policies.shipping_policy.version, 1);
    assert.equal(bodyRewrites.get('SHIPPING_POLICY'), `<!-- sss-policy shipping_policy v1 -->\n${BODIES.SHIPPING_POLICY}`);
    assert.deepEqual(changes.filter((c) => c.includes('version ')), []);
  } finally {
    cleanup(root);
  }
});

test('restamp is a no-op on the unstamped privacy policy, which stays unstamped', () => {
  const root = makeRoot();
  try {
    const { manifest, bodyRewrites } = restampManifest(manifestOf(root), bodiesFrom());
    assert.equal(bodyRewrites.has('PRIVACY_POLICY'), false);
    assert.equal(manifest.policies.privacy_policy.sha256, manifest.policies.privacy_policy.coreSha256);
  } finally {
    cleanup(root);
  }
});

test('restamp refuses a hand-broken version, and reports no changes at all', () => {
  const root = makeRoot();
  try {
    const manifest = manifestOf(root);
    manifest.policies.refund_policy.version = 0;
    assert.throws(() => restampManifest(manifest, bodiesFrom()), /not an integer >= 1/);
  } finally {
    cleanup(root);
  }
});

test('restamp leaves the manifest byte-identical when nothing moved', () => {
  const root = makeRoot();
  try {
    const before = readManifestRaw(root);
    const { changes, bodyRewrites } = restampManifest(manifestOf(root), bodiesFrom({
      CONTACT_INFORMATION: writtenBodyFor('CONTACT_INFORMATION'),
      PRIVACY_POLICY: writtenBodyFor('PRIVACY_POLICY'),
      REFUND_POLICY: writtenBodyFor('REFUND_POLICY'),
      SHIPPING_POLICY: writtenBodyFor('SHIPPING_POLICY'),
      TERMS_OF_SERVICE: writtenBodyFor('TERMS_OF_SERVICE'),
    }));
    assert.deepEqual(changes, []);
    assert.equal(bodyRewrites.size, 0);
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

test('restamp then check is clean; check is SILENT about the live store, which is the trap', () => {
  // The merged-but-not-pushed state. `check` is green here and proves only that the repo agrees
  // with itself; a wording change reaches customers through a separately authorized push, and
  // `policies:status` is the command that says so. Reading this green as "done" is exactly how a
  // policy change gets declared finished while customers still read the old text.
  const root = makeRoot();
  try {
    const editedCore = `${BODIES.SHIPPING_POLICY}\n<p>edited locally</p>`;
    writeRaw(root, fileNameForType('SHIPPING_POLICY'), fileTextFor(`<!-- sss-policy shipping_policy v1 -->\n${editedCore}`));
    assert.ok(check(root).mismatches.length > 0, 'the edit should be a mismatch before restamping');

    const { manifest, bodyRewrites } = restampManifest(manifestOf(root), bodiesFrom({
      SHIPPING_POLICY: `<!-- sss-policy shipping_policy v1 -->\n${editedCore}`,
    }));
    writeRaw(root, 'manifest.json', formatManifest(manifest));
    writeRaw(root, fileNameForType('SHIPPING_POLICY'), fileTextFor(bodyRewrites.get('SHIPPING_POLICY')));

    const { problems, mismatches, notes } = check(root);
    assert.deepEqual(problems, []);
    assert.deepEqual(mismatches, []);
    assert.deepEqual(notes, [], 'check must say nothing about the live store; it cannot know');
  } finally {
    cleanup(root);
  }
});

test('restamp updates entries by assignment, so manifest key order never churns', () => {
  const root = makeRoot();
  try {
    const before = Object.keys(manifestOf(root).policies.shipping_policy);
    const edited = `<!-- sss-policy shipping_policy v1 -->\n${BODIES.SHIPPING_POLICY}\n<p>x</p>`;
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

// ---------------------------------------------------------------------------------------------
// The CLI, in both directions
// ---------------------------------------------------------------------------------------------

/** Run `main` against a scratch root, capturing everything it prints. */
function runMain(root, extraArgs = []) {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (s) => out.push(String(s));
  console.error = (s) => err.push(String(s));
  try {
    const code = main(['node', 'restamp.mjs', '--root', root, ...extraArgs]);
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test('--check on a clean tree reports no change, exits 0, and writes nothing', () => {
  const root = makeRoot();
  try {
    const before = snapshotTree(policiesDir(root));
    const { code, out } = runMain(root, ['--check']);
    assert.equal(code, 0);
    assert.match(out, /already match the committed bodies/);
    assertTreeUnchanged(assert, before, snapshotTree(policiesDir(root)), '--check wrote something on a clean tree');
  } finally {
    cleanup(root);
  }
});

test('--check on a DIRTIED body reports the change, exits 2, and still writes nothing', () => {
  // The negative control. Without it, a --check that always reported "clean" would pass the test
  // above and prove nothing at all.
  const root = makeRoot();
  try {
    const edited = `<!-- sss-policy shipping_policy v1 -->\n${BODIES.SHIPPING_POLICY}\n<p>a wording edit</p>`;
    writeRaw(root, fileNameForType('SHIPPING_POLICY'), fileTextFor(edited));
    const before = snapshotTree(policiesDir(root));

    const { code, out } = runMain(root, ['--check']);
    assert.equal(code, 2, '--check must exit 2 when something would change');
    assert.match(out, /restamped to v2/);
    assert.match(out, /nothing written/);
    assertTreeUnchanged(assert, before, snapshotTree(policiesDir(root)), '--check wrote something');
  } finally {
    cleanup(root);
  }
});

test('a bare restamp writes the manifest AND the body, and leaves check clean', () => {
  const root = makeRoot();
  try {
    const edited = `<!-- sss-policy shipping_policy v1 -->\n${BODIES.SHIPPING_POLICY}\n<p>a wording edit</p>`;
    writeRaw(root, fileNameForType('SHIPPING_POLICY'), fileTextFor(edited));

    const { code, out } = runMain(root);
    assert.equal(code, 0);
    assert.match(out, /wrote manifest\.json and 1 body file/);
    assert.match(out, /It says NOTHING about the live store/, 'the merged-but-not-pushed trap must be named');
    assert.match(out, /policies:status/);

    assert.equal(readPolicy(root, 'SHIPPING_POLICY').startsWith('<!-- sss-policy shipping_policy v2 -->\n'), true);
    const { problems, mismatches } = check(root);
    assert.deepEqual(problems, []);
    assert.deepEqual(mismatches, []);
  } finally {
    cleanup(root);
  }
});

test('a refusal from the version derivation leaves the tree byte-identical', () => {
  const root = makeRoot();
  try {
    const manifest = manifestOf(root);
    manifest.policies.refund_policy.version = '2';
    writeRaw(root, 'manifest.json', formatManifest(manifest));
    const before = snapshotTree(policiesDir(root));

    const { code, err } = runMain(root);
    assert.equal(code, 1);
    assert.match(err, /not an integer >= 1/);
    assert.match(err, /nothing written/);
    assertTreeUnchanged(assert, before, snapshotTree(policiesDir(root)), 'a refused restamp wrote something');
  } finally {
    cleanup(root);
  }
});

test('an unusable body refuses before rewriting anything', () => {
  const root = makeRoot();
  try {
    writeRaw(root, fileNameForType('SHIPPING_POLICY'), '<p>a\r\nCRLF body</p>\n');
    const before = snapshotTree(policiesDir(root));
    const { code, err } = runMain(root);
    assert.equal(code, 1);
    assert.match(err, /carriage return|canonical form/);
    assertTreeUnchanged(assert, before, snapshotTree(policiesDir(root)), 'a refused restamp wrote something');
  } finally {
    cleanup(root);
  }
});
