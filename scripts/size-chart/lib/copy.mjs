// Reader for scripts/size-chart/copy.md, the single source of truth for the on-page size-chart prose.
//
// copy.md carries one machine-consumed region delimited by HTML comment markers:
//   - accordion-html: the verbatim rich-text HTML for the on-page `text_sc001` block. It must stay
//     byte-for-byte identical to the live block; the cohesion golden test depends on it.
//
// (The PNG's how-to panel and measurement callouts are per-profile now, so they live in each
// profile's `how_to` + `columns`, not here.)
//
// Pure Node fs; no external dependency.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_COPY_PATH = path.join(HERE, '..', 'copy.md');

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
  const accordionHtml = region(text, 'accordion-html');
  return { accordionHtml };
}
