import test from 'node:test';
import assert from 'node:assert/strict';

import { parseColor, composite, relativeLuminance, contrastRatio, round2 } from '../lib/color.mjs';

test('parseColor reads the three forms settings_data.json actually contains', () => {
  assert.deepEqual(parseColor('#ffffff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('#000000'), { r: 0, g: 0, b: 0, a: 1 });
  // The 8-digit form is the one that makes this file necessary at all.
  const withAlpha = parseColor('#000000cf');
  assert.deepEqual([withAlpha.r, withAlpha.g, withAlpha.b], [0, 0, 0]);
  assert.equal(withAlpha.a, 0xcf / 255);
  assert.deepEqual(parseColor('rgba(0,0,0,0)'), { r: 0, g: 0, b: 0, a: 0 });
  assert.deepEqual(parseColor('rgb(1, 2, 3)'), { r: 1, g: 2, b: 3, a: 1 });
});

test('parseColor tolerates shorthand hex, whitespace and case', () => {
  assert.deepEqual(parseColor('#FFF'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('  #AbC  '), { r: 0xaa, g: 0xbb, b: 0xcc, a: 1 });
  assert.equal(parseColor('#0000000f').a, 0x0f / 255);
  assert.equal(parseColor('#f00f').a, 1);
});

test('parseColor accepts modern space/slash rgb() and percentages', () => {
  assert.deepEqual(parseColor('rgb(0 0 0 / 50%)'), { r: 0, g: 0, b: 0, a: 0.5 });
  assert.deepEqual(parseColor('rgba(100%, 0%, 0%, 1)'), { r: 255, g: 0, b: 0, a: 1 });
});

test('parseColor THROWS on anything unrecognised rather than guessing', () => {
  // This is the fail-closed property the lint depends on: a colour the parser
  // cannot read must surface as an error, never as a silently skipped pair.
  for (const bad of ['', null, undefined, 'red', '#12345', 'hsl(0,0%,0%)', 'rgb(1,2)', 'rgb(a,b,c)']) {
    assert.throws(() => parseColor(bad), /unsupported/, `expected throw for ${JSON.stringify(bad)}`);
  }
});

test('relativeLuminance matches the WCAG reference values', () => {
  assert.equal(relativeLuminance({ r: 255, g: 255, b: 255, a: 1 }), 1);
  assert.equal(relativeLuminance({ r: 0, g: 0, b: 0, a: 1 }), 0);
  // Mid grey #808080 is a published sanity value: ~0.2158.
  assert.ok(Math.abs(relativeLuminance({ r: 128, g: 128, b: 128, a: 1 }) - 0.2158) < 0.001);
});

test('contrastRatio is symmetric and hits the known endpoints', () => {
  const white = parseColor('#ffffff');
  const black = parseColor('#000000');
  assert.equal(round2(contrastRatio(black, white)), 21);
  assert.equal(round2(contrastRatio(white, black)), 21);
  assert.equal(contrastRatio(white, white), 1);
  // #767676 on white is the canonical "exactly passes 4.5:1" value.
  assert.ok(contrastRatio(parseColor('#767676'), white) >= 4.5);
  assert.ok(contrastRatio(parseColor('#777777'), white) < 4.5);
});

test('composite implements source-over', () => {
  const white = parseColor('#ffffff');
  const black = parseColor('#000000');
  // Fully opaque foreground wins outright.
  assert.deepEqual(composite(black, white), { r: 0, g: 0, b: 0, a: 1 });
  // Fully transparent foreground disappears.
  assert.deepEqual(composite(parseColor('rgba(0,0,0,0)'), white), { r: 255, g: 255, b: 255, a: 1 });
  // Half-and-half lands in the middle.
  const half = composite({ r: 0, g: 0, b: 0, a: 0.5 }, white);
  assert.equal(half.a, 1);
  assert.equal(Math.round(half.r), 128);
});

test('composite keeps a translucent result translucent so layers can chain', () => {
  const stacked = composite({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 0.5 });
  assert.equal(stacked.a, 0.75);
  // Two transparent layers stay transparent, and must not divide by zero.
  assert.deepEqual(
    composite({ r: 1, g: 2, b: 3, a: 0 }, { r: 4, g: 5, b: 6, a: 0 }),
    { r: 0, g: 0, b: 0, a: 0 }
  );
});

test('compositing a translucent dark over white lowers contrast against white', () => {
  const white = parseColor('#ffffff');
  const solid = contrastRatio(parseColor('#000000'), white);
  const faded = contrastRatio(composite(parseColor('#000000cf'), white), white);
  assert.ok(faded < solid, 'alpha must reduce the achieved ratio');
  assert.ok(faded > 1);
});
