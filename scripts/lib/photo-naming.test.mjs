import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createNaming, defaultNaming, matchedColorValues, bodyPhotoToken, photoTokenBodies,
} from './photo-naming.mjs';
import { parseCatalogue, loadCommittedCatalogue } from './catalogue-manifest.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// A HAND-AUTHORED manifest, not the committed one. The naming vocabulary is derived now, so feeding
// these tests the live file would turn every assertion below into a statement about today's
// catalogue, and would rewrite itself the next time a product shipped. It mirrors the live SHAPE
// (three bodies, three colours, a Black-only women's vest, a gift card that is not a garment and
// is therefore keyed by its handle with no colour vocabulary) with synthetic GIDs.
const MANIFEST = parseCatalogue(
  JSON.stringify({
    version: 2,
    options: { color: 'Color', size: 'Size', design: 'Design', denomination: 'Denominations' },
    colors: {
      black: { display: 'Black', slug: 'black' },
      'grey heather': { display: 'Grey Heather', slug: 'grey-heather' },
      'classic navy': { display: 'Classic Navy', slug: 'classic-navy' },
    },
    sizes: { s: { display: 'S' }, m: { display: 'M' } },
    bodies: {
      crewneck: { colors: ['black', 'grey heather', 'classic navy'], sizes: ['s', 'm'] },
      'quarter-zip': { colors: ['black', 'grey heather', 'classic navy'], sizes: ['s', 'm'] },
      'vest-womens': { colors: ['black'], sizes: ['s', 'm'] },
    },
    products: {
      'huddle-crewneck': { line: 'huddle', body: 'crewneck', template: 'huddle-crewneck', title: 'Huddle Crewneck', gid: 'gid://shopify/Product/1' },
      'lead-ii-crewneck': { line: 'lead2', body: 'crewneck', template: 'lead-ii-crewneck', title: 'Lead II Crewneck', gid: 'gid://shopify/Product/2' },
      'lead-ii-quarter-zip': { line: 'lead2', body: 'quarter-zip', template: 'lead-ii-quarter-zip', title: 'Lead II Quarter-Zip', gid: 'gid://shopify/Product/3' },
      'lead-ii-vest-womens': { line: 'lead2', body: 'vest-womens', template: 'lead-ii-vest-womens', title: "Lead II Vest - Women's", gid: 'gid://shopify/Product/4' },
      'shift-fuel-crewneck': { line: 'shift-fuel', body: 'crewneck', template: 'shift-fuel-crewneck', title: 'Shift Fuel Crewneck', gid: 'gid://shopify/Product/5' },
      'the-gift-card': { line: null, body: null, template: 'gift-card', title: 'Gift Card', gid: 'gid://shopify/Product/6' },
    },
  })
);

const {
  colorwayToAdminValue, productForLineGarment, productForHandle, recognizedColorValues,
  altColorProblem, parseName, normalizeName,
} = createNaming(MANIFEST);

// --- the derivation ------------------------------------------------------------------------

test('createNaming derives every closed set from the manifest', () => {
  const n = createNaming(MANIFEST);
  assert.deepEqual(n.LINES, ['huddle', 'lead2', 'shift-fuel'], 'lines in product declaration order');
  assert.deepEqual(n.GARMENTS, ['crew-sweater', 'quarter-zip', 'vest'], 'filename tokens, not body ids');
  assert.deepEqual(n.COLORWAYS, ['black', 'grey-heather', 'classic-navy', 'group']);
  assert.deepEqual(Object.keys(n.PRODUCTS), [
    'huddle/crew-sweater',
    'lead2/crew-sweater',
    'lead2/quarter-zip',
    'lead2/vest',
    'shift-fuel/crew-sweater',
    'the-gift-card',
  ]);
  // The gift card has no body: it is keyed by its handle, with no line, garment or colours.
  assert.deepEqual(n.NON_GARMENTS, ['the-gift-card']);
  const card = n.productForHandle('the-gift-card');
  assert.equal(card.key, 'the-gift-card');
  assert.deepEqual(card.record, {
    line: null, garment: null, title: 'Gift Card', handle: 'the-gift-card', gid: 'gid://shopify/Product/6', colorValues: [],
  });
  assert.deepEqual(n.recognizedColorValues('the-gift-card'), []);
  // The hyphen-recovery vocabulary is every multi-word token, longest first; a non-garment handle
  // is one of them so an all-hyphen source name can still be recovered.
  assert.deepEqual(n.MULTIWORD_TOKENS, ['the-gift-card', 'classic-navy', 'crew-sweater', 'grey-heather', 'quarter-zip', 'shift-fuel']);
});

test('a colour added to the manifest becomes a colorway token with no edit here', () => {
  const withSand = createNaming(
    parseCatalogue(
      JSON.stringify({
        version: 2,
        options: { color: 'Color', size: 'Size', design: 'Design', denomination: 'Denominations' },
        colors: { black: { display: 'Black', slug: 'black' }, 'desert sand': { display: 'Desert Sand', slug: 'desert-sand' } },
        sizes: { s: { display: 'S' } },
        bodies: { crewneck: { colors: ['black', 'desert sand'], sizes: ['s'] } },
        products: {
          'huddle-crewneck': { line: 'huddle', body: 'crewneck', template: 'huddle-crewneck', title: 'Huddle Crewneck', gid: 'gid://shopify/Product/1' },
        },
      })
    )
  );
  assert.equal(withSand.colorwayToAdminValue('desert-sand'), 'Desert Sand');
  assert.equal(withSand.parseName('huddle_crew-sweater_desert-sand_flat-1.jpg').uncertain, false);
  assert.ok(withSand.MULTIWORD_TOKENS.includes('desert-sand'), 'the hyphen parser learns it too');
});

test('two products sharing a line and a body refuse loudly rather than silently overwriting a census key', () => {
  const clash = JSON.stringify({
    version: 2,
    options: { color: 'Color', size: 'Size', design: 'Design', denomination: 'Denominations' },
    colors: { black: { display: 'Black', slug: 'black' } },
    sizes: { s: { display: 'S' } },
    bodies: { crewneck: { colors: ['black'], sizes: ['s'] } },
    products: {
      'huddle-crewneck': { line: 'huddle', body: 'crewneck', template: 'huddle-crewneck', title: 'Huddle Crewneck', gid: 'gid://shopify/Product/1' },
      'huddle-crewneck-ii': { line: 'huddle', body: 'crewneck', template: 'huddle-crewneck-ii', title: 'Huddle Crewneck II', gid: 'gid://shopify/Product/2' },
    },
  });
  assert.throws(
    () => createNaming(parseCatalogue(clash)),
    /"huddle-crewneck" and "huddle-crewneck-ii" both resolve to photo census key "huddle\/crew-sweater"/
  );
});

test('a body with no filename token refuses loudly rather than naming a product after a body id', () => {
  const scarf = JSON.stringify({
    version: 2,
    options: { color: 'Color', size: 'Size', design: 'Design', denomination: 'Denominations' },
    colors: { black: { display: 'Black', slug: 'black' } },
    sizes: { s: { display: 'S' } },
    bodies: { scarf: { colors: ['black'], sizes: ['s'] } },
    products: {
      'lead-ii-scarf': { line: 'lead2', body: 'scarf', template: 'lead-ii-scarf', title: 'Lead II Scarf', gid: 'gid://shopify/Product/1' },
    },
  });
  assert.throws(() => createNaming(parseCatalogue(scarf)), /No photo filename token for body "scarf"/);
});

// --- BODY_PHOTO_TOKEN, both directions, against the committed manifest -----------------------

test('MATCHES PRODUCTION: the filename-token map covers every declared body and invents none', async () => {
  // The one hand-authored table left in this module. A photo filename is typed by hand and already
  // printed on files on disk and on uploaded Shopify filenames, so its tokens cannot follow a
  // manifest rename; this is what stops the map going stale in either direction instead.
  const manifest = await loadCommittedCatalogue();
  const declared = [...manifest.bodies.keys()];
  assert.deepEqual([...photoTokenBodies()].sort(), [...declared].sort());
  for (const body of declared) assert.ok(bodyPhotoToken(body), `${body} has a filename token`);
});

test('MATCHES PRODUCTION: defaultNaming records every declared product, garment or not, and no other', async () => {
  const manifest = await loadCommittedCatalogue();
  const n = defaultNaming();
  assert.deepEqual(
    Object.values(n.PRODUCTS).map((p) => p.handle).sort(),
    [...manifest.products.keys()].sort()
  );
  for (const p of manifest.products.values()) {
    const hit = n.productForHandle(p.handle);
    assert.ok(hit, `${p.handle} resolves by handle`);
    if (p.body === null) {
      assert.equal(hit.key, p.handle, `${p.handle} is keyed by its handle`);
      assert.deepEqual(hit.record.colorValues, [], `${p.handle} has no colour vocabulary`);
    } else {
      assert.ok(hit.key.includes('/'), `${p.handle} is keyed line/garment`);
    }
  }
  assert.equal(n, defaultNaming(), 'the committed manifest is read once and memoised');
});

// --- colorwayToAdminValue ------------------------------------------------------------------
test('colorwayToAdminValue maps the general colorway tokens', () => {
  assert.equal(colorwayToAdminValue('black'), 'Black');
  assert.equal(colorwayToAdminValue('classic-navy'), 'Classic Navy');
  assert.equal(colorwayToAdminValue('grey-heather'), 'Grey Heather');
});

test('colorwayToAdminValue returns null for group and unknown tokens', () => {
  assert.equal(colorwayToAdminValue('group'), null);
  assert.equal(colorwayToAdminValue('chartreuse'), null);
});

test('colorwayToAdminValue honours the vest Black-only divergence', () => {
  // A value not reserved on the product resolves to null (photo goes shared there, not mis-bound).
  assert.equal(colorwayToAdminValue('classic-navy', 'lead2/vest'), null);
  assert.equal(colorwayToAdminValue('grey-heather', 'lead2/vest'), null);
  assert.equal(colorwayToAdminValue('black', 'lead2/vest'), 'Black');
  // A product that reserves the value keeps it.
  assert.equal(colorwayToAdminValue('classic-navy', 'lead2/crew-sweater'), 'Classic Navy');
});

// --- productForLineGarment / productForHandle / recognizedColorValues ----------------------
test('productForLineGarment resolves known pairs and rejects unknown', () => {
  assert.equal(productForLineGarment('lead2', 'crew-sweater').handle, 'lead-ii-crewneck');
  assert.equal(productForLineGarment('nope', 'nope'), null);
});

test('productForHandle reverse-resolves a handle to { key, record } and rejects unknown', () => {
  const hit = productForHandle('lead-ii-crewneck');
  assert.equal(hit.key, 'lead2/crew-sweater');
  assert.equal(hit.record.handle, 'lead-ii-crewneck');
  assert.equal(productForHandle('no-such-handle'), null);
  assert.equal(productForHandle(''), null);
});

test('recognizedColorValues returns a defensive copy and [] for unknown keys', () => {
  const values = recognizedColorValues('lead2/crew-sweater');
  assert.deepEqual(values, ['Black', 'Grey Heather', 'Classic Navy']);
  values.push('Chartreuse'); // mutate the returned array
  assert.deepEqual(recognizedColorValues('lead2/crew-sweater'), ['Black', 'Grey Heather', 'Classic Navy']);
  assert.deepEqual(recognizedColorValues('nope/nope'), []);
});

// --- matchedColorValues --------------------------------------------------------------------
const LIVE = ['Black', 'Grey Heather', 'Classic Navy'];

// Contract table, copied VERBATIM into the matchedColorValues doc comment in photo-naming.mjs.
// There is no executable Liquid oracle for theme parity, so this table and that comment are the
// pinned statement of the storefront behaviour; keep the two in lockstep.
const CONTRACT = [
  ['Black crewneck, flat', LIVE, ['Black']],
  ['Grey-Heather crewneck', LIVE, ['Grey Heather']],
  ['Grey/Heather crewneck', LIVE, ['Grey Heather']],
  ['grey_heather flat', LIVE, ['Grey Heather']],
  ['Grey  Heather crewneck', LIVE, []],
  ['Classic, Navy crewneck', LIVE, []],
  ['Navy crewneck', LIVE, []],
  ['Grey\u00a0Heather crewneck', LIVE, []],
  ['Grey\tHeather crewneck', LIVE, []],
  ['light blue flat', ['Blue', 'Light Blue'], ['Light Blue']],
  ['Blackout hoodie', ['Black'], []],
];

test('matchedColorValues honours the pinned contract table (theme parity)', () => {
  for (const [alt, values, expected] of CONTRACT) {
    assert.deepEqual(matchedColorValues(alt, values), expected, `alt "${alt}"`);
  }
});

test('matchedColorValues matches whole words with separator awareness', () => {
  assert.deepEqual(matchedColorValues('', LIVE), []);
  assert.deepEqual(matchedColorValues('crew (Classic Navy)', LIVE), ['Classic Navy']);
  // Leading/trailing separators around the alt are boundaries too.
  assert.deepEqual(matchedColorValues('-Black-', LIVE), ['Black']);
  // Case-insensitive across a multi-word phrase.
  assert.deepEqual(matchedColorValues('GREY Heather flat', LIVE), ['Grey Heather']);
});

test('matchedColorValues preserves values order and treats value text literally', () => {
  assert.deepEqual(matchedColorValues('shot in Classic Navy and Black', LIVE), ['Black', 'Classic Navy']);
  // A value with regex metacharacters is matched literally, not as a pattern.
  assert.deepEqual(matchedColorValues('the A+ colour', ['A+']), ['A+']);
  // Separators inside the VALUE normalize like separators inside the alt.
  assert.deepEqual(matchedColorValues('Black (Heather) crew', ['Black (Heather)']), ['Black (Heather)']);
});

test('matchedColorValues normalizes the value side symmetrically with the alt side', () => {
  // The apostrophe is a separator on both sides: "Robin's Egg" is "robin s egg" everywhere.
  assert.deepEqual(matchedColorValues("the robin's egg vest", ["Robin's Egg"]), ["Robin's Egg"]);
  assert.deepEqual(matchedColorValues('robin s egg vest', ["Robin's Egg"]), ["Robin's Egg"]);
  // A hyphenated value matches a spaced alt and vice versa.
  assert.deepEqual(matchedColorValues('grey heather flat', ['Grey-Heather']), ['Grey-Heather']);
});

test('matchedColorValues never throws on degenerate inputs and never matches a blank value', () => {
  assert.deepEqual(matchedColorValues('---', LIVE), []);
  assert.deepEqual(matchedColorValues('Black crewneck', []), []);
  // A blank value's padded form is pure whitespace; it must not "match" a doubled-separator alt.
  assert.deepEqual(matchedColorValues('Classic, Navy crewneck', ['', 'Black']), []);
  assert.deepEqual(matchedColorValues('anything at all', ['   ']), []);
});

test('matchedColorValues applies the shadow rule (theme parity)', () => {
  // The shorter value appearing only inside the longer one is suppressed.
  assert.deepEqual(matchedColorValues('light blue flat', ['Blue', 'Light Blue']), ['Light Blue']);
  // The shorter value present independently AND inside the longer one is still suppressed,
  // exactly as the theme hides that photo under a selected "Blue".
  assert.deepEqual(matchedColorValues('blue trim on the light blue vest', ['Blue', 'Light Blue']), ['Light Blue']);
  // Order independence: the containing value may be listed first or last.
  assert.deepEqual(matchedColorValues('light blue flat', ['Light Blue', 'Blue']), ['Light Blue']);
  // No shadow when the shorter value stands alone.
  assert.deepEqual(matchedColorValues('blue flat', ['Blue', 'Light Blue']), ['Blue']);
});

// --- altColorProblem -----------------------------------------------------------------------
const KEY = 'lead2/crew-sweater';

test('altColorProblem skips empty alt', () => {
  assert.equal(altColorProblem('', 'Black', KEY), null);
  assert.equal(altColorProblem('   ', 'Black', KEY), null);
});

test('altColorProblem accepts an exact single match', () => {
  assert.equal(altColorProblem('Black crewneck, flat lay', 'Black', KEY), null);
});

test('altColorProblem flags wrong, missing, and extra colour values', () => {
  assert.match(altColorProblem('Classic Navy crewneck', 'Black', KEY), /expected exactly "Black"/);
  assert.match(altColorProblem('a plain crewneck', 'Black', KEY), /names no recognized colour value/);
  assert.match(altColorProblem('Black and Classic Navy crewneck', 'Black', KEY), /expected exactly "Black"/);
});

test('altColorProblem handles multi-word values', () => {
  assert.equal(altColorProblem('Classic Navy crewneck laid flat', 'Classic Navy', KEY), null);
  // "Navy" alone is not a value on this vocabulary; the alt binds nothing and goes shared.
  assert.match(altColorProblem('Navy crewneck laid flat', 'Classic Navy', KEY), /names no recognized colour value/);
  // A doubled separator breaks the phrase the same way it does on the storefront.
  assert.match(altColorProblem('Classic, Navy crewneck', 'Classic Navy', KEY), /names no recognized colour value/);
  assert.match(altColorProblem('Grey Heather and Classic Navy crewnecks', 'Classic Navy', KEY), /expected exactly "Classic Navy"/);
});

test('altColorProblem on a non-garment product accepts any alt: there is no value to name or to avoid', () => {
  assert.equal(altColorProblem('Canvas tote, front, flat on white', null, 'the-gift-card'), null);
  // A garment colour word is not in this product's (empty) vocabulary, so it is plain prose here.
  assert.equal(altColorProblem('Gift card on a black background', null, 'the-gift-card'), null);
});

test('altColorProblem enforces the shared/group rule', () => {
  assert.equal(altColorProblem('the team in matching sweaters', null, KEY), null);
  assert.match(altColorProblem('Black group shot', null, KEY), /would bind instead of staying shared/);
});

// --- parseName -----------------------------------------------------------------------------
test('parseName parses a 4-field name with a numeric index', () => {
  const p = parseName('huddle_crew-sweater_black_flat-1.jpg');
  assert.equal(p.ok, true);
  assert.equal(p.uncertain, false);
  assert.deepEqual(
    [p.line, p.garment, p.colorway, p.design, p.shot],
    ['huddle', 'crew-sweater', 'black', null, 'flat'],
  );
  assert.equal(p.index, 1);
  assert.equal(typeof p.index, 'number');
});

test('parseName parses a 5-field name with an open design token', () => {
  const p = parseName('lead2_quarter-zip_black_emt_flat-1.jpg');
  assert.equal(p.ok, true);
  assert.equal(p.uncertain, false);
  assert.equal(p.design, 'emt');
});

test('parseName applies confident repairs without marking the name uncertain', () => {
  // Known garment typo repaired via FIELD_TYPOS.
  const zip = parseName('lead2_quarterzip_black_flat-1.jpg');
  assert.equal(zip.garment, 'quarter-zip');
  assert.equal(zip.uncertain, false);
  // caffine -> caffeine repair on an open design token.
  const caf = parseName('shift-fuel_crew-sweater_black_caffine_flat-1.jpg');
  assert.equal(caf.design, 'caffeine');
  assert.equal(caf.uncertain, false);
});

test('parseName recovers all-hyphen names as a confident (not uncertain) repair', () => {
  const p = parseName('lead2-quarter-zip-black-emt-flat-1.jpg');
  assert.equal(p.ok, true);
  assert.equal(p.uncertain, false);
  assert.deepEqual(p.fields, ['lead2', 'quarter-zip', 'black', 'emt', 'flat-1']);
  assert.ok(p.warnings.some((w) => w.includes('field separators were hyphens')));
});

test('parseName parses the non-garment form <handle>_<shot>-<index> to the handle, with no colour', () => {
  const p = parseName('the-gift-card_flat-1.jpg');
  assert.equal(p.ok, true);
  assert.equal(p.uncertain, false);
  assert.deepEqual(p.warnings, []);
  assert.equal(p.product, 'the-gift-card');
  assert.equal(p.shot, 'flat');
  assert.equal(p.index, 1);
  assert.equal(p.line, null);
  assert.equal(p.garment, null);
  assert.equal(p.colorway, null);
  assert.deepEqual(p.fields, ['the-gift-card', 'flat-1']);
  assert.equal(normalizeName('the-gift-card_flat-1.jpg').canonical, 'the-gift-card_flat-1.jpg');
  // The garment forms report product null; their product comes from (line, garment).
  assert.equal(parseName('lead2_crew-sweater_black_flat-1.jpg').product, null);
});

test('parseName recovers an all-hyphen non-garment name as a confident repair', () => {
  const p = parseName('the-gift-card-styled-2.jpg');
  assert.equal(p.ok, true);
  assert.equal(p.uncertain, false);
  assert.equal(p.product, 'the-gift-card');
  assert.equal(p.shot, 'styled');
  assert.equal(p.index, 2);
  assert.deepEqual(p.warnings, ['field separators were hyphens; expected underscores between fields']);
  assert.equal(normalizeName('the-gift-card-styled-2.jpg').canonical, 'the-gift-card_styled-2.jpg');
});

test('parseName marks a non-garment name uncertain on an unknown shot or a missing index', () => {
  const badShot = parseName('the-gift-card_portrait-1.jpg');
  assert.equal(badShot.ok, true);
  assert.equal(badShot.uncertain, true);
  assert.ok(badShot.warnings.some((w) => w.includes('unknown shot "portrait"')));
  const noIndex = parseName('the-gift-card_flat.jpg');
  assert.equal(noIndex.uncertain, true);
  assert.ok(noIndex.warnings.some((w) => w.includes('no -<index> suffix')));
  // Two fields whose first is NOT a declared non-garment handle is still a bad field count.
  const twoFields = parseName('some-thing_flat-1.jpg');
  assert.equal(twoFields.ok, false);
  assert.equal(twoFields.product, null);
});

test('parseName flags a bad field count as not-ok and uncertain', () => {
  const few = parseName('a_b_c.jpg');
  assert.equal(few.ok, false);
  assert.equal(few.uncertain, true);
  assert.ok(few.warnings.some((w) => w.includes('expected 4 or 5 fields')));
  assert.equal(parseName('a_b_c_d_e_f.jpg').ok, false);
});

test('parseName keeps ok true but marks uncertain for a missing shot index', () => {
  const p = parseName('huddle_crew-sweater_black_flat.jpg');
  assert.equal(p.ok, true);
  assert.equal(p.uncertain, true);
  assert.equal(p.index, null);
  assert.ok(p.warnings.some((w) => w.includes('no -<index> suffix')));
});

test('parseName warns and marks uncertain on an unknown closed-set token', () => {
  const p = parseName('nope_crew-sweater_black_flat-1.jpg');
  assert.equal(p.uncertain, true);
  assert.ok(p.warnings.some((w) => w.includes('unknown line')));
});

test('parseName warns when a group shot carries a design field', () => {
  const p = parseName('huddle_crew-sweater_group_emt_flat-1.jpg');
  assert.equal(p.uncertain, true);
  assert.ok(p.warnings.some((w) => w.includes('group shot should not carry a design field')));
});

// --- normalizeName -------------------------------------------------------------------------
test('normalizeName yields one underscore-separated canonical name (output === source scheme)', () => {
  const n = normalizeName('lead2_quarter-zip_black_emt_flat-1.jpg');
  assert.equal(n.canonical, 'lead2_quarter-zip_black_emt_flat-1.jpg');
  assert.equal(n.uncertain, false);
  // Field separators are underscores; only multi-word field values keep internal hyphens.
  assert.equal(n.canonical.split('_').length, 5);
});

test('normalizeName recovers an all-hyphen source to the underscore canonical', () => {
  const n = normalizeName('lead2-quarter-zip-black-emt-flat-1.jpg');
  assert.equal(n.canonical, 'lead2_quarter-zip_black_emt_flat-1.jpg');
  assert.equal(n.uncertain, false);
});

test('normalizeName falls back to a hyphen collapse for an unparseable name', () => {
  const n = normalizeName('!!!.jpg');
  assert.equal(n.canonical, 'image.jpg'); // empty collapse guarded to 'image'
  assert.equal(n.uncertain, true);
});
