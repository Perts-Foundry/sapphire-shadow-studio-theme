// The browser probes under scripts/notifications/browser/ are plain JS files the skill passes
// verbatim as initScripts. Each embeds its own copy of the FNV-1a function (and editor-probe.js
// the stamp regex), because the browser cannot import from the repo. This suite loads each probe
// under node:vm with a stub document and proves the embedded copies agree with dump.mjs and
// brand.mjs on the inputs that matter: non-ASCII text and CRLF line endings. (There is no preview
// probe: the Preview dialog's iframe is an about:srcdoc frame where no init script runs, so the
// render is read from the EmailTemplateGeneratePreview network response instead.)

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { fnv1a, parseDump, LEN_PREFIX, HASH_PREFIX, CHUNK_PREFIX } from '../dump.mjs';
import { STAMP_RE_SOURCE, commentLine } from '../brand.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'browser');
const PROBES = ['editor-probe.js', 'editor-dump.js', 'mobile-check.js'];
const src = (name) => readFileSync(path.join(dir, name), 'utf8');

// Runs a probe with a stub DOM: `textarea` is the editor text, `frame` makes the window a child
// frame, `previewHtml` is what documentElement.outerHTML returns. Timers fire synchronously as
// many times as asked; console lines are collected.
function runProbe(name, { textarea = null, frame = false, previewHtml = '', ticks = 3, noButtons = false } = {}) {
  const logs = [];
  const timers = [];
  const buttons = [{ textContent: 'Revert changes button', disabled: true, getAttribute: () => null }, { textContent: 'Save', disabled: false, getAttribute: () => null }];
  const inputs = [{ getAttribute: (a) => (a === 'aria-label' ? 'Email subject' : null), id: '', value: 'Order {{name}} confirmed' }];
  const el = (tag) => ({ tagName: tag.toUpperCase(), className: '', getBoundingClientRect: () => ({ width: 0, left: 0 }), querySelectorAll: () => [] });
  const document = {
    readyState: 'complete',
    body: { innerHTML: previewHtml },
    head: { appendChild() {}, removeChild() {} },
    documentElement: { outerHTML: previewHtml, scrollWidth: 400 },
    createElement: () => ({}),
    querySelector: (sel) => {
      if (sel.includes('.cm-content') || sel.includes('.CodeMirror')) return sel.includes('textarea') && textarea !== null ? { value: textarea } : null;
      if (sel === 'table') return previewHtml.includes('<table') ? {} : null;
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel === 'textarea') return textarea === null ? [] : [{ value: textarea }];
      if (sel === 'button') return noButtons ? [] : buttons;
      if (sel.startsWith('input')) return inputs;
      if (sel === 'table.container') return [el('table')];
      return [];
    },
  };
  const window = { innerWidth: 411, addEventListener() {} };
  window.top = frame ? {} : window;
  const context = {
    document,
    window,
    console: { log: (line) => logs.push(line) },
    setInterval: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearInterval: () => {},
    setTimeout: (fn) => fn(),
    Math,
    RegExp,
    Array,
    String,
  };
  vm.runInNewContext(src(name), context, { filename: name });
  for (let t = 0; t < ticks; t++) for (const fn of timers) fn();
  return logs;
}

const SAMPLES = ['', 'a', 'café ’   \u{1F9F5} ©', 'line one\r\nline two\rthree\n', '{{ shop.name }}\n'.repeat(700)];

test('every probe file exists, is plain script (no import/export), and carries no em dash or CR', () => {
  assert.deepEqual(readdirSync(dir).sort(), [...PROBES].sort());
  for (const name of PROBES) {
    const text = src(name);
    assert.ok(!/^\s*(import|export)\b/m.test(text), `${name} uses module syntax`);
    assert.ok(!text.includes('\u2014'), `${name} contains an em dash`);
    assert.ok(!text.includes('\r'), `${name} contains a carriage return`);
    assert.ok(text.startsWith('//'), `${name} should open with its own description`);
  }
});

test('the two hashing probes embed the FNV-1a function and the dump prefixes; editor-probe embeds STAMP_RE_SOURCE', () => {
  const fnvBody = 'h = Math.imul(h, 0x01000193) >>> 0;';
  for (const name of ['editor-probe.js', 'editor-dump.js']) {
    assert.ok(src(name).includes(fnvBody), `${name} lacks the FNV-1a step`);
    assert.ok(src(name).includes('0x811c9dc5'), `${name} lacks the FNV offset basis`);
  }
  for (const name of ['editor-dump.js']) {
    for (const [label, value] of [['LEN_PREFIX', LEN_PREFIX], ['HASH_PREFIX', HASH_PREFIX], ['CHUNK_PREFIX', CHUNK_PREFIX]]) {
      assert.ok(src(name).includes(`var ${label} = '${value}';`), `${name} does not define ${label} = ${value}`);
    }
  }
  assert.ok(src('editor-probe.js').includes(`var STAMP_RE_SOURCE = '${STAMP_RE_SOURCE}';`), 'editor-probe.js must embed brand.mjs STAMP_RE_SOURCE verbatim');
  assert.ok(!src('mobile-check.js').includes('fnv1a'), 'mobile-check hashes nothing');
});

test('editor-probe.js: SSSPOLL length and FNV agree with dump.mjs on non-ASCII and CRLF input, once per change', () => {
  for (const sample of SAMPLES) {
    const lf = sample.replace(/\r\n?/g, '\n');
    const logs = runProbe('editor-probe.js', { textarea: sample, ticks: 4 });
    const polls = logs.filter((l) => l.startsWith('SSSPOLL '));
    assert.equal(polls.length, 1, `${JSON.stringify(sample.slice(0, 12))}: one SSSPOLL per change, got ${polls.length}`);
    assert.equal(polls[0], `SSSPOLL ${lf.length} ${fnv1a(lf)} textarea`);
    assert.ok(logs.includes('SSSREVERT true'));
  }
  // The revert state is part of the change key: a control that appears later is logged when it does.
  assert.ok(runProbe('editor-probe.js', { textarea: 'x', noButtons: true }).includes('SSSREVERT unknown'));
  assert.deepEqual(runProbe('editor-probe.js', { textarea: null }), [], 'no editor, no output');
});

test('editor-probe.js: the stamp comes from the first line only, parsed with STAMP_RE_SOURCE', () => {
  const stamped = commentLine('order_confirmation', 4) + '<p>sss-notification other_id v9</p>\n';
  assert.ok(runProbe('editor-probe.js', { textarea: stamped }).includes('SSSSTAMP order_confirmation 4'));
  const later = '<p>x</p>\n' + commentLine('order_confirmation', 4);
  assert.ok(runProbe('editor-probe.js', { textarea: later }).includes('SSSSTAMP none'), 'a stamp on a later line does not count');
  assert.ok(runProbe('editor-probe.js', { textarea: '{%- comment -%}sss-notification Bad v1{%- endcomment -%}\n' }).includes('SSSSTAMP none'));
  assert.ok(runProbe('editor-probe.js', { textarea: 'sss-notification x v01\n' }).includes('SSSSTAMP none'));
});

test('editor-dump.js: the console lines reassemble through parseDump to the LF-normalised text, with subject and revert', () => {
  for (const sample of SAMPLES.filter((s) => s.length > 0)) {
    const lf = sample.replace(/\r\n?/g, '\n');
    const logs = runProbe('editor-dump.js', { textarea: sample, ticks: 3 });
    assert.equal(logs.filter((l) => l.startsWith('SSSLEN ')).length, 1, 'dumps once');
    const dumpText = logs.map((l, i) => `msgid=${i + 1} [log] ${l} (1 args)\n`).join('');
    const r = parseDump(dumpText);
    assert.equal(r.text, lf);
    assert.equal(r.hash, fnv1a(lf));
    assert.equal(r.subject, 'Order {{name}} confirmed');
    assert.equal(r.revertDisabled, true);
    if (lf.length > 8000) assert.ok(logs.some((l) => l.startsWith('SSSCHUNK1 ')), 'long text is chunked');
  }
  assert.deepEqual(runProbe('editor-dump.js', { textarea: '' }), [], 'an empty editor is not dumped');
});

test('mobile-check.js: logs SSSMOBILE and SSSSQUEEZE lines', () => {
  const logs = runProbe('mobile-check.js');
  assert.equal(logs.length, 2);
  assert.match(logs[0], /^SSSMOBILE (ok|fail) widths=/);
  assert.match(logs[1], /^SSSSQUEEZE (ok|warn)/);
});
