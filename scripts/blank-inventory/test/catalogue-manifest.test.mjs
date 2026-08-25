import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseCatalogue,
  loadCatalogue,
  reconcileCatalogue,
  assessCatalogue,
  CATALOGUE_PATH,
  CATALOGUE_VERSION,
} from '../lib/catalogue-manifest.mjs';
import { variant, manifestDoc, manifestFor, BODIES, COLORS, SIZES } from './fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

// --- parseCatalogue: refusals -----------------------------------------------

test('parseCatalogue refuses a version it does not understand', () => {
  assert.throws(() => parseCatalogue(manifestDoc({ version: 2 })), /understands 1 only/);
  assert.throws(() => parseCatalogue(JSON.stringify({ bodies: {} })), /understands 1 only/);
  assert.equal(CATALOGUE_VERSION, 1);
});

test('parseCatalogue refuses an unnormalised body id, colour or size rather than normalising it', () => {
  assert.throws(() => parseCatalogue(manifestDoc({ bodies: { Crewneck: { colors: ['black'], sizes: ['m'] } } })), /not in normalised form/);
  assert.throws(() => parseCatalogue(manifestDoc({ bodies: { crewneck: { colors: ['Black'], sizes: ['m'] } } })), /not in normalised form/);
  assert.throws(() => parseCatalogue(manifestDoc({ bodies: { crewneck: { colors: ['black'], sizes: [' m'] } } })), /not in normalised form/);
});

test('parseCatalogue rejects a duplicate body key, which JSON.parse would silently last-wins', () => {
  const text = `{
  "version": 1,
  "bodies": {
    "crewneck": { "colors": ["black"], "sizes": ["m"] },
    "crewneck": { "colors": ["classic navy"], "sizes": ["l"] }
  }
}`;
  // JSON.parse itself is happy and takes the WRONG range, which is the whole point.
  assert.deepEqual(JSON.parse(text).bodies.crewneck.colors, ['classic navy']);
  assert.throws(() => parseCatalogue(text), /duplicate key/);
});

test('parseCatalogue rejects a repeated value inside a colors array, which the key check cannot see', () => {
  // findDuplicateKeys walks object keys; `["black", "black"]` has none, and it would otherwise
  // produce one cell twice.
  const text = manifestDoc({ bodies: { crewneck: { colors: ['black', 'black'], sizes: ['m'] } } });
  assert.throws(() => parseCatalogue(text), /lists "black" twice/);
});

test('parseCatalogue rejects a repeated value inside a sizes array', () => {
  const text = manifestDoc({ bodies: { crewneck: { colors: ['black'], sizes: ['m', 'm'] } } });
  assert.throws(() => parseCatalogue(text), /lists "m" twice/);
});

test('parseCatalogue refuses an empty colour or size list, which is a deleted body and not an empty one', () => {
  assert.throws(() => parseCatalogue(manifestDoc({ bodies: { crewneck: { colors: [], sizes: ['m'] } } })), /is empty/);
  assert.throws(() => parseCatalogue(manifestDoc({ bodies: { crewneck: { colors: ['black'], sizes: [] } } })), /is empty/);
});

test('parseCatalogue refuses a document with no bodies object at all', () => {
  assert.throws(() => parseCatalogue(JSON.stringify({ version: 1 })), /needs a "bodies" object/);
  assert.throws(() => parseCatalogue(manifestDoc({ bodies: [] })), /needs a "bodies" object/);
});

test('parseCatalogue refuses an unknown key inside a body, so a typo cannot look like a setting', () => {
  const text = manifestDoc({ bodies: { crewneck: { colors: ['black'], sizes: ['m'], typo: ['x'] } } });
  assert.throws(() => parseCatalogue(text), /unknown key\(s\): typo/);
});

test('parseCatalogue refuses an unknown top-level key, so policy cannot leak into the shape file', () => {
  const text = JSON.stringify({ version: 1, bodies: { crewneck: { colors: ['black'], sizes: ['m'] } }, budgets: { crewneck: 40 } });
  assert.throws(() => parseCatalogue(text), /unknown top-level key\(s\): budgets/);
});

test('parseCatalogue surfaces a JSON syntax error as a refusal, not a raw SyntaxError', () => {
  assert.throws(() => parseCatalogue('{ "version": 1, }}'), new RegExp(`${CATALOGUE_PATH.replace(/[/.]/g, '\\$&')} is not valid JSON`));
});

test('parseCatalogue refuses a body entry that is not an object', () => {
  assert.throws(() => parseCatalogue(manifestDoc({ bodies: { crewneck: ['black'] } })), /must be an object/);
  assert.throws(() => parseCatalogue(manifestDoc({ bodies: { crewneck: { colors: 'black', sizes: ['m'] } } })), /must be an array/);
});

// --- parseCatalogue: positive cases ------------------------------------------

test('parseCatalogue preserves colour and size declaration order, which becomes matrix row order', () => {
  const text = manifestDoc({
    bodies: {
      crewneck: { colors: ['classic navy', 'black', 'grey heather'], sizes: ['2xl', 'xs', 'm'] },
    },
  });
  const parsed = parseCatalogue(text);
  assert.deepEqual(parsed.bodies.get('crewneck').colors, ['classic navy', 'black', 'grey heather']);
  // Sizes are NOT sorted here either: buildAxes owns garment order, and this file owns the facts.
  assert.deepEqual(parsed.bodies.get('crewneck').sizes, ['2xl', 'xs', 'm']);
});

test('parseCatalogue accepts the optional comment and returns the bodies in declaration order', () => {
  const parsed = parseCatalogue(manifestDoc());
  assert.deepEqual([...parsed.bodies.keys()], ['crewneck', 'quarter-zip', 'vest-womens']);
  assert.equal(parsed.version, 1);
});

// --- loadCatalogue -----------------------------------------------------------

test('loadCatalogue turns a missing file into a refusal carrying fileMissing', async () => {
  const enoent = Object.assign(new Error('nope'), { code: 'ENOENT' });
  await assert.rejects(
    loadCatalogue({
      read: async () => {
        throw enoent;
      },
      path: 'catalogue.json',
    }),
    (err) => {
      assert.equal(err.fileMissing, true);
      assert.match(err.message, /committed at the repo root/);
      return true;
    }
  );
});

test('loadCatalogue rethrows a non-ENOENT read error as-is', async () => {
  const eacces = Object.assign(new Error('denied'), { code: 'EACCES' });
  await assert.rejects(
    loadCatalogue({
      read: async () => {
        throw eacces;
      },
    }),
    (err) => err === eacces
  );
});

test("the committed catalogue.json parses under the tool's own schema rules", async () => {
  const manifest = await loadCatalogue({ read: (p) => readFile(path.join(repoRoot, p), 'utf8') });
  assert.ok(manifest.bodies.size > 0, 'the committed manifest must declare at least one body');
  for (const [body, range] of manifest.bodies) {
    assert.ok(range.colors.length > 0, `${body} declares colours`);
    assert.ok(range.sizes.length > 0, `${body} declares sizes`);
  }
});

// --- reconcileCatalogue ------------------------------------------------------

// The real catalogue's shape: the women's vest is made in Black only.
const VEST_BLACK_ONLY = { colors: ['black'], sizes: SIZES.map((s) => s.toLowerCase()) };
const manifest = manifestFor({ 'vest-womens': VEST_BLACK_ONLY });

test('reconcileCatalogue is clean when the manifest, the body map and the store agree', () => {
  const out = reconcileCatalogue({
    manifest,
    bodyMapBodies: BODIES,
    vocab: { colors: COLORS, sizes: SIZES },
    variants: [variant({ body: 'crewneck', color: 'Black', size: 'M' })],
  });
  assert.deepEqual(out, { unknownBodies: [], unmappedBodies: [], unknownColors: [], unknownSizes: [], undeclaredVariants: [] });
  assert.equal(assessCatalogue(out).exitCode, 0);
});

test('a body declared in the manifest but absent from the approved body map refuses', () => {
  const out = reconcileCatalogue({ manifest, bodyMapBodies: ['crewneck', 'quarter-zip'], vocab: { colors: COLORS, sizes: SIZES } });
  assert.deepEqual(out.unknownBodies, ['vest-womens']);
  const assessed = assessCatalogue(out);
  assert.equal(assessed.exitCode, 1);
  assert.deepEqual(assessed.refusals.map((r) => r.code), ['catalogue-unknown-bodies']);
});

test('an approved body missing from the manifest refuses in the other direction', () => {
  const out = reconcileCatalogue({ manifest, bodyMapBodies: [...BODIES, 'hoodie'], vocab: { colors: COLORS, sizes: SIZES } });
  assert.deepEqual(out.unmappedBodies, ['hoodie']);
  const assessed = assessCatalogue(out);
  assert.equal(assessed.exitCode, 1);
  assert.deepEqual(assessed.refusals.map((r) => r.code), ['catalogue-unmapped-bodies']);
});

test('a tagged variant outside the declared shape refuses, naming the key and the count', () => {
  const out = reconcileCatalogue({
    manifest,
    bodyMapBodies: BODIES,
    vocab: { colors: COLORS, sizes: SIZES },
    variants: [
      variant({ body: 'vest-womens', color: 'Classic Navy', size: 'M' }),
      variant({ body: 'vest-womens', color: 'Classic Navy', size: 'M' }),
      variant({ body: 'crewneck', color: 'Black', size: 'M' }),
    ],
  });
  assert.deepEqual(out.undeclaredVariants, [{ key: 'vest-womens|classic navy|m', count: 2 }]);
  const assessed = assessCatalogue(out);
  assert.equal(assessed.exitCode, 1);
  assert.deepEqual(assessed.refusals.map((r) => r.code), ['catalogue-undeclared-variants']);
  assert.match(assessed.refusals[0].message, /vest-womens\|classic navy\|m \(2 variant\(s\)\)/);
});

test('an UNTAGGED variant outside the declared shape does not refuse', () => {
  // Nothing untagged is in a blank group, so nothing untagged is part of the stock picture this
  // review reports on. learnVocab draws the same line.
  const out = reconcileCatalogue({
    manifest,
    bodyMapBodies: BODIES,
    vocab: { colors: COLORS, sizes: SIZES },
    variants: [variant({ body: 'vest-womens', color: 'Classic Navy', size: 'M', blankId: null })],
  });
  assert.deepEqual(out.undeclaredVariants, []);
  assert.equal(assessCatalogue(out).exitCode, 0);
});

test('a declared colour or size the store has not shown yet warns and does not refuse', () => {
  const out = reconcileCatalogue({
    manifest,
    bodyMapBodies: BODIES,
    vocab: { colors: ['Black'], sizes: ['M'] },
    variants: [],
  });
  assert.deepEqual(out.unknownColors, ['classic navy', 'grey heather']);
  assert.ok(out.unknownSizes.includes('xs'));
  const assessed = assessCatalogue(out);
  assert.equal(assessed.exitCode, 0, 'declaring a colour ahead of its first blank is the point');
  assert.deepEqual(assessed.refusals, []);
  assert.deepEqual(assessed.warnings.map((w) => w.code), ['catalogue-unseen-colors', 'catalogue-unseen-sizes']);
});

test('assessCatalogue refuses a missing manifest file rather than defaulting to an empty shape', () => {
  const assessed = assessCatalogue({ fileMissing: true });
  assert.equal(assessed.exitCode, 1);
  assert.deepEqual(assessed.refusals.map((r) => r.code), ['catalogue-missing']);
});

// --- the read-only guard -----------------------------------------------------

test('the manifest module cannot reach a mutation, and neither can the lint that shares its schema', async () => {
  // The import list itself, not a substring search: the module header names mutations.mjs precisely
  // to say it must never import it, and a naive grep cannot tell the prohibition from the violation.
  const lib = await readFile(path.join(here, '../lib/catalogue-manifest.mjs'), 'utf8');
  const libImports = [...lib.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(libImports, ['./groups.mjs', './reorder.mjs']);
  assert.doesNotMatch(lib, /setQuantity\(|adjustQuantity\(|metafieldsSet/);

  const lint = await readFile(path.join(repoRoot, 'scripts/catalogue/check-catalogue.mjs'), 'utf8');
  const lintImports = [...lint.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(lintImports, ['node:fs/promises', 'node:path', 'node:url', '../blank-inventory/lib/catalogue-manifest.mjs']);
});
