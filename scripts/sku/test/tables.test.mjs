// Tables validation and the hash pin.
//
// Almost everything here runs against the HAND-AUTHORED fixture manifest, not against the committed
// catalogue.json: these are statements about the merge and the validators, not about today's
// catalogue. The two exceptions are labelled MATCHES PRODUCTION and are deliberate: the committed
// tables and the committed manifest have to agree in the repo as shipped, and only the real files
// can say so.
//
// THE HASH TESTS ARE THE HIGHEST-CONSEQUENCE ASSERTIONS IN THIS TOOL. A SKU is written onto a
// variant and then frozen onto every order line that variant sells, so a change that silently makes
// an approved plan write different strings is unrecoverable after the fact. `hashTables` therefore
// covers the DERIVATION INPUTS of the merged tables, manifest contribution included, and nothing
// else. Both directions are pinned below: positive controls that a derivation-changing edit voids an
// approval, and negative controls that an edit which cannot change a SKU does not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateTables,
  effectiveTables,
  hashTables,
  parseTables,
  loadTables,
  allCodes,
  segmentKinds,
  productEntry,
  isWritable,
  TABLES_PATH,
  TABLES_VERSION,
} from '../lib/tables.mjs';
import { parseCatalogue, loadCommittedCatalogue } from '../../lib/catalogue-manifest.mjs';
import { MANIFEST, TABLES, EFFECTIVE } from './fixtures.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** A deep clone of the raw fixture tables, with top-level overrides applied. */
const clone = (over = {}) => JSON.parse(JSON.stringify({ ...TABLES, ...over }));

/** The committed manifest, re-parsed from the repo root. */
const realManifest = () => loadCommittedCatalogue();

/** A clone of the fixture manifest's source document, mutated then re-parsed. */
function manifestWith(mutate) {
  const doc = {
    version: 2,
    options: { color: 'Color', size: 'Size', design: 'Design', denomination: 'Denominations' },
    colors: {
      black: { display: 'Black', slug: 'black' },
      'grey heather': { display: 'Grey Heather', slug: 'grey-heather' },
      'classic navy': { display: 'Classic Navy', slug: 'classic-navy' },
    },
    sizes: {
      xs: { display: 'XS' },
      s: { display: 'S' },
      m: { display: 'M' },
      l: { display: 'L' },
      xl: { display: 'XL' },
      '2xl': { display: '2XL' },
    },
    bodies: {
      crewneck: { colors: ['black', 'grey heather', 'classic navy'], sizes: ['xs', 's', 'm', 'l', 'xl', '2xl'] },
    },
    products: {
      'lead-ii-crewneck': { line: 'lead2', body: 'crewneck', template: 'lead-ii-crewneck', title: 'Lead II Crewneck', gid: 'gid://shopify/Product/1' },
      'huddle-crewneck': { line: 'huddle', body: 'crewneck', template: 'huddle-crewneck', title: 'Huddle Crewneck', gid: 'gid://shopify/Product/2' },
      'shift-fuel-crewneck': { line: 'shift-fuel', body: 'crewneck', template: 'shift-fuel-crewneck', title: 'Shift Fuel Crewneck', gid: 'gid://shopify/Product/3' },
      'sapphire-shadow-studio-gift-card': { line: null, body: null, template: 'gift-card', title: 'Gift Card', gid: 'gid://shopify/Product/4' },
    },
  };
  mutate(doc);
  return parseCatalogue(JSON.stringify(doc));
}

const problems = (tables, manifest = MANIFEST) => validateTables(tables, manifest).join('\n');

// ---------------------------------------------------------------------------
// The committed files (MATCHES PRODUCTION)
// ---------------------------------------------------------------------------

test('MATCHES PRODUCTION: the committed tables are valid against the committed manifest', async () => {
  const manifest = await realManifest();
  const raw = JSON.parse(await readFile(TABLES_PATH, 'utf8'));
  assert.deepEqual(validateTables(raw, manifest), []);
  assert.ok(allCodes(raw).length >= 20, 'the real tables should carry every live option value');
});

test('MATCHES PRODUCTION: the committed tables cover exactly the manifest census', async () => {
  const manifest = await realManifest();
  const tables = await loadTables({ manifest });
  assert.deepEqual(Object.keys(tables.products).sort(), [...manifest.products.keys()].sort());
  // Spelled out as well as derived, so a manifest that lost a product cannot make this vacuous.
  assert.deepEqual(Object.keys(tables.products).sort(), [
    'huddle-crewneck',
    'lead-ii-crewneck',
    'lead-ii-quarter-zip',
    'lead-ii-vest-womens',
    'sapphire-shadow-studio-gift-card',
    'shift-fuel-crewneck',
    'shift-fuel-tote',
  ]);
});

// ---------------------------------------------------------------------------
// Code shape and uniqueness
// ---------------------------------------------------------------------------

test('valid fixture tables produce no problems', () => {
  assert.deepEqual(validateTables(TABLES, MANIFEST), []);
});

test('validateTables refuses to run without a manifest', () => {
  assert.match(validateTables(TABLES, null).join('\n'), /needs the catalogue manifest/);
});

test('a lowercase or hyphenated code is refused', () => {
  const bad = clone();
  bad.colors = { ...bad.colors, black: 'blk' };
  assert.match(problems(bad), /not uppercase letters and digits only/);
  const hyphen = clone();
  hyphen.colors = { ...hyphen.colors, black: 'BL-K' };
  assert.match(problems(hyphen), /not uppercase letters and digits only/);
});

test('O and I are refused in new codes but allowed for an exempted one', () => {
  const bad = clone();
  bad.designs = { ...bad.designs, huddle: { ...bad.designs.huddle, Olive: 'OLV' } };
  assert.match(problems(bad), /ambiguous against 0\/1/);
  // GIFT contains an I and is exempt; it must not be reported.
  assert.equal(validateTables(TABLES, MANIFEST).length, 0);
});

test('duplicate codes are refused per scope, and only per scope', () => {
  const dupe = clone();
  dupe.colors = { ...dupe.colors, 'classic navy': 'BLK' };
  assert.match(problems(dupe), /color code "BLK" is used by both/);

  // The same code in two design namespaces is legitimate: they are different vocabularies.
  const across = clone();
  across.designs = { ...across.designs, huddle: { ...across.designs.huddle, Medic: 'MDC' } };
  assert.deepEqual(validateTables(across, MANIFEST), []);
});

test('a product code starting with 0 is refused, a denomination code starting with 0 is not', () => {
  const bad = clone();
  bad.products['shift-fuel-crewneck'] = { ...bad.products['shift-fuel-crewneck'], code: '0SF' };
  assert.match(problems(bad), /starts with 0/);
  // The shipped denominations are zero-padded and must stay legal.
  assert.deepEqual(validateTables(TABLES, MANIFEST), []);
});

test('empty tables are a problem, not a vacuous pass', () => {
  assert.match(problems({ version: TABLES_VERSION }), /defines no codes at all/);
});

test('a wrong version and a non-boolean skuWritable are refused', () => {
  assert.match(problems(clone({ version: 1 })), /version is 1, expected 2/);
  const flag = clone();
  flag.products['sapphire-shadow-studio-gift-card'].skuWritable = 'no';
  assert.match(problems(flag), /skuWritable must be a boolean/);
});

// ---------------------------------------------------------------------------
// The manifest contract: both directions, and the fields that moved out
// ---------------------------------------------------------------------------

test('the colour vocabulary is checked in both directions against the manifest', () => {
  const extra = clone();
  extra.colors = { ...extra.colors, 'forest green': 'FGN' };
  assert.match(problems(extra), /colors "forest green" is not a colour declared in catalogue\.json/);

  const missing = clone();
  delete missing.colors['classic navy'];
  assert.match(problems(missing), /colour "classic navy" is declared in catalogue\.json but has no code here/);
});

test('a colour keyed by its Admin display spelling is refused, naming the id to use', () => {
  // The third casing of one value is exactly what this migration removed. The refusal has to hand
  // the operator the id rather than only saying no.
  const cased = clone();
  delete cased.colors['grey heather'];
  cased.colors['Grey Heather'] = 'GRH';
  const text = problems(cased);
  assert.match(text, /colors "Grey Heather" is not a colour declared/);
  assert.match(text, /Keys here are colour IDS: use "grey heather"/);
});

test('the product census is checked in both directions against the manifest', () => {
  const extra = clone();
  extra.products = { ...extra.products, 'brand-new-hoodie': { code: 'BNHD', segments: [{ kind: 'color' }] } };
  assert.match(problems(extra), /product "brand-new-hoodie" is not declared in catalogue\.json/);

  const missing = clone();
  delete missing.products['huddle-crewneck'];
  assert.match(problems(missing), /product "huddle-crewneck" is declared in catalogue\.json but has no entry here/);
});

test('a title, sizes list, body, or segment option name left in the tables is refused, not ignored', () => {
  // All of them are now the manifest's to state. Silently ignoring a stale copy is how two sources of truth
  // drift apart, so the leftover has to red the lint.
  const titled = clone();
  titled.products['huddle-crewneck'].title = 'Huddle Crewneck';
  assert.match(problems(titled), /carries a "title"\. Titles come from catalogue\.json now/);

  const sized = clone();
  sized.products['huddle-crewneck'].sizes = ['S', 'M'];
  assert.match(problems(sized), /carries a "sizes" list\. Size ranges come from catalogue\.json now/);

  const bodied = clone();
  bodied.products['huddle-crewneck'].body = 'crewneck';
  assert.match(problems(bodied), /carries a "body"\. Garment bodies come from catalogue\.json now/);

  const optioned = clone();
  optioned.products['huddle-crewneck'].segments[1].option = 'Color';
  assert.match(problems(optioned), /carries an "option" name\. Option names come from catalogue\.json/);
});

test('segment kinds are the manifest option axes, not a hardcoded list', () => {
  assert.deepEqual([...segmentKinds(MANIFEST)].sort(), ['color', 'denomination', 'design', 'size']);

  const kind = clone();
  kind.products['shift-fuel-crewneck'].segments = [{ kind: 'fabric' }];
  assert.match(problems(kind), /unknown kind "fabric"; catalogue\.json declares the axes/);

  // A fifth axis needs no edit to this module. The manifest schema closes the axis set deliberately
  // (adding one is a schema change with consumers to update), so the widened manifest is built by
  // hand rather than parsed: the point being pinned is that nothing here restates the four.
  const withFabric = { ...MANIFEST, options: new Map([...MANIFEST.options, ['fabric', 'Fabric']]) };
  assert.ok(segmentKinds(withFabric).has('fabric'));
  assert.deepEqual(validateTables(kind, withFabric), []);
});

test('a product with no segments array or a repeated axis is refused; an empty array is a bare code', () => {
  const none = clone();
  delete none.products['shift-fuel-crewneck'].segments;
  assert.match(problems(none), /no segments array/);

  const bare = clone();
  bare.products['shift-fuel-crewneck'].segments = [];
  assert.doesNotMatch(problems(bare), /segments/);

  const twice = clone();
  twice.products['shift-fuel-crewneck'].segments = [{ kind: 'color' }, { kind: 'color' }];
  assert.match(problems(twice), /reads the "color" axis twice/);
});

test('a design segment without a namespace, and a namespace that does not exist, are both refused', () => {
  const noNs = clone();
  delete noNs.products['huddle-crewneck'].designNamespace;
  assert.match(problems(noNs), /design segment but no designNamespace/);

  const badNs = clone();
  badNs.products['huddle-crewneck'].designNamespace = 'nope';
  assert.match(problems(badNs), /does not exist/);
});

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

test('effectiveTables restores the shape downstream modules were always handed', () => {
  const entry = EFFECTIVE.products['shift-fuel-crewneck'];
  assert.equal(entry.title, 'Shift Fuel Crewneck');
  assert.deepEqual(entry.sizes, ['XS', 'S', 'M', 'L', 'XL', '2XL']);
  assert.deepEqual(entry.segments, [
    { kind: 'color', option: 'Color' },
    { kind: 'size', option: 'Size' },
  ]);
  // The codes are carried through untouched.
  assert.equal(entry.code, 'SFCN');
  assert.deepEqual(EFFECTIVE.colors, TABLES.colors);
});

test('a non-garment merges to a null size range, never an empty one', () => {
  // `[]` would read as "sells no sizes"; `null` is "this axis does not apply", which is what
  // derive.mjs has to tell apart to refuse a size segment on a gift card as a tables error.
  const gift = EFFECTIVE.products['sapphire-shadow-studio-gift-card'];
  assert.equal(gift.sizes, null);
});

test('an option name renamed in the manifest flows into every segment that reads it', () => {
  const renamed = manifestWith((doc) => {
    doc.options.color = 'Colour';
  });
  const merged = effectiveTables(TABLES, renamed);
  assert.equal(merged.products['shift-fuel-crewneck'].segments[0].option, 'Colour');
});

// ---------------------------------------------------------------------------
// parseTables and loadTables
// ---------------------------------------------------------------------------

test('parseTables throws with every problem listed', () => {
  const bad = clone();
  bad.designs.huddle.Olive = 'olv';
  assert.throws(
    () => parseTables(JSON.stringify(bad), { manifest: MANIFEST, source: 'fixture' }),
    (err) => {
      assert.match(err.message, /fixture is invalid/);
      assert.match(err.message, /uppercase/);
      return true;
    }
  );
  assert.throws(() => parseTables('{oops', { manifest: MANIFEST, source: 'fixture' }), /not valid JSON/);
});

test('parseTables returns the merged tables, not the raw ones', () => {
  const merged = parseTables(JSON.stringify(TABLES), { manifest: MANIFEST, source: 'fixture' });
  assert.equal(merged.products['huddle-crewneck'].title, 'Huddle Crewneck');
  assert.equal(merged.products['huddle-crewneck'].segments[0].option, 'Design');
});

test('loadTables accepts an injected manifest and does not read catalogue.json', async () => {
  // The injected manifest declares four products; the committed tables declare six, so the census
  // check has to fire. That it does is the proof the injected manifest was the one used.
  await assert.rejects(loadTables({ manifest: MANIFEST }), /is not declared in catalogue\.json/);
});

// ---------------------------------------------------------------------------
// The hash
// ---------------------------------------------------------------------------

test('the tables hash tracks meaning, not formatting', () => {
  const base = hashTables(EFFECTIVE);
  assert.equal(base, hashTables(JSON.parse(JSON.stringify(EFFECTIVE))));

  // Reordering keys must not void an approved plan.
  const reordered = {
    products: EFFECTIVE.products,
    denominations: EFFECTIVE.denominations,
    designs: EFFECTIVE.designs,
    colors: EFFECTIVE.colors,
    ambiguityExemptions: EFFECTIVE.ambiguityExemptions,
    version: EFFECTIVE.version,
  };
  assert.equal(hashTables(reordered), base);

  // A prose field is not part of the meaning.
  assert.equal(hashTables({ ...EFFECTIVE, readme: 'anything at all' }), base);

  // Changing a code must void it.
  const changed = effectiveTables({ ...TABLES, colors: { ...TABLES.colors, black: 'BLA' } }, MANIFEST);
  assert.notEqual(hashTables(changed), base);
});

test('POSITIVE CONTROL: a manifest edit that changes derivation changes the hash', () => {
  const base = hashTables(EFFECTIVE);

  // 1. An option axis renamed in the manifest. This is the pure-manifest case and the whole reason
  //    the hash covers the merged tables: nothing in tables.json changes, but every segment now
  //    reads a differently-named option off the variant, so every derived SKU can change.
  const renamedAxis = manifestWith((doc) => {
    doc.options.color = 'Colour';
  });
  assert.notEqual(hashTables(effectiveTables(TABLES, renamedAxis)), base);

  // 2. A body's declared size range. It is what a size is validated against before it passes
  //    through, so narrowing it turns previously-derived SKUs into misses.
  const fewerSizes = manifestWith((doc) => {
    doc.sizes = { s: { display: 'S' }, m: { display: 'M' } };
    doc.bodies.crewneck.sizes = ['s', 'm'];
  });
  assert.notEqual(hashTables(effectiveTables(TABLES, fewerSizes)), base);

  // 3. A colour renamed in the manifest. `validateTables` requires the tables to be re-keyed in the
  //    same edit, so this is a coupled change by construction; performed the only way that stays
  //    valid, it voids the approval.
  const renamedColour = manifestWith((doc) => {
    // Rebuilt in place: the manifest pins colour key order to the first-seen order across bodies.
    doc.colors = {
      black: doc.colors.black,
      'gray heather': { display: 'Gray Heather', slug: 'gray-heather' },
      'classic navy': doc.colors['classic navy'],
    };
    doc.bodies.crewneck.colors = ['black', 'gray heather', 'classic navy'];
  });
  const rekeyed = clone();
  rekeyed.colors = { black: 'BLK', 'gray heather': 'GRH', 'classic navy': 'NVY' };
  assert.deepEqual(validateTables(rekeyed, renamedColour), []);
  assert.notEqual(hashTables(effectiveTables(rekeyed, renamedColour)), base);
});

test('NEGATIVE CONTROL: a manifest edit that cannot change a SKU leaves the hash alone', () => {
  // Without this, hashing the merged whole indiscriminately would invalidate every approved plan
  // store-wide on a title typo fix, and nothing in the tool would notice that it had.
  const base = hashTables(EFFECTIVE);

  // 1. A title typo fix. Merchandising copy; no segment reads it.
  const retitled = manifestWith((doc) => {
    doc.products['huddle-crewneck'].title = 'Huddle Crew Neck';
  });
  assert.equal(hashTables(effectiveTables(TABLES, retitled)), base);

  // 2. A manifest product with no entry in the tables. It contributes no codes and no segments, so
  //    it cannot change any SKU the tables can derive. (The census check refuses it separately; the
  //    point here is that the hash is not the thing that catches it.)
  const extraProduct = manifestWith((doc) => {
    doc.products['lead-ii-scarf'] = {
      line: 'lead2',
      body: 'crewneck',
      template: 'lead-ii-scarf',
      title: 'Lead II Scarf',
      gid: 'gid://shopify/Product/9',
    };
  });
  assert.equal(hashTables(effectiveTables(TABLES, extraProduct)), base);

  // 3. A colour's Admin display spelling changed without changing its id. Derivation resolves the
  //    live value through normaliseAxis to the id, so the display is not an input.
  const restyled = manifestWith((doc) => {
    doc.colors['grey heather'].display = 'GREY HEATHER';
  });
  assert.equal(hashTables(effectiveTables(TABLES, restyled)), base);

  // 4. A GID corrected. It addresses the product for writes; it is not part of any SKU.
  const regid = manifestWith((doc) => {
    doc.products['huddle-crewneck'].gid = 'gid://shopify/Product/999';
  });
  assert.equal(hashTables(effectiveTables(TABLES, regid)), base);
});

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

test('productEntry and isWritable', () => {
  assert.equal(productEntry(EFFECTIVE, 'lead-ii-crewneck').code, 'L2CN');
  assert.equal(productEntry(EFFECTIVE, 'nope'), null);
  assert.equal(isWritable(productEntry(EFFECTIVE, 'lead-ii-crewneck')), true);
  assert.equal(isWritable(null), true, 'an unknown product is not exempt; it is unmapped');
  assert.equal(isWritable({ skuWritable: false }), false);
});
