import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { transcriptPath, withTranscript } from '../lib/transcript.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'sku-transcript-'));

test('dry-run and live transcripts get distinct paths so neither overwrites the other', () => {
  assert.equal(transcriptPath('/w', 'abc', false), path.join('/w', 'transcript-abc.log'));
  assert.equal(transcriptPath('/w', 'abc', true), path.join('/w', 'transcript-abc-dry-run.log'));
  assert.notEqual(transcriptPath('/w', 'abc', true), transcriptPath('/w', 'abc', false));
});

test('withTranscript tees both console.log and console.error and returns fn result', async () => {
  const file = path.join(tmp(), 'nested', 't.log');
  const result = await withTranscript(file, () => {
    console.log('summary line %d', 1);
    console.error('  failed on gid://x: boom');
    return 'done';
  });
  assert.equal(result, 'done');
  assert.equal(readFileSync(file, 'utf8'), 'summary line 1\n  failed on gid://x: boom\n');
});

test('withTranscript truncates a stale transcript from an earlier run', async () => {
  const file = path.join(tmp(), 't.log');
  writeFileSync(file, 'stale earlier run\n', 'utf8');
  await withTranscript(file, () => {
    console.log('fresh');
  });
  assert.equal(readFileSync(file, 'utf8'), 'fresh\n');
});

test('withTranscript restores console on success and on throw', async () => {
  const dir = tmp();
  const originalLog = console.log;
  const originalError = console.error;

  await withTranscript(path.join(dir, 'ok.log'), () => {});
  assert.equal(console.log, originalLog);
  assert.equal(console.error, originalError);

  await assert.rejects(
    withTranscript(path.join(dir, 'boom.log'), () => {
      console.log('before the crash');
      throw new Error('mid-apply crash');
    }),
    /mid-apply crash/
  );
  assert.equal(console.log, originalLog);
  assert.equal(console.error, originalError);
  // The crash still leaves a record of everything printed before it.
  assert.equal(readFileSync(path.join(dir, 'boom.log'), 'utf8'), 'before the crash\n');
});
