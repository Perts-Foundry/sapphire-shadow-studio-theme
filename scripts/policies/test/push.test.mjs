// scripts/policies/push.mjs: the only tool here that can change what a customer reads.
//
// The gates are the product, so each one gets a named case. Refusals are proved to have written
// nothing by comparing a byte snapshot of the tree before and after.
//
// WHAT A FAKE CLIENT CANNOT PROVE, and what these tests therefore do NOT claim: the mutation's
// actual input shape against a live schema, token minting and scopes, Shopify's real refusal for
// the auto-managed policy, Shopify's actual normalisation, and idempotency. See
// marketing/policies/README.md, "What the tests do not prove".

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import {
  PUSH_MUTATION,
  SUCCESS_MARKER,
  assertInteractive,
  assertReviewedTree,
  loadRestore,
  parseArgs,
  resolveType,
  run,
  writeBackup,
} from '../push.mjs';
import { check } from '../check.mjs';
import { FILE_MODE } from '../lib/backups.mjs';
import { PolicyError, bodyFromFileText, canonicalise, fileTextFor, formatManifest } from '../lib/policies.mjs';
import {
  BODIES,
  NOW,
  assertTreeUnchanged,
  cleanup,
  liveFrom,
  makeClient,
  makeRoot,
  policiesDir,
  readManifestRaw,
  readPolicy,
  snapshotTree,
  writeRaw,
} from './helpers.mjs';

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The repo body after a wording edit: what a push exists to send. */
const EDITED = `${BODIES.SHIPPING_POLICY}\n<p>Most orders ship within 3–5 business days.</p>`;

function backupDir() {
  return mkdtempSync(join(tmpdir(), 'policies-backup-'));
}

/** A root whose shipping policy has been edited and the manifest updated to match, as a commit would. */
function editedRoot(body = EDITED) {
  const root = makeRoot();
  writeRaw(root, 'shipping_policy.html', fileTextFor(body));
  const file = join(policiesDir(root), 'manifest.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const entry = manifest.policies.shipping_policy;
  entry.sha256 = sha(body);
  entry.length = body.length;
  entry.headings = headingsOf(body);
  writeFileSync(file, formatManifest(manifest), 'utf8');
  return root;
}

function headingsOf(body) {
  // Deliberately not the library's extractHeadings: a fixture builder that shares the code under
  // test cannot catch the code under test being wrong.
  const out = [];
  const re = /<(h[23])[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    const level = Number(m[1][1]);
    const text = m[2].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').trim();
    if (text === '') continue;
    out.push({
      level,
      text,
      id: level === 2 ? (text.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50).replace(/^-+|-+$/g, '') || 'section') : null,
    });
  }
  return out;
}

const BASE = { now: NOW, domain: 'example.myshopify.com', log: () => {}, sleep: async () => {} };

function options(overrides = {}) {
  return { ...parseArgs([]), type: 'SHIPPING_POLICY', ...overrides };
}

// ---------------------------------------------------------------------------------------------
// Step 1: argument parsing and the interactive gate
// ---------------------------------------------------------------------------------------------

test('parseArgs accepts both --flag value and --flag=value', () => {
  const a = parseArgs(['--type', 'shipping_policy', '--confirm=shipping_policy', '--expect-live-sha', 'abc']);
  assert.equal(a.type, 'shipping_policy');
  assert.equal(a.confirm, 'shipping_policy');
  assert.equal(a.expectLiveSha, 'abc');
});

test('parseArgs refuses an unknown flag and a flag with no value', () => {
  assert.throws(() => parseArgs(['--nope']), PolicyError);
  assert.throws(() => parseArgs(['--type']), /expects a value/);
});

test('resolveType refuses a missing type, an unknown type, and the auto-managed privacy policy', () => {
  assert.throws(() => resolveType(null), /--type: required/);
  assert.throws(() => resolveType('terms_of_sale'), /not a tracked policy/);
  assert.throws(() => resolveType('privacy_policy'), /not writable/);
  assert.equal(resolveType('shipping_policy'), 'SHIPPING_POLICY');
  assert.equal(resolveType('SHIPPING_POLICY'), 'SHIPPING_POLICY');
});

test('the interactive gate refuses CI and a non-TTY stdin', () => {
  assert.throws(() => assertInteractive({ env: { CI: 'true' }, isTTY: true }), /with CI set/);
  assert.throws(() => assertInteractive({ env: {}, isTTY: false }), /without a TTY/);
  assert.doesNotThrow(() => assertInteractive({ env: {}, isTTY: true }));
});

test('no workflow wires policies:push', () => {
  // A legal-policy write is an operator action. If a workflow ever calls it, the CI gate would be
  // holding write_legal_policies credentials, which is the blast radius this subsystem avoids.
  const dir = new URL('../../../.github/workflows/', import.meta.url);
  for (const name of readdirSync(dir)) {
    // Whole-line `#` comments are stripped first: validate.yml carries a comment saying not to add
    // `policies:pull --check` there, and a bare substring match would read that warning as the
    // violation it warns against.
    const text = readFileSync(new URL(name, dir), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    assert.equal(text.includes('policies:push'), false, `${name} invokes policies:push`);
    assert.equal(text.includes('policies:pull'), false, `${name} invokes policies:pull, which needs secrets`);
  }
});

// ---------------------------------------------------------------------------------------------
// Step 2: repo gates
// ---------------------------------------------------------------------------------------------

test('a dirty working tree under marketing/policies/ is a refusal', () => {
  const fakeGit = (root, args) => (args[0] === 'status' ? ' M marketing/policies/shipping_policy.html' : '');
  assert.throws(() => assertReviewedTree('/x', { run: fakeGit }), /uncommitted changes/);
});

test('HEAD not an ancestor of origin/main is a refusal, and --allow-unreviewed is the escape hatch', () => {
  const fakeGit = (root, args) => {
    if (args[0] === 'status') return '';
    if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? 'aaa' : 'bbb';
    throw new Error('not an ancestor');
  };
  assert.throws(() => assertReviewedTree('/x', { run: fakeGit }), /not an ancestor of origin\/main/);
  assert.deepEqual(assertReviewedTree('/x', { run: fakeGit, allowUnreviewed: true }), { unreviewed: true });
});

test('--allow-unreviewed still refuses a dirty tree', () => {
  const fakeGit = (root, args) => (args[0] === 'status' ? '?? marketing/policies/x.html' : '');
  assert.throws(() => assertReviewedTree('/x', { run: fakeGit, allowUnreviewed: true }), /uncommitted changes/);
});

test('an unclean policies:check refuses the push before anything is sent', async () => {
  const root = makeRoot();
  const dir = backupDir();
  try {
    writeRaw(root, 'shipping_policy.html', fileTextFor(EDITED)); // manifest deliberately NOT updated
    const client = makeClient({ live: liveFrom() });
    await assert.rejects(
      () => run({ ...BASE, client, root, options: options(), backupDir: dir }),
      /policies:check: is not clean/,
    );
    assert.deepEqual(client.calls, [], 'the client was touched before the repo gate passed');
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------------------------
// Step 3: already in sync
// ---------------------------------------------------------------------------------------------

test('a live body identical to the repo body exits without mutating', async () => {
  const root = makeRoot();
  const dir = backupDir();
  try {
    const client = makeClient({ live: liveFrom() });
    const result = await run({ ...BASE, client, root, options: options(), backupDir: dir });
    assert.equal(result.mutated, false);
    assert.equal(result.reason, 'in-sync');
    assert.deepEqual(client.calls.map((c) => c.kind), ['read']);
    assert.equal(readdirSync(dir).length, 0, 'wrote a backup for a no-op');
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------------------------
// Step 4: freshness
// ---------------------------------------------------------------------------------------------

test('a live body the manifest has not seen is a refusal naming policies:pull', async () => {
  const root = editedRoot();
  const dir = backupDir();
  try {
    const live = liveFrom({ ...BODIES, SHIPPING_POLICY: `${BODIES.SHIPPING_POLICY}\n<p>edited in Admin</p>` });
    const client = makeClient({ live });
    const before = snapshotTree(policiesDir(root));
    await assert.rejects(
      () => run({ ...BASE, client, root, options: options({ confirm: 'shipping_policy' }), backupDir: dir }),
      /has not seen.*policies:pull/s,
    );
    assert.equal(client.calls.filter((c) => c.kind === 'mutate').length, 0);
    assertTreeUnchanged(assert, before, snapshotTree(policiesDir(root)), 'freshness refusal wrote something');
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('--force-overwrite-live discards the Admin edit on purpose', async () => {
  const root = editedRoot();
  const dir = backupDir();
  try {
    const drifted = `${BODIES.SHIPPING_POLICY}\n<p>edited in Admin</p>`;
    const client = makeClient({ live: liveFrom({ ...BODIES, SHIPPING_POLICY: drifted }) });
    const result = await run({
      ...BASE,
      client,
      root,
      backupDir: dir,
      options: options({ confirm: 'shipping_policy', expectLiveSha: sha(drifted), forceOverwriteLive: true }),
    });
    assert.equal(result.mutated, true);
    assert.equal(client.state.get('SHIPPING_POLICY').body, EDITED);
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------------------------
// Step 5: the dry run
// ---------------------------------------------------------------------------------------------

test('without --confirm the run reads only, mutates nothing, and prints the exact next command', async () => {
  const root = editedRoot();
  const dir = backupDir();
  const lines = [];
  try {
    const client = makeClient({ live: liveFrom() });
    const before = snapshotTree(policiesDir(root));
    const result = await run({ ...BASE, log: (s) => lines.push(s), client, root, options: options(), backupDir: dir });
    assert.equal(result.mutated, false);
    assert.equal(result.reason, 'dry-run');
    assert.deepEqual(client.calls.map((c) => c.kind), ['read']);
    assert.equal(readdirSync(dir).length, 0, 'a dry run wrote a backup');
    assertTreeUnchanged(assert, before, snapshotTree(policiesDir(root)), 'a dry run wrote something');

    const text = lines.join('\n');
    assert.ok(text.includes('NO CHANGES WERE MADE'));
    assert.ok(text.includes(`--expect-live-sha=${result.liveSha}`));
    assert.ok(text.includes('--confirm=shipping_policy'));
    assert.equal(text.includes(SUCCESS_MARKER), false, 'the success marker leaked into a dry run');
    assert.ok(result.diff.includes('3–5 business days'));
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('the dry run calls out a heading change as an anchor break', async () => {
  const body = BODIES.SHIPPING_POLICY.replace('<h2>Questions?</h2>', '<h2>Questions and Answers</h2>');
  const root = editedRoot(body);
  const dir = backupDir();
  const lines = [];
  try {
    const client = makeClient({ live: liveFrom() });
    const result = await run({ ...BASE, log: (s) => lines.push(s), client, root, options: options(), backupDir: dir });
    assert.ok(result.headingDiff.length > 0);
    assert.ok(lines.join('\n').includes('HEADINGS CHANGE'));
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('--confirm must equal the type, and --expect-live-sha is required and checked', async () => {
  const root = editedRoot();
  const dir = backupDir();
  try {
    const client = makeClient({ live: liveFrom() });
    const base = { ...BASE, client, root, backupDir: dir };
    await assert.rejects(() => run({ ...base, options: options({ confirm: 'true' }) }), /must be exactly "shipping_policy"/);
    await assert.rejects(() => run({ ...base, options: options({ confirm: 'shipping_policy' }) }), /--expect-live-sha: required/);
    await assert.rejects(
      () => run({ ...base, options: options({ confirm: 'shipping_policy', expectLiveSha: 'stale' }) }),
      /changed since the dry run/,
    );
    assert.equal(client.calls.filter((c) => c.kind === 'mutate').length, 0);
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------------------------
// Step 6: the backup
// ---------------------------------------------------------------------------------------------

test('the backup holds the pre-push ADMIN body, not the repo body', async () => {
  const root = editedRoot();
  const dir = backupDir();
  try {
    const client = makeClient({ live: liveFrom() });
    const result = await run({
      ...BASE,
      client,
      root,
      backupDir: dir,
      options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
    });
    const record = JSON.parse(readFileSync(result.backupFile, 'utf8'));
    assert.equal(record.body, BODIES.SHIPPING_POLICY, 'the backup captured the repo body instead of Admin');
    assert.notEqual(record.body, EDITED);
    assert.equal(record.type, 'SHIPPING_POLICY');
    assert.equal(record.storeDomain, 'example.myshopify.com');
    assert.equal(record.sha256, sha(BODIES.SHIPPING_POLICY));
    assert.ok(record.id);
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('the backup file is 0600 and the directory 0700', async () => {
  const dir = backupDir();
  try {
    const { file } = writeBackup({
      dir: join(dir, 'nested'),
      type: 'SHIPPING_POLICY',
      live: { id: 'gid://x', title: 'Shipping', body: '<p>a</p>' },
      now: NOW,
      domain: 'example.myshopify.com',
    });
    assert.equal(statSync(file).mode & 0o777, FILE_MODE);
    assert.equal(statSync(join(dir, 'nested')).mode & 0o777, 0o700);
  } finally {
    cleanup(dir);
  }
});

test('writeBackup refuses to overwrite an existing backup', () => {
  const dir = backupDir();
  try {
    const args = {
      dir,
      type: 'SHIPPING_POLICY',
      live: { id: 'gid://x', title: 'Shipping', body: '<p>a</p>' },
      now: NOW,
      domain: 'd',
    };
    writeBackup(args);
    assert.throws(() => writeBackup(args), /already exists/);
  } finally {
    cleanup(dir);
  }
});

test('a failed backup aborts before any mutation', async () => {
  const root = editedRoot();
  try {
    const client = makeClient({ live: liveFrom() });
    // A file where the backup directory must go: mkdirSync fails, so the backup cannot be written.
    const blocked = mkdtempSync(join(tmpdir(), 'policies-blocked-'));
    const dir = join(blocked, 'file');
    writeFileSync(dir, 'not a directory', 'utf8');
    await assert.rejects(() =>
      run({
        ...BASE,
        client,
        root,
        backupDir: dir,
        options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
      }),
    );
    assert.equal(client.calls.filter((c) => c.kind === 'mutate').length, 0, 'mutated without a backup');
    cleanup(blocked);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------------------------
// Step 7: the mutation, and the userErrors-on-200 trap
// ---------------------------------------------------------------------------------------------

test('exactly one mutation, of the right type, with the canonicalised repo bytes', async () => {
  const root = editedRoot();
  const dir = backupDir();
  try {
    const client = makeClient({ live: liveFrom() });
    await run({
      ...BASE,
      client,
      root,
      backupDir: dir,
      options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
    });
    const mutations = client.calls.filter((c) => c.kind === 'mutate');
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].document, PUSH_MUTATION);
    assert.deepEqual(mutations[0].variables, { shopPolicy: { type: 'SHIPPING_POLICY', body: EDITED } });
    assert.equal(mutations[0].variables.shopPolicy.body, canonicalise(mutations[0].variables.shopPolicy.body));
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('the recorded call order is read, then backup, then mutate', async () => {
  const root = editedRoot();
  const dir = backupDir();
  const order = [];
  try {
    const client = makeClient({
      live: liveFrom(),
      onMutate: () => {
        order.push(`backup-exists:${readdirSync(dir).length > 0}`);
        return undefined;
      },
    });
    const patched = {
      ...client,
      async gql(doc, vars) {
        order.push(/\bmutation\b/.test(doc) ? 'mutate' : 'read');
        return client.gql(doc, vars);
      },
    };
    await run({
      ...BASE,
      client: patched,
      root,
      backupDir: dir,
      options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
    });
    assert.deepEqual(order, ['read', 'mutate', 'backup-exists:true', 'read']);
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('userErrors on a 200 fails closed, printing field and message, writing nothing locally', async () => {
  const root = editedRoot();
  const dir = backupDir();
  try {
    const client = makeClient({
      live: liveFrom(),
      onMutate: () => ({
        shopPolicyUpdate: {
          shopPolicy: null,
          userErrors: [{ code: 'TOO_BIG', field: ['shopPolicy', 'body'], message: 'Body is too long' }],
        },
      }),
    });
    const before = snapshotTree(policiesDir(root));
    const lines = [];
    await assert.rejects(
      () =>
        run({
          ...BASE,
          log: (s) => lines.push(s),
          client,
          root,
          backupDir: dir,
          options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
        }),
      (err) => {
        assert.match(err.message, /shopPolicy\.body: Body is too long \[TOO_BIG\]/);
        assert.match(err.message, /NOTHING WAS WRITTEN LOCALLY/);
        return true;
      },
    );
    assertTreeUnchanged(assert, before, snapshotTree(policiesDir(root)), 'a userErrors failure wrote something');
    assert.equal(lines.join('\n').includes(SUCCESS_MARKER), false, 'the success marker leaked into a failure');
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('a null shopPolicy with no userErrors is still a failed write', async () => {
  const root = editedRoot();
  const dir = backupDir();
  try {
    const client = makeClient({ live: liveFrom(), onMutate: () => ({ shopPolicyUpdate: { shopPolicy: null, userErrors: [] } }) });
    await assert.rejects(
      () =>
        run({
          ...BASE,
          client,
          root,
          backupDir: dir,
          options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
        }),
      /no shopPolicy and no userErrors/,
    );
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('the failure taxonomy: a missing mutation field, and a client that throws', async () => {
  const cases = [
    { name: 'missing mutation field', onMutate: () => ({}) },
    { name: 'top-level errors with null data', onMutate: () => ({ shopPolicyUpdate: null }) },
  ];
  for (const { name, onMutate } of cases) {
    const root = editedRoot();
    const dir = backupDir();
    try {
      const client = makeClient({ live: liveFrom(), onMutate });
      await assert.rejects(
        () =>
          run({
            ...BASE,
            client,
            root,
            backupDir: dir,
            options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
          }),
        /failed write|no shopPolicy/,
        name,
      );
    } finally {
      cleanup(root);
      cleanup(dir);
    }
  }

  // A thrown network error, and a throttling / 5xx error, both surface rather than being swallowed.
  for (const message of ['fetch failed', 'GraphQL errors: [{"extensions":{"code":"THROTTLED"}}]', 'HTTP 503: {}']) {
    const root = editedRoot();
    const dir = backupDir();
    try {
      const client = makeClient({ live: liveFrom() });
      const throwing = {
        ...client,
        async gql(doc, vars) {
          if (/\bmutation\b/.test(doc)) throw new Error(message);
          return client.gql(doc, vars);
        },
      };
      await assert.rejects(
        () =>
          run({
            ...BASE,
            client: throwing,
            root,
            backupDir: dir,
            options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
          }),
        new RegExp(message.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
    } finally {
      cleanup(root);
      cleanup(dir);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Step 8: verification and write-back
// ---------------------------------------------------------------------------------------------

test('the happy path records the new remote token and leaves pulledAt alone', async () => {
  const root = editedRoot();
  const dir = backupDir();
  const lines = [];
  try {
    const client = makeClient({ live: liveFrom() });
    const before = JSON.parse(readManifestRaw(root)).policies.shipping_policy;
    const result = await run({
      ...BASE,
      log: (s) => lines.push(s),
      client,
      root,
      backupDir: dir,
      options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
    });
    assert.equal(result.mutated, true);
    assert.equal(result.normalised, false);
    const after = JSON.parse(readManifestRaw(root)).policies.shipping_policy;
    assert.equal(after.remote.sha256, sha(EDITED));
    assert.equal(after.pulledAt, before.pulledAt, 'pulledAt moved on a push');
    assert.equal(after.sha256, before.sha256, 'the repo body was rewritten on the clean path');
    assert.ok(lines.join('\n').includes(SUCCESS_MARKER));
    assert.ok(lines.join('\n').includes('--restore'));
    assert.deepEqual(checkClean(root), []);
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

function checkClean(root) {
  const { problems, mismatches } = check(root);
  return [...problems, ...mismatches];
}

test('the verify read retries before believing a mismatch', async () => {
  const root = editedRoot();
  const dir = backupDir();
  try {
    let readsAfterMutate = 0;
    const client = makeClient({ live: liveFrom() });
    const flaky = {
      ...client,
      async gql(doc, vars) {
        if (!/\bmutation\b/.test(doc) && client.calls.some((c) => c.kind === 'mutate')) {
          readsAfterMutate += 1;
          // The first read after the write returns the OLD body, as a stale replica would.
          if (readsAfterMutate === 1) {
            return { shop: { shopPolicies: [{ id: 'gid://1', type: 'SHIPPING_POLICY', title: 'Shipping', body: BODIES.SHIPPING_POLICY, url: 'u' }, ...stubOthers()] } };
          }
        }
        return client.gql(doc, vars);
      },
    };
    const result = await run({
      ...BASE,
      client: flaky,
      root,
      backupDir: dir,
      options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
    });
    assert.equal(result.mutated, true);
    assert.equal(result.normalised, false);
    assert.equal(readsAfterMutate, 2, 'expected exactly one retry');
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

function stubOthers() {
  return ['CONTACT_INFORMATION', 'PRIVACY_POLICY', 'REFUND_POLICY', 'TERMS_OF_SERVICE'].map((type, i) => ({
    id: `gid://${i + 2}`,
    type,
    title: type,
    body: BODIES[type],
    url: 'u',
  }));
}

test('a re-read that differs by entities and whitespace refuses without --accept-normalisation', async () => {
  const root = editedRoot();
  const dir = backupDir();
  try {
    const normalised = EDITED.replace('Production &amp; Delivery Times', 'Production &#38; Delivery Times');
    const client = makeClient({ live: liveFrom(), onMutate: (type, body, state) => {
      state.set(type, { ...state.get(type), body: normalised });
      return { shopPolicyUpdate: { shopPolicy: { id: 'gid://1', type, title: 'Shipping', body: normalised }, userErrors: [] } };
    } });
    const before = snapshotTree(policiesDir(root));
    await assert.rejects(
      () =>
        run({
          ...BASE,
          client,
          root,
          backupDir: dir,
          options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY) }),
        }),
      /renormalised.*--accept-normalisation/s,
    );
    assertTreeUnchanged(assert, before, snapshotTree(policiesDir(root)), 'a normalisation refusal wrote something');
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('--accept-normalisation takes the stored version into the repo and the manifest', async () => {
  const root = editedRoot();
  const dir = backupDir();
  try {
    const normalised = EDITED.replace('Production &amp; Delivery Times', 'Production &#38; Delivery Times');
    const client = makeClient({ live: liveFrom(), onMutate: (type, body, state) => {
      state.set(type, { ...state.get(type), body: normalised });
      return { shopPolicyUpdate: { shopPolicy: { id: 'gid://1', type, title: 'Shipping', body: normalised }, userErrors: [] } };
    } });
    const result = await run({
      ...BASE,
      client,
      root,
      backupDir: dir,
      options: options({ confirm: 'shipping_policy', expectLiveSha: sha(BODIES.SHIPPING_POLICY), acceptNormalisation: true }),
    });
    assert.equal(result.normalised, true);
    assert.equal(bodyFromFileText(readPolicy(root, 'SHIPPING_POLICY')), normalised);
    const entry = JSON.parse(readManifestRaw(root)).policies.shipping_policy;
    assert.equal(entry.sha256, sha(normalised));
    assert.equal(entry.remote.sha256, sha(normalised));
    assert.deepEqual(checkClean(root), []);
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('a stored body differing by more than entities and whitespace is never accepted', async () => {
  const root = editedRoot();
  const dir = backupDir();
  try {
    const mangled = `${EDITED}\n<p>Shopify added a sentence.</p>`;
    const client = makeClient({ live: liveFrom(), onMutate: (type, body, state) => {
      state.set(type, { ...state.get(type), body: mangled });
      return { shopPolicyUpdate: { shopPolicy: { id: 'gid://1', type, title: 'Shipping', body: mangled }, userErrors: [] } };
    } });
    const before = snapshotTree(policiesDir(root));
    await assert.rejects(
      () =>
        run({
          ...BASE,
          client,
          root,
          backupDir: dir,
          options: options({
            confirm: 'shipping_policy',
            expectLiveSha: sha(BODIES.SHIPPING_POLICY),
            acceptNormalisation: true,
          }),
        }),
      /more than entity and whitespace spelling/,
    );
    assertTreeUnchanged(assert, before, snapshotTree(policiesDir(root)), 'a content mismatch wrote something');
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('a re-read whose HEADINGS differ is an anchor break: non-zero, file untouched, no flag helps', async () => {
  const root = editedRoot();
  const dir = backupDir();
  try {
    const reheaded = EDITED.replace('<h2>Questions?</h2>', '<h2>Questions and Answers</h2>');
    const client = makeClient({ live: liveFrom(), onMutate: (type, body, state) => {
      state.set(type, { ...state.get(type), body: reheaded });
      return { shopPolicyUpdate: { shopPolicy: { id: 'gid://1', type, title: 'Shipping', body: reheaded }, userErrors: [] } };
    } });
    const before = snapshotTree(policiesDir(root));
    await assert.rejects(
      () =>
        run({
          ...BASE,
          client,
          root,
          backupDir: dir,
          options: options({
            confirm: 'shipping_policy',
            expectLiveSha: sha(BODIES.SHIPPING_POLICY),
            acceptNormalisation: true,
          }),
        }),
      /HEADINGS differ.*anchor break/s,
    );
    assertTreeUnchanged(assert, before, snapshotTree(policiesDir(root)), 'an anchor break wrote something');
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------------------------

test('loadRestore refuses a missing file, a bodiless record, and a tampered body', () => {
  const dir = backupDir();
  try {
    assert.throws(() => loadRestore(join(dir, 'nope.json')), /no such backup file/);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ type: 'SHIPPING_POLICY', body: '' }), 'utf8');
    assert.throws(() => loadRestore(bad), /holds no body/);
    const tampered = join(dir, 'tampered.json');
    writeFileSync(tampered, JSON.stringify({ type: 'SHIPPING_POLICY', body: '<p>a</p>', sha256: 'f'.repeat(64) }), 'utf8');
    assert.throws(() => loadRestore(tampered), /does not match its recorded sha256/);
  } finally {
    cleanup(dir);
  }
});

test('a restore pushes the backup body and skips the freshness gate', async () => {
  const root = editedRoot();
  const dir = backupDir();
  try {
    // Live has drifted away from both the repo and the backup, which is exactly when a restore runs.
    const drifted = `${BODIES.SHIPPING_POLICY}\n<p>a bad edit</p>`;
    const client = makeClient({ live: liveFrom({ ...BODIES, SHIPPING_POLICY: drifted }) });
    const record = { type: 'SHIPPING_POLICY', body: BODIES.SHIPPING_POLICY, sha256: sha(BODIES.SHIPPING_POLICY) };
    const result = await run({
      ...BASE,
      client,
      root,
      backupDir: dir,
      options: options({ confirm: 'shipping_policy', expectLiveSha: sha(drifted), restore: 'f.json', restoreRecord: record }),
    });
    assert.equal(result.mutated, true);
    assert.equal(client.state.get('SHIPPING_POLICY').body, BODIES.SHIPPING_POLICY);
    // The repo copy still holds its own wording; the manifest says a push is outstanding.
    assert.equal(bodyFromFileText(readPolicy(root, 'SHIPPING_POLICY')), EDITED);
    const entry = JSON.parse(readManifestRaw(root)).policies.shipping_policy;
    assert.equal(entry.remote.sha256, sha(BODIES.SHIPPING_POLICY));
    assert.notEqual(entry.remote.sha256, entry.sha256);
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});
