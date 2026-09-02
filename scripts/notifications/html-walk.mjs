// A minimal tag-stack walker over rendered notification HTML, for verify-render.mjs. No
// dependency on purpose (the repo's scripts have none). It is not a browser parser: it trusts the
// nesting it is given, which is what a rendered preview dump is (the browser has already applied
// its recovery and serialised the DOM), and it knows just enough to be right about the things the
// render checks look at: nesting, void and self-closing tags, quoted `>` inside attributes, raw
// text inside <style> and <script>, comments, and colours in the forms the inliner emits
// (`#ABC`, `#aabbcc`, `rgb(1, 2, 3)`, the `bgcolor` attribute as well as `style`).

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style']);

function parseAttrs(text) {
  const attrs = {};
  const re = /([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].toLowerCase();
    if (name === '/') continue;
    attrs[name] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
  }
  return attrs;
}

// Finds the end of an open tag, honouring quotes so a `>` inside an attribute value does not end it.
function tagEnd(html, from) {
  let quote = null;
  for (let i = from; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return -1;
}

export function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, parent: null, children: [], text: '', raw: '' };
  const elements = [];
  const comments = [];
  const stack = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];
  const addText = (t) => {
    if (t.length === 0) return;
    top().text += t;
    top().children.push({ tag: '#text', text: t, parent: top(), children: [], attrs: {} });
  };
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      addText(html.slice(i));
      break;
    }
    addText(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      const text = end === -1 ? html.slice(lt + 4) : html.slice(lt + 4, end);
      const node = { tag: '#comment', text, parent: top(), children: [], attrs: {} };
      top().children.push(node);
      comments.push(node);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    if (html.startsWith('</', lt)) {
      const end = html.indexOf('>', lt);
      const name = html.slice(lt + 2, end === -1 ? html.length : end).trim().toLowerCase();
      // Pop to the nearest matching open element; a stray close tag with no match is ignored.
      const at = stack.map((e) => e.tag).lastIndexOf(name);
      if (at > 0) stack.length = at;
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    const end = tagEnd(html, lt + 1);
    if (end === -1) {
      addText(html.slice(lt));
      break;
    }
    const inner = html.slice(lt + 1, end);
    const nameMatch = /^([a-zA-Z][^\s/>]*)/.exec(inner);
    if (!nameMatch) {
      addText(html.slice(lt, end + 1));
      i = end + 1;
      continue;
    }
    const tag = nameMatch[1].toLowerCase();
    const selfClosing = /\/\s*$/.test(inner);
    const el = { tag, attrs: parseAttrs(inner.slice(nameMatch[1].length)), parent: top(), children: [], text: '', raw: '' };
    top().children.push(el);
    elements.push(el);
    i = end + 1;
    if (RAW.has(tag)) {
      const closeRe = new RegExp(`</${tag}\\s*>`, 'ig');
      closeRe.lastIndex = i;
      const m = closeRe.exec(html);
      el.raw = html.slice(i, m ? m.index : html.length);
      el.text = el.raw;
      i = m ? m.index + m[0].length : html.length;
      continue;
    }
    if (VOID.has(tag) || selfClosing) continue;
    stack.push(el);
  }
  return { root, elements, comments };
}

export function classesOf(el) {
  return (el.attrs.class || '').split(/\s+/).filter(Boolean);
}

export function hasClass(el, cls) {
  return classesOf(el).includes(cls);
}

export function ancestors(el) {
  const out = [];
  for (let p = el.parent; p && p.tag !== '#root'; p = p.parent) out.push(p);
  return out;
}

export function closest(el, pred) {
  return ancestors(el).find(pred) || null;
}

export function descendants(el) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children) {
      if (c.tag !== '#text' && c.tag !== '#comment') {
        out.push(c);
        walk(c);
      }
    }
  };
  walk(el);
  return out;
}

export function innerText(el) {
  let s = '';
  const walk = (n) => {
    for (const c of n.children) {
      if (c.tag === '#text') s += c.text;
      else if (c.tag !== '#comment') walk(c);
    }
  };
  walk(el);
  return s;
}

export function select(root, pred) {
  return descendants(root).filter(pred);
}

// Style declarations as { prop: { value, important } }, props lowercased, values trimmed.
export function parseDeclarations(text) {
  const out = {};
  for (const decl of String(text || '').split(';')) {
    const colon = decl.indexOf(':');
    if (colon === -1) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    let value = decl.slice(colon + 1).trim();
    if (!prop) continue;
    const important = /!\s*important\s*$/i.test(value);
    value = value.replace(/!\s*important\s*$/i, '').trim();
    out[prop] = { value, important };
  }
  return out;
}

export function styleOf(el) {
  return parseDeclarations(el.attrs.style);
}

const NAMED = { white: '#ffffff', black: '#000000', transparent: null };

// `#abc`, `#AABBCC`, `rgb(1, 2, 3)`, `rgba(1,2,3,x)` and a few names, to lowercase six-digit hex;
// anything else (including a value that is not a colour) is null.
export function normalizeColor(value) {
  if (value === undefined || value === null) return null;
  const v = String(value).trim().toLowerCase();
  if (v in NAMED) return NAMED[v];
  let m;
  if ((m = /^#([0-9a-f]{3})$/.exec(v))) return '#' + m[1].split('').map((c) => c + c).join('');
  if ((m = /^#([0-9a-f]{6})$/.exec(v))) return '#' + m[1];
  if ((m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,[^)]*)?\)$/.exec(v))) {
    return '#' + [m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('');
  }
  return null;
}

// The first colour token inside a `background` shorthand value.
function colorInShorthand(value) {
  for (const token of String(value).split(/\s+/)) {
    const c = normalizeColor(token);
    if (c) return c;
  }
  return null;
}

// The element's own background colour: style background-color, then style background, then the
// bgcolor attribute. Null when none is set on the element itself.
export function backgroundOf(el) {
  const s = styleOf(el);
  if (s['background-color']) return normalizeColor(s['background-color'].value);
  if (s.background) {
    const c = colorInShorthand(s.background.value);
    if (c) return c;
  }
  if (el.attrs.bgcolor !== undefined) return normalizeColor(el.attrs.bgcolor);
  return null;
}

export function colorOf(el) {
  const s = styleOf(el);
  if (s.color) return normalizeColor(s.color.value);
  if (el.attrs.color !== undefined) return normalizeColor(el.attrs.color);
  return null;
}

// A tiny stylesheet reader for the brand css and for the head <style> of a rendered dump: top-level
// rules as [{ selector, declarations }], and @media blocks as [{ query, rules }]. Comments are
// stripped first. Good enough for the flat css this repo writes and the inliner's output.
export function parseStylesheet(css) {
  const text = String(css).replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const media = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open === -1) break;
    const selector = text.slice(i, open).trim();
    if (selector.startsWith('@media')) {
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      const inner = text.slice(open + 1, j - 1);
      media.push({ query: selector.replace(/^@media\s*/, '').replace(/\s+/g, ' ').trim(), rules: parseStylesheet(inner).rules });
      i = j;
      continue;
    }
    const close = text.indexOf('}', open);
    if (close === -1) break;
    for (const sel of selector.split(',')) {
      const s = sel.replace(/\s+/g, ' ').trim();
      if (s) rules.push({ selector: s, declarations: parseDeclarations(text.slice(open + 1, close)) });
    }
    i = close + 1;
  }
  return { rules, media };
}
