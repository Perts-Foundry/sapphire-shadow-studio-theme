import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, numericOpt, makeWriter, catalogueGate, refusalPayload } from '../blank-inventory.mjs';
import { MODE_ABSOLUTE, MODE_DELTA } from '../lib/input.mjs';

// The CLI orchestrator's own functions. The lib layer is well covered on its own; these three are
// the untested seam between parsed operator flags and a live mutation, so a defect here writes wrong
// stock and nothing else guards it.

// --- parseArgs --------------------------------------------------------------

test('parseArgs collects the command, positionals, and --flag value pairs', () => {
  const opts = parseArgs(['plan', '--input', 'counts.csv', '--mode', 'absolute']);
  assert.equal(opts.command, 'plan');
  assert.equal(opts.input, 'counts.csv');
  assert.equal(opts.mode, 'absolute');
});

test('parseArgs leaves a value-less flag as boolean true (the numericOpt hazard)', () => {
  // A bare --quantity must NOT swallow the following --flag as its value; it becomes `true`, and
  // numericOpt is the thing that refuses to let that reach a write as Number(true) === 1.
  const opts = parseArgs(['untag', '--quantity', '--dry-run']);
  assert.equal(opts.quantity, true);
  assert.equal(opts.dryRun, true);
});

test('parseArgs does not consume a following --flag as a value', () => {
  const opts = parseArgs(['apply', '--plan', '--dry-run']);
  assert.equal(opts.plan, true, 'a following --flag is not the value for --plan');
  assert.equal(opts.dryRun, true);
});

test('parseArgs supports the --key=value form', () => {
  const opts = parseArgs(['apply', '--plan=/tmp/p.json']);
  assert.equal(opts.plan, '/tmp/p.json');
});

test('parseArgs camelCases hyphenated flags', () => {
  const opts = parseArgs(['backfill', '--allow-over-cap', '--timeout-ms', '1000']);
  assert.equal(opts.allowOverCap, true);
  assert.equal(opts.timeoutMs, '1000');
});

test('parseArgs accumulates repeated --variant into an array', () => {
  const opts = parseArgs(['untag', '--variant', 'gid://a', '--variant', 'gid://b']);
  assert.deepEqual(opts.variant, ['gid://a', 'gid://b']);
});

// --- numericOpt -------------------------------------------------------------
// The refusal path is injected rather than exercised through the process-exiting default, so the
// test can assert the refusal without tearing down the runner.
const thrower = (msg) => {
  throw new Error(msg);
};

test('numericOpt returns the fallback when the flag is absent', () => {
  assert.equal(numericOpt('--quantity', undefined, 0), 0);
});

test('numericOpt parses a numeric string', () => {
  assert.equal(numericOpt('--quantity', '12', 0), 12);
  assert.equal(numericOpt('--quantity', '0', 7), 0, 'an explicit 0 is not the fallback');
});

test('numericOpt refuses a bare boolean flag rather than coercing true to 1', () => {
  // The exact wrong-live-write this exists to stop: a fat-fingered `--quantity` arrives as `true`
  // from parseArgs, and Number(true) === 1 would silently mean "set every untagged variant to 1".
  assert.throws(() => numericOpt('--quantity', true, 0, thrower), /needs a number/);
});

test('numericOpt refuses a non-numeric string', () => {
  assert.throws(() => numericOpt('--quantity', 'lots', 0, thrower), /needs a number/);
});

test('numericOpt refuses an empty string', () => {
  assert.throws(() => numericOpt('--timeout-ms', '', 5, thrower), /needs a number/);
});

// --- makeWriter -------------------------------------------------------------
// The one function that turns an approved plan row into an inventory mutation. A stub client records
// the query and variables, exactly like mutations.test.mjs.
function stubClient(response) {
  const calls = [];
  return {
    calls,
    gql: async (query, variables) => {
      calls.push({ query, variables });
      return response;
    },
  };
}

test('makeWriter in absolute mode sets the target quantity with the baseline as the CAS guard', async () => {
  const client = stubClient({ inventorySetQuantities: { userErrors: [], inventoryAdjustmentGroup: { changes: [] } } });
  const write = makeWriter(client, 'gid://shopify/Location/1');
  const out = await write(
    { inventoryItemId: 'gid://shopify/InventoryItem/9', target: 12, baseline: 8, idempotencyKey: 'k1' },
    MODE_ABSOLUTE
  );
  const { variables } = client.calls[0];
  assert.equal(variables.input.quantities[0].quantity, 12);
  assert.equal(variables.input.quantities[0].changeFromQuantity, 8, 'CAS baseline is the pre-write quantity');
  assert.equal(variables.input.quantities[0].inventoryItemId, 'gid://shopify/InventoryItem/9');
  assert.equal(variables.input.quantities[0].locationId, 'gid://shopify/Location/1');
  assert.equal(variables.idempotencyKey, 'k1');
  assert.equal(out.ok, true);
});

test('makeWriter in delta mode writes target-minus-baseline, not the absolute target', async () => {
  // The destructive path the module warns about: a mis-computed delta fans out across every sibling
  // ("+12" applied to 10 members). Pin that the delta is target - baseline and no absolute quantity
  // rides along.
  const client = stubClient({ inventoryAdjustQuantities: { userErrors: [], inventoryAdjustmentGroup: { changes: [] } } });
  const write = makeWriter(client, 'gid://shopify/Location/1');
  await write(
    { inventoryItemId: 'gid://shopify/InventoryItem/9', target: 12, baseline: 8, idempotencyKey: 'k2' },
    MODE_DELTA
  );
  const { variables } = client.calls[0];
  assert.equal(variables.input.changes[0].delta, 4, 'delta is target - baseline');
  assert.equal(variables.input.changes[0].changeFromQuantity, 8);
  assert.equal(variables.input.changes[0].quantity, undefined, 'a delta write must not send an absolute quantity');
  assert.equal(variables.idempotencyKey, 'k2');
});

test('makeWriter surfaces a stale compare-and-swap as a failed outcome, not an exception', async () => {
  const client = stubClient({
    inventorySetQuantities: { userErrors: [{ code: 'CHANGE_FROM_QUANTITY_STALE', message: 'stale' }], inventoryAdjustmentGroup: null },
  });
  const write = makeWriter(client, 'gid://shopify/Location/1');
  const out = await write({ inventoryItemId: 'i', target: 1, baseline: 0, idempotencyKey: 'k' }, MODE_ABSOLUTE);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'CHANGE_FROM_QUANTITY_STALE');
});

// --- the catalogue manifest gate --------------------------------------------
// One helper, called by both `reorder` and `demand`, so the two cannot drift into different gates
// for the same file. It runs before the thresholds file is even read.

/** A store shaped like loadStore's return value, cut down to what the gate reads. */
function fakeStore({ variants = [], colors = ['Black'], sizes = ['M'] } = {}) {
  return {
    variants,
    display: {
      body: new Map(),
      color: new Map(colors.map((c) => [c.toLowerCase(), c])),
      size: new Map(sizes.map((s) => [s.toLowerCase(), s])),
    },
  };
}

const REFUSED = Symbol('refused');
/** Stands in for the process-exiting refusal, so the assertion can be made without tearing down the runner. */
function spyRefuse(seen) {
  return (params) => {
    seen.push(params);
    throw Object.assign(new Error('refused'), { tag: REFUSED });
  };
}

const ARTIFACT = { bodies: [{ productHandle: 'a', bodyId: 'crewneck' }] };
const ONE_BODY_MANIFEST = JSON.stringify({
  version: 1,
  bodies: { crewneck: { colors: ['black'], sizes: ['m'] } },
});

test('catalogueGate refuses a tagged variant whose combination the manifest does not declare', async () => {
  const seen = [];
  await assert.rejects(
    catalogueGate({
      artifact: ARTIFACT,
      store: fakeStore({
        colors: ['Black', 'Classic Navy'],
        variants: [
          { id: 'v1', body: 'crewneck', color: 'Classic Navy', size: 'M', blankId: 'NAVY_ACME_BLANKA_0001_M' },
        ],
      }),
      json: false,
      read: async () => ONE_BODY_MANIFEST,
      refuse: spyRefuse(seen),
    }),
    (err) => err.tag === REFUSED
  );
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].assessment.refusals.map((r) => r.code), ['catalogue-undeclared-variants']);
  assert.deepEqual(seen[0].assessment.refusals[0].keys, ['crewneck|classic navy|m']);
});

test('a manifest refusal renders in exactly the shape a thresholds refusal does', async () => {
  // A --json consumer must not have to know which gate stopped the run in order to parse the answer.
  const seen = [];
  await assert.rejects(
    catalogueGate({
      artifact: { bodies: [{ bodyId: 'quarter-zip' }] },
      store: fakeStore(),
      json: true,
      read: async () => ONE_BODY_MANIFEST,
      refuse: spyRefuse(seen),
    }),
    (err) => err.tag === REFUSED
  );
  const payload = refusalPayload(seen[0].assessment);
  assert.deepEqual(Object.keys(payload), ['error', 'keys', 'refusals', 'warnings']);
  assert.equal(payload.error, 'catalogue-unknown-bodies', 'error names the first refusal');
  // Both directions of the body-map disagreement fire, and `keys` carries every refusal's keys.
  assert.deepEqual(payload.refusals.map((r) => r.code), ['catalogue-unknown-bodies', 'catalogue-unmapped-bodies']);
  assert.deepEqual(payload.keys, ['crewneck', 'quarter-zip']);
});

test('catalogueGate refuses a missing manifest rather than defaulting to an empty shape', async () => {
  const seen = [];
  await assert.rejects(
    catalogueGate({
      artifact: ARTIFACT,
      store: fakeStore(),
      json: false,
      read: async () => {
        throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      },
      refuse: spyRefuse(seen),
    }),
    (err) => err.tag === REFUSED
  );
  assert.deepEqual(seen[0].assessment.refusals.map((r) => r.code), ['catalogue-missing']);
});

test('a warnings-only reconcile does not refuse; it returns the manifest and its warnings', async () => {
  const seen = [];
  const out = await catalogueGate({
    artifact: ARTIFACT,
    store: fakeStore({ colors: [], sizes: [] }), // nothing tagged yet, so every declared value is unseen
    json: false,
    read: async () => ONE_BODY_MANIFEST,
    refuse: spyRefuse(seen),
  });
  assert.deepEqual(seen, [], 'a warning is not a refusal');
  assert.deepEqual([...out.manifest.bodies.keys()], ['crewneck']);
  assert.deepEqual(out.warnings.map((w) => w.code), ['catalogue-unseen-colors', 'catalogue-unseen-sizes']);
});

test('a malformed manifest refuses in the same object shape as every other gate failure', async () => {
  // It used to print its own narrower {error, message, keys} instead, so a --json consumer that
  // read `refusals` crashed on exactly the case the shape exists to describe.
  const seen = [];
  await assert.rejects(
    catalogueGate({
      artifact: ARTIFACT,
      store: fakeStore(),
      json: true,
      read: async () => '{ not json',
      refuse: spyRefuse(seen),
    }),
    (err) => err.tag === REFUSED
  );
  const payload = refusalPayload(seen[0].assessment);
  assert.deepEqual(Object.keys(payload), ['error', 'keys', 'refusals', 'warnings']);
  assert.equal(payload.error, 'catalogue-invalid');
  assert.match(payload.refusals[0].message, /is not valid JSON/);
});

test('catalogueGate returns nothing at all when it refuses, rather than a half-built result', async () => {
  // `refuse` exits in production, so this is about the seam: a non-exiting refuse (a future
  // --dry-run, a collecting reporter) must not let the gate fall through and hand a caller a
  // result built on the manifest it just rejected.
  const seen = [];
  const collect = (params) => seen.push(params);
  const missing = await catalogueGate({
    artifact: ARTIFACT,
    store: fakeStore(),
    json: false,
    read: async () => {
      throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    },
    refuse: collect,
  });
  const mismatched = await catalogueGate({
    artifact: { bodies: [{ bodyId: 'quarter-zip' }] },
    store: fakeStore(),
    json: false,
    read: async () => ONE_BODY_MANIFEST,
    refuse: collect,
  });
  assert.equal(missing, undefined);
  assert.equal(mismatched, undefined, 'the reconcile refusal returns before building a result');
  assert.equal(seen.length, 2);
});

test('both reorder and demand run the manifest gate, and both run it before reading thresholds', async () => {
  // The short-circuit is an ORDERING property, and ordering is what the source shows. A manifest
  // refusal must not arrive alongside a list of unthresholded or stale cells computed from a cell
  // space the same refusal says is wrong.
  //
  // The slice is bounded to the function's own body and comments are stripped first. Slicing to end
  // of file let one command's indices come from a LATER function, so a command that stopped gating
  // could still pass on its neighbour's call; and an unstripped `await catalogueGate(` inside a
  // comment satisfied the search on its own. Both commands carry such a comment today.
  const cli = await readFile(path.join(dirname(fileURLToPath(import.meta.url)), '../blank-inventory.mjs'), 'utf8');
  const stripped = cli.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  for (const command of ['cmdReorder', 'cmdDemand']) {
    const start = stripped.indexOf(`async function ${command}(`);
    assert.ok(start > -1, `${command} is defined`);
    const next = stripped.indexOf('\nasync function ', start + 1);
    const body = stripped.slice(start, next === -1 ? undefined : next);
    const gate = body.indexOf('await catalogueGate(');
    const thresholds = body.indexOf('await readThresholdsOrRefuse(');
    assert.ok(gate > -1, `${command} calls the shared catalogueGate helper in its own body`);
    assert.ok(thresholds > -1, `${command} still reads the thresholds file`);
    assert.ok(gate < thresholds, `${command} gates on the manifest before reading thresholds`);
  }
});
