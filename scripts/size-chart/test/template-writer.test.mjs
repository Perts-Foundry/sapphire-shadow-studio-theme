import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertSizeChart, applyToTemplateObject } from '../lib/template-writer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const SEED = JSON.parse(readFileSync(path.join(HERE, '..', 'profiles', 'crewneck-fleece.json'), 'utf8'));
const ORIG_PATH = path.join(ROOT, 'templates', 'product.medical-credential-embroidered-sweatshirt.json');
const ORIG = readFileSync(ORIG_PATH, 'utf8');

function tmpFile(content) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sc-writer-'));
  const p = path.join(dir, 'product.test.json');
  writeFileSync(p, content);
  return p;
}

function stripSizeChart(raw) {
  const header = raw.match(/^﻿?\s*\/\*[\s\S]*?\*\/\s*/)[0];
  const obj = JSON.parse(raw.slice(header.length));
  const acc = obj.sections.main.blocks['product-details'].blocks.accordion_HrL6gj;
  delete acc.blocks.accordion_row_sc001;
  acc.block_order = acc.block_order.filter((id) => id !== 'accordion_row_sc001');
  return header + JSON.stringify(obj, null, 2) + '\n';
}

test('idempotent on an intact template (no write, no change)', async () => {
  const p = tmpFile(ORIG);
  const r = await upsertSizeChart({ templatePath: p, profile: SEED });
  assert.equal(r.changed, false);
  assert.equal(readFileSync(p, 'utf8'), ORIG);
});

test('insert reproduces the canonical file byte-for-byte', async () => {
  const p = tmpFile(stripSizeChart(ORIG));
  const r = await upsertSizeChart({ templatePath: p, profile: SEED });
  assert.equal(r.changed, true);
  assert.equal(readFileSync(p, 'utf8'), ORIG);
});

test('re-running after an insert is a no-op', async () => {
  const p = tmpFile(stripSizeChart(ORIG));
  await upsertSizeChart({ templatePath: p, profile: SEED });
  const r = await upsertSizeChart({ templatePath: p, profile: SEED });
  assert.equal(r.changed, false);
});

// findAccordion error paths: the "apply to a new handle with a different structure" case that the
// byte-for-byte golden does not exercise.
test('throws when the template has no product-details block', () => {
  const obj = { sections: { main: { blocks: {} } } };
  assert.throws(() => applyToTemplateObject(obj, SEED), /product-details/);
});

test('throws when there is no accordion block to place the row in', () => {
  const obj = { sections: { main: { blocks: { 'product-details': { blocks: { t: { type: 'text' } } } } } } };
  assert.throws(() => applyToTemplateObject(obj, SEED), /no accordion block/);
});

test('throws when there are multiple accordion blocks (ambiguous target)', () => {
  const acc = () => ({ type: 'accordion', blocks: {}, block_order: [] });
  const obj = { sections: { main: { blocks: { 'product-details': { blocks: { a: acc(), b: acc() } } } } } };
  assert.throws(() => applyToTemplateObject(obj, SEED), /multiple accordion/);
});
