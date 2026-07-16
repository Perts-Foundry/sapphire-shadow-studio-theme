// Reader for scripts/size-chart/copy.md, which holds the GARMENT-INDEPENDENT prose for the on-page
// size-chart accordion. Per-measurement prose is not here: it lives on each profile column's
// `explain`, because what a measurement means differs per blank (a vest has no sleeve; the women's
// vest measures bust, not chest).
//
// copy.md carries three machine-consumed regions, delimited by HTML comment markers:
//   - accordion-intro-html:    the "measurements are of the garment laid flat" framing
//   - accordion-choosing-html: the "Choosing your size" tie-breaker + help line
//   - accordion-trailer-html:  the trailing spacer paragraph the theme's RTE wants
//
// Regions may contain `{{garment_noun}}` and `{{deciding_label}}` tokens, substituted per profile by
// lib/table-block.mjs. Tokens are sentence-medial, lowercase, and singular: restructure a sentence
// rather than capitalising or pluralising a token, because `garment_noun` is schema-constrained to
// lowercase and has no plural form.
//
// (The PNG's how-to panel and measurement callouts are per-profile too, living in each profile's
// `how_to` + `columns`, not here.)
//
// Pure Node fs; no external dependency.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_COPY_PATH = path.join(HERE, '..', 'copy.md');

// The only tokens a region may use. Anything else is a typo, and the composer throws on it rather
// than shipping a literal `{{...}}` to the storefront.
export const KNOWN_TOKENS = ['garment_noun', 'deciding_label'];

// Return the exact text between `<!-- name:start -->` and `<!-- name:end -->`, stripping
// exactly one newline just inside each marker so the region content is byte-exact.
function region(text, name) {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const i = text.indexOf(start);
  const j = text.indexOf(end);
  if (i === -1 || j === -1 || j < i) {
    throw new Error(`copy.md: missing or malformed region '${name}'`);
  }
  return text.slice(i + start.length, j).replace(/^\n/, '').replace(/\n$/, '');
}

export function readCopy(copyPath = DEFAULT_COPY_PATH) {
  const text = readFileSync(copyPath, 'utf8');
  return {
    accordionIntroHtml: region(text, 'accordion-intro-html'),
    accordionChoosingHtml: region(text, 'accordion-choosing-html'),
    accordionTrailerHtml: region(text, 'accordion-trailer-html'),
  };
}
