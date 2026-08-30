import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCopy, KNOWN_TOKENS } from '../lib/copy.mjs';
import { resolvedProfile } from './profile-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = path.join(HERE, '..', 'profiles');
const profiles = readdirSync(PROFILES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => resolvedProfile(f));

const shipped = readCopy();
const sharedRegions = [shipped.accordionIntroHtml, shipped.accordionChoosingHtml];

// Write a throwaway copy.md and read it back through the `copyPath` seam.
function withCopy(body) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sizechart-copy-'));
  const p = path.join(dir, 'copy.md');
  writeFileSync(p, body);
  return p;
}

const REGIONS = ['accordion-intro-html', 'accordion-choosing-html', 'accordion-trailer-html'];
const wellFormed = REGIONS.map((r) => `<!-- ${r}:start -->\n<p>x</p>\n<!-- ${r}:end -->`).join('\n\n');

test('reads all three regions from a well-formed copy.md', () => {
  const c = readCopy(withCopy(wellFormed));
  assert.equal(c.accordionIntroHtml, '<p>x</p>');
  assert.equal(c.accordionChoosingHtml, '<p>x</p>');
  assert.equal(c.accordionTrailerHtml, '<p>x</p>');
});

test('throws on a missing region rather than composing half the prose', () => {
  const missing = wellFormed.replace(/<!-- accordion-choosing-html:start -->[\s\S]*?<!-- accordion-choosing-html:end -->/, '');
  assert.throws(() => readCopy(withCopy(missing)), /missing or malformed region 'accordion-choosing-html'/);
});

test('throws on a malformed region (end marker before start)', () => {
  const swapped = '<!-- accordion-intro-html:end -->\n<p>x</p>\n<!-- accordion-intro-html:start -->';
  assert.throws(() => readCopy(withCopy(swapped)), /missing or malformed region/);
});

test('an empty region reads as empty rather than silently inheriting', () => {
  const empty = wellFormed.replace('<!-- accordion-trailer-html:start -->\n<p>x</p>', '<!-- accordion-trailer-html:start -->\n');
  assert.equal(readCopy(withCopy(empty)).accordionTrailerHtml, '');
});

test('every shipped region is non-empty', () => {
  for (const [name, html] of Object.entries(shipped)) {
    assert.ok(html.length > 0, `${name} is empty`);
  }
});

// ── The invariant this file exists to protect ─────────────────────────────────
//
// copy.md is the GARMENT-INDEPENDENT prose. Before the per-garment refactor it silently was not:
// every blank got the crewneck's wording, so the women's vest explained "Sleeve length" and "Chest
// (circumference)" while its own table read Bust and Body Length. This is the executable form of the
// rule, so that cannot come back.

test('shared copy names no garment and no measurement', () => {
  // Derived from the shipped profiles rather than hardcoded, so a fifth blank extends the guard for
  // free. A static floor keeps the four original leak words covered even if a profile is removed.
  const fromProfiles = profiles.flatMap((p) => [
    p.garment_noun,
    ...p.columns.flatMap((c) => [c.heading, c.callout_label]),
  ]);
  const floor = ['sweatshirt', 'sleeve', 'vest', 'zip', 'bust', 'chest'];
  const words = [...new Set([...fromProfiles, ...floor].filter(Boolean))]
    // Split headings like "Chest (laid flat)" into words, drop the punctuation and short filler.
    .flatMap((s) => s.toLowerCase().split(/[^a-z]+/))
    .filter((w) => w.length > 2 && !['the', 'and', 'size', 'body', 'length', 'flat', 'laid'].includes(w));

  for (const region of sharedRegions) {
    for (const word of new Set(words)) {
      // \b-bounded: an unbounded /vest/ matches "invest", and /zip/ matches "zip code".
      assert.doesNotMatch(region, new RegExp(`\\b${word}\\b`, 'i'), `shared copy names '${word}'; move it to a column's explain`);
    }
  }
});

test('shared copy uses only known tokens', () => {
  // The one non-heuristic assertion here: a typo'd token would otherwise reach the storefront as
  // literal `{{...}}` if the composer's throw were ever loosened.
  for (const region of Object.values(shipped)) {
    for (const [, name] of region.matchAll(/\{\{([^}]*)\}\}/g)) {
      assert.ok(KNOWN_TOKENS.includes(name), `unknown token {{${name}}} in copy.md`);
    }
  }
});

test('shared copy contains no em dash', () => {
  for (const [name, html] of Object.entries(shipped)) {
    assert.doesNotMatch(html, /\u2014/, `${name} contains an em dash`);
  }
});

test('{{garment_noun}} is never sentence-initial and never follows "an"', () => {
  // Scoped to garment_noun, and only garment_noun. It is schema-constrained to lowercase, so
  // opening a sentence with it would render "Sweatshirt sizes..." as "sweatshirt sizes...", and
  // "an {{garment_noun}}" cannot agree for a consonant-initial noun.
  //
  // {{deciding_label}} is deliberately exempt: it resolves to a column heading ("Chest (laid
  // flat)", "Bust (laid flat)"), which is already capitalised, so it opens the "Choosing your size"
  // sentence correctly.
  for (const region of sharedRegions) {
    assert.doesNotMatch(region, /(^|[.!?]\s+|>\s*)\{\{garment_noun\}\}/, 'garment_noun at sentence start would render lowercase');
    assert.doesNotMatch(region, /\ban\s+\{\{garment_noun\}\}/i, 'article agreement cannot be guaranteed for garment_noun');
  }
});
