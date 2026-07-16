// Regenerate the crewneck SVG golden fixture after an INTENTIONAL design or copy change to the seed.
// Run: npm run size-chart:golden:update   then review the fixture diff carefully (it is the pinned
// SS3000 design). Not a test file (no `.test.mjs`), so `node --test` does not pick it up.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSvg } from '../lib/render-svg.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(readFileSync(path.join(HERE, '..', 'profiles', 'crewneck-fleece.json'), 'utf8'));
const out = path.join(HERE, 'fixtures', 'crewneck-fleece.svg');
writeFileSync(out, buildSvg(seed));
console.log(`Regenerated ${out}`);
