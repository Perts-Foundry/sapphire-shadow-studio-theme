import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyInFlight } from '../lib/sync-guard.mjs';

test('missing refs -> proceed with a warning', () => {
  assert.deepEqual(classifyInFlight({ refsPresent: false, divergedPaths: '' }), {
    action: 'proceed', warn: true, reason: 'refs-missing',
  });
});

test('diverged file on shopify-sync -> block', () => {
  const r = classifyInFlight({ refsPresent: true, divergedPaths: 'templates/product.x.json\n' });
  assert.equal(r.action, 'block');
  assert.equal(r.reason, 'diverged');
});

test('no divergence -> proceed', () => {
  const r = classifyInFlight({ refsPresent: true, divergedPaths: '' });
  assert.equal(r.action, 'proceed');
  assert.equal(r.reason, 'clean');
});

test('whitespace-only diff output is treated as no divergence', () => {
  const r = classifyInFlight({ refsPresent: true, divergedPaths: '   \n' });
  assert.equal(r.action, 'proceed');
});
