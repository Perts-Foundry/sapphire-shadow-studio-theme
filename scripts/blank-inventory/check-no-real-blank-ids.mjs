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

const SIZES = 'XS|S|M|L|XL|2XL|3XL|4XL';
const BLANK_ID_SHAPE = new RegExp(String.raw`\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}_(?:${SIZES})\b`, 'g');

// Segments that are known-synthetic (test fixtures) or generic. Anything else in a blank-id-shaped
// token is treated as a real supplier or style leak. Deliberately does NOT list the real tokens.
const ALLOWED_SEGMENTS = new Set([
  // colour words used by the fixtures and by the live option values
  'BLACK', 'GREY', 'GRAY', 'NAVY', 'WHITE',
  // the synthetic vendor + garment vocabulary in test/fixtures.mjs
  'ACME', 'FLEECE', 'BLANKA', 'BLANKB', 'EXAMPLE', 'SAMPLE', 'TEST', 'FAKE',
  // structural placeholders that may appear in docs
  'COLOR', 'COLOUR', 'BLANK', 'SIZE', 'SUPPLIER', 'STYLE',
]);

const SIZE_SET = new Set(SIZES.split('|'));

// Binary and vendored paths that are never prose.
const SKIP = /(^|\/)(node_modules|\.git|product-images|\.blank-inventory)\//;
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

if (import.meta.url === `file://${process.argv[1]}`) main();
