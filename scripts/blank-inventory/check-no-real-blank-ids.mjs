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
// from the synthetic vocabulary used by the test fixtures. A real supplier token is, by
// construction, not in that list, so it fails.
//
// Usage: node scripts/blank-inventory/check-no-real-blank-ids.mjs [files...]
//        (with no arguments, scans every git-tracked file)

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SIZES = 'XS|S|M|L|XL|2XL|3XL|4XL';
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

const SIZE_SET = new Set(SIZES.split('|'));

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
