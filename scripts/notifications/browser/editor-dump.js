// Dumps the Admin notification editor's document to the console in the dump.mjs contract, passed
// verbatim as the initScript of a navigate_page call. Once, as soon as the editor exists:
//   SSSLEN <length>, SSSHASH <fnv>, SSSSUBJ <subject>, SSSREVERT true|false, SSSCHUNK<n> <text>
// Reassemble with `node scripts/notifications/dump.mjs <saved console output> --out <file>` or
// record it with `record-stock.mjs --dump`. Read-only. The FNV function is a copy of the one in
// scripts/notifications/dump.mjs; test/browser-probes.test.mjs proves they agree.
(function () {
  var LEN_PREFIX = 'SSSLEN';
  var HASH_PREFIX = 'SSSHASH';
  var CHUNK_PREFIX = 'SSSCHUNK';
  var CHUNK_SIZE = 8000;
  function fnv1a(text) {
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }
  function readEditor() {
    var cm6 = document.querySelector('.cm-content');
    if (cm6 && cm6.cmView && cm6.cmView.view) return { source: 'cm6', text: cm6.cmView.view.state.doc.toString() };
    var cm5 = document.querySelector('.CodeMirror');
    if (cm5 && cm5.CodeMirror) return { source: 'cm5', text: cm5.CodeMirror.getValue() };
    var areas = document.querySelectorAll('textarea');
    var best = null;
    for (var i = 0; i < areas.length; i++) if (!best || areas[i].value.length > best.value.length) best = areas[i];
    if (best) return { source: 'textarea', text: best.value };
    return null;
  }
  function subject() {
    var inputs = document.querySelectorAll('input[type="text"], input:not([type])');
    for (var i = 0; i < inputs.length; i++) {
      var label = (inputs[i].getAttribute('aria-label') || '') + ' ' + (inputs[i].getAttribute('name') || '') + ' ' + (inputs[i].id || '');
      if (/subject/i.test(label)) return inputs[i].value;
    }
    return null;
  }
  function revertDisabled() {
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var label = (buttons[i].textContent || '') + ' ' + (buttons[i].getAttribute('aria-label') || '');
      if (/revert/i.test(label)) return buttons[i].disabled ? 'true' : 'false';
    }
    return null;
  }
  var done = false;
  function dump() {
    if (done) return;
    var r = readEditor();
    if (!r || r.text.length === 0) return;
    done = true;
    clearInterval(timer);
    var text = r.text.replace(/\r\n?/g, '\n');
    console.log(LEN_PREFIX + ' ' + text.length);
    console.log(HASH_PREFIX + ' ' + fnv1a(text));
    var s = subject();
    if (s !== null) console.log('SSSSUBJ ' + s);
    var rd = revertDisabled();
    if (rd !== null) console.log('SSSREVERT ' + rd);
    for (var i = 0, k = 0; i < text.length; i += CHUNK_SIZE, k++) console.log(CHUNK_PREFIX + k + ' ' + text.slice(i, i + CHUNK_SIZE));
  }
  var timer = setInterval(dump, 500);
})();
