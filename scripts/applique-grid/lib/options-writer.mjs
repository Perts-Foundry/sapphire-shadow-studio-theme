// Upsert the registry-derived pattern_options text into the Huddle product template, preserving
// every other byte of the file. Pure string/object work; the CLI (apply-options.mjs) owns fs and
// the shopify-sync in-flight guard.
//
// Same byte-stability contract as scripts/size-chart/lib/template-writer.mjs, whose splitHeader
// this reuses: Shopify serialises templates as JSON.stringify(obj, null, 2) plus a trailing
// newline, so a parse -> mutate -> re-serialise round trip diffs as exactly the one changed
// setting line. One trap that contract has: JS object iteration hoists integer-like keys ("10")
// ahead of string keys, so a template containing one would silently REORDER on round trip. That
// is checked before any mutation and hard-fails instead of writing a reordered file.

import { splitHeader } from '../../size-chart/lib/template-writer.mjs';

export const BLOCK_ID = 'applique_pattern_001';
export const BLOCK_TYPE = 'applique-pattern-select';

// Policy ceilings, not observed Shopify limits. Each dropdown line becomes a cart line-item
// property VALUE, where Shopify's practical bound is 255 characters; the whole-textarea ceiling
// is a runaway-registry backstop sized far above any plausible pattern count (~18 patterns is
// under 600 characters).
export const MAX_OPTION_LINE = 255;
export const MAX_OPTIONS_TEXT = 5000;

/**
 * Find the applique block in a parsed template object, wherever it nests. Exactly one block with
 * id BLOCK_ID must exist and its type must be BLOCK_TYPE.
 * @param {object} obj - parsed template
 * @returns {object} the block object (mutable reference into obj)
 */
export function findAppliqueBlock(obj) {
  const matches = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.blocks && typeof node.blocks === 'object' && !Array.isArray(node.blocks)) {
      if (Object.prototype.hasOwnProperty.call(node.blocks, BLOCK_ID)) matches.push(node.blocks[BLOCK_ID]);
      for (const child of Object.values(node.blocks)) walk(child);
    }
    if (node.sections && typeof node.sections === 'object') {
      for (const section of Object.values(node.sections)) walk(section);
    }
  };
  walk(obj);
  if (matches.length === 0) throw new Error(`template has no block "${BLOCK_ID}"; add the applique-pattern-select block before syncing options`);
  if (matches.length > 1) throw new Error(`template has ${matches.length} blocks with id "${BLOCK_ID}"; ambiguous target`);
  const block = matches[0];
  if (block?.type !== BLOCK_TYPE) {
    throw new Error(`block "${BLOCK_ID}" has type ${JSON.stringify(block?.type)}, expected "${BLOCK_TYPE}"`);
  }
  return block;
}

/**
 * Validate the derived dropdown text. LF-only (the template stores it as one JSON string; a CR
 * would round-trip but render as a stray character in the editor), bounded per line and overall.
 * The empty string is valid: an empty registry derives an empty dropdown.
 * @param {string} text
 */
export function assertOptionsText(text) {
  if (typeof text !== 'string') throw new Error('pattern_options text must be a string');
  if (text.includes('\r')) throw new Error('pattern_options text must be LF-only (contains a carriage return)');
  if (text.length > MAX_OPTIONS_TEXT) {
    throw new Error(`pattern_options text is ${text.length} characters (ceiling ${MAX_OPTIONS_TEXT}); the registry is implausibly large`);
  }
  for (const line of text.split('\n')) {
    if (line.length > MAX_OPTION_LINE) {
      throw new Error(`pattern_options line exceeds ${MAX_OPTION_LINE} characters (a line-item property value bound): ${JSON.stringify(line.slice(0, 60))}...`);
    }
  }
}

/**
 * Compute the updated template bytes. Returns { next, changed }; changed=false means the file
 * already carries exactly this text (idempotent re-run).
 * @param {string} raw - current template file contents
 * @param {string} text - registry-derived pattern_options text
 * @returns {{next: string, changed: boolean}}
 */
export function upsertPatternOptions(raw, text) {
  assertOptionsText(text);
  const { header, body } = splitHeader(raw);
  const obj = JSON.parse(body);

  // Round-trip stability check BEFORE mutating: if re-serialising the untouched object does not
  // reproduce the file (integer-like key reorder, foreign formatting), refuse rather than write a
  // whole-file diff that buries the real change.
  const trailingNewline = body.endsWith('\n') ? '\n' : '';
  const roundTrip = JSON.stringify(obj, null, 2) + trailingNewline;
  if (roundTrip !== body) {
    throw new Error('template does not round-trip byte-stably (an integer-like key or foreign formatting?); refusing to rewrite the whole file');
  }

  const block = findAppliqueBlock(obj);
  block.settings = block.settings && typeof block.settings === 'object' ? block.settings : {};
  block.settings.pattern_options = text;

  const next = header + JSON.stringify(obj, null, 2) + trailingNewline;
  return { next, changed: next !== raw };
}
