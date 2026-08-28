import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validate, assertValid, load, save, activePatterns, dropdownLines, dropdownText,
  emptyRegistry, serialize, EMPTY_SENTINEL, isEmptySentinel, deriveId, pinnedMedia, materialise,
} from '../lib/registry.mjs';
import { parseCatalogue } from '../../lib/catalogue-manifest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = () => JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'registry.fixture.json'), 'utf8'));

// Hand-authored, so the materialisation assertions state what the derivation does rather than what
// today's catalogue happens to contain.
const MANIFEST = parseCatalogue(
  JSON.stringify({
    version: 2,
    options: { color: 'Color', size: 'Size', design: 'Design', denomination: 'Denominations' },
    colors: { black: { display: 'Black', slug: 'black' }, 'grey heather': { display: 'Grey Heather', slug: 'grey-heather' } },
    sizes: { s: { display: 'S' } },
    bodies: { crewneck: { colors: ['black', 'grey heather'], sizes: ['s'] } },
    products: {
      'huddle-crewneck': { line: 'huddle', body: 'crewneck', template: 'huddle-crewneck', title: 'Huddle Crewneck', gid: 'gid://shopify/Product/7' },
      'the-gift-card': { line: null, body: null, template: 'gift-card', title: 'Gift Card', gid: 'gid://shopify/Product/8' },
    },
  })
);

test('fixture registry validates clean', () => {
  assert.deepEqual(validate(fixture()), []);
});

test('empty bootstrap registry validates clean', () => {
  assert.deepEqual(validate(emptyRegistry()), []);
});

test('sentinel is byte-equality, not structural emptiness', () => {
  assert.equal(isEmptySentinel(EMPTY_SENTINEL), true);
  const reg = emptyRegistry();
  reg.threads = ['white']; // structurally still empty of patterns, but not the sentinel bytes
  assert.equal(isEmptySentinel(serialize(reg)), false);
});

test('the bootstrap sentinel opens with the scalar handle and carries no product block', () => {
  // ITS BYTES CHANGED, DELIBERATELY. `serialize` no longer emits the product block, so the sentinel
  // this module ships is a different string than before the catalogue migration. That is the one
  // declared exception to the byte-stability criterion the migration otherwise held to, and it is
  // pinned here so a later formatting change is still caught.
  assert.equal(EMPTY_SENTINEL.startsWith('{\n  "version": 1,\n  "handle": "huddle-crewneck",\n  "threads": [],\n'), true);
  assert.equal(EMPTY_SENTINEL.includes('"product"'), false);
  assert.equal(EMPTY_SENTINEL.includes('gid://'), false, 'the GID lives in catalogue.json now');
  assert.equal(EMPTY_SENTINEL.endsWith('\n'), true);
});

test('serialize drops the derived product block, so a save cannot write it back into the file', () => {
  const written = JSON.parse(serialize(materialise(emptyRegistry(), MANIFEST)));
  assert.equal(written.product, undefined);
  assert.equal(written.handle, 'huddle-crewneck');
});

// --- materialise ---------------------------------------------------------------------------

test('materialise attaches the handle, GID and Color values from the manifest', () => {
  const out = materialise({ version: 1, handle: 'huddle-crewneck' }, MANIFEST);
  assert.deepEqual(out.product, {
    handle: 'huddle-crewneck',
    gid: 'gid://shopify/Product/7',
    colorValues: ['Black', 'Grey Heather'],
  });
});

test('a registry still carrying its own product block is REFUSED, not overwritten', () => {
  // The block held a GID and a colour snapshot the audit compares against the live store. Silently
  // replacing a stale copy would hide the drift that comparison exists to find.
  assert.throws(
    () => materialise({ version: 1, handle: 'huddle-crewneck', product: { handle: 'x' } }, MANIFEST),
    /carries a "product" block/
  );
});

test('an undeclared handle, and a non-garment one, both refuse', () => {
  assert.throws(() => materialise({ version: 1, handle: 'ghost' }, MANIFEST), /No product "ghost"/);
  assert.throws(() => materialise({ version: 1, handle: 'the-gift-card' }, MANIFEST), /"body": null/);
});

const expectProblem = (mutate, needle) => {
  const reg = fixture();
  mutate(reg);
  const problems = validate(reg);
  assert.ok(
    problems.some((p) => p.includes(needle)),
    `expected a problem mentioning ${JSON.stringify(needle)}, got:\n${problems.join('\n')}`,
  );
};

test('duplicate id rejected', () => {
  expectProblem((r) => { r.patterns[1].id = 'sunset-bloom'; }, 'duplicate id');
});

test('two names deriving the same id rejected', () => {
  expectProblem((r) => { r.patterns[1].name = 'Sunset  Bloom'; }, 'derives the same id');
});

test('deriveId kebabs punctuation and case', () => {
  assert.equal(deriveId("Willow's Path"), 'willows-path');
  assert.equal(deriveId('Sunset  Bloom'), 'sunset-bloom');
});

test('one photo in two patterns rejected', () => {
  expectProblem((r) => { r.patterns[1].sources.push('IMG_9001.heic'); }, 'already belongs to pattern');
});

test('duplicate position rejected', () => {
  expectProblem((r) => { r.patterns[1].position = 10; }, 'duplicate position');
});

test('hero must be one of the sources', () => {
  expectProblem((r) => { r.patterns[0].hero = 'IMG_9999.heic'; }, 'not one of its sources');
});

test('bad status rejected', () => {
  expectProblem((r) => { r.patterns[0].status = 'retired'; }, 'status must be one of');
});

test('em dash in a name rejected by charset', () => {
  expectProblem((r) => { r.patterns[0].name = 'Sunset\u{2014}Bloom'; }, 'em dash');
});

test('en dash in a name rejected by charset (guard-evasion hole)', () => {
  expectProblem((r) => { r.patterns[0].name = 'Black\u{2013}Watch'; }, 'en dash');
});

test('out-of-charset name rejected', () => {
  expectProblem((r) => { r.patterns[0].name = 'Sunset | Bloom'; }, 'outside the allowed set');
});

test('name whole-word-matching a Color value rejected', () => {
  expectProblem((r) => { r.patterns[0].name = 'Black Forest'; }, 'whole-word-matches Color value');
  expectProblem((r) => { r.patterns[0].name = 'Classic Navy'; }, 'whole-word-matches Color value');
});

test('a black THREAD is legal (thread words never enter alt text)', () => {
  const reg = fixture();
  assert.ok(reg.patterns.some((p) => p.thread === 'black'));
  assert.deepEqual(validate(reg), []);
});

test('thread outside the palette rejected', () => {
  expectProblem((r) => { r.patterns[0].thread = 'chartreuse'; }, 'not in the recorded thread palette');
});

test('crop bounds violations rejected', () => {
  expectProblem((r) => { r.patterns[0].crop = { left: 0.5, top: 0, width: 0.6, height: 1 }; }, 'crop must satisfy');
  expectProblem((r) => { r.patterns[0].crop = { left: -0.1, top: 0, width: 0.5, height: 0.5 }; }, 'crop must satisfy');
  expectProblem((r) => { r.patterns[0].crop = { left: 0, top: 0, width: 0, height: 0.5 }; }, 'crop must satisfy');
});

test('source with a path separator rejected (basenames only)', () => {
  expectProblem((r) => { r.patterns[0].sources[0] = '/Users/someone/IMG_9001.heic'; }, 'bare .heic basename');
  expectProblem((r) => { r.patterns[0].sources[0] = 'photos\\IMG_9001.heic'; }, 'bare .heic basename');
});

test('published entry shape enforced', () => {
  expectProblem((r) => {
    r.published = [{ page: 1, filename: 'x.jpg', mediaGid: 'not-a-gid', alt: 'a', specHash: 'f'.repeat(64) }];
  }, 'mediaGid');
  expectProblem((r) => {
    r.published = [{ page: 1, filename: 'x.jpg', mediaGid: 'gid://shopify/MediaImage/1', alt: 'a', specHash: 'nope' }];
  }, 'specHash');
});

test('numbering skips discontinued and follows position order', () => {
  const reg = fixture();
  // Shuffle array order; numbering must follow position, not array order.
  reg.patterns.reverse();
  const actives = activePatterns(reg);
  assert.equal(actives.length, 9);
  assert.deepEqual(actives.map((p) => p.id).slice(0, 4), ['sunset-bloom', 'meadow-trace', 'night-garden', 'copper-vine']);
  assert.deepEqual(actives.map((p) => p.number), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(!actives.some((p) => p.id === 'retired-rose'));
});

test('dropdown line format is "n. Name (thread thread)", naming the thread outright', () => {
  const lines = dropdownLines(fixture());
  assert.equal(lines[0], '1. Sunset Bloom (white thread)');
  assert.equal(lines[2], '3. Night Garden (black thread)'); // number 3 is the pattern AFTER the discontinued one
  // A bare colour parenthetical would read as the garment's colour, not the stitching's.
  assert.ok(!lines.some((l) => /\((?!.*\bthread\b)/.test(l)), 'every parenthetical names the thread');
});

test('empty registry derives the defined empty dropdown text', () => {
  assert.equal(dropdownText(emptyRegistry()), '');
});

test('assertValid throws with every problem listed', () => {
  const reg = fixture();
  reg.patterns[0].id = 'Bad Id';
  reg.patterns[1].position = -1;
  assert.throws(() => assertValid(reg), /kebab-case[\s\S]*position/);
});

test('load() on a nonexistent path throws', async () => {
  await assert.rejects(() => load(path.join(HERE, 'fixtures', 'does-not-exist.json')));
});

// ---------------------------------------------------------------------------
// gallery.pin_after_charts: media that must stay AFTER the chart block.
// ---------------------------------------------------------------------------

const LOGO = 'gid://shopify/MediaImage/44400000000001';

test('gallery is optional, and an absent gallery pins nothing', () => {
  const reg = fixture();
  assert.equal(reg.gallery, undefined);
  assert.deepEqual(validate(reg), []);
  assert.deepEqual(pinnedMedia(reg), []);
  assert.deepEqual(pinnedMedia(emptyRegistry()), []);
  assert.deepEqual(pinnedMedia(null), []);
});

test('an empty pin list is exactly equivalent to an absent gallery', () => {
  const reg = fixture();
  reg.gallery = { pin_after_charts: [] };
  assert.deepEqual(validate(reg), []);
  assert.deepEqual(pinnedMedia(reg), []);
});

test('a well-formed pin list validates and preserves declared order', () => {
  const reg = fixture();
  const second = 'gid://shopify/MediaImage/44400000000002';
  reg.gallery = { pin_after_charts: [LOGO, second] };
  assert.deepEqual(validate(reg), []);
  assert.deepEqual(pinnedMedia(reg), [LOGO, second]);
});

test('a malformed pinned GID is rejected, naming the offending value', () => {
  expectProblem((r) => { r.gallery = { pin_after_charts: ['44400000000001'] }; }, '"44400000000001"');
  expectProblem((r) => { r.gallery = { pin_after_charts: ['gid://shopify/Product/1'] }; }, 'MediaImage');
  expectProblem((r) => { r.gallery = { pin_after_charts: LOGO }; }, 'must be an array');
  expectProblem((r) => { r.gallery = []; }, 'gallery must be an object');
});

test('a duplicated pinned GID is rejected, naming the duplicate', () => {
  expectProblem((r) => { r.gallery = { pin_after_charts: [LOGO, LOGO] }; }, `duplicate GID(s): ${LOGO}`);
});

test('a pinned GID that is also a published chart is rejected', () => {
  expectProblem((r) => {
    r.published = [{
      page: 1,
      filename: 'x-applique-pattern-chart-1-of-1-aaaaaaaa.jpg',
      mediaGid: LOGO,
      alt: 'Applique pattern chart 1 of 1: patterns 1-1, A',
      specHash: 'a'.repeat(64),
    }];
    r.gallery = { pin_after_charts: [LOGO] };
  }, 'is a published chart');
});

test('an unknown key under gallery is rejected BY NAME, never ignored', () => {
  // The whole point: `pin_after_chart` must not validate clean while doing nothing, because the
  // next publish would then move the pinned media and undo the operator's Admin fix.
  expectProblem((r) => { r.gallery = { pin_after_chart: [LOGO] }; }, 'unknown key "pin_after_chart"');
});

test('a name longer than the chart density carries is rejected, with both numbers named', () => {
  expectProblem((r) => { r.patterns[0].name = 'A'.repeat(60); }, 'is 60 characters; the 3-column chart carries at most');
  // The ceiling is derived from the chart, so densifying the grid can invalidate existing names.
  // That is the point: the operator should learn it at the gate, not from a rendered chart.
  const reg = fixture();
  reg.patterns[0].name = 'Terracotta Blossoming'; // exactly 21: the 3-column ceiling
  assert.equal(reg.patterns[0].name.length, 21);
  assert.deepEqual(validate(reg), []);
  reg.chart = { ...reg.chart, columns: 5, rows: 2 };
  assert.ok(validate(reg).some((p) => /carries at most/.test(p)));
});

test('the ceiling is skipped when the chart params are themselves invalid', () => {
  const reg = fixture();
  reg.chart = { ...reg.chart, width_units: 10 };
  const problems = validate(reg);
  assert.ok(problems.some((p) => /width_units/.test(p)));
  assert.ok(!problems.some((p) => /carries at most/.test(p)), 'one broken field must not cascade into 10 name errors');
});

test('unknown keys are rejected in every container, not just gallery', () => {
  expectProblem((r) => { r.notAKey = 1; }, 'registry: unknown key "notAKey"');
  expectProblem((r) => { r.chart.gutter = 4; }, 'chart: unknown key "gutter"');
  expectProblem((r) => { r.patterns[0].notes = 'free text'; }, 'unknown key "notes"');
  expectProblem((r) => { r.patterns[0].crop.rotate = 90; }, 'crop: unknown key "rotate"');
  expectProblem((r) => {
    r.published = [{
      page: 1,
      filename: 'chart-1-of-1-aaaaaaaa.jpg',
      mediaGid: 'gid://shopify/MediaImage/1',
      alt: 'Applique pattern chart 1 of 1',
      specHash: 'a'.repeat(64),
      caption: 'free text',
    }];
  }, 'published[0]: unknown key "caption"');
});

// ---------------------------------------------------------------------------
// save() is the highest-stakes write in the module: publish.mjs calls it immediately after the
// live media writes, to record the new chart GIDs. It was a plain writeFile while the REVERSIBLE
// local write in draft.mjs was atomic, which is the wrong way round.
// ---------------------------------------------------------------------------

test('save() writes atomically: temp file first, rename second', async () => {
  const reg = fixture();
  const calls = [];
  await save('/registry/patterns.json', reg, {
    writeFile: async (p, contents) => { calls.push(['write', p, contents.length]); },
    rename: async (from, to) => { calls.push(['rename', from, to]); },
    suffix: 'test',
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 2), ['write', '/registry/patterns.json.tmp-test']);
  assert.deepEqual(calls[1], ['rename', '/registry/patterns.json.tmp-test', '/registry/patterns.json']);
  assert.equal(calls[0][2], serialize(reg).length, 'the temp file carries the full serialized registry');
});

test('save() leaves the target untouched when the temp write fails', async () => {
  let renamed = false;
  await assert.rejects(
    () => save('/registry/patterns.json', fixture(), {
      writeFile: async () => { throw new Error('ENOSPC'); },
      rename: async () => { renamed = true; },
    }),
    /ENOSPC/,
  );
  assert.equal(renamed, false, 'a failed temp write must never reach the rename');
});

test('save() validates BEFORE it writes anything', async () => {
  const bad = fixture();
  bad.patterns[0].thread = 'Not A Thread';
  let touched = false;
  await assert.rejects(
    () => save('/registry/patterns.json', bad, {
      writeFile: async () => { touched = true; },
      rename: async () => { touched = true; },
    }),
  );
  assert.equal(touched, false, 'an invalid registry must not reach the filesystem at all');
});
