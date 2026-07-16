// Build the canonical "Size Chart" accordion row (accordion_row_sc001) from a profile. The
// returned object matches the live templates' structure and key order exactly, so serialising it
// reproduces the existing block byte-for-byte for the seed blank (the cohesion golden test).
//
// The row nests a `text_sc001` rich-text block and a `table_9Nak3q` table block. Both are
// column-driven: the table's `column_count`, `colN_heading` labels and `rMcN` cells come from the
// profile's `columns` (rows 1..sizes.length filled, the rest left empty so the theme block
// auto-hides them), and the prose is composed as
//
//   intro + choosing + one <p> per column that declares `explain` + trailer
//
// with the framing paragraphs coming from copy.md. So a measurement is explained if and only if the
// blank has that column: the vests get no sleeve paragraph and the quarter-zip gets a zipper one,
// with no conditionals anywhere. Pure; no fs beyond copy.md via readCopy, no sharp.

import { deriveRows } from './normalize.mjs';
import { readCopy, KNOWN_TOKENS } from './copy.mjs';

// The theme table block (blocks/table.liquid) supports up to 8 rows and 6 columns.
const MAX_ROWS = 8;

// Mirrors lib/render-svg.mjs: a column's public label is its callout_label, falling back to the
// table heading. Keeping one rule means the PNG legend and the accordion cannot disagree.
const labelOf = (col) => col.callout_label ?? col.heading;

// The prose is written into a Shopify rich-text setting, so anything interpolated into it is HTML.
// profile-schema rejects these characters in the fields that land here, making this the second of
// two layers rather than the only one: the schema reject is a loud authoring error, this is the
// guarantee.
const escapeHtml = (s) =>
  String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// Substitute the known tokens. Uses replaceAll with a *function* replacement: a plain string
// replacement would let a `$&` inside a profile-authored label corrupt the output via
// String.replace's special replacement patterns.
function fillTokens(html, values) {
  let out = html;
  for (const token of KNOWN_TOKENS) {
    out = out.replaceAll(`{{${token}}}`, () => values[token]);
  }
  return out;
}

// Refuse to emit prose with a `{{...}}` left in it. Swept over the FINAL composed string, not just
// the substituted regions, so it also covers the trailer and any token written into a profile's
// `explain`. Substitution deliberately does not reach `explain`: a profile must not be able to
// inject into the shared copy pipeline, so a token there is an error, not an expansion.
function assertNoTokens(html) {
  const leftover = html.match(/\{\{[^}]*\}\}/);
  if (leftover) {
    throw new Error(
      `unresolved token ${leftover[0]} in composed accordion prose. Known tokens: ${KNOWN_TOKENS.map((t) => `{{${t}}}`).join(', ')}`,
    );
  }
}

// Compose the accordion prose for one profile.
function buildProse(profile) {
  const { accordionIntroHtml, accordionChoosingHtml, accordionTrailerHtml } = readCopy();

  const deciding = profile.columns.find((c) => c.decides_size === true);
  // profile-schema enforces exactly one; this guards a caller that skipped validation.
  if (!deciding) throw new Error(`profile ${profile.blank_id}: no column sets decides_size: true`);

  const values = {
    garment_noun: escapeHtml(profile.garment_noun),
    deciding_label: escapeHtml(labelOf(deciding)),
  };

  const explained = profile.columns
    .filter((c) => typeof c.explain === 'string' && c.explain.length > 0)
    .map((c) => `<p><strong>${escapeHtml(labelOf(c))}</strong> ${escapeHtml(c.explain)}</p>`);

  const html = [
    fillTokens(accordionIntroHtml, values),
    fillTokens(accordionChoosingHtml, values),
    ...explained,
    accordionTrailerHtml,
  ].join('');

  assertNoTokens(html);
  return html;
}

function buildTableSettings(rows, columns) {
  const n = columns.length;
  const settings = {
    column_count: String(n),
    show_header: true,
    stripe_rows: true,
  };
  for (let c = 1; c <= n; c++) settings[`col${c}_heading`] = columns[c - 1].heading;
  // rows x columns, row-major, matching the live key order (r1c1..r8cN). Unused rows stay empty.
  for (let r = 1; r <= MAX_ROWS; r++) {
    const row = rows[r - 1];
    for (let c = 1; c <= n; c++) {
      settings[`r${r}c${c}`] = row ? row[c - 1] : '';
    }
  }
  return settings;
}

export function buildAccordionRow(profile) {
  const accordionHtml = buildProse(profile);
  const rows = deriveRows(profile);

  return {
    type: '_accordion-row',
    settings: { heading: 'Size Chart', open_by_default: false, icon: 'none', width: 20 },
    blocks: {
      text_sc001: {
        type: 'text',
        settings: {
          text: accordionHtml,
          width: '100%',
          max_width: 'normal',
          alignment: 'left',
          type_preset: 'rte',
          font: 'var(--font-body--family)',
          font_size: '1rem',
          line_height: 'normal',
          letter_spacing: 'normal',
          case: 'none',
          wrap: 'pretty',
          color: 'var(--color-foreground)',
          background: false,
          background_color: '#00000026',
          corner_radius: 0,
          'padding-block-start': 0,
          'padding-block-end': 0,
          'padding-inline-start': 0,
          'padding-inline-end': 0,
        },
        blocks: {},
      },
      table_9Nak3q: {
        type: 'table',
        name: 't:names.table',
        settings: buildTableSettings(rows, profile.columns),
        blocks: {},
      },
    },
    block_order: ['text_sc001', 'table_9Nak3q'],
  };
}

// The canonical id under which this row is keyed in the parent accordion's blocks map.
export const ACCORDION_ROW_ID = 'accordion_row_sc001';
