// Read-only probe for the Admin notification editor, passed verbatim as the initScript of a
// navigate_page call by the notification-templates skill. It polls until the editor exists and
// logs, on every change of the document:
//   SSSPOLL <length> <fnv> <source>   String.length and 32-bit FNV-1a of the editor text
//                                     (UTF-16 code units, LF-normalised), and which widget it read
//   SSSSTAMP <id> <version> | none    the stamp parsed from the editor's FIRST LINE only
//   SSSREVERT true|false|unknown      whether a "Revert" button is disabled; `unknown` when the
//                                     editor shows none (observed: a clean editor shows neither
//                                     Save nor Revert), so the stock signal that counts is the
//                                     document's bytes equalling stock/<id>.liquid
// Nothing here writes to the page. The FNV function and the stamp regex are copies of the ones in
// scripts/notifications/dump.mjs and brand.mjs; test/browser-probes.test.mjs proves they agree.
(function () {
  var STAMP_RE_SOURCE = '(?<![A-Za-z0-9_-])sss-notification ([a-z0-9_]+) v([1-9][0-9]*)(?![0-9A-Za-z_-])';
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
  function revertDisabled() {
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var label = (buttons[i].textContent || '') + ' ' + (buttons[i].getAttribute('aria-label') || '');
      if (/revert/i.test(label)) return buttons[i].disabled ? 'true' : 'false';
    }
    return 'unknown';
  }
  var last = null;
  function poll() {
    var r = readEditor();
    if (!r) return;
    var text = r.text.replace(/\r\n?/g, '\n');
    var rd = revertDisabled();
    var key = r.source + ':' + text.length + ':' + fnv1a(text) + ':' + rd;
    if (key === last) return;
    last = key;
    console.log('SSSPOLL ' + text.length + ' ' + fnv1a(text) + ' ' + r.source);
    var firstLine = text.split('\n')[0];
    var m = new RegExp(STAMP_RE_SOURCE).exec(firstLine);
    console.log('SSSSTAMP ' + (m ? m[1] + ' ' + m[2] : 'none'));
    console.log('SSSREVERT ' + rd);
  }
  setInterval(poll, 500);
})();
