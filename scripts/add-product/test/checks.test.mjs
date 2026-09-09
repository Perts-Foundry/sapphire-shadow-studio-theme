import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DIVERGENT, IDENTICAL, checkVariants, hexOf, mediaSurvey, publicationCheck } from '../lib/checks.mjs';
import { runCheckVariants } from '../check-variants.mjs';
import { runMediaSurvey } from '../media-survey.mjs';
import { runPublicationCheck } from '../publication-check.mjs';
import { makeLogger, makePublication, makeProduct, media } from './fixtures.mjs';

const NBSP = String.fromCharCode(0x00a0);
const CLEAN = 'DNP (Doctor of Nursing Practice)';
const TAINTED = `DNP${NBSP}(Doctor of Nursing Practice)`;

const HEROES = { Black: media(1), Navy: media(2) };

function pair({ secondValue = CLEAN, overrides } = {}) {
  return [
    makeProduct({ handle: 'lead-ii-crewneck', designs: ['RN (Registered Nurse)', CLEAN], colors: ['Black', 'Navy'], sizes: ['S', 'M'], heroByColor: HEROES }),
    makeProduct({
      handle: 'lead-ii-quarter-zip',
      designs: ['RN (Registered Nurse)', secondValue],
      colors: ['Black', 'Navy'],
      sizes: ['S', 'M'],
      heroByColor: HEROES,
      overrides,
    }),
  ];
}

test('the hex verdict catches a non-breaking space that no terminal shows', () => {
  assert.notEqual(hexOf(CLEAN), hexOf(TAINTED));
  const divergent = checkVariants({ products: pair({ secondValue: TAINTED }), option: 'Design', value: CLEAN });
  assert.equal(divergent.verdict, DIVERGENT);
  assert.equal(divergent.exitCode, 1);
  assert.match(divergent.problems.join(' '), /not byte-identical/);
  // The two hexes differ at the byte that is invisible: c2a0 where the clean one has 20.
  const hexes = divergent.rows.map((r) => r.hex);
  assert.ok(hexes[1].includes('c2a0'));
  assert.ok(!hexes[0].includes('c2a0'));
});

test('a clean value is IDENTICAL across the run and exits 0', () => {
  const clean = checkVariants({ products: pair(), option: 'Design', value: CLEAN });
  assert.equal(clean.verdict, IDENTICAL);
  assert.equal(clean.exitCode, 0);
  assert.deepEqual(clean.problems, []);
  assert.equal(clean.rows[0].matching.length, 4);
});

test('a product missing the value entirely is DIVERGENT, not silently skipped', () => {
  const products = pair();
  products[1].options[0].values = ['RN (Registered Nurse)'];
  products[1].variants = products[1].variants.filter((v) => !v.selectedOptions.some((o) => o.value === CLEAN));
  const result = checkVariants({ products, option: 'Design', value: CLEAN });
  assert.equal(result.verdict, DIVERGENT);
  assert.equal(result.rows[1].hex, '(absent)');
});

test('check-variants exits 1 on ALLOW, on untracked, and on a zero weight', async () => {
  const cases = [
    [{ inventoryPolicy: 'ALLOW' }, /policy ALLOW or inventory not tracked/],
    [{ tracked: false }, /policy ALLOW or inventory not tracked/],
    [{ weight: 0 }, /weight 0/],
  ];
  for (const [defect, expected] of cases) {
    const products = pair({ overrides: ({ design }) => (design === CLEAN ? defect : {}) });
    const out = makeLogger();
    const code = await runCheckVariants({
      argv: ['--handle', 'lead-ii-crewneck,lead-ii-quarter-zip', '--value', CLEAN],
      loadProducts: async () => products,
      log: out.write,
      errLog: out.write,
    });
    assert.equal(code, 1);
    assert.match(out.text(), expected);
  }
});

test('check-variants exits 0 on a clean run and prints the hex either way', async () => {
  const out = makeLogger();
  const code = await runCheckVariants({
    argv: ['--handle', 'lead-ii-crewneck,lead-ii-quarter-zip', '--value', CLEAN],
    loadProducts: async () => pair(),
    log: out.write,
    errLog: out.write,
  });
  assert.equal(code, 0);
  assert.match(out.text(), /byte verdict: IDENTICAL/);
  assert.ok(out.text().includes(hexOf(CLEAN)));
  assert.match(out.text(), /OK: no problems found/);
});

test('check-variants needs a --value or --survey, and --survey lists the values', async () => {
  const err = makeLogger();
  assert.equal(
    await runCheckVariants({ argv: ['--handle', 'lead-ii-crewneck'], loadProducts: async () => pair(), log: err.write, errLog: err.write }),
    2,
  );
  assert.match(err.text(), /--value is required/);

  const out = makeLogger();
  const code = await runCheckVariants({
    argv: ['--handle', 'lead-ii-crewneck', '--survey'],
    loadProducts: async () => [pair()[0]],
    log: out.write,
    errLog: out.write,
  });
  assert.equal(code, 0);
  assert.ok(out.text().includes(hexOf(CLEAN)));
});

test('media-survey exits 1 on two distinct media ids on one colour', async () => {
  const products = [
    makeProduct({
      handle: 'lead-ii-crewneck',
      designs: ['RN (Registered Nurse)'],
      colors: ['Black', 'Navy'],
      sizes: ['S', 'M'],
      heroByColor: HEROES,
      overrides: ({ color, size }) => (color === 'Black' && size === 'M' ? { mediaIds: [media(99)] } : {}),
    }),
  ];
  const out = makeLogger();
  const code = await runMediaSurvey({ argv: ['--handle', 'lead-ii-crewneck'], loadProducts: async () => products, log: out.write, errLog: out.write });
  assert.equal(code, 1);
  assert.match(out.text(), /Black: 2 distinct media ids/);
});

test('media-survey exits 1 on a variant with no attached media', async () => {
  const products = [
    makeProduct({
      handle: 'lead-ii-crewneck',
      designs: ['RN (Registered Nurse)'],
      colors: ['Black', 'Navy'],
      sizes: ['S', 'M'],
      heroByColor: HEROES,
      overrides: ({ color, size }) => (color === 'Navy' && size === 'S' ? { mediaIds: [] } : {}),
    }),
  ];
  const out = makeLogger();
  const code = await runMediaSurvey({ argv: ['--handle', 'lead-ii-crewneck'], loadProducts: async () => products, log: out.write, errLog: out.write });
  assert.equal(code, 1);
  assert.match(out.text(), /Navy: 1 variant\(s\) with no attached media/);
});

test('media-survey exits 0 when every colour has one hero on every variant', async () => {
  const out = makeLogger();
  const code = await runMediaSurvey({ argv: ['--handle', 'lead-ii-crewneck'], loadProducts: async () => [pair()[0]], log: out.write, errLog: out.write });
  assert.equal(code, 0);
  assert.match(out.text(), /OK: no problems found/);
  assert.ok(out.text().includes(media(1)));
});

test('the media survey reports a colourless product as one bucket rather than crashing', () => {
  const tote = makeProduct({ handle: 'shift-fuel-tote' });
  const result = mediaSurvey([tote]);
  assert.equal(result.rows[0].colors.length, 1);
  assert.equal(result.rows[0].colors[0].color, '(no colour option)');
  assert.equal(result.exitCode, 1);
});

test('publication-check fails on an empty published set on either side', () => {
  const unpublished = publicationCheck({
    run: [makePublication({ handle: 'lead-ii-crewneck', published: [], unpublished: ['Online Store'] })],
    siblings: [makePublication({ handle: 'huddle-crewneck', published: ['Online Store'] })],
  });
  assert.equal(unpublished.exitCode, 1);
  assert.match(unpublished.problems.join(' '), /published to NO channel/);

  const uselessSibling = publicationCheck({
    run: [makePublication({ handle: 'lead-ii-crewneck', published: ['Online Store'] })],
    siblings: [makePublication({ handle: 'huddle-crewneck', published: [] })],
  });
  assert.equal(uselessSibling.exitCode, 1);
  assert.match(uselessSibling.problems.join(' '), /not a usable reference/);
});

test('publication-check reports a channel-set mismatch against the sibling', () => {
  const result = publicationCheck({
    run: [makePublication({ handle: 'lead-ii-crewneck', published: ['Online Store'] })],
    siblings: [makePublication({ handle: 'huddle-crewneck', published: ['Online Store', 'Shop'] })],
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.problems.join(' '), /missing Shop/);
});

test('publication-check refuses a sibling drawn from the run', async () => {
  const err = makeLogger();
  const code = await runPublicationCheck({
    argv: ['--handle', 'lead-ii-crewneck,lead-ii-quarter-zip', '--sibling', 'lead-ii-quarter-zip'],
    loadPublications: async () => {
      throw new Error('the refusal must come before any read');
    },
    log: err.write,
    errLog: err.write,
  });
  assert.equal(code, 2);
  assert.match(err.text(), /lead-ii-quarter-zip is part of this run/);
});

test('publication-check exits 0 when the run matches its sibling', async () => {
  const out = makeLogger();
  const code = await runPublicationCheck({
    argv: ['--handle', 'lead-ii-crewneck', '--sibling', 'huddle-crewneck'],
    loadPublications: async (handles) => handles.map((handle) => makePublication({ handle, published: ['Online Store', 'Shop'] })),
    log: out.write,
    errLog: out.write,
  });
  assert.equal(code, 0);
  assert.match(out.text(), /lead-ii-crewneck vs huddle-crewneck: match/);
  assert.match(out.text(), /OK: no problems found/);
});

test('publication-check requires a sibling: there is no useful answer without one', async () => {
  const err = makeLogger();
  const code = await runPublicationCheck({
    argv: ['--handle', 'lead-ii-crewneck'],
    loadPublications: async () => [],
    log: err.write,
    errLog: err.write,
  });
  assert.equal(code, 2);
  assert.match(err.text(), /--sibling is required/);
});
