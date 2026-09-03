// The Flow run-list probe's URL matchers.
//
// EVERY INPUT HERE IS SYNTHETIC. The operation names and the query-param spellings are API surface
// (the same class of fact as a field name in the probe itself), but no run id, count or timestamp
// from a real store appears here or may ever be committed: this repo is public. The store handle in
// these URLs is a placeholder for the same reason.
//
// This tests the matchers by reading them out of the probe source rather than importing it: the
// probe is browser JS wrapped in an IIFE with no exports, and it must stay that way so it can be
// passed verbatim as an initScript.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../browser/flow-runs-probe.js', import.meta.url), 'utf8');

/** Pull a `var NAME = /.../;` literal out of the probe source and rebuild it. */
function matcher(name) {
  const m = new RegExp(`var ${name} = /(.+)/;`).exec(SOURCE);
  assert.ok(m, `${name} is no longer a single-line regex literal in the probe source`);
  return new RegExp(m[1]);
}

const RUNS_URL_RE = matcher('RUNS_URL_RE');
const OP_NAME_RE = matcher('OP_NAME_RE');

const flow = (op) => `https://flow.shopifyapps.com/flow-core/graphql?opName=${op}`;
const admin = (op) => `https://admin.shopify.com/api/operations/abc/X/shopify/example-shop?operationName=${op}`;

test('the run-list operation matches: it is the only one carrying startedAt', () => {
  // Observed 2026-09-03. getWorkflowRunsV2Connection returns
  // data.workflowRunsV2Connection.edges[].node with id, startedAt, status and retried. If this
  // assertion ever fails the probe is silent, because nothing else in the surface has a timestamp.
  assert.ok(RUNS_URL_RE.test(flow('getWorkflowRunsV2Connection')));
});

test('the digit in V2 is reachable, which a letters-only class would not be', () => {
  // The regression this pins: Run[A-Za-z]* cannot get past the `2`, so the probe would match only
  // the timestamp-less summaries operation and report nothing.
  const lettersOnly = /(?:operationName|opName)=[A-Za-z]*(?:Flow|Workflow)[A-Za-z]*Run[A-Za-z]*(?![A-Za-z0-9_-])/;
  assert.equal(lettersOnly.test(flow('getWorkflowRunsV2Connection')), false);
  assert.ok(RUNS_URL_RE.test(flow('getWorkflowRunsV2Connection')));
});

test('both query-param spellings match, because the two hosts differ', () => {
  // flow.shopifyapps.com uses opName=; the admin.shopify.com shell uses operationName=.
  assert.ok(RUNS_URL_RE.test(flow('getWorkflowRunsSummaries')));
  assert.ok(RUNS_URL_RE.test(admin('FlowRun')));
});

test('the collapsed spelling that broke this is rejected as a matcher', () => {
  // `op(?:erationN)?ame` yields `opame` and matches NEITHER host. Kept as a test because the
  // collapsed form looks correct at a glance and was written once already.
  const collapsed = /op(?:erationN)?ame=[A-Za-z]*(?:Flow|Workflow)[A-Za-z]*Run[A-Za-z0-9]*(?![A-Za-z0-9_-])/;
  assert.equal(collapsed.test(flow('getWorkflowRunsV2Connection')), false);
});

test('unrelated Flow operations do not match', () => {
  for (const op of ['getShopTimezone', 'getShopVerdictBetaFlag', 'emitMetric']) {
    assert.equal(RUNS_URL_RE.test(flow(op)), false, op);
  }
  assert.equal(RUNS_URL_RE.test(admin('ShopSetup')), false);
});

test('a benign over-match is tolerated, and why', () => {
  // getWorkflowRunPollingInterval matches the URL pattern. That is harmless and deliberate:
  // findRuns filters structurally on id + status + timestamp, and logRuns emits nothing (and never
  // sets `matched`) when a response holds no runs. Widening or narrowing the URL match is not the
  // lever for a wrong reading; the structural walk is.
  assert.ok(RUNS_URL_RE.test(flow('getWorkflowRunPollingInterval')));
});

test('noteOp extracts the operation name under both spellings', () => {
  // This is what SSSFLOWNONE reports. Sharing the param spelling with RUNS_URL_RE is why the
  // 2026-09-03 silence reported a bare "-" instead of naming the operations it had seen.
  assert.equal(OP_NAME_RE.exec(flow('getShopTimezone'))[1], 'getShopTimezone');
  assert.equal(OP_NAME_RE.exec(admin('ShopSetup'))[1], 'ShopSetup');
});
