// The committed registry and the shipped product template must agree: the template's
// pattern_options is a derived artifact, and a PR that changes one without the other ships a
// dropdown that disagrees with the charts. The ONLY exempt state is the bootstrap sentinel
// (byte-equality, not structural emptiness: a registry that lost its patterns by accident is a
// failure, not a skip).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, dropdownText, isEmptySentinel, REGISTRY_PATH } from '../lib/registry.mjs';
import { findAppliqueBlock, BLOCK_TYPE } from '../lib/options-writer.mjs';
import { splitHeader } from '../../size-chart/lib/template-writer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(HERE, '..', '..', '..', 'templates', 'product.huddle-crewneck.json');

const rawRegistry = readFileSync(REGISTRY_PATH, 'utf8');
const registry = JSON.parse(rawRegistry);
const rawTemplate = readFileSync(TEMPLATE_PATH, 'utf8');

test('shipped registry validates', () => {
  assert.deepEqual(validate(registry), []);
});

test('shipped template carries the applique block with the right type', () => {
  const block = findAppliqueBlock(JSON.parse(splitHeader(rawTemplate).body));
  assert.equal(block.type, BLOCK_TYPE);
});

test('an empty registry is only legal as the byte-exact bootstrap sentinel', () => {
  if (registry.patterns.length === 0) {
    assert.ok(
      isEmptySentinel(rawRegistry),
      'registry has zero patterns but is not the bootstrap sentinel; it lost its patterns by accident or drifted in formatting',
    );
  }
});

test('template pattern_options byte-equals the registry-derived text (skipped only pre-bootstrap)', (t) => {
  if (isEmptySentinel(rawRegistry)) {
    t.skip('registry is the bootstrap sentinel; the first skill run populates it');
    return;
  }
  const block = findAppliqueBlock(JSON.parse(splitHeader(rawTemplate).body));
  assert.equal(
    block.settings.pattern_options,
    dropdownText(registry),
    'run scripts/applique-grid/apply-options.mjs and commit the template with patterns.json',
  );
});
