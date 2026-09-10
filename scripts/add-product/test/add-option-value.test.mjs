import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runAddOptionValue } from '../add-option-value.mjs';
import { assertExpectations, assertGates } from '../lib/gates.mjs';
import { copiedSkus, expectedNewVariants, parseWeights, planHeroAttach, variantSetupInput } from '../lib/option-value.mjs';
import { makeFakeClient, makeLogger, makeProduct, media } from './fixtures.mjs';

const NEW_VALUE = 'DNP (Doctor of Nursing Practice)';
const EXISTING = 'RN (Registered Nurse)';
const HEROES = { Black: media(1), Navy: media(2) };
const TABLES = {
  products: {
    'lead-ii-crewneck': { designNamespace: 'lead-ii' },
    'lead-ii-quarter-zip': { designNamespace: 'lead-ii' },
    'huddle-crewneck': { designNamespace: 'huddle' },
  },
};

/** The store before the write: two products, one design value, two colours, two sizes. */
function before() {
  return ['lead-ii-crewneck', 'lead-ii-quarter-zip'].map((handle) =>
    makeProduct({ handle, designs: [EXISTING], colors: ['Black', 'Navy'], sizes: ['S', 'M'], heroByColor: HEROES }),
  );
}

/** The store after productOptionUpdate has minted the new variants at Admin defaults. */
function after({ heroByColor = HEROES, overrides } = {}) {
  return ['lead-ii-crewneck', 'lead-ii-quarter-zip'].map((handle) =>
    makeProduct({
      handle,
      designs: [EXISTING, NEW_VALUE],
      colors: ['Black', 'Navy'],
      sizes: ['S', 'M'],
      heroByColor,
      overrides: (spec) => (spec.design === NEW_VALUE ? { mediaIds: [], weight: null, ...(overrides ? overrides(spec) : {}) } : {}),
    }),
  );
}

function sandboxEnv() {
  return { ADD_PRODUCT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'add-product-receipts-')) };
}

const DRY_RUN_ARGV = [
  '--namespace',
  'lead-ii',
  '--value',
  NEW_VALUE,
  '--price',
  '48.00',
  '--weight-lb',
  'lead-ii-crewneck=1.6,lead-ii-quarter-zip=2.1',
  '--dry-run',
];

test('the gate refuses with CI set, dry run included, and says no flag overrides it', () => {
  assert.throws(() => assertGates({ env: { CI: '1' }, isTTY: true, mutating: false }), /refuses to run with CI set/);
  assert.throws(() => assertGates({ env: { CI: 'true' }, isTTY: true, operatorApproved: true }), /no flag overrides this/);
  assert.deepEqual(assertGates({ env: {}, isTTY: false, mutating: false }), { via: 'dry-run' });
  assert.deepEqual(assertGates({ env: {}, isTTY: true }), { via: 'tty' });
  assert.deepEqual(assertGates({ env: {}, isTTY: false, operatorApproved: true }), { via: 'operator-approval' });
  assert.throws(() => assertGates({ env: {}, isTTY: false }), /Do not fake a terminal|do not wrap the command in a pty|pty/i);
});

test('CI set refuses the dry run through the command, before anything is read', async () => {
  const err = makeLogger();
  const code = await runAddOptionValue({
    argv: DRY_RUN_ARGV,
    env: { CI: '1' },
    isTTY: true,
    tables: TABLES,
    loadProducts: async () => {
      throw new Error('the refusal must come before any read');
    },
    log: err.write,
    errLog: err.write,
  });
  assert.equal(code, 2);
  assert.match(err.text(), /refuses to run with CI set/);
});

test('no TTY and no --operator-approved refuses a live run', async () => {
  const err = makeLogger();
  const code = await runAddOptionValue({
    argv: DRY_RUN_ARGV.filter((a) => a !== '--dry-run'),
    env: {},
    isTTY: false,
    tables: TABLES,
    loadProducts: async () => before(),
    log: err.write,
    errLog: err.write,
  });
  assert.equal(code, 2);
  assert.match(err.text(), /refuses to write without a TTY/);
  assert.match(err.text(), /--operator-approved/);
});

test('the dry run names every handle, its new-variant count, and the flags to copy', async () => {
  const out = makeLogger();
  const client = makeFakeClient();
  const code = await runAddOptionValue({
    argv: DRY_RUN_ARGV,
    env: sandboxEnv(),
    isTTY: false,
    client,
    tables: TABLES,
    loadProducts: async () => before(),
    log: out.write,
    errLog: out.write,
  });
  assert.equal(code, 0);
  const text = out.text();
  assert.match(text, /lead-ii-crewneck/);
  assert.match(text, /lead-ii-quarter-zip/);
  // Two colours x two sizes per product, four each, eight in total.
  assert.match(text, /total new variants: 8/);
  assert.match(text, /--expect-handles lead-ii-crewneck,lead-ii-quarter-zip --expect-new-variants 8/);
  assert.match(text, /dry run: nothing was written/);
  assert.equal(client.calls.length, 0);
});

test('the pre-flight refuses when the value already exists on any handle', async () => {
  const err = makeLogger();
  const client = makeFakeClient();
  const code = await runAddOptionValue({
    argv: DRY_RUN_ARGV,
    env: sandboxEnv(),
    isTTY: false,
    client,
    tables: TABLES,
    loadProducts: async () => after(),
    log: err.write,
    errLog: err.write,
  });
  assert.equal(code, 2);
  assert.match(err.text(), /already exists on lead-ii-crewneck/);
  assert.equal(client.calls.length, 0);
});

test('--expect-handles mismatch aborts before any mutation and asks for a new approval', async () => {
  const err = makeLogger();
  const client = makeFakeClient();
  const code = await runAddOptionValue({
    argv: [
      ...DRY_RUN_ARGV.filter((a) => a !== '--dry-run'),
      '--operator-approved',
      '--expect-handles',
      'lead-ii-crewneck',
      '--expect-new-variants',
      '8',
    ],
    env: sandboxEnv(),
    isTTY: false,
    client,
    tables: TABLES,
    loadProducts: async () => before(),
    log: err.write,
    errLog: err.write,
  });
  assert.equal(code, 2);
  assert.match(err.text(), /--expect-handles does not match this run/);
  assert.match(err.text(), /NEW operator approval/);
  assert.equal(client.calls.length, 0);
});

test('--expect-new-variants mismatch aborts before any mutation', async () => {
  const err = makeLogger();
  const client = makeFakeClient();
  const code = await runAddOptionValue({
    argv: [
      ...DRY_RUN_ARGV.filter((a) => a !== '--dry-run'),
      '--operator-approved',
      '--expect-handles',
      'lead-ii-crewneck,lead-ii-quarter-zip',
      '--expect-new-variants',
      '4',
    ],
    env: sandboxEnv(),
    isTTY: false,
    client,
    tables: TABLES,
    loadProducts: async () => before(),
    log: err.write,
    errLog: err.write,
  });
  assert.equal(code, 2);
  assert.match(err.text(), /--expect-new-variants does not match this run: approved 4, computed 8/);
  assert.equal(client.calls.length, 0);
});

test('a live run without the expectation flags is refused', async () => {
  const err = makeLogger();
  const code = await runAddOptionValue({
    argv: [...DRY_RUN_ARGV.filter((a) => a !== '--dry-run'), '--operator-approved'],
    env: sandboxEnv(),
    isTTY: false,
    client: makeFakeClient(),
    tables: TABLES,
    loadProducts: async () => before(),
    log: err.write,
    errLog: err.write,
  });
  assert.equal(code, 2);
  assert.match(err.text(), /--expect-handles and --expect-new-variants are required for a live run/);
});

// The three live paths each call requireExpectations separately, and assertExpectations is a no-op
// on a missing expectation, so requireExpectations is the only thing standing between a live run
// and no expectation check at all. Only the add path was covered; deleting the call from either of
// the other two survived the suite. One test per path, each asserting nothing reached the client.
for (const [label, extraArgv] of [
  ['--repair', ['--repair']],
  ['--attach-heroes', ['--attach-heroes']],
]) {
  test(`a live ${label} without the expectation flags is refused before any call`, async () => {
    const err = makeLogger();
    const client = makeFakeClient();
    const code = await runAddOptionValue({
      argv: [...DRY_RUN_ARGV.filter((a) => a !== '--dry-run'), '--operator-approved', ...extraArgv],
      env: sandboxEnv(),
      isTTY: false,
      client,
      tables: TABLES,
      loadProducts: async () => after(),
      log: err.write,
      errLog: err.write,
    });
    assert.equal(code, 2);
    assert.match(err.text(), /--expect-handles and --expect-new-variants are required for a live run/);
    assert.equal(client.calls.length, 0, `${label} reached the Admin API without an expectation check`);
  });
}

test('supplying only one expectation flag is still refused', async () => {
  // requireExpectations uses ||, so both must be present. Flipping it to && lets one flag through,
  // and the other side then passes assertExpectations vacuously.
  const err = makeLogger();
  const client = makeFakeClient();
  const code = await runAddOptionValue({
    argv: [
      ...DRY_RUN_ARGV.filter((a) => a !== '--dry-run'),
      '--operator-approved',
      '--expect-handles',
      'lead-ii-crewneck,lead-ii-quarter-zip',
    ],
    env: sandboxEnv(),
    isTTY: false,
    client,
    tables: TABLES,
    loadProducts: async () => before(),
    log: err.write,
    errLog: err.write,
  });
  assert.equal(code, 2);
  assert.match(err.text(), /--expect-handles and --expect-new-variants are required for a live run/);
  assert.equal(client.calls.length, 0);
});

test('assertExpectations is a no-op on a missing expectation, which is why requireExpectations exists', () => {
  // Pins the coupling that the three tests above depend on. If this ever starts throwing, those
  // tests are testing something else and requireExpectations may look redundant.
  assert.doesNotThrow(() =>
    assertExpectations({ handles: ['a'], newVariants: 1, expectHandles: null, expectNewVariants: null }),
  );
  assert.throws(
    () => assertExpectations({ handles: ['a'], newVariants: 1, expectHandles: 'b', expectNewVariants: null }),
    /--expect-handles does not match/,
  );
});

test('an approved live run adds the value, then sets weight, price, tracking and DENY', async () => {
  const out = makeLogger();
  const client = makeFakeClient();
  const env = sandboxEnv();
  let read = 0;
  const code = await runAddOptionValue({
    argv: [
      ...DRY_RUN_ARGV.filter((a) => a !== '--dry-run'),
      '--operator-approved',
      '--expect-handles',
      'lead-ii-crewneck,lead-ii-quarter-zip',
      '--expect-new-variants',
      '8',
    ],
    env,
    isTTY: false,
    client,
    tables: TABLES,
    loadProducts: async (handles) => {
      read += 1;
      const source = read === 1 ? before() : after();
      return handles.map((h) => source.find((p) => p.handle === h));
    },
    now: () => '2026-09-08T00:00:00.000Z',
    log: out.write,
    errLog: out.write,
  });
  assert.equal(code, 0);

  const ops = client.calls.map((c) => c.opName);
  assert.deepEqual(ops, [
    'AddProductOptionValue',
    'AddProductVariantSetup',
    'AddProductOptionValue',
    'AddProductVariantSetup',
  ]);
  const optionCall = client.calls[0].variables;
  assert.deepEqual(optionCall.optionValuesToAdd, [{ name: NEW_VALUE }]);
  assert.equal(optionCall.option.id, 'gid://shopify/Product/lead-ii-crewneck/opt-design');

  const setup = client.calls[1].variables.variants;
  assert.equal(setup.length, 4);

  // WHICH variants, not just how many. The earlier version of this compared `id` against
  // `setup[0].id`, which asserts nothing: sending the first four variants of the product instead of
  // the four carrying the new value passed it. That mutation is a live productVariantsBulkUpdate
  // rewriting price, weight, tracking and DENY onto variants that are already selling.
  const expectedIds = after()
    .find((p) => p.handle === 'lead-ii-crewneck')
    .variants.filter((v) => v.selectedOptions.some((o) => o.name === 'Design' && o.value === NEW_VALUE))
    .map((v) => v.id)
    .sort();
  assert.equal(expectedIds.length, 4);
  assert.deepEqual(setup.map((v) => v.id).sort(), expectedIds);

  assert.deepEqual(setup[0], {
    id: expectedIds.includes(setup[0].id) ? setup[0].id : 'NOT-A-NEW-VARIANT',
    price: '48.00',
    inventoryPolicy: 'DENY',
    inventoryItem: { sku: '', tracked: true, measurement: { weight: { value: 1.6, unit: 'POUNDS' } } },
  });
  // The second product carries its own weight from --weight-lb.
  assert.equal(client.calls[3].variables.variants[0].inventoryItem.measurement.weight.value, 2.1);

  const receiptFile = fs.readdirSync(path.join(env.ADD_PRODUCT_DIR, 'receipts'))[0];
  const receipt = JSON.parse(fs.readFileSync(path.join(env.ADD_PRODUCT_DIR, 'receipts', receiptFile), 'utf8'));
  assert.equal(receipt.value, NEW_VALUE);
  assert.equal(receipt.created.length, 2);
  assert.equal(receipt.created[0].variantIds.length, 4);
});

test('an option update that mints no variant stops the run instead of setting up nothing', async () => {
  // The one count that is not "fewer than expected" but a different fact. The bulk update would
  // carry an empty variant list, report no error, and the run would move to the next product having
  // silently skipped this one. It halts like a userError does, and the second product is never
  // attempted.
  const out = makeLogger();
  const client = makeFakeClient();
  let read = 0;
  const code = await runAddOptionValue({
    argv: [
      ...DRY_RUN_ARGV.filter((a) => a !== '--dry-run'),
      '--operator-approved',
      '--expect-handles',
      'lead-ii-crewneck,lead-ii-quarter-zip',
      '--expect-new-variants',
      '8',
    ],
    env: sandboxEnv(),
    isTTY: false,
    client,
    tables: TABLES,
    // The re-read shows the store exactly as it was: the value minted nothing.
    loadProducts: async (handles) => {
      read += 1;
      return handles.map((h) => before().find((p) => p.handle === h));
    },
    now: () => '2026-09-08T00:00:00.000Z',
    log: out.write,
    errLog: out.write,
  });
  assert.equal(code, 1);
  assert.match(out.text(), /no variant carries "DNP \(Doctor of Nursing Practice\)"/);
  assert.match(out.text(), /no further product is attempted/);
  // The option update for the FIRST product only, and no variant setup at all.
  assert.deepEqual(client.calls.map((c) => c.opName), ['AddProductOptionValue']);
  assert.equal(read, 2, 'it should have re-read the first product and then stopped');
});

test('a userError on the option update stops the run before the next product', async () => {
  const out = makeLogger();
  const client = makeFakeClient({
    AddProductOptionValue: () => ({
      productOptionUpdate: { product: null, userErrors: [{ field: ['optionValuesToAdd'], message: 'Value already exists', code: 'TAKEN' }] },
    }),
  });
  const code = await runAddOptionValue({
    argv: [
      ...DRY_RUN_ARGV.filter((a) => a !== '--dry-run'),
      '--operator-approved',
      '--expect-handles',
      'lead-ii-crewneck,lead-ii-quarter-zip',
      '--expect-new-variants',
      '8',
    ],
    env: sandboxEnv(),
    isTTY: false,
    client,
    tables: TABLES,
    loadProducts: async () => before(),
    log: out.write,
    errLog: out.write,
  });
  assert.equal(code, 1);
  assert.deepEqual(client.calls.map((c) => c.opName), ['AddProductOptionValue']);
  assert.match(out.text(), /Value already exists/);
});

test('--attach-heroes copies each colour hero and skips variants already attached', async () => {
  const out = makeLogger();
  const client = makeFakeClient();
  // One of the new variants already has its hero: a re-run must not attach it twice.
  const products = after({ overrides: ({ color, size }) => (color === 'Black' && size === 'S' ? { mediaIds: [media(1)] } : {}) });
  const code = await runAddOptionValue({
    argv: [
      '--namespace',
      'lead-ii',
      '--value',
      NEW_VALUE,
      '--attach-heroes',
      '--operator-approved',
      '--expect-handles',
      'lead-ii-crewneck,lead-ii-quarter-zip',
      '--expect-new-variants',
      '6',
    ],
    env: sandboxEnv(),
    isTTY: false,
    client,
    tables: TABLES,
    loadProducts: async () => products,
    log: out.write,
    errLog: out.write,
  });
  assert.equal(code, 0);
  const attached = client.calls.flatMap((c) => c.variables.variantMedia);
  // Four new variants per product, one already attached on each: six appends, never eight.
  assert.equal(attached.length, 6);
  assert.ok(attached.every((a) => a.mediaIds.length === 1));
  assert.ok(attached.every((a) => [media(1), media(2)].includes(a.mediaIds[0])));
});

test('--attach-heroes STOPs on a colour carrying two distinct hero ids, writing nothing', async () => {
  const out = makeLogger();
  const client = makeFakeClient();
  const products = after();
  // An existing Black variant on the first product shows a different picture from its siblings.
  const rogue = products[0].variants.find((v) => v.selectedOptions.some((o) => o.value === EXISTING) && v.selectedOptions.some((o) => o.value === 'Black'));
  rogue.mediaIds = [media(77)];
  const code = await runAddOptionValue({
    argv: [
      '--namespace',
      'lead-ii',
      '--value',
      NEW_VALUE,
      '--attach-heroes',
      '--operator-approved',
      '--expect-handles',
      'lead-ii-crewneck,lead-ii-quarter-zip',
      '--expect-new-variants',
      '8',
    ],
    env: sandboxEnv(),
    isTTY: false,
    client,
    tables: TABLES,
    loadProducts: async () => products,
    log: out.write,
    errLog: out.write,
  });
  assert.equal(code, 1);
  assert.equal(client.calls.length, 0);
  assert.match(out.text(), /STOP: a colour has more than one hero media id/);
  assert.match(out.text(), /2 distinct hero media ids/);
});

test('the hero plan is pure and reports its own skips', () => {
  const product = after({ overrides: ({ color, size }) => (color === 'Navy' && size === 'M' ? { mediaIds: [media(2)] } : {}) })[0];
  const plan = planHeroAttach(product, { option: 'Design', value: NEW_VALUE });
  assert.deepEqual(plan.stops, []);
  assert.equal(plan.skipped, 1);
  assert.equal(plan.attachments.length, 3);
  const black = plan.colors.find((c) => c.color === 'Black');
  assert.equal(black.heroId, media(1));
  assert.equal(black.targets.length, 2);
});

test('the new-variant count is the product of the other option axes', () => {
  const [crewneck] = before();
  assert.equal(expectedNewVariants(crewneck, 'Design'), 4);
  assert.equal(expectedNewVariants(makeProduct({ handle: 'shift-fuel-tote' }), 'Design'), 1);
});

test('--weight-lb is parsed per handle and refuses a nonsense weight', () => {
  assert.deepEqual([...parseWeights('a=1.6,b=2.1')], [['a', 1.6], ['b', 2.1]]);
  assert.throws(() => parseWeights('a'), /is not handle=lb/);
  assert.throws(() => parseWeights('a=0'), /positive number of pounds/);
  assert.throws(() => parseWeights('a=heavy'), /positive number of pounds/);
});

test('a missing weight for one handle refuses the whole run', async () => {
  const err = makeLogger();
  const code = await runAddOptionValue({
    argv: ['--namespace', 'lead-ii', '--value', NEW_VALUE, '--price', '48.00', '--weight-lb', 'lead-ii-crewneck=1.6', '--dry-run'],
    env: sandboxEnv(),
    isTTY: false,
    client: makeFakeClient(),
    tables: TABLES,
    loadProducts: async () => before(),
    log: err.write,
    errLog: err.write,
  });
  assert.equal(code, 2);
  assert.match(err.text(), /has no weight for lead-ii-quarter-zip/);
});

/** A bulk-update responder that reports every variant it was sent as still carrying `sku`. */
function skuSurvives(sku) {
  return {
    AddProductVariantSetup: (vars) => ({
      productVariantsBulkUpdate: {
        productVariants: vars.variants.map((v) => ({ id: v.id, inventoryItem: { sku } })),
        userErrors: [],
      },
    }),
  };
}

test('a live add whose setup leaves a copied SKU in place exits 1 and names it', async () => {
  const out = makeLogger();
  let read = 0;
  const code = await runAddOptionValue({
    argv: [
      ...DRY_RUN_ARGV.filter((a) => a !== '--dry-run'),
      '--operator-approved',
      '--expect-handles',
      'lead-ii-crewneck,lead-ii-quarter-zip',
      '--expect-new-variants',
      '8',
    ],
    env: sandboxEnv(),
    isTTY: false,
    client: makeFakeClient(skuSurvives('L2CN-RN-BLK-S')),
    tables: TABLES,
    loadProducts: async (handles) => {
      read += 1;
      const source = read === 1 ? before() : after();
      return handles.map((h) => source.find((p) => p.handle === h));
    },
    now: () => '2026-09-10T00:00:00.000Z',
    log: out.write,
    errLog: out.write,
  });
  assert.equal(code, 1);
  assert.match(out.text(), /lead-ii-crewneck: 4 new variant\(s\) still carry a SKU after the setup cleared it \(first: L2CN-RN-BLK-S\)/);
  assert.match(out.text(), /--repair under a fresh approval/);
});

test('a live --repair clears the SKU, and exits 1 if the payload shows one surviving', async () => {
  const run = (client) =>
    runAddOptionValue({
      argv: [
        '--namespace',
        'lead-ii',
        '--value',
        NEW_VALUE,
        '--price',
        '48.00',
        '--weight-lb',
        'lead-ii-crewneck=1.6,lead-ii-quarter-zip=2.1',
        '--repair',
        '--operator-approved',
        '--expect-handles',
        'lead-ii-crewneck,lead-ii-quarter-zip',
        '--expect-new-variants',
        '8',
      ],
      env: sandboxEnv(),
      isTTY: false,
      client,
      tables: TABLES,
      loadProducts: async (handles) => handles.map((h) => after().find((p) => p.handle === h)),
      now: () => '2026-09-10T00:00:00.000Z',
      log: () => {},
      errLog: () => {},
    });

  const clean = makeFakeClient();
  assert.equal(await run(clean), 0);
  const sent = clean.calls.filter((c) => c.opName === 'AddProductVariantSetup').flatMap((c) => c.variables.variants);
  assert.equal(sent.length, 8);
  assert.ok(sent.every((v) => v.inventoryItem.sku === ''));

  assert.equal(await run(makeFakeClient(skuSurvives('L2CN-RN-BLK-S'))), 1);
});

test('a live add whose setup payload describes fewer variants than were sent exits 1', async () => {
  // copiedSkus reads only what the payload describes, so a payload describing nothing would pass
  // every sent variant as cleared on no evidence at all.
  const out = makeLogger();
  let read = 0;
  const code = await runAddOptionValue({
    argv: [
      ...DRY_RUN_ARGV.filter((a) => a !== '--dry-run'),
      '--operator-approved',
      '--expect-handles',
      'lead-ii-crewneck,lead-ii-quarter-zip',
      '--expect-new-variants',
      '8',
    ],
    env: sandboxEnv(),
    isTTY: false,
    client: makeFakeClient({ AddProductVariantSetup: { productVariantsBulkUpdate: { productVariants: [], userErrors: [] } } }),
    tables: TABLES,
    loadProducts: async (handles) => {
      read += 1;
      const source = read === 1 ? before() : after();
      return handles.map((h) => source.find((p) => p.handle === h));
    },
    now: () => '2026-09-10T00:00:00.000Z',
    log: out.write,
    errLog: out.write,
  });
  assert.equal(code, 1);
  assert.match(out.text(), /lead-ii-crewneck: the setup payload described 0 of 4 variant\(s\), so the SKU clear on the rest is unconfirmed/);
});

test('the --repair dry run counts the targets still holding a SKU', async () => {
  // The clear is the one field a repair changes that is not already right, so it is the column the
  // operator approves; a copied SKU is invisible in every other one.
  const out = makeLogger();
  const copied = after({ overrides: () => ({ sku: 'L2CN-RN-BLK-S' }) });
  const code = await runAddOptionValue({
    argv: [...DRY_RUN_ARGV, '--repair'],
    env: sandboxEnv(),
    isTTY: false,
    client: makeFakeClient(),
    tables: TABLES,
    loadProducts: async (handles) => handles.map((h) => copied.find((p) => p.handle === h)),
    log: out.write,
    errLog: out.write,
  });
  assert.equal(code, 0);
  assert.match(out.text(), /holding a SKU/);
  assert.match(out.text(), /lead-ii-crewneck +4 +4 +48\.00/);
});

test('--repair refuses when a target holds a SKU no other variant shares, writing nothing', async () => {
  // A copied SKU duplicates its sibling; a SKU the sku skill assigned is unique on the product. The
  // setup clears every target's SKU, so after phase 2 a repair would wipe correct ones.
  const out = makeLogger();
  const client = makeFakeClient();
  const assigned = after({ overrides: (spec) => ({ sku: `L2CN-DNP-${spec.color.toUpperCase()}-${spec.size}` }) });
  const code = await runAddOptionValue({
    argv: [...DRY_RUN_ARGV, '--repair'],
    env: sandboxEnv(),
    isTTY: false,
    client,
    tables: TABLES,
    loadProducts: async (handles) => handles.map((h) => assigned.find((p) => p.handle === h)),
    log: out.write,
    errLog: out.write,
  });
  assert.equal(code, 2);
  assert.match(out.text(), /refuses: 8 target\(s\) hold a SKU no other variant shares/);
  assert.equal(client.calls.length, 0);
});

test('the variant setup input carries weight, tracking and policy for every id', () => {
  const input = variantSetupInput([{ id: 'v1' }, { id: 'v2' }], { price: '48.00', weightLb: 1.6 });
  assert.equal(input.length, 2);
  assert.ok(input.every((v) => v.inventoryPolicy === 'DENY'));
  assert.ok(input.every((v) => v.inventoryItem.tracked === true));
  assert.ok(input.every((v) => v.inventoryItem.measurement.weight.unit === 'POUNDS'));
});

// productOptionUpdate copies the first design value's SKU onto each new variant (L2CN-RN-BLK-XS on a
// CPT variant, the first live run). The sku planner refuses drift, so a copied SKU is not a gap the
// sku skill fills later; the setup has to clear it, explicitly, with an empty string.
test('the variant setup input clears the SKU the option update copied from a sibling', () => {
  const input = variantSetupInput([{ id: 'v1', sku: 'L2CN-RN-BLK-XS' }], { price: '48.00', weightLb: 1.6 });
  assert.equal(input[0].inventoryItem.sku, '');
});

test('copiedSkus reports only variants the payload shows still carrying a SKU', () => {
  const payload = {
    productVariants: [
      { id: 'v1', inventoryItem: { sku: '' } },
      { id: 'v2', inventoryItem: { sku: null } },
      { id: 'v3', inventoryItem: { sku: '  ' } },
      { id: 'v4', inventoryItem: { sku: 'L2CN-RN-BLK-S' } },
      { id: 'v5' },
    ],
  };
  assert.deepEqual(copiedSkus(payload), [{ id: 'v4', sku: 'L2CN-RN-BLK-S' }]);
  assert.deepEqual(copiedSkus(undefined), []);
  assert.deepEqual(copiedSkus({ productVariants: [] }), []);
});

test('assertExpectations passes only on an exact match, in order', () => {
  assert.doesNotThrow(() => assertExpectations({ handles: ['a', 'b'], newVariants: 8, expectHandles: 'a,b', expectNewVariants: '8' }));
  assert.throws(() => assertExpectations({ handles: ['a', 'b'], newVariants: 8, expectHandles: 'b,a', expectNewVariants: '8' }), /--expect-handles/);
  assert.throws(() => assertExpectations({ handles: ['a'], newVariants: 8, expectHandles: 'a', expectNewVariants: 'eight' }), /--expect-new-variants/);
});

test('--repair and --attach-heroes are separate runs with separate approvals', async () => {
  const err = makeLogger();
  const code = await runAddOptionValue({
    argv: ['--namespace', 'lead-ii', '--value', NEW_VALUE, '--repair', '--attach-heroes', '--dry-run'],
    env: sandboxEnv(),
    isTTY: false,
    tables: TABLES,
    loadProducts: async () => before(),
    log: err.write,
    errLog: err.write,
  });
  assert.equal(code, 2);
  assert.match(err.text(), /separate runs with separate approvals/);
});

test('--repair rewrites the setup over the variants already carrying the value', async () => {
  const out = makeLogger();
  const client = makeFakeClient();
  const code = await runAddOptionValue({
    argv: [
      '--namespace',
      'lead-ii',
      '--value',
      NEW_VALUE,
      '--price',
      '48.00',
      '--weight-lb',
      'lead-ii-crewneck=1.6,lead-ii-quarter-zip=2.1',
      '--repair',
      '--operator-approved',
      '--expect-handles',
      'lead-ii-crewneck,lead-ii-quarter-zip',
      '--expect-new-variants',
      '8',
    ],
    env: sandboxEnv(),
    isTTY: false,
    client,
    tables: TABLES,
    loadProducts: async () => after(),
    log: out.write,
    errLog: out.write,
  });
  assert.equal(code, 0);
  assert.deepEqual(client.calls.map((c) => c.opName), ['AddProductVariantSetup', 'AddProductVariantSetup']);
  assert.equal(client.calls[0].variables.variants.length, 4);
});

test('--help exits 0 and an unknown flag exits 2, neither reading the store', async () => {
  const out = makeLogger();
  assert.equal(
    await runAddOptionValue({
      argv: ['--help'],
      env: {},
      isTTY: false,
      loadProducts: async () => {
        throw new Error('--help must not read the store');
      },
      log: out.write,
      errLog: out.write,
    }),
    0,
  );
  assert.match(out.text(), /Usage: add-option-value\.mjs/);

  const err = makeLogger();
  assert.equal(
    await runAddOptionValue({ argv: ['--yolo'], env: {}, isTTY: false, log: err.write, errLog: err.write }),
    2,
  );
  assert.match(err.text(), /--yolo is not a flag/);
});
