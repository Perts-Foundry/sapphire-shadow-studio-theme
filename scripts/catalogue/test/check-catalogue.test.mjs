import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { checkCatalogue } from '../check-catalogue.mjs';

/** Write one manifest into a throwaway directory and return its path. */
async function fixture(contents) {
  const dir = await mkdtemp(path.join(tmpdir(), 'catalogue-lint-'));
  const file = path.join(dir, 'catalogue.json');
  await writeFile(file, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
  return file;
}

test('the committed catalogue.json passes the lint, with non-zero counts', async () => {
  // The counts are the fail-closed floor: a lint that validated nothing must not report success.
  const { bodies, colors, sizes } = await checkCatalogue();
  assert.ok(bodies > 0, 'bodies counted');
  assert.ok(colors > 0, 'colour values counted');
  assert.ok(sizes > 0, 'size values counted');
});

test('the lint refuses a manifest that declares no bodies at all', async () => {
  await assert.rejects(checkCatalogue(await fixture({ version: 1, bodies: {} })), /A lint that checks nothing must not pass/);
});

test('the lint refuses a malformed manifest through the tool\'s own schema, not a second copy of it', async () => {
  await assert.rejects(checkCatalogue(await fixture('{ "version": 1, }}')), /is not valid JSON/);
  await assert.rejects(checkCatalogue(await fixture({ version: 2, bodies: {} })), /understands 1 only/);
  await assert.rejects(
    checkCatalogue(await fixture({ version: 1, bodies: { crewneck: { colors: ['Black'], sizes: ['m'] } } })),
    /not in normalised form/
  );
});

test('the lint refuses an empty file rather than treating it as an empty catalogue', async () => {
  await assert.rejects(checkCatalogue(await fixture('')), /is not valid JSON/);
});
