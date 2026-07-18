import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  colorwayToAdminValue, productForLineGarment, recognizedColorValues,
  matchedColorValues, altColorProblem, parseName, normalizeName,
} from './photo-naming.mjs';

// --- colorwayToAdminValue ------------------------------------------------------------------
test('colorwayToAdminValue maps the general colorway tokens', () => {
  assert.equal(colorwayToAdminValue('black'), 'Black');
  assert.equal(colorwayToAdminValue('classic-navy'), 'Navy');
  assert.equal(colorwayToAdminValue('grey-heather'), 'Gray');
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
  assert.equal(colorwayToAdminValue('classic-navy', 'lead2/crew-sweater'), 'Navy');
});

// --- productForLineGarment / recognizedColorValues -----------------------------------------
test('productForLineGarment resolves known pairs and rejects unknown', () => {
  assert.equal(productForLineGarment('lead2', 'crew-sweater').handle, 'lead-ii-crewneck');
  assert.equal(productForLineGarment('nope', 'nope'), null);
});

test('recognizedColorValues returns a defensive copy and [] for unknown keys', () => {
  const values = recognizedColorValues('lead2/crew-sweater');
  assert.deepEqual(values, ['Black', 'Gray', 'Navy']);
  values.push('Chartreuse'); // mutate the returned array
  assert.deepEqual(recognizedColorValues('lead2/crew-sweater'), ['Black', 'Gray', 'Navy']);
  assert.deepEqual(recognizedColorValues('nope/nope'), []);
});

// --- matchedColorValues --------------------------------------------------------------------
test('matchedColorValues matches whole words with separator awareness', () => {
  assert.deepEqual(matchedColorValues('', ['Black']), []);
  assert.deepEqual(matchedColorValues('Black crewneck, flat', ['Black', 'Gray', 'Navy']), ['Black']);
  assert.deepEqual(matchedColorValues('crew (Navy)', ['Navy']), ['Navy']);
  // An embedded, non-word-bounded occurrence does NOT match.
  assert.deepEqual(matchedColorValues('Blackout hoodie', ['Black']), []);
});

test('matchedColorValues preserves values order and escapes regex metacharacters', () => {
  assert.deepEqual(matchedColorValues('shot in Navy and Black', ['Black', 'Navy']), ['Black', 'Navy']);
  // A value with regex metachars is matched literally, not as a pattern.
  assert.deepEqual(matchedColorValues('the A+ colour', ['A+']), ['A+']);
});

test('matchedColorValues does NOT shadow (documents the single-word-only limitation)', () => {
  // Current behaviour: both a containing multi-word value and the contained value match.
  // Every live Color value is a single word, so this never bites today; see the function doc.
  assert.deepEqual(matchedColorValues('light blue flat', ['Blue', 'Light Blue']), ['Blue', 'Light Blue']);
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
  assert.match(altColorProblem('Navy crewneck', 'Black', KEY), /expected exactly "Black"/);
  assert.match(altColorProblem('a plain crewneck', 'Black', KEY), /names no recognized colour value/);
  assert.match(altColorProblem('Black and Navy crewneck', 'Black', KEY), /expected exactly "Black"/);
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
test('normalizeName yields kebab canonical and underscore canonicalSource', () => {
  const n = normalizeName('lead2_quarter-zip_black_emt_flat-1.jpg');
  assert.equal(n.canonical, 'lead2-quarter-zip-black-emt-flat-1.jpg');
  assert.equal(n.canonicalSource, 'lead2_quarter-zip_black_emt_flat-1.jpg');
  assert.equal(n.uncertain, false);
});

test('normalizeName falls back to a kebab collapse for an unparseable name', () => {
  const n = normalizeName('!!!.jpg');
  assert.equal(n.canonical, 'image.jpg'); // empty collapse guarded to 'image'
  assert.equal(n.canonicalSource, 'image.jpg');
  assert.equal(n.uncertain, true);
});
