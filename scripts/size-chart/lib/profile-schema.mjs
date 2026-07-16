// Structural + invariant validation for a size-chart profile. Raises loudly rather than letting
// a malformed or transcription-swapped profile half-render a wrong number onto a customer-facing
// chart. Pure; no fs, no sharp.

const MEASUREMENTS = ['chest_circumference', 'body_length', 'sleeve_length'];
const TOP_LEVEL = new Set(['blank_id', 'display_name', 'unit', 'sizes', 'measurements', 'handles']);

// Sane per-measurement garment ranges in inches; anything outside is almost certainly a units
// or transcription error (e.g. a body measurement, a cm value pasted as inches).
const RANGES = {
  chest_circumference: [24, 80],
  body_length: [18, 44],
  // Sleeve is measured from centre back including the cuff rib (the SS3000 convention), so it runs
  // longer than a shoulder-to-cuff figure.
  sleeve_length: [20, 46],
};

const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;

export function validateProfile(profile) {
  const errs = [];

  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error('Invalid profile: must be an object');
  }

  for (const k of Object.keys(profile)) {
    if (!TOP_LEVEL.has(k)) errs.push(`unknown key '${k}' (additionalProperties not allowed)`);
  }

  if (!isNonEmptyString(profile.blank_id)) errs.push('blank_id must be a non-empty string');
  else if (!/^[a-z0-9-]+$/.test(profile.blank_id)) errs.push('blank_id must be kebab-case [a-z0-9-]');
  if (!isNonEmptyString(profile.display_name)) errs.push('display_name must be a non-empty string');
  if (profile.unit !== 'in') errs.push('unit must be "in"');

  const sizes = profile.sizes;
  if (!Array.isArray(sizes) || sizes.length === 0) {
    errs.push('sizes must be a non-empty array');
  } else {
    if (sizes.length > 6) errs.push(`sizes length ${sizes.length} exceeds the 6 data rows the table supports`);
    sizes.forEach((s, i) => { if (!isNonEmptyString(s)) errs.push(`sizes[${i}] must be a non-empty string`); });
  }

  if (profile.handles !== undefined) {
    if (!Array.isArray(profile.handles)) errs.push('handles must be an array');
    else profile.handles.forEach((h, i) => {
      // Kebab-case only: handles are interpolated into a template file path, so reject anything
      // that could traverse out of templates/ (e.g. a "../" from a crafted profile).
      if (!isNonEmptyString(h)) errs.push(`handles[${i}] must be a non-empty string`);
      else if (!/^[a-z0-9-]+$/.test(h)) errs.push(`handles[${i}] must be kebab-case [a-z0-9-] (got '${h}')`);
    });
  }

  const m = profile.measurements;
  const sizeCount = Array.isArray(sizes) ? sizes.length : null;
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    errs.push('measurements must be an object');
  } else {
    for (const k of Object.keys(m)) {
      if (!MEASUREMENTS.includes(k)) errs.push(`unknown measurement '${k}'`);
    }
    for (const k of MEASUREMENTS) {
      const arr = m[k];
      if (!Array.isArray(arr)) { errs.push(`measurements.${k} must be an array`); continue; }
      if (sizeCount !== null && arr.length !== sizeCount) {
        errs.push(`measurements.${k} length ${arr.length} != sizes length ${sizeCount}`);
      }
      arr.forEach((v, i) => {
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
          errs.push(`measurements.${k}[${i}] must be a positive number`);
        }
      });
    }
  }

  // Invariant checks only run once the arrays are structurally sound, so indexing is safe.
  if (errs.length === 0) {
    for (const k of MEASUREMENTS) {
      const arr = m[k];
      const [lo, hi] = RANGES[k];
      arr.forEach((v, i) => {
        if (v < lo || v > hi) errs.push(`measurements.${k}[${i}]=${v} outside sane range [${lo}, ${hi}] in (likely a units/transcription error)`);
      });
      for (let i = 1; i < arr.length; i++) {
        if (arr[i] < arr[i - 1]) {
          errs.push(`measurements.${k} decreases at size ${i} (${arr[i - 1]} -> ${arr[i]}); likely a transcription swap`);
        }
      }
    }
  }

  if (errs.length) throw new Error('Invalid profile:\n- ' + errs.join('\n- '));
  return true;
}
