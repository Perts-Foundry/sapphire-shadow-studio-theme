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
// of them stays green while the link points at nothing. That failure is silent at runtime too,
// because assets/size-guide-link.js deliberately bails without preventDefault on a missing anchor.
//
// So this file IS the shared source of truth, and it hardcodes the literal rather than importing
// ANCHOR_ID. That follows the ruling already made in profiles.test.mjs:66 for the sibling case:
// "these tests guard that writer, and a test that reads its constant agrees with it by
// construction." Importing ANCHOR_ID here would make the central assertion self-satisfying.
//
// Hardcoding also buys the tripwire that matters most: `#SizeChart` is an EXTERNAL contract.
// assets/accordion-custom.js honours /products/x#SizeChart from a shared or bookmarked URL, so a
// rename breaks links already in the wild. No amount of internal consistency detects that. If you
// are renaming it on purpose, changing this literal is the deliberate act that says so.
//
// Assertions read markup, never prose: every Liquid {% comment %} and {% doc %} block is stripped
// first, and each pattern is anchored to a real tag. These files document their own markup, so an
// unstripped grep for `href="#SizeChart"` is satisfied by the sentence explaining the href, and
// the feature could then be deleted outright with this suite green.
//
// Scope note: these are theme-layer assertions living under scripts/size-chart/. That is the
// point. The tooling is the only layer in this repo with a test runner, and this contract is the
// tooling's to keep, because the tooling is what writes the value.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAccordionRow } from '../lib/table-block.mjs';
import { ROOT, productTemplateFiles, readShippedTemplate, findAccordionOrNull } from './shipped-template.mjs';
import { resolvedProfile } from './profile-fixture.mjs';

// Deliberately not imported from table-block.mjs. See the header.
const ANCHOR = 'SizeChart';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = path.join(HERE, '..', 'profiles');

const profiles = readdirSync(PROFILES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => resolvedProfile(f));

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// Liquid comments and doc blocks are prose, and prose in these files talks about the very markup
// being asserted on: _accordion-row's comment contains "<summary>", and size-guide-link's {% doc %}
// contains `<a href>`. Strip commentary before matching, or the tests pin comments to comments.
const stripLiquidProse = (src) =>
  src
    .replace(/{%-?\s*comment\s*-?%}[\s\S]*?{%-?\s*endcomment\s*-?%}/g, '')
    .replace(/{%-?\s*doc\s*-?%}[\s\S]*?{%-?\s*enddoc\s*-?%}/g, '');

test('the generator emits the anchor the theme layers hardcode', () => {
  // The load-bearing one. Rename ANCHOR_ID and regenerate: the goldens all agree with the new
  // value and go green, and only this fails.
  for (const profile of profiles) {
    assert.equal(buildAccordionRow(profile).settings.anchor_id, ANCHOR, profile.blank_id);
  }
});

test('the size-guide link targets the anchor the generator emits', () => {
  const link = stripLiquidProse(read('snippets/size-guide-link.liquid'));
  const anchor = link.match(/<a\s[^>]*>/);
  assert.ok(anchor, 'snippets/size-guide-link.liquid renders no <a> tag; a real href is the point');
  assert.match(
    anchor[0],
    new RegExp(`href="#${ANCHOR}"`),
    `the <a> must link to #${ANCHOR}. Nothing else connects it to the generator.`
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

test('_accordion-row renders the anchor id onto the summary, escaped and guarded', () => {
  // Pinned to <summary> on purpose. An id on <details> would still scroll but would put focus and
  // the AT expanded-state announcement on the wrong node, and the reason for choosing <summary> is
  // subtle enough (see the block's inline comment) to be "tidied" later by someone reading the
  // HTML details-revealing algorithm and drawing the opposite conclusion.
  //
  // The pattern accepts either the `block_settings` alias or `block.settings` directly, and
  // whitespace-control dashes: the alias is incidental, and this file is Admin-writable (it is
  // CRLF-terminated, the Shopify code editor's signature), so a writer that is not us reformats
  // it. What is actually being pinned is "the id comes from anchor_id, escaped".
  const row = stripLiquidProse(read('blocks/_accordion-row.liquid'));

  // `<summary\s` and not `<summary`: prose writes a bare "<summary>", markup always has attributes.
  const summary = row.match(/<summary\s[\s\S]*?>/);
  assert.ok(summary, 'blocks/_accordion-row.liquid has no <summary> tag');
  assert.match(
    summary[0],
    /id="\{\{-?\s*(?:block_settings|block\.settings)\.anchor_id\s*\|\s*escape\s*-?\}\}"/,
    'the <summary> must render the anchor_id setting as an escaped id'
  );

  // The guard is what keeps every unanchored accordion row in the theme byte-identical to before.
  // Drop it and they all render id="".
  assert.match(
    summary[0],
    /{%-?\s*if\s+(?:block_settings|block\.settings)\.anchor_id\s*!=\s*blank\s*-?%}/,
    'the id must stay behind an "anchor_id != blank" guard, or unanchored rows render id=""'
  );
});

// A page with two #SizeChart elements silently scrolls to whichever comes first in document order.
// Reachable through the documented Admin workflow: anchor_id is a merchant-facing text setting on
// every accordion row, so someone can type it onto a second row by hand. Scanned across every
// product template on disk, including any no profile claims, mirroring the duplicate-row scan in
// profiles.test.mjs.
const anchorsIn = (file) => {
  const found = findAccordionOrNull(readShippedTemplate(file));
  if (!found) return [];
  return Object.entries(found.accordion.blocks ?? {}).filter(
    ([, block]) => block?.settings?.anchor_id === ANCHOR
  );
};

for (const file of productTemplateFiles()) {
  test(`template ${file} has no duplicate ${ANCHOR} anchor`, () => {
    const rows = anchorsIn(file);
    assert.ok(
      rows.length <= 1,
      `expected <= 1 row anchored ${ANCHOR}, found ${rows.length}: ${rows.map(([id]) => id).join(', ')}`
    );
  });
}
