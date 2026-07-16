import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAccordionRow, ACCORDION_ROW_ID } from '../lib/table-block.mjs';
import {
  ACCORDION_HTML_DIR,
  accordionHtmlOf,
  compactHtml,
  prettyHtml,
} from './accordion-html-fixture.mjs';
import { fileForSuffix, findAccordionOrNull, readShippedTemplate } from './shipped-template.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = path.join(HERE, '..', 'profiles');

// The live Size Chart row from a shipped product template. This is the cohesion anchor: the
// generator must reproduce every shipped row exactly.
function shippedRow(suffix) {
  const found = findAccordionOrNull(readShippedTemplate(fileForSuffix(suffix)));
  return found?.accordion?.blocks?.[ACCORDION_ROW_ID];
}

// Run this over every (profile, suffix) pair the profiles claim, not just the seed. A template is
// cloned from an already-charted one, so it arrives carrying the source blank's chart under the
// canonical id: the right shape, the wrong garment. Presence checks cannot see that, and neither
// can a duplicate scan, because there is exactly one row and it looks correct. Only comparing the
// row against a rebuild from its own profile catches it, and the same comparison catches a profile
// edited without re-running apply-size-chart.mjs, which is the same bug arriving later.
for (const f of readdirSync(PROFILES_DIR).filter((n) => n.endsWith('.json'))) {
  const profile = JSON.parse(readFileSync(path.join(PROFILES_DIR, f), 'utf8'));
  for (const suffix of profile.handles ?? []) {
    test(`${f} -> product.${suffix}.json: shipped row deep-equals a rebuild from the profile`, () => {
      assert.deepStrictEqual(shippedRow(suffix), buildAccordionRow(profile));
    });

    test(`${f} -> product.${suffix}.json: shipped row serialises byte-identically (key order)`, () => {
      // Environment-independent golden: JSON text, not pixels.
      assert.equal(JSON.stringify(shippedRow(suffix)), JSON.stringify(buildAccordionRow(profile)));
    });
  }
}

// The anchor id this row carries is asserted in test/anchor-contract.test.mjs, which owns that
// contract end to end. Nothing about it belongs here: a test in this file would compare the
// generator against its own constant and agree by construction.

// ── Accordion prose characterisation ──────────────────────────────────────────
//
// The goldens above cover every blank that has a shipped template, but they are self-referential:
// `apply-size-chart.mjs` rewrites the very templates they read, so after a regen they compare the
// generator against its own fresh output and cannot review a prose change. These fixtures are
// captured independently and diff as prose, one paragraph per line. They also cover any blank
// authored ahead of its template, which has no `handles` yet and so nothing above pins it.
//
// If one of these goes red, read the diff: it is the wording change, in reviewable form. Regenerate
// with `npm run size-chart:golden:update` only once the diff is the change you meant to make.

const profiles = readdirSync(PROFILES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(path.join(PROFILES_DIR, f), 'utf8')));

test('every shipped profile has a pinned accordion-html fixture', () => {
  const pinned = readdirSync(ACCORDION_HTML_DIR).filter((f) => f.endsWith('.html')).sort();
  const expected = profiles.map((p) => `${p.blank_id}.html`).sort();
  // Equality, not a subset: catches both a new blank with no fixture and an orphan fixture left
  // behind by a renamed blank.
  assert.deepStrictEqual(pinned, expected);
});

for (const profile of profiles) {
  test(`accordion prose for ${profile.blank_id} matches its pinned fixture`, () => {
    const fixture = readFileSync(path.join(ACCORDION_HTML_DIR, `${profile.blank_id}.html`), 'utf8');
    assert.equal(compactHtml(fixture), accordionHtmlOf(buildAccordionRow(profile)));
  });

  test(`accordion prose for ${profile.blank_id} is single-line, so the fixture transform is lossless`, () => {
    // prettyHtml/compactHtml round-trip on newlines alone. If the composer ever emits a literal
    // newline the readable fixture would silently drop it, so fail loudly here instead.
    const html = accordionHtmlOf(buildAccordionRow(profile));
    assert.ok(!html.includes('\n'), 'composed prose must not contain a literal newline');
    assert.equal(compactHtml(prettyHtml(html)), html);
  });
}

// ── Prose composition ─────────────────────────────────────────────────────────
//
// The fixtures above pin WHAT the prose says. These pin HOW it is assembled, so they keep holding
// when the wording legitimately changes and they cover blanks added later.

const byId = Object.fromEntries(profiles.map((p) => [p.blank_id, p]));
const proseOf = (profile) => accordionHtmlOf(buildAccordionRow(profile));
const labelsIn = (html) => [...html.matchAll(/<strong>([^<]*)<\/strong>/g)].map((m) => m[1]);

test('a paragraph is emitted for exactly the columns that declare explain, in column order', () => {
  // The whole design in one assertion: the prose list IS the column list. Order included, so the
  // deliberate laid-flat-before-circumference swap cannot silently revert.
  for (const profile of profiles) {
    const expected = profile.columns
      .filter((c) => typeof c.explain === 'string')
      .map((c) => c.callout_label ?? c.heading);
    // The choosing paragraph opens with its own <strong>, hence the slice.
    assert.deepStrictEqual(labelsIn(proseOf(profile)).slice(1), expected, profile.blank_id);
  }
});

test('every explain string appears exactly once in its own prose', () => {
  for (const profile of profiles) {
    const html = proseOf(profile);
    for (const col of profile.columns.filter((c) => c.explain)) {
      const hits = html.split(col.explain).length - 1;
      assert.equal(hits, 1, `${profile.blank_id}: ${col.role} explain appeared ${hits}x`);
    }
  }
});

test('the vest has no sleeve or chest-circumference paragraph, with no conditional anywhere', () => {
  // The point of the refactor: the vest has no such columns, so it gets no such prose.
  const html = proseOf(byId['vest-microfleece-womens']);
  assert.doesNotMatch(html, /sleeve/i);
  assert.doesNotMatch(html, /circumference/i);
  assert.doesNotMatch(html, /sweatshirt/i);
  assert.deepStrictEqual(labelsIn(html), ['Choosing your size.', 'US Size', 'Bust (laid flat)', 'Body length']);
});

test('the quarter-zip gains its zipper paragraph the same way', () => {
  const html = proseOf(byId['quarter-zip-midweight']);
  assert.ok(labelsIn(html).includes('Front zipper'));
  assert.match(html, /quarter-zip/);
});

test('{{deciding_label}} resolves to the deciding column, per garment', () => {
  assert.match(proseOf(byId['crewneck-fleece']), /<strong>Choosing your size\.<\/strong> Chest \(laid flat\) is the measurement/);
  // The same sentence, correctly saying Bust on the blank that measures bust.
  assert.match(proseOf(byId['vest-microfleece-womens']), /<strong>Choosing your size\.<\/strong> Bust \(laid flat\) is the measurement/);
});

test('{{garment_noun}} resolves per garment', () => {
  assert.match(proseOf(byId['crewneck-fleece']), /grab a sweatshirt you already own/);
  assert.match(proseOf(byId['vest-microfleece-womens']), /grab a vest you already own/);
  assert.match(proseOf(byId['quarter-zip-midweight']), /grab a quarter-zip you already own/);
});

test('a `how` blurb never leaks into the accordion (how and explain are different registers)', () => {
  // `how` is the terse PNG-legend line; explain is the long-form accordion paragraph. If a future
  // edit reuses one for the other, this catches it.
  for (const profile of profiles) {
    const html = proseOf(profile);
    for (const col of profile.columns.filter((c) => c.how && c.how !== c.explain)) {
      assert.ok(!html.includes(col.how), `${profile.blank_id}: ${col.role} 'how' text leaked into the accordion`);
    }
  }
});

test('an unresolved token throws rather than shipping {{...}} to the storefront', () => {
  const p = JSON.parse(JSON.stringify(byId['crewneck-fleece']));
  // Simulate the deciding column vanishing: {{deciding_label}} would have nothing to resolve to.
  delete p.columns[1].decides_size;
  assert.throws(() => buildAccordionRow(p), /no column sets decides_size/);
});

test('a $-bearing label is neither interpreted as a replace pattern nor left unescaped', () => {
  // Two properties in one case. `$&` / `$'` / `$1` are String.replace special patterns: a plain
  // string replacement would expand them into the surrounding copy. And the label reaches HTML now,
  // so its `&` must come out as an entity.
  const p = JSON.parse(JSON.stringify(byId['crewneck-fleece']));
  p.columns[1].callout_label = "Chest $& $' $1";
  const html = accordionHtmlOf(buildAccordionRow(p));
  assert.match(html, /Choosing your size\.<\/strong> Chest \$&amp; \$' \$1 is the measurement/);
  // If `$&` had expanded, the matched token text would appear instead of the literal.
  assert.doesNotMatch(html, /\{\{deciding_label\}\}/);
});
