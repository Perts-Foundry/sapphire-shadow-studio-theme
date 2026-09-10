// The --dry-run contract, on every path that can write.
//
// On 2026-09-10 `backfill --stage tag --plan <f> --dry-run`, run as a preview before the operator's
// tag gate, wrote every tag in the proposal to the live store and left a seeding receipt behind. The
// tag branch never read `opts.dryRun`, and nothing caught it: the flag registry test works per
// COMMAND, `cmdBackfill` reads the flag in its seed branch, so the flag counted as honoured for every
// stage. And because `main()` treated any dry run as a read, the writes also ran without the lock.
//
// Every case below runs against a synthetic store whose Admin client, file writer and apply engine
// are traps: any call on a dry run fails the test. Every dry run then goes through ONE helper,
// `assertCleanDryRun`, so a case cannot quietly assert less than the others.
//
// The tests run sequentially (the node:test default; do not set `concurrency`): they swap
// `console.log` to capture output, and share one temporary working directory that must stay empty.

import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { variant, groupSlice, blankIdFor, resetSeq } from './fixtures.mjs';
import { learnVocab, buildGroups } from '../lib/groups.mjs';
import { createArtifact, writeJsonAtomic } from '../lib/receipt.mjs';
import { MODE_ABSOLUTE } from '../lib/input.mjs';
import * as mutations from '../lib/mutations.mjs';

// The CLI resolves its working directory once, at import, so point it at a temp directory FIRST.
// Inputs (plan artifacts, proposals) live in a second directory, so "the working directory is still
// empty" means exactly "this run wrote nothing".
const WORK = await mkdtemp(path.join(os.tmpdir(), 'blank-inventory-dryrun-work-'));
const INPUTS = await mkdtemp(path.join(os.tmpdir(), 'blank-inventory-dryrun-in-'));
process.env.BLANK_INVENTORY_DIR = WORK;
// A namespace import, not named imports: a missing export must fail the cases that need it, not the
// whole file at load.
const cli = await import('../blank-inventory.mjs');

after(async () => {
  await rm(WORK, { recursive: true, force: true });
  await rm(INPUTS, { recursive: true, force: true });
});

// A leaked write fails the test that made it, and only that one: the directory is emptied here, so
// one stray file cannot cascade into every later "the working directory is still empty" check.
afterEach(async () => {
  const left = await readdir(WORK);
  for (const f of left) await rm(path.join(WORK, f), { recursive: true, force: true });
  if (left.length) throw new Error(`this test left ${left.join(', ')} in the working directory`);
});

const DONE = 'DRY RUN: nothing written.';

// --- harness -----------------------------------------------------------------

/** Run `fn` with console.log captured. Never throws: the error is returned for the caller to judge. */
async function capture(fn) {
  const printed = [];
  const realLog = console.log;
  console.log = (...args) => printed.push(args.join(' '));
  let error = null;
  try {
    await fn();
  } catch (err) {
    error = err;
  } finally {
    console.log = realLog;
  }
  const text = printed.join('\n');
  return { error, text, lines: text.split('\n').filter((l) => l.trim() !== '') };
}

/** A stand-in for the Admin API's answer to a mutation, so a LIVE control can get past the call. */
function benignResponse(query, variables) {
  if (query.includes('metafieldsSet(')) {
    return { metafieldsSet: { metafields: variables.metafields.map((m) => ({ ...m, id: 'mf' })), userErrors: [] } };
  }
  if (query.includes('metafieldsDelete(')) {
    return { metafieldsDelete: { deletedMetafields: variables.metafields, userErrors: [] } };
  }
  return {};
}

const opName = (query) => query.match(/(?:mutation|query)\s+(\w+)/)?.[1] ?? '(anonymous)';

/**
 * The three traps. On a dry run each records the call AND fails; on a live control each records the
 * call and lets it through, so a positive control can prove the fixture really reaches it.
 */
function traps({ live }) {
  const events = [];
  const gqlCalls = [];
  const writes = [];
  const engine = [];
  const client = {
    gql: async (query, variables = {}) => {
      gqlCalls.push({ query, variables });
      events.push(`gql:${opName(query)}`);
      if (!live) assert.fail(`the Admin client was called on a dry run (${opName(query)})`);
      return benignResponse(query, variables);
    },
    scopes: async () => ['write_products', 'write_inventory'],
  };
  const writeJson = async (filePath, data) => {
    writes.push({ path: filePath, data });
    events.push(`write:${path.basename(filePath)}`);
    if (!live) assert.fail(`writeJson was called on a dry run (${filePath})`);
  };
  const runBatches = async (params) => {
    engine.push(params);
    events.push('engine');
    if (!live) assert.fail('the apply engine was reached on a dry run');
    return { receipt: params.receipt, applied: 0, skipped: 0, failed: 0, batches: [], halted: false };
  };
  return { client, writeJson, runBatches, events, gqlCalls, writes, engine };
}

/** The shape loadStore returns, built from synthetic variants. */
function storeOf(variants, client) {
  const { vocab, conflicts, unbodied, display } = learnVocab(variants);
  return {
    client,
    locationId: 'gid://shopify/Location/1',
    locations: [],
    products: [],
    variants,
    vocab,
    conflicts,
    unbodied,
    display,
    unmapped: [],
    groups: buildGroups(variants),
  };
}

class Refused extends Error {}
const refuse = (msg) => {
  throw new Refused(msg);
};

const label = (v) => `${v.productHandle} | ${v.title}`;
const tagOf = (v, blankId) => ({ variantId: v.id, blankId, label: label(v), body: v.body, color: v.color, size: v.size, quantity: v.quantity });

async function writeInput(name, data) {
  const p = path.join(INPUTS, name);
  await writeJsonAtomic(p, data);
  return p;
}

// --- the cases ---------------------------------------------------------------
//
// One per dry-run path. Each returns the variants the synthetic store holds, the parsed flags for a
// LIVE run (the runner adds `dryRun`), and the command. The command is looked up when the case runs,
// so a missing export fails that case rather than the file.

const CASES = {
  apply: async () => {
    resetSeq(100);
    const members = groupSlice({ taggedQty: [11, 11, 11, 11], untagged: 0 });
    const [first] = members;
    const artifact = createArtifact({
      plans: [
        {
          blankId: first.blankId,
          target: 12,
          current: 11,
          baseline: 11,
          delta: null,
          writeTargetId: first.id,
          writeTargetTitle: label(first),
          inventoryItemId: first.inventoryItemId,
          memberIds: members.map((m) => m.id),
          siblingCount: members.length - 1,
          idempotencyKey: `key-${first.blankId}`,
        },
      ],
      mode: MODE_ABSOLUTE,
      planId: 'plan-dry-apply',
    });
    const plan = await writeInput('plan-dry-apply.json', artifact);
    return { variants: members, opts: { command: 'apply', plan }, cmd: () => cli.cmdApply };
  },

  'backfill:propose': async () => {
    resetSeq(200);
    const variants = groupSlice({ taggedQty: [11, 11], untagged: 3 });
    return { variants, opts: { command: 'backfill', stage: 'propose' }, cmd: () => cli.cmdBackfill };
  },

  'backfill:propose-bootstrap': async () => {
    resetSeq(300);
    const variants = [1, 2].map(() => variant({ body: 'crewneck', color: 'Black', size: 'M', quantity: 0, blankId: null }));
    return {
      variants,
      opts: { command: 'backfill', stage: 'propose', blank: 'BLACK_ACME_BLANKA_0002_M', product: 'product-crewneck' },
      cmd: () => cli.cmdBackfill,
    };
  },

  'backfill:tag': async () => {
    resetSeq(400);
    const established = groupSlice({ taggedQty: [11, 11, 11, 11], untagged: 3 });
    const blankId = established[0].blankId;
    const untagged = established.filter((v) => !v.blankId);
    // One variant already carrying this id, and one carrying a DIFFERENT one: the preview has to tell
    // all three apart, because a real run silently overwrites the third.
    const alreadyThere = established[0];
    const elsewhere = variant({ body: 'crewneck', color: 'Grey Heather', size: '2XL', blankId: blankIdFor('crewneck', 'Black', '2XL') });
    // And one the store no longer has: a real run would fail on it, so the preview must say so.
    const gone = variant({ body: 'crewneck', color: 'Grey Heather', size: '2XL', blankId: null });
    const variants = [...established, elsewhere];
    const tags = [...untagged, alreadyThere, elsewhere, gone].map((v) => tagOf(v, blankId));
    const plan = await writeInput('backfill-plan-dry-tag.json', { version: 1, planId: 'plan-dry-tag', tags });
    return {
      variants,
      opts: { command: 'backfill', stage: 'tag', plan },
      cmd: () => cli.cmdBackfill,
      expect: {
        states: [
          ...untagged.map((v) => [label(v), 'untagged']),
          [label(alreadyThere), 'already holds this id (no-op)'],
          [label(elsewhere), 'holds a DIFFERENT id: a real run would overwrite it'],
          [label(gone), 'not on the store: a real run would fail on it'],
        ],
        counts: '3 untagged, 1 already hold this id, 1 hold a DIFFERENT id, 1 not on the store',
      },
    };
  },

  'backfill:seed': async () => {
    resetSeq(500);
    const established = groupSlice({ taggedQty: [11, 11, 11, 11], untagged: 0 });
    const blankId = established[0].blankId;
    // After the tag stage: the new members carry the id and still sit at 0.
    const fresh = [1, 2].map(() => variant({ body: 'crewneck', color: 'Grey Heather', size: '2XL', quantity: 0, blankId }));
    const plan = await writeInput('backfill-plan-dry-seed.json', {
      version: 1,
      planId: 'plan-dry-seed',
      tags: fresh.map((v) => tagOf(v, blankId)),
    });
    return { variants: [...established, ...fresh], opts: { command: 'backfill', stage: 'seed', plan }, cmd: () => cli.cmdBackfill };
  },

  untag: async () => {
    resetSeq(600);
    const members = groupSlice({ taggedQty: [11, 11, 11], untagged: 0 });
    return { variants: members, opts: { command: 'untag', variant: [members[0].id] }, cmd: () => cli.cmdUntag };
  },
};

/** The deps every command gets here: a synthetic store, the traps, and no real waiting. */
function depsFor(variants, t) {
  return { load: async () => storeOf(variants, t.client), refuse, writeJson: t.writeJson, runBatches: t.runBatches, sleep: async () => {} };
}

/**
 * Run one case. `opts` rewrites the parsed flags (the backstop test uses it) and `load` replaces the
 * synthetic store's reader (the quiesce test uses it). The exit code is saved, restored and
 * reported: a command that set it would otherwise fail this file without naming a test.
 */
async function runCase(key, { dryRun, opts: rewrite = (o) => o, load } = {}) {
  const c = await CASES[key]();
  const t = traps({ live: !dryRun });
  const deps = depsFor(c.variants, t);
  if (load) deps.load = load(c, t);
  const opts = rewrite(dryRun ? { ...c.opts, dryRun: true } : c.opts);
  const exitCode = process.exitCode;
  const out = await capture(() => c.cmd()(opts, deps));
  const exitCodeChanged = process.exitCode !== exitCode;
  process.exitCode = exitCode;
  return { ...out, t, c, exitCodeChanged };
}

/**
 * Everything a dry run must satisfy. One helper for every case, so no case can assert less.
 *
 * "Resolved without throwing" is what separates the per-stage fix from the backstop: once the
 * backstop exists, a stage that forgets the flag throws `DRY RUN: refused ...` instead of writing,
 * which is safe but still a bug in that stage.
 */
async function assertCleanDryRun(key, { error, lines, t, exitCodeChanged }) {
  if (error && /^DRY RUN: refused/.test(error.message)) {
    assert.fail(`stage ${key} did not honour --dry-run (the backstop fired): ${error.message}`);
  }
  assert.equal(error, null, `${key} --dry-run threw: ${error?.message}`);
  assert.deepEqual(t.gqlCalls.map((c) => opName(c.query)), [], `${key} --dry-run called the Admin client`);
  assert.deepEqual(t.writes.map((w) => w.path), [], `${key} --dry-run called writeJson`);
  assert.equal(t.engine.length, 0, `${key} --dry-run reached the apply engine`);
  assert.deepEqual(await readdir(WORK), [], `${key} --dry-run left a file in the working directory`);
  assert.equal(exitCodeChanged, false, `${key} --dry-run changed the process exit code`);
  assert.equal(lines.at(-1), DONE, `${key} --dry-run must end with "${DONE}"`);
}

for (const key of Object.keys(CASES)) {
  test(`${key} --dry-run writes nothing, calls nothing, and says so last`, async () => {
    await assertCleanDryRun(key, await runCase(key, { dryRun: true }));
  });
}

// --- the incident ------------------------------------------------------------

test('2026-09-10: backfill --stage tag --dry-run shows every variant and its live state, and writes nothing', async () => {
  const run = await runCase('backfill:tag', { dryRun: true });
  await assertCleanDryRun('backfill:tag', run);
  // The full label, Design value and all: the hidden row in every group of the incident's gate was
  // the newest design value's variant.
  for (const [lbl, state] of run.c.expect.states) {
    const line = run.lines.find((l) => l.includes(lbl));
    assert.ok(line, `the preview names ${lbl}`);
    assert.ok(line.includes(state), `${lbl} is shown as "${state}", got: ${line}`);
  }
  assert.match(run.text, /Quiesce read the live store; nothing was written\./);
  assert.match(run.text, /No metafield and no seeding receipt written\./);
  assert.ok(run.lines.some((l) => l.trim() === run.c.expect.counts), `the count line reads "${run.c.expect.counts}"`);
});

// --- positive controls -------------------------------------------------------
//
// A green dry run is only meaningful if the same fixture, run live, reaches the traps. Without these
// a case whose fixture never got as far as a write path would pass for the wrong reason.

const REACHES = {
  apply: (t) => assert.deepEqual(t.events, ['engine']),
  'backfill:propose': (t) => {
    assert.equal(t.writes.length, 1, 'the proposal file');
    assert.match(path.basename(t.writes[0].path), /^backfill-.+\.json$/);
    // Without this the empty-directory checks could be watching a directory the CLI never writes
    // to: WORK_DIR is fixed at import, and only this file sets BLANK_INVENTORY_DIR first.
    assert.equal(path.dirname(t.writes[0].path), WORK, 'the CLI resolved its working directory to the temp one');
  },
  'backfill:propose-bootstrap': (t) => {
    assert.equal(t.writes.length, 1, 'the proposal file');
    assert.equal(t.writes[0].data.bootstrap, true);
  },
  'backfill:tag': (t) => assert.deepEqual(t.events, ['gql:BlankInventoryTag', 'write:receipt-seed-plan-dry-tag.json']),
  'backfill:seed': (t) => assert.deepEqual(t.events, ['engine']),
  untag: (t) => assert.deepEqual(t.events, ['gql:BlankInventoryUntag']),
};

for (const key of Object.keys(CASES)) {
  test(`positive control: ${key} without --dry-run reaches the trap`, async () => {
    const run = await runCase(key, { dryRun: false });
    if (key === 'untag') {
      // untag's live control stops at its own interlock, AFTER the delete reached the client: the
      // synthetic re-read still shows the tag. Pinned to that exact refusal, so a re-read that went
      // around deps.load (and threw for want of credentials) cannot hide behind a swallowed error.
      assert.match(run.error?.message ?? '', /still carry the blank metafield/);
    } else {
      assert.equal(run.error, null, `live ${key} threw: ${run.error?.message}`);
    }
    assert.equal(run.exitCodeChanged, false, `live ${key} changed the process exit code`);
    REACHES[key](run.t);
  });
}

test('the seed receipt is written through the injected writer, so a dry run cannot bypass it', async () => {
  // Seed's receipt is not written in the command body: it goes through the `persist` callback handed
  // to the engine. Invoke that callback and check where it lands.
  const run = await runCase('backfill:seed', { dryRun: false });
  assert.equal(run.error, null);
  const [params] = run.t.engine;
  await params.persist({ probe: true });
  assert.deepEqual(run.t.writes.map((w) => path.basename(w.path)), ['receipt-seed-plan-dry-seed.json']);
  assert.deepEqual(await readdir(WORK), [], 'and nothing reached the disk');
});

// --- completeness ------------------------------------------------------------

test('every dry-run path has a case, and every case has a positive control', () => {
  // DERIVED, not hand-listed. The registry test that let this bug through checks flags per COMMAND,
  // so a command that honours --dry-run on one stage counts as honouring it on all of them. This
  // requires one case per stage instead.
  //
  // Its limit: it checks that a case EXISTS, not what the case asserts. That is why every case goes
  // through assertCleanDryRun rather than asserting on its own.
  assert.ok(Array.isArray(cli.BACKFILL_STAGES) && cli.BACKFILL_STAGES.length >= 3, 'BACKFILL_STAGES is exported');
  const required = new Set();
  for (const [command, flags] of Object.entries(cli.COMMAND_FLAGS)) {
    if (!flags.includes('dryRun')) continue;
    if (command === 'backfill') {
      for (const stage of cli.BACKFILL_STAGES) required.add(`backfill:${stage}`);
      required.add('backfill:propose-bootstrap');
    } else {
      required.add(command);
    }
  }
  assert.deepEqual(Object.keys(CASES).sort(), [...required].sort());
  assert.deepEqual(Object.keys(REACHES).sort(), [...required].sort());
});

// --- validation before any read ---------------------------------------------

test('backfill refuses an unknown --stage before it reads the store', async () => {
  const t = traps({ live: false });
  const { error } = await capture(() =>
    cli.cmdBackfill(
      { command: 'backfill', stage: 'bogus' },
      { load: async () => assert.fail('the store must not be read for an unknown stage'), refuse, writeJson: t.writeJson, runBatches: t.runBatches, sleep: async () => {} }
    )
  );
  assert.ok(error instanceof Refused, `expected a refusal, got: ${error?.message}`);
  assert.match(error.message, /Unknown --stage "bogus"/);
});

// --- which runs take the lock ------------------------------------------------

test('isWriteRun: live writes take the lock and the stray-workdir refusal; dry runs and reads do not', () => {
  assert.equal(typeof cli.isWriteRun, 'function', 'isWriteRun is exported');
  const run = (s) => cli.isWriteRun(cli.parseArgs(s.split(' ')));
  const live = ['backfill --stage tag --plan p', 'backfill --stage seed --plan p', 'apply --plan p', 'untag --variant v'];
  for (const argv of live) {
    assert.equal(run(argv), true, `${argv} is a write run`);
    assert.equal(run(`${argv} --dry-run`), false, `${argv} --dry-run is not`);
  }
  for (const argv of ['repair --receipt r', 'audit', 'bodies', 'reorder', 'demand', 'vocab', 'show --plan p', 'plan --input i --mode absolute', 'verify --receipt r']) {
    assert.equal(run(argv), false, `${argv} is not a write run`);
  }
});

// --- structure: the backstop cannot be bypassed ------------------------------

test('nothing in apply, backfill or untag can reach the store or the disk around the backstop', async () => {
  // The runtime backstop wraps what `deps.load` returns and replaces `deps.writeJson` and
  // `deps.runBatches`. That covers a write only if nothing reaches the store or the disk another way,
  // so this checks the WHOLE FILE against allowlists, not just the three bodies: a helper that a
  // command calls is as much a bypass as a direct call. A new caller fails here until someone has
  // decided it cannot be reached from a dry run.
  //
  // Comments are stripped first, so prose naming a function neither satisfies nor trips the search.
  // Top-level boundaries are `function` or `const` at column 0; erring wide includes too much code in
  // a body, which can only make this stricter.
  const src = await readFile(fileURLToPath(new URL('../blank-inventory.mjs', import.meta.url)), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const lines = stripped.split('\n');
  const tops = [];
  lines.forEach((line, i) => {
    const m = line.match(/^(?:export )?(?:async )?function (\w+)\(|^(?:export )?const (\w+) = /);
    if (m) tops.push({ name: m[1] ?? m[2], line: i });
  });
  const bodyOf = (name) => {
    const i = tops.findIndex((t) => t.name === name);
    assert.ok(i > -1, `${name} was located`);
    return lines.slice(tops[i].line, tops[i + 1]?.line ?? lines.length).join('\n');
  };
  const callers = (needle) => {
    const names = new Set();
    lines.forEach((l, i) => {
      if (l.includes(needle)) names.add(tops.filter((t) => t.line <= i).at(-1)?.name ?? '(module)');
    });
    return [...names].sort();
  };

  assert.deepEqual(
    callers('loadStore('),
    ['cmdAudit', 'cmdDemand', 'cmdPlan', 'cmdReorder', 'cmdVocab', 'loadStore'],
    'only the read commands call loadStore() directly (and it is defined once)'
  );
  assert.deepEqual(callers('writeJsonAtomic('), ['cmdPlan', 'cmdRepair', 'withLock'], 'no dry-run path calls writeJsonAtomic()');
  // The client the backstop wraps is the only one: loadStore is the one place a client is built.
  assert.deepEqual(callers('createAdminClient('), ['loadStore'], 'only loadStore builds an Admin client');

  for (const name of ['cmdApply', 'cmdBackfill', 'cmdUntag']) {
    const body = bodyOf(name);
    // The line the forgetful-stage tests below depend on, pinned independently of read order.
    assert.ok(body.includes('dryRunDeps(opts, { ...DEFAULT_DEPS, ...injected })'), `${name} takes its deps through dryRunDeps`);
    assert.equal(body.split('DEFAULT_DEPS').length - 1, 1, `${name} names DEFAULT_DEPS only to hand it to dryRunDeps`);
    // liveWatchDeps() with no argument reads through loadStore, around the wrapped load.
    assert.doesNotMatch(body, /liveWatchDeps\(\s*\)/, `${name} passes its own load to liveWatchDeps`);
  }
});

// --- full rows at the gates --------------------------------------------------

test('backfill propose prints every variant in a group, never "... and N more"', async () => {
  resetSeq(700);
  const variants = groupSlice({ taggedQty: [11], untagged: 7 });
  const t = traps({ live: false });
  const { text } = await capture(() =>
    cli.cmdBackfill(
      { command: 'backfill', stage: 'propose', dryRun: true },
      { load: async () => storeOf(variants, t.client), refuse, writeJson: t.writeJson, runBatches: t.runBatches, sleep: async () => {} }
    )
  );
  const rows = variants.filter((v) => !v.blankId);
  assert.equal(rows.length, 7);
  for (const v of rows) assert.ok(text.includes(label(v)), `the proposal names ${label(v)}`);
  assert.doesNotMatch(text, /\.\.\. and \d+ more/);
});

test('untag prints every sibling of the group it leaves, never "... and N more"', async () => {
  resetSeq(800);
  const members = groupSlice({ taggedQty: [11, 11, 11, 11, 11, 11, 11], untagged: 0 });
  const t = traps({ live: false });
  const { text } = await capture(() =>
    cli.cmdUntag(
      { command: 'untag', variant: [members[0].id], dryRun: true },
      { load: async () => storeOf(members, t.client), refuse, writeJson: t.writeJson, runBatches: t.runBatches, sleep: async () => {} }
    )
  );
  const siblings = members.slice(1);
  assert.equal(siblings.length, 6);
  for (const s of siblings) assert.ok(text.includes(label(s)), `the untag gate names sibling ${label(s)}`);
  assert.doesNotMatch(text, /\.\.\. and \d+ more/);
});

// --- the backstop, wired into each command -----------------------------------
//
// The traps above fail any call on a dry run whether or not the backstop is there, so on their own
// they cannot tell a command that lost `dryRunDeps` from one that kept it. These make a stage FORGET
// its own check and require the backstop to catch it. That is the property the lock exemption in
// isWriteRun rests on.

/**
 * `dryRun` is true on its first read only. `dryRunDeps` is the first code in each command to read
 * the flag, so the backstop sees a dry run and the stage's own check does not. The source scan above
 * pins that first line independently, since this relies on read order.
 */
function forgetfulOpts(opts) {
  let reads = 0;
  return {
    ...opts,
    get dryRun() {
      return reads++ === 0;
    },
  };
}

for (const key of Object.keys(CASES)) {
  test(`backstop: ${key} with its own --dry-run check skipped aborts instead of writing`, async () => {
    const run = await runCase(key, { dryRun: false, opts: forgetfulOpts });
    assert.match(run.error?.message ?? '', /^DRY RUN: refused/, `${key} must be stopped by the backstop, got: ${run.error?.message}`);
    assert.deepEqual(run.t.writes.map((w) => w.path), [], 'no file write reached the writer');
    assert.equal(run.t.engine.length, 0, 'the apply engine was not reached');
    assert.deepEqual(run.t.gqlCalls.map((c) => opName(c.query)), [], 'no document reached the Admin client');
  });
}

test('the dry-run deps refuse a file write and the engine, and wrap the store client; a live run keeps its deps', async () => {
  const calls = [];
  const inner = {
    gql: async (query) => {
      calls.push(query);
      return { ok: true };
    },
  };
  const real = {
    load: async () => ({ client: inner, groups: new Map() }),
    writeJson: async () => assert.fail('the real writer must not be reached on a dry run'),
    runBatches: async () => assert.fail('the real engine must not be reached on a dry run'),
  };
  const dry = cli.dryRunDeps({ dryRun: true }, real);
  await assert.rejects(() => dry.writeJson('/work/receipt-seed-x.json', {}), /^Error: DRY RUN: refused to write \/work\/receipt-seed-x\.json/);
  await assert.rejects(() => dry.runBatches({}), /^Error: DRY RUN: refused to run the apply engine/);
  const store = await dry.load({ requireWrite: false });
  await assert.rejects(() => store.client.gql(mutations.M_METAFIELDS_SET, {}), /DRY RUN: refused to send mutation BlankInventoryTag/);
  assert.deepEqual(await store.client.gql('query Shop { shop { id } }', {}), { ok: true }, 'a read still goes through');
  assert.deepEqual(calls, ['query Shop { shop { id } }'], 'and only the read reached the client');

  assert.equal(cli.dryRunDeps({}, real), real, 'without --dry-run the deps are untouched');
});

// --- the branches the cases above do not reach -------------------------------

test('backfill tag on a store that never goes quiet: a dry run reports it, a live run refuses', async () => {
  // Every read moves one member's quantity, so the quiesce never settles.
  const moving = (c, t) => {
    let n = 0;
    return async () => {
      c.variants[0].quantity = 11 + (n++ % 2);
      return storeOf(c.variants, t.client);
    };
  };
  const dry = await runCase('backfill:tag', { dryRun: true, load: moving });
  await assertCleanDryRun('backfill:tag (never quiet)', dry);
  assert.match(dry.text, /A real run would refuse here\./);

  const live = await runCase('backfill:tag', { dryRun: false, load: moving });
  assert.ok(live.error instanceof Refused, `expected a refusal, got: ${live.error?.message}`);
  assert.match(live.error.message, /Groups still moving after 20 reads/);
  assert.deepEqual(live.t.events, [], 'and nothing was sent or written');
});

test('backfill seed --dry-run with nothing to seed still ends with the dry-run line', async () => {
  resetSeq(900);
  // Every member already agrees, so planSeed has no write to plan.
  const members = groupSlice({ taggedQty: [11, 11, 11, 11, 11], untagged: 0 });
  const plan = await writeInput('backfill-plan-dry-noseed.json', {
    version: 1,
    planId: 'plan-dry-noseed',
    tags: members.slice(3).map((v) => tagOf(v, v.blankId)),
  });
  const t = traps({ live: false });
  const out = await capture(() => cli.cmdBackfill({ command: 'backfill', stage: 'seed', plan, dryRun: true }, depsFor(members, t)));
  assert.match(out.text, /nothing to seed/);
  await assertCleanDryRun('backfill:seed (nothing to seed)', { ...out, t, exitCodeChanged: false });
});

test('backfill tag and seed refuse a missing --plan before they read the store', async () => {
  for (const stage of ['tag', 'seed']) {
    for (const dryRun of [false, true]) {
      const t = traps({ live: !dryRun });
      const deps = { ...depsFor([], t), load: async () => assert.fail('the store must not be read without a proposal') };
      const opts = { command: 'backfill', stage, ...(dryRun ? { dryRun } : {}) };
      const { error } = await capture(() => cli.cmdBackfill(opts, deps));
      assert.ok(error instanceof Refused, `${stage}${dryRun ? ' --dry-run' : ''}: expected a refusal, got: ${error?.message}`);
      assert.match(error.message, new RegExp(`--stage ${stage} needs --plan`));
    }
  }
});
