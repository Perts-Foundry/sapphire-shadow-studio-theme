// The strict reading of an article body. Pure: no fs, no fetch, no process.env, no process.argv.
//
// WHY A SECOND PARSER AT ALL. The first version of the safety rules walked the body with the
// lenient parser behind the notification templates and refused a BLOCKLIST of names. That is two
// separate bets, and both lose. A lenient parser recovers from broken markup in its own way, and a
// browser recovers in a different way: `<!--><img src=x onerror=...>-->` is one comment to a naive
// walker and an image with a live handler to Chrome, and `<p title=a"><img ...>` is one paragraph to
// one reader and two elements to the other. Every such disagreement is a payload the checker
// approves and the storefront executes. And a blocklist is only as long as somebody's memory of
// the HTML spec: `<base>`, `<meta http-equiv>`, `<noembed>` and `<math>` were each missing from it.
//
// SO THIS FILE DOES THE OPPOSITE ON BOTH COUNTS. The grammar below is deliberately much smaller than
// HTML: it accepts only markup whose reading is unambiguous, and REFUSES anything a browser would
// have to recover from, instead of guessing how the browser recovers. Comments, doctypes, CDATA,
// processing instructions, unquoted attribute values, a bare `<` in text, and any stray character
// inside a tag are all refusals rather than inputs. Over that strict reading, the elements and
// attributes are an ALLOWLIST: a name nobody has thought about is refused by default, which is the
// only direction a check on raw-rendered markup can safely fail in.
//
// THE GRAMMAR, in full:
//   text       any character except `<`
//   start tag  `<` name, then zero or more (whitespace+ attr-name, optionally `="..."` or `='...'`
//              with no `<` inside the value), optional whitespace, optional `/`, then `>`
//   end tag    `</` name, optional whitespace, `>`
//   name       [a-z][a-z0-9]* (case-insensitive, lowercased)
//   attr-name  [a-z][a-z0-9-]* (case-insensitive, lowercased)
//   whitespace the ASCII whitespace HTML defines: tab, LF, FF, CR, space
//
// Anything else is a malformed-markup refusal carrying the offset and a snippet, and the reading
// STOPS there: past the first point where this reader and a browser could disagree, nothing this
// file reports about the rest of the body would be trustworthy.

/**
 * Elements a body may contain. Anything else is refused.
 *
 * `h1` is here on purpose, and not because a body may carry one: the prose rule `prose/body-h1`
 * owns that refusal and says why. Refusing it here too would report one mistake twice under two
 * names, and the safety rule would be the less useful of the two.
 *
 * `pre` is NOT here, and neither is a nested table (see NESTED_TABLE_REFUSED). The live spike that
 * showed Shopify stores a body verbatim exercised a flat table, and the only rewriting it saw was
 * newlines inserted between table rows and cells. Nobody has shown what that normaliser does to
 * whitespace-significant `pre` content or to a table inside a table, and the repo compares its bytes
 * with what the store returns. Both stay refused until a second spike proves them; `code` inline is
 * fine because inline whitespace was part of what the first spike covered.
 */
export const ALLOWED_ELEMENTS = Object.freeze([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img', 'ul', 'ol', 'li',
  'strong', 'em', 'b', 'i', 'u', 's', 'small', 'sub', 'sup',
  'blockquote', 'cite', 'q', 'br', 'hr', 'figure', 'figcaption', 'span', 'div', 'code',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
]);

/** Attributes any allowed element may carry. None of them can carry a URL or run anything. */
export const GLOBAL_ATTRIBUTES = Object.freeze(['class', 'id', 'title', 'lang', 'dir']);

/** Attributes allowed on one element only, on top of the global set. */
export const ELEMENT_ATTRIBUTES = Object.freeze({
  a: Object.freeze(['href', 'rel', 'target']),
  img: Object.freeze(['src', 'alt', 'width', 'height', 'loading']),
  th: Object.freeze(['colspan', 'rowspan', 'scope']),
  td: Object.freeze(['colspan', 'rowspan', 'scope']),
});

/**
 * The attributes that carry a URL, by element. These two are the ONLY URL-bearing attributes the
 * allowlist admits, which is what lets the URL rules below be exhaustive rather than a list of
 * attribute names somebody remembered (`srcset`, `formaction`, `xlink:href` and `poster` are all
 * refused as attributes before any URL rule is reached).
 */
export const URL_ATTRIBUTE_BY_ELEMENT = Object.freeze({ a: 'href', img: 'src' });

/** The detail a nested table is refused with. Exported so the test asserts the reason, not a copy. */
export const NESTED_TABLE_REFUSED = 'a <table> nested inside another <table> is refused until a spike proves how Shopify normalises it';

const WS = '\\t\\n\\f\\r ';
const WS_RE = new RegExp(`[${WS}]+`, 'y');
const TAG_NAME_RE = /[A-Za-z][A-Za-z0-9]*/y;
const ATTR_NAME_RE = /[A-Za-z][A-Za-z0-9-]*/y;
const END_TAG_RE = new RegExp(`</([A-Za-z][A-Za-z0-9]*)[${WS}]*>`, 'y');

/** A short, single-line excerpt of the body at an offset, for a refusal detail. */
function snippet(text, offset) {
  return JSON.stringify(text.slice(offset, offset + 40));
}

function malformed(text, offset, why) {
  return { offset, detail: `malformed markup at offset ${offset} (${snippet(text, offset)}): ${why}` };
}

function matchAt(re, text, pos) {
  re.lastIndex = pos;
  return re.exec(text);
}

/**
 * Read a body under the strict grammar.
 *
 * Returns `{ elements, error }`. `elements` is every start tag in document order, each
 * `{ tag, attrs, offset, nestedTable }` where `attrs` is an array of `[name, value]` pairs in source
 * order: an array rather than an object, so a duplicated name is still two entries and the second
 * value is still examined. `value` is null for a bare boolean attribute. `nestedTable` is true for a
 * `<table>` opened while another is open. `error` is null, or `{ offset, detail }` for the first
 * point the body leaves the grammar, and `elements` then holds only what came before it.
 *
 * @param {string} body
 */
export function readMarkup(body) {
  const text = String(body ?? '');
  const elements = [];
  let tableDepth = 0;
  let pos = 0;

  while (pos < text.length) {
    const lt = text.indexOf('<', pos);
    if (lt === -1) break;
    pos = lt;
    const next = text[pos + 1];

    if (next === '!') {
      return { elements, error: malformed(text, pos, '`<!` opens a comment, doctype or CDATA section, none of which a body may contain') };
    }
    if (next === '?') {
      return { elements, error: malformed(text, pos, '`<?` is not allowed in a body') };
    }

    if (next === '/') {
      const end = matchAt(END_TAG_RE, text, pos);
      if (!end) {
        return { elements, error: malformed(text, pos, 'an end tag must be exactly `</name>`') };
      }
      if (end[1].toLowerCase() === 'table' && tableDepth > 0) tableDepth -= 1;
      pos += end[0].length;
      continue;
    }

    const name = matchAt(TAG_NAME_RE, text, pos + 1);
    if (!name) {
      return { elements, error: malformed(text, pos, 'a `<` in text must be written `&lt;`; it may only open a tag') };
    }
    const tag = name[0].toLowerCase();
    const offset = pos;
    const attrs = [];
    pos += 1 + name[0].length;

    // Attributes. Each one needs whitespace before it, so `<p title="a"class="b">` is refused
    // rather than read as two attributes, which is how a browser reads it and how a lenient walker
    // might not.
    for (;;) {
      const ws = matchAt(WS_RE, text, pos);
      if (ws) pos += ws[0].length;
      const attrName = ws ? matchAt(ATTR_NAME_RE, text, pos) : null;
      if (!attrName) break;
      pos += attrName[0].length;
      let value = null;
      if (text[pos] === '=') {
        const quote = text[pos + 1];
        if (quote !== '"' && quote !== "'") {
          return { elements, error: malformed(text, pos, `the value of "${attrName[0]}" is unquoted; quote every attribute value`) };
        }
        const close = text.indexOf(quote, pos + 2);
        if (close === -1) {
          return { elements, error: malformed(text, pos, `the value of "${attrName[0]}" is never closed`) };
        }
        value = text.slice(pos + 2, close);
        if (value.includes('<')) {
          return { elements, error: malformed(text, pos, `the value of "${attrName[0]}" contains a \`<\`; write \`&lt;\``) };
        }
        pos = close + 1;
      }
      attrs.push([attrName[0].toLowerCase(), value]);
    }

    if (text[pos] === '/') pos += 1;
    if (text[pos] !== '>') {
      return { elements, error: malformed(text, pos, `unexpected character inside <${tag}>`) };
    }
    pos += 1;

    let nestedTable = false;
    if (tag === 'table') {
      nestedTable = tableDepth > 0;
      tableDepth += 1;
    }
    elements.push({ tag, attrs, offset, nestedTable });
  }

  return { elements, error: null };
}

/** The attributes one element may carry. */
export function allowedAttributesFor(tag) {
  return [...GLOBAL_ATTRIBUTES, ...(ELEMENT_ATTRIBUTES[tag] ?? [])];
}

/**
 * Why a URL attribute value is refused, or null.
 *
 * Returns `{ kind, reason }` where `kind` is `'dangerous'` or `'not-https'`.
 *
 * AN ALLOWLIST OF PREFIXES, NOT A LIST OF BAD SCHEMES. The blocklist this replaced knew about
 * `javascript:`, `data:` and `vbscript:`, and every one of those has spellings a browser decodes
 * and a string comparison does not: `jav&#x61;script:`, `javascript&colon;`, `java&Tab;script:`, a
 * literal tab inside the scheme. Rather than decode entities the way a browser does and hope to
 * agree with it, the value is refused if it contains ANY character reference other than the exact
 * `&amp;` a query string needs, any whitespace or control character, or any backslash (which
 * browsers read as `/`, so `/\evil.example` is protocol-relative). What survives that is compared
 * against the only prefixes a body has a use for. That also retires `//host`, `tel:`, and a relative
 * `products/x` that resolves against the article's own URL, without a rule for each.
 *
 * `http://` is still refused, but under its own kind: the link rule `link/external-not-https` has
 * the more useful message for what is almost always a pasted link, not an attack.
 *
 * @param {string} tag   the element, `a` or `img`
 * @param {string} value the raw attribute value, entities undecoded
 */
export function urlRefusal(tag, value) {
  const raw = String(value ?? '');
  const amp = raw.replace(/&amp;/g, '');
  if (amp.includes('&')) {
    return { kind: 'dangerous', reason: 'contains a character reference other than `&amp;`, which a browser decodes and this check does not' };
  }
  // U+0000 to U+0020 is every C0 control character plus space, which covers all five kinds of
  // ASCII whitespace; U+007F is DEL. Written as escapes, so no raw control byte sits in this file.
  if (/[\u0000-\u0020\u007f\\]/.test(raw)) {
    return { kind: 'dangerous', reason: 'contains whitespace, a control character or a backslash' };
  }
  if (raw.startsWith('https://')) return null;
  if (tag === 'a' && (raw.startsWith('mailto:') || raw.startsWith('#'))) return null;
  if (/^\/[^/]/.test(raw)) return null;
  if (raw.startsWith('http://')) return { kind: 'not-https', reason: 'is http, not https' };
  const allowed = tag === 'a' ? '`https://`, `mailto:`, `#` or a single `/`' : '`https://` or a single `/`';
  return { kind: 'dangerous', reason: `does not start with ${allowed}` };
}

/** The URL a safe attribute value names: the one reference `urlRefusal` admits, decoded. */
export function decodeUrl(value) {
  return String(value ?? '').replace(/&amp;/g, '&');
}
