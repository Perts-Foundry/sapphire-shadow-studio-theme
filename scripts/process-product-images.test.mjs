import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import {
  planRenames, loadRenameMap, planManifestRows, readExistingManifest, altGuardProblems,
  profileName, underProductImages, prepareInput,
} from './process-product-images.mjs';

const execFileP = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('./process-product-images.mjs', import.meta.url));

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

// --- planManifestRows ----------------------------------------------------------------------
const EMPTY_D = { line: '', garment: '', colorway: '', admin_color: '', product: '', shot: '' };
const RESOLVED_D = { line: 'huddle', garment: 'crew-sweater', colorway: 'black', admin_color: 'Black', product: 'huddle-crewneck', shot: 'flat' };

test('planManifestRows fans a shared asset out across preserved per-product rows', () => {
  const preservedRows = [
    { alt: 'alt one', upload_status: 'created', product: 'huddle-crewneck', line: '', garment: '' },
    { alt: 'alt two', upload_status: '', product: 'lead-ii-crewneck', line: '', garment: '' },
  ];
  const { fanOut, seeds, warnings } = planManifestRows(EMPTY_D, preservedRows);
  assert.equal(fanOut, true);
  assert.deepEqual(warnings, []);
  assert.equal(seeds.length, 2);
  // Preserved order, per-row alt and upload_status independence, blank admin_color.
  assert.deepEqual(seeds.map((s) => [s.product, s.alt, s.upload_status, s.admin_color]), [
    ['huddle-crewneck', 'alt one', 'created', ''],
    ['lead-ii-crewneck', 'alt two', '', ''],
  ]);
});

test('planManifestRows keeps the first row and warns when a resolving name has several preserved rows', () => {
  const preservedRows = [
    { alt: 'first', upload_status: 'created', product: 'huddle-crewneck', line: 'huddle', garment: 'crew-sweater' },
    { alt: 'second', upload_status: '', product: 'lead-ii-crewneck', line: '', garment: '' },
  ];
  const { fanOut, seeds, warnings } = planManifestRows(RESOLVED_D, preservedRows);
  assert.equal(fanOut, false);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].alt, 'first');
  assert.equal(seeds[0].product, 'huddle-crewneck'); // the derived product, not a preserved one
  assert.ok(warnings.some((w) => w.includes('keeping the first')));
});

test('planManifestRows emits the plain single row when nothing is preserved', () => {
  const { fanOut, seeds, warnings } = planManifestRows(RESOLVED_D, []);
  assert.equal(fanOut, false);
  assert.deepEqual(warnings, []);
  assert.deepEqual(seeds, [{ ...RESOLVED_D, alt: '', upload_status: '' }]);
});

test('planManifestRows does not fan out when no preserved row carries a product', () => {
  const preservedRows = [{ alt: 'kept', upload_status: 'x', product: '', line: '', garment: '' }];
  const { fanOut, seeds } = planManifestRows(EMPTY_D, preservedRows);
  assert.equal(fanOut, false);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].alt, 'kept');
});

// --- altGuardProblems: shared fan-out rows -------------------------------------------------
test('altGuardProblems guards shared rows via productForHandle', () => {
  const rows = [
    // Shared row naming a colour value of its product: flagged (it would bind, not stay shared).
    { new_name: 'x.jpg', line: '', garment: '', admin_color: '', product: 'huddle-crewneck', alt: 'Black logo tag close-up' },
    // Shared row with a colour-free alt: passes.
    { new_name: 'y.jpg', line: '', garment: '', admin_color: '', product: 'huddle-crewneck', alt: 'Woven logo tag close-up' },
    // Unknown handle: a guard problem, never a throw.
    { new_name: 'z.jpg', line: '', garment: '', admin_color: '', product: 'no-such-product', alt: 'anything' },
  ];
  const problems = altGuardProblems(rows);
  assert.ok(problems.some((p) => p.startsWith('x.jpg:') && p.includes('would bind instead of staying shared')));
  assert.ok(!problems.some((p) => p.startsWith('y.jpg:')));
  assert.ok(problems.some((p) => p.startsWith('z.jpg:') && p.includes('not a recorded product')));
});

// --- profileName ---------------------------------------------------------------------------
test('profileName reads plain latin1 and UTF-16BE mluc descriptions', () => {
  assert.equal(profileName(null), 'no-profile');
  assert.equal(profileName(Buffer.from('....sRGB IEC61966-2.1....', 'latin1')), 'sRGB');
  // Apple's Display P3 description is UTF-16BE: every character preceded by a NUL byte.
  const utf16be = Buffer.concat(
    [...'Display P3'].map((c) => Buffer.from([0, c.charCodeAt(0)])),
  );
  assert.equal(profileName(utf16be), 'Display P3');
  assert.equal(profileName(Buffer.from('no keywords here', 'latin1')), 'other-profile');
});

test('profileName cross-boundary concatenation is an accepted false positive (pinned)', () => {
  // NUL-stripping can join unrelated byte runs into a keyword. Accepted: the label is a cosmetic
  // audit note and the colour conversion never reads it. This test pins the trade-off so a future
  // "fix" is a deliberate decision, not an accident.
  const buf = Buffer.from('Disp  lay P3', 'latin1');
  assert.equal(profileName(buf), 'Display P3');
});

// --- underProductImages --------------------------------------------------------------------
test('underProductImages contains writes to product-images/ paths only', () => {
  assert.equal(underProductImages('/tmp/x/product-images/processed'), true);
  assert.equal(underProductImages('product-images'), true);
  assert.equal(underProductImages('/tmp/elsewhere/out'), false);
  assert.equal(underProductImages('/tmp/product-imagesx/out'), false);
});

// --- prepareInput (HEIC branch, injected decoder; no HEIC binary in git) -------------------
const RAW_2X2 = () => ({
  width: 2,
  height: 2,
  data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]).buffer,
});

test('prepareInput passes non-HEIC inputs through untouched', async () => {
  assert.deepEqual(await prepareInput('photo.jpg'), { input: 'photo.jpg', notes: [] });
  assert.deepEqual(await prepareInput('scan.TIF'), { input: 'scan.TIF', notes: [] });
});

test('prepareInput decodes a HEIC and carries its embedded ICC profile', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'ppi-heic-'));
  try {
    // Harvest a REAL sRGB ICC profile from sharp itself, so withIccProfile gets valid bytes.
    const donor = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ffffff' } })
      .png().withIccProfile('srgb').toBuffer();
    const { icc } = await sharp(donor).metadata();
    assert.ok(icc && icc.length >= 128, 'donor PNG must carry an ICC profile');
    // Wrap the profile in a colr/prof box inside an otherwise-junk "HEIC" file.
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + 4 + icc.length, 0);
    head.write('colr', 4);
    const fake = Buffer.concat([Buffer.alloc(16, 0xab), head, Buffer.from('prof'), icc]);
    const p = path.join(base, 'fake.heic');
    await writeFile(p, fake);

    const { input, notes } = await prepareInput(p, { decode: async () => RAW_2X2() });
    assert.ok(Buffer.isBuffer(input));
    assert.ok(notes.some((n) => n.startsWith('heic-decoded (heic-decode ')));
    assert.ok(!notes.some((n) => n.includes('assuming sRGB')));
    const meta = await sharp(input).metadata();
    assert.equal(meta.format, 'png');
    assert.equal(meta.width, 2);
    assert.equal(meta.hasAlpha, false);
    assert.ok(meta.icc, 'the embedded profile must ride through to the PNG');
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('prepareInput warns assuming-sRGB when the HEIC carries no ICC, distinguishing nclx', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'ppi-heic-'));
  try {
    const bare = path.join(base, 'bare.heic');
    await writeFile(bare, Buffer.alloc(32, 0xab));
    const bareResult = await prepareInput(bare, { decode: async () => RAW_2X2() });
    assert.ok(bareResult.notes.some((n) => n === 'no colour info in HEIC; assuming sRGB'));

    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + 4 + 7, 0);
    head.write('colr', 4);
    const nclx = path.join(base, 'nclx.heic');
    await writeFile(nclx, Buffer.concat([head, Buffer.from('nclx'), Buffer.alloc(7)]));
    const nclxResult = await prepareInput(nclx, { decode: async () => RAW_2X2() });
    assert.ok(nclxResult.notes.some((n) => n === 'nclx colour info present, ICC absent; assuming sRGB'));
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('prepareInput propagates a decoder failure (corrupt HEIC) as a throw', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'ppi-heic-'));
  try {
    const p = path.join(base, 'corrupt.heic');
    await writeFile(p, Buffer.alloc(16, 0xab));
    await assert.rejects(
      () => prepareInput(p, { decode: async () => { throw new Error('format not supported'); } }),
      /format not supported/,
    );
  } finally { await rm(base, { recursive: true, force: true }); }
});

// --- integration: shared-asset manifest round-trip through the real CLI --------------------
// One spawn-based test pins the behaviours that only exist end to end: hand-authored fan-out
// rows surviving a reprocess (with CSV-quoted alt payloads and per-row upload_status), the
// file-based (not row-based) --verify count, and rows vanishing when their original is removed.
const CSV_HANDLES = [
  'lead-ii-crewneck', 'lead-ii-quarter-zip', 'lead-ii-vest-womens', 'shift-fuel-crewneck', 'huddle-crewneck',
];

function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { cells.push(cur); cur = ''; }
    else cur += c;
  }
  cells.push(cur);
  return cells;
}
const csvCell = (v) => (/[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

test('shared-asset rows survive a reprocess and vanish with their original (CLI round-trip)', { timeout: 120000 }, async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'ppi-'));
  try {
    const { mkdir, copyFile, unlink } = await import('node:fs/promises');
    const inDir = path.join(base, 'originals');
    const outDir = path.join(base, 'product-images', 'processed'); // satisfies the containment guard
    const manifestPath = path.join(outDir, 'manifest.csv');
    await mkdir(inDir, { recursive: true });
    const seed = path.join(base, 'seed.jpg');
    await sharp({ create: { width: 32, height: 24, channels: 3, background: '#808080' } }).jpeg().toFile(seed);
    await copyFile(seed, path.join(inDir, 'logo-tag-closeup-1.jpg'));
    await copyFile(seed, path.join(inDir, 'huddle_crew-sweater_black_flat-1.jpg'));

    const runCli = (...args) => execFileP(process.execPath, [SCRIPT, ...args]);

    // Run 1: the shared file emits one row with an empty product.
    await runCli('--input-dir', inDir, '--out', outDir);
    let lines = (await readFile(manifestPath, 'utf8')).split(/\r?\n/).filter((l) => l.length);
    const header = parseCsvLine(lines[0]);
    const col = (name) => header.indexOf(name);
    const logoRows = lines.slice(1).map(parseCsvLine).filter((c) => c[col('new_name')] === 'logo-tag-closeup-1.jpg');
    assert.equal(logoRows.length, 1);
    assert.equal(logoRows[0][col('product')], '');

    // Hand-author the fan-out: replace the single logo row with five per-product rows, each with
    // a CSV-hostile alt (commas + quotes) and its own upload_status.
    const template = logoRows[0];
    const fanned = CSV_HANDLES.map((handle, i) => {
      const cells = [...template];
      cells[col('product')] = handle;
      cells[col('alt')] = `Woven logo tag, close-up "detail" for ${handle}`;
      cells[col('upload_status')] = i === 0 ? 'created' : `status-${i}`;
      return cells.map(csvCell).join(',');
    });
    const kept = lines.filter((l, i) => i > 0 && parseCsvLine(l)[col('new_name')] !== 'logo-tag-closeup-1.jpg');
    await writeFile(manifestPath, [lines[0], ...fanned, ...kept].join('\n') + '\n');

    // The preservation reader sees five rows for the one name, in order.
    const preserved = await readExistingManifest(manifestPath);
    assert.equal(preserved.get('logo-tag-closeup-1.jpg').length, 5);
    assert.deepEqual(preserved.get('logo-tag-closeup-1.jpg').map((p) => p.product), CSV_HANDLES);

    // Run 2 (reprocess, same out): the five hand-authored rows survive intact.
    await runCli('--input-dir', inDir, '--out', outDir);
    lines = (await readFile(manifestPath, 'utf8')).split(/\r?\n/).filter((l) => l.length);
    const rows2 = lines.slice(1).map(parseCsvLine);
    const logo2 = rows2.filter((c) => c[col('new_name')] === 'logo-tag-closeup-1.jpg');
    assert.equal(logo2.length, 5);
    assert.deepEqual(logo2.map((c) => c[col('product')]), CSV_HANDLES); // ordering stability
    for (const [i, c] of logo2.entries()) {
      assert.equal(c[col('alt')], `Woven logo tag, close-up "detail" for ${CSV_HANDLES[i]}`); // quoting round-trip
      assert.equal(c[col('upload_status')], i === 0 ? 'created' : `status-${i}`); // per-row status independence
      assert.equal(c[col('admin_color')], ''); // shared rows stay colour-free
    }
    assert.equal(rows2.filter((c) => c[col('new_name')] === 'huddle_crew-sweater_black_flat-1.jpg').length, 1);

    // --verify counts FILES, not manifest rows: 2 output files vs 6 rows must pass.
    await runCli('--verify', '--out', outDir, '--input-dir', inDir);

    // Run 3: removing the original drops its rows (deliberate; documented in the skill).
    await unlink(path.join(inDir, 'logo-tag-closeup-1.jpg'));
    await runCli('--input-dir', inDir, '--out', outDir);
    lines = (await readFile(manifestPath, 'utf8')).split(/\r?\n/).filter((l) => l.length);
    const rows3 = lines.slice(1).map(parseCsvLine);
    assert.equal(rows3.filter((c) => c[col('new_name')] === 'logo-tag-closeup-1.jpg').length, 0);
    assert.equal(rows3.filter((c) => c[col('new_name')] === 'huddle_crew-sweater_black_flat-1.jpg').length, 1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
