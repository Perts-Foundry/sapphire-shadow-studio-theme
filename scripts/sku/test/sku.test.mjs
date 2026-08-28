import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, stringOpt, REQUIRED_SCOPES } from '../sku.mjs';
import { missingScopes } from '../../blank-inventory/lib/admin.mjs';
import { checkTables } from '../check-tables.mjs';
import { defaultWorkDir, resolveWorkDir } from '../lib/workdir.mjs';
import path from 'node:path';

test('flags parse in both --flag value and --flag=value forms', () => {
  assert.deepEqual(parseArgs(['apply', '--plan', '/w/plan.json', '--dry-run']), {
    command: 'apply',
    _: [],
    plan: '/w/plan.json',
    dryRun: true,
  });
  assert.deepEqual(parseArgs(['plan', '--include-mismatches']), { command: 'plan', _: [], includeMismatches: true });
  assert.equal(parseArgs(['show', '--plan=/w/p.json']).plan, '/w/p.json');
  assert.deepEqual(parseArgs([]), { command: undefined, _: [] });
});

test('a bare --plan is refused rather than reaching readFile as a boolean', () => {
  const opts = parseArgs(['apply', '--plan', '--dry-run']);
  assert.equal(opts.plan, true);
  const errors = [];
  stringOpt('--plan', opts.plan, (m) => errors.push(m));
  assert.match(errors[0], /--plan needs a value, got true/);
  assert.equal(stringOpt('--plan', '/w/p.json'), '/w/p.json');
});

test('this tool asks for write_products and nothing wider', () => {
  assert.deepEqual(REQUIRED_SCOPES, ['write_products']);
  assert.deepEqual(missingScopes(['read_products'], REQUIRED_SCOPES), ['write_products']);
  assert.deepEqual(missingScopes(['write_products', 'read_products'], REQUIRED_SCOPES), []);
  // A tool that never touches inventory must not demand the inventory scope.
  assert.equal(REQUIRED_SCOPES.includes('write_inventory'), false);
});

test('the offline tables lint passes on the committed tables and counts what it checked', async () => {
  const { codes, products } = await checkTables();
  assert.equal(products, 6);
  assert.ok(codes >= 20);
});

test('the tables lint refuses a vacuous pass on tables with no products', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(path.join(tmpdir(), 'sku-lint-'));
  const file = path.join(dir, 'tables.json');
  await writeFile(file, JSON.stringify({ version: 2, colors: { black: 'BLK' }, products: {} }), 'utf8');
  // The manifest is a stub built by hand rather than parsed: a real one cannot declare zero
  // products, and the floor is defence-in-depth BEHIND the validator, so reaching it needs a
  // manifest the schema would refuse. The file is internally consistent (its one colour is
  // declared, its empty census matches), so nothing upstream of the floor objects.
  const emptyCensus = {
    options: new Map([['color', 'Color'], ['size', 'Size'], ['design', 'Design'], ['denomination', 'Denominations']]),
    colors: new Map([['black', { display: 'Black', slug: 'black' }]]),
    products: new Map(),
  };
  await assert.rejects(checkTables(file, emptyCensus), /must not pass/);
});

test('the working directory is outside any checkout and SKU_WORK_DIR overrides it', () => {
  const env = { HOME: '/home/x', XDG_STATE_HOME: '/state' };
  assert.equal(defaultWorkDir(env), path.join('/state', 'sku-tool'));
  assert.equal(resolveWorkDir({ ...env, SKU_WORK_DIR: 'rel/dir' }), path.resolve('rel/dir'));
  // A relative XDG_STATE_HOME is ignored rather than resolved against cwd.
  assert.match(defaultWorkDir({ XDG_STATE_HOME: 'relative' }), /[/\\]\.local[/\\]state[/\\]sku-tool$/);
});
