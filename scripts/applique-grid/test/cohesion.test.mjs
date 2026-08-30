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
import { validate, dropdownText, isEmptySentinel, materialise, REGISTRY_PATH } from '../lib/registry.mjs';
import { parseCatalogue, CATALOGUE_PATH } from '../../lib/catalogue-manifest.mjs';
import { findAppliqueBlock, BLOCK_TYPE } from '../lib/options-writer.mjs';
import { chartSpec } from '../lib/naming.mjs';
import { splitHeader } from '../../size-chart/lib/template-writer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(HERE, '..', '..', '..', 'templates', 'product.huddle-crewneck.json');

const rawRegistry = readFileSync(REGISTRY_PATH, 'utf8');
// Materialised the way `load()` does it, so `validate` sees the Color option values the name guard
// checks against. Validating the raw file would run that guard against an empty list, which passes
// on any name at all.
const manifest = parseCatalogue(
  readFileSync(path.join(HERE, '..', '..', '..', CATALOGUE_PATH), 'utf8')
);
const registry = materialise(JSON.parse(rawRegistry), manifest);
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

// ── Byte stability against the frozen pre-migration snapshot ──────────────────
//
// The migration moved this registry's product GID and Color option snapshot into catalogue.json.
// The dropdown text and every published chart were supposed to be untouched by that. PR1 captured
// these bytes BEFORE any migration code existed, so this is not the generator agreeing with itself
// the way "regenerate and confirm a clean tree" would be.

const BASELINE = JSON.parse(
  readFileSync(path.join(HERE, '..', '..', 'catalogue', 'test', 'fixtures', 'pre-migration-baseline.json'), 'utf8')
);

test('the derived dropdown text is byte-identical to its pre-migration capture', () => {
  assert.deepEqual([dropdownText(registry)], BASELINE.appliqueDropdownInTemplate);
});

test('the pattern list is unchanged by the migration: same ids, names, threads, statuses, order', () => {
  const captured = BASELINE.appliquePatternsRegistry;
  assert.equal(registry.handle, captured.handle);
  assert.deepEqual(
    registry.patterns.map((p) => ({ id: p.id, name: p.name, thread: p.thread, status: p.status, position: p.position })),
    captured.patterns
  );
});

test('a chart spec cannot see the product block, so no shipped chart hash churns', () => {
  // The published charts' specHashes are the one thing a product-block change could plausibly have
  // churned, and this is why it cannot: chartSpec carries the style version, the grid params, the
  // page numbers and each pattern's id, name, thread, hero digest and crop. The handle, the GID and
  // the colour list are not among its inputs. Asserted structurally rather than against a capture,
  // because a capture of zero published charts would pass by saying nothing.
  const spec = chartSpec({
    chart: registry.chart,
    page: 1,
    pages: 1,
    patterns: [{
      number: 1, id: 'x', name: 'X', thread: 'White', heroSha256: 'a'.repeat(64),
      crop: { left: 0, top: 0, width: 1, height: 1 },
    }],
  });
  const text = JSON.stringify(spec);
  for (const secret of [registry.product.handle, registry.product.gid, ...registry.product.colorValues]) {
    assert.equal(text.includes(secret), false, `chartSpec must not carry ${secret}`);
  }
  assert.deepEqual(Object.keys(spec).sort(), ['grid', 'page', 'pages', 'patterns', 'styleVersion']);
});
