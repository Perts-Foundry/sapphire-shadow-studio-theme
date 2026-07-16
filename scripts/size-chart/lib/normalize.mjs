// Pure numeric normalisation for size charts: inch -> centimetre conversion, laid-flat
// derivation, rounding, and dual-unit cell formatting. No sharp, no fs; unit-testable in
// isolation. All stored measurement values are canonical inches on input.
//
// Formatting rules reproduced byte-for-byte from the live templates:
//   - inch value printed with no trailing zeros: 22, 24.5, 19.25, 27.75.
//   - centimetres = inch x 2.54, rounded to 0.1 cm, ties rounded up (away from zero), with a
//     trailing ".0" stripped: "97.8 cm", but "61 cm" (not "61.0 cm").
//   - cm is derived from the inch value independently, never from a rounded cm (so laid-flat cm
//     is half-inch x 2.54, not half of the rounded circumference cm).
//   - a `measure` cell reads `<inch>" / <cm> cm`, e.g. `38.5" / 97.8 cm`.

// Centimetres in tenths (cm x 10) as an integer, using integer arithmetic to avoid float drift.
// cents = inch x 100 (hundredths of an inch); cents x 254 = cm x 10000; round half up to 0.1 cm.
export function cmTenths(inchNum) {
  const cents = Math.round(inchNum * 100);
  return Math.floor((cents * 254 + 500) / 1000);
}

export function formatInch(n) {
  return String(Number(n));
}

export function formatCm(tenths) {
  return tenths % 10 === 0 ? String(tenths / 10) : (tenths / 10).toFixed(1);
}

export function cell(inchNum) {
  return `${formatInch(inchNum)}" / ${formatCm(cmTenths(inchNum))} cm`;
}

// A `range` cell (e.g. a body-chest fit range) reads `<lo>-<hi>"`, e.g. `32-34"`. Inch only, since
// these are body-fit ranges a shopper compares against, not garment dual-unit measurements.
export function rangeCell([lo, hi]) {
  return `${formatInch(lo)}-${formatInch(hi)}"`;
}

// Resolve one column's display string for size index i.
//   - the `size` role reads profile.sizes (single source of truth for the row labels)
//   - `measure` columns are cell()-formatted; a `derive` rule reads another column's stored value
//     and scales it (crewneck: laid-flat = circumference x 0.5; QZ: circumference = laid-flat x 2)
//   - `range` columns read a [lo, hi] pair; `label`/`string` columns pass their raw value through
function cellFor(col, i, byRole, sizes) {
  if (col.role === 'size') return String(sizes[i]);
  switch (col.kind) {
    case 'measure': {
      const src = col.derive ? byRole[col.derive.from].values[i] * col.derive.factor : col.values[i];
      return cell(src);
    }
    case 'range':
      return rangeCell(col.values[i]);
    case 'label':
    case 'string':
    default:
      return String(col.values[i]);
  }
}

// One display row per size, as an array of cell strings in column order (parallel to
// profile.columns). Consumers read profile.columns for the headings/badges/callout copy.
export function deriveRows(profile) {
  const { sizes, columns } = profile;
  const byRole = Object.fromEntries(columns.map((c) => [c.role, c]));
  return sizes.map((_size, i) => columns.map((col) => cellFor(col, i, byRole, sizes)));
}
