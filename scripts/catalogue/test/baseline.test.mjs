// The frozen pre-migration byte baseline.
//
// Five shipped artifacts are generated from data the catalogue migration moves under the manifest.
// `capture-baseline.mjs` froze their bytes BEFORE any migration code existed; this asserts the
// committed repo still matches those bytes, and the migration's own PR adds tests in the OWNING
// suites (following applique-grid/test/cohesion.test.mjs and size-chart/test/table-block.test.mjs)
// that byte-compare fresh generator output against the same fixture.
//
// WHY IT IS FROZEN RATHER THAN REGENERATED. "Regenerate and confirm a clean tree" compares a new
// generator against its own output: a generator that changed its mind consistently passes. This
// compares it against what a customer sees today.
//
// WHAT THE COUNTS ARE FOR. A fixture that quietly emptied would let every deep-equal below pass on
// nothing, which is the same fail-open shape the manifest's vacuity floor exists to prevent. The
// counts are pinned here so an emptied fixture fails rather than reads as agreement.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { captureBaseline, serializeBaseline, BASELINE_PATH } from './capture-baseline.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const frozen = async () => JSON.parse(await readFile(path.join(repoRoot, BASELINE_PATH), 'utf8'));

test('the frozen baseline is not vacuous', async () => {
  const baseline = await frozen();
  assert.equal(Object.keys(baseline.sizeChartGoldens).length, 4, 'one SVG golden and three accordion HTML fixtures');
  assert.equal(Object.keys(baseline.sizeChartAccordionRows).length, 5, 'the five garment product templates');
  assert.equal(baseline.appliquePatternsRegistry.patterns.length, 18);
  assert.equal(baseline.appliqueDropdownInTemplate.length, 1);
  assert.equal(baseline.a11yProductEntries.length, 6);
});

test('the committed repo still matches the frozen baseline, byte for byte', async () => {
  // Not a tautology: `captureBaseline` reads the SHIPPED artifacts (product templates, the applique
  // registry, the a11y path list, the size-chart goldens) and the fixture is a separate committed
  // file. A generator change that rewrote any of them fails here.
  assert.equal(serializeBaseline(await captureBaseline(repoRoot)), await readFile(path.join(repoRoot, BASELINE_PATH), 'utf8'));
});

test('the six accessibility labels are frozen as a LIST, because their order is a contract', async () => {
  // Product declaration order in catalogue.json drives this block once the a11y path list is
  // derived from it. Freezing a set rather than a list would let the derivation reorder the audit
  // with nothing failing.
  const baseline = await frozen();
  assert.deepEqual(baseline.a11yProductEntries.map((e) => e.label), [
    'product (huddle crewneck)',
    'product (lead ii crewneck)',
    'product (lead ii quarter zip)',
    'product (lead ii vest womens)',
    'product (shift fuel crewneck)',
    'product (gift card)',
  ]);
});

test('the a11y label rule is TEMPLATE-derived, which the gift card is the one product that proves', async () => {
  // Deriving the label from the handle gives "product (sapphire shadow studio gift card)", which is
  // not what ships. Deriving it from the template suffix reproduces all six exactly. This is the
  // whole reason `template` earns a place in the manifest, asserted against the frozen bytes rather
  // than against the manifest the rule reads.
  const baseline = await frozen();
  for (const entry of baseline.a11yProductEntries) {
    const template = entry.template.replace(/^templates\/product\./, '').replace(/\.json$/, '');
    assert.equal(entry.label, `product (${template.replace(/-/g, ' ')})`);
  }
  const gift = baseline.a11yProductEntries.find((e) => e.label === 'product (gift card)');
  assert.equal(gift.path, '/products/sapphire-shadow-studio-gift-card', 'the handle and the template differ here');
});

test('the applique dropdown shipped in the template matches the registry it is generated from', async () => {
  // Both ends are frozen, so a migration that broke the pair while updating only one of them fails.
  const baseline = await frozen();
  const [shipped] = baseline.appliqueDropdownInTemplate;
  const active = baseline.appliquePatternsRegistry.patterns.filter((p) => p.status === 'active');
  assert.equal(shipped.split('\n').length, active.length, 'one line per active pattern');
  for (const [index, line] of shipped.split('\n').entries()) {
    assert.match(line, new RegExp(`^${index + 1}\\. `), 'numbering is position order, one-based');
  }
});
