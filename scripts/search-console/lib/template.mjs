// template.mjs -- the capture skeleton `review.mjs --template <mode>` prints.
//
// WHY. The first full browser pass stopped seven times to read schema.mjs and learn a field's
// shape, and once to copy values out of the previous capture. The skeleton puts every field of every
// report the mode expects in front of the transcriber before the pass starts, rendered from the
// same REPORT_FIELDS the validator uses, so the two cannot drift. Every value is a `<kind>`
// placeholder and every optional key carries a `?` suffix; validateCapture refuses both, so a
// skeleton left partly filled fails as capture-invalid instead of evaluating as a clean run.
//
// The nonce is generated here so the transcriber never invents one. Math.random is enough: the
// nonce ties evidence to a run, it is not a secret, and node:crypto is outside the import closure.

import { PROPERTY } from './checks.mjs';
import { REPORT_FIELDS, EXPECTED_REPORTS_BY_MODE } from './schema.mjs';

const NONCE_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const NONCE_LENGTH = 12;

export function makeNonce(random = Math.random) {
  let out = '';
  for (let i = 0; i < NONCE_LENGTH; i++) out += NONCE_CHARS[Math.floor(random() * NONCE_CHARS.length)];
  return out;
}

/** The placeholder, or nested skeleton, for one combinator. */
export function renderField(check) {
  if (check.type === 'object') return renderObject(check.shape, check.optional);
  if (check.type === 'array') {
    const inner = renderField(check.inner);
    if (typeof inner === 'string' && Number.isInteger(check.max)) {
      return [`${inner.slice(0, -1)}; up to ${check.max} items, this one element is a shape example>`];
    }
    return [inner];
  }
  return `<${check.kind}>`;
}

/** Required keys first, then optional keys with a `?` suffix. */
export function renderObject(required, optional = {}) {
  const out = {};
  for (const [key, check] of Object.entries(required)) out[key] = renderField(check);
  for (const [key, check] of Object.entries(optional)) out[`${key}?`] = renderField(check);
  return out;
}

/**
 * @param {'audit'|'insights'} mode
 * @param {object} [opts]
 * @param {() => number} [opts.random] injected for tests
 */
export function buildTemplate(mode, { random = Math.random } = {}) {
  const reports = {};
  for (const id of EXPECTED_REPORTS_BY_MODE[mode]) {
    const { required, optional = {} } = REPORT_FIELDS[id];
    reports[id] = {
      captured_at: '<ISO 8601 with offset>',
      report: id,
      status: '<ok | not-ready | not-present; delete every field below unless ok>',
      ...renderObject(required, optional),
    };
  }
  return {
    schema: 1,
    mode,
    property: PROPERTY,
    property_added: '<YYYY-MM-DD, from the Settings About row>',
    captured_at: '<ISO 8601 with offset>',
    nonce: makeNonce(random),
    reports,
  };
}
