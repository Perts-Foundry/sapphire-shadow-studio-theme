// The cohesion checks: every repo-side surface that restates the catalogue's vocabulary.
//
// Two kinds of test here, kept apart on purpose:
//
//   - LOGIC tests drive `runCohesion` against hand-authored sources. They assert what each check
//     DECIDES, and they keep meaning the same thing after the catalogue changes.
//   - MATCHES-PRODUCTION tests run the real collector over the real repo. They assert that today's
//     files agree, which is a different and weaker claim, and they are labelled so nobody mistakes
//     one for the other.
//
// The untrusted-input block is neither: it asserts that no failure message can carry a raw newline
// out of a PR-authored file and into `$GITHUB_OUTPUT`, per source file, which is the bypass class
// this repo has already had one incident of.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHECKS, COHESION_CHECK_COUNT, runCohesion, collectSources, REFUSE, WARN } from '../../lib/catalogue-cohesion.mjs';
import { parseCatalogue, loadCommittedCatalogue } from '../../lib/catalogue-manifest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

// ---------------------------------------------------------------------------
// A hand-authored world that every check passes
// ---------------------------------------------------------------------------

const MANIFEST_DOC = {
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
    'b-vest': { line: 'b', body: 'vest', template: 'b-vest', title: 'B Vest', gid: 'gid://shopify/Product/2' },
    'the-gift-card': { line: null, body: null, template: 'gift-card', title: 'Gift Card', gid: 'gid://shopify/Product/3' },
  },
};

const manifest = () => parseCatalogue(JSON.stringify(MANIFEST_DOC));

const SKU_SCHEME_DOC = `# scheme

<!-- catalogue:begin products -->
| Product | Code |
|---|---|
| A Crew | \`ACRW\` |
| B Vest | \`BVST\` |
| Gift Card | \`GIFT\` |
<!-- catalogue:end products -->

<!-- catalogue:begin colors -->
**Colours** (store-wide): \`BLK\` Black, \`GRH\` Grey Heather.
<!-- catalogue:end colors -->
`;

const ALT_TEXT_DOC = `# alt text

<!-- catalogue:begin product-colors -->
| Product | Color option values |
|---|---|
| A Crew | \`Black\` / \`Grey Heather\` |
| **B Vest** | **\`Black\` only** |
<!-- catalogue:end product-colors -->
`;

/**
 * Every source the checks read, hand-authored so each one agrees with the manifest above.
 * @param {object} [over] - shallow overrides, one source at a time
 */
function sources(over = {}) {
  return {
    manifest: manifest(),
    settingsSchemaDefaults: new Map([
      ['color_option_name', 'Color'],
      ['size_option_name', 'Size'],
    ]),
    settingsDataValues: new Map([
      ['color_option_name', 'Color'],
      ['size_option_name', 'Size'],
    ]),
    templateFiles: [
      'templates/product.a-crew.json',
      'templates/product.b-vest.json',
      'templates/product.gift-card.json',
    ],
    sizeChartProfileBodies: new Map([
      ['crewneck', 'crewneck-fleece.json'],
      ['vest', 'vest-micro.json'],
    ]),
    appliqueHandle: 'a-crew',
    docs: { skuScheme: SKU_SCHEME_DOC, altText: ALT_TEXT_DOC },
    ...over,
  };
}

/** Run the set and return the ids of everything that fired. */
async function fired(over = {}) {
  const out = await runCohesion(sources(over));
  return {
    run: out.run,
    refusals: out.refusals.map((r) => r.id),
    warnings: out.warnings.map((w) => w.id),
    messages: Object.fromEntries([...out.refusals, ...out.warnings].map((f) => [f.id, f.message])),
  };
}

// ---------------------------------------------------------------------------
// The set itself
// ---------------------------------------------------------------------------

test('the check count is pinned, and every check declares an id, a source and a severity', () => {
  // The lint reports the count of checks RUN and the workflow greps it, so a check quietly leaving
  // the set has to be a deliberate edit here as well as there.
  assert.equal(COHESION_CHECK_COUNT, 10);
  assert.equal(CHECKS.length, 10);
  const ids = CHECKS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const check of CHECKS) {
    assert.ok(check.source, `${check.id} declares the file it reads`);
    assert.ok([REFUSE, WARN].includes(check.severity), `${check.id} declares a severity`);
    assert.equal(typeof check.run, 'function');
  }
});

test('exactly two checks are WARN, and both are the Admin-editable settings_data.json ones', () => {
  // A REFUSAL there would let an Admin theme-settings edit red a reconcile PR nobody in this repo
  // authored, and halt deploy.yml's gate on something unfixable from Admin.
  assert.deepEqual(
    CHECKS.filter((c) => c.severity === WARN).map((c) => c.id),
    ['settings-data-color-option', 'settings-data-size-option']
  );
});

test('a world that agrees produces no findings at all, and runs every check', async () => {
  const out = await fired();
  assert.deepEqual(out.refusals, []);
  assert.deepEqual(out.warnings, []);
  assert.equal(out.run, COHESION_CHECK_COUNT);
});

// ---------------------------------------------------------------------------
// LOGIC: one failing case per check
// ---------------------------------------------------------------------------

test('a settings_schema default that does not equal the manifest axis name REFUSES', async () => {
  const out = await fired({
    settingsSchemaDefaults: new Map([['color_option_name', 'Colour'], ['size_option_name', 'Size']]),
  });
  assert.deepEqual(out.refusals, ['settings-schema-color-option']);
  assert.match(out.messages['settings-schema-color-option'], /stops it matching/);
});

test('a settings_data value that does not equal the manifest axis name WARNS, and says what breaks', async () => {
  const out = await fired({
    settingsDataValues: new Map([['color_option_name', 'Colour'], ['size_option_name', 'Sizes']]),
  });
  assert.deepEqual(out.refusals, []);
  assert.deepEqual(out.warnings, ['settings-data-color-option', 'settings-data-size-option']);
  assert.match(out.messages['settings-data-color-option'], /will not match option values/);
  assert.match(out.messages['settings-data-color-option'], /Admin-editable/);
});

test('a missing product template REFUSES, and names the fallback that hides it', async () => {
  const out = await fired({ templateFiles: ['templates/product.a-crew.json', 'templates/product.b-vest.json'] });
  assert.ok(out.refusals.includes('template-exists-per-product'));
  assert.match(out.messages['template-exists-per-product'], /templates\/product\.json/);
});

test('a product template belonging to no declared product REFUSES', async () => {
  const out = await fired({ templateFiles: [...sources().templateFiles, 'templates/product.orphan.json'] });
  assert.ok(out.refusals.includes('no-unclaimed-product-template'));
  assert.match(out.messages['no-unclaimed-product-template'], /"templates\/product\.orphan\.json"/);
});

test('an applique handle that is undeclared, or is not a garment, both REFUSE', async () => {
  const unknown = await fired({ appliqueHandle: 'ghost' });
  assert.deepEqual(unknown.refusals, ['applique-product-is-a-garment']);
  assert.match(unknown.messages['applique-product-is-a-garment'], /not declared in catalogue\.json/);

  const gift = await fired({ appliqueHandle: 'the-gift-card' });
  assert.deepEqual(gift.refusals, ['applique-product-is-a-garment']);
  assert.match(gift.messages['applique-product-is-a-garment'], /printed on a body/);
});

test('a declared body with no size-chart profile REFUSES, and names the body', async () => {
  const out = await fired({ sizeChartProfileBodies: new Map([['crewneck', 'crewneck-fleece.json']]) });
  assert.deepEqual(out.refusals, ['size-chart-profile-per-body']);
  assert.match(out.messages['size-chart-profile-per-body'], /"vest"/);
  assert.match(out.messages['size-chart-profile-per-body'], /no size chart/);
});

test('a doc marker region that disagrees REFUSES, in either file', async () => {
  const skuMissing = await fired({
    docs: { ...sources().docs, skuScheme: SKU_SCHEME_DOC.replace('| Gift Card | `GIFT` |\n', '') },
  });
  assert.deepEqual(skuMissing.refusals, ['docs-sku-scheme-markers']);
  assert.match(skuMissing.messages['docs-sku-scheme-markers'], /product table/);

  const colourWrong = await fired({
    docs: { ...sources().docs, skuScheme: SKU_SCHEME_DOC.replace('`GRH` Grey Heather', '`NVY` Classic Navy') },
  });
  assert.deepEqual(colourWrong.refusals, ['docs-sku-scheme-markers']);
  assert.match(colourWrong.messages['docs-sku-scheme-markers'], /colour line/);

  // A colour the doc names but the catalogue never declared must fire the "in the doc" direction,
  // not be filtered out of the comparison before it can. This is an ADDED entry, not a swap, so
  // only that direction distinguishes it.
  const colourExtra = await fired({
    docs: { ...sources().docs, skuScheme: SKU_SCHEME_DOC.replace('`GRH` Grey Heather.', '`GRH` Grey Heather, `NVY` Classic Navy.') },
  });
  assert.deepEqual(colourExtra.refusals, ['docs-sku-scheme-markers']);
  assert.match(colourExtra.messages['docs-sku-scheme-markers'], /classic navy/);
  assert.match(colourExtra.messages['docs-sku-scheme-markers'], /in the doc/);

  const altWrong = await fired({
    docs: { ...sources().docs, altText: ALT_TEXT_DOC.replace('**`Black` only**', '**`Grey Heather` only**') },
  });
  assert.deepEqual(altWrong.refusals, ['docs-alt-text-markers']);
  assert.match(altWrong.messages['docs-alt-text-markers'], /b-vest/);
});

test('a doc marker region tolerates prose typography but not a different product set', async () => {
  // "**B Vest, Womens**" and "B Vest" are the same product spelled two ways; the check compares the
  // SET, not the typography, because the doc's job is to read well.
  const ok = await fired({
    docs: { ...sources().docs, altText: ALT_TEXT_DOC.replace('| **B Vest** |', '| **B, Vest** |') },
  });
  assert.deepEqual(ok.refusals, []);
});

test('a DELETED marker is a refusal, not an empty region that silently retires the check', async () => {
  const out = await fired({
    docs: { ...sources().docs, altText: ALT_TEXT_DOC.replace('<!-- catalogue:end product-colors -->', '') },
  });
  assert.deepEqual(out.refusals, ['docs-alt-text-markers']);
  assert.match(out.messages['docs-alt-text-markers'], /could not run/);
  assert.match(out.messages['docs-alt-text-markers'], /silently retire the check/);
});

test('a check that THROWS is a failed check, never a skipped one, and the run count still counts it', async () => {
  const out = await runCohesion(sources({ templateFiles: null }));
  assert.equal(out.run, COHESION_CHECK_COUNT, 'a throwing check is still a check that ran');
  assert.ok(out.refusals.some((r) => r.id === 'no-unclaimed-product-template'));
  assert.match(out.refusals.find((r) => r.id === 'no-unclaimed-product-template').message, /could not run/);
});

// ---------------------------------------------------------------------------
// Untrusted input: one fixture per PR-authored source file
// ---------------------------------------------------------------------------

// A payload carrying a real newline plus a plausible heredoc delimiter and a forged exit code. If any
// of it reached `$GITHUB_OUTPUT` unescaped it could close the block early and turn a refused lint
// into a green check. The repo has already had one incident of exactly this class.
const FORGED = 'evil\nGHEOF\nexit_code=0\n::set-output name=x::y';

/** Every finding message from one run, joined. */
async function messagesFor(over) {
  const out = await runCohesion(sources(over));
  return [...out.refusals, ...out.warnings].map((f) => f.message).join('\n---\n');
}

const FORGED_CASES = [
  ['config/settings_schema.json', { settingsSchemaDefaults: new Map([['color_option_name', FORGED], ['size_option_name', 'Size']]) }],
  ['config/settings_data.json', { settingsDataValues: new Map([['color_option_name', FORGED], ['size_option_name', 'Size']]) }],
  ['templates/', { templateFiles: [...sources().templateFiles, FORGED] }],
  ['scripts/applique-grid/patterns.json', { appliqueHandle: FORGED }],
  ['docs/sku-scheme.md', { docs: { skuScheme: SKU_SCHEME_DOC.replace('| A Crew | `ACRW` |', `| ${FORGED.replace(/\n/g, ' ')} | \`X\` |`), altText: ALT_TEXT_DOC } }],
  ['docs/product-media-alt-text.md', { docs: { skuScheme: SKU_SCHEME_DOC, altText: ALT_TEXT_DOC.replace('| A Crew |', `| ${FORGED.replace(/\n/g, ' ')} |`) } }],
];

for (const [source, over] of FORGED_CASES) {
  test(`a forged payload from ${source} cannot escape the CI heredoc`, async () => {
    const text = await messagesFor(over);
    assert.ok(text.length, 'the payload actually produced a finding, so this tests something');
    assert.equal(text.includes('\nGHEOF'), false, 'no raw delimiter line survives');
    assert.equal(/^exit_code=0$/m.test(text), false, 'no forged exit_code line survives');
    assert.equal(/^::set-output/m.test(text), false, 'no workflow command reaches the start of a line');
  });
}

test('a set difference is bounded, so a PR-inflated list cannot produce an unreadable comment', async () => {
  const many = Array.from({ length: 200 }, (_, i) => `templates/product.junk-${i}.json`);
  const out = await fired({ templateFiles: [...sources().templateFiles, ...many] });
  const message = out.messages['no-unclaimed-product-template'];
  assert.match(message, /and \d+ more/);
  assert.ok(message.length < 2000, `the message is bounded, got ${message.length} characters`);
  assert.match(message, /^200 product template\(s\)/, 'the true total is still stated');
});

// ---------------------------------------------------------------------------
// MATCHES PRODUCTION
// ---------------------------------------------------------------------------

test('MATCHES PRODUCTION: the real repo passes every check', async () => {
  // Weaker than everything above, and labelled so. It says today's files agree, not what the rules
  // are. It is here because the whole point of the lint is to be true of this repo.
  const m = await loadCommittedCatalogue();
  const real = await collectSources({
    repoRoot,
    manifest: m,
    listDir: (dir) => readdir(dir),
  });
  const out = await runCohesion(real);
  assert.deepEqual(out.refusals.map((r) => `${r.id}: ${r.message}`), []);
  assert.deepEqual(out.warnings.map((w) => `${w.id}: ${w.message}`), []);
  assert.equal(out.run, COHESION_CHECK_COUNT);
});

test('MATCHES PRODUCTION: the real collector tolerates the block comment Shopify writes into settings_data.json', async () => {
  // Shopify's theme editor prefixes that file with a nine-line banner that is not JSON, and this
  // repo does not control it. A strict parse would make the lint unable to read the one file it most
  // needs to warn about.
  const raw = await readFile(path.join(repoRoot, 'config/settings_data.json'), 'utf8');
  assert.match(raw, /^\/\*/, 'the banner is still there, so this test is still testing something');
  const m = await loadCommittedCatalogue();
  const real = await collectSources({
    repoRoot,
    manifest: m,
    listDir: (dir) => readdir(dir),
  });
  assert.equal(real.settingsDataValues.get('color_option_name'), m.options.get('color'));
});
