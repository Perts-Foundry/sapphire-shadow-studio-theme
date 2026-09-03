#!/usr/bin/env node
// Turns each stock Shopify notification template under marketing/notifications/stock/
// into the branded, ready-to-paste copy next to it. Three mechanical edits, nothing else:
//   1. the stock accent-colour <style> block is replaced with lib/brand-style.css
//   2. lib/footer-social.html is inserted before the footer's disclaimer paragraph
//   3. a version stamp: a one-line Liquid comment naming the source and version is prepended,
//      and an HTML comment carrying the same id and version follows the social row
// Manifest-driven and fail-closed: ids come from manifest.json, never a glob; every
// anchor must resolve exactly once; the stock snapshot must match its recorded hash;
// any refusal fails the whole run and, in generate mode, writes nothing.
//
// Versioning: each manifest entry carries `version` (integer, from 1) and `brandedSha256`, the
// sha256 of the stamp-free output ("core"). generate seeds a missing version at 1 and bumps it
// whenever the core bytes change; check refuses a file, hash or version that disagrees. The
// stamps are how an Admin copy is compared back to the repo; nothing else reads them.
//
//   node scripts/notifications/brand.mjs            regenerate every branded file
//   node scripts/notifications/brand.mjs --check    compare in memory, write nothing
//   node scripts/notifications/brand.mjs --status   print id, version, hash prefix; write nothing
//   ... --root <dir>                                 operate on another checkout (tests)
//
// marketing/notifications/README.md documents the surface.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The one stamp prefix. STAMP_RE_SOURCE is embedded verbatim in scripts/notifications/browser/
// editor-probe.js, and a test asserts the two strings are equal, so every reader of a stamp
// (this file, verify-render.mjs, the browser probe) parses it the same way. Bounded on both
// sides: the id is [a-z0-9_]+, the version [1-9][0-9]*, and neither may run into more text.
export const STAMP_PREFIX = 'sss-notification';
export const STAMP_RE_SOURCE = '(?<![A-Za-z0-9_-])sss-notification ([a-z0-9_]+) v([1-9][0-9]*)(?![0-9A-Za-z_-])';
export const STAMP_RE = new RegExp(STAMP_RE_SOURCE);

// The one EmailTemplate gid shape, and the one place it is written down. The id segment of an
// EmailTemplate gid is the template HANDLE, not a number: Admin returns
// `gid://shopify/EmailTemplate/buy_online`. It was `[0-9]+` in two hand-typed copies, in
// classify.mjs and state.mjs, until a sync read all 46 editors and every one of them was refused.
// Both copies agreed, and every fixture encoded the same invented numeric gid, so nothing was
// green-to-red about it: the shape had been assumed rather than observed. Deduplicating it here is
// what makes that class of defect structural rather than something a parity test has to notice;
// what actually guards against pairing one template's response with another id is the string
// equality in before-doc.mjs, which this format check only feeds. GID_EXAMPLE is embedded in the
// refusal messages both callers print, and test/gid-corpus.test.mjs asserts GID_RE accepts it, so
// a widened regex cannot leave a stale example behind.
export const GID_HANDLE_RE_SOURCE = '[a-z0-9_]+';
export const GID_RE = new RegExp(`^gid://shopify/EmailTemplate/${GID_HANDLE_RE_SOURCE}$`);
export const GID_EXAMPLE = 'gid://shopify/EmailTemplate/buy_online';
// The shape named in a refusal, so the two callers' messages cannot describe different regexes.
export const GID_EXPECTED = `expected gid://shopify/EmailTemplate/<handle> (handle matches ${GID_HANDLE_RE_SOURCE}, e.g. ${GID_EXAMPLE})`;

export function isValidVersion(v) {
  return Number.isInteger(v) && v >= 1;
}

// Every stamp in `text`, in order, as { id, version }. `parseStamp` returns null when there is
// none, and otherwise the first stamp plus `count` (how many stamps were found) and `consistent`
// (whether every stamp names the same id and version). Callers that need "exactly once" look at
// count; callers that only need the identity look at id and version.
export function findStamps(text) {
  const re = new RegExp(STAMP_RE_SOURCE, 'g');
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push({ id: m[1], version: Number(m[2]) });
  return out;
}

export function parseStamp(text) {
  const stamps = findStamps(text);
  if (stamps.length === 0) return null;
  const { id, version } = stamps[0];
  const consistent = stamps.every((s) => s.id === id && s.version === version);
  return { id, version, count: stamps.length, consistent };
}

export function footerStamp(id, version) {
  if (!isValidVersion(version)) throw new Error(`${id}: stamp needs an integer version >= 1, got ${JSON.stringify(version)}`);
  return `<!-- ${STAMP_PREFIX} ${id} v${version} -->`;
}

export const STOCK_STYLE_BLOCK = [
  '<style>',
  '.button__cell { background: {{ shop.email_accent_color }}; }',
  '.actions-buttons .button__cell--primary { background-color: {{ shop.email_accent_color }}; }',
  'a, a:hover, a:active, a:visited { color: {{ shop.email_accent_color }}; }',
  '</style>',
].join(' ');

export const FOOTER_TABLE_ANCHOR = '<table class="row footer">';
export const DISCLAIMER_ANCHOR = '<p class="disclaimer__subtext">';
// The `header` override inserts lib/header.html before this table and removes every stock logo
// block (a `{% if shop.email_logo_url %}` ... `{% endif %}` span holding the logo image) from the
// body, so a template that ships without a header table gets the brand band like the rest.
export const CONTENT_TABLE_ANCHOR = '<table class="row content">';
export const HEADER_TABLE_ANCHOR = '<table class="header row">';
export const LOGO_IF_TAG = '{% if shop.email_logo_url %}';
export const LOGO_ENDIF_TAG = '{% endif %}';

export class BrandError extends Error {
  constructor(id, anchor, detail) {
    super(`${id}: refused (${anchor}): ${detail}`);
    this.id = id;
    this.anchor = anchor;
    this.detail = detail;
  }
}

export function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function commentLine(id, version) {
  if (!isValidVersion(version)) throw new Error(`${id}: stamp needs an integer version >= 1, got ${JSON.stringify(version)}`);
  return `{%- comment -%}${STAMP_PREFIX} ${id} v${version}. Generated by scripts/notifications/brand.mjs from marketing/notifications/stock/${id}.liquid; do not hand-edit, change marketing/notifications/lib/ or manifest.json and regenerate.{%- endcomment -%}\n`;
}

// Stamps a stamp-free core: the comment line goes first, the footer HTML comment goes at
// `footerAt` (the offset in `core` of the footer anchor paragraph, directly after the inserted
// social row) on its own line at the anchor's indent, so the social region stays contiguous and
// the version survives into a sent email's HTML. Pure: same inputs, same bytes.
export function stamp(core, id, version, footerAt) {
  if (!Number.isInteger(footerAt) || footerAt < 0 || footerAt > core.length) {
    throw new Error(`${id}: stamp needs the footer offset`);
  }
  const indent = lineIndent(core, footerAt);
  if (indent === null) throw new Error(`${id}: footer stamp offset is not at the start of a line`);
  return commentLine(id, version) + core.slice(0, footerAt) + footerStamp(id, version) + '\n' + indent + core.slice(footerAt);
}

function indexesOf(haystack, needle) {
  const out = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + needle.length);
  }
  return out;
}

function commentRanges(text) {
  const ranges = [];
  const re = /{%-?\s*comment\s*-?%}[\s\S]*?{%-?\s*endcomment\s*-?%}/g;
  let m;
  while ((m = re.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

function insideComment(ranges, index) {
  return ranges.some(([a, b]) => index >= a && index < b);
}

function requireOnce(id, anchor, occurrences, ranges) {
  const outside = occurrences.filter((i) => !insideComment(ranges, i));
  if (occurrences.length !== outside.length) {
    throw new BrandError(id, anchor, 'anchor found inside a Liquid comment');
  }
  if (outside.length === 0) throw new BrandError(id, anchor, 'anchor not found');
  if (outside.length > 1) {
    throw new BrandError(id, anchor, `anchor found ${outside.length} times, expected exactly once`);
  }
  return outside[0];
}

function lineIndent(text, index) {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const prefix = text.slice(lineStart, index);
  if (!/^[ \t]*$/.test(prefix)) return null;
  return prefix;
}

// Every stock logo block, as whole-line [start, end) spans. A block is `{% if shop.email_logo_url %}`
// first on its line, then an <img> that references the logo, and the very next Liquid tag is the
// `{% endif %}` that closes it, alone on its line. Anything else is a refusal: a block that holds
// another tag is not the shape this removal was written for.
function logoBlocks(stock, id, ranges) {
  const spans = [];
  for (const at of indexesOf(stock, LOGO_IF_TAG)) {
    if (insideComment(ranges, at)) throw new BrandError(id, 'logo', 'logo block found inside a Liquid comment');
    const indent = lineIndent(stock, at);
    if (indent === null) throw new BrandError(id, 'logo', 'logo block tag is not first on its line');
    const innerStart = at + LOGO_IF_TAG.length;
    const nextTag = stock.indexOf('{%', innerStart);
    if (nextTag === -1 || !stock.startsWith(LOGO_ENDIF_TAG, nextTag)) {
      throw new BrandError(id, 'logo', 'logo block is not closed by the next Liquid tag');
    }
    const inner = stock.slice(innerStart, nextTag);
    if (!inner.includes('<img') || !inner.includes('shop.email_logo_url')) {
      throw new BrandError(id, 'logo', 'logo block does not hold the logo image');
    }
    if (lineIndent(stock, nextTag) === null) throw new BrandError(id, 'logo', 'logo block endif is not first on its line');
    const endifEnd = nextTag + LOGO_ENDIF_TAG.length;
    const lineEnd = stock.indexOf('\n', endifEnd);
    if (lineEnd === -1 || stock.slice(endifEnd, lineEnd).trim() !== '') {
      throw new BrandError(id, 'logo', 'logo block endif is not alone on its line');
    }
    spans.push([at - indent.length, lineEnd + 1]);
  }
  if (spans.length === 0) throw new BrandError(id, 'logo', 'anchor not found');
  return spans;
}

// Locate the regions in a stock template. Returns { styleStart, styleEnd, footerStart, contentStart,
// logos }; contentStart is null and logos is empty unless the override asks for a header.
export function locateAnchors(stock, id, override) {
  const ranges = commentRanges(stock);
  let styleStart;
  let styleEnd;
  if (override && override.styleAnchor) {
    const at = requireOnce(id, 'style', indexesOf(stock, override.styleAnchor), ranges);
    styleStart = at;
    styleEnd = at + override.styleAnchor.length;
  } else {
    const blocks = [];
    const re = /<style[^>]*>[\s\S]*?<\/style>/g;
    let m;
    while ((m = re.exec(stock)) !== null) {
      if (m[0].includes('shop.email_accent_color')) blocks.push([m.index, m.index + m[0].length]);
    }
    const at = requireOnce(id, 'style', blocks.map((b) => b[0]), ranges);
    const block = blocks.find((b) => b[0] === at);
    if (normalizeWhitespace(stock.slice(block[0], block[1])) !== STOCK_STYLE_BLOCK) {
      throw new BrandError(id, 'style', 'accent-colour style block differs from the known stock block');
    }
    styleStart = block[0];
    styleEnd = block[1];
  }

  // The insertion point must sit inside the footer table whether it came from the stock disclaimer
  // anchor or from a manifest override: an override that resolves to the body-side disclaimer
  // paragraph (six stock templates carry one) would otherwise brand "successfully" in the wrong place.
  const tableAt = requireOnce(id, 'footer-table', indexesOf(stock, FOOTER_TABLE_ANCHOR), ranges);
  let footerStart;
  let footerAnchorName;
  if (override && override.footerAnchor) {
    footerAnchorName = 'footer';
    footerStart = requireOnce(id, footerAnchorName, indexesOf(stock, override.footerAnchor), ranges);
  } else {
    footerAnchorName = 'disclaimer';
    footerStart = requireOnce(id, footerAnchorName, indexesOf(stock, DISCLAIMER_ANCHOR), ranges);
  }
  if (footerStart < tableAt) {
    throw new BrandError(id, footerAnchorName, 'disclaimer paragraph precedes the footer table');
  }
  if (stock.slice(tableAt, footerStart).includes('</table>')) {
    throw new BrandError(id, footerAnchorName, 'disclaimer paragraph is not inside the footer table');
  }
  if (lineIndent(stock, footerStart) === null) {
    throw new BrandError(id, 'footer', 'insertion point is not at the start of a line');
  }
  if (styleEnd > footerStart) throw new BrandError(id, 'footer', 'footer anchor precedes the style block');

  let contentStart = null;
  let logos = [];
  if (override && override.header) {
    if (indexesOf(stock, HEADER_TABLE_ANCHOR).some((i) => !insideComment(ranges, i))) {
      throw new BrandError(id, 'header', 'stock already has a header table');
    }
    contentStart = requireOnce(id, 'content-table', indexesOf(stock, CONTENT_TABLE_ANCHOR), ranges);
    if (lineIndent(stock, contentStart) === null) throw new BrandError(id, 'header', 'content table is not first on its line');
    if (contentStart < styleEnd) throw new BrandError(id, 'header', 'content table precedes the style block');
    if (contentStart > tableAt) throw new BrandError(id, 'header', 'content table follows the footer table');
    logos = logoBlocks(stock, id, ranges);
    for (const [a, b] of logos) {
      if (a < contentStart || b > tableAt) throw new BrandError(id, 'logo', 'logo block is outside the content region');
    }
  }
  return { styleStart, styleEnd, footerStart, contentStart, logos };
}

// Returns { output, core, footerAt, accentRemaining }: `core` is the stamp-free result of the
// mechanical edits (what brandedSha256 hashes), `footerAt` the offset in core where the footer
// stamp goes, and `output` the core stamped with `version`. A missing or invalid version throws
// before any work, so no caller can ever emit "vundefined".
export function brandTemplate(stock, { id, version, css, social, header, override }) {
  if (!isValidVersion(version)) throw new Error(`${id}: brandTemplate needs an integer version >= 1, got ${JSON.stringify(version)}`);
  const { core, footerAt, accentRemaining } = brandCore(stock, { id, css, social, header, override });
  return { output: stamp(core, id, version, footerAt), core, footerAt, accentRemaining };
}

export function brandCore(stock, { id, css, social, header, override }) {
  if (stock.charCodeAt(0) === 0xfeff) throw new BrandError(id, 'input', 'stock file starts with a BOM');
  if (stock.includes('\r')) throw new BrandError(id, 'input', 'stock file contains a carriage return');
  const { styleStart, styleEnd, footerStart, contentStart, logos } = locateAnchors(stock, id, override);
  // Edits as [start, end, replacement] over the stock text, applied in offset order. The two
  // every template gets, then the header pair when the override asks for it.
  const edits = [
    [styleStart, styleEnd, '<style>\n' + css + '  </style>'],
    [footerStart, footerStart, social.replace(/\s+$/, '') + '\n' + lineIndent(stock, footerStart)],
  ];
  if (contentStart !== null) {
    if (typeof header !== 'string' || header.trim() === '') {
      throw new BrandError(id, 'header', 'lib/header.html is required by the header override');
    }
    edits.push([contentStart, contentStart, header.replace(/\s+$/, '') + '\n\n' + lineIndent(stock, contentStart)]);
    for (const [a, b] of logos) edits.push([a, b, '']);
  }
  // The `replace` override: exact substrings swapped for exact substrings, each found exactly once
  // outside a Liquid comment. For markup the template must carry as long as the store's copy ships
  // it; the manifest entry's reason says which. That covers two cases, and they are not the same:
  // a stock markup bug Shopify ships (order_invoice, pending_payment_failure), and a block Admin
  // INJECTS into this store's copy, which is what customer_email_address_changed_confirmation's
  // colour block is (marketing/notifications/README.md explains it).
  if (override && override.replace !== undefined) {
    if (!Array.isArray(override.replace) || override.replace.length === 0) {
      throw new BrandError(id, 'replace', 'override.replace must be a non-empty array');
    }
    const ranges = commentRanges(stock);
    override.replace.forEach((entry, n) => {
      if (!entry || typeof entry.from !== 'string' || entry.from === '' || typeof entry.to !== 'string') {
        throw new BrandError(id, 'replace', `entry ${n} needs a non-empty string "from" and a string "to"`);
      }
      const at = requireOnce(id, `replace[${n}]`, indexesOf(stock, entry.from), ranges);
      edits.push([at, at + entry.from.length, entry.to]);
    });
  }
  edits.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  for (let i = 1; i < edits.length; i++) {
    const prev = edits[i - 1];
    const cur = edits[i];
    // Overlap, or a replacement starting on the exact spot an insertion goes: both are refusals,
    // because the second would rewrite the anchor the insertion was located by.
    if (cur[0] < prev[1] || (prev[0] === prev[1] && cur[0] === prev[0])) {
      throw new BrandError(id, 'replace', 'a replacement overlaps another edit');
    }
  }
  let core = '';
  let cursor = 0;
  let footerAt = null;
  for (const [a, b, text] of edits) {
    core += stock.slice(cursor, a) + text;
    // The footer edit is the insertion at footerStart; the stamp goes right after it, which is
    // exactly where the anchor paragraph resumes.
    if (a === footerStart && b === footerStart) footerAt = core.length;
    cursor = b;
  }
  core += stock.slice(cursor);
  if (footerAt === null) throw new BrandError(id, 'footer', 'footer insertion was not applied');
  const body = stock.slice(0, styleStart) + stock.slice(styleEnd);
  const accentRemaining = indexesOf(body, 'email_accent_color').length;
  return { core, footerAt, accentRemaining };
}

export function paths(root = REPO_ROOT) {
  const dir = join(root, 'marketing', 'notifications');
  return {
    dir,
    manifest: join(dir, 'manifest.json'),
    stockDir: join(dir, 'stock'),
    css: join(dir, 'lib', 'brand-style.css'),
    social: join(dir, 'lib', 'footer-social.html'),
    header: join(dir, 'lib', 'header.html'),
    branded: (id) => join(dir, `${id}.liquid`),
    stock: (id) => join(dir, 'stock', `${id}.liquid`),
  };
}

export function readManifest(root) {
  const p = paths(root);
  const manifest = JSON.parse(readFileSync(p.manifest, 'utf8'));
  if (!manifest.templates || typeof manifest.templates !== 'object') {
    throw new Error('manifest.json: missing "templates" object');
  }
  return manifest;
}

function liquidIds(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.liquid'))
    .map((f) => f.slice(0, -'.liquid'.length))
    .sort();
}

// The version and hash the next generate would record for one entry, from the entry as committed
// and the freshly computed core hash. Pure. `problem` is set when the committed version is not an
// integer >= 1, which refuses the whole run rather than guessing.
export function nextStamp(entry, coreSha256) {
  const hasVersion = entry.version !== undefined;
  const hasHash = entry.brandedSha256 !== undefined;
  if (hasVersion && !isValidVersion(entry.version)) {
    return { problem: `version must be an integer >= 1, got ${JSON.stringify(entry.version)}` };
  }
  const prevVersion = hasVersion ? entry.version : null;
  if (!hasVersion && !hasHash) return { version: 1, brandedSha256: coreSha256, bumped: true, prevVersion, seeded: true };
  if (hasVersion && !hasHash) return { version: entry.version, brandedSha256: coreSha256, bumped: false, prevVersion, seeded: true };
  if (!hasVersion && hasHash) return { version: 1, brandedSha256: coreSha256, bumped: true, prevVersion, seeded: true };
  if (entry.brandedSha256 !== coreSha256) return { version: entry.version + 1, brandedSha256: coreSha256, bumped: true, prevVersion, seeded: false };
  return { version: entry.version, brandedSha256: entry.brandedSha256, bumped: false, prevVersion, seeded: false };
}

// Shared by generate, check and --status. Side-effect free: reads the manifest and the files,
// touches nothing. Returns
//   outputs:  Map<id, string>   each core stamped with the version generate would record
//   cores:    Map<id, { core, footerAt, coreSha256 }>
//   stamps:   Map<id, { version, brandedSha256, bumped, prevVersion, seeded }>
//   problems, notes, expectedBranded, manifest (the parsed committed manifest, unmodified)
export function plan(root = REPO_ROOT) {
  const p = paths(root);
  const problems = [];
  const notes = [];
  const outputs = new Map();
  const cores = new Map();
  const stamps = new Map();
  const manifest = readManifest(root);
  const ids = Object.keys(manifest.templates).sort();
  if (ids.length === 0) problems.push('manifest.json lists no templates');

  const stockIds = liquidIds(p.stockDir);
  const brandedIds = liquidIds(p.dir);
  const skipped = new Set(ids.filter((id) => manifest.templates[id].skip));
  const expectedBranded = ids.filter((id) => !skipped.has(id));

  for (const id of ids) if (!stockIds.includes(id)) problems.push(`${id}: stock/${id}.liquid is missing`);
  for (const id of stockIds) if (!ids.includes(id)) problems.push(`${id}: stock/${id}.liquid is not in manifest.json`);
  for (const id of brandedIds) {
    if (!ids.includes(id)) problems.push(`${id}: ${id}.liquid has no manifest entry`);
    else if (skipped.has(id)) problems.push(`${id}: marked skip in manifest.json but ${id}.liquid exists`);
  }

  const css = readFileSync(p.css, 'utf8');
  const social = readFileSync(p.social, 'utf8');
  const header = existsSync(p.header) ? readFileSync(p.header, 'utf8') : null;
  if (!css.endsWith('\n')) problems.push('lib/brand-style.css must end with a newline');
  for (const [name, text] of [['lib/brand-style.css', css], ['lib/footer-social.html', social], ['lib/header.html', header || '']]) {
    if (text.includes('\r')) problems.push(`${name} contains a carriage return`);
  }
  if (header === null && ids.some((id) => manifest.templates[id].override && manifest.templates[id].override.header)) {
    problems.push('lib/header.html is missing but a manifest entry sets override.header');
  }

  for (const id of ids) {
    const entry = manifest.templates[id];
    if (!stockIds.includes(id)) continue;
    const stock = readFileSync(p.stock(id), 'utf8');
    if (typeof entry.stockSha256 !== 'string' || typeof entry.stockLength !== 'number') {
      problems.push(`${id}: manifest entry lacks stockSha256 / stockLength`);
      continue;
    }
    if (stock.length !== entry.stockLength || sha256(stock) !== entry.stockSha256) {
      problems.push(
        `${id}: stock/${id}.liquid does not match the recorded snapshot (length ${stock.length}, expected ${entry.stockLength}); ` +
          're-record it with scripts/notifications/record-stock.mjs if the change is intended',
      );
      continue;
    }
    if (skipped.has(id)) {
      notes.push(`${id}: skipped (${entry.skip})`);
      continue;
    }
    // Already reported once above; a per-id refusal on top would say the same thing three times.
    if (header === null && entry.override && entry.override.header) continue;
    try {
      const { core, footerAt, accentRemaining } = brandCore(stock, { id, css, social, header, override: entry.override });
      const coreSha256 = sha256(core);
      const next = nextStamp(entry, coreSha256);
      if (next.problem) {
        problems.push(`${id}: ${next.problem}`);
        continue;
      }
      cores.set(id, { core, footerAt, coreSha256 });
      stamps.set(id, next);
      outputs.set(id, stamp(core, id, next.version, footerAt));
      if (accentRemaining > 0) notes.push(`${id}: ${accentRemaining} email_accent_color reference(s) remain in the body`);
    } catch (err) {
      if (err instanceof BrandError) problems.push(err.message);
      else throw err;
    }
  }
  return { outputs, cores, stamps, problems, notes, expectedBranded, manifest };
}

function firstDifference(actual, expected) {
  const len = Math.min(actual.length, expected.length);
  let i = 0;
  while (i < len && actual[i] === expected[i]) i++;
  const line = actual.slice(0, i).split('\n').length;
  const ctx = (s) => s.slice(Math.max(0, i - 60), i + 60).replace(/\n/g, '\\n');
  return { offset: i, line, expected: ctx(expected), actual: ctx(actual) };
}

export const CHECK_VERSION_MESSAGE = 'version missing or invalid';
export const CHECK_BUMP_MESSAGE = 'bytes changed but version not bumped: run notifications:generate';

// Read-only. Mismatches (not problems, which are refusals of the inputs) are: the committed file
// differs from the core stamped with the committed version; the core hash differs from the
// committed brandedSha256; the committed version is missing or invalid. A green check proves the
// repo is self-consistent, not that Admin holds these bytes; only the skill's audit proves that.
export function check(root = REPO_ROOT) {
  const p = paths(root);
  const { cores, problems, notes, expectedBranded, manifest } = plan(root);
  const mismatches = [];
  for (const id of expectedBranded) {
    if (!cores.has(id)) continue;
    const entry = manifest.templates[id];
    const { core, footerAt, coreSha256 } = cores.get(id);
    if (!isValidVersion(entry.version)) {
      mismatches.push(`${id}: ${CHECK_VERSION_MESSAGE}`);
      continue;
    }
    if (entry.brandedSha256 !== coreSha256) mismatches.push(`${id}: ${CHECK_BUMP_MESSAGE}`);
    if (!existsSync(p.branded(id))) {
      mismatches.push(`${id}: ${id}.liquid is missing`);
      continue;
    }
    const actual = readFileSync(p.branded(id), 'utf8');
    const expected = stamp(core, id, entry.version, footerAt);
    if (Buffer.compare(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8')) !== 0) {
      const d = firstDifference(actual, expected);
      mismatches.push(
        `${id}: ${id}.liquid differs from regenerated output at offset ${d.offset} (line ${d.line})\n` +
          `    expected: ...${d.expected}...\n    actual:   ...${d.actual}...`,
      );
    }
  }
  return { problems, mismatches, notes };
}

// The manifest formatter record-stock.mjs uses, so a generate that only touches version and hash
// never reflows the file.
export function formatManifest(manifest) {
  return JSON.stringify(manifest, null, 2) + '\n';
}

function writeAtomic(target, text) {
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, target);
}

// Writes the manifest (only if its bytes change) and then every branded file. Manifest first: a
// crash between the two is self-healing, because the rerun sees hash == brandedSha256, does not
// bump, and writes the files. Returns { problems, written, notes, bumps } where bumps lists
// { id, prevVersion, version } for every seeded or bumped id.
export function generate(root = REPO_ROOT) {
  const p = paths(root);
  const { outputs, stamps, problems, notes, manifest } = plan(root);
  if (problems.length > 0) return { problems, written: [], notes, bumps: [] };
  const before = readFileSync(p.manifest);
  const bumps = [];
  for (const [id, next] of stamps) {
    const entry = manifest.templates[id];
    if (next.bumped || next.seeded) bumps.push({ id, prevVersion: next.prevVersion, version: next.version });
    // Assign into the existing entry so key order does not churn against record-stock's output.
    entry.version = next.version;
    entry.brandedSha256 = next.brandedSha256;
  }
  const after = formatManifest(manifest);
  if (Buffer.compare(before, Buffer.from(after, 'utf8')) !== 0) writeAtomic(p.manifest, after);
  const written = [];
  for (const [id, output] of outputs) {
    writeAtomic(p.branded(id), output);
    written.push(id);
  }
  return { problems, written, notes, bumps };
}

// The committed manifest's view, never the would-be-bumped one: [{ id, version, brandedSha256 }]
// with nulls where a field is absent. Read-only.
export function status(root = REPO_ROOT) {
  const manifest = readManifest(root);
  return Object.keys(manifest.templates).sort().map((id) => {
    const e = manifest.templates[id];
    return {
      id,
      version: isValidVersion(e.version) ? e.version : null,
      brandedSha256: typeof e.brandedSha256 === 'string' ? e.brandedSha256 : null,
      skip: e.skip ? String(e.skip) : null,
    };
  });
}

export function formatBump({ id, prevVersion, version }) {
  return `${id}: ${prevVersion === null ? 'unversioned' : `v${prevVersion}`} -> v${version}`;
}

function main(argv) {
  const args = argv.slice(2);
  const checkMode = args.includes('--check');
  const statusMode = args.includes('--status');
  const rootFlag = args.indexOf('--root');
  const root = rootFlag !== -1 ? resolve(args[rootFlag + 1]) : REPO_ROOT;
  if (statusMode) {
    for (const row of status(root)) {
      const hash = row.brandedSha256 === null ? '-' : row.brandedSha256.slice(0, 12);
      console.log(`${row.id} ${row.version === null ? 'unversioned' : row.version} ${hash}${row.skip ? ' skip' : ''}`);
    }
    return 0;
  }
  if (checkMode) {
    const { problems, mismatches, notes } = check(root);
    for (const n of notes) console.log(`note: ${n}`);
    for (const m of problems) console.error(`error: ${m}`);
    for (const m of mismatches) console.error(`error: ${m}`);
    if (problems.length || mismatches.length) {
      console.error(
        `notifications:check failed: ${problems.length} problem(s), ${mismatches.length} file(s) out of date. Fix: npm run notifications:generate`,
      );
      return 1;
    }
    console.log('notifications:check ok');
    return 0;
  }
  const { problems, written, notes, bumps } = generate(root);
  for (const n of notes) console.log(`note: ${n}`);
  for (const m of problems) console.error(`error: ${m}`);
  if (problems.length) {
    console.error(`notifications:generate refused: ${problems.length} problem(s); nothing written`);
    return 1;
  }
  for (const b of bumps) console.log(formatBump(b));
  console.log(`notifications:generate wrote ${written.length} file(s), ${bumps.length} version(s) seeded or bumped`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
