import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAccordionRow } from '../lib/table-block.mjs';
import {
  ACCORDION_HTML_DIR,
  accordionHtmlOf,
  compactHtml,
  prettyHtml,
} from './accordion-html-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const PROFILES_DIR = path.join(HERE, '..', 'profiles');
const SEED = JSON.parse(readFileSync(path.join(HERE, '..', 'profiles', 'crewneck-fleece.json'), 'utf8'));

// The live, byte-identical Size Chart row from a shipped product template. This is the cohesion
// anchor: the generator must reproduce it exactly for the seed blank.
function canonicalRow() {
  const raw = readFileSync(path.join(ROOT, 'templates', 'product.medical-applique-embroidered-sweatshirt.json'), 'utf8');
  const body = raw.replace(/^﻿?\s*\/\*[\s\S]*?\*\/\s*/, '');
  const t = JSON.parse(body);
  return t.sections.main.blocks['product-details'].blocks.accordion_HrL6gj.blocks.accordion_row_sc001;
}

test('built row deep-equals the canonical template row', () => {
  assert.deepStrictEqual(buildAccordionRow(SEED), canonicalRow());
});

test('built row serialises byte-identically (key order preserved)', () => {
  // Environment-independent golden: JSON text, not pixels.
  assert.equal(JSON.stringify(buildAccordionRow(SEED)), JSON.stringify(canonicalRow()));
});

// ── Accordion prose characterisation ──────────────────────────────────────────
//
// The two goldens above only cover the crewneck, and only against a shipped template. That leaves
// two gaps these fixtures close:
//
//   1. The quarter-zip and both vests have no `handles`, so no shipped template exists and nothing
//      pins their prose at all.
//   2. `apply-size-chart.mjs` rewrites the very templates the goldens above read. After a regen they
//      compare the generator against its own fresh output, so they cannot review a prose change.
//      These fixtures are captured independently and diff as prose, one paragraph per line.
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
