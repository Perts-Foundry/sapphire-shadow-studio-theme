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

// ------------------------------------------------------------------------------------------
// The version stamp
// ------------------------------------------------------------------------------------------

/**
 * The version stamp is an invisible HTML comment on the FIRST LINE of a policy body, so viewing
 * source on the live policy page answers "which version is up?" without an Admin read.
 *
 * THE CORE/STAMP SPLIT IS THE WHOLE DESIGN. The stamp is additive presentation, so every
 * comparison in this subsystem runs on the CORE body with the stamp stripped from both sides.
 * `coreSha256` is the wording; `sha256` is the committed bytes, an integrity hash only. Comparing
 * a stamped body against an unstamped one is how the stamp self-trips a gate, and the reason each
 * call site names its hash explicitly (marketing/policies/README.md has the table).
 *
 * Shape: `<!-- sss-policy shipping_policy v3 -->`. The prefix is deliberately store-specific:
 * `<!-- version 3 -->` would be plausible enough for a hand edit or another tool to collide with.
 */
const STAMP_KEY_RE = '[a-z][a-z0-9_]*';

/**
 * Anchored at position 0 and NOWHERE ELSE. A stamp-shaped comment further down a body is content,
 * not a stamp, and stripping it would silently rewrite a policy. `v0`, `v03`, `v-1` and `v 3` are
 * all non-matches: the version is `[1-9]\d*`, so a leading zero cannot mint a second spelling of
 * the same number.
 */
const STAMP_RE = new RegExp(`^<!-- sss-policy (${STAMP_KEY_RE}) v([1-9]\\d*) -->(?:\\r?\\n|$)`);

/** `{ key, version }` for a body whose first line is a stamp, else null. */
export function parseVersionStamp(body) {
  const m = STAMP_RE.exec(String(body ?? ''));
  return m === null ? null : { key: m[1], version: Number(m[2]) };
}

/** True when the body's first line is a version stamp. */
export function isStampedBody(body) {
  return parseVersionStamp(body) !== null;
}

/**
 * The core body: everything a comparison should look at. Idempotent, and a no-op on a body that
 * carries no stamp. Never strips more than one stamp: two stamps means something wrote one on top
 * of another, and `check` should say so rather than have this quietly tidy it away.
 */
export function stripVersionStamp(body) {
  const text = String(body ?? '');
  return text.replace(STAMP_RE, '');
}

/**
 * `sha256` of the core body. THE hash every comparison uses. Takes a raw or canonical body and
 * canonicalises first, so a caller cannot get a different answer by forgetting to.
 */
export function coreSha256(body) {
  return sha256(stripVersionStamp(canonicalise(body)));
}

/** The core body in canonical form. */
export function coreOf(body) {
  return stripVersionStamp(canonicalise(body));
}

/**
 * Put the stamp on. Takes a CORE body and refuses a body that already carries one: `stamp(stamp(x))`
 * is the double-stamp bug, and a silent second stamp would be invisible in a diff of the rendered
 * page. Callers strip first, always.
 */
export function stampVersion(core, key, version) {
  const text = canonicalise(core);
  if (isStampedBody(text)) throw new PolicyError(String(key), 'body already carries a version stamp; strip it first');
  if (typeForKey(key) === null) throw new PolicyError(String(key), 'not a tracked policy key');
  if (!isVersionNumber(version)) {
    throw new PolicyError(String(key), `version must be an integer >= 1, got ${JSON.stringify(version)}`);
  }
  return `<!-- sss-policy ${key} v${version} -->\n${text}`;
}

/**
 * A usable version number.
 *
 * SAFE integer, not merely integer. `Number.MAX_SAFE_INTEGER + 1` passes `Number.isInteger`, and
 * `+ 1` on it returns the same value, so a version there would stop incrementing silently and two
 * different bodies would ship under one number. Absurd as a real value, and exactly the kind of
 * thing a hand-edited manifest can hold.
 */
export function isVersionNumber(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

/** The stamp a policy SHOULD carry, given its manifest entry. `false` means it carries none. */
export function isStamped(entry) {
  return entry?.stamped === true;
}

/**
 * Whether a fresh entry for this type is stamped. Derived from WRITABLE, and it can only be
 * narrowed by hand afterwards: a stamp we cannot push is a permanent `check` failure, which is
 * exactly `privacy_policy`, auto-managed by Shopify and refused by `shopPolicyUpdate`.
 */
export function defaultStamped(type) {
  return WRITABLE[type] === true;
}

/**
 * The next version for a policy, from its previous manifest entry and the core hash of the body
 * now on disk. DERIVED AND NEVER HAND-TYPED, which is what makes `version` an identity rather
 * than a claim.
 *
 * | previous state                                   | result           |
 * |--------------------------------------------------|------------------|
 * | no entry, or no `version`                        | 1                |
 * | `version` present, `coreSha256` absent           | `version` (seed) |
 * | `version` present, `coreSha256` unchanged        | `version`        |
 * | `version` present, `coreSha256` differs          | `version + 1`    |
 * | `version` not an integer >= 1                    | REFUSAL          |
 * | derived <= `floor.highestPushed`, different core | REFUSAL          |
 *
 * Row two is the pre-migration shape: an entry that has been given a version but whose core hash
 * has never been recorded. Bumping there would invent a version off a comparison that was never
 * made.
 *
 * THE MONOTONIC FLOOR (last row). `prev` comes from a git-tracked file, so `git revert` restores
 * body and manifest atomically and walks `version` BACKWARDS while live still carries the higher
 * number. The next wording change then re-derives a version that is already live against different
 * bytes, which defeats the stamp's entire purpose. `floor` comes from the machine-local state file
 * (`highestPushed`), so this refuses rather than minting a colliding version. An identical core is
 * exempt: that is the same content, not a collision.
 *
 * Throws `PolicyError`. Every caller must leave the tree untouched when it does.
 *
 * @param {object|undefined} prev   the committed manifest entry, or undefined
 * @param {string} coreHash         sha256 of the core body on disk
 * @param {{highestPushed: number, coreSha256: string}|null} [floor]
 */
export function deriveVersion(prev, coreHash, floor = null) {
  if (typeof coreHash !== 'string' || !/^[0-9a-f]{64}$/.test(coreHash)) {
    throw new PolicyError('deriveVersion', `needs a sha256 digest, got ${JSON.stringify(coreHash)}`);
  }
  const previous = prev?.version;
  let version;
  if (previous === undefined || previous === null) {
    version = 1;
  } else if (!isVersionNumber(previous)) {
    throw new PolicyError(
      'version',
      `is ${JSON.stringify(previous)}, which is not an integer >= 1. It is derived, never hand-typed; ` +
        'fix it with npm run policies:restamp rather than by editing the manifest.',
    );
  } else if (typeof prev.coreSha256 !== 'string') {
    version = previous;
  } else if (prev.coreSha256 === coreHash) {
    version = previous;
  } else {
    version = previous + 1;
  }

  assertVersionFloor(version, coreHash, floor);
  return version;
}

/**
 * The monotonic floor, as its own function because two callers enforce it and one message is the
 * point: `deriveVersion` refuses to MINT a colliding version, and `push` refuses to WRITE one.
 * Push is where it actually matters, because that is where the state file is guaranteed present.
 *
 * A version at or below the floor is fine when the core hash matches the one that was pushed at
 * that version: that is the same content, not a collision.
 */
export function assertVersionFloor(version, coreHash, floor) {
  if (!floor || !Number.isSafeInteger(floor.highestPushed)) return;
  if (version > floor.highestPushed) return;
  if (floor.coreSha256 === coreHash) return;
  throw new PolicyError(
    'version',
    `${version} has already been pushed to the live store (highest pushed: v${floor.highestPushed}) against ` +
      'DIFFERENT wording, so writing it would put two bodies behind one version number and the stamp ' +
      'would stop identifying anything. This is what a `git revert` of a policy change looks like: the ' +
      'manifest walks backwards while the live store does not. Make the next wording edit and run ' +
      'npm run policies:restamp, which derives a version above the floor.',
  );
}

/**
 * The manifest entry a pull would record for one policy.
 *
 * `prev` is spread first so key order never churns against a hand-formatted manifest.
 *
 * `body` is the RAW body from Admin, which may or may not carry a stamp: live is unstamped until
 * the first stamped push lands, and stamped for every read after it. The core is taken from it
 * either way, and the entry describes the STAMPED body this function returns alongside it, which
 * is what pull writes to disk. Without that, `check` would either refuse after every pull or be
 * unable to detect a silently dropped stamp.
 *
 * The bookkeeping fields that used to live here, `remote` and `pulledAt`, are gone: they made
 * every push dirty the tree with its own side effect, which meant a PR per push forever. They live
 * in the machine-local state file now (`lib/state.mjs`), and the PR history is the record of what
 * changed.
 *
 * @param {object|undefined} prev  the committed entry, or undefined for a new one
 * @param {object} o
 * @param {string} o.type          a POLICY_TYPES member
 * @param {string} o.title         Admin's title for the policy
 * @param {string} o.body          the body from Admin, stamped or not
 * @param {{highestPushed: number, coreSha256: string}|null} [o.floor]  the monotonic floor, from state
 * @returns {{entry: object, body: string}} the entry, and the body to write to disk
 */
export function buildEntry(prev, { type, title, body, floor = null }) {
  const key = keyForType(type);
  const core = coreOf(body);
  const coreHash = sha256(core);
  const version = deriveVersion(prev, coreHash, floor);
  const stamped = prev?.stamped === undefined ? defaultStamped(type) : prev.stamped === true;
  const written = stamped ? stampVersion(core, key, version) : core;
  const entry = {
    ...(prev ?? {}),
    title,
    handle: STOREFRONT_HANDLES[type],
    writable: WRITABLE[type],
    stamped,
    version,
    coreSha256: coreHash,
    sha256: sha256(written),
    length: written.length,
    headings: extractHeadings(core),
  };
  delete entry.remote;
  delete entry.pulledAt;
  if (!WRITABLE[type]) {
    entry.reason = prev?.reason ?? NOT_WRITABLE_REASON;
  } else {
    delete entry.reason;
  }
  return { entry, body: written };
}

export const NOT_WRITABLE_REASON =
  'Shopify auto-manages this policy: shopPolicyUpdate is refused on it and Shopify rewrites the body on its own schedule. Tracked read-only.';

/**
 * Compare a committed entry against one recomputed from the body on disk. Returns a list of
 * mismatch strings, one per class, empty when they agree. Deliberately field-by-field rather than
 * a deep equal, so a failure names what moved instead of printing two 20 KB objects.
 *
 * `title` is deliberately NOT compared: it comes from Admin and cannot be recomputed offline, so
 * comparing it against itself would be a tautology dressed as a check. check.mjs asserts it is a
 * non-empty string, and pull is what keeps it current.
 */
export const DIFFED_FIELDS = Object.freeze(['handle', 'writable', 'stamped', 'sha256', 'coreSha256', 'length']);

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
