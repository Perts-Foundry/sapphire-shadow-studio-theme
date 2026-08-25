import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { checkCatalogue, formatCounts } from '../check-catalogue.mjs';

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

test('the lint counts each axis separately, so the three totals cannot be transposed', async () => {
  // Asymmetric on purpose: with 2 bodies and equal colour and size totals, swapping the two
  // accumulators would leave the whole suite green.
  const file = await fixture({
    version: 1,
    bodies: {
      crewneck: { colors: ['black', 'grey heather', 'classic navy'], sizes: ['m'] },
      'vest-womens': { colors: ['black', 'grey heather'], sizes: ['s', 'm', 'l', 'xl'] },
    },
  });
  assert.deepEqual(await checkCatalogue(file), { bodies: 2, colors: 5, sizes: 5 });
});

test('the success line matches the shape CI greps for its fail-closed floor', () => {
  // validate.yml parses this exact wording to assert the lint checked something. Pinning it here
  // means a reword fails locally instead of only in CI, where it reads as an unrelated failure.
  assert.equal(formatCounts({ bodies: 3, colors: 7, sizes: 18 }), 'catalogue OK: 3 bodies, 7 colour values, 18 size values.');
  // The workflow's sed anchors on both ends, so a trailing addition would break the floor too.
  assert.match(formatCounts({ bodies: 1, colors: 1, sizes: 1 }), /^catalogue OK: [0-9]+ bodies, [0-9]+ colour values, [0-9]+ size values\.$/);
});

test('the lint gives the module\'s curated refusal for a missing file, not a bare ENOENT', async () => {
  // The likeliest real CI failure is a rename or a bad merge deleting the file, and the message
  // needs to say who owns it rather than just naming an errno.
  await assert.rejects(checkCatalogue('/no/such/dir/catalogue.json'), (err) => {
    assert.equal(err.fileMissing, true);
    assert.match(err.message, /committed at the repo root and hand-edited in a reviewed PR/);
    return true;
  });
});
