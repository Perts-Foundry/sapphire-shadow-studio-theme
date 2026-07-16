// The Size Chart anchor spans three layers that cannot see each other:
//
//   1. scripts/size-chart/lib/table-block.mjs  emits  anchor_id: 'SizeChart'  into template JSON
//   2. blocks/_accordion-row.liquid            renders that value as an id on its <summary>
//   3. snippets/size-guide-link.liquid         links to  href="#SizeChart"
//
// Nothing else can hold those together. The theme has no build step (assets ship as-is), so the
// Liquid literal cannot be generated from the JS constant. And the goldens in table-block.test.mjs
// cannot help: they compare the shipped row against a rebuild from the same generator, so if the
// generator's value changes, `apply-size-chart.mjs` rewrites the templates to agree and every one
// of them stays green while the link points at nothing. That failure is silent by design at
// runtime too, because assets/size-guide-link.js deliberately bails without preventDefault on a
// missing anchor rather than throwing.
//
// So this file IS the shared source of truth. It is deliberately textual and narrow: does the
// literal appear where the other layers hardcode it, and does the block that must render it
// actually declare the setting. It does not render Liquid or assert on markup.
//
// Scope note: these are theme-layer assertions living under scripts/size-chart/. That is the
// point. The tooling is the only layer in this repo with a test runner, and this contract is the
// tooling's to keep, because the tooling is what writes the value.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ANCHOR_ID } from '../lib/table-block.mjs';
import { ROOT } from './shipped-template.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// Liquid comments are prose, and prose talks about markup: the block's own comment explains why the
// anchor sits on the <summary>, which a naive /<summary[\s\S]*?>/ happily matches instead of the
// real tag. Strip commentary before asserting on markup.
const stripLiquidComments = (src) => src.replace(/{%-?\s*comment\s*-?%}[\s\S]*?{%-?\s*endcomment\s*-?%}/g, '');

test('the size-guide link targets the anchor the generator emits', () => {
  const link = read('snippets/size-guide-link.liquid');
  assert.match(
    link,
    new RegExp(`href="#${ANCHOR_ID}"`),
    `snippets/size-guide-link.liquid must link to #${ANCHOR_ID}. If you renamed ANCHOR_ID, rename it here too: nothing else connects them.`
  );
});

test('_accordion-row declares the anchor_id setting the generator writes', () => {
  // Without the setting, the value sits in the template JSON, every golden passes, and the
  // <summary> renders with no id at all.
  const row = read('blocks/_accordion-row.liquid');
  const schema = row.match(/{%\s*schema\s*%}([\s\S]*?){%\s*endschema\s*%}/);
  assert.ok(schema, 'blocks/_accordion-row.liquid has no {% schema %} block');

  const settings = JSON.parse(schema[1]).settings ?? [];
  assert.ok(
    settings.some((s) => s.id === 'anchor_id'),
    'blocks/_accordion-row.liquid must declare an "anchor_id" setting for the generated value to render'
  );
});

test('_accordion-row renders the anchor id onto the summary', () => {
  // Pinned to <summary> on purpose. An id on <details> would still scroll but would put focus and
  // the AT expanded-state announcement on the wrong node, and the reason for choosing <summary> is
  // subtle enough (see the block's inline comment) to be "tidied" later by someone reading the
  // HTML details-revealing algorithm and drawing the opposite conclusion.
  const row = stripLiquidComments(read('blocks/_accordion-row.liquid'));
  // `<summary\s` and not `<summary`: the latter also matches a bare "<summary>" written in prose.
  const summary = row.match(/<summary\s[\s\S]*?>/);
  assert.ok(summary, 'blocks/_accordion-row.liquid has no <summary> tag');
  assert.match(
    summary[0],
    /id="\{\{\s*block_settings\.anchor_id\s*\|\s*escape\s*\}\}"/,
    'the <summary> must render block_settings.anchor_id as an escaped id'
  );
});
