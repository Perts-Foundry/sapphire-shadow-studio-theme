// Build the canonical "Size Chart" accordion row (accordion_row_sc001) from a profile. The
// returned object matches the live templates' structure and key order exactly, so serialising it
// reproduces the existing block byte-for-byte for the seed blank (the cohesion golden test).
//
// The row nests a `text_sc001` rich-text block (prose from copy.md) and a `table_9Nak3q` table
// block (six columns, rows 1-6 filled from the profile, rows 7-8 left empty so they auto-hide).
// Pure; no fs beyond copy.md via readCopy, no sharp.

import { deriveRows } from './normalize.mjs';
import { readCopy } from './copy.mjs';

const HEADINGS = [
  'Size',
  'Chest (circumference)',
  'Chest (laid flat)',
  'Body Length',
  'Shoulder Width',
  'Sleeve Length',
];

// Column keys in table order (col1..col6) as produced by deriveRows.
const COL_KEYS = ['size', 'chest_circumference', 'chest_laid_flat', 'body_length', 'shoulder_width', 'sleeve_length'];

function buildTableSettings(rows) {
  const settings = {
    column_count: '6',
    show_header: true,
    stripe_rows: true,
    col1_heading: HEADINGS[0],
    col2_heading: HEADINGS[1],
    col3_heading: HEADINGS[2],
    col4_heading: HEADINGS[3],
    col5_heading: HEADINGS[4],
    col6_heading: HEADINGS[5],
  };
  // 8 rows x 6 columns, row-major, matching the live key order (r1c1..r8c6).
  for (let r = 1; r <= 8; r++) {
    const row = rows[r - 1];
    for (let c = 1; c <= 6; c++) {
      settings[`r${r}c${c}`] = row ? row[COL_KEYS[c - 1]] : '';
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
        settings: buildTableSettings(rows),
        blocks: {},
      },
    },
    block_order: ['text_sc001', 'table_9Nak3q'],
  };
}

// The canonical id under which this row is keyed in the parent accordion's blocks map.
export const ACCORDION_ROW_ID = 'accordion_row_sc001';
