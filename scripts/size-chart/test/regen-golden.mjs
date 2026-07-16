// Regenerate the pinned golden fixtures after an INTENTIONAL design or copy change.
// Run: npm run size-chart:golden:update   then review the fixture diffs carefully.
//
// Two kinds of golden live here:
//
//   fixtures/crewneck-fleece.svg          the canonical SS3000 PNG design (seed blank only)
//   fixtures/accordion-html/<blank>.html  the on-page accordion prose, one file per blank
//
// The accordion-html fixtures make a prose change reviewable *as prose*: the shipped product
// templates carry the same HTML inside a JSON string, where a wording change renders as one 2KB
// changed line that no reviewer can read. They are also the only coverage a blank authored ahead
// of its template has, since it has no `handles` yet and so no shipped template for the cohesion
// goldens to compare against.
//
// Not a test file (no `.test.mjs`), so `node --test` does not pick it up.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSvg } from '../lib/render-svg.mjs';
import { buildAccordionRow } from '../lib/table-block.mjs';
import { prettyHtml, ACCORDION_HTML_DIR, accordionHtmlOf } from './accordion-html-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = path.join(HERE, '..', 'profiles');

const seed = JSON.parse(readFileSync(path.join(PROFILES_DIR, 'crewneck-fleece.json'), 'utf8'));
const svgOut = path.join(HERE, 'fixtures', 'crewneck-fleece.svg');
writeFileSync(svgOut, buildSvg(seed));
console.log(`Regenerated ${svgOut}`);

mkdirSync(ACCORDION_HTML_DIR, { recursive: true });
for (const file of readdirSync(PROFILES_DIR).filter((n) => n.endsWith('.json'))) {
  const profile = JSON.parse(readFileSync(path.join(PROFILES_DIR, file), 'utf8'));
  const out = path.join(ACCORDION_HTML_DIR, `${profile.blank_id}.html`);
  writeFileSync(out, prettyHtml(accordionHtmlOf(buildAccordionRow(profile))));
  console.log(`Regenerated ${out}`);
}
