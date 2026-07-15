// Pure numeric normalisation for size charts: inch -> centimetre conversion, laid-flat
// derivation, rounding, and dual-unit cell formatting. No sharp, no fs; unit-testable in
// isolation. All values are canonical inches on input.
//
// Formatting rules reproduced byte-for-byte from the live templates:
//   - inch value printed with no trailing zeros: 22, 24.5, 19.25, 27.75.
//   - centimetres = inch x 2.54, rounded to 0.1 cm, ties rounded up (away from zero), with a
//     trailing ".0" stripped: "97.8 cm", but "61 cm" (not "61.0 cm").
//   - cm is derived from the inch value independently, never from a rounded cm (so laid-flat cm
//     is half-inch x 2.54, not half of the rounded circumference cm).
//   - a cell reads `<inch>" / <cm> cm`, e.g. `38.5" / 97.8 cm`.

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

// Column order matches the on-page table: Size, Chest (circumference), Chest (laid flat),
// Body Length, Shoulder Width, Sleeve Length. Chest laid-flat is derived as half the
// circumference; every other column is a stored measurement.
export const DISPLAY_COLUMNS = [
  'size',
  'chest_circumference',
  'chest_laid_flat',
  'body_length',
  'shoulder_width',
  'sleeve_length',
];

// Derive one display row per size, each column a dual-unit string (except size).
export function deriveRows(profile) {
  const { sizes, measurements } = profile;
  return sizes.map((size, i) => ({
    size,
    chest_circumference: cell(measurements.chest_circumference[i]),
    chest_laid_flat: cell(measurements.chest_circumference[i] / 2),
    body_length: cell(measurements.body_length[i]),
    shoulder_width: cell(measurements.shoulder_width[i]),
    sleeve_length: cell(measurements.sleeve_length[i]),
  }));
}
