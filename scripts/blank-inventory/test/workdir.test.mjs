// Containment of the working directory, and the blank-id guard's coverage of it.
//
// These are regression tests for a real leak: a cwd-relative working directory created
// `scripts/blank-inventory/.blank-inventory/` (outside a root-anchored ignore pattern) holding an
// artifact with real blank ids, in a public repo, while the guard's SKIP pattern exempted that
// directory at any depth. Each assertion below pins one link of that chain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { defaultWorkDir, resolveWorkDir, findOrphanWorkDir, WORK_DIR_BASENAME } from '../lib/workdir.mjs';
import {
  findSuspectTokens, sizeAlternation, segmentsFromManifest, LEGACY_SIZE_TOKENS, ALLOWED_SEGMENTS,
} from '../check-no-real-blank-ids.mjs';
import { parseCatalogue, CATALOGUE_PATH } from '../../lib/catalogue-manifest.mjs';

const MANIFEST = parseCatalogue(readFileSync(new URL(`../../../${CATALOGUE_PATH}`, import.meta.url), 'utf8'));

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

test('the default working directory is outside the repository', () => {
  const dir = defaultWorkDir({ HOME: os.homedir() });
  assert.ok(path.isAbsolute(dir), 'must be absolute');
  assert.ok(
    !path.resolve(dir).startsWith(REPO_ROOT + path.sep),
    `default work dir ${dir} must not sit inside the checkout at ${REPO_ROOT}: artifacts hold real blank ids and this repo is public`
  );
});

test('defaultWorkDir honours XDG_STATE_HOME when it is absolute', () => {
  const dir = defaultWorkDir({ XDG_STATE_HOME: '/var/tmp/state' });
  assert.equal(dir, path.join('/var/tmp/state', 'blank-inventory'));
});

test('defaultWorkDir ignores a relative XDG_STATE_HOME rather than resolving it against cwd', () => {
  // A relative value here would reintroduce cwd dependence, which is the whole bug.
  const dir = defaultWorkDir({ XDG_STATE_HOME: 'relative/state' });
  assert.ok(path.isAbsolute(dir));
  assert.ok(!dir.includes('relative/state'));
});

test('BLANK_INVENTORY_DIR overrides and is resolved to an absolute path', () => {
  const dir = resolveWorkDir({ BLANK_INVENTORY_DIR: '/tmp/bi-override' });
  assert.equal(dir, '/tmp/bi-override');
});

test('a relative BLANK_INVENTORY_DIR is made absolute, never left cwd-relative', () => {
  const dir = resolveWorkDir({ BLANK_INVENTORY_DIR: './some/where' });
  assert.ok(path.isAbsolute(dir), 'an override must not stay relative');
  assert.equal(dir, path.resolve('./some/where'));
});

test('an empty BLANK_INVENTORY_DIR falls back to the default rather than resolving to cwd', () => {
  assert.equal(resolveWorkDir({ BLANK_INVENTORY_DIR: '   ' }), defaultWorkDir({}));
});

test('findOrphanWorkDir flags a stray directory under a different cwd', () => {
  const resolved = '/home/someone/.local/state/blank-inventory';
  const orphan = findOrphanWorkDir('/repo/scripts/blank-inventory', resolved);
  assert.equal(orphan, path.join('/repo/scripts/blank-inventory', WORK_DIR_BASENAME));
});

test('findOrphanWorkDir returns null when cwd already holds the resolved work dir', () => {
  const resolved = path.join('/repo', WORK_DIR_BASENAME);
  assert.equal(findOrphanWorkDir('/repo', resolved), null);
});

// --- guard coverage -------------------------------------------------------

test('the guard module imports cleanly with no entry script', () => {
  // Regression: the main-detection dereferenced process.argv[1], which is undefined under import(),
  // so the module threw on import and none of its logic could be unit-tested.
  assert.equal(typeof findSuspectTokens, 'function');
});

// Suspect tokens are ASSEMBLED here, never written as literals. A complete blank-id-shaped string
// with a non-allowlisted segment is exactly what the guard exists to reject, so spelling one out in
// this file would make the guard fail on its own test suite. The brand words below are invented.
const suspect = (...segments) => segments.join('_');

test('the guard flags a supplier-encoding blank id', () => {
  const token = suspect('BLACK', 'SUPPLIER' + 'NAME', '1234', 'M');
  assert.deepEqual(findSuspectTokens(token), [token]);
});

test('a numeric style segment alone does NOT make an id suspect', () => {
  // Pins the guard's real discriminator: numeric segments are exempt, so detection rests entirely
  // on supplier NAME tokens. Any future widening of ALLOWED_SEGMENTS must preserve this.
  assert.deepEqual(findSuspectTokens('BLACK_BLANK_1234_M'), []);
});

test('the synthetic fixture vocabulary is not flagged', () => {
  assert.deepEqual(findSuspectTokens('BLACK_ACME_FLEECE_M and GREY_ACME_FLEECE_2XL'), []);
});

test('a garment-coded id passes, so the migration can be documented in-repo', () => {
  // Before the allowlist was widened these failed CI, which meant the intended re-tagging scheme
  // could never appear in a doc or a fixture.
  assert.deepEqual(findSuspectTokens('BLACK_CREWNECK_0001_M'), []);
  assert.deepEqual(findSuspectTokens('NAVY_QUARTERZIP_0002_2XL'), []);
  assert.deepEqual(findSuspectTokens('GREY_VEST_WOMENS_0003_L'), []);
});

test('a supplier-SHAPED id still fails after the widening', () => {
  // The mandatory negative. Detection rests entirely on supplier NAME tokens (numeric segments are
  // exempt), so the widening is only safe while a made-up brand word is still caught. If this ever
  // goes green, the allowlist has swallowed the discriminator and the guard detects nothing.
  for (const token of [
    suspect('BLACK', 'NORTH' + 'RIDGE', 'CREWNECK', '0001', 'M'),
    suspect('NAVY', 'VEST', 'WOMENS', 'MILLCO' + 'APPAREL', 'L'),
  ]) {
    assert.deepEqual(findSuspectTokens(token), [token], `${token} must still be caught`);
  }
});

test('no allowlisted segment reads as a company name', () => {
  // Structural restatement of the widening rule: every token is a colour, a garment, a fit, a
  // structural placeholder, or the synthetic fixture vocabulary. A reviewer adding a supplier-ish
  // word has to delete this test to do it.
  const src = readFileSync(new URL('../check-no-real-blank-ids.mjs', import.meta.url), 'utf8');
  const rule = src.match(/THE POSITIVE-DETECTION RULE[\s\S]*?const ALLOWED_SEGMENTS/)?.[0] ?? '';
  assert.match(rule, /could never be a supplier's name/);
});

// --- the manifest union ----------------------------------------------------
//
// The guard's size alternation and allowlist are now the hand-curated lists UNIONED with what
// catalogue.json declares. `blank-inventory:guard` printing "scanned N file(s)" says nothing about
// detection POWER: a union that silently degraded into a replacement would print the same line and
// still exit 0, which is exactly the mistake these tests exist to prevent.
//
// Synthetic vocabulary only below, per the file's own rule and CLAUDE.md.

test('the size union never NARROWS: a legacy-only size is still detected', () => {
  // The mandatory negative. The committed manifest declares six sizes and no 3XL, so a derived
  // (rather than unioned) alternation would drop it and a real blank id ending _3XL would sail
  // through. Asserted through the live guard, not a helper, so it covers the wiring too.
  const token = suspect('BLACK', 'NORTH' + 'RIDGE', 'CREWNECK', '0001', '3XL');
  assert.deepEqual(findSuspectTokens(token), [token], '_3XL must still be a detectable ending');
  assert.deepEqual(sizeAlternation(['m', 'l']), sizeAlternation([]), 'a narrow manifest adds nothing and removes nothing');
  for (const legacy of LEGACY_SIZE_TOKENS) {
    assert.ok(sizeAlternation(['m']).includes(legacy), `${legacy} survives a manifest that omits it`);
  }
});

test('the size union does ADD: a manifest-only size becomes detectable', () => {
  const widened = sizeAlternation(['6xl']);
  assert.ok(widened.includes('6XL'));
  assert.ok(LEGACY_SIZE_TOKENS.every((s) => widened.includes(s)));
  // Longest-first, so the alternation stays greedy-correct: 2XL must be tried before L.
  const lengths = widened.map((s) => s.length);
  assert.deepEqual(lengths, [...lengths].sort((a, b) => b - a));
});

test('the allowlist union does ADD: a manifest-only colour and body word become allowed', () => {
  const synthetic = {
    bodies: new Map([['sample-longsleeve', { colors: ['forest green'], sizes: ['m'] }]]),
  };
  const segments = segmentsFromManifest(synthetic);
  // Split and flattened forms both, because a blank id may join the words either way.
  for (const token of ['FOREST', 'GREEN', 'FORESTGREEN', 'SAMPLE', 'LONGSLEEVE', 'SAMPLELONGSLEEVE']) {
    assert.ok(segments.includes(token), `${token} should be derived`);
  }
  // A digit-leading word is a legal non-leading blank-id segment, so it has to be derived too;
  // dropping it would trip the guard on the very fixture that uses the new body.
  assert.ok(
    segmentsFromManifest({ bodies: new Map([['tee-2pack', { colors: ['black'], sizes: ['m'] }]]) }).includes('2PACK'),
    '2PACK should be derived from tee-2pack'
  );
  // And the live manifest's own vocabulary really is in the allowlist the guard uses.
  const live = segmentsFromManifest(MANIFEST);
  assert.ok(live.length > 5, 'the live derivation must be non-empty, or the loop below is vacuous');
  for (const token of live) {
    assert.ok(ALLOWED_SEGMENTS.has(token), `${token} should have been unioned in`);
  }
});

test('a manifest size carrying punctuation cannot corrupt the detection regex', () => {
  // These tokens are interpolated into a RegExp source. normaliseAxis lowercases and trims but does
  // not restrict characters, so parseCatalogue would accept both of these. Unfiltered, the first
  // throws a SyntaxError at module load and takes the whole guard down, and the second compiles and
  // silently changes what the alternation matches. Neither could ever be a blank-id segment, so both
  // are dropped.
  for (const hostile of ['3xl(tall', 's?', 'm|xl', '2xl.*']) {
    const tokens = sizeAlternation([hostile]);
    assert.deepEqual(tokens, sizeAlternation([]), `${hostile} must be dropped, not carried through`);
    assert.doesNotThrow(() => new RegExp(`(?:${tokens.join('|')})`), `${hostile} must not break the regex`);
  }
  // And a well-formed manifest size is still added, so the filter is not just rejecting everything.
  assert.ok(sizeAlternation(['6xl']).includes('6XL'));
});

test('the allowlist union never NARROWS: the hand-curated tokens all survive it', () => {
  // The allowlist's own negative, matching the size union's. A union that degraded into a
  // replacement would drop every synthetic fixture token, and the fixture suite would start failing
  // the guard rather than the guard failing a test, which reads as an unrelated breakage.
  for (const token of ['ACME', 'BLANKA', 'BLANKB', 'GRAY', 'WHITE', 'HOODIE', 'SUPPLIER', 'QUARTERZIP']) {
    assert.ok(ALLOWED_SEGMENTS.has(token), `${token} is hand-curated and must survive the union`);
  }
});

test('no manifest-derived token can blind the detector', () => {
  // The collision check. Widening an allowlist is only safe while the added tokens cannot themselves
  // form, or launder, a blank-id shape. A derived token is a single word with no underscore, so it
  // is never an id on its own, and an id that also carries a non-vocabulary segment still fails.
  const live = segmentsFromManifest(MANIFEST);
  assert.ok(live.length > 5, 'the live derivation must be non-empty, or this loop is vacuous');
  for (const token of live) {
    assert.ok(!token.includes('_'), `${token} must not itself be underscore-separated`);
    assert.deepEqual(findSuspectTokens(token), [], `${token} alone is not a blank id`);
    const laundered = suspect('BLACK', token, 'MILLCO' + 'APPAREL', '0001', 'M');
    assert.deepEqual(findSuspectTokens(laundered), [laundered], `${token} must not launder a supplier token`);
  }
});

test('the guard no longer exempts a .blank-inventory path at any depth', async () => {
  // The load-bearing fix. Previously SKIP matched `.blank-inventory/` anywhere, so the one
  // directory guaranteed to hold real blank ids was never scanned.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../check-no-real-blank-ids.mjs', import.meta.url), 'utf8');
  const skipLine = src.match(/^const SKIP = .*$/m)?.[0] ?? '';
  assert.ok(skipLine.length > 0, 'SKIP pattern should still exist');
  assert.ok(
    !skipLine.includes('blank-inventory'),
    'SKIP must not exempt the working directory; a leak detector that fails open on its highest-risk input is worse than none'
  );
});
