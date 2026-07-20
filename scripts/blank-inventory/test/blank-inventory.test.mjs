import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, numericOpt, makeWriter } from '../blank-inventory.mjs';
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
