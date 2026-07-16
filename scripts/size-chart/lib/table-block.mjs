// Build the canonical "Size Chart" accordion row (accordion_row_sc001) from a profile. The
// returned object matches the live templates' structure and key order exactly, so serialising it
// reproduces the existing block byte-for-byte for the seed blank (the cohesion golden test).
//
// The row nests a `text_sc001` rich-text block (prose from copy.md) and a `table_9Nak3q` table
// block. The table is column-driven: `column_count`, the `colN_heading` labels, and the `rMcN` cells
// all come from the profile's `columns` (rows 1..sizes.length filled, the rest left empty so the
// theme block auto-hides them). Pure; no fs beyond copy.md via readCopy, no sharp.

import { deriveRows } from './normalize.mjs';
import { readCopy } from './copy.mjs';

// The theme table block (blocks/table.liquid) supports up to 8 rows and 6 columns.
const MAX_ROWS = 8;

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

export function buildAccordionRow(profile, { copyPath } = {}) {
  const { accordionHtml } = readCopy(copyPath);
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
