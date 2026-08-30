// The one-shot v1 -> v2 skeleton printer.
//
// The property worth testing is not "it produces a valid v2 document": it deliberately does not. It
// is that everything derivable is derived CORRECTLY (both order contracts, the slug projection) and
// everything unknowable is emitted as a placeholder the schema refuses, so an unfinished migration
// cannot merge looking done.
//
// This whole file is deleted with the migrator once the migration lands.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { migrateToV2, PLACEHOLDER, EXAMPLE_PRODUCT } from '../migrate-catalogue.mjs';
import { parseCatalogue } from '../../lib/catalogue-manifest.mjs';

/** A hand-authored v1 document whose union order is NOT alphabetical, so order is observable. */
const V1 = {
  version: 1,
  comment: 'the old comment',
  bodies: {
    crewneck: { colors: ['black', 'grey heather', 'classic navy'], sizes: ['xs', 's', 'm'] },
    'vest-womens': { colors: ['black'], sizes: ['xs', 's', 'm'] },
  },
};

test('it reads version 1 only, and says so', () => {
  assert.throws(() => migrateToV2({ ...V1, version: 2 }), /reads version 1 only/);
  assert.throws(() => migrateToV2({ version: 1 }), /nothing to migrate/);
  assert.throws(() => migrateToV2(null), /must be a JSON object/);
});

test('the colour and size key order is the first-seen union across bodies, not sorted', () => {
  // That order is the reorder matrix's row order, which is one of the two contracts v2 asserts. A
  // migrator that sorted it would silently reorder a printed count sheet on the day of the bump.
  const { skeleton } = migrateToV2(V1);
  assert.deepEqual(Object.keys(skeleton.colors), ['black', 'grey heather', 'classic navy']);
  assert.deepEqual(Object.keys(skeleton.sizes), ['xs', 's', 'm']);
});

test('the slug projection is derived correctly, because it is the one display-side thing that can be', () => {
  const { skeleton } = migrateToV2(V1);
  assert.equal(skeleton.colors['grey heather'].slug, 'grey-heather');
  assert.equal(skeleton.colors.black.slug, 'black');
});

test('bodies pass through unchanged', () => {
  const { skeleton } = migrateToV2(V1);
  assert.deepEqual(skeleton.bodies, V1.bodies);
});

test('every display is a title-cased GUESS, and the size guesses are wrong on purpose', () => {
  // "xs" title-cases to "Xs" and the live value is "XS". The notes say so rather than the migrator
  // pretending to know; inventing "XS" from "xs" would be right here and wrong for "2xl" -> "2XL"
  // versus a hypothetical "One Size".
  const { skeleton, notes } = migrateToV2(V1);
  assert.equal(skeleton.colors['grey heather'].display, 'Grey Heather');
  assert.equal(skeleton.sizes.xs.display, 'Xs');
  assert.ok(notes.some((n) => /wrong by construction/.test(n)));
});

test('everything unknowable is a placeholder, and products is empty', () => {
  const { skeleton } = migrateToV2(V1);
  assert.equal(skeleton.comment, PLACEHOLDER);
  assert.deepEqual(Object.keys(skeleton.options), ['color', 'size', 'design', 'denomination']);
  assert.deepEqual(Object.values(skeleton.options), Array(4).fill(PLACEHOLDER));
  assert.deepEqual(skeleton.products, {});
});

test('THE SKELETON DOES NOT VALIDATE, which is what stops an unfinished migration merging', () => {
  const { skeleton } = migrateToV2(V1);
  assert.throws(() => parseCatalogue(JSON.stringify(skeleton)), (err) => {
    // It fails on the empty census first; the placeholders and the size displays fail too once that
    // is filled in. Any of them is enough: the guarantee is that it cannot pass as printed.
    assert.match(err.message, /declares no products|TODO-READ-FROM-ADMIN|does not round|normalises to/);
    return true;
  });
});

test('the example products block names both shapes an editor needs', () => {
  assert.match(EXAMPLE_PRODUCT, /"line": null/);
  assert.match(EXAMPLE_PRODUCT, /"body": null/);
  assert.match(EXAMPLE_PRODUCT, /gid:\/\/shopify\/Product\//);
});

test('the migrator writes nothing: it imports no write API at all', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const source = await readFile(fileURLToPath(new URL('../migrate-catalogue.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /writeFile|writeFileSync|rename|unlink|mkdir/);
});
