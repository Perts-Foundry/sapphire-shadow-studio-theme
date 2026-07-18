import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planRenames, loadRenameMap } from './process-product-images.mjs';

// --- planRenames: the auto (confident-only) path is unchanged -------------------------------
test('planRenames auto-renames a confident non-canonical name and skips uncertain ones', () => {
  const files = [
    'lead2-quarter-zip-black-emt-flat-1.jpg', // all-hyphen: a confident repair
    'huddle-flat.jpg',                        // one field: genuinely uncertain
    'lead2_crew-sweater_black_cna_flat-1.jpg', // already canonical: a no-op
  ];
  const { plan, skips } = planRenames(files, new Set(files));
  assert.deepEqual(plan.map((p) => [p.from, p.to, p.source]), [
    ['lead2-quarter-zip-black-emt-flat-1.jpg', 'lead2_quarter-zip_black_emt_flat-1.jpg', 'auto'],
  ]);
  assert.ok(skips.some((s) => s.startsWith('huddle-flat.jpg: uncertain')));
});

// --- planRenames: operator-approved overrides ----------------------------------------------
test('planRenames applies an operator-approved override for an otherwise-uncertain file', () => {
  const files = ['huddle-flat.jpg'];
  const overrides = new Map([['huddle-flat.jpg', 'huddle_crew-sweater_black_flat-1.jpg']]);
  const { plan, skips } = planRenames(files, new Set(files), overrides);
  assert.deepEqual(skips, []);
  assert.deepEqual(plan, [{
    from: 'huddle-flat.jpg', to: 'huddle_crew-sweater_black_flat-1.jpg', source: 'approved', warnings: [],
  }]);
});

test('planRenames normalises a loosely-formed approved name to the canonical form', () => {
  const files = ['huddle-flat.jpg'];
  // An all-hyphen approved target is recovered to the underscore canonical, same as a source name.
  const overrides = new Map([['huddle-flat.jpg', 'huddle-crew-sweater-black-flat-1']]);
  const { plan } = planRenames(files, new Set(files), overrides);
  assert.equal(plan[0].to, 'huddle_crew-sweater_black_flat-1.jpg');
});

test('planRenames REFUSES an approved name missing a field (not a clean convention name)', () => {
  const files = ['huddle-flat.jpg'];
  // Missing colorway -> only three fields -> uncertain -> refused, never renamed.
  const overrides = new Map([['huddle-flat.jpg', 'huddle_crew-sweater_flat-1.jpg']]);
  const { plan, skips } = planRenames(files, new Set(files), overrides);
  assert.deepEqual(plan, []);
  assert.ok(skips.some((s) => s.includes('not a clean convention name')));
});

test('planRenames refuses an approved name with an unknown closed-set token', () => {
  const files = ['x.jpg'];
  const overrides = new Map([['x.jpg', 'huddle_crew-sweater_chartreuse_flat-1.jpg']]);
  const { plan, skips } = planRenames(files, new Set(files), overrides);
  assert.deepEqual(plan, []);
  assert.ok(skips.some((s) => s.includes('not a clean convention name')));
});

test('planRenames flags an override whose `from` is not among the input images', () => {
  const files = ['a.jpg'];
  const overrides = new Map([['ghost.jpg', 'huddle_crew-sweater_black_flat-1.jpg']]);
  const { skips } = planRenames(files, new Set(files), overrides);
  assert.ok(skips.some((s) => s.includes('not among the input images')));
});

test('planRenames skips an approved target that collides with an existing file', () => {
  const files = ['huddle-flat.jpg', 'huddle_crew-sweater_black_flat-1.jpg'];
  const overrides = new Map([['huddle-flat.jpg', 'huddle_crew-sweater_black_flat-1.jpg']]);
  const { plan, skips } = planRenames(files, new Set(files), overrides);
  assert.deepEqual(plan, []);
  assert.ok(skips.some((s) => s.includes('already exists or is claimed')));
});

// --- loadRenameMap -------------------------------------------------------------------------
test('loadRenameMap parses a from,to CSV', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rmap-'));
  try {
    const p = path.join(dir, 'map.csv');
    await writeFile(p, 'from,to\nhuddle-flat.jpg,huddle_crew-sweater_black_flat-1.jpg\n');
    const m = await loadRenameMap(p);
    assert.equal(m.get('huddle-flat.jpg'), 'huddle_crew-sweater_black_flat-1.jpg');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('loadRenameMap rejects a CSV missing the required columns', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rmap-'));
  try {
    const p = path.join(dir, 'bad.csv');
    await writeFile(p, 'source,target\na,b\n');
    await assert.rejects(loadRenameMap(p), /needs a header row with 'from' and 'to'/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('loadRenameMap rejects a duplicate `from`', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rmap-'));
  try {
    const p = path.join(dir, 'dupe.csv');
    await writeFile(p, 'from,to\na.jpg,huddle_crew-sweater_black_flat-1.jpg\na.jpg,huddle_crew-sweater_black_flat-2.jpg\n');
    await assert.rejects(loadRenameMap(p), /more than once/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
