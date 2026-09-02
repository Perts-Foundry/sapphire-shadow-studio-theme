// scripts/notifications/html-walk.mjs is the parser behind verify-render.mjs. Regex over inlined
// HTML produced three false positives in the first render checker; this suite pins the shapes
// that broke it: nesting, void and self-closing tags, a quoted `>` inside an attribute, raw
// <style> text, comments, and every colour form the inliner emits.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHtml,
  classesOf,
  hasClass,
  ancestors,
  closest,
  descendants,
  innerText,
  select,
  parseDeclarations,
  styleOf,
  normalizeColor,
  backgroundOf,
  colorOf,
  parseStylesheet,
} from '../html-walk.mjs';

test('nesting: parents, ancestors, descendants and text follow the markup', () => {
  const { root, elements } = parseHtml('<table class="body"><tr><td><p class="x y">Hi <b>there</b></p></td></tr></table>');
  assert.deepEqual(elements.map((e) => e.tag), ['table', 'tr', 'td', 'p', 'b']);
  const p = elements[3];
  assert.deepEqual(classesOf(p), ['x', 'y']);
  assert.ok(hasClass(p, 'y'));
  assert.deepEqual(ancestors(p).map((e) => e.tag), ['td', 'tr', 'table']);
  assert.equal(closest(p, (e) => hasClass(e, 'body')).tag, 'table');
  assert.equal(closest(p, (e) => e.tag === 'nope'), null);
  assert.deepEqual(descendants(elements[0]).map((e) => e.tag), ['tr', 'td', 'p', 'b']);
  assert.equal(innerText(p), 'Hi there');
  assert.equal(p.text, 'Hi ');
  assert.equal(select(root, (e) => e.tag === 'b').length, 1);
});

test('void tags and self-closing tags do not swallow their siblings', () => {
  const { elements } = parseHtml('<td><img src="a.png"><br/><meta charset="x"><span>after</span></td>');
  const span = elements.find((e) => e.tag === 'span');
  assert.deepEqual(ancestors(span).map((e) => e.tag), ['td']);
  assert.equal(elements.find((e) => e.tag === 'img').children.length, 0);
});

test('a quoted > inside an attribute does not end the tag', () => {
  const { elements } = parseHtml('<a href="x?a=1&gt=2" title=">" data-x=\'a>b\'>link</a><p>next</p>');
  assert.equal(elements[0].attrs.title, '>');
  assert.equal(elements[0].attrs['data-x'], 'a>b');
  assert.equal(innerText(elements[0]), 'link');
  assert.equal(elements[1].tag, 'p');
});

test('raw text inside <style> and <script> is kept verbatim, tags and all', () => {
  const css = '.a { color: #fff; }\n@media (max-width: 600px) {\n  .b > .c { x: y; }\n}';
  const { elements } = parseHtml(`<head><style>${css}</style><script>if (a < b) { x = "<p>"; }</script></head>`);
  assert.equal(elements[1].raw, css);
  assert.equal(elements[2].raw, 'if (a < b) { x = "<p>"; }');
  assert.deepEqual(elements.map((e) => e.tag), ['head', 'style', 'script']);
});

test('comments are collected and not treated as text', () => {
  const { elements, comments } = parseHtml('<p>a<!-- sss-notification x v1 -->b</p><!-- two -->');
  assert.deepEqual(comments.map((c) => c.text.trim()), ['sss-notification x v1', 'two']);
  assert.equal(innerText(elements[0]), 'ab');
});

test('a stray close tag is ignored and a mismatched close pops to the matching element', () => {
  const { elements } = parseHtml('<div><span>x</div><p>y</p></b>');
  const p = elements.find((e) => e.tag === 'p');
  assert.deepEqual(ancestors(p), [], 'the </div> closed both the span and the div');
});

test('uppercase tags and attributes are lowercased; unquoted attribute values parse', () => {
  const { elements } = parseHtml('<TABLE BGCOLOR=#071E3F Class=row><TR></TR></TABLE>');
  assert.equal(elements[0].tag, 'table');
  assert.equal(elements[0].attrs.bgcolor, '#071E3F');
  assert.equal(elements[0].attrs.class, 'row');
  const selfClosed = parseHtml('<td><img src=a.png/><br/></td>');
  assert.equal(selfClosed.elements[1].attrs.src, 'a.png', 'the self-closing slash is not part of an unquoted value');
  assert.deepEqual(selfClosed.elements.map((e) => e.tag), ['td', 'img', 'br']);
});

test('doctype, processing instructions, a bare < in text and an unterminated tag are survivable', () => {
  const { elements } = parseHtml('<!DOCTYPE html><?xml version="1.0"?><p>a < b</p><td');
  assert.deepEqual(elements.map((e) => e.tag), ['p']);
  assert.equal(innerText(elements[0]), 'a < b');
});

test('normalizeColor accepts the inliner forms and refuses non-colours', () => {
  assert.equal(normalizeColor('#FFF'), '#ffffff');
  assert.equal(normalizeColor('#071E3F'), '#071e3f');
  assert.equal(normalizeColor(' rgb(7, 30, 63) '), '#071e3f');
  assert.equal(normalizeColor('rgba(255,255,255,0.5)'), '#ffffff');
  assert.equal(normalizeColor('white'), '#ffffff');
  assert.equal(normalizeColor('transparent'), null);
  assert.equal(normalizeColor('url(x.png)'), null);
  assert.equal(normalizeColor(undefined), null);
  assert.equal(normalizeColor('#12345'), null);
});

test('parseDeclarations and styleOf read props, values and !important', () => {
  const d = parseDeclarations('Color: #333 ; background-color: rgb(1,2,3) !important;; width:100%');
  assert.deepEqual(d, {
    color: { value: '#333', important: false },
    'background-color': { value: 'rgb(1,2,3)', important: true },
    width: { value: '100%', important: false },
  });
  const { elements } = parseHtml('<td style="padding: 0; color: #FFF">x</td>');
  assert.equal(styleOf(elements[0]).color.value, '#FFF');
});

test('backgroundOf prefers style background-color, then background shorthand, then bgcolor', () => {
  const html = [
    '<td style="background-color: #071e3f" bgcolor="#ffffff"></td>',
    '<td style="background: #0071C2 url(x.png) no-repeat" bgcolor="#ffffff"></td>',
    '<td style="padding: 0" bgcolor="#E1EDF5"></td>',
    '<td style="background: url(x.png)"></td>',
    '<td></td>',
  ].join('');
  const { elements } = parseHtml(html);
  assert.deepEqual(elements.map(backgroundOf), ['#071e3f', '#0071c2', '#e1edf5', null, null]);
});

test('colorOf reads the style colour, then the color attribute', () => {
  const { elements } = parseHtml('<p style="color: rgb(51, 51, 51)">a</p><font color="#c9d8ea">b</font><p>c</p>');
  assert.deepEqual(elements.map(colorOf), ['#333333', '#c9d8ea', null]);
});

test('parseStylesheet splits selector lists, strips comments, and nests @media rules', () => {
  const css = [
    '/* comment { } */',
    '.a, .b { color: #fff; }',
    '.c .d { background-color: #000 !important; }',
    '@media (max-width: 600px) {',
    '  .container { table-layout: fixed !important; }',
    '  .header { margin-top: 0 !important; margin-bottom: 0 !important; }',
    '}',
    '.e { x: y }',
  ].join('\n');
  const { rules, media } = parseStylesheet(css);
  assert.deepEqual(rules.map((r) => r.selector), ['.a', '.b', '.c .d', '.e']);
  assert.equal(rules[0].declarations.color.value, '#fff');
  assert.equal(rules[2].declarations['background-color'].important, true);
  assert.equal(media.length, 1);
  assert.equal(media[0].query, '(max-width: 600px)');
  assert.deepEqual(media[0].rules.map((r) => r.selector), ['.container', '.header']);
  assert.deepEqual(media[0].rules[1].declarations['margin-bottom'], { value: '0', important: true });
  // The inliner's reflowed shape: newlines inside braces and between selector and brace.
  const reflowed = '.x {\ncolor: #fff;\n}\n@media (max-width: 600px) {\n  .container {\n    width: 94% !important;\n  }\n}\n';
  const r = parseStylesheet(reflowed);
  assert.equal(r.rules[0].declarations.color.value, '#fff');
  assert.equal(r.media[0].rules[0].declarations.width.value, '94%');
});
