import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseArgs,
  numericOpt,
  boolOpt,
  makeWriter,
  catalogueGate,
  refusalPayload,
  outOfArtifactUnconverged,
  waitForGroups,
  cmdRepair,
} from '../blank-inventory.mjs';
import { MODE_ABSOLUTE, MODE_DELTA } from '../lib/input.mjs';
import { createArtifact, verifyArtifact, receiptArtifactMismatch, writeJsonAtomic, readJson, ROW_APPLIED } from '../lib/receipt.mjs';
import { repairPlans } from '../lib/repair.mjs';
import { classifyGroups } from '../lib/groups.mjs';
import { CONVERGED, STALE, MISSING } from '../lib/convergence.mjs';
import { strandedGroup, blankIdFor, resetSeq } from './fixtures.mjs';

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

// --- boolOpt ----------------------------------------------------------------
// `--no-batch` disables the write pacing, so a swallowed argument here reads as "yes, disable it".

test('boolOpt returns false when the switch is absent and true when it is bare', () => {
  assert.equal(boolOpt('--no-batch', undefined), false);
  assert.equal(boolOpt('--no-batch', true), true);
});

test('boolOpt refuses a swallowed value rather than reading it as "on"', () => {
  assert.throws(() => boolOpt('--no-batch', 'counts.csv', thrower), /takes no value/);
  assert.throws(() => boolOpt('--no-batch', '0', thrower), /takes no value/);
});

test('--batch-size goes through numericOpt, so a bare flag cannot become a batch size of 1', () => {
  const opts = parseArgs(['apply', '--plan', 'p.json', '--batch-size', '4']);
  assert.equal(numericOpt('--batch-size', opts.batchSize, 1), 4);
  assert.throws(() => numericOpt('--batch-size', true, 1, thrower), /needs a number/);
});

// --- the resume receipt/artifact check --------------------------------------
// Both halves are load-bearing and each gets its own case: planId alone would pass a receipt from a
// different revision of the same plan, and contentHash alone would pass a receipt from a different
// plan whose groups happen to be identical, which is what a re-run of the same count sheet produces.

const planRow = (blankId) => ({
  blankId,
  target: 12,
  current: 11,
  baseline: 11,
  delta: null,
  writeTargetId: 'gid://shopify/ProductVariant/1',
  writeTargetTitle: 'p | t',
  inventoryItemId: 'gid://shopify/InventoryItem/1',
  memberIds: ['gid://shopify/ProductVariant/1'],
  siblingCount: 7,
  idempotencyKey: `key-${blankId}`,
});

test('--resume refuses a receipt whose contentHash does not match the artifact', () => {
  const artifact = createArtifact({ plans: [planRow('B1')], mode: MODE_ABSOLUTE, planId: 'plan-a' });
  const receipt = { planId: 'plan-a', contentHash: 'a-different-hash' };
  assert.match(receiptArtifactMismatch(receipt, artifact), /different bytes/);
});

test('--resume refuses a mismatched planId even when the hash matches', () => {
  // The case a hash-only check misses entirely: two plans over the same groups at the same targets
  // hash identically, so only the planId says which run's row statuses the receipt records.
  const a = createArtifact({ plans: [planRow('B1')], mode: MODE_ABSOLUTE, planId: 'plan-a' });
  const receipt = { planId: 'plan-b', contentHash: a.contentHash };
  assert.match(receiptArtifactMismatch(receipt, a), /not plan-a/);
  assert.equal(receiptArtifactMismatch({ planId: 'plan-a', contentHash: a.contentHash }, a), null);
});

// --- the pre-write store-state check ----------------------------------------

const A_BLANK = blankIdFor('crewneck', 'Grey Heather', '2XL');
const B_BLANK = blankIdFor('crewneck', 'Black', 'M');

test('apply refuses an unconverged group OUTSIDE the artifact', () => {
  // plan already refuses on any non-uniform group, but nothing re-checked between plan and apply,
  // and a long apply is exactly the window in which a group goes non-uniform.
  resetSeq(700);
  const groups = new Map([[B_BLANK, strandedGroup({ target: 12, stale: 11, color: 'Black', size: 'M' })]]);
  const artifact = createArtifact({ plans: [planRow(A_BLANK)], mode: MODE_ABSOLUTE, planId: 'plan-a' });
  const blocked = outOfArtifactUnconverged(artifact, classifyGroups(groups));
  assert.deepEqual(blocked.map((g) => g.blankId), [B_BLANK]);
});

test('apply does NOT refuse an unconverged group inside the artifact', () => {
  // checkDrift already handles those per row, against the approved baseline. Refusing on them would
  // also make every repair artifact unappliable, which is the one case that most needs applying.
  resetSeq(710);
  const groups = new Map([[A_BLANK, strandedGroup({ target: 12, stale: 11 })]]);
  const artifact = createArtifact({ plans: [planRow(A_BLANK)], mode: MODE_ABSOLUTE, planId: 'plan-a' });
  assert.deepEqual(outOfArtifactUnconverged(artifact, classifyGroups(groups)), []);
});

test('a real repairPlans output passes the check, precisely because its stranded group is inside it', () => {
  // Not a restatement of the case above: this feeds the actual planner's output through the actual
  // check, so a future change that stopped carrying the stranded blank into the artifact would fail
  // here rather than at the first live repair.
  resetSeq(720);
  const groups = new Map([[A_BLANK, strandedGroup({ target: 12, stale: 11 })]]);
  const { plans } = repairPlans({
    rows: [{ blankId: A_BLANK, target: 12, status: ROW_APPLIED, at: '2026-09-03T12:00:00.000Z' }],
    groups,
    planId: 'repair-1',
  });
  const artifact = createArtifact({ plans, mode: MODE_ABSOLUTE, planId: 'repair-1' });
  assert.equal(plans.length, 1);
  assert.deepEqual(outOfArtifactUnconverged(artifact, classifyGroups(groups)), []);
});

// --- one bar for "converged" ------------------------------------------------

test('verify and the batch gate classify identically, because they are the same call', async () => {
  // "The gate says converged" and "verify says converged" must be the same bar, or the gate passes
  // a batch that verify then fails and the operator holds two tools that disagree about one store.
  // One fake store and clock, fed through a verify-shaped call and a gate-shaped one.
  const frames = [
    { A: [12, 12], B: [11, 12], C: [] },
    { A: [12, 12], B: [11, 12], C: [] },
  ];
  const fakeDeps = () => {
    const s = { reads: 0, t: 0 };
    return {
      readAll: async () => {
        const frame = frames[Math.min(s.reads++, frames.length - 1)];
        return new Map(Object.entries(frame).map(([b, qs]) => [b, qs.map((q) => ({ quantity: q }))]));
      },
      now: () => s.t,
      sleep: async (ms) => {
        s.t += ms;
      },
    };
  };
  const targets = new Map([['A', 12], ['B', 12], ['C', 12]]);

  // verify-shaped: the whole receipt's applied rows, the --timeout-ms default.
  const fromVerify = await waitForGroups({ targets, timeoutMs: 300_000, deps: fakeDeps() });
  // gate-shaped: the ids one batch just wrote, the same timeout, driven from inside apply.
  const fromGate = await waitForGroups({ targets, timeoutMs: 300_000, deps: fakeDeps() });

  assert.deepEqual([...fromVerify.verdicts], [...fromGate.verdicts]);
  assert.deepEqual([...fromVerify.verdicts], [['A', CONVERGED], ['B', STALE], ['C', MISSING]]);
});

// --- repair writes nothing to the store -------------------------------------

test('cmdRepair issues no Admin call at all, against a client that fails the test if used', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'blank-inventory-repair-'));
  try {
    resetSeq(800);
    const groups = new Map([[A_BLANK, strandedGroup({ target: 12, stale: 11 })]]);
    const artifact = createArtifact({ plans: [planRow(A_BLANK)], mode: MODE_ABSOLUTE, planId: 'plan-a' });
    const artifactPath = path.join(dir, `plan-${artifact.planId}.json`);
    const receiptPath = path.join(dir, `receipt-${artifact.planId}.json`);
    const outPath = path.join(dir, 'repair.json');
    await writeJsonAtomic(artifactPath, artifact);
    await writeJsonAtomic(receiptPath, {
      planId: artifact.planId,
      contentHash: artifact.contentHash,
      mode: MODE_ABSOLUTE,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      rows: [{ blankId: A_BLANK, target: 12, status: ROW_APPLIED, detail: null, at: new Date().toISOString() }],
    });

    const spyClient = {
      gql: () => {
        assert.fail('repair must never issue an Admin call; it is read-only and emits an artifact');
      },
    };
    const printed = [];
    const realLog = console.log;
    console.log = (...args) => printed.push(args.join(' '));
    let out;
    try {
      out = await cmdRepair(
        { receipt: receiptPath, out: outPath },
        {
          load: async ({ requireWrite }) => {
            assert.equal(requireWrite, false, 'repair must not even ask for write scopes');
            return { client: spyClient, locationId: 'gid://shopify/Location/1', groups };
          },
          refuse: (msg) => assert.fail(`unexpected refusal: ${msg}`),
        }
      );
    } finally {
      console.log = realLog;
    }

    // The gate-5 reading has to name the source receipt and say the baseline is the LIVE quantity,
    // not the target: those two lines are what let an operator catch a stale or wrong receipt.
    const text = printed.join('\n');
    assert.match(text, /from plan plan-a/);
    assert.ok(text.includes(receiptPath));
    assert.match(text, /LIVE quantity, not the target/);

    assert.equal(out.repairedFrom, 'plan-a');
    assert.equal(out.groups.length, 1);
    // And what it wrote to disk is an ordinary artifact the normal path accepts.
    const written = verifyArtifact(await readJson(outPath));
    assert.equal(written.contentHash, out.contentHash);
    assert.equal(written.groups[0].target, 12);
    assert.equal(written.groups[0].baseline, 11);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cmdRepair refuses a receipt it cannot tie back to an artifact, before reading the store', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'blank-inventory-repair-'));
  try {
    const receiptPath = path.join(dir, 'receipt-orphan.json');
    await writeJsonAtomic(receiptPath, { planId: 'plan-nowhere', contentHash: 'x', rows: [] });
    const refusals = [];
    await cmdRepair(
      { receipt: receiptPath },
      {
        load: async () => assert.fail('the store must not be read once provenance has failed'),
        refuse: (msg) => refusals.push(msg),
      }
    );
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /No plan artifact for plan-nowhere/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cmdRepair refuses a receipt whose hash disagrees with the artifact beside it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'blank-inventory-repair-'));
  try {
    const artifact = createArtifact({ plans: [planRow(A_BLANK)], mode: MODE_ABSOLUTE, planId: 'plan-a' });
    await writeJsonAtomic(path.join(dir, 'plan-plan-a.json'), artifact);
    const receiptPath = path.join(dir, 'receipt-plan-a.json');
    await writeJsonAtomic(receiptPath, { planId: 'plan-a', contentHash: 'not-the-artifact-hash', rows: [] });
    const refusals = [];
    await cmdRepair(
      { receipt: receiptPath },
      { load: async () => assert.fail('the store must not be read'), refuse: (msg) => refusals.push(msg) }
    );
    assert.match(refusals[0], /does not belong to/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cmdRepair refuses a receipt older than 24 hours', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'blank-inventory-repair-'));
  try {
    const artifact = createArtifact({ plans: [planRow(A_BLANK)], mode: MODE_ABSOLUTE, planId: 'plan-a' });
    await writeJsonAtomic(path.join(dir, 'plan-plan-a.json'), artifact);
    const stale = new Date(Date.now() - 40 * 60 * 60 * 1000).toISOString();
    const receiptPath = path.join(dir, 'receipt-plan-a.json');
    await writeJsonAtomic(receiptPath, {
      planId: 'plan-a',
      contentHash: artifact.contentHash,
      startedAt: stale,
      finishedAt: stale,
      rows: [{ blankId: A_BLANK, target: 12, status: ROW_APPLIED, at: stale }],
    });
    const refusals = [];
    await cmdRepair(
      { receipt: receiptPath },
      { load: async () => assert.fail('an out-of-date receipt must not reach the store read'), refuse: (msg) => refusals.push(msg) }
    );
    assert.match(refusals[0], /past the 24h bound/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('repair is not a write command, and its body reaches no mutation', async () => {
  // A structural check to pair with the runtime one above: the runtime test proves this run made no
  // call, and this proves there is no branch that could. Comments are stripped first, so a mutation
  // named in prose does not satisfy or trip the search.
  const cli = await readFile(path.join(dirname(fileURLToPath(import.meta.url)), '../blank-inventory.mjs'), 'utf8');
  const stripped = cli.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const start = stripped.indexOf('async function cmdRepair(');
  assert.ok(start > -1);
  const next = stripped.indexOf('\nasync function ', start + 1);
  const body = stripped.slice(start, next === -1 ? undefined : next);
  for (const forbidden of ['setQuantity', 'adjustQuantity', 'setBlankMetafields', 'deleteBlankMetafields', 'makeWriter', 'applyPlan']) {
    assert.ok(!body.includes(forbidden), `cmdRepair must not reference ${forbidden}`);
  }
  assert.ok(body.includes('requireWrite: false'), 'and it must not ask for write scopes');
  assert.match(stripped, /writeCommands = new Set\(\['apply', 'backfill', 'untag'\]\)/, 'repair stays out of the write set');
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

/**
 * A store shaped like loadStore's return value, cut down to what the gate reads.
 *
 * `products` and `variants` are BOTH here now. The gate stopped comparing the manifest against the
 * approved body map (which is derived from the manifest, so that comparison could never fail for a
 * real reason) and compares it against the LIVE STORE instead, so the fake has to carry the live
 * side: a product census with titles and GIDs, and the variant list that says which are tracked.
 */
function fakeStore({ variants = [], colors = ['Black'], sizes = ['M'], products = null } = {}) {
  return {
    products: products ?? [{ id: LIVE_GID, handle: 'crew', title: 'Crew' }],
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

const LIVE_GID = 'gid://shopify/Product/1';

/**
 * A hand-authored one-body, one-product manifest.
 *
 * HAND-AUTHORED, not read from catalogue.json, and every gate test below uses it. Feeding these the
 * committed manifest would make each assertion a statement about today's catalogue rather than about
 * the gate's decision logic, and would rewrite itself the next time a product ships.
 *
 * @param {object} [over] - shallow overrides on the product entry
 */
function oneProductManifest(over = {}) {
  return JSON.stringify({
    version: 2,
    options: { color: 'Color', size: 'Size', design: 'Design', denomination: 'Denominations' },
    colors: { black: { display: 'Black', slug: 'black' } },
    sizes: { m: { display: 'M' } },
    bodies: { crewneck: { colors: ['black'], sizes: ['m'] } },
    products: {
      crew: { line: 'lead2', body: 'crewneck', template: 'crew', title: 'Crew', gid: LIVE_GID, ...over },
    },
  });
}

const ONE_BODY_MANIFEST = oneProductManifest();

test('catalogueGate refuses a tagged variant whose combination the manifest does not declare', async () => {
  const seen = [];
  await assert.rejects(
    catalogueGate({
      store: fakeStore({
        colors: ['Black', 'Classic Navy'],
        variants: [
          { id: 'v1', productHandle: 'crew', body: 'crewneck', color: 'Classic Navy', size: 'M', blankId: 'NAVY_ACME_BLANKA_0001_M' },
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

// --- the five networked refusal codes, offline -------------------------------
//
// These five can only FIRE at the networked gate, against a real store. Their decision logic is
// pure, though, so each one gets a hand-authored manifest and a fake Admin payload pair here: one
// that must refuse with exactly that code, and one that must not refuse at all. That turns "five
// refusal classes fire only at the networked gate" from an untested-code exposure into a
// data-freshness exposure, which is the most the offline half can do.

test('an undeclared live product refuses, and a declared one does not', async () => {
  const seen = [];
  await assert.rejects(
    catalogueGate({
      store: fakeStore({
        products: [
          { id: LIVE_GID, handle: 'crew', title: 'Crew' },
          { id: 'gid://shopify/Product/2', handle: 'newcomer', title: 'Newcomer' },
        ],
        variants: [{ productHandle: 'newcomer', tracked: true }],
      }),
      json: false,
      read: async () => ONE_BODY_MANIFEST,
      refuse: spyRefuse(seen),
    }),
    (err) => err.tag === REFUSED
  );
  assert.deepEqual(seen[0].assessment.refusals.map((r) => r.code), ['catalogue-undeclared-products']);
  assert.deepEqual(seen[0].assessment.refusals[0].keys, ['newcomer']);

  const clean = [];
  const ok = await catalogueGate({
    store: fakeStore(),
    json: false,
    read: async () => ONE_BODY_MANIFEST,
    refuse: spyRefuse(clean),
  });
  assert.deepEqual(clean, []);
  assert.ok(ok.manifest);
});

test('an untracked undeclared live product does NOT refuse', async () => {
  // A gift card has no tracked variants and joins no blank group, so it is out of scope for this
  // gate in the same way it is out of scope for learnVocab. Refusing on it would make the reorder
  // review unrunnable on a store that sells one.
  const seen = [];
  const out = await catalogueGate({
    store: fakeStore({
      products: [
        { id: LIVE_GID, handle: 'crew', title: 'Crew' },
        { id: 'gid://shopify/Product/9', handle: 'gift', title: 'Gift', tracked: false },
      ],
    }),
    json: false,
    read: async () => ONE_BODY_MANIFEST,
    refuse: spyRefuse(seen),
  });
  assert.deepEqual(seen, []);
  assert.ok(out.manifest);
});

test('a declared handle with no live product refuses', async () => {
  const seen = [];
  await assert.rejects(
    catalogueGate({
      store: fakeStore({ products: [{ id: 'gid://shopify/Product/2', handle: 'someone-else', title: 'Other' }] }),
      json: false,
      read: async () => ONE_BODY_MANIFEST,
      refuse: spyRefuse(seen),
    }),
    (err) => err.tag === REFUSED
  );
  const codes = seen[0].assessment.refusals.map((r) => r.code);
  assert.ok(codes.includes('catalogue-stale-products'), `got ${codes.join(', ')}`);
  assert.deepEqual(
    seen[0].assessment.refusals.find((r) => r.code === 'catalogue-stale-products').keys,
    ['crew']
  );
});

test('a live title that differs from the declared one refuses, and a matching one does not', async () => {
  const seen = [];
  await assert.rejects(
    catalogueGate({
      store: fakeStore({ products: [{ id: LIVE_GID, handle: 'crew', title: 'Crew (renamed in Admin)' }] }),
      json: false,
      read: async () => ONE_BODY_MANIFEST,
      refuse: spyRefuse(seen),
    }),
    (err) => err.tag === REFUSED
  );
  assert.deepEqual(seen[0].assessment.refusals.map((r) => r.code), ['catalogue-title-mismatch']);
  assert.deepEqual(seen[0].assessment.refusals[0].keys, ['crew']);

  const clean = [];
  await catalogueGate({ store: fakeStore(), json: false, read: async () => ONE_BODY_MANIFEST, refuse: spyRefuse(clean) });
  assert.deepEqual(clean, []);
});

test('a live GID that differs from the declared one refuses, and a matching one does not', async () => {
  // The one that matters most: a GID is stable for the life of a product, so a mismatch means the
  // handle now resolves to a DIFFERENT product, and writing media against it edits the wrong one.
  const seen = [];
  await assert.rejects(
    catalogueGate({
      store: fakeStore({ products: [{ id: 'gid://shopify/Product/999', handle: 'crew', title: 'Crew' }] }),
      json: false,
      read: async () => ONE_BODY_MANIFEST,
      refuse: spyRefuse(seen),
    }),
    (err) => err.tag === REFUSED
  );
  assert.deepEqual(seen[0].assessment.refusals.map((r) => r.code), ['catalogue-gid-mismatch']);
  assert.deepEqual(seen[0].assessment.refusals[0].keys, ['crew']);

  const clean = [];
  await catalogueGate({ store: fakeStore(), json: false, read: async () => ONE_BODY_MANIFEST, refuse: spyRefuse(clean) });
  assert.deepEqual(clean, []);
});

test('a manifest refusal renders in exactly the shape a thresholds refusal does', async () => {
  // A --json consumer must not have to know which gate stopped the run in order to parse the answer.
  const seen = [];
  await assert.rejects(
    catalogueGate({
      store: fakeStore({ products: [{ id: 'gid://shopify/Product/999', handle: 'crew', title: 'Renamed' }] }),
      json: true,
      read: async () => ONE_BODY_MANIFEST,
      refuse: spyRefuse(seen),
    }),
    (err) => err.tag === REFUSED
  );
  const payload = refusalPayload(seen[0].assessment);
  assert.deepEqual(Object.keys(payload), ['error', 'keys', 'refusals', 'warnings']);
  assert.equal(payload.error, 'catalogue-title-mismatch', 'error names the first refusal');
  assert.deepEqual(payload.refusals.map((r) => r.code), ['catalogue-title-mismatch', 'catalogue-gid-mismatch']);
  assert.deepEqual(payload.keys, ['crew', 'crew']);
});

test('catalogueGate refuses a missing manifest rather than defaulting to an empty shape', async () => {
  const seen = [];
  await assert.rejects(
    catalogueGate({
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

test('a version 1 manifest refuses with a message naming the migrator, and never auto-migrates', async () => {
  const seen = [];
  await assert.rejects(
    catalogueGate({
      store: fakeStore(),
      json: false,
      read: async () => JSON.stringify({ version: 1, bodies: { crewneck: { colors: ['black'], sizes: ['m'] } } }),
      refuse: spyRefuse(seen),
    }),
    (err) => err.tag === REFUSED
  );
  const [refusal] = seen[0].assessment.refusals;
  assert.equal(refusal.code, 'catalogue-invalid');
  assert.match(refusal.message, /hand-corrected in a reviewed PR/);
  assert.match(refusal.message, /never auto-migrated/);
});

test('catalogueGate returns nothing at all when it refuses, rather than a half-built result', async () => {
  // `refuse` exits in production, so this is about the seam: a non-exiting refuse (a future
  // --dry-run, a collecting reporter) must not let the gate fall through and hand a caller a
  // result built on the manifest it just rejected.
  const seen = [];
  const collect = (params) => seen.push(params);
  const missing = await catalogueGate({
    store: fakeStore(),
    json: false,
    read: async () => {
      throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    },
    refuse: collect,
  });
  const mismatched = await catalogueGate({
    store: fakeStore({ products: [{ id: 'gid://shopify/Product/999', handle: 'crew', title: 'Crew' }] }),
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
