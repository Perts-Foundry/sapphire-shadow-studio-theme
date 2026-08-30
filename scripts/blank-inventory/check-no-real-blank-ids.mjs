#!/usr/bin/env node
// Guard: no REAL blank id may be committed to this public repo.
//
// Blank ids embed the supplier name and style number, which CLAUDE.md classifies as sensitive.
// Gitleaks catches token-shaped strings but not merchant-keyed prose, and this repo was already
// deleted and recreated once to scrub embedded metadata, so a one-time manual grep before the first
// PR protects nothing afterwards. This runs in CI on every PR.
//
// The check is STRUCTURAL and names no supplier: it looks for the shape of a blank id
// (underscore-separated uppercase segments ending in a size token) and allows only segments drawn
// from the synthetic vocabulary used by the test fixtures, unioned with the colour, body and size
// words catalogue.json declares (see the union note below the imports). A real supplier token is, by
// construction, in neither, so it fails.
//
// Usage: node scripts/blank-inventory/check-no-real-blank-ids.mjs [files...]
//        (with no arguments, scans every git-tracked file)

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { parseCatalogue, CATALOGUE_PATH } from '../lib/catalogue-manifest.mjs';

// THE MANIFEST WIDENS THIS GUARD; IT NEVER NARROWS IT. Both the size alternation and the allowlist
// below are the hand-curated list UNIONED with what catalogue.json declares. Deriving either
// outright would be the tidier-looking change and a strictly worse detector: the manifest declares
// six sizes today, so a derived alternation would drop `3XL` and `4XL`, and a real blank id ending
// `_3XL` would stop being detected. A leak detector that gets weaker in exchange for tidiness is not
// a trade worth making. The value of the union is forward-looking: a colour added to the manifest
// joins the allowlist automatically instead of tripping the guard on the fixture that uses it.
//
// A MALFORMED MANIFEST CRASHES THIS GUARD, and that is deliberate. parseCatalogue throws rather than
// degrading, so a broken catalogue.json fails the CI step instead of quietly scanning with a
// half-built vocabulary. This file's whole stance is that a leak detector failing open is worse than
// none (see the SKIP note below); failing closed here is the same stance.
const MANIFEST = parseCatalogue(readFileSync(new URL(`../../${CATALOGUE_PATH}`, import.meta.url), 'utf8'));

/** The eight size tokens this guard has always detected, whatever the catalogue declares. */
export const LEGACY_SIZE_TOKENS = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'];

/**
 * Uppercase word tokens for one manifest value, both split and flattened.
 *
 * `quarter-zip` yields QUARTER, ZIP and QUARTERZIP; `grey heather` yields GREY, HEATHER and
 * GREYHEATHER. Both forms, because a blank id may join the words either way and neither spelling
 * names a supplier.
 *
 * A DIGIT-LEADING WORD COUNTS. A body `tee-2pack` must yield 2PACK, because `2PACK` is a legal
 * non-leading segment of a blank id and would otherwise trip the guard on the fixture that uses it,
 * which is the exact failure this union exists to prevent. The filter requires at least one LETTER
 * rather than a leading one: a purely numeric segment is already exempt in `findSuspectTokens`, so
 * adding one here would be noise.
 *
 * @param {string} value
 * @returns {string[]}
 */
const IS_WORD = /^[A-Z0-9]*[A-Z][A-Z0-9]*$/;
function tokensOf(value) {
  const parts = String(value).split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w.toUpperCase());
  const out = parts.filter((w) => IS_WORD.test(w));
  if (parts.length > 1) {
    const joined = parts.join('');
    if (IS_WORD.test(joined)) out.push(joined);
  }
  return out;
}

/**
 * Size tokens to detect: the legacy eight unioned with whatever the manifest declares, longest first
 * so the regex alternation stays greedy-correct (`2XL` must be tried before `L`).
 *
 * MANIFEST VALUES ARE FILTERED TO `[A-Z0-9]+`, NOT ESCAPED, and the difference matters. These go
 * straight into a `RegExp` source, and `normaliseAxis` lowercases and trims but does not restrict
 * characters, so `parseCatalogue` would accept a size of `3xl(tall)` (which throws a SyntaxError at
 * module load and takes the guard down on an otherwise valid catalogue edit) or `s?` (which compiles
 * and silently changes what the alternation matches). Escaping would preserve both as literals, but a
 * blank id's segments are `[A-Z0-9]+` by construction, so a size carrying punctuation could never
 * appear in one and is not something to detect. Dropping it is both safe and correct; the legacy
 * eight are unaffected either way, so this can never narrow detection below the old behaviour.
 *
 * @param {Iterable<string>} manifestSizes - normalised size tokens
 * @returns {string[]}
 */
export function sizeAlternation(manifestSizes) {
  const set = new Set(LEGACY_SIZE_TOKENS);
  for (const size of manifestSizes) {
    const token = String(size).toUpperCase();
    if (/^[A-Z0-9]+$/.test(token)) set.add(token);
  }
  return [...set].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Allowlist tokens implied by a manifest: its colour words and its body words.
 *
 * These name a colour or a KIND of clothing, never a maker of one, so they satisfy the
 * positive-detection rule stated below.
 *
 * @param {{bodies: Map<string, {colors: string[], sizes: string[]}>}} manifest
 * @returns {string[]}
 */
export function segmentsFromManifest(manifest) {
  const out = new Set();
  for (const [body, range] of manifest.bodies) {
    for (const token of tokensOf(body)) out.add(token);
    for (const color of range.colors) for (const token of tokensOf(color)) out.add(token);
  }
  return [...out];
}

const SIZE_TOKENS = sizeAlternation([...MANIFEST.bodies.values()].flatMap((r) => r.sizes));
const SIZES = SIZE_TOKENS.join('|');
const BLANK_ID_SHAPE = new RegExp(String.raw`\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}_(?:${SIZES})\b`, 'g');

// THE POSITIVE-DETECTION RULE, stated before the allowlist because every future edit to the list
// depends on it:
//
//   Numeric segments are already exempt (`/^\d+$/` below), so a style NUMBER is invisible to this
//   guard. Detection therefore rests ENTIRELY on supplier NAME tokens: a real id fails because it
//   carries a word that is not in this list. Widening the list is safe if and only if every token
//   added is one that could never be a supplier's name. Garment, colour and size words qualify.
//   A token that reads like a company or brand does not, and must never be added, whatever
//   convenience it buys.
//
// Deliberately does NOT list the real tokens.
const ALLOWED_SEGMENTS = new Set([
  // colour words used by the fixtures and by the live option values
  'BLACK', 'GREY', 'GRAY', 'NAVY', 'WHITE', 'HEATHER', 'CLASSIC',
  // the synthetic vendor + garment vocabulary in test/fixtures.mjs
  'ACME', 'FLEECE', 'BLANKA', 'BLANKB', 'EXAMPLE', 'SAMPLE', 'TEST', 'FAKE',
  // garment body words. These name a KIND of clothing, never a maker of it, so they cannot
  // encode the supplier the guard exists to keep out.
  'CREWNECK', 'CREW', 'QUARTERZIP', 'QTRZIP', 'HALFZIP', 'ZIP', 'PULLOVER', 'HOODIE',
  'SWEATSHIRT', 'TEE', 'TSHIRT', 'TANK', 'VEST', 'JACKET', 'LONGSLEEVE', 'SLEEVE',
  // fit qualifiers
  'WOMENS', 'MENS', 'UNISEX', 'YOUTH',
  // structural placeholders that may appear in docs
  'COLOR', 'COLOUR', 'BLANK', 'SIZE', 'SUPPLIER', 'STYLE', 'BODY',
]);

// The manifest union, added AFTER the declaration above rather than folded into it. The
// positive-detection rule comment has to stay immediately above `const ALLOWED_SEGMENTS`: a test
// matches on the text between the two, so a reviewer widening the list cannot miss the rule.
// `add`, never a replacement, for the reason given at the top of this file.
for (const segment of segmentsFromManifest(MANIFEST)) ALLOWED_SEGMENTS.add(segment);

export { ALLOWED_SEGMENTS };

const SIZE_SET = new Set(SIZE_TOKENS);

// Binary and vendored paths that are never prose.
//
// `.blank-inventory` is deliberately NOT skipped. It used to be, matching at any path depth, which
// meant the one directory guaranteed to contain real blank ids was the one directory the guard
// refused to look at. A cwd-relative run created `scripts/blank-inventory/.blank-inventory/`, and
// passing that artifact to the guard explicitly reported "scanned 0 file(s), no real blank ids
// found". The working directory now lives outside the repo entirely (lib/workdir.mjs), so no
// in-repo path is legitimate and there is nothing here to exempt. A leak detector that fails open
// on its highest-risk input is worse than none.
const SKIP = /(^|\/)(node_modules|\.git|product-images)\//;
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|ttf|otf|woff2?|zip|pdf|mp4|webm)$/i;

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

/**
 * Blank-id-shaped tokens in `text` that contain a segment outside the synthetic vocabulary.
 * @param {string} text
 * @returns {string[]}
 */
export function findSuspectTokens(text) {
  const hits = new Set();
  for (const match of text.matchAll(BLANK_ID_SHAPE)) {
    const token = match[0];
    const segments = token.split('_').filter((s) => !SIZE_SET.has(s));
    const suspect = segments.filter((s) => !ALLOWED_SEGMENTS.has(s) && !/^\d+$/.test(s));
    if (suspect.length) hits.add(token);
  }
  return [...hits];
}

function main() {
  const args = process.argv.slice(2);
  const files = (args.length ? args : trackedFiles()).filter((f) => !SKIP.test(f) && !BINARY.test(f));

  const findings = [];
  for (const file of files) {
    let text;
    try {
      if (statSync(file).size > 2_000_000) continue;
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const tokens = findSuspectTokens(text);
    if (tokens.length) findings.push({ file, tokens });
  }

  if (!findings.length) {
    console.log(`blank-id guard: scanned ${files.length} file(s), no real blank ids found.`);
    return;
  }

  console.error('\nblank-id guard FAILED: blank-id-shaped tokens with non-synthetic segments.\n');
  for (const f of findings) {
    // Print the file and the segment count, never the token itself: echoing it into a public CI
    // log would leak the very thing this guard exists to keep out of the repo.
    console.error(`  ${f.file}: ${f.tokens.length} suspect token(s)`);
  }
  console.error(
    `\nBlank ids embed the supplier and style number and must never be committed. Use the synthetic\n` +
      `vocabulary from scripts/blank-inventory/test/fixtures.mjs instead. See CLAUDE.md.\n`
  );
  process.exit(1);
}

// pathToFileURL, not a `file://` template. import.meta.url percent-encodes spaces and non-ASCII
// characters, so a hand-built string silently fails to match on a checkout path containing either,
// main() never runs, and the guard exits 0 having scanned nothing. A leak detector that fails open
// is worse than none, so the comparison has to be exact.
//
// argv[1] is undefined under `import()` (no entry script), which threw and made the module
// unimportable, so the tests below could not exercise it. Guard the dereference rather than the
// comparison: an unimportable guard cannot be unit-tested at all.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
