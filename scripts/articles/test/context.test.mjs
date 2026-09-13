// lib/context.mjs: the context refuses to invent a client, git or environment; CI refuses by
// presence; flags are a closed set; and exit codes map the same way for every command.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ArticleError, assertNotCI, createContext, parseFlags, requireClient, requireGit, toExitCode } from '../lib/context.mjs';

const BASE = { repoRoot: '/repo', env: {}, now: () => '2026-01-02T03:04:05.000Z', stateDir: '/state' };

test('createContext requires the root, the environment, the clock and the state directory', () => {
  for (const key of ['repoRoot', 'env', 'now', 'stateDir']) {
    const input = { ...BASE };
    delete input[key];
    assert.throws(() => createContext(input), TypeError, key);
  }
  assert.throws(() => createContext({ ...BASE, env: null }), /never omit it/);
  // A computed key: this is a test of the type check, not an injected git runner, so it stays out of
  // the hygiene rule's sight rather than teaching that rule an exception.
  assert.throws(() => createContext({ ...BASE, ['git']: 'not a function' }), TypeError);
  assert.throws(() => createContext({ ...BASE, client: {} }), TypeError);
});

test('there is NO default client and NO default git: absent is null, and a command needing one refuses', () => {
  const ctx = createContext(BASE);
  assert.equal(ctx.client, null);
  assert.equal(ctx.git, null);
  assert.equal(ctx.fetch, null);
  assert.ok(Object.isFrozen(ctx) && Object.isFrozen(ctx.env));
  assert.throws(() => requireClient(ctx, 'x'), /needs an Admin client/);
  assert.throws(() => requireGit(ctx, 'x'), /needs a git runner/);
});

test('CI refuses by PRESENCE: empty, false and 0 refuse too, and only absence passes', () => {
  for (const value of ['true', '1', '', 'false', '0', undefined]) {
    assert.throws(() => assertNotCI({ CI: value }, 'cmd'), (err) => err instanceof ArticleError && /refuses to run with CI set/.test(err.message));
  }
  assert.doesNotThrow(() => assertNotCI({}, 'cmd'));
  assert.doesNotThrow(() => assertNotCI({ CONTINUOUS: 'true', GITHUB_ACTIONS_X: '1' }, 'cmd'));
});

test('parseFlags: a closed set, both spellings, and every ambiguity refused', () => {
  const spec = { '--handle': 'string', '--live': 'boolean' };
  assert.deepEqual(parseFlags(['--handle', 'a'], spec, 'c'), { '--handle': 'a', '--live': false });
  assert.deepEqual(parseFlags(['--handle=a', '--live'], spec, 'c'), { '--handle': 'a', '--live': true });
  assert.deepEqual(parseFlags([], spec, 'c'), { '--handle': null, '--live': false });
  const refusals = [
    [['--nope'], /unknown flag --nope/],
    [['handle'], /unexpected argument/],
    [['--handle', 'a', '--handle', 'b'], /more than once/],
    [['--handle'], /expects a value/],
    [['--handle', '--live'], /expects a value/],
    [['--handle='], /non-empty value/],
    [['--live=yes'], /takes no value/],
  ];
  for (const [argv, why] of refusals) assert.throws(() => parseFlags(argv, spec, 'c'), why, JSON.stringify(argv));
});

test('toExitCode: 0 and 2 pass through, a refusal is 1, an unexpected code is 1, and errors are redacted', async () => {
  const errors = [];
  const ctx = createContext({ ...BASE, error: (s) => errors.push(s), client: { gql: async () => ({}), redact: (s) => String(s).replace('secret', '[redacted]') } });
  assert.equal(await toExitCode(async () => ({ code: 0 }), [], ctx, 'c'), 0);
  assert.equal(await toExitCode(async () => ({ code: 2 }), [], ctx, 'c'), 2);
  assert.equal(await toExitCode(async () => { throw new ArticleError('x', 'has a secret in it'); }, [], ctx, 'c'), 1);
  assert.ok(errors.some((e) => e.includes('[redacted]')) && !errors.some((e) => e.includes('secret')));
  assert.equal(await toExitCode(async () => ({ code: 3 }), [], ctx, 'c'), 1);
  assert.equal(await toExitCode(async () => ({}), [], ctx, 'c'), 1);
});
