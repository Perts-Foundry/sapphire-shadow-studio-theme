import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProfile } from '../lib/profile-schema.mjs';
import { buildSvg } from '../lib/render-svg.mjs';
import { altText } from '../render-size-chart.mjs';

// Every shipped profile must validate and render an SVG without throwing. This is the coverage that
// exercises the whole generalization payload at once: the vest / quarter-zip silhouettes, the zipper
// anchor, the new roles + range/string kinds, derive in both directions, and the canvas_height
// default + overflow guard on real content.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = path.join(HERE, '..', 'profiles');
const files = readdirSync(PROFILES_DIR).filter((f) => f.endsWith('.json'));

test('the profiles directory has the expected blanks', () => {
  assert.ok(files.length >= 4, `expected >= 4 profiles, found ${files.length}`);
});

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
