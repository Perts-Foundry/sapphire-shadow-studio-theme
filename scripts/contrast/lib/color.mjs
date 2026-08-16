// color.mjs -- colour parsing, alpha compositing and WCAG contrast maths.
//
// Dependency-free by repo policy. Everything here is pure: no I/O, no globals.
//
// Colour values in config/settings_data.json come in exactly three forms, all of
// which the theme editor can emit for a `type: color` setting with `alpha: true`:
//   #rrggbb        opaque hex
//   #rrggbbaa      hex with an alpha byte (e.g. #000000cf)
//   rgb()/rgba()   functional, e.g. rgba(0,0,0,0)
// The 3- and 4-digit shorthands are accepted too; the editor has not been seen
// emitting them, but they are legal CSS and cost two lines to support.

/**
 * @typedef {{r: number, g: number, b: number, a: number}} Rgba
 *   r/g/b are 0-255 integers, a is 0-1.
 */

const HEX = /^#([0-9a-f]{3,8})$/i;
const FUNC = /^rgba?\(\s*([^)]*)\)$/i;

/**
 * Parse a CSS colour string into {r, g, b, a}.
 * @param {string} input
 * @returns {Rgba}
 * @throws {Error} on anything unrecognised. Deliberately strict: a colour this
 *   parser cannot read is a colour the lint cannot check, and silently skipping
 *   it would be a fail-open hole in a gate whose whole job is to fail closed.
 * @example
 *   parseColor('#000000cf') // { r: 0, g: 0, b: 0, a: 0.8117647058823529 }
 */
export function parseColor(input) {
  const value = String(input ?? '').trim();

  const hex = value.match(HEX);
  if (hex) {
    const d = hex[1];
    if (d.length === 3 || d.length === 4) {
      const [r, g, b, a] = [...d].map((c) => parseInt(c + c, 16));
      return { r, g, b, a: d.length === 4 ? a / 255 : 1 };
    }
    if (d.length === 6 || d.length === 8) {
      const byte = (i) => parseInt(d.slice(i * 2, i * 2 + 2), 16);
      return { r: byte(0), g: byte(1), b: byte(2), a: d.length === 8 ? byte(3) / 255 : 1 };
    }
    throw new Error(`unsupported hex colour: ${value}`);
  }

  const func = value.match(FUNC);
  if (func) {
    // Accept both the legacy comma syntax (rgba(0,0,0,0)) and the modern
    // space/slash syntax (rgb(0 0 0 / 50%)); the editor emits the former.
    const parts = func[1].replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean);
    if (parts.length !== 3 && parts.length !== 4) {
      throw new Error(`unsupported rgb() colour: ${value}`);
    }
    const channel = (p) => {
      const n = p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p);
      if (!Number.isFinite(n)) throw new Error(`unsupported rgb() colour: ${value}`);
      return clamp(Math.round(n), 0, 255);
    };
    const alpha = (p) => {
      const n = p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p);
      if (!Number.isFinite(n)) throw new Error(`unsupported rgb() colour: ${value}`);
      return clamp(n, 0, 1);
    };
    return {
      r: channel(parts[0]),
      g: channel(parts[1]),
      b: channel(parts[2]),
      a: parts.length === 4 ? alpha(parts[3]) : 1,
    };
  }

  throw new Error(`unsupported colour: ${value}`);
}

function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * Composite `fg` over `bg` with the source-over operator, returning the visible
 * result. When `bg` is itself translucent the result stays translucent, so a
 * caller stacking three layers can chain the calls.
 * @param {Rgba} fg
 * @param {Rgba} bg
 * @returns {Rgba}
 * @example
 *   composite(parseColor('#000000cf'), parseColor('#ffffff')) // near-opaque dark grey
 */
export function composite(fg, bg) {
  const a = fg.a + bg.a * (1 - fg.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const ch = (f, b) => (f * fg.a + b * bg.a * (1 - fg.a)) / a;
  return { r: ch(fg.r, bg.r), g: ch(fg.g, bg.g), b: ch(fg.b, bg.b), a };
}

/**
 * WCAG 2.x relative luminance. Alpha is ignored: callers must composite first,
 * because luminance of a translucent colour is not defined.
 * @param {Rgba} c
 * @returns {number} 0-1
 */
export function relativeLuminance(c) {
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/**
 * WCAG 2.x contrast ratio between two OPAQUE colours, 1..21.
 * @param {Rgba} a
 * @param {Rgba} b
 * @returns {number}
 * @example
 *   contrastRatio(parseColor('#000000'), parseColor('#ffffff')) // 21
 */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Ratio rounded to 2dp, the form used in reports and accepted-risks.json. */
export function round2(ratio) {
  return Math.round(ratio * 100) / 100;
}
