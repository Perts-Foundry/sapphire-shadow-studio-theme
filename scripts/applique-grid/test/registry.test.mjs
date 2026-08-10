import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validate, assertValid, load, activePatterns, dropdownLines, dropdownText,
  emptyRegistry, serialize, EMPTY_SENTINEL, isEmptySentinel, deriveId,
} from '../lib/registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = () => JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'registry.fixture.json'), 'utf8'));

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

test('dropdown line format is "n. Name (thread)"', () => {
  const lines = dropdownLines(fixture());
  assert.equal(lines[0], '1. Sunset Bloom (white)');
  assert.equal(lines[2], '3. Night Garden (black)'); // number 3 is the pattern AFTER the discontinued one
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
