import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAccordionRow } from '../lib/table-block.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
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
