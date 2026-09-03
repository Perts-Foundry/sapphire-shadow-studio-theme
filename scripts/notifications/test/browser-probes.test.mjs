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
import { fnv1a, parseDump, parseStored, parseStoredStamp, parseSettled, LEN_PREFIX, HASH_PREFIX, CHUNK_PREFIX } from '../dump.mjs';
import { STAMP_RE_SOURCE, commentLine } from '../brand.mjs';
import { FIXTURE_GID, GID_CLASSES } from './gid-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'browser');
const PROBES = ['editor-probe.js', 'editor-dump.js', 'mobile-check.js'];
const src = (name) => readFileSync(path.join(dir, name), 'utf8');

// Runs a probe with a stub DOM. `textarea` is the editor text (a string, or an array of strings
// for several textareas; the probe must read the longest); `cm6` / `cm5` make the CodeMirror
// widgets exist with that text; `containers` and `scrollWidth` drive mobile-check. Timers fire
// synchronously `ticks` times, and `between(tick)` runs before each tick so a test can mutate the
// stub mid-run; console lines are collected.
function makeProbe(name, { textarea = null, cm6 = null, cm5 = null, noButtons = false, containers, scrollWidth = 400, fetchImpl = null, xhrImpl = null } = {}) {
  const logs = [];
  const timers = [];
  const buttons = [{ textContent: 'Revert changes button', disabled: true, getAttribute: () => null }, { textContent: 'Save', disabled: false, getAttribute: () => null }];
  const inputs = [{ getAttribute: (a) => (a === 'aria-label' ? 'Email subject' : null), id: '', value: 'Order {{name}} confirmed' }];
  const areas = textarea === null ? [] : (Array.isArray(textarea) ? textarea : [textarea]).map((value) => ({ value }));
  const el = (tag, { width = 0, left = 0, className = '', children = [] } = {}) => ({
    tagName: tag.toUpperCase(),
    className,
    getBoundingClientRect: () => ({ width, left }),
    querySelectorAll: () => children,
  });
  const defaultContainers = [el('table', { width: 380, left: 15 }), el('table', { width: 380, left: 15 })];
  const cm6El = cm6 === null ? null : { cmView: { view: { state: { doc: { toString: () => cm6 } } } } };
  const cm5El = cm5 === null ? null : { CodeMirror: { getValue: () => cm5 } };
  const stub = { buttons, areas, containers: containers === undefined ? defaultContainers : containers, scrollWidth };
  const document = {
    readyState: 'complete',
    head: { appendChild() {}, removeChild() {} },
    documentElement: { get scrollWidth() { return stub.scrollWidth; } },
    createElement: () => ({}),
    querySelector: (sel) => {
      if (sel === '.cm-content') return cm6El;
      if (sel === '.CodeMirror') return cm5El;
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel === 'textarea') return stub.areas;
      if (sel === 'button') return noButtons ? [] : stub.buttons;
      if (sel.startsWith('input')) return inputs;
      if (sel === 'table.container') return stub.containers;
      return [];
    },
  };
  const window = { innerWidth: 411, addEventListener() {} };
  if (fetchImpl) window.fetch = fetchImpl;
  if (xhrImpl) window.XMLHttpRequest = xhrImpl;
  window.top = window;
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
  return { logs, window, stub, tick: () => { for (const fn of timers) fn(); } };
}

// Ticks the probe `ticks` times and returns the console lines, the shape most tests want.
function runProbe(name, opts = {}) {
  const { ticks = 3, between = null } = opts;
  const probe = makeProbe(name, opts);
  for (let t = 0; t < ticks; t++) {
    if (between) between(t, probe.stub);
    probe.tick();
  }
  return probe.logs;
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

test('mobile-check.js: ok when every container shares a width and left edge and nothing scrolls sideways; fail otherwise', () => {
  const ok = runProbe('mobile-check.js');
  assert.deepEqual(ok, ['SSSMOBILE ok widths=380,380 lefts=15,15 scrollWidth=400 innerWidth=411', 'SSSSQUEEZE ok']);
  const el = (width, left) => ({ tagName: 'TABLE', className: 'container', getBoundingClientRect: () => ({ width, left }), querySelectorAll: () => [] });
  assert.match(runProbe('mobile-check.js', { containers: [el(300, 15), el(200, 15)] })[0], /^SSSMOBILE fail widths=300,200/);
  assert.match(runProbe('mobile-check.js', { containers: [el(300, 15), el(300, 60)] })[0], /^SSSMOBILE fail widths=300,300 lefts=15,60/);
  assert.match(runProbe('mobile-check.js', { scrollWidth: 500 })[0], /^SSSMOBILE fail .*scrollWidth=500 innerWidth=411$/);
  assert.deepEqual(runProbe('mobile-check.js', { containers: [] }), ['SSSMOBILE fail no table.container found']);
  const wideRow = { tagName: 'TD', className: 'price', getBoundingClientRect: () => ({ width: 350, left: 0 }), querySelectorAll: () => [] };
  const withWide = { tagName: 'TABLE', className: 'container', getBoundingClientRect: () => ({ width: 380, left: 15 }), querySelectorAll: () => [wideRow] };
  const squeezed = runProbe('mobile-check.js', { containers: [withWide] });
  assert.equal(squeezed[1], 'SSSSQUEEZE warn <td class="price"> 350px');
});

test('editor-probe.js reads CodeMirror 6 first, then CodeMirror 5, then the longest textarea', () => {
  const text = 'cm text ©\n';
  const lf = text;
  assert.ok(runProbe('editor-probe.js', { cm6: text, textarea: 'other' }).includes(`SSSPOLL ${lf.length} ${fnv1a(lf)} cm6`), 'cm6 wins over a textarea');
  assert.ok(runProbe('editor-probe.js', { cm5: text, textarea: 'other' }).includes(`SSSPOLL ${lf.length} ${fnv1a(lf)} cm5`), 'cm5 wins over a textarea');
  assert.ok(runProbe('editor-probe.js', { cm6: text, cm5: 'five' }).includes(`SSSPOLL ${lf.length} ${fnv1a(lf)} cm6`), 'cm6 wins over cm5');
  const longest = 'the longer textarea';
  assert.ok(runProbe('editor-probe.js', { textarea: ['short', longest, 'mid one'] }).includes(`SSSPOLL ${longest.length} ${fnv1a(longest)} textarea`), 'the longest textarea is read');
  assert.ok(runProbe('editor-dump.js', { cm6: text }).includes(`SSSHASH ${fnv1a(lf)}`), 'editor-dump reads cm6 too');
  assert.ok(runProbe('editor-dump.js', { cm5: text }).includes(`SSSHASH ${fnv1a(lf)}`), 'editor-dump reads cm5 too');
});

test('editor-probe.js logs again when the document or the revert state changes, and not otherwise', () => {
  const logs = runProbe('editor-probe.js', {
    textarea: 'first',
    ticks: 6,
    between: (t, stub) => {
      if (t === 2) stub.areas[0].value = 'second';
      if (t === 4) stub.buttons[0].disabled = false;
    },
  });
  const polls = logs.filter((l) => l.startsWith('SSSPOLL '));
  assert.deepEqual(polls, [
    `SSSPOLL 5 ${fnv1a('first')} textarea`,
    `SSSPOLL 6 ${fnv1a('second')} textarea`,
    `SSSPOLL 6 ${fnv1a('second')} textarea`,
  ]);
  assert.deepEqual(logs.filter((l) => l.startsWith('SSSREVERT ')), ['SSSREVERT true', 'SSSREVERT true', 'SSSREVERT false']);
});

// The stored document. The editor renders the stock body first and swaps the saved override in a
// moment later, so SSSPOLL under-reports on a cold navigation; SSSSTORED comes from the response
// that carries what Admin actually holds, so it does not have that race. It carries the gid too,
// because the request URL identifies no template: its variables are opaque.
const STORED_URL = 'https://admin.shopify.com/services/internal/graphql/EmailTemplate/shopify/sapphire-shadow-studio?operationName=EmailTemplate&variables=%7B%7D';
const PREVIEW_URL = 'https://admin.shopify.com/services/internal/graphql/EmailTemplateGeneratePreview/shopify/sapphire-shadow-studio?operationName=EmailTemplateGeneratePreview';
// From the shared fixture module, not a literal typed here: this is the ONLY gid in this suite,
// so the probe's extraction and parseStored's capture were proven against an invented numeric id
// and nothing else. That is what let a numeric-only GID_RE ship. The extraction itself is a JSON
// path and imposes no shape, and `parseStored gid classes` below runs the real ones through it.
const GID = FIXTURE_GID;
const storedBody = (bodyHtml, id = GID) => JSON.stringify({ data: { emailTemplate: id === null ? { bodyHtml } : { id, bodyHtml } } });
const flush = () => new Promise((r) => setImmediate(r));

function fetchStub(bodyByUrl) {
  const calls = [];
  return {
    calls,
    impl: (input) => {
      const url = typeof input === 'string' ? input : input.url;
      calls.push(url);
      const body = bodyByUrl[url];
      return Promise.resolve({ url, clone: () => ({ text: () => Promise.resolve(body) }) });
    },
  };
}

test('editor-probe.js: SSSSTORED carries the stored document and its gid, once, and parseStored reads it', async () => {
  for (const sample of SAMPLES.filter((s) => s.length > 0)) {
    const lfText = sample.replace(/\r\n?/g, '\n');
    const stub = fetchStub({ [STORED_URL]: storedBody(sample) });
    const probe = makeProbe('editor-probe.js', { textarea: 'whatever the screen shows', fetchImpl: stub.impl });
    const res = await probe.window.fetch(STORED_URL);
    await flush();
    assert.deepEqual(
      probe.logs.filter((l) => l.startsWith('SSSSTORED ')),
      [`SSSSTORED ${lfText.length} ${fnv1a(lfText)} ${GID}`],
      `${JSON.stringify(sample.slice(0, 12))}: one SSSSTORED line`,
    );
    assert.deepEqual(parseStored(probe.logs.join('\n')), { length: lfText.length, hash: fnv1a(lfText), gid: GID });
    assert.equal(res.url, STORED_URL, 'the patched fetch still returns the response to the caller');
    assert.deepEqual(stub.calls, [STORED_URL], 'the original fetch is called exactly once');
    // A second matching response does not log again: the first is the page load's own.
    await probe.window.fetch(STORED_URL);
    await flush();
    assert.equal(probe.logs.filter((l) => l.startsWith('SSSSTORED ')).length, 1);
  }
  // A response without the gid still reports, with a dash, and parseStored says so.
  const noGid = makeProbe('editor-probe.js', { textarea: 'x', fetchImpl: fetchStub({ [STORED_URL]: storedBody('body\n', null) }).impl });
  await noGid.window.fetch(STORED_URL);
  await flush();
  assert.deepEqual(noGid.logs.filter((l) => l.startsWith('SSSSTORED ')), [`SSSSTORED 5 ${fnv1a('body\n')} -`]);
  assert.equal(parseStored(noGid.logs.join('\n')).gid, null);
});

test('editor-probe.js and parseStored carry every gid class, not just the one fixture', async () => {
  // The extraction is `parsed.data.emailTemplate.id`, a JSON path with no pattern of its own, and
  // the SSSSTORED line is a space-separated field that parseStored splits. Neither imposes a shape,
  // and this is what proves it: real manifest handles, a numeric segment and the legal edge shapes
  // all round-trip. Before the shared fixtures, one invented numeric gid was the whole corpus here.
  const text = 'a body\n';
  for (const { name, gids } of GID_CLASSES) {
    for (const gid of gids) {
      const probe = makeProbe('editor-probe.js', { textarea: 'x', fetchImpl: fetchStub({ [STORED_URL]: storedBody(text, gid) }).impl });
      await probe.window.fetch(STORED_URL);
      await flush();
      assert.deepEqual(probe.logs.filter((l) => l.startsWith('SSSSTORED ')), [`SSSSTORED ${text.length} ${fnv1a(text)} ${gid}`], `${name}: ${gid}`);
      assert.deepEqual(parseStored(probe.logs.join('\n')), { length: text.length, hash: fnv1a(text), gid }, `${name}: ${gid}`);
    }
  }
});

test('editor-probe.js: SSSSTOREDSTAMP parses the STORED document, so the classification never turns on the racy widget read', async () => {
  const stamped = commentLine('order_confirmation', 4) + '<p>sss-notification other_id v9</p>\n';
  const probe = makeProbe('editor-probe.js', { textarea: 'the stock body the widget is still painting\n', fetchImpl: fetchStub({ [STORED_URL]: storedBody(stamped) }).impl });
  await probe.window.fetch(STORED_URL);
  await flush();
  probe.tick();
  assert.ok(probe.logs.includes('SSSSTOREDSTAMP order_confirmation 4'));
  assert.deepEqual(parseStoredStamp(probe.logs.join('\n')), { id: 'order_confirmation', version: 4 });
  // The widget's own stamp, read at the same moment, is the stock body's: none. That difference is
  // the whole reason the stored stamp exists.
  assert.ok(probe.logs.includes('SSSSTAMP none'));

  const unstamped = makeProbe('editor-probe.js', { textarea: 'x', fetchImpl: fetchStub({ [STORED_URL]: storedBody('<p>no stamp here</p>\n') }).impl });
  await unstamped.window.fetch(STORED_URL);
  await flush();
  assert.ok(unstamped.logs.includes('SSSSTOREDSTAMP none'));
  assert.equal(parseStoredStamp(unstamped.logs.join('\n')), 'none');
  // A stamp on a later line does not count, the same rule the first-line SSSSTAMP follows.
  const later = makeProbe('editor-probe.js', { textarea: 'x', fetchImpl: fetchStub({ [STORED_URL]: storedBody('<p>x</p>\n' + commentLine('order_link', 2)) }).impl });
  await later.window.fetch(STORED_URL);
  await flush();
  assert.ok(later.logs.includes('SSSSTOREDSTAMP none'));
});

test('editor-probe.js: only the EmailTemplate operation is read, and no longer operation name matches it', async () => {
  const preview = makeProbe('editor-probe.js', { textarea: 'x', fetchImpl: fetchStub({ [PREVIEW_URL]: storedBody('<p>rendered</p>') }).impl });
  await preview.window.fetch(PREVIEW_URL);
  await flush();
  assert.deepEqual(preview.logs.filter((l) => l.startsWith('SSSSTORED')), [], 'EmailTemplateGeneratePreview is a rendered document, never the stored one');

  // The lookahead has to exclude every character an operation name can continue with. A filter
  // like this one fails silently when it is widened, so the whole shape is pinned here.
  const base = 'https://admin.shopify.com/g?operationName=';
  for (const op of ['EmailTemplateGeneratePreview', 'EmailTemplateUpdate', 'EmailTemplate_Update', 'EmailTemplate-List', 'EmailTemplate2', 'EmailTemplates']) {
    const url = base + op;
    const probe = makeProbe('editor-probe.js', { textarea: 'x', fetchImpl: fetchStub({ [url]: storedBody('body\n') }).impl });
    await probe.window.fetch(url);
    await flush();
    assert.deepEqual(probe.logs.filter((l) => l.startsWith('SSSSTORED')), [], op);
  }
  const wanted = base + 'EmailTemplate';
  const hit = makeProbe('editor-probe.js', { textarea: 'x', fetchImpl: fetchStub({ [wanted]: storedBody('body\n') }).impl });
  await hit.window.fetch(wanted);
  await flush();
  assert.equal(hit.logs.filter((l) => l.startsWith('SSSSTORED ')).length, 1, 'the operation itself still matches');
  const withAmp = base + 'EmailTemplate&variables=%7B%7D';
  const hit2 = makeProbe('editor-probe.js', { textarea: 'x', fetchImpl: fetchStub({ [withAmp]: storedBody('body\n') }).impl });
  await hit2.window.fetch(withAmp);
  await flush();
  assert.equal(hit2.logs.filter((l) => l.startsWith('SSSSTORED ')).length, 1);
});

test('editor-probe.js: an unusable body reports once and does not burn the signal', async () => {
  for (const body of ['{}', '{"data":{"emailTemplate":{"bodyHtml":""}}}', 'not json at all', '{"data":{"emailTemplate":null}}']) {
    const probe = makeProbe('editor-probe.js', { textarea: 'x', fetchImpl: fetchStub({ [STORED_URL]: body }).impl });
    await probe.window.fetch(STORED_URL);
    await flush();
    assert.deepEqual(probe.logs.filter((l) => l.startsWith('SSSSTORED ')), ['SSSSTORED unavailable'], `body ${body}`);
    assert.equal(parseStored(probe.logs.join('\n')), 'unavailable');
  }
  // An aborted or empty first response must not force the run back onto the racy widget read for
  // the rest of the navigation, which is what latching before the parse used to do.
  const url2 = STORED_URL + '&second';
  const stub = fetchStub({ [STORED_URL]: '{}', [url2]: storedBody('the real body\n') });
  const probe = makeProbe('editor-probe.js', { textarea: 'x', fetchImpl: stub.impl });
  await probe.window.fetch(STORED_URL);
  await flush();
  await probe.window.fetch(url2);
  await flush();
  const text = 'the real body\n';
  assert.deepEqual(probe.logs.filter((l) => l.startsWith('SSSSTORED ')), ['SSSSTORED unavailable', `SSSSTORED ${text.length} ${fnv1a(text)} ${GID}`]);
  assert.ok(probe.logs.includes('SSSSTOREDSTAMP none'), 'the good reading brings its stamp with it');
  // parseStored takes the LAST line of either kind, so the good reading wins here and a stale
  // numeric reading never answers a navigation that said unavailable.
  assert.deepEqual(parseStored(probe.logs.join('\n')), { length: text.length, hash: fnv1a(text), gid: GID });
  // And two unusable responses report once, not twice.
  const twice = makeProbe('editor-probe.js', { textarea: 'x', fetchImpl: fetchStub({ [STORED_URL]: '{}', [url2]: '{}' }).impl });
  await twice.window.fetch(STORED_URL);
  await flush();
  await twice.window.fetch(url2);
  await flush();
  assert.deepEqual(twice.logs.filter((l) => l.startsWith('SSSSTORED ')), ['SSSSTORED unavailable']);
});

test('parseStored and parseStoredStamp take the last line, so a stale reading never answers this navigation', () => {
  const wrap = (...lines) => lines.map((l, i) => `msgid=${i + 1} [log] ${l} (1 args)`).join('\n');
  assert.equal(parseStored(''), null, 'no line at all is null, not a guess');
  assert.equal(parseStoredStamp(''), null);
  assert.deepEqual(parseStored(wrap(`SSSSTORED 100 aaaaaaaa ${GID}`)), { length: 100, hash: 'aaaaaaaa', gid: GID });
  // The console buffer can span navigations. Preferring any numeric reading anywhere would answer
  // a navigation that said `unavailable` with the PREVIOUS template's numbers.
  assert.equal(parseStored(wrap(`SSSSTORED 100 aaaaaaaa ${GID}`, 'SSSSTORED unavailable')), 'unavailable');
  assert.deepEqual(parseStored(wrap('SSSSTORED unavailable', 'SSSSTORED 42 cccccccc -')), { length: 42, hash: 'cccccccc', gid: null });
  assert.deepEqual(parseStored(wrap('SSSSTORED 1 aaaaaaaa -', 'SSSSTORED 2 bbbbbbbb -')), { length: 2, hash: 'bbbbbbbb', gid: null }, 'last numeric wins');
  // SSSSTOREDSTAMP shares the prefix and must not be read as a reading.
  assert.equal(parseStored(wrap('SSSSTOREDSTAMP order_link 1')), null);
  assert.deepEqual(parseStoredStamp(wrap('SSSSTOREDSTAMP order_link 1', 'SSSSTOREDSTAMP none')), 'none');
  assert.deepEqual(parseStoredStamp(wrap('SSSSTOREDSTAMP none', 'SSSSTOREDSTAMP order_link 7')), { id: 'order_link', version: 7 });
  assert.deepEqual(parseSettled(wrap('SSSSETTLED 5 aaaaaaaa', 'SSSSETTLED 6 bbbbbbbb')), { length: 6, hash: 'bbbbbbbb' });
  assert.equal(parseSettled(wrap('SSSPOLL 5 aaaaaaaa cm6')), null);
});

test('editor-probe.js: the XHR path reports SSSSTORED too', async () => {
  const sent = [];
  class FakeXHR {
    constructor() {
      this.listeners = {};
      this.responseText = '';
    }
    open(method, url) {
      sent.push([method, url]);
      this.url = url;
    }
    addEventListener(name, fn) {
      this.listeners[name] = fn;
    }
    send() {
      this.responseText = storedBody('stored via xhr\n');
      this.listeners.load();
    }
  }
  const probe = makeProbe('editor-probe.js', { textarea: 'x', xhrImpl: FakeXHR });
  const xhr = new probe.window.XMLHttpRequest();
  xhr.open('GET', STORED_URL);
  xhr.send();
  const text = 'stored via xhr\n';
  assert.deepEqual(probe.logs.filter((l) => l.startsWith('SSSSTORED ')), [`SSSSTORED ${text.length} ${fnv1a(text)} ${GID}`]);
  assert.deepEqual(sent, [['GET', STORED_URL]], 'the original open is still called with its arguments');
});

test('editor-probe.js: installing twice does not double-wrap the page globals', async () => {
  const stub = fetchStub({ [STORED_URL]: storedBody('body\n') });
  const probe = makeProbe('editor-probe.js', { textarea: 'x', fetchImpl: stub.impl });
  const first = probe.window.fetch;
  vm.runInNewContext(src('editor-probe.js'), { document: { querySelector: () => null, querySelectorAll: () => [] }, window: probe.window, console: { log: () => {} }, setInterval: () => 1, clearInterval: () => {} }, { filename: 'again' });
  assert.equal(probe.window.fetch, first, 'the second install is a no-op');
  await probe.window.fetch(STORED_URL);
  await flush();
  assert.deepEqual(stub.calls, [STORED_URL], 'and the original fetch is still called exactly once per call');
});

test('editor-probe.js: SSSSETTLED fires on the tick the document goes quiet, and re-arms after a change', () => {
  const text = 'settled document\n';
  // SETTLE_POLLS is 3, so a document unchanged from the first poll settles on the fourth tick and
  // says so once. Asserting the tick, not just the line, is what pins the window.
  for (const ticks of [1, 2, 3]) {
    assert.deepEqual(runProbe('editor-probe.js', { textarea: text, ticks }).filter((l) => l.startsWith('SSSSETTLED')), [], `${ticks} tick(s) is not a settle`);
  }
  assert.deepEqual(runProbe('editor-probe.js', { textarea: text, ticks: 4 }).filter((l) => l.startsWith('SSSSETTLED ')), [`SSSSETTLED ${text.length} ${fnv1a(text)}`]);
  assert.deepEqual(runProbe('editor-probe.js', { textarea: text, ticks: 9 }).filter((l) => l.startsWith('SSSSETTLED ')), [`SSSSETTLED ${text.length} ${fnv1a(text)}`], 'once, not once per tick');

  // A change resets the counter and re-arms the signal: two settles, with different hashes. This
  // fails if either the counter reset or the re-arm is dropped.
  const changing = runProbe('editor-probe.js', {
    textarea: 'first',
    ticks: 12,
    between: (t, stub) => {
      if (t === 6) stub.areas[0].value = 'second';
    },
  });
  assert.deepEqual(changing.filter((l) => l.startsWith('SSSSETTLED ')), [`SSSSETTLED 5 ${fnv1a('first')}`, `SSSSETTLED 6 ${fnv1a('second')}`]);
  // A change before the window closes resets the counter, so the settle lands three ticks after
  // the change and reports the new document, never the old one.
  const early = runProbe('editor-probe.js', {
    textarea: 'first',
    ticks: 6,
    between: (t, stub) => {
      if (t === 2) stub.areas[0].value = 'second';
    },
  });
  assert.deepEqual(early.filter((l) => l.startsWith('SSSSETTLED ')), [`SSSSETTLED 6 ${fnv1a('second')}`]);
});
