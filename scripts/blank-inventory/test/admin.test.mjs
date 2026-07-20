import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRedactor,
  missingScopes,
  isThrottled,
  backoffDelayMs,
  assertSingleLocation,
  createAdminClient,
  REQUIRED_SCOPES,
} from '../lib/admin.mjs';

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
