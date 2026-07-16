import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfile } from '../lib/profile-io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(path.join(HERE, '..', 'profiles', 'crewneck-fleece.json'), 'utf8'));

test('loadProfile resolves a blank_id to profiles/<id>.json and validates it', async () => {
  assert.deepEqual(await loadProfile('crewneck-fleece'), SEED);
});

test('loadProfile wraps a missing/unreadable profile in a clear error', async () => {
  await assert.rejects(loadProfile('./does-not-exist.json'), /Cannot read profile/);
});
