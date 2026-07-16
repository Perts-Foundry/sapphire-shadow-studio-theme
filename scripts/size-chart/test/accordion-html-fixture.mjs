// Shared helpers for the accordion-html golden fixtures, imported by both the regen script
// (regen-golden.mjs) and the assertion (table-block.test.mjs) so the two cannot drift apart.
//
// Why these fixtures exist: the composed accordion prose is one long single-line HTML string, and
// it ships inside a JSON string in a product template. A wording change there is one 2KB changed
// line, which is unreviewable. `prettyHtml` stores the same bytes with one paragraph per line so
// the fixture diff is per-paragraph. The transform is lossless and the test asserts the round-trip,
// so the readable form cannot hide a real change.
//
// Not a test file (no `.test.mjs`), so `node --test` does not pick it up.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const ACCORDION_HTML_DIR = path.join(HERE, 'fixtures', 'accordion-html');

/** The composed prose out of a built accordion row. */
export function accordionHtmlOf(row) {
  return row.blocks.text_sc001.settings.text;
}

/** One paragraph per line, plus a trailing newline. Reversible via `compactHtml`. */
export function prettyHtml(html) {
  return `${html.replaceAll('</p>', '</p>\n').trimEnd()}\n`;
}

/** Inverse of `prettyHtml`: rejoin into the single-line form the template actually carries. */
export function compactHtml(pretty) {
  return pretty.replaceAll('\n', '');
}
