// Structural + invariant validation for a v2 size-chart profile. Raises loudly rather than letting
// a malformed or transcription-swapped profile half-render a wrong number onto a customer-facing
// chart. Pure; no fs, no sharp.
//
// A profile declares its own ordered `columns`; each column carries a semantic `role` (used here for
// a sane-range + monotonicity check, and by the renderer for diagram-anchor binding) plus authored
// display text. Measured values are canonical inches. A `derive` column computes its values from
// another column (e.g. laid-flat = circumference x 0.5).

import { KNOWN_GARMENTS, ROLE_ANCHOR, garmentAnchors } from './garments.mjs';

const TOP_LEVEL = new Set([
  'blank_id', 'display_name', 'unit', 'garment', 'garment_noun', 'sizes', 'columns', 'how_to',
  'footer', 'canvas_height', 'handles',
]);
const COLUMN_KEYS = new Set([
  'role', 'heading', 'kind', 'values', 'derive', 'badge', 'callout_label', 'how', 'explain',
  'decides_size',
]);
const KINDS = new Set(['label', 'measure', 'range', 'string']);

// Sane per-role garment ranges in inches; anything outside is almost certainly a units or
// transcription error (e.g. a body measurement, a cm value pasted as inches). Roles absent here
// (size, size_numeric) carry no numeric range.
const ROLE_RANGES = {
  chest_circumference: [24, 80],
  chest_laid_flat: [12, 40],
  bust: [12, 40],
  body_length_hps: [18, 44],
  body_length_back: [18, 44],
  // Sleeve is measured from centre back including the cuff rib (the SS3000 convention), so it runs
  // longer than a shoulder-to-cuff figure.
  sleeve_cb: [20, 46],
  front_zipper: [3, 18],
  body_chest_range: [24, 80],
};
const KNOWN_ROLES = new Set(['size', 'size_numeric', ...Object.keys(ROLE_RANGES)]);

const MAX_SIZES = 6;   // the PNG canvas + on-page table are tuned for up to 6 size rows
const MAX_COLUMNS = 6; // blocks/table.liquid supports up to 6 columns
const MAX_EXPLAIN = 400; // the accordion is fixed-width UI; unbounded prose is a layout bug

const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const isPosNum = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

// Fields that land inside the accordion's rich-text HTML. table-block.mjs escapes them on write, so
// this reject is not the safety layer; it is a loud authoring error, caught at profile-validation
// time rather than discovered as mangled copy on the storefront. `{`/`}` are rejected too so a
// profile cannot smuggle a `{{token}}` into the shared copy pipeline.
const HTML_UNSAFE = /[<>&{}]/;

// Banned repo-wide. These fields are the newest prose surface and the likeliest to attract one, so
// make it mechanical rather than relying on the pre-push grep. Written as an escape, not the
// literal glyph, so this file stays clean under the repo's own em-dash sweep.
const EM_DASH = /\u2014/;

function checkProse(errs, at, value) {
  if (!isNonEmptyString(value)) { errs.push(`${at} must be a non-empty string`); return; }
  if (value.length > MAX_EXPLAIN) errs.push(`${at} is ${value.length} chars; max ${MAX_EXPLAIN}`);
  if (HTML_UNSAFE.test(value)) errs.push(`${at} must be plain prose; the engine emits the markup (no < > & { })`);
  if (EM_DASH.test(value)) errs.push(`${at} must not contain an em dash (U+2014)`);
}

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

  // How a shopper says the garment ("sweatshirt", "quarter-zip", "vest"). Substituted mid-sentence
  // into copy.md's shared prose, hence lowercase-only. Digits are rejected deliberately: a garment
  // noun essentially never contains one, and the charset is the cheap guard against a supplier SKU
  // ("qz-4050", "st254") arriving from a spec and landing in shopper-facing copy. Provenance is
  // gated in SKILL.md; this is the mechanical backstop.
  if (!isNonEmptyString(profile.garment_noun)) errs.push('garment_noun must be a non-empty string');
  else if (!/^[a-z]+(?:[ -][a-z]+)*$/.test(profile.garment_noun)) {
    errs.push("garment_noun must be a lowercase noun phrase [a-z], single spaces or hyphens between words (e.g. 'sweatshirt', 'quarter-zip')");
  } else if (profile.garment_noun.length > 30) {
    errs.push(`garment_noun is ${profile.garment_noun.length} chars; max 30`);
  }

  if (profile.garment !== undefined && profile.garment !== null && !KNOWN_GARMENTS.includes(profile.garment)) {
    errs.push(`garment '${profile.garment}' is not one of: ${KNOWN_GARMENTS.join(', ')} (or null)`);
  }

  if (profile.canvas_height !== undefined) {
    if (!isPosNum(profile.canvas_height) || profile.canvas_height < 800 || profile.canvas_height > 6000) {
      errs.push('canvas_height must be a number in [800, 6000]');
    }
  }

  const sizes = profile.sizes;
  let sizeCount = null;
  if (!Array.isArray(sizes) || sizes.length === 0) {
    errs.push('sizes must be a non-empty array');
  } else {
    sizeCount = sizes.length;
    if (sizes.length > MAX_SIZES) errs.push(`sizes length ${sizes.length} exceeds the ${MAX_SIZES} rows the chart supports`);
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

  const columns = profile.columns;
  const roles = new Map();  // role -> column (for derive resolution + uniqueness)
  const badges = new Set();
  if (!Array.isArray(columns) || columns.length === 0) {
    errs.push('columns must be a non-empty array');
  } else {
    if (columns.length > MAX_COLUMNS) errs.push(`columns length ${columns.length} exceeds the ${MAX_COLUMNS} the table supports`);
    columns.forEach((col, ci) => {
      const at = `columns[${ci}]`;
      if (!col || typeof col !== 'object' || Array.isArray(col)) { errs.push(`${at} must be an object`); return; }
      for (const k of Object.keys(col)) if (!COLUMN_KEYS.has(k)) errs.push(`${at}: unknown key '${k}'`);

      if (!isNonEmptyString(col.role)) errs.push(`${at}.role must be a non-empty string`);
      else if (!KNOWN_ROLES.has(col.role)) errs.push(`${at}.role '${col.role}' is not a known role`);
      else if (roles.has(col.role)) errs.push(`${at}.role '${col.role}' is duplicated`);
      else roles.set(col.role, col);

      if (!isNonEmptyString(col.heading)) errs.push(`${at}.heading must be a non-empty string`);
      if (!KINDS.has(col.kind)) errs.push(`${at}.kind must be one of ${[...KINDS].join('/')}`);

      if (col.badge !== undefined) {
        if (!/^[A-Z]$/.test(col.badge)) errs.push(`${at}.badge must be a single uppercase letter`);
        else if (badges.has(col.badge)) errs.push(`${at}.badge '${col.badge}' is duplicated`);
        else badges.add(col.badge);
        if (!isNonEmptyString(col.how)) errs.push(`${at} has a badge but no 'how' text for the legend`);
      }
      if (col.callout_label !== undefined && !isNonEmptyString(col.callout_label)) {
        errs.push(`${at}.callout_label must be a non-empty string`);
      }

      // `heading` and `callout_label` used to reach the SVG only. One of them is now also the bold
      // subject of an accordion sentence, so they are HTML too.
      if (isNonEmptyString(col.heading) && HTML_UNSAFE.test(col.heading)) {
        errs.push(`${at}.heading must not contain < > & { }`);
      }
      if (isNonEmptyString(col.callout_label) && HTML_UNSAFE.test(col.callout_label)) {
        errs.push(`${at}.callout_label must not contain < > & { }`);
      }

      // Long-form prose for the on-page accordion. Distinct from `how`, which is the terse
      // PNG-legend line: different media, different registers, both authored per column.
      if (col.explain !== undefined) checkProse(errs, `${at}.explain`, col.explain);

      if (col.decides_size !== undefined) {
        if (typeof col.decides_size !== 'boolean') errs.push(`${at}.decides_size must be a boolean`);
        else if (col.decides_size === true && !isNonEmptyString(col.explain)) {
          errs.push(`${at} decides the size but has no 'explain' prose for the accordion`);
        }
      }

      // Value / derive shape by kind (the size role is special: it renders profile.sizes).
      if (col.role === 'size') {
        if (col.values !== undefined || col.derive !== undefined) errs.push(`${at} (role size) must not carry values/derive; it renders profile.sizes`);
        return;
      }
      if (col.kind === 'measure' && col.derive !== undefined) {
        if (col.values !== undefined) errs.push(`${at} cannot have both values and derive`);
        const d = col.derive;
        if (!d || typeof d !== 'object' || Array.isArray(d)) errs.push(`${at}.derive must be an object`);
        else {
          if (!isNonEmptyString(d.from)) errs.push(`${at}.derive.from must be a role name`);
          if (!isPosNum(d.factor)) errs.push(`${at}.derive.factor must be a positive number`);
        }
        return;
      }
      // Otherwise a values array is required, sized to the sizes array.
      const arr = col.values;
      if (!Array.isArray(arr)) { errs.push(`${at}.values must be an array`); return; }
      if (sizeCount !== null && arr.length !== sizeCount) {
        errs.push(`${at}.values length ${arr.length} != sizes length ${sizeCount}`);
      }
      if (col.kind === 'measure') {
        arr.forEach((v, i) => { if (!isPosNum(v)) errs.push(`${at}.values[${i}] must be a positive number`); });
      } else if (col.kind === 'range') {
        arr.forEach((pair, i) => {
          if (!Array.isArray(pair) || pair.length !== 2 || !isPosNum(pair[0]) || !isPosNum(pair[1])) {
            errs.push(`${at}.values[${i}] must be a [lo, hi] pair of positive numbers`);
          } else if (pair[0] > pair[1]) {
            errs.push(`${at}.values[${i}] has lo > hi (${pair[0]} > ${pair[1]})`);
          }
        });
      } else { // label / string
        arr.forEach((v, i) => { if (!isNonEmptyString(String(v))) errs.push(`${at}.values[${i}] must be a non-empty value`); });
      }
    });
  }

  // Cross-column + invariant checks only once each column is structurally sound.
  if (errs.length === 0) {
    // The renderer treats column 0 as the size column (fixed 180px width + accent styling).
    if (columns[0].role !== 'size') errs.push("the first column must have role 'size'");

    // Exactly one column decides the size. It is what `{{deciding_label}}` resolves to in the shared
    // "Choosing your size" copy, so zero would leave the token unresolved and two would make the
    // sentence a lie. This is a merchandising claim rather than a measurement fact (getting it wrong
    // produces returns, silently, with a green build), so SKILL.md gates it on operator
    // confirmation; this is the mechanical half.
    const deciders = columns.filter((c) => c.decides_size === true);
    if (deciders.length !== 1) {
      errs.push(`exactly one column must set decides_size: true (found ${deciders.length})`);
    }

    const usedAnchors = new Map(); // anchor -> role, to catch two badges colliding on one anchor
    columns.forEach((col, ci) => {
      const at = `columns[${ci}]`;

      // derive.from must reference another column with stored values; range-check the derived output
      // too, so a wrong derive.factor (e.g. 0.5 vs 2) cannot render an out-of-range chest undetected.
      if (col.derive) {
        const base = roles.get(col.derive.from);
        if (!base) errs.push(`${at}.derive.from '${col.derive.from}' does not match any column role`);
        else if (!Array.isArray(base.values)) errs.push(`${at}.derive.from '${col.derive.from}' has no stored values to derive from`);
        else {
          const dr = ROLE_RANGES[col.role];
          if (dr) base.values.forEach((v, i) => {
            const d = v * col.derive.factor;
            if (d < dr[0] || d > dr[1]) errs.push(`${at} derived value ${d} at size ${i} outside sane range [${dr[0]}, ${dr[1]}] in (check derive.factor)`);
          });
        }
      }

      // A badge must attach to a diagram anchor the chosen garment actually exposes, and no two
      // badges may share an anchor (they would collide, and the later one would silently win).
      if (col.badge && profile.garment != null) {
        const anchor = ROLE_ANCHOR[col.role];
        if (!anchor) errs.push(`${at}.role '${col.role}' has a badge but no diagram anchor to attach it to`);
        else if (!garmentAnchors(profile.garment).includes(anchor)) errs.push(`${at}.role '${col.role}' badges the '${anchor}' anchor, which garment '${profile.garment}' does not have`);
        else if (usedAnchors.has(anchor)) errs.push(`${at}.role '${col.role}' and '${usedAnchors.get(anchor)}' both badge the '${anchor}' anchor`);
        else usedAnchors.set(anchor, col.role);
      }

      // Sane range + monotonicity for stored measure/range columns.
      const range = ROLE_RANGES[col.role];
      if (Array.isArray(col.values) && range) {
        const [lo, hi] = range;
        if (col.kind === 'measure') {
          col.values.forEach((v, i) => {
            if (v < lo || v > hi) errs.push(`${at}.values[${i}]=${v} outside sane range [${lo}, ${hi}] in (likely a units/transcription error)`);
          });
          for (let i = 1; i < col.values.length; i++) {
            if (col.values[i] < col.values[i - 1]) errs.push(`${at}.values decreases at size ${i} (${col.values[i - 1]} -> ${col.values[i]}); likely a transcription swap`);
          }
        } else if (col.kind === 'range') {
          col.values.forEach((pair, i) => {
            if (pair[0] < lo || pair[1] > hi) errs.push(`${at}.values[${i}]=${pair[0]}-${pair[1]} outside sane range [${lo}, ${hi}] in`);
          });
          for (let i = 1; i < col.values.length; i++) {
            if (col.values[i][0] < col.values[i - 1][0]) errs.push(`${at}.values 'lo' decreases at size ${i}; likely a transcription swap`);
            if (col.values[i][1] < col.values[i - 1][1]) errs.push(`${at}.values 'hi' decreases at size ${i}; likely a transcription swap`);
          }
        }
      }
    });
  }

  if (errs.length) throw new Error('Invalid profile:\n- ' + errs.join('\n- '));
  return true;
}
