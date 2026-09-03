// Shared scaffolding: a synthetic checkout root under marketing/policies/, a recording fake
// Admin client, and a byte-level snapshot so a refusal can be proved to have written nothing.
//
// Fixtures are SYNTHETIC and small, one per property. Nothing here reads the real bodies.

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { POLICY_TYPES, buildEntry, fileNameForType, fileTextFor, formatManifest, keyForType } from '../lib/policies.mjs';
import { emptyState, readState, recordObservation, writeState } from '../lib/state.mjs';

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

/**
 * A checkout root holding marketing/policies/ in a self-consistent state.
 *
 * BODIES ARE WRITTEN STAMPED, exactly as the real tree holds them, because the two-hash invariant
 * (`sha256` over the committed bytes, `coreSha256` over the wording) is only exercised by a
 * fixture where the two actually differ. A fixture of unstamped bodies would make every core
 * comparison in the suite a comparison of two identical values.
 */
export function makeRoot({ bodies = BODIES, titles = {}, stamped = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'policies-test-'));
  const dir = join(root, 'marketing', 'policies');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# policies\n', 'utf8');
  const manifest = { policies: {} };
  for (const type of POLICY_TYPES) {
    const key = keyForType(type);
    const prev = stamped === null ? undefined : { stamped: stamped[type] === true };
    const { entry, body: written } = buildEntry(prev, {
      type,
      title: titles[type] ?? titleFor(type),
      body: bodies[type],
    });
    writeFileSync(join(dir, fileNameForType(type)), fileTextFor(written), 'utf8');
    manifest.policies[key] = entry;
  }
  writeFileSync(join(dir, 'manifest.json'), formatManifest(manifest), 'utf8');
  return root;
}

/** The body `makeRoot` writes for one policy: the fixture core, stamped if the policy is. */
export function writtenBodyFor(type, bodies = BODIES) {
  const { body } = buildEntry(undefined, { type, title: titleFor(type), body: bodies[type] });
  return body;
}

// ---------------------------------------------------------------------------------------------
// The machine-local observation state
// ---------------------------------------------------------------------------------------------

/** A scratch state directory, outside any checkout. Never the repo, never a real XDG path. */
export function makeStateDir() {
  return mkdtempSync(join(tmpdir(), 'policies-state-'));
}

/**
 * Seed the state file so it records exactly what `live` holds. The ordinary precondition for a
 * push: the machine has pulled, so it knows what Admin was last seen holding.
 */
export function seedState(stateDir, { live = liveFrom(), now = NOW, extra = {} } = {}) {
  const state = emptyState();
  for (const [type, { body }] of Object.entries(live)) {
    const key = keyForType(type);
    state.policies[key] = { ...recordObservation(undefined, { body, now }), ...(extra[key] ?? {}) };
  }
  writeState({ dir: stateDir, state });
  return state;
}

/** The parsed state file, or null. */
export function readStateRaw(stateDir) {
  return readState({ dir: stateDir });
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
 * @param {object} [options]
 * @param {boolean} [options.exhaustive]  false for a fake deliberately left unused (a test OF the
 *        fake, or a gate the test asserts is never reached). Must carry `why`.
 * @param {string} [options.why]  required with `exhaustive: false`, so an opt-out is a sentence a
 *        reviewer reads rather than a flag someone added to make a failure go away.
 */
export function makeGitFake(expectations, { exhaustive = true, why = null } = {}) {
  if (!Array.isArray(expectations)) throw new TypeError('makeGitFake takes an array of expectations');
  if (!exhaustive && (typeof why !== 'string' || why.trim() === '')) {
    throw new TypeError('makeGitFake({ exhaustive: false }) needs a `why` saying which gate is deliberately not reached');
  }
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
  run.exhaustive = exhaustive;
  run.why = why;
  REGISTERED.push(run);
  /** The expectations nobody invoked. Empty when the gate under test made every call. */
  run.unusedExpectations = () => table.filter((e) => e.used === 0).map((e) => e.args);

  /** Every registered expectation must have been used at least once. Assert this at teardown. */
  run.assertExhausted = (assert, message = 'git expectations') => {
    const unused = run.unusedExpectations();
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

/**
 * Every fake built in this process, so exhaustion can be checked at RUNTIME rather than by counting
 * text. A textual rule cannot follow a file-level factory (`cleanGit`, `noGit`) into the tests that
 * call it, which left roughly three quarters of this directory's fakes outside the old rule.
 */
const REGISTERED = [];

/**
 * Assert that every fake this file built had all of its expectations invoked. Call it from an
 * `after()` hook; `test/test-hygiene.test.mjs` requires every file building fakes to do so.
 */
export function assertAllGitFakesExhausted(assert) {
  const unused = [];
  for (const fake of REGISTERED) {
    if (!fake.exhaustive) continue;
    for (const args of fake.unusedExpectations()) unused.push(JSON.stringify(args));
  }
  assert.deepEqual(
    unused,
    [],
    `${unused.length} git expectation(s) were registered and never invoked, so the gate that would ` +
      'have invoked them did not run. If a fake is deliberately never reached, build it with ' +
      `{ exhaustive: false, why: '...' }.\n${unused.map((a) => `  ${a}`).join('\n')}`,
  );
}

/** The argv the git-backed gates emit. One place, so a pathspec change breaks loudly. */
export const GIT_ARGV = Object.freeze({
  /** push's gate: ALL of marketing/policies/, since a push no longer writes into the tree. */
  statusDir: ['status', '--porcelain', '--', 'marketing/policies'],
  /** pull's gate: only the bodies that pull would actually overwrite. */
  statusFiles: (...names) => ['status', '--porcelain', '--', ...names.map((n) => `marketing/policies/${n}`)],
  revParseHead: ['rev-parse', 'HEAD'],
  revParseBase: ['rev-parse', 'origin/main'],
  isAncestor: (head, base) => ['merge-base', '--is-ancestor', head, base],
});
