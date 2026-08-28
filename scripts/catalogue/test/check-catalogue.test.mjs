// The lint entry point: the vacuity floor, the count line, and the contract between that line and
// the shell pipeline in .github/workflows/validate.yml that parses it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkCatalogue, formatCounts } from '../check-catalogue.mjs';
import { COHESION_CHECK_COUNT } from '../../lib/catalogue-cohesion.mjs';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

/**
 * A complete hand-authored manifest, so a schema test does not read the file it validates.
 * @param {object} [over]
 */
function manifestDoc(over = {}) {
  return {
    version: 2,
    options: { color: 'Color', size: 'Size', design: 'Design', denomination: 'Denominations' },
    colors: { black: { display: 'Black', slug: 'black' } },
    sizes: { m: { display: 'M' } },
    bodies: { crewneck: { colors: ['black'], sizes: ['m'] } },
    products: {
      crew: { line: 'a', body: 'crewneck', template: 'crew', title: 'Crew', gid: 'gid://shopify/Product/1' },
    },
    ...over,
  };
}

/** Write one manifest into a throwaway directory and return its path. */
async function fixture(contents) {
  const dir = await mkdtemp(path.join(tmpdir(), 'catalogue-lint-'));
  const file = path.join(dir, 'catalogue.json');
  await writeFile(file, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
  return file;
}

test('MATCHES PRODUCTION: the committed catalogue.json passes the lint, with every count non-zero', async () => {
  // The counts are the fail-closed floor: a lint that validated nothing must not report success.
  const { counts, warnings } = await checkCatalogue();
  for (const [name, n] of Object.entries(counts)) assert.ok(n > 0, `${name} counted`);
  assert.equal(counts.cohesion, COHESION_CHECK_COUNT);
  assert.deepEqual(warnings, [], 'the committed repo produces no cohesion warnings');
});

test('the lint refuses a malformed manifest through the tool\'s own schema, not a second copy of it', async () => {
  await assert.rejects(checkCatalogue({ filePath: await fixture('{ "version": 2, }}') }), /is not valid JSON/);
  await assert.rejects(checkCatalogue({ filePath: await fixture({ version: 9, bodies: {} }) }), /understands 2 only/);
  await assert.rejects(
    checkCatalogue({ filePath: await fixture(manifestDoc({ bodies: { Crewneck: { colors: ['black'], sizes: ['m'] } } })) }),
    /not in normalised form/
  );
});

test('the lint refuses an empty file rather than treating it as an empty catalogue', async () => {
  await assert.rejects(checkCatalogue({ filePath: await fixture('') }), /is not valid JSON/);
});

test('the lint runs the OFFLINE half of the reconcile gate, so a dangling body reds CI', async () => {
  // The one refusal code that needs no live data. Without this the check would only ever fire during
  // an operator's reorder review, which is not a gate a PR passes through.
  const file = await fixture(
    manifestDoc({
      bodies: { crewneck: { colors: ['black'], sizes: ['m'] }, hoodie: { colors: ['black'], sizes: ['m'] } },
    })
  );
  await assert.rejects(checkCatalogue({ filePath: file }), /catalogue-dangling-body/);
});

test('the lint gives the module\'s curated refusal for a missing file, not a bare ENOENT', async () => {
  // The likeliest real CI failure is a rename or a bad merge deleting the file, and the message
  // needs to say who owns it rather than just naming an errno.
  await assert.rejects(checkCatalogue({ filePath: '/no/such/dir/catalogue.json' }), (err) => {
    assert.equal(err.fileMissing, true);
    assert.match(err.message, /hand-edited in a reviewed PR/);
    return true;
  });
});

// --- the count line, and CI's parse of it ------------------------------------

test('the success line matches the shape CI greps for its fail-closed floor', () => {
  // validate.yml parses this exact wording to assert the lint checked something. Pinning it here
  // means a reword fails locally instead of only in CI, where it reads as an unrelated failure.
  assert.equal(
    formatCounts({ bodies: 3, colors: 7, sizes: 18, products: 6, options: 4, cohesion: 16 }),
    'catalogue OK: 3 bodies, 7 colour values, 18 size values, 6 products, 4 option names, 16 cohesion checks.'
  );
});

test("CI's OWN sed and cut pipeline, run against this line, extracts all six counts", async () => {
  // The regex lives in validate.yml and the wording lives here, two files apart, with only a manual
  // pre-push check between them. This runs the workflow's actual shell against the actual string, so
  // a reword on either side fails here rather than silently disabling the floor in CI.
  const line = formatCounts({ bodies: 3, colors: 7, sizes: 18, products: 6, options: 4, cohesion: 16 });
  const workflow = await readFile(path.join(repoRoot, '.github/workflows/validate.yml'), 'utf8');

  const sedExpr = workflow.match(/sed -nE '(s\/\^catalogue OK:.*?)' \| tail -1/s)?.[1];
  assert.ok(sedExpr, 'the anchored sed expression is still findable in validate.yml');

  const { stdout } = await execFileAsync('bash', [
    '-c',
    'COUNTS=$(printf "%s\\n" "$LINE" | sed -nE "$SED_EXPR" | tail -1); ' +
      'for i in 1 2 3 4 5 6; do echo "$COUNTS" | cut -d" " -f"$i"; done',
    ], { env: { ...process.env, LINE: line, SED_EXPR: sedExpr } });

  assert.deepEqual(stdout.trim().split('\n'), ['3', '7', '18', '6', '4', '16']);
});

test("CI's pipeline extracts NOTHING from a reworded line, so the floor fails closed", async () => {
  const workflow = await readFile(path.join(repoRoot, '.github/workflows/validate.yml'), 'utf8');
  const sedExpr = workflow.match(/sed -nE '(s\/\^catalogue OK:.*?)' \| tail -1/s)?.[1];
  const { stdout } = await execFileAsync('bash', [
    '-c',
    'printf "%s\\n" "$LINE" | sed -nE "$SED_EXPR" | tail -1',
  ], {
    env: { ...process.env, LINE: 'catalogue OK: 3 bodies, 7 colours, 18 sizes.', SED_EXPR: sedExpr },
  });
  assert.equal(stdout.trim(), '', 'an unrecognised line yields no counts, which reds the build');
});

test('the workflow asserts all SIX counts against its -lt 1 floor, not the original three', async () => {
  const workflow = await readFile(path.join(repoRoot, '.github/workflows/validate.yml'), 'utf8');
  const floor = workflow.match(/if \[ "\$\{BODIES:-0\}" -lt 1 \][\s\S]*?then/)?.[0];
  assert.ok(floor, 'the vacuity floor is still findable');
  for (const name of ['BODIES', 'COLOURS', 'SIZES', 'PRODUCTS', 'OPTION_NAMES', 'COHESION']) {
    assert.match(floor, new RegExp(`\\$\\{${name}:-0\\}" -lt 1`), `${name} is in the floor`);
  }
});

test('the workflow captures the sed output ONCE and cuts that variable, rather than re-running the lint', async () => {
  const workflow = await readFile(path.join(repoRoot, '.github/workflows/validate.yml'), 'utf8');
  const start = workflow.indexOf('COUNTS=$(');
  assert.ok(start > -1, 'the counts capture is still findable');
  const block = workflow.slice(start, workflow.indexOf('echo "exit_code=$EXIT_CODE"', start));
  assert.equal((block.match(/COUNTS=\$\(/g) ?? []).length, 1, 'the lint output is parsed once');
  assert.equal((block.match(/echo "\$COUNTS" \| cut/g) ?? []).length, 6, 'all six cuts read the same variable');
});
