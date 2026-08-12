import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  colorwayToAdminValue, productForLineGarment, productForHandle, recognizedColorValues,
  matchedColorValues, altColorProblem, parseName, normalizeName,
} from './photo-naming.mjs';

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
