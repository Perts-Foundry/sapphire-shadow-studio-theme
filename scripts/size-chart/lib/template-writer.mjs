// Insert or update the "Size Chart" accordion row in a product template, preserving every other
// byte of the file. Verified in this repo: Shopify serialises templates with exactly
// JSON.stringify(obj, null, 2) + a trailing newline, and preserves a leading auto-generated /* */
// comment. So a parse -> mutate -> re-serialise round-trip is byte-stable: the resulting git diff
// is only the added/changed Size Chart row (plus one block_order line when inserting). Idempotent:
// re-running with the same profile leaves the file unchanged.
//
// Pure fs; no git, no sharp. The git in-flight-edit guard lives in the apply-size-chart CLI.

import { readFile, writeFile } from 'node:fs/promises';
import { buildAccordionRow, ACCORDION_ROW_ID } from './table-block.mjs';

const HEADER_RE = /^﻿?\s*\/\*[\s\S]*?\*\/\s*/;
// The Size Chart row is conventionally placed just after the "Product Details" row.
const ANCHOR_ROW_ID = 'accordion_row_pd001';

function splitHeader(raw) {
  const m = raw.match(HEADER_RE);
  const header = m ? m[0] : '';
  return { header, body: raw.slice(header.length) };
}

// Return a copy of obj with newKey inserted immediately after afterKey, preserving order; if
// afterKey is absent, newKey is appended. Assigning an existing key keeps its position instead.
function insertAfter(obj, afterKey, newKey, newVal) {
  if (newKey in obj) { obj[newKey] = newVal; return obj; }
  const out = {};
  let done = false;
  for (const [k, v] of Object.entries(obj)) {
    out[k] = v;
    if (k === afterKey) { out[newKey] = newVal; done = true; }
  }
  if (!done) out[newKey] = newVal;
  return out;
}

function findAccordion(obj) {
  const details = obj?.sections?.main?.blocks?.['product-details'];
  if (!details || typeof details.blocks !== 'object') {
    throw new Error('template has no sections.main.blocks["product-details"].blocks; cannot place size chart');
  }
  const matches = Object.entries(details.blocks).filter(([, b]) => b && b.type === 'accordion');
  if (matches.length === 0) throw new Error('no accordion block found in product-details; add one before inserting a size chart');
  if (matches.length > 1) throw new Error(`multiple accordion blocks (${matches.map(([id]) => id).join(', ')}); ambiguous target`);
  return { details, accId: matches[0][0], accordion: matches[0][1] };
}

// Mutate the parsed template object in place: upsert the Size Chart row into its accordion.
export function applyToTemplateObject(obj, profile) {
  const row = buildAccordionRow(profile);
  const { details, accId, accordion } = findAccordion(obj);

  accordion.blocks = accordion.blocks && typeof accordion.blocks === 'object' ? accordion.blocks : {};
  accordion.block_order = Array.isArray(accordion.block_order) ? accordion.block_order : [];

  accordion.blocks = insertAfter(accordion.blocks, ANCHOR_ROW_ID, ACCORDION_ROW_ID, row);
  details.blocks[accId].blocks = accordion.blocks;

  if (!accordion.block_order.includes(ACCORDION_ROW_ID)) {
    const idx = accordion.block_order.indexOf(ANCHOR_ROW_ID);
    if (idx === -1) accordion.block_order.push(ACCORDION_ROW_ID);
    else accordion.block_order.splice(idx + 1, 0, ACCORDION_ROW_ID);
  }
  return obj;
}

// Read a product template, upsert the size chart, write it back byte-stably. Returns
// { changed, path }. changed=false means the file was already up to date (no write performed).
export async function upsertSizeChart({ templatePath, profile } = {}) {
  const raw = await readFile(templatePath, 'utf8');
  const { header, body } = splitHeader(raw);
  const obj = JSON.parse(body);

  applyToTemplateObject(obj, profile);

  const trailingNewline = body.endsWith('\n') ? '\n' : '';
  const next = header + JSON.stringify(obj, null, 2) + trailingNewline;

  if (next === raw) return { changed: false, path: templatePath };
  await writeFile(templatePath, next);
  return { changed: true, path: templatePath };
}
