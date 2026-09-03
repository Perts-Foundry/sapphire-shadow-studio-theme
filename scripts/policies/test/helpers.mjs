// Shared scaffolding: a synthetic checkout root under marketing/policies/, a recording fake
// Admin client, and a byte-level snapshot so a refusal can be proved to have written nothing.
//
// Fixtures are SYNTHETIC and small, one per property. Nothing here reads the real bodies.

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { POLICY_TYPES, buildEntry, fileNameForType, fileTextFor, formatManifest, keyForType } from '../lib/policies.mjs';

export const NOW = '2026-01-02T03:04:05.000Z';

/** One synthetic body per policy, each chosen to exercise a different property. */
export const BODIES = Object.freeze({
  CONTACT_INFORMATION: '<p>Reach us at <a href="mailto:test@example.com">test@example.com</a>.</p>\n<p>No headings here at all.</p>',
  PRIVACY_POLICY: '<h2>What We Collect</h2>\n<p>Auto-managed by Shopify.</p>\n<h2>Your Choices</h2>\n<p>b</p>',
  REFUND_POLICY: '<h2>Returns</h2>\n<p>Within 30 days.</p>\n<h2>Exchanges</h2>\n<p>b</p>\n<h2>Questions?</h2>\n<p>c</p>',
  SHIPPING_POLICY: [
    '<h2>Shipping Options</h2>',
    '<h3>Economy Shipping</h3>',
    '<ul><li><strong>Transit time:</strong> 5–8 business days after production</li></ul>',
    '<h2>Production &amp; Delivery Times</h2>',
    '<p><strong>Production Time:</strong> Most orders ship within <strong>3–5 business days</strong>.</p>',
    '<h2>Questions?</h2>',
    '<p>Ask us.</p>',
  ].join('\n'),
  TERMS_OF_SERVICE: '<p>Terms, with no headings, like the real one.</p>',
});

/** A checkout root holding marketing/policies/ in a self-consistent state. */
export function makeRoot({ bodies = BODIES, now = NOW, titles = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'policies-test-'));
  const dir = join(root, 'marketing', 'policies');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# policies\n', 'utf8');
  const manifest = { policies: {} };
  for (const type of POLICY_TYPES) {
    const body = bodies[type];
    writeFileSync(join(dir, fileNameForType(type)), fileTextFor(body), 'utf8');
    manifest.policies[keyForType(type)] = buildEntry(undefined, {
      type,
      title: titles[type] ?? titleFor(type),
      body,
      now,
    });
  }
  writeFileSync(join(dir, 'manifest.json'), formatManifest(manifest), 'utf8');
  return root;
}

export function titleFor(type) {
  return type
    .toLowerCase()
    .split('_')
    .map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

export function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

export function policiesDir(root) {
  return join(root, 'marketing', 'policies');
}

export function readPolicy(root, type) {
  return readFileSync(join(policiesDir(root), fileNameForType(type)), 'utf8');
}

export function readManifestRaw(root) {
  return readFileSync(join(policiesDir(root), 'manifest.json'), 'utf8');
}

export function writeRaw(root, name, text) {
  writeFileSync(join(policiesDir(root), name), text, 'utf8');
}

/**
 * Every file under a directory as `path -> bytes`, recursively. Used to prove a refusal wrote
 * nothing at all, including no leftover `.tmp` sibling.
 */
export function snapshotTree(dir) {
  const out = new Map();
  const walk = (d, prefix) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, rel);
      else out.set(rel, readFileSync(full).toString('base64'));
    }
  };
  walk(dir, '');
  return out;
}

export function assertTreeUnchanged(assert, before, after, message) {
  assert.deepEqual([...after.keys()], [...before.keys()], `${message}: file set changed`);
  for (const [k, v] of before) assert.equal(after.get(k), v, `${message}: ${k} changed`);
}

/**
 * A recording fake Admin client.
 *
 * `calls` records every `gql` in order, as `{ kind, document, variables }` where kind is 'read' or
 * 'mutate'. Response fixtures are shaped from a real captured pull, so the fake answers what
 * Shopify actually answers.
 *
 * @param {object} o
 * @param {object} o.live               Map-like of type -> { title, body }; the current live state
 * @param {Function} [o.onMutate]       (type, body, state) => optional override of the response
 * @param {Function} [o.onRead]         (callIndex, state) => optional override of the read response
 */
export function makeClient({ live, onMutate, onRead } = {}) {
  const state = new Map(Object.entries(live ?? {}));
  const calls = [];
  let reads = 0;
  const client = {
    calls,
    state,
    scopesGranted: ['read_legal_policies', 'write_legal_policies'],
    async scopes() {
      return client.scopesGranted;
    },
    redact: (s) => String(s ?? ''),
    apiVersion: 'test',
    async gql(document, variables = {}) {
      const isMutation = /\bmutation\b/.test(document);
      calls.push({ kind: isMutation ? 'mutate' : 'read', document, variables });
      if (!isMutation) {
        const index = reads++;
        const override = onRead ? onRead(index, state) : undefined;
        if (override !== undefined) return override;
        return { shop: { shopPolicies: shopPoliciesFrom(state) } };
      }
      const { type, body } = variables.shopPolicy;
      const override = onMutate ? onMutate(type, body, state) : undefined;
      if (override !== undefined) return override;
      state.set(type, { ...state.get(type), body });
      return {
        shopPolicyUpdate: {
          shopPolicy: { id: gidFor(type), type, title: state.get(type).title, body },
          userErrors: [],
        },
      };
    },
  };
  return client;
}

export function gidFor(type) {
  return `gid://shopify/ShopPolicy/${POLICY_TYPES.indexOf(type) + 1}`;
}

export function shopPoliciesFrom(state) {
  return POLICY_TYPES.filter((t) => state.has(t)).map((type) => ({
    id: gidFor(type),
    type,
    title: state.get(type).title,
    body: state.get(type).body,
    url: `https://example.myshopify.com/1/policies/${POLICY_TYPES.indexOf(type)}.html?locale=en`,
  }));
}

/** The live state matching `BODIES`, which is what `makeRoot` commits. */
export function liveFrom(bodies = BODIES, titles = {}) {
  const out = {};
  for (const type of POLICY_TYPES) out[type] = { title: titles[type] ?? titleFor(type), body: bodies[type] };
  return out;
}

// ---------------------------------------------------------------------------------------------
// The git fake
// ---------------------------------------------------------------------------------------------

/**
 * Thrown when a git-backed gate invokes an argv no expectation covers.
 *
 * A distinctive class, not a bare Error: every gate under test refuses by throwing, and a
 * permissive fake's "" return is indistinguishable from "git said the tree is clean". A test that
 * catches this class by accident (`assert.throws(fn, /refusal/)`) still fails, because the message
 * names the argv rather than the refusal.
 */
export class UnexpectedGitInvocation extends Error {
  constructor(argv, known) {
    super(
      `the git fake was invoked with an argv no expectation covers:\n  ${JSON.stringify(argv)}\n` +
        `registered:\n${known.map((a) => `  ${JSON.stringify(a)}`).join('\n') || '  (none)'}`,
    );
    this.name = 'UnexpectedGitInvocation';
    this.argv = argv;
  }
}

/**
 * A STRICT fake for the `run` that `assertReviewedTree` and every other git-backed gate injects.
 *
 * Matching is DEEP EQUALITY OF THE FULL ARGV ARRAY, and nothing else. `includes`, `join(' ')` and
 * regex matching are deliberately impossible here: PR #154 shipped two tests that passed
 * vacuously because a fake matched a bare filename (`a.endsWith('*.html')`) against production
 * code that emits a full pathspec, so the tests proved the fake's own shape rather than the
 * gate's. Deep equality means the expectation IS the argv production code has to emit.
 *
 * An unrecognised invocation throws `UnexpectedGitInvocation` rather than returning a default.
 * A default return is what makes an absent gate look like a passing one.
 *
 * `assertExhausted` closes the other half: a strict fake catches an argv nobody expected, but not
 * an expectation nobody used, which is how a gate that was silently removed keeps its test green.
 *
 * @param {Array<{args: string[], result?: string, throws?: Error|string}>} expectations
 *        `result` is what git prints (trimmed by production code); `throws` makes the invocation
 *        fail the way `execFileSync` does on a non-zero exit.
 */
export function makeGitFake(expectations) {
  if (!Array.isArray(expectations)) throw new TypeError('makeGitFake takes an array of expectations');
  const table = expectations.map((e, i) => {
    if (!Array.isArray(e.args)) throw new TypeError(`expectation ${i} has no args array`);
    if (e.result !== undefined && typeof e.result !== 'string') {
      throw new TypeError(`expectation ${i}: result must be the string git would print`);
    }
    if (e.result === undefined && e.throws === undefined) {
      throw new TypeError(`expectation ${i}: give it a result or a throws`);
    }
    return { args: e.args, result: e.result, throws: e.throws, used: 0 };
  });

  const calls = [];
  const run = (root, args) => {
    const argv = [...args];
    calls.push({ root, args: argv });
    const hit = table.find((e) => sameArgv(e.args, argv));
    if (!hit) throw new UnexpectedGitInvocation(argv, table.map((e) => e.args));
    hit.used++;
    if (hit.throws !== undefined) {
      throw hit.throws instanceof Error ? hit.throws : new Error(String(hit.throws));
    }
    return hit.result;
  };

  run.calls = calls;
  /** Every registered expectation must have been used at least once. Assert this at teardown. */
  run.assertExhausted = (assert, message = 'git expectations') => {
    const unused = table.filter((e) => e.used === 0).map((e) => e.args);
    assert.deepEqual(
      unused,
      [],
      `${message}: ${unused.length} expectation(s) were never invoked, so the gate that would have ` +
        'invoked them did not run:\n' + unused.map((a) => `  ${JSON.stringify(a)}`).join('\n'),
    );
  };
  return run;
}

function sameArgv(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** The argv `assertReviewedTree` emits, in order. One place, so a pathspec change breaks loudly. */
export const GIT_ARGV = Object.freeze({
  statusBodies: ['status', '--porcelain', '--', 'marketing/policies/*.html'],
  statusManifest: ['status', '--porcelain', '--', 'marketing/policies/manifest.json'],
  showManifest: ['show', 'HEAD:marketing/policies/manifest.json'],
  revParseHead: ['rev-parse', 'HEAD'],
  revParseBase: ['rev-parse', 'origin/main'],
  isAncestor: (head, base) => ['merge-base', '--is-ancestor', head, base],
});
