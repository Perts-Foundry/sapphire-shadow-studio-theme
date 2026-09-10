import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRedactor,
  missingScopes,
  isThrottled,
  backoffDelayMs,
  assertSingleLocation,
  createAdminClient,
  readOnlyClient,
  REQUIRED_SCOPES,
} from '../lib/admin.mjs';
import * as mutations from '../lib/mutations.mjs';
import { dryRunDeps } from '../blank-inventory.mjs';

test('makeRedactor scrubs every secret it was given', () => {
  const redact = makeRedactor('shpat_secret', 'client_secret_value');
  const out = redact('token=shpat_secret and secret=client_secret_value');
  assert.equal(out.includes('shpat_secret'), false);
  assert.equal(out.includes('client_secret_value'), false);
  assert.match(out, /\[redacted\]/);
});

test('makeRedactor ignores undefined secrets', () => {
  assert.equal(makeRedactor(undefined, null)('plain'), 'plain');
});

test('missingScopes reports exactly what is absent', () => {
  assert.deepEqual(missingScopes(['read_products', 'write_products']), ['write_inventory']);
  assert.deepEqual(missingScopes([...REQUIRED_SCOPES, 'read_products']), []);
  assert.deepEqual(missingScopes([]), [...REQUIRED_SCOPES]);
});

test('isThrottled recognises only the throttle code', () => {
  assert.equal(isThrottled([{ extensions: { code: 'THROTTLED' } }]), true);
  assert.equal(isThrottled([{ extensions: { code: 'MAX_COST_EXCEEDED' } }]), false);
  assert.equal(isThrottled(undefined), false);
});

test('backoffDelayMs grows and is capped, with jitter injectable', () => {
  const max = (attempt) => backoffDelayMs(attempt, { random: () => 1 });
  assert.equal(max(0), 1000);
  assert.equal(max(1), 2000);
  assert.equal(max(2), 4000);
  assert.equal(max(10), 16000, 'capped');
  // Full jitter halves the floor.
  assert.equal(backoffDelayMs(1, { random: () => 0 }), 1000);
});

test('assertSingleLocation returns the id when exactly one is active', () => {
  const id = assertSingleLocation([
    { id: 'gid://shopify/Location/1', isActive: true },
    { id: 'gid://shopify/Location/2', isActive: false },
  ]);
  assert.equal(id, 'gid://shopify/Location/1');
});

test('assertSingleLocation refuses a second active location', () => {
  // The Flow concatenates location ids with no separator; a second location breaks it silently.
  assert.throws(
    () =>
      assertSingleLocation([
        { id: 'gid://shopify/Location/1', isActive: true },
        { id: 'gid://shopify/Location/2', isActive: true },
      ]),
    /Expected exactly 1 active location, found 2/
  );
});

test('assertSingleLocation refuses zero locations', () => {
  assert.throws(() => assertSingleLocation([]), /found 0/);
});

// --- client behaviour with an injected fetch --------------------------------

function stubFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch to ${url}`);
    return { ok: next.ok ?? true, status: next.status ?? 200, json: async () => next.body };
  };
  impl.calls = calls;
  return impl;
}

const withEnv = async (fn) => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    MYSHOPIFY_DOMAIN: 'example.myshopify.com',
    SHOPIFY_CLIENT_ID: 'id',
    SHOPIFY_CLIENT_SECRET: 'shh',
  });
  try {
    await fn();
  } finally {
    process.env = saved;
  }
};

test('gql returns userErrors to the caller instead of throwing', async () => {
  // Load-bearing divergence from upload-product-media.mjs: a per-row CAS failure must be a
  // recoverable outcome that apply records and continues past, not a run-ending exception.
  await withEnv(async () => {
    const fetchImpl = stubFetch([
      { body: { access_token: 'shpat_tok' } },
      { body: { data: { inventorySetQuantities: { userErrors: [{ code: 'CHANGE_FROM_QUANTITY_STALE' }] } } } },
    ]);
    const client = createAdminClient({ fetchImpl });
    const data = await client.gql('mutation {}');
    assert.equal(data.inventorySetQuantities.userErrors[0].code, 'CHANGE_FROM_QUANTITY_STALE');
  });
});

test('gql retries a throttled response then succeeds', async () => {
  await withEnv(async () => {
    const fetchImpl = stubFetch([
      { body: { access_token: 'shpat_tok' } },
      { body: { errors: [{ extensions: { code: 'THROTTLED' } }] } },
      { body: { data: { ok: true } } },
    ]);
    const waited = [];
    const client = createAdminClient({ fetchImpl, sleep: async (ms) => void waited.push(ms) });
    const data = await client.gql('query {}');
    assert.deepEqual(data, { ok: true });
    assert.equal(waited.length, 1, 'one backoff between the two attempts');
  });
});

test('gql throws on a non-throttle GraphQL error, with the token redacted', async () => {
  await withEnv(async () => {
    const fetchImpl = stubFetch([
      { body: { access_token: 'shpat_tok' } },
      { body: { errors: [{ message: 'bad request for shpat_tok', extensions: { code: 'BAD_REQUEST' } }] } },
    ]);
    const client = createAdminClient({ fetchImpl });
    await assert.rejects(
      () => client.gql('query {}'),
      (err) => {
        assert.equal(err.message.includes('shpat_tok'), false, 'the token must never reach a log');
        assert.match(err.message, /\[redacted\]/);
        return true;
      }
    );
  });
});

// --- the dry-run backstop -----------------------------------------------------
//
// A dry run's store client refuses every mutation, and its file writer refuses every write, so a
// stage that forgets to check --dry-run aborts instead of writing. That is what backfill --stage tag
// did on 2026-09-10; see dry-run.test.mjs.

function recordingClient() {
  const calls = [];
  return {
    calls,
    gql: async (query, variables) => {
      calls.push({ query, variables });
      return { ok: true };
    },
  };
}

test('readOnlyClient refuses a mutation, and the inner client never sees it', async () => {
  for (const doc of [
    'mutation BlankInventoryTag { x }',
    '\n    mutation BlankInventoryTag { x }',
    '# a comment first\n  mutation BlankInventoryTag { x }',
  ]) {
    const inner = recordingClient();
    await assert.rejects(
      () => readOnlyClient(inner).gql(doc, {}),
      /^Error: DRY RUN: refused to send mutation BlankInventoryTag; a dry run reached a write path \(a bug\)/
    );
    assert.deepEqual(inner.calls, [], `the mutation must not reach the network: ${JSON.stringify(doc)}`);
  }
});

test('readOnlyClient passes a query through, named or anonymous', async () => {
  for (const doc of ['query Shop { shop { id } }', '{ shop { id } }', '# note\nquery Shop { shop { id } }']) {
    const inner = recordingClient();
    assert.deepEqual(await readOnlyClient(inner).gql(doc, { a: 1 }), { ok: true });
    assert.deepEqual(inner.calls, [{ query: doc, variables: { a: 1 } }]);
  }
});

test('readOnlyClient refuses every mutation document this tool can send', async () => {
  // Iterated, not listed: a new M_* constant is covered the day it is added.
  const docs = Object.entries(mutations).filter(([name]) => name.startsWith('M_'));
  assert.ok(docs.length >= 4, `the mutation constants were found (${docs.length})`);
  for (const [name, doc] of docs) {
    const inner = recordingClient();
    await assert.rejects(() => readOnlyClient(inner).gql(doc, {}), /DRY RUN: refused to send mutation/, `${name} is refused`);
    assert.deepEqual(inner.calls, [], `${name} never reaches the network`);
  }
});

test('the dry-run deps refuse a file write and wrap the store client; a live run keeps its deps', async () => {
  const inner = recordingClient();
  const real = {
    load: async () => ({ client: inner, groups: new Map() }),
    writeJson: async () => assert.fail('the real writer must not be reached on a dry run'),
  };
  const dry = dryRunDeps({ dryRun: true }, real);
  await assert.rejects(() => dry.writeJson('/work/receipt-seed-x.json', {}), /^Error: DRY RUN: refused to write \/work\/receipt-seed-x\.json/);
  const store = await dry.load({ requireWrite: false });
  await assert.rejects(() => store.client.gql(mutations.M_METAFIELDS_SET, {}), /DRY RUN: refused to send mutation BlankInventoryTag/);
  assert.deepEqual(inner.calls, []);

  assert.equal(dryRunDeps({}, real), real, 'without --dry-run the deps are untouched');
});

test('the token is minted once and reused across calls', async () => {
  await withEnv(async () => {
    const fetchImpl = stubFetch([
      { body: { access_token: 'shpat_tok' } },
      { body: { data: { a: 1 } } },
      { body: { data: { b: 2 } } },
    ]);
    const client = createAdminClient({ fetchImpl });
    await client.gql('query {}');
    await client.gql('query {}');
    const tokenCalls = fetchImpl.calls.filter((c) => c.url.includes('access_token'));
    assert.equal(tokenCalls.length, 1);
  });
});
