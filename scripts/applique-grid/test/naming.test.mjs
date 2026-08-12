import test from 'node:test';
import assert from 'node:assert/strict';
import {
  charsetProblem, colorConflicts, nameColorProblem,
  buildChartAlt, ALT_MAX, isChartAlt,
  chartFilename, isChartFilename, basenameFromUrl,
  chartSpec, specHash, hash8,
} from '../lib/naming.mjs';

// The live Huddle vocabulary the guard runs against.
const VALUES = ['Black', 'Grey Heather', 'Classic Navy'];

// ---------------------------------------------------------------------------
// Colour guard. These vectors pin the VERIFIED storefront behaviour of
// snippets/product-media-gallery-content.liquid via matchedColorValues(): whole-word matching
// with the separator set - _ , . / ( ) : ; ' and whitespace; multi-word values match as the full
// phrase only. If any of these flips, the guard has drifted from the theme filter.
// ---------------------------------------------------------------------------

test('whole-word "black" conflicts at start, middle, and end', () => {
  assert.deepEqual(colorConflicts('Black Forest', VALUES), ['Black']);
  assert.deepEqual(colorConflicts('Deep Black Forest', VALUES), ['Black']);
  assert.deepEqual(colorConflicts('Forest Black', VALUES), ['Black']);
});

test('a name that IS a value conflicts', () => {
  assert.deepEqual(colorConflicts('Classic Navy', VALUES), ['Classic Navy']);
});

test('containment without a word boundary is safe (verified whole-word storefront semantics)', () => {
  // "blackout" and "Blacks" contain "black" but the filter only matches whole words; these are
  // safe on the storefront and must be safe here, or the guard would over-reject good names.
  assert.deepEqual(colorConflicts('Blackout Hour', VALUES), []);
  assert.deepEqual(colorConflicts('Blacks Peak', VALUES), []);
});

test("apostrophe is a separator: Black's conflicts", () => {
  assert.deepEqual(colorConflicts("Black's Meadow", VALUES), ['Black']);
});

test('multi-word value matches as the full phrase only', () => {
  assert.deepEqual(colorConflicts('Grey Heather Sky', VALUES), ['Grey Heather']);
  // Any single separator normalizes to a space on the storefront, so it binds and must conflict
  // here too ("Grey/Heather" previously slipped past the guard while binding on the storefront).
  assert.deepEqual(colorConflicts('Grey/Heather', VALUES), ['Grey Heather']);
  // Doubled whitespace still breaks the phrase; matches the storefront, which never collapses it.
  assert.deepEqual(colorConflicts('Grey  Heather', VALUES), []);
});

test('a phrase component alone is safe (grey is not a value)', () => {
  assert.deepEqual(colorConflicts('Grey Dawn', VALUES), []);
  assert.deepEqual(colorConflicts('Heather Field', VALUES), []);
});

test('matching is case-insensitive', () => {
  assert.deepEqual(colorConflicts('classic navy stripe', VALUES), ['Classic Navy']);
  assert.deepEqual(colorConflicts('BLACK IRIS', VALUES), ['Black']);
});

test('nameColorProblem wraps conflicts into an error string, null when safe', () => {
  assert.match(nameColorProblem('Black Forest', VALUES), /whole-word-matches Color value/);
  assert.equal(nameColorProblem('Sunset Bloom', VALUES), null);
});

// ---------------------------------------------------------------------------
// Charset.
// ---------------------------------------------------------------------------

test('charsetProblem rejects em dash, en dash, empties, and foreign punctuation', () => {
  assert.match(charsetProblem('A\u{2014}B'), /em dash/);
  assert.match(charsetProblem('Black\u{2013}Watch'), /en dash/);
  assert.match(charsetProblem(''), /empty/);
  assert.match(charsetProblem('   '), /empty/);
  assert.match(charsetProblem('A | B'), /outside the allowed set/);
  assert.match(charsetProblem('Caf\u{00e9}'), /outside the allowed set/);
});

test('charsetProblem accepts the full allowed set', () => {
  assert.equal(charsetProblem("Willow's Path (v2), No. 3: a/b-c_d;"), null);
});

// ---------------------------------------------------------------------------
// Alt template.
// ---------------------------------------------------------------------------

test('alt renders the pinned template, names only', () => {
  const alt = buildChartAlt({ page: 1, pages: 2, first: 1, last: 3, names: ['Sunset Bloom', 'Meadow Trace', 'Night Garden'] });
  assert.equal(alt, 'Applique pattern chart 1 of 2: patterns 1-3, Sunset Bloom, Meadow Trace, Night Garden');
  assert.ok(isChartAlt(alt));
});

test('the guard runs on the fully rendered alt string, not just names', () => {
  const alt = buildChartAlt({ page: 1, pages: 1, first: 1, last: 1, names: ['Black Forest'] });
  assert.deepEqual(colorConflicts(alt, VALUES), ['Black']);
});

test('alt boundary: exactly 512 passes, 513 hard-fails', () => {
  const overhead = buildChartAlt({ page: 1, pages: 1, first: 1, last: 1, names: ['A'] }).length - 1;
  const at512 = buildChartAlt({ page: 1, pages: 1, first: 1, last: 1, names: ['A'.repeat(ALT_MAX - overhead)] });
  assert.equal(at512.length, 512);
  assert.throws(
    () => buildChartAlt({ page: 1, pages: 1, first: 1, last: 1, names: ['A'.repeat(ALT_MAX - overhead + 1)] }),
    /513 characters \(limit 512\)/,
  );
});

test('isChartAlt matches only the pinned opening', () => {
  assert.ok(isChartAlt('Applique pattern chart 2 of 3: patterns 8-14, X'));
  assert.ok(!isChartAlt('Black crewneck, front view'));
  assert.ok(!isChartAlt('An applique pattern chart 1 of 2'));
});

// ---------------------------------------------------------------------------
// Filenames and URL parsing.
// ---------------------------------------------------------------------------

test('chartFilename embeds handle, page, total, and hash8', () => {
  assert.equal(
    chartFilename({ handle: 'huddle-crewneck', page: 2, pages: 3, hash8: 'abcd1234' }),
    'huddle-crewneck-applique-pattern-chart-2-of-3-abcd1234.jpg',
  );
});

test('isChartFilename: exact, CDN collision suffix, and rejections', () => {
  const h = 'huddle-crewneck';
  assert.ok(isChartFilename('huddle-crewneck-applique-pattern-chart-1-of-2-abcd1234.jpg', h));
  assert.ok(isChartFilename('huddle-crewneck-applique-pattern-chart-1-of-2-abcd1234_53a9bc.jpg', h));
  assert.ok(isChartFilename('HUDDLE-CREWNECK-APPLIQUE-PATTERN-CHART-1-OF-2-ABCD1234.JPG', h)); // case-insensitive on purpose
  assert.ok(!isChartFilename('lead-ii-crewneck-applique-pattern-chart-1-of-2-abcd1234.jpg', h));
  assert.ok(!isChartFilename('huddle-crewneck-flat-1.jpg', h));
  assert.ok(!isChartFilename('', h));
});

test('basenameFromUrl handles CDN-shaped inputs', () => {
  const base = 'huddle-crewneck-applique-pattern-chart-1-of-2-abcd1234.jpg';
  assert.equal(basenameFromUrl(`https://cdn.shopify.com/s/files/1/01/2/products/${base}`), base);
  assert.equal(basenameFromUrl(`https://cdn.shopify.com/s/files/1/01/2/products/${base}?v=1712345678`), base);
  assert.equal(basenameFromUrl(`https://cdn.shopify.com/s/files/1/01/2/products/${base}?v=1&width=3840`), base);
  // Collision suffix survives (the predicate, not the parser, tolerates it).
  const collided = base.replace('.jpg', '_x1y2z3.jpg');
  assert.equal(basenameFromUrl(`https://cdn.shopify.com/a/${collided}?v=2`), collided);
  assert.equal(basenameFromUrl('https://cdn.shopify.com/a/some%20file.jpg'), 'some file.jpg');
  assert.equal(basenameFromUrl('not a url'), '');
  assert.equal(basenameFromUrl(''), '');
});

// ---------------------------------------------------------------------------
// Spec hash: parametrized sensitivity across EVERY input, insensitivity to discontinued rows,
// canonicalization over key order.
// ---------------------------------------------------------------------------

const baseChart = {
  columns: 3, rows: 3, cell_aspect: 0.75, cell_fit: 'cover',
  title: 'Applique Patterns', width_units: 1600, scale: 2, styleVersion: 1,
};
const basePatterns = [
  { number: 1, id: 'a', name: 'Alpha', thread: 'white', heroSha256: 'a'.repeat(64), crop: { left: 0, top: 0, width: 1, height: 1 } },
  { number: 2, id: 'b', name: 'Beta', thread: 'black', heroSha256: 'b'.repeat(64), crop: { left: 0.1, top: 0.2, width: 0.5, height: 0.5 } },
];
const baseSpec = () => chartSpec({ chart: { ...baseChart }, page: 1, pages: 2, patterns: basePatterns.map((p) => ({ ...p, crop: { ...p.crop } })) });

const MUTATIONS = [
  ['pattern id', (s) => { s.patterns[0].id = 'z'; }],
  ['pattern name', (s) => { s.patterns[0].name = 'Alpha Prime'; }],
  ['pattern thread', (s) => { s.patterns[0].thread = 'grey'; }],
  ['pattern number', (s) => { s.patterns[0].number = 9; }],
  ['pattern order', (s) => { s.patterns.reverse(); }],
  ['hero sha256', (s) => { s.patterns[0].heroSha256 = 'c'.repeat(64); }],
  ['crop left', (s) => { s.patterns[1].crop.left = 0.11; }],
  ['crop top', (s) => { s.patterns[1].crop.top = 0.21; }],
  ['crop width', (s) => { s.patterns[1].crop.width = 0.51; }],
  ['crop height', (s) => { s.patterns[1].crop.height = 0.51; }],
  ['grid columns', (s) => { s.grid.columns = 4; }],
  ['grid rows', (s) => { s.grid.rows = 5; }],
  ['grid cell_aspect', (s) => { s.grid.cell_aspect = 0.8; }],
  ['grid cell_fit', (s) => { s.grid.cell_fit = 'contain'; }],
  ['grid title', (s) => { s.grid.title = 'Patterns'; }],
  ['grid width_units', (s) => { s.grid.width_units = 1400; }],
  ['grid scale', (s) => { s.grid.scale = 2.5; }],
  ['styleVersion', (s) => { s.styleVersion = 2; }],
  ['page', (s) => { s.page = 2; }],
  ['pages', (s) => { s.pages = 3; }],
];

test('specHash is sensitive to every spec input', () => {
  const base = specHash(baseSpec());
  for (const [what, mutate] of MUTATIONS) {
    const spec = baseSpec();
    mutate(spec);
    assert.notEqual(specHash(spec), base, `expected ${what} to change the hash`);
  }
});

test('specHash ignores discontinued rows entirely (they never enter the spec)', () => {
  // chartSpec is built from actives only; a registry edit to a discontinued row produces the
  // identical spec, hence the identical hash.
  assert.equal(specHash(baseSpec()), specHash(baseSpec()));
});

test('specHash canonicalizes key order', () => {
  const a = baseSpec();
  const b = JSON.parse(JSON.stringify(a));
  b.patterns[0].crop = { height: 1, width: 1, top: 0, left: 0 }; // same values, reversed keys
  const bReordered = { patterns: b.patterns, pages: b.pages, page: b.page, grid: b.grid, styleVersion: b.styleVersion };
  assert.equal(specHash(a), specHash(bReordered));
});

test('hash8 is the 8-char filename prefix of the full hash', () => {
  const h = specHash(baseSpec());
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(hash8(h), h.slice(0, 8));
});
