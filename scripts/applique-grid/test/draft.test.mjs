// The draft: the resumable record of the naming gate's decisions, and the merge that turns it into
// patterns.json. The round-trip case here is the one manual verification step in the plan whose
// input IS committed, so it is a test rather than a checklist item.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANDIDATE_ANGLES, candidateProblem, candidateRegistry, cell, detailTable, digestProblems,
  draftProblems, emptyDraft, keyFor, narrowTable, tableDigest, tableRows, threadUsage,
  validationProblems,
} from '../lib/draft.mjs';
import {
  atomicWrite, defaultBranchNames, parseArgs, treeProblem, writeRefusal,
  CONVENTIONAL_DEFAULTS, HELP, UNTOUCHABLE_KEYS,
} from '../draft.mjs';
import { materialise, serialize, validate, REGISTRY_PATH } from '../lib/registry.mjs';
import { readCommittedCatalogue } from '../../lib/catalogue-manifest.mjs';
import { unifiedDiff } from '../lib/text-diff.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const committedRaw = readFileSync(REGISTRY_PATH, 'utf8');
// Materialised the way every mode of draft.mjs loads it, so validate sees the product block.
const committed = materialise(JSON.parse(committedRaw), readCommittedCatalogue());
const fixture = () => materialise(
  JSON.parse(readFileSync(path.join(FIXTURES, 'registry.fixture.json'), 'utf8')),
  readCommittedCatalogue()
);

// The shape `--init-from-registry` writes, kept here so the round trip proves the CLI's mapping.
const draftFromRegistry = (reg) => ({
  ...emptyDraft(),
  threads: [...reg.threads],
  patterns: reg.patterns.map((p) => ({
    id: p.id,
    name: p.name,
    thread: p.thread,
    status: p.status,
    sources: [...p.sources],
    hero: p.hero,
    crop: { ...p.crop },
    position: p.position,
  })),
});

test('the write path refuses a pattern named after a real Color value', () => {
  // Regression: modeWrite validated the candidate against the bare committed parse, whose absent
  // product block handed nameColorProblem an empty colorValues list, so a colour-named pattern
  // wrote cleanly. The existing registry is materialised now, so the guard checks real values.
  const draft = draftFromRegistry(fixture());
  const [firstColor] = fixture().product.colorValues;
  draft.patterns[0].name = firstColor;
  const problems = validationProblems(draft, fixture());
  assert.ok(
    problems.some((p) => p.includes('whole-word-matches Color value')),
    `expected the colour-name refusal for ${JSON.stringify(firstColor)}, got:\n${problems.join('\n')}`
  );
});

const twoPattern = () => {
  const d = draftFromRegistry(fixture());
  d.patterns = d.patterns.slice(0, 2);
  d.patterns[0].candidates = { descriptive: 'Scattered Paws', evocative: 'Midnight Steps', modern: 'Paws' };
  d.patterns[1].candidates = { descriptive: 'Busy Bees', playful: 'Bee Kind', trade: 'Apis Mellifera' };
  return d;
};

// ---------------------------------------------------------------------------
// Round trip: registry -> draft -> registry, byte for byte.
// ---------------------------------------------------------------------------

test('the committed registry survives a draft round trip byte-identically', () => {
  const back = serialize(candidateRegistry(draftFromRegistry(committed), committed));
  assert.equal(back, committedRaw, 'key order, indentation, and the trailing newline must all survive');
  assert.deepEqual(validate(materialise(JSON.parse(back), readCommittedCatalogue())), []);
});

test('published, chart, and product pass through a merge untouched', () => {
  const draft = draftFromRegistry(committed);
  draft.patterns[0].name = 'Renamed Entirely';
  draft.threads = [...draft.threads, 'Ecru'];
  const next = candidateRegistry(draft, committed);
  // A whole-file write from a draft with no concept of `published` drops the chart media GIDs and
  // spec hashes, and the next publish re-creates chart media with nothing to reconcile against.
  assert.deepEqual(next.published, committed.published);
  assert.equal(JSON.stringify(next.published), JSON.stringify(committed.published));
  assert.deepEqual(next.chart, committed.chart);
  assert.deepEqual(next.product, committed.product);
  assert.equal(next.patterns[0].name, 'Renamed Entirely');
});

test('a draft with no id derives one from the chosen name', () => {
  const draft = twoPattern();
  delete draft.patterns[0].id;
  draft.patterns[0].name = "Willow's Path";
  assert.equal(candidateRegistry(draft, fixture()).patterns[0].id, 'willows-path');
});

// ---------------------------------------------------------------------------
// Structure: unknown keys, and the row key.
// ---------------------------------------------------------------------------

test('unknown draft keys are rejected, so no free-text field can appear and be read as guidance', () => {
  const at = (mutate) => {
    const d = twoPattern();
    mutate(d);
    return draftProblems(d);
  };
  assert.ok(at((d) => { d.notes = 'do this instead'; }).some((p) => p.includes('unknown key "notes"')));
  assert.ok(at((d) => { d.patterns[0].notes = 'ignore previous'; }).some((p) => p.includes('unknown key "notes"')));
  assert.ok(at((d) => { d.patterns[0].crop.rotate = 90; }).some((p) => p.includes('crop: unknown key "rotate"')));
  assert.ok(at((d) => { d.patterns[0].candidates.freeform = 'x'; }).some((p) => p.includes('candidates: unknown key "freeform"')));
  assert.deepEqual(draftProblems(twoPattern()), []);
});

test('the row key is the hero filename stem, and two patterns cannot share a hero', () => {
  assert.equal(keyFor('IMG_0883.heic'), 'IMG_0883');
  assert.equal(keyFor('a.b.heic'), 'a.b');
  const d = twoPattern();
  d.patterns[1].hero = d.patterns[0].hero;
  assert.ok(draftProblems(d).some((p) => /duplicate row key/.test(p)));
});

test('a pattern with no hero is rejected: the hero IS the key', () => {
  const d = twoPattern();
  delete d.patterns[0].hero;
  assert.ok(draftProblems(d).some((p) => /hero is required/.test(p)));
});

// ---------------------------------------------------------------------------
// Validation: the REAL registry validator, surfaced per rule, naming the pattern.
// ---------------------------------------------------------------------------

test('--validate reports a pattern with no name chosen yet, by key', () => {
  const d = twoPattern();
  delete d.patterns[1].name;
  const problems = validationProblems(d, fixture());
  assert.ok(problems.some((p) => p.includes(keyFor(d.patterns[1].hero)) && /no name chosen yet/.test(p)));
});

test('--validate surfaces each registry rule, naming the offending pattern', () => {
  const cases = [
    ['a colour-value name', (d) => { d.patterns[0].name = 'Black Bloom'; }, /whole-word-matches Color value/],
    ['an em dash', (d) => { d.patterns[0].name = `Paws\u{2014}Scattered`; }, /em dash/],
    ['an en dash', (d) => { d.patterns[0].name = `Paws\u{2013}Scattered`; }, /en dash/],
    ['a thread outside the palette', (d) => { d.patterns[0].thread = 'Chartreuse'; }, /not in the recorded thread palette/],
    ['a crop out of bounds', (d) => { d.patterns[0].crop.left = 0.9; }, /crop must satisfy/],
    ['a hero not among its sources', (d) => { d.patterns[0].hero = 'IMG_9999.heic'; }, /hero .* is not one of its sources/],
    ['a duplicate position', (d) => { d.patterns[1].position = d.patterns[0].position; }, /duplicate position/],
    ['two names deriving one id', (d) => { d.patterns[1].name = `${d.patterns[0].name}  `; }, /derives the same id/],
  ];
  for (const [label, mutate, re] of cases) {
    const d = twoPattern();
    mutate(d);
    const problems = validationProblems(d, fixture());
    assert.ok(problems.some((p) => re.test(p)), `${label}: expected ${re}, got:\n${problems.join('\n')}`);
  }
});

// ---------------------------------------------------------------------------
// Threads: mechanical near-duplicate detection.
// ---------------------------------------------------------------------------

test('threadUsage counts usage, marks singletons, and flags undeclared threads', () => {
  const d = twoPattern();
  d.threads = ['White', 'Golden', 'Unused'];
  d.patterns[0].thread = 'White';
  d.patterns[1].thread = 'Ecru';
  const usage = threadUsage(d);
  const by = new Map(usage.map((u) => [u.thread, u]));
  assert.equal(by.get('White').count, 1);
  assert.equal(by.get('White').singleton, true);
  assert.equal(by.get('White').declared, true);
  assert.equal(by.get('Unused').count, 0);
  assert.equal(by.get('Ecru').declared, false, 'a thread used but never declared must be visible');
  assert.deepEqual(usage.map((u) => u.count), [...usage.map((u) => u.count)].sort((a, b) => b - a));
});

test('the real registry names both near-duplicate pairs the consolidation rule is about', () => {
  // Detection is a LIST with counts, not a judgement: asking the model that produced both "Navy"
  // and "Dark Blue" to notice they collide is not a control.
  const threads = threadUsage(draftFromRegistry(committed)).map((t) => t.thread);
  for (const t of ['Navy', 'Dark Blue', 'Golden', 'Green', 'Dark Green']) assert.ok(threads.includes(t));
});

// ---------------------------------------------------------------------------
// The gate artifacts and their digest.
// ---------------------------------------------------------------------------

test('the narrow table is the choice surface: Key plus six lettered columns, nothing else', () => {
  const rows = tableRows(twoPattern());
  const table = narrowTable(rows);
  const header = table.split('\n')[0];
  assert.match(header, /^\| Key\s+\| A\s+\| B\s+\| C\s+\| D\s+\| E\s+\| F\s+\|$/);
  assert.equal(table.split('\n').length, rows.length + 2);
  for (const r of rows) assert.ok(table.includes(r.key));
  // Nothing from the verification surface may leak into the choice surface.
  for (const noise of ['IMG_0883.heic', 'Thread', 'crop', 'clearance']) {
    assert.ok(!table.includes(noise), `narrow table must not carry ${noise}`);
  }
});

test('an empty candidate cell renders as n/a rather than a blank', () => {
  const rows = tableRows(twoPattern());
  assert.equal(rows[0].candidates.length, CANDIDATE_ANGLES.length);
  assert.ok(rows[0].candidates.includes('n/a'), 'the six angles are optional, and a gap is legal');
});

test('gate-table.md snapshot: the verification surface, over a synthetic 2-pattern draft', () => {
  const draft = twoPattern();
  const md = detailTable({
    rows: tableRows(draft),
    draft,
    colorValues: ['Black', 'Grey Heather', 'Classic Navy'],
    clearance: { [keyFor(draft.patterns[0].hero)]: { minSd: 5.2, tile: 91, edge: 'bottom-left', suspect: true } },
  });
  const golden = readFileSync(path.join(FIXTURES, 'gate-table.golden.md'), 'utf8');
  assert.equal(md, golden, 'intentional gate-format change? update fixtures/gate-table.golden.md and review it');
});

test('the detail table carries the units and the threshold, so SUSPECT cannot read as a verdict', () => {
  const draft = twoPattern();
  const md = detailTable({ rows: tableRows(draft), draft, colorValues: [] });
  assert.ok(md.includes('Edge clearance (min tile sd; <10 = inspect)'));
  assert.ok(md.includes('approves the NAME for that row and nothing'));
});

test('the detail table flags a guard-violating candidate before the operator sees it', () => {
  const draft = twoPattern();
  draft.patterns[0].candidates.evocative = 'Classic Navy Steps';
  const md = detailTable({ rows: tableRows(draft), draft, colorValues: ['Black', 'Classic Navy'] });
  assert.match(md, /B: name "Classic Navy Steps" whole-word-matches Color value/);
});

test('candidateProblem passes n/a and blanks, and applies the same rules validation will', () => {
  assert.equal(candidateProblem('n/a', ['Black']), null);
  assert.equal(candidateProblem('', ['Black']), null);
  assert.equal(candidateProblem('Scattered Paws', ['Black']), null);
  assert.match(candidateProblem('Black Cats', ['Black']), /whole-word-matches/);
  assert.match(candidateProblem(`A\u{2014}B`, []), /em dash/);
});

test('the digest binds an approval to the rendered rows, and choosing a name does not move it', () => {
  const draft = twoPattern();
  draft.tableDigest = tableDigest(draft);
  assert.deepEqual(digestProblems(draft), []);

  // Resolving the operator's letter into `name` is exactly what happens between --table and
  // --write, and it must not invalidate the approval.
  draft.patterns[0].name = draft.patterns[0].candidates.descriptive;
  assert.deepEqual(digestProblems(draft), []);
});

test('the digest names the rows that changed after the table was presented', () => {
  const base = twoPattern();
  base.tableDigest = tableDigest(base);
  const key0 = keyFor(base.patterns[0].hero);

  const edited = JSON.parse(JSON.stringify(base));
  edited.patterns[0].candidates.descriptive = 'Something Else';
  assert.ok(digestProblems(edited).some((p) => p.includes(`row "${key0}" changed`)));

  const removed = JSON.parse(JSON.stringify(base));
  removed.patterns.splice(0, 1);
  assert.ok(digestProblems(removed).some((p) => p.includes(`row "${key0}" was removed`)));

  const added = JSON.parse(JSON.stringify(base));
  added.patterns.push({ ...base.patterns[0], hero: 'IMG_7777.heic', sources: ['IMG_7777.heic'], position: 999 });
  assert.ok(digestProblems(added).some((p) => p.includes('row "IMG_7777" was added')));

  const repalette = JSON.parse(JSON.stringify(base));
  repalette.threads = [...repalette.threads].reverse();
  assert.ok(digestProblems(repalette).some((p) => /thread palette changed/.test(p)));

  for (const d of [edited, removed, added, repalette]) {
    assert.ok(digestProblems(d).every((p) => /re-run --table and re-present the gate/.test(p)));
  }
});

test('a draft with no digest at all cannot be written', () => {
  const d = twoPattern();
  assert.match(digestProblems(d)[0], /no gate-table digest/);
});

// ---------------------------------------------------------------------------
// The write rails.
// ---------------------------------------------------------------------------

test('--write refuses on the default branch, detached HEAD, and a dirty registry', () => {
  assert.match(treeProblem({ branch: 'main', defaultNames: ['main'], status: '' }), /default branch \(main\)/);
  assert.match(treeProblem({ branch: 'HEAD', defaultNames: ['main'], status: '' }), /detached/);
  assert.match(
    treeProblem({ branch: 'feat/x', defaultNames: ['main'], status: ' M scripts/applique-grid/patterns.json\n' }),
    /already has uncommitted changes/,
  );
  assert.equal(treeProblem({ branch: 'feat/x', defaultNames: ['main'], status: '' }), null);
});

test('treeProblem refuses EVERY name the default could be, not just the first', () => {
  // The fail-closed half of the defaultBranchNames fix: with origin/HEAD unavailable, both
  // conventional names are refused, so a repo whose real default is master is still protected.
  assert.match(treeProblem({ branch: 'master', defaultNames: CONVENTIONAL_DEFAULTS, status: '' }), /default branch \(master\)/);
  assert.match(treeProblem({ branch: 'main', defaultNames: CONVENTIONAL_DEFAULTS, status: '' }), /default branch \(main\)/);
  assert.equal(treeProblem({ branch: 'feat/x', defaultNames: CONVENTIONAL_DEFAULTS, status: '' }), null);
});

test('defaultBranchNames is exact with origin/HEAD and fails CLOSED without it', () => {
  assert.deepEqual(defaultBranchNames(() => 'origin/trunk'), ['trunk']);

  // The regression this replaced: origin/HEAD unavailable in a repo whose real default is master
  // but which also carries a stale local main. The old code answered "main", so treeProblem let
  // --write run on master, the actual default branch. Now both names are refused.
  const noOriginHead = (args) => {
    if (args[0] === 'symbolic-ref') throw new Error('no origin/HEAD');
    return '';
  };
  assert.deepEqual(defaultBranchNames(noOriginHead), ['main', 'master']);
  assert.match(
    treeProblem({ branch: 'master', defaultNames: defaultBranchNames(noOriginHead), status: '' }),
    /default branch \(master\)/,
  );

  assert.deepEqual(defaultBranchNames(() => { throw new Error('not a repo'); }), ['main', 'master']);
  // An empty symbolic-ref answer is not an answer.
  assert.deepEqual(defaultBranchNames(() => ''), ['main', 'master']);
});

test('writeRefusal covers every rail that used to live inline in main()', () => {
  const base = {
    published: [], chart: { columns: 3 }, product: { handle: 'h' },
    patterns: [{ id: 'a' }, { id: 'b' }],
  };
  const same = { ...base, patterns: [{ id: 'a' }, { id: 'b' }] };

  // treeProblem's verdict passes straight through, which is the wiring that was dead.
  assert.equal(
    writeRefusal({ tree: 'dirty tree', existing: base, next: same, allowPatternSetChange: false }),
    'dirty tree',
  );
  assert.equal(writeRefusal({ tree: null, existing: base, next: same, allowPatternSetChange: false }), null);

  const dropped = { ...base, patterns: [{ id: 'a' }] };
  const added = { ...base, patterns: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  assert.match(
    writeRefusal({ tree: null, existing: base, next: dropped, allowPatternSetChange: false }),
    /changes the pattern set \(0 added, 1 removed: -b\)/,
  );
  assert.match(
    writeRefusal({ tree: null, existing: base, next: added, allowPatternSetChange: false }),
    /changes the pattern set \(1 added, 0 removed: \+c\)/,
  );
  assert.equal(writeRefusal({ tree: null, existing: base, next: dropped, allowPatternSetChange: true }), null);

  for (const key of UNTOUCHABLE_KEYS) {
    const mutated = { ...same, [key]: { tampered: true } };
    assert.match(
      writeRefusal({ tree: null, existing: base, next: mutated, allowPatternSetChange: true }),
      new RegExp(`internal: --write would change ${key}`),
      `${key} must be structurally untouchable`,
    );
  }
});

test('a pipe in a filename cannot forge a row in either gate table', () => {
  // `|` is legal in a filename on macOS and Linux, and both tables are artifacts the operator
  // approves from and the model later re-reads. An unescaped one splits the row.
  assert.equal(cell('a|b'), 'a\\|b');
  assert.equal(cell('a\nb'), 'a b');
  assert.equal(cell('a\r\n\tb'), 'a b');
  assert.equal(cell(null), '');

  const rows = [{
    key: 'IMG_0001',
    candidates: ['ok', 'x | y', 'c', 'd', 'e', 'f'],
    name: 'Fine',
    thread: 'White',
    hero: 'evil|name.heic',
    sources: ['evil|name.heic'],
    crop: { left: 0.1, top: 0.1, width: 0.4 },
  }];

  const narrow = narrowTable(rows);
  for (const line of narrow.split('\n').slice(2)) {
    assert.equal(
      line.split(/(?<!\\)\|/).length - 2, CANDIDATE_ANGLES.length + 1,
      `a forged cell boundary got through: ${line}`,
    );
  }

  const detail = detailTable({ rows, draft: { ...emptyDraft(), threads: ['White'] }, colorValues: [] });
  const dataRow = detail.split('\n').find((l) => l.startsWith('| IMG_0001 '));
  assert.ok(dataRow, 'the row must be present to be checked');
  assert.equal(dataRow.split(/(?<!\\)\|/).length - 2, 8, 'the detail table has exactly eight columns');
  assert.ok(dataRow.includes('evil\\|name.heic'), 'the pipe must be escaped, not stripped');
});

test('--confirm gates the write, and gates it BEFORE the write happens', () => {
  // A structural test, deliberately. The confirm check has to sit after the diff is printed (the
  // diff is the thing being confirmed) and before atomicWrite, and modeWrite reaches neither
  // without a git repo whose registry path is this module's own. Scanning the source kills the
  // mutation that matters (`if (false)`, or deleting the guard) without pretending to be an
  // end-to-end test. The wiring around it is still only exercised by a real run.
  const src = readFileSync(path.join(HERE, '..', 'draft.mjs'), 'utf8');
  const guard = src.indexOf('if (!confirm)');
  const write = src.indexOf('await atomicWrite(REGISTRY_PATH');
  assert.ok(guard !== -1, '--confirm must be checked by name');
  assert.ok(write !== -1, 'the registry write must go through atomicWrite');
  assert.ok(guard < write, 'the confirm gate must precede the write, not follow it');
  assert.match(src.slice(guard, write), /Validity is not approval/);
  assert.match(src.slice(guard, write), /process\.exitCode = 1/, 'a refused write must exit non-zero');
});

test('parseArgs requires exactly one mode and refuses unknown options', () => {
  assert.throws(() => parseArgs([]), /exactly one mode/);
  assert.throws(() => parseArgs(['--table', '--write']), /exactly one mode/);
  assert.throws(() => parseArgs(['--nope']), /Unknown option --nope/);
  assert.equal(parseArgs(['--write', '--confirm']).confirm, true);
  assert.equal(parseArgs(['--help']).help, true);
  for (const flag of ['--init-from-registry', '--validate', '--table', '--write', '--confirm', '--allow-pattern-set-change', '--out-dir', '--help']) {
    assert.ok(HELP.includes(flag), `help text is missing ${flag}`);
  }
});

test('the atomic write leaves the target untouched when the temp write fails', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'applique-draft-'));
  try {
    const target = path.join(dir, 'patterns.json');
    await writeFile(target, 'ORIGINAL');
    await assert.rejects(() => atomicWrite(target, 'NEW', {
      writeFile: async () => { throw new Error('ENOSPC'); },
    }), /ENOSPC/);
    assert.equal(await readFile(target, 'utf8'), 'ORIGINAL', 'a failed write must not truncate the registry');

    await assert.rejects(() => atomicWrite(target, 'NEW', {
      rename: async () => { throw new Error('EXDEV'); },
    }), /EXDEV/);
    assert.equal(await readFile(target, 'utf8'), 'ORIGINAL', 'a failed rename must not truncate the registry either');

    await atomicWrite(target, 'NEW');
    assert.equal(await readFile(target, 'utf8'), 'NEW');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The diff the operator confirms.
// ---------------------------------------------------------------------------

test('the unified diff shows a rename as one changed line with context', () => {
  const draft = draftFromRegistry(committed);
  draft.patterns[0].name = 'Renamed Pattern';
  const diff = unifiedDiff(committedRaw, serialize(candidateRegistry(draft, committed)), {
    fromLabel: 'before', toLabel: 'after',
  });
  assert.match(diff, /^--- before\n\+\+\+ after\n@@ /);
  assert.equal(diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length, 1);
  assert.equal(diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length, 1);
  assert.ok(diff.includes(`-      "name": ${JSON.stringify(committed.patterns[0].name)},`));
  assert.ok(diff.includes('+      "name": "Renamed Pattern",'));
});

test('the unified diff is empty for identical inputs and handles insertions and deletions', () => {
  assert.equal(unifiedDiff('a\nb\n', 'a\nb\n'), '');
  assert.match(unifiedDiff('a\nb\n', 'a\nx\nb\n'), /\+x/);
  assert.match(unifiedDiff('a\nb\nc\n', 'a\nc\n'), /-b/);
});
