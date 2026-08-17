import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTables, hashTables, parseTables, loadTables, allCodes, productEntry, isWritable, TABLES_PATH } from '../lib/tables.mjs';
import { TABLES } from './fixtures.mjs';

const clone = (over = {}) => JSON.parse(JSON.stringify({ ...TABLES, ...over }));

test('the committed tables are valid', async () => {
  const tables = await loadTables(TABLES_PATH);
  assert.deepEqual(validateTables(tables), []);
  assert.ok(allCodes(tables).length >= 20, 'the real tables should carry every live option value');
});

test('the committed tables cover the whole live catalogue shape', async () => {
  const tables = await loadTables(TABLES_PATH);
  assert.deepEqual(Object.keys(tables.products).sort(), [
    'huddle-crewneck',
    'lead-ii-crewneck',
    'lead-ii-quarter-zip',
    'lead-ii-vest-womens',
    'sapphire-shadow-studio-gift-card',
    'shift-fuel-crewneck',
  ]);
});

test('valid fixture tables produce no problems', () => {
  assert.deepEqual(validateTables(TABLES), []);
});

test('a lowercase or hyphenated code is refused', () => {
  const bad = clone();
  bad.colors = { ...bad.colors, Sand: 'snd' };
  assert.match(validateTables(bad).join('\n'), /not uppercase letters and digits only/);
  const hyphen = clone();
  hyphen.colors = { ...hyphen.colors, Sand: 'SA-ND' };
  assert.match(validateTables(hyphen).join('\n'), /not uppercase letters and digits only/);
});

test('O and I are refused in new codes but allowed for an exempted one', () => {
  const bad = clone();
  bad.colors = { ...bad.colors, Olive: 'OLV' };
  assert.match(validateTables(bad).join('\n'), /ambiguous against 0\/1/);
  // GIFT contains an I and is exempt; it must not be reported.
  assert.equal(validateTables(TABLES).length, 0);
});

test('duplicate codes are refused per scope, and only per scope', () => {
  const dupe = clone();
  dupe.colors = { ...dupe.colors, Charcoal: 'BLK' };
  assert.match(validateTables(dupe).join('\n'), /color code "BLK" is used by both/);

  // The same code in two design namespaces is legitimate: they are different vocabularies.
  const across = clone();
  across.designs = { ...across.designs, huddle: { ...across.designs.huddle, Medic: 'MDC' } };
  assert.deepEqual(validateTables(across), []);
});

test('a product code starting with 0 is refused, a denomination code starting with 0 is not', () => {
  const bad = clone();
  bad.products = { ...bad.products, 'x-product': { ...bad.products['shift-fuel-crewneck'], code: '0SF' } };
  assert.match(validateTables(bad).join('\n'), /starts with 0/);
  // The shipped denominations are zero-padded and must stay legal.
  assert.deepEqual(validateTables(TABLES), []);
});

test('a design segment without a namespace, and a namespace that does not exist, are both refused', () => {
  const noNs = clone();
  delete noNs.products['huddle-crewneck'].designNamespace;
  assert.match(validateTables(noNs).join('\n'), /design segment but no designNamespace/);

  const badNs = clone();
  badNs.products['huddle-crewneck'].designNamespace = 'nope';
  assert.match(validateTables(badNs).join('\n'), /does not exist/);
});

test('a product with no segments, an unknown kind, or a repeated option is refused', () => {
  const none = clone();
  none.products['shift-fuel-crewneck'].segments = [];
  assert.match(validateTables(none).join('\n'), /no segments array/);

  const kind = clone();
  kind.products['shift-fuel-crewneck'].segments = [{ kind: 'fabric', option: 'Fabric' }];
  assert.match(validateTables(kind).join('\n'), /unknown kind/);

  const twice = clone();
  twice.products['shift-fuel-crewneck'].segments = [
    { kind: 'color', option: 'Color' },
    { kind: 'size', option: 'Color' },
  ];
  assert.match(validateTables(twice).join('\n'), /reads option "Color" twice/);
});

test('a wrong version and a non-boolean skuWritable are refused', () => {
  assert.match(validateTables(clone({ version: 2 })).join('\n'), /version is 2/);
  const flag = clone();
  flag.products['sapphire-shadow-studio-gift-card'].skuWritable = 'no';
  assert.match(validateTables(flag).join('\n'), /skuWritable must be a boolean/);
});

test('empty tables are a problem, not a vacuous pass', () => {
  assert.match(validateTables({ version: 1 }).join('\n'), /defines no codes at all/);
});

test('parseTables throws with every problem listed', () => {
  const bad = clone();
  bad.colors = { ...bad.colors, Olive: 'olv' };
  assert.throws(() => parseTables(JSON.stringify(bad), 'fixture'), (err) => {
    assert.match(err.message, /fixture is invalid/);
    assert.match(err.message, /uppercase/);
    return true;
  });
  assert.throws(() => parseTables('{oops', 'fixture'), /not valid JSON/);
});

test('the tables hash tracks meaning, not formatting', () => {
  const base = hashTables(TABLES);
  assert.equal(base, hashTables(JSON.parse(JSON.stringify(TABLES))));
  // Reordering keys must not void an approved plan.
  const reordered = { products: TABLES.products, denominations: TABLES.denominations, designs: TABLES.designs, colors: TABLES.colors, ambiguityExemptions: TABLES.ambiguityExemptions, version: 1 };
  assert.equal(hashTables(reordered), base);
  // The prose field is not part of the meaning.
  assert.equal(hashTables({ ...TABLES, readme: 'anything at all' }), base);
  // Changing a code must void it.
  const changed = clone();
  changed.colors = { ...changed.colors, Black: 'BLA' };
  assert.notEqual(hashTables(changed), base);
});

test('productEntry and isWritable', () => {
  assert.equal(productEntry(TABLES, 'lead-ii-crewneck').code, 'L2CN');
  assert.equal(productEntry(TABLES, 'nope'), null);
  assert.equal(isWritable(productEntry(TABLES, 'lead-ii-crewneck')), true);
  assert.equal(isWritable(null), true, 'an unknown product is not exempt; it is unmapped');
  assert.equal(isWritable({ skuWritable: false }), false);
});
