import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProfile } from '../lib/profile-schema.mjs';
import { buildSvg } from '../lib/render-svg.mjs';
import { altText } from '../render-size-chart.mjs';

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
