// The publish path's two refusal surfaces: the stored-plan stamp, and phase 3's post-barrier
// re-evaluation. Both are driven by fakes, so every branch runs with no network and no store.
//
// This is the suite that covers the first-publish reorder bug. A live dry run does not: the
// gallery is already converged, so it exercises almost none of this.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAN_MAX_AGE_MS, approvalProblem, approvalToken, liveStateHash, parseArgs, planStampProblem,
  reconcileLiveState, reorderPhase, sameMultiset,
} from '../publish.mjs';

const gid = (n) => `gid://shopify/MediaImage/${n}`;
const media = (n, over = {}) => ({ id: gid(n), alt: `alt ${n}`, filename: `f${n}.jpg`, ...over });

const NOW = Date.parse('2026-08-13T12:00:00.000Z');
const PLAN = { creates: [], deletes: [], reorderVerdict: 'not-required' };
const stamp = (over = {}) => ({
  version: 1,
  stampedAt: new Date(NOW - 60_000).toISOString(),
  shop: 'sapphire-shadow-studio.myshopify.com',
  handle: 'huddle-crewneck',
  liveStateHash: 'abc',
  reorderVerdict: 'not-required',
  plan: PLAN,
  ...over,
});
const check = (stored, over = {}) => planStampProblem({
  stored,
  shop: 'sapphire-shadow-studio.myshopify.com',
  handle: 'huddle-crewneck',
  liveHash: 'abc',
  plan: PLAN,
  nowMs: NOW,
  ...over,
});

// ---------------------------------------------------------------------------
// The stored plan
// ---------------------------------------------------------------------------

test('a fresh, matching stamp is accepted', () => {
  assert.equal(check(stamp()), null);
});

test('the stamp refuses a foreign shop, a foreign product, and a foreign version', () => {
  assert.match(check(stamp({ shop: 'other.myshopify.com' })), /computed against other\.myshopify\.com/);
  assert.match(check(stamp({ handle: 'other-product' })), /computed for product "other-product"/);
  assert.match(check(stamp({ version: 2 })), /version 2 is not 1/);
  assert.match(check(null), /not an object/);
});

test('the stamp refuses an expired plan even against byte-identical live state', () => {
  const old = stamp({ stampedAt: new Date(NOW - PLAN_MAX_AGE_MS - 1000).toISOString() });
  assert.match(check(old), /old \(limit 24h\); re-run --dry-run/);
  const justInside = stamp({ stampedAt: new Date(NOW - PLAN_MAX_AGE_MS + 60_000).toISOString() });
  assert.equal(check(justInside), null);
});

test('the stamp refuses a missing or future timestamp rather than trusting it', () => {
  assert.match(check(stamp({ stampedAt: undefined })), /no usable stampedAt/);
  assert.match(check(stamp({ stampedAt: 'not a date' })), /no usable stampedAt/);
  assert.match(check(stamp({ stampedAt: new Date(NOW + 60_000).toISOString() })), /stamped in the future/);
});

test('the stamp refuses drifted live state, a changed plan, and a changed reorder verdict', () => {
  assert.match(check(stamp(), { liveHash: 'zzz' }), /live media state changed/);
  assert.match(check(stamp({ plan: { creates: [1] } })), /computed plan changed/);
  // The verdict is stamped separately: approving "undetermined" is approving a different thing
  // from approving "not required", even when the rest of the plan is identical.
  assert.match(check(stamp({ reorderVerdict: 'undetermined' })), /approved reorder verdict "undetermined"/);
});

test('liveStateHash covers id, alt, and filename, and is order-sensitive', () => {
  const a = [media(1), media(2)];
  assert.equal(liveStateHash(a), liveStateHash([media(1), media(2)]));
  assert.notEqual(liveStateHash(a), liveStateHash([media(2), media(1)]));
  assert.notEqual(liveStateHash(a), liveStateHash([media(1, { alt: 'edited' }), media(2)]));
  assert.notEqual(liveStateHash(a), liveStateHash([media(1, { filename: 'edited.jpg' }), media(2)]));
});

// ---------------------------------------------------------------------------
// reconcileLiveState: tolerate our own writes, catch everyone else's.
// ---------------------------------------------------------------------------

test('reconcile accepts exactly our own creates and deletes', () => {
  const before = [media(1), media(2), media(3)];
  const after = [media(1), media(9), media(3)];
  assert.deepEqual(reconcileLiveState({
    before, after, createdIds: [gid(9)], deletedIds: new Set([gid(2)]),
  }), { ok: true });
});

test('reconcile catches a media that vanished while the run was in flight', () => {
  const r = reconcileLiveState({
    before: [media(1), media(2)], after: [media(1)], createdIds: [], deletedIds: new Set(),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, new RegExp(`missing from the gallery.*${gid(2)}`));
});

test('reconcile catches a media that appeared from somewhere else', () => {
  const r = reconcileLiveState({
    before: [media(1)], after: [media(1), media(7)], createdIds: [], deletedIds: new Set(),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, new RegExp(`unexpected media appeared.*${gid(7)}`));
});

test('reconcile catches a concurrent Admin edit to an untouched media', () => {
  const r = reconcileLiveState({
    before: [media(1), media(2)],
    after: [media(1), media(2, { alt: 'someone renamed this in Admin' })],
    createdIds: [],
    deletedIds: new Set(),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /was edited elsewhere while this run was in flight/);
});

test('reconcile does not trip on a created media whose filename the CDN rewrote', () => {
  // Creates are ours; their live filename is decided by the CDN and is not drift.
  assert.deepEqual(reconcileLiveState({
    before: [media(1)],
    after: [media(1), { id: gid(9), alt: 'chart', filename: 'chart_x1y2.jpg' }],
    createdIds: [gid(9)],
    deletedIds: new Set(),
  }), { ok: true });
});

// ---------------------------------------------------------------------------
// reorderPhase: the only place a live gallery move is issued.
// ---------------------------------------------------------------------------

function harness({ after, readThrows = false } = {}) {
  const calls = { reorder: [], snapshots: [], logs: [] };
  return {
    calls,
    run: (over = {}) => reorderPhase({
      readLiveOrder: async () => {
        if (readThrows) throw new Error('502 from Admin');
        return after;
      },
      reorder: async (ids) => { calls.reorder.push(ids); },
      writeSnapshot: async (m, label) => { calls.snapshots.push({ label, ids: m.map((x) => x.id) }); return `/snap/${label}.json`; },
      before: [media(1), media(2)],
      createdIds: [gid(9)],
      deletedIds: new Set(),
      targetIds: [gid(1), gid(2), gid(9)],
      log: (msg) => calls.logs.push(msg),
      ...over,
    }),
  };
}

test('creates that landed at the end need no move and issue no mutation', async () => {
  const h = harness({ after: [media(1), media(2), media(9)] });
  const r = await h.run();
  assert.equal(r.status, 'converged');
  assert.deepEqual(h.calls.reorder, []);
  assert.deepEqual(h.calls.snapshots, [], 'nothing moved, so there is nothing to roll back');
});

test('creates that landed MID-gallery are reordered, after a pre-reorder snapshot', async () => {
  // The observed bug: the dry run said "reorder not required" and this is where that was wrong.
  const h = harness({ after: [media(1), media(9), media(2)] });
  const r = await h.run();
  assert.equal(r.status, 'reordered');
  assert.equal(r.moves, 2);
  assert.deepEqual(h.calls.reorder, [[gid(1), gid(2), gid(9)]]);
  assert.deepEqual(h.calls.snapshots, [{ label: 'pre-reorder', ids: [gid(1), gid(9), gid(2)] }]);
  assert.ok(h.calls.snapshots.length, 'the snapshot must precede the mutation, not follow it');
});

test('a failed re-read aborts with NO reorder attempted', async () => {
  const h = harness({ after: [], readThrows: true });
  const r = await h.run();
  assert.equal(r.status, 'aborted');
  assert.match(r.reason, /could not re-read the gallery.*no reorder was attempted/s);
  assert.deepEqual(h.calls.reorder, []);
});

test('live state that does not reconcile aborts with NO reorder attempted', async () => {
  const h = harness({ after: [media(1), media(2), media(9), media(77)] });
  const r = await h.run();
  assert.equal(r.status, 'aborted');
  assert.match(r.reason, /unexpected media appeared/);
  assert.deepEqual(h.calls.reorder, []);
  assert.deepEqual(h.calls.snapshots, []);
});

test('an approved target that is no longer achievable stops with the named divergence line', async () => {
  const h = harness({ after: [media(1), media(2), media(9)] });
  const r = await h.run({ targetIds: [gid(1), gid(2), gid(9), gid(404)] });
  assert.equal(r.status, 'aborted');
  assert.equal(
    r.reason,
    'reorder needed but the resulting order differs from the approved plan; re-run --dry-run',
  );
  assert.deepEqual(h.calls.reorder, []);
});

test('a target with a DUPLICATE is not achievable, even at the right length', async () => {
  // The membership check this replaced (`every(includes)` plus a length compare) could not see a
  // duplicate: target [1, 1, 9] against live [1, 2, 9] scored achievable, and the reorder issued
  // would have dropped media 2 out of the approved order entirely.
  const h = harness({ after: [media(1), media(2), media(9)] });
  const r = await h.run({ targetIds: [gid(1), gid(1), gid(9)] });
  assert.equal(r.status, 'aborted');
  assert.match(r.reason, /differs from the approved plan/);
  assert.deepEqual(h.calls.reorder, [], 'no live mutation may be issued for an unachievable target');
  assert.deepEqual(h.calls.snapshots, []);
});

test('sameMultiset counts, and is order-insensitive', () => {
  assert.equal(sameMultiset(['a', 'b'], ['b', 'a']), true);
  assert.equal(sameMultiset(['a', 'a', 'c'], ['a', 'b', 'c']), false);
  assert.equal(sameMultiset(['a', 'b', 'c'], ['a', 'a', 'c']), false);
  assert.equal(sameMultiset(['a'], ['a', 'a']), false);
  assert.equal(sameMultiset([], []), true);
});

test('a reorder that throws leaves the pre-reorder snapshot behind', async () => {
  const calls = { snapshots: [] };
  await assert.rejects(() => reorderPhase({
    readLiveOrder: async () => [media(1), media(9), media(2)],
    reorder: async () => { throw new Error('productReorderMedia userError'); },
    writeSnapshot: async (m, label) => { calls.snapshots.push(label); return '/snap.json'; },
    before: [media(1), media(2)],
    createdIds: [gid(9)],
    deletedIds: new Set(),
    targetIds: [gid(1), gid(2), gid(9)],
    log: () => {},
  }), /productReorderMedia userError/);
  assert.deepEqual(calls.snapshots, ['pre-reorder'], 'the rollback record exists before the mutation is issued');
});

// ---------------------------------------------------------------------------
// The argv rail. The file header calls it load-bearing ("argv never carries a secret"), and it was
// the one guard here with no test at all: `if (false)` on the secret check survived the suite.
// ---------------------------------------------------------------------------

test('secret-shaped options are refused BY NAME, and the value is never echoed', () => {
  for (const flag of ['token', 'secret', 'client-secret', 'password', 'api-key']) {
    // Deliberately not token-shaped: a realistic `shpat_`-prefixed hex string would trip the
    // repo's Gitleaks scan, and the assertion only needs a value to look for in the message.
    const value = 'SYNTHETIC-NOT-A-REAL-CREDENTIAL';
    for (const argv of [[`--${flag}=${value}`], [`--${flag}`, value]]) {
      assert.throws(
        () => parseArgs(argv),
        (e) => {
          assert.match(e.message, /refused: secrets come from the env file/);
          assert.ok(e.message.includes(flag), 'the refusal must name the option');
          assert.ok(!e.message.includes(value), 'the refusal must not echo the supplied secret');
          return true;
        },
        `--${flag} must be refused`,
      );
    }
  }
  // Case-insensitive, so --TOKEN is not a way around it.
  assert.throws(() => parseArgs(['--TOKEN=x']), /refused: secrets come from the env file/);
});

test('an unknown option is refused rather than ignored', () => {
  assert.throws(() => parseArgs(['--nope']), /Unknown option --nope/);
  assert.throws(() => parseArgs(['--dry-run', '--publish-everything']), /Unknown option --publish-everything/);
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
  assert.equal(parseArgs([]).dryRun, false);
});

test('--approved is parsed in both spellings and defaults to null', () => {
  assert.equal(parseArgs([]).approved, null);
  assert.equal(parseArgs(['--approved', 'abc123def456']).approved, 'abc123def456');
  assert.equal(parseArgs(['--approved=abc123def456']).approved, 'abc123def456');
});

// ---------------------------------------------------------------------------
// The approval token. Freshness is not consent: before this, the only thing between a dry run and
// the irreversible live write was a file the SAME session had just written.
// ---------------------------------------------------------------------------

const TOKEN_INPUT = {
  shop: 'sapphire-shadow-studio.myshopify.com',
  handle: 'huddle-crewneck',
  liveStateHash: 'abc',
  plan: PLAN,
};

test('approvalToken is stable, short, and moves when any input moves', () => {
  const t = approvalToken(TOKEN_INPUT);
  assert.match(t, /^[0-9a-f]{12}$/);
  assert.equal(t, approvalToken({ ...TOKEN_INPUT }), 'same inputs must give the same token');

  for (const [key, value] of Object.entries({
    shop: 'other.myshopify.com',
    handle: 'other-product',
    liveStateHash: 'def',
    plan: { ...PLAN, reorderVerdict: 'required' },
  })) {
    assert.notEqual(approvalToken({ ...TOKEN_INPUT, [key]: value }), t, `${key} must change the token`);
  }
});

test('a live run with no --approved is refused, and a wrong token is refused by comparison', () => {
  const token = approvalToken(TOKEN_INPUT);
  const stored = stamp({ approvalToken: token });

  assert.match(approvalProblem({ supplied: null, stored }), /requires --approved/);
  assert.match(approvalProblem({ supplied: '', stored }), /requires --approved/);
  assert.match(approvalProblem({ supplied: 'deadbeefcafe', stored }), /does not match the stored plan's token/);
  assert.equal(approvalProblem({ supplied: token, stored }), null);
  // Typed by a human, so surrounding space and case are tolerated; nothing else is.
  assert.equal(approvalProblem({ supplied: `  ${token.toUpperCase()}  `, stored }), null);
});

test('a stored plan with no token is refused rather than treated as approved', () => {
  // Fail closed on the shape that predates this rail: a plan left on disk by an older build must
  // not execute just because it is fresh.
  for (const stored of [stamp(), stamp({ approvalToken: '' }), stamp({ approvalToken: 42 })]) {
    assert.match(approvalProblem({ supplied: 'anything', stored }), /carries no approval token/);
  }
});
