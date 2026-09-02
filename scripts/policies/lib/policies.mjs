// Pure helpers behind the marketing/policies/ subsystem: hashing, the one canonical body form,
// heading extraction, the slugify that mirrors assets/policy-nav.js, and manifest diffing.
//
// Lib rules, matching scripts/site-check/lib/: no fetch, no fs, no process.env, no process.argv,
// and deliberately NO import of the Admin client. A test asserts this file imports nothing that
// can reach the network, so a mistake in check.mjs cannot turn the offline check into an online
// one. Everything here is a function of its arguments.

import { createHash } from 'node:crypto';
import { parseHtml, innerText, descendants } from '../../notifications/html-walk.mjs';

/**
 * The policy types this repo tracks, in the order the manifest and every report lists them.
 *
 * ShopPolicyType has eight members (TERMS_OF_SALE, LEGAL_NOTICE and SUBSCRIPTION_POLICY are the
 * other three); `shop.shopPolicies` returns only the ones the shop actually has, and this store
 * has exactly these five. Adding one here without also adding its file and manifest entry is a
 * refusal in check.mjs, not a silent skip.
 */
export const POLICY_TYPES = [
  'CONTACT_INFORMATION',
  'PRIVACY_POLICY',
  'REFUND_POLICY',
  'SHIPPING_POLICY',
  'TERMS_OF_SERVICE',
];

/**
 * Which policies `shopPolicyUpdate` may write.
 *
 * PRIVACY_POLICY is Shopify auto-managed: the mutation is refused on it and Shopify rewrites the
 * body on its own schedule. It is still pulled and tracked (the repo is then a dated record of
 * what the storefront said), but push refuses it at flag-parse time rather than discovering the
 * refusal at the API, and check.mjs downgrades hygiene refusals to notes for it, so an em dash
 * Shopify introduces cannot turn CI permanently red on something nobody here can fix.
 */
export const WRITABLE = Object.freeze({
  CONTACT_INFORMATION: true,
  PRIVACY_POLICY: false,
  REFUND_POLICY: true,
  SHIPPING_POLICY: true,
  TERMS_OF_SERVICE: true,
});

/**
 * The storefront path each policy is served at, e.g. `/policies/shipping-policy`.
 *
 * ShopPolicy carries no `handle` field (verified by introspection against 2026-07), and its `url`
 * is the numeric legacy form (`/<shop-id>/policies/<policy-id>.html?locale=en`), which is churny
 * and tells a reviewer nothing. The handle is therefore derived here and pinned in the manifest,
 * where it doubles as the link target the theme's JSON-LD and templates use.
 */
export const STOREFRONT_HANDLES = Object.freeze({
  CONTACT_INFORMATION: 'contact-information',
  PRIVACY_POLICY: 'privacy-policy',
  REFUND_POLICY: 'refund-policy',
  SHIPPING_POLICY: 'shipping-policy',
  TERMS_OF_SERVICE: 'terms-of-service',
});

/** Files under marketing/policies/ that are documentation or the manifest, never a policy body. */
export const NON_POLICY_FILES = Object.freeze(['README.md', 'manifest.json']);

/** A refusal. Every message is pinned by a test so the wording cannot drift silently. */
export class PolicyError extends Error {
  constructor(subject, detail) {
    super(`${subject}: ${detail}`);
    this.name = 'PolicyError';
    this.subject = subject;
    this.detail = detail;
  }
}

/** `SHIPPING_POLICY` -> `shipping_policy`, the manifest key and the file stem. */
export function keyForType(type) {
  if (!POLICY_TYPES.includes(type)) throw new PolicyError(String(type), 'not a tracked ShopPolicyType');
  return type.toLowerCase();
}

/** `shipping_policy` -> `SHIPPING_POLICY`, or null when the key names no tracked type. */
export function typeForKey(key) {
  const type = String(key ?? '').toUpperCase();
  return POLICY_TYPES.includes(type) ? type : null;
}

/** `SHIPPING_POLICY` -> `shipping_policy.html`. */
export function fileNameForType(type) {
  return `${keyForType(type)}.html`;
}

/** `shipping_policy.html` -> `SHIPPING_POLICY`, or null. */
export function typeForFileName(name) {
  const s = String(name ?? '');
  return s.endsWith('.html') ? typeForKey(s.slice(0, -'.html'.length)) : null;
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The one canonical form of a policy body. Applied in exactly three places: pull's write, push's
 * sent body, and both sides of every comparison. Without a single form the CR/BOM hygiene rules
 * and the round-trip comparison fight each other.
 *
 * Three operations, deliberately no more: drop a leading BOM, CRLF (and lone CR) to LF, and strip
 * trailing whitespace at the END of the document. It does NOT strip per-line trailing whitespace:
 * a space before a newline is significant between inline elements, and "tidying" it would change
 * what the storefront renders.
 *
 * The canonical body carries no trailing newline. The file on disk is `canonicalise(body) + '\n'`
 * (see `fileTextFor` / `bodyFromFileText`), so the file is POSIX-clean while the bytes sent to
 * Shopify stay exactly what Admin returned. sha256 and length are always over the canonical body,
 * never over the file text.
 */
export function canonicalise(body) {
  let text = String(body ?? '');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
}

/** The bytes written to `<type>.html` for a body. */
export function fileTextFor(body) {
  return `${canonicalise(body)}\n`;
}

/** The body a `<type>.html` file holds. Inverse of `fileTextFor` for any canonical body. */
export function bodyFromFileText(text) {
  return canonicalise(text);
}

/** UTF-16 code units, as `String.length` reports it, matching marketing/notifications/manifest.json. */
export function lengthOf(body) {
  return canonicalise(body).length;
}

const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  reg: '®',
  copy: '©',
  trade: '™',
  deg: '°',
});

/**
 * Decode the entities that appear in policy prose, in a single pass so `&amp;lt;` decodes to the
 * five characters `&lt;` and not to `<`. A browser's `textContent` has already done this, which is
 * why heading text has to be decoded here before it is compared or slugified.
 * Unknown entities are left alone rather than guessed at.
 */
export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/**
 * Heading text to an id-safe slug.
 *
 * COUPLED TO `slugify` IN assets/policy-nav.js. That component assigns these ids at runtime, and
 * the ids are the shareable `/policies/...#section` links, so the two implementations must agree
 * character for character; a comment in policy-nav.js says the same thing from the other side.
 * `node --test` cannot reach the DOM, so browser parity is a one-time manual check recorded in
 * marketing/policies/README.md, not an automated one.
 */
export function slugify(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 50)
    .replace(/^-+|-+$/g, '');
}

const HEADING_TAGS = Object.freeze(['h2', 'h3']);

/**
 * Every `h2` and `h3` in a policy body, in document order, as `{ level, text, id }`.
 *
 * `text` is the element's decoded, trimmed text content including any nested inline markup, which
 * is what a browser's `textContent` yields. A heading whose text is empty or whitespace-only is
 * omitted, matching policy-nav.js, which filters those out before assigning ids.
 *
 * `id` is the anchor contract, and it is non-null for `h2` only: policy-nav.js queries `h2` and
 * assigns ids to nothing else, so an `h3` has no runtime id to pin. Recording h3s anyway is what
 * makes a reworded sub-heading show up in the manifest diff. Duplicate h2 ids are NOT resolved
 * here; check.mjs refuses them, because the browser would silently suffix one with `-2` and which
 * heading got suffixed would then depend on document order.
 */
export function extractHeadings(html) {
  const { root } = parseHtml(String(html ?? ''));
  const out = [];
  for (const el of descendants(root)) {
    if (!HEADING_TAGS.includes(el.tag)) continue;
    const text = decodeEntities(innerText(el)).trim();
    if (text === '') continue;
    const level = Number(el.tag.slice(1));
    out.push({ level, text, id: level === 2 ? slugify(text) || 'section' : null });
  }
  return out;
}

/** The h2 ids that appear more than once, sorted. Empty when the anchor set is sound. */
export function duplicateHeadingIds(headings) {
  const seen = new Map();
  for (const h of headings) {
    if (h.id === null) continue;
    seen.set(h.id, (seen.get(h.id) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id).sort();
}

/** The em dash, literal or entity-encoded. U+2013 (en dash) deliberately passes. */
export const EM_DASH_FORMS = Object.freeze(['\u2014', '&mdash;', '&#8212;', '&#x2014;', '&#X2014;']);

export function hasEmDash(text) {
  const s = String(text ?? '');
  return EM_DASH_FORMS.some((form) => s.includes(form));
}

/**
 * Every fail-closed hygiene rule, as `[]` or a list of reasons. Applied to the canonical body.
 * Enforcement lives in check.mjs; this is the single definition it and the tests share, so the
 * tests prove the enforcement rather than reimplementing the rules.
 */
export function hygieneProblems(body) {
  const text = String(body ?? '');
  const problems = [];
  if (text.charCodeAt(0) === 0xfeff) problems.push('starts with a byte-order mark');
  if (text.includes('\r')) problems.push('contains a carriage return');
  if (/<script[\s>]/i.test(text)) problems.push('contains a <script> tag');
  if (/<style[\s>]/i.test(text)) problems.push('contains a <style> tag');
  if (hasEmDash(text)) problems.push('contains an em dash (U+2014 or an entity form); use a comma, semicolon, colon or period');
  return problems;
}

/**
 * The manifest entry a pull would record for one policy.
 *
 * `prev` is spread first so key order never churns against a hand-formatted manifest.
 *
 * `remote.observedAt` reads as "when Admin was FIRST seen holding this body", not "when it was
 * last polled"; see the comment on the carry-forward below.
 *
 * @param {object|undefined} prev  the committed entry, or undefined for a new one
 * @param {object} o
 * @param {string} o.type          a POLICY_TYPES member
 * @param {string} o.title         Admin's title for the policy
 * @param {string} o.body          the RAW body from Admin; canonicalised here
 * @param {string} o.now           ISO-8601 timestamp for this run
 */
export function buildEntry(prev, { type, title, body, now }) {
  const canonical = canonicalise(body);
  const hash = sha256(canonical);
  const changed = !prev || prev.sha256 !== hash;
  // Both timestamps are carried forward unchanged when nothing moved, for the same reason: a
  // field rewritten on every pull churns all five entries, guarantees a conflict between two
  // branches that both pulled, trains reviewers to skim the file that carries the anchor
  // contract, and would make `policies:pull --check` report drift on a tree that has none.
  const sameRemote = prev && prev.remote && prev.remote.sha256 === hash;
  const entry = {
    ...(prev ?? {}),
    title,
    handle: STOREFRONT_HANDLES[type],
    writable: WRITABLE[type],
    sha256: hash,
    length: canonical.length,
    headings: extractHeadings(canonical),
    remote: { sha256: hash, length: canonical.length, observedAt: sameRemote ? prev.remote.observedAt : now },
    pulledAt: changed ? now : (prev.pulledAt ?? now),
  };
  if (!WRITABLE[type]) {
    entry.reason = prev?.reason ?? NOT_WRITABLE_REASON;
  } else {
    delete entry.reason;
  }
  return entry;
}

export const NOT_WRITABLE_REASON =
  'Shopify auto-manages this policy: shopPolicyUpdate is refused on it and Shopify rewrites the body on its own schedule. Tracked read-only.';

/**
 * The `remote` token a successful push records: what Admin held immediately after the write.
 * Same shape pull writes, so the freshness gate reads one field wherever it came from.
 */
export function remoteToken(body, now) {
  const canonical = canonicalise(body);
  return { sha256: sha256(canonical), length: canonical.length, observedAt: now };
}

/**
 * Compare a committed entry against one recomputed from the body on disk. Returns a list of
 * mismatch strings, one per class, empty when they agree. Deliberately field-by-field rather than
 * a deep equal, so a failure names what moved instead of printing two 20 KB objects.
 *
 * `title` is deliberately NOT compared: it comes from Admin and cannot be recomputed offline, so
 * comparing it against itself would be a tautology dressed as a check. check.mjs asserts it is a
 * non-empty string, and pull is what keeps it current.
 */
export const DIFFED_FIELDS = Object.freeze(['handle', 'writable', 'sha256', 'length']);

export function diffEntry(key, committed, computed) {
  const out = [];
  if (!committed) return [`${key}: no manifest entry`];
  for (const field of DIFFED_FIELDS) {
    if (committed[field] !== computed[field]) {
      out.push(`${key}: ${field} is ${JSON.stringify(committed[field])}, computed ${JSON.stringify(computed[field])}`);
    }
  }
  out.push(...diffHeadings(key, committed.headings, computed.headings));
  return out;
}

/** Heading-list mismatches, one line per differing position, plus a length line. */
export function diffHeadings(key, committed, computed) {
  const out = [];
  const a = Array.isArray(committed) ? committed : [];
  const b = computed;
  if (a.length !== b.length) out.push(`${key}: manifest records ${a.length} heading(s), the body has ${b.length}`);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i].level !== b[i].level || a[i].text !== b[i].text || a[i].id !== b[i].id) {
      out.push(
        `${key}: heading ${i + 1} is ${JSON.stringify(a[i])} in the manifest, ${JSON.stringify(b[i])} in the body; ` +
          'a reworded h2 changes its runtime id and silently breaks every shared /policies/...#anchor link',
      );
    }
  }
  return out;
}

/** The manifest formatter. One place, so pull and any future writer never reflow the file. */
export function formatManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
