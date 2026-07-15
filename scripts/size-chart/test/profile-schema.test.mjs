import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProfile } from '../lib/profile-schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(path.join(HERE, '..', 'profiles', 'crewneck-fleece.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

test('accepts the seed profile', () => {
  assert.equal(validateProfile(SEED), true);
});

test('rejects an unknown top-level key', () => {
  const p = clone(SEED); p.foo = 1;
  assert.throws(() => validateProfile(p), /unknown key 'foo'/);
});

test('rejects a measurement length that does not match sizes', () => {
  const p = clone(SEED); p.measurements.body_length.pop();
  assert.throws(() => validateProfile(p), /length/);
});

test('rejects a non-monotonic column (transcription swap)', () => {
  const p = clone(SEED); p.measurements.chest_circumference[2] = 30;
  assert.throws(() => validateProfile(p), /decreases/);
});

test('rejects an out-of-range value (units error)', () => {
  const p = clone(SEED); p.measurements.chest_circumference = [5, 6, 7, 8, 9, 10];
  assert.throws(() => validateProfile(p), /range/);
});

test('rejects a non-kebab blank_id', () => {
  const p = clone(SEED); p.blank_id = 'Crew Neck';
  assert.throws(() => validateProfile(p), /kebab/);
});

test('rejects a missing measurement', () => {
  const p = clone(SEED); delete p.measurements.shoulder_width;
  assert.throws(() => validateProfile(p), /shoulder_width/);
});

test('rejects a non-numeric cell', () => {
  const p = clone(SEED); p.measurements.sleeve_length[0] = '22';
  assert.throws(() => validateProfile(p), /positive number/);
});

test('rejects a handle that could traverse out of templates/', () => {
  const p = clone(SEED); p.handles = ['../../evil'];
  assert.throws(() => validateProfile(p), /kebab-case/);
});
