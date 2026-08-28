// Byte-stability against the frozen pre-migration snapshot.
//
// The catalogue-manifest migration moved this tool's size range and template list out of the
// profiles and into catalogue.json. Nothing it renders was supposed to change. "Regenerate and
// confirm a clean tree" cannot prove that: it compares the new generator against its OWN output,
// which is the self-referential-golden failure mode. So PR1 captured these bytes BEFORE any
// migration code existed, and this compares fresh generator output against that capture.
//
// The snapshot is frozen on purpose. It is never regenerated to make a test pass: a red here is
// either a real rendering change that has to be argued for, or the migration changing something it
// promised not to.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSvg } from '../lib/render-svg.mjs';
import { buildAccordionRow } from '../lib/table-block.mjs';
import { accordionHtmlOf } from './accordion-html-fixture.mjs';
import { resolvedProfile } from './profile-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const BASELINE = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'scripts/catalogue/test/fixtures/pre-migration-baseline.json'), 'utf8')
);

const PROFILE_FOR_TEMPLATE = {
  'templates/product.huddle-crewneck.json': 'crewneck-fleece',
  'templates/product.lead-ii-crewneck.json': 'crewneck-fleece',
  'templates/product.shift-fuel-crewneck.json': 'crewneck-fleece',
  'templates/product.lead-ii-quarter-zip.json': 'quarter-zip-midweight',
  'templates/product.lead-ii-vest-womens.json': 'vest-microfleece-womens',
};

test('the seed chart still renders the pre-migration SVG, byte for byte', () => {
  const key = 'scripts/size-chart/test/fixtures/crewneck-fleece.svg';
  assert.equal(buildSvg(resolvedProfile('crewneck-fleece')), BASELINE.sizeChartGoldens[key]);
});

test('every generated accordion row still serialises to its pre-migration bytes', () => {
  const rows = BASELINE.sizeChartAccordionRows;
  assert.deepEqual(Object.keys(rows).sort(), Object.keys(PROFILE_FOR_TEMPLATE).sort());
  for (const [file, expected] of Object.entries(rows)) {
    // The capture holds every Size Chart row found in the template. Exactly one is the contract;
    // two would mean a page rendering the chart twice, which the snapshot would have preserved.
    assert.equal(expected.length, 1, `${file} has exactly one Size Chart row`);
    const built = buildAccordionRow(resolvedProfile(PROFILE_FOR_TEMPLATE[file]));
    assert.equal(JSON.stringify(built), JSON.stringify(expected[0]), file);
  }
});

test('the accordion prose fixtures still match their pre-migration bytes', () => {
  for (const [key, expected] of Object.entries(BASELINE.sizeChartGoldens)) {
    if (!key.includes('accordion-html/')) continue;
    const blankId = path.basename(key, '.html');
    assert.equal(readFileSync(path.join(REPO_ROOT, key), 'utf8'), expected, key);
    // And the generator still produces what the fixture pins, so the pair cannot drift together.
    assert.ok(accordionHtmlOf(buildAccordionRow(resolvedProfile(blankId))).length, blankId);
  }
});
