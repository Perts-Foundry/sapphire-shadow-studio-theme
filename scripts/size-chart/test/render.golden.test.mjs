import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSvg } from '../lib/render-svg.mjs';
import { resolvedProfile } from './profile-fixture.mjs';

// Environment-independent golden: the crewneck's SVG string, not rasterised pixels. Pins the
// canonical SS3000 design so the column-driven generalisation cannot change it. The fixture was
// captured from the pre-refactor buildSvg output; the generalised engine must reproduce it exactly
// for the seed blank. (PNG bytes are librsvg/FreeType-bound and deliberately not asserted.)

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = resolvedProfile('crewneck-fleece');
const GOLDEN = readFileSync(path.join(HERE, 'fixtures', 'crewneck-fleece.svg'), 'utf8');

test('crewneck buildSvg matches the pinned SVG golden byte-for-byte', () => {
  assert.equal(buildSvg(SEED), GOLDEN);
});
