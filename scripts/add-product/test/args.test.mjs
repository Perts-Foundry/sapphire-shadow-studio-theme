import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AddProductError, assertHandle, loadTables, parseArgs, resolveHandles, tablesPath } from '../lib/args.mjs';
import { runMediaSurvey } from '../media-survey.mjs';
import { makeLogger } from './fixtures.mjs';

const TABLES = {
  products: {
    'lead-ii-crewneck': { designNamespace: 'lead-ii' },
    'lead-ii-quarter-zip': { designNamespace: 'lead-ii' },
    'huddle-crewneck': { designNamespace: 'huddle' },
    'shift-fuel-tote': {},
  },
};

test('an unknown flag is an error that names the flag', () => {
  assert.throws(() => parseArgs(['--nope'], { booleans: ['--help'] }), /--nope is not a flag/);
});

test('a value flag with no value is an error rather than a silent null', () => {
  assert.throws(() => parseArgs(['--handle'], { values: ['--handle'] }), /--handle expects a value/);
});

test('both --flag=value and --flag value parse, and repeatables accumulate', () => {
  const { flags, positionals } = parseArgs(
    ['set', 'skus', '--handle=a,b', '--evidence', 'one', '--evidence=two', '--all-handles'],
    { booleans: ['--all-handles'], values: ['--handle'], repeatables: ['--evidence'] },
  );
  assert.deepEqual(positionals, ['set', 'skus']);
  assert.equal(flags.handle, 'a,b');
  assert.deepEqual(flags.evidence, ['one', 'two']);
  assert.equal(flags.allHandles, true);
});

test('a boolean flag given a value is an error, not a truthy string', () => {
  assert.throws(() => parseArgs(['--dry-run=yes'], { booleans: ['--dry-run'] }), /--dry-run takes no value/);
});

test('--all requires --namespace', () => {
  assert.throws(() => resolveHandles({ all: true }, { tables: TABLES }), /--all requires --namespace/);
});

test('--all and --handle together is an error', () => {
  assert.throws(() => resolveHandles({ all: true, namespace: 'lead-ii', handle: 'a' }, { tables: TABLES }), /mutually exclusive/);
});

test('--all --namespace derives the namespace members in file order', () => {
  assert.deepEqual(resolveHandles({ all: true, namespace: 'lead-ii' }, { tables: TABLES }), [
    'lead-ii-crewneck',
    'lead-ii-quarter-zip',
  ]);
});

test('a namespace nothing matches is an error rather than an empty run', () => {
  assert.throws(() => resolveHandles({ all: true, namespace: 'nope' }, { tables: TABLES }), /matches no product/);
});

test('a bad handle is refused, never sanitised', () => {
  assert.throws(() => resolveHandles({ handle: 'Lead II Crewneck' }), AddProductError);
  assert.throws(() => resolveHandles({ handle: 'lead_ii' }), /is not a valid handle/);
  assert.throws(() => assertHandle('lead-ii-crewneck '), /is not a valid handle/);
  assert.equal(assertHandle('lead-ii-crewneck'), 'lead-ii-crewneck');
});

test('a repeated handle is an error, so a multi-handle write cannot double-write one product', () => {
  assert.throws(() => resolveHandles({ handle: 'a,b,a' }), /is named twice/);
});

test('the real SKU tables resolve a real namespace', () => {
  const handles = resolveHandles({ all: true, namespace: 'lead-ii' }, { tables: loadTables(tablesPath()) });
  assert.ok(handles.includes('lead-ii-crewneck'));
  assert.ok(handles.every((h) => /^[a-z0-9-]+$/.test(h)));
});

test('--help prints usage and exits 0 without reading anything', async () => {
  const out = makeLogger();
  const code = await runMediaSurvey({
    argv: ['--help'],
    log: out.write,
    errLog: out.write,
    loadProducts: async () => {
      throw new Error('--help must not read the store');
    },
  });
  assert.equal(code, 0);
  assert.match(out.text(), /Usage: media-survey\.mjs/);
});
