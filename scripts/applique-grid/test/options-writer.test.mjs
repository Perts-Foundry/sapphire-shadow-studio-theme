import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  upsertPatternOptions, findAppliqueBlock, assertOptionsText,
  BLOCK_ID, MAX_OPTION_LINE, MAX_OPTIONS_TEXT,
} from '../lib/options-writer.mjs';
import { splitHeader } from '../../size-chart/lib/template-writer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(HERE, '..', '..', '..', 'templates', 'product.huddle-crewneck.json');
const shipped = () => readFileSync(TEMPLATE_PATH, 'utf8');

const TEXT = '1. Sunset Bloom (white)\n2. Meadow Trace (grey)';

test('upsert on the real template changes exactly the pattern_options setting', () => {
  const raw = shipped();
  const { next, changed } = upsertPatternOptions(raw, TEXT);
  assert.equal(changed, true);
  const block = findAppliqueBlock(JSON.parse(splitHeader(next).body));
  assert.equal(block.settings.pattern_options, TEXT);
  // Byte-stable: the diff is confined to the one setting line.
  const before = splitHeader(raw).body.split('\n');
  const after = splitHeader(next).body.split('\n');
  assert.equal(before.length, after.length);
  const changedLines = before.filter((l, i) => l !== after[i]);
  assert.equal(changedLines.length, 1);
  assert.match(changedLines[0], /pattern_options/);
});

test('idempotent: re-upserting the same text is byte-identical and reports unchanged', () => {
  const first = upsertPatternOptions(shipped(), TEXT);
  const second = upsertPatternOptions(first.next, TEXT);
  assert.equal(second.changed, false);
  assert.equal(second.next, first.next);
});

test('N=0 derives a defined, still byte-stable empty string', () => {
  const { next, changed } = upsertPatternOptions(shipped(), '');
  assert.equal(changed, true);
  const block = findAppliqueBlock(JSON.parse(splitHeader(next).body));
  assert.equal(block.settings.pattern_options, '');
  assert.equal(upsertPatternOptions(next, '').changed, false);
});

test('CRLF text is refused (LF-only contract)', () => {
  assert.throws(() => upsertPatternOptions(shipped(), '1. A (white)\r\n2. B (grey)'), /LF-only/);
});

test('missing block errors', () => {
  const raw = shipped().replace(BLOCK_ID, 'renamed_block_001');
  assert.throws(() => upsertPatternOptions(raw, TEXT), /has no block "applique_pattern_001"/);
});

test('wrong block type errors', () => {
  const raw = shipped();
  const { header, body } = splitHeader(raw);
  const obj = JSON.parse(body);
  findAppliqueBlock(obj).type = 'text';
  const mutated = header + JSON.stringify(obj, null, 2) + (body.endsWith('\n') ? '\n' : '');
  assert.throws(() => upsertPatternOptions(mutated, TEXT), /expected "applique-pattern-select"/);
});

test('size ceilings hard-fail', () => {
  assert.throws(() => assertOptionsText(`1. ${'A'.repeat(MAX_OPTION_LINE)} (white)`), /line-item property value bound/);
  assert.throws(() => assertOptionsText('x\n'.repeat(MAX_OPTIONS_TEXT)), /implausibly large/);
});

test('a template with an integer-like key refuses to round-trip (key-order trap)', () => {
  // JS object iteration hoists integer-like keys, so a parse -> stringify cycle would REORDER
  // this file; the writer must refuse rather than emit a whole-file diff.
  const synthetic = `{
  "sections": {
    "main": {
      "type": "main-product",
      "blocks": {
        "applique_pattern_001": {
          "type": "applique-pattern-select",
          "settings": {
            "pattern_options": ""
          }
        }
      }
    },
    "10": {
      "type": "spacer"
    }
  },
  "order": ["main", "10"]
}
`;
  assert.throws(() => upsertPatternOptions(synthetic, TEXT), /does not round-trip byte-stably/);
});
