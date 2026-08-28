// The catalogue manifest schema, its derived accessors, and the read-only guard around it.
//
// EVERY DOCUMENT HERE IS HAND-AUTHORED. None of them is read from the committed catalogue.json, and
// none of them is derived from it. A schema test fed the file it validates asserts that the file
// agrees with itself; these assert what the RULES are, so they keep meaning the same thing after the
// catalogue changes. The two places that deliberately do read the committed file are marked as
// matches-production assertions where they appear.

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
  colorDisplay,
  colorSlug,
  sizeDisplay,
  optionName,
  productByHandle,
  productsOnBody,
  garmentProducts,
  nonGarmentProducts,
  colorValuesFor,
  sizeValuesFor,
  linesOf,
  templateFileFor,
  nameList,
  NotAGarmentError,
  ID_RE,
  PRODUCT_GID_RE,
  CATALOGUE_PATH,
  CATALOGUE_VERSION,
} from '../../lib/catalogue-manifest.mjs';
import { importsOf, importClosure, assertImportClosure } from '../../lib/import-closure.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

// ---------------------------------------------------------------------------
// Hand-authored documents
// ---------------------------------------------------------------------------

const BASE = {
  version: 2,
  options: { color: 'Color', size: 'Size', design: 'Design', denomination: 'Denominations' },
  colors: {
    black: { display: 'Black', slug: 'black' },
    'grey heather': { display: 'Grey Heather', slug: 'grey-heather' },
  },
  sizes: { s: { display: 'S' }, m: { display: 'M' } },
  bodies: {
    crewneck: { colors: ['black', 'grey heather'], sizes: ['s', 'm'] },
    vest: { colors: ['black'], sizes: ['s', 'm'] },
  },
  products: {
    'a-crew': { line: 'a', body: 'crewneck', template: 'a-crew', title: 'A Crew', gid: 'gid://shopify/Product/1' },
    'b-crew': { line: 'b', body: 'crewneck', template: 'b-crew', title: 'B Crew', gid: 'gid://shopify/Product/2' },
    'b-vest': { line: 'b', body: 'vest', template: 'b-vest', title: 'B Vest', gid: 'gid://shopify/Product/3' },
    'gift-card-handle': { line: null, body: null, template: 'gift-card', title: 'Gift Card', gid: 'gid://shopify/Product/4' },
  },
};

/** A manifest document as TEXT, so the raw-text checks run the way the tool runs them. */
function doc(over = {}) {
  return JSON.stringify({ ...BASE, ...over }, null, 2);
}

/** One product entry replaced, everything else the base. */
function withProduct(handle, entry) {
  return doc({ products: { ...BASE.products, [handle]: { ...BASE.products[handle], ...entry } } });
}

const parsed = () => parseCatalogue(doc());

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------

test('the tool understands version 2 only', () => {
  assert.equal(CATALOGUE_VERSION, 2);
  assert.throws(() => parseCatalogue(doc({ version: 3 })), /understands 2 only/);
  assert.throws(() => parseCatalogue(JSON.stringify({ bodies: {} })), /understands 2 only/);
});

test('a version 1 document refuses with a message naming the migrator, and is never auto-migrated', () => {
  // Auto-migrating would mean inventing the Admin display spellings and the product census, which
  // are exactly what a v1 document does not contain.
  assert.throws(
    () => parseCatalogue(JSON.stringify({ version: 1, bodies: { crewneck: { colors: ['black'], sizes: ['m'] } } })),
    (err) => {
      assert.match(err.message, /migrate-catalogue\.mjs/);
      assert.match(err.message, /SKELETON/);
      assert.match(err.message, /never auto-migrated/);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// raw-text checks
// ---------------------------------------------------------------------------

test('a duplicate key anywhere is refused, which JSON.parse would silently last-wins', () => {
  const text = `{
  "version": 2,
  "options": { "color": "Color", "size": "Size", "design": "Design", "denomination": "Denominations" },
  "colors": { "black": { "display": "Black", "slug": "black" } },
  "sizes": { "m": { "display": "M" } },
  "bodies": {
    "crewneck": { "colors": ["black"], "sizes": ["m"] },
    "crewneck": { "colors": ["black"], "sizes": ["m"] }
  },
  "products": {
    "a": { "line": "a", "body": "crewneck", "template": "a", "title": "A", "gid": "gid://shopify/Product/1" }
  }
}`;
  assert.throws(() => parseCatalogue(text), /duplicate key\(s\).*bodies\.crewneck/s);
});

test('malformed JSON refuses with a message saying who owns the file', () => {
  assert.throws(() => parseCatalogue('{ nope'), (err) => {
    assert.match(err.message, /is not valid JSON/);
    assert.match(err.message, /reviewed in a PR/);
    return true;
  });
});

test('an unknown top-level key is refused by name, and the message says where it belongs', () => {
  assert.throws(() => parseCatalogue(doc({ thresholds: {} })), (err) => {
    assert.match(err.message, /unknown top-level key\(s\): "thresholds"/);
    assert.match(err.message, /thresholds\.json/);
    assert.match(err.message, /scripts\/sku\/tables\.json/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// options: the one place key and value are NOT two spellings of one thing
// ---------------------------------------------------------------------------

test('the option axis set is closed, in both directions', () => {
  const { color, size, design } = BASE.options;
  assert.throws(() => parseCatalogue(doc({ options: { color, size, design } })), /Missing: "denomination"/);
  assert.throws(
    () => parseCatalogue(doc({ options: { ...BASE.options, fit: 'Fit' } })),
    /Unknown: "fit"/
  );
});

test('an option NAME is not round-trip checked, because the live data does not round-trip', () => {
  // `denomination` -> "Denominations" is live Admin data: it normalises to `denominations`, not to
  // its own key. If this ever started round-trip checking, the committed manifest would refuse.
  const m = parsed();
  assert.equal(optionName(m, 'denomination'), 'Denominations');
  assert.notEqual('denominations', 'denomination');
});

test('an option name is still checked on shape: blank, untrimmed, doubled-space and control chars refuse', () => {
  assert.throws(() => parseCatalogue(doc({ options: { ...BASE.options, color: '' } })), /must be a non-empty string/);
  assert.throws(() => parseCatalogue(doc({ options: { ...BASE.options, color: ' Color' } })), /leading or trailing whitespace/);
  assert.throws(() => parseCatalogue(doc({ options: { ...BASE.options, color: 'Co  lor' } })), /doubled whitespace/);
  assert.throws(() => parseCatalogue(doc({ options: { ...BASE.options, color: 'Col\nor' } })), /control character or newline/);
  assert.throws(() => parseCatalogue(doc({ options: { ...BASE.options, color: 'Col|or' } })), /key separator/);
});

test('two option axes cannot share a name', () => {
  assert.throws(() => parseCatalogue(doc({ options: { ...BASE.options, design: 'Color' } })), /Option axis names must be unique/);
});

// ---------------------------------------------------------------------------
// colours and sizes: identity, display, slug
// ---------------------------------------------------------------------------

test('a colour or size KEY is refused unless it is already normalised', () => {
  assert.throws(
    () => parseCatalogue(doc({ colors: { Black: { display: 'Black', slug: 'black' } }, bodies: { crewneck: { colors: ['Black'], sizes: ['m'] } } })),
    /not in normalised form/
  );
});

test('a display string must normalise back to the key it hangs off, and the refusal names both', () => {
  const bad = doc({
    colors: { ...BASE.colors, 'grey heather': { display: 'Gray Heather', slug: 'grey-heather' } },
  });
  assert.throws(() => parseCatalogue(bad), (err) => {
    assert.match(err.message, /"grey heather"/);
    assert.match(err.message, /"Gray Heather"/);
    assert.match(err.message, /"gray heather"/);
    assert.match(err.message, /two spellings of ONE value/);
    return true;
  });
});

test('a colour slug is a checked projection of the key, not free text', () => {
  const bad = doc({ colors: { ...BASE.colors, 'grey heather': { display: 'Grey Heather', slug: 'greyheather' } } });
  assert.throws(() => parseCatalogue(bad), (err) => {
    assert.match(err.message, /the only valid slug is "grey-heather"/);
    assert.match(err.message, /adjacent in the diff/);
    return true;
  });
});

test('a colour entry must carry exactly display and slug; a size entry exactly display', () => {
  assert.throws(
    () => parseCatalogue(doc({ colors: { ...BASE.colors, black: { display: 'Black' } } })),
    /must have exactly the keys "display", "slug"/
  );
  assert.throws(
    () => parseCatalogue(doc({ sizes: { ...BASE.sizes, m: { display: 'M', slug: 'm' } } })),
    /must have exactly the keys "display"/
  );
});

test('two colours cannot share a display spelling or a slug', () => {
  const sameDisplay = doc({
    colors: { black: { display: 'Black', slug: 'black' }, 'grey heather': { display: 'Black', slug: 'grey-heather' } },
  });
  // The round-trip check fires first on this document, which is the stronger statement about the
  // same defect: 'Black' does not normalise to 'grey heather'.
  assert.throws(() => parseCatalogue(sameDisplay), /two spellings of ONE value/);
});

// ---------------------------------------------------------------------------
// the vocabulary / bodies order contract
// ---------------------------------------------------------------------------

test('the colour key set must equal the union across bodies, in both directions', () => {
  assert.throws(
    () => parseCatalogue(doc({ colors: { black: { display: 'Black', slug: 'black' } } })),
    /Used but not declared: "grey heather"/
  );
  assert.throws(
    () =>
      parseCatalogue(
        doc({ colors: { ...BASE.colors, navy: { display: 'Navy', slug: 'navy' } } })
      ),
    /Declared but unused: "navy"/
  );
});

test('colour key ORDER must equal the first-seen union order, because that is the matrix row order', () => {
  const reversed = doc({
    colors: {
      'grey heather': { display: 'Grey Heather', slug: 'grey-heather' },
      black: { display: 'Black', slug: 'black' },
    },
  });
  assert.throws(() => parseCatalogue(reversed), (err) => {
    assert.match(err.message, /key order is/);
    assert.match(err.message, /reorder matrix's row order/);
    assert.match(err.message, /printed count sheet/);
    return true;
  });
});

test('size key order is held to the same contract', () => {
  const reversed = doc({ sizes: { m: { display: 'M' }, s: { display: 'S' } } });
  assert.throws(() => parseCatalogue(reversed), /"sizes" key order is/);
});

// ---------------------------------------------------------------------------
// bodies
// ---------------------------------------------------------------------------

test('a body with an empty colour or size list is refused rather than silently ranged to nothing', () => {
  assert.throws(
    () => parseCatalogue(doc({ bodies: { crewneck: { colors: [], sizes: ['m'] } } })),
    /is empty/
  );
});

test('a repeated value inside one body list is refused; JSON has no duplicate check for array values', () => {
  assert.throws(
    () =>
      parseCatalogue(
        doc({
          colors: { black: { display: 'Black', slug: 'black' } },
          bodies: { crewneck: { colors: ['black', 'black'], sizes: ['m'] } },
          sizes: { m: { display: 'M' } },
          products: { a: { line: 'a', body: 'crewneck', template: 'a', title: 'A', gid: 'gid://shopify/Product/1' } },
        })
      ),
    /lists "black" twice/
  );
});

test('an unknown key inside a body is refused by name, so a typo cannot look like a setting', () => {
  const bad = doc({
    bodies: { ...BASE.bodies, crewneck: { colors: ['black', 'grey heather'], sizes: ['s', 'm'], fits: ['unisex'] } },
  });
  assert.throws(() => parseCatalogue(bad), /unknown key\(s\): "fits"/);
});

// ---------------------------------------------------------------------------
// products
// ---------------------------------------------------------------------------

test('a product must carry exactly the five keys, and null counts as present', () => {
  const missing = doc({
    products: { ...BASE.products, 'a-crew': { body: 'crewneck', template: 'a-crew', title: 'A Crew', gid: 'gid://shopify/Product/1' } },
  });
  assert.throws(() => parseCatalogue(missing), (err) => {
    assert.match(err.message, /Missing: "line"/);
    assert.match(err.message, /explicit null reads as a decision/);
    return true;
  });
  assert.throws(() => parseCatalogue(withProduct('a-crew', { extra: 1 })), /Unknown: "extra"/);
});

test('line and body are null together, or neither is', () => {
  assert.throws(() => parseCatalogue(withProduct('a-crew', { body: null })), /they are null together or neither is/);
  assert.throws(() => parseCatalogue(withProduct('gift-card-handle', { line: 'x' })), /they are null together or neither is/);
});

test('a body reference is matched EXACTLY against the declared bodies, near miss included', () => {
  assert.throws(() => parseCatalogue(withProduct('a-crew', { body: 'crew-neck' })), (err) => {
    assert.match(err.message, /not a declared body/);
    assert.match(err.message, /Matched exactly/);
    return true;
  });
});

test('a handle and a template must be kebab-case', () => {
  assert.throws(() => parseCatalogue(doc({ products: { ...BASE.products, 'A-Crew': BASE.products['a-crew'] } })), /not in normalised form/);
  assert.throws(() => parseCatalogue(withProduct('a-crew', { template: 'A_Crew' })), /not in normalised form/);
});

test('a GID must have the Product GID shape', () => {
  assert.throws(() => parseCatalogue(withProduct('a-crew', { gid: '10209039483180' })), /gid:\/\/shopify\/Product\/<id>/);
  assert.throws(
    () => parseCatalogue(withProduct('a-crew', { gid: 'gid://shopify/Collection/1' })),
    /gid:\/\/shopify\/Product\/<id>/
  );
});

test('two products cannot share a GID, and the refusal says why that one matters', () => {
  assert.throws(() => parseCatalogue(withProduct('b-crew', { gid: 'gid://shopify/Product/1' })), /Product GIDs must be unique/);
});

test('two products cannot share a template suffix or a title', () => {
  assert.throws(() => parseCatalogue(withProduct('b-crew', { template: 'a-crew' })), /Product template suffixes must be unique/);
  assert.throws(() => parseCatalogue(withProduct('b-crew', { title: 'A Crew' })), /Product titles must be unique/);
});

test('a title is NOT normalised: case is preserved, and only structural defects refuse', () => {
  const m = parseCatalogue(withProduct('a-crew', { title: "Lead II Vest - Women's" }));
  assert.equal(productByHandle(m, 'a-crew').title, "Lead II Vest - Women's");
  assert.throws(() => parseCatalogue(withProduct('a-crew', { title: 'A  Crew' })), /doubled whitespace/);
  assert.throws(() => parseCatalogue(withProduct('a-crew', { title: ' A Crew' })), /leading or trailing whitespace/);
});

test('an empty products block is refused rather than treated as a catalogue with nothing in it', () => {
  assert.throws(() => parseCatalogue(doc({ products: {} })), /declares no products/);
});

// ---------------------------------------------------------------------------
// the dangling-body refusal, which is offline
// ---------------------------------------------------------------------------

test('a declared body with no product refuses OFFLINE, with its own code', () => {
  // Offline: reconcileCatalogue is called with no live data at all, which is how the lint runs it.
  const m = parseCatalogue(
    doc({
      bodies: { ...BASE.bodies, hoodie: { colors: ['black'], sizes: ['m'] } },
    })
  );
  const assessment = assessCatalogue(reconcileCatalogue({ manifest: m }));
  assert.deepEqual(assessment.refusals.map((r) => r.code), ['catalogue-dangling-body']);
  assert.deepEqual(assessment.refusals[0].keys, ['hoodie']);
  assert.equal(assessment.exitCode, 1);
});

test('every body having a product produces no offline refusal at all', () => {
  assert.deepEqual(assessCatalogue(reconcileCatalogue({ manifest: parsed() })).refusals, []);
});

// ---------------------------------------------------------------------------
// derived accessors
// ---------------------------------------------------------------------------

test('the display and slug accessors return the stored spellings', () => {
  const m = parsed();
  assert.equal(colorDisplay(m, 'grey heather'), 'Grey Heather');
  assert.equal(colorSlug(m, 'grey heather'), 'grey-heather');
  assert.equal(sizeDisplay(m, 'm'), 'M');
  assert.equal(optionName(m, 'color'), 'Color');
});

test('an unknown id throws and names what IS declared, rather than returning undefined', () => {
  const m = parsed();
  assert.throws(() => colorDisplay(m, 'navy'), /Unknown colour "navy"; declared: "black", "grey heather"/);
  assert.throws(() => sizeDisplay(m, 'xl'), /Unknown size "xl"/);
  assert.throws(() => optionName(m, 'fit'), /Unknown option axis "fit"/);
  assert.throws(() => productByHandle(m, 'nope'), /No product "nope"/);
  assert.throws(() => productsOnBody(m, 'hoodie'), /Unknown body "hoodie"/);
});

test('garment and non-garment products split on body: null, in declaration order', () => {
  const m = parsed();
  assert.deepEqual(garmentProducts(m).map((p) => p.handle), ['a-crew', 'b-crew', 'b-vest']);
  assert.deepEqual(nonGarmentProducts(m).map((p) => p.handle), ['gift-card-handle']);
  assert.deepEqual(productsOnBody(m, 'crewneck').map((p) => p.handle), ['a-crew', 'b-crew']);
});

test("a product's colour and size values are its BODY's, in the body's declaration order", () => {
  const m = parsed();
  assert.deepEqual(colorValuesFor(m, 'a-crew'), ['Black', 'Grey Heather']);
  assert.deepEqual(colorValuesFor(m, 'b-vest'), ['Black'], 'the narrow body is narrow for every product on it');
  assert.deepEqual(sizeValuesFor(m, 'b-vest'), ['S', 'M']);
});

test('colorValuesFor and sizeValuesFor THROW on a non-garment rather than returning an empty list', () => {
  // Returning [] would let a caller build zero cells, zero photo targets or zero SKU segments and
  // report success. This is the contract that stops that, asserted directly rather than left to be
  // proved incidentally by a consumer migration.
  const m = parsed();
  for (const [fn, name] of [[colorValuesFor, 'colorValuesFor'], [sizeValuesFor, 'sizeValuesFor']]) {
    assert.throws(() => fn(m, 'gift-card-handle'), (err) => {
      assert.ok(err instanceof NotAGarmentError, `${name} throws NotAGarmentError`);
      assert.equal(err.name, 'NotAGarmentError');
      assert.equal(err.handle, 'gift-card-handle');
      assert.match(err.message, new RegExp(`^${name}\\("gift-card-handle"\\)`));
      assert.match(err.message, /Returning an empty list here/);
      assert.match(err.message, /garmentProducts\(\)/);
      return true;
    });
  }
});

test('linesOf is first-seen order and skips non-garments', () => {
  assert.deepEqual(linesOf(parsed()), ['a', 'b']);
});

test('templateFileFor builds the theme path from the template suffix, not from the handle', () => {
  const m = parsed();
  assert.equal(templateFileFor(m, 'gift-card-handle'), 'templates/product.gift-card.json');
  assert.equal(templateFileFor(m, 'a-crew'), 'templates/product.a-crew.json');
});

// ---------------------------------------------------------------------------
// nameList: the untrusted-input escaper
// ---------------------------------------------------------------------------

test('nameList JSON-quotes every entry, so a newline cannot span lines in CI output', () => {
  const escaped = nameList(['ok', 'has\nnewline', 'has"quote']);
  assert.equal(escaped.includes('\n'), false, 'no raw newline reaches the output');
  assert.match(escaped, /"has\\nnewline"/);
  assert.match(escaped, /"has\\"quote"/);
});

test('nameList bounds the list and always states the true total', () => {
  const many = Array.from({ length: 30 }, (_, i) => `k${i}`);
  const out = nameList(many, 3);
  assert.match(out, /^"k0", "k1", "k2" and 27 more$/);
  assert.equal(nameList(['a', 'b'], 3), '"a", "b"', 'a short list is not truncated and gains no suffix');
});

test('every refusal message routes its PR-authored keys through nameList', () => {
  // The schema itself refuses a body id or a handle carrying a newline, so this exercises the layer
  // BELOW that: assessCatalogue formats keys it is handed, and the heredoc-escape guarantee has to
  // hold there too. A live product handle, a live title and a live GID all reach these messages from
  // Admin rather than from the manifest, so "the schema already refused it" is not a defence.
  const forged = 'x\nEOF_1\nexit_code=0';
  const assessment = assessCatalogue({
    danglingBodies: [forged],
    undeclaredProducts: [forged],
    staleProducts: [forged],
    titleMismatches: [{ handle: forged, live: forged, declared: 'ok' }],
    gidMismatches: [{ handle: forged, live: forged, declared: 'ok' }],
    undeclaredVariants: [{ key: forged, count: 1 }],
    unknownColors: [forged],
    unknownSizes: [forged],
  });
  assert.equal(assessment.exitCode, 1);
  assert.equal(assessment.refusals.length, 6, 'every refusal code fired');
  assert.equal(assessment.warnings.length, 2);
  for (const finding of [...assessment.refusals, ...assessment.warnings]) {
    assert.equal(
      finding.message.includes('\nEOF_1'),
      false,
      `${finding.code} lets a raw newline reach the message, which could close the CI heredoc early`
    );
    assert.match(finding.message, /EOF_1/, `${finding.code} still names the value, escaped`);
  }
});

// ---------------------------------------------------------------------------
// loadCatalogue
// ---------------------------------------------------------------------------

test('a missing file is a refusal carrying fileMissing, never an empty default', () => {
  return assert.rejects(
    loadCatalogue({
      read: async () => {
        throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      },
    }),
    (err) => {
      assert.equal(err.fileMissing, true);
      assert.match(err.message, /broken checkout/);
      assert.match(err.message, /no command and no agent creates or edits it/);
      return true;
    }
  );
});

test('a non-ENOENT read error is rethrown untouched rather than reported as a missing file', () => {
  return assert.rejects(
    loadCatalogue({
      read: async () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      },
    }),
    /permission denied/
  );
});

// ---------------------------------------------------------------------------
// The read-only guard
// ---------------------------------------------------------------------------

test('the import-list matcher sees a multi-line import, which a single-line one would miss', () => {
  // Positive control for the guard below. Without this, that guard can pass while being blind.
  const multiline = `import {\n  setQuantity,\n} from './mutations.mjs';\n`;
  assert.deepEqual(importsOf(multiline), ['./mutations.mjs']);
  assert.deepEqual(importsOf(`import x from "./a.mjs"\n`), ['./a.mjs']);
});

test('the closure walker follows a DEPTH-2 edge, which the direct-import check could not', async ({ mock }) => {
  // The control that matters most. A bug collapsing the closure to depth 1 passes every other
  // assertion in this file and silently degrades the guard back into the check it replaced, so this
  // builds a two-hop chain and asserts the far end is reported.
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'closure-'));
  try {
    await writeFile(path.join(dir, 'far.mjs'), 'export const x = 1;\n');
    await writeFile(path.join(dir, 'middle.mjs'), "import { x } from './far.mjs';\nexport const y = x;\n");
    await writeFile(path.join(dir, 'entry.mjs'), "import { y } from './middle.mjs';\nexport const z = y;\n");

    const { files } = await importClosure(path.join(dir, 'entry.mjs'));
    assert.equal(files.length, 3, 'entry, middle and far are all in the closure');
    assert.ok(files.includes(path.join(dir, 'far.mjs')), 'the depth-2 module is reached');

    await assert.rejects(
      assertImportClosure({ entry: path.join(dir, 'entry.mjs'), forbidden: [path.join(dir, 'far.mjs')] }),
      /reaches forbidden module\(s\)/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the closure walker fails LOUDLY on anything it cannot follow, rather than treating it as a leaf', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'closure-loud-'));
  try {
    await writeFile(path.join(dir, 'gone.mjs'), "import { x } from './does-not-exist.mjs';\nexport const y = x;\n");
    await assert.rejects(importClosure(path.join(dir, 'gone.mjs')), /cannot read/);

    await writeFile(path.join(dir, 'dyn.mjs'), "export async function f() { return await import('./far.mjs'); }\n");
    await assert.rejects(importClosure(path.join(dir, 'dyn.mjs')), /dynamic import call/);

    await writeFile(path.join(dir, 'far.mjs'), 'export const x = 1;\n');
    await writeFile(path.join(dir, 'reexport.mjs'), "export { x } from './far.mjs';\n");
    await assert.rejects(importClosure(path.join(dir, 'reexport.mjs')), /export \.\.\. from/);

    await writeFile(path.join(dir, 'bare.mjs'), "import sharp from 'sharp';\nexport const s = sharp;\n");
    await assert.rejects(
      assertImportClosure({ entry: path.join(dir, 'bare.mjs'), forbidden: [] }),
      /non-relative specifier\(s\)/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the manifest module cannot reach a mutation, and neither can the lint that shares its schema', async () => {
  // The exact import list, not a substring search: the module header names mutations.mjs precisely
  // to say it must never import it, and a naive grep cannot tell the prohibition from the violation.
  const libPath = path.join(repoRoot, 'scripts/lib/catalogue-manifest.mjs');
  const lib = await readFile(libPath, 'utf8');
  assert.deepEqual(importsOf(lib), ['./vocab.mjs', './json-keys.mjs']);
  assert.doesNotMatch(lib, /setQuantity\(|adjustQuantity\(|metafieldsSet/);

  const lintPath = path.join(repoRoot, 'scripts/catalogue/check-catalogue.mjs');
  const lint = await readFile(lintPath, 'utf8');
  assert.deepEqual(importsOf(lint), [
    'node:fs/promises',
    'node:path',
    'node:url',
    '../lib/catalogue-manifest.mjs',
    '../lib/catalogue-cohesion.mjs',
    '../lib/photo-naming.mjs',
  ]);

  // And the transitive closure of both, which is what the exact lists above cannot prove.
  const forbidden = [
    path.join(repoRoot, 'scripts/blank-inventory/lib/mutations.mjs'),
    path.join(repoRoot, 'scripts/blank-inventory/lib/admin.mjs'),
    path.join(repoRoot, 'scripts/blank-inventory/lib/apply.mjs'),
  ];
  const manifestClosure = await assertImportClosure({ entry: libPath, forbidden });
  assert.deepEqual(
    manifestClosure.map((f) => path.relative(repoRoot, f)).sort(),
    ['scripts/lib/catalogue-manifest.mjs', 'scripts/lib/json-keys.mjs', 'scripts/lib/vocab.mjs'],
    'the schema module and its two leaves, and nothing else'
  );
  await assertImportClosure({ entry: lintPath, forbidden });
});

test('vocab.mjs and json-keys.mjs are zero-import leaves', async () => {
  for (const name of ['vocab.mjs', 'json-keys.mjs']) {
    const source = await readFile(path.join(repoRoot, 'scripts/lib', name), 'utf8');
    assert.deepEqual(importsOf(source), [], `${name} imports nothing at all`);
  }
});

test('the ID and GID regexes copied into the schema module are byte-identical to the originals', async () => {
  // COPIED, not moved: the applique registry still owns its own copy until its migration lands, and
  // deleting it there in this change would break trunk in the window between the two PRs. This is
  // what stops the two drifting apart for as long as both exist. It is deleted with the copy.
  const registry = await readFile(path.join(repoRoot, 'scripts/applique-grid/lib/registry.mjs'), 'utf8');
  const idSource = registry.match(/^const ID_RE = (.+);$/m)?.[1];
  const gidSource = registry.match(/^const PRODUCT_GID_RE = (.+);$/m)?.[1];
  assert.ok(idSource && gidSource, 'both originals are still readable from registry.mjs');
  assert.equal(String(ID_RE), idSource);
  assert.equal(String(PRODUCT_GID_RE), gidSource);
});

// ---------------------------------------------------------------------------
// Matches-production
//
// The two assertions below deliberately read the COMMITTED manifest. They are flagged as such
// because everything above is hand-authored on purpose: these say "today's file parses and says what
// we think it says", which is a different claim from "the rules are these".
// ---------------------------------------------------------------------------

test('MATCHES PRODUCTION: the committed manifest parses under these rules', async () => {
  const m = await loadCatalogue({ read: (p) => readFile(path.join(repoRoot, p), 'utf8') });
  assert.equal(m.version, CATALOGUE_VERSION);
  assert.ok(m.bodies.size >= 1);
  assert.ok(m.products.size >= 1);
  assert.deepEqual(assessCatalogue(reconcileCatalogue({ manifest: m })).refusals, []);
});

test('MATCHES PRODUCTION: the committed manifest lives where CATALOGUE_PATH says it does', async () => {
  const text = await readFile(path.join(repoRoot, CATALOGUE_PATH), 'utf8');
  assert.equal(JSON.parse(text).version, CATALOGUE_VERSION);
});
