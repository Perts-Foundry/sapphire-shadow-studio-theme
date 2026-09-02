// The read-only guard over the shared Admin client, and the per-read runner.
//
// Tier A2 promises "side effects: none". That promise is enforced here, not by review: the
// wrapped `gql` inspects every document before it reaches the network and throws on a mutation
// (or subscription) operation. The wrapper is the only thing config.mjs hands the read list, so
// no code path in this tier can send a write even by accident.
//
// Lib rules: no fetch, no fs, no process.env, no process.argv. The client is injected.

import { missingScopes } from '../../blank-inventory/lib/admin.mjs';
import { makeFinding, skipFinding } from './finding.mjs';
import { paginate } from './admin-queries.mjs';

/** Strip GraphQL comments (`# ...` to end of line) and collapse whitespace. */
export function stripDocument(document) {
  return String(document ?? '').replace(/#[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The operation type of a document: 'query', 'mutation', 'subscription', or 'query' for the
 * shorthand `{ ... }` form. Decided on the first keyword after comments are stripped.
 * @param {string} document
 * @returns {'query'|'mutation'|'subscription'}
 */
export function operationType(document) {
  const text = stripDocument(document);
  if (!text) throw new Error('empty GraphQL document');
  // Refuse on ANY operation keyword in the document, not only the first: a multi-operation
  // document `query A {...} mutation B {...}` starts with `query` and would otherwise pass.
  // The scan is deliberately coarse (a field literally named `mutation` would refuse too);
  // every document here is a committed constant, so a false refusal is a review-time fix.
  if (/\b(mutation|subscription)\s*[A-Za-z_(\{@]/.test(text)) {
    return /\bsubscription\s*[A-Za-z_(\{@]/.test(text) && !/\bmutation\s*[A-Za-z_(\{@]/.test(text) ? 'subscription' : 'mutation';
  }
  if (text.startsWith('{')) return 'query';
  const m = /^(query|fragment)\b/.exec(text);
  if (!m) throw new Error(`unrecognised GraphQL document start: ${JSON.stringify(text.slice(0, 40))}`);
  return 'query';
}

/** True when the document may pass through the read-only client. */
export function isReadOnlyDocument(document) {
  return operationType(document) === 'query';
}

/**
 * Wrap an AdminClient so `gql` refuses anything but a query. Everything else (scopes, redact,
 * apiVersion) passes through untouched.
 * @param {{gql: Function, scopes: Function, redact?: Function, apiVersion?: string}} client
 */
export function createReadOnlyClient(client) {
  if (!client || typeof client.gql !== 'function') throw new Error('createReadOnlyClient needs an AdminClient');
  return {
    async gql(document, variables = {}) {
      const type = operationType(document);
      if (type !== 'query') {
        throw new Error(`read-only client refused a ${type} operation; site-check config.mjs never writes`);
      }
      return client.gql(document, variables);
    },
    scopes: () => client.scopes(),
    get redact() { return typeof client.redact === 'function' ? client.redact : (s) => String(s ?? ''); },
    get apiVersion() { return client.apiVersion; },
    readOnly: true,
  };
}

/**
 * Run one read to completion: the first page, then every further page the connection reports,
 * then the read's `continue` hook for nested connections. Returns the merged data.
 * @param {{gql: Function}} client
 * @param {object} read  a READS entry
 */
export async function runRead(client, read) {
  const variables = { ...(read.variables || {}) };
  if (!read.page) return client.gql(read.document, variables);
  const data = await paginate({
    path: read.page.path,
    fetchPage: (after) => client.gql(read.document, after === null ? variables : { ...variables, after }),
  });
  return typeof read.continue === 'function' ? read.continue(data, client.gql.bind(client)) : data;
}

/**
 * Gate a read on the granted scopes, then run it, never throwing.
 *
 * - Missing scope: `{ skipped: true, missing, findings }` where findings carry one SKIPPED per
 *   check the read feeds (subject = the first missing scope) plus one `admin-scope-missing`
 *   per missing scope. The differ then reports the baseline's findings for those checks as
 *   SKIPPED, never RESOLVED.
 * - Read threw (GraphQL errors, HTTP failure): `{ skipped: false, error, findings }` with one
 *   `admin-partial-response` ERROR whose subject is the read name and whose message is passed
 *   through `redact` (the client's own, then the caller's).
 * - Otherwise `{ skipped: false, data, findings: [] }`.
 *
 * @param {object} o
 * @param {{gql: Function, redact?: Function}} o.client
 * @param {object} o.read
 * @param {string[]} o.granted
 * @param {(s: string) => string} [o.redact]
 */
export async function readOrSkip({ client, read, granted, redact = (s) => s }) {
  const missing = missingScopes(granted, read.scopes);
  if (missing.length) {
    const reason = `read ${read.name} skipped: app does not grant ${missing.join(', ')}`;
    const findings = [
      ...missing.map((scope) => skipFinding('admin-scope-missing', scope, reason)),
      ...read.checks.map((check) => skipFinding(check, missing[0], reason)),
    ];
    return { skipped: true, missing, findings };
  }
  try {
    const data = await runRead(client, read);
    return { skipped: false, data, findings: [] };
  } catch (err) {
    const clientRedact = client && typeof client.redact === 'function' ? client.redact : (s) => String(s ?? '');
    const message = redact(clientRedact(err && err.message ? err.message : String(err)));
    return {
      skipped: false,
      error: message,
      findings: [makeFinding({
        check: 'admin-partial-response',
        subject: read.name,
        message: `read ${read.name} failed; its checks were not evaluated: ${message}`,
      })],
    };
  }
}
