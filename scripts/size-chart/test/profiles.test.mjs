import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProfile } from '../lib/profile-schema.mjs';
import { buildSvg } from '../lib/render-svg.mjs';
import { ACCORDION_ROW_ID } from '../lib/table-block.mjs';
import { altText } from '../render-size-chart.mjs';
import {
  disabledAncestors,
  fileForSuffix,
  findAccordionOrNull,
  productTemplateFiles,
  readShippedTemplate,
} from './shipped-template.mjs';

// Every shipped profile must validate and render an SVG without throwing. This is the coverage that
// exercises the whole generalization payload at once: the vest / quarter-zip silhouettes, the zipper
// anchor, the new roles + range/string kinds, derive in both directions, and the content-derived
// canvas height on real content.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const PROFILES_DIR = path.join(HERE, '..', 'profiles');
const files = readdirSync(PROFILES_DIR).filter((f) => f.endsWith('.json'));

// The three shipping blanks: crewneck-fleece, quarter-zip-midweight, vest-microfleece-womens.
// Was 4 until the unisex microfleece vest was dropped from the launch (2026-07-16); its profile is
// recoverable from git history if that blank comes back.
test('the profiles directory has the expected blanks', () => {
  assert.ok(files.length >= 3, `expected >= 3 profiles, found ${files.length}`);
});

// Each "handles" entry is a template suffix that apply-size-chart.mjs interpolates into
// templates/product.<suffix>.json. A suffix with no matching template is only SKIPped there, and the
// run still exits 0, so a typo (or a real Shopify product handle pasted in by mistake, which is a
// different string) applies nothing and reports success. Pin the suffixes to the files on disk so
// that mistake is red here instead of silent. An empty array passes: a profile may be authored
// before its template exists.
for (const f of files) {
  test(`profile ${f} handles all resolve to a template on disk`, () => {
    const profile = JSON.parse(readFileSync(path.join(PROFILES_DIR, f), 'utf8'));
    for (const handle of profile.handles ?? []) {
      const rel = path.join('templates', `product.${handle}.json`);
      assert.ok(existsSync(path.join(ROOT, rel)), `${f}: handles entry '${handle}' has no ${rel}`);
    }
  });
}

// Identify a size-chart row by the union of its id and its heading, never by either alone. The id
// is what the writer upserts on, so a duplicate under that id is impossible (JSON keys collapse)
// and a row carrying it is unambiguously ours. The heading catches a row cloned in under some other
// id, which the id alone cannot see. The union matters on a rename: change the heading in
// table-block.mjs and regenerate, and an id-only scan still finds a stale row left under the old
// heading, while a heading-only scan goes blind to it and reports one chart on a page rendering
// two. The 'Size Chart' literal here is deliberately not imported from table-block.mjs; these
// tests guard that writer, and a test that reads its constant agrees with it by construction.
const isSizeChartRow = ([id, row]) => id === ACCORDION_ROW_ID || row?.settings?.heading === 'Size Chart';

function sizeChartRowsIn(file) {
  const found = findAccordionOrNull(readShippedTemplate(file));
  if (!found) return [];
  return Object.entries(found.accordion.blocks ?? {}).filter(isSizeChartRow);
}

const productTemplates = productTemplateFiles();

// A directory listing drives the loop below, so an empty one would emit zero tests and still exit
// 0. Mirrors the profile-count guard above.
test('the templates directory has product templates to check', () => {
  assert.ok(productTemplates.length >= 3, `expected >= 3 product templates, found ${productTemplates.length}`);
});

// No product page may ever show two size charts. Asserted over every template on disk, including
// any that no profile claims, since a stray hand-added row is exactly the case the handles-driven
// checks below cannot see.
for (const file of productTemplates) {
  test(`template ${file} has no duplicate size-chart row`, () => {
    const rows = sizeChartRowsIn(file);
    assert.ok(rows.length <= 1, `expected <= 1 size-chart row, found ${rows.length}: ${rows.map(([id]) => id).join(', ')}`);
  });
}

// The other direction: a suffix a profile claims must carry that blank's chart, and that chart must
// actually reach the page. Guards apply-size-chart.mjs's silent-SKIP path, where a suffix with no
// matching template reports success having written nothing. That the row's *content* matches the
// profile is the cohesion golden's job (table-block.test.mjs); these two only cover renderability,
// which a deep-equal on the row cannot see because both live outside it.
for (const f of files) {
  for (const suffix of JSON.parse(readFileSync(path.join(PROFILES_DIR, f), 'utf8')).handles ?? []) {
    const file = fileForSuffix(suffix);

    // Shopify renders an accordion's children by walking block_order, so a row present in `blocks`
    // but missing from `block_order` is invisible on the storefront while looking intact on disk.
    // template-writer.mjs maintains the two on separate code paths, so they can diverge.
    test(`${file} lists its size-chart row in block_order`, () => {
      const { accordion } = findAccordionOrNull(readShippedTemplate(file));
      assert.ok(
        accordion.block_order.includes(ACCORDION_ROW_ID),
        `${ACCORDION_ROW_ID} is in blocks but absent from block_order, so the page renders no chart`,
      );
    });

    test(`${file} has no disabled ancestor hiding its size-chart row`, () => {
      const obj = readShippedTemplate(file);
      const { accId } = findAccordionOrNull(obj);
      const off = disabledAncestors(obj, accId, ACCORDION_ROW_ID);
      assert.deepStrictEqual(off, [], `disabled: true at ${off.join(', ')} hides the size chart`);
    });
  }
}

for (const f of files) {
  test(`profile ${f} validates and renders`, () => {
    const profile = JSON.parse(readFileSync(path.join(PROFILES_DIR, f), 'utf8'));
    assert.equal(validateProfile(profile), true);
    const svg = buildSvg(profile);
    assert.match(svg, /^<svg /);
    assert.match(svg, /<\/svg>$/);
    if (profile.garment) assert.ok(svg.includes('<g transform='), 'expected a garment silhouette group');
    assert.ok(altText(profile).startsWith(profile.display_name));
  });
}
