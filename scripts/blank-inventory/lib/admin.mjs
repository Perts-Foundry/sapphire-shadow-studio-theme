// Shopify Admin API access for the blank-inventory tooling.
//
// Lifted from the shape already proven in scripts/upload-product-media.mjs: the token is minted at
// runtime from SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET, never printed, never written to disk, and
// redacted out of every error string. There is deliberately only one token flow in this repo.
//
// One deliberate divergence from upload-product-media.mjs: `gql` here does NOT throw on
// `userErrors`. This tool must treat a per-row CHANGE_FROM_QUANTITY_STALE as a recoverable
// per-row outcome (apply continues with the remaining groups), not as a run-ending exception.
// Callers inspect userErrors themselves.
//
// The network-free helpers (backoffDelayMs, isThrottled, missingScopes, assertSingleLocation) are
// exported so the retry and gating logic is unit-testable without a network.

const DEFAULT_API_VERSION = '2026-07';

/** Scopes this tool cannot operate without. Verified at runtime, never assumed. */
export const REQUIRED_SCOPES = ['write_products', 'write_inventory'];

/**
 * Build a function that scrubs secrets out of any string before it is logged or thrown.
 * @param {...(string|undefined)} secrets
 * @returns {(s: unknown) => string}
 */
export function makeRedactor(...secrets) {
  const real = secrets.filter(Boolean);
  return (s) => real.reduce((acc, sec) => acc.split(sec).join('[redacted]'), String(s ?? ''));
}

/**
 * @param {string} name
 * @returns {string}
 */
export function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

/**
 * Which of the required scopes are absent from the granted set.
 * Pure, so the gate is testable without minting a token.
 * @param {string[]} granted
 * @param {string[]} [required]
 * @returns {string[]}
 */
export function missingScopes(granted, required = REQUIRED_SCOPES) {
  const have = new Set(granted ?? []);
  return required.filter((s) => !have.has(s));
}

/**
 * True when a GraphQL error array represents Shopify throttling.
 * @param {Array<{extensions?: {code?: string}}>} [errors]
 * @returns {boolean}
 */
export function isThrottled(errors) {
  return Array.isArray(errors) && errors.some((e) => e?.extensions?.code === 'THROTTLED');
}

/**
 * Exponential backoff with full jitter, capped. Pure so it can be tested with a seeded random.
 * @param {number} attempt - zero-based retry attempt
 * @param {object} [opts]
 * @param {number} [opts.baseMs]
 * @param {number} [opts.maxMs]
 * @param {() => number} [opts.random] - injectable for deterministic tests
 * @returns {number} milliseconds to wait
 */
export function backoffDelayMs(attempt, opts = {}) {
  const { baseMs = 1000, maxMs = 16000, random = Math.random } = opts;
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(ceiling * (0.5 + 0.5 * random()));
}

/**
 * The Flow's locationId handling and its aggregate-quantity comparison both assume exactly one
 * location. Refuse to operate otherwise rather than corrupting stock.
 * See docs/blank-inventory-sync-flow.md, "Assumptions and limitations".
 * @param {Array<{id: string, isActive?: boolean}>} locations
 * @returns {string} the single active location id
 */
export function assertSingleLocation(locations) {
  const active = (locations ?? []).filter((l) => l.isActive !== false);
  if (active.length !== 1) {
    throw new Error(
      `Expected exactly 1 active location, found ${active.length}. The blank-inventory sync Flow ` +
        `assumes a single location; revisit the Flow before running this tool.`
    );
  }
  return active[0].id;
}

/**
 * @typedef {object} AdminClient
 * @property {(query: string, variables?: object) => Promise<any>} gql
 * @property {() => Promise<string[]>} scopes
 * @property {(s: unknown) => string} redact
 * @property {string} apiVersion
 */

/**
 * Create an Admin API client. The token is minted lazily on first use.
 * @param {object} [opts]
 * @param {string} [opts.domain] - defaults to MYSHOPIFY_DOMAIN
 * @param {string} [opts.apiVersion]
 * @param {typeof fetch} [opts.fetchImpl] - injectable for tests
 * @param {(ms: number) => Promise<void>} [opts.sleep] - injectable for tests
 * @param {number} [opts.maxRetries]
 * @returns {AdminClient}
 */
export function createAdminClient(opts = {}) {
  const {
    domain = requireEnv('MYSHOPIFY_DOMAIN'),
    apiVersion = DEFAULT_API_VERSION,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    maxRetries = 5,
  } = opts;

  let redact = makeRedactor(process.env.SHOPIFY_CLIENT_SECRET);
  let tokenPromise = null;

  async function token() {
    if (!tokenPromise) {
      tokenPromise = (async () => {
        const res = await fetchImpl(`https://${domain}/admin/oauth/access_token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'client_credentials',
            client_id: requireEnv('SHOPIFY_CLIENT_ID'),
            client_secret: requireEnv('SHOPIFY_CLIENT_SECRET'),
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.access_token) {
          throw new Error(redact(`Token exchange failed (${res.status}): ${JSON.stringify(body)}`));
        }
        // Widen the redactor now that a live token exists.
        redact = makeRedactor(body.access_token, process.env.SHOPIFY_CLIENT_SECRET);
        return body.access_token;
      })();
    }
    return tokenPromise;
  }

  async function scopes() {
    const t = await token();
    const res = await fetchImpl(`https://${domain}/admin/oauth/access_scopes.json`, {
      headers: { 'X-Shopify-Access-Token': t },
    });
    const body = await res.json().catch(() => ({}));
    return (body.access_scopes || []).map((s) => s.handle);
  }

  async function gql(query, variables = {}) {
    const t = await token();
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetchImpl(`https://${domain}/admin/api/${apiVersion}/graphql.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': t, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(redact(`HTTP ${res.status}: ${JSON.stringify(body)}`));
      if (body.errors) {
        if (isThrottled(body.errors) && attempt < maxRetries) {
          await sleep(backoffDelayMs(attempt));
          continue;
        }
        throw new Error(redact(`GraphQL errors: ${JSON.stringify(body.errors)}`));
      }
      // userErrors are deliberately returned to the caller, not thrown. See the header note.
      return body.data || {};
    }
    throw new Error('Exhausted retries against the Admin API (throttled).');
  }

  return {
    gql,
    scopes,
    apiVersion,
    get redact() {
      return redact;
    },
  };
}

/**
 * Verify the app grants what this tool needs. Capability is not authorization: a passing scope
 * check never substitutes for an operator approval gate.
 *
 * `required` is a parameter because this client is shared with scripts/sku/, which writes variant
 * SKUs and needs only write_products. Demanding write_inventory of a tool that never touches
 * inventory would train the operator to widen the app's grants for no reason.
 *
 * @param {AdminClient} client
 * @param {string[]} [required] - defaults to this module's REQUIRED_SCOPES
 * @returns {Promise<string[]>} the granted scopes
 */
export async function assertScopes(client, required = REQUIRED_SCOPES) {
  const granted = await client.scopes();
  const missing = missingScopes(granted, required);
  if (missing.length) {
    throw new Error(
      `Missing required scope(s): ${missing.join(', ')}. The app must grant ` +
        `${required.join(' + ')}. Apply the changes in Admin by hand until then.`
    );
  }
  return granted;
}
